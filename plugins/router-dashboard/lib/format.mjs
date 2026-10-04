/**
 * How a number becomes text in the report.
 *
 * IT NEVER READS `.value` ON AN AGGREGATE. Every figure here comes from the `display` string the
 * engine already produced with `formatAgg()` — the one sanctioned way an aggregate reaches a
 * screen, which takes the whole aggregate so a caller cannot bypass the coverage information that
 * makes the number honest. This plugin cannot import that formatter, so re-implementing it here
 * would mean two copies of the function the project has an explicit rule about, each passing its
 * own tests while drifting from the other. The string travels instead.
 *
 * COVERAGE IS COMPOSED FROM INTEGERS, NEVER FROM A ROUNDED PERCENTAGE. One row in two hundred
 * and fifty is 0.4%, and `Math.round(0.4)` is 0 — which reads as "nothing was measured" when
 * something was. So the integers lead and the percentage, when shown at all, follows them.
 *
 * UNKNOWN HAS FOUR SPELLINGS and they are not interchangeable: `NULL` for an absent scalar, the
 * engine's own `unavailable (N events, none measured)` for an aggregate, `UNKNOWN` in a sentence
 * where a reader might otherwise see zero, and `none configured` for something an operator has
 * not set.
 */

/** NULL, never 0. The distinction this whole project exists to preserve. */
export function fmt(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL'
    return Number.isInteger(value) ? String(value) : value.toFixed(4)
  }
  return String(value)
}

/** A whole-number count with thousands separators, for a figure a human reads at a glance. */
export function count(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'NULL'
  return Math.round(value).toLocaleString('en-US')
}

/** A percentage, or NULL. Never a rounded zero standing in for an unknown. */
export function percent(ratio, places = 1) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 'NULL'
  return `${(ratio * 100).toFixed(places)}%`
}

/** Milliseconds, or NULL. A missing duration is not a fast one. */
export function ms(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'NULL'
  return `${Math.round(value).toLocaleString('en-US')} ms`
}

/**
 * The text of any metric node the engine produces.
 *
 * Aggregates and rates already carry a `display`. Counts are exact. An `unavailable` metric is
 * one the telemetry cannot answer at all, and it says so rather than rendering a dash, because a
 * dash in a cost column is read as zero by everyone who is in a hurry.
 */
export function metricText(node) {
  if (!node) return 'NULL'
  if (node.metricKind === 'unavailable') return 'not measured'
  if (node.metricKind === 'agg' || node.metricKind === 'rate') return node.display
  if (node.metricKind === 'count') return count(node.value)
  if (node.metricKind === 'series') return ms(node.median)
  return fmt(node.value)
}

/** The one-line reason an `unavailable` metric cannot be answered. */
export function unavailableReason(node) {
  if (!node || node.metricKind !== 'unavailable') return null
  return node.detail ?? node.reason ?? null
}

/**
 * Coverage as integers, with the percentage second.
 *
 * Returns null when there is nothing to cover, so a caller renders "no events" rather than "0 of
 * 0 events (NULL)".
 */
export function coverageText(coverage) {
  if (!coverage || coverage.totalEvents === 0) return null
  return `${count(coverage.knownEvents)} of ${count(coverage.totalEvents)} events · ${percent(coverage.ratio)}`
}

/** How confident a figure is, as one short word a card can carry as a badge. */
export function basisWord(node) {
  if (!node) return 'unknown'
  if (node.metricKind === 'unavailable') return 'unknown'
  if (node.metricKind === 'count') return 'measured'
  if (node.metricKind === 'rate') return node.value === null ? 'unknown' : 'measured'
  if (node.status === 'empty') return 'none'
  if (node.status === 'unavailable') return 'unknown'
  if (node.basis === 'actual') return 'measured'
  if (node.basis === 'estimated') return 'estimated'
  if (node.basis === 'mixed') return 'mixed'
  return 'unknown'
}

/**
 * Whether a figure is a floor rather than a total.
 *
 * A partial sum of a non-negative column really is "at least $X". For net savings, signed by
 * construction, a partial sum bounds nothing in either direction — and without this distinction a
 * partial net figure would read as a floor when it is not.
 */
export function isLowerBound(node) {
  return node?.metricKind === 'agg' && node.status === 'partial' && node.bound === 'lower'
}

/** The human word for a bucket key, since a sentinel is not a label. */
export function keyLabel(bucket) {
  if (!bucket) return 'unknown'
  if (bucket.label) return bucket.label
  return bucket.key
}

/** Pluralise a noun against a count, so a card never says "1 events". */
export function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many
}
