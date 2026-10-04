/**
 * How a number leaves this layer, and the last gate on what may leave with it.
 *
 * THE ENGINE RENDERS THE STRING. `formatAgg()` is documented in `telemetry/aggregate.mjs` as the
 * only sanctioned way an aggregate reaches a screen — it takes the whole Agg rather than `.value`
 * precisely so a caller cannot bypass the coverage information that makes the number honest. The
 * dashboard is a separate plugin and may not import it. The choice is therefore between shipping
 * the string and letting the dashboard re-implement the formatter, and a second copy of that one
 * function would reintroduce exactly the failure the rule exists to prevent: an `unavailable`
 * aggregate rendered as `$0.0000`. So every aggregate travels with `display` already formatted,
 * and a contract test asserts the string equals `formatAgg` of the same aggregate.
 *
 * THE UNIT COMES FROM A TABLE, NOT A CALL SITE. `DISPLAY_UNITS` is keyed by response path, and a
 * census test walks the finished response and fails on any aggregate whose path is absent. A new
 * headline therefore cannot ship unlabelled, and a USD column cannot ship formatted as tokens.
 *
 * `assertNoForbiddenFields()` is a belt over braces. The response is built from an allowlist, so
 * a content field should never be in it; this walks the finished object anyway, because the cost
 * of the walk is nothing and the cost of being wrong is publishing a developer's prompt.
 */

import { formatAgg } from '../telemetry/aggregate.mjs'
import { nullReasonFor } from './aggregates.mjs'
import { DISPLAY_UNITS, FORBIDDEN_FIELDS, POPULATIONS } from './schema.mjs'

/**
 * Serialize an Agg for the response.
 *
 * @param {object} agg          a finalized Agg
 * @param {string} path         its dotted path in the response; the key into DISPLAY_UNITS
 * @param {string} population   the named population `rowsTotal` was counted over
 */
export function serializeAgg(agg, path, population, { windowEmpty = false, compact = false } = {}) {
  const declared = DISPLAY_UNITS[path]
  // A missing unit is a programming error, not a data condition, and it must be loud: a
  // silently-defaulted unit is how a dollar figure ends up labelled as tokens. The census test
  // catches it before a release; this catches it in development.
  if (declared === undefined) throw new Error(`serializeAgg: no declared unit for ${path}`)
  if (POPULATIONS[population] === undefined) {
    throw new Error(`serializeAgg: ${path} names an undeclared population ${population}`)
  }

  const display = formatAgg(agg, { unit: declared.unit, places: declared.places })

  if (compact) {
    // The compact projection used inside segment buckets. It drops the version sets and the
    // actual/estimated row split, which a bucket does not need, but it KEEPS every field
    // `formatAgg()` reads — including `rowsUnavailable` and `rowsIncompatible`, which look
    // droppable and are not. Without them the display string cannot be recomputed from the node,
    // so neither the contract test nor the dashboard could verify that the string it is about to
    // print matches the number beside it, and a bucket could quietly claim complete coverage.
    return {
      metricKind: 'agg',
      value: agg.value,
      rowsTotal: agg.rowsTotal,
      rowsCounted: agg.rowsCounted,
      rowsUnavailable: agg.rowsUnavailable,
      rowsIncompatible: agg.rowsIncompatible,
      coverage: agg.coverage,
      status: agg.status,
      basis: agg.basis,
      bound: agg.bound,
      unit: declared.unit,
      places: declared.places,
      population,
      display,
    }
  }

  return {
    metricKind: 'agg',
    // The whole Agg, verbatim. The dashboard needs `coverage`, `basis`, `bound` and
    // `homogeneous` to render honestly; dropping any of them would push the honesty logic across
    // the plugin boundary into a second package.
    value: agg.value,
    rowsTotal: agg.rowsTotal,
    rowsCounted: agg.rowsCounted,
    rowsUnavailable: agg.rowsUnavailable,
    rowsIncompatible: agg.rowsIncompatible,
    coverage: agg.coverage,
    status: agg.status,
    rowsActual: agg.rowsActual,
    rowsEstimated: agg.rowsEstimated,
    rowsUnknownStatus: agg.rowsUnknownStatus,
    basis: agg.basis,
    bound: agg.bound,
    pricingVersions: agg.pricingVersions,
    calcVersions: agg.calcVersions,
    homogeneous: agg.homogeneous,
    unit: declared.unit,
    places: declared.places,
    // WITHOUT THIS, `coverage: 0.31` IS UNINTERPRETABLE. Savings columns are null on every
    // gate_block row by construction, so a savings aggregate over a whole window reports
    // `partial` as a permanent structural artefact rather than as a measurement gap. The
    // population name is what turns the coverage figure back into information.
    population,
    display,
    nullReason: nullReasonFor(agg, { windowEmpty }),
  }
}

/**
 * Serialize a ratio of two counts.
 *
 * NOT an Agg, and the distinction is not cosmetic: a quotient of counts has no measurement
 * status, so giving it one would let a `basis: 'actual'` appear on a number that is neither
 * measured nor estimated. `value` is null when the denominator is zero OR when it is known to be
 * incomplete — a rate computed against a denominator that is missing rows is worse than no rate,
 * because it looks like a finding.
 */
export function serializeRate(
  numerator,
  denominator,
  { population, denominatorComplete = true, caveat = null, places = 1 } = {},
) {
  if (POPULATIONS[population] === undefined) {
    throw new Error(`serializeRate: undeclared population ${population}`)
  }
  const computable = denominator > 0 && denominatorComplete
  const value = computable ? numerator / denominator : null
  return {
    metricKind: 'rate',
    value,
    numerator,
    denominator,
    denominatorComplete,
    population,
    caveat,
    unit: 'ratio',
    display: value === null
      ? denominator === 0
        ? 'no events'
        : `unavailable (${caveat ?? 'denominator incomplete'})`
      : `${(value * 100).toFixed(places)}% (${numerator} of ${denominator})`,
  }
}

/**
 * Serialize an exact count.
 *
 * A count is never null. Counts have no coverage problem — a row either matched the predicate or
 * it did not — only a schema gate, which is applied before counting.
 */
export function serializeCount(value, population, { label = null } = {}) {
  if (POPULATIONS[population] === undefined) {
    throw new Error(`serializeCount: undeclared population ${population}`)
  }
  return {
    metricKind: 'count',
    value,
    population,
    unit: 'count',
    display: label === null ? String(value) : `${value} ${label}`,
  }
}

/**
 * Serialize a metric the phase asks for that this telemetry cannot answer.
 *
 * It is a FIRST-CLASS SHAPE rather than an omission, because a missing key and a key that says
 * "there is no field for this" lead a reader to different conclusions. `reason` is
 * machine-readable so a dashboard can print the explanation instead of a dash.
 */
export function serializeUnavailable(reason, detail) {
  return { metricKind: 'unavailable', value: null, reason, detail }
}

/* ------------------------------------------------------------------ the scrub */

/**
 * Walk a finished response and collect any path whose KEY names a forbidden telemetry column.
 *
 * It checks keys rather than values on purpose: a value match would be a content scan, which
 * would mean reading the content in order to decide not to publish it, and would false-positive
 * on any legitimate string. The response is assembled from an allowlist, so a forbidden key can
 * only arrive by a mistake in this layer — which is what this is for.
 */
export function findForbiddenFields(value, path = '', out = []) {
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((v, i) => findForbiddenFields(v, `${path}[${i}]`, out))
    return out
  }
  for (const [key, v] of Object.entries(value)) {
    const here = path === '' ? key : `${path}.${key}`
    if (FORBIDDEN_FIELDS.includes(key)) out.push(here)
    findForbiddenFields(v, here, out)
  }
  return out
}

/** Throw if the response carries a forbidden column. Called once, on the finished object. */
export function assertNoForbiddenFields(response) {
  const found = findForbiddenFields(response)
  if (found.length > 0) {
    throw new Error(`analytics response carries forbidden field(s): ${found.join(', ')}`)
  }
  return response
}

/**
 * Every `metricKind: 'agg'` node in a response, with its path.
 *
 * Used by the contract census to prove each one has a declared unit and a declared population,
 * and by the dashboard tests to prove the renderer never reads `.value`.
 */
export function findAggNodes(value, path = '', out = []) {
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((v, i) => findAggNodes(v, `${path}[${i}]`, out))
    return out
  }
  if (value.metricKind === 'agg') out.push({ path, node: value })
  for (const [key, v] of Object.entries(value)) {
    findAggNodes(v, path === '' ? key : `${path}.${key}`, out)
  }
  return out
}

/**
 * The JSON replacer every serialization of a response must use.
 *
 * Copied from `test/evals/bin/run.mjs`, where the reason is the same: `JSON.stringify` DROPS keys
 * whose value is `undefined`, and ABSENT IS NOT NULL in this schema. A response that lost a key
 * on the way to a file would tell the dashboard a section does not exist rather than that a
 * measurement is missing. Maps become plain objects for the same reason — a Map stringifies to
 * `{}` and would silently empty a segment table.
 */
export function jsonReplacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value)
  return value === undefined ? null : value
}

/** Serialize a response to the exact bytes both CLIs emit. */
export function stringifyResponse(response) {
  return `${JSON.stringify(response, jsonReplacer, 2)}\n`
}
