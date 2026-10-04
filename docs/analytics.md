# Analytics

`lib/analytics/` answers one question — **what did delegation actually do, over a window you
choose?** — and it is a different question from the three around it. The telemetry layer answers
*what happened on one call*. Governance answers *what we were allowed to spend*. The evaluation
framework answers *whether routing decides well on a fixed corpus*. Analytics answers none of
those: it reads rows that already exist and groups them. It computes no cost, prices no model,
calls no worker, decides nothing, and writes nothing — not a segment, not a lock, not the store
directory.

> **The reader renders and never computes.**
> Every number in a report was computed once, at write time, and stamped with its
> `pricing_version` and `calc_version`. Analytics sums stored money through the one shipped
> aggregator, and [`test/analytics.isolation.test.mjs`](../test/analytics.isolation.test.mjs) pins
> statically that it imports no pricing module and contains no per-million divisor. The dashboard
> goes one step further and computes nothing at all: it prints strings `formatAgg()` produced, and
> [`test/dashboard.isolation.test.mjs`](../test/dashboard.isolation.test.mjs) pins that no module
> under its `lib/` imports even a node builtin.

---

## 1. What this phase can measure, and what it cannot

First, because the honest answer is narrower than "there is a dashboard now".

| question | measurable on a default install? | why |
| --- | --- | --- |
| how often tasks are delegated | **yes** | one row per hook invocation, so the denominator is real |
| which provider and model ran | **yes** | stored on every dispatched row |
| worker tokens consumed | **yes**, where the provider reports usage | `worker_usage_source` says which rows those are |
| primary tokens potentially avoided | **yes**, estimated | a counterfactual, never a measurement |
| worker cost | **no** | every rate in the bundled pricing table ships **`null`** |
| estimated savings | **no**, for the same reason | the cash net needs a worker bill |
| worker latency | **yes** | `latency_ms` and `provider_latency_ms` |
| hook / routing overhead | **no** | no column records it, by an explicit decision in `hook/event.mjs` |
| governance decision latency | **no** | no column exists |
| capability resolution latency | **no** | no column exists |
| time to first token | **no** | no column exists |
| per-attempt latency | **no** | `provider_latency_ms` is the final attempt only |
| a measured primary-model baseline | **no** | `primary_usage_method` is `none` on every row |
| answer quality | **no** | nothing in the schema grades an answer |

The uninstrumented latency components are reported as `unavailable` with a machine-readable
`reason`, not omitted. Deriving them by subtracting timestamps the contract never promised were
comparable would produce a measurement of the harness rather than of the router.

Answer quality belongs to [`npm run evals`](evaluation.md), over a fixed corpus — and a benchmark
result is evidence, never policy. **Nothing in this phase changes a routing threshold, a budget, a
provider default or any other configuration.** The dashboard is observational, and the dashboard
plugin cannot write a config file at all.

### Three numbers kept apart

```
a limit that was CONFIGURED        budget.daily.maxTotalTokens
spend that was MEASURED            provider-reported usage, priced at write time
spend we could NOT determine       null — and null is not zero
```

---

## 2. The out-of-the-box report

**No rate in the bundled pricing table is populated, so no report produced by a default install
contains a dollar figure of any kind. That is a refusal to price, not a missing feature.**

A first report therefore says:

```
worker cost               unavailable (23 events, none measured)
cost coverage             0 of 23 events (0.0%)
estimated net savings     unavailable (23 events, none measured)
tokens avoided            140600 tokens over 18 of 23 events, 5 unmeasured
```

`estimated_tokens_avoided` is the only populated headline. Both the CLI and the HTML report print
an explicit sentence beside it, because a reader who does not know that reads a page of
"unavailable" as a broken tool:

> Worker cost is UNKNOWN for this window — and unknown is not zero.

**Estimated savings are not necessarily actual invoice savings.** The avoided figure prices a
counterfactual that never ran, at the primary model's **input** rate only. When pricing is
unavailable, cost and savings metrics are **`null` or partially measured** — never zero.

Configure `pricing.overrides` to populate rates; `npm run doctor` reports what the pricing chain
resolved to.

---

## 3. Metric definitions

Every metric is a predicate over named telemetry columns. The definitions that are easy to get
wrong are spelled out.

### Routing

| metric | definition |
| --- | --- |
| routing events | every readable row in the window. One row is one hook invocation |
| delegated | `task_type != 'gate_block'` |
| gate refused | a gate row whose `routing_reason` is a gate-refusal reason |
| governance denied | `governance_decision == 'deny'` |
| approved, not dispatched | a gate row the gate and governance both approved — see §9 |
| delegation rate | delegated ÷ routing events |
| success rate | `status == 'ok'` ÷ delegated |

**The delegation-rate denominator is the whole routing-event population**, which only exists while
`telemetry.recordGateDecisions` is on. Computed over worker records alone the rate is always 100%,
and it looks entirely credible. Two independent checks guard it — what the config says, and
whether any gate row appears in the window — and if either fires the rate is emitted as `null`
with the condition `gate_decisions_not_recorded`. It is never silently computed against the wrong
denominator.

### Row classes

Closed, disjoint, exhaustive, and tested in this order:

```
schemaIncompatible     schema_version this build cannot read
governanceDenied       gate_block AND governance_decision == 'deny'
gateRefused            gate_block, not denied, routing_reason is a gate refusal
approvedNotDispatched  gate_block, not denied, no gate refusal reason  <- ambiguous
delegationOk           dispatched AND status == 'ok'
delegationError        dispatched AND status == 'error'
delegationSkipped      dispatched AND status == 'skipped'
```

**The order is load-bearing.** A budget refusal is written as a `gate_block` row whose
`routing_reason` is `threshold_met` — *the gate approved* — and only `governance_decision` records
the refusal. Testing `task_type` first files every denial under gate refusals and loses the
governance signal entirely.

### Worker usage

`worker_input_tokens`, `worker_cached_input_tokens`, `worker_output_tokens`,
`worker_thought_tokens`, `worker_billable_output_tokens`, and two totals reported side by side and
**never reconciled**: `totalTokensSummed` (strict — a row missing any component contributes
nothing) and `totalTokensReported` (the provider's own figure, verbatim). Where both are complete
and they disagree, that is a provider-parser bug, and `worker_token_sum_check: 'mismatch'` locates
the rows.

---

## 4. Savings methodology

Unchanged from [`savings-methodology.md`](savings-methodology.md), which remains the definition.
Analytics sums the stored results and invents nothing.

| | name | space | formula |
| --- | --- | --- | --- |
| 1 | **context net** | tokens | `estimated_tokens_avoided = estimated_input_tokens − returned_answer_tokens_estimated` |
| 2 | **cash net** | dollars | `estimated_net_savings = estimated_cost_avoided − worker_total_cost` |

Five quantities are reported separately and never collapsed:

1. **tokens avoided** — the context net
2. **worker tokens consumed** — consumption, reported beside the avoided figure. *Worker tokens are
   never saved tokens.*
3. **estimated primary-equivalent cost** — the net token delta at the primary input rate
4. **known worker cost** — summed from stored values
5. **estimated net savings** — the cash net

If an operand is unknown the result is **`null`**, not zero, and the aggregate says
`unavailable` rather than `$0.0000`.

### Savings are aggregated over a named population

`estimated_input_tokens` is only set once content has been read, so **every savings column is null
on every `gate_block` row by construction.** Aggregated over a whole window, a savings figure
would report `partial` coverage forever — describing the shape of the schema rather than the
quality of the data, and sending an operator looking for a problem that was never there. So every
aggregate in the response carries the name of the population it covers, and savings are scoped to
`dispatchAttempted`.

---

## 5. Cost and coverage

Cost aggregates are sums of stored money. Nothing is re-priced: a historical row priced against
today's table would produce a figure for a bill that was never sent.

**Every cost aggregate ships its coverage**, as integers first:

```
knownEvents    5
totalEvents   23
ratio          0.217
```

The integers lead because a ratio alone invites rounding — one row in 250 is 0.4%, and
`Math.round` of that is `0`, which reads as "nothing was measured" when something was. The HTML
report never prints a bare percentage for coverage.

### Three zeros, kept apart

| state | predicate | means |
| --- | --- | --- |
| **known zero** | `worker_total_cost == 0` and status `actual` | an operator configured a rate of literal `0`, usually a local model. A real measurement whose value is zero |
| **unknown** | `worker_total_cost == null` and status `unavailable` | the price cannot be stated. **Not zero**, and not a failure |
| **empty** | no rows in the population | nothing to measure |

The three render differently everywhere, and `cost.structurallyZeroEvents` /
`cost.unknownCostEvents` count the first two separately.

### Why a price is missing

The pricing layer returns a reason for every refusal to price and `buildEvent()` discards all of
them, so `cost.nullExplanation` is **re-derived** from `pricing_lookup`, `pricing_source` and
`worker_usage_source`, and is labelled `derived: true`. Cases those columns cannot separate are not
guessed at.

---

## 6. Latency

Reported over dispatched rows. Both latency columns are `null` on every gate row by design, so
those rows are excluded and counted rather than reported as unmeasured.

| series | column | meaning |
| --- | --- | --- |
| total | `latency_ms` | payload assembly, every attempt, the parse |
| provider | `provider_latency_ms` | the HTTP round trip of the **final attempt only** |
| dispatch overhead | derived | `latency_ms − provider_latency_ms`, **only where `retry_count == 0`** |

**The overhead restriction is what makes the figure trustworthy.** With a retry, the difference
includes an unknown amount of earlier network time, so publishing it would be inventing a number
and labelling it a measurement. Rows with a retry, and rows whose retry count is unknown, are
excluded and counted separately — `retry_count` is explicitly never defaulted to `0`, so excluding
on an unknown is reported rather than decided. Negative overhead samples are reported, never
clamped: a negative value means two measurements disagree, which is information.

### Median, p95, max — and no mean

Nearest rank, **no interpolation**. Every reported percentile is a value some event actually
produced, so an operator who sees a p95 of 18,400 ms can go and find the event. An interpolated p95
is a latency that never happened.

- even `n`: the **lower** median. Averaging the two middles is interpolation under another name
- `n == 1`: every statistic equals the sample
- `n == 0`: every statistic is **`null`**, never 0. "No samples" is not "no time"
- **the mean is deliberately `null`.** A single GC pause moves a mean and barely touches a median

Samples are kept exactly in a capped buffer (200,000 by default). Past the cap, collection **stops**
and `truncated` is set, so a prefix percentile is never presented as a complete one. Reservoir
sampling was rejected: it needs an RNG, which would make a p95 non-reproducible for the same store.

---

## 7. Failures and refusals

**Four conditions are counted separately and never added. There is deliberately no total.**

| condition | predicate | never confused with |
| --- | --- | --- |
| worker failure | dispatched, `status == 'error'`, reason is not `context_exceeded` | a refusal — the provider *was* called |
| governance denial | `governance_decision == 'deny'` | a worker failure (`status` is `skipped`, `error_code` is `null`) or a gate refusal |
| capability refusal | `routing_reason == 'context_exceeded'` | a provider error — the provider did nothing wrong |
| unknown cost | dispatched, `status == 'ok'`, cost `null` | all three. A successful call whose price we cannot state |

A context refusal splits further, and the two halves have opposite cost profiles:

- **pre-flight** — `worker_input_truncation_detected != true`. Refused before the call: no usage,
  no cost, nothing wasted.
- **truncation discard** — `worker_input_truncation_detected == true`. The call **ran, consumed
  tokens, and the answer was thrown away** because the provider read less of the prompt than was
  sent. The purest waste figure in the store, and it must never be averaged into the first.

`failures.retryable` is `unavailable`: whether an error code is retryable is declared in the
provider contract, which this layer may not import, and a copy of a vocabulary nobody keeps in step
would be worse than no copy.

### Worker overhead

`value.workerOverhead` sums the cost and tokens of dispatched rows that delivered nothing usable.
It is reported **beside** estimated net savings and **never subtracted from it**: subtracting would
be a new savings formula, and a partial overhead sum and a partial savings sum cover different row
sets, so their difference would describe no definite population.

---

## 8. Governance

**A governance denial is a successful governance decision.** It is recorded on a `gate_block` row
whose `routing_reason` is `threshold_met`, with `status: 'skipped'` and `error_code: null`.

| metric | meaning |
| --- | --- |
| consulted | at least one of the eight governance columns is non-null |
| **not consulted** | all eight are null — governance never ran. **A different state from "allowed"** |
| allowed / denied | `governance_decision` |
| denial reasons | including `cost_unknown` and `usage_unknown`, which are refusals *because* a measurement was missing |
| reservation statuses | `none`, `reserved`, `settled`, `released`, `overrun` |
| reservation tokens | a quantity, so it **may** be summed |

**Budget limits are never summed.** A limit is not a quantity consumed, so adding `budget_limit`
across rows produces a number with no referent. `governance.budgetSnapshots` reports the most
recent non-null observation per scope, by instant, with `aggregated: false`. Utilisation is
computed only where both the limit and the remaining headroom are known, and is `null` otherwise —
substituting zero would report a spent budget as untouched, or the reverse.

Routing and governance are reported as two separate verdicts:

```
Routing:     delegation appropriate
Governance:  denied — daily budget exceeded
```

---

## 9. Known gaps in the telemetry

Reported honestly rather than patched over.

**`approvedNotDispatched` is ambiguous.** `content_unreadable` and `content_binary` produce a row
the gate approved, governance approved, and nothing dispatched — and *nothing on the row says why*:
`error_code` is `null` and no `routing_reason` names them. It is surfaced under its own name with
`ambiguous: true`. Closing the gap needs a new `ROUTING_REASONS` member, which is a telemetry
change and not this phase's to make.

**A deliberate `other` cannot always be told from an unknown value that bucketed to `other`.**
`other` is a literal member of most enums, and `validation_codes` separates the two only when it
names the field. `routing.otherKinds` reports `deliberate`, `unknown_enum` and **`indeterminate`**
per field; the third is the honest answer where there is no evidence either way.

**A null is not an `other`.** `bucket(null, known)` returns `'other'` because null is in no enum
list, but "the writer chose a value we do not know" and "there was no value" are different facts.
The null bucket is separate.

---

## 10. Segmentation

Eleven dimensions: `date`, `provider`, `model`, `project`, `session`, `taskType`,
`routingDecision`, `routingReason`, `status`, `errorCode`, and `workerProfile` — a derived
`provider / model / mode` composite, which is the grain the delegation-value question is actually
asked at. `mode` is `task_type`, because schema version 1 has no mode column.

`governance_reason`, `pricing_lookup`, `worker_context_source` and `avoided_method` appear as
histograms inside their own sections instead.

### The null key

**The wire key for a null group is `__null__`, not the string `'unknown'`.**
`worker_context_source` has a literal `'unknown'` member, so the conventional mapping would merge
"we never resolved a context window" with "the provider told us it does not know" — two different
facts with two different fixes. The human word lives in a separate `label`, and every bucket
carries a `keyKind`:

| `keyKind` | `key` | `label` |
| --- | --- | --- |
| `value` | the raw stored string | the same |
| `null` | `__null__` | `unknown` |
| `other` | `__other__` | `other (N keys below the top 20)` |
| `overflow` | `__overflow__` | `overflow (dimension exceeded 200 tracked keys)` |

**Consumers disambiguate on `keyKind`, never on the key string**, so a model genuinely named
`__other__` is still reported as itself.

### Two caps

A **live** cap of 200 tracked keys per dimension bounds memory during the pass; new keys past it
fold into `__overflow__`. A **finalize** cap keeps the top 20 by row count, and the tail's
*unfinalized accumulators* are merged into `__other__` — merging states rather than values is what
keeps that bucket's coverage a real coverage of a real row set. Ordering is count descending then
key ascending, a total order, so two reads of the same store produce the same array.

`date` is exempt from both and bounded by the window; beyond 366 days it switches to ISO week keys
and says so. Its `axis` carries the **complete** day list while its buckets carry only days with
rows, so a renderer iterating the axis gets a zero where there was a zero and a gap where there was
a gap.

---

## 11. Negative savings

Never clamped. Two **different** populations, both required:

- `negativeSavings.tokens` — `estimated_tokens_avoided < 0`
- `negativeSavings.dollars` — `estimated_net_savings < 0`

A delegation can save context and still cost more than it saved, when the worker is priced above
the primary's input rate. Reporting only one count hides those rows, so both are reported with
their own events, rate and total — and the total sums only the negative rows, so the magnitude is
not diluted.

Up to 100 worst cases are listed by `event_id` and `task_id` with the operands of both nets. The
worst survive the cap rather than the earliest, because the first N in file order are an accident of
which segment was read first. **No content field is ever included.**

> A negative-savings event does not by itself mean the routing policy is wrong. It can indicate a
> small corpus, a verbose worker, a slow model, an unnecessary delegation, a task mismatch or a
> missing baseline. It is surfaced for investigation.

---

## 12. Time semantics

**Every boundary is UTC and every range is half-open `[start, end)`.** Adjacent windows partition
the timeline, so an event exactly at midnight belongs to the later day and only to the later day.
A local-timezone boundary would make "savings yesterday" unreproducible between two developers
reading the same store.

| window | range |
| --- | --- |
| `--today` | UTC midnight to now |
| `--24h` | a rolling 24 hours |
| `--7d` / `--30d` | 7 or 30 **whole UTC days**, ending today |
| `--all` | everything in the store |
| `--start` / `--end` | custom; a date-only `--end` means through the end of that day |

`7d` is whole days rather than 168 hours because a window that began at an arbitrary time of day
cannot be compared with a daily bucket.

### Boundaries are strict ISO only

A boundary is matched against a shape before `Date.parse` ever sees it. **Measured:**
`Date.parse('03/04/2026')` returns a valid instant in V8 — a non-standard extension, interpreted in
**local time** — so `--start 03/04/2026` would have meant a different instant on two machines and
still produced a plausible report. A date-time with no offset is refused for the same reason: the
spec reads it as local time. `Z` or `±HH:MM` is required.

`--now` exists so a fixture-dated store can be analyzed and so two runs can be diffed. It has **no
default**: an absent clock is a refusal, because a `= Date.now()` fallback would make a run meant
to be reproducible silently irreproducible.

### Two filters, and the coarse one is deliberately too wide

Segment filenames carry the UTC date from the clock of whichever process appended the row, so the
filename filter is widened by one day on each side and the precise per-row `timestamp` filter does
the real work. Narrowing the coarse filter would make the answer depend on a clock skew, and the
failure mode would be a silently missing event. An **undated** segment (`rotation: 'none'`) is
never excluded by a date filter, which is why the per-row filter is load-bearing rather than an
optimisation.

---

## 13. Data quality

The section exists to make one confusion impossible: **"we saved $0" versus "we do not know the
cost".**

| reported | |
| --- | --- |
| records scanned / accepted / rejected | with rejections itemised by reason |
| schema versions seen | including rows this build cannot read |
| rows missing usage / cost / latency / a savings figure | counted separately |
| rows with an unknown enum value | with the field named |
| records the sink shed to fit its size guard | a third, unrelated meaning of "truncation" |
| conditions | each with a severity and the metrics it affects |

**`malformed` and `truncated_tail` are never merged.** An unparseable line at the *end* of a
segment is a writer caught mid-flight and benign. An unparseable line in the *middle* is evidence
that append atomicity failed on this filesystem — the one reader counter that should change what an
operator does, and it raises an `error` condition pointing at `telemetry.shardByPid`.

A malformed line cannot corrupt an aggregate: the reader drops it before analytics sees it, and it
is reported alongside rather than folded in.

### Three truncations, which must not be conflated

| field | meaning | actor |
| --- | --- | --- |
| `worker_input_truncation_detected` | the provider read **less of the prompt** than was sent | worker runtime, inbound |
| `truncated` | the **answer** hit an output cap | worker runtime, outbound |
| `truncation_steps` | this **telemetry record** was shed to fit the size guard | the sink, at write |

---

## 14. Security

The analytics response and the HTML report never carry:

- `question_text`, `error_message_safe` or `project_path` — the three columns that can hold text a
  developer typed, a provider returned, or a filesystem path
- the reader's `samples[]`, each of which is a 120-character excerpt of a **raw telemetry line**
  plus an absolute file path. The counters are copied; the excerpts and paths are dropped
- any environment variable name or value

`FIELD_ALLOWLIST` is an **allowlist, not a denylist**: a column added to the telemetry schema must
be admitted deliberately. With a denylist, a new column carrying content would reach a rendered
dashboard the moment somebody grouped by it.

Three independent guards, because one is a single point of failure: the engine never emits the
fields, no dashboard source file names them, and a test doctors a response to smuggle each one in
and asserts the **value** is absent from the rendered HTML — which checks the property that
matters, namely that the renderer emits the fields it knows rather than the fields it was handed.

Every value interpolated into the document is escaped. A model id and an error code come from a
remote service, and the report is a local file a browser will execute.

---

## 15. Running it

```bash
npm run analytics                         # last 7 UTC days, in the terminal
npm run analytics -- --today
npm run analytics -- --30d --provider ollama --model llama3.1:8b
npm run analytics -- --start 2026-03-01 --end 2026-03-07
npm run analytics -- --json > analytics.json
npm run report                            # one self-contained HTML file; prints its path
npm run report -- --7d --out report.html
npm run analytics -- --json | npm run --silent report
```

Both are read-only. `analytics` opens no socket, calls no worker and **writes nothing at all** —
not the telemetry directory, not a lock, not a salt. A missing store is read as an empty store,
because a reporting tool that created a directory in order to tell you it was empty would quietly
falsify its own report.

| flag | effect |
| --- | --- |
| `--today --24h --7d --30d --all` | the window; pick one |
| `--start <date> --end <date>` | a custom range, strict ISO |
| `--provider --model --mode --project --session` | exact-match filters |
| `--mode` | `bulk-reader` or `code-writer`, resolved onto `task_type` and echoed back |
| `--json` | the response to **stdout**; takes no argument |
| `--now <instant>` | treat this instant as now, for reproducible windows |
| `--no-color --verbose` | presentation |
| `--input <file>` *(report)* | render a response from a file instead of collecting one |
| `--out <file>` *(report)* | where to write; default `./router-report-<UTC date>.html` |
| `--router <path>` *(report)* | where model-router is, if the probe cannot find it |

**Exit codes: `0` on any successful read, `2` on a bad invocation. Exit `1` is unreachable by
design** — deliberately unlike `doctor`'s "1 if and only if something FAILED". An unpriced install
is the normal state of this project, and a reporting command that failed on it would break every
pipeline that ran it.

### How `npm run report` reaches a store

`router-dashboard` may not import `model-router`, so a response arrives one of three ways, in this
order: `--input <file>`, stdin when it is not a terminal, or by **spawning** the router's own
read-only analytics CLI. A spawn is not an import, so the ban holds unchanged, and
`scripts/collect.mjs` is the only file in the plugin permitted to touch `child_process`.

Installed on its own, the dashboard is a *renderer* rather than a reporter: `--input` and stdin work
exactly as well, and the missing-router case prints instructions in one screen. The trade-off is
deliberate — mandating the pipe instead would make the plugin self-sufficient at the cost of a
PowerShell 5.1 `$OutputEncoding` hazard (ASCII by default) on the single most common invocation,
and a mangled model name is worse than a clear error in the rare standalone case.

---

## 16. Performance

One pass over the rows. Each row is pushed once into every accumulator it belongs to, through the
**same fold `aggregate()` itself uses** — `aggInit`/`aggPush`/`aggMerge`/`aggFinalize` were
extracted from `telemetry/aggregate.mjs` so there is exactly one implementation of the coverage
model in the repository, and the batch and streaming paths cannot disagree about what `partial`
means.

Measured on a 2026 developer laptop, Node 24, from a generated store:

| rows | store on disk | read | aggregate | serialize | response |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 29 MiB | 115 ms | 150 ms | <5 ms | 222 KiB |
| 100,000 | ~290 MiB | 1,979 ms | 2,650 ms | 3 ms | 450 KiB |

**The response does not grow with the store** — 10× the rows for roughly 2× the response — which
is what the segment caps are for, and what keeps the pipe into the dashboard bounded.

No index and no cache were introduced. A full read of 100,000 events costs a few seconds, which is
acceptable for a command an operator runs interactively; introducing a database for a question
answered this fast would be premature. `test/analytics.performance.test.mjs` asserts ceilings and a
roughly linear scaling ratio — a per-metric or per-bucket re-walk would show up as a superlinear
ratio long before it showed up as a wall-clock failure on a fast machine. The 100,000-row case is
gated behind `ROUTER_PERF_FULL=1` because its scratch store is ~290 MB.

---

## 17. Known limitations

- **No dollar figure on a default install.** By design; see §2.
- **Hook, governance and capability latency are not instrumented** and report `null`.
- **No measured primary-model baseline**, so every avoided figure is a counterfactual estimate.
- **`approvedNotDispatched` is ambiguous** — see §9.
- **`failures.retryable` cannot be classified** from this layer.
- **Latency is reported per window, not per worker profile.** A percentile buffer per
  provider/model/mode combination would be unbounded in the one dimension that is unbounded.
- **A partial float sum can differ in its last bit under reordering**, because IEEE-754 addition is
  not associative. Every count, coverage and basis figure is exact; a reader is still
  deterministic, because segments are read in sorted order.
- **`router-dashboard` installed alone renders but cannot collect** — see §15.

So out of the box, analytics is wired, tested and documented, reads a store nobody has priced, and
reports exactly that.

---

Terms: [`telemetry-schema.md`](telemetry-schema.md) defines every column.
[`savings-methodology.md`](savings-methodology.md) defines the two nets.
[`governance.md`](governance.md) defines what a budget decision means.
Full discussion of what the router will not delegate at all:
[`what-we-do-not-delegate.md`](what-we-do-not-delegate.md).
