/**
 * Lossless, deterministic tagged encoding for raw host-parser output.
 *
 * The recorded fixture must round-trip Harper's parse result exactly — including
 * shapes JSON has no notion of (URLSearchParams, Date, NaN, `undefined`, arrays
 * carrying marker properties such as `select.asArray`) — so that replay feeds the
 * adapter the same values a live run would.
 *
 * Encoding: JSON primitives stay themselves; everything else becomes an object with
 * a `$` discriminator. Plain objects are always wrapped, so a recorded object whose
 * own key is `$` is never confused with a tag. Object keys are emitted sorted, which
 * makes a re-record byte-identical when nothing changed.
 */

export type Tagged =
	| null
	| boolean
	| number
	| string
	| { $: 'undefined' }
	| { $: 'number'; v: string }
	| { $: 'bigint'; v: string }
	| { $: 'date'; iso: string }
	| { $: 'date'; invalid: true }
	| { $: 'error'; name: string; message: string }
	| { $: 'function'; name: string }
	| { $: 'symbol'; v: string }
	| { $: 'usp'; ctor: string; entries: [string, string][]; props?: Record<string, Tagged> }
	| { $: 'array'; items: Tagged[]; props?: Record<string, Tagged> }
	| { $: 'object'; ctor?: string; props: Record<string, Tagged> };

export class TaggedEncodeError extends Error {}

function sortedProps(source: object, keys: string[], seen: Set<object>): Record<string, Tagged> {
	const props: Record<string, Tagged> = {};
	for (const key of [...keys].sort()) props[key] = encodeWith((source as Record<string, unknown>)[key], seen);
	return props;
}

function encodeWith(value: unknown, seen: Set<object>): Tagged {
	if (value === null) return null;
	if (value === undefined) return { $: 'undefined' };

	switch (typeof value) {
		case 'boolean':
		case 'string':
			return value;
		case 'number':
			// NaN/±Infinity/-0 have no JSON spelling but are real Harper outputs (`limit(x)` → NaN).
			return Number.isFinite(value) && !Object.is(value, -0) ? value : { $: 'number', v: String(Object.is(value, -0) ? '-0' : value) };
		case 'bigint':
			return { $: 'bigint', v: String(value) };
		case 'symbol':
			return { $: 'symbol', v: String(value) };
		case 'function':
			return { $: 'function', name: (value as { name?: string }).name ?? '' };
		case 'object':
			break;
		default:
			throw new TaggedEncodeError(`cannot encode ${typeof value}`);
	}

	const object = value as object;
	if (seen.has(object)) throw new TaggedEncodeError('cannot encode a cyclic structure');
	seen.add(object);
	try {
		if (object instanceof Date)
			return Number.isNaN(object.getTime()) ? { $: 'date', invalid: true } : { $: 'date', iso: object.toISOString() };
		if (object instanceof Error) return { $: 'error', name: object.name, message: object.message };
		if (object instanceof URLSearchParams) {
			const own = Object.keys(object);
			const encoded: Tagged = {
				$: 'usp',
				ctor: object.constructor?.name ?? 'URLSearchParams',
				entries: [...object.entries()],
			};
			if (own.length > 0) (encoded as { props?: Record<string, Tagged> }).props = sortedProps(object, own, seen);
			return encoded;
		}
		if (Array.isArray(object)) {
			const markers = Object.keys(object).filter((key) => !/^(?:0|[1-9]\d*)$/.test(key));
			const encoded: Tagged = { $: 'array', items: object.map((item) => encodeWith(item, seen)) };
			if (markers.length > 0) (encoded as { props?: Record<string, Tagged> }).props = sortedProps(object, markers, seen);
			return encoded;
		}
		const ctor = object.constructor?.name;
		const encoded: { $: 'object'; ctor?: string; props: Record<string, Tagged> } = {
			$: 'object',
			props: sortedProps(object, Object.keys(object), seen),
		};
		if (ctor && ctor !== 'Object') encoded.ctor = ctor;
		return encoded;
	} finally {
		seen.delete(object);
	}
}

export function encodeTagged(value: unknown): Tagged {
	return encodeWith(value, new Set());
}

function isTag(value: Tagged): value is Exclude<Tagged, null | boolean | number | string> {
	return typeof value === 'object' && value !== null;
}

export function decodeTagged(value: Tagged): unknown {
	if (!isTag(value)) return value;
	switch (value.$) {
		case 'undefined': return undefined;
		case 'number': return value.v === '-0' ? -0 : Number(value.v);
		case 'bigint': return BigInt(value.v);
		case 'symbol': return Symbol(value.v);
		case 'function': return Object.defineProperty(() => undefined, 'name', { value: value.name });
		case 'date': return 'invalid' in value ? new Date(NaN) : new Date(value.iso);
		case 'error': {
			const error = new Error(value.message);
			error.name = value.name;
			return error;
		}
		case 'usp': {
			const params = new URLSearchParams();
			for (const [key, entry] of value.entries) params.append(key, entry);
			// A recorded RequestTarget is a URLSearchParams carrying the parsed query as own
			// properties (harper `resources/RequestTarget.ts`); replay preserves both halves.
			if (value.props) for (const [key, prop] of Object.entries(value.props)) (params as unknown as Record<string, unknown>)[key] = decodeTagged(prop);
			return params;
		}
		case 'array': {
			const items: unknown[] = value.items.map(decodeTagged);
			if (value.props) for (const [key, prop] of Object.entries(value.props)) (items as unknown as Record<string, unknown>)[key] = decodeTagged(prop);
			return items;
		}
		case 'object': {
			const object: Record<string, unknown> = {};
			for (const [key, prop] of Object.entries(value.props)) object[key] = decodeTagged(prop);
			return object;
		}
	}
}
