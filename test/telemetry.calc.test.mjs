/**
 * The math layer.
 *
 * Every test here exists to pin ONE null rule. The governing property is that a missing
 * measurement never becomes a zero, because a zero worker cost understates the worker bill and
 * therefore overstates savings — the single failure mode this project exists to avoid. So the
 * assertions are mostly of the form "this is null, and specifically it is not 0".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addOrNull,
  billableOutputTokens,
  cachedInputTokensFor,
  calculateAvoidedTokens,
  calculateCost,
  calculateEstimatedCostAvoided,
  calculateEstimatedNetSavings,
  calculateTokenDelta,
  priceTokens,
  statusFor,
  subOrNull,
  tokenSumCheck,
} from '../plugins/model-router/lib/telemetry/calc.mjs'
import { caps, pricedTable, usage } from './helpers/telemetry-dir.mjs'

const RATES = pricedTable().models['gemini:gemini-2.5-flash']
const FREE = { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 }

/* ---------------------------------------------------------------- primitives */

test('addOrNull returns null if any operand is null, never treating null as zero', () => {
  assert.equal(addOrNull(1, 2, 3), 6)
  assert.equal(addOrNull(1, null, 3), null)
  assert.equal(addOrNull(0, 0), 0)
  assert.equal(addOrNull(1, undefined), null)
})

test('subOrNull does not clamp a negative result', () => {
  assert.equal(subOrNull(5, 9), -4)
  assert.equal(subOrNull(null, 9), null)
  assert.equal(subOrNull(5, null), null)
})

test('priceTokens divides by a million exactly once', () => {
  assert.equal(priceTokens(1_000_000, 0.3), 0.3)
  assert.equal(priceTokens(600, 0.3), (600 * 0.3) / 1e6)
  assert.equal(priceTokens(null, 0.3), null)
  assert.equal(priceTokens(600, null), null)
  assert.equal(priceTokens(600, 0), 0, 'an explicitly free rate is a real zero')
})

test('statusFor maps a null value to unavailable and nothing else can', () => {
  assert.equal(statusFor(null, 'actual'), 'unavailable')
  assert.equal(statusFor(0, 'actual'), 'actual')
  assert.equal(statusFor(1.5, 'estimated'), 'estimated')
})

/* -------------------------------------------------------- thinking tokens */

test('output plus thinking is reported when both are known', () => {
  const r = billableOutputTokens(usage(), caps())
  assert.equal(r.value, 420)
  assert.equal(r.status, 'actual')
  assert.equal(r.assumption, 'reported')
})

test('a provider that cannot emit thinking tokens yields a structural zero, not a null', () => {
  // Ollama: source is provider_reported, thinking is hardcoded null, and the capability flag
  // proves the null is structural rather than an omission.
  const r = billableOutputTokens(
    usage({ thinkingTokens: null, cachedInputTokens: null }),
    caps({ reportsThinkingTokens: false }),
  )
  assert.equal(r.value, 120)
  assert.equal(r.status, 'actual')
  assert.equal(r.assumption, 'structural_zero')
})

test('a provider that can emit thinking tokens but did not yields null, not the bare output', () => {
  // Gemini with thinking off omits thoughtsTokenCount entirely. Returning `output` here would
  // understate the bill, so the sum is refused.
  const r = billableOutputTokens(usage({ thinkingTokens: null }), caps({ reportsThinkingTokens: true }))
  assert.equal(r.value, null)
  assert.notEqual(r.value, 120)
  assert.equal(r.status, 'unavailable')
  assert.equal(r.assumption, 'unknown')
})

test('an absent capabilities object resolves toward null, never toward a zero', () => {
  for (const c of [null, undefined, {}]) {
    const r = billableOutputTokens(usage({ thinkingTokens: null }), c)
    assert.equal(r.value, null, `capabilities ${JSON.stringify(c)} must resolve to null`)
  }
})

test('missing output tokens make billable output null whatever thinking says', () => {
  const r = billableOutputTokens(usage({ outputTokens: null }), caps())
  assert.equal(r.value, null)
  assert.equal(r.assumption, 'unknown')
})

/* ----------------------------------------------------------- cached input */

test('cached input is a structural zero only when the provider has no cache feature', () => {
  assert.equal(cachedInputTokensFor(usage({ cachedInputTokens: null }), caps({ supportsCachedInput: false })).value, 0)
  assert.equal(cachedInputTokensFor(usage({ cachedInputTokens: null }), caps({ supportsCachedInput: true })).value, null)
  assert.equal(cachedInputTokensFor(usage({ cachedInputTokens: null }), null).value, null)
  assert.equal(cachedInputTokensFor(usage(), caps()).value, 400)
})

/* ----------------------------------------------------------- calculateCost */

test('a fully reported usage against full rates prices every component as actual', () => {
  const c = calculateCost({ usage: usage(), rates: RATES, capabilities: caps(), lookup: 'exact' })
  assert.equal(c.input.value, (600 * 0.3) / 1e6)
  assert.equal(c.cachedInput.value, (400 * 0.075) / 1e6)
  assert.equal(c.output.value, (420 * 2.5) / 1e6)
  assert.equal(c.total.value, c.input.value + c.cachedInput.value + c.output.value)
  for (const k of ['input', 'cachedInput', 'output', 'total']) assert.equal(c[k].status, 'actual', k)
})

test('uncached input is priced alone, so a cached token is never charged at the full input rate', () => {
  // usage.inputTokens is ALREADY max(0, promptTokenCount - cachedContentTokenCount) for Gemini.
  // Pricing input + cached at the input rate would double-charge the cached half.
  const c = calculateCost({ usage: usage(), rates: RATES, capabilities: caps(), lookup: 'exact' })
  assert.equal(c.input.value, (600 * 0.3) / 1e6)
  assert.notEqual(c.input.value, ((600 + 400) * 0.3) / 1e6)
})

test('missing usage yields null money everywhere, and specifically not zero', () => {
  const empty = {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    totalTokens: null,
    source: 'missing',
  }
  const c = calculateCost({ usage: empty, rates: RATES, capabilities: caps(), lookup: 'exact' })
  for (const k of ['input', 'cachedInput', 'output', 'total']) {
    assert.equal(c[k].value, null, k)
    assert.notEqual(c[k].value, 0, `${k} must not be zero`)
    assert.equal(c[k].status, 'unavailable', k)
  }
})

test('a partial usage prices what it knows and refuses to total', () => {
  const partial = usage({ outputTokens: null, thinkingTokens: null, totalTokens: null, source: 'provider_partial' })
  const c = calculateCost({ usage: partial, rates: RATES, capabilities: caps(), lookup: 'exact' })
  assert.equal(c.input.value, (600 * 0.3) / 1e6, 'the measured input cost must survive')
  assert.equal(c.input.status, 'actual')
  assert.equal(c.output.value, null)
  // Never the sum of the knowns: a partial sum presented as a total understates the bill.
  assert.equal(c.total.value, null)
  assert.notEqual(c.total.value, c.input.value + c.cachedInput.value)
})

test('the mirror case: output known, input missing', () => {
  const partial = usage({ inputTokens: null, source: 'provider_partial' })
  const c = calculateCost({ usage: partial, rates: RATES, capabilities: caps(), lookup: 'exact' })
  assert.equal(c.input.value, null)
  assert.equal(c.output.value, (420 * 2.5) / 1e6)
  assert.equal(c.total.value, null)
})

test('provider_reported carries no pricing authority — status comes from the operands', () => {
  // Ollama's shape exactly: source says provider_reported while cached and thinking are null.
  // A derivation keyed on `source` would stamp `actual` on costs whose operands are unknown.
  const ollama = usage({ cachedInputTokens: null, thinkingTokens: null, source: 'provider_reported' })
  const c = calculateCost({
    usage: ollama,
    rates: FREE,
    capabilities: caps({ supportsCachedInput: false, reportsThinkingTokens: false }),
    lookup: 'wildcard',
  })
  assert.equal(c.cachedInput.value, 0, 'structural zero via the capability flag')
  assert.equal(c.output.value, 0)
  assert.equal(c.total.value, 0)
  assert.equal(c.total.status, 'actual', 'a configured zero rate is a real, actual zero')
})

test('an unpriced rate yields null cost, distinctly from an unknown model', () => {
  const unpriced = { inputPerMTok: null, cachedInputPerMTok: null, outputPerMTok: null }
  const a = calculateCost({ usage: usage(), rates: unpriced, capabilities: caps(), lookup: 'exact' })
  assert.equal(a.input.value, null)
  assert.equal(a.input.reason, 'rate_unpriced')

  const b = calculateCost({ usage: usage(), rates: null, capabilities: caps(), lookup: 'model_unknown' })
  assert.equal(b.input.value, null)
  assert.equal(b.input.reason, 'model_unknown')

  const c = calculateCost({ usage: usage(), rates: null, capabilities: caps(), lookup: 'no_table' })
  assert.equal(c.input.reason, 'pricing_unavailable')
})

test('a provider that does not report usage is priced as estimated, never actual', () => {
  const c = calculateCost({
    usage: usage(),
    rates: RATES,
    capabilities: caps({ reportsUsage: false }),
    lookup: 'exact',
  })
  assert.ok(c.total.value > 0)
  assert.equal(c.total.status, 'estimated')
  assert.equal(c.input.status, 'estimated')
})

test('a rate from a user override is actual — provenance never downgrades status', () => {
  const c = calculateCost({ usage: usage(), rates: RATES, capabilities: caps(), lookup: 'requested_alias' })
  assert.equal(c.total.status, 'actual')
})

test('the token sum check flags a provider parser disagreement without changing a cost', () => {
  assert.equal(tokenSumCheck(usage()), 'ok')
  assert.equal(tokenSumCheck(usage({ totalTokens: 9999 })), 'mismatch')
  assert.equal(tokenSumCheck(usage({ totalTokens: null })), 'unknown')
  assert.equal(tokenSumCheck(usage({ thinkingTokens: null })), 'unknown')

  const c = calculateCost({ usage: usage({ totalTokens: 9999 }), rates: RATES, capabilities: caps(), lookup: 'exact' })
  assert.equal(c.tokenSumCheck, 'mismatch')
  assert.equal(c.total.value, c.input.value + c.cachedInput.value + c.output.value, 'a mismatch must not alter a cost')
})

/* ------------------------------------------------- calculateAvoidedTokens */

test('chars over four floors rather than rounds, so the estimate stays a floor', () => {
  const r = calculateAvoidedTokens({ chars: 4003, filesCount: 1, provenFilesCount: 1 })
  assert.equal(r.value, 1000)
  assert.equal(r.status, 'estimated')
})

test('an unknown avoided method never silently falls back to chars over four', () => {
  const r = calculateAvoidedTokens({ chars: 4000, filesCount: 1, provenFilesCount: 1, method: 'vibes' })
  assert.equal(r.value, null)
  assert.notEqual(r.value, 1000)
  assert.equal(r.reason, 'method_unknown')
})

test('an exact token count of a hypothetical prompt is still estimated, never actual', () => {
  const r = calculateAvoidedTokens({
    chars: 4000,
    filesCount: 1,
    provenFilesCount: 1,
    method: 'anthropic_count_tokens',
    countedTokens: 1234,
  })
  assert.equal(r.value, 1234)
  assert.equal(r.status, 'estimated')
})

test('a caller that ignored the proven-files filter gets a refusal, not an inflated corpus', () => {
  const r = calculateAvoidedTokens({ chars: 40_000, filesCount: 6, provenFilesCount: 1 })
  assert.equal(r.value, null)
  assert.equal(r.reason, 'proven_filter_not_applied')
})

test('proven-only counting refuses when the proven count is unknown', () => {
  const r = calculateAvoidedTokens({ chars: 40_000, filesCount: 6, provenFilesCount: null })
  assert.equal(r.value, null)
  assert.equal(r.reason, 'proven_count_unknown')
})

test('calibrated chars-per-token refuses a missing or non-positive divisor', () => {
  const ok = calculateAvoidedTokens({ chars: 3300, filesCount: 1, provenFilesCount: 1, method: 'calibrated_cpt', charsPerToken: 3.3 })
  assert.equal(ok.value, 1000)
  for (const cpt of [null, 0, -1]) {
    const bad = calculateAvoidedTokens({ chars: 3300, filesCount: 1, provenFilesCount: 1, method: 'calibrated_cpt', charsPerToken: cpt })
    assert.equal(bad.value, null, `cpt ${cpt}`)
    assert.equal(bad.reason, 'cpt_unknown')
  }
})

test('an empty corpus is a measured zero, not a gap', () => {
  const r = calculateAvoidedTokens({ chars: 0, filesCount: 0, provenFilesCount: 0 })
  assert.equal(r.value, 0)
  assert.equal(r.status, 'estimated')
})

/* --------------------------------------------------- calculateTokenDelta */

test('the token delta is net of the returned answer', () => {
  const r = calculateTokenDelta({ avoidedInputTokens: 12_000, returnedAnswerTokens: 500 })
  assert.equal(r.value, 11_500)
  assert.equal(r.status, 'estimated')
})

test('an unknown returned-answer size refuses the delta rather than reporting gross', () => {
  const r = calculateTokenDelta({ avoidedInputTokens: 12_000, returnedAnswerTokens: null })
  assert.equal(r.value, null)
  assert.notEqual(r.value, 12_000, 'there must be no gross fallback')
  assert.equal(r.reason, 'returned_answer_unknown')
})

test('a delegation that saved nothing reports zero, which is not the same as unavailable', () => {
  const r = calculateTokenDelta({ avoidedInputTokens: 1000, returnedAnswerTokens: 1000 })
  assert.equal(r.value, 0)
  assert.equal(r.status, 'estimated')
})

test('a verbose worker answer yields a negative delta, stored and never clamped', () => {
  const r = calculateTokenDelta({ avoidedInputTokens: 1000, returnedAnswerTokens: 4000 })
  assert.equal(r.value, -3000)
})

test('the token delta never claims to be actual, for any input', () => {
  for (const [a, b] of [
    [0, 0],
    [1, 0],
    [1e6, 1],
    [1, 1e6],
  ]) {
    assert.notEqual(calculateTokenDelta({ avoidedInputTokens: a, returnedAnswerTokens: b }).status, 'actual')
  }
})

test('residency turns are stamped but never multiplied into the arithmetic', () => {
  // Claude Code pays CACHE rates for resident context, so a tokens-x-turns multiplier inflates
  // the claim 10-40x. The value with 40 turns must equal the value with none.
  const none = calculateTokenDelta({ avoidedInputTokens: 12_000, returnedAnswerTokens: 500 })
  const forty = calculateTokenDelta({
    avoidedInputTokens: 12_000,
    returnedAnswerTokens: 500,
    residencyTurns: 40,
    residencySource: 'transcript_measured',
  })
  assert.equal(forty.value, none.value)
  assert.equal(forty.residencyApplied, 0)
  assert.match(forty.reason, /residency_ignored/)
})

test('a non-zero residency with no provenance is ignored even if the caller insists', () => {
  const r = calculateTokenDelta({
    avoidedInputTokens: 12_000,
    returnedAnswerTokens: 500,
    residencyTurns: 40,
    residencySource: 'default_zero',
  })
  assert.equal(r.value, 11_500)
  assert.equal(r.residencyApplied, 0)
})

/* ------------------------------------------- cost avoided and net savings */

test('cost avoided is priced at the primary input rate only', () => {
  const delta = { value: 12_000, status: 'estimated', reason: 'net_of_answer' }
  const r = calculateEstimatedCostAvoided({
    tokenDelta: delta,
    primaryModel: 'claude-opus-5',
    primaryRates: { inputPerMTok: 15, cachedInputPerMTok: 1.5, outputPerMTok: 75 },
    primaryLookup: 'exact',
  })
  assert.equal(r.value, (12_000 * 15) / 1e6)
  assert.equal(r.status, 'estimated')
})

test('an unset primary model short-circuits to unavailable with a reason', () => {
  const r = calculateEstimatedCostAvoided({
    tokenDelta: { value: 12_000, status: 'estimated' },
    primaryModel: null,
    primaryRates: { inputPerMTok: 15 },
    primaryLookup: 'exact',
  })
  assert.equal(r.value, null)
  assert.equal(r.reason, 'primary_model_unset')
})

test('a negative delta yields negative dollars, unclamped', () => {
  const r = calculateEstimatedCostAvoided({
    tokenDelta: { value: -2000, status: 'estimated' },
    primaryModel: 'claude-opus-5',
    primaryRates: { inputPerMTok: 15 },
    primaryLookup: 'exact',
  })
  assert.equal(r.value, -((2000 * 15) / 1e6))
})

test('cost avoided never claims to be actual', () => {
  const r = calculateEstimatedCostAvoided({
    tokenDelta: { value: 10, status: 'estimated' },
    primaryModel: 'claude-opus-5',
    primaryRates: { inputPerMTok: 15 },
    primaryLookup: 'exact',
  })
  assert.notEqual(r.status, 'actual')
})

test('net savings refuses to net against an unknown worker cost', () => {
  const avoided = { value: 0.18, status: 'estimated', reason: 'priced_at_input_rate' }
  const r = calculateEstimatedNetSavings({ estimatedCostAvoided: avoided, workerTotalCost: { value: null } })
  assert.equal(r.value, null)
  // Reporting the avoided figure here would publish a gross number under a net label.
  assert.notEqual(r.value, 0.18)
  assert.equal(r.reason, 'worker_cost_unknown')
})

test('net savings subtracts the worker bill and keeps a negative result', () => {
  const ok = calculateEstimatedNetSavings({
    estimatedCostAvoided: { value: 0.18, status: 'estimated' },
    workerTotalCost: { value: 0.02, status: 'actual' },
  })
  assert.equal(Math.round(ok.value * 1e6) / 1e6, 0.16)
  assert.equal(ok.reason, 'net_of_worker_cost')

  const bad = calculateEstimatedNetSavings({
    estimatedCostAvoided: { value: 0.01, status: 'estimated' },
    workerTotalCost: { value: 0.05, status: 'actual' },
  })
  assert.ok(bad.value < 0)
  assert.equal(bad.reason, 'negative_savings')
})

test('net savings never claims to be actual, even when the worker cost is actual', () => {
  const r = calculateEstimatedNetSavings({
    estimatedCostAvoided: { value: 0.18, status: 'estimated' },
    workerTotalCost: { value: 0.02, status: 'actual' },
  })
  assert.equal(r.status, 'estimated')
})
