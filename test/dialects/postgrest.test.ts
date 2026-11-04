import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, QueryError } from '../../src/index.ts';
import { parsePostgREST, UnsupportedFeature } from '../../src/dialects/postgrest.ts';
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
		name: 'non-finite numeric spellings remain strings', search: 'value=eq.Infinity',
		expected: filtered(cond(['value'], 'eq', 'Infinity')),
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
		name: 'logic leaves bind the first viable operator before operator-like operand text',
		search: 'or=(version.eq.v1.eq.beta,b.eq.1)',
		expected: grouped('or', cond(['version'], 'eq', 'v1.eq.beta'), cond(['b'], 'eq', 1)),
	},
	{
		name: 'quoted logic path segments can use operator names',
		search: 'or=(metrics.%22eq%22.gt.2,b.eq.1)',
		expected: grouped('or', cond(['metrics', 'eq'], 'gt', 2), cond(['b'], 'eq', 1)),
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
		name: 'E.2 not.eq remains a negated operator inside a logic leaf',
		search: 'or=(a.not.eq.1,b.eq.2)',
		expected: grouped('or', cond(['a'], 'eq', 1, true), cond(['b'], 'eq', 2)),
	},
	{
		name: 'E.2 not.in remains a negated operator inside a logic leaf',
		search: 'or=(a.not.in.(1,2),b.eq.2)',
		expected: grouped('or', cond(['a'], 'in', [1, 2], true), cond(['b'], 'eq', 2)),
	},
	{
		name: 'E.2 leaf negation composes with a negated logic tree',
		search: 'not.or=(a.not.eq.1,b.eq.2)',
		expected: grouped('and', cond(['a'], 'eq', 1), cond(['b'], 'eq', 2, true)),
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
		name: 'E.2 cs preserves a colon in an array value', search: 'tags=cs.{red:blue,green}',
		expected: grouped('and', cond(['tags'], 'eq', 'red:blue'), cond(['tags'], 'eq', 'green')),
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
		name: 'range-form ov remains an extension comparator over the range value', search: 'period=ov.[1,10)',
		expected: filtered(cond(['period'], 'ov', '[1,10)')),
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
		name: 'PostgREST wildcard select maps to an absent canonical projection', search: 'select=*',
		expected: {},
	},
	{
		name: 'wildcard dominates an explicit PostgREST select list', search: 'select=id,*',
		expected: {},
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
			assert.deepEqual(parsePostgREST(vector.search), vector.expected);
		});
	}
});

describe('PostgREST input and shared-model behavior', () => {
	it('accepts a leading question mark', () => {
		assert.deepEqual(parsePostgREST('?age=gte.18'), filtered(cond(['age'], 'ge', 18)));
	});

	it('accepts URLSearchParams without decoding values twice', () => {
		const parameters = new URLSearchParams([['message', 'eq.100% ready']]);
		assert.deepEqual(parsePostgREST(parameters), filtered(cond(['message'], 'eq', '100% ready')));
	});

	it('accepts searchParams from a URL object', () => {
		const url = new URL('https://example.test/?id=eq.1&active=is.true');
		assert.deepEqual(
			parsePostgREST(url.searchParams),
			filtered(cond(['id'], 'eq', 1), cond(['active'], 'eq', true)),
		);
	});

	it('uses URL query decoding for plus and percent escapes', () => {
		assert.deepEqual(
			parsePostgREST('message=eq.hello+world%25'),
			filtered(cond(['message'], 'eq', 'hello world%')),
		);
	});

	it('keeps delimiters inside quoted column names', () => {
		assert.deepEqual(
			parsePostgREST('%22first.name%22=eq.bob'),
			filtered(cond(['first.name'], 'eq', 'bob')),
		);
	});

	it('does not treat a colon inside a quoted select field as an alias', () => {
		assert.deepEqual(
			parsePostgREST('select=%22namespace%3Afield%22'),
			{ select: projection(['namespace:field']) },
		);
	});

	it('parses a leading quoted identifier inside a logic tree', () => {
		assert.deepEqual(
			parsePostgREST('or=(%22information.cpe%22.eq.x,b.eq.2)'),
			grouped('or', cond(['information.cpe'], 'eq', 'x'), cond(['b'], 'eq', 2)),
		);
	});

	it('preserves trailing whitespace in logic-leaf operands', () => {
		assert.deepEqual(
			parsePostgREST('or=(name.eq.Bob%20,id.eq.1)'),
			grouped('or', cond(['name'], 'eq', 'Bob '), cond(['id'], 'eq', 1)),
		);
	});

	it('ignores leading separator whitespace in logic terms', () => {
		assert.deepEqual(
			parsePostgREST('or=(a.eq.1,%20and(b.eq.2,c.eq.3))'),
			grouped('or', cond(['a'], 'eq', 1), group('and', cond(['b'], 'eq', 2), cond(['c'], 'eq', 3))),
		);
	});

	it('does not interpret a first-segment not column as operator negation', () => {
		assert.deepEqual(
			parsePostgREST('or=(not.eq.ab,b.eq.2)'),
			grouped('or', cond(['not'], 'eq', 'ab'), cond(['b'], 'eq', 2)),
		);
	});

	it('pins PostgREST field-first binding against top-level canonical dotted paths', () => {
		assert.deepEqual(
			parsePostgREST('meta.like=eq.5'),
			filtered(cond(['meta', 'like'], 'eq', 5)),
		);
		assert.deepEqual(
			parsePostgREST('or=(meta.like.eq.5,b.eq.1)'),
			grouped('or', cond(['meta'], 'like', 'eq.5'), cond(['b'], 'eq', 1)),
		);
	});

	it('combines repeated logic parameters conjunctively', () => {
		assert.deepEqual(
			parsePostgREST('or=(a.eq.1,b.eq.2)&or=(c.eq.3,d.eq.4)'),
			filtered(
				group('or', cond(['a'], 'eq', 1), cond(['b'], 'eq', 2)),
				group('or', cond(['c'], 'eq', 3), cond(['d'], 'eq', 4)),
			),
		);
	});

	it('allows an unquoted operand to end in a quote character', () => {
		assert.deepEqual(
			parsePostgREST('title=eq.The+%22Best%22'),
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
			['id=eq(any).{1,2}', 'id=in=(1,2)'],
			['tags=cs.{red,blue}', 'tags=red&tags=blue'],
			['value=eq.-0', 'value==-0'],
			['value=eq.1.0', 'value==1.0'],
			['value=eq..5', 'value==.5'],
			['value=eq.%2B1', 'value==%2B1'],
			['value=eq.1e3', 'value==1e3'],
			['value=eq.01', 'value==01'],
		] as const;
		for (const [postgrest, core] of equivalentPairs)
			assert.deepEqual(parsePostgREST(postgrest), parseQuery(core));
	});

	it('pins the non-finite literal boundary against Core interpretation', () => {
		assert.deepEqual(parsePostgREST('value=eq.Infinity'), filtered(cond(['value'], 'eq', 'Infinity')));
		assert.deepEqual(parseQuery('value==Infinity'), filtered(cond(['value'], 'eq', Infinity)));
	});

	it('deferred errors never return a partially usable query', () => {
		const result = parsePostgREST('id=eq.1&limit=5&status=is.unknown', { deferErrors: true });
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
		['projection aggregate', 'select=id,amount.sum()'],
		['related ordering', 'order=directors(last_name).desc'],
		['multidimensional cs array', 'tags=cs.{{red},{blue}}'],
		['multidimensional cd array', 'tags=cd.{{red},{blue}}'],
		['multidimensional ov array', 'tags=ov.{{red},{blue}}'],
	] as const;

	for (const [name, search] of unsupported) {
		it(`${name} throws UnsupportedFeature`, () => {
			assert.throws(() => parsePostgREST(search), UnsupportedFeature);
		});
	}

	it('drop removes unsupported projection fields only when explicitly requested', () => {
		assert.deepEqual(
			parsePostgREST('select=id,display:name', { onUnsupported: 'drop' }),
			{ select: projection(['id']) },
		);
	});

	it('drop removes only unsupported null placement and preserves the order key', () => {
		assert.deepEqual(
			parsePostgREST('order=id,age.desc.nullsfirst', { onUnsupported: 'drop' }),
			{ sort: [sort(['id']), sort(['age'], 'desc')] },
		);
	});

	it('drop cannot erase the entire projection', () => {
		assert.throws(
			() => parsePostgREST('select=display:name', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});

	it('drop does not discard resource embedding because embedded-filter semantics differ', () => {
		assert.throws(
			() => parsePostgREST('select=title,actors(*)&actors.first_name=eq.Jehanne', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});

	it('drop preserves a sole order key when removing null placement', () => {
		assert.deepEqual(
			parsePostgREST('order=age.nullsfirst', { onUnsupported: 'drop' }),
			{ sort: [sort(['age'])] },
		);
	});

	it('drop never weakens an unsupported filter', () => {
		assert.throws(
			() => parsePostgREST('status=is.unknown', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});

	it('rejects unrepresentable JSON containment as UnsupportedFeature', () => {
		assert.throws(() => parsePostgREST('metadata=cs.{%22tier%22:%22gold%22}'), UnsupportedFeature);
	});

	it('rejects unrepresentable range containment as UnsupportedFeature', () => {
		assert.throws(() => parsePostgREST('period=cd.[1,10)'), UnsupportedFeature);
	});

	it('names aggregate projection errors accurately', () => {
		assert.throws(
			() => parsePostgREST('select=id,amount.sum()'),
			(error: unknown) => error instanceof UnsupportedFeature && error.message.includes('aggregate'),
		);
	});

	it('never drops aliased or cast aggregate projections', () => {
		for (const search of [
			'select=id,total:amount.sum()',
			'select=id,amount.sum()::numeric',
			'select=id,total:amount.sum()::numeric',
		]) {
			assert.throws(
				() => parsePostgREST(search, { onUnsupported: 'drop' }),
				(error: unknown) => error instanceof UnsupportedFeature && error.message.includes('aggregate'),
			);
		}
	});

	it('rejects nested any/all operands instead of stringifying them', () => {
		for (const search of ['value=eq(any).{{1},{2}}', 'value=gt(all).((1),(2))'])
			assert.throws(() => parsePostgREST(search), UnsupportedFeature);
	});

	it('rejects empty lists that would create undefined zero-term groups', () => {
		for (const search of ['tags=cs.{}', 'value=gt(any).{}', 'value=gt(all).{}'])
			assert.throws(() => parsePostgREST(search), UnsupportedFeature);
	});

	it('retains empty eq(any) as the defined canonical empty in condition', () => {
		assert.deepEqual(parsePostgREST('value=eq(any).{}'), filtered(cond(['value'], 'in', [])));
	});

	it('does not drop related ordering because it changes pagination semantics', () => {
		assert.throws(
			() => parsePostgREST('order=directors(last_name).desc', { onUnsupported: 'drop' }),
			UnsupportedFeature,
		);
	});

	it('classifies an unclosed containment array as syntax, not an unsupported feature', () => {
		assert.throws(
			() => parsePostgREST('tags=cs.{red,blue'),
			(error: unknown) => error instanceof QueryError && !(error instanceof UnsupportedFeature),
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
		'tags=ov(all).{red,blue}',
		'body=phfts(english%27%3Bdrop).cats',
	] as const;

	for (const search of hostileInputs) {
		it(`throws QueryError for ${search}`, () => {
			assert.throws(() => parsePostgREST(search), QueryError);
		});
	}

	it('rejects logic nesting beyond the parser depth budget as QueryError', () => {
		let logic = 'a.eq.1';
		for (let depth = 0; depth < 40; depth++) logic = `and(${logic})`;
		assert.throws(() => parsePostgREST(`or=(${logic})`), QueryError);
	});

	it('rejects lists beyond the parser value budget as QueryError', () => {
		const values = Array.from({ length: 1_001 }, (_, index) => String(index)).join(',');
		assert.throws(() => parsePostgREST(`id=in.(${values})`), QueryError);
	});

	it('applies the parser term budget to projection fields', () => {
		const fields = Array.from({ length: 1_001 }, (_, index) => `field${index}`).join(',');
		assert.throws(() => parsePostgREST(`select=${fields}`), QueryError);
	});

	it('applies the parser term budget to order keys', () => {
		const keys = Array.from({ length: 1_001 }, (_, index) => `field${index}`).join(',');
		assert.throws(() => parsePostgREST(`order=${keys}`), QueryError);
	});

	it('rejects an oversized encoded query before URL decoding', () => {
		assert.throws(() => parsePostgREST(`message=eq.${'x'.repeat(65_536)}`), QueryError);
	});
});
