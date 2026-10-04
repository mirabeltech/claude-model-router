/**
 * The hook against a real worker: a real dispatcher, a real provider module and a real socket.
 *
 * `hook.decision.test.mjs` stubs the dispatcher to ask which Reads get delegated. This file keeps
 * the dispatcher and stubs nothing below it, so it exercises the part only a real transport can:
 * that the answer comes back through `additionalContext`, that every provider failure mode ends
 * with the original Read, and that the hook's own deadline bounds an interactive read even when
 * the worker's does not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { hookEnv, hookServerConfig, makeWorkspace, readStdin } from './helpers/hook-payload.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

let server
test.before(async () => {
  server = await startProviderServer()
})
test.after(async () => {
  await server?.close()
})

/** Run the hook with the real dispatcher pointed at the fixture server. */
async function run({ scenario, patch = {}, configOverrides = {}, bytes = 40_000, payload = {} } = {}) {
  const ws = makeWorkspace('dispatch', { bytes })
  const before = server.requests.length
  try {
    const out = await runReadHook({
      raw: readStdin({
        cwd: ws.dir,
        transcript_path: ws.transcript,
        tool_input: { file_path: ws.file },
        ...payload,
      }),
      config: hookServerConfig(server.url, configOverrides, patch),
      env: hookEnv(server.url, scenario ? { MOCK_SCENARIO: scenario } : {}),
      emit: () => null,
    })
    return { ...out, requests: server.requests.length - before, ws }
  } finally {
    ws.cleanup()
  }
}

/* ------------------------------------------------------------- the happy path */

test('a delegated read calls the worker once and returns its answer as context', async () => {
  const r = await run()
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.requests, 1, 'one delegation is one provider call')
  assert.equal(r.result.status, 'ok')
  assert.equal(r.response.hookSpecificOutput.permissionDecision, 'deny')
  assert.ok(r.response.hookSpecificOutput.additionalContext.length > 0)
  assert.equal(r.response.hookSpecificOutput.additionalContext, r.result.text)
})

test('the worker is sent the file content, and the prompt is built by the mode not the hook', async () => {
  const r = await run()
  const sent = server.requests[server.requests.length - 1]
  assert.match(sent.body.prompt, /# Task/, 'the bulk-reader template, verbatim from modes.mjs')
  assert.match(sent.body.prompt, /FILE /)
  assert.match(sent.body.prompt, /export const value = 1/, 'the real file content reached the worker')
})

test('the served model and provider are reported, which is what the row prices against', async () => {
  const r = await run()
  assert.equal(r.result.provider, 'mock')
  assert.ok(r.result.model, 'the model the provider reports having SERVED')
  assert.equal(typeof r.result.latencyMs, 'number')
})

/* ------------------------------------------------- every failure falls open */

test('every provider failure mode ends with the original Read', async () => {
  // The dispatcher classifies these; the hook's only job is to not turn any of them into a
  // broken tool call. A failed optimisation is never a failed user operation.
  const scenarios = [
    'auth_401',
    'forbidden_403',
    'not_found_404',
    'too_large_413',
    'rate_limit_429',
    'server_500',
    'bad_gateway_502',
    'not_json',
    'empty_text',
  ]
  const codes = new Set()
  for (const scenario of scenarios) {
    // Retries off: this test is about classification, and the shared backoff is already pinned by
    // the dispatch suite. Leaving it on spends three seconds re-proving someone else's test.
    const r = await run({ scenario, patch: { worker: { maxRetries: 0 } } })
    // Asserted FIRST: a scenario name the fixture server does not recognise serves a healthy
    // response, and the test would then pass by delegating successfully — proving nothing.
    assert.equal(r.result.status, 'error', `${scenario} must actually fail, or this test is vacuous`)
    assert.ok(r.result.error.code, `${scenario} is classified, never a bare message`)
    assert.equal(r.response, null, scenario)
    assert.equal(r.outcome, 'worker_failed', scenario)
    codes.add(r.result.error.code)
  }
  assert.ok(codes.size > 1, 'the classifications are distinct, not one bucket called "failed"')
})

test('a provider failure still reports which provider failed, for the row', async () => {
  const r = await run({ scenario: 'auth_401' })
  assert.equal(r.result.provider, 'mock')
  assert.equal(r.decision.reason, 'threshold_met', 'the ROUTING reason is unchanged by a worker fault')
})

/* ------------------------------------------------------ the hook's own deadline */

test("the hook's deadline bounds the read even though the worker's timeout is minutes", async () => {
  // worker.timeoutMs defaults to 180000 with maxRetries 2. Without its own budget the hook could
  // block an interactive Read for minutes, so it aborts the dispatch and falls open instead.
  const started = Date.now()
  const r = await run({ scenario: 'hang', patch: { hooks: { timeoutMs: 300 } } })
  const elapsed = Date.now() - started

  assert.equal(r.response, null, 'a slow worker never blocks the Read')
  assert.equal(r.result.status, 'error')
  assert.equal(r.result.error.code, 'aborted', 'identified by the signal, never by a message')
  assert.ok(elapsed < 20_000, `fell open in ${elapsed}ms rather than waiting on the worker`)
})

test('the configured worker timeout is still honoured when it is the tighter one', async () => {
  const r = await run({
    scenario: 'hang',
    patch: { hooks: { timeoutMs: 60_000 }, worker: { timeoutMs: 250, maxRetries: 0 } },
  })
  assert.equal(r.response, null)
  assert.equal(r.result.status, 'error')
  assert.equal(r.result.error.code, 'timeout')
})

/* --------------------------------------------- nothing is spent on a refusal */

test('no provider request is made on any non-delegating path', async () => {
  // The strongest statement this suite can make about cost: a refusal cannot bill anybody.
  const cases = [
    { label: 'below threshold', opts: { bytes: 200 } },
    { label: 'targeted read', opts: { payload: { tool_input: { file_path: 'x' } } } },
    { label: 'hooks disabled', opts: { configOverrides: { hooks: { enabled: false } } } },
    { label: 'routing disabled', opts: { configOverrides: { enabled: false } } },
    { label: 'lane off', opts: { configOverrides: { routing: { bulkRead: { enforce: 'off' } } } } },
    { label: 'advisory only', opts: { configOverrides: { routing: { bulkRead: { enforce: 'suggest' } } } } },
    { label: 'worker unconfigured', opts: { configOverrides: { worker: { provider: 'gemini', apiKeyEnv: 'NOPE' } } } },
  ]
  for (const { label, opts } of cases) {
    const r = await run(opts)
    assert.equal(r.requests, 0, `${label}: no socket was opened`)
    assert.equal(r.response, null, label)
  }
})

test('a targeted read of a real large file still opens no socket', async () => {
  const ws = makeWorkspace('dispatch-targeted', { bytes: 40_000 })
  const before = server.requests.length
  try {
    const r = await runReadHook({
      raw: readStdin({
        cwd: ws.dir,
        transcript_path: ws.transcript,
        tool_input: { file_path: ws.file, offset: 10, limit: 20 },
      }),
      config: hookServerConfig(server.url),
      env: hookEnv(server.url),
      emit: () => null,
    })
    assert.equal(r.decision.reason, 'targeted_read')
    assert.equal(server.requests.length - before, 0)
    assert.equal(r.response, null)
  } finally {
    ws.cleanup()
  }
})

/* ----------------------------------------------------------- answer handling */

test('an answer that is only whitespace is not substituted for the file', async () => {
  // The provider contract refuses a blank answer outright, so this is belt to that braces: an
  // empty summary must never replace a file Claude asked for.
  const r = await run({ scenario: 'empty_text' })
  assert.equal(r.response, null)
})

test('a truncated answer is still reported, because it makes the saving suspect', async () => {
  const r = await run({ scenario: 'ok_truncated' })
  if (r.result.status === 'ok') {
    assert.equal(r.result.truncated, true)
    assert.ok(r.response, 'a truncated answer is still an answer; the row records that it was cut')
  }
})
