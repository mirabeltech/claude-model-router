/**
 * Latency.
 *
 * TWO COLUMNS EXIST AND FIVE ARE ASKED FOR. The store carries `latency_ms` (end to end: payload
 * assembly, every attempt, the parse) and `provider_latency_ms` (the HTTP round trip of the FINAL
 * attempt only). There is no hook overhead, no governance timing, no capability timing and no
 * time-to-first-token, because `hook/event.mjs` explicitly declines to give `latency_ms` a second
 * meaning. Those components are reported as `unavailable` with a reason — not omitted, and
 * certainly not invented by subtracting timestamps the contract never promised were comparable.
 *
 * THE ONE DERIVED FIGURE IS GUARDED. `latency_ms - provider_latency_ms` is dispatch overhead only
 * when there was exactly one attempt. With a retry the difference silently includes an earlier
 * attempt's network time, so the subtraction stops being a measurement and becomes a plausible
 * number. Those rows are excluded and counted.
 *
 * NO INTERPOLATION ANYWHERE. An interpolated p95 is a latency that never happened.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { percentileNearestRank } from '../plugins/model-router/lib/analytics/aggregates.mjs'
import { NOW, denialRow, dispatchedRow, errorRow, gateRow } from './helpers/analytics-rows.mjs'

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })
const at = (latency_ms, provider_latency_ms = null, over = {}) =>
  dispatchedRow({ latency_ms, provider_latency_ms, ...over })

/* ----------------------------------------------------------- the statistics */

test('no samples gives null for every statistic, never zero', () => {
  // "No samples" and "no time" are different claims, and only one of them is ever true.
  const s = run([]).latency.total
  assert.equal(s.n, 0)
  assert.equal(s.min, null)
  assert.equal(s.median, null)
  assert.equal(s.p95, null)
  assert.equal(s.max, null)
})

test('one sample makes every statistic equal to that sample', () => {
  const s = run([at(1234, 1000)]).latency.total
  assert.deepEqual([s.n, s.min, s.median, s.p95, s.max], [1, 1234, 1234, 1234, 1234])
})

test('the median of an even count is the LOWER middle, not an average of the two', () => {
  // Averaging the two middles is interpolation under another name, and the same argument against
  // an interpolated p95 applies: the reported figure should be one an event actually produced.
  const s = run([at(100, 50), at(200, 50), at(300, 50), at(400, 50)]).latency.total
  assert.equal(s.n, 4)
  assert.equal(s.median, 200, 'not 250')
})

test('the median of an odd count is the true middle', () => {
  const s = run([at(100, 50), at(200, 50), at(300, 50)]).latency.total
  assert.equal(s.median, 200)
})

test('every reported percentile is a value some event actually produced', () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  const s = run(samples.map((v) => at(v, 5))).latency.total
  for (const stat of [s.min, s.median, s.p95, s.p99, s.max]) {
    assert.ok(samples.includes(stat), `${stat} is not one of the measured values`)
  }
  assert.equal(s.interpolated, false)
  assert.equal(s.method, 'nearest_rank')
})

test('the maximum is the largest sample and is never smoothed', () => {
  const s = run([at(100, 50), at(30200, 50)]).latency.total
  assert.equal(s.max, 30200)
})

test('the mean is refused, and the refusal carries its reason', () => {
  // A single GC pause or an antivirus scan moves a mean and barely touches a median, so an
  // average headline would make the number a property of the machine rather than the router.
  const s = run([at(100, 50), at(100000, 50)]).latency.total
  assert.equal(s.mean, null)
  assert.equal(s.meanReason, 'median_and_p95_are_reported_instead')
})

test('nearest rank is exact at the boundaries and never indexes out of range', () => {
  const sorted = [1, 2, 3, 4, 5]
  assert.equal(percentileNearestRank(sorted, 0), 1)
  assert.equal(percentileNearestRank(sorted, 1), 5)
  assert.equal(percentileNearestRank(sorted, 0.95), 5)
  assert.equal(percentileNearestRank(sorted, 0.5), 3)
  assert.equal(percentileNearestRank([], 0.95), null)
  assert.equal(percentileNearestRank([7], 0.95), 7)
})

test('ties return the same value whichever index the rank selects', () => {
  const s = run([at(500, 1), at(500, 1), at(500, 1)]).latency.total
  assert.deepEqual([s.min, s.median, s.p95, s.max], [500, 500, 500, 500])
})

/* ------------------------------------------------------- the gate exclusion */

test('gate rows are excluded from latency and counted, not treated as unmeasured', () => {
  // Both columns are null on every gate row by an explicit design decision. Counting them as
  // missing measurements would report that decision as a data problem, on every store.
  const r = run([at(1000, 900), gateRow(), gateRow(), denialRow()])
  assert.equal(r.latency.gateRowsExcluded, 3)
  assert.equal(r.latency.total.n, 1)
  assert.equal(r.latency.total.unmeasuredRows, 0, 'a gate row is not an unmeasured dispatch')
  assert.match(r.latency.gateRowsExcludedReason, /design decision, not missing data/)
})

test('a dispatched row with a null latency IS counted as unmeasured', () => {
  const r = run([at(1000, 900), dispatchedRow({ latency_ms: null, provider_latency_ms: null })])
  assert.equal(r.latency.total.n, 1)
  assert.equal(r.latency.total.unmeasuredRows, 1)
  assert.equal(r.latency.gateRowsExcluded, 0)
})

test('a failed call contributes its total latency but no provider latency', () => {
  // The dispatcher measured the whole attempt; the final round trip never completed.
  const r = run([errorRow()])
  assert.equal(r.latency.total.n, 1)
  assert.equal(r.latency.total.max, 30200)
  assert.equal(r.latency.provider.n, 0)
  assert.equal(r.latency.provider.unmeasuredRows, 1)
})

/* ---------------------------------------------------- the derived overhead */

test('dispatch overhead is the difference, and only on a single-attempt row', () => {
  const r = run([at(2400, 2100, { retry_count: 0 })])
  const o = r.latency.dispatchOverhead
  assert.equal(o.n, 1)
  assert.equal(o.median, 300)
  assert.equal(o.derived, true)
  assert.equal(o.formula, 'latency_ms - provider_latency_ms')
  assert.equal(o.admittedWhen, 'retry_count === 0')
})

test('a retried row is EXCLUDED from overhead and counted, because the difference is not overhead', () => {
  // provider_latency_ms covers the final attempt only, so with a retry the difference is
  // overhead PLUS an unknown amount of earlier network time. Publishing it would be inventing a
  // number and calling it a measurement.
  const r = run([at(2400, 2100, { retry_count: 0 }), at(9000, 2100, { retry_count: 2 })])
  const o = r.latency.dispatchOverhead
  assert.equal(o.n, 1, 'only the retry-free row contributed')
  assert.equal(o.median, 300)
  assert.equal(o.excludedForRetry, 1)
  assert.match(o.note, /final attempt only/)
})

test('an unknown retry count is excluded and counted separately, not assumed to be zero', () => {
  // retry_count is explicitly never defaulted to 0 on the write side. Excluding on an unknown is
  // as wrong as including on one, so the decision is reported rather than taken.
  const r = run([at(2400, 2100, { retry_count: null })])
  const o = r.latency.dispatchOverhead
  assert.equal(o.n, 0)
  assert.equal(o.excludedForUnknownRetry, 1)
  assert.equal(o.excludedForRetry, 0)
})

test('overhead needs both operands; one null contributes nothing rather than a partial', () => {
  const r = run([at(2400, null, { retry_count: 0 }), at(null, 2100, { retry_count: 0 })])
  assert.equal(r.latency.dispatchOverhead.n, 0)
  assert.equal(r.latency.dispatchOverhead.excludedForRetry, 0)
  assert.equal(r.latency.dispatchOverhead.excludedForUnknownRetry, 0)
})

test('a negative overhead is reported, never clamped', () => {
  // It means the two measurements disagree, which is information about the dispatcher rather
  // than noise to hide. Clamping to zero would make a real inconsistency invisible.
  const r = run([at(2000, 2100, { retry_count: 0 })])
  const o = r.latency.dispatchOverhead
  assert.equal(o.n, 1)
  assert.equal(o.median, -100)
  assert.equal(o.negativeSamples, 1)
})

/* -------------------------------------------------- the missing components */

test('every uninstrumented component is reported as unavailable with a machine-readable reason', () => {
  const c = run([at(1000, 900)]).latency.components
  const expected = {
    hookOverheadMs: 'not_instrumented_by_design',
    governanceDecisionMs: 'not_instrumented',
    capabilityResolutionMs: 'not_instrumented',
    timeToFirstTokenMs: 'not_instrumented',
    perAttemptMs: 'final_attempt_only',
    payloadAssemblyMs: 'not_separable_from_total',
    parseMs: 'not_separable_from_total',
  }
  const violations = []
  for (const [key, reason] of Object.entries(expected)) {
    if (c[key] === undefined) violations.push(`${key} is absent rather than unavailable`)
    else if (c[key].metricKind !== 'unavailable') violations.push(`${key}: ${c[key].metricKind}`)
    else if (c[key].reason !== reason) violations.push(`${key}: ${c[key].reason} != ${reason}`)
    else if (c[key].value !== null) violations.push(`${key} carries a value`)
  }
  assert.deepEqual(violations, [], 'an uninstrumented component was not reported honestly')
})

test('hook overhead names the decision that refuses to record it', () => {
  // The refusal is deliberate and documented in hook/event.mjs; pointing at where it is measured
  // instead is more useful than a bare dash.
  const c = run([]).latency.components
  assert.match(c.hookOverheadMs.detail, /hook\/event\.mjs/)
  assert.match(c.hookOverheadMs.detail, /test\/hook\.latency\.test\.mjs/)
})

test('per-attempt latency explains that the schema cannot hold it', () => {
  const c = run([]).latency.components
  assert.match(c.perAttemptMs.detail, /scalar-only/)
})

/* ---------------------------------------------------------------- the cap */

test('the sample cap is a prefix, and a truncated series says so', () => {
  // A non-deterministic exact-looking number is worse than a deterministic prefix that admits
  // what it is, which is why reservoir sampling was rejected here.
  const rows = Array.from({ length: 12 }, (_, i) => at(100 + i, 50, { retry_count: 0 }))
  const r = analyzeRows(rows, {
    now: NOW,
    window: { kind: 'all' },
    limits: { topN: 20, maxTrackedKeys: 200, maxLatencySamples: 5, maxNegativeExamples: 100, maxDayBuckets: 366, maxOverflowKeyNames: 1000 },
  })
  const s = r.latency.total
  assert.equal(s.samplesKept, 5)
  assert.equal(s.samplesSeen, 12)
  assert.equal(s.truncated, true)
  assert.ok(r.dataQuality.conditions.some((c) => c.id === 'latency_samples_truncated'))
})

test('an untruncated series says that too, so a complete answer is identifiable', () => {
  const s = run([at(100, 50), at(200, 50)]).latency.total
  assert.equal(s.truncated, false)
  assert.equal(s.samplesKept, s.samplesSeen)
})

/* ------------------------------------------------------------- determinism */

test('the same samples in a different order give identical statistics', () => {
  const values = [500, 100, 900, 300, 700]
  const a = run(values.map((v) => at(v, 50))).latency.total
  const b = run([...values].reverse().map((v) => at(v, 50))).latency.total
  for (const key of ['n', 'min', 'median', 'p95', 'p99', 'max']) {
    assert.equal(a[key], b[key], `${key} depended on arrival order`)
  }
})

test('latency is reported over dispatched rows and names that population', () => {
  assert.equal(run([]).latency.population, 'dispatchAttempted')
})
