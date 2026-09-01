/**
 * Adapter: Harper's REST parse output → the RQL 2.0 canonical model (`src/types.ts`).
 *
 * Spec §8 lets an implementation with a different internal representation conform "by
 * supplying an adapter from its internal form to the canonical model". This is that
 * adapter, and the rules it follows are deliberately narrow:
 *
 * 1. **Structural only — values pass through untouched.** Harper has already decoded and
 *    (per its own rules) typed every value token. Re-interpreting `"3"` as `3` here would
 *    hide exactly the value-model divergences the harness exists to find.
 * 2. **Alias resolution follows *Harper's* vocabulary, not the spec's.** `includes` maps to
 *    `in` because that is what Harper's `ALTERNATE_COMPARATOR_NAMES` means by it, even
 *    though Appendix B assigns `includes` to `contains`. The diff then reports the real
 *    disagreement instead of an adapter that quietly agrees.
 * 3. **§6 normalization is applied**, because it is part of the canonical model rather than
 *    of either parser: a non-negated element-scoped match holding exactly one non-negated
 *    condition collapses to a plain condition on the concatenated path (§5.3).
 * 4. **Parse-time shape only.** Where Harper's *executor* later reads a shape in a
 *    surprising way, that is recorded in the report as an observation, not folded in here.
 * 5. **Total, except for genuinely unknown shapes.** Anything the adapter cannot place
 *    raises `AdapterError`, which the report surfaces as an adapter gap rather than
 *    silently dropping.
 */

import type { Condition, ElementMatch, Field, Group, ParseResult, Projection, SortKey, Value } from '../src/types.ts';

export class AdapterError extends Error {}

export type HarperOutcome =
	| { status: 'parsed'; result: ParseResult }
	/** Harper's deferred-error mode (§6.1, ledger row 8): a result object carrying `parseError`. */
	| { status: 'deferred-error'; message: string; partial: ParseResult };

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null;

/** Harper comparator name → canonical comparator plus whether the alias itself negates. */
const COMPARATOR_ALIASES: Readonly<Record<string, { comparator: string; negated?: true }>> = {
	// Symbolic-operator outputs (`SYMBOL_OPERATORS` in resources/search.ts).
	eq: { comparator: 'eq' },
	equals: { comparator: 'eq' },
	ne: { comparator: 'eq', negated: true },
	not_equal: { comparator: 'eq', negated: true },
	// `ALTERNATE_COMPARATOR_NAMES` — resolved at execution in Harper, at adaptation here.
	equal: { comparator: 'eq' },
	notEqual: { comparator: 'eq', negated: true },
	greater_than: { comparator: 'gt' },
	greaterThan: { comparator: 'gt' },
	greater_than_equal: { comparator: 'ge' },
	greaterThanEqual: { comparator: 'ge' },
	less_than: { comparator: 'lt' },
	lessThan: { comparator: 'lt' },
	less_than_equal: { comparator: 'le' },
	lessThanEqual: { comparator: 'le' },
	sw: { comparator: 'starts_with' },
	startsWith: { comparator: 'starts_with' },
	ew: { comparator: 'ends_with' },
	endsWith: { comparator: 'ends_with' },
	ct: { comparator: 'contains' },
	// Rule 2: Harper reads `includes` as `in`; Appendix B reads it as `contains`.
	includes: { comparator: 'in' },
};

/** A property path Harper has already decoded (`decodeProperty`): string, or segment array. */
function decodedPath(attribute: unknown): string[] {
	if (attribute === null || attribute === undefined) return [];
	if (Array.isArray(attribute)) return attribute.map((segment) => String(segment));
	if (typeof attribute === 'string') return [attribute];
	throw new AdapterError(`unsupported attribute shape: ${Object.prototype.toString.call(attribute)}`);
}

/**
 * A property path Harper kept RAW — the `name` of a scoped match or of a nested select,
 * which `parseBlock` assigns straight from the token. Split on literal `.` first so that
 * `%2E` stays inside one segment (§4.2).
 */
function rawPath(name: unknown): string[] {
	if (typeof name !== 'string') throw new AdapterError(`unsupported raw path shape: ${String(name)}`);
	return name.split('.').map((segment) => decodeURIComponent(segment));
}

const isConditionShape = (term: Dict): boolean => 'comparator' in term || 'attribute' in term || 'value' in term;
const isGroupShape = (term: Dict): boolean => Array.isArray(term.conditions);

/**
 * §5.3 / §6: a non-negated element-scoped match with exactly one non-negated inner
 * condition is the same thing as a plain condition on the concatenated path, and the
 * canonical model states it that way. Mirrors `pushElementMatch` in the reference parser.
 */
function normalizeElementMatch(match: ElementMatch): Condition | ElementMatch {
	const terms = match.some.terms;
	if (match.negated || terms.length !== 1) return match;
	const only = terms[0];
	if (!('comparator' in only) || only.negated) return match;
	const merged: Condition = { path: [...match.path, ...only.path], comparator: only.comparator, value: only.value };
	return merged;
}

function relativeLeg(raw: Dict, scopePath: string[]): Condition {
	const leg = adaptCondition(raw);
	if ('some' in leg) throw new AdapterError('a chained leg cannot itself be an element match');
	// Harper stores a chained leg with `attribute: null`; a `between` head keeps its own path.
	return { ...leg, path: leg.path.slice(scopePath.length) };
}

function adaptCondition(raw: Dict): Condition | ElementMatch {
	const rawComparator = raw.comparator === undefined || raw.comparator === null ? 'equals' : String(raw.comparator);
	const path = decodedPath(raw.attribute);
	const negatedByFlag = raw.negated === true;

	if (rawComparator === 'between') {
		const bounds = raw.value;
		// Appendix B: `between=(lo,hi)` is an element-scoped `ge` AND `le` (ledger row 4).
		if (Array.isArray(bounds) && bounds.length === 2) {
			const match: ElementMatch = {
				path,
				some: {
					operator: 'and',
					terms: [
						{ path: [], comparator: 'ge', value: bounds[0] as Value },
						{ path: [], comparator: 'le', value: bounds[1] as Value },
					],
				},
			};
			if (negatedByFlag) match.negated = true;
			return withChain(raw, match, path);
		}
		// Not a two-element list: keep Harper's literal condition so the diff can say so.
		const literal: Condition = { path, comparator: 'between', value: bounds as Value };
		if (negatedByFlag) literal.negated = true;
		return withChain(raw, literal, path);
	}

	const alias = COMPARATOR_ALIASES[rawComparator];
	const condition: Condition = {
		path,
		comparator: alias ? alias.comparator : rawComparator,
		value: raw.value as Value,
	};
	if (negatedByFlag !== (alias?.negated === true)) condition.negated = true;
	return withChain(raw, condition, path);
}

/**
 * `chainedConditions` (ledger row 2) is Harper's spelling of an element-scoped match: the
 * head condition plus its legs all bind to one element at the head's path.
 */
function withChain(raw: Dict, head: Condition | ElementMatch, path: string[]): Condition | ElementMatch {
	const chained = raw.chainedConditions;
	if (!Array.isArray(chained) || chained.length === 0) return head;

	const terms: (Condition | Group | ElementMatch)[] = [];
	if ('some' in head) terms.push(...head.some.terms);
	else terms.push({ ...head, path: head.path.slice(path.length) });
	for (const leg of chained) {
		if (!isDict(leg)) throw new AdapterError('unsupported chained condition shape');
		terms.push(relativeLeg(leg, path));
	}

	const match: ElementMatch = { path, some: { operator: raw.operator === 'or' ? 'or' : 'and', terms } };
	if ('some' in head && head.negated) match.negated = true;
	return normalizeElementMatch(match);
}

function adaptTerm(raw: unknown): Condition | Group | ElementMatch {
	if (!isDict(raw)) throw new AdapterError(`unsupported query term: ${String(raw)}`);
	if (isGroupShape(raw)) {
		const group = adaptGroup(raw);
		// `prop[...]` — Harper marks a scoped match by hanging the raw property name on the group.
		if (typeof raw.name === 'string') return normalizeElementMatch({ path: rawPath(raw.name), some: group });
		return group;
	}
	if (isConditionShape(raw)) return adaptCondition(raw);
	throw new AdapterError(`unrecognized query term with keys [${Object.keys(raw).join(', ')}]`);
}

function adaptGroup(raw: Dict): Group {
	const conditions = raw.conditions as unknown[];
	return { operator: raw.operator === 'or' ? 'or' : 'and', terms: conditions.map(adaptTerm) };
}

/** Harper's sort is a linked list of `{attribute, descending, next}` (ledger row 5). */
function adaptSort(raw: unknown): SortKey[] {
	const keys: SortKey[] = [];
	let node = raw;
	while (node !== undefined && node !== null) {
		if (!isDict(node)) throw new AdapterError(`unsupported sort node: ${String(node)}`);
		keys.push({
			path: node.attribute === '' ? [''] : decodedPath(node.attribute),
			direction: node.descending === true ? 'desc' : 'asc',
		});
		node = node.next;
	}
	return keys;
}

const nestedList = (item: unknown): unknown[] | undefined => {
	if (Array.isArray(item)) return item;
	if (isDict(item) && item.select !== undefined) return Array.isArray(item.select) ? item.select : [item.select];
	return undefined;
};

function adaptField(item: unknown): Field {
	if (typeof item === 'string') return { path: [item] };
	const nested = nestedList(item);
	if (nested === undefined) throw new AdapterError(`unsupported select item: ${String(item)}`);
	const name = (item as Dict).name;
	// §5.7: nested projections are always `records`.
	const projection: Projection = { mode: 'records', fields: nested.map(adaptField) };
	// A nameless nested list is Harper's `[a,b]` tuple item; it has no property path.
	return name === undefined ? { path: [], projection } : { path: rawPath(name), projection };
}

/**
 * Harper's `select` is polymorphic (ledger row 5) and its mode follows the dispatch in
 * `Table.transformEntryForSelect`: a bare string is the single-value form, an array marked
 * `asArray` is a tuple, anything else trims the record to an object.
 */
function adaptSelect(raw: unknown): Projection {
	if (typeof raw === 'string') return { mode: 'values', fields: [{ path: [raw] }] };
	if (Array.isArray(raw)) {
		const named = (raw as unknown as Dict).name;
		if (named !== undefined) return { mode: 'records', fields: [adaptField(raw)] };
		if ((raw as unknown as Dict).asArray === true) return { mode: 'tuples', fields: raw.map(adaptField) };
		return { mode: 'records', fields: raw.map(adaptField) };
	}
	if (isDict(raw) && raw.select !== undefined) return { mode: 'records', fields: [adaptField(raw)] };
	throw new AdapterError(`unsupported select shape: ${String(raw)}`);
}

function adaptNumber(raw: unknown, field: string): number {
	if (typeof raw !== 'number') throw new AdapterError(`${field} is not a number: ${String(raw)}`);
	return raw;
}

function adaptQueryBody(raw: Dict): ParseResult {
	const result: ParseResult = {};
	const conditions = raw.conditions;
	if (Array.isArray(conditions) && conditions.length > 0) result.filter = adaptGroup(raw);
	if (raw.sort !== undefined && raw.sort !== null) result.sort = adaptSort(raw.sort);
	if (raw.select !== undefined) result.select = adaptSelect(raw.select);
	if (raw.limit !== undefined) result.limit = adaptNumber(raw.limit, 'limit');
	if (raw.offset !== undefined) result.offset = adaptNumber(raw.offset, 'offset');
	return result;
}

/**
 * Ledger row 1: a query with no structural characters skips parsing entirely and its
 * conditions surface as raw `URLSearchParams` name/value pairs. Those names are always a
 * single segment — a literal `.` would have forced the parsing path — and both name and
 * value are already form-decoded, so neither is split or decoded again here.
 */
function adaptSearchParams(params: URLSearchParams): ParseResult {
	const terms: (Condition | Group | ElementMatch)[] = [];
	for (const [name, value] of params) terms.push({ path: [name], comparator: 'eq', value });
	return terms.length === 0 ? {} : { filter: { operator: 'and', terms } };
}

export function adaptHarperResult(raw: unknown): HarperOutcome {
	// `parseQuery('')` returns undefined — an unfiltered, unshaped query.
	if (raw === undefined || raw === null) return { status: 'parsed', result: {} };

	if (raw instanceof URLSearchParams) {
		// A RequestTarget is a URLSearchParams that ALSO carries the parsed query when the
		// parsing path ran (the dual shape of ledger row 1).
		const carrier = raw as unknown as Dict;
		if (carrier.conditions === undefined) return finish(adaptSearchParams(raw), carrier);
		return finish(adaptQueryBody(carrier), carrier);
	}
	if (!isDict(raw)) throw new AdapterError(`unsupported parse result: ${String(raw)}`);
	return finish(adaptQueryBody(raw), raw);
}

function finish(result: ParseResult, raw: Dict): HarperOutcome {
	const parseError = raw.parseError;
	if (parseError === undefined || parseError === null) return { status: 'parsed', result };
	const message = parseError instanceof Error ? parseError.message : String(parseError);
	return { status: 'deferred-error', message, partial: result };
}
