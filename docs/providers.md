# Provider setup

Three providers ship: **ollama** (local, keyless), **gemini** (hosted, metered) and **mock** (for
tests and the offline benchmark). Adding a fourth is
[adding-a-provider.md](adding-a-provider.md).

| | ollama | gemini | mock |
| --- | --- | --- | --- |
| API key | none | `GEMINI_API_KEY` | `MOCK_WORKER_URL` |
| Billing | `local_free` | `metered` | test only |
| Reports token usage | yes | yes | yes |
| Context window discovery | **yes**, from the daemon | **no** — see below | no |
| Transport ceiling | 1 MB | 2 MB | — |
| Behaviour on an over-long prompt | **silently drops the middle** (measured) | rejects with a 400 | — |

That last row is the one with real consequences, and it is why this project refuses an oversized
prompt rather than trimming it. See [worker-capability.md](worker-capability.md).

---

## Ollama

A local daemon. Nothing leaves your machine, there is no key, and cost is a structural zero rather
than an unknown — which is a different and better fact than "unpriced".

### Install and run

Install from [ollama.com](https://ollama.com), then:

```bash
ollama serve                      # often already running as a service
ollama pull qwen2.5-coder:7b      # the model this project defaults to
ollama list                       # confirm it is there
```

### Configure

```json
{
  "worker": { "provider": "ollama", "model": "qwen2.5-coder:7b" },
  "providers": { "ollama": { "baseUrl": "http://127.0.0.1:11434" } }
}
```

**Set both `provider` and `model`.** Setting only the provider leaves the model at its default of
`gemini-2.5-flash`, which Ollama does not own, and doctor reports a provider/model mismatch as a
FAIL. This is the single most common misconfiguration of this plugin.

`baseUrl` defaults to loopback. Point it elsewhere for a daemon on another host — note that this
plugin reads `providers.ollama.baseUrl`, **not** Ollama's own `OLLAMA_HOST` variable, because a
setting the config layer does not own cannot be validated or reported.

### How the context window is decided

Three different numbers get called "the context limit", and they are kept apart on purpose:

1. **what you configured** — `providers.ollama.contextTokens`
2. **what the daemon advertises** — discovered via `POST /api/show`
3. **what the runtime actually served** — only ever known after a call

`discoverContext` is `true` by default: one `/api/show` per model per process, cached for the
process lifetime, about seven milliseconds on loopback, made only *after* the routing gate has
already approved a delegation. A discovered value is the only kind labelled `measured`.

A configured value is clamped by a discovered one and still labelled **configured**, because an
operator's assertion clamped by a measurement is still an assertion. So set `contextTokens` only to
impose a *smaller* application limit than the model's real window.

If neither answers, the bundled table is consulted and the result is labelled `assumed`. If that
also fails, the capability is `unknown` — and **unknown is never treated as unlimited**.

### `num_ctx`, and why input is never truncated

Ollama sizes its serving window from available memory, and then **silently drops the middle of an
over-long prompt**. This was measured, not inferred: a 17,368-token prompt came back with
`prompt_eval_count` of 2060, with both end markers intact. Nothing in the response said anything
had been lost.

An answer confidently summarising a file whose middle was discarded is worse than no answer, so:

- `num_ctx` is always sent when the window is known, so the daemon cannot resize under us
- output may be capped to make room for input
- **input is never truncated.** A prompt that cannot be shown to fit is refused with
  `context_exceeded`, and the read falls open to Claude

### Limitations

- Throughput varies with memory pressure and the KV cache — a threefold swing was observed on one
  machine for the same prompt, so Ollama latency figures are not comparable run to run.
- A model must be pulled before it can be used. A missing model surfaces as a dispatch error, and
  the read falls open.
- A stopped daemon makes capability `unknown` and readiness not-ready. Both are WARN: a degraded
  router, not a broken one.

### Expected doctor output

```
Worker modes
  PASS  bulk-reader: ollama/qwen2.5-coder:7b   inherits worker.provider, timeoutMs=180000, key=none required

Worker capability
  PASS  provider/model coherence                every configured worker names a model its provider could own
  PASS  bulk-reader: ollama/qwen2.5-coder:7b: context=32768 (provider_api/measured)
```

`provider_api/measured` is the daemon answering. With the daemon stopped you get a WARN naming
`/api/show`, and `no API key required` in the provider section.

---

## Gemini

A hosted, metered model. Fast and cheap for extraction work, and the shipped default.

### Get a key

From [Google AI Studio](https://aistudio.google.com/apikey). Then put it in your **environment**:

```powershell
setx GEMINI_API_KEY "your-key"     # restart Claude Code; setx does not affect this shell
```

```bash
export GEMINI_API_KEY=your-key     # add to your shell profile to persist
```

**There is no config field for a key and there never will be.** `worker.apiKeyEnv` names the
variable that holds it; the value is read from the environment at call time. And no config value is
interpolated, so `"${GEMINI_API_KEY}"` would be read as that literal 19-character string — doctor
detects that shape by name, because it otherwise looks exactly like a bad key.

### Configure

```json
{
  "worker": {
    "provider": "gemini",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

Point `apiKeyEnv` at a different variable to keep several keys side by side, or to match a name
your CI already sets.

### Context discovery is NOT implemented

**Gemini exports no `describeModel`, so this plugin cannot discover a Gemini context window.** That
is a missing capability, stated plainly rather than papered over:

- capability status is `assumed` when the bundled table knows the model, `unknown` otherwise
- **doctor WARNs about it, and that warning is correct** — it is not a bug to report
- an unknown window is never treated as unlimited; dispatch falls back to the 2 MB transport ceiling
- `contextWindowModel` is `separate`, so an output request does not compete with input for the same
  budget the way it does on Ollama

If you want a window enforced for Gemini, there is currently no setting for it. Adding one would
mean adding a `providers.gemini.contextTokens` leaf — see
[adding-a-provider.md](adding-a-provider.md).

### Usage and cost

Gemini reports token usage, including cached input and thinking tokens, so token figures are real
measurements rather than estimates.

**Cost is a different matter.** Every rate in the bundled pricing table ships `null`, so worker cost
is reported as `NULL` — never `0`, and never a guess. Published rates change without notice, and a
confident wrong dollar figure is worse than a refusal to price.

To get dollar figures, supply rates:

```jsonc
// <project>/.claude/model-router.json
{ "pricing": { "source": "file", "overrides": "./.claude/model-router-pricing.json" } }
```

Start from [`examples/pricing-overrides.json`](../examples/pricing-overrides.json), or paste the
skeleton `npm run doctor` prints for exactly the models your install uses. Until then a **monetary**
budget has nothing to accumulate against, and doctor says so instead of letting it look enforced. A
**token** budget works immediately.

### Limitations

- No context-window discovery, as above.
- An over-long prompt is rejected with a 400 rather than truncated — a loud failure, which is the
  preferable one.
- Rate limits and quotas are the provider's, and surface as dispatch errors. The read falls open.

### Expected doctor output on a fresh keyless install

```
Worker provider
  PASS  provider "gemini" is registered
  WARN  GEMINI_API_KEY is not set, so nothing will be delegated yet
        GEMINI_API_KEY is the SHIPPED DEFAULT, not a choice you made — routing stays off
        and every read goes to Claude as normal.
  WARN  provider readiness: NOT ready   gemini: GEMINI_API_KEY not set

Worker capability
  WARN  bulk-reader: gemini/gemini-2.5-flash: context capability unknown
        no context limit is discoverable for gemini — that is a missing capability, not a fault
```

Exit code 0. Nothing there is broken.

---

## mock

Not for real use. It serves canned responses from a loopback URL in `MOCK_WORKER_URL`, which is how
the benchmark runs the full dispatch path offline and keyless. `MOCK_SCENARIO` selects failure
behaviours — a refusal, a timeout, a malformed usage block — so error paths can be tested without a
live provider. See [evaluation.md](evaluation.md).

---

## See also

- [configuration.md](configuration.md) — every setting, and the precedence order
- [worker-capability.md](worker-capability.md) — the three context numbers, in full
- [worker-dispatch.md](worker-dispatch.md) — provider resolution, timeouts, the error vocabulary
- [troubleshooting.md](troubleshooting.md) — when a provider is not working
- [adding-a-provider.md](adding-a-provider.md) — the contract a fourth provider must satisfy
