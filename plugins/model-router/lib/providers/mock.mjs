/**
 * Mock worker provider — a real provider module backed by a scriptable HTTP
 * endpoint, used by the test suites and by `router doctor --selftest`.
 *
 * It is deliberately NOT a stub object that short-circuits the network. It goes
 * through the same `httpJson` path as Gemini and Ollama, so the conformance
 * suite exercises real fetch behaviour: timeouts, aborts, non-JSON bodies, 4xx
 * and 5xx classification. A hand-rolled fake would pass tests that the real
 * transport fails.
 *
 * The scenario is chosen by the request body, so one tiny server covers every
 * failure mode (see test/helpers/provider-server.mjs).
 */

import {
  ProviderError,
  assertPayloadSize,
  httpJson,
  normalizeUsage,
  num,
} from './contract.mjs'

export const id = 'mock'

export const capabilities = Object.freeze({
  maxInputBytes: 64_000,
  supportsSystemPrompt: true,
  reportsUsage: true,
  reportsThinkingTokens: true,
  supportsCachedInput: true,
  requiresEnv: ['MOCK_WORKER_URL'],
  // `metered` is the conservative declaration for a stand-in: it exercises the unknown-cost
  // path rather than the structurally-free shortcut, so tests cover the branch that can
  // actually surprise someone.
  billing: 'metered',
  // `unknown` is the honest value for a fixture server standing in for an arbitrary provider,
  // and it keeps the budget module's pessimistic-default branch on a real caller rather than
  // only on an injected fake.
  contextWindowModel: 'unknown',
  silentInputTruncation: false,
})

export function readiness(env = process.env) {
  if (!env?.MOCK_WORKER_URL) {
    return { ready: false, reason: 'mock: MOCK_WORKER_URL is not set' }
  }
  return { ready: true }
}

export async function complete({
  model = 'mock-1',
  prompt,
  system,
  timeoutMs = 5_000,
  signal,
  providerConfig = {},
  env = process.env,
  fetchImpl,
  scenario,
}) {
  const baseUrl = (providerConfig.baseUrl || env?.MOCK_WORKER_URL || '').replace(/\/+$/, '')
  if (!baseUrl) {
    throw new ProviderError('config', 'mock: no baseUrl or MOCK_WORKER_URL', { provider: id, retryable: false })
  }

  assertPayloadSize(prompt, system, capabilities, id)

  const { json, latencyMs } = await httpJson(`${baseUrl}/complete`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, system, scenario: scenario ?? env?.MOCK_SCENARIO ?? 'ok' }),
    timeoutMs,
    signal,
    fetchImpl,
    provider: id,
  })

  const text = typeof json?.text === 'string' ? json.text : ''
  if (text.trim() === '') {
    throw new ProviderError('empty_response', 'mock: returned no text', { provider: id, retryable: false })
  }

  return {
    text,
    usage: normalizeUsage({
      inputTokens: num(json?.usage?.inputTokens),
      cachedInputTokens: num(json?.usage?.cachedInputTokens),
      outputTokens: num(json?.usage?.outputTokens),
      thinkingTokens: num(json?.usage?.thinkingTokens),
      totalTokens: num(json?.usage?.totalTokens),
    }),
    model: json?.model || model,
    providerLatencyMs: latencyMs,
    truncated: json?.truncated === true,
    finishReason: json?.finishReason ?? null,
  }
}
