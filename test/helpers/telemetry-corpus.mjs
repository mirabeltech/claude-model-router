/**
 * A synthetic telemetry store, written into test/.tmp, for the performance ceilings.
 *
 * WHY GENERATED AND NOT COMMITTED. A 100,000-row store is 40-80 MB. Committing that to assert a
 * ceiling would dominate every clone and every CI checkout on both matrix platforms, for a test
 * that never reads an individual value. The hand-authored corpus in `test/fixtures/telemetry/`
 * exists for correctness, where the exact bytes matter; this exists for throughput, where only
 * the count does.
 *
 * DETERMINISTIC FROM A SEED, via a tiny xorshift rather than Math.random. A perf fixture that
 * cannot be reproduced cannot be bisected, and the repo already bans Math.random in the layers
 * that need to be reproducible. The same seed and row count always produce the same bytes.
 *
 * IT WRITES THROUGH THE SHIPPED SERIALIZER. `serializeRecord()` does the projection, the
 * sanitisation and the size guard, so the bytes are real wire format rather than a test-only
 * shape. A store built from a hand-rolled `JSON.stringify` would let the analytics layer pass a
 * throughput test against rows the reader would never actually see.
 */

import { FIXTURE_ROUTER_VERSION } from './versions.mjs'
import fs from 'node:fs'
import path from 'node:path'

import { serializeRecord } from '../../plugins/model-router/lib/telemetry/contract.mjs'
import { FROZEN_MS } from './telemetry-dir.mjs'

/** xorshift32, seeded from a string. Small, fast, and reproducible across platforms. */
function rng(seed) {
  let s = 2166136261
  for (const ch of String(seed)) {
    s ^= ch.charCodeAt(0)
    s = Math.imul(s, 16777619)
  }
  s = s >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x1_0000_0000
  }
}

const PROVIDERS = Object.freeze([
  { provider: 'gemini', model: 'gemini-2.5-flash', ctx: 1048576, source: 'bundled_default', status: 'assumed' },
  { provider: 'gemini', model: 'gemini-2.5-pro', ctx: 1048576, source: 'bundled_default', status: 'assumed' },
  { provider: 'ollama', model: 'llama3.1:8b', ctx: 8192, source: 'provider_api', status: 'measured' },
  { provider: 'ollama', model: 'qwen2.5-coder:7b', ctx: 32768, source: 'provider_api', status: 'measured' },
])

const GATE_REASONS = Object.freeze([
  'below_threshold',
  'recently_edited',
  'targeted_read',
  'deny_glob',
  'task_type_excluded',
  'interactive',
])

const ERROR_CODES = Object.freeze(['timeout', 'provider_http_5xx', 'aborted', 'invalid_response'])

/**
 * One row, chosen by `pick` so the mix is realistic: roughly 45% successful delegations, 30%
 * gate refusals, 10% governance denials, 8% provider errors, 7% context refusals. Half of the
 * delegations are priced and half are not, which is what gives every cost aggregate a partial
 * coverage to report rather than a trivially complete or trivially empty one.
 */
function buildRow({ i, r, priced, dayMs }) {
  const w = PROVIDERS[Math.floor(r() * PROVIDERS.length)]
  const roll = r()
  const inputTokens = 2000 + Math.floor(r() * 24000)
  const outputTokens = 200 + Math.floor(r() * 2000)
  const answerTokens = Math.floor(outputTokens * (0.8 + r() * 0.6))

  const base = {
    schema_version: 1,
    event_id: `perf-${String(i).padStart(7, '0')}`,
    timestamp: new Date(dayMs).toISOString(),
    tz_offset_minutes: 0,
    router_version: FIXTURE_ROUTER_VERSION,
    calc_version: 1,
    pricing_version: priced ? '2026-02-01' : null,
    pricing_source: priced ? 'file' : 'none',
    currency: 'USD',
    privacy_level: 'hashed',
    session_id: `s${String(i % 97).padStart(31, '0')}`,
    project_id: `p${String(i % 7).padStart(31, '0')}`,
    project_path: null,
    task_id: `toolu_${String(i).padStart(9, '0')}`,
    routing_policy_version: 1,
    task_intent_source: null,
    worker_usage_source: 'missing',
    worker_thinking_assumption: 'unknown',
    worker_token_sum_check: 'unknown',
    primary_model: priced ? 'claude-sonnet-4-5' : null,
    primary_usage_method: 'none',
    primary_usage_status: 'unavailable',
    worker_input_cost_status: 'unavailable',
    worker_cached_input_cost_status: 'unavailable',
    worker_output_cost_status: 'unavailable',
    worker_total_cost_status: 'unavailable',
    primary_input_cost_status: 'unavailable',
    primary_output_cost_status: 'unavailable',
    primary_total_cost_status: 'unavailable',
    avoided_method: 'chars_div_4',
    counterfactual_render: 'raw',
    count_proven_files_only: true,
    residency_turns: 0,
    residency_source: 'default_zero',
    files_count: 1,
    files_inferred_count: 0,
    input_bytes: inputTokens * 4,
    estimated_tokens_avoided_status: 'unavailable',
    estimated_cost_avoided_status: 'unavailable',
    estimated_net_savings_status: 'unavailable',
    truncated: false,
    validation_warnings: 0,
    validation_codes: null,
    pricing_lookup: priced ? 'exact' : 'no_table',
  }

  // A gate refusal: nothing dispatched, no governance consulted.
  if (roll < 0.3) {
    return {
      ...base,
      task_type: 'gate_block',
      routing_decision: 'allow',
      routing_reason: GATE_REASONS[Math.floor(r() * GATE_REASONS.length)],
      provider: null,
      model: null,
      model_requested: null,
      status: 'skipped',
      error_code: null,
      input_bytes: Math.floor(r() * 11000),
    }
  }

  // A governance denial: the gate APPROVED, so routing_reason stays threshold_met.
  if (roll < 0.4) {
    return {
      ...base,
      task_type: 'gate_block',
      routing_decision: 'delegated',
      routing_reason: 'threshold_met',
      provider: w.provider,
      model: null,
      model_requested: null,
      status: 'skipped',
      error_code: null,
      governance_decision: 'deny',
      governance_reason: r() < 0.7 ? 'daily_budget_exceeded' : 'cost_unknown',
      budget_scope: 'daily',
      budget_limit: 1.5,
      budget_remaining: r() < 0.7 ? 0 : null,
      budget_measurement_status: r() < 0.7 ? 'measured' : 'unavailable',
      reservation_status: 'released',
    }
  }

  const dispatched = {
    ...base,
    task_type: 'bulk_read',
    routing_decision: 'delegated',
    routing_reason: 'threshold_met',
    prompt_version: 3,
    task_intent_source: 'none',
    provider: w.provider,
    model: w.model,
    model_requested: w.model,
    worker_context_tokens: w.ctx,
    worker_context_source: w.source,
    worker_context_status: w.status,
    worker_configured_max_output_tokens: 8192,
    worker_requested_input_tokens: inputTokens,
    worker_input_truncation_detected: false,
    governance_decision: 'allow',
    governance_reason: 'budget_not_configured',
    budget_measurement_status: 'unavailable',
    reservation_status: 'none',
  }

  // A context refusal, pre-flight: refused before the call, so no usage and no cost.
  if (roll < 0.47) {
    return {
      ...dispatched,
      routing_reason: 'context_exceeded',
      model: null,
      status: 'skipped',
      error_code: null,
      worker_input_truncation_detected: null,
      latency_ms: 20 + Math.floor(r() * 60),
      provider_latency_ms: null,
      retry_count: 0,
    }
  }

  // A provider failure: the worker was called and something went wrong.
  if (roll < 0.55) {
    return {
      ...dispatched,
      routing_reason: 'provider_error',
      model: null,
      status: 'error',
      error_code: ERROR_CODES[Math.floor(r() * ERROR_CODES.length)],
      latency_ms: 500 + Math.floor(r() * 30000),
      provider_latency_ms: null,
      retry_count: Math.floor(r() * 3),
      finish_reason: null,
    }
  }

  // A successful delegation. Priced half the time, so cost coverage is genuinely partial.
  const providerLatency = 400 + Math.floor(r() * 20000)
  const retries = r() < 0.85 ? 0 : 1 + Math.floor(r() * 2)
  const inputCost = priced ? Math.round(inputTokens * 0.3) / 1e6 : null
  const outputCost = priced ? Math.round(outputTokens * 2.5) / 1e6 : null
  const totalCost = priced ? inputCost + outputCost : null
  const avoided = inputTokens - answerTokens
  const costAvoided = priced ? Math.round(avoided * 3) / 1e6 : null

  return {
    ...dispatched,
    worker_usage_source: 'provider_reported',
    provider_reports_usage: true,
    provider_reports_thinking_tokens: false,
    provider_supports_cached_input: false,
    worker_input_tokens: inputTokens,
    worker_cached_input_tokens: 0,
    worker_output_tokens: outputTokens,
    worker_thought_tokens: 0,
    worker_total_tokens: inputTokens + outputTokens,
    worker_billable_output_tokens: outputTokens,
    worker_thinking_assumption: 'structural_zero',
    worker_token_sum_check: 'ok',
    worker_observed_prompt_tokens: inputTokens,
    worker_input_cost: inputCost,
    worker_input_cost_status: priced ? 'actual' : 'unavailable',
    worker_cached_input_cost: priced ? 0 : null,
    worker_cached_input_cost_status: priced ? 'actual' : 'unavailable',
    worker_output_cost: outputCost,
    worker_output_cost_status: priced ? 'actual' : 'unavailable',
    worker_total_cost: totalCost,
    worker_total_cost_status: priced ? 'actual' : 'unavailable',
    estimated_input_tokens: inputTokens,
    returned_answer_chars: answerTokens * 4,
    returned_answer_tokens_estimated: answerTokens,
    estimated_tokens_avoided: avoided,
    estimated_tokens_avoided_status: 'estimated',
    estimated_cost_avoided: costAvoided,
    estimated_cost_avoided_status: priced ? 'estimated' : 'unavailable',
    estimated_net_savings: priced ? costAvoided - totalCost : null,
    estimated_net_savings_status: priced ? 'estimated' : 'unavailable',
    status: 'ok',
    error_code: null,
    latency_ms: providerLatency + 20 + Math.floor(r() * 80),
    provider_latency_ms: providerLatency,
    retry_count: retries,
    finish_reason: 'stop',
  }
}

/**
 * Write a synthetic store of `rows` events into `dir`, spread across `days` daily segments.
 *
 * Returns the counts the caller needs to assert against, measured while writing rather than
 * predicted — the same rule the hand-authored corpus follows.
 *
 * @param {object} opts
 * @param {string} opts.dir            destination, normally from makeTempDir()
 * @param {number} opts.rows           total events to write
 * @param {string} [opts.seed]         anything stringifiable; the same seed gives the same bytes
 * @param {number} [opts.days]         how many daily segments to spread across
 * @param {number} [opts.now]          the newest instant; segments run backwards from here
 * @param {object} [opts.fsImpl]       injected for symmetry with the rest of the layer
 */
export function writeSyntheticStore({ dir, rows, seed = 'phase-10', days = 7, now = FROZEN_MS, fsImpl = fs }) {
  fsImpl.mkdirSync(dir, { recursive: true })
  const r = rng(seed)

  const counts = { rows: 0, bytes: 0, pricedRows: 0, nullCostRows: 0, gateRows: 0, segments: [] }
  const perDay = Math.ceil(rows / days)

  for (let d = 0; d < days && counts.rows < rows; d++) {
    // Walk backwards from `now` so the newest segment is today and a 7d window covers them all.
    const dayStart = now - d * 86_400_000
    const date = new Date(dayStart).toISOString().slice(0, 10)
    const file = path.join(dir, `events-${date}.jsonl`)
    const chunks = []

    for (let k = 0; k < perDay && counts.rows < rows; k++) {
      const i = counts.rows
      // Spread the instants across the day, monotonically, so a precise timestamp filter has
      // something real to cut on and two rows never share an instant.
      const dayMs = dayStart - Math.floor((k / perDay) * 86_000_000)
      const priced = r() < 0.5
      const { line } = serializeRecord(buildRow({ i, r, priced, dayMs }))
      if (line === null) throw new Error(`synthetic row ${i} failed to serialize`)
      chunks.push(line)
      counts.bytes += line.length
      counts.rows += 1
      if (priced) counts.pricedRows += 1
      const row = JSON.parse(line.toString('utf8'))
      if (row.worker_total_cost === null) counts.nullCostRows += 1
      if (row.task_type === 'gate_block') counts.gateRows += 1
    }

    fsImpl.writeFileSync(file, Buffer.concat(chunks))
    counts.segments.push(path.basename(file))
  }

  return { dir, ...counts }
}
