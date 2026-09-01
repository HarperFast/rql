# Differential conformance harness

Runs a corpus of RQL query strings through **both** Harper's REST query parser and the RQL 2.0
reference parser in `src/`, maps Harper's output into the canonical model (§6) with an adapter,
diffs the two, and classifies every difference.

The output is [`conformance-report.md`](./conformance-report.md), which is committed. Spec
Appendix D deliberately tracks no vendor rows — it links to each implementation's own public
ledger — so this harness is what turns Harper's ledger
([HarperFast/harper#2440](https://github.com/HarperFast/harper/issues/2440)) from a hand-written
list into an exhaustive, re-runnable one.

## Running it

```bash
npm run conformance                # replay the recorded fixture and regenerate the report
npm run conformance:check          # fail if the committed report is out of date (CI)
npm test                           # unit tests + an end-to-end replay assertion
npm run typecheck:conformance      # type-checks conformance/, test/conformance/ and src/
```

None of those need a Harper checkout. Only re-recording does:

```bash
HARPER_PATH=../harper npm run conformance:record
```

`HARPER_PATH` must point at a Harper checkout that has been built (`npm install && npm run build`
there) — the harness imports `dist/resources/search.js` and `dist/resources/RequestTarget.js`, and
that import graph pulls in Table/rocksdb-js, so a full install is required. There is no default
path and no implicit search: recording is an explicit act against a named checkout, and the
checkout's commit is stamped into the fixture.

Refresh the cached ledger before trusting a classification:

```bash
npm run conformance:refresh-ledger   # re-reads harper#2440 with the gh CLI
```

## Why record and replay

Harper's parser keeps **module-global state** (`lastIndex` / `currentQuery` / `queryString` in
`resources/search.ts`), so two parses must never interleave. Recording gives every query its own
short-lived process, which makes that structural rather than a convention and contains a crash or
a hang to the one case that caused it. Ordinary runs then replay the committed fixture, which
means:

- CI needs no cross-repo dependency and no build of Harper;
- the report is reproducible — `conformance:check` asserts replay reproduces it byte for byte;
- the adapter is exercised against real recorded host shapes rather than invented ones;
- the Harper revision every classification was made against is recorded, not assumed.

Replay uses **one** persistent reference-parser worker (the reference parser holds no global
state), killed and replaced if a parse exceeds its wall-clock budget, so one pathological case
costs that case and not the run.

## What is in here

| File | |
|---|---|
| `corpus.ts` | The declared corpus. Every case carries the grammar features it exercises and the ledger rows it witnesses. Ids are content hashes, so inserting a case never renumbers the others. |
| `harperAdapter.ts` | Harper's parse output → the canonical model. Structural only: it resolves Harper's comparator vocabulary and shapes, and never re-interprets a value Harper already decoded. |
| `tagged.ts` | Lossless, deterministic encoding of raw Harper output for the fixture — `URLSearchParams`, `Date`, `NaN`, `undefined`, arrays carrying marker properties. |
| `canonical.ts` | Deterministic canonical JSON for a `ParseResult`, plus the structural differ the classification rules match on. |
| `classify.ts` | The rules. Each maps the *shape* of a disagreement (or a named set of witness queries) to a ledger row, a proposed new row, or a reference-parser bug. |
| `compare.ts` | Assembles a run from the fixture plus reference outcomes. Shared by the runner and the tests. |
| `report.ts` | Markdown rendering. Reads only committed data, never the wall clock, so the report is stable. |
| `ledger.json` | A provenance-stamped **cache** of harper#2440. The issue stays canonical. |
| `fixtures/harper-parse.json` | Recorded raw Harper output, stamped with the Harper commit, the reference commit, the Node version and the corpus digest. |
| `../scripts/` | The CLI (`conformance-diff.mjs`), the two workers, and the ledger refresher. |

## Adding a corpus case

Add a `draft(...)` to the right group in `corpus.ts` with the grammar features it exercises, then:

```bash
HARPER_PATH=../harper npm run conformance:record
```

Replay refuses to run against a fixture recorded for a different corpus — the digest is checked —
so there is no way to compare a new case against a stale recording.

If the new case diverges for a reason no rule covers, the run **fails** and prints it. That is the
design: a divergence nobody has classified is not allowed to sit quietly in the report.

## Adding a classification rule

Rules live in `classify.ts` and are tried in order. Prefer a rule that matches the *shape* of the
disagreement (which pointers differ, and how) — it then covers every future case with the same
root cause. Pin a rule to witness queries only where the shape is not distinctive.

Each rule states a rationale citing the spec clause, and a `new` verdict must propose the ledger
row to add. **The specification is never edited from here**; the report proposes rows and a human
carries them to the ledger issue.

Every rule must match at least one corpus case — `test/conformance/replay.test.ts` fails on a rule
that matches nothing, so a rule made obsolete by a Harper fix has to be deleted along with it.

## Scope

This compares **parse** results. Value coercion against a table's declared attribute types,
comparator evaluation and result materialization all happen later, in Harper's `resources/Table.ts`,
and no case here can witness them — the report says so for the ledger rows that describe them.
