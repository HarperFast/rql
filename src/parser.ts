import { QueryError, SyntaxViolation } from './errors.ts';
import { SYMBOL_OPS, LIST_COMPARATORS, resolveFiqlName } from './comparators.ts';
import type {
	ParseResult, ParseOptions, Group, Condition, SortKey, Projection, Field, Value,
} from './types.ts';

const FIQL_NAME = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

// Regexes are created fresh per parseQuery call for reentrancy.
// QP: tokenises attribute names and structural operators.
// VP: tokenises value tokens (includes ( ) , as plain chars).
const QP_SRC = '([^?&|=<>!([{\\}\\]),]*)([([{\\}\\])|,&]|[=<>!]*)';
const VP_SRC = '([^&|=\\[\\]{}]*)([\\[\\]{}]|[&|=]*)';

// ── Value decoding ─────────────────────────────────────────────────────────

function interpretValue(token: string): Value {
	if (token === 'null') return null;
	if (token === 'true') return true;
	if (token === 'false') return false;
	const colon = token.indexOf(':');
	if (colon > 0) {
		const type = token.slice(0, colon);
		const rest = token.slice(colon + 1);
		switch (type) {
			case 'number':  return rest[0] === '$' ? parseInt(rest.slice(1), 36) : +rest;
			case 'boolean': return rest === 'true';
			case 'date':    return new Date(isNaN(+rest) ? decodeURIComponent(rest) : +rest);
			case 'string':  return decodeURIComponent(rest);
			default: throw new QueryError(`Unknown type prefix '${type}'`);
		}
	}
	return decodeURIComponent(token);
}

const verbatimValue = (token: string): Value => decodeURIComponent(token);

/**
 * Split a raw path token on literal `.`, decode each segment.
 * `%2E` → literal `.` inside a segment (§4.2).
 */
function splitPath(raw: string): string[] {
	return raw.split('.').map(decodeURIComponent);
}

function makeCondition(
	path: string[], comparator: string, negated: boolean, raw: string, verbatim: boolean
): Condition {
	// Trailing * on == (eq, interpreted) → starts_with.
	if (comparator === 'eq' && !verbatim && raw.indexOf('*') > -1) {
		if (!raw.endsWith('*')) throw new QueryError('wildcard can only be used at the end of a string');
		const c: Condition = { path, comparator: 'starts_with', value: decodeURIComponent(raw.slice(0, -1)) };
		if (negated) c.negated = true;
		return c;
	}
	const value = (verbatim ? verbatimValue : interpretValue)(raw);
	const c: Condition = { path, comparator, value };
	if (negated) c.negated = true;
	return c;
}

function parseListRaw(raw: string, verbatim: boolean): Value[] {
	// Expects `(v1,v2,...)` format. Each element decoded individually.
	const inner = raw.slice(1, -1);
	if (inner.length === 0) return [];
	const decode = verbatim ? verbatimValue : interpretValue;
	return inner.split(',').map(decode);
}

function betweenGroup(path: string[], raw: string, betweenNegated: boolean): Group {
	// `(lo,hi)` → and-Group of ge(lo) + le(hi), or or-Group when negated.
	if (raw.length < 2 || raw.charCodeAt(0) !== 0x28 || raw.charCodeAt(raw.length - 1) !== 0x29)
		throw new SyntaxViolation('between requires value list (lo,hi)');
	const parts = raw.slice(1, -1).split(',');
	if (parts.length !== 2) throw new SyntaxViolation('between requires exactly two values');
	const lo = interpretValue(parts[0]);
	const hi = interpretValue(parts[1]);
	const ge: Condition = { path, comparator: 'ge', value: lo };
	const le: Condition = { path, comparator: 'le', value: hi };
	if (betweenNegated) { ge.negated = true; le.negated = true; }
	return { operator: betweenNegated ? 'or' : 'and', terms: [ge, le] };
}

// ── Group accumulator ──────────────────────────────────────────────────────

type Term = Condition | Group;

type Acc = {
	terms: Term[];
	operator?: 'and' | 'or';
	lastPath?: string[];
	chainGroup?: { operator: 'and' | 'or'; terms: Term[] };
};

function newAcc(): Acc { return { terms: [] }; }

function setGroupOp(acc: Acc, op: 'and' | 'or', recordError: (msg: string) => void): void {
	if (acc.terms.length === 0 && !acc.chainGroup) return;
	if (acc.operator && acc.operator !== op)
		recordError('Cannot mix & and | in one group; use (...) or [...]');
	else acc.operator = op;
}

function closeChain(acc: Acc): void {
	if (acc.chainGroup) {
		acc.terms.push(acc.chainGroup as Group);
		acc.chainGroup = undefined;
	}
}

function pushTerm(acc: Acc, term: Term, chainOp: 'and' | 'or' | undefined, recordError: (msg: string) => void): void {
	if (chainOp) {
		if (!acc.chainGroup) {
			const prev = acc.terms.pop();
			if (prev === undefined) { recordError('no preceding condition to chain onto'); return; }
			acc.chainGroup = { operator: chainOp, terms: [prev] };
		}
		acc.chainGroup.terms.push(term);
	} else {
		closeChain(acc);
		acc.terms.push(term);
	}
}

function accToGroup(acc: Acc): Group | undefined {
	closeChain(acc);
	if (acc.terms.length === 0) return undefined;
	return { operator: acc.operator ?? 'and', terms: acc.terms };
}

// ── Main parse function ────────────────────────────────────────────────────

export function parseQuery(search: string, options?: ParseOptions): ParseResult {
	const deferErrors = options?.deferErrors ?? false;
	if (!search) return {};

	const qp = new RegExp(QP_SRC, 'g');
	const vp = new RegExp(VP_SRC, 'g');
	let pos = 0;
	let errorMsg: string | undefined;

	function recordError(msg: string): void {
		const em = `${msg} at position ${pos}`;
		errorMsg = errorMsg ? `${errorMsg}, ${em}` : em;
	}

	// ── Condition-group parser ───────────────────────────────────────────────
	// Uses QP throughout (no VP switching inside groups — VP is for top-level).
	// Call functions are not dispatched here; they're top-level only.

	function parseCondGroup(closeCh: string): Acc {
		const acc = newAcc();
		let path: string[] | undefined;
		let rawComp: string | undefined;
		let fiqlMode = false;
		let verbatim = false;
		let expectDelim = false;
		let chainOp: 'and' | 'or' | undefined;
		let chainPath: string[] | undefined; // path for &=/|= continuation

		function finishCond(rawVal: string): void {
			if (path === undefined) return;
			const rp = path;
			const rc = rawComp ?? '=';
			if (fiqlMode) {
				const r = resolveFiqlName(rc);
				if (r.isBetween) {
					pushTerm(acc, betweenGroup(rp, rawVal, r.betweenNegated ?? false), chainOp, recordError);
				} else {
					const isListComp = LIST_COMPARATORS.has(r.comparator) || LIST_COMPARATORS.has(`not_${r.comparator}`);
					let value: Value;
					if (isListComp && rawVal.charCodeAt(0) === 0x28) {
						value = parseListRaw(rawVal, r.verbatim);
					} else {
						value = (r.verbatim ? verbatimValue : interpretValue)(rawVal);
					}
					const c: Condition = { path: rp, comparator: r.comparator, value };
					if (r.negated) c.negated = true;
					pushTerm(acc, c, chainOp, recordError);
				}
			} else {
				const sym = SYMBOL_OPS[rc];
				if (!sym) { recordError(`unknown operator '${rc}'`); }
				else { pushTerm(acc, makeCondition(rp, sym.comparator, sym.negated, rawVal, sym.verbatim), chainOp, recordError); }
			}
			if (!chainOp) acc.lastPath = rp;
			path = undefined; rawComp = undefined; fiqlMode = false; verbatim = false; chainOp = undefined; chainPath = undefined;
		}

		qp.lastIndex = pos;
		let match: RegExpExecArray | null;
		while ((match = qp.exec(search))) {
			pos = qp.lastIndex;
			const [, val, op] = match;

			if (expectDelim) {
				if (val) recordError(`expected operator, got '${val}'`);
				expectDelim = false;
			}

			switch (op) {
				case '=':
					if (path !== undefined) {
						// Second '=' of FIQL: path=name=value.
						if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
						rawComp = val; fiqlMode = true;
					} else if (chainPath) {
						// &= chain: already have path, this is the FIQL name.
						if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
						path = chainPath; rawComp = val; fiqlMode = true;
					} else {
						if (!val) { recordError('path required before ='); break; }
						path = splitPath(val); rawComp = '='; verbatim = true;
					}
					break;
				case '==': case '===': case '!=': case '!==': case '<': case '<=': case '>': case '>=':
					if (chainPath) {
						path = chainPath; rawComp = op;
					} else {
						if (!val) { recordError(`path required before ${op}`); break; }
						path = splitPath(val); rawComp = op;
					}
					fiqlMode = false;
					break;
				case '&': case '|': {
					const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
					if (path !== undefined) finishCond(val);
					closeChain(acc);
					setGroupOp(acc, lop, recordError);
					break;
				}
				case '&=': case '|=': {
					if (path !== undefined) finishCond(val);
					chainOp = op === '&=' ? 'and' : 'or';
					chainPath = acc.lastPath ?? (acc.chainGroup?.terms.at(-1) as Condition | undefined)?.path;
					if (!chainPath) recordError('no preceding condition for &=/|=');
					break;
				}
				case '': case undefined:
					if (path !== undefined) finishCond(val);
					break;
				case ',':
					recordError("unexpected ','");
					break;
				case '(': {
					// Nested condition group.
					if (val) { recordError(`unexpected name '${val}' before '('`); break; }
					qp.lastIndex = pos;
					const inner = parseCondGroup(')');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (grp) { closeChain(acc); acc.terms.push(grp); acc.lastPath = undefined; }
					if (search[pos] === ',') { qp.lastIndex = ++pos; } else expectDelim = true;
					path = undefined; chainPath = undefined;
					break;
				}
				case '[': {
					if (val) { recordError(`unexpected name '${val}' before '['`); break; }
					qp.lastIndex = pos;
					const inner = parseCondGroup(']');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (grp) { closeChain(acc); acc.terms.push(grp); acc.lastPath = undefined; }
					if (search[pos] === ',') { qp.lastIndex = ++pos; } else expectDelim = true;
					path = undefined; chainPath = undefined;
					break;
				}
				case ')': case ']': case '}': {
					const ch = op[0];
					if (closeCh === ch) {
						if (path !== undefined) finishCond(val);
						else if (val) recordError('unexpected value without path');
						return acc;
					}
					recordError(closeCh ? `expected '${closeCh}', got '${ch}'` : `unexpected '${ch}'`);
					break;
				}
				default:
					recordError(`unexpected token '${op}'`);
			}

			qp.lastIndex = pos;
			if (pos === search.length) break;
		}
		if (closeCh) recordError(`expected '${closeCh}', got end of string`);
		return acc;
	}

	// ── Top-level parser (condition group + call functions) ──────────────────
	// Switches between QP and VP based on whether a comparator was just seen.

	const result: ParseResult = {};
	const topAcc = newAcc();

	let path: string[] | undefined;
	let rawComp: string | undefined;
	let fiqlMode = false;
	let verbatim = false;
	let expectDelim = false;
	let chainOp: 'and' | 'or' | undefined;
	let chainPath: string[] | undefined;

	function finishTopCond(rawVal: string): void {
		if (path === undefined) return;
		const rp = path;
		const rc = rawComp ?? '=';
		if (fiqlMode) {
			const r = resolveFiqlName(rc);
			if (r.isBetween) {
				pushTerm(topAcc, betweenGroup(rp, rawVal, r.betweenNegated ?? false), chainOp, recordError);
			} else {
				const isListComp = LIST_COMPARATORS.has(r.comparator) || LIST_COMPARATORS.has(`not_${r.comparator}`);
				let value: Value;
				if (isListComp && rawVal.charCodeAt(0) === 0x28) {
					value = parseListRaw(rawVal, r.verbatim);
				} else {
					value = (r.verbatim ? verbatimValue : interpretValue)(rawVal);
				}
				const c: Condition = { path: rp, comparator: r.comparator, value };
				if (r.negated) c.negated = true;
				pushTerm(topAcc, c, chainOp, recordError);
			}
		} else {
			const sym = SYMBOL_OPS[rc];
			if (!sym) { recordError(`unknown operator '${rc}'`); }
			else { pushTerm(topAcc, makeCondition(rp, sym.comparator, sym.negated, rawVal, sym.verbatim), chainOp, recordError); }
		}
		if (!chainOp) topAcc.lastPath = rp;
		path = undefined; rawComp = undefined; fiqlMode = false; verbatim = false; chainOp = undefined; chainPath = undefined;
	}

	// Sub-parsers for call function arguments.
	// Each creates its own regex but shares closure `pos`.

	function parsePlainArgs(callName: string): string[] {
		const args: string[] = [];
		const p = new RegExp(QP_SRC, 'g');
		p.lastIndex = pos;
		let m: RegExpExecArray | null;
		while ((m = p.exec(search))) {
			pos = p.lastIndex;
			const [, val, op] = m;
			args.push(val);
			if (op === ')') return args;
			if (op === ',') continue;
			if (pos === search.length) { recordError(`expected ')' for ${callName}`); return args; }
		}
		recordError(`expected ')' for ${callName}`);
		return args;
	}

	function parseSortArgs(): SortKey[] {
		const keys: SortKey[] = [];
		const p = new RegExp(QP_SRC, 'g');
		p.lastIndex = pos;
		let m: RegExpExecArray | null;
		while ((m = p.exec(search))) {
			pos = p.lastIndex;
			const [, val, op] = m;
			if (val) {
				let raw = val;
				let direction: 'asc' | 'desc' = 'asc';
				if (raw[0] === '+') raw = raw.slice(1);
				else if (raw[0] === '-') { direction = 'desc'; raw = raw.slice(1); }
				keys.push({ path: splitPath(raw), direction });
			}
			if (op === ')') return keys;
			if (op === ',') continue;
			if (pos === search.length) { recordError("expected ')' for sort"); return keys; }
		}
		recordError("expected ')' for sort");
		return keys;
	}

	type RawField = { path: string[]; nested?: RawField[]; tuple?: boolean };

	function parseSelectList(closeCh: string): RawField[] {
		const fields: RawField[] = [];
		const p = new RegExp(QP_SRC, 'g');
		p.lastIndex = pos;
		let m: RegExpExecArray | null;
		while ((m = p.exec(search))) {
			pos = p.lastIndex;
			const [, val, op] = m;
			if (op === closeCh || (op === '' && pos === search.length)) {
				if (val) fields.push({ path: splitPath(val) });
				if (op !== closeCh) recordError(`expected '${closeCh}' for select`);
				return fields;
			}
			if (op === ')' || op === ']' || op === '}') {
				if (op === closeCh) { if (val) fields.push({ path: splitPath(val) }); return fields; }
				recordError(`expected '${closeCh}', got '${op}'`);
				return fields;
			}
			if (op === ',') { if (val) fields.push({ path: splitPath(val) }); continue; }
			if (op === '{') {
				// `rel{x,y}` nested sub-select.
				const nested = parseSelectList('}');
				fields.push({ path: splitPath(val), nested });
				continue;
			}
			if (op === '[') {
				if (val) {
					// `rel[select(x,y)]` — consume `select(`, then list, then `)]`.
					const selectRe = /select\(/g;
					selectRe.lastIndex = pos;
					const sm = selectRe.exec(search);
					if (sm && sm.index === pos) {
						pos = selectRe.lastIndex;
						const nested = parseSelectList(')');
						if (search[pos] === ']') pos++;
						fields.push({ path: splitPath(val), nested });
					} else {
						recordError(`expected 'select(' after '${val}['`);
					}
				} else {
					// `[a,b]` tuple field.
					const items = parseSelectList(']');
					fields.push({ path: [], nested: items, tuple: true });
				}
				continue;
			}
			// Structural op like `=` — unexpected in select context.
			if (val) fields.push({ path: splitPath(val) });
		}
		recordError(`expected '${closeCh}' for select`);
		return fields;
	}

	function rawFieldsToProjection(fields: RawField[], trailingComma: boolean): Projection {
		if (fields.length === 1 && fields[0].tuple) {
			const f = fields[0];
			return {
				mode: 'tuples',
				fields: (f.nested ?? []).map((rf) => rawToField(rf)),
			};
		}
		const fs = fields.map((rf) => rawToField(rf));
		// `select(a)` → values; `select(a,b)` or `select(a,)` → records.
		const mode: 'values' | 'records' = (fs.length === 1 && !fields[0].nested && !trailingComma) ? 'values' : 'records';
		return { mode, fields: fs };
	}

	function rawToField(rf: RawField): Field {
		if (rf.nested) return { path: rf.path, projection: rawFieldsToProjection(rf.nested, false) };
		return { path: rf.path };
	}

	function parseSelectArgs(): Projection {
		// Capture position before trailing-comma detection.
		const startPos = pos;
		const fields = parseSelectList(')');
		// Detect trailing comma: search backwards from the `)` position.
		const beforeClose = search.slice(startPos, pos - 1).trimEnd();
		const trailingComma = beforeClose.endsWith(',');
		return rawFieldsToProjection(fields, trailingComma);
	}

	// Top-level loop. Switches between QP and VP based on whether we're expecting a value.
	qp.lastIndex = 0;

	function nextParser(): RegExp {
		// Use VP when we have both path and comparator set (expecting value token).
		return (path !== undefined && rawComp !== undefined) ? vp : qp;
	}

	let match: RegExpExecArray | null;
	while (pos < search.length) {
		const p = nextParser();
		p.lastIndex = pos;
		match = p.exec(search);
		if (!match) break;
		pos = p.lastIndex;
		const [, val, op] = match;

		if (expectDelim) {
			if (val) recordError(`expected operator, got '${val}'`);
			expectDelim = false;
		}

		if (p === vp) {
			// Value token: finish the pending condition.
			finishTopCond(val);
			// op from VP: `&`, `|`, `=`, `[`, `]`, `{`, `}`, or ''.
			// Handle the operator (logical separator or end-of-string).
			if (op === '&' || op === '|') {
				const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
				closeChain(topAcc);
				setGroupOp(topAcc, lop, recordError);
			} else if (op === '&=' || op === '|=') {
				chainOp = op === '&=' ? 'and' : 'or';
				chainPath = topAcc.lastPath ?? (topAcc.chainGroup?.terms.at(-1) as Condition | undefined)?.path;
				if (!chainPath) recordError('no preceding condition for &=/|=');
			}
			// Other ops (empty, brackets) fall through to next iteration.
			continue;
		}

		// QP path.
		switch (op) {
			case '=':
				if (path !== undefined) {
					if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
					rawComp = val; fiqlMode = true;
				} else if (chainPath) {
					if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
					path = chainPath; rawComp = val; fiqlMode = true;
				} else {
					if (!val) { recordError('path required before ='); break; }
					path = splitPath(val); rawComp = '='; verbatim = true;
				}
				break;
			case '==': case '===': case '!=': case '!==': case '<': case '<=': case '>': case '>=':
				if (chainPath) { path = chainPath; rawComp = op; }
				else { if (!val) { recordError(`path required before ${op}`); break; } path = splitPath(val); rawComp = op; }
				fiqlMode = false;
				break;
			case '&': case '|': {
				const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
				if (path !== undefined) finishTopCond(val);
				closeChain(topAcc);
				setGroupOp(topAcc, lop, recordError);
				break;
			}
			case '&=': case '|=':
				if (path !== undefined) finishTopCond(val);
				chainOp = op === '&=' ? 'and' : 'or';
				chainPath = topAcc.lastPath ?? (topAcc.chainGroup?.terms.at(-1) as Condition | undefined)?.path;
				if (!chainPath) recordError('no preceding condition for &=/|=');
				break;
			case '': case undefined:
				if (path !== undefined) finishTopCond(val);
				break;
			case ',':
				recordError("unexpected ','");
				break;
			case '(': {
				if (val) {
					// Call function.
					switch (val) {
						case 'select':  result.select = parseSelectArgs();            break;
						case 'sort':    result.sort = parseSortArgs();                break;
						case 'limit': {
							const args = parsePlainArgs('limit');
							if (args.length === 1) result.limit = +args[0];
							else if (args.length === 2) { result.offset = +args[0]; result.limit = +args[1] - result.offset; }
							else recordError('limit takes 1 or 2 arguments');
							break;
						}
						case 'group-by':
							parsePlainArgs('group-by');
							recordError('group-by is not implemented');
							break;
						default:
							parsePlainArgs(val);
							recordError(`unknown call function '${val}'`);
					}
					if (search[pos] === ',') pos++;
					else expectDelim = true;
					path = undefined; chainPath = undefined;
				} else {
					// Anonymous condition group.
					qp.lastIndex = pos;
					const inner = parseCondGroup(')');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (grp) { closeChain(topAcc); topAcc.terms.push(grp); topAcc.lastPath = undefined; }
					if (search[pos] === ',') pos++;
					else expectDelim = true;
					path = undefined; chainPath = undefined;
				}
				break;
			}
			case '[': {
				if (val) { recordError(`unexpected name '${val}' before '['`); break; }
				qp.lastIndex = pos;
				const inner = parseCondGroup(']');
				pos = qp.lastIndex;
				const grp = accToGroup(inner);
				if (grp) { closeChain(topAcc); topAcc.terms.push(grp); topAcc.lastPath = undefined; }
				if (search[pos] === ',') pos++;
				else expectDelim = true;
				path = undefined; chainPath = undefined;
				break;
			}
			case ')': case ']': case '}':
				recordError(`unexpected '${op[0]}'`);
				break;
			default:
				recordError(`unexpected token '${op}'`);
		}
	}

	if (path !== undefined) finishTopCond('');
	closeChain(topAcc);
	const filter = accToGroup(topAcc);
	if (filter) result.filter = filter;

	if (errorMsg) {
		const err = new SyntaxViolation(`Unable to parse query: ${errorMsg}`);
		if (deferErrors) { result.parseError = err; }
		else throw err;
	}

	return result;
}
