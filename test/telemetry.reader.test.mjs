/**
 * Reading a store that has been damaged, edited by hand, or caught mid-write.
 *
 * The reader's contract is: NEVER THROW, NEVER SILENTLY DROP. Every anomaly is counted on the
 * report, so "1 204 events, 0 malformed" is a claim the dashboard can actually print.
 *
 * The distinction that earns its keep is `truncated_tail` versus `malformed`. An unparseable
 * final line is benign — a writer is mid-flight. An unparseable line in the MIDDLE of a file is
 * field-detectable evidence that append atomicity failed on this machine, which is exactly the
 * property no specification guarantees on Windows or on a network volume.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { iterRecords, readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { READ_MAX_LINE_BYTES, emptyReadReport } from '../plugins/model-router/lib/telemetry/contract.mjs'
import { FROZEN_DATE, makeTempDir } from './helpers/telemetry-dir.mjs'

const rec = (n, extra = {}) => JSON.stringify({ schema_version: 1, event_id: `e${n}`, task_id: `t${n}`, ...extra })

/** Write a segment with exact bytes, so CRLF and BOM cases are byte-for-byte reproducible. */
function withSegment(label, body, fn) {
  const tmp = makeTempDir(label)
  try {
    const file = path.join(tmp.dir, `events-${FROZEN_DATE}.jsonl`)
    fs.writeFileSync(file, body)
    const report = emptyReadReport()
    const records = [...iterRecords(file, { fs, report })]
    return fn({ records, report, file, dir: tmp.dir })
  } finally {
    tmp.cleanup()
  }
}

test('a clean file yields every record and reports no anomalies', () => {
  withSegment('reader-clean', `${rec(1)}\n${rec(2)}\n${rec(3)}\n`, ({ records, report }) => {
    assert.equal(records.length, 3)
    assert.equal(report.yielded, 3)
    // A trailing newline produces no phantom final line at all: the carry is empty, so there is
    // nothing to handle. A healthy file therefore reports zero skips of every kind.
    assert.equal(report.lines, 3)
    assert.equal(report.skipped.blank, 0)
    assert.equal(report.skipped.malformed, 0)
  })
})

test('a trailing newline is free and is never reported as malformed', () => {
  withSegment('reader-trailing', `${rec(1)}\n`, ({ report }) => {
    assert.equal(report.yielded, 1)
    assert.equal(report.skipped.malformed, 0)
    assert.equal(report.skipped.truncated_tail, 0)
  })
})

test('a blank line and a whitespace-only line are skipped as blank, not malformed', () => {
  withSegment('reader-blank', `${rec(1)}\n\n   \n${rec(2)}\n`, ({ records, report }) => {
    assert.equal(records.length, 2)
    assert.equal(report.skipped.blank, 2)
    assert.equal(report.skipped.malformed, 0)
  })
})

test('a comment line is skipped under its own counter', () => {
  withSegment('reader-comment', `# a note\n${rec(1)}\n`, ({ records, report }) => {
    assert.equal(records.length, 1)
    assert.equal(report.skipped.comment, 1)
    assert.equal(report.skipped.malformed, 0)
  })
})

test('CRLF line endings parse identically to LF', () => {
  withSegment('reader-crlf', `${rec(1)}\r\n${rec(2)}\r\n`, ({ records, report }) => {
    assert.equal(records.length, 2)
    assert.equal(report.skipped.malformed, 0)
    assert.equal(records[0].event_id, 'e1')
  })
})

test('a doubled carriage return is treated as data, not as two line endings', () => {
  withSegment('reader-crcr', `${JSON.stringify({ schema_version: 1, model: 'a\r' })}\r\n`, ({ records, report }) => {
    assert.equal(report.skipped.malformed, 0)
    assert.equal(records[0].model, 'a\r', 'only one trailing CR is stripped')
  })
})

test('a UTF-8 BOM at the start of the file is stripped — PowerShell writes one', () => {
  withSegment('reader-bom', `﻿${rec(1)}\n${rec(2)}\n`, ({ records, report }) => {
    assert.equal(records.length, 2)
    assert.equal(report.skipped.malformed, 0)
  })
})

test('a BOM anywhere other than the first bytes falls through to the malformed path', () => {
  withSegment('reader-bom-mid', `${rec(1)}\n﻿${rec(2)}\n`, ({ report }) => {
    assert.equal(report.yielded, 1)
    assert.equal(report.skipped.malformed, 1)
  })
})

test('a malformed line in the middle of a file is counted as malformed, with a sample', () => {
  withSegment('reader-mid', `${rec(1)}\n{"schema_version":1,"brok\n${rec(2)}\n`, ({ records, report }) => {
    assert.equal(records.length, 2, 'the surrounding good records still read')
    assert.equal(report.skipped.malformed, 1)
    assert.equal(report.skipped.truncated_tail, 0, 'a mid-file break is not a tail')
    assert.equal(report.samples.length, 1)
    assert.equal(report.samples[0].reason, 'malformed')
    assert.equal(report.samples[0].lineNo, 2)
  })
})

test('an unparseable final line is a truncated tail, not a malformed line', () => {
  withSegment('reader-tail', `${rec(1)}\n{"schema_version":1,"half`, ({ records, report }) => {
    assert.equal(records.length, 1)
    assert.equal(report.skipped.truncated_tail, 1)
    assert.equal(report.skipped.malformed, 0, 'a mid-flight writer must not look like corruption')
  })
})

test('a complete but unterminated final line is yielded and counted', () => {
  withSegment('reader-unterminated', `${rec(1)}\n${rec(2)}`, ({ records, report }) => {
    assert.equal(records.length, 2)
    assert.equal(report.skipped.unterminated_tail_parsed, 1)
    assert.equal(report.skipped.truncated_tail, 0)
  })
})

test('a parsed non-object is skipped under its own counter', () => {
  withSegment('reader-nonobject', `[1,2]\n"a string"\n42\nnull\n${rec(1)}\n`, ({ records, report }) => {
    assert.equal(records.length, 1)
    assert.equal(report.skipped.not_an_object, 4)
    assert.equal(report.skipped.malformed, 0)
  })
})

test('an object with no numeric schema_version is unrecognized rather than yielded', () => {
  withSegment('reader-shapeless', `{"hello":"world"}\n{"schema_version":"1"}\n${rec(1)}\n`, ({ records, report }) => {
    assert.equal(records.length, 1)
    assert.equal(report.skipped.unrecognized, 2)
  })
})

test('a newer schema_version is yielded — forward compatibility is the aggregator\'s filter', () => {
  withSegment('reader-future', `${rec(1, { schema_version: 99 })}\n`, ({ records, report }) => {
    assert.equal(records.length, 1, 'the reader stays dumb and hands the row on')
    assert.equal(records[0].schema_version, 99)
    assert.equal(report.skipped.unrecognized, 0)
  })
})

test('an unknown enum value is preserved verbatim and never rejected', () => {
  withSegment('reader-enum', `${rec(1, { task_type: 'weird', routing_decision: 'sideways' })}\n`, ({ records }) => {
    assert.equal(records[0].task_type, 'weird')
    assert.equal(records[0].routing_decision, 'sideways')
  })
})

test('an unknown extra field is ignored and the row still reads', () => {
  withSegment('reader-extra', `${rec(1, { future_field: 7 })}\n`, ({ records }) => {
    assert.equal(records[0].future_field, 7)
    assert.equal(records[0].event_id, 'e1')
  })
})

test('an oversize line is counted and the reader resyncs at the next record', () => {
  const huge = `{"schema_version":1,"pad":"${'x'.repeat(READ_MAX_LINE_BYTES + 1000)}"}`
  withSegment('reader-oversize', `${rec(1)}\n${huge}\n${rec(2)}\n`, ({ records, report }) => {
    assert.equal(report.skipped.oversize_line, 1)
    const ids = records.map((r) => r.event_id)
    assert.ok(ids.includes('e1'))
    assert.ok(ids.includes('e2'), 'the reader must recover after an oversize line')
  })
})

test('a file with no newline at all does not grow the carry buffer without bound', () => {
  const huge = `{"schema_version":1,"pad":"${'x'.repeat(READ_MAX_LINE_BYTES * 2)}"}`
  withSegment('reader-noline', huge, ({ records, report }) => {
    assert.equal(report.skipped.oversize_line, 1)
    assert.equal(records.length, 0)
  })
})

test('a sample excerpt is redacted and bounded', () => {
  const leaky = `{"broken":"AIzaSYSOMETHINGSECRET1234567890","x":${'1'.repeat(400)}`
  withSegment('reader-redact', `${leaky}\n${rec(1)}\n`, ({ report }) => {
    assert.equal(report.samples.length, 1)
    assert.ok(report.samples[0].excerpt.length <= 120)
    assert.equal(report.samples[0].excerpt.includes('AIzaSY'), false)
  })
})

test('an unreadable file becomes a reported error rather than an exception', () => {
  const report = emptyReadReport()
  const records = [...iterRecords(path.join('does', 'not', 'exist.jsonl'), { fs, report })]
  assert.equal(records.length, 0)
  assert.equal(report.errors.length, 1)
  assert.equal(report.files, 0)
})

/* ----------------------------------------------------------- directory level */

test('the reader skips dot files, unknown extensions and directories', () => {
  const tmp = makeTempDir('reader-skips')
  try {
    fs.writeFileSync(path.join(tmp.dir, `events-${FROZEN_DATE}.jsonl`), `${rec(1)}\n`)
    fs.writeFileSync(path.join(tmp.dir, '.doctor-123'), 'probe')
    fs.writeFileSync(path.join(tmp.dir, '.salt'), 'deadbeefdeadbeef')
    fs.writeFileSync(path.join(tmp.dir, '.start'), 'go')
    fs.writeFileSync(path.join(tmp.dir, 'events.jsonl.gz'), 'binary')
    fs.writeFileSync(path.join(tmp.dir, `events-${FROZEN_DATE}.jsonl.bak`), 'backup')
    fs.writeFileSync(path.join(tmp.dir, 'router.sqlite'), 'db')
    fs.writeFileSync(path.join(tmp.dir, 'notes.txt'), 'hello')
    fs.mkdirSync(path.join(tmp.dir, 'events-2026-01-01.jsonl.d'))

    const { records, report } = readSegmentsSync({ dir: tmp.dir, fs })
    assert.equal(records.length, 1)
    assert.equal(report.files, 1, 'exactly one file was opened')
    assert.equal(report.errors.length, 0)
  } finally {
    tmp.cleanup()
  }
})

test('a missing store directory reads as an empty store, not an error', () => {
  const { records, report } = readSegmentsSync({ dir: path.join('no', 'such', 'dir'), fs })
  assert.equal(records.length, 0)
  assert.equal(report.errors.length, 0)
})

test('undated and dated segments can coexist after a rotation change', () => {
  const tmp = makeTempDir('reader-mixed')
  try {
    fs.writeFileSync(path.join(tmp.dir, 'events.jsonl'), `${rec(1)}\n`)
    fs.writeFileSync(path.join(tmp.dir, `events-${FROZEN_DATE}.jsonl`), `${rec(2)}\n`)
    const { records } = readSegmentsSync({ dir: tmp.dir, fs })
    assert.equal(records.length, 2)
    assert.equal(records[0].event_id, 'e1', 'undated segments sort first')
  } finally {
    tmp.cleanup()
  }
})
