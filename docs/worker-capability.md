# Worker capability and context budgeting

Three numbers get called "the context limit", and conflating them is how a router comes to
promise capacity it has not got. This document says which is which, how the system keeps
them apart, and what was measured to justify the design.

> **A configured value is never a measured capability.** `source` and `status` travel with
> every context number, and `statusForSource()` in
> `plugins/model-router/lib/providers/capability.mjs` is the only place the mapping between
> them exists.

---

## 1. What was measured

All figures below are from a live Ollama 0.34.4 daemon, CPU-only (`/api/ps` reports
`size_vram=0`), with `llama3:latest` (8B Q4_0) and `mistral:latest` (7.2B Q4_K_M).

### Output reservation is not the mechanism

| prompt | `num_predict` | `num_ctx` sent | `prompt_eval_count` |
| --- | --- | --- | --- |
| 17,368 tok | 1 | — | **2060** |
| 17,368 tok | 8192 | — | **2060** |
| ~4,100 tok | 32 | — | **2060** |

`prompt_eval_count` is invariant across an 8192× change in `num_predict`. Requesting more
output tokens does **not** shrink the prompt window, so the earlier theory — that
`worker.maxOutputTokens = 8192` was reserving space out of a 4096-token context — is
refuted and does not appear anywhere in this design.

### The real mechanism: a dynamically sized window, and the middle is dropped

The ~4,100-token probe planted a value at line 500 of 1000 with unique markers at the head
and tail. Result: `prompt_eval_count = 2060`, and the planted value was **not recovered** —
while the 17k-token probe reproduced *both* its end markers.

So the daemon keeps the head (`num_keep`) and the tail and **silently discards the middle**.
A fact buried mid-file is not "missed by a weak model"; it is never shown to the model.
2060 is consistent with a 2048-token serving window plus `num_keep` slack, but the exact
constant is not the point — it is well below both the configured limits and the model's 8192
architectural context, and it is **not stable**: an earlier session on the same model
observed 3985 under different memory conditions.

Before this phase, that meant a bulk read could be delegated, report success, and return a
summary derived from roughly half the bytes it was paid to send.

### Sending `num_ctx` fixes the truncation, and does not fix the answer

| `num_ctx` sent | `prompt_eval_count` | middle fact recovered? |
| --- | --- | --- |
| — (default) | 2060 | no |
| `8192` | **4108** | **no** |

The whole prompt is now evaluated. The model still answered wrongly, having been shown
every byte. **The runtime correction is necessary and not sufficient:** there are two
independent causes of a missed buried fact, and only the first is a router defect.

### Architectural context is discoverable, cheaply

- `POST /api/show` → `model_info["<family>.context_length"]` (llama3 `8192`, mistral `32768`)
- `GET /api/tags` → `details.context_length`, the same number
- `GET /api/ps` → `.context_length`, the window the *loaded* instance allocated

Discovery costs about **7 ms** to localhost, and 0 ms once memoised.

`details.family` is `llama` for *both* installed models, so the `model_info` key is
`llama.context_length` in both cases. Building the key from `family` alone is therefore not
reliable, and `contextTokensFrom()` falls back to any *single* key ending in
`.context_length`. Two candidates means neither is taken — a guess between them would be
worse than reporting unknown.

---

## 2. The three numbers

| number | source | what it means | certainty |
| --- | --- | --- | --- |
| `providers.ollama.contextTokens` | the operator | an application limit | asserted |
| `model_info["*.context_length"]` | `/api/show` | architectural ceiling of the weights | an upper bound |
| `prompt_eval_count` | the response | tokens actually evaluated | ground truth, after the fact |

The default serving allocation (2048 here) appears in **none** of the first two before the
call. That gap is why `capability_source` and `capability_status` exist.

### `maxInputBytes` is none of them

`capabilities.maxInputBytes` is a **transport** ceiling in bytes: provider-wide, static, and
not a context window. Ollama advertises `1_000_000` and cannot ingest a quarter of that on
an 8192-token model. No context math reads it, and
`test/providers.capability.test.mjs` asserts the string does not appear in either pure
module.

---

## 3. The capability model

`lib/providers/capability.mjs` — pure, zero imports.

```
CAPABILITY_SOURCES   provider_api | configured | bundled_default | unknown
CAPABILITY_STATUSES  measured     | configured | assumed         | unknown
```

`configured` is deliberately both a real source and an explicitly **non-measured** status.
Only `provider_api` earns `measured`.

**Invariant:** `contextTokens === null` exactly when `status === 'unknown'`. A number with an
unknown status would be a value nobody can weigh; an unknown status carrying a number would
be a measurement pretending to be a guess. `validateCapabilityRecord()` enforces it and the
provider conformance suite applies it to every record `describeModel()` returns.

### Resolution order

| configured | discovered | bundled | result |
| --- | --- | --- | --- |
| set | set | — | `min(configured, discovered)`, source `configured` |
| set | — | — | `configured` / `configured` |
| — | set | — | `discovered` / `measured` |
| — | — | set | `bundled_default` / `assumed` |
| — | — | — | `unknown` / `unknown`, `contextTokens: null` |

When a configured value and a measurement disagree, both limits are real, so the binding one
is the **smaller** — the same reasoning dispatch already applies to its two byte ceilings.
The result is labelled `configured`, the **weaker** of the two statuses, because an
operator's assertion clamped by a measurement is still an assertion.

### The bundled table

`BUNDLED_MODEL_CONTEXT` carries only what is known, and its editing rule is part of the
contract:

> **When unsure, omit the entry.** A missing entry resolves to `unknown`, which fails open to
> plain Claude Code. An entry that guesses **high** authorises a prompt the model will
> silently truncate, which is the one failure this design exists to prevent.

`llama3: 8192` and `mistral: 32768` are measured on this machine. There is **no fuzzy
matching**: `llama3-finetune-of-mine` does not inherit `llama3`'s window, because a prefix
match would invent a capability for a model nobody has run.

---

## 4. Context budgeting

`lib/context-budget.mjs` — pure, zero imports, token-denominated. The third pure module
beside `config.mjs` and `routing.mjs`.

```
shared window    effectiveInputCapacity = contextTokens − requestedOutputTokens
separate window  effectiveInputCapacity = contextTokens
```

`capabilities.contextWindowModel` carries the variation, so no provider is assumed to behave
like another: Ollama is `shared`, Gemini `separate` (independent `inputTokenLimit` and
`outputTokenLimit`, and a loud 400 on overflow), and mock `unknown`. **`unknown` is read as
`shared`**, the formula that can only ever refuse more.

### Verdicts, in order — first match owns the reason

| # | condition | verdict / reason |
| --- | --- | --- |
| 1 | prompt size not a count | `unknown` / `input_size_unknown` |
| 2 | output request not positive | `unknown` / `output_request_invalid` |
| 3 | `contextTokens === null` | `unknown` / `capability_unknown` |
| 4 | `contextTokens <= 0` | `unknown` / `capability_invalid` |
| 5 | window model unstated | treated as `shared`, warned |
| 6 | input fits | `fits` / `within_window` |
| 7 | headroom ≥ 256 | `cap_output` / `output_capped_to_fit` |
| 8 | headroom > 0 but < 256 | `refuse` / `output_floor_unreachable` |
| 9 | headroom ≤ 0 | `refuse` / `input_exceeds_window` |

Rows 8 and 9 are separate reasons because they have separate fixes: send fewer files, versus
choose a model with a larger window. `MIN_USEFUL_OUTPUT_TOKENS = 256` exists because capping
a bulk-read summary below a few hundred tokens is not a cap — it is a silent failure wearing
a cap's clothes, and the hook would substitute that sentence for the file.

`fits` is **tri-state**. `null` means unknown; `false` means measured and does not fit.

### Rounding runs both ways

`estimateTokensFromBytes` rounds **up** (never understate a prompt);
`capacityTokensFromBytes` rounds **down** (never overstate the room). `telemetry/calc.mjs`
floors because a savings figure must stay a floor — the opposite direction. One shared
function would be wrong for at least one caller, so the divisor is duplicated and
`test/context-budget.test.mjs` **pins the two equal** instead.

Bytes, not characters: `assertPayloadSize` already measures UTF-8 bytes, and `bytes >= chars`,
which is the conservative direction for a refusal.

### `num_ctx` is a coarse bucket, not the maximum and not the exact need

```
num_ctx = min(contextTokens, smallest bucket >= input + allowedOutput)
NUM_CTX_BUCKETS = [4096, 8192, 16384, 32768, 65536, 131072]
```

Asking for the model's maximum would make the daemon allocate a 128k KV cache for a 4k
prompt. Asking for the exact need, rounded to something fine like 1 KB, is worse — and this
one was measured:

| call | `num_ctx` | total | `load_duration` |
| --- | --- | --- | --- |
| first | 8192 | 12.3 s | 10.0 s |
| repeat | 8192 | **1.0 s** | **0.0 s** |
| changed | 4096 | 11.0 s | 8.5 s |
| repeat | 4096 | **1.0 s** | **0.0 s** |

**Changing the requested window forces a full model reload — about 8.5 s of pure load time
here.** The hook that calls all this has a 20-second budget (`hooks.timeoutMs`), so a
reallocation provoked by nothing more than the next file being a kilobyte larger does not
merely cost time: it can exhaust the budget and abort the delegation outright.

Coarse buckets mean a session normally allocates **once** and reuses it. Nine realistic file
sizes that 1 KB rounding would spread across six windows share two.

**The input estimate is marked up before it sizes a window.** `chars/4` under-counts code, so a
window sized from it can be smaller than the prompt it has to hold — which is a silent data loss
on a provider that truncates. This was not hypothetical: a case estimated at 3,301 tokens was
really 4,265, asked for a 4,096-token window, and was truncated. `WINDOW_SIZING_MARGIN` (1.35,
the inverse of ~3 bytes per token against the assumed 4) is applied to the input estimate only;
the output request is exact because we chose it.

The under-count stays everywhere else, because everywhere else it is the safe direction: it
makes a fit decision cautious, and it keeps `detectSilentTruncation` quiet on a healthy call.

---

## 5. Where it is enforced

| situation | behaviour |
| --- | --- |
| input + output fit | proceed |
| output overflows a shared window | **reduce output** to the headroom, warn `output_capped` |
| output over a separate provider ceiling | **reduce output** to that ceiling |
| input alone over the window | **refuse** — `context_exceeded` |
| headroom below the useful floor | **refuse** — `context_exceeded` |
| capability unknown | **proceed** under the byte ceiling, warn — the fail-open branch |
| response shows a prompt-token shortfall | **discard the answer** — `context_exceeded` |
| truncating input | **forbidden, never implemented** |

Two new steps in `lib/dispatch/index.mjs`:

- **8b** resolves the capability. After readiness, so an unavailable provider is never
  probed; before `mode.build()`, so step 8's ordering survives. Never throws.
- **9b** decides, reusing the byte count `assertPayloadSize` already returns — so the
  dispatch layer grows no new primitive and keeps its no-`node:`-import property.

### Why the answer is discarded, not annotated

Ollama drops the **middle**, and `lib/hook/run.mjs` substitutes the worker's text for the
real `Read` whenever the status is `ok`. A telemetry warning would therefore be invisible to
the person being misled, and the summary would be a confabulation risk on exactly the content
they cannot see is missing. The cost of discarding is one wasted local call; the developer
gets the real file.

### `prompt_eval_count` as a truncation detector

`detectSilentTruncation()` compares our estimate against what the runtime reports it read,
with a tolerance of `max(64, 10%)`. The tolerance leans the right way: `chars/4`
*under*-counts code, so on a healthy call the observed count comes back **higher** than the
estimate — measured at 4108 against ~4100. A shortfall is therefore a signal rather than a
rounding artefact, and 2060-against-4342 is unmistakable.

Returns `null`, never `false`, when either side is unavailable. An unmeasured call is not a
clean one.

---

## 6. Nothing reaches the routing gate

A per-model window is knowable three ways and the gate can use none:

- **measured** needs a network call, which `decide()` never makes
- **bundled table** needs the resolved model, i.e. importing `lib/dispatch` → `lib/providers`
  into the gate, putting a provider module behind every tool call
- **configured** the gate already reads, in the only unit it has — `policy.workerMaxInputBytes`
  against raw `inputBytes`, under reason `over_max_input_bytes`

> **The gate enforces what config can express in bytes; `dispatch()` enforces what capability
> can express in tokens.**

`decide()`'s sixteen-field input, `DECIDE_REASONS`, `readPolicy()`'s output and
`WORKER_UNAVAILABLE_REASONS` are all unchanged. The tempting seam — reporting
`worker_not_ready` for an over-large file — is rejected: it would report a global condition
for a per-file fact, and make every small read in the session look like a broken worker.

`test/routing.capability.test.mjs` exists to keep that argument from eroding. It asserts an
absence, which is unusual, and that is the reason it exists: a future reader with a plausible
optimisation would otherwise find no obstacle.

---

## 7. Fail-open, traced

`lib/hook/run.mjs` builds a substituted response **only** when `result.status === 'ok'`;
every other status yields `response: null` and the hook writes no bytes, so the original
`Read` proceeds untouched. Therefore:

- a window we cannot determine → plain Claude Code
- a window that refuses → plain Claude Code
- a daemon that is down during discovery → plain Claude Code
- a `describeModel()` that throws → caught, `unknown`, plain Claude Code

Never a blocked session.

---

## 8. Configuration

| leaf | default | meaning |
| --- | --- | --- |
| `providers.ollama.contextTokens` | **`null`** | the window, in tokens. `null` means unknown, and unknown is never infinite. |
| `providers.ollama.discoverContext` | `true` | ask `/api/show`, once per model per process |

`contextTokens` ships as `null` rather than a number because a shipped default would be
exactly the fabrication this design forbids — and it would be wrong for whichever of
llama3 / mistral / qwen2.5-coder the developer actually pulled.

Discovery defaults **on**: ~7 ms to localhost, memoised, after the gate has already approved
delegation, on a path about to spend seconds inside a local model. Default-off would mean the
protection does not exist until somebody already knows they need it.

One cross-field coherence rule, alongside the existing `telemetry.residencyTurns` rule: if
`contextTokens` is set and `worker.maxOutputTokens >= it`, the output request is clamped to
`contextTokens - 1` and a warning is recorded. Clamped to `-1`, not to a fraction, because
config's job is **coherence, not policy** — whether the remainder is *useful* is
`MIN_USEFUL_OUTPUT_TOKENS`'s question, and a usefulness floor in `config.mjs` would be a
second copy of a policy constant.

---

## 9. Provider/model coherence

Decided **negatively**. A positive "is this a valid ollama model" test is impossible — a
local tag is any string the developer pulled or built — so an allowlist would reject every
model nobody enumerated. Instead, a model is incoherent when **another registered provider
claims its naming shape**:

- `provider=ollama, model=gemini-3.8-flash` → Gemini claims it → **mismatch**
- `provider=ollama, model=llama3:latest` → nobody else claims it → **coherent**
- model missing after inheritance → **unresolved**, a distinct third state

`PROVIDER_MODEL_PATTERNS.ollama` is an empty array *listed deliberately*, so a reader can
tell "claims nothing" from "nobody filled this in".

`resolveConfig()` **warns and changes nothing**: no substitution, no fallback to Gemini, no
fallback to Ollama. It cannot throw — a PreToolUse hook loads it — and it must not guess.
Doctor reports a mismatch as **FAIL**. Runtime behaviour is left to the provider, because
Ollama already answers a bad model with `model_not_found` from the daemon itself, which is a
true report and strictly better than a name-shape guess.

A lane whose model is `null` inherits, and the inherited pair is already reported as
`worker`, so it is not re-reported per lane — one mistake stays one mistake.

---

## 10. Telemetry

Seven additive, nullable columns. **No `SCHEMA_VERSION` bump** (additive and nullable) and
**no `CALC_VERSION` bump** (no formula or null rule in `calc.mjs` changed, and none of these
participates in cost or savings arithmetic).

| column | semantics |
| --- | --- |
| `worker_context_tokens` | the resolved window; `null` when unknown |
| `worker_context_source` | `CAPABILITY_SOURCES`, open on read |
| `worker_context_status` | `CAPABILITY_STATUSES`, open on read |
| `worker_requested_input_tokens` | our `chars/4` estimate for the assembled prompt — what the decision was made on |
| `worker_configured_max_output_tokens` | the output budget requested, before any cap |
| `worker_effective_input_capacity` | tokens left for the prompt after the output request |
| `worker_input_truncation_detected` | **tri-state** `true`/`false`/`null` |

The last is the one that is not optional: it is the "surfaced, not swallowed" requirement,
and a `false` where we do not actually know would be the reassuring zero this project forbids.

These are recorded on **every dispatched path, including a refusal** —
`buildEvent()` takes them as explicit inputs rather than reading them off `result`, because
`result` is passed only on the `ok` path, and a context refusal is precisely the row where
the window that caused it must survive.

`record.mjs` declares its own copy of both vocabularies, because a column's vocabulary is a
property of the schema rather than of whichever layer populates it;
`test/capability.test.mjs` pins the two copies equal, the same arrangement `DECIDE_REASONS`
has with `ROUTING_REASONS`.

---

## 11. Security

No new exposure. Discovery sends **only a model name** to a localhost daemon the worker
already talks to — strictly less than the file content already sent. No shell execution, no
new filesystem access, no session scraping, no credential forwarding.

The standing disclosure is unchanged: **file content can be sent to the configured worker
provider, and nothing redacts it.** `test/task.security.test.mjs` continues to pin that in
both directions.

---

## 12. Known limitations

1. The architectural context from `/api/show` is an **upper bound**, not a promise about the
   live allocation. Sending `num_ctx` is what closes that gap, and the post-hoc detector is
   what catches it when something still goes wrong.
2. **Gemini's window is not discovered.** It resolves `unknown` and behaves exactly as it did
   before this phase. Nothing here changes Gemini.
3. The bundled table will go stale as models are pulled. Discovery is the mitigation; the
   omit-when-unsure rule is the fallback.
4. Fixing truncation did not fix the probe's answer (§1). Worker quality has a second,
   independent cause that neither context budgeting nor task construction addresses.
5. `prompt_eval_count` is only available from providers that report usage. A provider with
   `reportsUsage: false` cannot be checked for silent truncation at all.
