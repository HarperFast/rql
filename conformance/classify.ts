/**
 * Divergence classification.
 *
 * Every disagreement between Harper and the reference parser has to land in exactly one of
 * three buckets: a row of Harper's divergence ledger (spec Appendix D links to it), a NEW
 * divergence the ledger does not carry yet, or a bug in the reference parser. Nothing may
 * fall through — an unmatched disagreement is reported as `unclassified` and fails the run,
 * which is what keeps the report honest as the corpus grows.
 *
 * Two mechanisms do the work:
 *
 * 1. **A residual filter.** Harper's interpreted-mode values are never typed (§5.2.2), so
 *    that one divergence shows up as noise on top of many others. Differences it explains
 *    are removed first and recorded as `alsoUninterpretedValues`, and the remaining
 *    differences are what the rules match on. A case with nothing left over is classified
 *    as that divergence alone.
 *
 * 2. **Ordered rules.** Each rule matches either the *shape* of the residual disagreement
 *    (so a newly added corpus case with the same root cause is classified without being
 *    hand-labelled) or an explicit list of witness queries where the shape is not
 *    distinctive enough to be worth guessing at. The first matching rule wins.
 *
 * Where BOTH parsers deviate from the specification, the verdict names the side that has to
 * change for them to agree *conformantly* — normally Harper — and the rationale records the
 * reference parser's own gap so it is not lost.
 */

import type { Case } from './corpus.ts';
import type { Difference, Json, Outcome } from './canonical.ts';
import { isRejection } from './canonical.ts';

export type Proposal = {
	/** A proposed ledger row, in the columns Harper's ledger issue uses. */
	divergence: string;
	class: 'bug' | 'feature gap' | 'permitted' | 'tolerance' | 'divergence';
	action: string;
};

export type Classification =
	| { verdict: 'agrees' }
	| { verdict: 'ledger'; rule: string; row: number; rationale: string }
	| { verdict: 'new'; rule: string; rationale: string; proposal: Proposal }
	| { verdict: 'reference-bug'; rule: string; rationale: string }
	| { verdict: 'unclassified' };

export type Comparison = {
	case: Case;
	ref: Outcome;
	harper: Outcome;
	/** Differences left after the interpreted-value filter; empty when the two agree. */
	differences: Difference[];
	/** True when Harper answered from its non-parsing fast path (ledger row 1). */
	harperFastPath: boolean;
	/** True when some differences were explained by `value-not-interpreted` and removed. */
	alsoUninterpretedValues?: boolean;
};

type Rule = {
	id: string;
	/** Witness queries this rule applies to; omit to match on shape alone. */
	queries?: readonly string[];
	when?: (comparison: Comparison) => boolean;
	classify: () => Omit<Extract<Classification, { rule: string }>, 'rule'>;
};

// ── shape predicates ────────────────────────────────────────────────────────

const isValuePointer = (at: string): boolean => at === '/value' || at.endsWith('/value') || at.includes('/value/');

/** True when `harper` is the plain decimal/boolean/null *spelling* of `ref`'s typed literal. */
export function isUninterpretedSpelling(ref: Json | undefined, harper: Json | undefined): boolean {
	if (typeof harper !== 'string') return false;
	if (ref === null) return harper === 'null';
	if (typeof ref === 'number' || typeof ref === 'boolean') return String(ref) === harper;
	return false;
}

const explainedByValueMode = (difference: Difference): boolean =>
	isValuePointer(difference.at) &&
	(difference.kind === 'value' || difference.kind === 'type') &&
	isUninterpretedSpelling(difference.ref, difference.harper);

const everyDifference = (comparison: Comparison, predicate: (difference: Difference) => boolean): boolean =>
	comparison.differences.length > 0 && comparison.differences.every(predicate);

const bothParsed = (comparison: Comparison): boolean =>
	comparison.ref.status === 'parsed' && comparison.harper.status === 'parsed';

const harperRejectsOnly = (comparison: Comparison): boolean =>
	comparison.ref.status === 'parsed' && isRejection(comparison.harper);

const refRejectsOnly = (comparison: Comparison): boolean =>
	comparison.harper.status === 'parsed' && isRejection(comparison.ref);

const hasFeature = (comparison: Comparison, feature: string): boolean => comparison.case.features.includes(feature);
const hasLedgerTag = (comparison: Comparison, row: number): boolean => (comparison.case.ledger ?? []).includes(row);
const refErrorIs = (comparison: Comparison, name: string): boolean =>
	isRejection(comparison.ref) && (comparison.ref as { error: string }).error.startsWith(name);

// ── the rules, in order ─────────────────────────────────────────────────────

const RULES: readonly Rule[] = [
	{
		id: 'reference-uri-error-not-a-client-error',
		when: (comparison) => refErrorIs(comparison, 'URIError'),
		classify: () => ({
			verdict: 'reference-bug',
			rationale:
				'The reference parser calls `decodeURIComponent` on the raw token and lets the resulting `URIError` escape. §4.2 makes percent-decoding part of parsing and §6.1 makes a structural violation a client error, so a malformed escape must surface as a `SyntaxViolation` (HTTP 400), not as a bare `URIError` with no status. Harper answers from its fast path here and leaves the malformed escape in place (ledger row 1).',
		}),
	},
	{
		id: 'harper-fast-path-form-decoding',
		when: (comparison) =>
			comparison.harperFastPath &&
			everyDifference(
				comparison,
				(difference) =>
					isValuePointer(difference.at) &&
					typeof difference.ref === 'string' &&
					typeof difference.harper === 'string' &&
					difference.ref.includes('+') &&
					difference.ref.replace(/\+/g, ' ') === difference.harper
			),
		classify: () => ({
			verdict: 'new',
			rationale:
				'The fast path builds a `URLSearchParams`, which decodes `+` as a space (HTML form encoding). §4.2 defines decoding as percent-decoding per token, where `+` is a literal. Harper therefore reads `a=1+2` two different ways depending on whether anything else in the query forced the parsing path — `"1 2"` on the fast path, `"1+2"` on the parsing path.',
			proposal: {
				divergence: 'The fast path decodes values with HTML form rules, so a raw `+` becomes a space — and means something different once any structural character forces the parsing path',
				class: 'bug',
				action: 'decode fast-path names/values with `decodeURIComponent` (§4.2), or route every query through the parser',
			},
		}),
	},
	{
		id: 'ledger-1-fast-path-skips-parsing',
		when: (comparison) => comparison.harperFastPath && (refRejectsOnly(comparison) || comparison.differences.length > 0),
		classify: () => ({
			verdict: 'ledger',
			row: 1,
			rationale:
				'The query contains none of the characters that trigger Harper’s parser, so it is never parsed: `URLSearchParams` splits it into name/value pairs and any structure in it becomes literal text. That makes Harper accept strings §4 rejects (a bare name, a value containing `=` or `,`, `{`/`}`). Where the reference parser also accepts such a string, it does so by silently DROPPING the malformed term rather than rejecting it, which is a gap of its own.',
		}),
	},
	{
		id: 'ledger-13-no-not-expression',
		when: (comparison) => hasFeature(comparison, 'not-expr') && harperRejectsOnly(comparison),
		classify: () => ({
			verdict: 'ledger',
			row: 13,
			rationale:
				'`not` is read as a call-function name, and it is not in Harper’s call namespace, so the query is rejected instead of desugaring to leaf/scope negation (§5.4).',
		}),
	},
	{
		id: 'ledger-14-element-conditions',
		when: (comparison) => hasFeature(comparison, 'elem-cond') && harperRejectsOnly(comparison),
		classify: () => ({
			verdict: 'ledger',
			row: 14,
			rationale:
				'An element condition (§5.3) has an empty relative path. Harper requires an attribute before every comparator, so `prop[=ge=10]` is rejected — it supports only the `prop[cond&cond]` half of scoped matching.',
		}),
	},
	{
		id: 'ledger-2-nameless-chain-leg',
		queries: ['ratings=ge=3&=5'],
		classify: () => ({
			verdict: 'ledger',
			row: 2,
			rationale:
				'Harper lets a nameless chain leg inherit the preceding comparator. §4’s `chained-cond` requires a comparator name on every leg, so the reference parser rejects it; the ledger already marks this for deprecation.',
		}),
	},
	{
		id: 'ledger-6-lenient-value-scan',
		// The tag alone would swallow any other disagreement on these queries, so the rule also
		// requires the shape the tolerance actually produces: Harper accepts, the reference does not.
		when: (comparison) => hasLedgerTag(comparison, 6) && refRejectsOnly(comparison),
		classify: () => ({
			verdict: 'ledger',
			row: 6,
			rationale:
				'§4.1 lets a consumer scan a value leniently and take `(`, `)`, `<`, `>` and `!` as literal characters. Harper does; the reference parser does so only after an interpreting comparator. Both readings are conformant — this is a tolerance, not a semantic difference — and producers must percent-encode these characters regardless.',
		}),
	},
	{
		id: 'ledger-7-repeated-array-parameter',
		when: (comparison) => hasLedgerTag(comparison, 7) && refRejectsOnly(comparison),
		classify: () => ({
			verdict: 'ledger',
			row: 7,
			rationale:
				'`prop[]=v` is a host-framework accommodation (Appendix B), not RQL grammar: Harper turns it into a membership condition, while the reference parser reads `[` structurally and rejects the empty scope body.',
		}),
	},
	{
		id: 'reference-gap-value-list-inside-a-group',
		queries: ['(a=in=(1,2)&b=2)', '[a=in=(1,2)&b=2]', 'x[a=in=(1,2)]'],
		classify: () => ({
			verdict: 'reference-bug',
			rationale:
				'Known reference-parser gap. Inside a group or scope body the reference parser always tokenizes with the structural pattern, so a `(v1,v2)` value list is read as a nested group and rejected. §5.1.2 puts no such restriction on where a value list may appear; Harper is right here.',
		}),
	},
	{
		id: 'reference-rejects-chaining-after-between',
		queries: ['a=between=(1,5)&=ne=3'],
		classify: () => ({
			verdict: 'reference-bug',
			rationale:
				'`between` is a condition in surface terms (`prop=fiql-name=value-list`), so §4’s `chained-cond` — "MUST directly follow a condition or another chained-cond" — permits chaining onto it. The reference parser has already desugared it to an ElementMatch by then and refuses to chain onto a non-Condition. Harper extends the same element scope, which is what §5.3 describes.',
		}),
	},
	{
		id: 'reference-wildcard-on-negated-equality',
		queries: ['name!=Jo*'],
		classify: () => ({
			verdict: 'reference-bug',
			rationale:
				'§5.1.2: "The trailing-`*` wildcard applies only to `==`". The reference parser applies it to every non-verbatim equality, so `!=` becomes a negated `starts_with`. Harper keeps the `*` as a literal, which is what the spec says.',
		}),
	},
	{
		id: 'reference-missing-camelcase-alias',
		queries: ['price=notEqual=10'],
		classify: () => ({
			verdict: 'reference-bug',
			rationale:
				'Appendix B’s alias list ends in "…", and the reference parser implements the camelCase forms for the ordered comparators (`lessThan`, `greaterThanEqual`, …) but not `notEqual`, which falls through to the open vocabulary. Harper resolves it to `ne`. Either the reference parser should carry the alias or Appendix B should close the list explicitly.',
		}),
	},
	{
		id: 'reference-accepts-a-leading-conjunction',
		queries: ['|', '|a=1'],
		classify: () => ({
			verdict: 'reference-bug',
			rationale:
				'§4’s `query` production has a term before every conjunction, so a leading `|` is a syntax error. The reference parser records the group operator and moves on, accepting the query; Harper rejects it.',
		}),
	},
	{
		id: 'harper-not-prefix-only-for-a-fixed-base-set',
		when: (comparison) =>
			bothParsed(comparison) &&
			comparison.differences.length > 0 &&
			comparison.differences.every(
				(difference) =>
					(difference.at.endsWith('/comparator') &&
						typeof difference.ref === 'string' &&
						difference.harper === `not_${difference.ref}`) ||
					(difference.at.endsWith('/negated') && difference.ref === true)
			),
		classify: () => ({
			verdict: 'new',
			rationale:
				'§5.1.1 makes `not_` a uniform prefix over *any* comparator, including open-vocabulary names. Harper’s `resolveComparator` strips it only when the base is one of `in`, `between`, `starts_with`, `ends_with`, `contains`, `equals`, so `not_lt`, `not_ge` and `not_<anything unknown>` survive as opaque comparator names that no executor implements — a silent no-match rather than a negation.',
			proposal: {
				divergence: 'The `not_` prefix is recognized only for a fixed base set, so `not_lt`/`not_le`/`not_gt`/`not_ge` and `not_<open-vocabulary name>` are not negations',
				class: 'bug',
				action: 'strip `not_` from any comparator name and set `negated` (§5.1.1); leave semantic validation of the base name to execution',
			},
		}),
	},
	{
		id: 'harper-includes-is-in-not-contains',
		queries: ['price=includes=10'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'Appendix B desugars `includes` to `contains`; Harper’s `ALTERNATE_COMPARATOR_NAMES` maps it to `in`. The two mean different things — substring containment versus membership in a supplied list — so the same query returns different records.',
			proposal: {
				divergence: '`includes` is an alias for `in`, but Appendix B assigns it to `contains`',
				class: 'divergence',
				action: 'decide: realign `includes` with Appendix B, or record it as a Harper-lineage exception and have the spec note the conflict',
			},
		}),
	},
	{
		id: 'harper-missing-out-alias',
		queries: ['a=out=(1,2)'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'Appendix B carries the RQL 1.x `out` alias for `not_in`. Harper does not know the name, so it is left as an opaque comparator and its `(1,2)` argument is never recognized as a value list — the condition becomes an equality against the literal string `"(1,2)"`.',
			proposal: {
				divergence: 'The RQL 1.x `out` alias is not accepted; the value list is left as the literal string `(v1,v2)`',
				class: 'feature gap',
				action: 'add `out` → `not_in` to `ALTERNATE_COMPARATOR_NAMES` (Appendix B), or reject unknown comparators at parse',
			},
		}),
	},
	{
		id: 'harper-wildcard-on-fiql-equality',
		queries: ['name=eq=Jo*'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§5.1.2 restricts the trailing-`*` wildcard to the `==` surface form. Harper applies it whenever the raw comparator name is `eq`, so the FIQL spelling `=eq=` also wildcards. Worth confirming with the spec editor rather than only with Harper: `==` and `=eq=` desugar to the same comparator and the same value mode, so the asymmetry may be a spec gap rather than an implementation one.',
			proposal: {
				divergence: 'The trailing-`*` wildcard is applied to the FIQL form `=eq=` as well as to `==`',
				class: 'divergence',
				action: 'confirm §5.1.2’s intent for `=eq=`; then either restrict the wildcard to `==` or widen the spec to both spellings',
			},
		}),
	},
	{
		id: 'harper-alias-value-mode-is-always-interpreted',
		queries: ['a=equals=null', 'a=equal=null', 'a=not_equal=null'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'Appendix B desugars `equals` / `equal` / `not_equal` to a VERBATIM value (they are the FIQL spelling of `===` and `!==`). Harper decodes every FIQL value with `typedDecoding`, so the strict comparators still interpret `null` — the one literal `typedDecoding` does convert — and a query asking for the four-character string `null` matches the null value instead.',
			proposal: {
				divergence: 'The strict aliases `equals`/`equal`/`not_equal` decode their value in interpreted mode, so `=equals=null` matches null rather than the string "null"',
				class: 'bug',
				action: 'decode the value mode from the comparator (§5.2): verbatim for `=`, `===`, `!==` and their aliases; interpreted otherwise',
			},
		}),
	},
	{
		id: 'harper-malformed-typed-literals-are-coerced',
		queries: ['a=eq=number:abc', 'a=eq=number:', 'a=eq=boolean:yes', 'a=eq=date:notadate'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§5.2.2 makes a malformed typed literal a syntax error (HTTP 400), and §6 requires every value in the model to be well-formed — "no NaN, no invalid timestamps". Harper coerces instead: `number:abc` becomes `NaN`, `number:` becomes `0`, `boolean:yes` becomes `false`, and `date:notadate` becomes an Invalid Date. Each of those silently changes which records match.',
			proposal: {
				divergence: 'Malformed typed literals are coerced rather than rejected — `number:abc` → NaN, `number:` → 0, `boolean:yes` → false, `date:notadate` → Invalid Date',
				class: 'bug',
				action: 'reject a malformed typed literal with a 400 (§5.2.2); never admit NaN or an invalid Date into a condition',
			},
		}),
	},
	{
		id: 'harper-between-arguments-unvalidated',
		queries: ['a=between=(1,5,9)', 'a=between=1'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'Appendix B defines `between=(lo,hi)` as exactly two bounds desugaring to `ge` AND `le`. Harper accepts any argument shape: three values produce a three-element list and a bare scalar produces a string, both of which reach execution as a `between` comparator that cannot be evaluated as a range.',
			proposal: {
				divergence: '`between` accepts anything as its argument — a bare scalar or a list of any length — instead of requiring exactly two bounds',
				class: 'bug',
				action: 'reject a `between` argument that is not a two-element value list (Appendix B)',
			},
		}),
	},
	{
		id: 'harper-chain-supports-only-one-leg',
		queries: ['ratings=ge=3&=le=4&=ne=5'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'`parseBlock` switches to the value pattern (the one that recognizes `&=` and `|=` as single tokens) only while an attribute is pending. After the first chained leg the attribute is the empty string, so the second `&=` is tokenized as `&` followed by `=` and the query is rejected. §5.3 puts no bound on the number of chained legs, and two-sided ranges plus an exclusion (`=ge=3&=le=9&=ne=5`) are the obvious case.',
			proposal: {
				divergence: 'Only ONE chained leg is supported: a second `&=` / `|=` is tokenized as `&` + `=` and rejected',
				class: 'bug',
				action: 'keep using the value pattern across chained legs so `prop=ge=1&=le=9&=ne=5` parses (§5.3)',
			},
		}),
	},
	{
		id: 'harper-empty-group-body-accepted',
		queries: ['()', '[]', '(a=1&())', 'a[]'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§4’s `group-body` requires at least one term, so `()`, `[]` and `prop[]` are syntax errors. Harper builds an empty condition group instead, and an empty AND group is vacuously true — a query that should be rejected becomes one that matches everything. (The reference parser accepts these too, but drops the empty group rather than keeping it; it should reject.)',
			proposal: {
				divergence: 'An empty group or scope body (`()`, `[]`, `prop[]`) is accepted and becomes an empty condition group, which matches every record',
				class: 'bug',
				action: 'reject an empty `group-body` at parse (§4)',
			},
		}),
	},
	{
		id: 'harper-unbalanced-groups-accepted',
		queries: ['((a=1)', '[a=1)', 'a[b=1'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'`parseBlock` reports a missing terminator only for the block that is waiting for one, so a group left open at the end of the string — or closed with the wrong delimiter — parses as if it had been closed. The query silently means something other than what was written.',
			proposal: {
				divergence: 'Unterminated or mismatched group delimiters (`((a=1)`, `[a=1)`, `a[b=1`) parse as if the group had been closed correctly',
				class: 'bug',
				action: 'require every opened group/scope to be closed by its own delimiter before the end of the query',
			},
		}),
	},
	{
		id: 'harper-duplicate-call-functions-accepted',
		queries: ['select(a)&select(b)', 'limit(1)&limit(2)', 'sort(a)&sort(b)'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§5.6: "A call function appearing more than once in a query is a syntax error." Harper overwrites the earlier call, so a duplicate silently wins on last-write — which is exactly the shape a request-smuggling or cache-key bug takes when two layers each append a `limit(...)`.',
			proposal: {
				divergence: 'A repeated call function is accepted, last one wins, instead of being a syntax error',
				class: 'bug',
				action: 'reject a second occurrence of `select`, `sort` or `limit` in one query (§5.6)',
			},
		}),
	},
	{
		id: 'harper-limit-arguments-unvalidated',
		queries: ['limit(x)', 'limit(-1)', 'limit(2,1)', 'limit(1.5)', 'limit(01)'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§5.6 requires non-negative decimal integers with end ≥ start, and §6 requires `limit`/`offset` to be validated non-negative integers. Harper applies unary `+` and keeps whatever comes out: `limit(x)` becomes `NaN`, `limit(-1)` a negative limit, and `limit(2,1)` an offset of 2 with a limit of −1.',
			proposal: {
				divergence: '`limit` arguments are coerced with unary `+` and never validated — `limit(x)` → NaN, `limit(-1)` → −1, `limit(2,1)` → offset 2 / limit −1',
				class: 'bug',
				action: 'validate both arguments as non-negative decimal integers with end ≥ start, and reject otherwise (§5.6)',
			},
		}),
	},
	{
		id: 'harper-sort-direction-marker-read-after-decoding',
		queries: ['sort(%2Bname)', 'sort(%2Dname)'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§4.2 rule 4 recognizes the `+`/`-` sort marker on the RAW token, so `%2B`/`%2D` are literal name characters — `sort(%2Bname)` sorts by the property named `+name`. Harper decodes the token first and then inspects its first character, so the escape is indistinguishable from the marker and a property whose name starts with `+` or `-` cannot be sorted on at all.',
			proposal: {
				divergence: 'The `+`/`-` sort-direction marker is read AFTER percent-decoding, so `sort(%2Bname)` is treated as ascending `name` rather than the property `+name`',
				class: 'bug',
				action: 'read the direction marker on the raw token before decoding (§4.2 rule 4)',
			},
		}),
	},
	{
		id: 'harper-trailing-comma-yields-an-empty-key',
		queries: ['sort(a,)', 'select(a,b,)'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'A trailing comma is significant only for `select`, where it forces records mode for a single field (§5.7). Harper pushes the empty token as another argument, producing a sort key on the property named "" and a selected field named "" — neither of which exists.',
			proposal: {
				divergence: 'A trailing comma in a call adds an empty argument: `sort(a,)` gains a sort key on "" and `select(a,b,)` a field named ""',
				class: 'bug',
				action: 'drop a trailing empty argument; keep its only meaning, the single-field records form `select(a,)` (§5.7)',
			},
		}),
	},
	{
		id: 'harper-dotted-select-path-collides-with-tuple-form',
		queries: ['select(a.b)', 'select(a.b,c)'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'A dotted select path is decoded into a segment array, which is the same representation Harper uses for the `[a,b]` tuple form — so `select(a.b)` is indistinguishable from `select([a,b])` and is projected as a two-column tuple of the top-level properties `a` and `b` rather than as the nested property `a.b`. §5.7’s `select-item` is a `prop-path`, and §5.5 makes dotted paths nested-property addressing.',
			proposal: {
				divergence: 'A dotted path in `select` is represented as a segment array and read as the `[a,b]` tuple form, so `select(a.b)` projects two top-level properties instead of the nested one',
				class: 'bug',
				action: 'give a nested select path a distinct representation from the tuple form (e.g. `{ name: [...] }` vs. an `asArray` list)',
			},
		}),
	},
	{
		id: 'harper-reserved-nested-tuple-accepted',
		queries: ['select(rel{[a,b]})'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§5.7 reserves the nested tuple form: "A nested `[x,y]` tuple form (`rel{[x,y]}`) is reserved and currently a syntax error." Harper accepts it and produces a nested list whose single element is an unnamed array, which no consumer reads as a projection.',
			proposal: {
				divergence: 'The reserved nested tuple form `rel{[a,b]}` is accepted and produces an unnamed nested array',
				class: 'bug',
				action: 'reject a `[...]` item inside a `{...}` nested projection until the form is specified (§5.7)',
			},
		}),
	},
	{
		id: 'harper-empty-sort-rejected',
		queries: ['sort()'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§4’s `call` production makes the argument list optional, so `sort()` is grammatical and means "no ordering". Harper reaches `toSortObject` with an empty argument list and reports "Unknown sort type undefined". Low impact, but it is a rejection of a grammatical query; if the intent is that `sort` requires at least one key, §5.6 should say so.',
			proposal: {
				divergence: '`sort()` with no keys is rejected, though §4 makes a call’s argument list optional',
				class: 'divergence',
				action: 'accept `sort()` as a no-op, or have §5.6 require at least one sort key',
			},
		}),
	},
	{
		id: 'harper-empty-value-drops-the-condition',
		queries: ['a==', 'a!==', 'a>='],
		classify: () => ({
			verdict: 'new',
			rationale:
				'§4’s `plain-value` is `*vchar` — the empty value is legal, and `a==` is a condition against the empty string. Harper’s value pattern requires at least one character, so at the end of the string the pending condition is never built and the whole filter disappears: `?a==` returns every record instead of the ones whose `a` is empty. (`a=` takes the fast path and does produce the condition, so the two spellings disagree inside Harper.)',
			proposal: {
				divergence: 'A comparator followed by an empty value at end-of-string silently drops the condition, so `?a==` returns everything',
				class: 'bug',
				action: 'allow an empty value token on the parsing path (§4 `plain-value = *vchar`), matching what the fast path already does for `a=`',
			},
		}),
	},
	{
		id: 'harper-re-anchors-on-a-second-operator',
		queries: ['a===1===2'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'Two comparators in one term are a syntax error (§4 rule 2: a raw `=` never occurs inside a value). Harper takes the second operator as the start of a new condition and builds one on the property named `1`; the reference parser instead keeps the first condition and silently discards the rest, which is its own gap. Neither rejects.',
			proposal: {
				divergence: 'A second comparator in one term re-anchors the condition (`a===1===2` becomes a condition on the property `1`) instead of being a syntax error',
				class: 'bug',
				action: 'reject a second comparator within one term (§4 rule 2)',
			},
		}),
	},
	{
		id: 'harper-trailing-conjunction-drops-the-operator',
		queries: ['a=1|'],
		classify: () => ({
			verdict: 'new',
			rationale:
				'A trailing conjunction with no following term is a syntax error under §4. Both parsers accept it; they differ in what the resulting one-term group says: Harper assigns the group operator only when a second condition arrives, so the group reports `and` where the query said `|`. With a single term the operator carries no meaning, but the two representations are not equal.',
			proposal: {
				divergence: 'A dangling conjunction is accepted, and the group operator it named is dropped (`a=1|` yields an `and` group)',
				class: 'bug',
				action: 'reject a conjunction with no following term (§4)',
			},
		}),
	},
];

/**
 * Split a difference list into the part explained by Harper's uninterpreted values and the
 * part that still needs a rule.
 */
export function partitionDifferences(differences: Difference[]): { residual: Difference[]; valueMode: boolean } {
	const residual = differences.filter((difference) => !explainedByValueMode(difference));
	return { residual, valueMode: residual.length !== differences.length };
}

const VALUE_MODE_CLASSIFICATION: Extract<Classification, { verdict: 'new' }> = {
	verdict: 'new',
	rule: 'value-not-interpreted',
	rationale:
		'Harper’s `typedDecoding` interprets only `null` and the explicit `type:` prefixes, so a bare `3`, `true` or `false` in interpreted position stays the string it was written as. §5.2.2 makes a round-trip decimal numeral a number and `true`/`false` booleans in EVERY interpreted mode — `==`, `!=`, the ordered symbolic operators, and all FIQL named comparators. Downstream, `Table.ts` re-coerces against the column type where a schema attribute is known, which is why this is usually invisible; it stops being invisible for schema-less values, for chained legs (whose attribute is null — ledger row 10) and for any consumer that reads the parsed condition directly.',
	proposal: {
		divergence:
			'Interpreted-mode value literals are not typed at parse: a bare numeral stays a string and `true`/`false` stay strings (only `null` and the `type:` prefixes are honored)',
		class: 'bug',
		action: 'apply §5.2.2 in `typedDecoding` — round-trip decimal numerals become numbers, `true`/`false` become booleans',
	},
};

/**
 * Outcomes that can constitute agreement. A timeout, an adapter gap or a harness error is
 * never agreement, even when both sides report it — those mean the harness did not observe
 * the parse, which has to surface rather than pass.
 */
const AGREEABLE_STATUSES: ReadonlySet<string> = new Set(['parsed', 'rejected', 'deferred-error']);

export function classify(comparison: Comparison): Classification {
	// Note that agreement requires the same *mode* of rejection, not merely that neither side
	// accepted: a `rejected` on one side and a `deferred-error` on the other is a real
	// difference (the deferring side still produced a partial result) and must reach the rules.
	if (
		comparison.ref.status === comparison.harper.status &&
		AGREEABLE_STATUSES.has(comparison.ref.status) &&
		comparison.differences.length === 0 &&
		!comparison.alsoUninterpretedValues
	)
		return { verdict: 'agrees' };

	for (const rule of RULES) {
		if (rule.queries && !rule.queries.includes(comparison.case.query)) continue;
		if (rule.when && !rule.when(comparison)) continue;
		if (!rule.queries && !rule.when) continue;
		return { ...rule.classify(), rule: rule.id } as Classification;
	}

	// Nothing structural left over: the whole disagreement is the value-mode divergence.
	if (comparison.differences.length === 0 && comparison.alsoUninterpretedValues) return VALUE_MODE_CLASSIFICATION;

	return { verdict: 'unclassified' };
}

export const RULE_IDS: readonly string[] = [...RULES.map((rule) => rule.id), VALUE_MODE_CLASSIFICATION.rule];
