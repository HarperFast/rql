import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TaggedEncodeError, decodeTagged, encodeTagged } from '../../conformance/tagged.ts';

/** Encode, decode, encode again — the second encoding must equal the first. */
function roundTrip(value: unknown): unknown {
	const encoded = encodeTagged(value);
	const decoded = decodeTagged(encoded);
	assert.deepEqual(encodeTagged(decoded), encoded, 'round trip changed the encoding');
	return decoded;
}

describe('tagged encoding', () => {
	it('passes JSON primitives through unchanged', () => {
		for (const value of [null, true, false, '', 'x', 0, -1, 2.5]) assert.equal(encodeTagged(value), value);
	});

	it('encodes numbers JSON cannot spell', () => {
		assert.deepEqual(encodeTagged(NaN), { $: 'number', v: 'NaN' });
		assert.deepEqual(encodeTagged(Infinity), { $: 'number', v: 'Infinity' });
		assert.deepEqual(encodeTagged(-0), { $: 'number', v: '-0' });
		assert.ok(Number.isNaN(decodeTagged(encodeTagged(NaN)) as number));
		assert.ok(Object.is(decodeTagged(encodeTagged(-0)), -0));
	});

	it('round-trips undefined, which Harper returns for an empty query', () => {
		assert.deepEqual(encodeTagged(undefined), { $: 'undefined' });
		assert.equal(decodeTagged(encodeTagged(undefined)), undefined);
	});

	it('round-trips valid and invalid Dates', () => {
		const valid = new Date('2020-01-01T00:00:00.000Z');
		assert.deepEqual(encodeTagged(valid), { $: 'date', iso: '2020-01-01T00:00:00.000Z' });
		assert.deepEqual(roundTrip(valid), valid);
		// `a=eq=date:notadate` really does produce one of these.
		assert.deepEqual(encodeTagged(new Date(NaN)), { $: 'date', invalid: true });
		assert.ok(Number.isNaN((decodeTagged(encodeTagged(new Date(NaN))) as Date).getTime()));
	});

	it('round-trips a URLSearchParams, preserving repeated names and order', () => {
		const params = new URLSearchParams('a=1&b=2&a=3');
		assert.deepEqual(encodeTagged(params), {
			$: 'usp',
			ctor: 'URLSearchParams',
			entries: [
				['a', '1'],
				['b', '2'],
				['a', '3'],
			],
		});
		const decoded = decodeTagged(encodeTagged(params)) as URLSearchParams;
		assert.deepEqual([...decoded.entries()], [...params.entries()]);
	});

	it('round-trips a URLSearchParams that also carries own properties (a RequestTarget)', () => {
		const target = new URLSearchParams('a=1') as URLSearchParams & { conditions?: unknown; limit?: number };
		target.conditions = [{ attribute: 'a', comparator: 'equals', value: '1' }];
		target.limit = 10;
		const decoded = roundTrip(target) as URLSearchParams & { conditions?: unknown; limit?: number };
		assert.deepEqual([...decoded.entries()], [['a', '1']]);
		assert.deepEqual(decoded.conditions, [{ attribute: 'a', comparator: 'equals', value: '1' }]);
		assert.equal(decoded.limit, 10);
	});

	it('preserves marker properties hung off an array (select.asArray, select.name)', () => {
		const select = ['x', 'y'] as string[] & { asArray?: boolean; name?: string };
		select.asArray = true;
		select.name = 'rel';
		const encoded = encodeTagged(select) as { $: string; items: unknown[]; props: Record<string, unknown> };
		assert.equal(encoded.$, 'array');
		assert.deepEqual(encoded.items, ['x', 'y']);
		assert.deepEqual(encoded.props, { asArray: true, name: 'rel' });
		const decoded = roundTrip(select) as string[] & { asArray?: boolean; name?: string };
		assert.deepEqual([...decoded], ['x', 'y']);
		assert.equal(decoded.asArray, true);
		assert.equal(decoded.name, 'rel');
	});

	it('records the constructor of a non-plain object', () => {
		class Query {
			conditions: unknown[] = [];
		}
		assert.deepEqual(encodeTagged(new Query()), { $: 'object', ctor: 'Query', props: { conditions: { $: 'array', items: [] } } });
	});

	it('emits object keys in sorted order, so an unchanged re-record is byte-identical', () => {
		const one = encodeTagged({ b: 1, a: 2, c: 3 });
		const other = encodeTagged({ c: 3, a: 2, b: 1 });
		assert.equal(JSON.stringify(one), JSON.stringify(other));
	});

	it('does not mistake a plain object whose own key is "$" for a tag', () => {
		const decoded = roundTrip({ $: 'usp', entries: 'not really a URLSearchParams' }) as Record<string, unknown>;
		assert.deepEqual(decoded, { $: 'usp', entries: 'not really a URLSearchParams' });
	});

	it('round-trips an Error', () => {
		const error = new TypeError('boom');
		const decoded = decodeTagged(encodeTagged(error)) as Error;
		assert.equal(decoded.name, 'TypeError');
		assert.equal(decoded.message, 'boom');
	});

	it('refuses a cyclic structure rather than looping', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.throws(() => encodeTagged(cyclic), TaggedEncodeError);
	});

	it('allows the same object twice when it is not a cycle', () => {
		const shared = { a: 1 };
		assert.deepEqual(roundTrip({ left: shared, right: shared }), { left: { a: 1 }, right: { a: 1 } });
	});
});
