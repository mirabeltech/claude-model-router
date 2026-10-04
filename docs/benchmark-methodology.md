# Benchmark methodology

What the numbers in a benchmark run mean, and what they are not worth. The case format, the corpus
and the gates are in [`evaluation.md`](evaluation.md); the savings arithmetic is in
[`savings-methodology.md`](savings-methodology.md) and is not restated here.

> **The eval reuses the shipped math; it never recomputes savings.** A per-case metrics row *is* a
> telemetry event, produced by `buildEvent()`. There is no second calculation to drift from the
> first, and every null rule, status rule and structural zero in `calc.mjs` applies to a benchmark
> figure for free.

The phase this framework was built for opened with a live run that measured **13 corpus tokens
avoided against 179 worker output tokens — a net of −166**, stored unclamped. That is the
justification: the router works as designed, the design may be wrong, and until now there was no
reproducible way to find out.

## One row, one event

`buildEvent()` is called; `emitEvent()` never is. Nothing is written to the user's telemetry store,
no salt file is created, `~/.claude` is never touched. Three consequences:

- `aggregate()` gates on `KNOWN_SCHEMA_VERSIONS.has(row.schema_version)`, so a hand-rolled row would
  be counted `rowsIncompatible` and silently dropped from every total. A `buildEvent` row is the
  only shape the read side accepts.
- `buildEvent` is pure given `now` and `eventId`, so a row is reproducible.
- `identity` is the frozen literal `{session_id: null, project_id: null, project_path: null}`.
  `buildIdentity()` would create a file, and with a `resolveConfig`-built config — which never sets
  `telemetry.dirResolved` — it would create it at a literal `~`-prefixed *relative* path under the
  working directory. The case id travels in `task_id`, as plain text.

An event id is `eval:<case-id>:<sha256-16>`. A sha formatted to look like a UUID would be an invalid
UUIDv4 and, worse, indistinguishable from a production row at a glance; with `session_id` and
`project_id` both null, that prefix is the only in-row signal that a row is synthetic.

### The four states a case can be in

`buildEvent` derives `status` from the **presence** of `result`, so `result` is a three-valued
switch rather than a payload. Pass it wrong and the row is quietly a different kind of row that
still looks plausible.

| state | `result` | `task_type` | `status` | `corpusChars` |
| --- | --- | --- | --- | --- |
| delegated, worker ok | the dispatch result | `bulk_read` | `ok` | chars actually sent |
| delegated, worker error | `null`, with `error` | `bulk_read` | `error` | chars built |
| gate refusal | `null` | `gate_block` | `skipped` | `null` |
| gate said delegate, no worker asked | `null` | `other` | `skipped` | `null` |

The fourth row is not a bug, and working that out cost a thrown error. A `decide`-harness case
exists precisely to stop at the gate: it measures a routing decision and runs no worker. That state
is **not** a delegation, so it must not wear `bulk_read`, and the gate did not block it, so it must
not wear `gate_block`. `other` with `status: 'skipped'` and a null corpus size describes what
happened without claiming a worker ran, and every savings column comes back `unavailable` on its own.
A *dispatch* case in that state is still a framework bug and throws.

`dispatch()` is never called on a non-delegating decision "for uniformity": it would return
`status: 'skipped', reason: 'routing_declined'`, which looks enough like a result that the row would
be stamped `bulk_read` on what is actually a refusal.

## Where a zero would lie

`validate.mjs` passes a literal zero straight through and `calc.mjs`'s `count(0)` is `0`. A
defaulted zero therefore does not fail loudly — it publishes a fabricated measurement.
[`evals.nulls.test.mjs`](../test/evals.nulls.test.mjs) is this table as assertions.

**Three would overstate savings**, which is the one direction of error the project exists to avoid:

| passing `0` for | would | so the eval passes |
| --- | --- | --- |
| `returnedAnswerChars` / `returnedAnswerTokens` | make the net equal the gross — the headline overstatement | `null`, so `buildEvent` derives it from `result.text` with the same method it used for the corpus |
| `corpusChars` | report a measured zero where the truth is unavailable | `null` on every path that built no payload |
| `provenFilesCount` | slip past the inflated-corpus cross-check, which only fires when `filesCount > provenFilesCount` | `null` when the case names no files |

**Others would fabricate a reading**: `inputBytes` from a failed stat (`fileBytes()` returns null —
never `?? 0`), `attempts: 0` (which warns `invalid:attempts` and poisons the one "something looks
wrong" signal the store has), a hand-supplied `charsPerToken: 4` (which duplicates `chars_div_4`
under a label claiming a calibration nobody measured), a pass rate of `0/0`, and a rounded coverage
percentage — `Math.round(0.004 * 100)` is `0` while one row did contribute, so coverage prints as
`k of N`.

Latency has no injectable zero at all: `buildEvalRow` takes no latency argument, so `latency_ms`
comes from `result.latencyMs` and nowhere else. That is the stronger arrangement — there is no call
site at which a zero could be introduced.

**Five zeros are real and must survive** being "hardened" into nulls: a net token change of zero
("this delegation saved nothing" is a finding), `retry_count` on a first-attempt success,
`residency_turns`, `validation_warnings`, and `files_inferred_count` when every file was named.

One distinction is easy to get backwards and is worth stating. On a provider with
`supportsCachedInput: false`, `worker_cached_input_tokens` is **null** — the provider reported
nothing, and the token column reports what was reported — while `worker_cached_input_cost` is **0**
with status `actual`, because the capability flag proves no such billing line exists. Two different
questions, two different answers, the same row.

## The primary arm is structurally unmeasured

> **No primary-model cost figure in this framework can be `actual` until a transcript reader
> exists.**

`primary_usage_status` is `actual` only when `primaryUsage` is non-null *and* `primaryUsageMethod` is
`transcript_measured`. There is no transcript reader, so all six primary fields are null and
`savings-methodology.md` already commits to that. The framework does not paper over it:

- `comparisonComplete` is **derived**, never passed — from `primaryArm.measured` and the status of
  every monetary aggregate — so forgetting a flag cannot mislabel a run. It is structurally `false`
  today and flips only when two real things land.
- `comparisonBlockers` is a closed list: `primary_usage_unmeasured`, `worker_rates_unpriced`,
  `rows_unavailable`, `quality_ungraded`. The first two name different fixes, so they are reported
  separately — an "unpriced" blocker against a fully priced table would send a reader to the wrong
  file.
- `ratio` is **always null**, and the renderer refuses to print any ratio or percentage comparing the
  arms while the comparison is incomplete. A ratio is the most dangerous derived number here:
  unlike every field in the telemetry schema, **it has no `*_status` companion to carry its own
  caveat**, so a reader who sees one has no way to know it was computed over partial data.

Running a second model over the corpus and filing its usage under `primary_*` would be a lie. Those
columns mean the real session's spend, and a reader summing both would double-count. A proxy model
is a **third arm** with its own rows.

### What the primary side genuinely owns

Four real measurements, kept in an `observed` namespace that cannot be read as savings: the corpus
bytes it would have ingested (a real `statSync`), the path overhead every `Read` pays when nothing
delegates, the gate-refusal counts by reason, and the `status` distribution. They are segregated
because a latency delta rendered beside a token delta is how someone eventually writes "40% faster
and 60% cheaper" out of one table.

## Pricing

The chain is passed to `buildEvent()` explicitly and `loadPricing(config)` is never called, so a
`pricing.overrides` file on a developer's disk cannot move a benchmark number.

| chain | effect |
| --- | --- |
| `EVAL_CHAIN_BUNDLED` (default) | the shipped table. Every rate is `null`, so **every monetary field is `unavailable`** with reason `rate_unpriced` |
| `evalPricedChain()` (`--priced`) | `pricingVersion: 'eval-fixture.1'`, round numbers chosen to be checkable by hand |
| `EVAL_CHAIN_NONE` | no table: `lookup: 'no_table'`, `pricing_source: 'none'` |

The default arm reporting no money is **the shipped reality faithfully reproduced**, not a gap. A
benchmark that quietly substituted plausible rates would be measuring a product nobody ships. Out of
the box the only populated headline is `estimated_tokens_avoided`, which is exactly what
`savings-methodology.md` says it should be.

The fixture table's version string could never be mistaken for a real price list, which matters
because every row those rates touch is stamped with it. A `mock:*` row is mandatory in it:
`test/helpers/telemetry-dir.mjs pricedTable()` has gemini, ollama and anthropic rows but no mock
one, so reusing it would yield `lookup: 'model_unknown'` and a silently null cost.

## The threshold sweep

> **The sweep has no notion of better, and exports no function that could acquire one.**

### The selection bias it is built to avoid

The obvious implementation runs the worker once per case and then, per threshold, filters to the rows
that delegated. The denominator shrinks as the threshold rises, so avoided-tokens-per-delegation
climbs monotonically and the table reads as "higher is better" — an endorsement manufactured out of
nothing but selection bias, and one that would look entirely reasonable in review.

So **`rowsTotal` is the full case set at every threshold.** A case that does not delegate is present
as a row contributing `null`, which is what it actually is. `buildEvent` is called once per
`(case, threshold)` — cheap, since it is pure — while the worker still runs once per case, because
its output does not depend on `minBytes`. Coverage then falls as the threshold rises and
`formatAgg` prints `at least 24743 tokens over 2 of 17 events, 15 unmeasured`, which structurally
cannot be read as a recommendation.

A verdict only counts at a threshold where its case actually delegated. At a threshold that retains
the case on the primary model **no answer would exist**, so carrying the verdict forward would credit
a quality pass to a delegation that never happened — and the rate would read identically at every
threshold, which is the kind of number that cannot be wrong and therefore says nothing.

### Three prohibitions

- **No argmax.** No `bestThreshold`, no `recommended`, no sort-by-value. The absence of the function
  is the enforcement; the output carries `selectedThreshold: null` and `recommended: null`
  *explicitly*, because an absent field invites a reader to supply their own answer.
- **No threshold-to-threshold delta.** Subtracting two thresholds' sums adds aggregates to each other
  across different coverage sets, which `aggregate.mjs` refuses by design — it exports no `addAgg`,
  and combination happens per row inside an extractor.
- **No `aggregateGrouped`.** It would need a non-schema `threshold` field on the row.

### A finding the sweep produced immediately

`thresholdMet` ORs its three size signals, so **a file that already clears `minLines` (350)
delegates at any `minBytes`** — even an absurd five megabytes. Three corpus cases are in that
position. Anyone reading a `minBytes` sweep and concluding "a high floor stops delegation" would be
wrong: tuning `minBytes` alone has a floor it cannot go below. That is asserted in
[`evals.sweep.test.mjs`](../test/evals.sweep.test.mjs) rather than left to be rediscovered.

## Latency

Seven series, measured separately and **never summed**. Two overlap by construction —
`total_delegated_path` contains `worker`, which contains `provider` — so a total would double-count,
and the absence of a total is the enforcement.

| series | measured by |
| --- | --- |
| `hook_startup` | spawning the real `pre-tool-use.mjs` child process. The ~70 ms every `Read` pays |
| `routing_decision` | `hrtime` around `decide()` alone |
| `file_load` | re-reading the fixture from disk, as the hook does on its hot path |
| `worker` | the dispatcher's own `latencyMs`, from its two clock reads |
| `provider` | `httpJson`'s delta around `fetch` only |
| `total_delegated_path` | the hook child process, end to end |
| `primary_path_overhead` | the same, on a **refusing** case — the only latency the primary arm owns |

These are machine-dependent and nothing asserts an exact value against them. The artifact is stamped
`deterministic: false`, the report labels them, and the assertions that consume them stay generous —
a flaky performance test gets deleted rather than fixed. `median()` lives in
[`test/helpers/timing.mjs`](../test/helpers/timing.mjs), hoisted out of `hook.latency.test.mjs`, so
the benchmark and the budget test have one producer rather than two definitions of one number.

## Reproducibility

A full `buildEvent` row **cannot** be byte-compared across machines, and the reason looks like a bug
until it is stated: `tz_offset_minutes: -new Date(now).getTimezoneOffset()` is **machine-local**.
Both CI platforms gate, so the same injected `now` yields a different value on Windows than on Linux.
Forcing `process.env.TZ` after startup is unreliable on Windows.

So the framework does not fight it. Three artifacts, because a byte-identical golden and a real
latency series cannot coexist in one file — one of them would have to be lying:

| artifact | compared? |
| --- | --- |
| `rows.jsonl` | no. Every field of every row, recorded |
| `stable.jsonl` | **yes.** The projection, omitting `tz_offset_minutes`, `latency_ms` and `provider_latency_ms`. Two runs on any platform must match byte for byte |
| `timings.json` | no. The seven series, stamped `deterministic: false` |
| `report.json` | no. Routing, quality, metrics, gates, sweep, provenance, nulls preserved |

Nothing in the savings path is projected away. If one of those fields ever varied between runs, that
is a finding about the math, not something to hide. The projection iterates `FIELD_ORDER` rather than
the row's own keys, so two runs cannot differ by key ordering, and it writes `null` explicitly rather
than dropping a key — absent and null are not two ways of saying the same thing.

### Provenance

Every run records: the eval schema version, the corpus fingerprint and case count, the arm, the
provider and model, the pricing version and source, the run seed, the frozen clock, the platform,
architecture and Node version, and the engine's own `POLICY_VERSION`, `PROMPT_VERSION`,
`SCHEMA_VERSION`, `CALC_VERSION`, `CONFIG_VERSION` and `ROUTER_VERSION` — read from the engine, not
re-typed. `modelDependent` is **derived** from the arm, so a live run cannot be filed as reproducible
by forgetting a flag.

The corpus fingerprint is a sha over the sorted `(id, caseVersion, per-file bytes/lines/sha)` tuples,
and a test asserts `corpus.json` matches the corpus on disk. Otherwise a corpus version is a number
somebody forgets to bump, which is to say decoration.

## Determinism, and what the deterministic arm does not prove

The default arm replaces only the **transport**: the provider module, the dispatcher, the retry
wrapper and the payload-size guard are all the real ones, and the mode builder produces the real
prompt. That is the narrowest possible substitution, and it is why the arm can gate CI.

What it proves is the **plumbing**: that a usage block flows through `calc.mjs` and comes out with
the right statuses and the right nulls, that the gate agrees with its expectation, that the gates can
fire. What it does **not** prove is anything about a real model. The usage numbers are synthetic —
derived from prompt and answer lengths so they are reproducible and roughly proportional — and no
conclusion about a real model's token accounting may be drawn from them. The canned answers are
written to satisfy their criteria, so the quality rate on the deterministic arm measures the
**evaluators**, not a model's ability.

Real token counts and a real quality rate need `--arm ollama`, and those results are
**model-dependent, not reproducible, and reported separately**.

## Known limitations

Each of these was verified against the code while building the framework, and each belongs here
rather than in a commit message.

1. **There is no classifier.** `hook/adapter.mjs` hardcodes `taskType: 'bulk_read'`; the three
   `skills/` directories are empty; the hook intercepts only `Read`. Four refusal rules are
   reachable in production, and `task_type_excluded`, `precise_output_requested`, `interactive`,
   `latency_sensitive`, `over_max_files`, `minLines` and `minEstimatedTokens` are all dead from the
   hook. The protected-category guarantee is vacuous, and safe because it is vacuous.
2. **The hook sends one file and no question.** Multi-file behaviour and any per-case task are
   measurable only at the dispatch layer, so the corpus cannot claim either through the hook.
3. **Nothing redacts outbound file content.** The filename deny list is the only control. Pinned as
   a declared exposure rather than fixed, because fixing it would change the dispatch path.
4. **Committed fixture bytes depend on the checkout.** `core.autocrlf` is effectively true on
   Windows. `.gitattributes` now pins `* text=auto eol=lf` and names the fixture trees explicitly,
   so a fresh checkout is LF everywhere — but that is a repository setting a consumer can override,
   not a property of the bytes. Generated fixtures sidestep it entirely; the four committed ones are
   also LF-normalised before measurement.
5. **`tz_offset_minutes` is machine-local**, so the golden artifact is a projection.
6. **`mock` caps a payload at 64 000 bytes.** The loader rejects a dispatch case over 60 000 with a
   named error, so a contributor adding a 70 KB fixture is told why rather than blaming the provider.
7. **Deny globs match any path segment, including a case directory's name.** Guarded by
   `accidental_deny_glob`.
8. **The corpus measures accuracy on planted facts and vocabulary everywhere else.** No deterministic
   evaluator establishes that a summary is true.
9. **`no_invented_entities` and `no_claimed_side_effects` are advisory**, with a structural false
   negative: neither catches recombination of real tokens into a false claim.
10. **No primary-model figure can be `actual`**, and `estimated_net_savings` can never be `actual` in
    any `calc_version`, forever — one operand is always a counterfactual.

## And the standing rule

A benchmark run is evidence. It does not change `routing.bulkRead.minBytes`, it does not widen
`DELEGATABLE_TASK_TYPES`, and it does not relax a deny glob. Any of those remains a deliberate
change to [`config.mjs`](../plugins/model-router/lib/config.mjs) or
[`routing-policy.mjs`](../plugins/model-router/lib/routing-policy.mjs), argued on its own terms, and
CLAUDE.md #6 still requires a negative eval alongside it — which is what
[`evals.protected.test.mjs`](../test/evals.protected.test.mjs) is for.

## The A/B dimension (Phase 7)

`npm run evals -- --ab` runs the corpus twice, once per worker-task construction, and reports the
two side by side. One variable moves: both passes share the corpus, the routing decision, the
files, the provider, the model and the config, and the task sentence itself is identical because a
case without a declared `taskIntent` falls back to its own `task`. Only the requirements block
differs.

Each variant is a **full independent pass** — its own rows, verdicts, metrics and gates. Threading
a variant through one pass instead would collide on the bare case id in three places that silently
keep only one variant: `verdictMap`, the quality extractor and the confusion table. Gates run per
pass too, so a leak in one construction cannot be averaged away by the other.

`generic` takes an empty `eventIdSuffix`, so a default run's `stable.jsonl` is byte-identical to
the artifact this runner produced before the dimension existed; `intent` takes `#intent`, a
different separator from the sweep's `@<minBytes>` so a variant row cannot be mistaken for a
threshold point.

### What the A/B table may not say

**No delta, no ratio, no percentage between variants.** `COMPARISON_BLOCKERS` is a closed list with
no member for "this dimension is not measurable offline", and an uncaveated derived number is the
most dangerous thing a report can carry.

**Quality cannot be compared offline at all, and the block says so** via a `qualityIsMeasured`
field derived from the arm. `fixture-worker.mjs` keys its canned answer off the case id in the URL
and never off the prompt, so an intent-aware prompt gets the identical authored answer back and the
two variants' quality is equal **by construction**. A delta computed from that would measure the
fixture.

**Per-variant authored answers were considered and rejected.** Giving the intent variant its own,
better `answers/` file would let whoever wrote it decide which construction wins — manufacturing
"intent-aware scores higher" out of nothing but prose. The same argument as
"the canned answers are written to satisfy their criteria", one step further.

### What it does measure, honestly

Prompt characters, `worker_input_tokens`, `worker_output_tokens`, `estimated_tokens_avoided`, cost
status, latency series, routing agreement and gate results — **per case**, lifted straight off the
row, nothing summed or divided. Synthetic usage rises on the intent arm because `usageFor` derives
from prompt length; that is correct, deterministic, and the reason `prompt_version` differs.

Real quality needs `--ab --arm ollama`, and those results are model-dependent, not reproducible,
and reported separately.

### The standing rule still stands

An A/B result is evidence. It did not make the intent construction the default:
`hooks.taskIntent.source` ships as `none`. Promoting it remains a deliberate change to
[`config.mjs`](../plugins/model-router/lib/config.mjs), argued on its own terms.

## The knob sweep has no notion of better either (phase 8)

`sweepKnobs()` extends the threshold sweep to five routing knobs. Every prohibition carries
over verbatim, and one is added.

**No argmax, per knob or across knobs.** `selected` and `recommended` are written as explicit
nulls, and the module exports no `bestKnob`, `recommendKnob`, `bestConfiguration`,
`rankKnobs`, `scoreKnob` or `optimise`. The absence of the function is the enforcement;
`test/evals.sweep.test.mjs` asserts the absence, including the five new spellings a
multi-knob sweep invites.

**No cross-knob comparison.** Five knobs is five independent measurements, not a leaderboard.
Ranking them would require a single objective function over quality, cost and latency — and
cost is unavailable by default, so two of the three terms cannot be evaluated.

**New: a knob that cannot move anything must say so.** Measurability is computed, by asking
whether the delegating set changes across the points, and it is printed *before* any numbers.
Six numerically identical rows are not a neutral presentation of a null result: they imply a
resolution the measurement has not got, and invite a reader to pick the row they prefer. This
is the same reasoning that dropped the brief's 1/4/8 KB `minBytes` points.

## Phase 8 restated the standing rule

A benchmark run is still evidence. It did not change `routing.bulkRead.minBytes`, it did not
widen `DELEGATABLE_TASK_TYPES`, it did not relax a deny glob, and it did not promote
`hooks.taskIntent.source` from `none`. `docs/phase-8-findings.md` records verdict **A — no
production routing change justified**, and names why the measurements required to justify one
are not available.

What phase 8 *did* change is correctness, not policy: a prompt that cannot fit the worker
model is now refused rather than silently truncated. That is a bug fix argued on its own
terms in `docs/worker-capability.md`, not a threshold tuned by a benchmark. The distinction
matters, because the standing rule only works if "the benchmark told me to" is never an
available argument.

## A live arm needs a different worker budget than production (phase 8)

The shipped `worker.timeoutMs` (180 s) and `worker.maxRetries` (2) are sized for a hosted
provider. A local CPU-only model is one to two orders of magnitude slower per token, and
running a benchmark under the shipped values produced a measured confound rather than a result:

| variant | status | worker latency |
| --- | --- | --- |
| generic | error: timeout | 541,357 ms = 3 x 180 s |
| intent | ok | 141,709 ms |

The generic variant's prompt needed ~262 s of evaluation at the measured 12.6 tok/s, so it
could never complete inside 180 s. Its three doomed attempts then warmed the model for the
variant that ran next. The apparent effect was running order.

So `EVAL_ARMS` gives every live arm `timeoutMs: 900_000, maxRetries: 0`, and the model is
warmed at the requested window before a run. **`maxRetries: 0` is the important half:** a
retry cannot fix a timeout caused by arithmetic, and a retry that warms a shared cache
transfers an advantage to whatever is measured next. The deterministic `mock` arm keeps the
shipped values, because its purpose is that the timeout and retry paths behave as they ship.

The general rule this is an instance of: **a benchmark must not let one measurement change the
conditions of the next.** Warm caches, model residency and retry side effects all do, and none
of them is visible in a pass rate.
