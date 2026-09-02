/**
 * Worker-lifecycle tests for the replay supervisor.
 *
 * These run real subprocesses, including deliberately broken ones, because the paths worth
 * testing here are the crash windows: a worker that dies mid-parse, one that never answers,
 * one that never starts, and one that cannot be replaced. Each must end in a settled outcome
 * the classifier refuses to call agreement — never in a promise nobody resolves.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReferenceRunner } from '../../conformance/referenceRunner.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_WORKER = join(root, 'scripts', 'conformance-ref-worker.mjs');

let stubDir: string;
const stub = (name: string, body: string): string => {
	const path = join(stubDir, name);
	writeFileSync(path, body);
	return path;
};

before(() => {
	stubDir = mkdtempSync(join(tmpdir(), 'rql-ref-runner-'));
});
after(() => {
	rmSync(stubDir, { recursive: true, force: true });
});

/** Fail loudly rather than letting the suite hang if a path stops settling. */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`${what} never settled within ${ms}ms`)), ms);
			timer.unref();
		}),
	]);
}

// Worker stderr is silenced: several of these workers are supposed to fail, and their stack
// traces in the test output read like the suite itself broke.
const options = { timeoutMs: 1500, startupTimeoutMs: 5000, stderr: 'ignore' } as const;

describe('ReferenceRunner — the happy path', () => {
	it('parses through the real worker in both error modes', async () => {
		const runner = new ReferenceRunner({ workerPath: REAL_WORKER, ...options });
		await runner.start();
		try {
			const parsed = await withDeadline(runner.parse('a=1'), 10_000, 'a valid parse');
			assert.equal(parsed.strict.status, 'parsed');
			const rejected = await withDeadline(runner.parse('a=1&b=2|c=3'), 10_000, 'an invalid parse');
			assert.equal(rejected.strict.status, 'rejected');
			// §6.1's deferred mode keeps a partial result rather than throwing.
			assert.equal(rejected.deferred.status, 'deferred-error');
			assert.equal(runner.deadReason, undefined);
		} finally {
			runner.stop();
		}
	});
});

describe('ReferenceRunner — failure paths', () => {
	it('settles an in-flight parse when the worker dies instead of answering', async () => {
		const path = stub(
			'dies-mid-parse.mjs',
			`process.on('message', () => process.exit(3));\nprocess.send({ type: 'ready' });\n`
		);
		const runner = new ReferenceRunner({ workerPath: path, ...options });
		await runner.start();
		const outcomes = await withDeadline(runner.parse('a=1'), 10_000, 'a parse whose worker died');
		assert.equal(outcomes.strict.status, 'harness-error');
		assert.match((outcomes.strict as { error: string }).error, /exited \(code 3/);
		assert.ok(runner.deadReason, 'the runner should record why it stopped working');
	});

	it('fails fast on every later parse once the worker is gone, rather than hanging', async () => {
		const path = stub('dies-again.mjs', `process.on('message', () => process.exit(4));\nprocess.send({ type: 'ready' });\n`);
		const runner = new ReferenceRunner({ workerPath: path, ...options });
		await runner.start();
		await withDeadline(runner.parse('a=1'), 10_000, 'the first parse');
		const second = await withDeadline(runner.parse('b=2'), 5_000, 'the parse after the worker died');
		assert.equal(second.strict.status, 'harness-error');
	});

	it('times out a worker that never answers, and stays usable afterwards', async () => {
		const path = stub('never-answers.mjs', `process.on('message', () => {});\nprocess.send({ type: 'ready' });\n`);
		const runner = new ReferenceRunner({ workerPath: path, timeoutMs: 300, startupTimeoutMs: 5000, stderr: 'ignore' });
		await runner.start();
		try {
			const first = await withDeadline(runner.parse('a=1'), 10_000, 'a parse against a silent worker');
			assert.deepEqual(first.strict, { status: 'timeout', ms: 300 });
			assert.equal(runner.deadReason, undefined, 'a replaced worker leaves the runner healthy');
			// The replacement is a fresh process, so the next case is timed independently.
			const second = await withDeadline(runner.parse('b=2'), 10_000, 'the parse after a timeout');
			assert.deepEqual(second.strict, { status: 'timeout', ms: 300 });
		} finally {
			runner.stop();
		}
	});

	it('reports a timeout AND marks itself dead when the replacement cannot start', async () => {
		// Answers nothing, and deletes itself so the restart has no script to fork.
		const path = stub(
			'vanishes.mjs',
			`import { rmSync } from 'node:fs';\nprocess.on('message', () => rmSync(new URL(import.meta.url)));\nprocess.send({ type: 'ready' });\n`
		);
		const runner = new ReferenceRunner({ workerPath: path, timeoutMs: 300, startupTimeoutMs: 1000, stderr: 'ignore' });
		await runner.start();
		const first = await withDeadline(runner.parse('a=1'), 10_000, 'a parse whose replacement cannot start');
		assert.equal(first.strict.status, 'timeout');
		assert.match(runner.deadReason ?? '', /could not be restarted/);
		const second = await withDeadline(runner.parse('b=2'), 5_000, 'the parse after a failed restart');
		assert.equal(second.strict.status, 'harness-error');
	});

	it('rejects start() for a worker that exits before reporting ready', async () => {
		const path = stub('exits-at-once.mjs', `process.exit(7);\n`);
		const runner = new ReferenceRunner({ workerPath: path, ...options });
		await assert.rejects(withDeadline(runner.start(), 10_000, 'start against an exiting worker'), /exited before starting/);
	});

	it('rejects start() for a worker that never reports ready', async () => {
		const path = stub('never-ready.mjs', `setTimeout(() => {}, 60_000);\n`);
		const runner = new ReferenceRunner({ workerPath: path, timeoutMs: 300, startupTimeoutMs: 400, stderr: 'ignore' });
		await assert.rejects(withDeadline(runner.start(), 10_000, 'start against a silent worker'), /did not start within 400ms/);
		runner.stop();
	});

	it('does not hang when asked to parse before it was started', async () => {
		const runner = new ReferenceRunner({ workerPath: REAL_WORKER, ...options });
		const outcomes = await withDeadline(runner.parse('a=1'), 5_000, 'a parse before start()');
		assert.equal(outcomes.strict.status, 'harness-error');
	});
});
