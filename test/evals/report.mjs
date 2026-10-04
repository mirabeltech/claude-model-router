/**
 * The human-readable report.
 *
 * Follows `scripts/doctor.mjs`: raw ANSI constants, section rules at sixty-eight columns, and a
 * `fmt()` that renders null as the literal string NULL rather than as 0. The machine-readable JSON
 * is assembled separately, in `bin/run.mjs`, so a formatting decision here can never change a
 * recorded number.
 *
 * THREE THINGS THIS RENDERER REFUSES TO PRINT.
 *
 *   A ratio or a percentage comparing the arms, while `comparisonComplete` is false. Unlike every
 *   field in the telemetry schema, a ratio has no `*_status` companion to carry its own caveat, so
 *   a reader who sees one has no way to know it was computed over partial data.
 *
 *   A bare aggregate value. Every number goes through `formatAgg`, which takes the whole Agg and so
 *   prints coverage and basis alongside — `unavailable` renders as "unavailable", never "$0.00".
 *
 *   A rounded coverage percentage. `Math.round(0.004 * 100)` is 0, which reads as "nothing" when
 *   one row in two hundred and fifty did contribute. Coverage prints as "k of N".
 */

import { formatAgg } from '../../plugins/model-router/lib/telemetry/aggregate.mjs'
import { formatPassRate } from './metrics.mjs'
import { renderKnobSweep, renderSweep } from './sweep.mjs'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const OFF = '\u001b[0m'

const RULE = '-'.repeat(68)
const BAR = '='.repeat(68)

/** NULL, never 0. The distinction this whole project exists to preserve. */
export function fmt(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4)
  return String(v)
}

const pad = (s, n) => String(s).padEnd(n)

export function renderReport(report, { color = true } = {}) {
  const c = (code, s) => (color ? `${code}${s}${OFF}` : String(s))
  const out = []
  const line = (s = '') => out.push(s)
  const section = (title) => {
    line('')
    line(title)
    line(RULE)
  }

  /* ------------------------------------------------------------- provenance */
  const p = report.provenance
  section('Provenance')
  line(`  arm                 ${p.arm}${p.deterministic ? '' : c(YELLOW, '  (model-dependent)')}`)
  line(`  provider / model    ${fmt(p.provider)} / ${fmt(p.modelRequested)}`)
  line(`  corpus              ${p.corpusCases} cases, fingerprint ${p.corpusFingerprint.slice(0, 16)}…`)
  line(`  eval schema         ${p.evalSchemaVersion}`)
  line(`  policy / prompt     ${fmt(p.policyVersion)} / ${fmt(p.promptVersion)}`)
  line(`  record / calc       ${fmt(p.schemaVersion)} / ${fmt(p.calcVersion)}`)
  line(`  router version      ${fmt(p.routerVersion)}`)
  line(`  pricing             ${fmt(p.pricingVersion)} (${fmt(p.pricingSource)})`)
  line(`  run seed            ${p.runSeed}`)
  line(`  platform / node     ${p.platform}-${p.arch} / ${p.nodeVersion}`)
  line(`  started             ${p.startedAt}`)
  if (!p.deterministic) {
    line(c(YELLOW, '  Results below depend on a live model and are not reproducible.'))
  }

  /* ----------------------------------------------------------------- routing */
  const r = report.routing
  section('Routing')
  line('                        actual primary   actual delegate')
  line(`  expected primary      ${pad(r.cells.expectedPrimaryActualPrimary, 17)}${r.cells.expectedPrimaryActualDelegate}`)
  line(`  expected delegate     ${pad(r.cells.expectedDelegateActualPrimary, 17)}${r.cells.expectedDelegateActualDelegate}`)
  line('')
  line(c(DIM, '  Not an accuracy metric: the expected classes are declared by the corpus'))
  line(c(DIM, '  author, not measured, so a percentage would dress intent up as a property.'))
  line('')
  if (r.disagreements.length === 0) {
    line(c(GREEN, `  all ${r.cases.length} cases agreed with the engine`))
  } else {
    line(c(RED, `  ${r.disagreements.length} disagreement(s):`))
    for (const d of r.disagreements) {
      line(c(RED, `    ${d.id}`))
      for (const m of d.mismatches) line(`      ${m}`)
    }
  }
  line('')
  line('  per case:')
  for (const row of r.cases) {
    const mark = row.agrees ? c(GREEN, 'ok  ') : c(RED, 'FAIL')
    line(`    ${mark} ${pad(row.id, 34)} ${pad(row.actualClass, 10)} ${row.actualReason}`)
  }

  /* ----------------------------------------------------------------- quality */
  section('Quality')
  line(`  ${formatPassRate(report.quality.rate)}`)
  line('')
  line(c(DIM, '  Denominator is GRADED, not total. A case with no criteria, or no output, is'))
  line(c(DIM, '  ungraded — which is not the same as failed, and is never averaged in.'))
  if (report.quality.failures.length > 0) {
    line('')
    line(c(RED, `  ${report.quality.failures.length} graded failure(s):`))
    for (const f of report.quality.failures) {
      line(c(RED, `    ${f.id}: ${f.failed.join(', ')}`))
      for (const d of f.detail) line(`      ${d}`)
    }
  }

  /* ------------------------------------------------------- tokens and savings */
  const a = report.metrics.aggs
  section('Tokens and savings')
  line(`  tokens avoided (net)  ${formatAgg(a.estimatedTokensAvoided, { unit: 'tokens', places: 0 })}`)
  line(`  worker tokens         ${formatAgg(a.workerTokens, { unit: 'tokens', places: 0 })}`)
  line(`  worker cost           ${formatAgg(a.workerTotalCost)}`)
  line(`  cost avoided          ${formatAgg(a.estimatedCostAvoided)}`)
  line(`  net savings           ${formatAgg(a.estimatedNetSavings)}`)
  if (report.metrics.negativeSavingsCases.length > 0) {
    line('')
    line(c(YELLOW, `  ${report.metrics.negativeSavingsCases.length} case(s) with NEGATIVE net tokens:`))
    for (const n of report.metrics.negativeSavingsCases) {
      line(c(YELLOW, `    ${pad(n.id, 34)} ${n.netTokens} tokens`))
    }
    line(c(DIM, '  Stored, never clamped. A negative is the evidence a threshold is wrong.'))
  }

  /* ------------------------------------------------------------- comparison */
  section('Primary versus worker')
  line(`  comparisonComplete    ${report.metrics.comparisonComplete}`)
  line(`  blockers              ${report.metrics.comparisonBlockers.join(', ') || 'none'}`)
  line(`  ratio                 ${fmt(report.metrics.ratio)}`)
  line('')
  line(`  primary arm   measured=${report.metrics.primaryArm.measured}  method=${report.metrics.primaryArm.method}`)
  line(`                tokens=${fmt(report.metrics.primaryArm.tokens)}  cost=${fmt(report.metrics.primaryArm.cost)}`)
  line(`                corpus bytes it would have read: ${fmt(report.metrics.primaryArm.observed.corpusBytes)}`)
  line(`  worker arm    ok=${report.metrics.workerArm.ok} error=${report.metrics.workerArm.error} skipped=${report.metrics.workerArm.skipped}`)
  line('')
  line(c(DIM, '  No primary-model cost figure in this framework can be `actual` until a'))
  line(c(DIM, '  transcript reader lands. No ratio is printed while the comparison is'))
  line(c(DIM, '  incomplete, because a ratio carries no status field of its own.'))

  /* ---------------------------------------------------------------- latency */
  section('Latency')
  line(c(DIM, '  Seven series, measured separately and never summed: total_delegated_path'))
  line(c(DIM, '  contains worker, which contains provider. Machine-dependent.'))
  line('')
  line(`  ${pad('series', 24)}${pad('n', 5)}${pad('median', 11)}${pad('p95', 11)}max`)
  for (const [name, s] of Object.entries(report.latency)) {
    const ms = (v) => (v === null ? 'NULL' : `${v.toFixed(1)} ms`)
    line(`  ${pad(name, 24)}${pad(s.n, 5)}${pad(ms(s.median), 11)}${pad(ms(s.p95), 11)}${ms(s.max)}`)
  }

  /* ------------------------------------------------------------------ gates */
  section('Gates')
  // One line per GATE, not per gate-times-case: eighty-seven identical rows bury the three that
  // matter. Failures are always named individually, with their case, because the whole point of
  // this section is that no aggregate hides one.
  const byGate = new Map()
  for (const g of report.gates) {
    if (!byGate.has(g.gate)) byGate.set(g.gate, { pass: 0, fail: 0, not_applicable: 0, failures: [], detail: null })
    const e = byGate.get(g.gate)
    e[g.status] += 1
    if (g.status === 'fail') e.failures.push(g)
    if (g.status === 'pass' && e.detail === null) e.detail = g.detail
  }
  for (const [name, e] of byGate) {
    const mark = e.fail > 0 ? c(RED, 'FAIL') : e.pass > 0 ? c(GREEN, 'pass') : c(DIM, 'n/a ')
    const counts = `${e.pass} pass, ${e.fail} fail, ${e.not_applicable} n/a`
    line(`  ${mark} ${pad(name, 44)}${counts}`)
    for (const f of e.failures) {
      line(c(RED, `       ${f.caseId ?? '(run)'}: ${f.detail}`))
      if (f.evidence !== null) line(c(DIM, `         ${f.evidence}`))
    }
  }
  line('')
  line(c(DIM, '  n/a is a real third status: a gate with nothing to measure on a refusing case'))
  line(c(DIM, '  says so, rather than inflating the pass count.'))

  if (report.advisories.length > 0) {
    section('Advisories (never gate, never counted as a pass)')
    const flagged = report.advisories.filter((g) => g.status === 'fail')
    if (flagged.length === 0) {
      line(c(DIM, '  nothing flagged'))
    } else {
      for (const g of flagged) {
        line(`  ${c(YELLOW, 'flag')} ${pad(g.gate, 34)}${g.caseId ?? ''}`)
        line(`       ${g.detail}`)
        if (g.evidence !== null) line(c(DIM, `       ${g.evidence}`))
      }
      line('')
      line(c(DIM, '  Advisories carry real false-positive rates and are for human triage.'))
      line(c(DIM, '  no_invented_entities cannot catch recombination of real tokens into a'))
      line(c(DIM, '  false claim, which is the failure that matters most.'))
    }
  }

  /* ------------------------------------------------------------------ sweep */
  if (report.knobSweep != null) {
    section('Routing knob sweep')
    line(renderKnobSweep(report.knobSweep))
  }

  if (report.sweep !== null) {
    section('Threshold sweep')
    line(renderSweep(report.sweep))
  }

  /* ---------------------------------------------------------------- summary */
  const failedGates = report.gates.filter((g) => g.status === 'fail')
  line('')
  line(BAR)
  const verdict =
    r.disagreements.length === 0 && failedGates.length === 0
      ? c(GREEN, 'RESULT: corpus agreed, gates clean')
      : c(RED, `RESULT: ${r.disagreements.length} routing disagreement(s), ${failedGates.length} gate failure(s)`)
  line(verdict)
  line(
    `  ${report.routing.cases.length} cases · ${formatPassRate(report.quality.rate)} · ` +
      `${report.gates.length} gates · ${report.advisories.filter((g) => g.status === 'fail').length} advisory flag(s)`,
  )
  line(BAR)

  return out.join('\n')
}
