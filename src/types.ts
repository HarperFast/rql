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
	terms: (Condition | Group)[];
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
