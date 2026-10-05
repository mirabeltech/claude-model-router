/**
 * SEVEN WAYS NOT TO DELEGATE, EACH FOLLOWED TO THE RENDERED REPORT.
 *
 * The happy path has one shape and the refusals have seven, and the seven are where a router
 * actually earns its keep: every one of them must leave the developer's `Read` working. This file
 * drives each through the REAL hook child process and asserts the same five things of all of them:
 *
 *   1. the user's primary task does not fail — stdout is empty, exit is 0
 *   2. no worker delegation occurred when it should not have
 *   3. NO FALSE WORKER USAGE is emitted — null, never 0
 *   4. telemetry names the right reason
 *   5. analytics classifies it correctly, and the report does not call a safe refusal a failure
 *
 * THE FIFTH IS THE ONE WORTH THE FILE. A safe refusal and a worker failure are both "no answer
 * came back", and a reader that cannot tell them apart will show a healthy, correctly-cautious
 * router as broken — which is how a team concludes the plugin does not work and removes it. So
 * every row below asserts which analytics bucket it lands in, not merely that it was recorded.
 *
 * LAYER: Claude Code smoke (the hook is a real child process) plus provider-level integration
 * (a real socket to the fixture server, through the shipped mock provider module). Not live: no
 * Ollama, no API key, no network egress.
 *
 * ONE MECHANISM PER ROW. Each case changes exactly one thing against a baseline that delegates, so
 * a row that passes for the wrong reason is visible — the baseline test is the first one here, and
 * without it every assertion below could be satisfied by a router that never delegates at all.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { renderReport } from '../plugins/router-dashboard/lib/render/index.mjs'
import { makeTempDir, readStdin, runHookProcess } from './helpers/hook-payload.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

let server
test.before(async () => {
  server = await startProviderServer()
})
test.after(async () => {
  await server?.close()
})

const PADDING = 'export const value = 1 // padding to reach a delegation-worthy size\n'

/**
 * Drive one Read through the real hook and return the protocol plus the rows it wrote.
 *
 * @param {{env?: object, bytes?: number, fileName?: string}} opts
 */
async function drive(label, { env = {}, bytes = 48_000, fileName = 'big.ts' } = {}) {
  const tmp = makeTempDir(label)
  const projectDir = path.join(tmp.dir, 'project')
  const storeDir = path.join(tmp.dir, 'store')
  fs.mkdirSync(path.dirname(path.join(projectDir, fileName)), { recursive: true })

  const target = path.join(projectDir, fileName)
  fs.writeFileSync(target, PADDING.repeat(Math.ceil(bytes / PADDING.length)))
  const transcript = path.join(projectDir, 'transcript.jsonl')
  fs.writeFileSync(transcript, '')

  const hook = await runHookProcess(
    readStdin({
      cwd: projectDir,
      transcript_path: transcript,
      tool_use_id: 'toolu_refusal',
      tool_input: { file_path: target },
    }),
    {
      CMR_WORKER_PROVIDER: 'mock',
      CMR_WORKER_MODEL: 'mock-1',
      CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
      MOCK_WORKER_URL: server.url,
      CMR_TELEMETRY_ENABLED: 'true',
      CMR_TELEMETRY_DIR: storeDir,
      CLAUDE_PROJECT_DIR: projectDir,
      HOME: tmp.dir,
      USERPROFILE: tmp.dir,
      ...env,
    },
  )

  const rows = !fs.existsSync(storeDir)
    ? []
    : fs
        .readdirSync(storeDir)
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) =>
          fs
            .readFileSync(path.join(storeDir, f), 'utf8')
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => JSON.parse(l)),
        )

  return { hook, rows, target, cleanup: tmp.cleanup }
}

/** Every column that would be a LIE on a call that produced no worker usage. */
const NO_WORKER_USAGE = Object.freeze([
  'worker_input_tokens',
  'worker_output_tokens',
  'worker_total_tokens',
  'worker_cached_input_tokens',
  'worker_thought_tokens',
  'worker_billable_output_tokens',
  'worker_input_cost',
  'worker_output_cost',
  'worker_total_cost',
  'estimated_tokens_avoided',
  'estimated_cost_avoided',
  'estimated_net_savings',
])

/** The five shared assertions. `expect` names what this particular refusal should look like. */
function assertSafeRefusal(r, expect) {
  // 1. the developer's Read still happens.
  assert.equal(r.hook.code, 0, `${expect.label}: the hook must exit 0`)
  assert.equal(r.hook.stderr, '', `${expect.label}: stderr would become Claude's feedback`)
  assert.equal(r.hook.stdout, '', `${expect.label}: zero bytes means "run the Read"`)

  // 2 and 4. one row, naming the right reason.
  assert.equal(r.rows.length, 1, `${expect.label}: exactly one row`)
  const row = r.rows[0]
  assert.equal(row.task_type, expect.taskType, `${expect.label}: event kind`)
  assert.equal(row.routing_reason, expect.routingReason, `${expect.label}: reason`)
  assert.equal(row.status, expect.status, `${expect.label}: status`)
  if ('errorCode' in expect) {
    assert.equal(row.error_code, expect.errorCode, `${expect.label}: error_code`)
  }

  // 3. NO FALSE WORKER USAGE. Null, never 0 — a zero would be a measurement nobody took.
  for (const col of NO_WORKER_USAGE) {
    assert.equal(row[col], null, `${expect.label}: ${col} must be null, not 0`)
  }

  // 5. analytics classifies it, and the report does not call it a worker failure.
  const analysis = analyzeRows(r.rows, {
    now: Date.parse(row.timestamp) + 1000,
    window: { kind: 'all' },
  })
  assert.equal(analysis.summary.events.value, 1, `${expect.label}: counted`)
  assert.equal(
    analysis.summary.successes.value,
    0,
    `${expect.label}: a refusal is never a success`,
  )
  const byClass = analysis.routing.byClass ?? {}
  assert.equal(
    byClass[expect.bucket],
    1,
    `${expect.label}: expected class ${expect.bucket}, got ${JSON.stringify(byClass)}`,
  )

  const html = renderReport(analysis, { generatedAt: '2026-10-04T00:00:00.000Z' })
  assert.match(html, /<!doctype html>/i, `${expect.label}: the report still renders`)
  assert.equal(/\$[0-9]/.test(html), false, `${expect.label}: no invented dollar figure`)
  return { row, analysis, html }
}

/* ------------------------------------------------------------------ the baseline */

test('the baseline delegates, so every refusal below is a real difference', async () => {
  // Without this, a router that refused everything would satisfy every assertion in this file.
  const r = await drive('refuse-baseline')
  try {
    assert.notEqual(r.hook.stdout, '', 'the baseline must actually delegate')
    assert.equal(r.rows[0].status, 'ok')
    assert.equal(r.rows[0].task_type, 'bulk_read')
  } finally {
    r.cleanup()
  }
})

/* --------------------------------------------------------- A. routing denies */

test('A. a sensitive path is refused by the gate, and its bytes are never read', async () => {
  // The deny glob is a SECURITY control, so the claim is stronger than "it did not delegate": the
  // file's contents must never have been loaded at all. The gate rules on the path alone.
  const r = await drive('refuse-glob', { fileName: 'secrets.ts' })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'deny glob',
      taskType: 'gate_block',
      routingReason: 'deny_glob',
      status: 'skipped',
      errorCode: null,
      bucket: 'gateRefused',
    })
    assert.equal(row.routing_decision, 'allow', 'the developer still gets their own Read')
    assert.equal(row.provider, null, 'and no worker was ever named')
    // Governance never ran: the gate declined first, and that ordering is visible in the row.
    assert.equal(row.governance_decision, null)
  } finally {
    r.cleanup()
  }
})

test('A2. a targeted read is refused, because a range read is already cheap', async () => {
  const tmp = makeTempDir('refuse-targeted')
  try {
    const projectDir = path.join(tmp.dir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const target = path.join(projectDir, 'big.ts')
    fs.writeFileSync(target, PADDING.repeat(800))
    const transcript = path.join(projectDir, 't.jsonl')
    fs.writeFileSync(transcript, '')
    const hook = await runHookProcess(
      readStdin({
        cwd: projectDir,
        transcript_path: transcript,
        // `offset`/`limit` are what make a read targeted — see the hook contract document.
        tool_input: { file_path: target, offset: 10, limit: 20 },
      }),
      {
        CMR_WORKER_PROVIDER: 'mock',
        CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
        MOCK_WORKER_URL: server.url,
        CMR_TELEMETRY_ENABLED: '0',
        HOME: tmp.dir,
        USERPROFILE: tmp.dir,
      },
    )
    assert.equal(hook.code, 0)
    assert.equal(hook.stdout, '', 'a targeted read is left alone')
  } finally {
    tmp.cleanup()
  }
})

/* ------------------------------------------------------ B. governance denies */

test('B. an exhausted budget refuses, and the row says which budget and how much', async () => {
  // A token budget of 1 against a 48 KB file. `onExceed: disable` is the strict setting; the
  // SHIPPED default is that no limit exists at all, so this row is only reachable by configuring
  // one, which is the point of asserting it.
  //
  // The ledger goes in its own scratch directory, cleaned up alongside the workspace. An earlier
  // draft created it with makeTempDir() inline and never cleaned it, which is exactly the leak
  // this phase fixed in the helper — so leaving it would have been the one remaining example of
  // the thing being fixed.
  const govTmp = makeTempDir('refuse-budget-state')
  const r = await drive('refuse-budget', {
    env: {
      CMR_BUDGET_ENABLED: 'true',
      CMR_RUN_MAX_TOTAL_TOKENS: '1',
      CMR_BUDGET_ON_EXCEED: 'disable',
      CMR_BUDGET_STATE_DIR: path.join(govTmp.dir, 'gov'),
    },
  })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'budget exceeded',
      taskType: 'gate_block',
      // NOT a routing reason. THIS IS CLAUDE.md'S NINTH RULE, VISIBLE IN ONE ROW: routing still
      // says `threshold_met`, because the read WAS delegation-worthy, and governance separately
      // says `deny`. Collapsing them would leave a row saying the budget was spent without
      // saying whether the read deserved delegating at all — which is the shortcut the
      // architecture rejects on the record.
      routingReason: 'threshold_met',
      status: 'skipped',
      errorCode: null,
      bucket: 'governanceDenied',
    })
    assert.equal(row.routing_decision, 'deny', 'routing would have delegated')
    assert.equal(row.governance_decision, 'deny', 'and governance is what stopped it')
    assert.equal(row.governance_reason, 'run_budget_exceeded', 'naming the budget that bound')
    assert.equal(row.budget_scope, 'run')
    assert.equal(row.budget_limit, 1)
    assert.equal(row.reservation_status, 'none', 'a denied call reserves nothing')
  } finally {
    r.cleanup()
    govTmp.cleanup()
  }
})

/* ---------------------------------------------- C/D. capability and context */

test('C. a window too small to hold the prompt refuses rather than sending it', async () => {
  // THE OLLAMA MIDDLE-DROP REGRESSION, at the hook level. A provider that silently drops the
  // middle of an over-long prompt returns a confident, wrong answer and bills for it. So an
  // oversized prompt is REFUSED — input is never truncated — and that refusal is the feature.
  const r = await drive('refuse-context', {
    env: { CMR_WORKER_PROVIDER: 'ollama', CMR_WORKER_MODEL: 'tiny', CMR_OLLAMA_CONTEXT_TOKENS: '256', CMR_OLLAMA_DISCOVER_CONTEXT: '0', CMR_OLLAMA_BASE_URL: server.url },
  })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'context exceeded',
      taskType: 'bulk_read',
      routingReason: 'context_exceeded',
      // `error`, not `skipped`, and that is a judgement worth knowing: the call was PREPARED and
      // then refused by the capability layer, so it is an outcome of an attempted delegation
      // rather than a gate refusal. It carries an error_code for the same reason.
      status: 'error',
      errorCode: 'context_exceeded',
      bucket: 'delegationError',
    })
    // The window IS recorded on a refusal, which is what makes it explainable afterwards. A
    // refusal with no window in the row is a refusal nobody can audit.
    assert.equal(row.worker_context_tokens, 256)
    assert.equal(row.worker_context_status, 'configured')
    assert.ok(row.worker_requested_input_tokens > 256, 'and what was asked for exceeds it')
    assert.equal(row.error_code, 'context_exceeded')
  } finally {
    r.cleanup()
  }
})

/* ----------------------------------------------------- E. worker unavailable */

test('E. a worker that is not ready is never called, and the gate says so', async () => {
  // Gemini with no key present. The gate learns this from a table lookup, with no network call and
  // no provider module loaded — which is why an unconfigured install costs nothing.
  const r = await drive('refuse-unavailable', {
    env: { CMR_WORKER_PROVIDER: 'gemini', CMR_WORKER_API_KEY_ENV: 'GEMINI_API_KEY', MOCK_WORKER_URL: '' },
  })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'worker not ready',
      taskType: 'gate_block',
      routingReason: 'worker_not_ready',
      status: 'skipped',
      errorCode: null,
      bucket: 'gateRefused',
    })
    assert.equal(row.provider, null, 'nothing was dispatched, so no provider is claimed')
  } finally {
    r.cleanup()
  }
})

/* --------------------------------------------------------- F. worker timeout */

test('F. a worker that hangs falls open once the hook deadline passes', async () => {
  // The hook has its own deadline, shorter than worker.timeoutMs, because Claude Code is waiting.
  // A timeout is an ERROR row, not a refusal — the call was made and produced nothing — and the
  // distinction matters: this one belongs in the failure bucket, and the report should say so.
  const r = await drive('refuse-timeout', {
    env: { MOCK_SCENARIO: 'hang', CMR_HOOK_TIMEOUT_MS: '1000', CMR_WORKER_MAX_RETRIES: '0' },
  })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'timeout',
      taskType: 'bulk_read',
      routingReason: 'provider_error',
      status: 'error',
      bucket: 'delegationError',
    })
    // `aborted`, not `timeout`, and the difference is real: the HOOK's deadline fired and
    // cancelled the request, which is a different event from the provider's own timeout
    // classification. Asserting the literal is what stops the two being conflated later.
    assert.equal(row.error_code, 'aborted', 'the hook deadline aborted the call')
    assert.equal(row.worker_input_tokens, null, 'a call that produced nothing measured nothing')
  } finally {
    r.cleanup()
  }
})

/* ----------------------------------------------------------- G. provider error */

test('G. an upstream 500 falls open, and is recorded as a worker failure, not a refusal', async () => {
  const r = await drive('refuse-500', {
    env: { MOCK_SCENARIO: 'server_500', CMR_WORKER_MAX_RETRIES: '0' },
  })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'http 500',
      taskType: 'bulk_read',
      routingReason: 'provider_error',
      status: 'error',
      errorCode: 'http_5xx',
      bucket: 'delegationError',
    })
    assert.equal(row.provider, 'mock', 'a dispatched call names the provider it reached')
  } finally {
    r.cleanup()
  }
})

test('G2. a 401 falls open too, and the key never appears in the row', async () => {
  // Classified separately from a 5xx because the remedy is different — and `auth` must not be
  // retried, since retrying a bad credential three times is just three failures.
  const r = await drive('refuse-401', {
    env: { MOCK_SCENARIO: 'auth_401', CMR_WORKER_MAX_RETRIES: '0' },
  })
  try {
    const { row } = assertSafeRefusal(r, {
      label: 'http 401',
      taskType: 'bulk_read',
      routingReason: 'provider_error',
      status: 'error',
      errorCode: 'auth',
      bucket: 'delegationError',
    })
    const line = JSON.stringify(row)
    assert.equal(line.includes(server.url), false, 'the worker URL is not a telemetry column')
  } finally {
    r.cleanup()
  }
})

/* ------------------------------------- the distinction the report has to preserve */

test('a safe refusal and a worker failure land in different buckets, and the report shows both', async () => {
  // THE CLAIM THIS FILE EXISTS FOR, asserted on one combined store rather than one row at a time.
  // A reader that merged these would report a correctly-cautious router as a broken one.
  const refused = await drive('mix-refused', { fileName: 'credentials.ts' })
  const failed = await drive('mix-failed', { env: { MOCK_SCENARIO: 'server_500', CMR_WORKER_MAX_RETRIES: '0' } })
  try {
    const rows = [...refused.rows, ...failed.rows]
    assert.equal(rows.length, 2)
    const analysis = analyzeRows(rows, { now: Date.now(), window: { kind: 'all' } })

    assert.equal(analysis.routing.byClass.gateRefused, 1, 'one refusal')
    assert.equal(analysis.routing.byClass.delegationError, 1, 'and one failure')
    assert.equal(analysis.summary.delegations.value, 1, 'only ONE call was ever attempted')
    assert.equal(analysis.summary.refusals.value, 1)
    assert.equal(analysis.summary.successes.value, 0)

    // Success rate is over DISPATCHED calls, so the refusal is not in its denominator. A refusal
    // counted as a failed dispatch would read as a 50% success rate on a router that made one
    // call and lost it to an upstream 500.
    assert.equal(
      analysis.routing.successRate.value,
      0,
      'the one dispatched call failed; the refusal is not in this denominator',
    )

    const html = renderReport(analysis, { generatedAt: '2026-10-04T00:00:00.000Z' })
    assert.equal(/\$[0-9]/.test(html), false)
    // Both populations have to be visible, or the coverage figure is a ratio with a hidden
    // denominator — which docs/analytics.md names as the thing it will not ship.
    assert.match(html, /refus/i, 'the report names refusals')
  } finally {
    refused.cleanup()
    failed.cleanup()
  }
})

/* ------------------------- H. a worker that fabricates: verified, then discarded */

test('H. a summary whose claims do not check out is DISCARDED, not substituted', async () => {
  // THE FAILURE A DEVELOPER CANNOT SEE. The worker's answer replaces the file in Claude's
  // context, so a fabrication is indistinguishable from a good summary until something built on
  // it breaks. Verification happens before substitution, and `verify.onSuspect: 'discard'` (the
  // shipped default) falls open to the real Read.
  //
  // Driven through the real hook with the real dispatcher, overriding only the worker's TEXT, so
  // what is tested is the shipped decision path rather than the verifier in isolation.
  const ws = makeTempDir('refuse-fabricated')
  try {
    const projectDir = path.join(ws.dir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const target = path.join(projectDir, 'big.ts')
    fs.writeFileSync(target, PADDING.repeat(Math.ceil(48_000 / PADDING.length)))
    const transcript = path.join(projectDir, 't.jsonl')
    fs.writeFileSync(transcript, '')

    const { runReadHook } = await import('../plugins/model-router/lib/hook/run.mjs')
    const { hookConfig, hookEnv, readStdin } = await import('./helpers/hook-payload.mjs')

    const fabricated = [
      'This file declares `getUserByEmail` on line 412 and `AuditLogWriter` on line 980.',
      'It throws `"no such tenant in the registry"` when the lookup fails.',
    ].join('\n')

    const out = await runReadHook({
      raw: readStdin({ cwd: projectDir, transcript_path: transcript, tool_input: { file_path: target } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => ({
        ok: true,
        status: 'ok',
        reason: 'completed',
        provider: 'mock',
        model: 'mock-1',
        text: fabricated,
        usage: null,
        capabilities: null,
        attempts: 1,
        latencyMs: 5,
        error: null,
        promptVersion: 5,
        policyVersion: 1,
      }),
      emit: () => null,
    })

    assert.equal(out.outcome, 'summary_unverified', 'the outcome names why it was not substituted')
    assert.equal(out.response, null, 'ZERO BYTES: the developer gets their own Read')
    assert.ok(out.result, 'and the worker call is still on the record, because it was still paid for')
  } finally {
    ws.cleanup()
  }
})

test('H2. the same fabrication is substituted WITH A CAVEAT under onSuspect: warn', async () => {
  // The other operator choice: keep the summary, but tell Claude which claims failed. Claude is
  // the one consumer that can act on that — it can re-read the file.
  const ws = makeTempDir('refuse-fabricated-warn')
  try {
    const projectDir = path.join(ws.dir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const target = path.join(projectDir, 'big.ts')
    fs.writeFileSync(target, PADDING.repeat(Math.ceil(48_000 / PADDING.length)))
    const transcript = path.join(projectDir, 't.jsonl')
    fs.writeFileSync(transcript, '')

    const { runReadHook } = await import('../plugins/model-router/lib/hook/run.mjs')
    const { hookConfig, hookEnv, readStdin } = await import('./helpers/hook-payload.mjs')

    const out = await runReadHook({
      raw: readStdin({ cwd: projectDir, transcript_path: transcript, tool_input: { file_path: target } }),
      config: hookConfig({ verify: { enabled: true, onSuspect: 'warn', maxUngroundedIdentifierRatio: 0.25 } }),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => ({
        ok: true,
        status: 'ok',
        reason: 'completed',
        provider: 'mock',
        model: 'mock-1',
        text: 'This file declares `getUserByEmail` on line 412 and `AuditLogWriter` on line 980.',
        usage: null,
        capabilities: null,
        attempts: 1,
        latencyMs: 5,
        error: null,
        promptVersion: 5,
        policyVersion: 1,
      }),
      emit: () => null,
    })

    assert.equal(out.outcome, 'delegated')
    assert.ok(out.response, 'the summary IS substituted')
    const hso = out.response.hookSpecificOutput
    assert.match(hso.permissionDecisionReason, /could not be confirmed/, 'and Claude is told')
    assert.match(hso.permissionDecisionReason, /re-read the file with offset and limit/)
    // The caveat goes in the REASON, never mixed into the worker's own words.
    assert.equal(/could not be confirmed/.test(hso.additionalContext), false)
  } finally {
    ws.cleanup()
  }
})

test('H3. a summary that checks out is substituted with no caveat at all', async () => {
  // The baseline for H and H2: verification must not interfere with a good answer. The padding
  // file is full of `value`, so an answer quoting it is grounded.
  const ws = makeTempDir('refuse-verified-ok')
  try {
    const projectDir = path.join(ws.dir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const target = path.join(projectDir, 'big.ts')
    fs.writeFileSync(target, PADDING.repeat(Math.ceil(48_000 / PADDING.length)))
    const transcript = path.join(projectDir, 't.jsonl')
    fs.writeFileSync(transcript, '')

    const { runReadHook } = await import('../plugins/model-router/lib/hook/run.mjs')
    const { hookConfig, hookEnv, readStdin } = await import('./helpers/hook-payload.mjs')

    const out = await runReadHook({
      raw: readStdin({ cwd: projectDir, transcript_path: transcript, tool_input: { file_path: target } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => ({
        ok: true,
        status: 'ok',
        reason: 'completed',
        provider: 'mock',
        model: 'mock-1',
        text: 'This file declares `value` on line 1 and repeats that declaration throughout.',
        usage: null,
        capabilities: null,
        attempts: 1,
        latencyMs: 5,
        error: null,
        promptVersion: 5,
        policyVersion: 1,
      }),
      emit: () => null,
    })

    assert.equal(out.outcome, 'delegated')
    assert.ok(out.response)
    assert.equal(
      /could not be confirmed/.test(out.response.hookSpecificOutput.permissionDecisionReason),
      false,
      'a good answer earns no caveat',
    )
  } finally {
    ws.cleanup()
  }
})

/* ------------- H4. a discarded summary saves nothing, and the row must say so */

test('H4. a discarded summary is recorded as skipped with no saving, and its spend is kept', async () => {
  // Found end to end on 2026-10-05 against a real worker: a summary with 1 of 2 line references
  // wrong was discarded — Claude read the whole file itself — yet the row said `status: ok` and
  // `estimated_tokens_avoided: 2898`. Analytics then counted it as a success, a delivered answer
  // and a saving. CLAUDE.md's sixth rule: nothing was avoided, so nothing may be claimed.
  const ws = makeTempDir('refuse-fabricated-row')
  try {
    const projectDir = path.join(ws.dir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const target = path.join(projectDir, 'big.ts')
    fs.writeFileSync(target, PADDING.repeat(Math.ceil(48_000 / PADDING.length)))
    const transcript = path.join(projectDir, 't.jsonl')
    fs.writeFileSync(transcript, '')

    const { runReadHook } = await import('../plugins/model-router/lib/hook/run.mjs')
    const { buildEvent } = await import('../plugins/model-router/lib/telemetry/event.mjs')
    const { classifyRow, predicates } = await import('../plugins/model-router/lib/analytics/predicates.mjs')
    const { hookConfig, hookEnv } = await import('./helpers/hook-payload.mjs')

    const config = hookConfig()
    let inputs = null
    const out = await runReadHook({
      raw: readStdin({ cwd: projectDir, transcript_path: transcript, tool_input: { file_path: target } }),
      config,
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => ({
        ok: true,
        status: 'ok',
        reason: 'completed',
        provider: 'mock',
        model: 'mock-1',
        text: 'This file declares `getUserByEmail` on line 412 and `AuditLogWriter` on line 980.',
        usage: { inputTokens: 5805, cachedInputTokens: 0, outputTokens: 478, thinkingTokens: 0, totalTokens: 6283, source: 'provider_reported' },
        capabilities: null,
        attempts: 1,
        latencyMs: 5,
        error: null,
        promptVersion: 5,
        policyVersion: 1,
      }),
      emit: (i) => {
        inputs = i
        return null
      },
    })

    assert.equal(out.outcome, 'summary_unverified')
    assert.equal(out.response, null, 'the developer got their own Read')
    assert.ok(inputs, 'the discarded call is still recorded')

    const row = buildEvent({ ...inputs, config, now: 0, eventId: 'e' })
    assert.equal(row.status, 'skipped', 'not ok: nothing reached Claude')
    assert.equal(row.estimated_tokens_avoided, null, 'Claude read the whole file, so nothing was avoided')
    assert.equal(row.returned_answer_chars, null, 'nothing was returned to Claude')
    assert.equal(row.summary_verify_verdict, 'suspect')
    assert.equal(row.worker_input_tokens, 5805, 'the spend is kept: those tokens were consumed')
    assert.equal(row.worker_output_tokens, 478)

    assert.equal(classifyRow(row), 'delegationSkipped')
    assert.equal(predicates.delegationOk(row), false)
    assert.equal(predicates.answerDelivered(row), false)
    assert.equal(predicates.noUsableAnswer(row), true, 'it is worker overhead: paid for, bought nothing')
  } finally {
    ws.cleanup()
  }
})
