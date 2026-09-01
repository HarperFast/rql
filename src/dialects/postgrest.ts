import { QueryError, SyntaxViolation } from '../errors.ts';
import { interpretValue, negateGroup, negateTerm } from '../parser.ts';
import type {
	Condition, ElementMatch, Field, Group, ParseOptions, ParseResult, Projection, SortKey, Value,
} from '../types.ts';

type Term = Condition | Group | ElementMatch;

export interface PostgrestOptions extends ParseOptions {
	onUnsupported?: 'throw' | 'drop';
}

export class UnsupportedFeature extends QueryError {}

const MAX_LOGIC_DEPTH = 32;
const MAX_TERMS = 1_000;
const MAX_LIST_VALUES = 1_000;

const OPERATOR_NAMES = new Set([
	'eq', 'gt', 'gte', 'lt', 'lte', 'neq', 'in', 'cs', 'cd', 'ov', 'is',
	'like', 'ilike', 'match', 'imatch', 'fts', 'plfts', 'phfts', 'wfts',
	'sl', 'sr', 'nxl', 'nxr', 'adj', 'isdistinct',
]);

const CONFIGURABLE_OPERATORS = new Set(['fts', 'plfts', 'phfts', 'wfts']);

type ParseBudget = { terms: number };

type ParsedOperator = {
	operator: string;
	argument?: string;
	negated: boolean;
	operand: string;
};

function syntaxViolation(message: string): never {
	throw new SyntaxViolation(`Unable to parse PostgREST query: ${message}`);
}

function useTerms(budget: ParseBudget, count: number): void {
	budget.terms += count;
	if (budget.terms > MAX_TERMS) syntaxViolation(`query exceeds the ${MAX_TERMS}-term limit`);
}

function matchingClose(open: string, close: string): boolean {
	if (open === '{') return close === '}';
	if (open === '[') return close === ']' || close === ')';
	return close === ')' || close === ']';
}

function splitTopLevel(input: string): string[] {
	const parts: string[] = [];
	const stack: string[] = [];
	let quoted = false;
	let escaped = false;
	let start = 0;

	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
		} else if (character === '(' || character === '[' || character === '{') {
			stack.push(character);
		} else if (character === ')' || character === ']' || character === '}') {
			const open = stack.pop();
			if (!open || !matchingClose(open, character)) syntaxViolation('unbalanced operand delimiter');
		} else if (character === ',' && stack.length === 0) {
			parts.push(input.slice(start, index));
			start = index + 1;
		}
	}

	if (quoted) syntaxViolation('unterminated quoted operand');
	if (stack.length > 0) syntaxViolation('unbalanced operand delimiter');
	parts.push(input.slice(start));
	return parts;
}

function decodeQuoted(raw: string): string {
	if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"')
		syntaxViolation('malformed quoted operand');
	let value = '';
	for (let index = 1; index < raw.length - 1; index++) {
		const character = raw[index];
		if (character === '\\') {
			index++;
			if (index >= raw.length - 1) syntaxViolation('malformed quoted operand escape');
			value += raw[index];
		} else {
			value += character;
		}
	}
	return value;
}

function interpretDecodedValue(token: string): Value {
	const colon = token.indexOf(':');
	if (colon > 0) {
		const type = token.slice(0, colon);
		let encodedRest = encodeURIComponent(token.slice(colon + 1));
		if (type === 'number' && encodedRest.startsWith('%24')) encodedRest = `$${encodedRest.slice(3)}`;
		return interpretValue(`${type}:${encodedRest}`);
	}
	return interpretValue(encodeURIComponent(token));
}

function parseOperand(raw: string): Value {
	if (raw.startsWith('"') || raw.endsWith('"')) return decodeQuoted(raw);
	return interpretDecodedValue(raw);
}

function parseList(raw: string, open: '(' | '{'): Value[] {
	const close = open === '(' ? ')' : '}';
	if (raw[0] !== open || raw[raw.length - 1] !== close)
		syntaxViolation(`operator requires a ${open}${close} value list`);
	const inner = raw.slice(1, -1);
	if (inner === '') return [];
	const parts = splitTopLevel(inner);
	if (parts.length > MAX_LIST_VALUES)
		syntaxViolation(`value list exceeds the ${MAX_LIST_VALUES}-value limit`);
	return parts.map(parseOperand);
}

function parseModifierValues(raw: string): Value[] {
	if (raw.startsWith('{')) return parseList(raw, '{');
	if (raw.startsWith('(')) return parseList(raw, '(');
	syntaxViolation('any/all modifier requires a value list');
}

function splitColumnPath(raw: string): string[] {
	if (!raw) syntaxViolation('column path is empty');
	const segments = raw.split(/->>|->|\./).map((segment) => {
		if (!segment) syntaxViolation('column path contains an empty segment');
		return segment.startsWith('"') || segment.endsWith('"') ? decodeQuoted(segment) : segment;
	});
	return segments;
}

function condition(
	path: string[], comparator: string, value: Value, negated: boolean, budget: ParseBudget,
): Condition {
	useTerms(budget, 1);
	const result: Condition = { path, comparator, value };
	if (negated) result.negated = true;
	return result;
}

function parseOperator(expression: string): ParsedOperator {
	const match = /^(not\.)?([a-z][a-z0-9_]*)(?:\(([^()]*)\))?\.([\s\S]*)$/.exec(expression);
	if (!match) syntaxViolation('filter must have the form [not.]operator.operand');
	const [, notPrefix, operator, argument, operand] = match;
	if (!OPERATOR_NAMES.has(operator)) syntaxViolation(`unknown PostgREST operator '${operator}'`);
	if (argument !== undefined && argument !== 'any' && argument !== 'all' && !CONFIGURABLE_OPERATORS.has(operator))
		syntaxViolation(`operator '${operator}' does not accept configuration arguments`);
	return { operator, argument, negated: notPrefix !== undefined, operand };
}

function parseFilterValue(path: string[], expression: string, budget: ParseBudget): Term {
	const parsed = parseOperator(expression);
	let comparator: string;
	let intrinsicallyNegated = false;

	switch (parsed.operator) {
		case 'eq': comparator = 'eq'; break;
		case 'gt': comparator = 'gt'; break;
		case 'gte': comparator = 'ge'; break;
		case 'lt': comparator = 'lt'; break;
		case 'lte': comparator = 'le'; break;
		case 'neq': comparator = 'eq'; intrinsicallyNegated = true; break;
		case 'in': comparator = 'in'; break;
		case 'ov': comparator = 'in'; break;
		case 'is': comparator = 'eq'; break;
		default: comparator = parsed.argument && parsed.argument !== 'any' && parsed.argument !== 'all'
			? `${parsed.operator}(${parsed.argument})`
			: parsed.operator;
	}

	let term: Term;
	if (parsed.operator === 'is') {
		if (parsed.operand !== 'null' && parsed.operand !== 'true' && parsed.operand !== 'false')
			throw new UnsupportedFeature(`PostgREST feature 'is.${parsed.operand}' is unsupported`);
		term = condition(path, comparator, interpretDecodedValue(parsed.operand), false, budget);
	} else if (parsed.operator === 'in') {
		term = condition(path, comparator, parseList(parsed.operand, '('), false, budget);
	} else if (parsed.operator === 'ov') {
		term = condition(path, comparator, parseList(parsed.operand, '{'), false, budget);
	} else if (parsed.operator === 'cs') {
		const values = parseList(parsed.operand, '{');
		term = {
			operator: 'and',
			terms: values.map((value) => condition(path, 'eq', value, false, budget)),
		};
	} else if (parsed.operator === 'cd') {
		const values = parseList(parsed.operand, '{');
		const inner = condition([], 'in', values, true, budget);
		term = negateTerm({ path, some: { operator: 'and', terms: [inner] } });
	} else if (parsed.argument === 'any' || parsed.argument === 'all') {
		const values = parseModifierValues(parsed.operand);
		if (parsed.operator === 'eq' && parsed.argument === 'any') {
			term = condition(path, 'in', values, false, budget);
		} else {
			term = {
				operator: parsed.argument === 'any' ? 'or' : 'and',
				terms: values.map((value) => condition(path, comparator, value, intrinsicallyNegated, budget)),
			};
			intrinsicallyNegated = false;
		}
	} else {
		term = condition(path, comparator, parseOperand(parsed.operand), intrinsicallyNegated, budget);
		intrinsicallyNegated = false;
	}

	if (intrinsicallyNegated) term = negateTerm(term);
	if (parsed.negated) term = negateTerm(term);
	return term;
}

function unwrapLogicBody(raw: string): string {
	if (raw.length < 2 || raw[0] !== '(' || raw[raw.length - 1] !== ')')
		syntaxViolation('logic parameter requires a parenthesized body');
	return raw.slice(1, -1);
}

function parseLogicLeaf(raw: string, budget: ParseBudget): Term {
	for (let index = 1; index < raw.length; index++) {
		if (raw[index] !== '.') continue;
		const expression = raw.slice(index + 1);
		const operatorMatch = /^(?:not\.)?([a-z][a-z0-9_]*)(?:\([^()]*\))?\./.exec(expression);
		if (operatorMatch && OPERATOR_NAMES.has(operatorMatch[1]))
			return parseFilterValue(splitColumnPath(raw.slice(0, index)), expression, budget);
	}
	syntaxViolation('logic leaf must have the form column.[not.]operator.operand');
}

function parseLogicTerm(raw: string, depth: number, budget: ParseBudget): Term {
	const value = raw.trim();
	const call = /^(not\.)?(and|or)\(/.exec(value);
	if (!call) return parseLogicLeaf(value, budget);
	if (!value.endsWith(')')) syntaxViolation('unbalanced logic group');
	const group = parseLogicGroup(
		value.slice(call[0].length, -1), call[2] as 'and' | 'or', depth + 1, budget,
	);
	return call[1] ? negateGroup(group) : group;
}

function parseLogicGroup(
	body: string, operator: 'and' | 'or', depth: number, budget: ParseBudget,
): Group {
	if (depth > MAX_LOGIC_DEPTH) syntaxViolation(`logic exceeds the depth limit of ${MAX_LOGIC_DEPTH}`);
	if (!body) syntaxViolation('logic group cannot be empty');
	const parts = splitTopLevel(body);
	if (parts.some((part) => part.trim() === '')) syntaxViolation('logic group contains an empty term');
	return { operator, terms: parts.map((part) => parseLogicTerm(part, depth, budget)) };
}

function unsupported(feature: string, options: PostgrestOptions | undefined): boolean {
	if (options?.onUnsupported === 'drop') return true;
	throw new UnsupportedFeature(`PostgREST feature '${feature}' is unsupported`);
}

function parseSelect(raw: string, options: PostgrestOptions | undefined): Projection | undefined {
	const fields: Field[] = [];
	for (const rawField of splitTopLevel(raw)) {
		const field = rawField.trim();
		if (!field) syntaxViolation('select contains an empty field');
		let feature: string | undefined;
		if (field.includes('::')) feature = `projection cast '${field}'`;
		else if (field.includes(':')) feature = `projection alias '${field}'`;
		else if (field.includes('(') || field.includes(')') || field.includes('!'))
			feature = `resource embedding '${field}'`;
		if (feature) {
			if (unsupported(feature, options)) continue;
		}
		fields.push({ path: splitColumnPath(field) });
	}
	if (fields.length === 0) return undefined;
	return { mode: 'records', fields };
}

function parseOrder(raw: string, options: PostgrestOptions | undefined): SortKey[] | undefined {
	const keys: SortKey[] = [];
	for (const rawKey of splitTopLevel(raw)) {
		let key = rawKey.trim();
		if (!key) syntaxViolation('order contains an empty key');
		if (/(?:^|\.)(?:nullsfirst|nullslast)$/.test(key)) {
			if (unsupported(`null ordering '${key}'`, options)) continue;
		}
		let direction: 'asc' | 'desc' = 'asc';
		if (key.endsWith('.asc')) key = key.slice(0, -4);
		else if (key.endsWith('.desc')) { key = key.slice(0, -5); direction = 'desc'; }
		keys.push({ path: splitColumnPath(key), direction });
	}
	return keys.length > 0 ? keys : undefined;
}

function parseNonNegativeInteger(raw: string, name: string): number {
	if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) syntaxViolation(`${name} must be a non-negative integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) syntaxViolation(`${name} exceeds the safe integer range`);
	return value;
}

function filterFromTerms(terms: Term[]): Group | undefined {
	if (terms.length === 0) return undefined;
	if (terms.length === 1 && 'terms' in terms[0]) return terms[0];
	return { operator: 'and', terms };
}

function parseInto(
	result: ParseResult, parameters: URLSearchParams, options: PostgrestOptions | undefined,
): void {
	const terms: Term[] = [];
	const budget: ParseBudget = { terms: 0 };
	const seenReserved = new Set<string>();

	for (const [key, value] of parameters.entries()) {
		if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') {
			if (seenReserved.has(key)) syntaxViolation(`duplicate '${key}' parameter`);
			seenReserved.add(key);
			if (key === 'select') result.select = parseSelect(value, options);
			else if (key === 'order') result.sort = parseOrder(value, options);
			else result[key] = parseNonNegativeInteger(value, key);
		} else if (key === 'or' || key === 'and' || key === 'not.or' || key === 'not.and') {
			const operator = key.endsWith('or') ? 'or' : 'and';
			const group = parseLogicGroup(unwrapLogicBody(value), operator, 1, budget);
			terms.push(key.startsWith('not.') ? negateGroup(group) : group);
		} else {
			terms.push(parseFilterValue(splitColumnPath(key), value, budget));
		}
	}

	const filter = filterFromTerms(terms);
	if (filter) result.filter = filter;
}

/**
 * Parse the Appendix E PostgREST surface into the RQL §6 canonical model.
 * `neq` intentionally uses RQL complement semantics, so absent properties differ from SQL `<>`.
 */
export function parsePostgrest(
	search: string | URLSearchParams, options?: PostgrestOptions,
): ParseResult {
	const result: ParseResult = {};
	try {
		const parameters = typeof search === 'string'
			? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
			: search;
		parseInto(result, parameters, options);
	} catch (error) {
		if (!(error instanceof QueryError)) throw error;
		if (!options?.deferErrors) throw error;
		result.parseError = error;
	}
	return result;
}
