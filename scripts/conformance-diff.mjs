#!/usr/bin/env node
/**
 * Differential conformance runner: Harper's REST query parser vs. the RQL 2.0 reference
 * parser, over the corpus in `conformance/corpus.ts`.
 *
 * Two modes:
 *
 *   node scripts/conformance-diff.mjs            replay (the default, and what CI runs)
 *   HARPER_PATH=../harper … --record             re-record the Harper fixture, then replay
 *
 * Replay needs no Harper checkout: it reads the committed fixture of raw Harper output,
 * maps it through `conformance/harperAdapter.ts`, and diffs it against a live reference
 * parse. Recording is the only step that runs Harper, and it gives each query its own
 * short-lived process because Harper's parser holds module-global state.
 *
 * Flags:
 *   --record              re-record `conformance/fixtures/harper-parse.json`
 *   --check               fail if replay does not reproduce the committed report exactly
 *   --out <path>          write the report somewhere else
 *   --timeout <ms>        per-parse wall-clock budget (default 5000)
 *   --startup-timeout <ms> budget for a record worker to load Harper (default 60000)
 *   --concurrency <n>     recording processes in flight (default 4). Safe despite Harper's
 *                         module-global parser state: each process has its own module graph,
 *                         and no two parses ever share one.
 *   --json <path>         also dump the raw comparison data, for debugging the harness
 *
 * Exit codes: 0 clean · 1 divergences unclassified / fixture stale / report drift · 2 the
 * harness itself could not run.
 */
import { fork } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS, corpusDigest } from '../conformance/corpus.ts';
import { buildRun } from '../conformance/compare.ts';
import { renderReport } from '../conformance/report.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..');
const FIXTURE = join(root, 'conformance', 'fixtures', 'harper-parse.json');
const LEDGER = join(root, 'conformance', 'ledger.json');
const DEFAULT_REPORT = join(root, 'conformance', 'conformance-report.md');
const FIXTURE_SCHEMA = 1;
const STALE_LEDGER_DAYS = 30;

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const option = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index === -1 ? fallback : argv[index + 1];
};

const fail = (message, code = 2) => {
	console.error(message);
	process.exit(code);
};

/** A numeric flag that is silently NaN would record a whole fixture of spurious timeouts. */
const positiveIntOption = (name, fallback) => {
	const raw = option(name, String(fallback));
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer; got ${JSON.stringify(raw)}`);
	return value;
};

const options = {
	record: has('record'),
	check: has('check'),
	out: resolve(option('out', DEFAULT_REPORT)),
	timeout: positiveIntOption('timeout', 5000),
	startupTimeout: positiveIntOption('startup-timeout', 60000),
	concurrency: positiveIntOption('concurrency', 4),
	json: option('json', undefined),
};

const git = (cwd, args) => {
	try {
		return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return undefined;
	}
};

// ── recording: one isolated process per query ───────────────────────────────

function recordOne(harperPath, query) {
	return new Promise((resolveOutcome) => {
		const child = fork(join(scriptDir, 'conformance-record-worker.mjs'), [], {
			// A dedicated IPC channel: Harper's module graph writes to stdout/stderr on import,
			// and results must not be parsed out of that noise.
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			env: { ...process.env, HARPER_PATH: harperPath },
		});
		let stderr = '';
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});

		let settled = false;
		let timer;
		const settle = (outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill('SIGKILL');
			resolveOutcome(outcome);
		};
		// Loading Harper's module graph takes seconds and has nothing to do with how long the
		// parse takes. Timing them together would let a slow or busy machine record a spurious
		// timeout INTO the committed fixture, so the two budgets are separate and the parse
		// clock only starts once the worker says it is ready.
		timer = setTimeout(() => settle({ fatal: `worker did not load Harper within ${options.startupTimeout}ms` }), options.startupTimeout);

		child.on('message', (message) => {
			if (message?.type === 'recorded') settle({ strict: message.strict, target: message.target });
			else if (message?.type === 'fatal') settle({ fatal: `${message.name}: ${message.message}` });
			else if (message?.type === 'ready') {
				clearTimeout(timer);
				timer = setTimeout(() => settle({ timedOut: true }), options.timeout);
				child.send({ type: 'record', query });
			}
		});
		child.on('error', (error) => settle({ fatal: error.message }));
		child.on('exit', (code, signal) =>
			settle({ fatal: `worker exited (code ${code}, signal ${signal})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}` })
		);
	});
}

async function record() {
	const harperPath = resolve(option('harper', process.env.HARPER_PATH ?? ''));
	if (!process.env.HARPER_PATH && !option('harper', undefined))
		fail('--record needs a Harper checkout: set HARPER_PATH=/path/to/harper (or pass --harper <path>).');
	const searchDist = join(harperPath, 'dist', 'resources', 'search.js');
	if (!existsSync(searchDist))
		fail(`No built Harper parser at ${searchDist}. Run \`npm install && npm run build\` in the Harper checkout first.`);

	let version;
	try {
		version = JSON.parse(readFileSync(join(harperPath, 'package.json'), 'utf8')).version;
	} catch {
		version = undefined;
	}

	const provenance = {
		harper: {
			commit: git(harperPath, ['rev-parse', 'HEAD']) ?? 'unknown',
			describe: git(harperPath, ['describe', '--tags', '--always']),
			dirty: (git(harperPath, ['status', '--porcelain']) ?? '') !== '',
			version,
		},
		// Recorded here, not rendered from the working tree: the report is committed, so a
		// value read from `git rev-parse HEAD` would invalidate it on every later commit.
		reference: {
			commit: git(root, ['rev-parse', 'HEAD']) ?? 'unknown',
			describe: git(root, ['describe', '--tags', '--always']),
			dirty: (git(root, ['status', '--porcelain']) ?? '') !== '',
		},
		recordedAt: new Date().toISOString(),
		corpusDigest: corpusDigest(),
		node: process.version,
	};

	const cases = {};
	let done = 0;
	let cursor = 0;
	const runNext = async () => {
		while (cursor < CORPUS.length) {
			const item = CORPUS[cursor++];
			const outcome = await recordOne(harperPath, item.query);
			if (outcome.fatal) fail(`Recording ${JSON.stringify(item.query)} failed: ${outcome.fatal}`);
			cases[item.id] = outcome.timedOut
				? { query: item.query, timedOut: true, timeoutMs: options.timeout }
				: { query: item.query, strict: outcome.strict, target: outcome.target };
			done++;
			if (done % 25 === 0 || done === CORPUS.length) process.stderr.write(`  recorded ${done}/${CORPUS.length}\n`);
		}
	};
	process.stderr.write(`Recording ${CORPUS.length} cases against Harper at ${harperPath}\n`);
	await Promise.all(Array.from({ length: options.concurrency }, runNext));

	mkdirSync(dirname(FIXTURE), { recursive: true });
	const body = JSON.stringify({ schema: FIXTURE_SCHEMA, provenance, cases }, null, '\t') + '\n';
	// Atomic: a half-written fixture would replay as silent corpus drift.
	writeFileSync(`${FIXTURE}.tmp`, body);
	renameSync(`${FIXTURE}.tmp`, FIXTURE);
	process.stderr.write(`Wrote ${FIXTURE}\n`);
}

// ── replay: one persistent reference worker, restarted on timeout ───────────

class ReferenceRunner {
	#child;
	#pending = new Map();
	#nextId = 0;
	/** Set once the worker cannot be replaced; every later parse fails fast instead of hanging. */
	#dead;

	/**
	 * Settle every in-flight parse with a harness error. A reference outcome the harness could
	 * not observe must never look like agreement, so it flows on to the classifier, finds no
	 * rule, and fails the run with the query named.
	 */
	#failPending(reason) {
		const pending = this.#pending;
		this.#pending = new Map();
		for (const entry of pending.values()) {
			clearTimeout(entry.timer);
			const outcome = { status: 'harness-error', error: reason };
			entry.resolve({ strict: outcome, deferred: outcome });
		}
	}

	async #spawn() {
		const child = fork(join(scriptDir, 'conformance-ref-worker.mjs'), [], {
			stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
		});
		this.#child = child;
		// Requests are issued one at a time by the replay loop, so replacing the pending map on
		// a restart cannot strand a second in-flight parse.
		this.#pending = new Map();

		child.on('message', (message) => {
			if (message?.type !== 'result') return;
			const entry = this.#pending.get(message.id);
			if (!entry) return;
			this.#pending.delete(message.id);
			clearTimeout(entry.timer);
			entry.resolve({ strict: message.strict, deferred: message.deferred });
		});
		// Without these, a worker that dies mid-parse (uncaught throw, OOM kill) leaves its
		// promise unsettled and the whole run hangs instead of failing.
		const onGone = (reason) => {
			if (this.#child !== child) return;
			this.#dead ??= reason;
			this.#failPending(reason);
		};
		child.on('exit', (code, signal) => onGone(`the reference worker exited (code ${code}, signal ${signal})`));
		child.on('error', (error) => onGone(`the reference worker failed to run: ${error.message}`));

		await new Promise((ready, reject) => {
			const timer = setTimeout(() => reject(new Error(`the reference worker did not start within ${options.startupTimeout}ms`)), options.startupTimeout);
			const settle = (fn, value) => {
				clearTimeout(timer);
				fn(value);
			};
			child.once('message', (message) =>
				message?.type === 'ready' ? settle(ready) : settle(reject, new Error('the reference worker sent no ready message'))
			);
			child.once('error', (error) => settle(reject, error));
			child.once('exit', (code, signal) => settle(reject, new Error(`the reference worker exited before starting (code ${code}, signal ${signal})`)));
		});
		this.#dead = undefined;
	}

	async start() {
		await this.#spawn();
	}

	/**
	 * One parse. On a timeout the worker is killed and replaced, so one wedged case costs
	 * exactly that case rather than the rest of the corpus. A replacement that will not start
	 * ends the run's reference coverage rather than hanging it.
	 */
	parse(query) {
		if (this.#dead) return Promise.resolve({ strict: { status: 'harness-error', error: this.#dead }, deferred: { status: 'harness-error', error: this.#dead } });
		const id = this.#nextId++;
		return new Promise((resolveOutcome) => {
			const timer = setTimeout(async () => {
				this.#pending.delete(id);
				const timedOut = { status: 'timeout', ms: options.timeout };
				this.#child.kill('SIGKILL');
				try {
					await this.#spawn();
				} catch (error) {
					this.#dead = `the reference worker could not be restarted: ${error.message}`;
				}
				resolveOutcome({ strict: timedOut, deferred: timedOut });
			}, options.timeout);
			this.#pending.set(id, { resolve: resolveOutcome, timer });
			this.#child.send({ type: 'parse', id, query });
		});
	}

	stop() {
		this.#child?.kill();
	}
}

async function replay() {
	if (!existsSync(FIXTURE))
		fail('No recorded fixture. Run `HARPER_PATH=../harper npm run conformance:record` first.', 1);
	const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
	if (fixture.schema !== FIXTURE_SCHEMA)
		fail(`Fixture schema ${fixture.schema} is not ${FIXTURE_SCHEMA}; re-record with \`npm run conformance:record\`.`, 1);
	const digest = corpusDigest();
	if (fixture.provenance?.corpusDigest !== digest)
		fail(
			`Fixture was recorded for corpus ${fixture.provenance?.corpusDigest}, but the corpus is now ${digest}.\n` +
				'Re-record it: `HARPER_PATH=../harper npm run conformance:record`.',
			1
		);
	const missing = CORPUS.filter((item) => !(item.id in fixture.cases));
	if (missing.length > 0)
		fail(`Fixture is missing ${missing.length} case(s), starting with ${JSON.stringify(missing[0].query)}; re-record it.`, 1);

	const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
	const ledgerAgeDays = Math.floor((Date.now() - Date.parse(ledger.fetchedAt)) / 86_400_000);
	if (ledgerAgeDays > STALE_LEDGER_DAYS)
		process.stderr.write(
			`WARNING: the ledger snapshot is ${ledgerAgeDays} days old (${ledger.source.url}).\n` +
				'         Classifications may cite rows that have since changed — run `npm run conformance:refresh-ledger`.\n'
		);

	const runner = new ReferenceRunner();
	await runner.start();

	// The reference parses run first, sequentially and each under its own timeout; the run is
	// then assembled by the same code the tests use.
	const referenceOutcomes = new Map();
	try {
		for (const item of CORPUS) referenceOutcomes.set(item.id, await runner.parse(item.query));
	} finally {
		runner.stop();
	}

	const run = buildRun(fixture, ledger, (item) => referenceOutcomes.get(item.id));
	const { comparisons } = run;

	if (options.json) writeFileSync(resolve(options.json), JSON.stringify(run, null, '\t') + '\n');

	const report = renderReport(run);
	const unclassified = comparisons.filter((comparison) => comparison.classification.verdict === 'unclassified');

	if (options.check) {
		const existing = existsSync(options.out) ? readFileSync(options.out, 'utf8') : '';
		if (existing !== report) {
			writeFileSync(`${options.out}.actual`, report);
			fail(
				`${options.out} is out of date — replay produced a different report.\n` +
					`The regenerated report was written to ${options.out}.actual; run \`npm run conformance\` and commit the result.`,
				1
			);
		}
		process.stderr.write(`${options.out} is up to date (${comparisons.length} cases).\n`);
	} else {
		writeFileSync(options.out, report);
		process.stderr.write(`Wrote ${options.out} (${comparisons.length} cases).\n`);
	}

	const counts = comparisons.reduce((tally, comparison) => {
		tally[comparison.classification.verdict] = (tally[comparison.classification.verdict] ?? 0) + 1;
		return tally;
	}, {});
	process.stderr.write(
		`agrees=${counts.agrees ?? 0} ledger=${counts.ledger ?? 0} new=${counts.new ?? 0} ` +
			`reference-bug=${counts['reference-bug'] ?? 0} unclassified=${counts.unclassified ?? 0}\n`
	);

	if (unclassified.length > 0) {
		process.stderr.write(`\n${unclassified.length} divergence(s) are unclassified. Add a rule in conformance/classify.ts:\n`);
		for (const comparison of unclassified.slice(0, 40))
			process.stderr.write(
				`  ${JSON.stringify(comparison.case.query)}  ref=${comparison.ref.status} harper=${comparison.harper.status}` +
					`${comparison.differences.length ? ` diffs=${comparison.differences.map((difference) => difference.at || '/').join(',')}` : ''}\n`
			);
		if (unclassified.length > 40) process.stderr.write(`  … and ${unclassified.length - 40} more\n`);
		process.exit(1);
	}
}

if (options.record) await record();
await replay();
