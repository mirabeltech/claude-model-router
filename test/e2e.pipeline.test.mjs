/**
 * ONE DELEGATION, THROUGH EVERY LAYER, WITH NAMED EVIDENCE AT EACH.
 *
 * WHAT THIS TEST IS, in the vocabulary the rest of the suite uses:
 *
 *   unit                 no — nothing here is called in process
 *   integration          yes, for analytics and the renderer, which are called as libraries
 *   provider-level       yes, over a REAL loopback socket to test/helpers/provider-server.mjs
 *                        through the shipped lib/providers/mock.mjs module
 *   Claude Code smoke    yes, for the hook — hooks/pre-tool-use.mjs runs as a real child process
 *                        speaking the real stdin/stdout protocol
 *   LIVE provider        no, and deliberately. See scripts/smoke-hook.mjs for that, which needs
 *                        Ollama and is therefore not in `npm test`.
 *
 * Nothing under test is substituted for a fixture. The mock provider is a shipped provider module
 * going through the same httpJson path as Gemini and Ollama — it is a configured worker, not a
 * stub — and the fixture server is a real HTTP server on a real port.
 *
 * WHY IT IS NOT A DUPLICATE OF clean-install.test.mjs. That file walks the same sequence and
 * asserts its ENDPOINTS: a delegation happened, analytics counted one success, the HTML parsed,
 * no dollar figure appeared. It says nothing about the layers in between. This file asserts the
 * PIPELINE: that routing ruled, then governance ruled, then capability was resolved, then dispatch
 * ran, then usage was captured — in that order, each with the column that proves it.
 *
 * THE TELEMETRY ROW IS THE CROSS-LAYER ARTIFACT, which is what makes that checkable at all. Every
 * layer's verdict lands in a column of one JSONL line, so reading one row off disk is how a test
 * observes nine layers without reaching into any of them. If this test is hard to write, the
 * schema has stopped being a complete account of what happened — which is itself worth knowing.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { renderReport } from '../plugins/router-dashboard/lib/render/index.mjs'
import { CALC_VERSION, SCHEMA_VERSION } from '../plugins/model-router/lib/telemetry/record.mjs'
import { ROUTER_VERSION } from '../plugins/model-router/lib/version.mjs'
import { makeTempDir, readStdin, runHookProcess } from './helpers/hook-payload.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

let server
test.before(async () => {
  server = await startProviderServer()
})
test.after(async () => {
  await server?.close()
})

/** A file big enough to be delegation-worthy under the shipped thresholds. */
const PADDING = 'export const value = 1 // padding to reach a delegation-worthy size\n'

/**
 * Drive the whole pipeline once and return everything it produced.
 *
 * Telemetry is ENABLED here, unlike `hook.e2e.test.mjs`, because the row is the evidence. It is
 * pointed at a scratch directory and HOME/USERPROFILE are redirected, so no developer's real store
 * is touched and no real config file can change the result.
 */
async function runPipeline(label, { env = {}, bytes = 48_000 } = {}) {
  const tmp = makeTempDir(label)
  const projectDir = path.join(tmp.dir, 'project')
  const storeDir = path.join(tmp.dir, 'store')
  fs.mkdirSync(projectDir, { recursive: true })

  const target = path.join(projectDir, 'big.ts')
  fs.writeFileSync(target, PADDING.repeat(Math.ceil(bytes / PADDING.length)))
  const transcript = path.join(projectDir, 'transcript.jsonl')
  fs.writeFileSync(transcript, '')

  const hook = await runHookProcess(
    readStdin({
      cwd: projectDir,
      transcript_path: transcript,
      tool_use_id: 'toolu_pipeline',
      tool_input: { file_path: target },
    }),
    {
      CMR_WORKER_PROVIDER: 'mock',
      CMR_WORKER_MODEL: 'mock-1',
      // Required: worker.apiKeyEnv stays at its Gemini default when only the provider is
      // overridden, and a supplied name REPLACES the provider's own requiresEnv. Without this the
      // mock is asked for GEMINI_API_KEY and the gate declines with worker_not_ready.
      CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
      MOCK_WORKER_URL: server.url,
      CMR_TELEMETRY_ENABLED: 'true',
      CMR_TELEMETRY_DIR: storeDir,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_SESSION_ID: 'e2e-pipeline-session',
      HOME: tmp.dir,
      USERPROFILE: tmp.dir,
      ...env,
    },
  )

  const segments = fs.existsSync(storeDir)
    ? fs.readdirSync(storeDir).filter((f) => f.endsWith('.jsonl'))
    : []
  const rows = segments.flatMap((f) =>
    fs
      .readFileSync(path.join(storeDir, f), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l)),
  )

  return { hook, rows, storeDir, projectDir, target, cleanup: tmp.cleanup, requests: server.requests }
}

/* ============================================================== the happy path */

test('one delegated Read leaves evidence of every layer, in pipeline order', async (t) => {
  const p = await runPipeline('e2e-pipeline')
  try {
    /* ---- layer 0: Claude Code <-> hook. The protocol, as the installed binary defines it. */

    assert.equal(p.hook.code, 0, 'the hook always exits 0; a non-zero code would block the Read')
    assert.equal(p.hook.stderr, '', 'stderr would become Claude feedback, so it stays empty')
    const out = JSON.parse(p.hook.stdout)
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput'], 'no deprecated top-level fields')
    const hso = out.hookSpecificOutput
    assert.equal(hso.hookEventName, 'PreToolUse')
    assert.equal(hso.permissionDecision, 'deny', 'deny is what keeps the file out of the window')
    assert.ok(hso.additionalContext.length > 0, "and the worker's answer travels alongside it")

    /* ---- the row. One delegation writes exactly one. */

    assert.equal(p.rows.length, 1, 'one gated Read is one row')
    const row = p.rows[0]

    /* ---- layer 1: routing — "would this be APPROPRIATE to delegate?" */

    // TWO TAXONOMIES, and they do not agree by accident. `task_type` is the EVENT kind, so an
    // attempted delegation is `bulk_read`; `routing_decision` is what the GATE said about the
    // original tool call, and for a delegated read that is `deny` — deny the direct Read, and
    // return the worker's answer instead. A reader that conflated them would report every
    // successful delegation as a refusal.
    assert.equal(row.task_type, 'bulk_read', 'a literal in the adapter; intent never reaches the gate')
    assert.equal(row.routing_decision, 'deny', 'the direct Read is denied; the answer replaces it')
    assert.equal(row.routing_reason, 'threshold_met', 'and it says WHICH rule approved delegating')
    assert.equal(row.routing_policy_version, 1, 'stamped, so a policy change is visible in the data')
    assert.equal(row.task_intent_source, 'none', 'intent is off by default, and the row records that')

    /* ---- layer 2: governance — "are we currently ALLOWED to?" */

    // Every limit ships null, so governance is consulted and declines to govern. That is a real
    // state with its own reason, not an absence: `budget_not_configured` is how a default install
    // proves the layer ran at all.
    assert.equal(row.governance_decision, 'allow')
    assert.equal(row.governance_reason, 'budget_not_configured')
    assert.equal(row.budget_limit, null, 'no limit configured means null, never 0')
    assert.equal(row.budget_remaining, null)
    assert.equal(row.budget_measurement_status, null, 'nothing to measure is null, not unavailable')
    assert.equal(row.reservation_status, 'none', 'nothing reserved, so nothing to settle')

    /* ---- layer 3: capability — "what do we know about this worker's window?" */

    // The mock provider declares contextWindowModel 'unknown' and exports no describeModel, so an
    // unknown window is the CORRECT answer here. The invariant is what matters: unknown context is
    // never infinite context, and the tokens are null exactly when the status is unknown.
    assert.ok(
      ['unknown', 'configured', 'discovered', 'assumed'].includes(row.worker_context_status),
      `unexpected capability status ${row.worker_context_status}`,
    )
    assert.equal(
      row.worker_context_tokens === null,
      row.worker_context_status === 'unknown',
      'contextTokens === null if and only if status === unknown',
    )

    /* ---- layer 4: the context budget — "CAN this worker run it?" */

    assert.ok(row.worker_requested_input_tokens > 0, 'the request was sized before it was sent')
    assert.equal(
      row.worker_input_truncation_detected === null || typeof row.worker_input_truncation_detected === 'boolean',
      true,
      'tri-state: true, false, or null — never defaulted to a reassuring false',
    )

    /* ---- layer 5: dispatch — the approved request, executed */

    assert.equal(row.provider, 'mock')
    assert.equal(row.model, 'mock-1')
    assert.equal(row.model_requested, 'mock-1', 'no silent model substitution')
    assert.equal(typeof row.prompt_version, 'number', 'the prompt is versioned')
    assert.ok(p.requests.length >= 1, 'a real request crossed a real socket')

    /* ---- layer 6: the worker — what it actually said */

    assert.equal(row.status, 'ok')
    assert.equal(row.error_code, null)
    assert.ok(row.returned_answer_chars > 0, 'an answer came back')
    assert.equal(row.worker_usage_source, 'provider_reported', 'the mock reports usage')
    assert.ok(row.worker_input_tokens > 0)
    assert.ok(row.worker_output_tokens > 0)
    assert.equal(typeof row.latency_ms, 'number')

    /* ---- layer 7: telemetry — the record, and its provenance */

    assert.equal(row.schema_version, SCHEMA_VERSION)
    assert.equal(row.calc_version, CALC_VERSION)
    assert.equal(row.router_version, ROUTER_VERSION, 'the row says which build produced it')
    assert.match(row.event_id, /^[0-9a-f-]{36}$/)
    assert.equal(row.task_id, 'toolu_pipeline', 'the tool_use_id, which carries no content')
    assert.match(row.session_id, /^[0-9a-f]{32}$/, 'hashed, never raw')
    assert.equal(
      row.project_path,
      null,
      'a path is opt-in, and storeFilePaths is false by default',
    )
    assert.equal(row.question_text, null, 'and so is the prompt text')

    // Money: null on a default install, with a status that says why. Never 0.
    assert.equal(row.worker_total_cost, null, 'every bundled rate ships null')
    assert.equal(row.worker_total_cost_status, 'unavailable')

    t.diagnostic(
      `row: ${row.routing_reason} / ${row.governance_reason} / ctx ${row.worker_context_status} / ` +
        `${row.worker_input_tokens}+${row.worker_output_tokens} tok / ${row.latency_ms} ms`,
    )

    /* ---- layer 8: analytics — the read model over the row the write model produced */

    // analyzeRows rather than the CLI, because the CLI is covered by analytics.cli.test.mjs and
    // what matters here is that the READ model consumes what the WRITE model just wrote.
    const analysis = analyzeRows(p.rows, { now: Date.parse(row.timestamp) + 1000, window: { kind: 'all' } })
    assert.equal(analysis.summary.events.value, 1)
    assert.equal(analysis.summary.delegations.value, 1)
    assert.equal(analysis.summary.successes.value, 1, 'the dispatch succeeded, not merely ran')
    assert.equal(analysis.summary.workerCost.value, null, 'unpriced stays null through the fold')
    assert.ok(
      analysis.summary.tokensAvoided.value > 0,
      'tokens avoided is measured from the file the gate proved',
    )

    /* ---- layer 9: the dashboard — a human can see it */

    const html = renderReport(analysis, { generatedAt: '2026-10-04T00:00:00.000Z' })
    assert.match(html, /<!doctype html>/i)
    assert.equal(/\$[0-9]/.test(html), false, 'a default install must invent no dollar figure')
    assert.equal(html.includes(p.target), false, 'and must not leak a local path')
    assert.equal(html.includes('mock-1'), true, 'while still reporting which worker ran')
  } finally {
    p.cleanup()
  }
})

test('the chain is reproducible: a second identical delegation agrees on every stable column', async () => {
  // Determinism across PROCESSES, which is the only kind that matters for a hook. The excluded
  // columns are excluded because they are genuinely per-run, and naming them is the point: a test
  // that diffed everything would have to be loosened later, and a loosened diff hides a change.
  const PER_RUN = new Set([
    'event_id', 'timestamp', 'tz_offset_minutes', 'task_id', 'project_id', 'session_id',
    'latency_ms', 'provider_latency_ms',
  ])
  const a = await runPipeline('e2e-repeat-a')
  const b = await runPipeline('e2e-repeat-b')
  try {
    assert.equal(a.rows.length, 1)
    assert.equal(b.rows.length, 1)
    const stable = (row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !PER_RUN.has(k)))
    assert.deepEqual(stable(a.rows[0]), stable(b.rows[0]))

    // And the per-run columns really do differ, or the exclusion list is hiding a bug rather than
    // describing one.
    assert.notEqual(a.rows[0].event_id, b.rows[0].event_id)
    assert.notEqual(a.rows[0].project_id, b.rows[0].project_id, 'a different project hashes differently')
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

test('a read the gate refuses is still recorded, which is what makes the refusal auditable', async () => {
  // A small file is not delegation-worthy. The gate allows the real Read — zero bytes on stdout,
  // indistinguishable from no hook installed — and STILL writes a row, because "we considered this
  // and declined" is the observation the whole analytics layer is built to count. A refusal that
  // left no trace would make the delegation rate a ratio with an unknown denominator.
  const p = await runPipeline('e2e-no-delegate', { bytes: 200 })
  try {
    assert.equal(p.hook.stdout, '', 'zero bytes out: the user gets their Read')
    assert.equal(p.hook.code, 0)
    assert.equal(p.rows.length, 1, 'and the decision is on the record')

    const row = p.rows[0]
    assert.equal(row.task_type, 'gate_block', 'the EVENT kind for a refusal')
    assert.equal(row.routing_decision, 'allow', 'the gate allowed the direct Read')
    assert.equal(row.routing_reason, 'below_threshold')
    assert.equal(row.status, 'skipped', 'no worker call was attempted')

    // NO FALSE WORKER USAGE. This is the invariant that keeps a refusal from inflating the
    // numbers, and it is asserted field by field rather than in aggregate.
    assert.equal(row.provider, null)
    assert.equal(row.model, null)
    assert.equal(row.worker_input_tokens, null, 'null, not 0 — nothing was measured')
    assert.equal(row.worker_output_tokens, null)
    assert.equal(row.worker_total_cost, null)
    assert.equal(row.estimated_tokens_avoided, null, 'nothing was avoided, and that is not zero')
    assert.equal(row.error_code, null, 'a refusal is not an error')
    assert.equal(row.latency_ms, null)

    // All eight governance columns are null together: governance was never consulted, because the
    // gate had already declined. The ordering guarantee, visible in the data.
    for (const col of [
      'governance_decision', 'governance_reason', 'budget_scope', 'budget_limit',
      'budget_remaining', 'budget_measurement_status', 'reservation_tokens', 'reservation_status',
    ]) {
      assert.equal(row[col], null, `${col} must be null when governance never ran`)
    }
  } finally {
    p.cleanup()
  }
})

test('with telemetry off, a delegation still works and the store is never created', async () => {
  // The installing-changes-nothing promise at the write layer: telemetry disabled means NO
  // directory, not an empty one. Separated from the refusal case above because they are different
  // claims, and conflating them is what made the first draft of this file assert the wrong thing.
  const p = await runPipeline('e2e-telem-off', { env: { CMR_TELEMETRY_ENABLED: '0' } })
  try {
    assert.notEqual(p.hook.stdout, '', 'the delegation still happens')
    assert.equal(JSON.parse(p.hook.stdout).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(fs.existsSync(p.storeDir), false, 'and nothing at all is written')
  } finally {
    p.cleanup()
  }
})
