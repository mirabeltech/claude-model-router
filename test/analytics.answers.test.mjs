/**
 * THE ANSWER-QUALITY SECTION, whose job is to be impossible to misread as a pass.
 *
 * WHY IT EXISTS AT ALL. Every other section of a report carries a figure that goes UP when
 * delegation works: delegation rate, tokens avoided, success rate, cost avoided. A reader who
 * scans the overview and stops concludes the router is doing well, and nothing on the page
 * contradicted that reading — while whether the ANSWERS were any good is not established anywhere
 * in this project. A team could adopt the plugin, see a healthy dashboard, and be getting worse
 * answers.
 *
 * THIS IS NOT A QUALITY METRIC AND MUST NEVER BECOME ONE. Every figure is a count of a MEASURED
 * condition. The tests below assert that in the strongest form available: `measured` is literally
 * `false`, every figure names its population, and the section carries the sentence saying
 * correctness is unestablished. A future change that turned this into a score would fail here.
 *
 * WHAT WAS DELIBERATELY NOT BUILT, and the reasoning belongs beside the thing that replaced it:
 * the eval framework has an ADVISORY `no_invented_entities` grounding check, and promoting it to
 * runtime was considered and rejected. Its own documented failure profile says false positives are
 * common — "roughly one per run across five dispatch cases" — from legitimate composition and
 * prose casing drift. A noisy detector rendered as a quality number is the same overclaiming
 * problem inverted, and a team chasing false positives trusts the report less, not more. The
 * sharpened version is a backlog item with an explicit precondition: measure the false-positive
 * rate first.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { POPULATIONS, SECTIONS } from '../plugins/model-router/lib/analytics/schema.mjs'
import { renderReport } from '../plugins/router-dashboard/lib/render/index.mjs'
import { NOW, dispatchedRow, errorRow, gateRow, resetIds } from './helpers/analytics-rows.mjs'

const analyze = (rows) => analyzeRows(rows, { now: NOW + 1000, window: { kind: 'all' } })

/* ------------------------------------------------------------------ the shape */

test('the section is declared, and its population is too', () => {
  // A section the response does not declare is a section the contract test would reject, and a
  // population serializeCount does not know throws at render time rather than at review time.
  assert.ok(SECTIONS.includes('answerQuality'))
  assert.ok(POPULATIONS.answerDelivered, 'answerDelivered must be a declared population')
  assert.match(POPULATIONS.answerDelivered, /not measured/i, 'and must say what it is for')
})

test('measured is literally false, as a field and not only as prose', () => {
  // THE LOAD-BEARING ASSERTION. A consumer that renders this section cannot mistake it for a
  // quality figure while this is false, and a future build that gains a real grader has one thing
  // to flip. A caveat that lives only in a note is a caveat that gets dropped by the next
  // renderer.
  const r = analyze([dispatchedRow()])
  assert.equal(r.answerQuality.measured, false)
  assert.equal(typeof r.answerQuality.established, 'string')
  assert.match(r.answerQuality.notEstablished, /correct/i, 'it must name what is unestablished')
  assert.match(r.answerQuality.note, /NOT A QUALITY SCORE/)
})

test('every figure in the section names the population it covers', () => {
  // The repository's rule: a coverage figure without its denominator is not information.
  const r = analyze([dispatchedRow(), gateRow(), errorRow()])
  for (const key of [
    'delivered',
    'onUnverifiedWindow',
    'cutOffMidAnswer',
    'discardedForTruncation',
    'usageInconsistent',
  ]) {
    const node = r.answerQuality[key]
    assert.equal(node.metricKind, 'count', key)
    assert.ok(POPULATIONS[node.population], `${key} names an undeclared population`)
  }
})

/* ----------------------------------------------------------- what it counts */

test('a delivered answer is a dispatched, ok row that actually returned text', () => {
  resetIds()
  const r = analyze([
    dispatchedRow({ status: 'ok', returned_answer_chars: 400 }),
    // Dispatched and ok, but empty: nothing was delivered, so nothing has unknown correctness.
    dispatchedRow({ status: 'ok', returned_answer_chars: 0 }),
    // A gate refusal never reaches a worker.
    gateRow(),
    // An error produced no answer.
    errorRow(),
  ])
  assert.equal(r.answerQuality.delivered.value, 1)
})

test('an answer on an unverified window is counted, because that is the residual risk', () => {
  // The one honest per-answer confidence signal in the store. Truncation detection needs a
  // window; without one, a silently middle-dropped prompt could not have been caught. This is a
  // measured fact about our own coverage, not a guess about the model.
  resetIds()
  const r = analyze([
    dispatchedRow({ status: 'ok', returned_answer_chars: 400, worker_context_status: 'unknown', worker_context_tokens: null }),
    dispatchedRow({ status: 'ok', returned_answer_chars: 400, worker_context_status: 'configured', worker_context_tokens: 8192 }),
  ])
  assert.equal(r.answerQuality.delivered.value, 2)
  assert.equal(r.answerQuality.onUnverifiedWindow.value, 1)
  assert.equal(
    r.answerQuality.onUnverifiedWindow.population,
    'answerDelivered',
    'the denominator is delivered answers, not every row',
  )
})

test('a truncation-detected answer is DISCARDED, so it is never counted as delivered', () => {
  // The defence working, and the reason the delivered population is safer than it looks: an
  // answer built from a provably truncated prompt is thrown away rather than returned. Both halves
  // are reported, because together they are the whole picture — one is the risk we caught and the
  // other is the risk we could not have caught.
  resetIds()
  const r = analyze([
    dispatchedRow({ status: 'skipped', worker_input_truncation_detected: true, returned_answer_chars: null }),
  ])
  assert.equal(r.answerQuality.discardedForTruncation.value, 1)
  assert.equal(r.answerQuality.delivered.value, 0, 'a discarded answer was never delivered')
})

test('an answer cut off mid-generation is counted separately from a truncated PROMPT', () => {
  // Two different events that both contain the word truncated, and conflating them would report an
  // incomplete answer as a potentially-fabricated one. `truncated` is the output budget running
  // out — loud and detectable. `worker_input_truncation_detected` is the prompt being silently
  // shortened — the dangerous one.
  resetIds()
  const r = analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 50, truncated: true })])
  assert.equal(r.answerQuality.cutOffMidAnswer.value, 1)
  assert.equal(r.answerQuality.discardedForTruncation.value, 0)
  assert.equal(r.answerQuality.delivered.value, 1, 'an incomplete answer was still delivered')
})

test('an empty window reports zeros rather than nulls, because zero answers is a measurement', () => {
  // "No answers were delivered" is a fact. A null here would read as "we do not know how many
  // answers were delivered", which is a different and much worse claim.
  const r = analyze([])
  assert.equal(r.answerQuality.measured, false)
  assert.equal(r.answerQuality.delivered.value, 0)
  assert.equal(r.answerQuality.onUnverifiedWindow.value, 0)
})

/* --------------------------------------------------------------- the report */

test('the report renders the section SECOND, before any favourable figure', () => {
  // Position is the point. A reader who scans the overview and stops must meet the evidence
  // boundary before the savings, not after them — so this asserts the ORDER, not merely that the
  // section exists somewhere on the page.
  const html = renderReport(analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 400 })]), {
    generatedAt: '2026-03-04T12:00:00.000Z',
  })
  const answerAt = html.indexOf('Answer quality')
  const savingsAt = html.indexOf('Savings')
  const routingAt = html.indexOf('>Routing')
  assert.ok(answerAt > 0, 'the section must be on the page')
  assert.ok(answerAt < routingAt, 'it must precede Routing')
  assert.ok(answerAt < savingsAt, 'and precede Savings')
})

test('the report says NOT MEASURED in the section, not only in a footnote', () => {
  const html = renderReport(analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 400 })]), {
    generatedAt: '2026-03-04T12:00:00.000Z',
  })
  const section = html.slice(html.indexOf('Answer quality'))
  assert.match(section.slice(0, 1200), /NOT MEASURED/, 'it leads with the boundary')
  assert.match(section.slice(0, 2000), /no grader/i)
  assert.match(section.slice(0, 2000), /confident wrong one/i, 'and names the failure it cannot detect')
})

test('the report escapes its own markup rather than emitting it', () => {
  // A first draft passed <strong> into callout() and table(), which escape — so the page showed
  // the tags as text. Pinned because the fix is invisible: the section still rendered, just badly.
  const html = renderReport(analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 400 })]), {
    generatedAt: '2026-03-04T12:00:00.000Z',
  })
  assert.equal(/&lt;strong&gt;/.test(html), false, 'escaped markup is leaking into the page')
})

test('the unverified-window callout appears only when there is something to warn about', () => {
  // A warning that is always present is a warning nobody reads.
  const clean = renderReport(
    analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 400, worker_context_status: 'configured', worker_context_tokens: 8192 })]),
    { generatedAt: '2026-03-04T12:00:00.000Z' },
  )
  // The probe has to be unique to the CALLOUT. "could not be determined" also appears in the
  // table row, which is always present — a first draft used it and failed for that reason.
  assert.equal(/never treated as unlimited/.test(clean), false, 'nothing to warn about, so no warning')

  const risky = renderReport(
    analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 400, worker_context_status: 'unknown', worker_context_tokens: null })]),
    { generatedAt: '2026-03-04T12:00:00.000Z' },
  )
  assert.match(risky, /never treated as unlimited/, 'a warning when there is, saying what DID protect the call')
  assert.match(risky, /delivered answer\(s\) came from a worker/, 'and naming the count')
})

test('the section carries no dollar figure and no answer text', () => {
  // It describes answers; it must not quote one. The answer text is never stored, so this is a
  // belt — but it is the section most likely to tempt somebody into adding an excerpt.
  const html = renderReport(
    analyze([dispatchedRow({ status: 'ok', returned_answer_chars: 400, question_text: 'SECRET-QUESTION' })]),
    { generatedAt: '2026-03-04T12:00:00.000Z' },
  )
  const section = html.slice(html.indexOf('Answer quality'), html.indexOf('>Routing'))
  assert.equal(section.includes('SECRET-QUESTION'), false)
  assert.equal(/\$[0-9]/.test(section), false)
})
