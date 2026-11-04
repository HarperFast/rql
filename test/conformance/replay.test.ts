/**
 * End-to-end: replay the committed fixture through the same code the runner uses and assert
 * that the committed report is exactly what comes out.
 *
 * This is `npm run conformance:check` as a test, minus the worker isolation — the reference
 * parser runs in-process here because a wedged case would fail the test anyway. It is what
 * keeps the committed report honest: nobody can hand-edit it, and a change to the adapter,
 * the corpus or a classification rule that is not reflected in the report fails here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CORPUS, corpusDigest } from '../../conformance/corpus.ts';
import { canonicalize } from '../../conformance/canonical.ts';
import type { Outcome } from '../../conformance/canonical.ts';
import { RULE_IDS } from '../../conformance/classify.ts';
import { type Fixture, type Ledger, buildRun } from '../../conformance/compare.ts';
import { renderReport } from '../../conformance/report.ts';
import { parseQuery } from '../../src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'conformance', 'fixtures', 'harper-parse.json'), 'utf8')) as Fixture;
const ledger = JSON.parse(readFileSync(join(root, 'conformance', 'ledger.json'), 'utf8')) as Ledger;
const committedReport = readFileSync(join(root, 'conformance', 'conformance-report.md'), 'utf8');

const describeError = (error: unknown): string =>
	error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;

function strict(query: string): Outcome {
	try {
		return { status: 'parsed', canonical: canonicalize(parseQuery(query)) };
	} catch (error) {
		return { status: 'rejected', error: describeError(error) };
	}
}

function deferred(query: string): Outcome {
	try {
		const { parseError, ...rest } = parseQuery(query, { deferErrors: true });
		return parseError
			? { status: 'deferred-error', error: describeError(parseError), canonical: canonicalize(rest) }
			: { status: 'parsed', canonical: canonicalize(rest) };
	} catch (error) {
		return { status: 'rejected', error: describeError(error) };
	}
}

const run = buildRun(fixture, ledger, (item) => ({ strict: strict(item.query), deferred: deferred(item.query) }));

describe('fixture integrity', () => {
	it('is at the schema version the runner writes', () => {
		assert.equal(fixture.schema, 1);
	});

	it('was recorded for exactly this corpus', () => {
		assert.equal(fixture.provenance.corpusDigest, corpusDigest());
		for (const item of CORPUS) assert.ok(item.id in fixture.cases, `${item.query} is missing from the fixture`);
		assert.equal(Object.keys(fixture.cases).length, CORPUS.length);
	});

	it('records the query alongside each id, so a stale entry is visible', () => {
		for (const item of CORPUS) assert.equal(fixture.cases[item.id].query, item.query);
	});

	it('names the Harper and reference revisions it was recorded against', () => {
		assert.match(fixture.provenance.harper.commit, /^[0-9a-f]{40}$/);
		assert.match(fixture.provenance.reference.commit, /^[0-9a-f]{40}$/);
		assert.ok(Date.parse(fixture.provenance.recordedAt) > 0);
	});
});

describe('replay', () => {
	it('classifies every divergence — nothing is left unclassified', () => {
		const unclassified = run.comparisons.filter((comparison) => comparison.classification.verdict === 'unclassified');
		assert.deepEqual(
			unclassified.map((comparison) => comparison.case.query),
			[]
		);
	});

	it('reproduces the committed report byte for byte', () => {
		assert.equal(renderReport(run), committedReport, 'run `npm run conformance` and commit the regenerated report');
	});

	it('accounts for every corpus case exactly once', () => {
		assert.equal(run.comparisons.length, CORPUS.length);
		assert.equal(new Set(run.comparisons.map((comparison) => comparison.case.id)).size, CORPUS.length);
	});

	it('leaves no classification rule without a witness', () => {
		const fired = new Set(
			run.comparisons
				.map((comparison) => (comparison.classification as { rule?: string }).rule)
				.filter((rule): rule is string => rule !== undefined)
		);
		const dead = RULE_IDS.filter((rule) => !fired.has(rule));
		assert.deepEqual(dead, [], 'these rules match nothing — delete them or keep a witness case');
	});

	it('still finds real agreement — the harness is not reporting everything as a divergence', () => {
		const agrees = run.comparisons.filter((comparison) => comparison.classification.verdict === 'agrees');
		assert.ok(agrees.length > CORPUS.length / 4, `${agrees.length} of ${CORPUS.length} cases agree`);
	});

	it('collects deferred-mode evidence for ledger rows 8 and 9', () => {
		const queries = new Set(run.deferred.map((observation) => observation.case.query));
		assert.ok(queries.has('group-by(a)'), 'row 9 needs the group-by witness');
		const groupBy = run.deferred.find((observation) => observation.case.query === 'group-by(a)');
		// Row 9: the reserved call name is reported AND still falls through into `sort`.
		assert.equal(groupBy?.harper.status, 'deferred-error');
		assert.deepEqual((groupBy?.harper as { canonical: unknown }).canonical, { sort: [{ path: ['a'], direction: 'asc' }] });
	});
});
