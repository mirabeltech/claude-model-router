# Telemetry schema

`schema_version: 1` · `calc_version: 1` · one JSON object per line, UTF-8, LF.

This document is the **contract between the two plugins**. `router-dashboard` installs
independently of `model-router`, so it cannot import `lib/telemetry/`; the JSONL format described
here, plus the fixture corpus in [`test/fixtures/telemetry/`](../test/fixtures/telemetry/), is what
the two agree on.

That corpus now exists, and it is hand-authored rather than generated on purpose: its value is
that it holds the things a generator would normalise away — a UTF-8 BOM, a `#` comment, a blank
line, an unparseable line in the *middle* of a file, a `schema_version: 2` row, an unknown enum
value, and one row per distinction a reader is tempted to collapse. Every count in its README is
measured by [`test/telemetry.fixtures.test.mjs`](../test/telemetry.fixtures.test.mjs) using the
shipped reader, so a declared figure cannot drift from the bytes. What is computed from these rows
is defined in [`analytics.md`](analytics.md).

## Two meanings of the word "status"

The schema has one field called `status` and nine called `*_status`. They are different things,
and conflating them produces wrong answers:

| field | meaning | values |
|---|---|---|
| `status` | the **event outcome** — what happened to the delegation | `ok`, `error`, `skipped` |
| `*_status` | the **measurement status** of the number beside it | `actual`, `estimated`, `unavailable` |

`SELECT ... WHERE status = 'ok'` filters events. To ask whether a dollar figure can be trusted,
read the `*_status` next to that specific figure.

## Rules that hold for every record

1. **Flat and scalar-only.** Every value is `string`, `number`, `boolean` or `null`. No nested
   objects, and no arrays either — an array is nesting with extra steps and breaks the 1:1
   JSONL→SQL column mapping. `validation_codes` is a comma-joined string for this reason.
2. **`null` is always written explicitly.** Every record has every key. "Key absent" and "key
   null" are never two ways of saying the same thing, and `undefined` never appears.
3. **Enums are closed on write, open on read.** Writers emit only the listed values. A reader
   preserves an unknown value verbatim and buckets it as `other`. Never reject a record for an
   unrecognised enum value.
4. **`null` means unavailable, never zero.** This is the load-bearing rule of the whole system.
   A missing measurement is `null`. A measured zero is `0`. The two must never be conflated,
   because a zero worker cost understates the worker bill and therefore overstates savings.
5. **`value === null` ⟺ `status === 'unavailable'`**, in both directions, for every measured
   field. There is no "unavailable but here is a number" and no "actual null".
6. **Cost is computed once, at write time**, and stamped with `pricing_version` and
   `calc_version`. A reader sums stored money; it never re-prices a row. Re-pricing history
   against today's table would produce a number for a bill nobody was sent.

## Fields

### Identity and stamps

| field | type | meaning |
|---|---|---|
| `schema_version` | int | Event contract version. Bumped when a field changes meaning. |
| `event_id` | string | UUID. The idempotency key for ingest. |
| `timestamp` | string | ISO 8601 UTC with milliseconds and `Z`. |
| `tz_offset_minutes` | int | Signed minutes **ahead of** UTC at write time (`+600` = UTC+10). The inverse of `Date#getTimezoneOffset`. |
| `router_version` | string | Plugin version that wrote the row. |
| `calc_version` | int | Version of the math. Bumped on any change to a formula **or a null rule**. |
| `pricing_version` | string\|null | The table that served the rates. `null` when nothing priced this row. |
| `pricing_source` | string | `bundled` \| `file` \| `none`. |
| `currency` | string | `USD`. A table in any other currency is rejected at load, never converted. |
| `privacy_level` | string | `hashed` \| `labeled` \| `verbose`. **Stamped so a reader can tell "null because private" from "null because unmeasured".** |
| `session_id` | string\|null | Salted HMAC. `null` if no salt was obtainable. |
| `project_id` | string\|null | Salted HMAC of the project directory. |
| `project_path` | string\|null | Raw path only under `storeFilePaths`; basename only under `storeProjectLabel`; otherwise `null`. |

### Task and routing

| field | type | meaning |
|---|---|---|
| `task_id` | string\|null | Correlates a gate decision with the delegation it caused. |
| `task_type` | string | `bulk_read` \| `code_write` \| `gate_block` \| `delegation` \| `other`. |
| `routing_decision` | string | `allow` \| `deny` \| `ask` \| `suggest` \| `off` \| `delegated` \| `not_applicable` \| `other`. |
| `routing_reason` | string | A reason **code**, never prose — see `ROUTING_REASONS` in `record.mjs`. Prose cannot be grouped. |
| `routing_policy_version` | int\|null | The `POLICY_VERSION` of the `decide()` result behind this row. Added with the hook integration; additive and nullable, so no `schema_version` bump. |
| `prompt_version` | int\|null | The version of the worker prompt that was ACTUALLY built: currently `3` for the generic request and `4` when it carried a task intent. `null` when no prompt was built — on every `gate_block` row, for instance. **An intent row is not cost-comparable with a generic one**: it sent extra input tokens on purpose. Both counters moved from `1`/`2` in phase 8, when the shared bulk-reader system prompt changed; rows stamped `1` or `2` were produced by the earlier wording. |
| `task_intent_source` | string\|null | Where the worker's task came from: `none` (the fixed generic task, which is the default and describes every row written before this field existed), `transcript` (the developer opted in to forwarding their newest prompt), `other` (a caller supplied it; not reachable from the hook). `null` on a row that made no request, because `none` would claim a generic task was sent when nothing was. Records the SOURCE and never the text — the task itself travels only through `question_text`, which is off by default, clamped and redacted. Additive and nullable, so no `schema_version` bump. |
| `provider` | string\|null | Resolved through the provider registry. `null` when no call was attempted. |
| `model` | string\|null | The model the provider **reports having served**. The pricing key. |
| `model_requested` | string\|null | `config.worker.model`. Both are needed: Gemini returns `-001` suffixes, so the served and configured names differ. |
| `pricing_lookup` | string | `exact` \| `requested_alias` \| `wildcard` \| `model_unknown` \| `no_table`. |

`task_type` is an **event** taxonomy — what kind of row is this — and its value for a gate decision
is `gate_block`. The routing engine's own `taskType` is a different, larger taxonomy answering what
kind of work was asked for (`ROUTING_TASK_TYPES` in `lib/routing-policy.mjs`: `bulk_read`,
`code_write`, `debugging`, `architecture`, `security`, `precise_edit`, `general`, `unknown`). The two
overlap on the two delegatable lanes and a test pins that those spellings agree, but they are not
the same list and neither is derived from the other.

`routing_reason` gained six codes with the routing engine: `task_type_excluded`, `interactive`,
`latency_sensitive`, `unknown_input`, `precise_output_requested` and `over_max_input_bytes`. The
addition is additive and did **not** bump `schema_version`: a reader preserves an unknown value and
buckets it as `other`, so a dashboard built against the earlier list still ingests these rows. The
closed subset a gate decision can carry is `DECIDE_REASONS` in `lib/routing-policy.mjs`.

### Worker usage

| field | type | meaning |
|---|---|---|
| `worker_usage_source` | string | **Verbatim** from the provider contract: `provider_reported` \| `provider_partial` \| `missing`. |
| `provider_reports_usage` | bool\|null | `false` ⇒ every cost on this row is `estimated`, never `actual`. |
| `provider_reports_thinking_tokens` | bool\|null | Distinguishes a structural null from an omission. |
| `provider_supports_cached_input` | bool\|null | Same role for cached input. |
| `worker_input_tokens` | int\|null | **Uncached** prompt tokens. |
| `worker_cached_input_tokens` | int\|null | Cache-read prompt tokens. |
| `worker_output_tokens` | int\|null | Output **excluding** thinking. |
| `worker_thought_tokens` | int\|null | Thinking tokens. Billed at the output rate, excluded from the field above. |
| `worker_total_tokens` | int\|null | **The provider's own total, verbatim. Never recomputed.** |
| `worker_billable_output_tokens` | int\|null | `output + thinking` under the null policy below. The operand the output cost used. |
| `worker_thinking_assumption` | string | `reported` \| `structural_zero` \| `unknown`. Explains the field above. |
| `worker_token_sum_check` | string | `ok` \| `mismatch` \| `unknown`. Audit only — **a mismatch never changes a cost.** |
| `worker_context_tokens` | int\|null | The model's resolved context window, in tokens. `null` means unknown, and unknown is never treated as infinite. Additive and nullable, so no `schema_version` bump. |
| `worker_context_source` | string\|null | Where that number came from: `provider_api` \| `configured` \| `bundled_default` \| `unknown`. Open on read. |
| `worker_context_status` | string\|null | What it is worth: `measured` \| `configured` \| `assumed` \| `unknown`. **Only `provider_api` yields `measured`** — a configured value is never presentable as a measurement. |
| `worker_requested_input_tokens` | int\|null | Our own `chars/4` estimate for the ASSEMBLED prompt — the figure the fit decision was actually made on. Distinct from `worker_input_tokens` beside it, which is the provider's own count and is `null` on a refusal because no call happened. |
| `worker_configured_max_output_tokens` | int\|null | The output budget that was requested, before any cap. |
| `worker_effective_input_capacity` | int\|null | Tokens left for the prompt once the output request was honoured or reduced. On a shared window this is `context − allowed_output`. |
| `worker_input_truncation_detected` | bool\|null | Did the provider quietly read less of the prompt than was sent? **Tri-state:** `true`, `false`, or `null` when it could not be determined. Never defaulted to `false`. |

Together these make a refusal legible **without any opt-in**: a `context_exceeded` row reading
`worker_requested_input_tokens: 16403` against `worker_effective_input_capacity: 7680` says the
request was over by 2.1x. The message that would otherwise have said so lives in
`error_message_safe`, which is `null` unless `telemetry.storeErrorDetail` is enabled — and a
token count carries no file content, no task text and no credential, so there is no reason for
this one to be opt-in.

The last four are recorded on **every dispatched path, including a refusal**: a
`context_exceeded` row is precisely the one where the window that caused it must survive. A
gate row that never reached a worker leaves all four `null` rather than claiming `unknown`
about a request nobody made.

### Three different things are called truncation

| column | what it means | who did it |
| --- | --- | --- |
| `worker_input_truncation_detected` | the provider silently read **less of the prompt** than was sent | the worker runtime, on the way IN |
| `truncated` | the **answer** hit an output cap | the worker runtime, on the way OUT |
| `truncation_steps` | this telemetry **record** was shed to fit a size guard | the sink, when writing |

They are unrelated, and only the first invalidates an answer: a capped answer is incomplete but
honest, a shed record loses metadata rather than content, and a truncated *prompt* means the
answer was derived from material the reader cannot see was missing.

`worker_input_truncation_detected` is computed by comparing our `chars/4` estimate against
the provider's own `prompt_eval_count`. Because that estimate *under*-counts code, a healthy
call normally reports slightly MORE tokens read than estimated; a material shortfall is
therefore a signal rather than a rounding artefact. See `docs/worker-capability.md` for the
measurements behind it.

> **`provider_reported` carries no pricing authority.** The provider contract computes `source`
> from `inputTokens` and `outputTokens` only, so it says nothing about cached or thinking tokens.
> Ollama reports `provider_reported` with both hardcoded `null`. Always read the `*_status`
> fields, which are derived from the operands, not from `worker_usage_source`.

### Primary-model baseline

These are **actual primary-model spend**, not the counterfactual. The counterfactual lives in the
`estimated_*` fields. Populating un-prefixed `primary_*` with a hypothetical would double-count
the saving for any reader that summed both, and would make `SUM(primary_total_cost)` read as "what
Claude cost me" for work that never happened.

| field | type | meaning |
|---|---|---|
| `primary_model` | string\|null | Default `null` — resolved from the session, never guessed. |
| `primary_usage_method` | string | `none` \| `transcript_measured`. |
| `primary_usage_status` | string | `actual` \| `estimated` \| `unavailable`. |
| `primary_input_tokens` | int\|null | |
| `primary_output_tokens` | int\|null | |
| `primary_total_tokens` | int\|null | |

**In this release all six are `null` and `primary_usage_status` is always `unavailable`**, because
there is no transcript reader yet. `actual` is reserved. When the reader lands, the same columns
fill with real numbers and the status flips — no `schema_version` bump.

### Money

Nine monetary fields, each with its own `*_status`. The status is **per field** because input and
output availability genuinely differ: Gemini can report `promptTokenCount` with no
`candidatesTokenCount`, and a single grouped status would force either claiming `actual` for a
bill missing its output component (overstating savings) or discarding the one number that was
measured.

| field | type | notes |
|---|---|---|
| `worker_input_cost` | number\|null | **Uncached** input only. |
| `worker_cached_input_cost` | number\|null | Priced at the cache-read rate. Separate so the double-charge trap is visible. |
| `worker_output_cost` | number\|null | `worker_billable_output_tokens` × output rate. |
| `worker_total_cost` | number\|null | **Null if any component is null — never a partial sum.** |
| `primary_input_cost` / `_output_` / `_total_` | number\|null | Actual primary spend. `null` in this release. |
| `estimated_cost_avoided` | number\|null | The token delta priced at the **primary input rate**. |
| `estimated_net_savings` | number\|null | `estimated_cost_avoided − worker_total_cost`. Negative values are stored, never clamped. |

### Counterfactual and savings

| field | type | meaning |
|---|---|---|
| `avoided_method` | string | `chars_div_4` \| `calibrated_cpt` \| `worker_prompt_tokens` \| `anthropic_count_tokens`. |
| `counterfactual_render` | string | `raw` \| `read_tool`. |
| `count_proven_files_only` | bool | Whether the corpus counts hook-proven files only. |
| `residency_turns` | int | Stamped, **never multiplied into anything**. See the savings methodology. |
| `residency_source` | string | `default_zero` \| `config` \| `transcript_measured`. |
| `files_count` | int\|null | Files in the estimate. `0` is legitimate. |
| `files_inferred_count` | int\|null | Files the skill added beyond what the gate proved. |
| `input_bytes` | int\|null | Bytes of the counterfactual render. |
| `estimated_input_tokens` | int\|null | **Gross** corpus size in primary-model tokens. |
| `returned_answer_chars` | int\|null | Characters of the worker answer that enter Claude's context. |
| `returned_answer_tokens_estimated` | int\|null | The same render method applied to the answer. **Not** `worker_output_tokens` — that is the worker's tokenizer, not the primary's. |
| `estimated_tokens_avoided` | int\|null | **Net** of the returned answer. Can be `0` ("saved nothing") or negative. |

### Outcome and performance

| field | type | meaning |
|---|---|---|
| `status` | string | `ok` \| `error` \| `skipped`. `skipped` = no worker call attempted. |
| `error_code` | string\|null | One of `DISPATCH_ERROR_CODES`: the provider contract's 14 `ERROR_CODES` verbatim, plus 5 the dispatch layer owns (`invalid_request`, `provider_unavailable`, `aborted`, `unsupported_mode`, `unsupported_provider`). Never a vendor message. See [`worker-dispatch.md`](worker-dispatch.md#error-vocabulary). |
| `error_message_safe` | string\|null | Redacted and clamped. `null` unless `storeErrorDetail`. |
| `latency_ms` | int\|null | **End to end**: payload assembly, every attempt, and parse. |
| `provider_latency_ms` | int\|null | The HTTP round trip of the **final attempt only**. Two fields, not one lie. |
| `retry_count` | int\|null | `attempts − 1` (attempts is 1-based). `null` means unknown, which is **not** the same as `0`. |
| `truncated` | bool\|null | Output hit a cap — a truncated answer makes the savings figure suspect. |
| `finish_reason` | string\|null | Verbatim provider value. |
| `question_text` | string\|null | Redacted and clamped. `null` unless `storeQuestionText`. |
| `truncation_steps` | string\|null | Which size-guard steps fired, comma-joined. `null` normally. |
| `validation_warnings` | int | Count of fields nulled at the boundary. `0` normally. |
| `validation_codes` | string\|null | Sorted, de-duplicated, comma-joined, e.g. `negative:input_bytes`. |

### Governance (phase 9)

Eight columns, all nullable, added **additively** — `schema_version` stays `1` and `calc_version`
stays `1`, so a reader built against the phase-8 schema sees eight keys it does not know and
ignores them.

| field | type | meaning |
|---|---|---|
| `governance_decision` | string\|null | `allow` \| `deny` \| `unknown`. Open on read, buckets to `other`. **Not** the `routing_decision` vocabulary: that says what the hook did to a tool call, this says whether the budget permitted it. |
| `governance_reason` | string\|null | `governance_disabled`, `budget_not_configured`, `within_budget`, `run`/`daily`/`monthly_budget_exceeded`, `token_budget_exceeded`, `cost_unknown`, `usage_unknown`, `invalid_budget`. Separate from the decision, so a refusal and the reason for it never share a column. |
| `budget_scope` | string\|null | `run` \| `daily` \| `monthly`. Which period the decision was made against. |
| `budget_limit` | number\|null | The CONFIGURED limit. `null` means no limit was configured — never `0`, and never infinity. |
| `budget_remaining` | number\|null | Headroom. `null` **if and only if** `budget_measurement_status` is `unavailable`. `limit − unknown` is never evaluated as though unknown were zero, which would report the full budget as free. Clamped at `0`, so it is never negative even after an overrun. |
| `budget_measurement_status` | string\|null | `measured` \| `estimated` \| `unavailable`. Closed — no `other`, because the three states already include not knowing. |
| `reservation_tokens` | int\|null | The estimate that sized the reservation, not a measurement. |
| `reservation_status` | string\|null | `none` \| `reserved` \| `settled` \| `released` \| `overrun`. What the reservation BECAME, so a row never claims a reservation is still held after its call finished. |

Three things to rely on when reading these:

- **All eight are `null` when governance was never consulted** — every row where routing refused
  before the budget was asked. That is a distinct state from "governance allowed this".
- **A budget refusal is not an error.** It writes `status: 'skipped'` with `error_code: null`, so a
  budget refusal and a failed provider call are never confused for one another.
- **They duplicate no `worker_*` column.** These describe policy and headroom; the worker columns
  describe what one call used. Summing a budget column across rows is meaningless — a limit is not
  a quantity consumed.

Full semantics, including the accounting rules behind `reservation_status`:
[`governance.md`](governance.md).

## Store layout

| rotation | shardByPid | filename |
|---|---|---|
| `daily` | `false` | `events-2026-10-02.jsonl` |
| `daily` | `true` | `events-2026-10-02.p48213.jsonl` |
| `none` | `false` | `events.jsonl` |
| `none` | `true` | `events.p48213.jsonl` |

**The date is UTC**, because it is a partition key and not a calendar label: local time makes a
shared team store impossible to prune consistently, DST gives a repeated and a missing hour so
file boundaries stop being time-ordered, and `toISOString()` is spec-pinned where
`toLocaleDateString` varies with the ICU build. Local-day *presentation* is recovered from
`timestamp` + `tz_offset_minutes`, so nothing is lost.

A reader must skip: dot-prefixed names (`.salt`, `.doctor-<pid>` probes), anything that is not a
regular file, and anything the segment pattern rejects (`events.jsonl.gz`, `*.sqlite`, user
files). Undated segments sort first, so a directory that spans a rotation change still reads.

## Reading a damaged store

The reader never throws and never silently drops. Every anomaly is counted:

| counter | meaning |
|---|---|
| `blank` | Empty or whitespace-only line. A trailing newline costs nothing. |
| `comment` | Line starting with `#`. |
| `malformed` | **Unparseable line in the middle of a file.** See below. |
| `not_an_object` | Parsed to a non-object. |
| `unrecognized` | No numeric `schema_version`. |
| `oversize_line` | Over 1 MiB. The reader resyncs at the next newline. |
| `truncated_tail` | Unparseable **final** line — a writer was mid-flight. Benign. |
| `unterminated_tail_parsed` | Complete final line with no trailing newline. Yielded. |

**`malformed > 0` is the signal that matters.** One record is one `write()` of one buffer, so a
break in the middle of a file means append atomicity failed on that filesystem — the one property
no specification guarantees on Windows or on a network volume. `router doctor` surfaces it, and
the fix is `telemetry.shardByPid: true`.

A record with a **newer** `schema_version` **is yielded**. Forward compatibility is the
aggregation layer's filter, not the reader's; the reader stays dumb.

## Durability

One record is one `fs.writeSync` of one buffer ending in `\n`, to a file opened `O_APPEND`, with
no explicit write position. There is deliberately **no `fsync`**: a per-record fsync costs
milliseconds on every hook, and the page cache already makes the bytes visible to every reader on
the machine. A kernel-level crash can therefore lose the tail of a segment. That is the right
trade for telemetry, and it is recorded here rather than left silent.

A single line is capped at 64 KiB including its newline. Over that, the size guard clamps
`error_message_safe` and then `question_text`, recording what it did in `truncation_steps`. If
that is still not enough — a pathological value in a field it cannot shrink — it writes a
*carcass*: every key present, non-required fields nulled, required strings clamped to 256 bytes.
**A record is never dropped and a partial line is never written.**
