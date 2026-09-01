import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, QueryError } from '../../src/index.ts';
import { parsePostgrest, UnsupportedFeature } from '../../src/dialects/postgrest.ts';
import type {
	Condition, ElementMatch, Group, ParseResult, Projection, SortKey, Value,
} from '../../src/index.ts';

type Term = Condition | Group | ElementMatch;

function cond(path: string[], comparator: string, value: Value, negated = false): Condition {
	const result: Condition = { path, comparator, value };
	if (negated) result.negated = true;
	return result;
}

function group(operator: 'and' | 'or', ...terms: Term[]): Group {
	return { operator, terms };
}

function filtered(...terms: Term[]): ParseResult {
	return { filter: group('and', ...terms) };
}

function grouped(operator: 'and' | 'or', ...terms: Term[]): ParseResult {
	return { filter: group(operator, ...terms) };
}

function projection(...paths: string[][]): Projection {
	return { mode: 'records', fields: paths.map((path) => ({ path })) };
}

function sort(path: string[], direction: 'asc' | 'desc' = 'asc'): SortKey {
	return { path, direction };
}

const vectors: { name: string; search: string; expected: ParseResult }[] = [
	{
		name: 'E.2 eq maps to canonical eq', search: 'age=eq.11',
		expected: filtered(cond(['age'], 'eq', 11)),
	},
	{
		name: 'E.2 gt passes through', search: 'age=gt.11',
		expected: filtered(cond(['age'], 'gt', 11)),
	},
	{
		name: 'E.2 gte maps to ge', search: 'age=gte.11',
		expected: filtered(cond(['age'], 'ge', 11)),
	},
	{
		name: 'E.2 lt passes through', search: 'age=lt.11',
		expected: filtered(cond(['age'], 'lt', 11)),
	},
	{
		name: 'E.2 lte maps to le', search: 'age=lte.11',
		expected: filtered(cond(['age'], 'le', 11)),
	},
	{
		name: 'E.2 neq maps to complement-semantics negated eq', search: 'status=neq.archived',
		expected: filtered(cond(['status'], 'eq', 'archived', true)),
	},
	{
		name: 'E.2 not.eq toggles the same negated flag', search: 'status=not.eq.archived',
		expected: filtered(cond(['status'], 'eq', 'archived', true)),
	},
	{
		name: 'E.2 not.neq cancels the intrinsic neq negation', search: 'status=not.neq.archived',
		expected: filtered(cond(['status'], 'eq', 'archived')),
	},
	{
		name: 'E.2 in maps to a canonical value list', search: 'id=in.(1,2,3)',
		expected: filtered(cond(['id'], 'in', [1, 2, 3])),
	},
	{
		name: 'E.2 in preserves commas inside quoted values',
		search: 'message=in.("hi,there","yes,you")',
		expected: filtered(cond(['message'], 'in', ['hi,there', 'yes,you'])),
	},
	{
		name: 'quoted list values suppress literal interpretation', search: 'code=in.("3","true")',
		expected: filtered(cond(['code'], 'in', ['3', 'true'])),
	},
	{
		name: 'quoted scalar values suppress literal interpretation', search: 'code=eq."0123"',
		expected: filtered(cond(['code'], 'eq', '0123')),
	},
	{
		name: 'PostgREST timestamps remain schema-free strings',
		search: 'created_at=gte.2024-01-01T00%3A00%3A00Z',
		expected: filtered(cond(['created_at'], 'ge', '2024-01-01T00:00:00Z')),
	},
	{
		name: 'PostgREST URLs remain schema-free strings', search: 'homepage=eq.https%3A%2F%2Fexample.com',
		expected: filtered(cond(['homepage'], 'eq', 'https://example.com')),
	},
	{
		name: 'RQL typed-prefix spelling is ordinary data in PostgREST', search: 'kind=eq.number%3A42',
		expected: filtered(cond(['kind'], 'eq', 'number:42')),
	},
	{
		name: 'non-roundtrip exponential numerals remain strings', search: 'value=eq.1e3',
		expected: filtered(cond(['value'], 'eq', '1e3')),
	},
	{
		name: 'non-roundtrip leading-zero numerals remain strings', search: 'value=eq.01',
		expected: filtered(cond(['value'], 'eq', '01')),
	},
	{
		name: 'roundtrip signed and decimal numerals are interpreted', search: 'low=eq.-5&ratio=eq.2.5',
		expected: filtered(cond(['low'], 'eq', -5), cond(['ratio'], 'eq', 2.5)),
	},
	{
		name: 'dotted filter keys become path segments', search: 'account.owner=eq.alice',
		expected: filtered(cond(['account', 'owner'], 'eq', 'alice')),
	},
	{
		name: 'E.2 json arrow filter path becomes a dotted canonical path',
		search: 'json_col->>field=eq.value',
		expected: filtered(cond(['json_col', 'field'], 'eq', 'value')),
	},
	{
		name: 'separate filter parameters are conjunctive', search: 'age=gte.18&active=is.true',
		expected: filtered(cond(['age'], 'ge', 18), cond(['active'], 'eq', true)),
	},
	{
		name: 'repeated filter parameters remain separate conjunctive terms', search: 'age=gte.18&age=lte.65',
		expected: filtered(cond(['age'], 'ge', 18), cond(['age'], 'le', 65)),
	},
	{
		name: 'E.2 or tree maps directly to an or Group', search: 'or=(age.eq.11,age.eq.12)',
		expected: grouped('or', cond(['age'], 'eq', 11), cond(['age'], 'eq', 12)),
	},
	{
		name: 'E.2 and tree maps directly to an and Group', search: 'and=(age.gte.11,age.lte.20)',
		expected: grouped('and', cond(['age'], 'ge', 11), cond(['age'], 'le', 20)),
	},
	{
		name: 'E.2 logic grammar recursively parses nested and inside or',
		search: 'or=(a.eq.1,and(b.eq.2,c.eq.3))',
		expected: grouped('or', cond(['a'], 'eq', 1), group('and', cond(['b'], 'eq', 2), cond(['c'], 'eq', 3))),
	},
	{
		name: 'logic leaves bind the rightmost viable operator after a colliding path segment',
		search: 'or=(meta.like.eq.5,b.eq.2)',
		expected: grouped('or', cond(['meta', 'like'], 'eq', 5), cond(['b'], 'eq', 2)),
	},
	{
		name: 'E.2 not.and applies Core De Morgan desugaring', search: 'not.and=(a.eq.1,b.eq.2)',
		expected: grouped('or', cond(['a'], 'eq', 1, true), cond(['b'], 'eq', 2, true)),
	},
	{
		name: 'E.2 not.or applies Core De Morgan desugaring', search: 'not.or=(a.eq.1,b.eq.2)',
		expected: grouped('and', cond(['a'], 'eq', 1, true), cond(['b'], 'eq', 2, true)),
	},
	{
		name: 'E.2 nested not.and desugars inside a logic tree',
		search: 'or=(a.eq.1,not.and(b.eq.2,c.eq.3))',
		expected: grouped('or', cond(['a'], 'eq', 1), group('or', cond(['b'], 'eq', 2, true), cond(['c'], 'eq', 3, true))),
	},
	{
		name: 'E.2 gt(any) becomes an or Group over values', search: 'age=gt(any).{11,21}',
		expected: grouped('or', cond(['age'], 'gt', 11), cond(['age'], 'gt', 21)),
	},
	{
		name: 'E.2 like(any) retains its extension comparator', search: 'name=like(any).{A*,B*}',
		expected: grouped('or', cond(['name'], 'like', 'A*'), cond(['name'], 'like', 'B*')),
	},
	{
		name: 'E.2 eq(any) collapses to canonical in', search: 'status=eq(any).{open,closed}',
		expected: filtered(cond(['status'], 'in', ['open', 'closed'])),
	},
	{
		name: 'E.2 gt(all) becomes an and Group over values', search: 'age=gt(all).{11,21}',
		expected: grouped('and', cond(['age'], 'gt', 11), cond(['age'], 'gt', 21)),
	},
	{
		name: 'E.2 neq(all) preserves intrinsic leaf negations', search: 'age=neq(all).{11,21}',
		expected: grouped('and', cond(['age'], 'eq', 11, true), cond(['age'], 'eq', 21, true)),
	},
	{
		name: 'E.2 not.gt(any) negates the expanded group through De Morgan', search: 'age=not.gt(any).{11,21}',
		expected: grouped('and', cond(['age'], 'gt', 11, true), cond(['age'], 'gt', 21, true)),
	},
	{
		name: 'E.2 cs array contains-all becomes conjunctive existential eq', search: 'tags=cs.{red,blue}',
		expected: grouped('and', cond(['tags'], 'eq', 'red'), cond(['tags'], 'eq', 'blue')),
	},
	{
		name: 'E.2 singleton cs remains an explicit and Group', search: 'tags=cs.{red}',
		expected: grouped('and', cond(['tags'], 'eq', 'red')),
	},
	{
		name: 'E.2 not.cs negates the generated contains-all group', search: 'tags=not.cs.{red,blue}',
		expected: grouped('or', cond(['tags'], 'eq', 'red', true), cond(['tags'], 'eq', 'blue', true)),
	},
	{
		name: 'E.2 ov array overlap becomes canonical in', search: 'tags=ov.{red,blue}',
		expected: filtered(cond(['tags'], 'in', ['red', 'blue'])),
	},
	{
		name: 'E.2 not.ov becomes negated canonical in', search: 'tags=not.ov.{red,blue}',
		expected: filtered(cond(['tags'], 'in', ['red', 'blue'], true)),
	},
	{
		name: 'E.2 cd uses the forall-as-not-exists-not ElementMatch shape', search: 'tags=cd.{red,blue}',
		expected: filtered({
			path: ['tags'], negated: true,
			some: group('and', cond([], 'in', ['red', 'blue'], true)),
		}),
	},
	{
		name: 'E.2 not.cd toggles the outer not-exists scope', search: 'tags=not.cd.{red,blue}',
		expected: filtered({
			path: ['tags'],
			some: group('and', cond([], 'in', ['red', 'blue'], true)),
		}),
	},
	{
		name: 'E.2 is.null maps to eq null', search: 'deleted_at=is.null',
		expected: filtered(cond(['deleted_at'], 'eq', null)),
	},
	{
		name: 'E.2 is.true maps to eq true', search: 'active=is.true',
		expected: filtered(cond(['active'], 'eq', true)),
	},
	{
		name: 'E.2 is.false maps to eq false', search: 'active=is.false',
		expected: filtered(cond(['active'], 'eq', false)),
	},
	{
		name: 'E.2 like is an extension comparator', search: 'name=like.*son',
		expected: filtered(cond(['name'], 'like', '*son')),
	},
	{
		name: 'E.2 ilike is an extension comparator', search: 'name=ilike.*SON',
		expected: filtered(cond(['name'], 'ilike', '*SON')),
	},
	{
		name: 'E.2 match is an extension comparator', search: 'name=match.^A',
		expected: filtered(cond(['name'], 'match', '^A')),
	},
	{
		name: 'E.2 imatch is an extension comparator', search: 'name=imatch.^a',
		expected: filtered(cond(['name'], 'imatch', '^a')),
	},
	{
		name: 'E.2 fts is an extension comparator', search: 'body=fts.cats',
		expected: filtered(cond(['body'], 'fts', 'cats')),
	},
	{
		name: 'E.2 plfts is an extension comparator', search: 'body=plfts.fat cats',
		expected: filtered(cond(['body'], 'plfts', 'fat cats')),
	},
	{
		name: 'E.2 phfts argument is folded into the opaque comparator name',
		search: 'body=phfts(english).The Fat Cats',
		expected: filtered(cond(['body'], 'phfts(english)', 'The Fat Cats')),
	},
	{
		name: 'E.2 wfts argument is folded into the opaque comparator name',
		search: 'body=wfts(simple).The Fat Cats',
		expected: filtered(cond(['body'], 'wfts(simple)', 'The Fat Cats')),
	},
	{
		name: 'E.2 sl retains a range operand as an extension value', search: 'period=sl.[1,10)',
		expected: filtered(cond(['period'], 'sl', '[1,10)')),
	},
	{
		name: 'E.2 sr is an extension comparator', search: 'period=sr.[1,10)',
		expected: filtered(cond(['period'], 'sr', '[1,10)')),
	},
	{
		name: 'E.2 nxl is an extension comparator', search: 'period=nxl.[1,10)',
		expected: filtered(cond(['period'], 'nxl', '[1,10)')),
	},
	{
		name: 'E.2 nxr is an extension comparator', search: 'period=nxr.[1,10)',
		expected: filtered(cond(['period'], 'nxr', '[1,10)')),
	},
	{
		name: 'E.2 adj is an extension comparator', search: 'period=adj.[1,10)',
		expected: filtered(cond(['period'], 'adj', '[1,10)')),
	},
	{
		name: 'E.2 isdistinct is an extension comparator', search: 'status=isdistinct.archived',
		expected: filtered(cond(['status'], 'isdistinct', 'archived')),
	},
	{
		name: 'E.2 single select field remains record-shaped in the PostgREST dialect', search: 'select=id',
		expected: { select: projection(['id']) },
	},
	{
		name: 'E.2 select list maps to canonical projection fields', search: 'select=id,name',
		expected: { select: projection(['id'], ['name']) },
	},
	{
		name: 'E.2 json arrow select path becomes a dotted canonical path', search: 'select=json_col->>field',
		expected: { select: projection(['json_col', 'field']) },
	},
	{
		name: 'E.2 order defaults to ascending', search: 'order=name',
		expected: { sort: [sort(['name'])] },
	},
	{
		name: 'E.2 order supports multiple keys and desc', search: 'order=age.desc,name.asc',
		expected: { sort: [sort(['age'], 'desc'), sort(['name'])] },
	},
	{
		name: 'E.2 order supports dotted paths', search: 'order=account.name.desc',
		expected: { sort: [sort(['account', 'name'], 'desc')] },
	},
	{
		name: 'E.2 limit maps to canonical limit', search: 'limit=25',
		expected: { limit: 25 },
	},
	{
		name: 'E.2 offset maps to canonical offset', search: 'offset=10',
		expected: { offset: 10 },
	},
	{
		name: 'E.2 limit and offset coexist', search: 'limit=25&offset=10',
		expected: { limit: 25, offset: 10 },
	},
	{
		name: 'filters and result-shaping parameters share one ParseResult',
		search: 'active=is.true&select=id,name&order=name.desc&limit=5&offset=2',
		expected: {
			filter: group('and', cond(['active'], 'eq', true)),
			select: projection(['id'], ['name']), sort: [sort(['name'], 'desc')], limit: 5, offset: 2,
		},
	},
];

describe('PostgREST Appendix E conformance vectors', () => {
	for (const vector of vectors) {
		it(vector.name, () => {
			assert.deepEqual(parsePostgrest(vector.search), vector.expected);
		});
	}
});

describe('PostgREST input and shared-model behavior', () => {
	it('accepts a leading question mark', () => {
		assert.deepEqual(parsePostgrest('?age=gte.18'), filtered(cond(['age'], 'ge', 18)));
	});

	it('accepts URLSearchParams without decoding values twice', () => {
		const parameters = new URLSearchParams([['message', 'eq.100% ready']]);
		assert.deepEqual(parsePostgrest(parameters), filtered(cond(['message'], 'eq', '100% ready')));
	});

	it('uses URL query decoding for plus and percent escapes', () => {
		assert.deepEqual(
			parsePostgrest('message=eq.hello+world%25'),
			filtered(cond(['message'], 'eq', 'hello world%')),
		);
	});

	it('keeps delimiters inside quoted column names', () => {
		assert.deepEqual(
			parsePostgrest('%22first.name%22=eq.bob'),
			filtered(cond(['first.name'], 'eq', 'bob')),
		);
	});

	it('does not treat a colon inside a quoted select field as an alias', () => {
		assert.deepEqual(
			parsePostgrest('select=%22namespace%3Afield%22'),
			{ select: projection(['namespace:field']) },
		);
	});

	it('allows an unquoted operand to end in a quote character', () => {
		assert.deepEqual(
			parsePostgrest('title=eq.The+%22Best%22'),
			filtered(cond(['title'], 'eq', 'The "Best"')),
		);
	});

	it('shares canonical literal interpretation with parseQuery', () => {
		const equivalentPairs = [
			['age=gte.18', 'age=ge=18'],
			['active=is.true', 'active=eq=true'],
			['deleted=is.null', 'deleted=eq=null'],
			['id=in.(1,2,3)', 'id=in=(1,2,3)'],
			['status=neq.archived', 'status=ne=archived'],
		] as const;
		for (const [postgrest, core] of equivalentPairs)
			assert.deepEqual(parsePostgrest(postgrest), parseQuery(core));
	});

	it('deferred errors never return a partially usable query', () => {
		const result = parsePostgrest('id=eq.1&limit=5&status=is.unknown', { deferErrors: true });
		assert.ok(result.parseError instanceof QueryError);
		assert.deepEqual(Object.keys(result), ['parseError']);
	});
});

describe('Unsupported PostgREST features', () => {
	const unsupported = [
		['projection alias', 'select=display:name'],
		['projection cast', 'select=age::text'],
		['nullsfirst ordering', 'order=age.nullsfirst'],
		['nullslast ordering', 'order=age.desc.nullslast'],
		['resource embedding', 'select=id,orders(id,total)'],
		['hinted embedding', 'select=id,orders!inner(id)'],
	] as const;

	for (const [name, search] of unsupported) {
		it(`${name} throws UnsupportedFeature`, () => {
			assert.throws(() => parsePostgrest(search), UnsupportedFeature);
		});
	}

	it('drop removes unsupported projection fields only when explicitly requested', () => {
		assert.deepEqual(
			parsePostgrest('select=id,display:name', { onUnsupported: 'drop' }),
			{ select: projection(['id']) },
		);
	});

	it('drop removes unsupported order decorations only when explicitly requested', () => {
		assert.deepEqual(
			parsePostgrest('order=id,age.nullsfirst', { onUnsupported: 'drop' }),
			{ sort: [sort(['id'])] },
		);
	});

	it('drop cannot erase the entire projection', () => {
		assert.throws(
			() => parsePostgrest('select=display:name', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});

	it('drop cannot erase every order key', () => {
		assert.throws(
			() => parsePostgrest('order=age.nullsfirst', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});

	it('drop never weakens an unsupported filter', () => {
		assert.throws(
			() => parsePostgrest('status=is.unknown', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});
});

describe('PostgREST syntax and resource bounds', () => {
	const hostileInputs = [
		'a=wat.1',
		'or=(a.eq.1,,b.eq.2)',
		'or=(a.eq.1,and(b.eq.2,c.eq.3)',
		'id=in.(1,2',
		'code=eq."unterminated',
		'limit=-1',
		'offset=1.5',
		'limit=1&limit=2',
		'offset=1&offset=2',
		'select=id&select=name',
		'order=id&order=name',
	] as const;

	for (const search of hostileInputs) {
		it(`throws QueryError for ${search}`, () => {
			assert.throws(() => parsePostgrest(search), QueryError);
		});
	}

	it('rejects logic nesting beyond the parser depth budget as QueryError', () => {
		let logic = 'a.eq.1';
		for (let depth = 0; depth < 40; depth++) logic = `and(${logic})`;
		assert.throws(() => parsePostgrest(`or=(${logic})`), QueryError);
	});

	it('rejects lists beyond the parser value budget as QueryError', () => {
		const values = Array.from({ length: 1_001 }, (_, index) => String(index)).join(',');
		assert.throws(() => parsePostgrest(`id=in.(${values})`), QueryError);
	});

	it('applies the parser term budget to projection fields', () => {
		const fields = Array.from({ length: 1_001 }, (_, index) => `field${index}`).join(',');
		assert.throws(() => parsePostgrest(`select=${fields}`), QueryError);
	});

	it('applies the parser term budget to order keys', () => {
		const keys = Array.from({ length: 1_001 }, (_, index) => `field${index}`).join(',');
		assert.throws(() => parsePostgrest(`order=${keys}`), QueryError);
	});
});
