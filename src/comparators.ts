export const SYMBOL_OPERATORS: Record<string, string> = {
	// coercing operators
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
	'!=': 'ne',
	'==': 'eq',
	// strict operators
	'===': 'equals',
	'!==': 'not_equal',
};

export const COERCIBLE_OPERATORS: Record<string, true> = {
	lt: true,
	le: true,
	gt: true,
	ge: true,
	ne: true,
	eq: true,
};

export const ALTERNATE_COMPARATOR_NAMES: Record<string, string> = {
	'eq': 'equals',
	'greater_than': 'gt',
	'greaterThan': 'gt',
	'greater_than_equal': 'ge',
	'greaterThanEqual': 'ge',
	'less_than': 'lt',
	'lessThan': 'lt',
	'less_than_equal': 'le',
	'lessThanEqual': 'le',
	'not_equal': 'ne',
	'notEqual': 'ne',
	'equal': 'equals',
	'sw': 'starts_with',
	'startsWith': 'starts_with',
	'ew': 'ends_with',
	'endsWith': 'ends_with',
	'ct': 'contains',
	'includes': 'in',
	'>': 'gt',
	'>=': 'ge',
	'<': 'lt',
	'<=': 'le',
	'...': 'between',
};

/** Comparators whose value is a list — recognizes `(v1,v2,...)` syntax during parsing. */
export const LIST_VALUE_COMPARATORS: Set<string> = new Set(['in', 'between']);

/** Base comparators that accept the `not_` prefix to produce a negated form. */
export const NEGATABLE_BASE_COMPARATORS: Set<string> = new Set([
	'in',
	'between',
	'starts_with',
	'ends_with',
	'contains',
	'equals',
]);

/**
 * Resolve a comparator name to a (possibly stripped) base comparator and a `negated` flag.
 * Existing aliases are preserved as-is. Only the `not_` prefix is stripped, and only when the
 * base is a recognized negatable comparator and the full name is not itself an existing alias
 * (so `not_equal` keeps its historical mapping to `ne`).
 */
export function resolveComparator(comparator: string | undefined): {
	comparator: string | undefined;
	negated: boolean;
} {
	if (comparator == null) return { comparator, negated: false };
	if (ALTERNATE_COMPARATOR_NAMES[comparator]) return { comparator, negated: false };
	if (comparator.startsWith('not_')) {
		const base = comparator.slice(4);
		const baseResolved = ALTERNATE_COMPARATOR_NAMES[base] || base;
		if (NEGATABLE_BASE_COMPARATORS.has(baseResolved)) {
			return { comparator: base, negated: true };
		}
	}
	return { comparator, negated: false };
}
