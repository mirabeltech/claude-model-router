/**
 * Timeout and abort.
 *
 * These are two independent mechanisms that both end a call early, and the dispatcher must tell
 * them apart. ONE MECHANISM PER TEST: a hang driven by both a short timeout and a test-driven
 * abort is a race, and whichever wins first decides the assertion.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import {
  bulkReadPayload,
  delegatingDecision,
  fixedClock,
  serverConfig,
} from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer() })
test.after(async () => { await server?.close() })

const MOCK_ENV = () => ({ MOCK_WORKER_URL: server.url })

/** `timeoutMs` is patched past the resolver: the SPEC minimum is 1000 and these tests need less. */
const mockConfig = (timeoutMs = 5000, workers = {}) =>
  serverConfig(
    server.url,
    { workers: { bulkRead: { provider: 'mock', model: 'mock-1' }, ...workers } },
    { worker: { timeoutMs, maxRetries: 0 } },
  )

const run = (config, extra = {}) =>
  dispatch({
    decision: delegatingDecision(),
    config,
    input: bulkReadPayload(),
    env: MOCK_ENV(),
    sleep: async () => {},
    ...extra,
  })

/* -------------------------------------------------------------------- timeout */

test('the configured timeout fires on a server that never answers', async () => {
  const r = await run(mockConfig(150), { scenario: 'hang' })
  assert.equal(r.status, 'error')
  assert.equal(r.reason, 'provider_error')
  assert.equal(r.error.code, 'timeout')
  assert.equal(r.executed, true, 'a request was made; it simply did not come back')
})

test('a timeout is retryable, and the attempt count reflects what actually happened', async () => {
  const config = serverConfig(
    server.url,
    { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } },
    { worker: { timeoutMs: 120, maxRetries: 2 } },
  )
  const r = await run(config, { scenario: 'hang' })
  assert.equal(r.error.code, 'timeout')
  assert.equal(r.error.retryable, true)
  assert.equal(r.attempts, 3, 'the shared retry policy ran, and reported how many times')
})

test('a per-lane timeout is the one that applies to that lane', async () => {
  // The lane value must reach the provider, not merely be resolved and then dropped.
  const config = serverConfig(
    server.url,
    { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } },
    { worker: { timeoutMs: 60_000, maxRetries: 0 } },
  )
  config.workers = { ...config.workers, bulkRead: { ...config.workers.bulkRead, timeoutMs: 150 } }
  const started = Date.now()
  const r = await run(config, { scenario: 'hang' })
  assert.equal(r.error.code, 'timeout')
  assert.ok(Date.now() - started < 10_000, 'the 60s global timeout was used instead of the lane one')
})

/* ---------------------------------------------------------------------- abort */

test('a signal aborted before dispatch starts makes no call at all', async () => {
  const ctl = new AbortController()
  ctl.abort()
  const before = server.requests.length
  const r = await run(mockConfig(), { scenario: 'ok', signal: ctl.signal })
  assert.equal(r.status, 'skipped')
  assert.equal(r.reason, 'aborted')
  assert.equal(r.executed, false)
  assert.equal(server.requests.length, before)
})

test('an abort mid-flight is reported as aborted, never as the transport error it arrives as', async () => {
  // THE RULE: an abort is identified by the signal, never by the message. httpJson reports a
  // cancel as ProviderError('transport', '<p>: request cancelled') — the same code a dead socket
  // produces — so matching on the text would break the moment anyone rewords it.
  const ctl = new AbortController()
  const promise = run(mockConfig(30_000), { scenario: 'hang', signal: ctl.signal })
  setTimeout(() => ctl.abort(), 50)
  const r = await promise
  assert.equal(r.reason, 'aborted')
  assert.equal(r.error.code, 'aborted')
  assert.notEqual(r.error.code, 'transport')
  assert.equal(r.error.retryable, false, 'the caller asked to stop; retrying would ignore them')
  assert.equal(r.executed, true)
})

test('the caller signal reaches the provider, so an abort actually ends the request', async () => {
  const ctl = new AbortController()
  const started = Date.now()
  const promise = run(mockConfig(30_000), { scenario: 'hang', signal: ctl.signal })
  setTimeout(() => ctl.abort(), 50)
  await promise
  assert.ok(Date.now() - started < 5000, 'the call outlived the abort')
})

test('with no signal passed, abort is unreachable and a hang is a timeout', async () => {
  const r = await run(mockConfig(150), { scenario: 'hang' })
  assert.equal(r.reason, 'provider_error')
  assert.equal(r.error.code, 'timeout')
})

/* ------------------------------------------------------------------ the clock */

test('latencyMs is measured end to end from an injectable clock', async () => {
  const now = fixedClock(1_000_000, 25)
  const r = await run(mockConfig(), { scenario: 'ok', now })
  assert.equal(r.latencyMs, 25)
  assert.equal(now.calls(), 2, 'the clock is read exactly twice: once at entry, once at exit')
})

test('every exit path stamps a latency, including the ones that never call a provider', async () => {
  const paths = [
    { decision: { delegate: false }, config: mockConfig(), input: bulkReadPayload() },
    { decision: null, config: mockConfig(), input: bulkReadPayload() },
    { decision: delegatingDecision({ mode: 'translator' }), config: mockConfig(), input: bulkReadPayload() },
  ]
  for (const args of paths) {
    const now = fixedClock(500, 7)
    const r = await dispatch({ ...args, env: MOCK_ENV(), now })
    assert.equal(r.latencyMs, 7, `${r.reason} did not stamp a latency`)
    assert.equal(now.calls(), 2)
  }
})

test('provider latency and end-to-end latency are two fields, not one', async () => {
  // providerLatencyMs is the final HTTP round trip; latencyMs covers payload assembly, every
  // attempt and the parse. Reporting one as the other would understate the cost of a retry.
  const r = await run(mockConfig(), { scenario: 'ok' })
  assert.equal(typeof r.latencyMs, 'number')
  assert.equal(typeof r.providerLatencyMs, 'number')
  assert.ok(r.latencyMs >= 0 && r.providerLatencyMs >= 0)
})

test('a skipped call reports no provider latency, because there was no round trip to measure', async () => {
  const r = await dispatch({
    decision: { delegate: false },
    config: mockConfig(),
    input: bulkReadPayload(),
    env: MOCK_ENV(),
  })
  assert.equal(r.providerLatencyMs, null)
  assert.notEqual(r.latencyMs, null, 'the dispatcher still took some time, and knows how much')
})
