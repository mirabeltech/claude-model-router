/**
 * The HTML report.
 *
 * The renderer is a pure string function, so all of this runs without a store, a file or a
 * browser. What it checks is not layout but HONESTY: every assertion here corresponds to a way a
 * conventional dashboard would tell a lie about missing data.
 *
 *   - an unavailable aggregate rendered as `$0.0000`
 *   - a null point drawn as a zero-width bar, pixel-identical to a measured zero
 *   - a null day interpolated across by a single polyline
 *   - a coverage of 0.4% rounded to "0%" and read as "nothing measured"
 *   - four unrelated refusal counts added into one "failures" number
 *   - a direction arrow drawn through three data points
 *
 * The test file imports the ENGINE to build its input, which the dashboard source may never do.
 * That asymmetry is the point: the contract is the response object, and a test is the right place
 * to stand on both sides of it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { mapReadReport } from '../plugins/model-router/lib/analytics/quality.mjs'
import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { renderReport } from '../plugins/router-dashboard/lib/render/index.mjs'
import { barChart, lineChart, trendNote, MIN_TREND_POINTS } from '../plugins/router-dashboard/lib/render/chart.mjs'
import { acceptResponse, parseResponse } from '../plugins/router-dashboard/lib/contract.mjs'
import { coverageText, fmt, metricText, percent } from '../plugins/router-dashboard/lib/format.mjs'
import { escapeHtml } from '../plugins/router-dashboard/lib/html.mjs'
import { NOW, dispatchedRow, denialRow, errorRow, gateRow, pricedRow } from './helpers/analytics-rows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 'telemetry')
const STAMP = '2026-03-04T12:00:00.000Z'

const analyze = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })
const render = (rows, opts = {}) => renderReport(analyze(rows, opts), { generatedAt: STAMP })

/** The full fixture corpus, which carries one of every hazard. */
function corpusReport() {
  const { records, report } = readSegmentsSync({ dir: FIXTURES, fs })
  const response = analyzeRows(records, { now: NOW, window: { kind: '7d' }, read: mapReadReport(report) })
  return { response, html: renderReport(response, { generatedAt: STAMP }) }
}

/** Visible text only, with styles and charts removed. */
function visibleText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

/* -------------------------------------------------------------- the document */

test('the report is one self-contained document with no external request', () => {
  const { html } = corpusReport()
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /<meta name="viewport"/)
  assert.match(html, /<title>/)
  // No network: a report has to open on a machine with no internet and keep working in a year.
  assert.equal(/<script/i.test(html), false, 'the report runs no script at all')
  assert.equal(/https?:\/\//.test(html), false, 'no external URL')
  assert.equal(/<link/i.test(html), false, 'no external stylesheet')
})

test('every required section is rendered', () => {
  const text = visibleText(corpusReport().html)
  for (const heading of [
    'Overview',
    'Routing',
    'Worker performance',
    'Savings',
    'Cost',
    'Latency',
    'Governance',
    'Reliability',
    'Trends',
    'Data quality',
  ]) {
    assert.ok(text.includes(heading), `${heading} is missing`)
  }
})

test('the footer stamps every version the report depends on', () => {
  const text = visibleText(corpusReport().html)
  assert.match(text, /analytics contract 1/)
  assert.match(text, /telemetry schema 1/)
  assert.match(text, /calc 1/)
})

/* ------------------------------------------------- the never-a-zero rules */

test('an unavailable aggregate renders the word unavailable and never a zero amount', () => {
  // THE CENTRAL RULE. On a default install every money column is null, so this is the normal
  // path rather than an edge case.
  const html = render([dispatchedRow(), dispatchedRow()])
  const text = visibleText(html)
  assert.match(text, /unavailable \(2 events, none measured\)/)
  assert.equal(html.includes('$0.0000'), false, 'an unknown cost rendered as a zero amount')
  assert.equal(/\$[0-9]/.test(html), false, 'an unpriced window contains no dollar figure at all')
})

test('a structurally zero cost and an unknown cost render differently', () => {
  // Ollama at a configured rate of $0.0000 has genuinely cost nothing, and that is a finding.
  // An unpriced Gemini call is the absence of a finding. They must not look the same.
  const zero = render([pricedRow({ worker_total_cost: 0, worker_total_cost_status: 'actual' })])
  const unknown = render([dispatchedRow()])
  assert.ok(visibleText(zero).includes('$0.0000'), 'a measured zero is printed as a zero')
  assert.equal(visibleText(unknown).includes('$0.0000'), false)
  assert.ok(visibleText(unknown).includes('unavailable'))
})

test('a null scalar prints NULL, never 0', () => {
  const text = visibleText(render([gateRow()]))
  assert.ok(text.includes('NULL'), 'a missing latency must say NULL')
})

test('the report never prints a rounded coverage percentage on its own', () => {
  // One row in 250 is 0.4%, and Math.round of that is 0 — which reads as "nothing measured" when
  // something was. The integers always lead.
  const rows = [pricedRow(), ...Array.from({ length: 249 }, () => dispatchedRow())]
  const text = visibleText(render(rows))
  assert.match(text, /1 of 250 events/, 'the integers must be shown')
  assert.equal(coverageText({ knownEvents: 1, totalEvents: 250, ratio: 1 / 250 }).startsWith('1 of 250'), true)
})

test('coverage is null rather than zero percent when there is nothing to cover', () => {
  assert.equal(coverageText({ knownEvents: 0, totalEvents: 0, ratio: null }), null)
  assert.equal(percent(null), 'NULL')
  assert.equal(fmt(null), 'NULL')
  assert.equal(fmt(undefined), 'NULL')
  assert.equal(fmt(Number.NaN), 'NULL')
})

test('a partial sum of a non-negative column is labelled a floor', () => {
  const text = visibleText(render([pricedRow(), dispatchedRow()]))
  assert.match(text, /at least/)
  assert.match(text, /a floor, not a total/)
})

test('a partial sum containing a negative claims no floor', () => {
  const html = render([
    pricedRow({ estimated_net_savings: -0.05 }),
    pricedRow({ estimated_net_savings: 0.02 }),
    dispatchedRow(),
  ])
  const response = analyze([
    pricedRow({ estimated_net_savings: -0.05 }),
    pricedRow({ estimated_net_savings: 0.02 }),
    dispatchedRow(),
  ])
  assert.equal(response.summary.netSavings.bound, 'none')
  assert.equal(response.summary.netSavings.display.startsWith('at least'), false)
  assert.ok(html.includes(escapeHtml(response.summary.netSavings.display)))
})

/* --------------------------------------------------- the renderer never computes */

test('the renderer prints display strings and never reads .value on an aggregate', () => {
  // Reading it crashes on NULL, and the reflex fix for that crash is the `?? 0` this project
  // exists to forbid. chart.mjs is the single exemption, because drawing needs arithmetic.
  const dir = path.join(HERE, '..', 'plugins', 'router-dashboard')
  const offenders = []
  const walk = (d, rel = '') => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const next = path.join(d, entry.name)
      const id = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(next, id)
        continue
      }
      if (!entry.name.endsWith('.mjs')) continue
      if (id === 'lib/render/chart.mjs') continue
      const src = fs
        .readFileSync(next, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      if (/\.value\.toFixed/.test(src)) offenders.push(`${id} formats a raw value`)
    }
  }
  walk(dir)
  assert.deepEqual(offenders, [], 'formatting a raw aggregate value crashes on NULL')
})

test('every aggregate string in the document came from the engine verbatim', () => {
  // The dashboard cannot import formatAgg, so the only honest option is to print what it was
  // handed. If a display string were ever reconstructed here, the two would drift.
  const { response, html } = corpusReport()
  const violations = []
  for (const key of ['tokensAvoided', 'workerTokens', 'workerCost', 'netSavings']) {
    const node = response.summary[key]
    if (!html.includes(escapeHtml(node.display))) violations.push(`${key}: ${node.display}`)
  }
  assert.deepEqual(violations, [], 'a headline string was not the engine\'s own')
})

/* --------------------------------------------------------------- the charts */

test('a NULL point is a gap, never a zero-width bar', () => {
  // A zero-width rect is pixel-identical to a measured zero at every zoom level, so an unpriced
  // call would render exactly like a free one.
  const svg = barChart({
    points: [
      { label: 'measured', value: 10, display: '10' },
      { label: 'unknown', value: null, display: 'NULL' },
    ],
  })
  assert.match(svg, /class="gap-rule"/, 'a null gets a dashed tick')
  assert.equal(/width="0"/.test(svg), false, 'and never a zero-width rect')
  assert.match(svg, />NULL</)
  assert.match(svg, /unmeasured: unknown \(1 of 2\)/, 'and is named under the chart')
})

test('a measured zero gets a visible stub, so it is not mistaken for an absence', () => {
  const svg = barChart({ points: [{ label: 'ollama', value: 0, display: '$0.0000' }] })
  assert.match(svg, /class="zero-stub"/)
  assert.match(svg, /\$0\.0000/)
})

test('a chart with nothing plottable draws no axis at all', () => {
  // An axis with no marks on it reads as a measurement whose answer was zero.
  const svg = barChart({ points: [{ label: 'a', value: null, display: 'NULL' }] })
  assert.equal(svg.includes('<svg'), false, 'no axis must be drawn')
  assert.match(svg, /no measured data in this window/)
})

test('an empty point list renders a sentence rather than an empty chart', () => {
  assert.match(barChart({ points: [] }), /no measured data in this window/)
  assert.match(lineChart({ points: [] }), /no measured data in this window/)
})

test('a NULL day splits the line into two polylines rather than interpolating', () => {
  // A line drawn through a gap asserts a measurement that was never taken, in the most
  // persuasive form available.
  const svg = lineChart({
    points: [
      { label: '03-01', value: 10 },
      { label: '03-02', value: 20 },
      { label: '03-03', value: null },
      { label: '03-04', value: 30 },
      { label: '03-05', value: 40 },
    ],
  })
  assert.equal((svg.match(/<polyline/g) ?? []).length, 2, 'two runs, not one line through the gap')
  assert.match(svg, /class="gap-rule"/, 'and the gap is marked')
  assert.match(svg, /1 day unmeasured/)
  assert.match(svg, /never interpolated/)
})

test('a single measured day is a dot, not a line to nowhere', () => {
  const svg = lineChart({ points: [{ label: '03-01', value: 10 }] })
  assert.match(svg, /<circle/)
  assert.equal(svg.includes('<polyline'), false)
})

test('a line of all-null days draws nothing and says so', () => {
  const svg = lineChart({ points: [{ label: 'a', value: null }, { label: 'b', value: null }] })
  assert.match(svg, /no measured data in this window/)
  assert.equal(svg.includes('<polyline'), false)
})

/* ------------------------------------------------------------- small samples */

test('a short series says the sample is too small and states no direction', () => {
  assert.equal(trendNote(3), 'sample size too small to imply a trend (n = 3)')
  assert.equal(trendNote(MIN_TREND_POINTS), null, 'at the threshold a trend is allowed')
  assert.equal(trendNote(MIN_TREND_POINTS - 1) !== null, true)
  assert.equal(trendNote(null), 'sample size too small to imply a trend (n = 0)')
})

test('no direction word appears in a chart rendered from fewer than the trend minimum', () => {
  const svg = lineChart({
    points: [
      { label: 'a', value: 1 },
      { label: 'b', value: 5 },
      { label: 'c', value: 20 },
    ],
  })
  assert.match(svg, /sample size too small to imply a trend \(n = 3\)/)
  for (const word of ['increase', 'decrease', 'rising', 'falling', 'trending', '▲', '▼']) {
    assert.equal(svg.toLowerCase().includes(word.toLowerCase()), false, `"${word}" implies a direction`)
  }
})

test('a short window carries the too-small note into the trends section', () => {
  const html = renderReport(analyzeRows([dispatchedRow()], { now: NOW, window: { kind: 'today' } }), {
    generatedAt: STAMP,
  })
  assert.match(visibleText(html), /sample size too small to imply a trend/)
})

/* ------------------------------------------- the three things never merged */

test('the failures section renders three tables with three totals and no grand total', () => {
  const rows = [
    errorRow(),
    denialRow(),
    dispatchedRow({ status: 'skipped', routing_reason: 'context_exceeded', error_code: null }),
    dispatchedRow(),
  ]
  const text = visibleText(render(rows))
  assert.match(text, /Worker call failures/)
  assert.match(text, /Refusals . the worker was never called/)
  assert.match(text, /Things we could not measure/)
  assert.match(text, /A budget refusal, a context refusal and an unpriced call are three different events/)
  assert.match(text, /never add them up|never adds them up/)
  // The sum of the four would be 4; no element may present it as one figure.
  assert.equal(/failures[^0-9]{0,20}4\b/i.test(text), false, 'a combined failure total appeared')
})

test('the two kinds of context refusal are shown apart', () => {
  const text = visibleText(
    render([
      gateRow({ task_type: 'bulk_read', routing_reason: 'context_exceeded', status: 'skipped', worker_input_truncation_detected: null }),
      pricedRow({ routing_reason: 'context_exceeded', worker_input_truncation_detected: true, status: 'skipped' }),
    ]),
  )
  assert.match(text, /pre-flight/)
  assert.match(text, /truncation discard/)
  assert.match(text, /never called and nothing was spent/)
  assert.match(text, /the answer was discarded/)
})

test('a governance denial is labelled a decision rather than a failure', () => {
  const text = visibleText(render([denialRow(), dispatchedRow()]))
  assert.match(text, /a decision, not a failure|A successful decision, not a failure/)
})

/* ------------------------------------------------------------- empty store */

test('an empty store renders a complete report that says no events everywhere', () => {
  // A fresh install is the most common case there is; a renderer that special-cased it would be
  // untested on the path every new user takes first.
  const html = renderReport(analyzeRows([], { now: NOW, window: { kind: '7d' } }), { generatedAt: STAMP })
  const text = visibleText(html)
  for (const heading of ['Overview', 'Routing', 'Savings', 'Cost', 'Latency', 'Governance', 'Reliability', 'Trends', 'Data quality']) {
    assert.ok(text.includes(heading), `${heading} is missing from an empty report`)
  }
  assert.match(text, /no events/)
  assert.equal(/\$[0-9]/.test(html), false, 'an empty report contains no dollar figure')
})

test('on an empty window a COUNT series draws zeros and a MEASUREMENT series draws nothing', () => {
  // The distinction is the whole point and it is easy to get backwards. A day in the window with
  // no rows genuinely had ZERO routing events — that is a measurement whose answer is zero, and
  // a flat line at zero is a true statement about an installed router that routed nothing. The
  // same day has NO tokens-avoided figure at all, and drawing that as zero would claim a
  // measurement nobody took. So the count charts draw and the measurement charts decline.
  const html = renderReport(analyzeRows([], { now: NOW, window: { kind: '7d' } }), { generatedAt: STAMP })
  const declined = (html.match(/no measured data in this window/g) ?? []).length
  assert.ok(declined >= 3, `the measurement charts must decline to draw; found ${declined}`)
  assert.match(html, /<polyline/, 'the event-count series is a real line of real zeros')

  // And the per-day table says "no events" for the measurements rather than 0.
  const text = visibleText(html)
  assert.match(text, /2026-02-26 0 0 no events no events no events/)
})

test('a window with some quiet days keeps the quiet days as zeros and the gaps as gaps', () => {
  const html = renderReport(
    analyzeRows(
      [
        dispatchedRow({ timestamp: '2026-03-02T10:00:00.000Z' }),
        dispatchedRow({ timestamp: '2026-03-04T10:00:00.000Z' }),
      ],
      { now: NOW, window: { kind: '7d' } },
    ),
    { generatedAt: STAMP },
  )
  const text = visibleText(html)
  // 03-03 had no rows: zero events, and no avoided figure.
  assert.match(text, /2026-03-03 0 0 no events/)
  // The tokens-avoided line must break rather than crossing 03-03.
  assert.match(html, /class="gap-rule"/)
})

/* -------------------------------------------------------------- escaping */

test('every interpolated value is escaped, because a model id came from a remote service', () => {
  // The report is a local file opened in a browser, so an injected tag would execute.
  const html = render([dispatchedRow({ model: '<script>alert(1)</script>', provider: 'x"y' })])
  assert.equal(html.includes('<script>alert(1)</script>'), false, 'a model id injected a tag')
  assert.ok(html.includes('&lt;script&gt;'), 'and it is present, escaped')
})

test('escapeHtml covers all five characters that change a document', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
  assert.equal(escapeHtml(0), '0')
})

/* ------------------------------------------------------------ the contract */

test('a response from an unknown contract version is refused, not rendered', () => {
  // A newer contract may have given a field a new meaning. Rendering it anyway produces a report
  // that looks right and is wrong, which is worse than an error.
  const r = acceptResponse({ analytics_contract_version: 2 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unsupported_contract_version')
  assert.match(r.detail, /looks right and is wrong/)
})

test('a response with no contract version is refused with a usable message', () => {
  const r = acceptResponse({ summary: {} })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_contract_version')
  assert.match(r.detail, /analytics --json/)
})

test('an incomplete response names the sections it is missing', () => {
  const r = acceptResponse({ analytics_contract_version: 1, summary: {} })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'incomplete_response')
  assert.match(r.detail, /routing/)
})

test('the human report piped by mistake is diagnosed as such', () => {
  // The most likely user error is forgetting --json, and "Unexpected token =" sends the reader
  // to entirely the wrong place.
  const r = parseResponse('====\nmodel-router analytics\n====')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not_json')
  assert.match(r.detail, /add --json/)
})

test('empty input is diagnosed as empty rather than as malformed', () => {
  const r = parseResponse('   \n')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty_input')
})

test('a valid corpus response is accepted', () => {
  const { response } = corpusReport()
  assert.equal(acceptResponse(response).ok, true)
  assert.equal(parseResponse(JSON.stringify(response)).ok, true)
})

/* ------------------------------------------------------------ determinism */

test('rendering the same response twice gives identical bytes', () => {
  const { response } = corpusReport()
  const a = renderReport(response, { generatedAt: STAMP })
  const b = renderReport(response, { generatedAt: STAMP })
  assert.equal(a, b)
})

/* ---------------------------------------------------------------- formatting */

test('an unavailable metric says it was not measured rather than showing a dash', () => {
  // A dash in a cost column is read as zero by everyone who is in a hurry.
  assert.equal(metricText({ metricKind: 'unavailable', value: null, reason: 'x', detail: 'y' }), 'not measured')
  assert.equal(metricText(null), 'NULL')
})

test('the uninstrumented latency components are listed with their reasons', () => {
  const text = visibleText(corpusReport().html)
  assert.match(text, /hookOverheadMs/)
  assert.match(text, /declines to put the hook wall clock/)
  assert.match(text, /perAttemptMs/)
})
