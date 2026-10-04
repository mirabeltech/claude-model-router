/**
 * The real entry point, as a real child process, speaking the real protocol.
 *
 * Everything else in the hook suite calls `runReadHook()` in process. This file spawns
 * `hooks/pre-tool-use.mjs` exactly the way Claude Code does — JSON on stdin, JSON on stdout, an
 * exit code — because the process boundary has its own failure modes that an in-process test
 * cannot see: a buffered stdout write racing exit, an unhandled rejection printing to stderr, a
 * non-zero exit from a module that failed to load.
 *
 * It is CI-safe: the worker is the `mock` provider against a local fixture server, so there is no
 * API key, no network egress and no Ollama requirement. The developer's own config files and
 * environment are deliberately NOT inherited — see `runHookProcess`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { makeWorkspace, readStdin, runHookProcess } from './helpers/hook-payload.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

let server
test.before(async () => {
  server = await startProviderServer()
})
test.after(async () => {
  await server?.close()
})

/**
 * The environment a child needs to reach the fixture worker.
 *
 * `CMR_WORKER_API_KEY_ENV` is set to the mock provider's own variable rather than left at the
 * Gemini default, because `resolveWorker` inherits `worker.apiKeyEnv` across a provider change —
 * so switching only the provider asks the mock for GEMINI_API_KEY and reports a healthy fixture
 * as unavailable. HOME and USERPROFILE point at a scratch directory so no developer's
 * ~/.claude/model-router/config.json can change the outcome of a test.
 */
function childEnv(dir, extra = {}) {
  return {
    CMR_WORKER_PROVIDER: 'mock',
    CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
    MOCK_WORKER_URL: server.url,
    CMR_TELEMETRY_ENABLED: '0',
    CLAUDE_PROJECT_DIR: dir,
    HOME: dir,
    USERPROFILE: dir,
    ...extra,
  }
}

/* ------------------------------------------------------------- the happy path */

test('a delegated read returns a valid deny response on stdout and exits 0', async () => {
  const ws = makeWorkspace('e2e-ok', { bytes: 40_000 })
  try {
    const r = await runHookProcess(
      readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      childEnv(ws.dir),
    )
    assert.equal(r.code, 0, 'the hook always exits 0')
    assert.equal(r.stderr, '', 'nothing is ever written to stderr')

    const parsed = JSON.parse(r.stdout)
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'])
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
    assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0, "the worker's answer is in context")
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /not read directly/)
  } finally {
    ws.cleanup()
  }
})

test('the stdout bytes are exactly one JSON object with no trailing noise', async () => {
  // Claude Code only parses stdout when it starts with { and ends with }. A stray newline from a
  // library, or a partial write at exit, makes a working hook silently inert.
  const ws = makeWorkspace('e2e-bytes', { bytes: 40_000 })
  try {
    const r = await runHookProcess(
      readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      childEnv(ws.dir),
    )
    assert.equal(r.stdout.startsWith('{'), true)
    assert.equal(r.stdout.endsWith('}'), true)
    assert.equal(r.stdout.trim(), r.stdout, 'no leading or trailing whitespace')
  } finally {
    ws.cleanup()
  }
})

/* ----------------------------------------------- allowing is silence, always */

test('every path that allows the Read writes nothing at all and still exits 0', async () => {
  const ws = makeWorkspace('e2e-allow', { bytes: 40_000 })
  try {
    const payload = readStdin({
      cwd: ws.dir,
      transcript_path: ws.transcript,
      tool_input: { file_path: ws.file },
    })
    const small = makeWorkspace('e2e-allow-small', { bytes: 100 })
    const cases = [
      ['hooks disabled', payload, childEnv(ws.dir, { CMR_HOOKS_ENABLED: '0' })],
      ['routing disabled', payload, childEnv(ws.dir, { CMR_ENABLED: '0' })],
      ['lane off', payload, childEnv(ws.dir, { CMR_BULK_READ_ENFORCE: 'off' })],
      ['advisory only', payload, childEnv(ws.dir, { CMR_BULK_READ_ENFORCE: 'suggest' })],
      ['no worker key', payload, childEnv(ws.dir, { CMR_WORKER_PROVIDER: 'gemini', CMR_WORKER_API_KEY_ENV: 'NOPE' })],
      ['worker errors', payload, childEnv(ws.dir, { MOCK_SCENARIO: 'auth_401', CMR_WORKER_MAX_RETRIES: '0' })],
      [
        'below threshold',
        readStdin({ cwd: small.dir, transcript_path: small.transcript, tool_input: { file_path: small.file } }),
        childEnv(small.dir),
      ],
      ['targeted read', readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file, offset: 1 } }), childEnv(ws.dir)],
      ['another tool', readStdin({ tool_name: 'Bash', tool_input: { command: 'ls' } }), childEnv(ws.dir)],
      ['malformed stdin', 'this is not json', childEnv(ws.dir)],
      ['empty stdin', '', childEnv(ws.dir)],
      ['missing file', readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: path.join(ws.dir, 'nope.ts') } }), childEnv(ws.dir)],
    ]

    try {
      for (const [label, stdin, env] of cases) {
        const r = await runHookProcess(stdin, env)
        assert.equal(r.code, 0, `${label}: exit code`)
        assert.equal(r.stdout, '', `${label}: stdout must be empty so the Read proceeds`)
        assert.equal(r.stderr, '', `${label}: stderr must be empty`)
      }
    } finally {
      small.cleanup()
    }
  } finally {
    ws.cleanup()
  }
})

test('an unreadable transcript still exits 0 and allows the Read', async () => {
  const ws = makeWorkspace('e2e-transcript', { bytes: 40_000 })
  try {
    const r = await runHookProcess(
      readStdin({
        cwd: ws.dir,
        transcript_path: path.join(ws.dir, 'no-such-transcript.jsonl'),
        tool_input: { file_path: ws.file },
      }),
      childEnv(ws.dir),
    )
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '')
  } finally {
    ws.cleanup()
  }
})

/* --------------------------------------------------------------- the deadline */

test('a hanging worker does not hang the hook: it falls open inside its own budget', async () => {
  const ws = makeWorkspace('e2e-hang', { bytes: 40_000 })
  try {
    const started = Date.now()
    const r = await runHookProcess(
      readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      childEnv(ws.dir, { MOCK_SCENARIO: 'hang', CMR_HOOK_TIMEOUT_MS: '1000', CMR_WORKER_MAX_RETRIES: '0' }),
    )
    const elapsed = Date.now() - started
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '', 'a slow worker never blocks the Read')
    assert.ok(elapsed < 20_000, `fell open in ${elapsed}ms, well inside Claude Code's own hook timeout`)
  } finally {
    ws.cleanup()
  }
})

/* --------------------------------------------------------- telemetry on disk */

test('a real child process writes a real row to a real store', async () => {
  const ws = makeWorkspace('e2e-telemetry', { bytes: 40_000 })
  try {
    const r = await runHookProcess(
      readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      childEnv(ws.dir, { CMR_TELEMETRY_ENABLED: '1', CMR_TELEMETRY_DIR: ws.dir }),
    )
    assert.equal(r.code, 0)
    assert.ok(r.stdout.startsWith('{'), 'the delegation still happened')

    const segments = fs.readdirSync(ws.dir).filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
    assert.equal(segments.length, 1, 'one daily segment')

    const lines = fs.readFileSync(path.join(ws.dir, segments[0]), 'utf8').split('\n').filter(Boolean)
    assert.equal(lines.length, 1, 'one delegation is one record')
    const row = JSON.parse(lines[0])
    assert.equal(row.task_type, 'bulk_read')
    assert.equal(row.status, 'ok')
    assert.equal(row.provider, 'mock')
    assert.ok(row.routing_policy_version >= 1)
  } finally {
    ws.cleanup()
  }
})

test('a telemetry directory that cannot be written does not affect the response', async () => {
  const ws = makeWorkspace('e2e-telemetry-bad', { bytes: 40_000 })
  try {
    const r = await runHookProcess(
      readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      // A path whose parent is a FILE, so mkdir cannot succeed.
      childEnv(ws.dir, { CMR_TELEMETRY_ENABLED: '1', CMR_TELEMETRY_DIR: path.join(ws.file, 'nested', 'store') }),
    )
    assert.equal(r.code, 0)
    assert.equal(r.stderr, '')
    assert.ok(r.stdout.startsWith('{'), 'the delegation survives a store that cannot be opened')
  } finally {
    ws.cleanup()
  }
})

/* ------------------------------------------------- the intent path, as a process */

test('CMR_TASK_INTENT_SOURCE reaches the shipped entry point and changes the request', async () => {
  // Every other intent test calls `runReadHook()` in process. This one proves the knob survives
  // the whole real path: an env var read by the real `loadConfig()`, in a child whose HOME points
  // at a scratch directory so no developer config can be the thing that made it work.
  const ws = makeWorkspace('e2e-intent')
  const question = 'which exported symbols take no arguments, and on what line'
  fs.writeFileSync(
    ws.transcript,
    JSON.stringify({ type: 'last-prompt', lastPrompt: question, leafUuid: 'u', sessionId: 's' }) + '\n',
  )
  const stdin = readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } })

  try {
    const before = server.requests.length
    const off = await runHookProcess(stdin, childEnv(ws.dir))
    const offPrompt = server.requests[before].body.prompt

    const mid = server.requests.length
    const on = await runHookProcess(stdin, childEnv(ws.dir, { CMR_TASK_INTENT_SOURCE: 'transcript' }))
    const onPrompt = server.requests[mid].body.prompt

    for (const r of [off, on]) {
      assert.equal(r.code, 0, 'the hook must always exit 0')
      assert.equal(r.stderr, '', 'and must never write to stderr')
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny')
    }

    assert.equal(offPrompt.includes(question), false, 'the default must not forward the prompt')
    assert.equal(offPrompt.includes('# Requirements'), false)
    assert.ok(onPrompt.includes(question), 'the opted-in run must forward it')
    assert.match(onPrompt, /# Requirements/)
  } finally {
    ws.cleanup()
  }
})
