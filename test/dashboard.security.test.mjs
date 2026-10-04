/**
 * What may never reach a rendered report.
 *
 * Three independent guards exist, because one would be a single point of failure:
 *
 *   1. the engine never puts a content column in the response (analytics.contract.test.mjs)
 *   2. no dashboard source file names one (dashboard.isolation.test.mjs)
 *   3. and THIS FILE: a response is deliberately doctored to smuggle each field in under its real
 *      name, and the rendered HTML must not contain the VALUE.
 *
 * The third is the one that tests the property that actually matters. The first two prove the
 * current code does not emit these fields; this proves the renderer emits only the fields it
 * knows about, so a future response that gained a content column would still not publish it.
 * Asserting on the absence of a value rather than of a key name is what makes that distinction
 * checkable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { renderReport } from '../plugins/router-dashboard/lib/render/index.mjs'
import { escapeHtml } from '../plugins/router-dashboard/lib/html.mjs'
import { NOW, dispatchedRow, errorRow, pricedRow } from './helpers/analytics-rows.mjs'

const STAMP = '2026-03-04T12:00:00.000Z'
const MARKER = 'SMUGGLED-MUST-NOT-RENDER'

const analyze = (rows) => analyzeRows(rows, { now: NOW, window: { kind: 'all' } })
const render = (response) => renderReport(response, { generatedAt: STAMP })

/** Deep-clone a response so a doctored copy cannot affect another test. */
const clone = (o) => JSON.parse(JSON.stringify(o))

/**
 * Every HTML tag in the document, so an assertion can distinguish markup from text.
 *
 * It matters: escaping neutralises `<` and `>` but leaves the words between them, so a hostile
 * model id legitimately puts the characters `onerror=alert(1)` into the document as inert text.
 * Searching the whole document for that string finds the harmless case and would have to be
 * weakened until it found nothing; searching only inside tags asks the real question.
 */
const tagsOf = (html) => html.match(/<[^>]*>/g) ?? []

/* --------------------------------------------------- smuggling, the hard way */

test('a content column smuggled into the response is not rendered', () => {
  // The renderer emits the fields it knows, never the fields it was handed. Without that
  // property, a telemetry schema change could publish a developer's prompt on the strength of
  // nobody having updated the dashboard.
  const response = clone(analyze([dispatchedRow(), pricedRow()]))
  response.question_text = `${MARKER}-question`
  response.error_message_safe = `${MARKER}-error`
  response.project_path = `${MARKER}-path`
  response.summary.question_text = `${MARKER}-nested`
  response.dataQuality.read.samples = [{ file: `${MARKER}-file`, excerpt: `${MARKER}-excerpt` }]

  const html = render(response)
  assert.equal(html.includes(MARKER), false, 'a smuggled value reached the document')
})

test('a content column smuggled into a negative-savings example is not rendered', () => {
  // The examples table is the one place the report prints per-row fields, so it is the most
  // likely route for a content field to arrive by.
  const response = clone(
    analyze([pricedRow({ estimated_net_savings: -0.05, estimated_tokens_avoided: -100 })]),
  )
  assert.ok(response.negativeSavings.examples.items.length > 0, 'the fixture must produce an example')
  response.negativeSavings.examples.items[0].question_text = `${MARKER}-example`
  response.negativeSavings.examples.items[0].error_message_safe = `${MARKER}-example-error`
  response.negativeSavings.examples.items[0].project_path = `${MARKER}-example-path`

  const html = render(response)
  assert.equal(html.includes(MARKER), false, 'an example leaked a content field')
})

test('a content column smuggled into a segment bucket is not rendered', () => {
  const response = clone(analyze([dispatchedRow(), errorRow()]))
  for (const bucket of response.segments.workerProfile.buckets) {
    bucket.question_text = `${MARKER}-bucket`
  }
  const html = render(response)
  assert.equal(html.includes(MARKER), false, 'a bucket leaked a content field')
})

/* --------------------------------------------------------------- real fields */

test('the fixture content markers never appear, in any section', () => {
  // The corpus rows carry FIXTURE-MUST-NOT-APPEAR-* in all three content columns. This is the
  // end-to-end version of the same property, with no doctoring.
  const rows = [
    dispatchedRow({
      question_text: 'FIXTURE-MUST-NOT-APPEAR-questiontext',
      error_message_safe: 'FIXTURE-MUST-NOT-APPEAR-errormessage',
      project_path: 'FIXTURE-MUST-NOT-APPEAR-projectpath',
      privacy_level: 'verbose',
    }),
  ]
  const response = analyze(rows)
  const html = render(response)
  assert.equal(JSON.stringify(response).includes('FIXTURE-MUST-NOT-APPEAR'), false)
  assert.equal(html.includes('FIXTURE-MUST-NOT-APPEAR'), false)
})

test('no absolute filesystem path reaches the document', () => {
  // A store directory is a local path, and a report is a file people attach to tickets.
  const response = clone(analyze([dispatchedRow()]))
  response.dataQuality.read.storeDir = 'C:/Users/someone/.claude/model-router/telemetry'
  const html = render(response)
  assert.equal(html.includes('C:/Users/someone'), false)
  assert.equal(/[A-Z]:[\\/]Users/.test(html), false, 'a Windows home path appeared')
  assert.equal(/\/home\/[a-z]/.test(html), false, 'a POSIX home path appeared')
})

test('an environment variable name never appears beside a value', () => {
  // The report must not become a place to discover how an install is configured.
  const html = render(analyze([dispatchedRow(), pricedRow()]))
  const violations = []
  for (const name of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CMR_', 'CLAUDE_ROUTER_TELEMETRY']) {
    if (html.includes(name)) violations.push(name)
  }
  assert.deepEqual(violations, [], 'an environment variable name appeared in the report')
})

/* ----------------------------------------------------------------- escaping */

test('a hostile model id cannot inject markup', () => {
  // A model id and an error code come from a remote service, and the report is a local file a
  // browser will execute with file-URL privileges.
  const hostile = '</style><script>fetch("//evil")</script>'
  const html = render(analyze([dispatchedRow({ model: hostile, provider: hostile })]))
  assert.equal(html.includes('<script>'), false, 'a tag was injected')
  assert.equal(html.includes('</style><script'), false)
  assert.ok(html.includes(escapeHtml(hostile)), 'and the value is present, escaped')
})

test('a hostile error code cannot inject markup', () => {
  // The escaped text `onerror=alert(1)` DOES appear in the document, as inert text content, and
  // that is correct — escaping neutralises the angle brackets, not the words between them. The
  // property worth asserting is that no TAG was created, so the test looks for the element
  // rather than for the string.
  const hostile = '"><img src=x onerror=alert(1)>'
  const html = render(analyze([errorRow({ error_code: hostile })]))
  assert.equal(html.includes('<img'), false, 'a tag was created')
  assert.ok(html.includes('&lt;img'), 'and the value is present, escaped')
  assert.equal(tagsOf(html).some((t) => /\son[a-z]+\s*=/i.test(t)), false, 'an event handler appeared in a tag')
})

test('a hostile bucket label cannot break out of an attribute', () => {
  const html = render(analyze([dispatchedRow({ model: 'a" onload="x' })]))
  assert.equal(tagsOf(html).some((t) => /onload/i.test(t)), false)
  assert.ok(html.includes('&quot;'), 'the quote was escaped rather than closing the attribute')
})

test('a hostile data-quality detail cannot inject markup', () => {
  const response = clone(analyze([dispatchedRow()]))
  response.dataQuality.conditions = [
    { id: 'injected', severity: 'error', affects: ['x'], detail: '<script>alert(1)</script>' },
  ]
  const html = render(response)
  assert.equal(html.includes('<script>alert(1)</script>'), false)
})

test('the document contains no script element and no event handler attribute', () => {
  const html = render(analyze([dispatchedRow(), pricedRow(), errorRow()]))
  assert.equal(/<script/i.test(html), false)
  // Inside TAGS only. An `on...=` sequence in escaped text content is inert, and asserting
  // against the whole document would conflate the two.
  const handlers = tagsOf(html).filter((t) => /\son[a-z]+\s*=/i.test(t))
  assert.deepEqual(handlers, [], 'an inline event handler appeared')
  assert.equal(/javascript:/i.test(html), false)
})
