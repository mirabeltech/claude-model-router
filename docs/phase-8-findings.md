# Phase 8 findings

Evidence first, then exactly one verdict. This document does not change production policy;
`docs/benchmark-methodology.md` holds the standing rule that a benchmark result never does.

---

## 1. The Phase 7 root cause was misattributed

Phase 7 concluded that a live quality failure came from `worker.maxOutputTokens = 8192`
reserving generation space out of a 4096-token context, leaving only ~2060 tokens of prompt.

**That is refuted.** Measured against the live daemon:

| prompt | `num_predict` | `num_ctx` sent | `prompt_eval_count` |
| --- | --- | --- | --- |
| 17,368 tok | 1 | — | **2060** |
| 17,368 tok | 8192 | — | **2060** |
| ~4,100 tok | 32 | — | **2060** |

`prompt_eval_count` is invariant across an 8192× change in `num_predict`. Output reservation
is not the mechanism.

### What was actually happening

Ollama sizes its serving window from **available memory**, then silently truncates an
over-long prompt by **dropping the middle** and keeping head and tail. A probe with a value
planted at line 500 of 1000 did not recover it, while a 17k-token probe reproduced both its
end markers. The window is not a constant: an earlier session observed 3985 on the same
model where this one observed 2060.

Consequence before this phase: a bulk read could be delegated, report success, and return a
summary derived from roughly half the bytes it was paid to send — with nothing in the
response indicating a problem.

### The fix works, and it is not sufficient

| `num_ctx` sent | `prompt_eval_count` | middle fact recovered? |
| --- | --- | --- |
| — | 2060 | no |
| `8192` | **4108** | **no** |

The whole prompt now reaches the model. The model still answered wrongly. **There are two
independent causes of a missed buried fact, and only the first is a router defect.** This is
the single most important finding in the phase, and it bounds what any task-construction
change could possibly achieve.

Full measurement log: `docs/worker-capability.md` §1.

---

## 2. Routing knob measurability

Measured by sweeping each knob independently over the 26-case corpus and asking whether the
set of delegating cases changes at all. Measurability is **computed, not asserted** — see
`test/evals/sweep.mjs`.

| knob | measurable? | cases that respond | note |
| --- | --- | --- | --- |
| `minBytes` | **yes** | 9 | delegation falls 15 → 6 across 1 KB … 50 KB |
| `minLines` | **yes** | 3 | ships at 350 |
| `minEstimatedTokens` | **no** | 0 | ships `null`; no case supplies the input, so the rule can never fire |
| `maxFiles` | yes, coarsely | 1 | corpus tops out at three files per case |
| `minFiles` | yes, trivially | 13 | raising it to 2 collapses delegation from 14 to 1 |

`decide()` guards every size clause with `isKnown(x) && x >= t`, so a field no case declares
can never fire its rule. `minEstimatedTokens` is therefore reported as a sentence rather than
as six numerically identical rows, because a flat table implies a resolution the measurement
has not got.

**Correction to an earlier estimate.** `minLines` was predicted to move only one case, from
counting explicit `routingInput.lineCount` declarations. It moves three: the harness derives
`lineCount` from file metadata for `decide` cases. The prediction was wrong and the
measurement stands.

---

## 3. Generic vs intent-aware task construction

> ### NOT MEASURED. The experiment could not be run on this hardware.
>
> Five attempts, no gradeable pair. The blocker is a hard 300-second ceiling in Node's HTTP
> client against a machine that needs ~191 seconds to *read* a corpus prompt. Each attempt
> found and fixed a real defect on the way, and those fixes are the phase's actual output —
> but **no generic-vs-intent quality comparison exists**, and none is reported.

This section is not filled from the offline arm, because the offline arm **cannot** answer the
question: `test/evals/fixture-worker.mjs` keys its answer off the case id in the request URL
and never off the prompt, so both variants receive a byte-identical authored answer and quality
is equal by construction. Substituting that for a live result is the specific failure the brief
warns against.

The experiment that is running:

| arm | model | context | cases | calls |
| --- | --- | --- | --- | --- |
| `ollama` | `llama3:latest` | 8192 | 9 of 11 (2 refused as over-context) | 18 |
| `ollama-mistral` | `mistral:latest` | 32768 | 11 of 11 | 22 |

Everything else is held identical: same corpus, same routing decisions, same provider, same
configuration, same thresholds, same files, same evaluation criteria. Only `taskIntent`
reaching `buildWorkerTask` differs.

**Why two arms.** With `llama3` alone, a quality difference could not be told apart from "the
model's window was too small for this case" — the two explanations are confounded. A
32768-token model over the same corpus separates them.

**What the result is already constrained by.** §1 showed that fixing truncation did *not* fix
the probe's answer: the model was shown every byte and still answered wrongly. So there is a
known second cause of a missed buried fact that task construction cannot address, and a null
result here would be consistent with that rather than surprising.

Expected to be weakly powered regardless: 9-11 cases, a nondeterministic model, CPU-only. All
four of Part 8's outcomes stay open until the numbers exist, and "inconclusive" is the honest
default rather than a fallback.

### Feasibility, measured the hard way

**The full two-arm run did not complete.** It was stopped at a two-hour limit having produced
**no artifacts at all** — not even the first arm's first pass. Two causes, and both are worth
recording because both were underestimated:

1. **The runner persists nothing until every pass finishes.** A killed run yields zero rows,
   however much inference it did. For a multi-hour live arm that is the wrong durability
   model: results should land per case.
2. **The throughput estimate was wrong.** It projected ~1.9 h for the llama3 arm from a
   measured 12.6 tok/s prompt-eval rate. Two hours was not enough. Model reloads between
   differently-sized requests and the hook cases' child processes are the likely difference,
   but the estimate was not re-validated before being relied on, which is the actual mistake.

So the live comparison is run **case by case**, each invocation writing its own artifacts, over
the five `intent-*` cases — the ones built for exactly this comparison in phase 7, each
declaring a `taskIntent` and each planting a fact that stopping early or summarising would
miss. That is a smaller experiment than the brief asks for, and it is reported as such rather
than extrapolated to the cases that did not run.

### The first attempt produced a confound, not a result

The first live pair over `intent-buried-in-repetition` came back like this:

| variant | status | worker latency | tokens in / out | quality |
| --- | --- | --- | --- | --- |
| generic | **error: timeout** | 541,357 ms | — | `null` (no output) |
| intent | ok | 141,709 ms | 4265 / 30 | `false` |

Read naively that says intent-aware construction is dramatically better. **It says nothing of
the kind,** and the arithmetic shows why:

- 541,357 ms is exactly three attempts against the shipped 180-second provider timeout.
- CPU-only prompt evaluation here runs at about 12.6 tok/s, so a ~3,300-token prompt needs
  ~262 seconds. The generic variant **could never have completed** inside 180 s.
- It ran first, burned three doomed attempts, and in doing so **warmed the model** for the
  intent variant that followed — which is why the larger prompt then finished in 141 s.

So the variable that moved was running order and cache warmth, not task construction. Two
corrections, neither touching the product:

| setting | mock arm | live arms | why |
| --- | --- | --- | --- |
| `worker.timeoutMs` | 180,000 (shipped) | 900,000 | the shipped default is sized for a hosted provider; a local CPU model is one to two orders of magnitude slower per token |
| `worker.maxRetries` | 2 (shipped) | **0** | a retry cannot fix a timeout caused by arithmetic, so it triples the cost of a doomed call and changes no answer — and silently warms the model for whatever runs next |

The model is also warmed at the requested window before a run, so neither variant absorbs the
~8.5 s allocation plus page-in.

### A third confound, and a product bug behind it

Re-running the pair warm, with the timeout raised to 900 s, the generic variant **still
failed** — at 305,152 ms, nowhere near 900 s, with `error_code: transport`.

That is Node's own HTTP client. Its `headersTimeout` defaults to **300 s**, and `fetch` offers
no standard way to raise it, so **`worker.timeoutMs` is unreachable above ~300,000 whatever the
config says** — the spec permits thirty minutes. Two real product defects followed, both now
fixed:

1. **Misclassification.** The runtime's timeout surfaced as `transport`, i.e. "network
   failure", pointing an operator at their network instead of at their model. It is now
   detected by its `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` cause and reported as
   `timeout`, naming the ceiling that actually applied.
2. **A doomed call was retried.** `transport` is in `RETRYABLE`, so a request that could not
   possibly fit the budget was attempted three times — which is precisely where the first
   run's 541 s came from, and where the cache warming that flattered the intent variant came
   from. `router doctor` now WARNs when `worker.timeoutMs` exceeds what the runtime will wait.

And one more cause, the subtlest of the three. Warm prompt evaluation measures about **67
tok/s**, so a 4,265-token prompt is ~63 s of evaluation — not 305. The generic variant was not
slow to *read*; it was slow to *stop*. With `maxOutputTokens` at the shipped 8192, the budget
caps output to whatever the window has spare — 4,891 tokens here — and the generic prompt,
lacking the requirements block that tells it to be specific, generated until it hit the wall.
The intent variant answered in **30 tokens**.

**That is a genuine difference in worker behaviour, and it still cannot be read as a quality
result**, because one side has no answer to grade. So both variants now get the same modest
512-token ceiling: every corpus answer is a short factual finding, 512 is generous for one, and
it keeps every call well inside the wall — which is what makes the two sides comparable at all.

Three confounds, all of which would have produced "intent is dramatically better" from a run
whose variable was never task construction.

### The detector caught a bug in this phase's own code

With output bounded to 512 and the model warm, the pair came back:

| variant | error | truncation detected |
| --- | --- | --- |
| generic | `timeout` | `null` |
| intent | **`context_exceeded`** | **`true`** |

The intent variant was silently truncated **even though `num_ctx` was being sent** — which is
supposed to be the whole point of sending it. The arithmetic:

```
estimate (chars/4)        3,301 tokens
output request              512 tokens
num_ctx asked for   bucket(3,813) = 4,096
REAL prompt               4,265 tokens      <-- larger than the window we asked for
```

`chars/4` under-counts code. Sizing a *window* from that estimate asks for less than the prompt
will actually need, Ollama truncates in silence, and the post-hoc detector discards the answer.
**The bug was in `requiredContextTokens`, written in this phase**, and the detector written
alongside it is what surfaced it.

The fix is a `WINDOW_SIZING_MARGIN` of 1.35 — the inverse of ~3 bytes per token against the
assumed 4, i.e. the worst realistic case rather than the average — applied to the input estimate
only when sizing a window. The output request is not marked up: we chose that number and know
it exactly. Everywhere else the under-count stays, because everywhere else it is conservative:
it makes a fit decision cautious and it keeps the truncation detector quiet on a healthy call.

`test/context-budget.test.mjs` pins the exact case, by its real measured numbers, so it cannot
come back.

**The lesson is about which direction an estimate is allowed to be wrong in.** The same
`chars/4` figure is safe as a lower bound on a cost and unsafe as a lower bound on a capacity
requirement, and this design had already written that down for `estimateTokensFromBytes` versus
`capacityTokensFromBytes` — then violated it one function later.

### Why it still could not be measured

With all four defects fixed — full window, no truncation, no retries, bounded output, pinned
temperature — **both variants still timed out.** Reducing the output cap to 192 and then to 96
changed nothing, which was the clue: output was never the bottleneck.

Measured directly, with a bare `fetch` and no harness in the way:

| | rate |
| --- | --- |
| prompt evaluation | **22.3 tok/s** |
| generation | **6.4 tok/s** |

A corpus case is ~4,265 real prompt tokens, so **~191 seconds of prompt evaluation before a
single token is produced**, against a ceiling of 300. A bare `fetch` with a corpus-sized prompt
hit `UND_ERR_HEADERS_TIMEOUT` with no eval code involved at all.

Throughput also degraded across the session: an early warm call managed ~77 tok/s, the same
shape later measured 22.3, and a `num_predict: 1` warm-up once took 4.9 minutes. Repeated
multi-gigabyte KV allocations and page-cache pressure are the likely cause. A platform whose
throughput moves by 3x is not one a quality comparison can be run on — at 22 tok/s a case
finishes inside the budget, at 15 it does not, and which happens is machine load.

### What this does and does not license saying

**Supported:** the live comparison was not performed. Part 8's outcome 4 — *"result remains
inconclusive"* — is the finding, for a concrete and documented reason.

**Also supported, and worth keeping:** one observation survived, from the single call that
completed before the caps were tightened. Given the whole prompt and no truncation, llama3
answered `intent-buried-in-repetition` in 30 tokens and **failed** its quality criteria
(`lineCitations`). That is consistent with §1 — fixing truncation did not fix the answer — and
it is one sample, on one case, on one model. It is not evidence about intent-aware
construction, because the generic side of that pair never returned.

**Not supported, and not claimed:** anything about whether intent-aware tasks improve quality.
Not "no effect", not "inconclusive because the model is noisy", not "intent looked promising".
The experiment did not run.

### What would be needed

1. A GPU, or any host where a 4k-token prompt evaluates in seconds rather than minutes. This is
   the whole blocker; everything below is secondary.
2. Per-case artifact persistence in the runner, so a long arm that is interrupted keeps what it
   finished. Added here in practice by invoking `--case` per case; the runner itself still
   writes nothing until every pass completes.
3. A transport that can wait longer than 300 s, if slow hosts are to be supported at all —
   which means replacing `fetch` with `node:http`, and is deliberately out of scope.

**This is what "do not average away individual failures" is for.** Averaged, the pair above
would have contributed one pass and one null to a rate and read as a win. The individual
failure *was* the finding.

**An observation, not acted on.** The two variants would be far cheaper to compare if the
`# Requirements` block were emitted *after* `# Files` rather than before it: the two prompts
would then share the long file-content prefix and a runtime's prompt cache could serve the
second variant almost free. As the template stands, the prefixes diverge at the top and every
byte is re-evaluated per variant. Reordering would change prompt semantics and bump both
version counters again, so it is left alone and noted.

## 4. Negative savings

**Zero cases** across every knob and every sweep point have
`estimated_tokens_avoided < 0`.

The correlation analysis Part 11 asks for therefore has no data to run on in this corpus,
and reporting correlations over an empty set would be worse than reporting none. The
machine-readable per-case report (`report.json` → `knobSweep[].points[].negativeSavings`)
carries the operands — tokens avoided, returned answer tokens, worker output, input bytes,
latency, quality verdict, context window and truncation flag — so it will populate the moment
a negative case exists.

Known context, from `docs/benchmark-methodology.md`: a live run earlier in the project
measured 13 corpus tokens avoided against 179 worker output tokens, a net of −166. That shape
is real; it simply does not occur in the current corpus, whose dispatch cases are all
≥ 12 KB.

---

## 5. Latency

Seven series, measured separately and **never summed** — `total_delegated_path` contains
`worker`, which contains `provider`. No derived single score is proposed:

- Part 12 requires any derived metric to be defined mathematically with every assumption
  documented.
- Pricing is unavailable by default, so the only available denominator would be tokens, which
  would reintroduce exactly the kind of inflated composite CLAUDE.md forbids.

So the series are reported side by side against tokens avoided, worker output and quality,
and no dollar figure appears while pricing is unavailable.

Two new latency facts worth recording.

**A refusal is fast.** A `context_exceeded` refusal costs **~0.1 s** and opens no socket,
where the same request previously spent minutes of local inference to return a confabulated
summary. The end-to-end hook smoke test on a 44 KB file now falls open in **661 ms**.
Refusing early is faster than succeeding badly.

**Changing the requested context window costs a model reload.** Measured:

| call | `num_ctx` | total | `load_duration` |
| --- | --- | --- | --- |
| first | 8192 | 12.3 s | 10.0 s |
| repeat | 8192 | **1.0 s** | **0.0 s** |
| changed | 4096 | 11.0 s | 8.5 s |
| repeat | 4096 | **1.0 s** | **0.0 s** |

About 8.5 s of pure load time, against a 20-second hook budget. This is why `num_ctx` is
snapped to coarse buckets rather than to the exact need: fine-grained rounding would make
successive reads of similar files evict each other's allocation, and a delegation that blows
the hook budget is a delegation wasted. It is also a latency component that belongs to
neither `worker` nor `provider` cleanly — it is paid inside the provider call but caused by
the *previous* call's parameters, and the seven series do not model that.

---

## 6. Cost

Unavailable, by default and by design. The bundled pricing chain reports no money, so:

- `worker_total_cost` is `null` with status `unavailable`
- `estimated_net_savings` is `null` for the same reason
- no cost-based conclusion is drawn anywhere in this document

`docs/benchmark-methodology.md` §"No primary-model cost figure in this framework can be
`actual` until a transcript reader exists" still holds.

---

## 7. Verdict

> ### A — No production routing change is justified.
>
> Stated on the sweep, cost and measurability evidence, which is complete. The live
> generic-vs-intent comparison (§3) is still running; it can only bear on whether
> `hooks.taskIntent.source` should be promoted, which is a separate decision from a routing
> threshold and which stays `none` either way until argued on its own terms.

Part 10 forbids reporting an optimal threshold unless the objective function is explicitly
defined **and all required measurements are available**. They are not:

1. One knob is richly measurable, one moves three cases, one moves none, and two are coarse.
2. Cost is unavailable, so two of the three terms any sensible objective function would need
   cannot be evaluated.
3. Quality on the deterministic arm measures the **evaluators**, not a model: the fixture
   worker keys its answer off the case id and never off the prompt.
4. The live arms are nondeterministic, CPU-bound and cover 9–11 cases. Any difference they
   show is weakly powered.

Every shipped default is therefore **unchanged**:

| knob | value | status |
| --- | --- | --- |
| `routing.bulkRead.minBytes` | 12000 | unchanged |
| `routing.bulkRead.minLines` | 350 | unchanged |
| `routing.bulkRead.minEstimatedTokens` | `null` | unchanged |
| `routing.bulkRead.minFiles` | 1 | unchanged |
| `routing.bulkRead.maxFiles` | 25 | unchanged |
| `hooks.taskIntent.source` | `none` | unchanged |

**What did change is correctness, not policy**: a prompt that cannot fit the model is now
refused instead of silently truncated, and the window is pinned instead of guessed. That is a
bug fix, argued on its own terms in `docs/worker-capability.md`, not a threshold change
justified by a benchmark.

Promoting intent-aware task construction remains a deliberate change to `config.mjs`, argued
separately, and — per CLAUDE.md #7 — requiring a negative eval alongside it.

---

## 8. Unresolved limitations

1. The Phase 7 attribution was wrong; the corrected mechanism is silent middle-dropping
   truncation under a dynamically sized window.
2. Fixing truncation did not fix the probe's answer. Worker quality has a second, independent
   cause that neither context budgeting nor task construction addresses.
3. **The live generic-vs-intent comparison was not performed** (§3). Prompt evaluation on this
   host runs at 22.3 tok/s, so a corpus case needs ~191 s of reading against a 300 s ceiling in
   Node's HTTP client, and throughput varied 3x across the session. Nothing is claimed about
   intent-aware construction in either direction. A host where a 4k-token prompt evaluates in
   seconds would settle it; no other change is needed.
4. `worker.timeoutMs` is unreachable above ~300,000 ms, and the eval runner persists no
   artifacts until every pass completes, so an interrupted live arm loses all its work. The
   first is documented and surfaced by doctor; the second is worked around per case rather than
   fixed in the runner.
5. `minEstimatedTokens` is unmeasurable in this corpus; `maxFiles` and `minFiles` are coarse.
6. Money remains unavailable, so no cost-based conclusion is possible.
7. Gemini's context window is still undiscovered and resolves `unknown` by design. Nothing in
   this phase changes Gemini.
8. Outbound file content remains unredacted.
9. The bundled model-context table will go stale as new models are pulled. Discovery is the
   mitigation; the omit-when-unsure rule is the fallback.
10. A provider with `reportsUsage: false` cannot be checked for silent truncation at all.
