/**
 * The telemetry event contract: field order, required keys, open enums.
 *
 * Three rules govern this file, and every other telemetry module defers to it:
 *
 *  1. FLAT AND SCALAR-ONLY. Every value is string | number | boolean | null. No objects and no
 *     arrays — an array is nesting with extra steps, and it breaks the 1:1 JSONL -> SQL column
 *     mapping that lets the store move to SQLite or ClickHouse without touching a caller.
 *
 *  2. NULL IS WRITTEN EXPLICITLY. A key is never omitted and `undefined` never appears. "Absent
 *     key" and "null key" must not be two ways of saying the same thing, because the whole
 *     savings model rests on telling a measured zero from an unknown.
 *
 *  3. ENUMS ARE CLOSED ON WRITE, OPEN ON READ. Writers emit only listed values; readers preserve
 *     an unknown value verbatim and bucket it as `other` via bucket(). Dropping a record for an
 *     unknown enum would lose data over a vocabulary disagreement.
 *
 * Note the one name that carries two meanings in this schema, deliberately kept for the spec:
 * `status` is the EVENT OUTCOME (ok | error | skipped). Every MEASUREMENT status is a distinct
 * field with an explicit prefix — `worker_input_cost_status`, `primary_usage_status`, and so on.
 */

/** Bumped when a field changes meaning or disappears. Adding a nullable field does not bump it. */
export const SCHEMA_VERSION = 1

/** Bumped on any change to a formula or a null rule in calc.mjs. Stamped on every event. */
export const CALC_VERSION = 1

/**
 * The release version, generated from package.json by scripts/sync-version.mjs and re-exported
 * here so every existing import of ROUTER_VERSION keeps working. A zero-import module rather than
 * a manifest read, because this file is on the PreToolUse hot path.
 */
export { ROUTER_VERSION } from '../version.mjs'

/** Only USD in v1. A table in any other currency is rejected at load rather than converted. */
export const CURRENCY = 'USD'

/* ------------------------------------------------------------------------ enums */

/** Measurement status. Exactly three values, forever. `unavailable` <=> the value is null. */
export const MEASUREMENT = Object.freeze({
  ACTUAL: 'actual',
  ESTIMATED: 'estimated',
  UNAVAILABLE: 'unavailable',
})

export const MEASUREMENT_VALUES = Object.freeze(['actual', 'estimated', 'unavailable'])

/** Event outcome. `skipped` means no worker call was attempted (a gate decision, say). */
export const STATUS_VALUES = Object.freeze(['ok', 'error', 'skipped'])

/** Answer-verification verdicts. Open on read like every other enum: an unknown value buckets. */
export const SUMMARY_VERIFY_VERDICTS = Object.freeze(['verified', 'suspect', 'not_checkable'])

export const TASK_TYPES = Object.freeze(['bulk_read', 'code_write', 'gate_block', 'delegation', 'other'])

export const ROUTING_DECISIONS = Object.freeze([
  'allow',
  'deny',
  'ask',
  'suggest',
  'off',
  'delegated',
  'not_applicable',
  'other',
])

/**
 * Reason CODES, never prose. A free-text reason cannot be grouped, and the dashboard needs to
 * answer "why did routing decline 400 times" without string-matching an English sentence.
 */
export const ROUTING_REASONS = Object.freeze([
  'below_threshold',
  'over_max_files',
  'threshold_met',
  'targeted_read',
  'recently_edited',
  'deny_glob',
  'allow_glob',
  'worker_not_ready',
  'budget_exceeded',
  'disabled',
  'skill_invoked',
  'provider_error',
  // Phase 3 — emitted by lib/routing.mjs decide(). Additive: readers bucket an unknown value
  // as `other`, so an older dashboard still ingests these rows and SCHEMA_VERSION is unchanged.
  'task_type_excluded',
  'interactive',
  'latency_sensitive',
  'unknown_input',
  'precise_output_requested',
  'over_max_input_bytes',
  // Phase 8. The prompt could not fit the WORKER MODEL's context window, so delegation was
  // refused. Distinct from `provider_error` on purpose: the provider did nothing wrong and was
  // very likely never called. Filing these under provider_error would hide the single most
  // important new refusal behind an unrelated bucket. Additive, so no SCHEMA_VERSION bump.
  'context_exceeded',
  'other',
])

/** Verbatim from the provider contract's Usage.source. Never mapped onto MEASUREMENT. */
export const USAGE_SOURCES = Object.freeze(['provider_reported', 'provider_partial', 'missing'])

/** Why worker_billable_output_tokens is what it is. */
export const THINKING_ASSUMPTIONS = Object.freeze(['reported', 'structural_zero', 'unknown'])

/**
 * Where a model's context window came from, and what the number is therefore worth.
 *
 * Declared HERE rather than imported from providers/capability.mjs, because record.mjs is the
 * telemetry contract and imports nothing — a column's vocabulary is a property of the schema, not
 * of whichever layer happens to populate it. A test pins these equal to the provider-side lists,
 * which is the same arrangement DECIDE_REASONS already has with ROUTING_REASONS.
 *
 * Open on read, like every other enum here: an unrecognised value is preserved and bucketed.
 */
export const WORKER_CONTEXT_SOURCES = Object.freeze([
  'provider_api',
  'configured',
  'bundled_default',
  'unknown',
])

/** `configured` is a real source and an explicitly NON-measured status. That is the whole point. */
export const WORKER_CONTEXT_STATUSES = Object.freeze([
  'measured',
  'configured',
  'assumed',
  'unknown',
])

/** Audit flag comparing the component sum against the provider's own total. Never changes a cost. */
export const TOKEN_SUM_CHECKS = Object.freeze(['ok', 'mismatch', 'unknown'])

/** How a rate row was found. Distinguishes an unknown model from a deliberately unpriced one. */
export const PRICING_LOOKUPS = Object.freeze([
  'exact',
  'requested_alias',
  'wildcard',
  'model_unknown',
  'no_table',
])

export const PRICING_SOURCES = Object.freeze(['bundled', 'file', 'none'])

/** How primary-model usage was obtained. `none` is the only reachable value before Phase 3. */
export const PRIMARY_USAGE_METHODS = Object.freeze(['none', 'transcript_measured'])

/**
 * Where the worker's task intent came from.
 *
 * `none` is the shipped default and means the worker got the frozen generic task, which is the
 * behaviour every row written before this field existed also describes. `transcript` means the
 * developer opted in to forwarding the newest prompt from the session transcript. `other` is the
 * open-on-read bucket; it is not reachable from the hook and exists so a future source does not
 * have to be a schema break.
 *
 * This records the SOURCE and never the text. The task itself travels only through
 * `question_text`, which is off by default, clamped and redacted.
 */
export const TASK_INTENT_SOURCES = Object.freeze(['none', 'transcript', 'other'])

/* ---------------------------------------------------------------------- governance
 *
 * Phase 9. Additive and entirely nullable, so SCHEMA_VERSION stays 1: a reader built against
 * the phase-8 schema sees eight columns it does not know and ignores them, which is exactly
 * what the forward-compatibility rule in docs/telemetry-schema.md promises.
 *
 * `governance_decision` is deliberately NOT the same vocabulary as `routing_decision`. Routing
 * answers "what does the hook do to this tool call"; governance answers "are we allowed to
 * delegate right now". Two different questions sharing one enum is how a reader ends up unable
 * to tell a budget refusal from a gate refusal.
 */

/** Open on read, like every other event enum. */
export const GOVERNANCE_DECISION_VALUES = Object.freeze(['allow', 'deny', 'unknown', 'other'])

export const GOVERNANCE_REASON_VALUES = Object.freeze([
  'governance_disabled',
  'budget_not_configured',
  'within_budget',
  'run_budget_exceeded',
  'daily_budget_exceeded',
  'monthly_budget_exceeded',
  'token_budget_exceeded',
  'cost_unknown',
  'usage_unknown',
  'invalid_budget',
  'other',
])

export const BUDGET_SCOPE_VALUES = Object.freeze(['run', 'daily', 'monthly', 'other'])

/**
 * How well the spend behind `budget_remaining` is known.
 *
 * Carries the same invariant the money columns carry: `budget_remaining === null` if and only if
 * this is `unavailable`. `limit - unknown` is never evaluated as though unknown were zero, so an
 * unmeasurable budget reports null headroom rather than full headroom.
 */
export const BUDGET_MEASUREMENT_STATUS_VALUES = Object.freeze(['measured', 'estimated', 'unavailable'])

export const RESERVATION_STATUS_VALUES = Object.freeze([
  'none',
  'reserved',
  'settled',
  'released',
  'overrun',
  'other',
])

export const AVOIDED_METHODS = Object.freeze([
  'chars_div_4',
  'calibrated_cpt',
  'worker_prompt_tokens',
  'anthropic_count_tokens',
])

export const COUNTERFACTUAL_RENDERS = Object.freeze(['raw', 'read_tool'])

export const RESIDENCY_SOURCES = Object.freeze(['default_zero', 'config', 'transcript_measured'])

export const PRIVACY_LEVELS = Object.freeze(['hashed', 'labeled', 'verbose'])

/**
 * Open-enum read helper. Preserves the raw value and offers a bucket for grouping, so an unknown
 * value is never rejected and never silently renamed.
 *
 * @returns {{raw: unknown, bucket: string}}
 */
export function bucket(value, known) {
  const list = Array.isArray(known) ? known : []
  return { raw: value, bucket: list.includes(value) ? value : 'other' }
}

/* ----------------------------------------------------------------- field order */

/**
 * The serialization order. JSON.stringify preserves insertion order for string keys, so writing
 * through this list makes identical input produce byte-identical output — which is what makes the
 * size guard stable and the golden fixtures meaningful.
 *
 * Any field not in this list is dropped by projectRecord(). That is the defence against a caller
 * smuggling an undeclared key (including `__proto__`) into the store.
 */
export const FIELD_ORDER = Object.freeze([
  /* identity and stamps */
  'schema_version',
  'event_id',
  'timestamp',
  'tz_offset_minutes',
  'router_version',
  'calc_version',
  'pricing_version',
  'pricing_source',
  'currency',
  'privacy_level',
  'session_id',
  'project_id',
  'project_path',

  /* task and routing */
  'task_id',
  'task_type',
  'routing_decision',
  'routing_reason',
  // Additive and nullable, so no SCHEMA_VERSION bump: the routing engine and the dispatcher each
  // stamp their own version in their result precisely so the layer that writes a row can record
  // which policy and which prompt produced it. A reader built before these existed still ingests
  // the row, because enums and fields are open on read.
  'routing_policy_version',
  'prompt_version',
  // Beside `prompt_version` because the two answer one question together: which request was made.
  // `prompt_version` names the template, this names where its task text came from. Additive and
  // nullable, so no SCHEMA_VERSION bump. Deliberately NOT a second version counter — the template
  // version already distinguishes a generic request from an intent-aware one.
  'task_intent_source',
  'provider',
  'model',
  'model_requested',
  'pricing_lookup',

  /* worker usage */
  'worker_usage_source',
  'provider_reports_usage',
  'provider_reports_thinking_tokens',
  'provider_supports_cached_input',
  'worker_input_tokens',
  'worker_cached_input_tokens',
  'worker_output_tokens',
  'worker_thought_tokens',
  'worker_total_tokens',
  'worker_billable_output_tokens',
  'worker_thinking_assumption',
  'worker_token_sum_check',

  /* worker context capability — all four additive and nullable, so no SCHEMA_VERSION bump, and
   * none of them participates in cost or savings arithmetic, so no CALC_VERSION bump either.
   *
   * The pair of them is the point: a number without its provenance invites a reader to treat a
   * value we configured, a ceiling the provider advertised and a window we actually measured as
   * the same fact. They are not. See providers/capability.mjs. */
  'worker_context_tokens',
  'worker_context_source',
  'worker_context_status',
  // The two sides of the budget the window produced. `configured` is what the operator asked
  // for; `effective_input_capacity` is what was left for the prompt once the output request was
  // honoured or reduced. Storing both is what makes "was this call capped, and by how much"
  // answerable from a row rather than only from a live dispatch result.
  'worker_configured_max_output_tokens',
  'worker_effective_input_capacity',
  // The other operand, and the one that makes a REFUSAL legible. Without it a
  // `context_exceeded` row says "the window was 8192" and not whether the request was over by
  // a tenth or by tenfold — and the message that would have said so lives in
  // `error_message_safe`, which is null unless `telemetry.storeErrorDetail` is opted into.
  // A token count carries no file content, no task text and no credential, so there is no
  // reason to make this one opt-in.
  'worker_requested_input_tokens',
  // What the runtime reported actually READING, recorded even when the answer was discarded.
  // This is the EVIDENCE for worker_input_truncation_detected: without it the flag is an
  // assertion a reader cannot check, because `worker_input_tokens` beside it comes from the
  // usage block and is null on any non-ok path. Sitting next to
  // `worker_requested_input_tokens`, the pair shows the shortfall directly.
  'worker_observed_prompt_tokens',
  // TRI-STATE: true, false, or null when we could not tell. Never defaulted to false — a
  // reassuring zero here would hide the exact failure this column exists to surface.
  'worker_input_truncation_detected',

  /* primary-model baseline — actual spend, never a counterfactual */
  'primary_model',
  'primary_usage_method',
  'primary_usage_status',
  'primary_input_tokens',
  'primary_output_tokens',
  'primary_total_tokens',

  /* worker money */
  'worker_input_cost',
  'worker_input_cost_status',
  'worker_cached_input_cost',
  'worker_cached_input_cost_status',
  'worker_output_cost',
  'worker_output_cost_status',
  'worker_total_cost',
  'worker_total_cost_status',

  /* primary money */
  'primary_input_cost',
  'primary_input_cost_status',
  'primary_output_cost',
  'primary_output_cost_status',
  'primary_total_cost',
  'primary_total_cost_status',

  /* counterfactual and savings */
  'avoided_method',
  'counterfactual_render',
  'count_proven_files_only',
  'residency_turns',
  'residency_source',
  'files_count',
  'files_inferred_count',
  'input_bytes',
  'estimated_input_tokens',
  'returned_answer_chars',
  'returned_answer_tokens_estimated',
  'estimated_tokens_avoided',
  'estimated_tokens_avoided_status',
  'estimated_cost_avoided',
  'estimated_cost_avoided_status',
  'estimated_net_savings',
  'estimated_net_savings_status',

  /* outcome and performance */
  'status',
  'error_code',
  'error_message_safe',
  'latency_ms',
  'provider_latency_ms',
  'retry_count',
  'truncated',
  'finish_reason',
  'question_text',
  'truncation_steps',
  'validation_warnings',
  'validation_codes',

  /* answer verification. ADDITIVE, so `schema_version` stays 1: a reader built before these
   * existed sees four columns it does not know and ignores them, which is the rule this schema
   * already follows for every other addition.
   *
   * All four are null on a row where verification did not run — a gate refusal, a worker error, or
   * `verify.enabled: false`. Null therefore means "not checked", which is a different and weaker
   * statement than `summary_verify_verdict: 'not_checkable'`, which means "checked, and the answer
   * made no claim that could be checked". Collapsing those two would hide an operator who turned
   * verification off. */
  'summary_verify_verdict',
  'summary_verify_reason',
  'summary_line_claims',
  'summary_line_claims_wrong',

  /* governance (phase 9). All nullable; all null when governance was never evaluated, which is
   * the case for every row where routing refused before the budget was ever consulted. */
  'governance_decision',
  'governance_reason',
  'budget_scope',
  'budget_limit',
  'budget_remaining',
  'budget_measurement_status',
  'reservation_tokens',
  'reservation_status',
])

const FIELD_SET = new Set(FIELD_ORDER)

export function isKnownField(name) {
  return FIELD_SET.has(name)
}

/**
 * Keys the carcass record keeps when the size guard has exhausted everything else. "Required"
 * means the KEY is present, not that the value is non-null — `pricing_version` is legitimately
 * null when no table served.
 */
export const REQUIRED_FIELDS = Object.freeze([
  'schema_version',
  'event_id',
  'timestamp',
  'tz_offset_minutes',
  'router_version',
  'calc_version',
  'pricing_version',
  'pricing_source',
  'currency',
  'privacy_level',
  'task_type',
  'routing_decision',
  'routing_reason',
  'status',
  'truncation_steps',
])

/**
 * The size-guard shed ladder, applied in order until the line fits. Only optional free text is
 * touched; no required field is ever removed and no number is ever altered, so the savings math
 * keeps every input it was computed from even on a truncated record.
 */
export const SHED_ORDER = Object.freeze([
  { field: 'error_message_safe', strategy: 'clamp', keepBytes: 200, step: 'clamp:error_message_safe' },
  { field: 'question_text', strategy: 'clamp', keepBytes: 200, step: 'clamp:question_text' },
  { field: 'error_message_safe', strategy: 'null', step: 'null:error_message_safe' },
  { field: 'question_text', strategy: 'null', step: 'null:question_text' },
])

/**
 * Project an arbitrary object onto the declared field order.
 *
 * Undeclared keys are dropped. A declared key that is absent or `undefined` becomes `null`, so
 * every record has every key and "we did not measure this" is always spelled the same way.
 */
export function projectRecord(input) {
  const src = input ?? {}
  const out = {}
  for (const field of FIELD_ORDER) {
    const v = src[field]
    out[field] = v === undefined ? null : v
  }
  return out
}

/** The carcass: required keys only, every string hard-clamped by the caller. Provably small. */
export function carcassFields() {
  return REQUIRED_FIELDS.slice()
}
