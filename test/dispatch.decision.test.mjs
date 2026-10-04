/**
 * The gate between a routing decision and a provider call.
 *
 * The one rule this file exists to pin: the dispatcher executes on `delegate === true` and on
 * nothing else. In particular it does NOT read `decision.decision`, because that field answers a
 * different question — what the hook does to the tool call — and its most common delegating
 * value is `'deny'`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { decide } from '../plugins/model-router/lib/routing.mjs'
import { DECIDE_REASONS } from '../plugins/model-router/lib/routing-policy.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import { bulkReadInput, routingConfig } from './helpers/routing-input.mjs'
import {
  bulkReadPayload,
  codeWritePayload,
  decliningDecision,
  delegatingDecision,
  serverConfig,
} from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer() })
test.after(async () => { await server?.close() })

const MOCK_ENV = () => ({ MOCK_WORKER_URL: server.url })
const mockConfig = (overrides = {}) =>
  serverConfig(server.url, {
    workers: {
      bulkRead: { provider: 'mock', model: 'mock-1' },
      codeWrite: { provider: 'mock', model: 'mock-1' },
    },
    ...overrides,
  })

const run = (decision, extra = {}) =>
  dispatch({
    decision,
    config: mockConfig(),
    input: bulkReadPayload(),
    env: MOCK_ENV(),
    scenario: 'ok',
    ...extra,
  })

/* ------------------------------------------------------------------ delegating */

test('a delegating decision executes and returns the worker answer', async () => {
  const r = await run(delegatingDecision())
  assert.equal(r.status, 'ok')
  assert.equal(r.ok, true)
  assert.equal(r.executed, true)
  assert.equal(r.reason, 'completed')
  assert.match(r.text, /UserService/)
  assert.equal(r.error, null)
})

test('decision "deny" with delegate true EXECUTES — deny blocks the tool call, it does not refuse the worker', async () => {
  // The shipped bulkRead lane enforces 'deny' while delegating. A dispatcher that gated on
  // `decision === 'allow'` would refuse every delegation the system is actually designed to make.
  for (const enforcement of ['deny', 'ask', 'suggest', 'allow']) {
    const r = await run(delegatingDecision({ decision: enforcement }))
    assert.equal(r.status, 'ok', `enforcement ${enforcement} did not execute`)
    assert.equal(r.executed, true)
  }
})

test('the code-writer lane dispatches through the same path as bulk-reader', async () => {
  const r = await dispatch({
    decision: delegatingDecision({ mode: 'code-writer', lane: 'codeWrite', taskType: 'code_write' }),
    config: mockConfig(),
    input: codeWritePayload(),
    env: MOCK_ENV(),
    scenario: 'ok',
  })
  assert.equal(r.status, 'ok')
  assert.equal(r.mode, 'code-writer')
  assert.equal(r.lane, 'codeWrite')
})

/* --------------------------------------------------------------- not delegating */

test('a non-delegating decision makes no provider call at all', async () => {
  const before = server.requests.length
  const r = await run(decliningDecision())
  assert.equal(r.executed, false)
  assert.equal(server.requests.length, before, 'a request reached the provider')
})

test('a refusal is skipped, not an error — the caller doing the work itself is the system working', async () => {
  const r = await run(decliningDecision())
  assert.equal(r.status, 'skipped')
  assert.equal(r.reason, 'routing_declined')
  assert.equal(r.ok, false)
  assert.equal(r.error, null, 'a refusal has nothing to report as a failure')
  assert.equal(r.mode, null)
  assert.equal(r.lane, null)
})

test('every reason decide() can refuse with is declined identically, with no call made', async () => {
  // The dispatcher re-reads no threshold, glob or budget: `delegate` already answered.
  const before = server.requests.length
  for (const reason of DECIDE_REASONS) {
    const r = await run(decliningDecision({ reason }))
    assert.equal(r.reason, 'routing_declined', `decide reason ${reason} was not declined`)
    assert.equal(r.status, 'skipped')
  }
  assert.equal(server.requests.length, before)
})

/* ------------------------------------------------------- the real routing engine */

test('a real decide() refusal and a real decide() approval both drive the dispatcher correctly', async () => {
  // Proves the hand-built fixtures in the other tests still match what decide() actually returns.
  const refused = decide(bulkReadInput({ interactive: true }), routingConfig())
  assert.equal(refused.delegate, false)
  const r1 = await run(refused)
  assert.equal(r1.status, 'skipped')
  assert.equal(r1.reason, 'routing_declined')

  const approved = decide(bulkReadInput(), routingConfig())
  assert.equal(approved.delegate, true)
  assert.equal(approved.decision, 'deny', 'the shipped lane denies the tool call while delegating')
  const r2 = await run(approved)
  assert.equal(r2.status, 'ok')
  assert.equal(r2.mode, 'bulk-reader')
  assert.equal(r2.policyVersion, approved.policyVersion)
})

/* ------------------------------------------------------------- invalid decisions */

test('a decision that is not an object is refused rather than treated as a refusal to delegate', async () => {
  // Rejecting loudly matters: silently reading `undefined.delegate` as "do not delegate" would
  // turn a caller bug into a permanent, invisible opt-out of the whole system.
  for (const bad of [undefined, null, 'deny', 42, [], true]) {
    const r = await run(bad)
    assert.equal(r.status, 'error', `${JSON.stringify(bad) ?? 'undefined'} was not refused`)
    assert.equal(r.reason, 'invalid_request')
    assert.equal(r.error.code, 'invalid_request')
    assert.equal(r.executed, false)
  }
})

test('a non-boolean delegate is a caller bug, not a refusal', async () => {
  for (const bad of ['true', 1, null, undefined]) {
    const r = await run(delegatingDecision({ delegate: bad }))
    assert.equal(r.reason, 'invalid_request')
    assert.equal(r.executed, false)
  }
})

test('an unusable config is refused before any provider is resolved', async () => {
  for (const bad of [undefined, null, {}, 'config', { worker: 'gemini' }]) {
    const r = await dispatch({ decision: delegatingDecision(), config: bad, input: bulkReadPayload(), env: MOCK_ENV() })
    assert.equal(r.reason, 'invalid_request')
    assert.equal(r.provider, null)
  }
})

/* ------------------------------------------------------------- unsupported mode */

test('an unknown mode is refused, and the message names the modes that do exist', async () => {
  const before = server.requests.length
  const r = await run(delegatingDecision({ mode: 'translator' }))
  assert.equal(r.reason, 'unsupported_mode')
  assert.equal(r.error.code, 'unsupported_mode')
  assert.equal(r.mode, 'translator', 'the rejected mode is echoed so the caller can see what it sent')
  assert.match(r.error.message, /bulk-reader/)
  assert.match(r.error.message, /code-writer/)
  assert.equal(server.requests.length, before)
})

test('a missing or non-string mode on a delegating decision is unsupported, not a crash', async () => {
  for (const bad of [null, undefined, 42, {}]) {
    const r = await run(delegatingDecision({ mode: bad }))
    assert.equal(r.reason, 'unsupported_mode')
    assert.equal(r.executed, false)
  }
})

test('the mode decides the lane, and a decision that disagrees is warned about rather than obeyed', async () => {
  // MODES is keyed off LANE_MODE, so it cannot disagree with the policy table; a hand-built
  // decision can. Reading the config block named by a mismatched lane would resolve the wrong
  // worker, so the mode wins and the disagreement is recorded.
  const r = await run(delegatingDecision({ mode: 'bulk-reader', lane: 'codeWrite' }))
  assert.equal(r.lane, 'bulkRead')
  assert.ok(r.warnings.includes('lane_mode_mismatch'))
  assert.equal(r.status, 'ok', 'a mismatch is a warning, not a refusal')
})

/* -------------------------------------------------------------- the mode's input */

test('input the mode cannot use is refused before a provider is called', async () => {
  const before = server.requests.length
  const cases = [
    [{ files: [], task: 'x' }, /must not be empty/],
    [{ files: 'not an array', task: 'x' }, /must be an array/],
    [{ files: [{ path: 'a.js' }], task: 'x' }, /content must be a string/],
    [{ files: [{ path: '', content: 'x' }], task: 'x' }, /path must be a non-empty string/],
    [{ files: [{ path: 'a.js', content: 'x' }] }, /task must be a non-empty string/],
    [undefined, /input must be an object/],
  ]
  for (const [input, pattern] of cases) {
    const r = await dispatch({ decision: delegatingDecision(), config: mockConfig(), input, env: MOCK_ENV() })
    assert.equal(r.reason, 'invalid_request', `${JSON.stringify(input)} was accepted`)
    assert.match(r.error.message, pattern)
  }
  assert.equal(server.requests.length, before)
})

test('an empty file is legitimate input; a missing content field is not', async () => {
  // '' is a real file that happens to be empty. undefined is a caller bug. Conflating them would
  // either reject valid corpora or send a corpus with a hole in it.
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload({ files: [{ path: 'empty.js', content: '' }] }),
    env: MOCK_ENV(),
    scenario: 'ok',
  })
  assert.equal(r.status, 'ok')
})
