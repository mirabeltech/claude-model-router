/**
 * Ollama worker provider — local models, no API key.
 *
 * Its real job is making the system testable and demonstrable end to end with
 * zero credentials and zero cost: CI, a developer's first run, and the keyless
 * smoke test in the README all go through here. It is also the honest answer for
 * anyone whose code may not leave the machine at all.
 *
 * Readiness deliberately does NOT probe the daemon. The gate calls readiness()
 * on the hot path, and a TCP connect to a dead port costs real milliseconds on
 * every Read. An unreachable daemon surfaces as a `transport` error at
 * delegation time, where waiting is already expected.
 *
 * WHY num_ctx IS SENT, AND WHY IT HAS TO BE. Measured against Ollama 0.34.4 on this
 * machine, with no num_ctx in the request:
 *
 *   prompt      num_predict   prompt_eval_count
 *   17,368 tok            1   2060
 *   17,368 tok         8192   2060
 *    4,100 tok           32   2060
 *
 * Three things follow. First, `num_predict` does not shrink the prompt window — the
 * count is identical across an 8192x change, so "the worker reserved generation space"
 * is not the mechanism. Second, the daemon sizes the serving window dynamically from
 * available memory: 2060 here, 3985 under different memory conditions, neither of them
 * the model's 8192-token architectural context. Third, and worst, the overflow is
 * SILENT and drops the MIDDLE: the 17k prompt came back with its first and last markers
 * both intact and everything between them gone, and a value planted at line 500 of 1000
 * was simply never shown to the model.
 *
 * So a bulk read could be delegated, report success, and return a summary derived from
 * half the bytes it was paid to send. Sending num_ctx explicitly is what makes the
 * window deterministic — the same prompt with num_ctx 8192 evaluated 4108 tokens
 * instead of 2060. `describeModel()` below is how we learn what to ask for.
 */

import {
  ProviderError,
  assertPayloadSize,
  httpJson,
  normalizeUsage,
  num,
} from './contract.mjs'
import { modelCapability, unknownCapability } from './capability.mjs'

export const id = 'ollama'

export const capabilities = Object.freeze({
  // A TRANSPORT ceiling only. This number is NOT evidence that the model can consume 1 MB of
  // context — on llama3:latest it is about thirty times the real window. Context lives in a
  // ModelCapability (see capability.mjs) and no context math may read this field.
  maxInputBytes: 1_000_000,
  supportsSystemPrompt: true,
  // prompt_eval_count / eval_count are real counts from the runtime, not estimates.
  reportsUsage: true,
  reportsThinkingTokens: false,
  supportsCachedInput: false,
  requiresEnv: [],
  // The model runs on this machine. There is no invoice, so the cost is a STRUCTURAL zero and a
  // monetary budget cannot be consumed by it — which is different from a cost we failed to look
  // up. Declared, not inferred from the empty requiresEnv above.
  billing: 'local_free',
  // num_ctx covers prompt and completion together, so every output token asked for is an input
  // token given up.
  contextWindowModel: 'shared',
  // MEASURED true, and the reason this phase exists. See the header.
  silentInputTruncation: true,
})

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434'

/** Discovery is a localhost round trip on a path about to spend seconds in a local model. */
const DISCOVERY_TIMEOUT_MS = 4000

/**
 * How long a failed discovery is remembered. Short, so a daemon started mid-session is picked
 * up on the next delegation rather than staying `unknown` for the life of the process; non-zero,
 * so a dead daemon is not re-probed on every single Read.
 */
const DISCOVERY_NEGATIVE_TTL_MS = 30_000

/**
 * baseUrl|model -> { capability, expiresAt }. A pulled model's architectural context does not
 * change under a running daemon, so a successful answer is cached for the process lifetime.
 */
const discoveryCache = new Map()

/** Exported for tests: a memo that outlives a test is a test that passes for the wrong reason. */
export function clearCapabilityCache() {
  discoveryCache.clear()
}

export function readiness() {
  // No key, nothing to check synchronously. Local-only by construction.
  return { ready: true }
}

/**
 * Ask the daemon how large this model's context is.
 *
 * NEVER THROWS. Every failure path — discovery disabled, no model name, daemon down, 404,
 * timeout, non-JSON body, a body with no context in it — returns `unknownCapability()`, because
 * an undiscoverable window must degrade to plain Claude Code and not to an exception inside a
 * PreToolUse hook.
 *
 * This reports the ARCHITECTURAL context of the weights, which is an upper bound on what the
 * daemon might allocate and NOT a promise that it will. That is why the record it returns carries
 * `source: 'provider_api'` rather than a claim about the live window, and why `complete()` still
 * has to send num_ctx to pin the window down.
 *
 * @param {object} a
 * @param {string|null} a.model
 * @param {object} [a.providerConfig]
 * @param {AbortSignal} [a.signal]
 * @param {number} [a.timeoutMs]
 * @param {Function} [a.fetchImpl]
 * @param {Function} [a.now]
 * @returns {Promise<Readonly<object>>} a ModelCapability
 */
export async function describeModel({
  model,
  providerConfig = {},
  signal,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  fetchImpl,
  now = Date.now,
} = {}) {
  const resolvedModel = model || providerConfig.model || null
  const unknown = (detail) => unknownCapability({ provider: id, model: resolvedModel, detail })

  if (providerConfig.discoverContext === false) return unknown('discovery disabled by config')
  if (!resolvedModel) return unknown('no model name to describe')

  const baseUrl = (providerConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const key = `${baseUrl}|${resolvedModel}`

  const hit = discoveryCache.get(key)
  if (hit && (hit.expiresAt === null || hit.expiresAt > now())) return hit.capability

  let json
  try {
    const res = await httpJson(`${baseUrl}/api/show`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: resolvedModel }),
      timeoutMs,
      signal,
      fetchImpl,
      provider: id,
    })
    json = res.json
  } catch (err) {
    // httpJson has already classified and redacted this. Remember the failure briefly.
    const capability = unknown(`/api/show failed: ${err?.code ?? 'unknown'}`)
    discoveryCache.set(key, { capability, expiresAt: now() + DISCOVERY_NEGATIVE_TTL_MS })
    return capability
  }

  const contextTokens = contextTokensFrom(json)
  const capability =
    contextTokens === null
      ? unknown('no context_length in /api/show')
      : modelCapability({
          provider: id,
          model: resolvedModel,
          contextTokens,
          // Shared window: there is no separate output ceiling to report.
          maxOutputTokens: null,
          source: 'provider_api',
          measuredAt: now(),
        })

  discoveryCache.set(key, {
    capability,
    expiresAt: contextTokens === null ? now() + DISCOVERY_NEGATIVE_TTL_MS : null,
  })
  return capability
}

/**
 * Dig the context length out of an /api/show body.
 *
 * The `model_info` key is family-prefixed — `llama.context_length` — so the obvious
 * implementation builds it from `details.family`. That is not reliable: on this machine
 * `details.family` is `llama` for BOTH llama3 and mistral, and nothing guarantees a family
 * string matches its own metadata prefix. So the family is tried first and then any single key
 * ending in `.context_length` is accepted, which is robust without being a guess: if a body ever
 * carries two of them we take neither rather than pick one.
 *
 * Exported so the conformance suite can test the parse rules without a daemon.
 */
export function contextTokensFrom(json) {
  const info = json?.model_info
  const ok = (v) => (Number.isInteger(v) && v > 0 ? v : null)

  if (info && typeof info === 'object') {
    const family = json?.details?.family
    if (typeof family === 'string' && family !== '') {
      const direct = ok(info[`${family}.context_length`])
      if (direct !== null) return direct
    }
    const keys = Object.keys(info).filter((k) => k.endsWith('.context_length'))
    if (keys.length === 1) {
      const scanned = ok(info[keys[0]])
      if (scanned !== null) return scanned
    }
  }

  // GET /api/tags reports the same number here, so a body shaped like a tags entry still works.
  return ok(json?.details?.context_length)
}

export async function complete({
  model,
  prompt,
  system,
  temperature = 0.2,
  maxOutputTokens = 8192,
  timeoutMs = 180_000,
  contextTokens = null,
  signal,
  providerConfig = {},
  fetchImpl,
}) {
  const resolvedModel = model || providerConfig.model
  if (!resolvedModel) {
    throw new ProviderError('config', 'ollama: model is required (set providers.ollama.model)', {
      provider: id,
      retryable: false,
    })
  }

  assertPayloadSize(prompt, system, capabilities, id)

  const baseUrl = (providerConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/api/chat`

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const options = { temperature, num_predict: maxOutputTokens }

  // Pin the serving window when, and only when, we actually know what to ask for. Left unset the
  // daemon allocates from available memory and then silently drops the middle of an over-long
  // prompt — see the header for the measurements. Derived from the resolved ModelCapability and
  // NEVER from maxInputBytes, which is a byte ceiling and knows nothing about context.
  //
  // Null-when-unknown is deliberate: an install whose window cannot be discovered behaves exactly
  // as it did before this existed, and the budget has already recorded `capability_unknown`.
  if (Number.isInteger(contextTokens) && contextTokens > 0) options.num_ctx = contextTokens

  const { json, latencyMs } = await httpJson(url, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      stream: false,
      options,
    }),
    timeoutMs,
    signal,
    fetchImpl,
    provider: id,
  })

  return parseOllamaResponse(json, { model: resolvedModel, latencyMs })
}

/** Exported so the conformance suite can test the parse rules directly. */
export function parseOllamaResponse(json, { model, latencyMs = 0 } = {}) {
  // Ollama answers a bad model name with HTTP 200 and an `error` field.
  if (typeof json?.error === 'string' && json.error !== '') {
    const missingModel = /not found|no such model|try pulling/i.test(json.error)
    throw new ProviderError(missingModel ? 'model_not_found' : 'unknown', `ollama: ${json.error}`, {
      provider: id,
      retryable: false,
    })
  }

  const text = typeof json?.message?.content === 'string' ? json.message.content : ''
  const finishReason = json?.done_reason ?? null

  const usage = normalizeUsage({
    inputTokens: num(json?.prompt_eval_count),
    cachedInputTokens: null,
    outputTokens: num(json?.eval_count),
    thinkingTokens: null,
    totalTokens:
      num(json?.prompt_eval_count) === null || num(json?.eval_count) === null
        ? null
        : json.prompt_eval_count + json.eval_count,
  })

  if (text.trim() === '') {
    throw new ProviderError(
      'empty_response',
      `ollama: returned no text${finishReason ? ` (done_reason: ${finishReason})` : ''}`,
      { provider: id, retryable: false },
    )
  }

  return {
    text,
    usage,
    model: json?.model || model,
    providerLatencyMs: latencyMs,
    truncated: finishReason === 'length',
    finishReason,
  }
}
