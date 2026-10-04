/**
 * The assembled event.
 *
 * These are the end-to-end assertions about what actually lands in the store: that the schema is
 * complete, that the measurement statuses agree with their values, and above all that nothing
 * unmeasured arrives as a zero.
 *
 * The two invariants that carry the design are property-tested here:
 *
 *     INV-1  value === null   <=>   status === 'unavailable'     (bidirectional)
 *     INV-2  status === 'actual'  =>  every operand was a measured count and a known rate
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { buildEvent } from '../plugins/model-router/lib/telemetry/event.mjs'
import { BUNDLED_PRICING } from '../plugins/model-router/lib/telemetry/pricing-table.mjs'
import {
  CALC_VERSION,
  FIELD_ORDER,
  ROUTER_VERSION,
  SCHEMA_VERSION,
} from '../plugins/model-router/lib/telemetry/record.mjs'
import { ProviderError } from '../plugins/model-router/lib/providers/contract.mjs'
import { FROZEN_MS, caps, pricedChain, telemetryConfig, usage } from './helpers/telemetry-dir.mjs'

const bundledChain = [{ table: BUNDLED_PRICING, source: 'bundled' }]

const result = (o = {}) => ({
  text: 'a summary of three files',
  usage: usage(),
  model: 'gemini-3.8-flash',
  providerLatencyMs: 820,
  truncated: false,
  finishReason: 'STOP',
  ...o,
})

/** A delegation that went well, priced against a real table. */
function event(overrides = {}, configOverrides = {}) {
  return buildEvent({
    config: telemetryConfig('/proj', configOverrides),
    pricingChain: pricedChain(),
    identity: { session_id: 's1', project_id: 'p1', project_path: null },
    providerId: 'gemini',
    result: result(),
    capabilities: caps(),
    attempts: 1,
    filesCount: 3,
    provenFilesCount: 3,
    inputBytes: 48_000,
    corpusChars: 48_000,
    latencyMs: 940,
    now: FROZEN_MS,
    eventId: 'fixed-event-id',
    ...overrides,
  })
}

/** All the monetary fields, paired with the status that must agree with each. */
const MONEY = [
  ['worker_input_cost', 'worker_input_cost_status'],
  ['worker_cached_input_cost', 'worker_cached_input_cost_status'],
  ['worker_output_cost', 'worker_output_cost_status'],
  ['worker_total_cost', 'worker_total_cost_status'],
  ['primary_input_cost', 'primary_input_cost_status'],
  ['primary_output_cost', 'primary_output_cost_status'],
  ['primary_total_cost', 'primary_total_cost_status'],
  ['estimated_cost_avoided', 'estimated_cost_avoided_status'],
  ['estimated_net_savings', 'estimated_net_savings_status'],
]

/* ------------------------------------------------------------------- shape */

test('the event carries every declared field and nothing else', () => {
  assert.deepEqual(Object.keys(event()).sort(), [...FIELD_ORDER].sort())
})

test('no value is ever undefined — absence is always null', () => {
  for (const [k, v] of Object.entries(event())) assert.notEqual(v, undefined, k)
})

test('the version stamps are written at write time, so a stored row is self-describing', () => {
  const e = event()
  assert.equal(e.schema_version, SCHEMA_VERSION)
  assert.equal(e.calc_version, CALC_VERSION)
  assert.equal(e.router_version, ROUTER_VERSION)
  assert.equal(e.pricing_version, 'test.1')
  assert.equal(e.pricing_source, 'file')
  assert.equal(e.currency, 'USD')
  assert.equal(e.privacy_level, 'hashed')
})

test('the timestamp is ISO UTC and the offset is signed minutes ahead of UTC', () => {
  const e = event()
  assert.equal(e.timestamp, new Date(FROZEN_MS).toISOString())
  assert.match(e.timestamp, /Z$/)
  assert.equal(e.tz_offset_minutes, -new Date(FROZEN_MS).getTimezoneOffset())
})

/* ------------------------------------------------------------- normal event */

test('a fully measured delegation prices every component as actual', () => {
  const e = event()
  assert.equal(e.worker_input_tokens, 600)
  assert.equal(e.worker_cached_input_tokens, 400)
  assert.equal(e.worker_output_tokens, 120)
  assert.equal(e.worker_thought_tokens, 300)
  assert.equal(e.worker_billable_output_tokens, 420)
  assert.equal(e.worker_thinking_assumption, 'reported')
  assert.equal(e.worker_token_sum_check, 'ok')

  assert.equal(e.worker_input_cost, (600 * 0.3) / 1e6)
  assert.equal(e.worker_cached_input_cost, (400 * 0.075) / 1e6)
  assert.equal(e.worker_output_cost, (420 * 2.5) / 1e6)
  assert.equal(e.worker_total_cost, e.worker_input_cost + e.worker_cached_input_cost + e.worker_output_cost)
  assert.equal(e.worker_total_cost_status, 'actual')
  assert.equal(e.status, 'ok')
  assert.equal(e.retry_count, 0)
  assert.equal(e.validation_warnings, 0)
  assert.equal(e.validation_codes, null)
})

test('the full savings chain resolves when a primary model is set and priced', () => {
  const e = event({}, { primaryModel: 'claude-opus-5' })
  assert.equal(e.estimated_input_tokens, 12_000)
  assert.equal(e.returned_answer_chars, 'a summary of three files'.length)
  assert.equal(e.returned_answer_tokens_estimated, Math.floor('a summary of three files'.length / 4))
  assert.equal(e.estimated_tokens_avoided, 12_000 - e.returned_answer_tokens_estimated)
  assert.equal(e.estimated_cost_avoided, (e.estimated_tokens_avoided * 15) / 1e6)
  assert.equal(e.estimated_net_savings, e.estimated_cost_avoided - e.worker_total_cost)
  assert.equal(e.estimated_net_savings_status, 'estimated')
})

test('a stored row can be recomputed from its own fields — router verify in miniature', () => {
  const e = event({}, { primaryModel: 'claude-opus-5' })
  // Every money field is reproducible from the row plus the table its pricing_version names.
  const rates = pricedChain()[0].table.models['gemini:gemini-3.8-flash']
  const primary = pricedChain()[0].table.models['anthropic:claude-opus-5']
  assert.equal(e.worker_input_cost, (e.worker_input_tokens * rates.inputPerMTok) / 1e6)
  assert.equal(e.worker_cached_input_cost, (e.worker_cached_input_tokens * rates.cachedInputPerMTok) / 1e6)
  assert.equal(e.worker_output_cost, (e.worker_billable_output_tokens * rates.outputPerMTok) / 1e6)
  assert.equal(e.estimated_cost_avoided, (e.estimated_tokens_avoided * primary.inputPerMTok) / 1e6)
  assert.equal(e.estimated_net_savings, e.estimated_cost_avoided - e.worker_total_cost)
})

/* ---------------------------------------------------------- the invariants */

test('INV-1: a null value always pairs with an unavailable status, and vice versa', () => {
  const cases = [
    event(),
    event({}, { primaryModel: 'claude-opus-5' }),
    event({ pricingChain: bundledChain }),
    event({ result: null, providerId: null }),
    event({ result: result({ usage: { ...usage(), outputTokens: null, source: 'provider_partial' } }) }),
    event({ capabilities: caps({ reportsThinkingTokens: true }), result: result({ usage: usage({ thinkingTokens: null }) }) }),
    event({ corpusChars: null }),
    event({ error: new ProviderError('timeout', 'slow'), result: null }),
  ]
  for (const [i, e] of cases.entries()) {
    for (const [field, statusField] of MONEY) {
      const nullValue = e[field] === null
      const unavailable = e[statusField] === 'unavailable'
      assert.equal(nullValue, unavailable, `case ${i}: ${field}=${e[field]} but ${statusField}=${e[statusField]}`)
    }
  }
})

test('INV-2: nothing is stamped actual against the unpriced bundled table', () => {
  const e = event({ pricingChain: bundledChain })
  for (const [field, statusField] of MONEY) {
    assert.equal(e[field], null, field)
    assert.equal(e[statusField], 'unavailable', statusField)
  }
})

test('the counterfactual statuses can never be actual', () => {
  // Structural: one operand is always a hypothetical. Checked across the whole case matrix.
  for (const primaryModel of [null, 'claude-opus-5']) {
    for (const chain of [bundledChain, pricedChain()]) {
      for (const corpusChars of [null, 0, 48_000]) {
        const e = event({ pricingChain: chain, corpusChars }, { primaryModel })
        for (const f of [
          'estimated_tokens_avoided_status',
          'estimated_cost_avoided_status',
          'estimated_net_savings_status',
        ]) {
          assert.notEqual(e[f], 'actual', `${f} claimed actual`)
        }
      }
    }
  }
})

/* --------------------------------------------------------- the bundled table */

test('out of the box every monetary field is null and tokens avoided still works', () => {
  // The accepted consequence of shipping null rates. The honest headline is non-monetary.
  const e = event({ pricingChain: bundledChain })
  assert.equal(e.worker_total_cost, null)
  assert.equal(e.estimated_net_savings, null)
  assert.equal(e.pricing_lookup, 'exact')
  assert.equal(e.estimated_tokens_avoided, 12_000 - e.returned_answer_tokens_estimated)
  assert.equal(e.estimated_tokens_avoided_status, 'estimated')
})

test('an unknown model is distinguishable from a deliberately unpriced one', () => {
  // Both the served AND the requested model must be absent from the table, or the
  // requested_alias path legitimately rescues the lookup.
  const unknownConfig = telemetryConfig('/proj')
  unknownConfig.worker = { provider: 'gemini', model: 'gemini-9.9-imaginary' }
  const unknown = event({
    config: unknownConfig,
    result: result({ model: 'gemini-9.9-imaginary' }),
    pricingChain: bundledChain,
  })
  assert.equal(unknown.pricing_lookup, 'model_unknown')
  assert.equal(unknown.pricing_version, null)

  const unpriced = event({ pricingChain: bundledChain })
  assert.equal(unpriced.pricing_lookup, 'exact')
  assert.notEqual(unpriced.pricing_version, null)
  // Both yield null costs; pricing_lookup is what tells an operator which fix applies.
  assert.equal(unknown.worker_total_cost, null)
  assert.equal(unpriced.worker_total_cost, null)
})

test('the served model and the requested model are both recorded for the alias path', () => {
  const e = event({ result: result({ model: 'gemini-3.8-flash-001' }) })
  assert.equal(e.model, 'gemini-3.8-flash-001')
  assert.equal(e.model_requested, 'gemini-3.8-flash')
  assert.equal(e.pricing_lookup, 'requested_alias')
  assert.notEqual(e.worker_input_cost, null, 'the alias must still price')
})

/* ------------------------------------------------------- missing worker usage */

test('missing worker usage yields null money everywhere and never a zero', () => {
  const e = event({
    result: result({
      usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, thinkingTokens: null, totalTokens: null, source: 'missing' },
    }),
  })
  assert.equal(e.worker_usage_source, 'missing')
  for (const f of ['worker_input_cost', 'worker_cached_input_cost', 'worker_output_cost', 'worker_total_cost']) {
    assert.equal(e[f], null, f)
    assert.notEqual(e[f], 0, `${f} must not be zero`)
  }
  assert.equal(e.estimated_net_savings, null)
})

test('net savings is not the avoided figure when the worker cost is unknown', () => {
  const e = event({
    pricingChain: pricedChain(),
    result: result({ usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, thinkingTokens: null, totalTokens: null, source: 'missing' } }),
  }, { primaryModel: 'claude-opus-5' })
  assert.notEqual(e.estimated_cost_avoided, null, 'the counterfactual still resolves')
  assert.equal(e.estimated_net_savings, null)
  assert.notEqual(e.estimated_net_savings, e.estimated_cost_avoided, 'no gross-as-net fallback')
})

test('a partial usage keeps the measured side and refuses to total', () => {
  const e = event({
    result: result({ usage: usage({ outputTokens: null, thinkingTokens: null, totalTokens: null, source: 'provider_partial' }) }),
  })
  assert.equal(e.worker_usage_source, 'provider_partial')
  assert.equal(e.worker_input_cost, (600 * 0.3) / 1e6)
  assert.equal(e.worker_input_cost_status, 'actual')
  assert.equal(e.worker_output_cost, null)
  assert.equal(e.worker_total_cost, null)
})

/* ------------------------------------------------------ missing primary usage */

test('primary usage is unavailable before a transcript reader exists', () => {
  const e = event()
  assert.equal(e.primary_usage_status, 'unavailable')
  assert.equal(e.primary_usage_method, 'none')
  for (const f of ['primary_input_tokens', 'primary_output_tokens', 'primary_total_tokens', 'primary_input_cost', 'primary_output_cost', 'primary_total_cost']) {
    assert.equal(e[f], null, f)
  }
})

test('naming a primary model does not by itself produce primary usage', () => {
  const e = event({}, { primaryModel: 'claude-opus-5' })
  assert.equal(e.primary_model, 'claude-opus-5')
  assert.equal(e.primary_usage_status, 'unavailable')
  assert.equal(e.primary_input_tokens, null)
})

test('an unset primary model explains why cost avoided is null', () => {
  const e = event()
  assert.equal(e.primary_model, null)
  assert.equal(e.estimated_cost_avoided, null)
  assert.equal(e.estimated_cost_avoided_status, 'unavailable')
})

test('a measured primary usage fills the columns and flips the status, with no schema change', () => {
  // The Phase 3 path, exercised now so the columns are proven to be the right shape.
  const e = event(
    {
      primaryUsage: { inputTokens: 90_000, cachedInputTokens: 0, outputTokens: 1200, thinkingTokens: 0, totalTokens: 91_200, source: 'provider_reported' },
      primaryUsageMethod: 'transcript_measured',
    },
    { primaryModel: 'claude-opus-5' },
  )
  assert.equal(e.primary_usage_status, 'actual')
  assert.equal(e.primary_input_tokens, 90_000)
  assert.equal(e.primary_input_cost, (90_000 * 15) / 1e6)
  assert.equal(e.primary_total_cost_status, 'actual')
})

/* -------------------------------------------------- cached and thought tokens */

test('cached input is priced at the cache rate, never at the full input rate', () => {
  const e = event()
  assert.equal(e.worker_input_cost, (600 * 0.3) / 1e6)
  assert.notEqual(e.worker_input_cost, ((600 + 400) * 0.3) / 1e6)
  assert.equal(e.worker_cached_input_cost, (400 * 0.075) / 1e6)
})

test('an ollama-shaped event takes both structural zeros and still totals', () => {
  const e = event({
    providerId: 'ollama',
    result: result({ model: 'qwen2.5-coder:7b', usage: usage({ cachedInputTokens: null, thinkingTokens: null, totalTokens: 720 }) }),
    capabilities: caps({ supportsCachedInput: false, reportsThinkingTokens: false }),
  })
  assert.equal(e.worker_usage_source, 'provider_reported')
  assert.equal(e.worker_cached_input_tokens, null, 'the raw reading stays null')
  assert.equal(e.worker_cached_input_cost, 0, 'but the cost is a structural zero')
  assert.equal(e.worker_billable_output_tokens, 120)
  assert.equal(e.worker_thinking_assumption, 'structural_zero')
  assert.equal(e.worker_total_cost, 0)
  assert.equal(e.worker_total_cost_status, 'actual')
})

test('a gemini omission of thought tokens nulls the output cost rather than understating it', () => {
  const e = event({
    result: result({ usage: usage({ thinkingTokens: null }) }),
    capabilities: caps({ reportsThinkingTokens: true }),
  })
  assert.equal(e.worker_thought_tokens, null)
  assert.equal(e.worker_billable_output_tokens, null)
  assert.equal(e.worker_thinking_assumption, 'unknown')
  assert.equal(e.worker_output_cost, null)
  assert.equal(e.worker_total_cost, null)
  assert.equal(e.estimated_net_savings, null)
})

test('capability flags are stamped, because they are what distinguish a structural null', () => {
  const e = event({ capabilities: caps({ reportsThinkingTokens: false, supportsCachedInput: false }) })
  assert.equal(e.provider_reports_usage, true)
  assert.equal(e.provider_reports_thinking_tokens, false)
  assert.equal(e.provider_supports_cached_input, false)
})

test('a provider that does not report usage is stamped estimated, never actual', () => {
  const e = event({ capabilities: caps({ reportsUsage: false }) })
  assert.notEqual(e.worker_total_cost, null)
  assert.equal(e.worker_total_cost_status, 'estimated')
  assert.equal(e.provider_reports_usage, false)
})

/* ---------------------------------------------------------------- outcomes */

test('a provider error records a safe code and a skipped-call status', () => {
  const err = new ProviderError('rate_limit', 'gemini: HTTP 429', { provider: 'gemini', httpStatus: 429 })
  err.attempts = 3
  // No explicit `attempts`: the caller did not get a return value, so the count comes off the
  // error the registry stamped it on.
  const e = event({ result: null, attempts: null, error: err, routingReason: 'provider_error' })
  assert.equal(e.status, 'error')
  assert.equal(e.error_code, 'rate_limit')
  assert.equal(e.retry_count, 2, 'attempts is 1-based')
  assert.equal(e.model, null)
  assert.equal(e.worker_total_cost, null)
})

test('an error detail is withheld unless storeErrorDetail opts in, and is redacted when stored', () => {
  const err = new ProviderError('auth', 'bad key', { detail: 'key AIzaSYSOMETHINGSECRET1234567 rejected' })
  assert.equal(event({ result: null, error: err }).error_message_safe, null)

  const stored = event({ result: null, error: err }, { storeErrorDetail: true })
  assert.notEqual(stored.error_message_safe, null)
  assert.match(stored.error_message_safe, /\[redacted\]/)
  assert.equal(stored.error_message_safe.includes('AIzaSY'), false)
})

test('no worker call at all is skipped, not an error', () => {
  const e = event({ result: null, providerId: null, taskType: 'gate_block', routingDecision: 'deny', routingReason: 'deny_glob' })
  assert.equal(e.status, 'skipped')
  assert.equal(e.error_code, null)
  assert.equal(e.task_type, 'gate_block')
  assert.equal(e.routing_decision, 'deny')
})

test('end-to-end latency and provider latency are separate fields', () => {
  const e = event()
  assert.equal(e.latency_ms, 940)
  assert.equal(e.provider_latency_ms, 820, 'the provider figure covers the HTTP round trip only')
})

/* ----------------------------------------------------------------- privacy */

test('question text is withheld by default and clamped by characters when stored', () => {
  assert.equal(event({ questionText: 'summarize these files' }).question_text, null)
  const stored = event({ questionText: 'x'.repeat(500) }, { storeQuestionText: true, questionTextMaxChars: 50 })
  assert.equal(stored.question_text.length, 50)
})

test('a stored question is redacted', () => {
  const stored = event({ questionText: 'token=AIzaSYSOMETHINGSECRET1234567' }, { storeQuestionText: true })
  assert.equal(stored.question_text.includes('AIzaSY'), false)
})

/* ------------------------------------------------------- invalid caller input */

test('an invalid caller number is nulled, flagged, and never clamped to zero', () => {
  const e = event({ inputBytes: -5, filesCount: 3, provenFilesCount: 3 })
  assert.equal(e.input_bytes, null)
  assert.notEqual(e.input_bytes, 0)
  assert.equal(e.validation_warnings, 1)
  assert.match(e.validation_codes, /negative:input_bytes/)
})

test('a hostile usage object cannot inject a fabricated measurement', () => {
  const e = event({
    result: result({ usage: { inputTokens: '600', cachedInputTokens: -1, outputTokens: NaN, thinkingTokens: 1.5, totalTokens: 1e15, source: 'provider_reported' } }),
  })
  for (const f of ['worker_input_tokens', 'worker_cached_input_tokens', 'worker_output_tokens', 'worker_thought_tokens', 'worker_total_tokens']) {
    assert.equal(e[f], null, f)
  }
  assert.ok(e.validation_warnings >= 5)
  assert.equal(e.worker_total_cost, null)
})

test('every shipped provider shape passes the boundary with no warnings', () => {
  // Keeps the provider layer and the telemetry boundary honest about each other.
  const shapes = [
    { caps: caps(), usage: usage() },
    { caps: caps({ supportsCachedInput: false, reportsThinkingTokens: false }), usage: usage({ cachedInputTokens: null, thinkingTokens: null, totalTokens: 720 }) },
  ]
  for (const s of shapes) {
    const e = event({ capabilities: s.caps, result: result({ usage: s.usage }) })
    assert.equal(e.validation_warnings, 0, e.validation_codes ?? '')
  }
})

test('an unknown enum value is preserved and flagged rather than rejected', () => {
  const e = event({ taskType: 'from_the_future' })
  assert.equal(e.task_type, 'from_the_future')
  assert.match(e.validation_codes, /unknown_enum:task_type/)
})

/* --------------------------------------------------- counterfactual plumbing */

test('an unknown avoided method nulls the estimate rather than guessing a divisor', () => {
  const e = event({}, { avoidedMethod: 'vibes' })
  assert.equal(e.avoided_method, 'vibes')
  assert.equal(e.estimated_input_tokens, null)
  assert.equal(e.estimated_tokens_avoided, null)
})

test('the proven-only filter and residency provenance are stamped on every row', () => {
  const e = event()
  assert.equal(e.count_proven_files_only, true)
  assert.equal(e.residency_turns, 0)
  assert.equal(e.residency_source, 'default_zero')
  assert.equal(e.counterfactual_render, 'raw')
  assert.equal(e.avoided_method, 'chars_div_4')
})

test('an inflated corpus is refused rather than counted', () => {
  const e = event({ filesCount: 9, provenFilesCount: 2 })
  assert.equal(e.files_count, 9)
  assert.equal(e.estimated_input_tokens, null, 'the proven-filter inconsistency must refuse the estimate')
  assert.equal(e.estimated_tokens_avoided, null)
})

test('a verbose answer produces negative tokens avoided, stored unclamped', () => {
  const e = event({ corpusChars: 400, result: result({ text: 'y'.repeat(40_000) }) })
  assert.ok(e.estimated_tokens_avoided < 0, `expected negative, got ${e.estimated_tokens_avoided}`)
  assert.equal(e.estimated_tokens_avoided_status, 'estimated')
})

/* ------------------------------------------------- event identity, and duplicates */

/**
 * WHAT A DUPLICATE event_id MEANS, pinned because the answer is "nothing deduplicates it".
 *
 * There is no dedupe anywhere in the read path — no Set of seen ids, no uniqueness check in the
 * aggregator. That is a decision rather than an omission, and it is only safe because of where
 * the id comes from: `emitEvent` generates a fresh `crypto.randomUUID()` per record, so the
 * router cannot emit the same id twice. A duplicate in a store therefore means a segment file was
 * copied, restored or concatenated by hand — an operator action, not a router behaviour.
 *
 * Counting a copied row twice is the right answer to that: the alternative is for the reader to
 * silently drop rows that look alike, which would hide a genuine double-write on a filesystem
 * where append atomicity failed. The reader already reports a mid-file malformed line as evidence
 * of exactly that; quietly deduplicating would remove the other half of the signal.
 */

test('a generated event id is a fresh UUID every time', () => {
  // The property the no-dedupe decision rests on. If ids were derived from content — a hash of
  // the row, say — two identical delegations a second apart would collide and the store would
  // silently lose one.
  const ids = new Set()
  for (let i = 0; i < 200; i++) ids.add(crypto.randomUUID())
  assert.equal(ids.size, 200, 'no collisions across 200 generated ids')
})

test('buildEvent defaults to the all-zero id, which is never what a real row carries', () => {
  // The default is deliberately an obvious sentinel rather than a generated value: buildEvent is
  // pure and must not reach for randomness, so a row that reaches a store with this id did not go
  // through emitEvent. That makes it a detectable fixture rather than a plausible-looking record.
  // buildEvent directly, not the local `event()` helper, because that helper injects a fixed id —
  // which is itself the point of the test below.
  const bare = buildEvent({ config: telemetryConfig('/proj'), now: FROZEN_MS })
  assert.equal(bare.event_id, '00000000-0000-0000-0000-000000000000')
})

test('an injected id is used verbatim, which is what makes a fixture reproducible', () => {
  // The fixture corpus depends on this: the committed JSONL files are byte-pinned, so the id has
  // to be supplied rather than generated.
  const e = event({ eventId: 'fixed-0001' })
  assert.equal(e.event_id, 'fixed-0001')
})
