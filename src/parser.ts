import { Query } from './query.ts';
import { QueryError, SyntaxViolation } from './errors.ts';
import {
	SYMBOL_OPERATORS,
	COERCIBLE_OPERATORS,
	ALTERNATE_COMPARATOR_NAMES,
	LIST_VALUE_COMPARATORS,
	resolveComparator,
} from './comparators.ts';

const NEEDS_PARSER = /[()[\]|!<>.]|(=\w*=)/;
const FIQL_OPERATOR_NAME = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

/**
 * Parse a query string into a Query object.
 *
 * @param search - The raw query string (no leading `?`).
 * @param target - Optional existing Query to mutate. When provided, semantic errors accumulate
 *   into `target.parseError` instead of throwing. When omitted a fresh Query is returned and
 *   errors throw.
 */
export function parseQuery(search: string, target?: Query): Query {
	if (!search) return target ?? new Query();

	if (!NEEDS_PARSER.test(search)) {
		// Fast path: no special operators — return URLSearchParams-backed Query.
		if (target) return target;
		return new Query(search);
	}

	// Parsed path: fresh regex instances per call for reentrancy.
	const queryParser = /([^?&|=<>!([{}\]),]*)([([{}\])|,&]|[=<>!]*)/g;
	const valueParser = /([^&|=[\]{}]+)([[\]{}]|[&|=]*)/g;

	let lastIndex = 0;
	let parseErrorMessage: string | undefined;

	function recordError(msg: string): void {
		const em = `${msg} at position ${lastIndex}`;
		parseErrorMessage = parseErrorMessage ? parseErrorMessage + ', ' + em : em;
	}

	function decodeProperty(name: string): string | string[] {
		if (name.indexOf('.') > -1) return name.split('.').map((p) => decodeURIComponent(p));
		return decodeURIComponent(name);
	}

	function typedDecoding(value: string): unknown {
		if (value === 'null') return null;
		if (value.indexOf(':') > -1) {
			const colonIdx = value.indexOf(':');
			const type = value.slice(0, colonIdx);
			const rest = value.slice(colonIdx + 1);
			if (type === 'number') {
				if (rest[0] === '$') return parseInt(rest.slice(1), 36);
				return +rest;
			}
			if (type === 'boolean') return rest === 'true';
			if (type === 'date') return new Date(isNaN(+rest) ? decodeURIComponent(rest) : +rest);
			if (type === 'string') return decodeURIComponent(rest);
			throw new QueryError(`Unknown type ${type}`);
		}
		return decodeURIComponent(value);
	}

	function wildcardDecoding(condition: any, rawValue: string): void {
		if (rawValue.indexOf('*') > -1) {
			if (rawValue.endsWith('*')) {
				condition.comparator = 'starts_with';
				condition.value = decodeURIComponent(rawValue.slice(0, -1));
			} else {
				throw new QueryError('wildcard can only be used at the end of a string');
			}
		}
	}

	function buildCondition(
		attribute: any,
		rawComparator: string | undefined,
		rawValue: string,
		valueDecoder: (s: string) => unknown
	): any {
		const { comparator: resolvedComparator, negated } = resolveComparator(rawComparator);
		let value: unknown;
		if (
			LIST_VALUE_COMPARATORS.has(resolvedComparator as string) &&
			rawValue.length >= 2 &&
			rawValue.charCodeAt(0) === 0x28 /* ( */ &&
			rawValue.charCodeAt(rawValue.length - 1) === 0x29 /* ) */
		) {
			const inner = rawValue.slice(1, -1);
			value = inner.length === 0 ? [] : inner.split(',').map(valueDecoder);
		} else {
			value = valueDecoder(rawValue);
		}
		const condition: any = { comparator: resolvedComparator, attribute: attribute || null, value };
		if (negated) condition.negated = true;
		if (rawComparator === 'eq') wildcardDecoding(condition, rawValue);
		return condition;
	}

	function toSortEntry(sort: any): any {
		if (Array.isArray(sort)) {
			const sortObject = toSortEntry(sort[0]);
			sort[0] = sortObject.attribute;
			sortObject.attribute = sort;
			return sortObject;
		}
		if (typeof sort === 'string') {
			switch (sort[0]) {
				case '-': return { attribute: sort.slice(1), descending: true };
				case '+': return { attribute: sort.slice(1), descending: false };
				default: return { attribute: sort, descending: false };
			}
		}
		recordError(`Unknown sort type ${sort}`);
	}

	function toSortObject(sort: any[]): any {
		const sortObject = toSortEntry(sort[0]);
		if (sort.length > 1) sortObject.next = toSortObject(sort.slice(1));
		return sortObject;
	}

	function assignOperator(query: any, lastBinaryOperator: string | undefined): void {
		if (query.conditions.length > 0) {
			if (query.operator) {
				if (query.operator !== lastBinaryOperator)
					recordError('Can not mix operators within a condition grouping');
			} else {
				query.operator = lastBinaryOperator;
			}
		}
	}

	function parseBlock(query: any, expectedEnd: string): any {
		// Ensure Query instances have conditions ready for the parsed path.
		// Inner groups are created with new Query() whose conditions start undefined.
		if (query instanceof Query && query.conditions === undefined) query.conditions = [];

		let parser = queryParser;
		let match: RegExpExecArray | null;
		let attribute: any;
		let comparator: string | undefined;
		let expectingDelimiter: boolean | undefined;
		let expectingValue: boolean | undefined;
		let valueDecoder: (s: string) => unknown = decodeURIComponent;
		let lastBinaryOperator: string | undefined;

		while ((match = parser.exec(search))) {
			lastIndex = parser.lastIndex;
			const [, value, operator] = match;

			if (expectingDelimiter) {
				if (value) recordError(`expected operator, but encountered '${value}'`);
				expectingDelimiter = false;
				expectingValue = false;
			} else {
				expectingValue = true;
			}

			let entry: any;
			switch (operator) {
				case '=':
					if (attribute != undefined) {
						if (FIQL_OPERATOR_NAME.test(value)) comparator = value;
						else recordError(`invalid FIQL operator ${value}`);
						valueDecoder = typedDecoding;
					} else {
						valueDecoder = decodeURIComponent;
						comparator = 'equals';
						if (!value) recordError(`attribute must be specified before equality comparator`);
						attribute = decodeProperty(value);
					}
					break;
				case '==':
				case '!=':
				case '<':
				case '<=':
				case '>':
				case '>=':
				case '===':
				case '!==':
					comparator = SYMBOL_OPERATORS[operator];
					valueDecoder = COERCIBLE_OPERATORS[comparator] ? typedDecoding : decodeURIComponent;
					if (!value) recordError(`attribute must be specified before comparator ${operator}`);
					attribute = decodeProperty(value);
					break;
				case '&=':
				case '|=':
				case '|':
				case '&':
				case '':
				case undefined:
					if (attribute == null) {
						if (attribute === undefined) {
							if (expectedEnd)
								recordError(
									`expected '${expectedEnd}', but encountered ${operator?.[0] ? "'" + operator[0] + "'" : 'end of string'}`
								);
							recordError(`no comparison specified before ${operator ? "'" + operator + "'" : 'end of string'}`);
						}
					} else {
						if (!query.conditions) recordError('conditions/comparisons are not allowed in a property list');
						const condition = buildCondition(attribute, comparator, value, valueDecoder);
						if (attribute === '') {
							const lastCondition = query.conditions[query.conditions.length - 1];
							lastCondition.chainedConditions = lastCondition.chainedConditions || [];
							lastCondition.chainedConditions.push(condition);
							lastCondition.operator = lastBinaryOperator;
						} else {
							assignOperator(query, lastBinaryOperator);
							query.conditions.push(condition);
						}
					}
					if (operator === '&') {
						lastBinaryOperator = 'and';
						attribute = undefined;
					} else if (operator === '|') {
						lastBinaryOperator = 'or';
						attribute = undefined;
					} else if (operator === '&=') {
						lastBinaryOperator = 'and';
						attribute = '';
					} else if (operator === '|=') {
						lastBinaryOperator = 'or';
						attribute = '';
					}
					break;
				case ',':
					if (query.conditions) {
						recordError('conditions/comparisons are not allowed in a property list');
					} else {
						query.push(decodeProperty(value));
					}
					attribute = undefined;
					break;
				case '(': {
					queryParser.lastIndex = lastIndex;
					const args: any = parseBlock(value ? [] : new Query(), ')');
					switch (value) {
						case '':
							assignOperator(query, lastBinaryOperator);
							query.conditions.push(args);
							break;
						case 'limit':
							switch (args.length) {
								case 1:
									query.limit = +args[0];
									break;
								case 2:
									query.offset = +args[0];
									query.limit = args[1] - query.offset;
									break;
								default:
									recordError('limit must have 1 or 2 arguments');
							}
							break;
						case 'select':
							if (Array.isArray(args[0]) && args.length === 1 && !args[0].name) {
								query.select = args[0];
								query.select.asArray = true;
							} else if (args.length === 1) {
								query.select = args[0];
							} else if (args.length === 2 && args[1] === '') {
								query.select = args.slice(0, 1);
							} else {
								query.select = args;
							}
							break;
						case 'group-by':
							recordError('group by is not implemented yet');
							break; // fix: original falls through into sort
						case 'sort':
							query.sort = toSortObject(args);
							break;
						default:
							recordError(`unknown query function call ${value}`);
					}
					if (search[lastIndex] === ',') {
						parser.lastIndex = ++lastIndex;
					} else {
						expectingDelimiter = true;
					}
					attribute = null;
					break;
				}
				case '{':
					if (query.conditions) recordError('property sets are not allowed in a queries');
					if (!value) recordError('property sets must have a defined parent property name');
					queryParser.lastIndex = lastIndex;
					entry = parseBlock([], '}');
					entry.name = value;
					query.push(entry);
					if (search[lastIndex] === ',') {
						parser.lastIndex = ++lastIndex;
					} else {
						expectingDelimiter = true;
					}
					break;
				case '[':
					queryParser.lastIndex = lastIndex;
					if (value) {
						entry = parseBlock(new Query(), ']');
						entry.name = value;
					} else {
						entry = parseBlock(query.conditions ? new Query() : [], ']');
					}
					if (query.conditions) {
						assignOperator(query, lastBinaryOperator);
						if (search[lastIndex] === '=') {
							valueDecoder = decodeURIComponent;
							comparator = 'equals';
							attribute = decodeProperty(value);
							parser.lastIndex = ++lastIndex;
							break;
						} else {
							query.conditions.push(entry);
							attribute = null;
						}
					} else {
						query.push(entry);
					}
					if (search[lastIndex] === ',') {
						parser.lastIndex = ++lastIndex;
					} else {
						expectingDelimiter = true;
					}
					break;
				case ')':
				case ']':
				case '}':
					if (expectedEnd === operator[0]) {
						if (query.conditions) {
							if (attribute) {
								const condition = buildCondition(attribute, comparator || 'equals', value, valueDecoder);
								assignOperator(query, lastBinaryOperator);
								query.conditions.push(condition);
							} else if (value) {
								recordError('no attribute or comparison specified');
							}
						} else if (value || (query.length > 0 && expectingValue)) {
							query.push(decodeProperty(value));
						}
						return query;
					} else if (expectedEnd) {
						recordError(`expected '${expectedEnd}', but encountered '${operator[0]}'`);
					} else {
						recordError(`unexpected token '${operator[0]}'`);
					}
					break;
				default:
					recordError(`unexpected operator '${operator}'`);
			}

			if (expectedEnd !== ')') {
				parser = attribute ? valueParser : queryParser;
				parser.lastIndex = lastIndex;
			}
			if (lastIndex === search.length) return query;
		}
		if (expectedEnd) recordError(`expected '${expectedEnd}', but encountered end of string`);
		return query;
	}

	const result = target ?? new Query();
	result.conditions = [];
	queryParser.lastIndex = 0;

	try {
		parseBlock(result, '');
		if (lastIndex !== search.length)
			recordError(`Unable to parse query, unexpected end of query`);
		if (parseErrorMessage) {
			const err = new SyntaxViolation(parseErrorMessage);
			if (target) {
				target.parseError = err;
			} else {
				throw err;
			}
		}
		return result;
	} catch (error: any) {
		error.statusCode = 400;
		if (!(error instanceof SyntaxViolation)) {
			error.message = `Unable to parse query, ${error.message} at position ${lastIndex} in '${search}'`;
			if (parseErrorMessage) error.message += ', ' + parseErrorMessage;
		}
		if (target) {
			target.parseError = error;
			return target;
		}
		throw error;
	}
}
