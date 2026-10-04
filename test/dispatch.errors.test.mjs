/**
 * Error normalization: one classified code per failure mode, every one driven through the real
 * transport rather than an injected fake.
 *
 * Two levels, deliberately. `reason` says which branch of the dispatcher owned the outcome;
 * `error.code` says exactly what went wrong. Six reasons coincide with a code; `provider_error`
 * is the one that fans out across the provider vocabulary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { DISPATCH_ERROR_CODES } from '../plugins/model-router/lib/dispatch/contract.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import {
  bulkReadPayload,
  delegatingDecision,
  dispatchConfig,
  serverConfig,
} from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer() })
test.after(async () => { await server?.close() })

const GEMINI_KEY = 'AIzaTESTKEYTESTKEYTESTKEY'

const mockRun = (scenario, { maxRetries = 0 } = {}) =>
  dispatch({
    decision: delegatingDecision(),
    config: serverConfig(
      server.url,
      { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } },
      { worker: { maxRetries } },
    ),
    input: bulkReadPayload(),
    env: { MOCK_WORKER_URL: server.url },
    scenario,
    sleep: async () => {},
  })

const geminiRun = (scenario, { maxRetries = 0 } = {}) =>
  dispatch({
    decision: delegatingDecision(),
    config: serverConfig(
      `${server.url}/s/${scenario}`,
      { workers: { bulkRead: { provider: 'gemini', model: 'gemini-2.5-flash' } } },
      { worker: { maxRetries } },
    ),
    input: bulkReadPayload(),
    env: { GEMINI_API_KEY: GEMINI_KEY },
    sleep: async () => {},
  })

/* ----------------------------------------------------------- HTTP status codes */

test('HTTP status is classified by the shared provider table, not re-derived here', async () => {
  const cases = [
    ['auth_401', 'auth'],
    ['forbidden_403', 'auth'],
    ['not_found_404', 'model_not_found'],
    ['too_large_413', 'payload_too_large'],
    ['rate_limit_429', 'rate_limit'],
    ['server_500', 'http_5xx'],
    ['bad_gateway_502', 'http_5xx'],
  ]
  for (const [scenario, code] of cases) {
    const r = await mockRun(scenario)
    assert.equal(r.error.code, code, `${scenario} classified as ${r.error.code}`)
    assert.equal(r.reason, 'provider_error')
    assert.equal(r.status, 'error')
    assert.equal(r.executed, true)
    assert.equal(r.error.httpStatus, Number(scenario.match(/(\d{3})$/)[1]))
  }
})

test('an auth failure is not retried, because another attempt cannot fix a missing permission', async () => {
  const before = server.requests.length
  const r = await mockRun('auth_401', { maxRetries: 2 })
  assert.equal(r.error.retryable, false)
  assert.equal(r.attempts, 1)
  assert.equal(server.requests.length - before, 1)
})

test('a rate limit and a server error are retried up to the configured ceiling', async () => {
  for (const scenario of ['rate_limit_429', 'server_500']) {
    const r = await mockRun(scenario, { maxRetries: 2 })
    assert.equal(r.error.retryable, true, `${scenario} should be retryable`)
    assert.equal(r.attempts, 3, `${scenario} did not exhaust its retries`)
  }
})

/* ------------------------------------------------------------- body-level faults */

test('a non-JSON body is a parse error and is not retried', async () => {
  const r = await mockRun('not_json', { maxRetries: 2 })
  assert.equal(r.error.code, 'parse_error')
  assert.equal(r.error.retryable, false)
  assert.equal(r.attempts, 1)
})

test('an empty answer is an error, and text stays null rather than becoming an empty string', async () => {
  // '' would read downstream as "the worker answered, and the answer was nothing".
  const r = await mockRun('empty_text')
  assert.equal(r.error.code, 'empty_response')
  assert.equal(r.text, null)
  assert.equal(r.ok, false)
})

test('a safety block is its own code, distinct from an auth or a server failure', async () => {
  for (const scenario of ['safety_blocked', 'prompt_blocked']) {
    const r = await geminiRun(scenario)
    assert.equal(r.error.code, 'provider_safety', `${scenario} classified as ${r.error.code}`)
  }
})

test('a failure delivered inside an HTTP 200 body is still classified', async () => {
  // Ollama reports a missing model with status 200. Trusting the status alone would report this
  // as a success with no text.
  const config = serverConfig(`${server.url}/s/model_not_found_200`, {
    workers: { bulkRead: { provider: 'ollama', model: 'qwen2.5-coder:7b' } },
  })
  const r = await dispatch({ decision: delegatingDecision(), config, input: bulkReadPayload(), env: {} })
  assert.equal(r.error.code, 'model_not_found')
  assert.equal(r.status, 'error')
})

/* ------------------------------------------------------------------- transport */

test('an unreachable endpoint is a transport error, with no fake needed to produce one', async () => {
  const config = serverConfig('http://127.0.0.1:1', {
    workers: { bulkRead: { provider: 'mock', model: 'mock-1' } },
  })
  const r = await dispatch({
    decision: delegatingDecision(),
    config,
    input: bulkReadPayload(),
    env: { MOCK_WORKER_URL: 'http://127.0.0.1:1' },
    sleep: async () => {},
  })
  assert.equal(r.error.code, 'transport')
  assert.equal(r.reason, 'provider_error')
})

test('a provider that cannot be configured reports config, not a transport failure', async () => {
  const config = dispatchConfig(
    { workers: { bulkRead: { provider: 'ollama' } } },
    { providers: { ollama: { baseUrl: server.url, model: null } } },
  )
  const r = await dispatch({ decision: delegatingDecision(), config, input: bulkReadPayload(), env: {} })
  assert.equal(r.error.code, 'config')
  assert.equal(r.reason, 'provider_error')
})

/* ----------------------------------------------------------- the pre-flight gate */

test('an oversized payload is refused before a socket opens, not by the server', async () => {
  // The configured ceiling and the provider's own are both real; the binding one is the smaller.
  // Mock caps at 64 000 bytes, well under the 2 MB config default, so only taking the config
  // value would let this reach the network.
  const before = server.requests.length
  const r = await dispatch({
    decision: delegatingDecision(),
    config: serverConfig(server.url, { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } }),
    input: bulkReadPayload({ files: [{ path: 'big.txt', content: 'x'.repeat(70_000) }] }),
    env: { MOCK_WORKER_URL: server.url },
  })
  assert.equal(r.reason, 'payload_too_large')
  assert.equal(r.error.code, 'payload_too_large')
  assert.equal(r.executed, false)
  assert.equal(server.requests.length, before, 'the payload reached the network anyway')
})

test('the pre-flight refusal and the server s 413 are the same code but different reasons', async () => {
  // Same classification, different place. `reason` is what tells the two apart.
  const preflight = await dispatch({
    decision: delegatingDecision(),
    config: serverConfig(server.url, { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } }),
    input: bulkReadPayload({ files: [{ path: 'big.txt', content: 'x'.repeat(70_000) }] }),
    env: { MOCK_WORKER_URL: server.url },
  })
  const fromServer = await mockRun('too_large_413')
  assert.equal(preflight.error.code, fromServer.error.code)
  assert.equal(preflight.reason, 'payload_too_large')
  assert.equal(fromServer.reason, 'provider_error')
  assert.equal(preflight.executed, false)
  assert.equal(fromServer.executed, true)
})

test('the configured ceiling binds when it is the smaller of the two', async () => {
  const config = serverConfig(
    server.url,
    { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } },
    { worker: { maxInputBytes: 2000 } },
  )
  const r = await dispatch({
    decision: delegatingDecision(),
    config,
    input: bulkReadPayload({ files: [{ path: 'medium.txt', content: 'x'.repeat(5000) }] }),
    env: { MOCK_WORKER_URL: server.url },
  })
  assert.equal(r.reason, 'payload_too_large')
  assert.match(r.error.message, /2000 byte limit/)
})

/* -------------------------------------------------------------- the vocabulary */

test('every code the dispatcher emits is in the declared vocabulary', async () => {
  const results = [
    await mockRun('auth_401'),
    await mockRun('rate_limit_429'),
    await mockRun('server_500'),
    await mockRun('not_json'),
    await mockRun('empty_text'),
    await geminiRun('safety_blocked'),
  ]
  for (const r of results) {
    assert.ok(DISPATCH_ERROR_CODES.includes(r.error.code), `${r.error.code} is not declared`)
  }
})

test('an error carries the attempt count, so a retried failure is distinguishable from a first one', async () => {
  const once = await mockRun('auth_401', { maxRetries: 2 })
  const thrice = await mockRun('server_500', { maxRetries: 2 })
  assert.equal(once.attempts, 1)
  assert.equal(thrice.attempts, 3)
})

test('an error names the provider that produced it', async () => {
  const r = await mockRun('server_500')
  assert.equal(r.error.provider, 'mock')
  assert.equal(r.provider, 'mock')
})
