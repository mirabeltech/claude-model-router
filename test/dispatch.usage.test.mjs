/**
 * Token usage, passed through and never re-derived.
 *
 * The dispatcher does no token arithmetic. The provider layer already applied the Gemini cached
 * subtraction and the thinking-tokens separation; redoing either here is how two layers drift and
 * how a cached token gets charged twice. The one rule above all others: a missing count is
 * `null`, never `0`, because a zero worker cost understates the bill and so overstates savings.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { USAGE_SOURCES } from '../plugins/model-router/lib/telemetry/record.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import { bulkReadPayload, delegatingDecision, serverConfig } from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer({ flakyFailures: 1 }) })
test.after(async () => { await server?.close() })

const GEMINI_KEY = 'AIzaTESTKEYTESTKEYTESTKEY'

/** Mock takes its scenario in the request body; gemini takes it as a baseUrl path prefix. */
const viaMock = (scenario) => ({
  config: serverConfig(server.url, { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } }),
  env: { MOCK_WORKER_URL: server.url },
  scenario,
})

const viaGemini = (scenario) => ({
  config: serverConfig(`${server.url}/s/${scenario}`, {
    workers: { bulkRead: { provider: 'gemini', model: 'gemini-3.8-flash' } },
  }),
  env: { GEMINI_API_KEY: GEMINI_KEY },
})

const run = ({ config, env, scenario }, extra = {}) =>
  dispatch({
    decision: delegatingDecision(),
    config,
    input: bulkReadPayload(),
    env,
    scenario,
    sleep: async () => {},
    ...extra,
  })

/* ------------------------------------------------------------ reported usage */

test('a fully reported usage object arrives intact, with its source', async () => {
  const r = await run(viaMock('ok'))
  assert.equal(r.usage.inputTokens, 1000)
  assert.equal(r.usage.outputTokens, 120)
  assert.equal(r.usage.totalTokens, 1120)
  assert.equal(r.usage.source, 'provider_reported')
  assert.ok(USAGE_SOURCES.includes(r.usage.source))
})

test('missing usage stays null on every count — never zero', async () => {
  // The load-bearing rule of the whole system. A zero here becomes a zero worker cost, which
  // becomes an overstated saving.
  const r = await run(viaMock('ok_no_usage'))
  assert.equal(r.status, 'ok')
  for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'thinkingTokens', 'totalTokens']) {
    assert.equal(r.usage[field], null, `${field} was fabricated as ${r.usage[field]}`)
  }
  assert.equal(r.usage.source, 'missing')
})

test('a partially reported usage is marked partial, not missing and not complete', async () => {
  const r = await run(viaMock('ok_partial_usage'))
  assert.equal(r.usage.inputTokens, 1000)
  assert.equal(r.usage.outputTokens, null)
  assert.equal(r.usage.source, 'provider_partial')
})

/* ------------------------------------------------- the two normalisation traps */

test('the Gemini cached subtraction is the provider layer s, and the dispatcher does not redo it', async () => {
  // promptTokenCount is INCLUSIVE of cachedContentTokenCount upstream. The provider already
  // subtracted; a dispatcher that subtracted again would bill 200 uncached tokens instead of 600.
  const r = await run(viaGemini('ok_cached'))
  assert.equal(r.usage.inputTokens, 600)
  assert.equal(r.usage.cachedInputTokens, 400)
  assert.equal(r.usage.inputTokens + r.usage.cachedInputTokens, 1000)
})

test('thinking tokens stay reported separately from output, exactly as the provider sent them', async () => {
  const r = await run(viaGemini('ok_thinking'))
  assert.equal(r.usage.thinkingTokens, 300)
  assert.equal(r.usage.outputTokens, 120, 'thinking is not folded into output by this layer')
  assert.equal(r.usage.totalTokens, 1420)
})

test('a provider that reports no cached or thinking tokens reports null, not zero', async () => {
  // Ollama supports neither. The structural zero is the cost layer s decision to make, gated on
  // capabilities; inventing it here would discard the capability check.
  const config = serverConfig(`${server.url}/s/ok`, {
    workers: { bulkRead: { provider: 'ollama', model: 'qwen2.5-coder:7b' } },
  })
  const r = await dispatch({ decision: delegatingDecision(), config, input: bulkReadPayload(), env: {} })
  assert.equal(r.usage.cachedInputTokens, null)
  assert.equal(r.usage.thinkingTokens, null)
  assert.equal(r.capabilities.supportsCachedInput, false)
  assert.equal(r.capabilities.reportsThinkingTokens, false)
})

/* ---------------------------------------------------------------- the result */

test('the served model and the requested model are both reported, because they differ', async () => {
  const r = await run(viaGemini('ok'))
  assert.equal(r.modelRequested, 'gemini-3.8-flash')
  assert.equal(r.model, 'gemini-3.8-flash-001')
  assert.notEqual(r.model, r.modelRequested)
})

test('a truncated answer is flagged, with the provider s own finish reason', async () => {
  const r = await run(viaMock('ok_truncated'))
  assert.equal(r.truncated, true)
  assert.equal(r.finishReason, 'length')
})

test('an untruncated answer reports false, not null — the provider did tell us', async () => {
  const r = await run(viaMock('ok'))
  assert.equal(r.truncated, false)
})

test('the result is a structural superset of a CompletionResult', async () => {
  // This is what lets the integration layer pass it straight to buildEvent as `result` instead
  // of copying six fields across, which is a copy that can fall behind.
  const r = await run(viaMock('ok'))
  for (const key of ['text', 'usage', 'model', 'providerLatencyMs', 'truncated', 'finishReason']) {
    assert.ok(key in r, `${key} is missing from the result`)
    assert.notEqual(r[key], undefined)
  }
})

/* -------------------------------------------------------------------- attempts */

test('attempts counts what happened, so retry_count is derived from fact rather than config', async () => {
  server.resetFlaky()
  const r = await run(viaMock('flaky_then_ok'))
  assert.equal(r.status, 'ok')
  assert.equal(r.attempts, 2, 'one failure then a success')
})

test('a single clean call reports one attempt, which is zero retries', async () => {
  const r = await run(viaMock('ok'))
  assert.equal(r.attempts, 1)
})

test('a skipped call reports no attempts at all, which is not the same as zero', async () => {
  const r = await dispatch({
    decision: { delegate: false },
    config: viaMock('ok').config,
    input: bulkReadPayload(),
    env: { MOCK_WORKER_URL: server.url },
  })
  assert.equal(r.attempts, null)
  assert.equal(r.usage, null, 'no call means no usage, not empty usage')
})
