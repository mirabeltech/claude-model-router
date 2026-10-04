/**
 * Query and aggregation primitives over stored events. PURE: no filesystem, no network.
 * This module must never gain a `node:` import — a test enforces that statically.
 *
 * IT SUMS STORED MONEY AND NEVER RECOMPUTES IT. Cost was computed once at write time and stamped
 * with its `pricing_version` and `calc_version`; re-pricing a historical row against today's
 * table would produce a number for a bill that was never incurred. This module therefore imports
 * nothing from calc.mjs, and a test asserts that.
 *
 * THE HARD PROBLEM THIS SOLVES: summing a column where some rows are NULL. Treating NULL as 0
 * silently understates worker cost or overstates savings depending on the column, and either way
 * presents partial coverage as complete. So a sum is never a bare number here — it is an Agg that
 * carries its own coverage, and the formatter takes the whole Agg rather than `.value`.
 */

import { SCHEMA_VERSION, bucket } from './record.mjs'

/** Rows whose schema this build understands. A newer row is counted, not silently included. */
export const KNOWN_SCHEMA_VERSIONS = Object.freeze(new Set([SCHEMA_VERSION]))

/** Null group keys get their own bucket: dropping them would shrink the denominator. */
export const NULL_KEY = '__null__'

/**
 * @typedef {Object} Agg
 * @property {number|null} value        Sum over contributing rows; NULL when nothing contributed.
 * @property {number} rowsTotal
 * @property {number} rowsCounted       Rows that contributed to `value`.
 * @property {number} rowsUnavailable
 * @property {number} rowsIncompatible  Excluded for an unreadable schema_version.
 * @property {number} coverage          rowsCounted / rowsTotal, 0..1.
 * @property {'complete'|'partial'|'unavailable'|'empty'} status
 * @property {number} rowsActual
 * @property {number} rowsEstimated
 * @property {number} rowsUnknownStatus
 * @property {'actual'|'estimated'|'mixed'|'unavailable'} basis
 * @property {'lower'|'none'} bound
 * @property {string[]} pricingVersions
 * @property {number[]} calcVersions
 * @property {boolean} homogeneous
 */

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Null-strict sum. Deliberately duplicated rather than imported from calc.mjs — see the header. */
function sumStrict(values) {
  let total = 0
  for (const v of values) {
    const n = finite(v)
    if (n === null) return null
    total += n
  }
  return total
}

/* --------------------------------------------------------------- the fold */

/**
 * The accumulator behind `aggregate()`, exposed as three functions so a streaming consumer can
 * reuse the coverage model instead of reimplementing it.
 *
 * WHY THIS IS SPLIT OUT. `aggregate()` takes an array, and the analytics layer needs ~60 of these
 * plus a few thousand more inside its segment buckets. Calling `aggregate()` once per
 * (metric, group) is a walk per metric over a materialized array of every row in the window, which
 * at 100k rows is hundreds of megabytes of live objects and tens of millions of extractor calls
 * before any aggregation starts. Pushing each row once into every slot is the same arithmetic in
 * one pass.
 *
 * It is a PURE REFACTOR, and that matters more than the speed: a second implementation of the
 * coverage model is a second place for the NULL-is-not-zero rule to be got wrong, and the two
 * would drift silently because each would have its own tests. There is one implementation, and
 * `aggregate()` is now defined in terms of it — so the batch path and the streaming path cannot
 * disagree about what `partial` means.
 *
 * The state is a MONOID, which is what makes `aggMerge` legitimate: every field is a sum, a count,
 * a boolean OR or a set union, and every derived figure — `coverage`, `status`, `basis`, `bound`,
 * `homogeneous` and the value-versus-null rule — is computed in the finalizer from that state
 * rather than carried along in it.
 */
export function aggInit(extractorKey = 'anonymous') {
  return {
    extractorKey,
    rowsTotal: 0,
    rowsCounted: 0,
    rowsIncompatible: 0,
    rowsActual: 0,
    rowsEstimated: 0,
    rowsUnknownStatus: 0,
    total: 0,
    anyNegative: false,
    pricingVersions: new Set(),
    calcVersions: new Set(),
  }
}

/** Push one row through one extractor. Mutates and returns `state`. */
export function aggPush(state, row, extract) {
  state.rowsTotal += 1

  if (!KNOWN_SCHEMA_VERSIONS.has(row?.schema_version)) {
    state.rowsIncompatible += 1
    return state
  }

  const got = extract(row) ?? { value: null, status: 'unavailable' }
  const v = finite(got.value)
  if (v === null) return state

  state.rowsCounted += 1
  state.total += v
  if (v < 0) state.anyNegative = true

  if (got.status === 'actual') state.rowsActual += 1
  else if (got.status === 'estimated') state.rowsEstimated += 1
  // An unrecognized status still CONTRIBUTES — enums are open on read — but it is counted so
  // the basis degrades to `mixed` rather than silently claiming to be actual or estimated.
  else state.rowsUnknownStatus += 1

  if (typeof row.pricing_version === 'string') state.pricingVersions.add(row.pricing_version)
  if (typeof row.calc_version === 'number') state.calcVersions.add(row.calc_version)
  return state
}

/**
 * Combine two UNFINALIZED states over DISJOINT row sets. Returns a new state; neither input is
 * mutated.
 *
 * THIS IS NOT `addAgg()`, which deliberately does not exist (see `extractors` below). That
 * prohibition is about adding two FINALIZED values whose coverage differs, which yields a number
 * computed over an undefined row set. This adds neither values nor coverage: it unions two row
 * sets that do not overlap, and `aggFinalize` then recomputes every derived figure from the exact
 * counts of the union. The one sanctioned use is folding a segment dimension's long tail into an
 * `other` bucket, where the buckets partition the window by construction.
 *
 * Disjointness is the caller's to guarantee and cannot be checked here. The extractor key can be,
 * and is: merging two states built from different columns would produce a sum of unlike things.
 *
 * ONE MEASURED CAVEAT, and it is not a defect in the coverage model. Every COUNT this produces is
 * exact — `rowsTotal`, `rowsCounted`, `coverage`, `status`, `basis`, `bound` and the version sets
 * are bit-identical to aggregating the same rows in one pass. The float `value` can differ in its
 * last bit, because IEEE-754 addition is not associative: summing a partition group-by-group
 * reaches the same total by a different route. MEASURED: 0.012318034292198722 one way,
 * 0.01231803429219872 the other — a relative difference of ~2e-16 on a column of USD.
 *
 * That property already belongs to `aggregate()` and is not introduced here: the same rows in a
 * different order already give a different last bit. It is also NOT a determinism problem for a
 * reader, which is the distinction that matters — the segment list is sorted and each file is read
 * front to back, so the same store always produces the same bytes. Deterministic is not the same
 * claim as order-independent, and only the first one is load-bearing.
 */
export function aggMerge(a, b) {
  if (a.extractorKey !== b.extractorKey) {
    throw new Error(`aggMerge: ${a.extractorKey} != ${b.extractorKey}`)
  }
  return {
    extractorKey: a.extractorKey,
    rowsTotal: a.rowsTotal + b.rowsTotal,
    rowsCounted: a.rowsCounted + b.rowsCounted,
    rowsIncompatible: a.rowsIncompatible + b.rowsIncompatible,
    rowsActual: a.rowsActual + b.rowsActual,
    rowsEstimated: a.rowsEstimated + b.rowsEstimated,
    rowsUnknownStatus: a.rowsUnknownStatus + b.rowsUnknownStatus,
    total: a.total + b.total,
    anyNegative: a.anyNegative || b.anyNegative,
    pricingVersions: new Set([...a.pricingVersions, ...b.pricingVersions]),
    calcVersions: new Set([...a.calcVersions, ...b.calcVersions]),
  }
}

/** Turn an accumulated state into an {@link Agg}. */
export function aggFinalize(state) {
  const {
    rowsTotal,
    rowsCounted,
    rowsIncompatible,
    rowsActual,
    rowsEstimated,
    rowsUnknownStatus,
    total,
    anyNegative,
    pricingVersions,
    calcVersions,
  } = state
  const rowsUnavailable = rowsTotal - rowsCounted - rowsIncompatible

  let status
  if (rowsTotal === 0) status = 'empty'
  else if (rowsCounted === 0) status = 'unavailable'
  else if (rowsCounted === rowsTotal) status = 'complete'
  else status = 'partial'

  let basis
  if (rowsCounted === 0) basis = 'unavailable'
  else if (rowsUnknownStatus > 0) basis = 'mixed'
  else if (rowsActual === rowsCounted) basis = 'actual'
  else if (rowsEstimated === rowsCounted) basis = 'estimated'
  else basis = 'mixed'

  const versions = [...pricingVersions].sort()
  const calcs = [...calcVersions].sort((a, b) => a - b)

  return {
    // NULL when nothing contributed — never 0. "Saved nothing" and "we do not know" must not
    // render identically; that is the aggregation-level restatement of the no-overstating rule.
    value: rowsCounted === 0 ? null : total,
    rowsTotal,
    rowsCounted,
    rowsUnavailable,
    rowsIncompatible,
    coverage: rowsTotal === 0 ? 0 : rowsCounted / rowsTotal,
    status,
    rowsActual,
    rowsEstimated,
    rowsUnknownStatus,
    basis,
    // The honesty bit. For a same-signed column a partial sum is a genuine lower bound ("at
    // least $X"). For estimated_net_savings, signed by construction, a partial sum bounds
    // nothing — and without this flag a partial net figure would read as a floor when it is not.
    bound: anyNegative ? 'none' : 'lower',
    pricingVersions: versions,
    calcVersions: calcs,
    // Each row was priced correctly against the table in force when it was written, so summing
    // across versions is a real sum of real dollars. But a mid-window rate change explains a
    // discontinuity that otherwise looks like a behaviour change, so it is never silent.
    homogeneous: versions.length <= 1 && calcs.length <= 1,
  }
}

/**
 * Aggregate one column over an array of rows.
 *
 * @param {Array<object>} rows
 * @param {(row: object) => {value: number|null, status: string}} extract
 * @returns {Agg}
 */
export function aggregate(rows, extract) {
  const state = aggInit()
  for (const row of Array.isArray(rows) ? rows : []) aggPush(state, row, extract)
  return aggFinalize(state)
}

/**
 * Per-row extractors. These answer the required headline figures.
 *
 * `addAgg()` deliberately DOES NOT EXIST — two Aggs can have different row coverage, so adding
 * their values yields a number computed over an undefined row set. All combination happens at the
 * ROW level, inside an extractor, with strict null propagation.
 */
export const extractors = Object.freeze({
  /**
   * Total worker tokens, strict: a row missing ANY component contributes NOTHING rather than a
   * partial. `rowsUnavailable` is where that shows up.
   */
  workerTokens: (r) => ({
    value: sumStrict([
      r.worker_input_tokens,
      r.worker_cached_input_tokens,
      r.worker_output_tokens,
      r.worker_thought_tokens,
    ]),
    status: 'actual',
  }),

  /**
   * The provider's own total, verbatim. Reported as a SECOND column beside workerTokens and never
   * reconciled with it: where both are complete and they disagree, that is a provider-parser bug,
   * and `worker_token_sum_check: 'mismatch'` on the offending rows locates it.
   */
  workerTokensReported: (r) => ({ value: r.worker_total_tokens, status: 'actual' }),

  estimatedTokensAvoided: (r) => ({
    value: r.estimated_tokens_avoided,
    status: r.estimated_tokens_avoided_status,
  }),
  estimatedCostAvoided: (r) => ({ value: r.estimated_cost_avoided, status: r.estimated_cost_avoided_status }),
  workerTotalCost: (r) => ({ value: r.worker_total_cost, status: r.worker_total_cost_status }),
  estimatedNetSavings: (r) => ({ value: r.estimated_net_savings, status: r.estimated_net_savings_status }),
})

/* ------------------------------------------------------------------ grouping */

export function groupBy(rows, keyFn) {
  const out = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = keyFn(row)
    const k = key === null || key === undefined || key === '' ? NULL_KEY : String(key)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}

export function aggregateGrouped(rows, keyFn, extract) {
  const out = new Map()
  for (const [key, list] of groupBy(rows, keyFn)) out.set(key, aggregate(list, extract))
  return out
}

/**
 * Bucket a row by calendar day.
 *
 * DEFAULTS TO UTC, and the choice is stamped on the result. It must never silently use the
 * machine timezone: two developers reading the same log would disagree about which day a
 * delegation fell in, and "savings yesterday" would be unreproducible. A local grouping is
 * available but must be asked for explicitly.
 */
export function byDate(row, { timeZone = 'UTC' } = {}) {
  const ts = row?.timestamp
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return null
  if (timeZone === 'UTC') return new Date(ms).toISOString().slice(0, 10)
  try {
    // Intl is stdlib, so this stays zero-dependency. en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/** Bucket by the writer's own local day, recovered from the stamped offset. */
export function byWriterLocalDate(row) {
  const ts = row?.timestamp
  const off = row?.tz_offset_minutes
  if (typeof ts !== 'string' || typeof off !== 'number') return null
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms)) return null
  return new Date(ms + off * 60_000).toISOString().slice(0, 10)
}

export const byProject = (row) => row?.project_id ?? null
export const byProvider = (row) => row?.provider ?? null
export const byModel = (row) => row?.model ?? null

/** Raw value, so an unknown task_type keeps its own group rather than being merged away. */
export const byTaskType = (row) => row?.task_type ?? null

/** The `other` roll-up half of the open-enum convention. */
export const byTaskTypeBucketed = (row, known) => bucket(row?.task_type, known).bucket

/* ----------------------------------------------------------------- selection */

/** Filter helpers. Each takes the raw rows and returns a new array; none mutates. */
export function eventsByDate(rows, { from = null, to = null, timeZone = 'UTC' } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const d = byDate(r, { timeZone })
    if (d === null) return false
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  })
}

const whereEquals = (field) => (rows, value) =>
  (Array.isArray(rows) ? rows : []).filter((r) => (r?.[field] ?? null) === value)

export const eventsByProject = whereEquals('project_id')
export const eventsByProvider = whereEquals('provider')
export const eventsByModel = whereEquals('model')
export const eventsByTaskType = whereEquals('task_type')

/* ----------------------------------------------------------------- formatting */

/**
 * The ONLY sanctioned way an aggregate reaches a screen.
 *
 * It takes the whole Agg, never `.value`, because a caller that reads `.value` and prints it has
 * bypassed the coverage information that makes the number honest. In particular an `unavailable`
 * Agg must never render as "$0.00".
 */
export function formatAgg(agg, { unit = 'USD', places = 4 } = {}) {
  if (!agg || agg.status === 'empty') return 'no events'
  if (agg.status === 'unavailable') {
    return `unavailable (${agg.rowsTotal} event${agg.rowsTotal === 1 ? '' : 's'}, none measured)`
  }

  const n = unit === 'USD' ? `$${agg.value.toFixed(places)}` : `${Math.round(agg.value)} ${unit}`
  if (agg.status === 'complete') return n

  const qualifier = agg.bound === 'lower' ? 'at least ' : ''
  const missing = agg.rowsUnavailable > 0 ? `, ${agg.rowsUnavailable} unmeasured` : ''
  const incompatible = agg.rowsIncompatible > 0 ? `, ${agg.rowsIncompatible} unreadable` : ''
  return `${qualifier}${n} over ${agg.rowsCounted} of ${agg.rowsTotal} events${missing}${incompatible}`
}

/**
 * The five required headline totals, computed in one pass each and returned together so a caller
 * cannot accidentally mix coverage from different row sets.
 */
export function summarize(rows) {
  return {
    workerTokens: aggregate(rows, extractors.workerTokens),
    workerTokensReported: aggregate(rows, extractors.workerTokensReported),
    estimatedTokensAvoided: aggregate(rows, extractors.estimatedTokensAvoided),
    estimatedCostAvoided: aggregate(rows, extractors.estimatedCostAvoided),
    workerTotalCost: aggregate(rows, extractors.workerTotalCost),
    estimatedNetSavings: aggregate(rows, extractors.estimatedNetSavings),
  }
}
