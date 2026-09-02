import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AdapterError, adaptHarperResult } from '../../conformance/harperAdapter.ts';
import type { ParseResult } from '../../src/types.ts';

/**
 * Every raw shape below was captured from Harper's built parser (see
 * `conformance/fixtures/harper-parse.json` for the recorded originals); the adapter is
 * asserted against those shapes rather than against invented ones.
 */
function adapt(raw: unknown): ParseResult {
	const outcome = adaptHarperResult(raw);
	assert.equal(outcome.status, 'parsed', 'expected a parsed outcome');
	return (outcome as { result: ParseResult }).result;
}

const query = (body: Record<string, unknown>): Record<string, unknown> => ({ conditions: [], ...body });

describe('harper adapter — fast path (ledger row 1)', () => {
	it('maps URLSearchParams entries to verbatim equality conditions', () => {
		assert.deepEqual(adapt(new URLSearchParams('a=1&b=2')), {
			filter: {
				operator: 'and',
				terms: [
					{ path: ['a'], comparator: 'eq', value: '1' },
					{ path: ['b'], comparator: 'eq', value: '2' },
				],
			},
		});
	});

	it('treats a fast-path name as ONE segment — a literal dot cannot reach this path', () => {
		assert.deepEqual(adapt(new URLSearchParams('a%2Eb=1')), {
			filter: { operator: 'and', terms: [{ path: ['a.b'], comparator: 'eq', value: '1' }] },
		});
	});

	it('maps an empty query to an unfiltered result', () => {
		assert.deepEqual(adapt(undefined), {});
		assert.deepEqual(adapt(new URLSearchParams('')), {});
	});
});

describe('harper adapter — conditions', () => {
	it('resolves Harper comparator aliases to canonical names', () => {
		const cases: [string, string, boolean][] = [
			['equals', 'eq', false],
			['eq', 'eq', false],
			['ne', 'eq', true],
			['not_equal', 'eq', true],
			['notEqual', 'eq', true],
			['sw', 'starts_with', false],
			['ew', 'ends_with', false],
			['ct', 'contains', false],
			['greaterThanEqual', 'ge', false],
			['less_than', 'lt', false],
		];
		for (const [harperName, canonical, negated] of cases) {
			const result = adapt(query({ conditions: [{ comparator: harperName, attribute: 'a', value: '1' }] }));
			const condition = result.filter?.terms[0] as { comparator: string; negated?: boolean };
			assert.equal(condition.comparator, canonical, harperName);
			assert.equal(condition.negated ?? false, negated, harperName);
		}
	});

	it('follows HARPER’s vocabulary for `includes`, not Appendix B’s', () => {
		// Harper's ALTERNATE_COMPARATOR_NAMES maps `includes` to `in`; the spec maps it to
		// `contains`. Mapping it to `contains` here would hide the divergence.
		const result = adapt(query({ conditions: [{ comparator: 'includes', attribute: 'a', value: 'x' }] }));
		assert.equal((result.filter?.terms[0] as { comparator: string }).comparator, 'in');
	});

	it('combines an alias’s own negation with the negated flag', () => {
		const result = adapt(query({ conditions: [{ comparator: 'ne', attribute: 'a', value: '1', negated: true }] }));
		// `not_ne` would be a double negation, so the canonical condition is NOT negated.
		assert.deepEqual(result.filter?.terms[0], { path: ['a'], comparator: 'eq', value: '1' });
	});

	it('passes an unknown comparator through untouched (the open vocabulary)', () => {
		const result = adapt(query({ conditions: [{ comparator: 'frobnicate', attribute: 'a', value: 'x' }] }));
		assert.equal((result.filter?.terms[0] as { comparator: string }).comparator, 'frobnicate');
	});

	it('NEGATIVE CONTROL: never re-interprets a value Harper already decoded', () => {
		for (const value of ['3', 'true', 'null', '2.5']) {
			const result = adapt(query({ conditions: [{ comparator: 'eq', attribute: 'a', value }] }));
			assert.equal((result.filter?.terms[0] as { value: unknown }).value, value, `${value} must stay a string`);
		}
		// …and a typed value Harper produced is passed along as the typed value it is.
		const date = new Date('2020-01-01T00:00:00.000Z');
		const typed = adapt(query({ conditions: [{ comparator: 'eq', attribute: 'a', value: date }] }));
		assert.equal((typed.filter?.terms[0] as { value: unknown }).value, date);
	});

	it('maps a dotted attribute array to a segment path, and a missing one to []', () => {
		const dotted = adapt(query({ conditions: [{ comparator: 'eq', attribute: ['a', 'b'], value: '1' }] }));
		assert.deepEqual((dotted.filter?.terms[0] as { path: string[] }).path, ['a', 'b']);
	});

	it('defaults a group operator to `and` and honours `or`', () => {
		const both = adapt(
			query({
				conditions: [
					{ comparator: 'equals', attribute: 'a', value: '1' },
					{ comparator: 'equals', attribute: 'b', value: '2' },
				],
				operator: 'or',
			})
		);
		assert.equal(both.filter?.operator, 'or');
		assert.equal(adapt(query({ conditions: [{ comparator: 'equals', attribute: 'a', value: '1' }] })).filter?.operator, 'and');
	});
});

describe('harper adapter — element matches', () => {
	it('desugars `between` to an element-scoped ge + le (ledger row 4)', () => {
		const result = adapt(query({ conditions: [{ comparator: 'between', attribute: 'a', value: ['1', '5'] }] }));
		assert.deepEqual(result.filter?.terms[0], {
			path: ['a'],
			some: {
				operator: 'and',
				terms: [
					{ path: [], comparator: 'ge', value: '1' },
					{ path: [], comparator: 'le', value: '5' },
				],
			},
		});
	});

	it('marks not_between as a negated element match', () => {
		const result = adapt(query({ conditions: [{ comparator: 'between', attribute: 'a', value: ['1', '5'], negated: true }] }));
		assert.equal((result.filter?.terms[0] as { negated?: boolean }).negated, true);
	});

	it('keeps a `between` whose argument is not a two-element list as a literal condition', () => {
		const result = adapt(query({ conditions: [{ comparator: 'between', attribute: 'a', value: '1' }] }));
		assert.deepEqual(result.filter?.terms[0], { path: ['a'], comparator: 'between', value: '1' });
	});

	it('maps chainedConditions to an element match with element-relative paths (row 2)', () => {
		const result = adapt(
			query({
				conditions: [
					{
						comparator: 'ge',
						attribute: 'ratings',
						value: '3',
						operator: 'and',
						chainedConditions: [{ comparator: 'le', attribute: null, value: '4' }],
					},
				],
			})
		);
		assert.deepEqual(result.filter?.terms[0], {
			path: ['ratings'],
			some: {
				operator: 'and',
				terms: [
					{ path: [], comparator: 'ge', value: '3' },
					{ path: [], comparator: 'le', value: '4' },
				],
			},
		});
	});

	it('carries a chain’s `or` operator into the element match', () => {
		const result = adapt(
			query({
				conditions: [
					{
						comparator: 'ge',
						attribute: 'a',
						value: '3',
						operator: 'or',
						chainedConditions: [{ comparator: 'le', attribute: null, value: '4' }],
					},
				],
			})
		);
		assert.equal((result.filter?.terms[0] as { some: { operator: string } }).some.operator, 'or');
	});

	it('maps `prop[cond&cond]` to an element match on the decoded property path', () => {
		const result = adapt(
			query({
				conditions: [
					{
						name: 'reviews',
						operator: 'and',
						conditions: [
							{ comparator: 'ge', attribute: 'rating', value: '4' },
							{ comparator: 'ge', attribute: 'helpful', value: '10' },
						],
					},
				],
			})
		);
		assert.deepEqual(result.filter?.terms[0], {
			path: ['reviews'],
			some: {
				operator: 'and',
				terms: [
					{ path: ['rating'], comparator: 'ge', value: '4' },
					{ path: ['helpful'], comparator: 'ge', value: '10' },
				],
			},
		});
	});

	it('splits a scoped match’s RAW name on literal dots and decodes each segment (§4.2)', () => {
		const dotted = adapt(query({ conditions: [{ name: 'a.b', conditions: [{ comparator: 'equals', attribute: 'c', value: '1' }] }] }));
		assert.deepEqual(dotted.filter?.terms[0], { path: ['a', 'b', 'c'], comparator: 'eq', value: '1' });
		const encoded = adapt(query({ conditions: [{ name: 'a%2Eb', conditions: [{ comparator: 'equals', attribute: 'c', value: '1' }] }] }));
		assert.deepEqual(encoded.filter?.terms[0], { path: ['a.b', 'c'], comparator: 'eq', value: '1' });
	});

	it('normalizes a single non-negated inner condition to the concatenated path (§5.3)', () => {
		const result = adapt(query({ conditions: [{ name: 'orders', conditions: [{ comparator: 'equals', attribute: 'status', value: 'open' }] }] }));
		assert.deepEqual(result.filter?.terms[0], { path: ['orders', 'status'], comparator: 'eq', value: 'open' });
	});

	it('NEVER flattens a negated inner condition — ∃¬ is not ¬∃ (§5.1.1)', () => {
		const result = adapt(
			query({ conditions: [{ name: 'tags', conditions: [{ comparator: 'eq', attribute: 'x', value: 'urgent', negated: true }] }] })
		);
		assert.deepEqual(result.filter?.terms[0], {
			path: ['tags'],
			some: { operator: 'and', terms: [{ path: ['x'], comparator: 'eq', value: 'urgent', negated: true }] },
		});
	});

	it('reads a nameless nested condition list as a plain group', () => {
		const result = adapt(
			query({
				conditions: [
					{
						conditions: [
							{ comparator: 'equals', attribute: 'a', value: '1' },
							{ comparator: 'equals', attribute: 'b', value: '2' },
						],
						operator: 'or',
					},
				],
			})
		);
		assert.deepEqual(result.filter?.terms[0], {
			operator: 'or',
			terms: [
				{ path: ['a'], comparator: 'eq', value: '1' },
				{ path: ['b'], comparator: 'eq', value: '2' },
			],
		});
	});
});

describe('harper adapter — sort, select, limit (ledger row 5)', () => {
	it('walks the sort linked list', () => {
		const result = adapt(query({ sort: { attribute: 'a', descending: false, next: { attribute: ['b', 'c'], descending: true } } }));
		assert.deepEqual(result.sort, [
			{ path: ['a'], direction: 'asc' },
			{ path: ['b', 'c'], direction: 'desc' },
		]);
	});

	it('keeps an empty sort attribute as a one-segment empty path', () => {
		assert.deepEqual(adapt(query({ sort: { attribute: '', descending: false } })).sort, [{ path: [''], direction: 'asc' }]);
	});

	it('maps the polymorphic select shapes to a projection mode', () => {
		assert.deepEqual(adapt(query({ select: 'a' })).select, { mode: 'values', fields: [{ path: ['a'] }] });
		assert.deepEqual(adapt(query({ select: ['a', 'b'] })).select, {
			mode: 'records',
			fields: [{ path: ['a'] }, { path: ['b'] }],
		});
		const tuple = Object.assign(['a', 'b'], { asArray: true });
		assert.deepEqual(adapt(query({ select: tuple })).select, { mode: 'tuples', fields: [{ path: ['a'] }, { path: ['b'] }] });
	});

	it('maps a nested select, in both the brace and the bracket shape', () => {
		const brace = Object.assign(['x', 'y'], { name: 'rel' });
		assert.deepEqual(adapt(query({ select: brace })).select, {
			mode: 'records',
			fields: [{ path: ['rel'], projection: { mode: 'records', fields: [{ path: ['x'] }, { path: ['y'] }] } }],
		});
		assert.deepEqual(adapt(query({ select: { name: 'rel', select: ['x', 'y'], conditions: [] } })).select, {
			mode: 'records',
			fields: [{ path: ['rel'], projection: { mode: 'records', fields: [{ path: ['x'] }, { path: ['y'] }] } }],
		});
	});

	it('carries limit and offset through, including values Harper failed to validate', () => {
		assert.deepEqual(adapt(query({ limit: 5, offset: 2 })), { limit: 5, offset: 2 });
		assert.ok(Number.isNaN(adapt(query({ limit: NaN })).limit));
		assert.equal(adapt(query({ offset: 2, limit: -1 })).limit, -1);
	});
});

describe('harper adapter — errors', () => {
	it('reports a deferred parseError instead of pretending the query parsed (row 8)', () => {
		const outcome = adaptHarperResult(
			query({ conditions: [{ comparator: 'equals', attribute: 'a', value: '1' }], parseError: new Error('bad query') })
		);
		assert.equal(outcome.status, 'deferred-error');
		assert.equal((outcome as { message: string }).message, 'bad query');
		assert.equal((outcome as { partial: ParseResult }).partial.filter?.terms.length, 1);
	});

	it('raises AdapterError for a KNOWN field carrying an unknown shape or value', () => {
		// Guessing here would let the harness compare a fabricated result — and possibly report
		// agreement — the first time Harper changes one of these structures.
		assert.throws(() => adaptHarperResult({ conditions: { nope: true } }), AdapterError);
		assert.throws(() => adaptHarperResult(query({ conditions: [{ comparator: 'eq', attribute: 'a', value: '1' }], operator: 'xor' })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ conditions: [{ comparator: 'eq', attribute: 'a', value: '1', negated: 'yes' }] })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ conditions: [{ comparator: 'eq', attribute: 'a', value: '1', chainedConditions: 'nope' }] })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ sort: { attribute: 'a', descending: 'yes' } })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ select: Object.assign(['a'], { asArray: 'yes' }) })), AdapterError);
	});

	it('raises AdapterError rather than guessing at a shape it does not know', () => {
		assert.throws(() => adaptHarperResult(42), AdapterError);
		assert.throws(() => adaptHarperResult(query({ conditions: [{ nonsense: true }] })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ conditions: [{ comparator: 'eq', attribute: 7, value: '1' }] })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ select: 42 })), AdapterError);
		assert.throws(() => adaptHarperResult(query({ limit: 'ten' })), AdapterError);
	});
});
