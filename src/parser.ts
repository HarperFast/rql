import { QueryError, SyntaxViolation } from './errors.ts';
import { SYMBOL_OPS, LIST_COMPARATORS, resolveFiqlName } from './comparators.ts';
import type {
	ParseResult, ParseOptions, Group, Condition, ElementMatch, SortKey, Projection, Field, Value,
} from './types.ts';

// QP: tokenises attribute names and structural operators.
// VP: tokenises value tokens (includes ( ) , as plain chars; excludes & | = [ ] { }).
// [&|]= wins over single-char structural match — chain/elem operators are two-char tokens.
const QP_SRC = '([^?&|=<>!([{\\}\\]),]*)([&|]=|[([{\\}\\])|,&]|[=<>!]*)';
const VP_SRC = '([^&|=\\[\\]{}]*)([\\[\\]{}]|[&|=]*)';

const FIQL_NAME = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

// ── Value decoding ─────────────────────────────────────────────────────────

export function interpretValue(token: string): Value {
	if (token === 'null') return null;
	if (token === 'true') return true;
	if (token === 'false') return false;
	const colon = token.indexOf(':');
	if (colon > 0) {
		const type = token.slice(0, colon);
		const rest = token.slice(colon + 1);
		switch (type) {
			case 'number': {
				const n = rest[0] === '$' ? parseInt(rest.slice(1), 36) : (rest === '' ? NaN : +rest);
				if (isNaN(n)) throw new QueryError(`malformed number literal '${token}'`);
				return n;
			}
			case 'boolean':
				if (rest !== 'true' && rest !== 'false') throw new QueryError(`malformed boolean literal '${token}'`);
				return rest === 'true';
			case 'date': {
				const d = new Date(isNaN(+rest) ? decodeURIComponent(rest) : +rest);
				if (isNaN(d.getTime())) throw new QueryError(`malformed date literal '${token}'`);
				return d;
			}
			case 'string':  return decodeURIComponent(rest);
			default: throw new QueryError(`Unknown type prefix '${type}'`);
		}
	}
	// §5.2.2: round-trip decimal numerals auto-convert in interpreted mode.
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
	const inner = raw.slice(1, -1);
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

/** §5.6: limit args must be non-negative decimal integers. */
function parseNonNegInt(s: string): number {
	const n = +s;
	if (!Number.isInteger(n) || n < 0 || String(n) !== s)
		throw new QueryError(`limit argument must be a non-negative integer: '${s}'`);
	return n;
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

// §5.4 De Morgan desugaring for not(...). Recursively toggles negated flags inward.
export function negateTerm(term: Term): Term {
	if ('terms' in term) return negateGroup(term as Group);
	if ('some' in term) {
		const em = term as ElementMatch;
		const r: ElementMatch = { path: em.path, some: em.some };
		if (!em.negated) r.negated = true;
		return r;
	}
	const c = term as Condition;
	const r: Condition = { path: c.path, comparator: c.comparator, value: c.value };
	if (!c.negated) r.negated = true;
	return r;
}

export function negateGroup(grp: Group): Term {
	// Single-term group: collapse to the negated leaf directly.
	if (grp.terms.length === 1) return negateTerm(grp.terms[0]);
	const op: 'and' | 'or' = grp.operator === 'and' ? 'or' : 'and';
	return { operator: op, terms: grp.terms.map(negateTerm) };
}

// §6 invariant: an ElementMatch scoping exactly one plain non-negated Condition normalizes
// to an ordinary Condition on the concatenated path (§5.3). Plain Conditions on list paths
// are already existential (§5.5), so elem-cond path=[] also flattens safely:
// [...em.path, ...[]] = em.path. Negated inner conditions are never flattened (∃¬ ≠ ¬∃).
function pushElementMatch(acc: Acc, em: ElementMatch): void {
	const t = em.some.terms;
	if (t.length === 1 && !('some' in t[0]) && !('terms' in t[0]) && !em.negated && !(t[0] as Condition).negated) {
		const ic = t[0] as Condition;
		const merged: Condition = { path: [...em.path, ...ic.path], comparator: ic.comparator, value: ic.value };
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
	// Always uses QP. When isScoped=true (prop[...] body), elem-conds (=name=val) are
	// accepted with an empty implicit path, and &=/|= decompose to conjunction + elem-cond.

	function parseCondGroup(closeCh: string, isScoped = false): Acc {
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
		}

		qp.lastIndex = pos;
		let match: RegExpExecArray | null;
		while ((match = qp.exec(search))) {
			pos = qp.lastIndex;
			const [, val, op] = match;

			switch (op) {
				case '=':
					if (path !== undefined) {
						// Second `=` of FIQL.
						if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
						rawComp = val; fiqlMode = true;
					} else if (chainPath) {
						if (!FIQL_NAME.test(val)) { recordError(`invalid FIQL name '${val}'`); break; }
						path = chainPath; rawComp = val; fiqlMode = true;
					} else if (isScoped && !val) {
						// elem-cond: `=fiql-name=value` with no explicit property path.
						path = []; rawComp = '='; fiqlMode = false;
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
					const hadPending = path !== undefined;
					if (hadPending) finishCond(val);
					// In a scoped-body, &=/|= after an elem-cond (lastPath=[]) is a
					// conjunction + new elem-cond start, not a chain operator.
					const lastIsElemCond = acc.lastPath !== undefined && acc.lastPath.length === 0;
					if (isScoped && lastIsElemCond && !activeEM) {
						closeEM();
						setGroupOp(acc, cop, recordError);
						path = []; rawComp = '='; fiqlMode = false;
					} else if (activeEM) {
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
					if (val === 'not') {
						// §5.4 not(...) term-form — not a call function.
						qp.lastIndex = pos;
						const inner = parseCondGroup(')');
						pos = qp.lastIndex;
						const grp = accToGroup(inner);
						if (!grp) { recordError('not() requires a non-empty body'); break; }
						closeEM();
						acc.terms.push(negateGroup(grp));
						acc.lastPath = undefined;
						break;
					}
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
						// prop[...] scoped-match.
						const ePath = splitPath(val);
						qp.lastIndex = pos;
						const inner = parseCondGroup(']', true);
						pos = qp.lastIndex;
						const innerGrp = accToGroup(inner);
						if (!innerGrp) {
							recordError(`empty bracket group for '${val}'`);
						} else if (innerGrp.terms.length === 1 && !('some' in innerGrp.terms[0]) && !('terms' in innerGrp.terms[0]) && !(innerGrp.terms[0] as Condition).negated) {
							const ic = innerGrp.terms[0] as Condition;
							const merged: Condition = { path: [...ePath, ...ic.path], comparator: ic.comparator, value: ic.value };
							closeEM(); acc.terms.push(merged); acc.lastPath = merged.path;
						} else {
							closeEM(); pushElementMatch(acc, { path: ePath, some: innerGrp });
						}
					} else {
						qp.lastIndex = pos;
						const inner = parseCondGroup(']');
						pos = qp.lastIndex;
						const grp = accToGroup(inner);
						if (grp) { closeEM(); acc.terms.push(grp); acc.lastPath = undefined; }
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

	const result: ParseResult = {};
	const topAcc = newAcc();
	let path: string[] | undefined;
	let rawComp: string | undefined;
	let fiqlMode = false;
	let chainPath: string[] | undefined;
	let activeEM: ElementMatch | undefined;
	const seenCalls = new Set<string>();

	function useVP(): boolean {
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
				p.lastIndex = pos;
				// §5.7: nested '[...]' tuple form inside '{}' is reserved.
				if (nested.some(f => f.tuple)) recordError("nested '[...]' tuple inside '{}' is reserved");
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
					p.lastIndex = pos;
					fields.push({ path: [], nested: items, tuple: true });
				}
				continue;
			}
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
			finishTopCond(val);
			switch (op) {
				case '&': case '|': {
					const lop: 'and' | 'or' = op === '&' ? 'and' : 'or';
					closeActiveEM();
					setGroupOp(topAcc, lop, recordError);
					break;
				}
				case '&=': case '|=': {
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
			case '': case undefined:
				if (path !== undefined) finishTopCond(val);
				else if (chainPath !== undefined && val) recordError(`chain leg requires a comparator name before '${val}'`);
				break;
			case ',':
				recordError("unexpected ','");
				break;
			case '(': {
				if (val === 'not') {
					// §5.4 not(...) term-form — not a call function (§5.6).
					qp.lastIndex = pos;
					const inner = parseCondGroup(')');
					pos = qp.lastIndex;
					const grp = accToGroup(inner);
					if (!grp) { recordError('not() requires a non-empty body'); }
					else {
						closeActiveEM();
						topAcc.terms.push(negateGroup(grp));
						topAcc.lastPath = undefined;
					}
					if (search[pos] === ',') pos++;
					path = undefined; chainPath = undefined;
					break;
				}
				if (val) {
					if (seenCalls.has(val)) {
						// Consume args and record duplicate error.
						if (val === 'select') parseSelectArgs();
						else if (val === 'sort') parseSortArgs();
						else parsePlainArgs(val);
						recordError(`duplicate ${val}()`);
					} else {
						seenCalls.add(val);
						switch (val) {
							case 'select':  result.select = parseSelectArgs();   break;
							case 'sort':    result.sort = parseSortArgs();        break;
							case 'limit': {
								const args = parsePlainArgs('limit');
								try {
									if (args.length === 1) {
										result.limit = parseNonNegInt(args[0]);
									} else if (args.length === 2) {
										const start = parseNonNegInt(args[0]);
										const end = parseNonNegInt(args[1]);
										if (end < start) throw new QueryError(`limit end ${end} must be ≥ start ${start}`);
										result.offset = start;
										result.limit = end - start;
									} else {
										recordError('limit takes 1 or 2 arguments');
									}
								} catch (e) {
									if (e instanceof QueryError) recordError(e.message);
									else throw e;
								}
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
					const inner = parseCondGroup(']', true);
					pos = qp.lastIndex;
					const innerGrp = accToGroup(inner);
					if (!innerGrp) {
						recordError(`empty bracket group for '${val}'`);
					} else if (innerGrp.terms.length === 1 && !('some' in innerGrp.terms[0]) && !('terms' in innerGrp.terms[0]) && !(innerGrp.terms[0] as Condition).negated) {
						const ic = innerGrp.terms[0] as Condition;
						const merged: Condition = { path: [...ePath, ...ic.path], comparator: ic.comparator, value: ic.value };
						closeActiveEM(); topAcc.terms.push(merged); topAcc.lastPath = merged.path;
					} else {
						closeActiveEM(); pushElementMatch(topAcc, { path: ePath, some: innerGrp });
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
