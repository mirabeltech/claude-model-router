/**
 * The shape of a dispatch result, and the vocabularies it draws on.
 *
 * This file owns the STRUCTURE: which keys exist, in what order, what is frozen, and that the
 * enums agree with the layers either side. Which branch produces which outcome belongs to
 * `dispatch.decision.test.mjs`; what each error code means belongs to `dispatch.errors.test.mjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DISPATCH_ERROR_CODES,
  DISPATCH_OWNED_CODES,
  DISPATCH_REASONS,
  DISPATCH_STATUSES,
  RESULT_KEYS,
  buildResult,
  dispatchError,
} from '../plugins/model-router/lib/dispatch/contract.mjs'
import { MODES, PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'
import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { ERROR_CODES } from '../plugins/model-router/lib/providers/contract.mjs'
import { modelCapability } from '../plugins/model-router/lib/providers/capability.mjs'
import { LANE_MODE } from '../plugins/model-router/lib/routing-policy.mjs'
import { STATUS_VALUES } from '../plugins/model-router/lib/telemetry/record.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import {
  bulkReadPayload,
  decliningDecision,
  delegatingDecision,
  serverConfig,
} from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer() })
test.after(async () => { await server?.close() })

const MOCK_ENV = () => ({ MOCK_WORKER_URL: server.url })
const mockConfig = (overrides = {}, patch = {}) =>
  serverConfig(
    server.url,
    { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } }, ...overrides },
    patch,
  )

/* ---------------------------------------------------------------- the key list */

test('the result carries exactly these twenty-one fields, in this order', async () => {
  // The phase that writes telemetry reads this object. Adding a field is additive; reordering or
  // dropping one is not.
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload(),
    env: MOCK_ENV(),
    scenario: 'ok',
  })
  assert.deepEqual(Object.keys(r), [...RESULT_KEYS])
})

test('every outcome produces the identical key list, so a caller never feature-detects a field', async () => {
  const outcomes = [
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV(), scenario: 'ok' }),
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV(), scenario: 'auth_401' }),
    await dispatch({ decision: decliningDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV() }),
    await dispatch({ decision: null, config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV() }),
  ]
  for (const r of outcomes) assert.deepEqual(Object.keys(r), [...RESULT_KEYS])
})

test('no field is ever undefined — absent and null must not be two ways of saying one thing', async () => {
  for (const r of await everyReason()) {
    for (const key of RESULT_KEYS) {
      assert.notEqual(r[key], undefined, `${r.reason}: ${key} is undefined`)
    }
  }
})

test('the result and its usage object are frozen, so a reader cannot edit a measurement', async () => {
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload(),
    env: MOCK_ENV(),
    scenario: 'ok',
  })
  assert.equal(Object.isFrozen(r), true)
  assert.equal(Object.isFrozen(r.usage), true)
  assert.equal(Object.isFrozen(r.warnings), true)
  assert.throws(() => { 'use strict'; r.status = 'ok' }, TypeError)
})

/* ------------------------------------------------------------------- the enums */

test('every DISPATCH_REASONS member is reachable by some input', async () => {
  // The completeness check that catches a branch written and then shadowed by an earlier one.
  const seen = new Set((await everyReason()).map((r) => r.reason))
  assert.deepEqual([...seen].sort(), [...DISPATCH_REASONS].sort())
})

test('DISPATCH_REASONS has no duplicates', () => {
  assert.equal(new Set(DISPATCH_REASONS).size, DISPATCH_REASONS.length)
})

test('the error vocabulary is the provider list plus exactly six the dispatcher owns', () => {
  // Derived from ERROR_CODES rather than re-typed, so a new provider code cannot desync the two.
  for (const code of ERROR_CODES) assert.ok(DISPATCH_ERROR_CODES.includes(code), `${code} was dropped`)
  const extra = DISPATCH_ERROR_CODES.filter((c) => !ERROR_CODES.includes(c))
  assert.deepEqual(extra.sort(), [
    'aborted',
    // A token window, not the provider layer's `payload_too_large` byte ceiling. Listed
    // literally so adding a dispatcher-owned code stays a deliberate act.
    'context_exceeded',
    'invalid_request',
    'provider_unavailable',
    'unsupported_mode',
    'unsupported_provider',
  ])
  assert.deepEqual([...extra].sort(), [...DISPATCH_OWNED_CODES].sort())
  assert.equal(new Set(DISPATCH_ERROR_CODES).size, DISPATCH_ERROR_CODES.length)
})

test('the dispatcher-owned codes do not collide with a provider code', () => {
  // A collision would silently redefine a provider's meaning rather than add to it.
  for (const code of DISPATCH_OWNED_CODES) {
    assert.equal(ERROR_CODES.includes(code), false, `${code} is already a provider code`)
  }
})

test('every status the dispatcher emits is a telemetry STATUS_VALUES member', async () => {
  // Assigned to the column, never translated into it.
  assert.deepEqual([...DISPATCH_STATUSES], [...STATUS_VALUES])
  for (const r of await everyReason()) {
    assert.ok(STATUS_VALUES.includes(r.status), `${r.reason} emitted status ${r.status}`)
  }
})

test('the mode table and the routing policy name the same two modes', () => {
  // MODES is keyed off LANE_MODE's values, so a lane added to routing without a mode here shows
  // up as a missing key rather than as a mode nobody notices is unreachable.
  assert.deepEqual(Object.keys(MODES).sort(), [...Object.values(LANE_MODE)].sort())
  for (const [mode, def] of Object.entries(MODES)) {
    assert.equal(def.id, mode)
    assert.equal(LANE_MODE[def.lane], mode)
  }
})

/* --------------------------------------------------------------- the builders */

test('buildResult derives ok from status rather than trusting a caller to pass both', () => {
  assert.equal(buildResult({ status: 'ok' }).ok, true)
  assert.equal(buildResult({ status: 'error' }).ok, false)
  assert.equal(buildResult({ status: 'skipped' }).ok, false)
  // A caller that tries to disagree with status loses.
  assert.equal(buildResult({ status: 'error', ok: true }).ok, false)
})

test('buildResult sorts and de-duplicates warnings, so the list is stable across runs', () => {
  assert.deepEqual(buildResult({ warnings: ['b', 'a', 'b'] }).warnings, ['a', 'b'])
})

test('dispatchError degrades an unlisted code to unknown rather than inventing a vocabulary', () => {
  assert.equal(dispatchError('not_a_real_code', 'x').code, 'unknown')
  assert.equal(dispatchError('aborted', 'x').code, 'aborted')
  assert.equal(dispatchError('rate_limit', 'x').code, 'rate_limit')
})

test('a dispatcher error is a plain frozen object, never a ProviderError', () => {
  // ProviderError's constructor coerces any unlisted code to 'unknown', so building one with
  // 'aborted' would silently lose the classification this layer exists to add.
  const e = dispatchError('aborted', 'cancelled')
  assert.equal(e instanceof Error, false)
  assert.equal(Object.isFrozen(e), true)
  assert.deepEqual(Object.keys(e).sort(), ['code', 'detail', 'httpStatus', 'message', 'provider', 'retryable'])
})

test('the prompt version is a positive integer and is stamped on a result', async () => {
  assert.ok(Number.isInteger(PROMPT_VERSION) && PROMPT_VERSION > 0)
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload(),
    env: MOCK_ENV(),
    scenario: 'ok',
  })
  assert.equal(r.promptVersion, PROMPT_VERSION)
  assert.equal(r.policyVersion, delegatingDecision().policyVersion)
})

/* ------------------------------------------------------------------- fixtures */

/** One result per DISPATCH_REASONS member. */
async function everyReason() {
  const ctl = new AbortController()
  ctl.abort()
  const huge = bulkReadPayload({
    files: [{ path: 'big.txt', content: 'x'.repeat(70_000) }],
    task: 'summarise',
  })
  // Under mock's 64 KB byte ceiling, so step 9 lets it through and step 9b is the branch that
  // refuses it. The window is injected through the provider's OWN discovery seam rather than by
  // claiming a capability, so the fixture cannot drift away from how production resolves one.
  const overContext = bulkReadPayload({
    files: [{ path: 'wide.txt', content: 'x'.repeat(40_000) }],
    task: 'summarise',
  })
  const tinyWindow = async () =>
    modelCapability({ provider: 'mock', model: 'mock-1', contextTokens: 2048, source: 'provider_api', measuredAt: 0 })
  return [
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV(), scenario: 'ok' }),
    await dispatch({ decision: decliningDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV() }),
    await dispatch({ decision: 'not an object', config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV() }),
    await dispatch({ decision: delegatingDecision({ mode: 'translator' }), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV() }),
    await dispatch({
      decision: delegatingDecision(),
      config: mockConfig({ workers: { bulkRead: { provider: 'bedrock', model: 'x' } } }),
      input: bulkReadPayload(),
      env: MOCK_ENV(),
    }),
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: bulkReadPayload(), env: {} }),
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: huge, env: MOCK_ENV() }),
    await dispatch({
      decision: delegatingDecision(),
      config: mockConfig(),
      input: overContext,
      env: MOCK_ENV(),
      describeModelImpl: tinyWindow,
    }),
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV(), scenario: 'auth_401' }),
    await dispatch({ decision: delegatingDecision(), config: mockConfig(), input: bulkReadPayload(), env: MOCK_ENV(), signal: ctl.signal }),
  ]
}
