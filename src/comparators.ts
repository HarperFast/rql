// Canonical comparator set (§5.1.1). All other names are open-vocabulary FIQL.
export const CORE_COMPARATORS: ReadonlySet<string> = new Set([
	'eq', 'lt', 'le', 'gt', 'ge', 'contains', 'starts_with', 'ends_with', 'in',
]);

// Comparators whose value token is a list (v1,v2,...).
export const LIST_COMPARATORS: ReadonlySet<string> = new Set(['in', 'not_in']);

// Maps symbol operators to {comparator, verbatim} (§5.1.2 desugaring table).
export const SYMBOL_OPS: Record<string, { comparator: string; negated: boolean; verbatim: boolean }> = {
	'=':   { comparator: 'eq', negated: false, verbatim: true  },
	'===': { comparator: 'eq', negated: false, verbatim: true  },
	'==':  { comparator: 'eq', negated: false, verbatim: false },
	'!=':  { comparator: 'eq', negated: true,  verbatim: false },
	'!==': { comparator: 'eq', negated: true,  verbatim: true  },
	'<':   { comparator: 'lt', negated: false, verbatim: false },
	'<=':  { comparator: 'le', negated: false, verbatim: false },
	'>':   { comparator: 'gt', negated: false, verbatim: false },
	'>=':  { comparator: 'ge', negated: false, verbatim: false },
};

// Appendix B compatibility aliases. Maps alias → {comparator, negated, verbatim}.
// verbatim=null means "inherit from context" (FIQL → false).
const ALIASES: Record<string, { comparator: string; negated: boolean; verbatim: boolean }> = {
	'ne':              { comparator: 'eq',        negated: true,  verbatim: false },
	'equals':          { comparator: 'eq',        negated: false, verbatim: true  },
	'equal':           { comparator: 'eq',        negated: false, verbatim: true  },
	'not_equal':       { comparator: 'eq',        negated: true,  verbatim: true  },
	'sw':              { comparator: 'starts_with', negated: false, verbatim: false },
	'ew':              { comparator: 'ends_with',   negated: false, verbatim: false },
	'ct':              { comparator: 'contains',    negated: false, verbatim: false },
	'includes':        { comparator: 'contains',    negated: false, verbatim: false },
	'out':             { comparator: 'in',          negated: true,  verbatim: false },
	'less_than':       { comparator: 'lt',          negated: false, verbatim: false },
	'lessThan':        { comparator: 'lt',          negated: false, verbatim: false },
	'less_than_equal': { comparator: 'le',          negated: false, verbatim: false },
	'lessThanEqual':   { comparator: 'le',          negated: false, verbatim: false },
	'greater_than':    { comparator: 'gt',          negated: false, verbatim: false },
	'greaterThan':     { comparator: 'gt',          negated: false, verbatim: false },
	'greater_than_equal': { comparator: 'ge',       negated: false, verbatim: false },
	'greaterThanEqual':   { comparator: 'ge',       negated: false, verbatim: false },
};

export type ResolvedComparator = {
	comparator: string;
	negated: boolean;
	verbatim: boolean;
	/** 'between' or 'not_between' — caller must desugar to ge+le group. */
	isBetween?: boolean;
	betweenNegated?: boolean;
};

/**
 * Resolve a FIQL comparator name (from `=name=` surface form, always interpreted by default)
 * to its canonical form. Aliases desugar per Appendix B.
 */
export function resolveFiqlName(name: string): ResolvedComparator {
	if (name === 'between')     return { comparator: 'between', negated: false, verbatim: false, isBetween: true, betweenNegated: false };
	if (name === 'not_between') return { comparator: 'between', negated: false, verbatim: false, isBetween: true, betweenNegated: true };

	const alias = ALIASES[name];
	if (alias) return { ...alias };

	// Generic not_ stripping — only when base is recognized or open-vocabulary.
	if (name.startsWith('not_')) {
		const base = name.slice(4);
		const baseAlias = ALIASES[base];
		if (baseAlias) {
			return { comparator: baseAlias.comparator, negated: !baseAlias.negated, verbatim: baseAlias.verbatim };
		}
		// Open-vocabulary: not_<unknown> → <unknown>, negated:true.
		return { comparator: base, negated: true, verbatim: false };
	}

	// Open-vocabulary / core pass-through.
	return { comparator: name, negated: false, verbatim: false };
}
