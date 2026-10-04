# Post-V1 backlog

Ranked, with the reason each item sits where it does. Nothing here is implemented — phase 12 was a
hardening phase, and a backlog that quietly grows features is not a backlog.

**Not everything already documented as a limitation is P1.** A limitation that is correctly
disclosed, fails safe, and does not block the product promise is often a P2 or a P3 — and saying so
is more useful than a flat list where everything is urgent. Two items below are P3 precisely
because the honest answer is "this may never be worth doing".

| | meaning |
|---|---|
| **P0** | release blocker |
| **P1** | high-value post-V1; changes what a user can learn or do |
| **P2** | useful enhancement; removes a real rough edge |
| **P3** | exploratory; may turn out not to be worth it |

---

## P0 — release blockers

**None.**

That is a claim, so here is what backs it. Three candidates were considered and each was argued
down, on the record:

- **The null-sink construction fallback loses telemetry while reporting `ok: true`.** Examined in
  phase 12 and deliberately not changed. The path is near-unreachable (`openSink` performs no I/O,
  so only a module-load failure reaches the catch), the alternative — a handle that throws — breaks
  a stronger rule, `bytes` is the field that tells the truth, and the returned warning that
  `doctor` surfaces is now pinned as load-bearing. Disclosed in
  [failure-modes.md](failure-modes.md) §7. **It is a known limitation, not a blocker: it loses at
  most observability, never correctness, and never blocks a session.**
- **The release tag format contradicted the workflow that enforces it.** `docs/install.md`
  documented `model-router--v<version>` while `release.yml` triggers on `v*`. Fixed in phase 12,
  because a release instruction nobody can follow is a release blocker and this one was cheap to
  correct.
- **A rejected config value was echoed into a warning that `doctor` prints.** Fixed in phase 12.
  Small, real, and in a project whose stated standard is that anything crossing a boundary is
  redacted.

## P1 — high-value post-V1

### 1. A measured primary-model baseline

Every avoided-token and avoided-cost figure is a **counterfactual estimate**: there is no
measurement of what Claude would actually have ingested, so `chars/4` over hook-proven files stands
in for it. The savings methodology is conservative in every direction and says so, but "estimated"
is doing real work in that sentence and no amount of care turns an estimate into an invoice.

**Why P1 and not P2:** it is the difference between a dashboard that reports what was saved and one
that reports what we think was saved. That is the core product promise, and it is the single item
that would most change what a user can learn.

**Why not P0:** the estimate is labelled as an estimate everywhere, the bundled prices all ship
`null` so a default install reports no dollar figure at all, and a CI step fails if a price appears.
Nothing overstates.

**Shape:** a transcript reader. `docs/benchmark-methodology.md` already states that no primary-model
cost figure can be `actual` until one exists.

### 2. The live generic-vs-intent A/B

Phase 8 attempted this five times and could not produce a gradeable pair: prompt evaluation on the
development machine runs at 22.3 tok/s (**re-measured at 10.6 tok/s in phase 12** on the same
hardware with a different model), so a corpus case needs minutes of reading against a hard ceiling
in Node's HTTP client. The experiment did not run, and **nothing is claimed about intent-aware task
construction in either direction** — not "no effect", not "inconclusive because the model is
noisy", not "promising".

**Why P1:** `hooks.taskIntent.source` ships `none`, and the argument for ever changing that default
is exactly the evidence this would produce. Until it runs, the intent path is a feature nobody can
justify enabling.

**Shape:** GPU hardware, and the offline harness already built. `docs/evaluation.md` explains why
the offline arm cannot answer it — the fixture worker keys its answer off the case id, so quality is
equal by construction and `report.ab` reports `qualityIsMeasured: false`.

### 3. Gemini context discovery

Gemini exports no `describeModel`, so no Gemini context window can be discovered. Capability
resolves `assumed` when the bundled table knows the model and `unknown` otherwise, dispatch falls
back to the 2 MB transport ceiling, and `doctor` warns — correctly.

**Why P1:** it is the one place where a hosted provider is meaningfully less safe than the local
one. An unknown window is never treated as unlimited, so the failure mode is a missed refusal
rather than a silent truncation — but Gemini users get less protection than Ollama users, and
nothing in the configuration lets them fix it.

**Why not P0:** unknown degrades to the byte ceiling rather than to unbounded, and Gemini does not
silently middle-drop — it errors on overflow, which is loud.

### 4. `approvedNotDispatched` is ambiguous

A row that was approved by the gate and by governance and then never dispatched carries no
recoverable cause: `error_code` is null and no routing reason names it. `content_unreadable` and
`content_binary` both land here. The dashboard reports the ambiguity rather than guessing, which is
right, but it is a telemetry gap in a schema whose whole claim is that it is a complete account of
what happened.

**Why P1:** every other row in the store explains itself. **Shape:** likely a new routing reason,
which is additive and needs no `schema_version` bump.

## P2 — useful enhancements

### 5. Outbound file content is not redacted

The filename deny list is the only control on what reaches a worker. Intent text crosses
`redactSecrets()`; **file content does not**, and `test/task.security.test.mjs` pins that exposure
in both directions as a declared disclosure rather than an accident.

**Why P2 and not P1:** this is a deliberate design position, not an oversight. A secret scanner over
outbound content would be probabilistic, and a probabilistic control presented as a guarantee is
worse than a documented absence — it changes behaviour from "we told you we do not do this" to "we
try, and sometimes miss". The deny list is a deterministic control the operator can extend. Raising
this to P1 requires an argument that a scanner's false sense of safety beats an honest gap.

### 6. Provider capability refresh

A discovered capability is cached for the process lifetime (a failure for 30 s). There is no expiry
on a stored record, deliberately: a model's context length does not drift, so discarding a
measurement for age would trade a fact for an unknown. `test/capability.boundary.test.mjs` pins
that a stale record stays usable and keeps its timestamp.

**Why P2:** it only matters if a model is replaced under the same name, which is unusual and
visible in the row's `measuredAt`.

### 7. Usage-silent providers

A provider that reports no usage yields `worker_usage_source: 'missing'` and null token counts, so
every downstream figure for that call is null. Correct — null is never zero — but a provider that
never reports usage is invisible to the savings model.

**Why P2:** both shipped providers report usage. This is a cost of adding a third.

### 8. One import scanner, everywhere

Phase 12 added `test/helpers/imports.mjs` and moved six of the eight local copies onto it. Two
remain by explicit decision, each with its reason recorded in
`REMAINING_LOCAL_SCANNERS`: `routing.capability.test.mjs` mixes specifier checks with raw-source
checks that are the real protection for routing purity, and `test/evals/gates.mjs` produces a
non-advisory gate result, so changing what it scans changes what a benchmark reports — which
CLAUDE.md rule 7 forbids doing by itself.

`scanForCapability` has no `export … from` pattern at all, and `context-budget.mjs` is absent from
its `DELEGATION_PATH`. Both holes are now covered by `test/architecture.graph.test.mjs`, which is
why this is P2 and not P1.

### 9. Telemetry ingestion and SQLite materialisation

JSONL is the durable write-ahead log; nothing turns it into a queryable store. `telemetry.sink`
already declares the planned values and falls back to `jsonl` with a warning, so the config surface
exists.

**Why P2:** `npm run analytics` answers the questions a team actually asks, over a window, by
streaming. This matters at a scale this project has not reached — the 100k-row case takes 2.6
seconds to aggregate.

### 10. A behavioural evaluation runner

`npm run evals` measures routing decisions over a fixed corpus. Nothing measures whether a
delegated answer is *correct* beyond planted facts and vocabulary, and two of the corpus gates are
advisory with a structural false negative: neither catches recombination of real tokens into a false
claim.

**Why P2, not P1:** this is the quality question, and it depends on item 1 and item 2 to be
interpretable at all. Building a grader before there is a baseline to grade against produces a
number with nothing to compare it to.

(The empty `test/behavioural/` directory was removed in phase 12. An empty directory documented as
holding cases is worse than its absence.)

### 13. A per-answer grounding check, with its false-positive rate measured first

`test/evals/evaluators.mjs` already has the machinery: `codePositionTokens()` extracts
identifier-shaped tokens from code position only — inside backticks or quotes, camelCase,
snake_case, `foo()` — which is the design that keeps it off prose words like "structure" and
"declaration". A runtime check would be: every code-position identifier in the worker's answer
must appear in the file content it was given. An answer citing `getUserById` about a file with no
such token is demonstrably fabricated, deterministically, with no model involved.

**Why this is not shipped, and why that is not timidity.** `test/evals/gates.mjs` records the
honest failure profile of the advisory version: false positives are *common* — "roughly one per run
across five dispatch cases" — from legitimate composition (an answer writing `resolveWorkerConfig`
about `resolveWorker` plus `deriveConfig`), prose casing drift, and pluralisation. Rendering that
as a dashboard quality number would be the same overclaiming the rest of this project refuses, just
inverted: a team chasing false positives trusts the report *less*. There is also a structural false
negative it can never fix — recombination of real tokens into a false claim. `decide() calls
resolveWorker()` has every token in the lexicon and is false.

**The sharpened design, and its precondition.** Most of the false positives are *decomposable*:
`resolveWorkerConfig` is a concatenation of present tokens. A check that excluded tokens
decomposable into two or more present tokens, and ignored plurals and possessives, would plausibly
cut the rate far enough to be useful. **That is a hypothesis, and this project does not ship
hypotheses as measurements.** The precondition is a measured false-positive rate over the corpus,
reported the way every other benchmark number here is reported.

**Why P1 and not P2:** it is the only route to a *per-delegation* quality signal that does not
require a primary-model baseline, and it would catch the exact failure the context-budget work
exists to prevent — a confident answer about a prompt the model never fully saw.

(What shipped instead, at V1, is the honest half: the report now leads with an **Answer quality**
section that says `NOT MEASURED` and reports only measured confidence-bounding conditions,
including how many delivered answers came from a worker whose window could not be verified. That
closes the "a healthy dashboard implies good answers" hole without inventing a metric.)

## P3 — exploratory

### 11. Delegation-steering skills

`routing.codeWrite.enforce` is advisory and intercepts nothing; `suggest` does nothing because
nothing steers Claude to a delegation script. The `codeWrite` lane is unreachable.

**Why P3:** CLAUDE.md's seventh non-negotiable is *never delegate reasoning* — debugging,
architecture, security, precise edits and small files stay with Claude. A code-write lane is in
tension with that, and the honest position is that it may never be worth building. It is listed so
that `enforce: 'deny'` on `codeWrite` is understood as inert rather than assumed to work.

### 12. A hook-level latency and governance instrumentation path

`docs/analytics.md` records that hook, governance and capability latency are not instrumented and
report `null`. Phase 12 added harnesses that *measure* governance
(`test/governance.latency.test.mjs`) and the hook (`test/hook.latency.test.mjs`), but no row carries
those numbers.

**Why P3:** the measured values are 0.0015 ms for a default-install governance check and ~80 ms for
a whole hook process against a 20-second deadline. Per-row instrumentation of a cost that small is
telemetry about telemetry.

---

## Explicitly not on this list

- **A `tokens × turns` residency multiplier.** Rejected on the record: Claude Code pays cache
  rates, so the claim would be inflated tenfold or more. `residency_turns` ships `0` unless
  measured, and `residencySource` must say where a non-zero number came from.
- **Feeding `budget_exceeded` into the routing gate.** Rejected on the record. It would let a budget
  rewrite a routing classification and leave a row saying the budget was spent without saying
  whether the read was delegation-worthy at all.
- **Deduplicating `event_id` on read.** See [failure-modes.md](failure-modes.md) §8: silently
  dropping look-alike rows would hide a genuine double-write on a filesystem where append
  atomicity failed.
- **Clamping out-of-range configuration into range.** An operator who asked for a 1 ms timeout and
  silently got 1000 has a configuration nobody wrote. It falls back to the default and warns.
