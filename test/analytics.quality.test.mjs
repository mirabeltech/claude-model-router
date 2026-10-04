/**
 * Data quality.
 *
 * This section exists to make one confusion impossible: "we saved $0" versus "we do not know the
 * cost". Everything else in the response reports numbers; this reports how much of the window
 * those numbers cover and names the conditions that bound them.
 *
 * MALFORMED IS NOT A TRUNCATED TAIL, and the two are kept apart because they mean opposite
 * things. An unparseable line at the END of a segment is a writer caught mid-flight and is
 * entirely benign — it happens on any store being written to. An unparseable line in the MIDDLE
 * is evidence that append atomicity failed on this filesystem, which is the one reader counter
 * that should change what an operator does.
 *
 * AND MALFORMED DATA IS NEVER SILENTLY DISCARDED. A rejected line is counted, itemised by reason,
 * and raised as a condition — but it also cannot corrupt an aggregate, because it never reaches
 * one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { DATA_QUALITY_CONDITIONS } from '../plugins/model-router/lib/analytics/schema.mjs'
import { mapReadReport } from '../plugins/model-router/lib/analytics/quality.mjs'
import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { NOW, denialRow, dispatchedRow, errorRow, gateRow, pricedRow } from './helpers/analytics-rows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 'telemetry')

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })
const ids = (r) => r.dataQuality.conditions.map((c) => c.id)

/* --------------------------------------------------------------- the reader */

test('the reader counters are reported as scanned, accepted and rejected', () => {
  const { records, report } = readSegmentsSync({ dir: FIXTURES, fs })
  const r = analyzeRows(records, { now: NOW, window: { kind: '7d' }, read: mapReadReport(report) })
  const read = r.dataQuality.read
  assert.equal(read.segmentsRead, 3)
  assert.equal(read.linesScanned, 36)
  assert.equal(read.recordsAccepted, 33)
  assert.equal(read.recordsRejected, 3)
  assert.ok(read.bytesScanned > 0)
})

test('rejections are itemised by reason, never reported as one total', () => {
  // A single number would merge the benign (a blank line from a trailing newline) with the
  // alarming (a malformed line mid-file), which is the distinction most worth keeping.
  const { records, report } = readSegmentsSync({ dir: FIXTURES, fs })
  const r = analyzeRows(records, { now: NOW, window: { kind: '7d' }, read: mapReadReport(report) })
  assert.deepEqual(r.dataQuality.read.rejectionReasons, {
    blank: 1,
    comment: 1,
    malformed: 1,
    notAnObject: 0,
    unrecognized: 0,
    oversizeLine: 0,
    truncatedTail: 0,
    unterminatedTailParsed: 0,
  })
})

test('a malformed record raises an ERROR condition naming the atomicity hazard', () => {
  const r = run([dispatchedRow()], {
    read: mapReadReport({ files: 1, bytes: 10, lines: 2, yielded: 1, skipped: { malformed: 1 }, errors: [], samples: [] }),
  })
  const condition = r.dataQuality.conditions.find((c) => c.id === 'malformed_records')
  assert.ok(condition)
  assert.equal(condition.severity, 'error')
  assert.equal(condition.count, 1)
  assert.match(condition.detail, /append atomicity failed/)
  assert.match(condition.detail, /shardByPid/)
})

test('a truncated tail raises NO condition, because it is a writer caught mid-flight', () => {
  const r = run([dispatchedRow()], {
    read: mapReadReport({ files: 1, bytes: 10, lines: 2, yielded: 1, skipped: { truncated_tail: 1 }, errors: [], samples: [] }),
  })
  assert.equal(ids(r).includes('malformed_records'), false)
  assert.equal(r.dataQuality.read.rejectionReasons.truncatedTail, 1, 'but it is still counted')
})

test('a malformed line cannot corrupt an aggregate, because it never becomes a row', () => {
  // The reader drops it before analytics sees it, so the numbers describe the accepted rows and
  // the rejection is reported alongside rather than folded in.
  const r = run([pricedRow(), pricedRow()], {
    read: mapReadReport({ files: 1, bytes: 10, lines: 5, yielded: 2, skipped: { malformed: 3 }, errors: [], samples: [] }),
  })
  assert.equal(r.summary.events.value, 2)
  assert.ok(Math.abs(r.summary.workerCost.value - 0.0084) < 1e-12)
  assert.equal(r.summary.workerCost.status, 'complete', 'complete over the rows that existed')
  assert.equal(r.dataQuality.read.recordsRejected, 3)
})

/* ---------------------------------------------------------- schema versions */

test('schema versions are reported with a count each, including the unreadable ones', () => {
  const r = run([dispatchedRow(), dispatchedRow({ schema_version: 2 }), dispatchedRow({ schema_version: 2 })])
  assert.deepEqual(r.dataQuality.schemaVersions, { 1: 1, 2: 2 })
  assert.equal(r.coverage.rowsIncompatible, 2)
  assert.ok(ids(r).includes('schema_versions_unreadable'))
})

test('a row with a non-numeric schema version is reported as unreadable, not as version zero', () => {
  const r = run([dispatchedRow({ schema_version: null })])
  assert.deepEqual(r.dataQuality.schemaVersions, { unreadable: 1 })
  assert.equal(r.coverage.rowsCountable, 0)
})

test('an extra undeclared field does not reject the row', () => {
  // Rows are open on read for the same reason enums are: an older reader must still ingest a
  // newer writer's row rather than discarding the whole window.
  const row = { ...dispatchedRow(), future_field_nobody_declared: 'tolerated' }
  const r = run([row])
  assert.equal(r.summary.events.value, 1)
  assert.equal(r.summary.tokensAvoided.value, 8400)
})

test('a missing field is read as null rather than throwing', () => {
  const row = { ...dispatchedRow() }
  delete row.worker_total_cost
  delete row.latency_ms
  const r = run([row])
  assert.equal(r.summary.events.value, 1)
  assert.equal(r.summary.workerCost.value, null)
  assert.equal(r.latency.total.unmeasuredRows, 1)
})

/* ---------------------------------------------------------- the row tallies */

test('missing usage, cost, latency and savings are each counted separately', () => {
  const r = run([
    dispatchedRow(),
    errorRow(),
    dispatchedRow({ worker_usage_source: 'provider_partial' }),
    pricedRow(),
  ])
  const rows = r.dataQuality.rows
  assert.equal(rows.missingUsage, 1, 'the error row reported no usage')
  assert.equal(rows.partialUsage, 1)
  assert.equal(rows.knownCost, 1)
  assert.equal(rows.missingCost, 3)
  assert.equal(rows.missingSavings, 1, 'the error row has no avoided figure')
})

test('a gate row is never counted as a missing cost, because it never made a call', () => {
  // Counting it would report a structural fact as a data-quality problem and would make cost
  // coverage look broken on a perfectly healthy store.
  const r = run([gateRow(), gateRow(), pricedRow()])
  assert.equal(r.dataQuality.rows.missingCost, 0)
  assert.equal(r.dataQuality.rows.knownCost, 1)
})

test('an unknown enum is counted and the field that carried it is named', () => {
  const r = run([
    dispatchedRow({
      routing_reason: 'quantum_tunnelling',
      validation_warnings: 1,
      validation_codes: 'unknown_enum:routing_reason',
    }),
  ])
  assert.equal(r.dataQuality.rows.unknownEnums, 1)
  assert.deepEqual(r.dataQuality.rows.unknownEnumFields, { routing_reason: 1 })
  assert.ok(ids(r).includes('unknown_enum_values'))
})

test('a shed record is counted under its own name, not under either other truncation', () => {
  // Three unrelated things are called truncation: a shed RECORD (the sink trimmed it to fit the
  // size guard), a truncated ANSWER (the output hit a cap), and a truncated PROMPT (the provider
  // read less than was sent). Conflating any two misattributes a sink problem to a provider.
  const r = run([
    dispatchedRow({ truncation_steps: 'error_message_safe' }),
    dispatchedRow({ truncated: true }),
    dispatchedRow({ worker_input_truncation_detected: true }),
  ])
  assert.equal(r.dataQuality.rows.shedRecords, 1)
  assert.equal(r.failures.truncatedAnswers.value, 1)
  assert.equal(r.capability.truncationDetected.value, 1)
})

test('a token sum mismatch is a warning and both totals are still reported', () => {
  const r = run([dispatchedRow({ worker_total_tokens: 9999, worker_token_sum_check: 'mismatch' })])
  assert.equal(r.dataQuality.rows.tokenSumMismatch, 1)
  assert.ok(ids(r).includes('token_sum_mismatch'))
  assert.equal(r.workerUsage.totalTokensSummed.value, 9600)
  assert.equal(r.workerUsage.totalTokensReported.value, 9999)
  assert.match(r.workerUsage.reconciliationNote, /never reconciled/)
})

test('a detected prompt truncation is an ERROR, because the call was paid for and discarded', () => {
  const r = run([pricedRow({ worker_input_truncation_detected: true, status: 'skipped' })])
  const condition = r.dataQuality.conditions.find((c) => c.id === 'truncation_detected')
  assert.equal(condition.severity, 'error')
  assert.match(condition.detail, /discarded after the call was paid for/)
})

/* ---------------------------------------------------------- the conditions */

test('every raised condition is declared, with a severity and a blast radius', () => {
  const r = run([dispatchedRow(), gateRow(), errorRow(), denialRow()])
  const violations = []
  for (const c of r.dataQuality.conditions) {
    const declared = DATA_QUALITY_CONDITIONS[c.id]
    if (declared === undefined) violations.push(`${c.id} is undeclared`)
    else {
      if (c.severity !== declared.severity) violations.push(`${c.id}: severity drifted`)
      if (!Array.isArray(c.affects) || c.affects.length === 0) violations.push(`${c.id}: no blast radius`)
      if (typeof c.detail !== 'string' || c.detail === '') violations.push(`${c.id}: no detail`)
    }
  }
  assert.deepEqual(violations, [], 'a condition was raised without being declared')
})

test('severities are tallied so a reader can tell an alarm from a note', () => {
  const r = run([dispatchedRow()], {
    read: mapReadReport({ files: 1, bytes: 1, lines: 2, yielded: 1, skipped: { malformed: 1 }, errors: [], samples: [] }),
  })
  const s = r.dataQuality.severities
  assert.equal(s.error >= 1, true)
  assert.equal(Object.keys(s).sort().join(','), 'error,info,warn')
})

test('an incomplete period is reported, because its last bucket covers a shorter span', () => {
  const r = analyzeRows([dispatchedRow()], { now: NOW, window: { kind: 'today' } })
  assert.equal(r.timeRange.incompletePeriod, true)
  assert.ok(ids(r).includes('incomplete_period'))
})

test('a clean, priced, fully-measured window raises no error or warning at all', () => {
  // The negative control. Without it, a test suite that only ever checks that conditions FIRE
  // would pass just as well with a function that raised everything always.
  const r = run([pricedRow(), gateRow(), pricedRow({ primary_usage_method: 'transcript_measured' })], {
    config: { telemetry: { recordGateDecisions: true } },
    window: { kind: 'all' },
  })
  const bad = r.dataQuality.conditions.filter((c) => c.severity !== 'info')
  assert.deepEqual(bad.map((c) => c.id), [], 'a healthy window must be quiet')
})

test('the data-quality note states the rule the whole section serves', () => {
  assert.match(run([]).dataQuality.note, /never a zero/)
})

/* ----------------------------------------------------------------- security */

test('the reader samples are counted and withheld, never copied through', () => {
  // Each sample is a 120-character excerpt of a RAW telemetry line plus an absolute file path,
  // and a raw line is a whole record — so it can carry question_text, error_message_safe or
  // project_path. The counters are useful; the excerpts are not worth the exposure.
  const r = run([dispatchedRow()], {
    read: mapReadReport({
      files: 1,
      bytes: 1,
      lines: 2,
      yielded: 1,
      skipped: { malformed: 1 },
      errors: [{ file: 'C:/secret/path/events.jsonl', code: 'EACCES' }],
      samples: [{ file: 'C:/secret/path/events.jsonl', excerpt: 'FIXTURE-MUST-NOT-APPEAR-questiontext' }],
    }),
  })
  assert.equal(r.dataQuality.read.samplesWithheld, 1)
  assert.equal('samples' in r.dataQuality.read, false)
  assert.equal('errors' in r.dataQuality.read, false)
  assert.equal(r.dataQuality.read.readErrors, 1, 'the error is counted, not quoted')
  const json = JSON.stringify(r)
  assert.equal(json.includes('FIXTURE-MUST-NOT-APPEAR'), false)
  assert.equal(json.includes('C:/secret/path'), false, 'an absolute store path is not analytics data')
})

/* ----------------------------------------------------------------- coverage */

test('every row is accounted for by exactly one selection verdict', () => {
  const r = analyzeRows(
    [
      dispatchedRow({ timestamp: '2026-03-04T11:00:00.000Z' }),
      dispatchedRow({ timestamp: '2020-01-01T00:00:00.000Z' }),
      dispatchedRow({ timestamp: 'not a timestamp' }),
      dispatchedRow({ timestamp: '2026-03-04T11:00:00.000Z', provider: 'ollama' }),
    ],
    { now: NOW, window: { kind: 'today' }, scope: { provider: 'gemini' } },
  )
  const c = r.coverage
  assert.equal(c.rowsYielded, 4)
  assert.equal(c.rowsInWindow, 1)
  assert.equal(c.rowsOutOfWindow, 1)
  assert.equal(c.rowsUndatable, 1)
  assert.equal(c.rowsOutOfScope, 1)
  assert.equal(c.rowsInWindow + c.rowsOutOfWindow + c.rowsUndatable + c.rowsOutOfScope, c.rowsYielded)
})

test('an undatable row is reported apart from an out-of-window row', () => {
  // A row with an unparseable timestamp has not been excluded by the range; it has failed to say
  // when it happened. Merging the two would make a broken clock look like a quiet afternoon.
  const r = analyzeRows([dispatchedRow({ timestamp: 'garbage' })], { now: NOW, window: { kind: 'today' } })
  assert.equal(r.coverage.rowsUndatable, 1)
  assert.equal(r.coverage.rowsOutOfWindow, 0)
})
