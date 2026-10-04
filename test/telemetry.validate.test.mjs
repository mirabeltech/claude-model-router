/**
 * Boundary coercion.
 *
 * The one rule being pinned: NEVER CLAMP A MEASUREMENT TO MAKE IT VALID. A negative or nonsense
 * count becomes null, not zero, because clamping to zero fabricates a measurement — and
 * specifically fabricates the one that understates worker cost and overstates savings.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_PLAUSIBLE_TOKENS,
  createWarnings,
  toBool,
  toByteCount,
  toDurationMs,
  toEnum,
  toEstimatedCount,
  toMoney,
  toReportedCount,
  toRetryCount,
  toSignedCount,
  toText,
} from '../plugins/model-router/lib/telemetry/validate.mjs'

test('null and undefined are legitimately absent and record no complaint', () => {
  const w = createWarnings()
  assert.equal(toReportedCount(null, 'f', w), null)
  assert.equal(toReportedCount(undefined, 'f', w), null)
  assert.equal(w.count, 0)
  assert.equal(w.serialize(), null)
})

test('a negative count becomes null, never zero', () => {
  const w = createWarnings()
  assert.equal(toReportedCount(-1, 'worker_input_tokens', w), null)
  assert.notEqual(toReportedCount(-1, 'worker_input_tokens', createWarnings()), 0)
  assert.match(w.serialize(), /negative:worker_input_tokens/)
})

test('negative zero folds to zero — the only clamp in the file, and it changes no magnitude', () => {
  const w = createWarnings()
  assert.equal(toReportedCount(-0, 'f', w), 0)
  assert.equal(Object.is(toReportedCount(-0, 'f', w), -0), false)
  assert.equal(w.count, 0)
})

test('NaN and the infinities become null with a nonfinite code', () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    const w = createWarnings()
    assert.equal(toReportedCount(v, 'f', w), null)
    assert.match(w.serialize(), /nonfinite:f/)
  }
})

test('a numeric string is never coerced — it signals raw JSON passed straight through', () => {
  const w = createWarnings()
  assert.equal(toReportedCount('1234', 'f', w), null)
  assert.match(w.serialize(), /type:f/)
})

test('booleans, arrays and objects are refused as counts', () => {
  for (const v of [true, [], {}, () => {}]) {
    const w = createWarnings()
    assert.equal(toReportedCount(v, 'f', w), null)
    assert.equal(w.count, 1)
  }
})

test('a fractional provider count is refused: the parser is wrong, not the count', () => {
  const w = createWarnings()
  assert.equal(toReportedCount(1234.5, 'f', w), null)
  assert.match(w.serialize(), /fractional:f/)
})

test('a fractional estimated count is floored, because flooring under-counts', () => {
  const w = createWarnings()
  assert.equal(toEstimatedCount(1234.5, 'f', w), 1234)
  assert.equal(w.count, 0)
})

test('an implausible magnitude is treated as corruption, not as a very large measurement', () => {
  const w = createWarnings()
  assert.equal(toReportedCount(MAX_PLAUSIBLE_TOKENS * 10, 'files_count', w), null)
  assert.match(w.serialize(), /implausible:files_count/)
  assert.equal(toByteCount(1e15, 'input_bytes', createWarnings()), null)
})

test('a zero byte or file count is legitimate — the caller always knows it', () => {
  const w = createWarnings()
  assert.equal(toByteCount(0, 'input_bytes', w), 0)
  assert.equal(toEstimatedCount(0, 'files_count', w), 0)
  assert.equal(w.count, 0)
})

test('a negative latency from clock skew becomes null, not zero', () => {
  const w = createWarnings()
  assert.equal(toDurationMs(-3, 'latency_ms', w), null)
  assert.notEqual(toDurationMs(-3, 'latency_ms', createWarnings()), 0)
  assert.match(w.serialize(), /negative:latency_ms/)
})

test('a duration is rounded to whole milliseconds', () => {
  assert.equal(toDurationMs(940.6, 'latency_ms'), 941)
})

test('money accepts any sign, because negative savings are a result rather than a bad reading', () => {
  const w = createWarnings()
  assert.equal(toMoney(-0.04, 'estimated_net_savings', w), -0.04)
  assert.equal(toMoney(0, 'worker_total_cost', w), 0)
  assert.equal(toMoney(null, 'worker_total_cost', w), null)
  assert.equal(w.count, 0)
  assert.equal(toMoney(NaN, 'worker_total_cost', w), null)
  assert.match(w.serialize(), /nonfinite/)
})

test('a signed token delta keeps its sign and truncates toward zero', () => {
  assert.equal(toSignedCount(-3000.9, 'estimated_tokens_avoided'), -3000)
  assert.equal(toSignedCount(11_995, 'estimated_tokens_avoided'), 11_995)
})

test('one attempt means zero retries; an invalid attempt count means unknown, not zero', () => {
  assert.equal(toRetryCount(1), 0)
  assert.equal(toRetryCount(3), 2)
  const w = createWarnings()
  assert.equal(toRetryCount(0, w), null)
  assert.notEqual(toRetryCount(0, createWarnings()), 0, '"unknown" and "no retries" are different facts')
  assert.match(w.serialize(), /invalid:attempts/)
  assert.equal(toRetryCount(null), null)
  assert.equal(toRetryCount(1.5, createWarnings()), null)
})

test('text and boolean fields refuse the wrong type rather than stringifying it', () => {
  const w = createWarnings()
  assert.equal(toText(42, 'model', w), null)
  assert.equal(toBool('yes', 'truncated', w), null)
  assert.equal(w.count, 2)
  assert.equal(toText('gemini-3.8-flash', 'model'), 'gemini-3.8-flash')
  assert.equal(toBool(false, 'truncated'), false)
})

test('an unknown enum value is preserved, not refused, but it is still flagged', () => {
  const w = createWarnings()
  assert.equal(toEnum('weird', 'task_type', ['bulk_read'], w), 'weird')
  assert.match(w.serialize(), /unknown_enum:task_type/)
  assert.equal(toEnum('bulk_read', 'task_type', ['bulk_read'], createWarnings()), 'bulk_read')
})

test('codes are de-duplicated and sorted, so the flat string is stable', () => {
  const w = createWarnings()
  w.add('b:x')
  w.add('a:y')
  w.add('b:x')
  assert.equal(w.serialize(), 'a:y,b:x')
  assert.equal(w.count, 3, 'the count reports occurrences, the codes report distinct problems')
})
