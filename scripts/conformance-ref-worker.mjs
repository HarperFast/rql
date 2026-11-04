#!/usr/bin/env node
/**
 * Persistent worker for the RQL 2.0 reference parser.
 *
 * The reference parser runs out-of-process so that a pathological case cannot wedge the
 * whole corpus run: the parent gives every parse a wall-clock budget and, on a timeout,
 * kills and restarts this worker rather than waiting. One long-lived process is enough
 * here — unlike the Harper recorder, the reference parser holds no module-global state —
 * and it keeps replay fast.
 *
 * Protocol (Node IPC, so the parser's own stdout/stderr can never corrupt it):
 *   parent → { type: 'parse', id, query }
 *   child  → { type: 'result', id, strict, deferred }
 */
import { canonicalize } from '../conformance/canonical.ts';
import { parseQuery } from '../src/index.ts';

const describe = (error) =>
	error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;

function strictOutcome(query) {
	try {
		return { status: 'parsed', canonical: canonicalize(parseQuery(query)) };
	} catch (error) {
		return { status: 'rejected', error: describe(error) };
	}
}

/** §6.1's optional deferred-error mode, for comparison against Harper's (ledger row 8). */
function deferredOutcome(query) {
	try {
		const result = parseQuery(query, { deferErrors: true });
		const { parseError, ...rest } = result;
		if (parseError) return { status: 'deferred-error', error: describe(parseError), canonical: canonicalize(rest) };
		return { status: 'parsed', canonical: canonicalize(rest) };
	} catch (error) {
		return { status: 'rejected', error: describe(error) };
	}
}

process.on('message', (message) => {
	if (message?.type !== 'parse') return;
	let strict;
	let deferred;
	try {
		strict = strictOutcome(message.query);
		deferred = deferredOutcome(message.query);
	} catch (error) {
		strict = { status: 'harness-error', error: describe(error) };
		deferred = strict;
	}
	process.send({ type: 'result', id: message.id, strict, deferred });
});

process.send({ type: 'ready' });
