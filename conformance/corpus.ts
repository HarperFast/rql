/**
 * The differential corpus: query strings exercising every feature of the RQL 2.0 grammar
 * (specification/rql-2.0.md §4–§5.7), the Appendix B compatibility aliases, the rows of
 * Harper's divergence ledger, and a body of adversarial strings.
 *
 * Cases are declared, not randomly generated, so the corpus is reviewable and a recorded
 * fixture stays addressable across edits: each case's id is a hash of its query string, so
 * inserting a case never renumbers the others.
 */

export type Case = {
	/** Stable, content-derived id — also the fixture key. */
	id: string;
	query: string;
	features: readonly string[];
	/** Rows of the Harper divergence ledger this case is a witness for. */
	ledger?: readonly number[];
	note?: string;
};

/** Every feature tag the corpus is required to cover; the report enumerates these. */
export const REQUIRED_FEATURES = [
	'form-encoding',
	'symbol-op',
	'fiql-core',
	'fiql-alias',
	'not-prefix',
	'value-list',
	'typed-value',
	'wildcard',
	'grouping-paren',
	'grouping-bracket',
	'grouping-nested',
	'chain',
	'scoped-match',
	'elem-cond',
	'not-expr',
	'dotted-path',
	'pct-encoded-path',
	'pct-encoded-value',
	'select',
	'sort',
	'limit',
	'call-error',
	'tolerance',
	'adversarial',
] as const;

function fnv1a(input: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

type Draft = { query: string; features: readonly string[]; ledger?: readonly number[]; note?: string };

const draft = (query: string, features: readonly string[], extra: Omit<Draft, 'query' | 'features'> = {}): Draft => ({
	query,
	features,
	...extra,
});

// ── §4 / §5.1.2 symbolic operators × representative value tokens ─────────────
const SYMBOL_OPS = ['=', '==', '===', '!=', '!==', '<', '<=', '>', '>='] as const;
const SYMBOL_VALUES = ['5', 'abc', 'null', 'true', '2.5', 'x%20y'] as const;

const symbolMatrix: Draft[] = SYMBOL_OPS.flatMap((op) =>
	SYMBOL_VALUES.map((value) =>
		draft(`price${op}${value}`, op === '=' ? ['symbol-op', 'form-encoding'] : ['symbol-op'], {
			ledger: op === '=' ? [1, 3] : op === '===' || op === '!==' ? [3] : undefined,
		})
	)
);

// ── §5.1.1 core comparators and Appendix B aliases in FIQL form ──────────────
const CORE_FIQL = ['eq', 'lt', 'le', 'gt', 'ge', 'contains', 'starts_with', 'ends_with'] as const;
const ALIAS_FIQL = [
	'ne', 'equals', 'equal', 'not_equal', 'notEqual', 'sw', 'ew', 'ct', 'includes',
	'less_than', 'lessThan', 'less_than_equal', 'lessThanEqual',
	'greater_than', 'greaterThan', 'greater_than_equal', 'greaterThanEqual',
] as const;

const fiqlMatrix: Draft[] = [
	...CORE_FIQL.map((name) => draft(`price=${name}=10`, ['fiql-core'])),
	...ALIAS_FIQL.map((name) => draft(`price=${name}=10`, ['fiql-alias'], { ledger: [3] })),
];

const NOT_PREFIXES = [
	'not_eq', 'not_in', 'not_contains', 'not_ct', 'not_starts_with', 'not_sw',
	'not_ends_with', 'not_lt', 'not_le', 'not_gt', 'not_ge', 'not_equals', 'not_frobnicate',
] as const;

const notPrefixMatrix: Draft[] = NOT_PREFIXES.map((name) =>
	draft(name === 'not_in' ? `labels=${name}=(a,b)` : `labels=${name}=urgent`, ['not-prefix'])
);

const DRAFTS: Draft[] = [
	// ── §3.2 form encoding — Harper's non-parsing fast path (ledger row 1) ──────
	draft('', ['form-encoding'], { note: 'empty query' }),
	draft('a=1', ['form-encoding'], { ledger: [1] }),
	draft('a=1&b=2', ['form-encoding'], { ledger: [1] }),
	draft('a=1&a=2', ['form-encoding'], { ledger: [1], note: 'repeated parameter, no brackets' }),
	draft('a=', ['form-encoding'], { ledger: [1], note: 'empty value' }),
	draft('a', ['form-encoding'], { ledger: [1], note: 'name with no comparator' }),
	draft('a&b', ['form-encoding'], { ledger: [1] }),
	draft('a=1&', ['form-encoding'], { ledger: [1], note: 'trailing conjunction' }),
	draft('a=1&&b=2', ['form-encoding', 'adversarial'], { ledger: [1] }),
	draft('&', ['form-encoding', 'adversarial'], { ledger: [1] }),
	draft('=1', ['form-encoding', 'adversarial'], { ledger: [1], note: 'value with no property path' }),
	draft('a=1+2', ['form-encoding', 'pct-encoded-value'], { ledger: [1], note: 'raw + — form decoding vs percent decoding' }),
	draft('a=1+2&b<3', ['form-encoding', 'pct-encoded-value', 'symbol-op'], { note: 'the same + token, but on the parsing path' }),
	draft('a=b%26c', ['form-encoding', 'pct-encoded-value'], { ledger: [1] }),
	draft('a%20b=1', ['form-encoding', 'pct-encoded-path'], { ledger: [1] }),
	draft('a=%20', ['form-encoding', 'pct-encoded-value'], { ledger: [1] }),
	draft('%61=1', ['form-encoding', 'pct-encoded-path'], { ledger: [1] }),

	// ── §5.1.2 wildcards ────────────────────────────────────────────────────────
	draft('name==Jo*', ['wildcard']),
	draft('name=eq=Jo*', ['wildcard']),
	draft('name==*', ['wildcard'], { note: 'bare wildcard' }),
	draft('name==*Jo', ['wildcard', 'adversarial'], { note: 'leading wildcard — §5.1.2 syntax error' }),
	draft('name==*Jo*', ['wildcard', 'adversarial'], { note: 'embedded wildcard' }),
	draft('name==12*', ['wildcard'], { note: 'the stem is the decoded string, never interpreted' }),
	draft('name=starts_with=Jo*', ['wildcard'], { note: 'wildcards apply only to ==' }),
	draft('name===Jo*', ['wildcard'], { note: 'verbatim equality does not take a wildcard' }),
	draft('name==Jo%2A', ['wildcard', 'pct-encoded-value'], { note: '§4.2 rule 4 — an encoded marker is literal' }),
	draft('name!=Jo*', ['wildcard'], { note: 'negated equality with a wildcard stem' }),

	// ── §5.1.2 value lists ──────────────────────────────────────────────────────
	draft('a=in=(1,2)', ['value-list', 'fiql-core']),
	draft('a=in=(1)', ['value-list', 'fiql-core']),
	draft('a=in=()', ['value-list', 'fiql-core'], { note: 'the empty list' }),
	draft('a=in=(1,2,3,4,5)', ['value-list', 'fiql-core']),
	draft('a=in=(a,b%2Cc)', ['value-list', 'pct-encoded-value']),
	draft('a=not_in=(1,2)', ['value-list', 'not-prefix']),
	draft('a=out=(1,2)', ['value-list', 'fiql-alias'], { note: 'Appendix B: out desugars to not_in' }),
	draft('a=in=(number:1,boolean:true)', ['value-list', 'typed-value'], { note: 'list elements may be typed' }),
	draft('a=eq=(1,2)', ['value-list', 'adversarial'], { note: 'a list for a non-list comparator is a syntax error' }),
	draft('a=(4)', ['value-list', 'tolerance'], { ledger: [6], note: 'literal "(4)" on a non-list comparator' }),
	draft('a=lt=(4)', ['value-list', 'tolerance'], { ledger: [6] }),

	// ── Appendix B between / not_between (ledger row 4) ─────────────────────────
	draft('a=between=(1,5)', ['fiql-alias', 'value-list'], { ledger: [4] }),
	draft('a=not_between=(1,5)', ['fiql-alias', 'value-list', 'not-prefix'], { ledger: [4] }),
	draft('a=between=(1,5,9)', ['fiql-alias', 'adversarial'], { ledger: [4], note: 'between needs exactly two bounds' }),
	draft('a=between=1', ['fiql-alias', 'adversarial'], { ledger: [4], note: 'between needs a value list' }),
	draft('a=between=(number:1,number:5)', ['fiql-alias', 'typed-value'], { ledger: [4] }),
	draft('a=ge=1&=le=5', ['chain'], { ledger: [2], note: 'the canonical spelling of the between alias' }),

	// ── §5.2.2 typed and interpreted values ────────────────────────────────────
	draft('a==3', ['typed-value'], { note: 'round-trip decimal numeral becomes a number' }),
	draft('a==-5', ['typed-value']),
	draft('a==2.5', ['typed-value']),
	draft('a==1e3', ['typed-value'], { note: 'non-round-trip spelling stays a string' }),
	draft('a==01', ['typed-value'], { note: 'non-round-trip spelling stays a string' }),
	draft('a==1.50', ['typed-value'], { note: 'non-round-trip spelling stays a string' }),
	draft('a==null', ['typed-value']),
	draft('a==true', ['typed-value']),
	draft('a==false', ['typed-value']),
	draft('a=null', ['typed-value', 'form-encoding'], { ledger: [1], note: 'verbatim mode keeps the string' }),
	draft('a=eq=number:5', ['typed-value']),
	draft('a=eq=number:$ff', ['typed-value'], { note: 'base-36 numeral' }),
	draft('a=eq=number:-2.5', ['typed-value']),
	draft('a=eq=number:abc', ['typed-value', 'adversarial'], { note: 'malformed numeric literal' }),
	draft('a=eq=number:', ['typed-value', 'adversarial']),
	draft('a=eq=boolean:true', ['typed-value']),
	draft('a=eq=boolean:false', ['typed-value']),
	draft('a=eq=boolean:yes', ['typed-value', 'adversarial'], { note: 'malformed boolean literal' }),
	draft('a=eq=date:2020-01-01', ['typed-value']),
	draft('a=eq=date:2024-01-05T20%3A07%3A27.955Z', ['typed-value', 'pct-encoded-value']),
	draft('a=eq=date:1602872124871', ['typed-value'], { note: 'epoch millis' }),
	draft('a=eq=date:notadate', ['typed-value', 'adversarial'], { note: 'unparseable date literal' }),
	draft('a=eq=string:null', ['typed-value'], { note: 'the string: prefix suppresses further interpretation' }),
	draft('a=equals=null', ['typed-value', 'fiql-alias'], { ledger: [3], note: 'Appendix B reads equals in verbatim mode' }),
	draft('a=equal=null', ['typed-value', 'fiql-alias'], { ledger: [3] }),
	draft('a=not_equal=null', ['typed-value', 'fiql-alias'], { ledger: [3] }),
	draft('a=ne=null', ['typed-value', 'fiql-alias'], { ledger: [3], note: 'ne is interpreted in both' }),
	draft('a=eq=string:3', ['typed-value']),
	draft('a=eq=unknown:x', ['typed-value', 'adversarial'], { note: 'unknown type prefix — syntax error' }),
	draft('a==string%3Anull', ['typed-value', 'pct-encoded-value'], { note: '§4.2 rule 4 — an encoded marker is literal' }),
	draft('a==%2C', ['pct-encoded-value']),
	draft('a==%26', ['pct-encoded-value']),
	draft('a==%28x%29', ['pct-encoded-value']),
	draft('a==a%2Fb', ['pct-encoded-value']),

	// ── §5.5 property paths ────────────────────────────────────────────────────
	draft('brand.name=Microsoft', ['dotted-path']),
	draft('a.b.c==1', ['dotted-path']),
	draft('a.b.c.d.e==1', ['dotted-path']),
	draft('a%2Eb=1', ['pct-encoded-path', 'form-encoding'], { ledger: [1], note: '%2E is a literal dot inside one segment' }),
	draft('a%2Eb==1', ['pct-encoded-path']),
	draft('a%2Eb.c==1', ['pct-encoded-path', 'dotted-path'], { note: 'segment "a.b" then segment "c"' }),
	draft('a.b%2Ec==1', ['pct-encoded-path', 'dotted-path']),
	draft('%2E==1', ['pct-encoded-path', 'adversarial'], { note: 'a property literally named "."' }),
	draft('a-b_c~d==1', ['dotted-path'], { note: 'unreserved segment characters' }),
	draft('a%2Db==1', ['pct-encoded-path']),

	// ── §5.4 grouping ──────────────────────────────────────────────────────────
	draft('a=1|b=2', ['grouping-paren'], { ledger: [1] }),
	draft('(a=1|b=2)&c=3', ['grouping-paren']),
	draft('[a=1|b=2]&c=3', ['grouping-bracket']),
	draft('a=1&[b=2|c=3]', ['grouping-bracket']),
	draft('(a=1)', ['grouping-paren'], { note: 'a group of one — §6 does not flatten it' }),
	draft('[a=1]', ['grouping-bracket']),
	draft('a=1&(b=2|(c=3&d=4))', ['grouping-nested']),
	draft('[a=1&[b=2|[c=3|d=4]]]', ['grouping-nested']),
	draft('(a=1&b=2)|(c=3&d=4)', ['grouping-nested']),
	draft('((a=1))', ['grouping-nested']),
	draft('a=1&b=2|c=3', ['adversarial'], { ledger: [8], note: '§5.4 forbids mixing & and | in one group' }),
	draft('(a=1&b=2|c=3)', ['adversarial'], { note: 'mixing inside a group' }),
	draft('()', ['grouping-paren', 'adversarial'], { note: 'empty group' }),
	draft('[]', ['grouping-bracket', 'adversarial']),
	draft('(a=1&())', ['grouping-nested', 'adversarial']),
	draft('(a=in=(1,2)&b=2)', ['grouping-paren', 'value-list'], { note: 'a value list inside a parenthesized group' }),
	draft('[a=in=(1,2)&b=2]', ['grouping-bracket', 'value-list']),
	draft('x[a=in=(1,2)]', ['scoped-match', 'value-list']),

	// ── §5.3 chaining ──────────────────────────────────────────────────────────
	draft('ratings=ge=3&=le=4', ['chain'], { ledger: [2, 10] }),
	draft('ratings=ge=3&ratings=le=4', ['chain'], { note: 'contrast: two independent conditions' }),
	draft('ratings=ge=3|=le=4', ['chain'], { ledger: [2] }),
	draft('ratings=ge=3&=not_eq=4', ['chain', 'not-prefix'], { ledger: [2] }),
	draft('ratings=ge=3&=le=4&=ne=5', ['chain'], { ledger: [2], note: 'three-leg chain' }),
	draft('ratings=ge=3&=le=4&b=2', ['chain'], { ledger: [2], note: 'a chain followed by an independent condition' }),
	draft('a==1&=le=5', ['chain'], { ledger: [2], note: 'chain onto a symbolic-operator head' }),
	draft('a=1&=le=5', ['chain'], { ledger: [2], note: 'chain onto a verbatim-equality head' }),
	draft('ratings=ge=3&=5', ['chain', 'adversarial'], { ledger: [2], note: 'a nameless leg — a syntax error in 2.0' }),
	draft('ratings=ge=3&=le=4|=gt=1', ['chain', 'adversarial'], { note: 'mixing & and | within one chain' }),
	draft('&=le=4', ['chain', 'adversarial'], { note: 'a chain with no preceding condition' }),
	draft('(a=1)&=le=4', ['chain', 'adversarial'], { note: 'a chain onto a group' }),
	draft('a=in=(1,2)&=le=4', ['chain', 'value-list']),
	draft('a=between=(1,5)&=ne=3', ['chain', 'fiql-alias'], { ledger: [4] }),

	// ── §5.3 scoped sub-queries and element conditions ─────────────────────────
	draft('reviews[rating=ge=4&helpful=ge=10]', ['scoped-match'], { ledger: [14] }),
	draft('reviews[rating=ge=4|helpful=ge=10]', ['scoped-match'], { ledger: [14] }),
	draft('orders[status=open]', ['scoped-match'], { note: '§5.3 normalizes a single non-negated inner condition' }),
	draft('orders[status=not_eq=open]', ['scoped-match', 'not-prefix'], { note: 'a negated inner condition is never flattened' }),
	draft('a.b[c=1]', ['scoped-match', 'dotted-path']),
	draft('a%2Eb[c=1]', ['scoped-match', 'pct-encoded-path']),
	draft('a[b[c=1]]', ['scoped-match', 'grouping-nested']),
	draft('a[b=1&c[d=2]]', ['scoped-match', 'grouping-nested']),
	draft('x[a=1&b=2]|y=3', ['scoped-match', 'grouping-bracket']),
	draft('a[]', ['scoped-match', 'adversarial'], { note: 'an empty scope body' }),
	draft('scores[=ge=10|=le=2]', ['elem-cond'], { ledger: [14] }),
	draft('scores[=ge=10&=le=20]', ['elem-cond'], { ledger: [14] }),
	draft('scores[=ge=10]', ['elem-cond'], { ledger: [14], note: 'equivalent to scores=ge=10 after §5.3 normalization' }),
	draft('tags[=not_eq=urgent]', ['elem-cond', 'not-prefix'], { ledger: [14], note: 'some tag differs — contrast tags=not_eq=urgent' }),
	draft('tags=not_eq=urgent', ['not-prefix'], { note: 'no tag equals — negation scopes over the existential' }),
	draft('reviews[=ge=4&author.name=kim]', ['elem-cond', 'scoped-match', 'dotted-path'], { ledger: [14] }),

	// ── §5.4 not(...) ──────────────────────────────────────────────────────────
	draft('not(a=1)', ['not-expr'], { ledger: [13] }),
	draft('not(a=1&b=2)', ['not-expr'], { ledger: [13], note: 'De Morgan' }),
	draft('not(a=1|b=2)', ['not-expr'], { ledger: [13] }),
	draft('not(not(a=1))', ['not-expr'], { ledger: [13], note: 'a nested not cancels' }),
	draft('status=open&not(tag=urgent|tag=blocked)', ['not-expr'], { ledger: [13] }),
	draft('not(scores[=ge=10&=le=20])', ['not-expr', 'elem-cond'], { ledger: [13, 14] }),
	draft('not(reviews[rating=ge=4])', ['not-expr', 'scoped-match'], { ledger: [13, 14] }),
	draft('a=1&not(b=2)', ['not-expr'], { ledger: [13] }),
	draft('[not(a=1)|b=2]', ['not-expr', 'grouping-bracket'], { ledger: [13] }),
	draft('not()', ['not-expr', 'adversarial'], { ledger: [13], note: 'an empty body' }),
	draft('not(a=1&b=2|c=3)', ['not-expr', 'adversarial'], { ledger: [13], note: 'mixing still applies inside' }),

	// ── §5.6 sort ──────────────────────────────────────────────────────────────
	draft('sort(a)', ['sort'], { ledger: [5] }),
	draft('sort(+a)', ['sort'], { ledger: [5] }),
	draft('sort(-a)', ['sort'], { ledger: [5] }),
	draft('sort(+a,-b)', ['sort'], { ledger: [5] }),
	draft('sort(a,b,c)', ['sort'], { ledger: [5] }),
	draft('sort(a.b)', ['sort', 'dotted-path'], { ledger: [5] }),
	draft('sort(-a.b)', ['sort', 'dotted-path'], { ledger: [5] }),
	draft('sort(%2Bname)', ['sort', 'pct-encoded-path'], { note: '§4.2 rule 4 — %2B is a literal name character' }),
	draft('sort(%2Dname)', ['sort', 'pct-encoded-path']),
	draft('sort(a%2Eb)', ['sort', 'pct-encoded-path']),
	draft('sort()', ['sort', 'adversarial'], { note: 'no sort keys' }),
	draft('sort(a,)', ['sort', 'adversarial'], { note: 'a trailing comma' }),
	draft('sort(a', ['sort', 'adversarial'], { note: 'an unterminated call' }),
	draft('a=1&sort(b)', ['sort']),

	// ── §5.7 select ────────────────────────────────────────────────────────────
	draft('select(a)', ['select'], { ledger: [5], note: 'a single field is values mode' }),
	draft('select(a,b)', ['select'], { ledger: [5], note: 'records mode' }),
	draft('select(a,)', ['select'], { ledger: [5], note: 'a trailing comma forces records mode for one field' }),
	draft('select(a,b,)', ['select'], { ledger: [5] }),
	draft('select([a,b])', ['select'], { ledger: [5], note: 'tuple rows' }),
	draft('select([a])', ['select'], { ledger: [5] }),
	draft('select([a,b],c)', ['select'], { ledger: [5], note: 'a tuple item inside a record projection' }),
	draft('select(rel{x,y})', ['select'], { ledger: [5], note: 'a nested projection, brace form' }),
	draft('select(rel{x})', ['select'], { ledger: [5] }),
	draft('select(rel{x,y},id)', ['select'], { ledger: [5] }),
	draft('select(rel{x},rel2{y})', ['select'], { ledger: [5] }),
	draft('select(rel[select(x,y)])', ['select'], { ledger: [5], note: 'a nested projection, bracket form' }),
	draft('select(related{name,otherTable{other_name}},id,name)', ['select'], { ledger: [5], note: 'two levels of nesting' }),
	draft('select(related[select(name,otherTable[select(other_name,)])],id,name)', ['select'], { ledger: [5] }),
	draft('select(rel{[a,b]})', ['select', 'adversarial'], { note: '§5.7 reserves the nested tuple form' }),
	draft('select(a.b)', ['select', 'dotted-path'], { ledger: [5], note: 'a single dotted field' }),
	draft('select(a.b,c)', ['select', 'dotted-path'], { ledger: [5] }),
	draft('select(a%2Eb)', ['select', 'pct-encoded-path'], { ledger: [5] }),
	draft('select()', ['select', 'adversarial'], { note: 'no fields' }),
	draft('select(a', ['select', 'adversarial'], { note: 'an unterminated call' }),
	draft('select([a,b)', ['select', 'adversarial'], { note: 'mismatched brackets' }),
	draft('select(a)&sort(b)&limit(2)', ['select', 'sort', 'limit']),

	// ── §5.6 limit ─────────────────────────────────────────────────────────────
	draft('limit(10)', ['limit']),
	draft('limit(0)', ['limit']),
	draft('limit(5,10)', ['limit'], { note: 'start/end bounds — offset 5, at most 5 records' }),
	draft('limit(0,0)', ['limit']),
	draft('limit(x)', ['limit', 'adversarial'], { note: 'a non-integer argument is a §5.6 syntax error' }),
	draft('limit(-1)', ['limit', 'adversarial'], { note: 'a negative bound' }),
	draft('limit(2,1)', ['limit', 'adversarial'], { note: 'end below start' }),
	draft('limit(1.5)', ['limit', 'adversarial']),
	draft('limit(01)', ['limit', 'adversarial'], { note: 'a non-canonical integer spelling' }),
	draft('limit()', ['limit', 'adversarial']),
	draft('limit(1,2,3)', ['limit', 'adversarial'], { note: 'too many arguments' }),
	draft('limit(5,10', ['limit', 'adversarial'], { note: 'an unterminated call' }),

	// ── §5.6 the call-function namespace ───────────────────────────────────────
	draft('unknown(1)', ['call-error'], { ledger: [8], note: 'call names are a closed set' }),
	draft('lt(price,10)', ['call-error'], { note: 'Appendix A — comparators have no call form in 2.0' }),
	draft('group-by(a)', ['call-error'], { ledger: [8, 9], note: 'an Appendix C reserved name' }),
	draft('count(a)', ['call-error'], { note: 'an Appendix C reserved name' }),
	draft('distinct(a)', ['call-error'], { note: 'an Appendix C reserved name' }),
	draft('aggregate(a)', ['call-error'], { note: 'an Appendix C reserved name' }),
	draft('select(a)&select(b)', ['call-error'], { note: 'a call function may appear only once' }),
	draft('limit(1)&limit(2)', ['call-error']),
	draft('sort(a)&sort(b)', ['call-error']),
	draft('a=1&select(b)&sort(c)&limit(2)', ['select', 'sort', 'limit']),
	draft('select(b)&a=1', ['select'], { note: 'a call before a condition' }),

	// ── §4.1 tolerances and host accommodations ────────────────────────────────
	draft('foo=ba)r', ['tolerance'], { ledger: [6], note: '§4.1 — a lenient value scan may take ) literally' }),
	draft('foo==ba)r', ['tolerance'], { ledger: [6] }),
	draft('foo==ba(r', ['tolerance'], { ledger: [6] }),
	draft('foo=ba(r', ['tolerance'], { ledger: [6] }),
	draft('foo==a<b', ['tolerance'], { ledger: [6] }),
	draft('foo==a!b', ['tolerance'], { ledger: [6] }),
	draft('itemIds[]=1', ['tolerance'], { ledger: [7], note: 'an Appendix B repeated array parameter' }),
	draft('itemIds[]=1&itemIds[]=2', ['tolerance'], { ledger: [7] }),
	draft('itemIds[]=1&itemIds[]=2&b=3', ['tolerance'], { ledger: [7] }),

	// ── adversarial structure ──────────────────────────────────────────────────
	draft('(', ['adversarial']),
	draft(')', ['adversarial']),
	draft('[', ['adversarial']),
	draft(']', ['adversarial']),
	draft('((a=1)', ['adversarial'], { note: 'an unbalanced open group' }),
	draft('a=1)', ['adversarial', 'tolerance'], { ledger: [6], note: '§4.1 — the lenient value scan takes a stray ) literally' }),
	draft('(a=1))', ['adversarial']),
	draft('[a=1)', ['adversarial'], { note: 'crossed delimiters' }),
	draft('(a=1]', ['adversarial']),
	draft('|', ['adversarial']),
	draft('a=1|', ['adversarial']),
	draft('|a=1', ['adversarial']),
	draft('a==', ['adversarial'], { note: 'a comparator with no value' }),
	draft('==1', ['adversarial'], { note: 'a comparator with no property path' }),
	draft('a=%2E=1', ['adversarial', 'pct-encoded-value'], { note: 'an encoded dot cannot be a FIQL name' }),
	draft('a=1=2', ['adversarial'], { note: 'a raw = never occurs inside a value (§4 rule 2)' }),
	draft('a=9lives=1', ['adversarial'], { note: 'a FIQL name may not start with a digit' }),
	draft('a=has-dash=1', ['adversarial'], { note: 'a FIQL name may not contain a dash' }),
	draft('a=,=1', ['adversarial']),
	draft('a,b=1', ['adversarial'], { note: 'a comma outside a call' }),
	draft('{a}', ['adversarial'], { note: 'braces are only a select nesting form' }),
	draft('a{b}=1', ['adversarial']),
	draft('a=1&b', ['adversarial'], { note: 'a name with no comparator after a condition' }),
	draft('a=1&&&b=2', ['adversarial']),
	draft('a===1===2', ['adversarial']),
	draft('a!==', ['adversarial']),
	draft('a>=', ['adversarial']),
	draft('a<>1', ['adversarial'], { note: 'not an RQL operator' }),
	draft('a=1#b=2', ['adversarial'], { note: 'a fragment delimiter inside a query component' }),
	draft('a=1&limit(2)&', ['adversarial'], { ledger: [8] }),
	draft('a[b=1', ['adversarial'], { note: 'an unterminated scope' }),
	draft('a]b=1', ['adversarial']),
	draft('%ZZ=1', ['adversarial', 'pct-encoded-path'], { note: 'a malformed percent escape' }),
	draft('a=%ZZ', ['adversarial', 'pct-encoded-value'], { note: 'a malformed percent escape in a value' }),
	draft('a==%ZZ', ['adversarial', 'pct-encoded-value']),
	draft('a==%E0%A4%A', ['adversarial', 'pct-encoded-value'], { note: 'a truncated UTF-8 escape' }),
	draft('a'.repeat(200) + '=1', ['adversarial'], { note: 'a long property name' }),
	draft('a=' + '1'.repeat(500), ['adversarial'], { note: 'a long value' }),
	draft('(((((((((((a=1)))))))))))', ['adversarial', 'grouping-nested'], { note: 'deep nesting' }),
	draft('a=in=(' + Array.from({ length: 50 }, (_, index) => index).join(',') + ')', ['adversarial', 'value-list'], { note: 'a long value list' }),
	draft('a[b[c[d[e=1]]]]', ['adversarial', 'scoped-match'], { note: 'deep scoping' }),
	draft('a=1&' + Array.from({ length: 40 }, (_, index) => `f${index}=${index}`).join('&'), ['adversarial'], { note: 'many conditions' }),
];

function build(): readonly Case[] {
	const drafts = [...DRAFTS, ...symbolMatrix, ...fiqlMatrix, ...notPrefixMatrix];
	const seen = new Map<string, string>();
	const cases: Case[] = [];
	for (const item of drafts) {
		const id = `q${fnv1a(item.query)}`;
		const previous = seen.get(id);
		if (previous !== undefined)
			throw new Error(`corpus id collision between ${JSON.stringify(previous)} and ${JSON.stringify(item.query)}`);
		seen.set(id, item.query);
		cases.push({
			id,
			query: item.query,
			features: item.features,
			...(item.ledger ? { ledger: item.ledger } : {}),
			...(item.note ? { note: item.note } : {}),
		});
	}
	// Corpus order is declaration order; the fixture and the report both follow it.
	return Object.freeze(cases);
}

/**
 * Ledger rows that describe behavior AFTER parsing. A parser-only harness cannot witness
 * them, so the report says so instead of leaving them looking untested.
 */
export const EXECUTION_LEVEL_LEDGER_ROWS: Readonly<Record<number, string>> = {
	11: 'duplicate results from indexed `elements` attributes are produced by query execution, not by parsing',
	12: '`contains` coercing a number to its decimal string happens inside the comparator, at execution',
};

export const CORPUS: readonly Case[] = build();

/** A fingerprint of the corpus, stamped into the fixture so replay can detect drift. */
export function corpusDigest(cases: readonly Case[] = CORPUS): string {
	let hash = '';
	for (const item of cases) hash = fnv1a(hash + ' ' + item.id + ' ' + item.query);
	return `${cases.length}-${hash}`;
}

export function featureCoverage(cases: readonly Case[] = CORPUS): Map<string, Case[]> {
	const coverage = new Map<string, Case[]>();
	for (const feature of REQUIRED_FEATURES) coverage.set(feature, []);
	for (const item of cases)
		for (const feature of item.features) {
			const bucket = coverage.get(feature);
			if (bucket) bucket.push(item);
			else coverage.set(feature, [item]);
		}
	return coverage;
}

export function ledgerCoverage(cases: readonly Case[] = CORPUS): Map<number, Case[]> {
	const coverage = new Map<number, Case[]>();
	for (const item of cases)
		for (const row of item.ledger ?? []) {
			const bucket = coverage.get(row);
			if (bucket) bucket.push(item);
			else coverage.set(row, [item]);
		}
	return coverage;
}
