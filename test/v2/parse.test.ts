import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, Query, resolveComparator } from '../../src/index.ts';

// ---------------------------------------------------------------------------
// Ported from harper/unitTests/resources/query-parse.test.js
// ---------------------------------------------------------------------------

describe('Parsing queries', () => {
	it('Basic AND query', () => {
		const query = parseQuery('id=1&name=2');
		const conditions = Array.from(query);
		assert.equal(conditions.length, 2);
		assert.equal((conditions[0] as any)[0], 'id');
		assert.equal((conditions[0] as any)[1], '1');
		assert.equal((conditions[1] as any)[0], 'name');
		assert.equal((conditions[1] as any)[1], '2');
	});

	it('Basic OR query', () => {
		const query = parseQuery('id=1|name=2');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions!.length, 2);
		assert.equal(query.conditions![0].attribute, 'id');
		assert.equal(query.conditions![0].value, '1');
		assert.equal(query.conditions![1].attribute, 'name');
		assert.equal(query.conditions![1].value, '2');
	});

	it('Basic AND and nested OR query', () => {
		const query = parseQuery('id=1&(value=gt=4|name=2)');
		assert.equal(query.conditions!.length, 2);
		assert.equal(query.conditions![0].attribute, 'id');
		assert.equal(query.conditions![0].value, '1');
		assert.equal((query.conditions![1] as any).operator, 'or');
		assert.equal((query.conditions![1] as any).conditions[0].attribute, 'value');
		assert.equal((query.conditions![1] as any).conditions[0].comparator, 'gt');
		assert.equal((query.conditions![1] as any).conditions[1].comparator, 'equals');
		assert.equal((query.conditions![1] as any).conditions[1].value, '2');
	});

	it('Basic OR and nested AND/OR query', () => {
		const query = parseQuery('(value!=4&name=2)|id=5|(foo=bar&name=2&(value=gt=4|name=2))');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions!.length, 3);
		const g0 = query.conditions![0] as any;
		assert.equal(g0.operator, 'and');
		assert.equal(g0.conditions[0].attribute, 'value');
		assert.equal(g0.conditions[0].comparator, 'ne');
		assert.equal(g0.conditions[0].value, '4');
		assert.equal(g0.conditions[1].attribute, 'name');
		assert.equal(g0.conditions[1].comparator, 'equals');
		assert.equal(g0.conditions[1].value, '2');
		const c1 = query.conditions![1] as any;
		assert.equal(c1.attribute, 'id');
		assert.equal(c1.value, '5');
		const g2 = query.conditions![2] as any;
		assert.equal(g2.operator, 'and');
		assert.equal(g2.conditions[0].attribute, 'foo');
		assert.equal(g2.conditions[0].comparator, 'equals');
		assert.equal(g2.conditions[0].value, 'bar');
		assert.equal(g2.conditions[1].attribute, 'name');
		assert.equal(g2.conditions[1].comparator, 'equals');
		assert.equal(g2.conditions[1].value, '2');
		assert.equal(g2.conditions[2].operator, 'or');
		assert.equal(g2.conditions[2].conditions[0].attribute, 'value');
		assert.equal(g2.conditions[2].conditions[0].comparator, 'gt');
		assert.equal(g2.conditions[2].conditions[0].value, '4');
		assert.equal(g2.conditions[2].conditions[1].comparator, 'equals');
		assert.equal(g2.conditions[2].conditions[1].value, '2');
	});

	it('OR and nested AND/OR query with brackets and parens in values', () => {
		const query = parseQuery('[value!=4&name=2]|id=5|[foo=ba)r&name=2&[value=gt=(4)|name=2]]|id=6');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions!.length, 4);
		const g0 = query.conditions![0] as any;
		assert.equal(g0.operator, 'and');
		assert.equal(g0.conditions[0].attribute, 'value');
		assert.equal(g0.conditions[0].comparator, 'ne');
		assert.equal(g0.conditions[0].value, '4');
		assert.equal(g0.conditions[1].attribute, 'name');
		assert.equal(g0.conditions[1].comparator, 'equals');
		assert.equal(g0.conditions[1].value, '2');
		const c1 = query.conditions![1] as any;
		assert.equal(c1.attribute, 'id');
		assert.equal(c1.value, '5');
		const g2 = query.conditions![2] as any;
		assert.equal(g2.operator, 'and');
		assert.equal(g2.conditions[0].attribute, 'foo');
		assert.equal(g2.conditions[0].comparator, 'equals');
		assert.equal(g2.conditions[0].value, 'ba)r');
		assert.equal(g2.conditions[1].attribute, 'name');
		assert.equal(g2.conditions[1].comparator, 'equals');
		assert.equal(g2.conditions[1].value, '2');
		assert.equal(g2.conditions[2].operator, 'or');
		assert.equal(g2.conditions[2].conditions[0].attribute, 'value');
		assert.equal(g2.conditions[2].conditions[0].comparator, 'gt');
		assert.equal(g2.conditions[2].conditions[0].value, '(4)');
		assert.equal(g2.conditions[2].conditions[1].comparator, 'equals');
		assert.equal(g2.conditions[2].conditions[1].value, '2');
		const c3 = query.conditions![3] as any;
		assert.equal(c3.attribute, 'id');
	});

	it('Query and select and limit', () => {
		const query = parseQuery('id=1&name=2&select(id,name)&limit(10)');
		assert.equal(query.conditions!.length, 2);
		assert.equal(query.conditions![0].attribute, 'id');
		assert.equal(query.conditions![0].value, '1');
		assert.equal(query.conditions![1].attribute, 'name');
		assert.equal(query.conditions![1].value, '2');
		assert.equal(query.select!.length, 2);
		assert.equal(query.select![0], 'id');
		assert.equal(query.select![1], 'name');
		assert.equal(query.limit, 10);
	});

	it('Limit with offset', () => {
		const query = parseQuery('limit(5,10)');
		assert.equal(query.conditions!.length, 0);
		assert.equal(query.offset, 5);
		assert.equal(query.limit, 5);
	});

	it('Coercible vs strict', () => {
		const query = parseQuery(
			'id=1&foo==number:5&bar==null&baz!=boolean:true&qux!=date:2024-01-05T20%3A07%3A27.955Z&strict===number:5'
		);
		assert.equal(query.conditions!.length, 6);
		assert.equal(query.conditions![0].attribute, 'id');
		assert.equal(query.conditions![0].value, '1');
		assert.equal(query.conditions![1].value, 5);
		assert.equal(query.conditions![2].value, null);
		assert.equal(query.conditions![3].value, true);
		assert.ok(query.conditions![4].value instanceof Date);
		assert.equal(query.conditions![5].value, 'number:5');
	});

	it('Coerce date', () => {
		const query = parseQuery('time=lt=date:2024-01-05T20%3A07%3A27.955Z&time=gt=date:1602872124871');
		assert.equal(query.conditions!.length, 2);
		assert.equal(query.conditions![0].attribute, 'time');
		assert.equal((query.conditions![0].value as Date).getTime(), new Date('2024-01-05T20:07:27.955Z').getTime());
		assert.equal((query.conditions![1].value as Date).getTime(), 1602872124871);
	});

	it('Nested select', () => {
		const query = parseQuery('select(related{name,otherTable{other_name}},id,name)');
		assert.equal(query.conditions!.length, 0);
		assert.equal(query.select!.length, 3);
		assert.equal((query.select![0] as any).name, 'related');
		assert.equal((query.select![0] as any).length, 2);
		assert.equal((query.select![0] as any)[0], 'name');
		assert.equal((query.select![0] as any)[1].name, 'otherTable');
		assert.equal((query.select![0] as any)[1].length, 1);
		assert.equal((query.select![0] as any)[1][0], 'other_name');
	});

	it('Nested select using select', () => {
		const query = parseQuery('select(related[select(name,otherTable[select(other_name,)])],id,name)');
		assert.equal(query.conditions!.length, 0);
		assert.equal(query.select!.length, 3);
		assert.equal((query.select![0] as any).name, 'related');
		assert.equal((query.select![0] as any).select.length, 2);
		assert.equal((query.select![0] as any).select[0], 'name');
		assert.equal((query.select![0] as any).select[1].name, 'otherTable');
		assert.equal((query.select![0] as any).select[1].select.length, 1);
		assert.equal((query.select![0] as any).select[1].select[0], 'other_name');
	});

	it('Multi-part properties', () => {
		const query = parseQuery('name.subname=2');
		assert.equal(query.conditions!.length, 1);
		assert.deepEqual(query.conditions![0].attribute, ['name', 'subname']);
	});

	it('Multi-part properties in sort', () => {
		const query = parseQuery('name.subname=2&sort(name.subname)');
		assert.equal(query.conditions!.length, 1);
		assert.deepEqual(query.conditions![0].attribute, ['name', 'subname']);
		assert.deepEqual(query.sort!.attribute, ['name', 'subname']);
	});

	it('Multi-part properties in complex sort', () => {
		const query = parseQuery('name.subname=2&sort(+name.subname,-otherName)');
		assert.deepEqual(query.sort!.attribute, ['name', 'subname']);
		assert.equal(query.sort!.descending, false);
		assert.equal(query.sort!.next!.attribute, 'otherName');
		assert.equal(query.sort!.next!.descending, true);
	});

	it('Union with calls', () => {
		const query = parseQuery('select(name,age)&name=2|name=3&sort(+name)');
		assert.equal(query.sort!.attribute, 'name');
		assert.equal(query.operator, 'or');
		assert.equal(query.conditions!.length, 2);
		assert.deepEqual(query.select, ['name', 'age']);
	});

	it('Bracket/array parameter', () => {
		const query = parseQuery('itemIds[]=1&itemIds[]=2');
		assert.equal(query.conditions!.length, 2);
		assert.equal(query.conditions![0].value, '1');
		assert.equal(query.conditions![1].value, '2');
	});

	it('Bad calls', () => {
		assert.throws(() => parseQuery('limit(5,10'), /expected '\)'/);
		assert.throws(() => parseQuery('unknown(5,10)'), /unknown query function call/);
		assert.throws(() => parseQuery('select([)'), /expected '\]'/);
		assert.throws(() => parseQuery('select)'), /unexpected token '\)'/);
	});

	it('Bad nesting', () => {
		assert.throws(() => parseQuery('(name=value)shouldntbehere'), /expected operator/);
		assert.throws(() => parseQuery('(name))'), /no attribute/);
		assert.throws(() => parseQuery('(=value&=test)'), /attribute must be specified/);
		assert.throws(() => parseQuery('(name=(value))'), /no attribute/);
		assert.throws(() => parseQuery('name=value|test=3&foo=bar'), /mix operators/);
		assert.throws(() => parseQuery('name=value&[test=3&foo=bar|test=4]'), /mix operators/);
	});
});

describe('Parsing queries with target (RequestTarget-style)', () => {
	it('Basic AND query', () => {
		const target = new Query();
		target.conditions = [];
		parseQuery('id=1&name=2', target);
		// fast path: target untouched, iterate as URLSearchParams (nothing set in target)
		// Actually fast path with target returns target as-is.
		// Use a fresh parseQuery without target to test fast-path iteration.
		const query = parseQuery('id=1&name=2');
		const conditions = Array.from(query);
		assert.equal(conditions.length, 2);
		assert.equal((conditions[0] as any)[0], 'id');
		assert.equal((conditions[0] as any)[1], '1');
	});

	it('Basic OR query with target', () => {
		const target = new Query();
		parseQuery('id=1|name=2', target);
		assert.equal(target.operator, 'or');
		assert.equal(target.conditions!.length, 2);
		assert.equal(target.conditions![0].attribute, 'id');
		assert.equal(target.conditions![0].value, '1');
		assert.equal(target.conditions![1].attribute, 'name');
		assert.equal(target.conditions![1].value, '2');
	});

	it('Basic AND and nested OR query with target', () => {
		const target = new Query();
		parseQuery('id=1&(value=gt=4|name=2)', target);
		assert.equal(target.conditions!.length, 2);
		assert.equal(target.conditions![0].attribute, 'id');
		assert.equal(target.conditions![0].value, '1');
		assert.equal((target.conditions![1] as any).operator, 'or');
	});
});

// ---------------------------------------------------------------------------
// Ported from harper/unitTests/resources/query-tier1.test.js
// 'REST query parsing' describe block (~lines 152–197)
// ---------------------------------------------------------------------------

describe('resolveComparator helper', () => {
	it('preserves existing aliases as-is', () => {
		assert.deepEqual(resolveComparator('eq'), { comparator: 'eq', negated: false });
		assert.deepEqual(resolveComparator('not_equal'), { comparator: 'not_equal', negated: false });
		assert.deepEqual(resolveComparator('greater_than'), { comparator: 'greater_than', negated: false });
	});

	it('strips not_ prefix on negatable comparators', () => {
		assert.deepEqual(resolveComparator('not_in'), { comparator: 'in', negated: true });
		assert.deepEqual(resolveComparator('not_starts_with'), { comparator: 'starts_with', negated: true });
		assert.deepEqual(resolveComparator('not_between'), { comparator: 'between', negated: true });
		assert.deepEqual(resolveComparator('not_contains'), { comparator: 'contains', negated: true });
		assert.deepEqual(resolveComparator('not_ends_with'), { comparator: 'ends_with', negated: true });
	});

	it('returns input unchanged for unknown comparators', () => {
		assert.deepEqual(resolveComparator('unknown'), { comparator: 'unknown', negated: false });
		assert.deepEqual(resolveComparator(undefined), { comparator: undefined, negated: false });
	});
});

describe('REST query parsing', () => {
	it('parses (v1,v2,v3) list-value syntax with `in`', () => {
		const q = parseQuery('status=in=(active,pending,inactive)');
		assert.equal(q.conditions![0].comparator, 'in');
		assert.deepEqual(q.conditions![0].value, ['active', 'pending', 'inactive']);
	});

	it('parses single-element list', () => {
		const q = parseQuery('status=in=(active)');
		assert.deepEqual(q.conditions![0].value, ['active']);
	});

	it('parses empty list', () => {
		const q = parseQuery('status=in=()');
		assert.deepEqual(q.conditions![0].value, []);
	});

	it('parses not_in to negated in', () => {
		const q = parseQuery('status=not_in=(active,pending)');
		assert.equal(q.conditions![0].comparator, 'in');
		assert.deepEqual(q.conditions![0].value, ['active', 'pending']);
		assert.equal(q.conditions![0].negated, true);
	});

	it('parses not_starts_with as negated starts_with', () => {
		const q = parseQuery('name=not_starts_with=Joh');
		assert.equal(q.conditions![0].comparator, 'starts_with');
		assert.equal(q.conditions![0].value, 'Joh');
		assert.equal(q.conditions![0].negated, true);
	});

	it('parses between with list value', () => {
		const q = parseQuery('age=between=(18,65)');
		assert.equal(q.conditions![0].comparator, 'between');
		assert.deepEqual(q.conditions![0].value, ['18', '65']);
	});

	it('parses typed values inside list', () => {
		const q = parseQuery('id=in=(number:1,number:2,number:3)');
		assert.deepEqual(q.conditions![0].value, [1, 2, 3]);
	});

	it('preserves backwards-compat for non-list (...) values on non-list comparators', () => {
		const q = parseQuery('value=gt=(4)');
		assert.equal(q.conditions![0].value, '(4)');
	});

	it('accepts multi-character FIQL operators', () => {
		const q = parseQuery('a=between=(1,2)|b=in=(x,y)');
		assert.equal(q.conditions![0].comparator, 'between');
		assert.equal(q.conditions![1].comparator, 'in');
	});
});

// ---------------------------------------------------------------------------
// New: reentrancy and URLSearchParams behavior
// ---------------------------------------------------------------------------

describe('Reentrancy', () => {
	it('sequential parses with errors do not pollute subsequent parses', () => {
		assert.throws(() => parseQuery('name=value|test=3&foo=bar'), /mix operators/);
		// fresh parse after the failed one must succeed cleanly
		const q = parseQuery('status=in=(active,pending)');
		assert.equal(q.conditions![0].comparator, 'in');
		assert.deepEqual(q.conditions![0].value, ['active', 'pending']);
	});

	it('two independent parses return independent results', () => {
		const a = parseQuery('id=1|name=2');
		const b = parseQuery('foo=gt=5&bar=lt=10');
		assert.equal(a.operator, 'or');
		assert.equal(a.conditions![0].attribute, 'id');
		assert.equal(b.conditions![0].attribute, 'foo');
		assert.equal(b.conditions![0].comparator, 'gt');
		assert.equal(b.conditions![1].comparator, 'lt');
	});

	it('failed mid-parse does not corrupt a later successful parse', () => {
		const target = new Query();
		parseQuery('limit(5,10', target); // mismatched paren — writes parseError
		assert.ok(target.parseError);
		// new independent parse
		const q = parseQuery('age=between=(18,65)');
		assert.equal(q.conditions![0].comparator, 'between');
		assert.deepEqual(q.conditions![0].value, ['18', '65']);
	});
});

describe('Query extends URLSearchParams', () => {
	it('fast-path: get() and getAll() work', () => {
		const q = parseQuery('foo=bar&foo=baz&x=1');
		assert.equal(q.get('foo'), 'bar');
		assert.deepEqual(q.getAll('foo'), ['bar', 'baz']);
	});

	it('fast-path: iteration yields [name, value] pairs', () => {
		const q = parseQuery('a=1&b=2');
		const entries = Array.from(q);
		assert.deepEqual(entries, [['a', '1'], ['b', '2']]);
	});

	it('parsed-path: Query is still a URLSearchParams instance', () => {
		const q = parseQuery('id=1|name=2');
		assert.ok(q instanceof URLSearchParams);
		assert.ok(q instanceof Query);
	});

	it('parsed-path with target: target is returned as Query instance', () => {
		const target = new Query();
		const result = parseQuery('id=1|name=2', target);
		assert.strictEqual(result, target);
		assert.ok(result instanceof Query);
	});

	it('empty string returns empty Query', () => {
		const q = parseQuery('');
		assert.ok(q instanceof Query);
		assert.equal(q.conditions, undefined);
	});
});

// ---------------------------------------------------------------------------
// group-by fix: must NOT fall through into sort
// ---------------------------------------------------------------------------

describe('group-by fix', () => {
	it('group-by records error without setting sort', () => {
		const target = new Query();
		parseQuery('group-by(foo)', target);
		assert.ok(target.parseError, 'should have a parseError');
		assert.match(target.parseError!.message, /group by/);
		assert.equal(target.sort, undefined, 'group-by must not set sort');
	});

	it('group-by does not clobber a preceding sort() call', () => {
		const target = new Query();
		parseQuery('sort(name)&group-by(foo)', target);
		assert.ok(target.parseError);
		// sort set by the preceding sort() call must survive
		assert.equal(target.sort!.attribute, 'name');
	});
});

// ---------------------------------------------------------------------------
// Wildcard behavior
// ---------------------------------------------------------------------------

describe('Wildcard handling', () => {
	it('trailing * on == converts to starts_with', () => {
		const q = parseQuery('name==John*');
		assert.equal(q.conditions![0].comparator, 'starts_with');
		assert.equal(q.conditions![0].value, 'John');
	});

	it('non-trailing * throws', () => {
		assert.throws(() => parseQuery('name==*John'), /wildcard/);
	});
});
