/**
 * Aggregation for the benchmark, and the comparison that refuses to overstate itself.
 *
 * NOT ONE TOKEN OR DOLLAR IS COMPUTED HERE. `aggregate()` sums stored columns and never reprices;
 * `estimated_tokens_avoided` is already the context net, computed once per row by
 * `calculateTokenDelta`. The only thing this file adds is a way to make QUALITY aggregatable, and
 * a derivation of whether the primary-versus-worker comparison is complete.
 *
 * TWO RULES INHERITED FROM THE READ SIDE, both of which it would be easy to break here:
 *
 *   1. AGGREGATES ARE NEVER ADDED TO EACH OTHER. `aggregate.mjs` exports no `addAgg()` by design;
 *      combination happens per row, inside an extractor, with strict null propagation. So there is
 *      no threshold-to-threshold delta in this framework: two thresholds have different coverage
 *      sets, and subtracting their sums produces a number about neither.
 *   2. `?? 0` AND `|| 0` APPEAR NOWHERE DOWNSTREAM OF AN AGG. Printing `agg.value` directly throws
 *      on null (`.toFixed` of null), and the reflex fix is `?? 0`, which renders "we do not know"
 *      as "zero". `formatAgg` takes the whole Agg precisely so that cannot happen, and
 *      `evals.isolation.test.mjs` greps for both spellings.
 */

import { NULL_KEY, aggregate, extractors, formatAgg, summarize } from '../../plugins/model-router/lib/telemetry/aggregate.mjs'

export { NULL_KEY, aggregate, extractors, formatAgg, summarize }

/* --------------------------------------------------------------------- quality */

/**
 * Quality as an aggregatable column, without inventing a schema field.
 *
 * A `{row, verdict}` wrapper would break `aggregate()`, which reads `row.schema_version` at the top
 * level, and adding `eval_quality` to the event would break `projectRecord`/`serializeRecord` for
 * anyone who ever ran an eval row through the real serializer. So the verdicts arrive in a closure
 * keyed on `task_id`, which already holds the case id.
 *
 *   1    the criterion ran and passed
 *   0    it ran and FAILED — a true zero, the same shape as calc.mjs's structural zeros: the
 *        "capability flag" here is "a verdict exists"
 *   null no verdict, which is NOT a failure. A worker crash is an availability fact, and grading it
 *        as a quality failure conflates two different things that need two different fixes.
 *
 * @param {Map<string,'pass'|'fail'>} verdicts  keyed by `task_id`
 */
export function qualityExtractor(verdicts) {
  return (row) => {
    const v = verdicts.get(row?.task_id)
    if (v !== 'pass' && v !== 'fail') return { value: null, status: 'unavailable' }
    return { value: v === 'pass' ? 1 : 0, status: 'actual' }
  }
}

/**
 * A pass rate that cannot read as better than it is.
 *
 * `0/0` is `null`, never `0` and never `NaN`. The denominator is GRADED, not total, and `total`
 * travels alongside so the reader sees how much of the corpus was never asked. Rendered as
 * `passed/graded of total`, never as a bare percentage — a single number is how a seventeen-case
 * corpus with five answers reports "100% quality".
 */
export function passRate(agg) {
  if (agg.rowsCounted === 0) {
    return { value: null, status: 'unavailable', passed: null, graded: 0, total: agg.rowsTotal }
  }
  return {
    value: agg.value / agg.rowsCounted,
    status: 'actual',
    passed: agg.value,
    graded: agg.rowsCounted,
    total: agg.rowsTotal,
  }
}

export function formatPassRate(rate) {
  if (rate.value === null) return `unavailable, 0 of ${rate.total} graded`
  const pct = (rate.value * 100).toFixed(0)
  return `${rate.passed}/${rate.graded} passed (${pct}%), ${rate.total - rate.graded} of ${rate.total} ungraded`
}

/* ---------------------------------------------------------------- distributions */

export function countBy(rows, keyFn) {
  const out = new Map()
  for (const row of rows) {
    const key = keyFn(row) ?? NULL_KEY
    // A counter genuinely starts at zero — "no occurrences yet" is a true zero, not a missing
    // measurement — but it is spelled out rather than written `?? 0` so it cannot be mistaken for
    // the substitution this framework forbids, and so the isolation grep stays absolute.
    if (!out.has(key)) out.set(key, 0)
    out.set(key, out.get(key) + 1)
  }
  return new Map([...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

export function statusCounts(rows) {
  const out = { ok: 0, error: 0, skipped: 0, other: 0 }
  for (const row of rows) {
    const s = row?.status
    if (s === 'ok' || s === 'error' || s === 'skipped') out[s] += 1
    else out.other += 1
  }
  return out
}

/* ------------------------------------------------------------- the comparison */

/**
 * Why a primary-versus-worker comparison is not complete. A closed list, so a reader can tell
 * "we have not built the thing yet" from "this run happened to lack data".
 */
export const COMPARISON_BLOCKERS = Object.freeze([
  'primary_usage_unmeasured',
  'worker_rates_unpriced',
  'rows_unavailable',
  'quality_ungraded',
])

/**
 * The primary arm, honestly.
 *
 * For tokens and money there is nothing to measure. `primary_usage_status` is `actual` only when
 * `primaryUsage !== null && primaryUsageMethod === 'transcript_measured'`, and no transcript reader
 * exists — `docs/savings-methodology.md` already commits to `primary_*_cost` being `unavailable`
 * today. Running a second model over the corpus and filing its usage under `primary_*` would be a
 * lie: those columns mean the real session's spend, and a reader summing both would double-count.
 * A proxy model is a THIRD ARM with its own rows.
 *
 * What IS real on this side is kept in `observed`, in a namespace that cannot be read as savings.
 * A latency delta printed beside a token delta is how someone eventually writes "40% faster and
 * 60% cheaper" out of one table.
 */
export function buildPrimaryArm({ rows, latency = null }) {
  const bytes = rows.reduce((sum, r) => sum + (typeof r.input_bytes === 'number' ? r.input_bytes : 0), 0)
  const bytesKnown = rows.filter((r) => typeof r.input_bytes === 'number').length
  return {
    measured: false,
    method: 'none',
    blockers: ['no_transcript_reader'],
    tokens: null,
    cost: null,
    observed: {
      corpusBytes: bytesKnown === 0 ? null : bytes,
      rowsWithBytes: bytesKnown,
      gateRefusalsByReason: Object.fromEntries(
        countBy(
          rows.filter((r) => r.status === 'skipped'),
          (r) => r.routing_reason,
        ),
      ),
      pathOverheadMs: latency?.primary_path_overhead ?? null,
    },
  }
}

/**
 * Is the comparison complete? DERIVED, never passed in — one place decides what the word means,
 * the way `buildResult` derives `ok` from `status`.
 *
 * Structurally `false` today, and it flips only when two real things land: a transcript reader for
 * the primary side, and a priced table for the worker side.
 */
export function isComparisonComplete({ primaryArm, aggs }) {
  if (primaryArm?.measured !== true) return false
  const monetary = [aggs.workerTotalCost, aggs.estimatedCostAvoided, aggs.estimatedNetSavings]
  return monetary.every((a) => a?.status === 'complete')
}

export function blockersFor({ primaryArm, aggs, quality }) {
  const out = []
  if (primaryArm?.measured !== true) out.push('primary_usage_unmeasured')

  // Two different problems that a single "not complete" check would conflate, and whose fixes are
  // different: `worker_rates_unpriced` means NO row priced, so the pricing table needs a rate;
  // partial coverage means some rows priced and some did not apply, which is `rows_unavailable`.
  // Reporting an unpriced blocker against a fully priced table sends the reader to the wrong file.
  if (aggs.workerTotalCost?.rowsCounted === 0) out.push('worker_rates_unpriced')
  if (
    aggs.estimatedTokensAvoided?.rowsUnavailable > 0 ||
    (aggs.workerTotalCost?.rowsCounted > 0 && aggs.workerTotalCost?.status !== 'complete')
  ) {
    out.push('rows_unavailable')
  }
  if (quality?.graded !== quality?.total) out.push('quality_ungraded')
  return out
}

/**
 * Assemble the comparison.
 *
 * `ratio` is ALWAYS null while `comparisonComplete` is false, and the renderer refuses to print one
 * at all. A ratio is the most dangerous derived number in the framework: unlike every field in the
 * telemetry schema, it has no `*_status` companion to carry its own caveat, so a reader who sees it
 * has no way to know it was computed over partial data.
 */
export function buildComparison({ rows, verdicts, latency = null }) {
  const aggs = summarize(rows)
  const qualityAgg = aggregate(rows, qualityExtractor(verdicts))
  const quality = passRate(qualityAgg)
  const primaryArm = buildPrimaryArm({ rows, latency })

  const workerArm = {
    measured: true,
    ...statusCounts(rows),
    tokensAvoided: aggs.estimatedTokensAvoided,
    workerTokens: aggs.workerTokens,
    cost: aggs.workerTotalCost,
  }

  const comparisonComplete = isComparisonComplete({ primaryArm, aggs })

  return {
    comparisonComplete,
    comparisonBlockers: blockersFor({ primaryArm, aggs, quality }),
    ratio: null,
    primaryArm,
    workerArm,
    aggs,
    quality,
    byRoutingReason: Object.fromEntries(countBy(rows, (r) => r.routing_reason)),
    byTaskType: Object.fromEntries(countBy(rows, (r) => r.task_type)),
    statusCounts: statusCounts(rows),
    negativeSavingsCases: rows
      .filter((r) => typeof r.estimated_tokens_avoided === 'number' && r.estimated_tokens_avoided < 0)
      .map((r) => ({ id: r.task_id, netTokens: r.estimated_tokens_avoided })),
  }
}
