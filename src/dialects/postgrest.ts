import { QueryError, SyntaxViolation } from '../errors.ts';
import { negateGroup, negateTerm } from '../parser.ts';
import type {
	Condition, ElementMatch, Field, Group, ParseOptions, ParseResult, Projection, SortKey, Value,
} from '../types.ts';

type Term = Condition | Group | ElementMatch;

interface URLSearchParams {
	entries(): IterableIterator<[string, string]>;
}

type URLSearchParamsConstructor = new (input?: string) => URLSearchParams;

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

const FILTER_PATTERN = /^(not\.)?([a-z][a-z0-9_]*)(?:\(([^()]*)\))?\.([\s\S]*)$/;
const LOGIC_OPERATOR_PATTERN = /^(?:not\.)?([a-z][a-z0-9_]*)(?:\([^()]*\))?\./;
const LOGIC_CALL_PATTERN = /^(not\.)?(and|or)\(/;
const NULL_ORDER_PATTERN = /(?:^|\.)(?:nullsfirst|nullslast)$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

const URL_SEARCH_PARAMS = (globalThis as unknown as {
	URLSearchParams: URLSearchParamsConstructor;
}).URLSearchParams;

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

function splitTopLevel(input: string, maxParts = MAX_TERMS): string[] {
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
			if (parts.length >= maxParts) syntaxViolation(`list exceeds the ${maxParts}-item limit`);
			parts.push(input.slice(start, index));
			start = index + 1;
		}
	}

	if (quoted) syntaxViolation('unterminated quoted operand');
	if (stack.length > 0) syntaxViolation('unbalanced operand delimiter');
	if (parts.length >= maxParts) syntaxViolation(`list exceeds the ${maxParts}-item limit`);
	parts.push(input.slice(start));
	return parts;
}

function includesUnquoted(input: string, token: string): boolean {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') quoted = false;
		} else if (character === '"') {
			quoted = true;
		} else if (input.startsWith(token, index)) {
			return true;
		}
	}
	return false;
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
		} else if (character === '"') {
			syntaxViolation('unescaped quote inside quoted operand');
		} else {
			value += character;
		}
	}
	return value;
}

function interpretDecodedValue(token: string): Value {
	if (token === 'null') return null;
	if (token === 'true') return true;
	if (token === 'false') return false;
	const number = +token;
	if (token !== '' && !isNaN(number) && String(number) === token) return number;
	return token;
}

function parseOperand(raw: string): Value {
	if (raw.startsWith('"')) return decodeQuoted(raw);
	return interpretDecodedValue(raw);
}

function parseList(raw: string, open: '(' | '{'): Value[] {
	const close = open === '(' ? ')' : '}';
	if (raw[0] !== open || raw[raw.length - 1] !== close)
		syntaxViolation(`operator requires a ${open}${close} value list`);
	const inner = raw.slice(1, -1);
	if (inner === '') return [];
	const parts = splitTopLevel(inner, MAX_LIST_VALUES);
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
	const segments: string[] = [];
	let quoted = false;
	let escaped = false;
	let start = 0;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') {
			quoted = true;
			continue;
		}
		let delimiterLength = 0;
		if (character === '.') delimiterLength = 1;
		else if (raw.startsWith('->>', index)) delimiterLength = 3;
		else if (raw.startsWith('->', index)) delimiterLength = 2;
		if (!delimiterLength) continue;
		const segment = raw.slice(start, index);
		if (!segment) syntaxViolation('column path contains an empty segment');
		segments.push(segment.startsWith('"') ? decodeQuoted(segment) : segment);
		index += delimiterLength - 1;
		start = index + 1;
	}
	if (quoted) syntaxViolation('unterminated quoted column path');
	const finalSegment = raw.slice(start);
	if (!finalSegment) syntaxViolation('column path contains an empty segment');
	segments.push(finalSegment.startsWith('"') ? decodeQuoted(finalSegment) : finalSegment);
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
	const match = FILTER_PATTERN.exec(expression);
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
		term = parsed.operand.startsWith('{')
			? condition(path, comparator, parseList(parsed.operand, '{'), false, budget)
			: condition(path, 'ov', parseOperand(parsed.operand), false, budget);
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
	const candidateIndexes: number[] = [];
	const stack: string[] = [];
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index];
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
		} else if (character === '.' && index > 0 && stack.length === 0) {
			candidateIndexes.push(index);
		}
	}
	if (quoted) syntaxViolation('unterminated quoted column path');
	if (stack.length > 0) syntaxViolation('unbalanced operand delimiter');
	for (let candidate = candidateIndexes.length - 1; candidate >= 0; candidate--) {
		const index = candidateIndexes[candidate];
		const expression = raw.slice(index + 1);
		const operatorMatch = LOGIC_OPERATOR_PATTERN.exec(expression);
		if (operatorMatch && OPERATOR_NAMES.has(operatorMatch[1])) {
			const previousIndex = candidate > 0 ? candidateIndexes[candidate - 1] : -1;
			if (previousIndex >= 0 && raw.slice(previousIndex + 1, index) === 'not') {
				return parseFilterValue(
					splitColumnPath(raw.slice(0, previousIndex)), raw.slice(previousIndex + 1), budget,
				);
			}
			return parseFilterValue(splitColumnPath(raw.slice(0, index)), expression, budget);
		}
	}
	syntaxViolation('logic leaf must have the form column.[not.]operator.operand');
}

function parseLogicTerm(raw: string, depth: number, budget: ParseBudget): Term {
	const value = raw.trimStart();
	const call = LOGIC_CALL_PATTERN.exec(value);
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

function parseSelect(
	raw: string, options: PostgrestOptions | undefined, budget: ParseBudget,
): Projection | undefined {
	const fields: Field[] = [];
	let dropped = false;
	let wildcard = false;
	for (const rawField of splitTopLevel(raw)) {
		const field = rawField.trim();
		if (!field) syntaxViolation('select contains an empty field');
		if (field === '*') { wildcard = true; continue; }
		let feature: string | undefined;
		if (includesUnquoted(field, '::')) feature = `projection cast '${field}'`;
		else if (includesUnquoted(field, ':')) feature = `projection alias '${field}'`;
		else if (includesUnquoted(field, '(') || includesUnquoted(field, ')') || includesUnquoted(field, '!')) {
			throw new UnsupportedFeature(`PostgREST feature 'resource embedding (${field})' is unsupported`);
		}
		if (feature) {
			if (unsupported(feature, options)) { dropped = true; continue; }
		}
		useTerms(budget, 1);
		fields.push({ path: splitColumnPath(field) });
	}
	if (wildcard) return undefined;
	if (fields.length === 0 && dropped)
		throw new UnsupportedFeature('PostgREST cannot drop every selected field');
	if (fields.length === 0) syntaxViolation('select cannot be empty');
	return { mode: 'records', fields };
}

function parseOrder(
	raw: string, options: PostgrestOptions | undefined, budget: ParseBudget,
): SortKey[] {
	const keys: SortKey[] = [];
	let dropped = false;
	for (const rawKey of splitTopLevel(raw)) {
		let key = rawKey.trim();
		if (!key) syntaxViolation('order contains an empty key');
		if (NULL_ORDER_PATTERN.test(key)) {
			if (unsupported(`null ordering '${key}'`, options)) { dropped = true; continue; }
		}
		let direction: 'asc' | 'desc' = 'asc';
		if (key.endsWith('.asc')) key = key.slice(0, -4);
		else if (key.endsWith('.desc')) { key = key.slice(0, -5); direction = 'desc'; }
		useTerms(budget, 1);
		keys.push({ path: splitColumnPath(key), direction });
	}
	if (keys.length === 0 && dropped)
		throw new UnsupportedFeature('PostgREST cannot drop every order key');
	if (keys.length === 0) syntaxViolation('order cannot be empty');
	return keys;
}

function parseNonNegativeInteger(raw: string, name: string): number {
	if (!NON_NEGATIVE_INTEGER_PATTERN.test(raw)) syntaxViolation(`${name} must be a non-negative integer`);
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
			if (key === 'select') {
				const select = parseSelect(value, options, budget);
				if (select) result.select = select;
			}
			else if (key === 'order') result.sort = parseOrder(value, options, budget);
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
 * Appendix E.4: `neq` uses RQL complement semantics, so absent properties differ from SQL `<>`.
 */
export function parsePostgrest(
	search: string | URLSearchParams, options?: PostgrestOptions,
): ParseResult {
	const result: ParseResult = {};
	try {
		const parameters = typeof search === 'string'
			? new URL_SEARCH_PARAMS(search.startsWith('?') ? search.slice(1) : search)
			: search;
		parseInto(result, parameters, options);
	} catch (error) {
		if (!(error instanceof QueryError)) throw error;
		if (!options?.deferErrors) throw error;
		return { parseError: error };
	}
	return result;
}
