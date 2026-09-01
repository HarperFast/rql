import { QueryError, SyntaxViolation } from './errors.ts';
import { SYMBOL_OPS, LIST_COMPARATORS, resolveFiqlName } from './comparators.ts';
import type {
	ParseResult, ParseOptions, Group, Condition, ElementMatch, SortKey, Projection, Field, Value,
} from './types.ts';

// QP: tokenises attribute names and structural operators.
// VP: tokenises value tokens (includes ( ) , as plain chars; excludes & | = [ ] { }).
// Both are created fresh per parseQuery call for reentrancy.
// [&|]= first: the chain operators are two-char tokens and must win over
// the single-char structural match.
const QP_SRC = '([^?&|=<>!([{\\}\\]),]*)([&|]=|[([{\\}\\])|,&]|[=<>!]*)';
const VP_SRC = '([^&|=\\[\\]{}]*)([\\[\\]{}]|[&|=]*)';

const FIQL_NAME = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

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
	// §5.2.2: decimal numerals auto-convert in interpreted mode (round-trip rule),
	// keeping interpreted `a==3` distinct from verbatim `a=3`.
	const n = +token;
	if (token !== '' && !isNaN(n) && String(n) === token) return n;
	return decodeURIComponent(token);
}

const verbatimValue = (token: string): Value => decodeURIComponent(token);

/** Split on literal `.`; decode each segment so `%2E` stays within a segment. */
function splitPath(raw: string): string[] {
	return raw.split('.').map(decodeURIComponent);
}

function makeCondition(
	path: string[], comparator: string, negated: boolean, raw: string, verbatim: boolean
): Condition {
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
	const inner = raw.slice(1, -1); // strip ( )
	if (inner.length === 0) return [];
	const decode = verbatim ? verbatimValue : interpretValue;
	return inner.split(',').map(decode);
}

/** Produce an ElementMatch for `between`/`not_between`. Inner conditions have `path: []`. */
function betweenMatch(path: string[], raw: string, negated: boolean): ElementMatch {
	if (raw.length < 2 || raw.charCodeAt(0) !== 0x28 || raw.charCodeAt(raw.length - 1) !== 0x29)
		throw new SyntaxViolation('between requires value list (lo,hi)');
	const parts = raw.slice(1, -1).split(',');
	if (parts.length !== 2) throw new SyntaxViolation('between requires exactly two values');
	const ge: Condition = { path: [], comparator: 'ge', value: interpretValue(parts[0]) };
	const le: Condition = { path: [], comparator: 'le', value: interpretValue(parts[1]) };
	const em: ElementMatch = { path, some: { operator: 'and', terms: [ge, le] } };
	if (negated) em.negated = true;
	return em;
}

// ── Group accumulator ──────────────────────────────────────────────────────

type Term = Condition | Group | ElementMatch;

type Acc = {
	terms: Term[];
	operator?: 'and' | 'or';
	lastPath?: string[];
};

function newAcc(): Acc { return { terms: [] }; }

function setGroupOp(acc: Acc, op: 'and' | 'or', recordError: (msg: string) => void): void {
	if (acc.operator && acc.operator !== op)
		recordError('Cannot mix & and | in one group; use (...) or [...]');
	else acc.operator = op;
}

function accToGroup(acc: Acc): Group | undefined {
	if (acc.terms.length === 0) return undefined;
	return { operator: acc.operator ?? 'and', terms: acc.terms };
}

// §6 invariant: an ElementMatch scoping a single plain condition normalizes to an
// ordinary Condition with the concatenated path.
function pushElementMatch(acc: Acc, em: ElementMatch): void {
	const t = em.some.terms;
	if (t.length === 1 && !('some' in t[0]) && !('terms' in t[0]) && !em.negated) {
		const ic = t[0] as Condition;
		const merged: Condition = { path: [...em.path, ...ic.path], comparator: ic.comparator, value: ic.value };
		if (ic.negated) merged.negated = true;
		acc.terms.push(merged);
		acc.lastPath = merged.path;
	} else {
		acc.terms.push(em);
		acc.lastPath = em.path;
	}
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

	// ── Condition-group parser ─────────────────────────────────────────────
	// Always uses QP (FIQL works because QP sees both `=` tokens sequentially).
	// Call functions NOT dispatched here.

	function parseCondGroup(closeCh: string): Acc {
		const acc = newAcc();
		let path: string[] | undefined;
		let rawComp: string | undefined;
		let fiqlMode = false;
		let chainPath: string[] | undefined;
		let activeEM: ElementMatch | undefined;

		function closeEM(): void {
			if (activeEM) {
				pushElementMatch(acc, activeEM);
				activeEM = undefined;
				chainPath = undefined;
			}
		}

		function finishCond(rawVal: string): void {
			if (path === undefined) return;
			const rp = path;
			const rc = rawComp ?? '=';

			let term: Condition | ElementMatch;
			if (fiqlMode) {
				const r = resolveFiqlName(rc);
				if (r.isBetween) {
					term = betweenMatch(rp, rawVal, r.betweenNegated ?? false);
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
					term = c;
				}
			} else {
				const sym = SYMBOL_OPS[rc];
				if (!sym) {
					recordError(`unknown operator '${rc}'`);
					path = undefined; rawComp = undefined; fiqlMode = false;
					if (!activeEM) chainPath = undefined;
					return;
				}
				term = makeCondition(rp, sym.comparator, sym.negated, rawVal, sym.verbatim);
			}

			if (activeEM) {
				const addLeg = (c: Condition): void => {
					const relPath = c.path.slice(activeEM!.path.length);
					const ec: Condition = { path: relPath, comparator: c.comparator, value: c.value };
					if (c.negated) ec.negated = true;
					activeEM!.some.terms.push(ec);
				};
				if ('some' in term) for (const leg of (term as ElementMatch).some.terms) addLeg(leg as Condition);
				else addLeg(term as Condition);
			} else {
				acc.lastPath = rp;
				acc.terms.push(term);
			}
			path = undefined; rawComp = undefined; fiqlMode = false;
			// chainPath / activeEM persist across chain legs.
		}

		qp.lastIndex = pos;
		let match: RegExpExecArray | null;
		while ((match = qp.exec(search))) {
			pos = qp.lastIndex;
			const [, val, op] = match;

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
						path = splitPath(val); rawComp = '='; fiqlMode = false;
					}
					break;
				case '==': case '===': case '!=': case '!==': case '<': case '<=': case '>': case '>=':
					if (chainPath) { path = chainPath; rawComp = op; fiqlMode = false; }
					else {
						if (!val) { recordError(`path required before ${op}`); break; }
						path = splitPath(val); rawComp = op; fiqlMode = false;
					}
					break;
				case '&': case '|': {
					const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
					if (path !== undefined) finishCond(val);
					else if (chainPath !== undefined && val) recordError(`chain leg requires a comparator name before '${val}'`);
					closeEM();
					setGroupOp(acc, lop, recordError);
					break;
				}
				case '&=': case '|=': {
					const cop: 'and' | 'or' = op === '&=' ? 'and' : 'or';
					if (path !== undefined) finishCond(val);
					if (activeEM) {
						if (cop !== activeEM.some.operator) recordError('cannot mix & and | within a chain');
					} else {
						const prev = acc.terms.pop();
						if (!prev || 'some' in prev || 'terms' in prev) {
							if (prev) acc.terms.push(prev);
							recordError('no preceding condition for &=/|=');
							break;
						}
						const prevCond = prev as Condition;
						chainPath = prevCond.path;
						const relCond: Condition = { path: [], comparator: prevCond.comparator, value: prevCond.value };
						if (prevCond.negated) relCond.negated = true;
						activeEM = { path: chainPath, some: { operator: cop, terms: [relCond] } };
						acc.lastPath = undefined;
					}
					break;
				}
				case '': case undefined:
					if (path !== undefined) finishCond(val);
					else if (chainPath !== undefined && val) recordError(`chain leg requires a comparator name before '${val}'`);
					break;
				case ',':
					recordError("unexpected ','");
					break;
				case '(': {
					if (val) { recordError(`unexpected call '${val}(' inside condition group`); break; }
					qp.lastIndex = pos;
					const inner = parseCondGroup(')');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (grp) { closeEM(); acc.terms.push(grp); acc.lastPath = undefined; }
					break;
				}
				case '[': {
					if (val) {
						const ePath = splitPath(val);
						qp.lastIndex = pos;
						const inner = parseCondGroup(']');
						pos = qp.lastIndex;
						const innerGrp = accToGroup(inner);
						if (!innerGrp) {
							recordError(`empty bracket group for '${val}'`);
						} else {
							closeEM();
							pushElementMatch(acc, { path: ePath, some: innerGrp });
						}
					} else {
						qp.lastIndex = pos;
						const inner = parseCondGroup(']');
						pos = qp.lastIndex;
						const grp = accToGroup(inner);
						if (grp) { acc.terms.push(grp); acc.lastPath = undefined; }
					}
					break;
				}
				case ')': case ']': case '}': {
					const ch = op[0];
					if (closeCh === ch) {
						if (path !== undefined) finishCond(val);
						else if (val) recordError(`unexpected value without path '${val}'`);
						closeEM();
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
		closeEM();
		return acc;
	}

	// ── Top-level parser ───────────────────────────────────────────────────
	// QP/VP switching: VP only when committed to reading a value (FIQL or non-eq op seen).
	// Chaining and between produce ElementMatch.

	const result: ParseResult = {};
	const topAcc = newAcc();
	let path: string[] | undefined;
	let rawComp: string | undefined;
	let fiqlMode = false;
	let chainPath: string[] | undefined;
	let activeEM: ElementMatch | undefined;

	function useVP(): boolean {
		// Use VP only after we have path + a comparator that won't be FIQL second-=.
		return path !== undefined && rawComp !== undefined && (fiqlMode || rawComp !== '=');
	}

	function finishTopCond(rawVal: string): void {
		if (path === undefined) return;
		const rp = path;
		const rc = rawComp ?? '=';

		let term: Condition | ElementMatch;
		if (fiqlMode) {
			const r = resolveFiqlName(rc);
			if (r.isBetween) {
				term = betweenMatch(rp, rawVal, r.betweenNegated ?? false);
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
				term = c;
			}
		} else {
			const sym = SYMBOL_OPS[rc];
			if (!sym) {
				recordError(`unknown operator '${rc}'`);
				path = undefined; rawComp = undefined; fiqlMode = false;
				if (!activeEM) chainPath = undefined;
				return;
			}
			term = makeCondition(rp, sym.comparator, sym.negated, rawVal, sym.verbatim);
		}

		if (activeEM) {
			function addLeg(c: Condition): void {
				const relPath = c.path.slice(activeEM!.path.length);
				const ec: Condition = { path: relPath, comparator: c.comparator, value: c.value };
				if (c.negated) ec.negated = true;
				activeEM!.some.terms.push(ec);
			}
			if ('some' in term) {
				for (const leg of (term as ElementMatch).some.terms) addLeg(leg as Condition);
			} else {
				addLeg(term as Condition);
			}
		} else {
			topAcc.lastPath = rp;
			topAcc.terms.push(term);
		}

		path = undefined; rawComp = undefined; fiqlMode = false;
		// chainPath / activeEM persist across chain legs.
	}

	function closeActiveEM(): void {
		if (activeEM) {
			pushElementMatch(topAcc, activeEM);
			activeEM = undefined;
			chainPath = undefined;
		}
	}

	// ── Sub-parsers for call function arguments ────────────────────────────

	function parsePlainArgs(callName: string): string[] {
		const args: string[] = [];
		const p = new RegExp(QP_SRC, 'g');
		p.lastIndex = pos;
		let m: RegExpExecArray | null;
		while ((m = p.exec(search))) {
			pos = p.lastIndex;
			const [, val, op] = m;
			if (op === ')') { if (val) args.push(val); return args; }
			if (val) args.push(val);
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

			if (op === closeCh) { if (val) fields.push({ path: splitPath(val) }); return fields; }
			if (op === ')' || op === ']' || op === '}') {
				if (val) fields.push({ path: splitPath(val) });
				if (op === closeCh) return fields;
				recordError(`expected '${closeCh}', got '${op}'`);
				return fields;
			}
			if (op === ',') {
				if (val) fields.push({ path: splitPath(val) });
				p.lastIndex = pos;
				continue;
			}
			if (op === '{') {
				const nested = parseSelectList('}');
				p.lastIndex = pos; // re-sync after recursive call updates shared pos
				fields.push({ path: splitPath(val), nested });
				continue;
			}
			if (op === '[') {
				if (val) {
					const selectRe = /select\(/g;
					selectRe.lastIndex = pos;
					const sm = selectRe.exec(search);
					if (sm && sm.index === pos) {
						pos = selectRe.lastIndex;
						const nested = parseSelectList(')');
						if (search[pos] === ']') pos++;
						p.lastIndex = pos;
						fields.push({ path: splitPath(val), nested });
					} else {
						recordError(`expected 'select(' after '${val}['`);
					}
				} else {
					// `[a,b]` → tuple.
					const items = parseSelectList(']');
					p.lastIndex = pos; // re-sync after recursive call updates shared pos
					fields.push({ path: [], nested: items, tuple: true });
				}
				continue;
			}
			// Unrecognised structural op or empty string: treat val as field name.
			if (val) fields.push({ path: splitPath(val) });
			if (!op && pos >= search.length) { recordError(`expected '${closeCh}' for select`); return fields; }
		}
		recordError(`expected '${closeCh}' for select`);
		return fields;
	}

	function rawFieldsToProjection(fields: RawField[], trailingComma: boolean, nested = false): Projection {
		if (fields.length === 1 && fields[0].tuple) {
			return { mode: 'tuples', fields: (fields[0].nested ?? []).map(rawToField) };
		}
		const fs = fields.map(rawToField);
		// The single-field `values` mode is a top-level surface form only (§5.7);
		// nested projections trim the object (`records`), matching sub-select semantics.
		const mode: 'values' | 'records' =
			(!nested && fs.length === 1 && !fields[0].nested && !trailingComma) ? 'values' : 'records';
		return { mode, fields: fs };
	}

	function rawToField(rf: RawField): Field {
		if (rf.nested) return { path: rf.path, projection: rawFieldsToProjection(rf.nested, false, true) };
		return { path: rf.path };
	}

	function parseSelectArgs(): Projection {
		const startPos = pos;
		const fields = parseSelectList(')');
		const beforeClose = search.slice(startPos, pos - 1).trimEnd();
		const trailingComma = beforeClose.endsWith(',');
		return rawFieldsToProjection(fields, trailingComma);
	}

	// ── Main loop ──────────────────────────────────────────────────────────

	while (pos < search.length) {
		const p = useVP() ? vp : qp;
		p.lastIndex = pos;
		const match = p.exec(search);
		if (!match) break;
		pos = p.lastIndex;
		const [, val, op] = match;

		if (p === vp) {
			// Value token consumed.
			finishTopCond(val);
			// Process any logical separator carried by VP.
			switch (op) {
				case '&': case '|': {
					const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
					closeActiveEM();
					setGroupOp(topAcc, lop, recordError);
					break;
				}
				case '&=': case '|=': {
					// Chain operator: start or extend an ElementMatch.
					const cop: 'and' | 'or' = op === '&=' ? 'and' : 'or';
					if (activeEM) {
						if (cop !== activeEM.some.operator) recordError('cannot mix & and | within a chain');
					} else {
						const prev = topAcc.terms.pop();
						if (!prev || 'some' in prev || 'terms' in prev) {
							if (prev) topAcc.terms.push(prev);
							recordError('no preceding Condition to chain onto'); break;
						}
						const prevCond = prev as Condition;
						chainPath = prevCond.path;
						const relCond: Condition = { path: [], comparator: prevCond.comparator, value: prevCond.value };
						if (prevCond.negated) relCond.negated = true;
						activeEM = { path: chainPath, some: { operator: cop, terms: [relCond] } };
						topAcc.lastPath = undefined;
					}
					break;
				}
				default: break;
			}
			continue;
		}

		// QP token.
		switch (op) {
			case '=':
				if (path !== undefined) {
					// Second `=` of FIQL.
					if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
					rawComp = val; fiqlMode = true;
				} else if (chainPath) {
					if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
					path = chainPath; rawComp = val; fiqlMode = true;
				} else {
					if (!val) { recordError('path required before ='); break; }
					path = splitPath(val); rawComp = '='; fiqlMode = false;
				}
				break;
			case '==': case '===': case '!=': case '!==': case '<': case '<=': case '>': case '>=':
				if (chainPath) { path = chainPath; rawComp = op; fiqlMode = false; }
				else {
					if (!val) { recordError(`path required before ${op}`); break; }
					path = splitPath(val); rawComp = op; fiqlMode = false;
				}
				break;
			case '&': case '|': {
				const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
				if (path !== undefined) finishTopCond(val);
				else if (chainPath !== undefined && val) recordError(`chain leg requires a comparator name before '${val}'`);
				closeActiveEM();
				setGroupOp(topAcc, lop, recordError);
				break;
			}
			case '&=': case '|=': {
				const cop: 'and' | 'or' = op === '&=' ? 'and' : 'or';
				if (path !== undefined) finishTopCond(val);
				if (activeEM) {
					if (cop !== activeEM.some.operator) recordError('cannot mix & and | within a chain');
				} else {
					const prev = topAcc.terms.pop();
					if (!prev || 'some' in prev) {
						recordError('no preceding Condition to chain onto'); break;
					}
					const prevCond = prev as Condition;
					chainPath = prevCond.path;
					const relCond: Condition = { path: [], comparator: prevCond.comparator, value: prevCond.value };
					if (prevCond.negated) relCond.negated = true;
					activeEM = { path: chainPath, some: { operator: cop, terms: [relCond] } };
					topAcc.lastPath = undefined;
				}
				break;
			}
			case '': case undefined:
				if (path !== undefined) finishTopCond(val);
				else if (chainPath !== undefined && val) recordError(`chain leg requires a comparator name before '${val}'`);
				break;
			case ',':
				recordError("unexpected ','");
				break;
			case '(': {
				if (val) {
					switch (val) {
						case 'select':  result.select = parseSelectArgs();   break;
						case 'sort':    result.sort = parseSortArgs();        break;
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
					path = undefined; chainPath = undefined;
				} else {
					qp.lastIndex = pos;
					const inner = parseCondGroup(')');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (grp) { closeActiveEM(); topAcc.terms.push(grp); topAcc.lastPath = undefined; }
					if (search[pos] === ',') pos++;
					path = undefined;
				}
				break;
			}
			case '[': {
				if (val) {
					const ePath = splitPath(val);
					qp.lastIndex = pos;
					const inner = parseCondGroup(']');
					pos = qp.lastIndex;
					const innerGrp = accToGroup(inner);
					if (!innerGrp) {
						recordError(`empty bracket group for '${val}'`);
					} else if (innerGrp.terms.length === 1 && !('some' in innerGrp.terms[0])) {
						const ic = innerGrp.terms[0] as Condition;
						const merged: Condition = { path: [...ePath, ...ic.path], comparator: ic.comparator, value: ic.value };
						if (ic.negated) merged.negated = true;
						closeActiveEM(); topAcc.terms.push(merged); topAcc.lastPath = merged.path;
					} else {
						closeActiveEM(); topAcc.terms.push({ path: ePath, some: innerGrp }); topAcc.lastPath = ePath;
					}
					if (search[pos] === ',') pos++;
					path = undefined; chainPath = undefined;
				} else {
					qp.lastIndex = pos;
					const inner = parseCondGroup(']');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (grp) { closeActiveEM(); topAcc.terms.push(grp); topAcc.lastPath = undefined; }
					if (search[pos] === ',') pos++;
					path = undefined;
				}
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
	closeActiveEM();

	const filter = accToGroup(topAcc);
	if (filter) result.filter = filter;

	if (errorMsg) {
		const err = new SyntaxViolation(`Unable to parse query: ${errorMsg}`);
		if (deferErrors) { result.parseError = err; }
		else throw err;
	}

	return result;
}
