/**
 * Gemini worker provider — Google AI (generativelanguage) REST, API-key auth.
 *
 * Direct HTTPS via global fetch: no SDK, no CLI, nothing to install. The payload
 * travels in the request body rather than argv, so there is no ARG_MAX ceiling.
 *
 * Three usage traps are closed here, and all three bias the same dangerous way —
 * each one would understate worker cost, which overstates savings:
 *
 *  1. `promptTokenCount` is INCLUSIVE of `cachedContentTokenCount`. Reporting it
 *     as uncached input double-counts the cached portion.
 *  2. `thoughtsTokenCount` is billed as output but is EXCLUDED from
 *     `candidatesTokenCount`. It has to be added or reasoning is free.
 *  3. A response with no usage block must yield null, never 0.
 */

import {
  ProviderError,
  assertPayloadSize,
  emptyUsage,
  envReadiness,
  httpJson,
  normalizeUsage,
  num,
} from './contract.mjs'
import { redactSecrets } from '../redact.mjs'

export const id = 'gemini'

export const capabilities = Object.freeze({
  // A TRANSPORT ceiling, not a context window. Comfortably inside the 1M-token context while
  // staying a sane request size.
  maxInputBytes: 2_000_000,
  supportsSystemPrompt: true,
  reportsUsage: true,
  reportsThinkingTokens: true,
  supportsCachedInput: true,
  requiresEnv: ['GEMINI_API_KEY'],
  // A bill exists whether or not we know the rate. Every rate in the bundled pricing table
  // ships null, so an out-of-the-box Gemini call has an UNKNOWN cost, never a zero one.
  billing: 'metered',
  // `inputTokenLimit` and `outputTokenLimit` are independent fields on a Gemini model, so output
  // is not taken out of the prompt's budget.
  contextWindowModel: 'separate',
  // Over the limit, Gemini answers 400. A loud refusal, never a quietly shortened prompt.
  silentInputTruncation: false,
})

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Which env var holds the key is configurable (`worker.apiKeyEnv`), so readiness
 * has to be told rather than assuming GEMINI_API_KEY.
 */
export function readiness(env = process.env, { apiKeyEnv = 'GEMINI_API_KEY' } = {}) {
  return envReadiness(env, { ...capabilities, requiresEnv: [apiKeyEnv] }, id)
}

export async function complete({
  model,
  prompt,
  system,
  temperature = 0.2,
  maxOutputTokens = 8192,
  timeoutMs = 180_000,
  signal,
  providerConfig = {},
  env = process.env,
  apiKeyEnv = 'GEMINI_API_KEY',
  fetchImpl,
}) {
  if (!model) throw new ProviderError('config', 'gemini: model is required', { provider: id, retryable: false })

  const apiKey = env?.[apiKeyEnv]
  if (!apiKey) {
    throw new ProviderError('auth', `gemini: ${apiKeyEnv} is not set`, { provider: id, retryable: false })
  }

  assertPayloadSize(prompt, system, capabilities, id)

  const baseUrl = (providerConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens },
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }

  const { json, latencyMs } = await httpJson(url, {
    headers: {
      'content-type': 'application/json',
      // Header auth, never a query string — a key in a URL lands in access logs.
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    timeoutMs,
    signal,
    fetchImpl,
    provider: id,
  })

  return parseGeminiResponse(json, { model, latencyMs })
}

/** Exported so the conformance suite can exercise the parse rules without a server. */
export function parseGeminiResponse(json, { model, latencyMs = 0 } = {}) {
  const blockReason = json?.promptFeedback?.blockReason
  if (blockReason) {
    throw new ProviderError('provider_safety', `gemini: prompt blocked (${blockReason})`, {
      provider: id,
      retryable: false,
    })
  }

  const candidate = json?.candidates?.[0]
  const finishReason = candidate?.finishReason ?? null

  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'BLOCKLIST') {
    throw new ProviderError('provider_safety', `gemini: response blocked (${finishReason})`, {
      provider: id,
      retryable: false,
    })
  }

  const text = (candidate?.content?.parts ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')

  const usage = extractUsage(json?.usageMetadata)

  if (text.trim() === '') {
    // MAX_TOKENS with no text means the whole budget went to reasoning. Failing
    // loudly beats handing back an empty answer that looks like a valid summary.
    throw new ProviderError(
      'empty_response',
      finishReason === 'MAX_TOKENS'
        ? 'gemini: returned no text — the output budget was exhausted. Raise worker.maxOutputTokens or split the request.'
        : `gemini: returned no text${finishReason ? ` (finishReason: ${finishReason})` : ''}`,
      { provider: id, retryable: false, detail: redactSecrets(JSON.stringify(json ?? {}).slice(0, 200)) },
    )
  }

  return {
    text,
    usage,
    model: json?.modelVersion || model,
    providerLatencyMs: latencyMs,
    truncated: finishReason === 'MAX_TOKENS',
    finishReason,
  }
}

/**
 * Turn `usageMetadata` into the contract's Usage shape.
 *
 * promptTokenCount is inclusive of cached, so uncached input is the difference.
 * thoughtsTokenCount is billed as output but excluded from candidatesTokenCount,
 * so it is carried separately and added at pricing time.
 */
export function extractUsage(meta) {
  if (!meta || typeof meta !== 'object') return emptyUsage('missing')

  const prompt = num(meta.promptTokenCount)
  const cached = num(meta.cachedContentTokenCount) ?? 0
  const candidates = num(meta.candidatesTokenCount)
  const thoughts = num(meta.thoughtsTokenCount)

  return normalizeUsage({
    // Guard the subtraction: a provider inconsistency must not yield a negative.
    inputTokens: prompt === null ? null : Math.max(0, prompt - cached),
    cachedInputTokens: num(meta.cachedContentTokenCount) === null ? null : cached,
    outputTokens: candidates,
    thinkingTokens: thoughts,
    totalTokens: num(meta.totalTokenCount),
  })
}
