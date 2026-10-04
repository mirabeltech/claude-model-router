# Adding a provider

A provider is one file plus one registry line. Routing, the hook, telemetry and analytics are
untouched, because they resolve `worker.provider` through the registry rather than importing a
provider directly — `providers/` is one of the two deliberate swap points in the system.

## The five exports

```js
export const id = 'myprovider'                 // must match the registry key

export const capabilities = {
  maxInputBytes: 1_000_000,       // TRANSPORT ceiling in BYTES. Not a context window, and no
                                  // context arithmetic may read it.
  supportsSystemPrompt: true,
  reportsUsage: true,             // false means every cost on every row becomes NULL
  reportsThinkingTokens: false,
  requiresEnv: ['MYPROVIDER_API_KEY'],   // [] for a local provider
  contextWindowModel: 'shared',   // 'shared' | 'separate' | 'unknown'
  silentInputTruncation: false,   // TRUE only if MEASURED. See below.
}

export async function describeModel({ model, providerConfig })  // OPTIONAL
export function readiness(env, opts)   // SYNC, no network -> { ready, reason }
export async function complete(req)    // -> { text, usage, model, providerLatencyMs }
```

`readiness()` must be synchronous and must not open a socket: it is consulted on the hot path, and
a provider that blocked there would make the gate slow for everyone.

`describeModel()` is optional and is the only way a context window can ever be labelled
`measured`. Omit it and your provider's window is `assumed` (if the bundled table knows the model)
or `unknown` — which is honest, and exactly the state Gemini is in. Four constraints when you do
implement it: never throw, bound the request with a short timeout, cache a success for the process
lifetime, and apply a negative TTL so a stopped daemon is not re-probed on every call.

## The registry

`lib/providers/index.mjs` keeps a **synchronous duplicate** of each module's requirements, so the
hot path pays no dynamic import:

```js
const SYNC_REQUIREMENTS = Object.freeze({
  myprovider: { requiresEnv: ['MYPROVIDER_API_KEY'], billing: 'metered' },
})
```

A conformance test pins the two against each other, so they cannot drift. Keep the list
alphabetical.

**`billing` is DECLARED, never inferred.** It is tempting to derive it — "no key means it is local
and free" — and that is wrong in the expensive direction: an unidentified provider returns `null`
rather than `local_free`, because assuming something is free is the mistake that costs money.
`local_free` is a structural zero and renders differently from an unpriced call.

## Provider/model coherence

`PROVIDER_MODEL_PATTERNS` in `lib/providers/capability.mjs` decides whether a configured model
*could* belong to your provider, so a mismatch is reported rather than discovered at the first
delegation.

Decide this **negatively**: Ollama's pattern set is deliberately empty, because a local model can be
named anything and a pattern would produce false mismatches. Add a pattern only if your provider's
model ids are genuinely recognisable.

## `silentInputTruncation`, and why it exists

Set it `true` only if you have **measured** the provider silently discarding part of an over-long
prompt. Ollama does: a 17,368-token prompt came back with `prompt_eval_count` of 2060, both end
markers intact, and nothing in the response said anything had been lost.

That flag is why an oversized prompt is refused with `context_exceeded` rather than trimmed. An
answer confidently summarising a file whose middle was discarded is worse than no answer. If your
provider rejects an over-long request loudly — as Gemini does, with a 400 — set it `false`.

## Config, and the generated files

A `providers.<id>.*` block needs `SPEC` entries in `lib/config.mjs` and a sentence each in
`lib/config-descriptions.mjs`. Then regenerate, or CI fails:

```bash
npm run gen:schema
npm run docs:config      # refuses to run if a setting has no description
npm run docs:env
```

A new environment variable also needs declaring — a `SPEC` entry if it is a setting, otherwise
`lib/env-registry.mjs`. `test/env.inventory.test.mjs` fails on an undeclared read.

## The bar

```bash
npm run validate
npm test
```

`test/providers.conformance.test.mjs` is the contract: it drives every registered provider through
the same assertions, so a new one is held to exactly the standard the existing three are. Nothing
is allowlisted by name.

A row in `BUNDLED_MODEL_CONTEXT` needs **evidence** — the table marks which of its entries were
measured and which are the vendor's claim, and an unsourced number there becomes an `assumed`
capability that nobody can trace.

## What lights up

Once registered, `npm run doctor` reports your provider across five sections — registration, the
contract check, key presence per lane, which lane resolves to it, and its context capability — plus
governance, which asks whether a budget can be enforced given your `billing` and `reportsUsage`.

## Context capability

Two new REQUIRED fields on `capabilities`:

| field | values | meaning |
| --- | --- | --- |
| `contextWindowModel` | `shared` \| `separate` \| `unknown` | does one window cover prompt *and* completion? |
| `silentInputTruncation` | boolean | does exceeding the window DROP prompt content instead of erroring? |

**The honest value for a new provider is usually `unknown`.** It is read as `shared`, the
conservative formula, and it costs you nothing: an unknown window proceeds under the byte
ceiling exactly as before. Claiming `separate` when the window is actually shared promises
capacity the model has not got.

`silentInputTruncation: true` is a serious claim and should only be set from a measurement.
It is `true` for ollama because a 17,368-token prompt was observed being served as
`prompt_eval_count` 2060 with the middle gone.

### The optional fifth export

```js
export async function describeModel({ model, providerConfig, signal, timeoutMs, fetchImpl, now })
  -> ModelCapability
```

Optional on purpose: `typeof mod.describeModel === 'function'` is already the honest answer
to "can a window be discovered for this provider", so requiring it would only force a fake
implementation into providers that cannot.

Four constraints, all enforced by `test/providers.capability.test.mjs`:

1. **It must never throw.** It is called from inside a PreToolUse hook. Every failure path
   returns `unknownCapability()` with a `detail` saying why.
2. **It must never be called from `readiness()`**, which stays synchronous and network-free.
3. It should memoise, so the cost is once per model per process.
4. The record it returns must satisfy `validateCapabilityRecord()` — in particular the
   invariant that `contextTokens === null` exactly when `status === 'unknown'`.

**Do not report a configured or assumed number as `provider_api`.** `statusForSource()` is
the only place source maps to status, and the whole model rests on that mapping.

See `docs/worker-capability.md`.
