/**
 * Reproducibility.
 *
 * A BENCHMARK THAT CANNOT BE RERUN IS AN ANECDOTE. But a full `buildEvent()` row cannot be
 * byte-compared across machines, and the reason is worth stating because it looks like a bug:
 *
 *   tz_offset_minutes: -new Date(now).getTimezoneOffset()
 *
 * is MACHINE-LOCAL. Both CI platforms gate, so the same injected `now` produces a different value
 * on a Windows developer box than on Linux CI. Forcing `process.env.TZ` after startup is unreliable
 * on Windows, so the framework does not fight it: it compares a PROJECTION that omits the three
 * fields which legitimately vary, and keeps the full rows as an artifact that is recorded rather
 * than diffed.
 *
 * That also resolves a collision the brief sets up without naming. Real latency measurement and a
 * byte-identical golden file cannot coexist in one artifact — one of them has to be lying. So there
 * are three artifacts, and this file pins which is which.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import { FIELD_ORDER, ROUTER_VERSION } from '../plugins/model-router/lib/telemetry/record.mjs'

/**
 * Deliberately not the release version. A provenance fixture that supplied the real version could
 * only ever assert its own input back, which is how the pass-through test below used to be
 * vacuous.
 */
const FAKE_ROUTER_VERSION = '9.9.9-test'
import {
  EVAL_EVENT_ID_PREFIX,
  EVAL_NOW,
  EVAL_VOLATILE_FIELDS,
  LATENCY_SERIES,
  buildProvenance,
  eventIdFor,
  stableLine,
  stableProjection,
} from './evals/determinism.mjs'
import { EVAL_ARMS } from './evals/config.mjs'
import { EVAL_CHAIN_BUNDLED } from './evals/pricing.mjs'
import { buildEvalRow } from './evals/row.mjs'
import { evalConfig } from './evals/config.mjs'

const CONFIG = evalConfig({}, { projectDir: '/proj' })

const caseDef = {
  id: 'size-at-min-bytes',
  harness: 'dispatch',
  files: [{ path: 'files/at.ts', source: 'generated', bytes: 12_000, lines: 160 }],
  qualityCriteria: null,
  config: {},
  routingInput: {},
  safety: null,
  metadata: {},
}

const decision = Object.freeze({
  decision: 'deny',
  delegate: true,
  mode: 'bulk-reader',
  lane: 'bulkRead',
  reason: 'threshold_met',
  taskType: 'bulk_read',
  estimatedInputTokens: null,
  policyVersion: 1,
  inputWarnings: Object.freeze([]),
})

const resultWith = (latencyMs) =>
  Object.freeze({
    ok: true, executed: true, status: 'ok', reason: 'completed', mode: 'bulk-reader', lane: 'bulkRead',
    provider: 'mock', model: 'mock-1', modelRequested: 'mock-1', text: 'a summary.',
    usage: Object.freeze({ inputTokens: 3000, cachedInputTokens: 0, outputTokens: 3, thinkingTokens: 0, totalTokens: 3003, source: 'provider_reported' }),
    capabilities: Object.freeze({ maxInputBytes: 64_000, supportsSystemPrompt: true, reportsUsage: true, requiresEnv: [], reportsThinkingTokens: true, supportsCachedInput: true }),
    attempts: 1, latencyMs, providerLatencyMs: latencyMs - 1, truncated: false, finishReason: 'stop',
    error: null, promptVersion: 1, policyVersion: 1, warnings: Object.freeze([]),
  })

const rowWith = (latencyMs, seed = 'phase-6') =>
  buildEvalRow({
    caseDef,
    decision,
    result: resultWith(latencyMs),
    config: CONFIG,
    pricingChain: EVAL_CHAIN_BUNDLED,
    corpusChars: 12_000,
    now: EVAL_NOW,
    runSeed: seed,
  })

/* ------------------------------------------------------------- the event id */

test('the event id is a pure function of the case id and the run seed', () => {
  assert.equal(eventIdFor('a-case', 'seed'), eventIdFor('a-case', 'seed'))
  assert.notEqual(eventIdFor('a-case', 'seed'), eventIdFor('b-case', 'seed'))
  assert.notEqual(eventIdFor('a-case', 'seed'), eventIdFor('a-case', 'other'))
})

test('the event id announces itself as synthetic', () => {
  // `buildEvent` writes eventId through verbatim with no UUID constraint. A sha formatted to look
  // like a UUID would be an invalid UUIDv4 AND indistinguishable from a production row at a glance,
  // and with session_id and project_id both null this prefix is the only in-row signal.
  const id = eventIdFor('a-case', 'seed')
  assert.ok(id.startsWith(`${EVAL_EVENT_ID_PREFIX}:`), id)
  assert.match(id, /^eval:a-case:[0-9a-f]{16}$/)
  assert.equal(rowWith(12).event_id.startsWith('eval:'), true)
})

/* ------------------------------------------------------------- the projection */

test('two runs produce a byte-identical projection despite different latency', () => {
  // The whole claim. The rows differ in the one place they must; the golden does not.
  const a = rowWith(12)
  const b = rowWith(9999)
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the full rows must differ, or latency is not measured')
  assert.equal(stableLine(a), stableLine(b), 'the projection must not')
})

test('the projection omits exactly the volatile fields, and tz_offset_minutes is one of them', () => {
  const projected = stableProjection(rowWith(12))
  for (const field of EVAL_VOLATILE_FIELDS) {
    assert.equal(Object.hasOwn(projected, field), false, `${field} must be omitted`)
  }
  assert.ok(EVAL_VOLATILE_FIELDS.includes('tz_offset_minutes'), 'the machine-local field is the reason this exists')
  assert.equal(Object.keys(projected).length, FIELD_ORDER.length - EVAL_VOLATILE_FIELDS.length)
})

test('the projection keeps every savings field, because those must be reproducible', () => {
  // Nothing in the savings path may be projected away. If one of these ever varied between runs,
  // that is a finding about the math, not something to hide.
  const projected = stableProjection(rowWith(12))
  for (const field of [
    'estimated_input_tokens',
    'returned_answer_tokens_estimated',
    'estimated_tokens_avoided',
    'estimated_tokens_avoided_status',
    'estimated_cost_avoided',
    'estimated_net_savings',
    'worker_total_cost',
    'calc_version',
    'pricing_version',
  ]) {
    assert.ok(Object.hasOwn(projected, field), `${field} must survive the projection`)
  }
})

test('the projection key order follows FIELD_ORDER, not insertion order', () => {
  // So two runs cannot differ by ordering alone, and a JSON diff is a diff of values.
  const keys = Object.keys(stableProjection(rowWith(12)))
  const expected = FIELD_ORDER.filter((f) => !EVAL_VOLATILE_FIELDS.includes(f))
  assert.deepEqual(keys, [...expected])
})

test('the projection writes null explicitly rather than dropping a key', () => {
  // `record.mjs` is explicit that absent and null are not two ways of saying the same thing, and
  // JSON.stringify drops undefined — so a projection built by spreading would lose fields silently.
  const projected = stableProjection({ schema_version: 1 })
  assert.equal(projected.worker_total_cost, null)
  assert.ok(Object.hasOwn(projected, 'worker_total_cost'))
  for (const value of Object.values(projected)) {
    assert.notEqual(value, undefined, 'no projected field may be undefined')
  }
})

test('the run seed changes the projection, so two seeds are two runs', () => {
  assert.notEqual(stableLine(rowWith(12, 'seed-a')), stableLine(rowWith(12, 'seed-b')))
})

/* --------------------------------------------------------------- provenance */

const provenanceFor = (arm) =>
  buildProvenance({
    evalSchemaVersion: 1,
    corpusFingerprint: 'abc123',
    corpusCases: 21,
    arm,
    config: { worker: { provider: arm.id, model: 'm' } },
    pricingVersion: 'bundled-unpriced.1',
    pricingSource: 'bundled',
    runSeed: 'phase-6',
    startedAt: '2026-10-03T00:00:00.000Z',
    versions: { policyVersion: 1, promptVersion: 1, schemaVersion: 1, calcVersion: 1, configVersion: 1, routerVersion: FAKE_ROUTER_VERSION },
  })

test('provenance records everything needed to say what produced a number', () => {
  const p = provenanceFor(EVAL_ARMS.mock)
  for (const field of [
    'evalSchemaVersion', 'corpusFingerprint', 'corpusCases', 'arm', 'provider', 'modelRequested',
    'pricingVersion', 'pricingSource', 'runSeed', 'startedAt', 'frozenClock', 'platform', 'arch',
    'nodeVersion', 'policyVersion', 'promptVersion', 'schemaVersion', 'calcVersion', 'configVersion',
    'routerVersion',
  ]) {
    assert.notEqual(p[field], undefined, `${field} is missing from provenance`)
  }
  assert.equal(p.frozenClock, EVAL_NOW)
  assert.equal(p.nodeVersion, process.version)
  assert.equal(p.platform, process.platform)
})

test('modelDependent is derived from the arm, so a live run cannot be filed as reproducible', () => {
  // Derived rather than passed: forgetting a flag must not be able to mislabel a live run.
  const deterministic = provenanceFor(EVAL_ARMS.mock)
  assert.equal(deterministic.deterministic, true)
  assert.equal(deterministic.modelDependent, false)

  const live = provenanceFor(EVAL_ARMS.ollama)
  assert.equal(live.deterministic, false)
  assert.equal(live.modelDependent, true, 'a real model makes every number in the run model-dependent')
})

test('buildProvenance passes a version stamp through rather than inventing one', () => {
  // This fixture supplies FAKE_ROUTER_VERSION, which is deliberately NOT the release version, so
  // the assertion proves pass-through. It used to pass in '0.1.0' and then assert '0.1.0' — the
  // input against itself, under a title claiming the stamp came from the engine.
  const p = provenanceFor(EVAL_ARMS.mock)
  assert.equal(p.routerVersion, FAKE_ROUTER_VERSION)
  assert.notEqual(p.routerVersion, ROUTER_VERSION, 'the fixture must not accidentally equal the real version')
  assert.equal(typeof p.calcVersion, 'number')
  assert.equal(typeof p.policyVersion, 'number')
})

test('the harness stamps the engine version, not a literal of its own', () => {
  // The claim the test above cannot make, made where it is actually true: the one real call site
  // reads ROUTER_VERSION from the engine, so the release version reaches a benchmark row without
  // anybody retyping it.
  const source = readFileSync(new URL('./evals/bin/run.mjs', import.meta.url), 'utf8')
  assert.match(source, /routerVersion:\s*ROUTER_VERSION/, 'run.mjs must stamp the engine constant')
  // Plain substring checks rather than one clever regex: the claim is about two specific lines of
  // source, and a brittle pattern here would fail for reasons that have nothing to do with it.
  assert.ok(
    source.includes("ROUTER_VERSION") &&
      source.includes("from '../../../plugins/model-router/lib/telemetry/record.mjs'"),
    'run.mjs must import the version from the engine rather than redeclaring it',
  )
  assert.ok(
    !/^\s*(?:export\s+)?const ROUTER_VERSION\s*=/m.test(source),
    'run.mjs must not declare a ROUTER_VERSION of its own',
  )
  assert.match(ROUTER_VERSION, /^\d+\.\d+\.\d+$/)
})

/* ------------------------------------------------------------------ latency */

test('seven latency series are declared, and none of them is a total', () => {
  // Two overlap by construction — total_delegated_path contains worker, which contains provider —
  // so a sum would double-count. The absence of a total is the enforcement.
  assert.equal(LATENCY_SERIES.length, 7)
  for (const want of ['hook_startup', 'routing_decision', 'file_load', 'worker', 'provider', 'total_delegated_path', 'primary_path_overhead']) {
    assert.ok(LATENCY_SERIES.includes(want), `${want} must be a declared series`)
  }
  for (const name of LATENCY_SERIES) {
    assert.equal(/total$|sum|overall/.test(name.replace('total_delegated_path', '')), false, `${name} reads like an aggregate`)
  }
})
