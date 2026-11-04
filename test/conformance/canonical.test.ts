import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, diffCanonical, isRejection, stableStringify } from '../../conformance/canonical.ts';
import type { Json } from '../../conformance/canonical.ts';

describe('canonicalize', () => {
	it('leaves an absent member absent — absent is not the same as empty', () => {
		assert.deepEqual(canonicalize({}), {});
		assert.deepEqual(canonicalize({ sort: [] }), { sort: [] });
	});

	it('keeps a value’s type, so "3" never reads as 3', () => {
		const asString = canonicalize({ filter: { operator: 'and', terms: [{ path: ['a'], comparator: 'eq', value: '3' }] } });
		const asNumber = canonicalize({ filter: { operator: 'and', terms: [{ path: ['a'], comparator: 'eq', value: 3 }] } });
		assert.notDeepEqual(asString, asNumber);
	});

	it('renders a Date, an invalid Date and a non-finite number distinguishably', () => {
		const of = (value: unknown): Json =>
			(canonicalize({ filter: { operator: 'and', terms: [{ path: ['a'], comparator: 'eq', value: value as never }] } }) as never)[
				'filter'
			]['terms'][0]['value'];
		assert.deepEqual(of(new Date('2020-01-01T00:00:00.000Z')), { $date: '2020-01-01T00:00:00.000Z' });
		assert.deepEqual(of(new Date(NaN)), { $date: 'invalid' });
		assert.deepEqual(of(NaN), { $number: 'NaN' });
	});

	it('distinguishes a negated condition from a plain one', () => {
		const plain = canonicalize({ filter: { operator: 'and', terms: [{ path: ['a'], comparator: 'eq', value: '1' }] } });
		const negated = canonicalize({ filter: { operator: 'and', terms: [{ path: ['a'], comparator: 'eq', value: '1', negated: true }] } });
		assert.notDeepEqual(plain, negated);
	});

	it('distinguishes an element match from a plain condition on the same path', () => {
		const match = canonicalize({
			filter: { operator: 'and', terms: [{ path: ['a'], some: { operator: 'and', terms: [{ path: [], comparator: 'ge', value: 1 }] } }] },
		});
		const condition = canonicalize({ filter: { operator: 'and', terms: [{ path: ['a'], comparator: 'ge', value: 1 }] } });
		assert.notDeepEqual(match, condition);
	});
});

describe('stableStringify', () => {
	it('sorts object keys so equal structures produce equal bytes', () => {
		assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
		assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
	});

	it('keeps array order, which is meaningful', () => {
		assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
	});

	it('indents without changing the value', () => {
		assert.equal(JSON.stringify(JSON.parse(stableStringify({ a: [1, { b: 2 }] }, 2))), '{"a":[1,{"b":2}]}');
	});
});

describe('diffCanonical', () => {
	it('finds nothing when two results are equal', () => {
		assert.deepEqual(diffCanonical({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), []);
	});

	it('names the pointer of a differing leaf', () => {
		assert.deepEqual(diffCanonical({ a: { b: 1 } }, { a: { b: 2 } }), [{ at: '/a/b', kind: 'value', ref: 1, harper: 2 }]);
	});

	it('reports a type change rather than descending into it', () => {
		assert.deepEqual(diffCanonical({ a: '1' }, { a: 1 }), [{ at: '/a', kind: 'type', ref: '1', harper: 1 }]);
	});

	it('reports members present on only one side', () => {
		assert.deepEqual(diffCanonical({ a: 1 }, {}), [{ at: '/a', kind: 'ref-only', ref: 1 }]);
		assert.deepEqual(diffCanonical({}, { a: 1 }), [{ at: '/a', kind: 'harper-only', harper: 1 }]);
	});

	it('reports extra and missing array elements by index', () => {
		assert.deepEqual(diffCanonical([1], [1, 2]), [{ at: '/1', kind: 'harper-only', harper: 2 }]);
		assert.deepEqual(diffCanonical([1, 2], [1]), [{ at: '/1', kind: 'ref-only', ref: 2 }]);
	});
});

describe('isRejection', () => {
	it('counts both a throw and a deferred error as "not accepted"', () => {
		assert.equal(isRejection({ status: 'rejected', error: 'x' }), true);
		assert.equal(isRejection({ status: 'deferred-error', error: 'x', canonical: {} }), true);
		assert.equal(isRejection({ status: 'parsed', canonical: {} }), false);
		assert.equal(isRejection({ status: 'timeout', ms: 1 }), false);
	});
});
