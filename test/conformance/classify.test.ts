import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Difference, Outcome } from '../../conformance/canonical.ts';
import type { Case } from '../../conformance/corpus.ts';
import { type Comparison, classify, partitionDifferences } from '../../conformance/classify.ts';

const CASE: Case = { id: 'qtest', query: 'a=1', features: ['form-encoding'] };

const comparison = (overrides: Partial<Comparison>): Comparison => ({
	case: CASE,
	ref: { status: 'parsed', canonical: {} },
	harper: { status: 'parsed', canonical: {} },
	differences: [],
	harperFastPath: false,
	...overrides,
});

const valueDifference = (ref: Difference['ref'], harper: Difference['harper']): Difference => ({
	at: '/filter/terms/0/value',
	kind: 'type',
	ref,
	harper,
});

const parsed: Outcome = { status: 'parsed', canonical: {} };
const rejected: Outcome = { status: 'rejected', error: 'SyntaxViolation: nope' };

describe('partitionDifferences', () => {
	it('removes exactly the differences Harper’s uninterpreted values explain', () => {
		const split = partitionDifferences([valueDifference(3, '3'), valueDifference(true, 'true'), valueDifference(null, 'null')]);
		assert.deepEqual(split.residual, []);
		assert.equal(split.valueMode, true);
	});

	it('keeps a value difference that is NOT just a spelling', () => {
		// A different number, not the same number written as a string.
		const split = partitionDifferences([valueDifference(3, '4')]);
		assert.equal(split.residual.length, 1);
		assert.equal(split.valueMode, false);
	});

	it('keeps differences outside a value position', () => {
		const split = partitionDifferences([{ at: '/filter/terms/0/comparator', kind: 'value', ref: 'eq', harper: 'equals' }]);
		assert.equal(split.residual.length, 1);
		assert.equal(split.valueMode, false);
	});

	it('separates a mixed case into an explained part and a residual', () => {
		const split = partitionDifferences([
			valueDifference(10, '10'),
			{ at: '/filter/terms/0/comparator', kind: 'value', ref: 'contains', harper: 'in' },
		]);
		assert.equal(split.residual.length, 1);
		assert.equal(split.valueMode, true);
	});
});

describe('classify', () => {
	it('calls identical results agreement', () => {
		assert.deepEqual(classify(comparison({})), { verdict: 'agrees' });
	});

	it('calls a shared rejection agreement', () => {
		assert.deepEqual(classify(comparison({ ref: rejected, harper: rejected })), { verdict: 'agrees' });
	});

	it('does NOT call a throw and a deferred error agreement — the deferring side kept a partial', () => {
		const verdict = classify(
			comparison({
				case: { ...CASE, query: 'not=a=witness', features: [] },
				ref: rejected,
				harper: { status: 'deferred-error', error: 'nope', canonical: { limit: 1 } },
			})
		);
		assert.deepEqual(verdict, { verdict: 'unclassified' });
	});

	it('NEGATIVE CONTROL: a pinned witness query is NOT classified when a parse was not observed', () => {
		// `harper-limit-arguments-unvalidated` names `limit(x)` and matches on the query alone.
		// Were an unobserved outcome allowed through, a timed-out reference parse would be
		// reported as that divergence and the run would pass having compared nothing.
		for (const unobserved of [
			{ status: 'timeout', ms: 5000 } as Outcome,
			{ status: 'harness-error', error: 'the reference worker exited (code 1, signal null)' } as Outcome,
			{ status: 'adapter-gap', error: 'unsupported select shape' } as Outcome,
		]) {
			const item = { ...CASE, query: 'limit(x)', features: ['limit', 'adversarial'] };
			assert.deepEqual(classify(comparison({ case: item, ref: unobserved, harper: parsed })), { verdict: 'unclassified' });
			assert.deepEqual(classify(comparison({ case: item, ref: parsed, harper: unobserved })), { verdict: 'unclassified' });
		}
	});

	it('never calls an unobserved parse agreement, on either side', () => {
		const timeout: Outcome = { status: 'timeout', ms: 5000 };
		assert.deepEqual(classify(comparison({ case: { ...CASE, query: 'x=1', features: [] }, ref: timeout, harper: timeout })), {
			verdict: 'unclassified',
		});
		const gap: Outcome = { status: 'adapter-gap', error: 'unknown shape' };
		assert.deepEqual(classify(comparison({ case: { ...CASE, query: 'y=1', features: [] }, ref: gap, harper: gap })), {
			verdict: 'unclassified',
		});
	});

	it('does not attribute an unrelated disagreement to a ledger tag the case happens to carry', () => {
		// The tolerance rule requires Harper to accept where the reference rejects, not merely
		// that the case carries the tag.
		const verdict = classify(
			comparison({
				case: { ...CASE, query: 'foo=ba)r', features: ['tolerance'], ledger: [6] },
				differences: [{ at: '/filter/terms/0/path/0', kind: 'value', ref: 'foo', harper: 'bar' }],
			})
		);
		assert.deepEqual(verdict, { verdict: 'unclassified' });
	});

	it('classifies a case whose only difference was the value mode', () => {
		const verdict = classify(comparison({ differences: [], alsoUninterpretedValues: true }));
		assert.equal(verdict.verdict, 'new');
		assert.equal((verdict as { rule: string }).rule, 'value-not-interpreted');
	});

	it('assigns the fast path to ledger row 1', () => {
		const verdict = classify(comparison({ harperFastPath: true, ref: rejected, harper: parsed }));
		assert.equal(verdict.verdict, 'ledger');
		assert.equal((verdict as { row: number }).row, 1);
	});

	it('assigns a rejected not(...) to ledger row 13', () => {
		const verdict = classify(
			comparison({ case: { ...CASE, query: 'not(a=1)', features: ['not-expr'] }, ref: parsed, harper: rejected })
		);
		assert.equal((verdict as { row: number }).row, 13);
	});

	it('assigns a rejected element condition to ledger row 14', () => {
		const verdict = classify(
			comparison({ case: { ...CASE, query: 'scores[=ge=10]', features: ['elem-cond'] }, ref: parsed, harper: rejected })
		);
		assert.equal((verdict as { row: number }).row, 14);
	});

	it('blames the reference parser for letting a URIError escape', () => {
		const verdict = classify(comparison({ ref: { status: 'rejected', error: 'URIError: URI malformed' }, harper: parsed }));
		assert.equal(verdict.verdict, 'reference-bug');
	});

	it('recognizes the `not_` prefix gap from the shape alone, not from the query string', () => {
		const verdict = classify(
			comparison({
				case: { ...CASE, query: 'anything=not_zzz=1', features: ['not-prefix'] },
				differences: [
					{ at: '/filter/terms/0/comparator', kind: 'value', ref: 'zzz', harper: 'not_zzz' },
					{ at: '/filter/terms/0/negated', kind: 'ref-only', ref: true },
				],
			})
		);
		assert.equal(verdict.verdict, 'new');
		assert.equal((verdict as { rule: string }).rule, 'harper-not-prefix-only-for-a-fixed-base-set');
	});

	it('NEGATIVE CONTROL: an unexplained difference is unclassified, never quietly dropped', () => {
		const verdict = classify(
			comparison({
				case: { ...CASE, query: 'brand.new=1', features: [] },
				differences: [{ at: '/filter/terms/0/path/0', kind: 'value', ref: 'brand', harper: 'purple' }],
			})
		);
		assert.deepEqual(verdict, { verdict: 'unclassified' });
	});

	it('NEGATIVE CONTROL: an unexplained accept/reject split is unclassified', () => {
		assert.deepEqual(classify(comparison({ case: { ...CASE, query: 'nothing=matches=this', features: [] }, ref: rejected, harper: parsed })), {
			verdict: 'unclassified',
		});
	});

	it('NEGATIVE CONTROL: a rule pinned to witness queries does not fire on another query', () => {
		// `harper-missing-out-alias` names `a=out=(1,2)`; the same shape on another query must
		// not inherit its verdict.
		const verdict = classify(
			comparison({
				case: { ...CASE, query: 'z=out=(1,2)', features: ['fiql-alias'] },
				differences: [{ at: '/filter/terms/0/comparator', kind: 'value', ref: 'in', harper: 'out' }],
			})
		);
		assert.deepEqual(verdict, { verdict: 'unclassified' });
	});
});
