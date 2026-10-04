# configuration

Not written yet. See [`plugins/model-router/lib/config.schema.json`](../plugins/model-router/lib/config.schema.json)
— generated from the same `SPEC` table that enforces validation at runtime, so it cannot drift —
and the README's Configuration section until this lands.

Two keys that are easy to miss because they govern what leaves the machine:

| key | default | effect |
|---|---|---|
| `hooks.taskIntent.source` | `none` | `transcript` forwards your newest session prompt to the worker as the question. Off by default. |
| `hooks.taskIntent.maxChars` | `600` | Ceiling on how much of it may be sent. Longer intent is truncated, never dropped. |

Env: `CMR_TASK_INTENT_SOURCE`, `CMR_TASK_INTENT_MAX_CHARS`. Full discussion, including what the
redaction boundary does and does not cover, is in
[worker-task-construction.md](worker-task-construction.md).

## Ollama context window (phase 8)

| leaf | type | default | meaning |
| --- | --- | --- | --- |
| `providers.ollama.contextTokens` | int \| null | **`null`** | The model's context window, in tokens. |
| `providers.ollama.discoverContext` | bool | `true` | Ask the daemon via `/api/show`. |

`contextTokens` ships as `null`, not a number, and that is deliberate: a shipped default
would be a **fabricated capability**, and it would be wrong for whichever of
`llama3` / `mistral` / `qwen2.5-coder` you actually pulled. `null` means unknown, and unknown
is never treated as infinite — the window is discovered from the daemon, then looked up in a
small bundled table, and a request that still cannot be shown to fit is **refused** rather
than silently truncated.

Set it to override both, for instance when you run a model behind a proxy that reports
nothing, or when you deliberately want a smaller window than the model supports. A configured
value above what the provider reports is clamped down to the provider's number, because both
limits are real and the binding one is the smaller.

`discoverContext` defaults on: one cached localhost call per model per process, measured at
about 7 ms, made *after* the routing gate has already approved delegation. Turn it off to
rely on `contextTokens` and the bundled table alone.

### Coherence rules

Two rules run in `resolveConfig()`, both of which **warn and never substitute**:

- `worker.maxOutputTokens >= providers.ollama.contextTokens` leaves no room for a prompt, so
  the output request is clamped to `contextTokens - 1`.
- A model named like a *different* provider's model — `provider: ollama` with
  `model: gemini-2.5-flash`, the classic result of switching one and forgetting the other —
  is reported as a mismatch. Nothing is substituted: no silent fallback to Gemini, no silent
  fallback to Ollama. `npm run doctor` reports it as a FAIL.

See `docs/worker-capability.md`.

## Budget governance (phase 9)

| leaf | type | default | meaning |
| --- | --- | --- | --- |
| `budget.enabled` | bool | `true` | Master switch. Off, no limit is evaluated and no state is read or written. |
| `budget.run.maxWorkerCostUsd` | number \| null | **`null`** | Cost ceiling for ONE delegation. |
| `budget.run.maxInputTokens` | int \| null | **`null`** | Worker input tokens for one delegation. |
| `budget.run.maxOutputTokens` | int \| null | **`null`** | Worker output tokens for one delegation. |
| `budget.run.maxTotalTokens` | int \| null | **`null`** | Total worker tokens for one delegation. |
| `budget.daily.maxWorkerCostUsd` | number \| null | **`null`** | Cost ceiling per UTC day. |
| `budget.daily.maxTotalTokens` | int \| null | **`null`** | Total worker tokens per UTC day. |
| `budget.monthly.maxWorkerCostUsd` | number \| null | **`null`** | Cost ceiling per UTC month. |
| `budget.monthly.maxTotalTokens` | int \| null | **`null`** | Total worker tokens per UTC month. |
| `budget.onExceed` | enum | `disable` | `disable` refuses delegation; `warn` records the breach and delegates anyway. Neither fails your request. |
| `budget.onUnknownCost` | enum | `allow` | What to do when a monetary budget is set but the cost is unknown. |
| `budget.onUnknownUsage` | enum | `allow` | Same, for a provider that reports no token counts. |
| `budget.stateDir` | string | `~/.claude/model-router/governance` | Where the accounting ledger lives. |

Env: `CMR_BUDGET_ENABLED`, `CMR_RUN_BUDGET_USD`, `CMR_RUN_MAX_INPUT_TOKENS`,
`CMR_RUN_MAX_OUTPUT_TOKENS`, `CMR_RUN_MAX_TOTAL_TOKENS`, `CMR_DAILY_BUDGET_USD`,
`CMR_DAILY_MAX_TOTAL_TOKENS`, `CMR_MONTHLY_BUDGET_USD`, `CMR_MONTHLY_MAX_TOTAL_TOKENS`,
`CMR_BUDGET_ON_EXCEED`, `CMR_BUDGET_ON_UNKNOWN_COST`, `CMR_BUDGET_ON_UNKNOWN_USAGE`,
`CMR_BUDGET_STATE_DIR`.

### Three states, not two

`null` is **no configured limit** and is what ships. `0` is a deliberately configured **zero
budget** that refuses everything. A negative number is **invalid** and is rejected, falling back to
the default with a warning — it is never read as a zero budget, because that would disable all
delegation on a typo.

So out of the box governance is wired, tested and documented, and enforces nothing.

### A token budget binds; a dollar budget may not

Every rate in the bundled pricing table ships `null`, so worker cost is NULL until you configure
`pricing.overrides`. A monetary budget therefore has nothing to accumulate against on a default
install, and `npm run doctor` says so rather than letting you believe a ceiling is enforced. A
**token** budget works immediately wherever the provider reports usage.

A local provider is a third case: its cost is a *structural* zero rather than an unknown, so a
dollar ceiling does not apply to it at all and doctor reports that as healthy.

`npm run budget` prints the current limits, UTC period and spend. It is read-only and creates
nothing — including on an unconfigured install, where touching the disk would falsify the very
property it is reporting.

Full discussion, including the accounting rules, the concurrency guarantees and what is *not*
guaranteed: [governance.md](governance.md).
