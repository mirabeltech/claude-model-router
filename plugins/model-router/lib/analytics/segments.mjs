/**
 * The ten segment dimensions.
 *
 * TWO CAPS WITH TWO DIFFERENT MEANINGS, both surfaced on the dimension rather than applied
 * quietly. A LIVE cap bounds how many keys are tracked during the pass, because `model` and
 * `session` are unbounded in principle and a store with 40,000 sessions would otherwise build
 * 40,000 accumulators. A FINALIZE cap keeps the top N and folds the tail into an `other` bucket.
 *
 * THE TAIL IS FOLDED BY MERGING STATES, NOT VALUES. `aggMerge` unions two unfinalized
 * accumulators and `aggFinalize` then recomputes coverage from the exact counts of the union, so
 * the `other` bucket's coverage is a real coverage of a real row set. Adding finalized values
 * would be `addAgg()`, which deliberately does not exist, and the `other` bucket is exactly where
 * that mistake would hide: a plausible number over an undefined population.
 *
 * THE NULL KEY STAYS `NULL_KEY`, NOT THE STRING `'unknown'`. `worker_context_source` has a literal
 * `'unknown'` member, so the conventional mapping would merge "we never resolved a context window"
 * with "the provider told us it does not know" — two different facts with two different fixes.
 * The human word lives in `label`, and consumers disambiguate on `keyKind` rather than on the key
 * string, so a model genuinely named `__other__` is still reported as itself.
 *
 * ORDERING IS A TOTAL ORDER — row count descending, then key ascending — so two reads of the same
 * store produce the same array and the reproducibility diff in CI means something.
 */

import { extractors } from '../telemetry/aggregate.mjs'
import { aggFinalize, aggInit, aggMerge, aggPush } from './aggregates.mjs'
import { classifyRow, predicates } from './predicates.mjs'
import {
  DEFAULT_LIMITS,
  NULL_BUCKET_KEY,
  OTHER_KEY,
  PROFILE_SEPARATOR,
  OVERFLOW_KEY,
  SEGMENT_DIMENSIONS,
  SEGMENT_METRICS,
} from './schema.mjs'
import { enumerateDays, enumerateWeeks, isoWeekKey, rowInstantMs, utcDayKey } from './window.mjs'

/** The five aggregates each bucket carries. */
const BUCKET_EXTRACTORS = Object.freeze({
  workerTokens: extractors.workerTokens,
  tokensAvoided: extractors.estimatedTokensAvoided,
  workerCost: extractors.workerTotalCost,
  costAvoided: extractors.estimatedCostAvoided,
  netSavings: extractors.estimatedNetSavings,
})

/** The per-bucket counters. Enough to compute a delegation rate and a failure rate per bucket. */
const BUCKET_COUNTERS = Object.freeze([
  'events',
  'dispatchAttempted',
  'delegationOk',
  'workerFailure',
  'governanceDenied',
  'capabilityRefusal',
  'knownCost',
  'unknownCost',
  'negativeTokens',
  'negativeDollars',
])

/**
 * The key function for each dimension.
 *
 * `date` is the only dimension that derives its key rather than reading a column, and it is the
 * only one allowed to invent keys — a day on which nothing happened still needs a bucket, or a
 * series would draw a line straight through it.
 */
export function dimensionKeyFns({ granularity = 'day' } = {}) {
  const out = {}
  for (const dim of SEGMENT_DIMENSIONS) {
    if (dim.id === 'date') {
      out.date = (row) => {
        const ms = rowInstantMs(row)
        if (ms === null) return null
        return granularity === 'week' ? isoWeekKey(ms) : utcDayKey(ms)
      }
    } else if (dim.id === 'workerProfile') {
      // A composite key, so the delegation-value view has one row per combination rather than
      // forcing a reader to cross two tables by eye. Each component falls back to `unknown`
      // INSIDE the key rather than nulling the whole key, because a row with a known provider
      // and an unresolved model is still worth seeing under that provider.
      out.workerProfile = (row) => {
        if (row?.provider === null && row?.model === null && row?.task_type === null) return null
        return [row?.provider ?? 'unknown', row?.model ?? 'unknown', row?.task_type ?? 'unknown'].join(
          PROFILE_SEPARATOR,
        )
      }
    } else {
      out[dim.id] = (row) => row?.[dim.field] ?? null
    }
  }
  return out
}

function newBucket(dimensionId, key) {
  const aggs = {}
  for (const name of Object.keys(BUCKET_EXTRACTORS)) {
    aggs[name] = aggInit(`${dimensionId}.${name}`)
  }
  const counters = {}
  for (const name of BUCKET_COUNTERS) counters[name] = 0
  return { key, aggs, counters }
}

export function createSegmentState({ limits = DEFAULT_LIMITS, granularity = 'day' } = {}) {
  const dims = new Map()
  for (const dim of SEGMENT_DIMENSIONS) {
    dims.set(dim.id, {
      id: dim.id,
      field: dim.field,
      buckets: new Map(),
      overflow: newBucket(dim.id, OVERFLOW_KEY),
      overflowKeys: new Set(),
      overflowKeysExact: true,
      truncated: false,
    })
  }
  return { limits, granularity, dims, keyFns: dimensionKeyFns({ granularity }) }
}

export function pushSegments(state, row) {
  if (classifyRow(row) === 'schemaIncompatible') return state

  for (const [id, dim] of state.dims) {
    const raw = state.keyFns[id](row)
    // `groupBy()` folds '' into the null key, and this matches it exactly so a consumer running
    // its own grouping produces keys identical to the engine's.
    const key = raw === null || raw === undefined || raw === '' ? NULL_BUCKET_KEY : String(raw)

    let bucket = dim.buckets.get(key)
    if (bucket === undefined) {
      // `date` is exempt from the live cap: it is bounded by the window instead.
      const capped = id !== 'date' && dim.buckets.size >= state.limits.maxTrackedKeys
      if (capped) {
        dim.truncated = true
        if (dim.overflowKeys.size < state.limits.maxOverflowKeyNames) dim.overflowKeys.add(key)
        else dim.overflowKeysExact = false
        bucket = dim.overflow
      } else {
        bucket = newBucket(id, key)
        dim.buckets.set(key, bucket)
      }
    }
    pushBucket(bucket, row)
  }
  return state
}

function pushBucket(bucket, row) {
  bucket.counters.events += 1
  if (predicates.dispatchAttempted(row)) bucket.counters.dispatchAttempted += 1
  if (predicates.delegationOk(row)) bucket.counters.delegationOk += 1
  if (predicates.workerFailure(row)) bucket.counters.workerFailure += 1
  if (predicates.governanceDenied(row)) bucket.counters.governanceDenied += 1
  if (predicates.capabilityRefusal(row)) bucket.counters.capabilityRefusal += 1
  if (predicates.knownCost(row)) bucket.counters.knownCost += 1
  if (predicates.unknownCost(row)) bucket.counters.unknownCost += 1
  if (predicates.negativeTokens(row)) bucket.counters.negativeTokens += 1
  if (predicates.negativeDollars(row)) bucket.counters.negativeDollars += 1

  // Every aggregate in a bucket is scoped to the dispatched rows, because every column they read
  // is null on a gate row by construction. The bucket's `events` counter keeps the full count.
  if (!predicates.dispatchAttempted(row)) return bucket
  for (const [name, extract] of Object.entries(BUCKET_EXTRACTORS)) {
    aggPush(bucket.aggs[name], row, extract)
  }
  return bucket
}

/* ------------------------------------------------------------------ finalize */

/**
 * `{key, count}` ordering, used for both the top-N selection and the emitted array.
 *
 * A total order, so ties cannot reorder between two runs. Count descending puts the buckets worth
 * looking at first; key ascending breaks every tie deterministically.
 */
const byCountThenKey = (a, b) =>
  b.counters.events - a.counters.events || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export function finalizeSegments(state, { timeRange, formatBucket }) {
  const out = {}
  const truncatedDimensions = []

  for (const [id, dim] of state.dims) {
    const tracked = [...dim.buckets.values()]

    let kept
    let tail = []
    if (id === 'date') {
      // The date dimension is never top-N'd: dropping the quietest days from a time series would
      // leave a chart that interpolates across them. It is bounded by the window instead.
      kept = tracked.sort((a, b) => (a.key < b.key ? -1 : 1))
    } else {
      const sorted = tracked.sort(byCountThenKey)
      kept = sorted.slice(0, state.limits.topN)
      tail = sorted.slice(state.limits.topN)
    }

    const buckets = kept.map((b) => formatBucket(id, b, keyKindOf(b.key)))

    // The tail, folded by merging STATES so the `other` bucket's coverage is exact.
    if (tail.length > 0) {
      const merged = newBucket(id, OTHER_KEY)
      for (const b of tail) {
        for (const name of Object.keys(BUCKET_EXTRACTORS)) {
          merged.aggs[name] = aggMerge(merged.aggs[name], b.aggs[name])
        }
        for (const name of BUCKET_COUNTERS) merged.counters[name] += b.counters[name]
      }
      buckets.push({
        ...formatBucket(id, merged, 'other'),
        label: `other (${tail.length} key${tail.length === 1 ? '' : 's'} below the top ${state.limits.topN})`,
        foldedKeys: tail.length,
      })
    }

    if (dim.truncated) {
      truncatedDimensions.push(id)
      buckets.push({
        ...formatBucket(id, dim.overflow, 'overflow'),
        label: `overflow (dimension exceeded ${state.limits.maxTrackedKeys} tracked keys)`,
        distinctKeysSeen: dim.overflowKeys.size,
        distinctKeysExact: dim.overflowKeysExact,
      })
    }

    out[id] = {
      id,
      field: dim.field,
      distinctKeys: dim.buckets.size,
      truncated: dim.truncated,
      topN: id === 'date' ? null : state.limits.topN,
      foldedIntoOther: tail.length,
      buckets,
    }
  }

  // THE AXIS IS THE COMPLETE DAY LIST; the buckets only cover days that had rows. The split is
  // deliberate: the engine does not fabricate empty buckets, but a renderer that iterated the
  // buckets alone could not tell a quiet Sunday from a Sunday outside the window, and would draw
  // a line straight through it. Iterating the axis and looking each key up gives a renderer the
  // zero where there was a zero and the gap where there was a gap.
  const axis =
    state.granularity === 'week' ? enumerateWeeks(timeRange) : enumerateDays(timeRange, state.limits.maxDayBuckets)
  out.date.axis = axis
  out.date.granularity = state.granularity

  return { segments: out, truncatedDimensions }
}

/** Which kind of key a bucket key is. Consumers branch on this, never on the string. */
function keyKindOf(key) {
  if (key === NULL_BUCKET_KEY) return 'null'
  return 'value'
}

/** The names a consumer renders for each key kind. */
export function labelFor(key, keyKind) {
  if (keyKind === 'null') return 'unknown'
  if (keyKind === 'other') return 'other'
  if (keyKind === 'overflow') return 'overflow'
  return key
}

/**
 * Build the bucket formatter. Kept as a factory so `metrics.mjs` and `segments.mjs` do not both
 * need to know how an Agg is serialized.
 */
export function makeBucketFormatter({ serializeBucketAgg }) {
  return function formatBucket(dimensionId, bucket, keyKind) {
    const metrics = {}
    for (const name of Object.keys(SEGMENT_METRICS)) {
      metrics[name] = serializeBucketAgg(name, aggFinalize(bucket.aggs[name]))
    }
    const c = bucket.counters
    return {
      key: bucket.key,
      keyKind,
      label: labelFor(bucket.key, keyKind),
      events: c.events,
      dispatchAttempted: c.dispatchAttempted,
      delegationOk: c.delegationOk,
      workerFailures: c.workerFailure,
      governanceDenials: c.governanceDenied,
      capabilityRefusals: c.capabilityRefusal,
      knownCostEvents: c.knownCost,
      unknownCostEvents: c.unknownCost,
      negativeTokenEvents: c.negativeTokens,
      negativeDollarEvents: c.negativeDollars,
      // Null rather than zero when there is nothing to divide. A rate of 0% over no events is a
      // different statement from a rate of 0% over four hundred.
      delegationRate: c.events === 0 ? null : c.dispatchAttempted / c.events,
      failureRate: c.dispatchAttempted === 0 ? null : c.workerFailure / c.dispatchAttempted,
      costCoverage: c.dispatchAttempted === 0 ? null : c.knownCost / c.dispatchAttempted,
      metrics,
    }
  }
}
