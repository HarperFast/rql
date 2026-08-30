import type { Condition, Operator, Sort, Select } from './types.ts';

export class Query extends URLSearchParams {
	declare conditions: Condition[] | undefined;
	declare operator: Operator | undefined;
	// @ts-ignore — shadows URLSearchParams.prototype.sort; own-property set in constructor
	declare sort: Sort | undefined;
	declare select: Select | undefined;
	declare limit: number | undefined;
	declare offset: number | undefined;
	declare parseError: Error | undefined;
	/** Set when this Query is used as a sub-select container (`rel[...]` syntax). */
	declare name: string | undefined;

	constructor(init?: string | URLSearchParams | Record<string, string> | string[][]) {
		super(init as any);
		// Create own property so assignment of a Sort object shadows the inherited
		// URLSearchParams.prototype.sort method.
		Object.defineProperty(this, 'sort', {
			value: undefined,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
}
