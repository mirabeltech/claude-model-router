/**
 * The streaming machinery: the coverage fold, the latency series, and the percentiles.
 *
 * THE FOLD IS RE-EXPORTED, NOT REIMPLEMENTED. `aggInit`/`aggPush`/`aggMerge`/`aggFinalize` live in
 * `telemetry/aggregate.mjs`, where `aggregate()` is now defined in terms of them. There is one
 * implementation of the NULL-is-not-zero rule in this repository and the batch and streaming
 * paths cannot disagree about what `partial` means. A mirrored copy here would have its own tests,
 * would pass them, and would drift.
 *
 * WHAT THIS FILE ADDS is the part `aggregate.mjs` has no opinion about: order statistics. A sum is
 * a fold and needs no samples; a median is not, and the memory question is real at 100k rows.
 *
 * NO RNG ANYWHERE. Reservoir sampling would bound memory exactly and was rejected: it makes a p95
 * non-reproducible for the same store, and this repo has determinism tests precisely because a
 * number that moves between two runs of the same input cannot be used as evidence. A deterministic
 * prefix cap that SAYS it is a prefix is honest; an exact-looking number that is not reproducible
 * is not.
 */

import {
  aggFinalize,
  aggInit,
  aggMerge,
  aggPush,
  KNOWN_SCHEMA_VERSIONS,
} from '../telemetry/aggregate.mjs'
import { DEFAULT_LIMITS, NULL_REASONS } from './schema.mjs'

export { aggInit, aggPush, aggMerge, aggFinalize, KNOWN_SCHEMA_VERSIONS }

/** The Agg keys, so a consumer can assert the shape it was handed is complete. */
export const AGG_KEYS = Object.freeze([
  'value',
  'rowsTotal',
  'rowsCounted',
  'rowsUnavailable',
  'rowsIncompatible',
  'coverage',
  'status',
  'rowsActual',
  'rowsEstimated',
  'rowsUnknownStatus',
  'basis',
  'bound',
  'pricingVersions',
  'calcVersions',
  'homogeneous',
])

/**
 * Why an aggregate's value is null, derived from its own state rather than guessed.
 *
 * Only ever called when `value === null`, and the four answers are genuinely different advice:
 * an empty window means widen the window, an empty population means the metric does not apply to
 * these rows, all-unavailable means configure a measurement, and all-incompatible means upgrade
 * the reader.
 */
export function nullReasonFor(agg, { windowEmpty = false } = {}) {
  if (agg.value !== null) return null
  if (agg.rowsTotal === 0) return windowEmpty ? NULL_REASONS[0] : NULL_REASONS[1]
  if (agg.rowsIncompatible === agg.rowsTotal) return NULL_REASONS[3]
  return NULL_REASONS[2]
}

/* ------------------------------------------------------------ order statistics */

/**
 * The percentile used everywhere in this layer: NEAREST RANK, no interpolation.
 *
 * Copied from `test/helpers/timing.mjs`, which is already the house convention, and the reason is
 * worth stating. An interpolated p95 is a latency that never happened: it averages two
 * measurements into a third that no event produced. Nearest rank always returns a value that was
 * actually measured, so an operator who sees a p95 of 18,400 ms can go and find the event. Ties
 * are identical values, so whichever index the rank selects returns the same number.
 */
export function percentileNearestRank(sortedAsc, q) {
  const n = sortedAsc.length
  if (n === 0) return null
  const rank = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))
  return sortedAsc[rank]
}

/**
 * A bounded sample collector for one latency column.
 *
 * Exact samples in a growable typed array, hard-capped, with the cap surfaced. Three series at
 * 200,000 samples is about 4.8 MB and the answer is exact for any realistic store. Past the cap,
 * collection STOPS and `truncated` is set, so a prefix p95 is never presented as a complete one.
 *
 * A non-finite sample is counted as `nullRows`, not pushed as a zero. "The call took no time" and
 * "we failed to measure it" are different claims; only one of them belongs in a median.
 */
export function createSeries({ maxSamples = DEFAULT_LIMITS.maxLatencySamples, label = null } = {}) {
  return {
    label,
    maxSamples,
    buf: new Float64Array(Math.min(1024, maxSamples)),
    n: 0,
    seen: 0,
    nullRows: 0,
    negative: 0,
    truncated: false,
  }
}

export function seriesPush(series, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    series.nullRows += 1
    return series
  }
  series.seen += 1
  if (value < 0) series.negative += 1
  if (series.n >= series.maxSamples) {
    series.truncated = true
    return series
  }
  if (series.n >= series.buf.length) {
    const grown = new Float64Array(Math.min(series.buf.length * 2, series.maxSamples))
    grown.set(series.buf.subarray(0, series.n))
    series.buf = grown
  }
  series.buf[series.n++] = value
  return series
}

/**
 * Turn a series into its order statistics.
 *
 * `mean` IS DELIBERATELY NULL. A single GC pause or an antivirus scan moves a mean and barely
 * touches a median, so reporting an average as the headline latency would make the number a
 * property of the machine rather than of the router. The field exists so a consumer sees the
 * refusal rather than wondering where the average went.
 */
export function seriesFinalize(series, { unit = 'ms' } = {}) {
  const n = series.n
  const sorted = series.buf.subarray(0, n).slice().sort((a, b) => a - b)
  return Object.freeze({
    metricKind: 'series',
    unit,
    // Every statistic is null at n === 0. Never 0: "no samples" is not "no time".
    n,
    min: n === 0 ? null : sorted[0],
    // The LOWER median on an even count. Averaging the two middles is interpolation under
    // another name, and the same argument against an interpolated p95 applies.
    median: n === 0 ? null : sorted[Math.floor((n - 1) / 2)],
    p95: percentileNearestRank(sorted, 0.95),
    p99: percentileNearestRank(sorted, 0.99),
    max: n === 0 ? null : sorted[n - 1],
    mean: null,
    meanReason: 'median_and_p95_are_reported_instead',
    samplesSeen: series.seen,
    samplesKept: n,
    truncated: series.truncated,
    // Rows in the population that carried no measurement at all.
    unmeasuredRows: series.nullRows,
    // Reported, never clamped: a negative sample means two measurements disagree, which is
    // information about the dispatcher rather than noise to hide.
    negativeSamples: series.negative,
    method: 'nearest_rank',
    interpolated: false,
  })
}

/* --------------------------------------------------------------- histograms */

/**
 * A counting histogram over one column, with the null group kept rather than dropped.
 *
 * Dropping nulls would shrink the denominator, which is the same error as treating a null sum as
 * zero: the percentages would still add to 100% and would describe a population nobody chose.
 */
export function createHistogram() {
  return { counts: new Map(), nulls: 0, total: 0 }
}

export function histogramPush(hist, value) {
  hist.total += 1
  if (value === null || value === undefined || value === '') {
    hist.nulls += 1
    return hist
  }
  const key = String(value)
  hist.counts.set(key, (hist.counts.get(key) ?? 0) + 1)
  return hist
}

/**
 * Finalize a histogram into a sorted array of `{key, count}`.
 *
 * Ordered by count descending then key ascending — a TOTAL order, so two runs over the same store
 * produce the same array and the CI reproducibility diff means something.
 */
export function histogramFinalize(hist, { nullKey = null } = {}) {
  const buckets = [...hist.counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (hist.nulls > 0 && nullKey !== null) buckets.push({ key: nullKey, count: hist.nulls })
  return Object.freeze({
    total: hist.total,
    nulls: hist.nulls,
    distinct: hist.counts.size,
    buckets: Object.freeze(buckets),
  })
}

/* ------------------------------------------------------------------ counters */

/** A plain named counter set, so every counted condition is reported even at zero. */
export function createCounters(names) {
  const out = {}
  for (const name of names) out[name] = 0
  return out
}

/**
 * A bounded "worst N" collector.
 *
 * It keeps the extremes rather than the first N, because the first N negative-savings events are
 * an accident of file order while the worst N are the ones worth investigating. Sorted on
 * finalize by the same total order the histograms use, so the output is deterministic.
 */
export function createTopList({ limit = DEFAULT_LIMITS.maxNegativeExamples, compare } = {}) {
  return { limit, compare, items: [], seen: 0 }
}

export function topListPush(list, item) {
  list.seen += 1
  list.items.push(item)
  // Trim lazily at twice the limit so the sort is amortised rather than per-row.
  if (list.items.length >= list.limit * 2) {
    list.items.sort(list.compare)
    list.items.length = list.limit
  }
  return list
}

export function topListFinalize(list) {
  list.items.sort(list.compare)
  const kept = list.items.slice(0, list.limit)
  return Object.freeze({
    seen: list.seen,
    kept: kept.length,
    truncated: list.seen > kept.length,
    items: Object.freeze(kept),
  })
}

/**
 * The latest non-null observation of a value, by instant.
 *
 * Needed for budget limits, which must NEVER be summed: a limit is not a quantity consumed, so
 * adding `budget_limit` across rows produces a number with no meaning. The most recent
 * observation per scope is the only honest aggregate of a configured ceiling.
 */
export function createLatest() {
  return { ms: -Infinity, value: null, observations: 0 }
}

export function latestPush(latest, ms, value) {
  if (value === null || value === undefined) return latest
  latest.observations += 1
  if (typeof ms === 'number' && ms >= latest.ms) {
    latest.ms = ms
    latest.value = value
  }
  return latest
}
