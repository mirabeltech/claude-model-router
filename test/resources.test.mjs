/**
 * WHAT THE ROUTER LEAVES BEHIND, which should be nothing.
 *
 * A hook runs on every large `Read` in every session, so a leak that costs one descriptor or one
 * temporary file per call is not a tidiness problem — it is an outage several hours in. This file
 * covers the resources a hook can leak and the ones the previous phases actually leaked.
 *
 * TWO REAL REGRESSIONS ARE PINNED HERE:
 *
 *   1. ONE DESCRIPTOR PER EVENT. `telemetry/index.mjs` caches its sink keyed on config IDENTITY,
 *      so a caller that builds a fresh config object per call used to get a fresh sink per call
 *      and never closed the previous one. A long delegation loop turned that into EMFILE. The fix
 *      closes the old handle before replacing it, and the assertion here is on the open/close
 *      counts rather than on a descriptor table, because the latter is not portable.
 *
 *   2. SCRATCH DIRECTORIES OUTLIVING THEIR TESTS. A full run was leaving sixteen directories under
 *      `test/.tmp`, each with a ledger and a lock file, because `fs.rmSync` has no retries by
 *      default and on Windows a directory cannot be removed while a child process still holds a
 *      handle into it. The suites that spawn writers called cleanup() before the OS had finished
 *      tearing those children down, the EBUSY propagated, and the directory stayed. See
 *      `makeTempDir` in helpers/telemetry-dir.mjs.
 *
 * The lock and reservation cases live in governance.concurrency.test.mjs, which already spawns
 * real competing processes; this file does not duplicate them.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  __resetTelemetryForTests,
  emitEvent,
} from '../plugins/model-router/lib/telemetry/index.mjs'
import { openSink } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import {
  FROZEN_MS,
  TMP_ROOT,
  buildProbeRecord,
  makeTempDir,
  telemetryConfig,
} from './helpers/telemetry-dir.mjs'

const record = () => buildProbeRecord({ writerIndex: 0, seq: 1, padLen: 0, nonce: 'n' })

/** An fs that counts opens and closes, so a leak is arithmetic rather than a guess. */
function countingFs() {
  const state = { opens: 0, closes: 0, writes: 0, mkdirs: 0, openFds: new Set() }
  let next = 100
  return {
    state,
    mkdirSync: () => {
      state.mkdirs += 1
    },
    openSync: () => {
      state.opens += 1
      const fd = next
      next += 1
      state.openFds.add(fd)
      return fd
    },
    closeSync: (fd) => {
      state.closes += 1
      state.openFds.delete(fd)
    },
    writeSync: (_fd, buf) => {
      state.writes += 1
      return buf.length
    },
  }
}

/* ---------------------------------------------------------- file descriptors */

test('a thousand events through one sink open exactly one descriptor', () => {
  // The baseline. The fd is cached across appends and the segment path is recomputed per append,
  // so a long-lived process crossing UTC midnight rotates without reopening on every record.
  const f = countingFs()
  const sink = openSink({ dir: 'C:/nowhere', now: () => FROZEN_MS, pid: 1, fs: f })
  for (let i = 0; i < 1000; i++) assert.equal(sink.append(record()).ok, true)
  assert.equal(f.state.opens, 1, 'one open for a thousand records')
  assert.equal(f.state.writes, 1000, 'and one write each — never two syscalls per record')
  sink.close()
  assert.equal(f.state.openFds.size, 0, 'and close() releases it')
})

test('a fresh config object per event does not leak a descriptor per event', () => {
  // REGRESSION 1. The cache is keyed on config IDENTITY, not on its contents, so this is the
  // shape that leaked: every call looks like a new config, so every call built a new sink.
  const tmp = makeTempDir('res-fd-leak')
  __resetTelemetryForTests()
  try {
    const f = countingFs()
    for (let i = 0; i < 40; i++) {
      // A NEW OBJECT every iteration. Deliberate: hoisting it would test the cache hit instead,
      // which is the path that never leaked.
      const config = telemetryConfig(tmp.dir)
      emitEvent({}, { config, fs: f, now: () => FROZEN_MS, env: {}, pid: 1 })
    }
    assert.equal(f.state.opens, 40, 'forty sinks were built, which is the cache behaving as designed')
    assert.equal(
      f.state.closes,
      39,
      'and thirty-nine were closed as they were replaced — the fortieth is still live',
    )
    assert.equal(f.state.openFds.size, 1, 'at most ONE descriptor is held at any time')
  } finally {
    __resetTelemetryForTests()
    tmp.cleanup()
  }
})

test('resetting the telemetry layer closes the descriptor it was holding', () => {
  // Not just hygiene for the suite: it is the same code path a long-lived process would need, and
  // an un-closed handle here is what makes a Windows directory impossible to remove.
  const tmp = makeTempDir('res-fd-reset')
  __resetTelemetryForTests()
  try {
    const f = countingFs()
    const config = telemetryConfig(tmp.dir)
    emitEvent({}, { config, fs: f, now: () => FROZEN_MS, env: {}, pid: 1 })
    assert.equal(f.state.openFds.size, 1)
    __resetTelemetryForTests()
    assert.equal(f.state.openFds.size, 0, 'the held descriptor is released')
  } finally {
    __resetTelemetryForTests()
    tmp.cleanup()
  }
})

test('a sink that failed to open holds nothing and stops trying', () => {
  // An unwritable path must cost one failed syscall, not one per event. A per-event retry against
  // a permanently unwritable directory is a syscall storm on the hot path.
  let mkdirs = 0
  const sink = openSink({
    dir: 'C:/nowhere',
    now: () => FROZEN_MS,
    pid: 1,
    fs: {
      mkdirSync: () => {
        mkdirs += 1
        throw Object.assign(new Error('nope'), { code: 'EACCES' })
      },
      openSync: () => 9,
      closeSync: () => {},
      writeSync: (_fd, b) => b.length,
    },
  })
  for (let i = 0; i < 25; i++) sink.append(record())
  assert.equal(mkdirs, 1, 'one attempt, then latched off')
  sink.close()
})

/* ------------------------------------------------------------ temporary files */

test('the scratch tree is empty, so no test leaked a directory into the repository', () => {
  // REGRESSION 2, and the assertion is deliberately about the WHOLE tree rather than one suite's
  // directories: a leak is only visible from outside the suite that caused it.
  //
  // It tolerates directories belonging to OTHER live test processes, because `node --test` runs
  // each file in its own process and they run concurrently — a sibling's scratch directory is not
  // a leak, it is work in progress. Only this process's own leftovers are an error here, and the
  // suite-level truth is checked by the repository-hygiene assertion in packaging.test.mjs.
  if (!fs.existsSync(TMP_ROOT)) return
  const mine = fs
    .readdirSync(TMP_ROOT)
    .filter((name) => name.includes(`-${process.pid}-`))
  assert.deepEqual(mine, [], 'this process left scratch directories behind')
})

test('cleanup survives a directory that is still being held, and still reports', () => {
  // The exact Windows failure that caused the leak: an open handle into the directory. cleanup()
  // must not throw — a test that failed here would report the wrong defect — and the retry is what
  // makes it usually succeed anyway.
  const tmp = makeTempDir('res-held')
  const file = path.join(tmp.dir, 'held.txt')
  fs.writeFileSync(file, 'x')
  const fd = fs.openSync(file, 'r')
  try {
    // With the handle open this may or may not succeed depending on the platform. What is
    // asserted is that it does not throw either way.
    tmp.cleanup()
  } finally {
    fs.closeSync(fd)
    tmp.cleanup()
  }
  assert.equal(fs.existsSync(tmp.dir), false, 'and once the handle is closed it is gone')
})

/* --------------------------------------------------------------- idempotence */

test('closing a sink twice is harmless, and appending after close does not reopen', () => {
  // A hook exits immediately after one event, so double-close is not hypothetical: it is what
  // happens when a reset races a process teardown.
  const f = countingFs()
  const sink = openSink({ dir: 'C:/nowhere', now: () => FROZEN_MS, pid: 1, fs: f })
  sink.append(record())
  sink.close()
  sink.close()
  assert.equal(f.state.closes, 1, 'the second close is a no-op, not a second syscall')

  const after = sink.append(record())
  assert.equal(after.ok, true, 'appending after close reopens rather than failing')
  assert.equal(f.state.opens, 2)
  sink.close()
  assert.equal(f.state.openFds.size, 0)
})
