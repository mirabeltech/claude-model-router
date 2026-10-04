# Worker dispatch

`lib/dispatch/` answers one question: given a decision the routing engine already approved, what
did the worker actually say? It joins three layers and owns none of their jobs. It does not
decide, does not retry, does not price anything, and does not write a telemetry row. It registers
no hook of its own: **`lib/hook/run.mjs` is its one caller**, on the `PreToolUse` path.

> **Failing to delegate is failing open.** The dispatcher's safe failure is to make no provider
> call, because the caller then does the work itself. That is CLAUDE.md's second non-negotiable
> seen from the other side: the gate must never block a session, and the executor must never
> invent an answer.

```
decision (routing)  ->  mode (prompt)  ->  registry  ->  provider  ->  result
```

## What dispatch owns, and what it does not

| concern | owner | why not dispatch |
|---|---|---|
| should this be delegated | `lib/routing.mjs` | `delegate` already answered. A second copy of a threshold is a second one to keep in sync. |
| retry and backoff | `withRetry()` in `providers/contract.mjs` | A backoff here would multiply the existing one, not replace it. |
| the HTTP shape of a provider | `providers/<id>.mjs` | Adding a provider must stay one file plus one registry line. |
| token normalization | `providers/contract.mjs` | The cached subtraction and the thinking split are already applied. Redoing either is how a cached token gets charged twice. |
| cost, savings, the event row | `lib/telemetry/` | Writing a row is the integration layer's decision. A dispatcher coupled to the sink could not be called by anything that did not want one written. |
| prompt wording | `lib/dispatch/modes.mjs` | — this layer |
| provider resolution and execution | `lib/dispatch/index.mjs` | — this layer |

## The result

Twenty-one fields, frozen, in a fixed order. No field is ever `undefined`: absent and `null` must
not be two ways of saying one thing.

```js
{
  ok: false,                  // status === 'ok'. Derived, never passed in.
  executed: false,            // was a provider attempt made — i.e. could money have been spent
  status: 'skipped',          // 'ok' | 'error' | 'skipped' — the telemetry value, by assignment
  reason: 'routing_declined', // which branch owned the outcome; a CODE, never prose
  mode: null,                 // 'bulk-reader' | 'code-writer' | null
  lane: null,                 // 'bulkRead' | 'codeWrite' | null — which workers.* block was read
  provider: null,             // resolved provider id; null only when resolution itself failed
  model: null,                // what the provider reports having SERVED
  modelRequested: null,       // what was ASKED for — gemini serves '-001' suffixes
  text: null,                 // the worker's answer
  usage: null,                // the provider's normalized Usage, verbatim
  capabilities: null,         // the provider's Capabilities; non-null once the module loaded
  attempts: null,             // 1-based. retry_count is attempts - 1
  latencyMs: null,            // END TO END: assembly, every attempt, parse
  providerLatencyMs: null,    // the final HTTP round trip only
  truncated: null,
  finishReason: null,
  error: null,                // {code, message, retryable, httpStatus, detail, provider} | null
  promptVersion: 1,
  policyVersion: 1,           // echoed from the decision that authorised this
  warnings: [],               // sorted, de-duplicated codes
}
```

`executed` and `status` are not redundant. Both `executed: false` with `status: 'error'` (the
provider was never reachable) and `executed: true` with `status: 'error'` (it answered badly) are
real, and only `executed` separates them.

`latencyMs` and `providerLatencyMs` are two fields rather than one lie, for the same reason the
telemetry schema keeps both: the first is the only one that includes a retry.

### `text`, not `output`

`buildEvent()` reads exactly `text`, `usage`, `model`, `providerLatencyMs`, `truncated` and
`finishReason` off a result object. Naming the answer `text` makes a dispatch result a structural
**superset** of `CompletionResult`, so the integration layer passes it straight through instead of
copying six fields across — and a copy is a thing that falls behind.

## Rule order

Evaluated top to bottom; the first match returns. `DISPATCH_REASONS` is listed in this order, so
the enum doubles as this table.

| # | reason | condition | `status` | `executed` | `error.code` |
|---|---|---|---|---|---|
| 1 | `invalid_request` | the decision, the config or the mode's input is unusable | `error` | no | `invalid_request` |
| 2 | `routing_declined` | `decision.delegate !== true` | **`skipped`** | no | `null` |
| 3 | `aborted` | the caller's signal was already aborted | `skipped` | no | `aborted` |
| 4 | `unsupported_mode` | `decision.mode` has no builder | `error` | no | `unsupported_mode` |
| 5 | `unsupported_provider` | the resolved id is not in the registry, or the module fails its contract | `error` | no | `unsupported_provider` |
| 6 | `provider_unavailable` | `readiness()` said no | `error` | no | `provider_unavailable` |
| 7 | `payload_too_large` | assembled bytes over the binding ceiling | `error` | no | `payload_too_large` |
| 7b | `context_exceeded` | the built prompt cannot fit the MODEL's context window | `error` | no | `context_exceeded` |
| 8 | `provider_error` | the provider threw | `error` | yes | the provider's code, verbatim |
| 9 | `aborted` | the caller aborted mid-flight | `error` | yes | `aborted` |
| — | `completed` | a provider returned text | `ok` | yes | `null` |

### The gate is `delegate`, not `decision`

`decide()` returns `decision: 'deny'` **while delegating** — `deny` means "block this tool call and
steer to the skill" — so `decision === 'deny' && delegate === true` is the shipped happy path for
the bulkRead lane. A dispatcher that gated on `decision === 'allow'` would refuse every delegation
the system exists to make. That is also why the refusal reason is spelled `routing_declined` and
not `routing_denied`: the latter reads backwards.

A refusal is `skipped`, not an error. The caller doing the work itself is the system working.

## Provider resolution

A lane's worker is `worker.*` refined by `workers.<lane>.*`, where `null` means inherit. The
inheritance is deliberately **asymmetric**:

| field | inherits | why |
|---|---|---|
| `provider` | always | there is one global worker; a lane only refines it |
| `model` | only when the provider did, else `providers.<id>.model` | a model id is meaningless against a different provider |
| `apiKeyEnv` | only when the provider did | an env-var name is meaningless against a different provider |
| `timeoutMs` | always | a millisecond budget carries no provider identity |

The asymmetry exists for one concrete failure. `worker.model` defaults to `gemini-2.5-flash`, so
`{"workers": {"codeWrite": {"provider": "ollama"}}}` with symmetric inheritance would ask Ollama
for a Gemini model. `ollama.mjs` takes `model || providerConfig.model`, so the configured
`qwen2.5-coder:7b` would never be consulted, the daemon would answer HTTP 200 with a "model not
found" body, and the only clue would be a Gemini model name inside an Ollama error.

The rule keys on the resolved **value**, not on "did the leaf fall back", so writing the same
provider out explicitly is a no-op rather than a reset.

`temperature`, `maxOutputTokens` and `maxRetries` are not per-mode, for the same reason
`timeoutMs` always inherits: none of them carries provider identity.

### How settings reach the provider

Through a derived config — `{...config, worker: {...config.worker, provider, model, apiKeyEnv,
timeoutMs}}` — which is then handed to `callWorker()`. That is what keeps provider-specific
branches out of the dispatcher entirely: `callWorker` resolves `providers.<id>` itself. The
derived object is never mutated and never reaches the telemetry sink, whose cache is keyed on
config identity.

## Availability

`readiness()` is synchronous and makes no network request, and the dispatcher adds none. A probe
would put a round trip in front of every delegation, and the tests assert `server.requests.length`
is unchanged across an unavailable call.

**`apiKeyEnv` renames a key a provider needs; it does not invent one.** `readinessFor()` treats a
supplied name as *replacing* the provider's own `requiresEnv`, so the dispatcher forwards it only
when the provider's capabilities say a key is wanted. Without that, switching `worker.provider`
to a local model while leaving `worker.apiKeyEnv` at its default would report a running Ollama
daemon as unavailable for want of a Gemini key.

**There is no fallback.** Phase 4 defines no fallback contract, and an unavailable provider is
never silently replaced by a working one: that would bill an account the operator did not choose
and log a model they never configured. A future provider-routing layer can add one deliberately.

## Timeout and abort

Both are honoured, and they are different things.

| mechanism | source | arrives as | reported as |
|---|---|---|---|
| configured timeout | `workers.<lane>.timeoutMs` ?? `worker.timeoutMs` | `ProviderError('timeout')` | `provider_error` / `timeout` |
| caller abort | the `signal` argument | `ProviderError('transport', '…request cancelled')` | `aborted` / `aborted` |

**An abort is identified by the signal, never by the message.** A cancel and a dead socket share
the `transport` code, so matching on the text would break the moment anyone rewords it. Checking
the signal is exact because `httpJson` composes `AbortSignal.any([signal, timeoutCtl.signal])`:
aborting the caller's signal leaves the timeout controller untouched, and vice versa. The signal
is checked first, because if both fired the caller's intent wins.

## Context budget

Step 9b, after the prompt is built. The ceiling below is a **transport** limit in bytes; this
is a **context** limit in tokens, and the two have different fixes - raise the knob, versus
choose a model with a larger window. Hence a separate reason code.

Output may be **reduced** to leave room for the prompt. Input is never reduced: for a bulk
read, dropping file content invalidates the whole optimisation, so an oversized prompt is
refused instead. A capability we cannot determine proceeds under the byte ceiling and warns,
because a router that cannot determine a window must degrade to plain Claude Code rather
than to a blocked session.

After a successful call, `prompt_eval_count` is compared against the estimate. A material
shortfall means the provider silently dropped prompt content, and **the answer is discarded**
rather than returned with a warning - Ollama drops the *middle*, and `hook/run.mjs`
substitutes the worker's text for the real `Read` whenever the status is `ok`, so a warning
would be invisible to the person being misled.

`docs/worker-capability.md` holds the capability model, the budget formula and the
measurements behind both.

## Payload ceiling

The configured ceiling and the provider's own are both real limits, so the binding one is
`min(config.worker.maxInputBytes, capabilities.maxInputBytes)`, checked before any socket opens
and reported with the existing `payload_too_large` code. Checking only the config value would
never fire for Ollama (1 MB) or mock (64 KB), both under the 2 MB default; checking only
capabilities would leave the documented knob unenforced at execution time.

## Error vocabulary

`context_exceeded` is the sixth dispatcher-owned code. It is never retryable: a context
window is not a transient condition.

Nineteen codes: the fourteen provider `ERROR_CODES` passed through **verbatim**, plus five the
dispatcher owns because they arise before or outside a call.

| dispatcher-owned | raised when |
|---|---|
| `invalid_request` | the decision, config or mode input is unusable |
| `unsupported_mode` | no builder is registered for the mode |
| `unsupported_provider` | the id is not in the registry, checked **before** `loadProvider()`, which would otherwise report `config` and conflate "does not exist" with "is misconfigured" |
| `provider_unavailable` | a required environment variable is absent |
| `aborted` | the caller's signal fired |

`DISPATCH_ERROR_CODES` is **derived** from `ERROR_CODES` rather than re-typed, so a new provider
code cannot desync the two, and a test asserts the difference is exactly those five.

**Dispatcher errors are never a `ProviderError`.** Its constructor does
`this.code = ERROR_CODES.includes(code) ? code : 'unknown'`, so a `ProviderError` built with
`'aborted'` would silently become `'unknown'`. They are plain frozen objects instead.

Both `error.message` and `error.detail` are scrubbed with `redactSecrets` regardless of origin.
`httpJson` redacts `detail` but not `message`, and `parseOllamaResponse` interpolates raw daemon
text straight into a message, so scrubbing only what this layer writes itself would leave that
path open.

## Security boundary

| claim | how it is enforced |
|---|---|
| no filesystem, no shell, no child process | the layer imports no `node:` builtin at all — a static test, not a convention |
| content is received, never discovered | `files[].content` comes from the caller; a `path` is a label and nothing resolves it |
| nothing is logged | no `console.` and no `process.stdout` in the layer, comments stripped before the scan |
| no telemetry edge | nothing in `lib/dispatch` imports `lib/telemetry`, and nothing in `lib/telemetry` imports `lib/dispatch` |
| secrets do not survive into a result | both error fields redacted; the prompt is never echoed back |

The dispatcher does **not** re-check deny globs. The gate owns that rule, and a second copy in a
second place is two copies that drift. Correspondingly, nothing in the result claims the corpus
was screened.

All of the above live in [`test/telemetry.isolation.test.mjs`](../test/telemetry.isolation.test.mjs),
which is where this repo keeps architecture rules, because a purity rule that is only a comment is
a purity rule that will be broken by a well-meaning import six months from now.

## Modes

Two, and only two, keyed off `LANE_MODE`'s values so a lane added to the routing policy without a
mode shows up as a missing key rather than as a mode nobody notices is unreachable.

| mode | input |
|---|---|
| `bulk-reader` | `{files: [{path, content}], task, instructions?, outputRequirements?}` |
| `code-writer` | `{instruction, context?, reference?, instructions?, outputRequirements?}` |

The two optional arrays are produced by `lib/dispatch/task.mjs` from a task intent, and render as
one `# Requirements` section. Absent or empty, nothing is emitted and the prompt is byte-identical
to the pre-Phase-7 template — which is what makes the shipped default a no-op. See
[worker-task-construction.md](worker-task-construction.md).

Prompts are literal templates filled by concatenation. No model is called to write a prompt for a
model: an unreproducible request cannot be compared across a threshold change. `build()` returns
the version of the prompt it actually produced — `PROMPT_VERSION` (3) for the generic request,
`INTENT_PROMPT_VERSION` (4) when the requirements section is present — and `dispatch()` stamps
that returned value rather than the module constant, because a row carrying extra input tokens
must say so or a reader will subtract it from a generic row.

Every template is built with `join('\n')`, never a multi-line template literal. `core.autocrlf` is
on, so a literal would hold `\r\n` in a Windows checkout and `\n` in a Linux one — and CI gates on
both. `.gitattributes` now normalises the repository too, but an explicit join does not depend on a
repository setting being in force.

The bulk-reader is **not** told to produce a particular answer SHAPE. Imposing a serialization
format would be an artificial semantic interpretation of an answer this layer does not read, and
nothing in either template mentions JSON, YAML or a schema — asserted over the built prompt, not
just the system string, in `test/task.builder.test.mjs`.

Content requirements are a different thing and are allowed: "give the line number", "find every
occurrence", "do not invent a match" constrain WHAT is answered, not how it is encoded. Phase 7
added those, and only when a task intent supplied them.

## Configuration

| key | default | notes |
|---|---|---|
| `workers.bulkRead.provider` | `null` | inherit `worker.provider` |
| `workers.bulkRead.model` | `null` | inherit, per the asymmetry above |
| `workers.bulkRead.apiKeyEnv` | `null` | inherit, per the asymmetry above |
| `workers.bulkRead.timeoutMs` | `null` | inherit `worker.timeoutMs`; same bounds, pinned by a test |
| `workers.codeWrite.*` | `null` | the same four |

Every leaf is nullable and defaults to `null`, so **no shipped default is copied** and the SPEC and
DEFAULTS tables cannot drift. Each has a `CMR_*` override (`CMR_BULK_READ_WORKER_PROVIDER` and so
on). The string leaves are `nonEmpty`, which is load-bearing: without it
`CMR_BULK_READ_WORKER_PROVIDER=""` would resolve to `''`, and `??` does not catch `''`, so the lane
would resolve a provider id of empty string rather than inheriting.

## Telemetry

**Dispatch emits nothing.** It is not coupled to the sink and imports nothing from it. A later
integration layer combines a decision, a dispatch result, primary usage and pricing into an event:

```js
buildEvent({
  result: d.status === 'ok' ? d : null,   // d is a CompletionResult superset
  error: d.error,
  capabilities: d.capabilities,
  attempts: d.attempts,
  latencyMs: d.latencyMs,
  providerId: d.provider,
  config: derivedConfig,                  // buildEvent reads config.worker.model for model_requested
})
```

`buildEvent` derives `status` as `error ? 'error' : result ? 'ok' : 'skipped'`, which is why
`result` is passed only on the `ok` path.

`ROUTING_REASONS` is closed on write, and `completed`, `routing_declined` and `aborted` are not
members. **A dispatch reason must not be passed straight through** — it would stamp
`unknown_enum:routing_reason` on every row. The mapping:

| dispatch `reason` | telemetry `routing_reason` |
|---|---|
| `completed` | echo `decision.reason` (normally `threshold_met`) |
| `routing_declined` | echo `decision.reason` — already a member of both enums |
| everything else | `provider_error` |

There is no `prompt_version` column, exactly as there is no `routing_policy_version` column. The
dispatcher stamps `promptVersion` in its result so the phase that does the writing can add the
field — additive and nullable, so still no schema bump.

## Known discrepancy

**Two error codes are unreachable.** `quota` is declared in `ERROR_CODES` but no provider
constructs it, and every status the fixture server can send maps to something more specific than
`http_4xx`. Rather than add scenarios to a shared fixture to chase a green reachability test, the
suite asserts the static superset and this paragraph states the gap.

**`withRetry` is signal-blind.** It sleeps between attempts without checking the caller's signal,
so an abort during a backoff is honoured only on the next fetch — up to `400 · 2^attempt` ms late.
The dispatcher cannot shorten that without taking over retry, which it deliberately does not do.

**A global provider change leaves `worker.model` behind.** Setting `worker.provider` alone — as
`CMR_WORKER_PROVIDER=ollama` does — keeps `worker.model` at its Gemini default, and a lane
inheriting a provider also inherits its model, faithfully. The per-lane asymmetry above protects
the lane case, not the global one. `npm run doctor` prints the resolved pair for both modes, which
is where that mismatch becomes visible.

**`dispatch()` has exactly one caller.** `lib/hook/run.mjs` invokes it for a delegated `Read`,
under the hook's own deadline rather than `worker.timeoutMs` — see
[hook-integration.md](hook-integration.md). No delegation-steering skill ships, so nothing invokes
the `code-writer` mode and the `codeWrite` lane remains advisory and unreachable. The one shipped
skill, `router-dashboard`'s `router-report`, reads analytics and dispatches nothing.

## The reachable timeout ceiling

`worker.timeoutMs` accepts up to 1,800,000 ms. **Only about 300,000 of that is reachable.**

Node's bundled HTTP client stops waiting for response headers after 300 s
(`FETCH_HEADERS_TIMEOUT_MS` in `providers/contract.mjs`), and `fetch` exposes no standard way
to raise it without reaching for a dispatcher outside the public API. A call that needs longer
is killed there, at a number nobody configured.

This only binds on very slow local models — a hosted provider answers in seconds — but it bit
a live benchmark in phase 8 and cost two real defects on the way:

- The runtime's timeout arrived as a `transport` error, i.e. "network failure", which points an
  operator at their network rather than their model. It is now detected by its
  `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` cause and reported as `timeout`, with a
  message naming the ceiling that actually applied.
- `transport` is in `RETRYABLE`, so a call that could not possibly fit the budget was retried
  three times. Classifying it as a timeout does not stop retries (timeouts are legitimately
  retryable), but it does stop the misattribution — and `router doctor` now WARNs when a
  configured timeout exceeds what the runtime will honour, which is the actionable half.

The ceiling is documented and surfaced rather than worked around: replacing `fetch` with
`node:http` to gain one knob would trade the whole transport layer for it.
