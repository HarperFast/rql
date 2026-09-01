import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, resolveFiqlName } from '../../src/index.ts';
import type { Condition, Group, ElementMatch, ParseResult } from '../../src/index.ts';

// Helpers
function cond(path: string[], comparator: string, value: unknown, negated?: boolean): Condition {
	const c: Condition = { path, comparator, value: value as any };
	if (negated) c.negated = true;
	return c;
}
function andGrp(...terms: (Condition | Group)[]): Group { return { operator: 'and', terms }; }
function orGrp(...terms: (Condition | Group)[]): Group { return { operator: 'or', terms }; }

// ---------------------------------------------------------------------------
// Basic conditions — single `=` is verbatim eq
// ---------------------------------------------------------------------------

describe('Verbatim eq (single =)', () => {
	it('simple a=b', () => {
		const r = parseQuery('id=1');
		assert.deepEqual(r.filter, andGrp(cond(['id'], 'eq', '1')));
	});

	it('a=b&c=d → and group, verbatim strings', () => {
		const r = parseQuery('id=1&name=alice');
		assert.deepEqual(r.filter, andGrp(
			cond(['id'], 'eq', '1'),
			cond(['name'], 'eq', 'alice'),
		));
	});
});

describe('Interpreted eq (==)', () => {
	it('a==b → eq interpreted', () => {
		const r = parseQuery('foo==number:5');
		assert.deepEqual(r.filter, andGrp(cond(['foo'], 'eq', 5)));
	});

	it('a==null → null value', () => {
		const r = parseQuery('bar==null');
		assert.deepEqual(r.filter, andGrp(cond(['bar'], 'eq', null)));
	});
});

describe('Negated eq (!=)', () => {
	it('a!=b → negated eq, interpreted', () => {
		const r = parseQuery('baz!=boolean:true');
		assert.deepEqual(r.filter, andGrp(cond(['baz'], 'eq', true, true)));
	});
});

describe('Strict verbatim (===, !==)', () => {
	it('===value stays as string', () => {
		const r = parseQuery('strict===number:5');
		// verbatim — no interpretation
		assert.deepEqual(r.filter, andGrp(cond(['strict'], 'eq', 'number:5')));
	});

	it('!==value → negated eq, verbatim', () => {
		const r = parseQuery('x!==foo');
		assert.deepEqual(r.filter, andGrp(cond(['x'], 'eq', 'foo', true)));
	});
});

describe('Ordered comparators', () => {
	it('< > <= >=', () => {
		const r = parseQuery('price<10&qty<=5&age>18&score>=90');
		assert.deepEqual(r.filter, andGrp(
			cond(['price'], 'lt', 10),
			cond(['qty'], 'le', 5),
			cond(['age'], 'gt', 18),
			cond(['score'], 'ge', 90),
		));
	});

	it('FIQL lt/le/gt/ge', () => {
		const r = parseQuery('age=gt=4');
		assert.deepEqual(r.filter, andGrp(cond(['age'], 'gt', 4)));
	});
});

// ---------------------------------------------------------------------------
// OR and grouping
// ---------------------------------------------------------------------------

describe('OR query', () => {
	it('id=1|name=2', () => {
		const r = parseQuery('id=1|name=2');
		assert.deepEqual(r.filter, orGrp(cond(['id'], 'eq', '1'), cond(['name'], 'eq', '2')));
	});

	it('nested: id=1&(a=gt=4|name=2)', () => {
		const r = parseQuery('id=1&(value=gt=4|name=2)');
		assert.deepEqual(r.filter, andGrp(
			cond(['id'], 'eq', '1'),
			orGrp(cond(['value'], 'gt', 4), cond(['name'], 'eq', '2')),
		));
	});

	it('complex nested: (ne!=4&name=2)|id=5|(foo=bar&name=2&(a=gt=4|name=2))', () => {
		const r = parseQuery('(value!=4&name=2)|id=5|(foo=bar&name=2&(value=gt=4|name=2))');
		assert.equal(r.filter!.operator, 'or');
		assert.equal(r.filter!.terms.length, 3);
		assert.equal((r.filter!.terms[0] as Group).operator, 'and');
		assert.equal((r.filter!.terms[0] as Group).terms[0].comparator, 'eq');
		assert.equal(((r.filter!.terms[0] as Group).terms[0] as Condition).negated, true);
	});

	it('bracket groups [...]', () => {
		const r = parseQuery('[value!=4&name=2]|id=5');
		assert.equal(r.filter!.operator, 'or');
		assert.equal((r.filter!.terms[0] as Group).operator, 'and');
		assert.equal((r.filter!.terms[1] as Condition).path[0], 'id');
	});
});

// ---------------------------------------------------------------------------
// Desugaring: comparator aliases
// ---------------------------------------------------------------------------

describe('Alias desugaring', () => {
	it('ne → negated eq', () => {
		const r = parseQuery('a=ne=1');
		assert.deepEqual(r.filter, andGrp(cond(['a'], 'eq', 1, true)));
	});

	it('equals → eq (verbatim)', () => {
		const r = parseQuery('a=equals=hello');
		assert.deepEqual(r.filter, andGrp(cond(['a'], 'eq', 'hello')));
	});

	it('not_equal → negated eq (verbatim)', () => {
		const r = parseQuery('a=not_equal=hello');
		assert.deepEqual(r.filter, andGrp(cond(['a'], 'eq', 'hello', true)));
	});

	it('ne and != produce same canonical form (interpreted)', () => {
		const a = parseQuery('x=ne=1');
		const b = parseQuery('x!=1');
		// Both → negated eq, interpreted (numeral auto-converts: value is number 1)
		assert.deepEqual(a.filter, b.filter);
	});

	it('sw/ew/ct aliases', () => {
		assert.deepEqual(parseQuery('a=sw=foo').filter, andGrp(cond(['a'], 'starts_with', 'foo')));
		assert.deepEqual(parseQuery('a=ew=bar').filter, andGrp(cond(['a'], 'ends_with', 'bar')));
		assert.deepEqual(parseQuery('a=ct=baz').filter, andGrp(cond(['a'], 'contains', 'baz')));
	});

	it('less_than / greaterThan aliases', () => {
		assert.deepEqual(parseQuery('a=less_than=5').filter, andGrp(cond(['a'], 'lt', 5)));
		assert.deepEqual(parseQuery('a=greaterThan=5').filter, andGrp(cond(['a'], 'gt', 5)));
	});

	it('out → negated in', () => {
		const r = parseQuery('a=out=(1,2)');
		const c = r.filter!.terms[0] as Condition;
		assert.equal(c.comparator, 'in');
		assert.equal(c.negated, true);
		assert.deepEqual(c.value, [1, 2]);
	});
});

// ---------------------------------------------------------------------------
// between desugaring
// ---------------------------------------------------------------------------

describe('between desugaring', () => {
	it('between=(lo,hi) → ElementMatch wrapping ge+le group', () => {
		const r = parseQuery('age=between=(18,65)');
		// filter is an and-Group with one term: the ElementMatch.
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['age']);
		assert.equal(em.some.operator, 'and');
		assert.equal(em.some.terms.length, 2);
		assert.equal((em.some.terms[0] as Condition).comparator, 'ge');
		assert.equal((em.some.terms[0] as Condition).value, 18);
		assert.deepEqual((em.some.terms[0] as Condition).path, []);
		assert.equal((em.some.terms[1] as Condition).comparator, 'le');
		assert.equal((em.some.terms[1] as Condition).value, 65);
		assert.deepEqual((em.some.terms[1] as Condition).path, []);
		assert.equal(em.negated, undefined);
	});

	it('not_between=(lo,hi) → negated ElementMatch wrapping ge+le group', () => {
		const r = parseQuery('age=not_between=(18,65)');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['age']);
		assert.equal(em.some.operator, 'and');
		assert.equal(em.negated, true);
		assert.equal((em.some.terms[0] as Condition).comparator, 'ge');
		assert.equal((em.some.terms[1] as Condition).comparator, 'le');
	});

	it('between with typed values', () => {
		const r = parseQuery('score=between=(number:10,number:99)');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.equal((em.some.terms[0] as Condition).value, 10);
		assert.equal((em.some.terms[1] as Condition).value, 99);
	});
});

// ---------------------------------------------------------------------------
// Chaining (&= / |=) desugaring
// ---------------------------------------------------------------------------

describe('Chaining desugaring', () => {
	// &= means "same-element scope": some one element of path satisfies ALL chained conditions.
	it('age=ge=20&=le=30 → ElementMatch with element-relative conditions', () => {
		const r = parseQuery('age=ge=20&=le=30');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['age']);
		assert.equal(em.some.operator, 'and');
		assert.equal(em.some.terms.length, 2);
		assert.equal((em.some.terms[0] as Condition).comparator, 'ge');
		assert.deepEqual((em.some.terms[0] as Condition).path, []);
		assert.equal((em.some.terms[1] as Condition).comparator, 'le');
		assert.deepEqual((em.some.terms[1] as Condition).path, []);
	});

	it('|= produces ElementMatch with or operator', () => {
		const r = parseQuery('status=eq=active|=eq=pending');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['status']);
		assert.equal(em.some.operator, 'or');
		assert.equal((em.some.terms[0] as Condition).value, 'active');
		assert.equal((em.some.terms[1] as Condition).value, 'pending');
	});

	// Semantic motivation: chained vs un-chained are different for list-valued properties.
	it('chained vs un-chained produce different canonical shapes (ski-lengths)', () => {
		// Chained: some ONE skiLength value must be in [175,180].
		const chained = parseQuery('skiLengths=ge=175&=le=180');
		// Un-chained: some element ≥175 AND some (possibly different) element ≤180.
		const unchained = parseQuery('skiLengths=ge=175&skiLengths=le=180');

		const em = chained.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['skiLengths']);
		assert.equal(em.some.operator, 'and');
		assert.deepEqual((em.some.terms[0] as Condition).path, []);
		assert.deepEqual((em.some.terms[1] as Condition).path, []);

		assert.equal(unchained.filter!.terms.length, 2);
		assert.deepEqual((unchained.filter!.terms[0] as Condition).path, ['skiLengths']);
		assert.deepEqual((unchained.filter!.terms[1] as Condition).path, ['skiLengths']);

		assert.notDeepEqual(chained.filter, unchained.filter);
	});
});

// ---------------------------------------------------------------------------
// in comparator
// ---------------------------------------------------------------------------

describe('in comparator', () => {
	it('(v1,v2,v3) list', () => {
		const r = parseQuery('status=in=(active,pending,inactive)');
		const c = r.filter!.terms[0] as Condition;
		assert.equal(c.comparator, 'in');
		assert.deepEqual(c.value, ['active', 'pending', 'inactive']);
	});

	it('empty list', () => {
		const r = parseQuery('status=in=()');
		assert.deepEqual((r.filter!.terms[0] as Condition).value, []);
	});

	it('typed values in list', () => {
		const r = parseQuery('id=in=(number:1,number:2,number:3)');
		assert.deepEqual((r.filter!.terms[0] as Condition).value, [1, 2, 3]);
	});

	it('not_in → negated in', () => {
		const r = parseQuery('status=not_in=(active,pending)');
		const c = r.filter!.terms[0] as Condition;
		assert.equal(c.comparator, 'in');
		assert.equal(c.negated, true);
		assert.deepEqual(c.value, ['active', 'pending']);
	});
});

// ---------------------------------------------------------------------------
// Wildcard
// ---------------------------------------------------------------------------

describe('Wildcard', () => {
	it('trailing * on == → starts_with', () => {
		const r = parseQuery('name==John*');
		assert.deepEqual(r.filter, andGrp(cond(['name'], 'starts_with', 'John')));
	});

	it('non-trailing * throws', () => {
		assert.throws(() => parseQuery('name==*John'), /wildcard/);
	});

	it('not_starts_with via FIQL', () => {
		const r = parseQuery('name=not_starts_with=Joh');
		const c = r.filter!.terms[0] as Condition;
		assert.equal(c.comparator, 'starts_with');
		assert.equal(c.negated, true);
		assert.equal(c.value, 'Joh');
	});
});

// ---------------------------------------------------------------------------
// Typed values
// ---------------------------------------------------------------------------

describe('Typed values', () => {
	it('number:, boolean:, date:', () => {
		const r = parseQuery('a==number:5&b==boolean:true&c!=date:2024-01-05T20%3A07%3A27.955Z');
		const terms = r.filter!.terms as Condition[];
		assert.equal(terms[0].value, 5);
		assert.equal(terms[1].value, true);
		assert.ok(terms[2].value instanceof Date);
		assert.equal((terms[2].value as Date).getTime(), new Date('2024-01-05T20:07:27.955Z').getTime());
	});

	it('date: with numeric epoch', () => {
		const r = parseQuery('time=gt=date:1602872124871');
		assert.ok((r.filter!.terms[0] as Condition).value instanceof Date);
		assert.equal(((r.filter!.terms[0] as Condition).value as Date).getTime(), 1602872124871);
	});

	it('number:$X base-36', () => {
		const r = parseQuery('x==number:$z');
		assert.equal((r.filter!.terms[0] as Condition).value, 35);
	});

	it('string: prefix suppresses interpretation', () => {
		const r = parseQuery('x==string:null');
		assert.equal((r.filter!.terms[0] as Condition).value, 'null');
	});

	it('unknown type prefix throws', () => {
		assert.throws(() => parseQuery('x==custom:foo'), /Unknown type prefix/);
	});
});

// ---------------------------------------------------------------------------
// Property paths
// ---------------------------------------------------------------------------

describe('Property paths', () => {
	it('dotted path → multi-segment', () => {
		const r = parseQuery('name.subname=2');
		assert.deepEqual((r.filter!.terms[0] as Condition).path, ['name', 'subname']);
	});

	it('%2E in segment is a literal dot (single segment)', () => {
		const r = parseQuery('a%2Eb==3');
		assert.deepEqual((r.filter!.terms[0] as Condition).path, ['a.b']);
	});

	it('a.b path vs a%2Eb path are different', () => {
		const dotted = parseQuery('a.b==3');
		const encoded = parseQuery('a%2Eb==3');
		assert.deepEqual((dotted.filter!.terms[0] as Condition).path, ['a', 'b']);
		assert.deepEqual((encoded.filter!.terms[0] as Condition).path, ['a.b']);
	});
});

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

describe('sort()', () => {
	it('single field ascending', () => {
		const r = parseQuery('sort(name)');
		assert.deepEqual(r.sort, [{ path: ['name'], direction: 'asc' }]);
	});

	it('+ and - prefixes', () => {
		const r = parseQuery('sort(+name,-age)');
		assert.deepEqual(r.sort, [
			{ path: ['name'], direction: 'asc' },
			{ path: ['age'], direction: 'desc' },
		]);
	});

	it('dotted sort key', () => {
		const r = parseQuery('sort(name.subname)');
		assert.deepEqual(r.sort, [{ path: ['name', 'subname'], direction: 'asc' }]);
	});

	it('conditions + sort', () => {
		const r = parseQuery('name.subname=2&sort(+name.subname,-otherName)');
		assert.deepEqual(r.sort, [
			{ path: ['name', 'subname'], direction: 'asc' },
			{ path: ['otherName'], direction: 'desc' },
		]);
		assert.deepEqual((r.filter!.terms[0] as Condition).path, ['name', 'subname']);
	});
});

// ---------------------------------------------------------------------------
// limit / offset
// ---------------------------------------------------------------------------

describe('limit()', () => {
	it('limit(10) → limit=10', () => {
		const r = parseQuery('limit(10)');
		assert.equal(r.limit, 10);
		assert.equal(r.offset, undefined);
	});

	it('limit(5,10) → offset=5, limit=5', () => {
		const r = parseQuery('limit(5,10)');
		assert.equal(r.offset, 5);
		assert.equal(r.limit, 5);
	});
});

// ---------------------------------------------------------------------------
// select / projection
// ---------------------------------------------------------------------------

describe('select()', () => {
	it('single field → values mode', () => {
		const r = parseQuery('select(id)');
		assert.deepEqual(r.select, { mode: 'values', fields: [{ path: ['id'] }] });
	});

	it('two fields → records mode', () => {
		const r = parseQuery('select(id,name)');
		assert.deepEqual(r.select, {
			mode: 'records',
			fields: [{ path: ['id'] }, { path: ['name'] }],
		});
	});

	it('[a,b] → tuples mode', () => {
		const r = parseQuery('select([id,name])');
		assert.deepEqual(r.select, {
			mode: 'tuples',
			fields: [{ path: ['id'] }, { path: ['name'] }],
		});
	});

	it('nested brace select', () => {
		const r = parseQuery('select(related{name,other_name},id)');
		assert.deepEqual(r.select!.mode, 'records');
		assert.equal(r.select!.fields[0].path[0], 'related');
		assert.deepEqual(r.select!.fields[0].projection, {
			mode: 'records',
			fields: [{ path: ['name'] }, { path: ['other_name'] }],
		});
		assert.deepEqual(r.select!.fields[1].path, ['id']);
	});

	it('select + conditions + limit', () => {
		const r = parseQuery('id=1&name=2&select(id,name)&limit(10)');
		assert.equal(r.filter!.terms.length, 2);
		assert.deepEqual(r.select!.fields.map((f) => f.path), [['id'], ['name']]);
		assert.equal(r.limit, 10);
	});
});

// ---------------------------------------------------------------------------
// group-by (reserved, error)
// ---------------------------------------------------------------------------

describe('group-by', () => {
	it('records error, does not set sort or filter', () => {
		assert.throws(() => parseQuery('group-by(foo)'), /group-by/);
	});

	it('deferErrors collects error without throwing', () => {
		const r = parseQuery('group-by(foo)', { deferErrors: true });
		assert.ok(r.parseError);
		assert.match(r.parseError.message, /group-by/);
		assert.equal(r.sort, undefined);
	});
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('Parse errors', () => {
	it('unbalanced ( throws', () => {
		assert.throws(() => parseQuery('limit(5,10'), /expected '\)'/);
	});

	it('unknown call function', () => {
		assert.throws(() => parseQuery('unknown(5,10)'), /unknown call function/);
	});

	it('mixing & and | in one group', () => {
		assert.throws(() => parseQuery('name=value|test=3&foo=bar'), /mix/);
	});

	it('prop[]=v is a parse error (not grammar)', () => {
		// [ in condition context with a named prefix is an error.
		assert.throws(() => parseQuery('itemIds[]=1'));
	});

	it('deferErrors mode returns error in result', () => {
		const r = parseQuery('name=value|test=3&foo=bar', { deferErrors: true });
		assert.ok(r.parseError);
	});
});

// ---------------------------------------------------------------------------
// Reentrancy
// ---------------------------------------------------------------------------

describe('Reentrancy', () => {
	it('sequential failing then succeeding parse is independent', () => {
		assert.throws(() => parseQuery('name=value|test=3&foo=bar'));
		const r = parseQuery('status=in=(active,pending)');
		assert.deepEqual((r.filter!.terms[0] as Condition).value, ['active', 'pending']);
	});

	it('two independent results', () => {
		const a = parseQuery('id=1|name=2');
		const b = parseQuery('foo=gt=5&bar=lt=10');
		assert.equal(a.filter!.operator, 'or');
		assert.equal(b.filter!.operator, 'and');
		assert.equal((b.filter!.terms[0] as Condition).comparator, 'gt');
	});
});

// ---------------------------------------------------------------------------
// resolveFiqlName conformance
// ---------------------------------------------------------------------------

describe('resolveFiqlName', () => {
	it('core comparators pass through', () => {
		const r = resolveFiqlName('eq');
		assert.equal(r.comparator, 'eq');
		assert.equal(r.negated, false);
	});

	it('not_ prefix negates', () => {
		const r = resolveFiqlName('not_in');
		assert.equal(r.comparator, 'in');
		assert.equal(r.negated, true);
	});

	it('ne → negated eq interpreted', () => {
		const r = resolveFiqlName('ne');
		assert.equal(r.comparator, 'eq');
		assert.equal(r.negated, true);
		assert.equal(r.verbatim, false);
	});

	it('equals → eq verbatim', () => {
		const r = resolveFiqlName('equals');
		assert.equal(r.comparator, 'eq');
		assert.equal(r.verbatim, true);
	});

	it('not_equal → negated eq verbatim', () => {
		const r = resolveFiqlName('not_equal');
		assert.equal(r.comparator, 'eq');
		assert.equal(r.negated, true);
		assert.equal(r.verbatim, true);
	});

	it('between is flagged for desugaring', () => {
		const r = resolveFiqlName('between');
		assert.ok(r.isBetween);
		assert.equal(r.betweenNegated, false);
	});

	it('unknown name passes through', () => {
		const r = resolveFiqlName('fuzzy_match');
		assert.equal(r.comparator, 'fuzzy_match');
		assert.equal(r.negated, false);
	});
});

// ---------------------------------------------------------------------------
// Verbatim vs interpreted distinction, group chaining, nested projection mode
// ---------------------------------------------------------------------------

describe('Verbatim vs interpreted values (§5.2)', () => {
	it('a==3 (interpreted) parses to number, a=3 / a===3 (verbatim) to string', () => {
		assert.deepEqual(parseQuery('a==3').filter, andGrp(cond(['a'], 'eq', 3)));
		assert.deepEqual(parseQuery('a=3').filter, andGrp(cond(['a'], 'eq', '3')));
		assert.deepEqual(parseQuery('a===3').filter, andGrp(cond(['a'], 'eq', '3')));
	});

	it('non-roundtrip numerals stay strings in interpreted mode', () => {
		assert.deepEqual(parseQuery('a==1e3').filter, andGrp(cond(['a'], 'eq', '1e3')));
	});
});

describe('Chain legs require a comparator name (§4 grammar)', () => {
	it('a=ge=1&=5 throws', () => {
		assert.throws(() => parseQuery('a=ge=1&=5'), /chain leg requires a comparator name/);
	});
});

describe('Chaining inside groups keeps element scoping (§5.3)', () => {
	it('(skiLengths=ge=175&=le=180) → ElementMatch, same as un-grouped', () => {
		const grouped = parseQuery('(skiLengths=ge=175&=le=180)');
		const inner = grouped.filter!.terms[0] as Group;
		const em = inner.terms[0] as ElementMatch;
		assert.deepEqual(em, {
			path: ['skiLengths'],
			some: { operator: 'and', terms: [
				{ path: [], comparator: 'ge', value: 175 },
				{ path: [], comparator: 'le', value: 180 },
			] },
		});
	});

	it('chained legs inside a bracket scoped-match stay grouped', () => {
		const r = parseQuery('a=1&[skiLengths=ge=175&=le=180]');
		const grp = r.filter!.terms[1] as Group;
		const em = grp.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['skiLengths']);
		assert.equal(em.some.terms.length, 2);
	});
});

describe('Nested projections are records mode (§5.7)', () => {
	it('select(name,brand{name}) → nested single-field projection trims the object', () => {
		const r = parseQuery('select(name,brand{name})');
		assert.deepEqual(r.select, {
			mode: 'records',
			fields: [
				{ path: ['name'] },
				{ path: ['brand'], projection: { mode: 'records', fields: [{ path: ['name'] }] } },
			],
		});
	});
});
