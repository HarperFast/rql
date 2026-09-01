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
	it('chained vs un-chained produce different canonical shapes (ratings)', () => {
		// Chained: some ONE rating must be in [3,4].
		const chained = parseQuery('ratings=ge=3&=le=4');
		// Un-chained: some element ≥3 AND some (possibly different) element ≤4.
		const unchained = parseQuery('ratings=ge=3&ratings=le=4');

		const em = chained.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['ratings']);
		assert.equal(em.some.operator, 'and');
		assert.deepEqual((em.some.terms[0] as Condition).path, []);
		assert.deepEqual((em.some.terms[1] as Condition).path, []);

		assert.equal(unchained.filter!.terms.length, 2);
		assert.deepEqual((unchained.filter!.terms[0] as Condition).path, ['ratings']);
		assert.deepEqual((unchained.filter!.terms[1] as Condition).path, ['ratings']);

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
	it('(ratings=ge=3&=le=4) → ElementMatch, same as un-grouped', () => {
		const grouped = parseQuery('(ratings=ge=3&=le=4)');
		const inner = grouped.filter!.terms[0] as Group;
		const em = inner.terms[0] as ElementMatch;
		assert.deepEqual(em, {
			path: ['ratings'],
			some: { operator: 'and', terms: [
				{ path: [], comparator: 'ge', value: 3 },
				{ path: [], comparator: 'le', value: 4 },
			] },
		});
	});

	it('chained legs inside a bracket scoped-match stay grouped', () => {
		const r = parseQuery('a=1&[ratings=ge=3&=le=4]');
		const grp = r.filter!.terms[1] as Group;
		const em = grp.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['ratings']);
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

// ---------------------------------------------------------------------------
// §5.3 Negated-inner flattening exemption
// ---------------------------------------------------------------------------

describe('Negated-inner ElementMatch is NOT flattened (§5.3)', () => {
	it('tags[=not_eq=urgent] stays an ElementMatch (∃¬ ≠ ¬∃)', () => {
		const r = parseQuery('tags[=not_eq=urgent]');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.ok('some' in em, 'should remain an ElementMatch, not flatten to a Condition');
		assert.deepEqual(em.path, ['tags']);
		assert.equal(em.some.terms.length, 1);
		const ic = em.some.terms[0] as Condition;
		assert.deepEqual(ic.path, []);
		assert.equal(ic.comparator, 'eq');
		assert.equal(ic.negated, true);
		assert.equal(ic.value, 'urgent');
		assert.equal(em.negated, undefined);
	});

	it('orders[status=open] flattens to plain Condition (single non-negated)', () => {
		const r = parseQuery('orders[status=open]');
		// Single non-negated inner condition → normalized to plain Condition.
		const c = r.filter!.terms[0] as Condition;
		assert.ok(!('some' in c), 'should flatten to a plain Condition');
		assert.deepEqual(c.path, ['orders', 'status']);
		assert.equal(c.comparator, 'eq');
	});
});

// ---------------------------------------------------------------------------
// §4 Elem-cond surface inside prop[...]
// ---------------------------------------------------------------------------

describe('Element-scoped match (prop[...])', () => {
	it('scores[=ge=10] → plain Condition (single non-negated elem-cond flattens per §5.5)', () => {
		// Plain Conditions on list paths are already existential (§5.5).
		// scores[=ge=10] ≡ scores=ge=10 — both read as ∃x≥10.
		const r = parseQuery('scores[=ge=10]');
		const c = r.filter!.terms[0] as Condition;
		assert.ok(!('some' in c), 'should flatten to a plain Condition');
		assert.deepEqual(c.path, ['scores']);
		assert.equal(c.comparator, 'ge');
		assert.equal(c.value, 10);
	});

	it('scores[=ge=10|=le=2] → ElementMatch with two elem-conds (or)', () => {
		const r = parseQuery('scores[=ge=10|=le=2]');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['scores']);
		assert.equal(em.some.operator, 'or');
		assert.equal(em.some.terms.length, 2);
		assert.deepEqual((em.some.terms[0] as Condition).path, []);
		assert.equal((em.some.terms[0] as Condition).comparator, 'ge');
		assert.deepEqual((em.some.terms[1] as Condition).path, []);
		assert.equal((em.some.terms[1] as Condition).comparator, 'le');
	});

	it('reviews[rating=ge=4&helpful=ge=10] → ElementMatch with two named conditions', () => {
		const r = parseQuery('reviews[rating=ge=4&helpful=ge=10]');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['reviews']);
		assert.equal(em.some.operator, 'and');
		assert.equal(em.some.terms.length, 2);
		const ic0 = em.some.terms[0] as Condition;
		const ic1 = em.some.terms[1] as Condition;
		assert.deepEqual(ic0.path, ['rating']);
		assert.equal(ic0.comparator, 'ge');
		assert.equal(ic0.value, 4);
		assert.deepEqual(ic1.path, ['helpful']);
		assert.equal(ic1.comparator, 'ge');
		assert.equal(ic1.value, 10);
	});

	it('tags[=not_eq=urgent] (negated elem-cond) is not flattened', () => {
		const r = parseQuery('tags[=not_eq=urgent]');
		assert.ok('some' in r.filter!.terms[0], 'must remain ElementMatch');
		const em = r.filter!.terms[0] as ElementMatch;
		const ic = em.some.terms[0] as Condition;
		assert.equal(ic.negated, true);
	});
});

// ---------------------------------------------------------------------------
// §5.2.2 Malformed typed literals are syntax errors
// ---------------------------------------------------------------------------

describe('Parse errors — malformed typed literals (§5.2.2)', () => {
	it('boolean:yes throws', () => {
		assert.throws(() => parseQuery('x==boolean:yes'), /malformed boolean literal/);
	});

	it('boolean: (empty) throws', () => {
		assert.throws(() => parseQuery('x==boolean:'), /malformed boolean literal/);
	});

	it('number:abc throws', () => {
		assert.throws(() => parseQuery('x==number:abc'), /malformed number literal/);
	});

	it('number: (empty) throws', () => {
		assert.throws(() => parseQuery('x==number:'), /malformed number literal/);
	});

	it('date:not-a-date throws', () => {
		assert.throws(() => parseQuery('x==date:not-a-date'), /malformed date literal/);
	});

	it('valid boolean:true does not throw', () => {
		assert.doesNotThrow(() => parseQuery('x==boolean:true'));
	});

	it('valid number:42 does not throw', () => {
		assert.doesNotThrow(() => parseQuery('x==number:42'));
	});
});

// ---------------------------------------------------------------------------
// §5.6 Limit validation
// ---------------------------------------------------------------------------

describe('Parse errors — limit validation (§5.6)', () => {
	it('limit(10,5) throws — end < start', () => {
		assert.throws(() => parseQuery('limit(10,5)'), /limit/);
	});

	it('limit(-1) throws — negative', () => {
		assert.throws(() => parseQuery('limit(-1)'), /non-negative integer/);
	});

	it('limit(1.5) throws — non-integer', () => {
		assert.throws(() => parseQuery('limit(1.5)'), /non-negative integer/);
	});

	it('limit(foo) throws — non-numeric', () => {
		assert.throws(() => parseQuery('limit(foo)'), /non-negative integer/);
	});

	it('limit(0) is valid', () => {
		const r = parseQuery('limit(0)');
		assert.equal(r.limit, 0);
	});

	it('limit(0,10) is valid — offset=0, limit=10', () => {
		const r = parseQuery('limit(0,10)');
		assert.equal(r.offset, 0);
		assert.equal(r.limit, 10);
	});
});

// ---------------------------------------------------------------------------
// §5.6 Duplicate call functions
// ---------------------------------------------------------------------------

describe('Parse errors — duplicate call functions (§5.6)', () => {
	it('two select() calls throw', () => {
		assert.throws(() => parseQuery('select(id)&select(name)'), /duplicate select/);
	});

	it('two sort() calls throw', () => {
		assert.throws(() => parseQuery('sort(name)&sort(age)'), /duplicate sort/);
	});

	it('two limit() calls throw', () => {
		assert.throws(() => parseQuery('limit(10)&limit(5)'), /duplicate limit/);
	});
});

// ---------------------------------------------------------------------------
// §4 Chained value lists — &=in= and &=between= pin tests
// ---------------------------------------------------------------------------

describe('Chained value lists (§4)', () => {
	it('a=ge=1&=in=(2,3) parses without error', () => {
		const r = parseQuery('a=ge=1&=in=(2,3)');
		// Produces an ElementMatch on 'a' with ge+in legs.
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['a']);
		assert.equal(em.some.operator, 'and');
		assert.equal(em.some.terms.length, 2);
		const leg0 = em.some.terms[0] as Condition;
		const leg1 = em.some.terms[1] as Condition;
		assert.equal(leg0.comparator, 'ge');
		assert.equal(leg0.value, 1);
		assert.equal(leg1.comparator, 'in');
		assert.deepEqual(leg1.value, [2, 3]);
	});

	it('a=ge=1&=between=(2,3) parses — between legs fold into the ElementMatch', () => {
		// The between desugars into ge+le inner conditions inside the same ElementMatch.
		const r = parseQuery('a=ge=1&=between=(2,3)');
		assert.ok(r.filter);
		// At minimum we get an ElementMatch on 'a'.
		const em = r.filter!.terms[0] as ElementMatch;
		assert.deepEqual(em.path, ['a']);
	});
});

// ---------------------------------------------------------------------------
// §5.7 Nested tuple projection reserved
// ---------------------------------------------------------------------------

describe('Nested tuple projection reserved (§5.7)', () => {
	it('select(rel{[x,y]}) throws', () => {
		assert.throws(() => parseQuery('select(rel{[x,y]})'), /nested.*tuple.*reserved/);
	});
});

// ---------------------------------------------------------------------------
// §4.2 rule 4 Raw-token marker pins
// ---------------------------------------------------------------------------

describe('Raw-token marker pins (§4.2 rule 4)', () => {
	it('x==string%3Anull → plain string "string:null" (encoded colon is not a type prefix)', () => {
		const r = parseQuery('x==string%3Anull');
		const c = r.filter!.terms[0] as Condition;
		assert.equal(c.value, 'string:null');
	});

	it('name==Jo%2A → eq "Jo*" (encoded asterisk is not a wildcard)', () => {
		const r = parseQuery('name==Jo%2A');
		const c = r.filter!.terms[0] as Condition;
		assert.equal(c.comparator, 'eq');
		assert.equal(c.value, 'Jo*');
	});

	it('sort(%2Bname) → path ["+name"] ascending (encoded + is not a direction marker)', () => {
		const r = parseQuery('sort(%2Bname)');
		assert.deepEqual(r.sort, [{ path: ['+name'], direction: 'asc' }]);
	});

	it('sort(-age) → path ["age"] descending (raw - IS a direction marker)', () => {
		const r = parseQuery('sort(-age)');
		assert.deepEqual(r.sort, [{ path: ['age'], direction: 'desc' }]);
	});
});

// ---------------------------------------------------------------------------
// §5.4 not(...) De Morgan desugaring
// ---------------------------------------------------------------------------

describe('not(...) De Morgan desugaring (§5.4)', () => {
	it('not(a=1) ≡ a=not_equal=1 — single condition toggles negated (both verbatim)', () => {
		// `=` is verbatim, so value is string '1'; not_equal is also verbatim.
		const direct = parseQuery('a=not_equal=1');
		const negated = parseQuery('not(a=1)');
		assert.deepEqual(negated.filter, direct.filter);
	});

	it('status=open&not(tag=urgent|tag=blocked) → and[eq(status,open), and[neg(tag,urgent), neg(tag,blocked)]]', () => {
		const r = parseQuery('status=open&not(tag=urgent|tag=blocked)');
		assert.equal(r.filter!.operator, 'and');
		assert.equal(r.filter!.terms.length, 2);
		const first = r.filter!.terms[0] as Condition;
		assert.deepEqual(first.path, ['status']);
		assert.equal(first.comparator, 'eq');
		const second = r.filter!.terms[1] as Group;
		assert.equal(second.operator, 'and');
		assert.equal(second.terms.length, 2);
		assert.equal((second.terms[0] as Condition).negated, true);
		assert.equal((second.terms[1] as Condition).negated, true);
		assert.deepEqual((second.terms[0] as Condition).path, ['tag']);
		assert.deepEqual((second.terms[1] as Condition).path, ['tag']);
	});

	it('not(scores[=ge=10&=le=20]) → negated ElementMatch (NO element in [10,20])', () => {
		const r = parseQuery('not(scores[=ge=10&=le=20])');
		const em = r.filter!.terms[0] as ElementMatch;
		assert.ok('some' in em);
		assert.deepEqual(em.path, ['scores']);
		assert.equal(em.negated, true);
		assert.equal(em.some.operator, 'and');
		assert.equal(em.some.terms.length, 2);
	});

	it('not(not(a=1)) → plain eq — double negation cancels', () => {
		const r = parseQuery('not(not(a=1))');
		const c = r.filter!.terms[0] as Condition;
		assert.ok(!c.negated);
		assert.deepEqual(c.path, ['a']);
		assert.equal(c.comparator, 'eq');
	});

	it('not() empty → QueryError', () => {
		assert.throws(() => parseQuery('not()'), /not\(\) requires/);
	});

	it('not(a=1&b=2|c=3) → mixing error still applies inside', () => {
		assert.throws(() => parseQuery('not(a=1&b=2|c=3)'), /mix/);
	});

	it('not(...) inside a group works', () => {
		const r = parseQuery('(x=1&not(y=2))');
		const grp = r.filter!.terms[0] as Group;
		assert.equal(grp.operator, 'and');
		assert.equal(grp.terms.length, 2);
		const neg = grp.terms[1] as Condition;
		assert.deepEqual(neg.path, ['y']);
		assert.equal(neg.negated, true);
	});

	it('not(a=1&b=2) → De Morgan: or[negated(a,eq,1), negated(b,eq,2)]', () => {
		const r = parseQuery('not(a=1&b=2)');
		const grp = r.filter!.terms[0] as Group;
		assert.equal(grp.operator, 'or');
		assert.equal(grp.terms.length, 2);
		assert.equal((grp.terms[0] as Condition).negated, true);
		assert.equal((grp.terms[1] as Condition).negated, true);
	});
});
