/**
 * The terminal rendering of an analytics response.
 *
 * It RETURNS A STRING and prints nothing, following `test/evals/report.mjs`: a renderer that
 * logs cannot be asserted on without capturing stdout, and the CLI that owns the process is the
 * right place to decide where bytes go.
 *
 * IT READS NO `.value` ON AN AGGREGATE. Every number here comes from the `display` string the
 * engine already produced with `formatAgg()`, which is the only sanctioned way an aggregate
 * reaches a screen — it takes the whole Agg so a caller cannot bypass the coverage that makes the
 * number honest. Formatting a raw value would also crash on null, and the reflex fix for that
 * crash is the `?? 0` this project exists to forbid.
 *
 * UNKNOWN HAS FOUR DELIBERATE SPELLINGS and they are not interchangeable:
 *
 *   `NULL`                                  a single absent scalar
 *   `unavailable (N events, none measured)`  an aggregate nothing contributed to
 *   `UNKNOWN` plus "Unknown is not zero."    where a reader might otherwise read zero
 *   `none configured`                        an operator has not set a value
 *
 * The third is the one that matters most, and it is why this file prints a sentence rather than a
 * dash: a dash in a cost column is read as zero by everyone who is in a hurry.
 */

import { MIN_TREND_POINTS } from './schema.mjs'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

const RULE = '-'.repeat(68)
const BAR = '='.repeat(68)

/** NULL, never 0. The distinction this whole project exists to preserve. */
export function fmt(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4)
  return String(v)
}

/** A USD amount at a fixed width, or NULL. Fixed places so a column of money aligns. */
export function money(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(4)}` : 'NULL'
}

/**
 * The human word for a histogram key.
 *
 * Histogram buckets carry only `{key, count}`, so the sentinel has to be translated here. The
 * engine keeps `__null__` on the wire rather than the word "unknown" because at least one enum
 * has a literal `unknown` member, and the two must not merge.
 */
export function keyLabel(key) {
  if (key === '__null__') return 'unknown'
  if (key === '__other__') return 'other'
  if (key === '__overflow__') return 'overflow'
  return key
}

/** A percentage, or NULL. Never a rounded zero standing in for an unknown. */
export function pct(ratio, places = 1) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 'NULL'
  return `${(ratio * 100).toFixed(places)}%`
}

/**
 * Coverage as integers first and a percentage second.
 *
 * One row in 250 is 0.4%, and a rounded 0% reads as "nothing was measured" when something was.
 * The integers cannot mislead that way, so they lead.
 */
export function coverageText(coverage) {
  if (!coverage || coverage.totalEvents === 0) return 'no events'
  return `${coverage.knownEvents} of ${coverage.totalEvents} events (${pct(coverage.ratio)})`
}

/** A metric node of any kind, as one short string. */
function metric(node) {
  if (!node) return 'NULL'
  if (node.metricKind === 'unavailable') return `unavailable ${DIM}(${node.reason})${OFF}`
  if (node.metricKind === 'agg' || node.metricKind === 'rate') return node.display
  if (node.metricKind === 'count') return String(node.value)
  return fmt(node.value)
}

export function renderText(response, { color = true, verbose = false } = {}) {
  const c = (code, s) => (color ? `${code}${s}${OFF}` : String(s))
  const plain = (s) => (color ? s : s.replace(/\x1b\[[0-9;]*m/g, ''))
  const out = []
  const line = (s = '') => out.push(plain(s))
  const section = (title) => {
    line('')
    line(title)
    line(RULE)
  }
  const kv = (label, value, note = '') =>
    line(`  ${label.padEnd(26)}${value}${note ? `  ${c(DIM, note)}` : ''}`)

  const r = response

  /* ---- header ---- */
  line(BAR)
  line('model-router analytics')
  line(BAR)
  if (!r.timeRange.valid) {
    line('')
    line(`  ${c(RED, 'invalid time range')}  ${c(DIM, r.timeRange.reason)}`)
    line('')
    return out.join('\n')
  }
  kv('window', `${r.timeRange.kind}  ${r.timeRange.start} .. ${r.timeRange.end}`)
  kv('boundaries', `${r.timeRange.timeZone}, half-open [start, end)`)
  kv('segments examined', String(r.timeRange.segmentsExamined))
  if (r.request.resolvedFilters && Object.keys(r.request.resolvedFilters).length > 0) {
    kv(
      'filters',
      Object.entries(r.request.resolvedFilters)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
    )
  }
  for (const w of r.request.scopeWarnings ?? []) {
    line(`  ${c(YELLOW, 'WARN')}  ${w.scope} ${JSON.stringify(w.value)}: ${w.reason}`)
  }

  /* ---- overview ---- */
  section('Overview')
  kv('routing events', metric(r.summary.events))
  kv('delegated', metric(r.summary.delegations))
  kv('refused', metric(r.summary.refusals))
  kv('delegation rate', metric(r.summary.delegationRate))
  kv('tokens avoided', metric(r.summary.tokensAvoided))
  kv('worker tokens', metric(r.summary.workerTokens), 'consumption, not savings')
  kv('worker cost', metric(r.summary.workerCost))
  kv('cost coverage', coverageText(r.summary.costCoverage))
  kv('estimated net savings', metric(r.summary.netSavings))
  kv('median worker latency', `${fmt(r.latency.total.median)} ms`)

  // Only when there is something whose cost we could have known. On an empty window every line
  // already says "no events", and an explanation of unpriced rates would be answering a question
  // nobody asked.
  if (r.summary.headlineAvailable === 'tokens_only' && r.summary.events.value > 0) {
    line('')
    line(`  ${c(YELLOW, 'worker cost is UNKNOWN for this window')}`)
    line(`  ${c(DIM, 'Unknown is not zero. No rate in the bundled pricing table is populated, so a')}`)
    line(`  ${c(DIM, 'default install reports no dollar figure at all. Set pricing.overrides to price')}`)
    line(`  ${c(DIM, 'these calls; until then the token figures are the measurable ones.')}`)
  }

  /* ---- routing ---- */
  section('Routing')
  kv('delegation rate', metric(r.routing.delegationRate))
  kv('refusal rate', metric(r.routing.refusalRate))
  kv('success rate', metric(r.routing.successRate), 'of dispatched calls')
  line('')
  line(`  ${c(DIM, 'by outcome')}`)
  for (const [klass, count] of Object.entries(r.routing.byClass)) {
    if (count === 0 && !verbose) continue
    kv(`  ${klass}`, String(count))
  }
  if (r.routing.counts.approvedNotDispatched.value > 0) {
    line('')
    line(`  ${c(YELLOW, 'approved but never dispatched')}  ${c(DIM, 'cause not recorded — see docs/analytics.md')}`)
  }
  line('')
  line(`  ${c(DIM, 'top routing reasons')}`)
  for (const b of r.routing.byReason.buckets.slice(0, 8)) {
    kv(`  ${keyLabel(b.key)}`, String(b.count))
  }

  /* ---- worker performance, at the provider/model/mode grain ---- */
  section('Worker performance')
  line(
    `  ${'provider'.padEnd(9)}${'model'.padEnd(23)}${'mode'.padEnd(11)}${'calls'.padStart(6)}${'tokens'.padStart(11)}${'fails'.padStart(6)}${'refused'.padStart(8)}${'cost cov'.padStart(9)}`,
  )
  // Dispatched profiles only. A gate_block profile has no worker call to report on, so a row of
  // zeros under "worker performance" would be noise in the one table an operator scans to choose
  // a model. The omitted count is printed instead of being hidden.
  const profiles = r.segments.workerProfile.buckets.filter((b) => b.dispatchAttempted > 0)
  const omitted = r.segments.workerProfile.buckets.length - profiles.length
  for (const b of profiles) {
    const [provider, model, mode] =
      b.keyKind === 'value' ? b.key.split(' / ') : [b.label, '', '']
    line(
      `  ${String(provider).slice(0, 8).padEnd(9)}${String(model).slice(0, 22).padEnd(23)}${String(mode).slice(0, 10).padEnd(11)}` +
        `${String(b.dispatchAttempted).padStart(6)}${fmt(b.metrics.workerTokens.value).padStart(11)}` +
        `${String(b.workerFailures).padStart(6)}${String(b.capabilityRefusals + b.governanceDenials).padStart(8)}` +
        `${(b.costCoverage === null ? 'NULL' : pct(b.costCoverage, 0)).padStart(9)}`,
    )
  }
  if (profiles.length === 0) line(`  ${c(DIM, 'no worker call was dispatched in this window')}`)
  if (omitted > 0) {
    line(`  ${c(DIM, `${omitted} profile(s) with no dispatched call omitted.`)}`)
  }
  line(`  ${c(DIM, 'Every dimension is shown separately: there is deliberately no single value score.')}`)
  line('')
  line(`  ${''.padEnd(26)}${'median'.padStart(9)}${'p95'.padStart(9)}  ${c(DIM, 'latency is reported per window, not per profile')}`)
  line(`  ${'worker latency (ms)'.padEnd(26)}${fmt(r.latency.total.median).padStart(9)}${fmt(r.latency.total.p95).padStart(9)}`)

  /* ---- savings ---- */
  section('Savings')
  kv('corpus tokens', metric(r.savings.estimatedInputTokens))
  kv('answer tokens', metric(r.savings.returnedAnswerTokens))
  kv('tokens avoided (net)', metric(r.savings.tokensAvoided), 'corpus minus answer')
  kv('worker consumption', metric(r.savings.workerTokensConsumed), 'not a saving')
  kv('estimated cost avoided', metric(r.savings.costAvoided), 'at the primary input rate only')
  kv('estimated net savings', metric(r.savings.netSavings), 'avoided minus worker cost')
  line('')
  line(`  ${c(DIM, 'Estimated savings are not necessarily actual invoice savings.')}`)
  line(`  ${c(DIM, 'Methodology: docs/savings-methodology.md')}`)

  if (r.negativeSavings.dollars.events.value > 0 || r.negativeSavings.tokens.events.value > 0) {
    line('')
    line(`  ${c(DIM, 'negative outcomes')}`)
    kv('  negative tokens', `${r.negativeSavings.tokens.events.value} events, ${metric(r.negativeSavings.tokens.total)}`)
    kv('  negative dollars', `${r.negativeSavings.dollars.events.value} events, ${metric(r.negativeSavings.dollars.total)}`)
    line(`  ${c(DIM, 'A negative event is for investigation, not proof the policy is wrong.')}`)
  }

  /* ---- cost ---- */
  section('Cost')
  kv('worker input', metric(r.cost.workerInput))
  kv('worker output', metric(r.cost.workerOutput))
  kv('worker total', metric(r.cost.workerTotal))
  kv('coverage', coverageText(r.cost.coverage))
  kv('known cost events', metric(r.cost.knownCostEvents))
  kv('zero cost events', metric(r.cost.structurallyZeroEvents), 'configured rate of 0, measured')
  kv('unknown cost events', metric(r.cost.unknownCostEvents), 'not zero — unknown')
  kv('primary baseline', metric(r.cost.primaryBaseline))

  /* ---- latency ---- */
  section('Latency')
  line(`  ${''.padEnd(26)}${'median'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}${'n'.padStart(7)}`)
  for (const [label, s] of [
    ['total (end to end)', r.latency.total],
    ['provider round trip', r.latency.provider],
    ['dispatch overhead', r.latency.dispatchOverhead],
  ]) {
    line(
      `  ${label.padEnd(26)}${fmt(s.median).padStart(9)}${fmt(s.p95).padStart(9)}${fmt(s.max).padStart(9)}${String(s.n).padStart(7)}`,
    )
  }
  line(`  ${c(DIM, `nearest rank, no interpolation. ${r.latency.gateRowsExcluded} gate row(s) excluded.`)}`)
  if (r.latency.dispatchOverhead.excludedForRetry > 0) {
    line(
      `  ${c(DIM, `${r.latency.dispatchOverhead.excludedForRetry} retried call(s) excluded from overhead: the difference would include earlier attempts.`)}`,
    )
  }
  line('')
  line(`  ${c(DIM, 'not instrumented')}`)
  for (const [key, node] of Object.entries(r.latency.components)) {
    kv(`  ${key}`, `NULL  ${c(DIM, node.reason)}`)
  }

  /* ---- governance ---- */
  section('Governance')
  kv('consulted', metric(r.governance.consulted))
  kv('not consulted', metric(r.governance.notConsulted), 'governance never ran on these')
  kv('allowed', metric(r.governance.allowed))
  kv('denied', metric(r.governance.denied), 'a successful decision, not a failure')
  if (r.governance.byReason.buckets.length > 0) {
    line('')
    line(`  ${c(DIM, 'reasons')}`)
    for (const b of r.governance.byReason.buckets) kv(`  ${keyLabel(b.key)}`, String(b.count))
  }
  if (r.governance.budgetSnapshots.snapshots.length > 0) {
    line('')
    line(`  ${c(DIM, 'budget snapshots (latest observation per scope; never summed)')}`)
    for (const s of r.governance.budgetSnapshots.snapshots) {
      kv(
        `  ${s.scope}`,
        `limit ${money(s.limit)}  remaining ${money(s.remaining)}  used ${s.utilization === null ? 'NULL' : pct(s.utilization)}`,
      )
    }
  }

  /* ---- reliability ---- */
  section('Reliability')
  line(`  ${c(DIM, 'These are four different events and this report never adds them up.')}`)
  kv('worker failures', metric(r.failures.workerFailures), 'the provider was called')
  kv('governance denials', metric(r.failures.governanceDenials), 'not a failure')
  kv('context refusals', metric(r.failures.capabilityRefusals.total), 'not a provider fault')
  kv('  pre-flight', metric(r.failures.capabilityRefusals.preflight), 'never called, nothing spent')
  kv('  truncation discard', metric(r.failures.capabilityRefusals.truncationDiscarded), 'paid for, discarded')
  kv('unknown cost', metric(r.failures.unknownCost), 'not a failed request')
  kv('unknown usage', metric(r.failures.unknownUsage))
  kv('capability unknown', metric(r.failures.capabilityUnknown))
  kv('retried', metric(r.failures.retried))
  if (r.failures.byErrorCode.buckets.length > 0) {
    line('')
    line(`  ${c(DIM, 'error codes')}`)
    for (const b of r.failures.byErrorCode.buckets) kv(`  ${keyLabel(b.key)}`, String(b.count))
  }

  /* ---- trends ---- */
  section('Trends')
  const dateBuckets = new Map(r.segments.date.buckets.map((b) => [b.key, b]))
  const axis = r.segments.date.axis
  if (axis.length < MIN_TREND_POINTS) {
    line(`  ${c(DIM, `sample size too small to imply a trend (n = ${axis.length})`)}`)
  }
  line(`  ${'day'.padEnd(14)}${'events'.padStart(8)}${'delegated'.padStart(11)}${'avoided'.padStart(12)}${'worker tok'.padStart(12)}`)
  for (const day of axis) {
    const b = dateBuckets.get(day)
    if (!b) {
      // A day the window covered on which nothing was recorded. A real zero, printed as one —
      // omitting the row would let a reader join two distant points into a straight line.
      line(`  ${day.padEnd(14)}${'0'.padStart(8)}${'0'.padStart(11)}${'-'.padStart(12)}${'-'.padStart(12)}`)
      continue
    }
    line(
      `  ${day.padEnd(14)}${String(b.events).padStart(8)}${String(b.dispatchAttempted).padStart(11)}${fmt(b.metrics.tokensAvoided.value).padStart(12)}${fmt(b.metrics.workerTokens.value).padStart(12)}`,
    )
  }

  /* ---- data quality ---- */
  section('Data quality')
  const q = r.dataQuality
  kv('segments read', String(q.read.segmentsRead))
  kv('lines scanned', String(q.read.linesScanned))
  kv('records accepted', String(q.read.recordsAccepted))
  kv('records rejected', String(q.read.recordsRejected))
  if (q.read.recordsRejected > 0) {
    const reasons = Object.entries(q.read.rejectionReasons)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ')
    kv('  reasons', reasons)
  }
  kv('schema versions', Object.entries(q.schemaVersions).map(([v, n]) => `${v}:${n}`).join(' ') || 'none')
  kv('gate decisions recorded', q.gateDecisionsRecorded ? 'yes' : c(RED, 'NO'))
  kv('rows missing cost', String(q.rows.missingCost))
  kv('rows missing usage', String(q.rows.missingUsage))
  kv('rows missing latency', String(q.rows.missingLatency))

  if (q.conditions.length > 0) {
    line('')
    for (const cond of q.conditions) {
      const tag =
        cond.severity === 'error' ? c(RED, 'FAIL') : cond.severity === 'warn' ? c(YELLOW, 'WARN') : c(GREEN, 'NOTE')
      line(`  ${tag}  ${cond.id}`)
      line(`        ${c(DIM, cond.detail)}`)
    }
  }
  line('')
  line(`  ${c(DIM, q.note)}`)
  line('')
  line(BAR)
  return out.join('\n')
}
