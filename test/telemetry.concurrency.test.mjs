/**
 * Multi-process concurrent appends.
 *
 * This is the EVIDENCE for a claim no specification will give us. POSIX guarantees that a single
 * write() to an O_APPEND fd on a regular local file is atomic with respect to other writers.
 * Windows does not publish an equivalent guarantee: libuv maps O_APPEND to FILE_APPEND_DATA and
 * every Windows log appender relies on it, but Microsoft documents no cross-process atomicity and
 * no size bound. So the claim is empirically true and contractually unspecified, and the only
 * honest way to make it is to run four real processes at one real file and look at the bytes.
 *
 * That is why windows-latest is a GATING platform in CI rather than an informational one.
 *
 * If this test ever fails, the IMPLEMENTATION changes, not the test. The prepared fallback is to
 * default `telemetry.shardByPid` to true on win32, which removes the requirement by construction
 * because each writer then owns a private file.
 *
 * Determinism controls, so a real filesystem test is not a flaky one: a fixed writer count, a
 * fixed record count, index-derived sizes with no randomness, a constant nonce passed from the
 * parent, and a frozen clock in every child.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RECORD_MAX_BYTES, serializeRecord } from '../plugins/model-router/lib/telemetry/contract.mjs'
import { iterRecords, openSink, readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { listSegments } from '../plugins/model-router/lib/telemetry/segments.mjs'
import {
  FROZEN_DATE,
  FROZEN_MS,
  buildProbeRecord,
  checkProbeRecord,
  makeTempDir,
  padToExactly,
} from './helpers/telemetry-dir.mjs'

/** Fixed, not scaled off os.cpus(): a variable writer count makes the count assertion variable. */
const WRITERS = 4
const RECORDS_EACH = 250
const TOTAL = WRITERS * RECORDS_EACH
const NONCE = 'cmr-concurrency-nonce'

const CHILD = fileURLToPath(new URL('./helpers/jsonl-writer-child.mjs', import.meta.url))

/** Resolves on 'close', not 'exit' — close guarantees the child's stdio has drained. */
function runChild(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, CMR_TEST_WRITER: JSON.stringify(spec) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    })
    let out = ''
    let err = ''
    let readySeen = false
    const ready = []
    child.stdout.on('data', (d) => {
      out += d.toString()
      if (!readySeen && out.includes('ready')) {
        readySeen = true
        ready.forEach((fn) => fn())
      }
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      // Reject with the child's stderr attached, so a crash reads as a crash rather than
      // surfacing later as an inexplicable count mismatch.
      if (code !== 0) {
        reject(new Error(`writer ${spec.writerIndex} exited ${code}/${signal}: ${err.trim() || '(no stderr)'}`))
        return
      }
      resolve({ pid: child.pid, out, err })
    })
    child.whenReady = () => new Promise((r) => (readySeen ? r() : ready.push(r)))
    spec.__handle = child
  })
}

/** The caller owns the temp dir and must call cleanup() — the assertions read the files. */
async function runScenario({ shardByPid }) {
  const tmp = makeTempDir(`concurrency-${shardByPid ? 'sharded' : 'shared'}`)
  const specs = []
  const promises = []
  for (let i = 0; i < WRITERS; i++) {
    const spec = {
      dir: tmp.dir,
      writerIndex: i,
      records: RECORDS_EACH,
      nonce: NONCE,
      frozenMs: FROZEN_MS,
      shardByPid,
      barrier: true,
    }
    specs.push(spec)
    promises.push(runChild(spec))
  }

  // Release every writer at once, so they contend. Capped, and NOTHING ASSERTS ON IT — if the
  // barrier never fires the test still passes, it just proves less.
  await Promise.all(specs.map((s) => s.__handle?.whenReady?.() ?? Promise.resolve())).catch(() => {})
  fs.writeFileSync(path.join(tmp.dir, '.start'), 'go')

  const results = await Promise.all(promises)
  const childPids = results.map((r) => r.pid).sort((a, b) => a - b)

  const segments = listSegments({ dir: tmp.dir, fs })
  const { records, report } = readSegmentsSync({ dir: tmp.dir, fs })

  return { tmp, segments, records, report, childPids }
}

function sharedAssertions({ segments, records, report }) {
  // 1. No silent loss.
  assert.equal(report.yielded, TOTAL, `expected ${TOTAL} records, got ${report.yielded}`)
  assert.equal(records.length, TOTAL)

  // 2. Every line parses. A malformed line in the MIDDLE of a segment is the signature of an
  //    append that was not atomic — which is precisely what this test exists to rule out.
  assert.equal(report.skipped.malformed, 0, `malformed lines: ${JSON.stringify(report.samples)}`)
  assert.equal(report.skipped.not_an_object, 0)
  assert.equal(report.skipped.oversize_line, 0)
  assert.equal(report.skipped.unrecognized, 0)

  // 3. Strict, and safe because the parent waited for every child to exit cleanly.
  assert.equal(report.skipped.truncated_tail, 0)

  // 4. No interleaving, on all three independent axes.
  for (const rec of records) {
    const problem = checkProbeRecord(rec, NONCE)
    assert.equal(problem, null, problem ?? '')
  }

  // 5. No duplicates and no gaps: every writer wrote exactly its own 0..N-1.
  const ids = new Set(records.map((r) => r.task_id))
  assert.equal(ids.size, TOTAL, 'duplicate or missing task_id')
  for (let w = 0; w < WRITERS; w++) {
    const seqs = records.filter((r) => r.task_id.startsWith(`w${w}:`)).map((r) => r.input_bytes)
    assert.equal(seqs.length, RECORDS_EACH, `writer ${w} wrote ${seqs.length} records`)
    assert.deepEqual(
      [...seqs].sort((a, b) => a - b),
      Array.from({ length: RECORDS_EACH }, (_, i) => i),
      `writer ${w} seq set is not 0..${RECORDS_EACH - 1}`,
    )
  }

  // 6. Exactly one at-cap record per writer, each still untruncated. The off-by-one guard,
  //    proven under contention rather than in isolation.
  const atCap = records.filter((r) => serializeRecord(r).bytes === RECORD_MAX_BYTES)
  assert.equal(atCap.length, WRITERS, `expected ${WRITERS} at-cap records, got ${atCap.length}`)
  for (const rec of atCap) assert.equal(rec.truncation_steps, null)

  // 7. The most direct possible test of "one record = one line": count the newline bytes.
  const raw = Buffer.concat(segments.map((s) => fs.readFileSync(s.file)))
  assert.equal(raw.at(-1), 0x0a, 'file does not end in a newline')
  let newlines = 0
  for (const b of raw) if (b === 0x0a) newlines += 1
  assert.equal(newlines, TOTAL, `expected ${TOTAL} newline bytes, found ${newlines}`)

  // 8. LF only, even on Windows: a segment written here must parse byte-identically on Linux.
  assert.equal(raw.includes('\r\n'), false, 'found CRLF in a segment')
}

test('four concurrent writers append 1000 intact records to one shared file', async () => {
  const outcome = await runScenario({ shardByPid: false })
  try {
    // Without this, the test could silently degrade into the sharded case and stop being an
    // atomicity test at all.
    assert.equal(outcome.segments.length, 1, `expected one shared segment, got ${outcome.segments.length}`)
    assert.equal(outcome.segments[0].name, `events-${FROZEN_DATE}.jsonl`)
    sharedAssertions(outcome)
  } finally {
    outcome.tmp.cleanup()
  }
})

test('four concurrent writers with shardByPid write four files and lose nothing', async () => {
  const outcome = await runScenario({ shardByPid: true })
  try {
    assert.equal(outcome.segments.length, WRITERS)
    const pids = outcome.segments.map((s) => s.pid).sort((a, b) => a - b)
    assert.deepEqual(pids, outcome.childPids, 'segment pids do not match the child pids')
    for (const seg of outcome.segments) {
      assert.match(seg.name, new RegExp(`^events-${FROZEN_DATE}\\.p\\d+\\.jsonl$`))
    }
    sharedAssertions(outcome)

    // Each shard holds exactly one writer's records — the property that makes shardByPid a safe
    // escape hatch on filesystems where cross-writer append atomicity does not hold.
    for (const seg of outcome.segments) {
      const perFile = [...iterRecords(seg.file, { fs })]
      assert.equal(perFile.length, RECORDS_EACH, `shard ${seg.name} holds ${perFile.length} records`)
      const writers = new Set(perFile.map((r) => r.task_id.split(':')[0]))
      assert.equal(writers.size, 1, `shard ${seg.name} mixes writers: ${[...writers].join(',')}`)
    }
  } finally {
    outcome.tmp.cleanup()
  }
})

/* ------------------------------------------------------------- single process */

test('a thousand records from one process produce a thousand parseable lines', () => {
  // Fast and spawn-free, so it runs everywhere and catches serializer or fd-cache regressions
  // without paying for four processes.
  const tmp = makeTempDir('concurrency-single')
  try {
    const sink = openSink({ dir: tmp.dir, now: () => FROZEN_MS, pid: 4242 })
    for (let seq = 0; seq < 1000; seq++) {
      const res = sink.append(buildProbeRecord({ writerIndex: 0, seq, padLen: 100 + (seq % 500), nonce: NONCE }))
      assert.equal(res.ok, true, res.reason ?? '')
    }
    sink.close()

    const { records, report } = readSegmentsSync({ dir: tmp.dir, fs })
    assert.equal(report.yielded, 1000)
    assert.equal(report.skipped.malformed, 0)
    assert.equal(records.length, 1000)
    for (const rec of records) assert.equal(checkProbeRecord(rec, NONCE), null)
  } finally {
    tmp.cleanup()
  }
})

test('a writer killed mid-run leaves a readable file and at most one unparseable tail line', async () => {
  // Bounds, never exact counts, so this cannot flake on scheduling. The expected outcome is
  // actually truncated_tail === 0: because one record is one write, a kill lands BETWEEN records
  // rather than inside one. So this test also documents the benefit of the design.
  const tmp = makeTempDir('concurrency-kill')
  try {
    const spec = {
      dir: tmp.dir,
      writerIndex: 0,
      records: 5000,
      nonce: NONCE,
      frozenMs: FROZEN_MS,
      shardByPid: false,
      barrier: false,
    }
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, CMR_TEST_WRITER: JSON.stringify(spec) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const closed = new Promise((resolve) => child.on('close', resolve))
    // Wait until the file has some content, then kill hard. TerminateProcess on Windows.
    const segment = path.join(tmp.dir, `events-${FROZEN_DATE}.jsonl`)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        if (fs.statSync(segment).size > 50_000) break
      } catch {
        /* not created yet */
      }
    }
    child.kill('SIGKILL')
    await closed

    const { records, report } = readSegmentsSync({ dir: tmp.dir, fs })
    assert.equal(report.skipped.malformed, 0, 'a kill must not corrupt a completed line')
    assert.ok(report.skipped.truncated_tail <= 1, `truncated_tail was ${report.skipped.truncated_tail}`)
    assert.ok(report.yielded >= 1, 'nothing was readable after the kill')
    for (const rec of records) assert.equal(checkProbeRecord(rec, NONCE), null)
  } finally {
    tmp.cleanup()
  }
})
