# Design note — differential conformance harness

## Intent

Give the RQL 2.0 specification a repeatable, single-command comparison between Harper's REST
query parser and the reference parser in `src/`, so that Harper's divergence ledger
([HarperFast/harper#2440](https://github.com/HarperFast/harper/issues/2440), which spec Appendix D
links to) can be exhaustive rather than hand-assembled, and so that the same command can be re-run
as Harper converges.

## Design assessment

The change adds a tooling directory and touches neither parser's API nor any production
behaviour. One judgement area is load-bearing: **adapter mapping fidelity** — how faithfully
Harper's internal shapes become the canonical model of `src/types.ts`, since an adapter that is
too generous makes divergences disappear and one that is too literal invents them. The planning
gate therefore applied.

## Invariant

For every corpus query, both parsers see exactly the query string; Harper's output is mapped
structurally without reinterpreting any value it already decoded; equal canonical outcomes compare
equal after deterministic serialization; and every unequal outcome appears exactly once in the
generated report under exactly one classification, with an unclassified outcome failing the run.

## Approaches considered

### Different layer — make Harper emit the canonical model

Change `resources/search.ts` so its public parse result already matches `src/types.ts`, and
compare without an adapter. **Rejected:** Harper's parse output is consumed by its request
pipeline in host-specific forms, and changing that production API would fold convergence work into
what is meant to be a diagnostic. Spec §8 explicitly provides for the adapter route.

### Deeper cause — have Harper consume the reference parser

Eliminate drift at the source. **Rejected:** the specification is deliberately an independent
*ideal* definition and Harper converges toward it through a ledger, not by adopting the reference
implementation. Sharing the implementation would also destroy the differential independence that
makes the harness worth running.

### Do less — one witness per known ledger row

Snapshot a single example for each existing row and stop there. **Rejected:** that cannot reach
the grammar coverage the task requires and, by construction, can never surface an *unknown*
divergence — which is most of what the first run actually found.

### Chosen — isolated recording plus deterministic replay

An explicit `--record` command runs each Harper parse in its own short-lived process against a
named `HARPER_PATH` checkout and writes a losslessly tagged fixture stamped with that checkout's
commit. Ordinary runs replay the fixture through a pure adapter, parse the same corpus with a
persistent reference worker (restarted on timeout), diff, classify, and render the committed
report.

## Planning-gate history

The first two `--mode plan` reviews did not clear:

1. `option-set-too-narrow` — the option set had not considered record/replay against live-only.
   Escalated; **ruling: adopt record/replay with a shared corpus and per-case timeouts.**
2. `better-alternative-exists` — record/replay agreed, topology refined. Escalated; **ruling:
   adopt all three refinements** —
   - commit a provenance-stamped snapshot of harper#2440 as a *cache*, with an explicit refresh
     command, treating the issue as canonical and reporting the snapshot's age;
   - per-case subprocesses **only** for live Harper recording; one persistent reference worker,
     restarted on timeout, for replay;
   - deterministic timeout handling, fixture provenance checks, a dedicated child IPC channel,
     negative controls, and package scripts that actually typecheck and run the new tests.

All of that is implemented; nothing about the framing is carried into review as an open
disagreement.

## Components

- `conformance/corpus.ts` — declared, feature-tagged cases with content-hash ids and a digest.
- `conformance/harperAdapter.ts` — structural mapping to `src/types.ts`; five stated rules, the
  load-bearing one being that values pass through untouched.
- `conformance/tagged.ts` — lossless deterministic encoding of raw host values.
- `conformance/canonical.ts` — canonical JSON plus the pointer-addressed differ.
- `conformance/classify.ts` — the residual filter and the ordered rule set.
- `conformance/compare.ts` — run assembly, shared by the runner and the tests.
- `conformance/report.ts` — Markdown rendering from committed data only.
- `scripts/conformance-diff.mjs` — the CLI; `scripts/conformance-record-worker.mjs` and
  `scripts/conformance-ref-worker.mjs` — the two process boundaries;
  `scripts/refresh-ledger.mjs` — the ledger cache refresher.

## Behaviour traces

- Harper is driven through **both** of its entry points. `parseQuery(query)` (no target) throws on
  a recorded error and is what the diff uses — it is also how Harper's own unit tests drive it.
  `new RequestTarget('?' + query)` is the production path: a `URLSearchParams` that also carries
  the parsed query and defers parse errors into `parseError`. Recording both is what lets the
  report confirm ledger rows 8 and 9, neither of which is observable through the throwing path.
- The reference parser is driven in both of §6.1's modes for the same reason.
- Determinism: the report contains no wall-clock value. Provenance timestamps come from the
  fixture and the ledger snapshot, both committed, so `--check` can assert byte equality.

## Failure handling

Recording against a missing or unbuilt checkout fails with an actionable message; replay never
searches for Harper implicitly. A fixture whose schema, corpus digest or case set does not match
fails with the exact refresh command rather than silently mixing revisions. Fixture writes are
atomic. Timeouts are outcomes, not aborts. Tagged encoding refuses cyclic input rather than
looping. An adapter shape that cannot be placed raises `AdapterError` and surfaces as an adapter
gap. Any unclassified divergence exits non-zero.
