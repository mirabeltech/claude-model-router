/**
 * Readiness: deciding whether a worker can be called, without calling it.
 *
 * The contract is synchronous and makes no network request. That is not an optimisation detail —
 * a probe here would add a round trip to every delegation, and `server.requests.length` is the
 * assertion that proves no probe happens.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { providerIds } from '../plugins/model-router/lib/providers/index.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import { bulkReadPayload, delegatingDecision, serverConfig } from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer() })
test.after(async () => { await server?.close() })

const GEMINI_KEY = 'AIzaTESTKEYTESTKEYTESTKEY'

const laneConfig = (workers) => serverConfig(server.url, { workers })

const run = (config, env, extra = {}) =>
  dispatch({
    decision: delegatingDecision(),
    config,
    input: bulkReadPayload(),
    env,
    scenario: 'ok',
    ...extra,
  })

/* ------------------------------------------------------------- not available */

test('a provider whose key is absent fails structurally, with no request made', async () => {
  const before = server.requests.length
  const r = await run(laneConfig({ bulkRead: { provider: 'gemini' } }), {})
  assert.equal(r.status, 'error')
  assert.equal(r.reason, 'provider_unavailable')
  assert.equal(r.error.code, 'provider_unavailable')
  assert.equal(r.executed, false)
  assert.equal(server.requests.length, before, 'readiness must not probe the network')
})

test('the unavailability message names the variable that is missing, not a generic failure', async () => {
  const r = await run(laneConfig({ bulkRead: { provider: 'gemini' } }), {})
  assert.match(r.error.message, /GEMINI_API_KEY/)
  assert.equal(r.error.provider, 'gemini')
})

test('the same provider with its key present executes', async () => {
  const r = await run(
    laneConfig({ bulkRead: { provider: 'gemini', model: 'gemini-2.5-flash' } }),
    { GEMINI_API_KEY: GEMINI_KEY },
  )
  assert.equal(r.status, 'ok')
  assert.equal(r.provider, 'gemini')
})

test('a mock worker with no MOCK_WORKER_URL is unavailable', async () => {
  const r = await run(laneConfig({ bulkRead: { provider: 'mock', model: 'mock-1' } }), {})
  assert.equal(r.reason, 'provider_unavailable')
  assert.match(r.error.message, /MOCK_WORKER_URL/)
})

/* ------------------------------------------------------------------ available */

test('a local provider that requires no key is ready with an empty environment', async () => {
  // Ollama's readiness deliberately does not probe the daemon; an unreachable daemon surfaces as
  // a transport error at call time, not as a slow readiness check on every read.
  const r = await run(laneConfig({ bulkRead: { provider: 'ollama' } }), {})
  assert.notEqual(r.reason, 'provider_unavailable')
  assert.equal(r.status, 'ok')
  assert.equal(r.provider, 'ollama')
})

test('switching one lane to a keyless provider does not make it demand the global key', async () => {
  // The cross-provider inheritance trap, caught behaviourally rather than only in resolveWorker:
  // worker.apiKeyEnv is GEMINI_API_KEY, and readinessFor() would require whatever name it is
  // handed, so inheriting the name across a provider change would make Ollama need a Gemini key.
  const config = laneConfig({ codeWrite: { provider: 'ollama' } })
  assert.equal(config.worker.apiKeyEnv, 'GEMINI_API_KEY')
  const r = await dispatch({
    decision: delegatingDecision({ mode: 'code-writer', lane: 'codeWrite' }),
    config,
    input: { instruction: 'write a test' },
    env: {},
    scenario: 'ok',
  })
  assert.equal(r.status, 'ok', `expected ready, got ${r.reason}: ${r.error?.message}`)
})

test('an explicit per-lane key variable is the one readiness checks', async () => {
  const config = laneConfig({ bulkRead: { provider: 'gemini', model: 'gemini-2.5-flash', apiKeyEnv: 'BULK_KEY' } })
  const missing = await run(config, { GEMINI_API_KEY: GEMINI_KEY })
  assert.equal(missing.reason, 'provider_unavailable')
  assert.match(missing.error.message, /BULK_KEY/)

  const present = await run(config, { BULK_KEY: GEMINI_KEY })
  assert.equal(present.status, 'ok')
})

test('a keyless provider set GLOBALLY is ready even though worker.apiKeyEnv still names a key', async () => {
  // Switching `worker.provider` to a local model leaves `worker.apiKeyEnv` pointing at the old
  // provider's variable, and the lane inherits it because the provider WAS inherited. Since
  // readinessFor() treats a supplied name as REPLACING the provider's own requiresEnv, forwarding
  // it unconditionally would report a local daemon as unavailable for want of a Gemini key.
  // `apiKeyEnv` renames a key a provider needs; it does not invent one.
  const config = serverConfig(server.url, {}, { worker: { provider: 'ollama', model: 'qwen2.5-coder:7b' } })
  assert.equal(config.worker.apiKeyEnv, 'GEMINI_API_KEY', 'the stale name this test is about')
  const r = await run(config, {})
  assert.notEqual(r.reason, 'provider_unavailable', `reported unavailable: ${r.error?.message}`)
  assert.equal(r.status, 'ok')
})

test('a renamed key variable is still honoured for a provider that does want one', async () => {
  // The rename must keep working: the capability list says WHETHER a key is wanted, the config
  // says WHICH variable holds it.
  const config = serverConfig(server.url, {}, { worker: { provider: 'gemini', apiKeyEnv: 'MY_GEMINI_KEY' } })
  assert.equal((await run(config, { GEMINI_API_KEY: GEMINI_KEY })).reason, 'provider_unavailable')
  assert.equal((await run(config, { MY_GEMINI_KEY: GEMINI_KEY })).status, 'ok')
})

/* ------------------------------------------------------------ unknown provider */

test('an unregistered provider is unsupported_provider, not a config error', async () => {
  // loadProvider throws with code 'config', which would conflate "that provider does not exist"
  // with "that provider is misconfigured". The registry is checked first so the two stay distinct.
  const before = server.requests.length
  const r = await run(laneConfig({ bulkRead: { provider: 'bedrock', model: 'x' } }), {})
  assert.equal(r.reason, 'unsupported_provider')
  assert.equal(r.error.code, 'unsupported_provider')
  assert.equal(r.error.code !== 'config', true)
  assert.equal(r.provider, 'bedrock', 'the rejected id is echoed so the typo is visible')
  assert.equal(server.requests.length, before)
})

test('an unknown provider is refused before readiness, so it never reports a missing key', async () => {
  const r = await run(laneConfig({ bulkRead: { provider: 'bedrock', model: 'x' } }), {})
  assert.equal(/API_KEY/.test(r.error.message), false)
})

test('every registered provider id resolves and dispatches through the same path', async () => {
  // No provider-specific branch exists in the dispatcher: adding one to the registry is enough.
  const env = { GEMINI_API_KEY: GEMINI_KEY, MOCK_WORKER_URL: server.url }
  const models = { gemini: 'gemini-2.5-flash', ollama: 'qwen2.5-coder:7b', mock: 'mock-1' }
  for (const id of providerIds()) {
    const r = await run(laneConfig({ bulkRead: { provider: id, model: models[id] } }), env)
    assert.equal(r.status, 'ok', `${id} did not dispatch: ${r.reason} ${r.error?.message}`)
    assert.equal(r.provider, id)
    assert.equal(r.capabilities.maxInputBytes > 0, true, `${id} reported no capabilities`)
  }
})

test('capabilities come back even when the call fails, because the cost math needs them', async () => {
  const r = await run(laneConfig({ bulkRead: { provider: 'mock', model: 'mock-1' } }), { MOCK_WORKER_URL: server.url }, { scenario: 'auth_401' })
  assert.equal(r.status, 'error')
  assert.notEqual(r.capabilities, null)
  assert.equal(typeof r.capabilities.reportsThinkingTokens, 'boolean')
})

test('capabilities are null when resolution failed before a module could load', async () => {
  const r = await run(laneConfig({ bulkRead: { provider: 'bedrock', model: 'x' } }), {})
  assert.equal(r.capabilities, null)
})

/* ------------------------------------------------------------------- fallback */

test('an unavailable provider is not silently replaced by a working one', async () => {
  // Phase 4 defines no fallback contract. Quietly succeeding on a provider the operator did not
  // choose would bill an account they did not pick and log a model they never configured.
  const r = await run(laneConfig({ bulkRead: { provider: 'gemini' } }), { MOCK_WORKER_URL: server.url })
  assert.equal(r.reason, 'provider_unavailable')
  assert.equal(r.provider, 'gemini')
  assert.equal(r.text, null)
})
