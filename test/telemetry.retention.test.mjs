/**
 * Segment naming, listing and retention.
 *
 * Retention selects on the FILENAME DATE, never on mtime: a cloud-sync rehydrate, a restore, a
 * git checkout or an antivirus touch rewrites mtime, so mtime-based retention would delete the
 * wrong files. Filename dates make the whole thing testable with a frozen clock and no real
 * aging, which is why these tests can be exact.
 *
 * The other property under test is that the pruner and the reader share ONE definition of a
 * segment. That is the guarantee retention cannot delete a file the reader would have read.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  MIN_KEEP_DAYS,
  compareSegments,
  isSegmentName,
  listSegments,
  parseSegmentName,
  segmentName,
  selectForPrune,
  shiftDateKey,
  utcDateKey,
} from '../plugins/model-router/lib/telemetry/segments.mjs'
import { pruneSegments } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { FROZEN_DATE, FROZEN_MS, makeTempDir } from './helpers/telemetry-dir.mjs'

/* -------------------------------------------------------------------- naming */

test('the date key is UTC and spec-pinned, not locale-dependent', () => {
  assert.equal(utcDateKey(FROZEN_MS), FROZEN_DATE)
  assert.equal(utcDateKey(Date.parse('2026-12-31T23:59:59.999Z')), '2026-12-31')
  assert.equal(utcDateKey(Date.parse('2027-01-01T00:00:00.000Z')), '2027-01-01')
})

test('segment names cover all four rotation and sharding combinations', () => {
  assert.equal(segmentName({ rotation: 'daily', shardByPid: false, now: FROZEN_MS }), `events-${FROZEN_DATE}.jsonl`)
  assert.equal(segmentName({ rotation: 'daily', shardByPid: true, now: FROZEN_MS, pid: 48213 }), `events-${FROZEN_DATE}.p48213.jsonl`)
  assert.equal(segmentName({ rotation: 'none', shardByPid: false }), 'events.jsonl')
  assert.equal(segmentName({ rotation: 'none', shardByPid: true, pid: 48213 }), 'events.p48213.jsonl')
})

test('a name is parsed back into its date and pid', () => {
  assert.deepEqual(parseSegmentName('events-2026-03-04.jsonl'), { date: '2026-03-04', pid: null })
  assert.deepEqual(parseSegmentName('events-2026-03-04.p99.jsonl'), { date: '2026-03-04', pid: 99 })
  assert.deepEqual(parseSegmentName('events.jsonl'), { date: null, pid: null })
  assert.deepEqual(parseSegmentName('events.p99.jsonl'), { date: null, pid: 99 })
})

test('an impossible calendar date is rejected rather than silently rolled over', () => {
  // Date.parse would turn 2026-02-31 into 2026-03-03, and the pruner selects on this date.
  assert.equal(parseSegmentName('events-2026-02-31.jsonl'), null)
  assert.equal(parseSegmentName('events-2026-13-01.jsonl'), null)
  assert.equal(parseSegmentName('events-9999-99-99.jsonl'), null)
})

test('anything that is not a segment is not recognised as one', () => {
  for (const n of [
    'events.jsonl.gz',
    'events-2026-03-04.jsonl.bak',
    'events.tmp',
    'router.sqlite',
    'router.sqlite-wal',
    'notes.txt',
    'Events-2026-03-04.jsonl',
    'events-2026-3-4.jsonl',
    'prefix-events-2026-03-04.jsonl',
    'events-2026-03-04.jsonlx',
    '.doctor-123',
    '.salt',
  ]) {
    assert.equal(isSegmentName(n), false, n)
  }
})

test('undated segments sort before dated ones, so a mixed-mode directory still reads in order', () => {
  const segs = [
    { name: 'b', date: '2026-03-05', pid: null },
    { name: 'a', date: null, pid: null },
    { name: 'c', date: '2026-03-04', pid: 2 },
    { name: 'd', date: '2026-03-04', pid: 1 },
  ]
  assert.deepEqual([...segs].sort(compareSegments).map((s) => s.name), ['a', 'd', 'c', 'b'])
})

/* ------------------------------------------------------------------- listing */

test('listing skips dot files, non-segments and directories', () => {
  const tmp = makeTempDir('retention-list')
  try {
    for (const n of ['events-2026-03-04.jsonl', 'events-2026-03-05.p7.jsonl', 'events.jsonl']) {
      fs.writeFileSync(path.join(tmp.dir, n), '')
    }
    for (const n of ['.salt', '.doctor-1', 'events.jsonl.gz', 'router.sqlite']) {
      fs.writeFileSync(path.join(tmp.dir, n), '')
    }
    fs.mkdirSync(path.join(tmp.dir, 'events-2026-01-01.jsonl.d'))

    const segs = listSegments({ dir: tmp.dir, fs })
    assert.deepEqual(segs.map((s) => s.name), ['events.jsonl', 'events-2026-03-04.jsonl', 'events-2026-03-05.p7.jsonl'])
  } finally {
    tmp.cleanup()
  }
})

test('a date filter never excludes an undated segment, which can hold any day', () => {
  const tmp = makeTempDir('retention-filter')
  try {
    fs.writeFileSync(path.join(tmp.dir, 'events.jsonl'), '')
    fs.writeFileSync(path.join(tmp.dir, 'events-2026-01-01.jsonl'), '')
    fs.writeFileSync(path.join(tmp.dir, 'events-2026-03-04.jsonl'), '')
    const segs = listSegments({ dir: tmp.dir, fs, from: '2026-03-01', to: '2026-03-31' })
    assert.deepEqual(segs.map((s) => s.name), ['events.jsonl', 'events-2026-03-04.jsonl'])
  } finally {
    tmp.cleanup()
  }
})

test('a missing directory lists as empty rather than throwing', () => {
  assert.deepEqual(listSegments({ dir: path.join('no', 'such', 'dir'), fs }), [])
})

/* ----------------------------------------------------------------- selection */

test('segments strictly older than the cutoff are eligible and the rest are kept', () => {
  const segments = [
    { name: 'events-2025-12-01.jsonl', date: '2025-12-01' },
    { name: 'events-2026-02-02.jsonl', date: '2026-02-02' },
    { name: 'events-2026-03-03.jsonl', date: '2026-03-03' },
    { name: `events-${FROZEN_DATE}.jsonl`, date: FROZEN_DATE },
  ]
  const r = selectForPrune({ segments, retentionDays: 7, now: FROZEN_MS })
  assert.equal(r.cutoff, shiftDateKey(FROZEN_DATE, -7))
  assert.deepEqual(r.eligible.map((s) => s.name), ['events-2025-12-01.jsonl', 'events-2026-02-02.jsonl'])
  assert.equal(r.kept.length, 2)
})

test('a segment exactly at the retention boundary is kept, not deleted', () => {
  const boundary = shiftDateKey(FROZEN_DATE, -7)
  const r = selectForPrune({
    segments: [{ name: `events-${boundary}.jsonl`, date: boundary }],
    retentionDays: 7,
    now: FROZEN_MS,
  })
  assert.equal(r.eligible.length, 0)
})

test('today and yesterday survive even a retention of zero, by a structural floor', () => {
  const yesterday = shiftDateKey(FROZEN_DATE, -1)
  const r = selectForPrune({
    segments: [
      { name: `events-${FROZEN_DATE}.jsonl`, date: FROZEN_DATE },
      { name: `events-${yesterday}.jsonl`, date: yesterday },
    ],
    retentionDays: 0,
    now: FROZEN_MS,
  })
  assert.equal(r.eligible.length, 0)
  assert.equal(MIN_KEEP_DAYS, 1)
})

test('an undated segment is never eligible, so retention is a no-op under rotation none', () => {
  // A real trap: rotation 'none' with retentionDays 7 gives infinite retention. doctor warns on
  // exactly this combination; the behaviour itself is pinned here.
  const r = selectForPrune({
    segments: [{ name: 'events.jsonl', date: null }],
    retentionDays: 1,
    now: FROZEN_MS,
  })
  assert.equal(r.eligible.length, 0)
  assert.match(r.kept[0].reason, /undated/)
})

/* --------------------------------------------------------------- the sweep */

test('pruning deletes only eligible segments and reports what it freed', () => {
  const tmp = makeTempDir('retention-prune')
  try {
    const old = path.join(tmp.dir, 'events-2025-12-01.jsonl')
    const fresh = path.join(tmp.dir, `events-${FROZEN_DATE}.jsonl`)
    const undated = path.join(tmp.dir, 'events.jsonl')
    const foreign = path.join(tmp.dir, 'router.sqlite')
    const salt = path.join(tmp.dir, '.salt')
    fs.writeFileSync(old, 'x'.repeat(100))
    fs.writeFileSync(fresh, 'y')
    fs.writeFileSync(undated, 'z')
    fs.writeFileSync(foreign, 'db')
    fs.writeFileSync(salt, 'deadbeef')

    const r = pruneSegments({ dir: tmp.dir, retentionDays: 7, now: FROZEN_MS, fs })
    assert.deepEqual(r.deleted, ['events-2025-12-01.jsonl'])
    assert.equal(r.bytesFreed, 100)
    assert.equal(fs.existsSync(old), false)

    // The pruner shares isSegmentName with the reader, so it can only ever delete something the
    // reader would have read.
    assert.equal(fs.existsSync(fresh), true)
    assert.equal(fs.existsSync(undated), true)
    assert.equal(fs.existsSync(foreign), true)
    assert.equal(fs.existsSync(salt), true)
  } finally {
    tmp.cleanup()
  }
})

test('a dry run reports without deleting', () => {
  const tmp = makeTempDir('retention-dry')
  try {
    const old = path.join(tmp.dir, 'events-2025-12-01.jsonl')
    fs.writeFileSync(old, 'x')
    const r = pruneSegments({ dir: tmp.dir, retentionDays: 7, now: FROZEN_MS, fs, dryRun: true })
    assert.deepEqual(r.eligible, ['events-2025-12-01.jsonl'])
    assert.deepEqual(r.deleted, ['events-2025-12-01.jsonl'])
    assert.equal(r.dryRun, true)
    assert.equal(fs.existsSync(old), true)
  } finally {
    tmp.cleanup()
  }
})

test('an unlink failure is recorded and the sweep carries on', () => {
  const tmp = makeTempDir('retention-locked')
  try {
    fs.writeFileSync(path.join(tmp.dir, 'events-2025-12-01.jsonl'), 'x')
    fs.writeFileSync(path.join(tmp.dir, 'events-2025-12-02.jsonl'), 'y')
    const fakeFs = {
      ...fs,
      unlinkSync(p) {
        if (p.includes('12-01')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return fs.unlinkSync(p)
      },
    }
    const r = pruneSegments({ dir: tmp.dir, retentionDays: 7, now: FROZEN_MS, fs: fakeFs })
    assert.deepEqual(r.errors, [{ name: 'events-2025-12-01.jsonl', code: 'EBUSY' }])
    assert.deepEqual(r.deleted, ['events-2025-12-02.jsonl'])
  } finally {
    tmp.cleanup()
  }
})

test('pruning an empty or missing store does nothing and reports nothing', () => {
  const r = pruneSegments({ dir: path.join('no', 'such', 'dir'), retentionDays: 7, now: FROZEN_MS, fs })
  assert.equal(r.examined, 0)
  assert.deepEqual(r.deleted, [])
  assert.deepEqual(r.errors, [])
})
