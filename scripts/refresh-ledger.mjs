#!/usr/bin/env node
/**
 * Refresh `conformance/ledger.json` from Harper's divergence ledger.
 *
 * Spec Appendix D deliberately keeps no vendor rows: it links to each implementation's own
 * public ledger, which for Harper is issue #2440. The harness needs those rows locally to
 * classify a divergence, so it keeps a snapshot — a provenance-stamped CACHE, never a second
 * source of truth. The issue stays canonical; the report prints the snapshot's age and warns
 * when it is stale.
 *
 * Usage: node scripts/refresh-ledger.mjs [--issue N] [--repo owner/name]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};

const repo = option('repo', 'HarperFast/harper');
const issue = Number(option('issue', '2440'));

let raw;
try {
	raw = execFileSync('gh', ['issue', 'view', String(issue), '--repo', repo, '--json', 'title,body,url,number'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
} catch (error) {
	console.error(`Could not read ${repo}#${issue} with the gh CLI: ${error.message}`);
	console.error('Authenticate with `gh auth login`, or edit conformance/ledger.json by hand from the issue.');
	process.exit(2);
}

const issueJson = JSON.parse(raw);
const rows = [];
// The ledger is one Markdown table of `| # | Divergence | Class | Action |`.
for (const line of issueJson.body.split('\n')) {
	const cells = line.trim().match(/^\|(.+)\|$/);
	if (!cells) continue;
	// A cell may hold a code span containing `|` (row 14 does), so mask spans before splitting.
	const spans = [];
	const masked = cells[1].replace(/`[^`]*`/g, (span) => `\u0000${spans.push(span) - 1}\u0000`);
	const parts = masked
		.split('|')
		.map((cell) => cell.replace(/\u0000(\d+)\u0000/g, (_, index) => spans[Number(index)]).trim());
	if (parts.length !== 4) continue;
	const row = Number(parts[0]);
	if (!Number.isInteger(row)) continue;
	rows.push({ row, divergence: parts[1], class: parts[2], action: parts[3] });
}

if (rows.length === 0) {
	console.error(`No ledger rows found in ${issueJson.url} — has the issue's table format changed?`);
	process.exit(2);
}

const ledger = {
	source: { repo, issue: issueJson.number, url: issueJson.url, title: issueJson.title },
	fetchedAt: new Date().toISOString(),
	note: 'Snapshot of Harper’s divergence ledger, cached so the harness can classify offline. The issue is canonical; refresh with `npm run conformance:refresh-ledger`.',
	rows,
};

const target = join(root, 'conformance', 'ledger.json');
writeFileSync(target, JSON.stringify(ledger, null, '\t') + '\n');
console.log(`Wrote ${rows.length} ledger rows from ${issueJson.url} to conformance/ledger.json`);
