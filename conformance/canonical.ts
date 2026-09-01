/**
 * Deterministic serialization of the canonical model, and a structural differ over it.
 *
 * Both parsers produce `ParseResult`s (Harper's via the adapter). Comparing them needs a
 * form that is stable byte-for-byte across runs — object key order is not — and a diff
 * that names *where* two results disagree, because the classification rules key off the
 * shape of the disagreement rather than off the query string.
 */

import type { ParseResult, Value } from '../src/types.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Outcome of running one query string through one parser. A successful parse is carried as
 * its canonical JSON view rather than as a `ParseResult`, so that an outcome crossing the
 * worker IPC boundary is the same value the comparison and the report work on.
 */
export type Outcome =
	| { status: 'parsed'; canonical: Json }
	/** Rejected at parse — the canonical behavior for a syntax violation (§6.1). */
	| { status: 'rejected'; error: string }
	/** Rejected, but only into the pipeline: Harper's deferred mode (§6.1, ledger row 8). */
	| { status: 'deferred-error'; error: string; canonical: Json }
	/** The parse did not finish inside its wall-clock budget. */
	| { status: 'timeout'; ms: number }
	/** The parse produced a shape the adapter cannot place in the canonical model. */
	| { status: 'adapter-gap'; error: string }
	/** The parser process itself failed (crash, unusable output). */
	| { status: 'harness-error'; error: string };

/** Whether an outcome means "this query was not accepted", however that was signalled. */
export function isRejection(outcome: Outcome): boolean {
	return outcome.status === 'rejected' || outcome.status === 'deferred-error';
}

function canonicalValue(value: Value | undefined): Json {
	if (value === undefined) return { $absent: true };
	if (value === null) return null;
	if (value instanceof Date)
		return Number.isNaN(value.getTime()) ? { $date: 'invalid' } : { $date: value.toISOString() };
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
	return value;
}

/**
 * Canonical JSON view of a ParseResult. Absent optional members stay absent (they are not
 * the same as present-and-empty), and values keep their type so `"3"` never reads as `3`.
 */
export function canonicalize(result: ParseResult): Json {
	const out: { [key: string]: Json } = {};
	if (result.filter !== undefined) out.filter = canonicalTerm(result.filter);
	if (result.sort !== undefined) out.sort = result.sort.map((key) => ({ path: key.path, direction: key.direction }));
	if (result.select !== undefined) out.select = canonicalProjection(result.select);
	if (result.limit !== undefined) out.limit = canonicalValue(result.limit as Value);
	if (result.offset !== undefined) out.offset = canonicalValue(result.offset as Value);
	return out;
}

function canonicalProjection(projection: NonNullable<ParseResult['select']>): Json {
	return {
		mode: projection.mode,
		fields: projection.fields.map((field) => {
			const out: { [key: string]: Json } = { path: field.path };
			if (field.projection) out.projection = canonicalProjection(field.projection);
			return out;
		}),
	};
}

type Term = NonNullable<ParseResult['filter']>['terms'][number] | NonNullable<ParseResult['filter']>;

function canonicalTerm(term: Term): Json {
	if ('terms' in term) return { kind: 'group', operator: term.operator, terms: term.terms.map(canonicalTerm) };
	if ('some' in term) {
		const out: { [key: string]: Json } = { kind: 'elementMatch', path: term.path };
		if (term.negated) out.negated = true;
		out.some = canonicalTerm(term.some);
		return out;
	}
	const out: { [key: string]: Json } = { kind: 'condition', path: term.path, comparator: term.comparator };
	if (term.negated) out.negated = true;
	out.value = canonicalValue(term.value);
	return out;
}

/** JSON with object keys emitted in sorted order, so equal structures produce equal bytes. */
export function stableStringify(value: Json, indent = 0): string {
	const render = (node: Json, depth: number): string => {
		const pad = indent ? '\n' + ' '.repeat(indent * (depth + 1)) : '';
		const closePad = indent ? '\n' + ' '.repeat(indent * depth) : '';
		if (node === null || typeof node !== 'object') return JSON.stringify(node);
		if (Array.isArray(node)) {
			if (node.length === 0) return '[]';
			return '[' + node.map((item) => pad + render(item, depth + 1)).join(',') + closePad + ']';
		}
		const keys = Object.keys(node).sort();
		if (keys.length === 0) return '{}';
		return '{' + keys.map((key) => pad + JSON.stringify(key) + ':' + (indent ? ' ' : '') + render(node[key], depth + 1)).join(',') + closePad + '}';
	};
	return render(value, 0);
}

/**
 * Short content fingerprint of a canonical value. The report prints truncated JSON for
 * readability; the fingerprint is what makes the committed bytes change when a value changes
 * past the truncation point, so `--check` cannot miss a regression it did not have room to show.
 */
export function digest(value: Json): string {
	const text = stableStringify(value);
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

export type Difference = {
	/** JSON-pointer-ish location, e.g. `/filter/terms/0/value`. */
	at: string;
	kind: 'value' | 'type' | 'ref-only' | 'harper-only';
	ref?: Json;
	harper?: Json;
};

const typeOf = (node: Json): string => (node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node);

/** Structural difference list between the reference result and the adapted Harper result. */
export function diffCanonical(ref: Json, harper: Json): Difference[] {
	const differences: Difference[] = [];
	walk('', ref, harper, differences);
	return differences;
}

function walk(at: string, ref: Json, harper: Json, out: Difference[]): void {
	if (typeOf(ref) !== typeOf(harper)) {
		out.push({ at, kind: 'type', ref, harper });
		return;
	}
	if (ref === null || typeof ref !== 'object') {
		if (ref !== harper) out.push({ at, kind: 'value', ref, harper });
		return;
	}
	if (Array.isArray(ref) && Array.isArray(harper)) {
		const length = Math.max(ref.length, harper.length);
		for (let index = 0; index < length; index++) {
			const location = `${at}/${index}`;
			if (index >= harper.length) out.push({ at: location, kind: 'ref-only', ref: ref[index] });
			else if (index >= ref.length) out.push({ at: location, kind: 'harper-only', harper: harper[index] });
			else walk(location, ref[index], harper[index], out);
		}
		return;
	}
	const refObject = ref as { [key: string]: Json };
	const harperObject = harper as { [key: string]: Json };
	for (const key of [...new Set([...Object.keys(refObject), ...Object.keys(harperObject)])].sort()) {
		const location = `${at}/${key}`;
		if (!(key in harperObject)) out.push({ at: location, kind: 'ref-only', ref: refObject[key] });
		else if (!(key in refObject)) out.push({ at: location, kind: 'harper-only', harper: harperObject[key] });
		else walk(location, refObject[key], harperObject[key], out);
	}
}
