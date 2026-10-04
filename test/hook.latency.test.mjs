/**
 * What the hook costs, measured rather than asserted in prose.
 *
 * This hook runs on every Read in every session where the plugin is enabled, including Claude
 * Code's own internal reads, so its cost is paid constantly and its benefit only occasionally.
 * The numbers these tests print are the ones quoted in docs/hook-integration.md; the budgets they
 * assert are deliberately loose, because a CI runner under load is not a benchmark rig and a
 * flaky performance test gets deleted instead of fixed.
 *
 * What matters is the SHAPE of the cost, and two properties keep it flat:
 *
 *   - The non-delegating path reads metadata and a bounded transcript tail. It never reads the
 *     file, never resolves a provider module and never opens a socket.
 *   - The transcript scan is bounded by bytes, not by session length, so the thousandth Read of a
 *     session costs what the first one did.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { recentlyEdited } from '../plugins/model-router/lib/hook/facts.mjs'
import { hookConfig, hookEnv, makeWorkspace, readStdin, runHookProcess } from './helpers/hook-payload.mjs'
import { median } from './helpers/timing.mjs'

test('the in-process cost of a read that is not delegated', async (t) => {
  const ws = makeWorkspace('latency-refuse', { bytes: 200 })
  try {
    const config = hookConfig()
    const raw = readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } })
    const ms = await median(30, () =>
      runReadHook({ raw, config, env: hookEnv('http://127.0.0.1:1'), emit: () => null }),
    )
    t.diagnostic(`non-delegating decision: ${ms.toFixed(2)} ms (median of 30, in process)`)
    assert.ok(ms < 100, `${ms.toFixed(2)}ms is too slow for a decision made from metadata alone`)
  } finally {
    ws.cleanup()
  }
})

test('the cost does not grow with the size of the file that is not delegated', async (t) => {
  // The decision is made from `statSync` alone, so a 10 MB file must cost what a 1 KB file costs.
  // If this ever regresses it means something started reading the file to decide about it.
  const small = makeWorkspace('latency-small', { bytes: 1_000 })
  const big = makeWorkspace('latency-big', { bytes: 4_000_000 })
  try {
    const config = hookConfig({}, { worker: { maxInputBytes: 1024 } })
    const time = (ws) =>
      median(20, () =>
        runReadHook({
          raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
          config,
          env: hookEnv('http://127.0.0.1:1'),
          emit: () => null,
        }),
      )
    const smallMs = await time(small)
    const bigMs = await time(big)
    t.diagnostic(`1 KB file: ${smallMs.toFixed(2)} ms | 4 MB file: ${bigMs.toFixed(2)} ms`)
    assert.ok(bigMs < smallMs + 50, `a 4 MB refusal cost ${bigMs.toFixed(2)}ms vs ${smallMs.toFixed(2)}ms`)
  } finally {
    small.cleanup()
    big.cleanup()
  }
})

test('the cost does not grow with the length of the session transcript', async (t) => {
  const ws = makeWorkspace('latency-transcript', { bytes: 1_000 })
  try {
    const line = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(500) } })}\n`
    const write = (bytes) =>
      fs.writeFileSync(ws.transcript, line.repeat(Math.ceil(bytes / Buffer.byteLength(line))))

    write(64 * 1024)
    const shortMs = await median(20, () => recentlyEdited(ws.transcript, ws.file))
    write(16 * 1024 * 1024)
    const longMs = await median(20, () => recentlyEdited(ws.transcript, ws.file))

    t.diagnostic(`64 KiB transcript: ${shortMs.toFixed(2)} ms | 16 MiB transcript: ${longMs.toFixed(2)} ms`)
    assert.ok(longMs < shortMs + 50, `a 16 MiB transcript cost ${longMs.toFixed(2)}ms — the tail bound slipped`)
  } finally {
    ws.cleanup()
  }
})

test('the whole-process cost, which is what a developer actually waits for', async (t) => {
  // The in-process numbers above exclude Node startup, and Node startup dominates: this is the
  // honest figure for "how much slower is every Read". It is why the hook does as little as
  // possible rather than as much as it could.
  const ws = makeWorkspace('latency-process', { bytes: 200 })
  try {
    const raw = readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } })
    const env = { CMR_TELEMETRY_ENABLED: '0', CLAUDE_PROJECT_DIR: ws.dir, HOME: ws.dir, USERPROFILE: ws.dir }
    const ms = await median(5, async () => {
      const r = await runHookProcess(raw, env)
      assert.equal(r.code, 0)
    })
    t.diagnostic(`full child process, refusing: ${ms.toFixed(0)} ms (median of 5, includes Node startup)`)
    assert.ok(ms < 5_000, `${ms.toFixed(0)}ms per Read is not an interactive experience`)
  } finally {
    ws.cleanup()
  }
})
