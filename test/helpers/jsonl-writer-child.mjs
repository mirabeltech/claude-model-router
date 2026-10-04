/**
 * One concurrent writer process for test/telemetry.concurrency.test.mjs.
 *
 * Deliberately NOT named *.test.mjs, so `node --test "test/**\/*.test.mjs"` does not pick it up
 * and run it as a suite.
 *
 * Its whole job is to open the real sink against a shared directory and append N self-checking
 * records as fast as it can, so the parent can prove that concurrent appends to one file do not
 * interleave. Its config arrives in ONE env var as JSON rather than in argv: a JSON string in
 * argv runs into Windows CommandLineToArgvW quoting rules around embedded double quotes, which
 * is a pointless source of platform-specific failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import { openSink } from '../../plugins/model-router/lib/telemetry/jsonl.mjs'
import { RECORD_MAX_BYTES, serializeRecord } from '../../plugins/model-router/lib/telemetry/contract.mjs'
import { buildProbeRecord, padToExactly } from './telemetry-dir.mjs'

const spec = JSON.parse(process.env.CMR_TEST_WRITER ?? '{}')
const { dir, writerIndex, records, nonce, frozenMs, shardByPid, barrier } = spec

const sink = openSink({
  dir,
  rotation: 'daily',
  shardByPid,
  // Frozen, so a run across the UTC midnight boundary cannot split the segment.
  now: () => frozenMs,
  pid: process.pid,
})

/**
 * Record sizes are derived from the index, never random: a variable payload makes a failure
 * impossible to reproduce. The last record of each writer sits EXACTLY at the cap, which is what
 * proves a large single write neither interleaves nor comes back short.
 */
function padFor(seq) {
  if (seq === records - 1) {
    return padToExactly({
      writerIndex,
      seq,
      nonce,
      targetBytes: RECORD_MAX_BYTES,
      serialize: (r) => serializeRecord(r),
    })
  }
  if (seq >= records - 10) return 8192
  return 200 + ((seq * 7) % 600)
}

/* Contention barrier. The parent creates `.start` once every child has announced itself, so all
 * writers hit the file at the same moment. Dot-prefixed, so the reader and the pruner skip it by
 * the convention they already follow.
 *
 * CRUCIALLY, NO ASSERTION DEPENDS ON THE BARRIER. If it never fires the test still passes; it
 * just proves less. That is how a real filesystem test avoids being flaky. */
function waitForStart() {
  if (!barrier) return
  const flag = path.join(dir, '.start')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(flag)) return
    } catch {
      return
    }
  }
}

process.stdout.write('ready\n')
waitForStart()

let failures = 0
for (let seq = 0; seq < records; seq++) {
  const padLen = padFor(seq)
  if (padLen === null) {
    process.stderr.write(`writer ${writerIndex}: could not build an at-cap record for seq ${seq}\n`)
    process.exit(2)
  }
  const res = sink.append(buildProbeRecord({ writerIndex, seq, padLen, nonce }))
  if (!res.ok) {
    failures += 1
    process.stderr.write(`writer ${writerIndex}: append failed at seq ${seq}: ${res.reason}\n`)
  }
}

sink.close()

if (failures > 0) process.exit(3)
process.exit(0)
