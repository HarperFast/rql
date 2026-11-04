/**
 * Turning one recorded Harper outcome plus one reference outcome into a classified
 * comparison. Kept out of the CLI so that the end-to-end test builds its comparisons
 * through exactly the same code the runner uses, rather than through a second copy of it.
 */

import type { Case } from './corpus.ts';
import { CORPUS } from './corpus.ts';
import type { Outcome } from './canonical.ts';
import { canonicalize, diffCanonical } from './canonical.ts';
import { decodeTagged, type Tagged } from './tagged.ts';
import { AdapterError, adaptHarperResult } from './harperAdapter.ts';
import { type Classification, type Comparison, classify, partitionDifferences } from './classify.ts';

export type RecordedCase = {
	query: string;
	timedOut?: boolean;
	timeoutMs?: number;
	/** `parseQuery(query)` — the throwing entry point. */
	strict?: RecordedOutcome;
	/** `new RequestTarget('?' + query)` — the production entry point, which defers errors. */
	target?: RecordedOutcome;
};

export type RecordedOutcome = { status: 'ok'; raw: Tagged } | { status: 'error'; name: string; message: string };

/** Map one recorded raw Harper result into the canonical model. */
export function harperOutcome(recorded: RecordedOutcome | undefined, label: string): Outcome {
	if (!recorded) return { status: 'harness-error', error: `the fixture has no "${label}" outcome for this case` };
	if (recorded.status === 'error') return { status: 'rejected', error: `${recorded.name}: ${recorded.message}` };
	if (recorded.status !== 'ok')
		return { status: 'harness-error', error: `unknown recorded status ${String((recorded as { status: string }).status)}` };

	try {
		const adapted = adaptHarperResult(decodeTagged(recorded.raw));
		return adapted.status === 'parsed'
			? { status: 'parsed', canonical: canonicalize(adapted.result) }
			: { status: 'deferred-error', error: adapted.message, canonical: canonicalize(adapted.partial) };
	} catch (error) {
		if (error instanceof AdapterError) return { status: 'adapter-gap', error: error.message };
		return { status: 'harness-error', error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * A recorded `URLSearchParams` (rather than a `Query`) means Harper never parsed the
 * query at all — its fast path, ledger row 1.
 */
export function tookFastPath(recorded: RecordedCase): boolean {
	const strict = recorded.strict;
	return !recorded.timedOut && strict?.status === 'ok' && typeof strict.raw === 'object' && strict.raw !== null && (strict.raw as { $?: string }).$ === 'usp';
}

export function buildComparison(item: Case, reference: Outcome, recorded: RecordedCase): Comparison & { classification: Classification } {
	const harper: Outcome = recorded.timedOut
		? { status: 'timeout', ms: recorded.timeoutMs ?? 0 }
		: harperOutcome(recorded.strict, 'strict');

	const raw =
		reference.status === 'parsed' && harper.status === 'parsed' ? diffCanonical(reference.canonical, harper.canonical) : [];
	// Harper's uninterpreted values would otherwise decorate every other divergence; take
	// them out first and classify what is left (see classify.ts).
	const { residual, valueMode } = partitionDifferences(raw);

	const comparison: Comparison = {
		case: item,
		ref: reference,
		harper,
		differences: residual,
		harperFastPath: tookFastPath(recorded),
		alsoUninterpretedValues: valueMode,
	};
	return { ...comparison, classification: classify(comparison) };
}

// ── the shape of one whole run ──────────────────────────────────────────────

export type LedgerRow = { row: number; divergence: string; class: string; action: string };

export type Ledger = {
	source: { repo: string; issue: number; url: string; title: string };
	fetchedAt: string;
	note?: string;
	rows: LedgerRow[];
};

export type Provenance = {
	harper: { commit: string; describe?: string; dirty?: boolean; version?: string };
	/** The reference-parser revision the fixture was recorded against. */
	reference: { commit: string; describe?: string; dirty?: boolean };
	recordedAt: string;
	corpusDigest: string;
	node: string;
};

export type Fixture = { schema: number; provenance: Provenance; cases: Record<string, RecordedCase> };

/** A Harper outcome recorded from the deferring production entry point, and its reference peer. */
export type Observation = { case: Case; harper: Outcome; ref: Outcome };

export type RunResult = {
	comparisons: (Comparison & { classification: Classification })[];
	deferred: Observation[];
	provenance: Provenance;
	ledger: Ledger;
};

/** Reference-parser outcomes for one query, in both of §6.1's error modes. */
export type ReferenceOutcomes = { strict: Outcome; deferred: Outcome };

/**
 * Assemble a whole run from the recorded fixture plus reference outcomes the caller has
 * already obtained (from the worker in the runner, in-process in the tests).
 */
export function buildRun(
	fixture: Fixture,
	ledger: Ledger,
	referenceOf: (item: Case) => ReferenceOutcomes,
	cases: readonly Case[] = CORPUS
): RunResult {
	const comparisons: RunResult['comparisons'] = [];
	const deferred: Observation[] = [];

	for (const item of cases) {
		const recorded = fixture.cases[item.id];
		const reference = referenceOf(item);
		const comparison = buildComparison(item, reference.strict, recorded);
		comparisons.push(comparison);

		// Ledger rows 8 and 9: the production entry point defers errors instead of throwing.
		// Record it wherever deferring changes what Harper reports.
		if (!recorded.timedOut) {
			const target = harperOutcome(recorded.target, 'target');
			if (target.status !== comparison.harper.status) deferred.push({ case: item, harper: target, ref: reference.deferred });
		}
	}

	return { comparisons, deferred, provenance: fixture.provenance, ledger };
}
