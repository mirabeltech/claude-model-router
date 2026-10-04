/**
 * Which Reads reach the worker, and which stay with Claude.
 *
 * The dispatcher is stubbed here so the question under test is only "did the hook decide to
 * delegate". The real worker call is `hook.dispatch.test.mjs`, and the routing rules themselves
 * are already pinned by `routing.exclusions.test.mjs` — this file checks that the HOOK reaches
 * the gate with facts that let those rules apply, which is the part a stubbed engine cannot prove.
 *
 * Every refusal must end with the ORIGINAL Read proceeding: `response === null`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { hookConfig, hookEnv, makeWorkspace, readStdin, writeEditTranscript } from './helpers/hook-payload.mjs'

/** A dispatcher that records what it was asked and returns a fixed successful answer. */
function stubDispatch(overrides = {}) {
  const calls = []
  const impl = async (args) => {
    calls.push(args)
    return {
      ok: true,
      executed: true,
      status: 'ok',
      reason: 'completed',
      mode: 'bulk-reader',
      lane: 'bulkRead',
      provider: 'mock',
      model: 'mock-1',
      modelRequested: 'mock-1',
      text: 'THE WORKER SUMMARY',
      usage: { inputTokens: 100, outputTokens: 20, source: 'provider_reported' },
      capabilities: null,
      attempts: 1,
      latencyMs: 12,
      providerLatencyMs: 10,
      truncated: false,
      finishReason: 'stop',
      error: null,
      promptVersion: 1,
      policyVersion: 1,
      warnings: [],
      ...overrides,
    }
  }
  impl.calls = calls
  return impl
}

/** Run the hook over a workspace whose file is big enough to delegate. */
async function run({ configOverrides = {}, patch = {}, payload = {}, bytes = 40_000, dispatchImpl } = {}) {
  const ws = makeWorkspace('decision', { bytes })
  const impl = dispatchImpl ?? stubDispatch()
  try {
    const out = await runReadHook({
      raw: readStdin({
        cwd: ws.dir,
        transcript_path: ws.transcript,
        tool_input: { file_path: ws.file },
        ...payload,
      }),
      config: hookConfig(configOverrides, patch),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: impl,
      emit: () => null,
    })
    return { ...out, ws, calls: impl.calls }
  } finally {
    ws.cleanup()
  }
}

/* ------------------------------------------------------------------ delegates */

test('a large full read of a ready worker is delegated and the Read is blocked', async () => {
  const r = await run()
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.decision.reason, 'threshold_met')
  assert.equal(r.calls.length, 1)
  assert.equal(r.response.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(r.response.hookSpecificOutput.additionalContext, 'THE WORKER SUMMARY')
})

/* ------------------------------------------------------------------- refuses */

test('a file below every size threshold stays with Claude', async () => {
  const r = await run({ bytes: 200 })
  assert.equal(r.outcome, 'not_delegated')
  assert.equal(r.decision.reason, 'below_threshold')
  assert.equal(r.calls.length, 0, 'no worker call is attempted, so no money can be spent')
  assert.equal(r.response, null)
})

test('a targeted read stays with Claude, which is the documented escape hatch', async () => {
  for (const narrowing of [{ offset: 10 }, { limit: 50 }, { pages: '1-2' }]) {
    const ws = makeWorkspace('decision-targeted', { bytes: 40_000 })
    const impl = stubDispatch()
    try {
      const r = await runReadHook({
        raw: readStdin({
          cwd: ws.dir,
          transcript_path: ws.transcript,
          tool_input: { file_path: ws.file, ...narrowing },
        }),
        config: hookConfig(),
        env: hookEnv('http://127.0.0.1:1'),
        dispatchImpl: impl,
        emit: () => null,
      })
      assert.equal(r.decision.reason, 'targeted_read', JSON.stringify(narrowing))
      assert.equal(r.response, null)
      assert.equal(impl.calls.length, 0)
    } finally {
      ws.cleanup()
    }
  }
})

test('a file Claude edited this session stays with Claude', async () => {
  const ws = makeWorkspace('decision-edited', { bytes: 40_000 })
  const impl = stubDispatch()
  try {
    writeEditTranscript(ws.transcript, ws.file)
    const r = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: impl,
      emit: () => null,
    })
    assert.equal(r.decision.reason, 'recently_edited')
    assert.equal(r.response, null)
    assert.equal(impl.calls.length, 0)
  } finally {
    ws.cleanup()
  }
})

test('a sensitive path is refused whatever its size, and its bytes are never read', async () => {
  for (const name of ['.env', 'secrets.ts', 'server.pem', 'id_rsa', 'my-credentials.json']) {
    const ws = makeWorkspace('decision-deny', { bytes: 40_000, name })
    const impl = stubDispatch()
    let opened = 0
    const watchfulFs = {
      statSync: (...a) => fs.statSync(...a),
      openSync: (...a) => fs.openSync(...a),
      readSync: (...a) => fs.readSync(...a),
      closeSync: (...a) => fs.closeSync(...a),
      readFileSync: (p, ...rest) => {
        if (String(p).includes(name)) opened += 1
        return fs.readFileSync(p, ...rest)
      },
    }
    try {
      const r = await runReadHook({
        raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
        config: hookConfig(),
        env: hookEnv('http://127.0.0.1:1'),
        fs: watchfulFs,
        dispatchImpl: impl,
        emit: () => null,
      })
      assert.equal(r.decision.reason, 'deny_glob', name)
      assert.equal(r.response, null, name)
      assert.equal(impl.calls.length, 0, name)
      assert.equal(opened, 0, `${name}: a refused file's contents are never loaded`)
    } finally {
      ws.cleanup()
    }
  }
})

test('an unconfigured worker refuses every read, which is the out-of-box behaviour', async () => {
  const r = await run({ configOverrides: { worker: { provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' } } })
  assert.equal(r.decision.reason, 'worker_not_ready')
  assert.equal(r.calls.length, 0)
  assert.equal(r.response, null)
})

test('a payload over the worker ceiling is refused before anything is read', async () => {
  const r = await run({ patch: { worker: { maxInputBytes: 1024 } } })
  assert.equal(r.decision.reason, 'over_max_input_bytes')
  assert.equal(r.calls.length, 0)
})

/* ---------------------------------------------------- enforcement, not policy */

test('a delegate-worthy read under suggest or ask is NOT intercepted in this phase', async () => {
  // `suggest` means "delegate-worthy, but do not block", and steering Claude to a skill is a
  // later phase; `ask` would prompt the developer to approve a read rather than delegate it.
  // Both are recorded and both let the Read through.
  for (const enforce of ['suggest', 'ask']) {
    const r = await run({ configOverrides: { routing: { bulkRead: { enforce } } } })
    assert.equal(r.decision.delegate, true, enforce)
    assert.equal(r.decision.decision, enforce === 'suggest' ? 'suggest' : 'ask')
    assert.equal(r.outcome, 'not_enforced', enforce)
    assert.equal(r.response, null, enforce)
    assert.equal(r.calls.length, 0, `${enforce}: no worker call, so nothing is spent on an advisory`)
  }
})

test('a lane switched off refuses with disabled and never reaches a threshold', async () => {
  const r = await run({ configOverrides: { routing: { bulkRead: { enforce: 'off' } } } })
  assert.equal(r.decision.reason, 'disabled')
  assert.equal(r.response, null)
})

/* -------------------------------------------------------------- off-switches */

test('hooks.enabled false stops the hook before it reads anything at all', async () => {
  const r = await run({ configOverrides: { hooks: { enabled: false } } })
  assert.equal(r.outcome, 'hooks_disabled')
  assert.equal(r.decision, null, 'the gate is not even consulted')
  assert.equal(r.response, null)
})

test('routing disabled stops the hook, and writes nothing about work it declined to consider', async () => {
  const r = await run({ configOverrides: { enabled: false } })
  assert.equal(r.outcome, 'routing_disabled')
  assert.equal(r.decision, null)
  assert.equal(r.response, null)
})

/* ------------------------------------------------------ what reaches the worker */

test('the worker receives the one proven file and the fixed task, and nothing else', async () => {
  const r = await run()
  const { input, decision, config, signal } = r.calls[0]
  assert.deepEqual(Object.keys(input).sort(), ['files', 'task'])
  assert.equal(input.files.length, 1, 'exactly the file the gate proved — no inferred siblings')
  assert.deepEqual(Object.keys(input.files[0]).sort(), ['content', 'path'])
  assert.match(input.task, /^Summarise this file/)
  assert.equal(decision.delegate, true)
  assert.ok(config, 'the resolved config is passed, not reconstructed')
  assert.ok(signal, 'the hook imposes its own deadline through the dispatcher signal seam')
})

test('the file is read exactly once on a delegated path', async () => {
  const ws = makeWorkspace('decision-once', { bytes: 40_000 })
  const impl = stubDispatch()
  let reads = 0
  const countingFs = {
    statSync: (...a) => fs.statSync(...a),
    openSync: (...a) => fs.openSync(...a),
    readSync: (...a) => fs.readSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
    readFileSync: (p, ...rest) => {
      if (String(p) === ws.file) reads += 1
      return fs.readFileSync(p, ...rest)
    },
  }
  try {
    const r = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      fs: countingFs,
      dispatchImpl: impl,
      emit: () => null,
    })
    assert.equal(r.outcome, 'delegated')
    assert.equal(reads, 1, 'never twice: loading a file to decide whether to avoid loading it is the bug')
  } finally {
    ws.cleanup()
  }
})

test('a binary file falls open to the real Read, which is the only thing that can render it', async () => {
  const ws = makeWorkspace('decision-binary', { bytes: 40_000 })
  const impl = stubDispatch()
  try {
    const bin = path.join(ws.dir, 'blob.bin')
    fs.writeFileSync(bin, Buffer.concat([Buffer.alloc(40_000, 0x41), Buffer.from([0x00])]))
    const r = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: bin } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: impl,
      emit: () => null,
    })
    assert.equal(r.outcome, 'content_binary')
    assert.equal(r.response, null)
    assert.equal(impl.calls.length, 0, 'a binary prompt would be billed for replacement characters')
  } finally {
    ws.cleanup()
  }
})
