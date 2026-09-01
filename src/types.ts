// §6 canonical parsed representation — language-neutral; JSON-serializable.

export type Value = string | number | boolean | null | Date | Value[];

export interface Condition {
	path: string[];
	comparator: string;
	negated?: boolean;
	value: Value;
}

export interface Group {
	operator: 'and' | 'or';
	terms: (Condition | Group | ElementMatch)[];
}

/**
 * Asserts that at least one element reached via `path` satisfies `some`.
 * Conditions inside `some` use element-relative paths; `path: []` means the element itself.
 * Produced by chaining (`&=` / `|=`) and by `between` / `not_between`.
 */
export interface ElementMatch {
	path: string[];
	some: Group;
	negated?: boolean;
}

export interface SortKey {
	path: string[];
	direction: 'asc' | 'desc';
}

export interface Field {
	path: string[];
	projection?: Projection;
}

export interface Projection {
	mode: 'records' | 'values' | 'tuples';
	fields: Field[];
}

export interface ParseResult {
	filter?: Group;
	sort?: SortKey[];
	select?: Projection;
	limit?: number;
	offset?: number;
	/** Only present when parseQuery is called with {deferErrors: true}. */
	parseError?: import('./errors.ts').QueryError;
}

export interface ParseOptions {
	deferErrors?: boolean;
}
