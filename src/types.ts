export type Operator = 'and' | 'or';

export type Comparator =
	| 'between'
	| 'contains'
	| 'ends_with'
	| 'eq'
	| 'equals'
	| 'gt'
	| 'ge'
	| 'lt'
	| 'le'
	| 'greater_than'
	| 'greater_than_equal'
	| 'in'
	| 'less_than'
	| 'less_than_equal'
	| 'ne'
	| 'not_equal'
	| 'starts_with';

/**
 * A direct (leaf) condition. Consumers read `c[0] ?? c.attribute` and `c[1] ?? c.value`
 * to handle both parsed objects and URLSearchParams [name, value] tuples from the fast path.
 */
export interface DirectCondition<V = unknown> {
	attribute?: string | string[] | null;
	comparator?: string;
	value?: V;
	negated?: boolean;
	chainedConditions?: Condition<V>[];
	/** Internal: comparator applied to chained conditions. */
	operator?: Operator;
}

export interface ConditionGroup<V = unknown> {
	conditions?: Condition<V>[];
	operator?: Operator;
}

export type Condition<V = unknown> = DirectCondition<V> & ConditionGroup<V>;

/** Linked-list sort descriptor. */
export interface Sort {
	attribute: string | string[];
	descending?: boolean;
	next?: Sort;
}

export interface SubSelect {
	name: string;
	select: (string | SubSelect)[];
}

/**
 * Four polymorphic shapes:
 *  1. `string[]` — flat attribute list
 *  2. `(string | SubSelect)[]` — nested via `rel{a,b}` brace syntax
 *  3. Array with `.asArray = true` — from `select([a,b])` syntax
 *  4. A Query object — from `rel[select(a,b)]` bracket syntax (has `.name`, `.select`)
 */
export type Select = any[];
