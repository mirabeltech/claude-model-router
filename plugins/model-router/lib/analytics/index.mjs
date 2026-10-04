/**
 * The analytics engine: one pass over a telemetry window, one self-describing response.
 *
 * `lib/analytics/` answers one question — **what did delegation actually do, over a window you
 * choose?** — and it is a different question from the three around it. The telemetry layer answers
 * *what happened on one call*. Governance answers *what we were allowed to spend*. The evaluation
 * framework answers *whether routing decides well on a fixed corpus*. Analytics answers none of
 * those: it reads rows that already exist and groups them.
 *
 * IT COMPUTES NO MONEY. Cost was computed once at write time and stamped with its
 * `pricing_version` and `calc_version`; re-pricing a historical row against today's table would
 * produce a figure for a bill that was never incurred. So this layer imports no pricing module,
 * names no per-million divisor, and sums stored money through the one shipped aggregator.
 *
 * IT WRITES NOTHING — not a segment, not a lock, not the store directory. That is not merely a
 * promise: `openStoreFromConfig()` performs no I/O of its own, `listSegments()` treats a missing
 * directory as an empty store, and this module never calls `buildIdentity()`, which is the only
 * writer anywhere in the read path. A reporting tool that created a directory in order to tell you
 * it was empty would quietly falsify the thing it was reporting on.
 *
 * NO `node:` IMPORT ANYWHERE IN THIS LAYER. `openStoreFromConfig` defaults its own `fs`, so the
 * whole engine is a pure function of a row stream and is unit-testable from an array.
 *
 * ONE PASS, AND THE REASON IS NOT SPEED. The response holds roughly sixty aggregates plus ten
 * dimensions of buckets. Calling `aggregate()` once per (metric, bucket) would mean materializing
 * every row in the window first — hundreds of megabytes at 100,000 rows — and walking it dozens of
 * times. Each row is pushed once into every slot it belongs to instead, through the same fold
 * `aggregate()` itself uses.
 */

import { CALC_VERSION, ROUTER_VERSION, SCHEMA_VERSION } from '../telemetry/record.mjs'
import { KNOWN_SCHEMA_VERSIONS, NULL_KEY } from '../telemetry/aggregate.mjs'
import { openStoreFromConfig } from '../telemetry/index.mjs'
import {
  ANALYTICS_CONTRACT_VERSION,
  DEFAULT_LIMITS,
  MIN_TREND_POINTS,
  SECTIONS,
  SEGMENT_METRICS,
} from './schema.mjs'
import { buildSelector, describeScope, emptyVerdictCounts } from './select.mjs'
import { createMetricState, finalizeMetrics, pushMetrics } from './metrics.mjs'
import { createSegmentState, finalizeSegments, makeBucketFormatter, pushSegments } from './segments.mjs'
import { createQualityState, finalizeQuality, mapReadReport, pushQuality } from './quality.mjs'
import { assertNoForbiddenFields, serializeAgg } from './serialize.mjs'
import { resolveWindow, segmentPrefilter } from './window.mjs'

export { ANALYTICS_CONTRACT_VERSION } from './schema.mjs'
export { stringifyResponse, jsonReplacer } from './serialize.mjs'

/**
 * Analyze a window of a telemetry store.
 *
 * @param {object}   opts
 * @param {object}   opts.config        a resolved config, for the store directory and the
 *                                      `recordGateDecisions` evidence
 * @param {object}   [opts.store]       an already-open store; injected by tests
 * @param {object}   [opts.fs]          injected filesystem, passed through to the store
 * @param {number}   opts.now           the clock, in ms. REQUIRED — see resolveWindow
 * @param {object}   [opts.window]      `{kind, start, end}`
 * @param {object}   [opts.scope]       `{provider, model, mode, ...}`
 * @param {object}   [opts.limits]      cardinality and sample caps
 */
export async function analyze({
  config = null,
  store = null,
  fs = undefined,
  now,
  window: windowRequest = { kind: '7d' },
  scope = {},
  limits = DEFAULT_LIMITS,
} = {}) {
  const timeRange = resolveWindow(windowRequest, now)
  const described = describeScope(scope)
  const state = createState({ timeRange, limits })

  const handle = store ?? (await openStoreFromConfig(config, fs ? { fs } : undefined))
  try {
    if (timeRange.valid && !timeRange.empty) {
      const select = buildSelector({ timeRange, scope: described })
      for await (const row of handle.read(segmentPrefilter(timeRange))) {
        ingest(state, row, select)
      }
    }
    return buildResponse(state, {
      read: mapReadReport(handle.report()),
      timeRange,
      scope: described,
      config,
      limits,
      now,
      windowRequest,
    })
  } finally {
    // Always, even on a throw: a reporting tool must not leave a descriptor open on the store it
    // was only reading.
    await handle.close()
  }
}

/**
 * The same analysis over an in-memory array. The engine's unit-test entry point, and the reason
 * every file in this layer is pure.
 *
 * It takes rows that are already in the window when `window` is omitted, so a test can pass four
 * rows without having to date them into a range.
 */
export function analyzeRows(
  rows,
  { now, window: windowRequest = { kind: 'all' }, scope = {}, config = null, limits = DEFAULT_LIMITS, read = null } = {},
) {
  const timeRange = resolveWindow(windowRequest, now)
  const described = describeScope(scope)
  const state = createState({ timeRange, limits })
  const select = buildSelector({ timeRange, scope: described })

  if (timeRange.valid && !timeRange.empty) {
    for (const row of Array.isArray(rows) ? rows : []) ingest(state, row, select)
  }

  return buildResponse(state, {
    read:
      read ??
      mapReadReport({
        files: 0,
        bytes: 0,
        lines: Array.isArray(rows) ? rows.length : 0,
        yielded: Array.isArray(rows) ? rows.length : 0,
        skipped: {},
        errors: [],
        samples: [],
      }),
    timeRange,
    scope: described,
    config,
    limits,
    now,
    windowRequest,
  })
}

function createState({ timeRange, limits }) {
  // A window longer than the day-bucket cap switches the date dimension to weeks rather than
  // silently dropping the oldest days from the series.
  const dayBucketsExceeded = timeRange.valid && timeRange.days > limits.maxDayBuckets
  return {
    limits,
    dayBucketsExceeded,
    verdicts: emptyVerdictCounts(),
    rowsYielded: 0,
    rowsIncompatible: 0,
    metrics: createMetricState({ limits }),
    segments: createSegmentState({ limits, granularity: dayBucketsExceeded ? 'week' : 'day' }),
    quality: createQualityState(),
  }
}

/** One row, once, into every accumulator that wants it. */
function ingest(state, row, select) {
  state.rowsYielded += 1
  const verdict = select(row)
  state.verdicts[verdict] += 1
  if (verdict !== 'in') return

  if (!KNOWN_SCHEMA_VERSIONS.has(row?.schema_version)) state.rowsIncompatible += 1

  pushQuality(state.quality, row)
  pushMetrics(state.metrics, row)
  pushSegments(state.segments, row)
}

/* ------------------------------------------------------------- the response */

function buildResponse(state, { read, timeRange, scope, config, limits, now, windowRequest }) {
  const rowsInWindow = state.verdicts.in
  const coverage = {
    rowsYielded: state.rowsYielded,
    rowsInWindow,
    rowsIncompatible: state.rowsIncompatible,
    rowsOutOfWindow: state.verdicts.out_of_window,
    rowsOutOfScope: state.verdicts.out_of_scope,
    // NOT the same as out of window. A row with an unparseable timestamp has not been excluded
    // by the range, it has failed to say when it happened, and merging the two would make a
    // broken clock look like a quiet afternoon.
    rowsUndatable: state.verdicts.undatable,
    rowsCountable: rowsInWindow - state.rowsIncompatible,
  }

  const bucketFormatter = makeBucketFormatter({
    serializeBucketAgg: (name, agg) =>
      serializeAgg(
        agg,
        // Bucket aggregates borrow the declared unit of the headline they mirror, so a segment
        // can never disagree with the summary about whether a column is money or tokens.
        BUCKET_UNIT_PATHS[name],
        'dispatchAttempted',
        { windowEmpty: !timeRange.valid || timeRange.empty, compact: true },
      ),
  })

  const { segments, truncatedDimensions } = finalizeSegments(state.segments, {
    timeRange,
    formatBucket: bucketFormatter,
  })

  const latencyTruncated =
    state.metrics.latency.total.truncated ||
    state.metrics.latency.provider.truncated ||
    state.metrics.latency.dispatchOverhead.truncated

  const quality = finalizeQuality(state.quality, {
    read,
    timeRange,
    coverage,
    config,
    limits: {
      dayBucketsExceeded: state.dayBucketsExceeded,
      segmentsTruncated: truncatedDimensions.length > 0,
      truncatedDimensions,
      latencyTruncated,
    },
  })

  const sections = finalizeMetrics(state.metrics, {
    timeRange,
    gateDecisionsRecorded: quality.gateDecisionsRecorded,
  })

  const response = {
    analytics_contract_version: ANALYTICS_CONTRACT_VERSION,

    engine: {
      routerVersion: ROUTER_VERSION,
      buildSchemaVersion: SCHEMA_VERSION,
      buildCalcVersion: CALC_VERSION,
      knownSchemaVersions: [...KNOWN_SCHEMA_VERSIONS].sort(),
      contractVersion: ANALYTICS_CONTRACT_VERSION,
      nullKey: NULL_KEY,
      minTrendPoints: MIN_TREND_POINTS,
    },

    request: {
      window: {
        kind: windowRequest?.kind ?? '7d',
        start: windowRequest?.start ?? null,
        end: windowRequest?.end ?? null,
      },
      // What was asked for, and what is actually tested, side by side. `--mode` resolves onto
      // `task_type` because there is no `mode` column, and nobody should have to guess that.
      scope: scope.requested,
      resolvedFilters: scope.filters,
      scopeWarnings: scope.warnings,
      generatedAt: new Date(now).toISOString(),
      limits: {
        topN: limits.topN,
        maxTrackedKeys: limits.maxTrackedKeys,
        maxLatencySamples: limits.maxLatencySamples,
        maxNegativeExamples: limits.maxNegativeExamples,
        maxDayBuckets: limits.maxDayBuckets,
      },
    },

    timeRange: {
      kind: timeRange.kind,
      valid: timeRange.valid,
      reason: timeRange.reason,
      start: timeRange.start,
      end: timeRange.end,
      timeZone: timeRange.timeZone,
      boundaries: timeRange.boundaries,
      days: timeRange.days,
      empty: timeRange.empty,
      future: timeRange.future,
      incompletePeriod: timeRange.incompletePeriod,
      segmentsExamined: read.segmentsRead,
    },

    ...sections,

    segments,
    coverage: {
      ...coverage,
      reconciliation:
        'rowsCountable = rowsInWindow - rowsIncompatible, and every aggregate rowsTotal is the size of its own named population rather than of the window. The two families reconcile through the population names, not by subtraction.',
    },
    dataQuality: quality,
  }

  // The response is assembled from an allowlist, so a content field can only arrive through a
  // mistake in this layer. The walk costs nothing and the alternative is publishing a prompt.
  assertNoForbiddenFields(response)
  return response
}

/** Which headline each bucket metric borrows its declared unit from. */
const BUCKET_UNIT_PATHS = Object.freeze({
  workerTokens: 'summary.workerTokens',
  tokensAvoided: 'summary.tokensAvoided',
  workerCost: 'summary.workerCost',
  costAvoided: 'savings.costAvoided',
  netSavings: 'summary.netSavings',
})

/** The section list, re-exported so a contract test can assert the response has exactly these. */
export { SECTIONS, SEGMENT_METRICS }
