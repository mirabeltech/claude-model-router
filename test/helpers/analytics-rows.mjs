/**
 * Row builders for the analytics tests.
 *
 * Built through `projectRecord()` so every row carries all 101 declared columns with explicit
 * nulls, exactly as a stored row does. A hand-written partial object would let a test pass
 * against a shape the reader never produces — and the single most common analytics bug is reading
 * a field that is null in practice, which a partial fixture hides by omitting it entirely.
 *
 * Three builders, one per row KIND, because the kinds are not variations of each other: a gate row
 * has no worker call at all, a governance denial is a gate row that the gate APPROVED, and a
 * dispatched row is the only kind that carries usage.
 */

import { FIXTURE_ROUTER_VERSION } from './versions.mjs'
import { projectRecord } from '../../plugins/model-router/lib/telemetry/record.mjs'

/** 2026-03-04T12:00:00.000Z, matching telemetry-dir.mjs so fixtures and builders agree. */
export const NOW = Date.parse('2026-03-04T12:00:00.000Z')

let seq = 0
/** Reset the id counter so a test that asserts on ids is order-independent. */
export function resetIds() {
  seq = 0
}

function identity(over) {
  seq += 1
  return {
    schema_version: 1,
    event_id: `t${String(seq).padStart(4, '0')}`,
    task_id: `toolu_${String(seq).padStart(6, '0')}`,
    timestamp: over.timestamp ?? new Date(NOW - 60_000).toISOString(),
    tz_offset_minutes: 0,
    router_version: FIXTURE_ROUTER_VERSION,
    calc_version: 1,
    currency: 'USD',
    privacy_level: 'hashed',
    session_id: 'sess0000000000000000000000000000',
    project_id: 'proj0000000000000000000000000000',
    routing_policy_version: 1,
    validation_warnings: 0,
    validation_codes: null,
    truncated: false,
  }
}

/** A gate_block row: the gate declined and nothing was dispatched. */
export function gateRow(over = {}) {
  return projectRecord({
    ...identity(over),
    pricing_version: null,
    pricing_source: 'none',
    pricing_lookup: 'no_table',
    task_type: 'gate_block',
    routing_decision: 'allow',
    routing_reason: 'below_threshold',
    task_intent_source: null,
    provider: null,
    model: null,
    model_requested: null,
    worker_usage_source: 'missing',
    worker_thinking_assumption: 'unknown',
    worker_token_sum_check: 'unknown',
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
    input_bytes: 900,
    estimated_tokens_avoided_status: 'unavailable',
    estimated_cost_avoided_status: 'unavailable',
    estimated_net_savings_status: 'unavailable',
    status: 'skipped',
    error_code: null,
    // Both latency columns are null on every gate row, by design.
    latency_ms: null,
    provider_latency_ms: null,
    retry_count: null,
    ...over,
  })
}

/**
 * A governance denial. A gate_block row whose `routing_reason` is `threshold_met` — THE GATE
 * APPROVED — with `governance_decision: 'deny'` as the only field that records the refusal.
 */
export function denialRow(over = {}) {
  return gateRow({
    routing_decision: 'delegated',
    routing_reason: 'threshold_met',
    provider: 'gemini',
    input_bytes: 40000,
    governance_decision: 'deny',
    governance_reason: 'daily_budget_exceeded',
    budget_scope: 'daily',
    budget_limit: 1.5,
    budget_remaining: 0,
    budget_measurement_status: 'measured',
    reservation_status: 'released',
    // status is `skipped` and error_code is null: a refusal is never an error.
    status: 'skipped',
    error_code: null,
    ...over,
  })
}

/** A dispatched bulk_read row that succeeded. Unpriced by default — the shipped state. */
export function dispatchedRow(over = {}) {
  return gateRow({
    task_type: 'bulk_read',
    routing_decision: 'delegated',
    routing_reason: 'threshold_met',
    prompt_version: 3,
    task_intent_source: 'none',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    model_requested: 'gemini-2.5-flash',
    pricing_lookup: 'exact',
    worker_usage_source: 'provider_reported',
    provider_reports_usage: true,
    provider_reports_thinking_tokens: false,
    provider_supports_cached_input: false,
    worker_input_tokens: 9000,
    worker_cached_input_tokens: 0,
    worker_output_tokens: 600,
    worker_thought_tokens: 0,
    worker_total_tokens: 9600,
    worker_billable_output_tokens: 600,
    worker_thinking_assumption: 'structural_zero',
    worker_token_sum_check: 'ok',
    worker_context_tokens: 1048576,
    worker_context_source: 'bundled_default',
    worker_context_status: 'assumed',
    worker_configured_max_output_tokens: 8192,
    worker_requested_input_tokens: 9000,
    worker_observed_prompt_tokens: 9000,
    worker_input_truncation_detected: false,
    input_bytes: 36000,
    estimated_input_tokens: 9000,
    returned_answer_chars: 2400,
    returned_answer_tokens_estimated: 600,
    estimated_tokens_avoided: 8400,
    estimated_tokens_avoided_status: 'estimated',
    status: 'ok',
    latency_ms: 2400,
    provider_latency_ms: 2100,
    retry_count: 0,
    finish_reason: 'stop',
    governance_decision: 'allow',
    governance_reason: 'budget_not_configured',
    budget_measurement_status: 'unavailable',
    reservation_status: 'none',
    ...over,
  })
}

/** A dispatched row with cost populated, as a configured pricing table produces. */
export function pricedRow(over = {}) {
  return dispatchedRow({
    pricing_version: '2026-02-01',
    pricing_source: 'file',
    primary_model: 'claude-sonnet-4-5',
    worker_input_cost: 0.0027,
    worker_input_cost_status: 'actual',
    worker_cached_input_cost: 0,
    worker_cached_input_cost_status: 'actual',
    worker_output_cost: 0.0015,
    worker_output_cost_status: 'actual',
    worker_total_cost: 0.0042,
    worker_total_cost_status: 'actual',
    estimated_cost_avoided: 0.0252,
    estimated_cost_avoided_status: 'estimated',
    estimated_net_savings: 0.021,
    estimated_net_savings_status: 'estimated',
    ...over,
  })
}

/** A dispatched row that failed in the provider. Usage and cost are unknown, never zero. */
export function errorRow(over = {}) {
  return dispatchedRow({
    status: 'error',
    error_code: 'timeout',
    routing_reason: 'provider_error',
    model: null,
    worker_usage_source: 'missing',
    worker_input_tokens: null,
    worker_cached_input_tokens: null,
    worker_output_tokens: null,
    worker_thought_tokens: null,
    worker_total_tokens: null,
    worker_billable_output_tokens: null,
    worker_thinking_assumption: 'unknown',
    worker_token_sum_check: 'unknown',
    estimated_input_tokens: null,
    returned_answer_chars: null,
    returned_answer_tokens_estimated: null,
    estimated_tokens_avoided: null,
    estimated_tokens_avoided_status: 'unavailable',
    latency_ms: 30200,
    provider_latency_ms: null,
    retry_count: 2,
    finish_reason: null,
    ...over,
  })
}
