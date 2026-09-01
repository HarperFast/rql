#!/usr/bin/env node
/**
 * One-shot worker that records Harper's parse of a single query string.
 *
 * Harper's parser keeps module-global state (`lastIndex` / `currentQuery` / `queryString`
 * in `resources/search.ts`), so two parses must never interleave. Giving each case its own
 * short-lived process makes that structural rather than a convention, and it also contains
 * a crash or a hang to the one case that caused it.
 *
 * Two shapes are recorded per query, because Harper has two entry points and they behave
 * differently:
 *   - `strict`: `parseQuery(query)` with no target — how Harper's own unit tests drive it.
 *     Recorded errors surface as a throw.
 *   - `target`: `new RequestTarget('?' + query)` — the production path, a URLSearchParams
 *     that also carries the parsed query, and which defers parse errors into `parseError`
 *     instead of throwing (ledger rows 1 and 8).
 *
 * Protocol (Node IPC): parent → { type: 'record', query }, child → { type: 'recorded', ... }.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { encodeTagged } from '../conformance/tagged.ts';

const harperPath = process.env.HARPER_PATH;
const describe = (error) =>
	error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };

const importFromHarper = (relative) => import(pathToFileURL(join(harperPath, relative)).href);

async function main() {
	const { parseQuery } = await importFromHarper('dist/resources/search.js');
	const { RequestTarget } = await importFromHarper('dist/resources/RequestTarget.js');

	process.on('message', (message) => {
		if (message?.type !== 'record') return;
		const query = message.query;

		let strict;
		try {
			strict = { status: 'ok', raw: encodeTagged(parseQuery(query)) };
		} catch (error) {
			strict = { status: 'error', ...describe(error) };
		}

		let target;
		try {
			target = { status: 'ok', raw: encodeTagged(new RequestTarget(`?${query}`)) };
		} catch (error) {
			target = { status: 'error', ...describe(error) };
		}

		// Exit only once the message has actually been flushed to the parent — `process.send`
		// is asynchronous, and Harper's module graph leaves handles open (config, sockets), so
		// neither a bare `process.exit()` nor waiting for a natural exit is safe.
		process.send({ type: 'recorded', strict, target }, () => process.exit(0));
	});

	process.send({ type: 'ready' });
}

main().catch((error) => {
	if (process.send) process.send({ type: 'fatal', ...describe(error) });
	process.exit(1);
});
