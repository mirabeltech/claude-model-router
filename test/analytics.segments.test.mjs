/**
 * Segmentation.
 *
 * THE NULL KEY IS THE INTERESTING PART. The convention everywhere else is to group a null under
 * the word "unknown", and that is wrong for at least one dimension here: `worker_context_source`
 * has a literal `'unknown'` member, so the mapping would merge "we never resolved a context
 * window" with "the provider told us it does not know" — two different facts with two different
 * fixes. So the wire key stays the shared `NULL_KEY` sentinel, the human word lives in a separate
 * `label`, and consumers branch on `keyKind` rather than on the key string. A model genuinely
 * named `__other__` is still reported as itself.
 *
 * THE TAIL IS FOLDED BY MERGING STATES, NOT VALUES. An `other` bucket built by adding finalized
 * numbers would carry a coverage figure describing no definite row set, which is exactly the
 * mistake `addAgg()` does not exist in order to prevent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { DEFAULT_LIMITS, SEGMENT_DIMENSIONS } from '../plugins/model-router/lib/analytics/schema.mjs'
import { NULL_KEY, aggregate, extractors } from '../plugins/model-router/lib/telemetry/aggregate.mjs'
import { NOW, denialRow, dispatchedRow, errorRow, gateRow, pricedRow } from './helpers/analytics-rows.mjs'

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })
const keys = (dim) => dim.buckets.map((b) => b.key)
const find = (dim, key) => dim.buckets.find((b) => b.key === key)

/* ------------------------------------------------------------- the dimensions */

test('every declared dimension appears, even on an empty window', () => {
  const r = run([])
  for (const dim of SEGMENT_DIMENSIONS) {
    assert.ok(r.segments[dim.id], `${dim.id} is missing`)
    assert.deepEqual(r.segments[dim.id].buckets, [])
  }
})

test('each dimension names the column it grouped by', () => {
  const r = run([dispatchedRow()])
  for (const dim of SEGMENT_DIMENSIONS) {
    assert.equal(r.segments[dim.id].field, dim.field)
  }
})

test('grouping by provider, model, mode, task type and status all work from one pass', () => {
  const r = run([
    dispatchedRow({ provider: 'gemini', model: 'gemini-3.8-flash' }),
    dispatchedRow({ provider: 'ollama', model: 'llama3.1:8b' }),
    gateRow(),
  ])
  assert.deepEqual(keys(r.segments.provider).sort(), ['__null__', 'gemini', 'ollama'])
  assert.deepEqual(keys(r.segments.model).sort(), ['__null__', 'gemini-3.8-flash', 'llama3.1:8b'])
  assert.deepEqual(keys(r.segments.taskType).sort(), ['bulk_read', 'gate_block'])
  assert.deepEqual(keys(r.segments.status).sort(), ['ok', 'skipped'])
})

test('the error-code dimension groups raw values, because the vocabulary is not ours to declare', () => {
  // DISPATCH_ERROR_CODES lives in the dispatch contract, which this layer may not import. A copy
  // of a vocabulary nobody keeps in step is worse than no copy, and the consequence is reported
  // instead: failures.retryable is unavailable.
  const r = run([errorRow({ error_code: 'timeout' }), errorRow({ error_code: 'brand_new_code' })])
  assert.ok(keys(r.segments.errorCode).includes('brand_new_code'))
  assert.equal(r.failures.retryable.metricKind, 'unavailable')
  assert.equal(r.failures.retryable.reason, 'classification_not_available_to_this_layer')
})

/* ---------------------------------------------------------------- the null key */

test('a null group key uses the shared sentinel, not the string "unknown"', () => {
  // `worker_context_source` has a literal 'unknown' member, so mapping null onto that word
  // would merge "never resolved" with "the provider says it does not know".
  const r = run([gateRow()])
  const bucket = find(r.segments.provider, NULL_KEY)
  assert.ok(bucket, 'the null group must exist')
  assert.equal(bucket.keyKind, 'null')
  assert.equal(bucket.label, 'unknown', 'the human word lives in the label')
})

test('an empty-string key is folded into the null key, matching groupBy exactly', () => {
  // A consumer that runs groupBy() from the telemetry layer must produce keys identical to the
  // engine's, or the two disagree about how many groups there are.
  const r = run([dispatchedRow({ provider: '' }), gateRow()])
  assert.equal(find(r.segments.provider, NULL_KEY).events, 2)
  assert.equal(keys(r.segments.provider).includes(''), false)
})

test('the null group is kept, never dropped, because dropping it shrinks the denominator', () => {
  const r = run([dispatchedRow({ provider: 'gemini' }), gateRow(), gateRow()])
  const total = r.segments.provider.buckets.reduce((a, b) => a + b.events, 0)
  assert.equal(total, 3, 'every row is in exactly one bucket')
})

test('a stored value that looks like a sentinel is reported as a value, not as a fold', () => {
  // Consumers branch on keyKind, so a model genuinely named __other__ stays itself.
  const r = run([dispatchedRow({ model: '__other__' })])
  const bucket = find(r.segments.model, '__other__')
  assert.equal(bucket.keyKind, 'value')
  assert.equal(bucket.label, '__other__')
})

test('every bucket declares its key kind and a non-empty label', () => {
  const r = run([dispatchedRow(), gateRow(), denialRow()])
  const violations = []
  for (const [id, dim] of Object.entries(r.segments)) {
    for (const b of dim.buckets) {
      if (!['value', 'null', 'other', 'overflow'].includes(b.keyKind)) violations.push(`${id}.${b.key}`)
      if (typeof b.label !== 'string' || b.label === '') violations.push(`${id}.${b.key}: no label`)
    }
  }
  assert.deepEqual(violations, [], 'a bucket could not be interpreted')
})

/* -------------------------------------------------------------- the date axis */

test('the date dimension groups by UTC day and publishes the complete axis', () => {
  // The axis is the full day list; the buckets cover only days with rows. A renderer iterating
  // the axis gets a zero where there was a zero and a gap where there was a gap — a renderer
  // iterating the buckets alone would draw a line straight through a quiet day.
  const r = analyzeRows(
    [
      dispatchedRow({ timestamp: '2026-03-02T10:00:00.000Z' }),
      dispatchedRow({ timestamp: '2026-03-04T10:00:00.000Z' }),
    ],
    { now: NOW, window: { kind: '7d' } },
  )
  assert.equal(r.segments.date.granularity, 'day')
  assert.equal(r.segments.date.axis.length, 7)
  assert.equal(r.segments.date.axis.at(-1), '2026-03-04')
  assert.deepEqual(keys(r.segments.date), ['2026-03-02', '2026-03-04'])
})

test('the date dimension is never top-N trimmed, because a time series needs every point', () => {
  const r = analyzeRows([dispatchedRow()], { now: NOW, window: { kind: '7d' } })
  assert.equal(r.segments.date.topN, null)
})

test('date buckets are ordered chronologically, not by size', () => {
  const r = analyzeRows(
    [
      dispatchedRow({ timestamp: '2026-03-04T10:00:00.000Z' }),
      dispatchedRow({ timestamp: '2026-03-02T10:00:00.000Z' }),
      dispatchedRow({ timestamp: '2026-03-02T11:00:00.000Z' }),
    ],
    { now: NOW, window: { kind: '7d' } },
  )
  assert.deepEqual(keys(r.segments.date), ['2026-03-02', '2026-03-04'])
})

test('a window longer than the day cap switches to weeks and says so', () => {
  const r = analyzeRows([], {
    now: NOW,
    window: { kind: 'custom', start: '2020-01-01', end: '2026-03-04' },
  })
  assert.equal(r.segments.date.granularity, 'week')
  assert.ok(r.dataQuality.conditions.some((c) => c.id === 'window_exceeds_day_bucket_limit'))
})

/* ---------------------------------------------------------------- the caps */

test('a dimension beyond the top-N cap folds its tail into an `other` bucket', () => {
  const rows = []
  for (let i = 0; i < DEFAULT_LIMITS.topN + 5; i++) {
    // Descending counts, so which keys fall into the tail is unambiguous.
    for (let k = 0; k <= DEFAULT_LIMITS.topN + 5 - i; k++) {
      rows.push(dispatchedRow({ model: `m${String(i).padStart(3, '0')}` }))
    }
  }
  const r = run(rows)
  const dim = r.segments.model
  assert.equal(dim.distinctKeys, DEFAULT_LIMITS.topN + 5)
  assert.equal(dim.foldedIntoOther, 5)
  const other = find(dim, '__other__')
  assert.ok(other, 'the tail must be reported, not discarded')
  assert.equal(other.keyKind, 'other')
  assert.equal(other.foldedKeys, 5)
  assert.match(other.label, /^other \(5 keys below the top 20\)$/)
})

test('the `other` bucket total equals the sum of the rows it folded', () => {
  const rows = []
  for (let i = 0; i < DEFAULT_LIMITS.topN + 3; i++) {
    for (let k = 0; k <= DEFAULT_LIMITS.topN + 3 - i; k++) {
      rows.push(dispatchedRow({ model: `m${String(i).padStart(3, '0')}` }))
    }
  }
  const r = run(rows)
  const dim = r.segments.model
  const kept = dim.buckets.filter((b) => b.keyKind === 'value')
  const other = find(dim, '__other__')
  const accountedFor = kept.reduce((a, b) => a + b.events, 0) + other.events
  assert.equal(accountedFor, rows.length, 'no row may be lost in the fold')
})

test('the `other` bucket coverage is recomputed, not averaged from the buckets it folded', () => {
  // Folding MERGES unfinalized states, so coverage comes from the exact counts of the union.
  // Averaging two coverages would produce a figure describing no definite row set.
  const rows = []
  for (let i = 0; i < DEFAULT_LIMITS.topN + 2; i++) {
    const n = DEFAULT_LIMITS.topN + 2 - i
    for (let k = 0; k <= n; k++) {
      // Every other tail row is priced, so the folded bucket has a genuinely partial coverage.
      rows.push(k % 2 === 0 ? pricedRow({ model: `m${i}` }) : dispatchedRow({ model: `m${i}` }))
    }
  }
  const r = run(rows)
  const other = find(r.segments.model, '__other__')
  const wc = other.metrics.workerCost
  assert.equal(wc.rowsTotal, other.dispatchAttempted)
  assert.equal(wc.coverage, wc.rowsCounted / wc.rowsTotal)
  assert.ok(wc.rowsCounted > 0 && wc.rowsCounted < wc.rowsTotal, 'the fold must be genuinely partial here')
})

test('a dimension beyond the tracked-key cap reports an overflow bucket and a condition', () => {
  const limits = { ...DEFAULT_LIMITS, maxTrackedKeys: 3, topN: 10 }
  const rows = Array.from({ length: 8 }, (_, i) => dispatchedRow({ model: `m${i}` }))
  const r = analyzeRows(rows, { now: NOW, window: { kind: 'all' }, limits })
  const dim = r.segments.model
  assert.equal(dim.truncated, true)
  const overflow = find(dim, '__overflow__')
  assert.ok(overflow)
  assert.equal(overflow.keyKind, 'overflow')
  assert.equal(overflow.events, 5, 'the five keys past the cap')
  assert.equal(overflow.distinctKeysSeen, 5)
  assert.equal(overflow.distinctKeysExact, true)
  assert.ok(r.dataQuality.conditions.some((c) => c.id === 'segments_truncated'))
})

test('the overflow bucket stops counting distinct names past its own cap and says so', () => {
  const limits = { ...DEFAULT_LIMITS, maxTrackedKeys: 1, maxOverflowKeyNames: 2, topN: 10 }
  const rows = Array.from({ length: 6 }, (_, i) => dispatchedRow({ model: `m${i}` }))
  const r = analyzeRows(rows, { now: NOW, window: { kind: 'all' }, limits })
  const overflow = find(r.segments.model, '__overflow__')
  assert.equal(overflow.distinctKeysExact, false, 'an exact count past the cap would be unbounded memory')
  assert.equal(overflow.distinctKeysSeen, 2)
})

test('the date dimension is exempt from the tracked-key cap', () => {
  // It is bounded by the window instead, so a 30-day window is never truncated by a key cap
  // meant for unbounded columns.
  const limits = { ...DEFAULT_LIMITS, maxTrackedKeys: 2 }
  const rows = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'].map((d) =>
    dispatchedRow({ timestamp: `${d}T10:00:00.000Z` }),
  )
  const r = analyzeRows(rows, { now: NOW, window: { kind: '7d' }, limits })
  assert.equal(r.segments.date.truncated, false)
  assert.equal(r.segments.date.buckets.length, 4)
})

/* ------------------------------------------------------------- the ordering */

test('buckets are ordered by count descending then key ascending, a total order', () => {
  const r = run([
    dispatchedRow({ model: 'c' }),
    dispatchedRow({ model: 'b' }),
    dispatchedRow({ model: 'a' }),
    dispatchedRow({ model: 'z' }),
    dispatchedRow({ model: 'z' }),
  ])
  assert.deepEqual(keys(r.segments.model), ['z', 'a', 'b', 'c'])
})

test('the bucket order does not depend on which row arrived first', () => {
  // Map iteration is insertion order, so without an explicit total order the array would differ
  // between two reads of the same store and the CI reproducibility diff would be meaningless.
  const rows = [
    dispatchedRow({ model: 'a' }),
    dispatchedRow({ model: 'b' }),
    dispatchedRow({ model: 'c' }),
  ]
  assert.deepEqual(keys(run(rows).segments.model), keys(run([...rows].reverse()).segments.model))
})

/* ------------------------------------------------------------ bucket metrics */

test('a bucket aggregate agrees with aggregating that bucket row set directly', () => {
  // The streaming per-bucket fold must give the same answer as the batch call over the same rows.
  const gem = [pricedRow({ provider: 'gemini' }), dispatchedRow({ provider: 'gemini' })]
  const r = run([...gem, dispatchedRow({ provider: 'ollama' })])
  const bucket = find(r.segments.provider, 'gemini')
  const direct = aggregate(gem, extractors.workerTotalCost)
  assert.equal(bucket.metrics.workerCost.value, direct.value)
  assert.equal(bucket.metrics.workerCost.rowsTotal, direct.rowsTotal)
  assert.equal(bucket.metrics.workerCost.rowsCounted, direct.rowsCounted)
  assert.equal(bucket.metrics.workerCost.coverage, direct.coverage)
  assert.equal(bucket.metrics.workerCost.status, direct.status)
})

test('a bucket reports the delegation-value dimensions separately, not as one score', () => {
  // The brief forbids an opaque ROI number: an operator has to be able to see which dimension
  // is responsible for a bad-looking segment.
  const r = run([pricedRow({ provider: 'gemini' }), errorRow({ provider: 'gemini' })])
  const b = find(r.segments.provider, 'gemini')
  for (const key of [
    'events',
    'dispatchAttempted',
    'delegationOk',
    'workerFailures',
    'governanceDenials',
    'capabilityRefusals',
    'knownCostEvents',
    'unknownCostEvents',
    'negativeTokenEvents',
    'negativeDollarEvents',
    'delegationRate',
    'failureRate',
    'costCoverage',
  ]) {
    assert.ok(key in b, `${key} is missing from the value view`)
  }
  for (const key of ['workerTokens', 'tokensAvoided', 'workerCost', 'costAvoided', 'netSavings']) {
    assert.ok(b.metrics[key], `${key} is missing from the bucket metrics`)
  }
  assert.equal(b.failureRate, 0.5)
})

test('a bucket rate over an empty sub-population is null, not zero percent', () => {
  const r = run([gateRow()])
  const b = find(r.segments.provider, NULL_KEY)
  assert.equal(b.dispatchAttempted, 0)
  assert.equal(b.failureRate, null, 'no dispatches means no failure rate at all')
  assert.equal(b.costCoverage, null)
  assert.equal(b.delegationRate, 0, 'but the delegation rate IS computable: one event, none sent')
})

test('an unreadable row is in no bucket of any dimension', () => {
  const r = run([dispatchedRow({ provider: 'gemini' }), dispatchedRow({ provider: 'x', schema_version: 2 })])
  assert.deepEqual(keys(r.segments.provider), ['gemini'])
})
