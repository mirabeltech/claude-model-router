# adding a provider

Not written yet. See the architecture proposal and README until this lands.

## Context capability (phase 8)

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
