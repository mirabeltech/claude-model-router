/**
 * What the hook puts on the record, written through the real sink and read back off disk.
 *
 * The rules this file enforces come from docs/savings-methodology.md and are the reason the
 * project exists: a missing measurement is NULL and never 0, primary-model usage is unavailable
 * rather than estimated, and nothing claims a saving it cannot derive from measured operands.
 *
 * It also pins the one translation the integration layer owns and could silently get wrong: a
 * dispatch `reason` is not a telemetry `routing_reason`, and passing one straight through would
 * stamp `unknown_enum:routing_reason` on essentially every delegated row.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { routingReasonFor, toEventInputs } from '../plugins/model-router/lib/hook/event.mjs'
import { __resetTelemetryForTests } from '../plugins/model-router/lib/telemetry/index.mjs'
import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import {
  CALC_VERSION,
  ROUTING_REASONS,
  SCHEMA_VERSION,
  TASK_TYPES,
} from '../plugins/model-router/lib/telemetry/record.mjs'
import { POLICY_VERSION } from '../plugins/model-router/lib/routing-policy.mjs'
import { PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'
import { hookConfig, hookEnv, makeWorkspace, readStdin } from './helpers/hook-payload.mjs'
import { delegatingDecision, decliningDecision } from './helpers/dispatch-input.mjs'

const okResult = {
  ok: true,
  status: 'ok',
  reason: 'completed',
  mode: 'bulk-reader',
  lane: 'bulkRead',
  provider: 'mock',
  model: 'mock-1',
  modelRequested: 'mock-1',
  text: 'A SUMMARY OF THE FILE',
  usage: {
    inputTokens: 1200,
    cachedInputTokens: null,
    outputTokens: 60,
    thinkingTokens: null,
    totalTokens: 1260,
    source: 'provider_reported',
  },
  capabilities: { reportsUsage: true, reportsThinkingTokens: false, supportsCachedInput: false },
  attempts: 1,
  latencyMs: 42,
  providerLatencyMs: 40,
  truncated: false,
  finishReason: 'stop',
  error: null,
  promptVersion: PROMPT_VERSION,
  policyVersion: POLICY_VERSION,
  warnings: [],
}

/** Run the hook against a REAL jsonl sink in a scratch directory, and read the rows back. */
async function runAndRead({ configOverrides = {}, patch = {}, dispatchImpl, bytes = 40_000, payload = {} } = {}) {
  __resetTelemetryForTests()
  const ws = makeWorkspace('telemetry', { bytes })
  try {
    const config = hookConfig(configOverrides, {
      ...patch,
      telemetry: { enabled: true, dir: ws.dir, dirResolved: ws.dir, ...(patch.telemetry ?? {}) },
    })
    const out = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file }, ...payload }),
      config,
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: dispatchImpl ?? (async () => okResult),
    })
    const { records, report } = readSegmentsSync({ dir: ws.dir, fs })
    return { ...out, records, report, ws, config }
  } finally {
    __resetTelemetryForTests()
    ws.cleanup()
  }
}

/* ------------------------------------------------------------ a delegated row */

test('a delegated read writes exactly one well-formed row', async () => {
  const r = await runAndRead()
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.records.length, 1)
  assert.equal(r.report.skipped.malformed, 0, 'a mid-file break would mean append atomicity failed')

  const row = r.records[0]
  assert.equal(row.schema_version, SCHEMA_VERSION)
  assert.equal(row.calc_version, CALC_VERSION)
  assert.equal(row.status, 'ok')
  assert.equal(row.task_type, 'bulk_read')
})

test('the row records the routing decision, not the dispatch outcome', async () => {
  const row = (await runAndRead()).records[0]
  assert.equal(row.routing_decision, 'deny', 'the lane enforcement IS the decision on the delegate path')
  assert.equal(row.routing_reason, 'threshold_met', 'why the gate delegated — "completed" is what status is for')
})

test('the policy and prompt versions are stamped, so a stored row names what produced it', async () => {
  const row = (await runAndRead()).records[0]
  assert.equal(row.routing_policy_version, POLICY_VERSION)
  assert.equal(row.prompt_version, PROMPT_VERSION)
})

test('the worker provider, model and performance are recorded', async () => {
  const row = (await runAndRead()).records[0]
  assert.equal(row.provider, 'mock')
  assert.equal(row.model, 'mock-1')
  assert.equal(row.model_requested, 'mock-1')
  assert.equal(row.latency_ms, 42)
  assert.equal(row.provider_latency_ms, 40)
  assert.equal(row.retry_count, 0, 'one attempt means zero retries')
  assert.equal(row.truncated, false)
  assert.equal(row.finish_reason, 'stop')
})

test("the worker's usage is preserved verbatim, never recomputed", async () => {
  const row = (await runAndRead()).records[0]
  assert.equal(row.worker_input_tokens, 1200)
  assert.equal(row.worker_output_tokens, 60)
  assert.equal(row.worker_total_tokens, 1260, "the provider's own total, as reported")
  assert.equal(row.worker_usage_source, 'provider_reported')
})

test('the corpus is counted as exactly the one file the gate proved', async () => {
  const r = await runAndRead()
  const row = r.records[0]
  assert.equal(row.files_count, 1)
  assert.equal(row.files_inferred_count, 0, 'the hook never adds a file the gate did not prove')
  assert.equal(row.input_bytes, r.ws.bytes)
  assert.equal(row.count_proven_files_only, true)
})

test('the saving is net of the answer that entered Claude context, and is an estimate', async () => {
  const r = await runAndRead()
  const row = r.records[0]
  assert.equal(row.avoided_method, 'chars_div_4')
  assert.equal(row.estimated_input_tokens, Math.floor(r.ws.chars / 4))
  assert.equal(row.returned_answer_chars, okResult.text.length)
  assert.equal(
    row.estimated_tokens_avoided,
    row.estimated_input_tokens - row.returned_answer_tokens_estimated,
    'net, not gross: the summary does enter the context window',
  )
  assert.equal(row.estimated_tokens_avoided_status, 'estimated', 'never actual, in any calc_version')
})

/* -------------------------------------------------------------- null discipline */

test('primary-model usage is unavailable, not estimated from the file size', async () => {
  // There is no transcript reader. Putting a counterfactual in the un-prefixed primary_* columns
  // would double-count the saving for any reader that summed both.
  const row = (await runAndRead()).records[0]
  for (const f of ['primary_model', 'primary_input_tokens', 'primary_output_tokens', 'primary_total_tokens']) {
    assert.equal(row[f], null, f)
  }
  assert.equal(row.primary_usage_method, 'none')
  assert.equal(row.primary_usage_status, 'unavailable')
})

test('an unpriced model leaves every money field null and says so, rather than guessing a rate', async () => {
  const row = (await runAndRead()).records[0]
  for (const f of ['worker_input_cost', 'worker_output_cost', 'worker_total_cost', 'estimated_net_savings']) {
    assert.equal(row[f], null, f)
    assert.equal(row[`${f}_status`], 'unavailable', `${f}_status`)
  }
})

test('missing usage stays null and never becomes zero', async () => {
  const r = await runAndRead({
    dispatchImpl: async () => ({ ...okResult, usage: null, capabilities: null }),
  })
  const row = r.records[0]
  assert.equal(row.worker_usage_source, 'missing')
  for (const f of ['worker_input_tokens', 'worker_output_tokens', 'worker_total_tokens']) {
    assert.equal(row[f], null, `${f} must be null, because a zero worker cost overstates savings`)
  }
})

test('value null and status unavailable always agree, in both directions', async () => {
  const row = (await runAndRead()).records[0]
  for (const key of Object.keys(row)) {
    if (!key.endsWith('_status') || key.startsWith('primary_usage')) continue
    const value = key.replace(/_status$/, '')
    if (!(value in row)) continue
    assert.equal(
      row[value] === null,
      row[key] === 'unavailable',
      `${value}/${key}: there is no "unavailable but here is a number"`,
    )
  }
})

/* -------------------------------------------------------------- a refused row */

test('a refusal writes a gate_block row that explains itself', async () => {
  const r = await runAndRead({ bytes: 200 })
  assert.equal(r.records.length, 1)
  const row = r.records[0]
  assert.equal(row.task_type, 'gate_block')
  assert.equal(row.status, 'skipped', 'no worker call was attempted')
  assert.equal(row.routing_decision, 'allow')
  assert.equal(row.routing_reason, 'below_threshold')
  assert.equal(row.routing_policy_version, POLICY_VERSION)
  assert.equal(row.provider, null, 'nothing was resolved, because nothing was called')
  assert.equal(row.latency_ms, null, 'there was no worker call to time')
  assert.equal(row.prompt_version, null, 'no prompt was built')
})

test('a refusal claims no saving at all', async () => {
  const row = (await runAndRead({ bytes: 200 })).records[0]
  assert.equal(row.estimated_input_tokens, null, 'the file was never read, so nothing was avoided')
  assert.equal(row.estimated_tokens_avoided, null)
  assert.equal(row.estimated_net_savings, null)
})

test('refusals can be switched off without losing delegation accounting', async () => {
  const off = { telemetry: { recordGateDecisions: false } }
  const refused = await runAndRead({ bytes: 200, patch: off })
  assert.equal(refused.records.length, 0, 'no gate row')

  const delegated = await runAndRead({ patch: off })
  assert.equal(delegated.records.length, 1, 'a delegation is always accounted for')
  assert.equal(delegated.records[0].task_type, 'bulk_read')
})

test('nothing is written when the hook never reached a decision', async () => {
  for (const opts of [
    { configOverrides: { hooks: { enabled: false } } },
    { configOverrides: { enabled: false } },
    { payload: { tool_name: 'Bash' } },
  ]) {
    const r = await runAndRead(opts)
    assert.equal(r.records.length, 0, JSON.stringify(opts))
  }
})

/* ------------------------------------------------------------- a failed row */

test('a worker failure is recorded as an error with a classified code', async () => {
  const r = await runAndRead({
    dispatchImpl: async () => ({
      ...okResult,
      ok: false,
      status: 'error',
      reason: 'provider_error',
      text: null,
      usage: null,
      error: { code: 'auth', message: 'mock: 401', retryable: false, httpStatus: 401, detail: null, provider: 'mock' },
    }),
  })
  const row = r.records[0]
  assert.equal(row.status, 'error')
  assert.equal(row.error_code, 'auth')
  assert.equal(row.task_type, 'bulk_read', 'it was a delegation attempt, whatever became of it')
  assert.equal(row.error_message_safe, null, 'storeErrorDetail is off by default')
})

/* -------------------------------------------------- the mandatory translation */

test('no row ever carries unknown_enum:routing_reason', async () => {
  // The symptom of passing a dispatch reason straight through. It would poison the one signal the
  // store has for "something is actually wrong".
  const cases = [
    {},
    { bytes: 200 },
    { dispatchImpl: async () => ({ ...okResult, status: 'error', reason: 'aborted', error: { code: 'aborted' } }) },
    { dispatchImpl: async () => ({ ...okResult, status: 'skipped', reason: 'routing_declined', text: null }) },
    { dispatchImpl: async () => ({ ...okResult, status: 'error', reason: 'payload_too_large', error: { code: 'payload_too_large' } }) },
  ]
  for (const opts of cases) {
    const r = await runAndRead(opts)
    for (const row of r.records) {
      assert.ok(ROUTING_REASONS.includes(row.routing_reason), `${row.routing_reason} is a declared reason`)
      assert.equal(
        String(row.validation_codes ?? '').includes('unknown_enum:routing_reason'),
        false,
        JSON.stringify(opts),
      )
      assert.ok(TASK_TYPES.includes(row.task_type), row.task_type)
    }
  }
})

test('the reason translation is exactly the documented table', async () => {
  const decision = delegatingDecision()
  assert.equal(routingReasonFor(decision, null), 'threshold_met', 'no dispatch: echo the decision')
  assert.equal(routingReasonFor(decision, { reason: 'completed' }), 'threshold_met')
  assert.equal(routingReasonFor(decliningDecision(), { reason: 'routing_declined' }), 'below_threshold')
  for (const reason of ['aborted', 'provider_error', 'payload_too_large', 'unsupported_mode', 'invalid_request']) {
    assert.equal(routingReasonFor(decision, { reason }), 'provider_error', reason)
  }
})

test('a decision with no usable reason still produces a declared enum value', async () => {
  for (const decision of [null, undefined, {}, { reason: 42 }]) {
    assert.ok(ROUTING_REASONS.includes(routingReasonFor(decision, null)), JSON.stringify(decision))
  }
})

/* --------------------------------------------------------- warnings are folded */

test("the gate's complaints about its input are folded into validation_codes", async () => {
  const inputs = toEventInputs({
    decision: delegatingDecision({ inputWarnings: ['type:fileCount', 'unsupported_glob_syntax'] }),
    result: null,
  })
  assert.deepEqual(inputs.extraValidationCodes, ['type:fileCount', 'unsupported_glob_syntax'])
})

test('a malformed warning list is ignored rather than stringified into a code', async () => {
  for (const inputWarnings of [null, undefined, 'x', 42, {}]) {
    const inputs = toEventInputs({ decision: delegatingDecision({ inputWarnings }), result: null })
    assert.equal(inputs.extraValidationCodes, null, JSON.stringify(inputWarnings))
  }
})

/* ------------------------------------------------------------------- privacy */

test('the default privacy level stores no path, no question and no content', async () => {
  const r = await runAndRead()
  const row = r.records[0]
  assert.equal(row.privacy_level, 'hashed')
  assert.equal(row.project_path, null)
  assert.equal(row.question_text, null, 'storeQuestionText is off by default')
  const serialized = JSON.stringify(row)
  assert.equal(serialized.includes(r.ws.file), false, 'the file path is not in the row')
  assert.equal(serialized.includes('export const value'), false, 'no file content is in the row')
  assert.equal(serialized.includes('A SUMMARY OF THE FILE'), false, "no worker answer is in the row")
})

test('the task is stored only when question text is explicitly turned on, and only for a delegation', async () => {
  const on = { telemetry: { storeQuestionText: true } }
  const delegated = await runAndRead({ patch: on })
  assert.match(delegated.records[0].question_text, /^Summarise this file/)

  const refused = await runAndRead({ bytes: 200, patch: on })
  assert.equal(refused.records[0].question_text, null, 'no task was ever built for a refused read')
})
