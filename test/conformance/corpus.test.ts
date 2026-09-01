import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
	CORPUS,
	EXECUTION_LEVEL_LEDGER_ROWS,
	REQUIRED_FEATURES,
	corpusDigest,
	featureCoverage,
	ledgerCoverage,
} from '../../conformance/corpus.ts';
import type { Ledger } from '../../conformance/report.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ledger = JSON.parse(readFileSync(join(root, 'conformance', 'ledger.json'), 'utf8')) as Ledger;

describe('corpus', () => {
	it('holds at least the 200 cases the harness is specified to carry', () => {
		assert.ok(CORPUS.length >= 200, `corpus has ${CORPUS.length} cases`);
	});

	it('has no duplicate query strings and no colliding ids', () => {
		assert.equal(new Set(CORPUS.map((item) => item.query)).size, CORPUS.length);
		assert.equal(new Set(CORPUS.map((item) => item.id)).size, CORPUS.length);
	});

	it('gives every required grammar feature at least one case', () => {
		const coverage = featureCoverage();
		const uncovered = REQUIRED_FEATURES.filter((feature) => (coverage.get(feature) ?? []).length === 0);
		assert.deepEqual(uncovered, [], 'grammar features with no corpus case');
	});

	it('witnesses every parse-observable row of the divergence ledger', () => {
		const witnessed = ledgerCoverage();
		const missing = ledger.rows
			.map((row) => row.row)
			.filter((row) => !EXECUTION_LEVEL_LEDGER_ROWS[row] && (witnessed.get(row) ?? []).length === 0);
		assert.deepEqual(missing, [], 'ledger rows with no witness case');
	});

	it('does not tag a case with a ledger row the snapshot does not have', () => {
		const known = new Set(ledger.rows.map((row) => row.row));
		for (const item of CORPUS)
			for (const row of item.ledger ?? []) assert.ok(known.has(row), `${item.query} cites unknown ledger row ${row}`);
	});

	it('produces a digest that changes with the corpus and not otherwise', () => {
		assert.equal(corpusDigest(), corpusDigest());
		assert.match(corpusDigest(), /^\d+-[0-9a-f]{8}$/);
		assert.notEqual(corpusDigest(), corpusDigest(CORPUS.slice(0, -1)));
		assert.notEqual(
			corpusDigest(),
			corpusDigest([...CORPUS.slice(0, -1), { ...CORPUS[CORPUS.length - 1], id: 'qdeadbeef', query: 'changed=1' }])
		);
	});

	it('marks only rows that genuinely cannot be witnessed as execution-level', () => {
		const witnessed = ledgerCoverage();
		for (const row of Object.keys(EXECUTION_LEVEL_LEDGER_ROWS).map(Number))
			assert.equal((witnessed.get(row) ?? []).length, 0, `row ${row} is marked execution-level but has a witness case`);
	});
});
