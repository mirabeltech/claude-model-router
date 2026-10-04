/**
 * The zero-leak table.
 *
 * `validate.mjs` passes a literal zero straight through, and `calc.mjs`'s `count(0)` is `0`. So a
 * defaulted zero does not fail loudly — it publishes a FABRICATED MEASUREMENT that looks exactly
 * like a real one. CLAUDE.md #5 and the whole savings methodology rest on one sentence:
 *
 *   > A missing measurement is NULL, never 0.
 *
 * This file is that sentence as a test matrix. Each row below passes a hostile `0` where a `null`
 * belongs and asserts the result is `null` with status `unavailable`. Three of them OVERSTATE
 * SAVINGS, which is the one direction of error this project exists to avoid, and they are marked.
 *
 * The second half is the opposite obligation. Five zeros are REAL, and "hardening" them into nulls
 * would be its own lie: a delegation that saved nothing saved nothing, and that must not render
 * identically to "we do not know".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateAvoidedTokens,
  calculateEstimatedCostAvoided,
  calculateEstimatedNetSavings,
  calculateTokenDelta,
} from '../plugins/model-router/lib/telemetry/calc.mjs'
import { aggregate } from '../plugins/model-router/lib/telemetry/aggregate.mjs'
import { buildEvalRow, toEvalEventInputs } from './evals/row.mjs'
import { EVAL_NOW } from './evals/determinism.mjs'
import { EVAL_CHAIN_BUNDLED, evalPricedChain, EVAL_PRIMARY_MODEL } from './evals/pricing.mjs'
import { evalConfig } from './evals/config.mjs'
import { passRate, qualityExtractor } from './evals/metrics.mjs'

const CONFIG = evalConfig({}, { projectDir: '/proj' })

const caseDef = (overrides = {}) => ({
  id: 'zero-leak',
  harness: 'decide',
  files: [{ path: 'files/a.ts', source: 'generated', bytes: 12_000, lines: 160 }],
  qualityCriteria: null,
  config: {},
  routingInput: {},
  safety: null,
  metadata: {},
  ...overrides,
})

const gateDecision = Object.freeze({
  decision: 'allow',
  delegate: false,
  mode: null,
  lane: 'bulkRead',
  reason: 'below_threshold',
  taskType: 'bulk_read',
  estimatedInputTokens: null,
  policyVersion: 1,
  inputWarnings: Object.freeze([]),
})

/* ------------------------------- the three that would overstate savings */

test('OVERSTATES: a zero answer size would publish the gross figure under the net label', () => {
  // The worst one. `calculateTokenDelta` is avoided - returned; a returned of 0 makes the net equal
  // the gross, which is precisely the overstatement docs/savings-methodology.md forbids absolutely.
  const avoided = 3000
  const honest = calculateTokenDelta({ avoidedInputTokens: avoided, returnedAnswerTokens: null })
  assert.equal(honest.value, null, 'an unknown answer size must refuse to compute a net')
  assert.equal(honest.status, 'unavailable')
  assert.equal(honest.reason, 'returned_answer_unknown')

  const fabricated = calculateTokenDelta({ avoidedInputTokens: avoided, returnedAnswerTokens: 0 })
  assert.equal(fabricated.value, avoided, 'a zero would silently equal the gross — this is the trap')

  // And the eval never supplies either field, so `buildEvent` derives them from `result.text`.
  const inputs = toEvalEventInputs({ caseDef: caseDef(), decision: gateDecision, result: null })
  assert.equal(inputs.returnedAnswerChars, null, 'must be null so buildEvent derives it')
  assert.equal(inputs.returnedAnswerTokens, null)
})

test('OVERSTATES: a zero corpus size would be a measured zero where the truth is unavailable', () => {
  const honest = calculateAvoidedTokens({ chars: null, filesCount: 1, provenFilesCount: 1 })
  assert.equal(honest.value, null)
  assert.equal(honest.status, 'unavailable')
  assert.equal(honest.reason, 'chars_unknown')

  const fabricated = calculateAvoidedTokens({ chars: 0, filesCount: 1, provenFilesCount: 1 })
  assert.equal(fabricated.value, 0)
  assert.equal(fabricated.status, 'estimated', 'a zero is reported as a MEASUREMENT, not as a gap')

  // So a gate row must pass corpusChars null, never 0.
  const row = buildEvalRow({
    caseDef: caseDef(),
    decision: gateDecision,
    result: null,
    config: CONFIG,
    pricingChain: EVAL_CHAIN_BUNDLED,
    corpusChars: null,
    now: EVAL_NOW,
    runSeed: 'test',
  })
  assert.equal(row.estimated_input_tokens, null)
  assert.equal(row.estimated_tokens_avoided, null)
  assert.equal(row.estimated_tokens_avoided_status, 'unavailable')
})

test('OVERSTATES: a zero proven-file count slips past the inflated-corpus cross-check', () => {
  // The cross-check only fires when filesCount > provenFilesCount. Pass both as 0 and it never
  // fires, so an unproven corpus would be priced as if the gate had vouched for it.
  const honest = calculateAvoidedTokens({ chars: 48_000, filesCount: 1, provenFilesCount: null })
  assert.equal(honest.value, null)
  assert.equal(honest.reason, 'proven_count_unknown')

  const caught = calculateAvoidedTokens({ chars: 48_000, filesCount: 4, provenFilesCount: 1 })
  assert.equal(caught.value, null)
  assert.equal(caught.reason, 'proven_filter_not_applied', 'claiming more files than were proven is refused')

  const slipped = calculateAvoidedTokens({ chars: 48_000, filesCount: 0, provenFilesCount: 0 })
  assert.equal(slipped.value, 12_000, 'zero over zero passes the check — which is why the eval passes null')

  const inputs = toEvalEventInputs({ caseDef: caseDef({ files: [] }), decision: gateDecision, result: null })
  assert.equal(inputs.filesCount, null)
  assert.equal(inputs.provenFilesCount, null)
})

/* ------------------------------------------- the ones that fabricate a reading */

test('a zero inputBytes from a failed stat would fabricate a reading, so the eval passes null', () => {
  // `fileBytes()` returns null on a failed stat. Writing `?? 0` at the call site would turn "we
  // could not measure this file" into "this file is empty", and nothing downstream could tell.
  const withZero = buildEvalRow({
    caseDef: caseDef(), decision: gateDecision, result: null, config: CONFIG,
    pricingChain: EVAL_CHAIN_BUNDLED, now: EVAL_NOW, runSeed: 'test', inputBytes: 0,
  })
  assert.equal(withZero.input_bytes, 0, 'a zero reaches the row verbatim — it is not sanitised for you')

  const withNull = buildEvalRow({
    caseDef: caseDef(), decision: gateDecision, result: null, config: CONFIG,
    pricingChain: EVAL_CHAIN_BUNDLED, now: EVAL_NOW, runSeed: 'test',
  })
  assert.equal(withNull.input_bytes, null, 'input_bytes must default to null, not 0')
})

test('latency has no injectable zero, because the dispatcher is its only source', () => {
  // `buildEvalRow` takes no latency argument: `latency_ms` comes from `result.latencyMs` and
  // nowhere else. So a gate row's latency is null by construction rather than by discipline, which
  // is the stronger arrangement — there is no call site at which a zero could be introduced.
  const gateRow = buildEvalRow({
    caseDef: caseDef(), decision: gateDecision, result: null, config: CONFIG,
    pricingChain: EVAL_CHAIN_BUNDLED, now: EVAL_NOW, runSeed: 'test',
  })
  assert.equal(gateRow.latency_ms, null, 'no worker ran, so there is no duration to report')
  assert.equal(gateRow.provider_latency_ms, null)

  const inputs = toEvalEventInputs({ caseDef: caseDef(), decision: gateDecision, result: null })
  assert.equal(inputs.latencyMs, null, 'and the mapping reads it only from the result')
})

test('a zero attempt count is invalid, and poisons the one signal the store has', () => {
  // toRetryCount warns `invalid:attempts` and nulls the retry count. The null is right; the warning
  // is the cost, because validation_warnings is what a reader greps for "something looks wrong".
  const r = buildEvalRow({
    caseDef: caseDef({ harness: 'dispatch' }),
    decision: { ...gateDecision, decision: 'deny', delegate: true, mode: 'bulk-reader', reason: 'threshold_met' },
    result: {
      ok: true, executed: true, status: 'ok', reason: 'completed', mode: 'bulk-reader', lane: 'bulkRead',
      provider: 'mock', model: 'mock-1', modelRequested: 'mock-1', text: 'ok', usage: null,
      capabilities: null, attempts: 0, latencyMs: 1, providerLatencyMs: 1, truncated: false,
      finishReason: 'stop', error: null, promptVersion: 1, policyVersion: 1, warnings: [],
    },
    config: CONFIG,
    pricingChain: EVAL_CHAIN_BUNDLED,
    corpusChars: 100,
    now: EVAL_NOW,
    runSeed: 'test',
  })
  assert.equal(r.retry_count, null, 'zero attempts is not zero retries, it is nonsense')
  assert.match(r.validation_codes ?? '', /invalid:attempts/)
})

test('a hand-supplied charsPerToken of 4 would claim a calibration nobody measured', () => {
  // Not a zero, but the same family: it duplicates chars_div_4 under a label asserting a measured
  // characters-per-token ratio. The eval passes null, so `calibrated_cpt` refuses rather than lying.
  const refused = calculateAvoidedTokens({ chars: 48_000, filesCount: 1, provenFilesCount: 1, method: 'calibrated_cpt', charsPerToken: null })
  assert.equal(refused.value, null)
  assert.equal(refused.reason, 'cpt_unknown')

  const inputs = toEvalEventInputs({ caseDef: caseDef(), decision: gateDecision, result: null })
  assert.equal(inputs.charsPerToken, null)
  assert.equal(inputs.workerPromptTokens, null, 'a method this arm does not use must not be half-supplied')
  assert.equal(inputs.countedTokens, null)
})

test('an unknown avoided method never falls back to chars_div_4', () => {
  const r = calculateAvoidedTokens({ chars: 48_000, filesCount: 1, provenFilesCount: 1, method: 'vibes' })
  assert.equal(r.value, null)
  assert.equal(r.reason, 'method_unknown', 'a number must match the method stamped beside it')
})

/* ------------------------------------------------------- aggregates and rates */

test('an aggregate over nothing is null, never zero', () => {
  // `aggregate.mjs` is explicit that an unavailable Agg must never render as $0.00. The reflex fix
  // for a null is `?? 0`, which is why `evals.isolation.test.mjs` greps for that spelling.
  const empty = aggregate([], () => ({ value: 1, status: 'actual' }))
  assert.equal(empty.value, null)
  assert.equal(empty.status, 'empty')

  const allUnavailable = aggregate(
    [{ schema_version: 1 }, { schema_version: 1 }],
    () => ({ value: null, status: 'unavailable' }),
  )
  assert.equal(allUnavailable.value, null)
  assert.equal(allUnavailable.status, 'unavailable')
  assert.equal(allUnavailable.rowsUnavailable, 2)
})

test('a pass rate over nothing graded is null, not zero and not NaN', () => {
  const nothing = aggregate([{ schema_version: 1, task_id: 'a' }], qualityExtractor(new Map()))
  const rate = passRate(nothing)
  assert.equal(rate.value, null, 'zero over zero is unavailable')
  assert.equal(rate.status, 'unavailable')
  assert.equal(rate.passed, null, 'and the numerator is null too, not 0')
  assert.equal(rate.graded, 0)
  assert.equal(rate.total, 1, 'while the total still says how much was never asked')
})

test('an ungraded case contributes nothing to the denominator rather than contributing a zero', () => {
  // A worker crash is an availability fact. Grading it as a quality failure would drag the rate down
  // for a question nobody asked.
  const rows = [
    { schema_version: 1, task_id: 'passed' },
    { schema_version: 1, task_id: 'failed' },
    { schema_version: 1, task_id: 'crashed' },
  ]
  const verdicts = new Map([['passed', 'pass'], ['failed', 'fail']])
  const rate = passRate(aggregate(rows, qualityExtractor(verdicts)))
  assert.equal(rate.passed, 1)
  assert.equal(rate.graded, 2, 'the crashed case is not in the denominator')
  assert.equal(rate.total, 3, 'but it is visible in the total')
  assert.equal(rate.value, 0.5)
})

test('an unpriced rate yields null dollars, never a guessed figure', () => {
  const delta = calculateTokenDelta({ avoidedInputTokens: 3000, returnedAnswerTokens: 9 })
  const unpriced = calculateEstimatedCostAvoided({ tokenDelta: delta, primaryModel: EVAL_PRIMARY_MODEL, primaryRates: { inputPerMTok: null }, primaryLookup: 'exact' })
  assert.equal(unpriced.value, null)
  assert.equal(unpriced.reason, 'primary_rate_unpriced')

  const unset = calculateEstimatedCostAvoided({ tokenDelta: delta, primaryModel: null })
  assert.equal(unset.value, null)
  assert.equal(unset.reason, 'primary_model_unset', 'the primary model is resolved from a session, never guessed')
})

test('net savings refuses to compute rather than publishing a gross figure as net', () => {
  const costAvoided = { value: 0.39, status: 'estimated', reason: 'priced_at_input_rate' }
  const noWorkerCost = calculateEstimatedNetSavings({ estimatedCostAvoided: costAvoided, workerTotalCost: { value: null } })
  assert.equal(noWorkerCost.value, null)
  assert.equal(noWorkerCost.reason, 'worker_cost_unknown', 'no partial netting, under any circumstance')
})

/* ------------------------------------------ the zeros that are real measurements */

test('a zero net token change is a real result and must survive', () => {
  // "This delegation saved nothing" is a finding. It must not render identically to "we do not
  // know", which is why the status travels with the value.
  const r = calculateTokenDelta({ avoidedInputTokens: 500, returnedAnswerTokens: 500 })
  assert.equal(r.value, 0)
  assert.equal(r.status, 'estimated', 'measured, not unavailable')
})

test('a negative net token change is stored unclamped, because it is the evidence', () => {
  const r = calculateTokenDelta({ avoidedInputTokens: 13, returnedAnswerTokens: 179 })
  assert.equal(r.value, -166, 'the live finding that justified this phase')
  assert.equal(r.status, 'estimated')
})

test('negative dollars follow a negative delta, unclamped', () => {
  const delta = calculateTokenDelta({ avoidedInputTokens: 13, returnedAnswerTokens: 179 })
  const cost = calculateEstimatedCostAvoided({
    tokenDelta: delta,
    primaryModel: EVAL_PRIMARY_MODEL,
    primaryRates: { inputPerMTok: 10 },
    primaryLookup: 'exact',
  })
  assert.equal(cost.value, -(166 * 10) / 1e6)
  const net = calculateEstimatedNetSavings({ estimatedCostAvoided: cost, workerTotalCost: { value: 0.001 } })
  assert.ok(net.value < 0)
  assert.equal(net.reason, 'negative_savings', 'flagged by reason, with the value left standing')
})

const REAL_ZEROS = Object.freeze([
  ['retry_count', 'a first-attempt success genuinely retried zero times'],
  ['residency_turns', 'a stamped config value that calc_version 1 ignores'],
  ['validation_warnings', 'a clean row genuinely has no warnings'],
  ['files_inferred_count', 'every corpus file was named, so none was inferred'],
])

for (const [column, why] of REAL_ZEROS) {
  test(`${column} may legitimately be zero, because ${why}`, () => {
    const r = buildEvalRow({
      caseDef: caseDef({ harness: 'dispatch' }),
      decision: { ...gateDecision, decision: 'deny', delegate: true, mode: 'bulk-reader', reason: 'threshold_met' },
      result: {
        ok: true, executed: true, status: 'ok', reason: 'completed', mode: 'bulk-reader', lane: 'bulkRead',
        provider: 'mock', model: 'mock-1', modelRequested: 'mock-1', text: 'ok',
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, thinkingTokens: 0, totalTokens: 12, source: 'provider_reported' },
        capabilities: { maxInputBytes: 64_000, supportsSystemPrompt: true, reportsUsage: true, requiresEnv: [], reportsThinkingTokens: true, supportsCachedInput: true },
        attempts: 1, latencyMs: 5, providerLatencyMs: 4, truncated: false, finishReason: 'stop',
        error: null, promptVersion: 1, policyVersion: 1, warnings: [],
      },
      config: CONFIG,
      pricingChain: evalPricedChain(),
      corpusChars: 400,
      now: EVAL_NOW,
      runSeed: 'test',
    })
    assert.equal(r[column], 0, `${column} must be a real zero here, not nulled out defensively`)
  })
}

test('a structural zero cost is actual, because the provider has no such billing line', () => {
  // One of exactly two controlled departures from the null rule, and it is gated on a CAPABILITY
  // FLAG rather than a guess. An ollama-shaped provider cannot produce thinking tokens, so output
  // alone is a measurement — not an assumption.
  const r = buildEvalRow({
    caseDef: caseDef({ harness: 'dispatch' }),
    decision: { ...gateDecision, decision: 'deny', delegate: true, mode: 'bulk-reader', reason: 'threshold_met' },
    result: {
      ok: true, executed: true, status: 'ok', reason: 'completed', mode: 'bulk-reader', lane: 'bulkRead',
      provider: 'ollama', model: 'llama3:latest', modelRequested: 'llama3:latest', text: 'ok',
      usage: { inputTokens: 10, cachedInputTokens: null, outputTokens: 2, thinkingTokens: null, totalTokens: 12, source: 'provider_reported' },
      capabilities: { maxInputBytes: 64_000, supportsSystemPrompt: true, reportsUsage: true, requiresEnv: [], reportsThinkingTokens: false, supportsCachedInput: false },
      attempts: 1, latencyMs: 5, providerLatencyMs: 4, truncated: false, finishReason: 'stop',
      error: null, promptVersion: 1, policyVersion: 1, warnings: [],
    },
    config: CONFIG,
    pricingChain: evalPricedChain(),
    corpusChars: 400,
    now: EVAL_NOW,
    runSeed: 'test',
  })
  assert.equal(r.worker_thinking_assumption, 'structural_zero')

  // THE DISTINCTION WORTH PINNING, and it is easy to get backwards. The TOKEN column reports what
  // the provider actually reported, which was nothing — so it stays null rather than claiming the
  // provider sent a zero. The COST takes the structural zero, because the capability flag proves
  // no such billing line exists. Two different questions, two different answers, same row.
  assert.equal(r.worker_cached_input_tokens, null, 'the provider reported no count, so the column is null')
  assert.equal(r.provider_supports_cached_input, false, 'and the flag on the row explains why the cost may be zero')
  assert.equal(r.worker_cached_input_cost, 0, 'a provider with no cache feature has a true zero cost')
  assert.equal(r.worker_cached_input_cost_status, 'actual', 'which is a measurement, not an assumption')
  assert.notEqual(r.worker_total_cost, null, 'and so the total is computable')
  assert.equal(r.worker_total_cost_status, 'actual')
})

test('a capability that CAN report and did not resolves toward null, not toward zero', () => {
  // The other side of the same flag. mock declares reportsThinkingTokens true, so an absent count
  // is genuinely unknown and the output cost must refuse.
  const r = buildEvalRow({
    caseDef: caseDef({ harness: 'dispatch' }),
    decision: { ...gateDecision, decision: 'deny', delegate: true, mode: 'bulk-reader', reason: 'threshold_met' },
    result: {
      ok: true, executed: true, status: 'ok', reason: 'completed', mode: 'bulk-reader', lane: 'bulkRead',
      provider: 'mock', model: 'mock-1', modelRequested: 'mock-1', text: 'ok',
      usage: { inputTokens: 10, cachedInputTokens: null, outputTokens: 2, thinkingTokens: null, totalTokens: 12, source: 'provider_reported' },
      capabilities: { maxInputBytes: 64_000, supportsSystemPrompt: true, reportsUsage: true, requiresEnv: [], reportsThinkingTokens: true, supportsCachedInput: true },
      attempts: 1, latencyMs: 5, providerLatencyMs: 4, truncated: false, finishReason: 'stop',
      error: null, promptVersion: 1, policyVersion: 1, warnings: [],
    },
    config: CONFIG,
    pricingChain: evalPricedChain(),
    corpusChars: 400,
    now: EVAL_NOW,
    runSeed: 'test',
  })
  assert.equal(r.worker_thinking_assumption, 'unknown')
  assert.equal(r.worker_output_cost, null, 'an omitted count it could have reported is unknown')
  assert.equal(r.worker_total_cost, null, 'and a total is never a partial sum')
  assert.equal(r.estimated_net_savings, null, 'so the headline refuses, which is the accepted consequence')
})
