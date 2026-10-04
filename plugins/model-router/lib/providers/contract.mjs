/**
 * The provider contract.
 *
 * Every worker provider is one module exporting the same four symbols. Routing,
 * skills, scripts and telemetry never import a provider directly — they resolve
 * `worker.provider` through the registry — so adding OpenAI, Groq, Anthropic or
 * anything else is one new file plus one registry line.
 *
 *   export const id            : string
 *   export const capabilities  : Capabilities
 *   export function readiness(env)        -> { ready, reason? }   // sync, NO network
 *   export async function complete(req)   -> CompletionResult     // ONE attempt
 *
 * plus one OPTIONAL fifth symbol:
 *
 *   export async function describeModel(o) -> ModelCapability     // async, MAY use network
 *
 * Three deliberate constraints:
 *
 *  - `readiness()` must be synchronous and must not touch the network. The gate
 *    calls it while the developer waits on a tool call; a probe there would add
 *    latency to every single Read.
 *
 *  - `complete()` makes exactly ONE attempt and throws ProviderError on failure.
 *    Retry policy lives in `withRetry()` below so it is written and tested once
 *    rather than re-implemented per provider.
 *
 *  - `describeModel()` must NEVER throw and must never be called from the gate or
 *    from `readiness()`. Every failure — daemon down, 404, timeout, garbage body —
 *    returns `unknownCapability()`, because an undiscoverable window has to degrade
 *    to plain Claude Code rather than to an exception on the hot path. It is
 *    optional on purpose: `typeof mod.describeModel === 'function'` is already the
 *    honest answer to "can a window be discovered for this provider", so requiring
 *    it would only force a fake implementation into providers that cannot.
 */

import { redactSecrets } from '../redact.mjs'

/**
 * @typedef {Object} Capabilities
 * @property {number}   maxInputBytes       TRANSPORT ceiling for one request payload, in bytes.
 *   NOT a context window, and never evidence of consumable context: ollama advertises 1_000_000
 *   bytes here and cannot ingest a quarter of that on an 8192-token model. No context math may
 *   read this field — the window lives in a ModelCapability.
 * @property {boolean}  supportsSystemPrompt
 * @property {boolean}  reportsUsage        false => telemetry must mark usage as estimated.
 * @property {string[]} requiresEnv         Env vars that must be set for this provider to work.
 * @property {boolean}  reportsThinkingTokens
 * @property {boolean}  supportsCachedInput
 * @property {'shared'|'separate'|'unknown'} contextWindowModel
 *   `shared`   — one window covers prompt AND completion (local runtimes; ollama with num_ctx)
 *   `separate` — input and output limits are independent fields (Gemini)
 *   `unknown`  — read as `shared`, which is the conservative formula
 * @property {'local_free'|'metered'} billing
 *   How this provider's cost arises, DECLARED rather than inferred. `local_free` means the cost
 *   is structurally zero — the model runs on the developer's own hardware and no invoice exists
 *   — so a monetary budget cannot be consumed by it. `metered` means a bill exists, whether or
 *   not we currently know the rate; an unpriced metered call is UNKNOWN cost, never free.
 *
 *   This is a field rather than a derivation from `requiresEnv.length === 0` on purpose. "Needs
 *   no API key" and "costs no money" are different claims, and a self-hosted metered gateway
 *   satisfies the first while violating the second. Governance reads this and nothing else.
 * @property {boolean}  silentInputTruncation
 *   true when exceeding the window DROPS prompt content instead of erroring. Measured true for
 *   ollama: a 17,368-token prompt was served as prompt_eval_count 2060 with the first and last
 *   markers both intact — head and tail kept, MIDDLE DROPPED. Identical at num_predict 1 and
 *   8192, so output reservation is not the mechanism; the window is allocated dynamically from
 *   available memory, which is why num_ctx has to be sent explicitly.
 */

/**
 * @typedef {Object} ModelCapability
 * @property {string|null} provider
 * @property {string|null} model
 * @property {number|null} contextTokens    null means UNKNOWN. Never Infinity, never a guess.
 * @property {number|null} maxOutputTokens  the model's own output ceiling, where one exists
 * @property {string}      source           a member of CAPABILITY_SOURCES
 * @property {string}      status           a member of CAPABILITY_STATUSES
 * @property {number|null} measuredAt       epoch ms, only when source === 'provider_api'
 * @property {string|null} detail           why it is unknown; redacted by its caller
 */

/**
 * @typedef {Object} CompletionRequest
 * @property {string}  model
 * @property {string}  prompt
 * @property {string}  [system]
 * @property {number}  [temperature]
 * @property {number}  [maxOutputTokens]
 * @property {number}  [timeoutMs]
 * @property {number|null} [contextTokens]  The resolved serving window, or null when unknown.
 *   A provider that can pin its window (ollama's num_ctx) sends it; one that cannot ignores it.
 * @property {AbortSignal} [signal]
 * @property {object}  [providerConfig]  The `providers.<id>` config block.
 * @property {object}  [env]
 * @property {Function} [fetchImpl]      Injected for tests.
 */

/**
 * @typedef {Object} Usage
 * @property {number|null} inputTokens        Uncached prompt tokens.
 * @property {number|null} cachedInputTokens
 * @property {number|null} outputTokens
 * @property {number|null} thinkingTokens     Billed as output but reported separately.
 * @property {number|null} totalTokens        The provider's own total, kept so the math stays checkable.
 * @property {'provider_reported'|'provider_partial'|'missing'} source
 */

/**
 * @typedef {Object} CompletionResult
 * @property {string}  text
 * @property {Usage}   usage
 * @property {string}  model              Model the provider reports having served.
 * @property {number}  providerLatencyMs
 * @property {boolean} truncated          Output hit a cap.
 * @property {string|null} finishReason
 */

/** Error codes the rest of the system keys on. Never string-match a vendor message. */
export const ERROR_CODES = Object.freeze([
  'auth',
  'rate_limit',
  'quota',
  'timeout',
  'payload_too_large',
  'model_not_found',
  'provider_safety',
  'empty_response',
  'parse_error',
  'transport',
  'http_4xx',
  'http_5xx',
  'config',
  'unknown',
])

/** Codes where another attempt could plausibly succeed. */
export const RETRYABLE = Object.freeze(new Set(['rate_limit', 'timeout', 'transport', 'http_5xx']))

export class ProviderError extends Error {
  /**
   * @param {string} code    one of ERROR_CODES
   * @param {string} message
   * @param {{provider?: string, httpStatus?: number|null, retryable?: boolean, cause?: unknown, detail?: string}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = ERROR_CODES.includes(code) ? code : 'unknown'
    this.provider = opts.provider ?? null
    this.httpStatus = opts.httpStatus ?? null
    this.retryable = opts.retryable ?? RETRYABLE.has(this.code)
    this.detail = opts.detail ?? null
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}

/** Map an HTTP status to an error code. Shared so providers classify identically. */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'model_not_found'
  if (status === 413) return 'payload_too_large'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'http_5xx'
  if (status >= 400) return 'http_4xx'
  return 'unknown'
}

/** A usage object with nothing known. Telemetry turns this into NULL money, never $0. */
export function emptyUsage(source = 'missing') {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    totalTokens: null,
    source,
  }
}

/**
 * Coerce a provider-reported count. Anything that is not a finite non-negative
 * number becomes null — a wrong zero would understate worker cost, which
 * overstates savings.
 */
export function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Normalize a usage object and decide its source. `provider_partial` matters:
 * it tells telemetry the cost is incomplete without pretending it is missing.
 */
export function normalizeUsage({ inputTokens, cachedInputTokens, outputTokens, thinkingTokens, totalTokens }) {
  const u = {
    inputTokens: num(inputTokens),
    cachedInputTokens: num(cachedInputTokens),
    outputTokens: num(outputTokens),
    thinkingTokens: num(thinkingTokens),
    totalTokens: num(totalTokens),
    source: 'missing',
  }
  const billable = [u.inputTokens, u.outputTokens]
  if (billable.every((x) => x !== null)) u.source = 'provider_reported'
  else if (billable.some((x) => x !== null)) u.source = 'provider_partial'
  return u
}

/** Throw if the payload exceeds the provider's ceiling, before any network call. */
export function assertPayloadSize(prompt, system, capabilities, provider) {
  const bytes = Buffer.byteLength(prompt ?? '', 'utf8') + Buffer.byteLength(system ?? '', 'utf8')
  if (bytes > capabilities.maxInputBytes) {
    throw new ProviderError(
      'payload_too_large',
      `request is ${bytes} bytes, over the ${capabilities.maxInputBytes} byte limit for ${provider}. Send fewer or smaller files.`,
      { provider, retryable: false },
    )
  }
  return bytes
}

/** Every required env var present? Shared so readiness() reads the same way everywhere. */
export function envReadiness(env, capabilities, provider) {
  const missing = capabilities.requiresEnv.filter((k) => !env?.[k])
  if (missing.length > 0) {
    return { ready: false, reason: `${provider}: ${missing.join(', ')} not set` }
    }
  return { ready: true }
}

/**
 * Issue one HTTP request with a hard timeout, classifying every failure into a
 * ProviderError. Providers share this so a timeout, a DNS failure and a 500 are
 * never reported three different ways.
 */
/**
 * The ceiling Node's bundled HTTP client imposes on how long it will wait for response headers,
 * and therefore the LONGEST a single worker call can actually take — regardless of
 * `worker.timeoutMs`, whose spec allows thirty minutes.
 *
 * `fetch` offers no standard way to raise it without reaching for a dispatcher that is not part
 * of the public API, so this is documented and surfaced by `router doctor` rather than worked
 * around. It only binds on very slow local models: a hosted provider answers in seconds.
 */
export const FETCH_HEADERS_TIMEOUT_MS = 300_000

/** Is this the runtime's own header/body timeout rather than a real network failure? */
function isRuntimeTimeout(err) {
  const code = err?.cause?.code ?? err?.code
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT'
}

export async function httpJson(url, { method = 'POST', headers, body, timeoutMs = 180000, signal, fetchImpl, provider }) {
  const f = fetchImpl ?? globalThis.fetch
  if (typeof f !== 'function') {
    throw new ProviderError('config', 'no fetch implementation available', { provider, retryable: false })
  }

  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(new Error('timeout')), timeoutMs)
  const composed = signal ? AbortSignal.any([signal, timeoutCtl.signal]) : timeoutCtl.signal

  let res
  const started = Date.now()
  try {
    res = await f(url, { method, headers, body, signal: composed })
  } catch (err) {
    if (timeoutCtl.signal.aborted) {
      throw new ProviderError('timeout', `${provider}: request exceeded ${timeoutMs}ms`, { provider, cause: err })
    }
    if (signal?.aborted) {
      throw new ProviderError('transport', `${provider}: request cancelled`, { provider, retryable: false, cause: err })
    }
    // The runtime's OWN timeout, which fires before ours whenever `timeoutMs` exceeds it.
    // MEASURED: a request that needed ~305 s came back as `transport` — "network failure" —
    // when it was a timeout, which points an operator at their network instead of at their
    // model. Worse, every provider then saw a plain transport error, and this one is reported
    // with `retryable` left at its default, so a doomed call was retried: three attempts at
    // 180 s each is where a live benchmark's 541 s and its cache-warming confound came from.
    if (isRuntimeTimeout(err)) {
      throw new ProviderError(
        'timeout',
        `${provider}: the runtime closed the request after ${FETCH_HEADERS_TIMEOUT_MS}ms, before the configured ${timeoutMs}ms budget could apply`,
        { provider, cause: err },
      )
    }
    throw new ProviderError('transport', `${provider}: ${err?.message ?? 'network failure'}`, { provider, cause: err })
  } finally {
    clearTimeout(timer)
  }

  const latencyMs = Date.now() - started
  const text = await res.text().catch(() => '')

  if (!res.ok) {
    const code = codeForStatus(res.status)
    throw new ProviderError(code, `${provider}: HTTP ${res.status}`, {
      provider,
      httpStatus: res.status,
      detail: redactSecrets(text).slice(0, 400),
    })
  }

  try {
    return { json: JSON.parse(text), latencyMs, httpStatus: res.status }
  } catch (err) {
    throw new ProviderError('parse_error', `${provider}: response was not JSON`, {
      provider,
      httpStatus: res.status,
      retryable: false,
      detail: redactSecrets(text).slice(0, 200),
      cause: err,
    })
  }
}

/**
 * Retry policy, written once. Providers stay single-attempt; callers get
 * `attempts` back so telemetry can record `retry_count` accurately.
 *
 * @returns {Promise<{result: any, attempts: number}>}
 */
export async function withRetry(fn, { maxRetries = 2, baseDelayMs = 400, sleep = defaultSleep, random = Math.random } = {}) {
  let attempt = 0
  for (;;) {
    try {
      const result = await fn(attempt)
      return { result, attempts: attempt + 1 }
    } catch (err) {
      const retryable = err instanceof ProviderError ? err.retryable : false
      if (!retryable || attempt >= maxRetries) {
        if (err instanceof ProviderError) err.attempts = attempt + 1
        throw err
      }
      // Exponential backoff with full jitter — a worker under load should not be
      // hit by every developer's retry on the same schedule.
      const delay = Math.round(baseDelayMs * 2 ** attempt * (0.5 + random() * 0.5))
      await sleep(delay)
      attempt++
    }
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Assert a module satisfies the contract. Used by the conformance suite so a new
 * provider cannot ship with a missing export or a malformed capabilities block.
 */
export function validateProviderModule(mod) {
  const problems = []
  if (typeof mod?.id !== 'string' || mod.id === '') problems.push('id must be a non-empty string')
  if (typeof mod?.readiness !== 'function') problems.push('readiness must be a function')
  if (typeof mod?.complete !== 'function') problems.push('complete must be an async function')

  // Optional, so absence is fine; present-but-not-a-function is a bug the suite should catch.
  if (mod?.describeModel !== undefined && typeof mod.describeModel !== 'function') {
    problems.push('describeModel, when present, must be an async function')
  }

  const c = mod?.capabilities
  if (typeof c !== 'object' || c === null) {
    problems.push('capabilities must be an object')
  } else {
    if (!Number.isInteger(c.maxInputBytes) || c.maxInputBytes <= 0) problems.push('capabilities.maxInputBytes must be a positive integer')
    for (const k of ['supportsSystemPrompt', 'reportsUsage', 'reportsThinkingTokens', 'supportsCachedInput', 'silentInputTruncation']) {
      if (typeof c[k] !== 'boolean') problems.push(`capabilities.${k} must be a boolean`)
    }
    if (!['shared', 'separate', 'unknown'].includes(c.contextWindowModel)) {
      problems.push("capabilities.contextWindowModel must be 'shared', 'separate' or 'unknown'")
    }
    // Required, with no default. A provider that forgot to declare how it bills must fail the
    // contract check rather than silently inherit "free", which is the expensive way to be wrong.
    if (!['local_free', 'metered'].includes(c.billing)) {
      problems.push("capabilities.billing must be 'local_free' or 'metered'")
    }
    if (!Array.isArray(c.requiresEnv) || !c.requiresEnv.every((x) => typeof x === 'string')) {
      problems.push('capabilities.requiresEnv must be an array of strings')
    }
  }
  return problems
}
