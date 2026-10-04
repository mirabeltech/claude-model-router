/**
 * What each metric COUNTS. The numerators live here.
 *
 * Deliberately separate from select.mjs, which decides what the window CONTAINS. The two look
 * alike and are not: a selector sets the denominator, a predicate sets a numerator. One file
 * holding both is how an edit to a numerator silently becomes an edit to a denominator, and the
 * delegation rate is exactly the metric that would break without anyone noticing.
 *
 * THE FOUR CONDITIONS THAT MUST NEVER MERGE. A worker failure, a governance denial, a capability
 * refusal and an unknown-cost event are four different facts with four different responses, and
 * the telemetry row makes three of them easy to confuse:
 *
 *   - A governance denial is written as a `gate_block` row whose `routing_reason` is
 *     `threshold_met` — THE GATE APPROVED. Only `governance_decision` records the refusal, and
 *     `status` is `skipped` with `error_code: null`, so it is neither a gate refusal nor an error.
 *   - A capability refusal carries `routing_reason: 'context_exceeded'`, which is deliberately
 *     not `provider_error`: the provider did nothing wrong and was usually never called.
 *   - An unknown-cost event is a perfectly successful delegation whose price cannot be stated.
 *
 * So no counter here is derived by subtracting another. Each is its own predicate over named
 * fields, which is what stops a future row class quietly inflating one of them.
 */

import { bucket } from '../telemetry/record.mjs'
import { KNOWN_SCHEMA_VERSIONS } from '../telemetry/aggregate.mjs'
import { GATE_REFUSAL_REASONS, ROW_CLASSES } from './schema.mjs'

const GATE_REFUSAL_SET = new Set(GATE_REFUSAL_REASONS)

/** The eight governance columns. All null means governance was never consulted. */
export const GOVERNANCE_FIELDS = Object.freeze([
  'governance_decision',
  'governance_reason',
  'budget_scope',
  'budget_limit',
  'budget_remaining',
  'budget_measurement_status',
  'reservation_tokens',
  'reservation_status',
])

/** A row this build can read at all. Checked before anything else classifies it. */
export const isReadable = (row) => KNOWN_SCHEMA_VERSIONS.has(row?.schema_version)

/** A row on which the gate ruled and nothing was dispatched. */
const isGateRow = (row) => row?.task_type === 'gate_block'

/**
 * Classify a row into exactly one of {@link ROW_CLASSES}.
 *
 * ORDER IS LOAD-BEARING. `governanceDenied` is tested before `gateRefused` because a budget
 * refusal and a gate refusal are the same `task_type` with the same `routing_reason`; testing the
 * task type first would file every denial under gate refusals and lose the governance signal
 * entirely.
 */
export function classifyRow(row) {
  if (!isReadable(row)) return 'schemaIncompatible'

  if (isGateRow(row)) {
    if (row.governance_decision === 'deny') return 'governanceDenied'
    if (GATE_REFUSAL_SET.has(row.routing_reason)) return 'gateRefused'
    // The gate approved, governance (if consulted) approved, and nothing was dispatched.
    // `content_unreadable` and `content_binary` land here, and NOTHING ON THE ROW SAYS SO:
    // `error_code` is null and no `routing_reason` names them. Reported under its own name with
    // `ambiguous: true` rather than folded into gate refusals, because a refusal we cannot
    // explain is a different thing from one we can. A real telemetry gap.
    return 'approvedNotDispatched'
  }

  if (row.status === 'ok') return 'delegationOk'
  if (row.status === 'error') return 'delegationError'
  // `skipped` on a dispatched row is a refusal that happened after the gate: a pre-flight
  // context refusal, or a post-hoc truncation discard.
  return 'delegationSkipped'
}

/* --------------------------------------------------------------- predicates */

/**
 * Named row predicates. Every one is a pure function of one row and reads only fields the
 * allowlist admits.
 *
 * A predicate is false for an unreadable row wherever that matters — a count must never include a
 * row whose schema this build cannot interpret — and `classifyRow` handles that centrally, so the
 * predicates below assume nothing and check `isReadable` where it changes the answer.
 */
export const predicates = Object.freeze({
  /* ---- populations ---- */

  countable: (row) => isReadable(row),

  dispatchAttempted: (row) => isReadable(row) && !isGateRow(row),

  delegationOk: (row) => isReadable(row) && !isGateRow(row) && row.status === 'ok',

  /** At least one governance column is non-null, i.e. governance actually ran. */
  governanceConsulted: (row) =>
    isReadable(row) && GOVERNANCE_FIELDS.some((f) => row[f] !== null && row[f] !== undefined),

  /** All eight null: governance was NEVER consulted. A different state from "it allowed this". */
  governanceNotConsulted: (row) =>
    isReadable(row) && GOVERNANCE_FIELDS.every((f) => row[f] === null || row[f] === undefined),

  capabilityKnown: (row) => isReadable(row) && typeof row.worker_context_tokens === 'number',

  capabilityUnknown: (row) => isReadable(row) && row.worker_context_status === 'unknown',

  retryFreeDispatch: (row) => isReadable(row) && !isGateRow(row) && row.retry_count === 0,

  /* ---- the four that must never merge ---- */

  /**
   * A WORKER FAILURE: the provider was called and something went wrong. `context_exceeded` is
   * excluded on purpose — it is a refusal, and the provider did nothing wrong.
   */
  workerFailure: (row) =>
    isReadable(row) && !isGateRow(row) && row.status === 'error' && row.routing_reason !== 'context_exceeded',

  /**
   * A GOVERNANCE DENIAL. The only discriminator is this column: `task_type` is `gate_block` and
   * `routing_reason` is `threshold_met`, because the gate approved before governance refused.
   */
  governanceDenied: (row) => isReadable(row) && row.governance_decision === 'deny',

  governanceAllowed: (row) => isReadable(row) && row.governance_decision === 'allow',

  /** A CAPABILITY REFUSAL: the prompt did not fit the worker's window. Never a provider error. */
  capabilityRefusal: (row) => isReadable(row) && row.routing_reason === 'context_exceeded',

  /**
   * Pre-flight: refused before the call, so no usage, no cost and nothing wasted.
   * `worker_input_truncation_detected` is TRI-STATE, so this tests `!== true` rather than
   * `=== false` — a null means we could not tell, which is not the same as "not truncated", and
   * it must not be counted as a paid-for discard.
   */
  capabilityRefusalPreflight: (row) =>
    isReadable(row) &&
    row.routing_reason === 'context_exceeded' &&
    row.worker_input_truncation_detected !== true,

  /**
   * The post-hoc truncation discard: the call RAN, tokens were consumed, and the answer was
   * thrown away because the provider silently dropped the middle of the prompt. The purest waste
   * figure in the store, and it must never be averaged into the pre-flight case above.
   */
  capabilityRefusalTruncationDiscarded: (row) =>
    isReadable(row) && row.worker_input_truncation_detected === true,

  /**
   * An UNKNOWN-COST event: a successful delegation whose price cannot be stated. Not a failure,
   * and not zero.
   */
  unknownCost: (row) =>
    isReadable(row) &&
    !isGateRow(row) &&
    row.status === 'ok' &&
    row.worker_total_cost === null &&
    row.worker_total_cost_status === 'unavailable',

  /**
   * A STRUCTURALLY ZERO cost: an operator-configured rate of literal `0` that `rate()` preserved.
   * A real, known, measured zero — the opposite of the row above, and the two must never render
   * the same way.
   */
  zeroCost: (row) => isReadable(row) && row.worker_total_cost === 0 && row.worker_total_cost_status === 'actual',

  knownCost: (row) => isReadable(row) && typeof row.worker_total_cost === 'number',

  /* ---- usage ---- */

  usageReported: (row) => isReadable(row) && row.worker_usage_source === 'provider_reported',
  usagePartial: (row) => isReadable(row) && row.worker_usage_source === 'provider_partial',
  /** A dispatched row that reported no usage at all. Unknown, never zero. */
  usageMissing: (row) => isReadable(row) && !isGateRow(row) && row.worker_usage_source === 'missing',
  tokenSumMismatch: (row) => isReadable(row) && row.worker_token_sum_check === 'mismatch',

  /* ---- outcomes ---- */

  /**
   * Dispatched and delivered nothing usable. The worker-overhead population: money and tokens
   * the worker consumed that bought nothing.
   *
   * It includes the truncation discard even though that row's `status` is `skipped`, because the
   * call was paid for. A pre-flight refusal is NOT here: nothing was spent.
   */
  noUsableAnswer: (row) =>
    isReadable(row) &&
    !isGateRow(row) &&
    (row.status !== 'ok' || row.worker_input_truncation_detected === true),

  /* ---- answer quality: the population whose correctness is NOT measured ---- */

  /**
   * An answer that was actually DELIVERED to Claude: dispatched, ok, and non-empty.
   *
   * This is the population the `answerQuality` section exists to describe, and the reason it is
   * not simply `delegationOk` is the next predicate: what matters about a delivered answer is how
   * much of it we could verify, and that question only applies to answers somebody received.
   */
  answerDelivered: (row) =>
    isReadable(row) &&
    !isGateRow(row) &&
    row.status === 'ok' &&
    typeof row.returned_answer_chars === 'number' &&
    row.returned_answer_chars > 0,

  /**
   * THE RESIDUAL RISK, and the only honest per-answer confidence signal in the store.
   *
   * A delivered answer whose context window could not be determined. It matters because
   * truncation detection needs a window: with one, an answer built from a silently middle-dropped
   * prompt is detected and DISCARDED (see `capabilityRefusalTruncationDiscarded`, which is that
   * defence working). Without one, the same thing could have happened and nothing would notice.
   *
   * So this is not "the answer is wrong". It is "this answer is the kind we cannot vouch for",
   * which is a measured fact about our own coverage rather than a guess about the model.
   */
  answerUnverifiedWindow: (row) =>
    isReadable(row) &&
    !isGateRow(row) &&
    row.status === 'ok' &&
    row.worker_context_status === 'unknown',

  truncatedAnswer: (row) => isReadable(row) && row.truncated === true,
  retried: (row) => isReadable(row) && typeof row.retry_count === 'number' && row.retry_count > 0,
  /** `retry_count` is null: unknown, and explicitly never defaulted to 0. */
  retryCountUnknown: (row) => isReadable(row) && !isGateRow(row) && row.retry_count === null,

  /* ---- savings ---- */

  negativeTokens: (row) =>
    isReadable(row) && typeof row.estimated_tokens_avoided === 'number' && row.estimated_tokens_avoided < 0,

  negativeDollars: (row) =>
    isReadable(row) && typeof row.estimated_net_savings === 'number' && row.estimated_net_savings < 0,

  /* ---- data quality ---- */

  /**
   * The row carries a stored enum value this build does not know. `toEnum()` preserves the value
   * verbatim and records the code, so this is how an unknown value is told from a deliberate one.
   */
  hasUnknownEnum: (row) =>
    typeof row?.validation_codes === 'string' && row.validation_codes.includes('unknown_enum:'),

  priced: (row) => isReadable(row) && row.pricing_source === 'file',
})

/** Every predicate name, for the census test. */
export const PREDICATE_NAMES = Object.freeze(Object.keys(predicates))

/**
 * Which kind of `other` a bucketed value is, for ONE named field.
 *
 * `other` is a literal member of most enums in record.mjs, so a row can carry it DELIBERATELY —
 * and an unknown value also buckets to `other` on read. The two are different facts, and
 * `validation_codes` separates them only when it is present.
 *
 * Returns `'deliberate'`, `'unknown_enum'`, `'indeterminate'`, or null when the value is not an
 * `other` at all. The third is not laziness: on a row whose `validation_codes` is null there is
 * genuinely no evidence either way, and reporting a guess as one of the first two would invent a
 * distinction the store does not hold.
 *
 * TWO THINGS IT REFUSES TO CONFLATE, both found by a test rather than by reasoning:
 *
 *   - A NULL IS NOT AN `other`. `bucket(null, known)` returns `'other'`, because null is not a
 *     member of any list — but "the writer chose a value this build does not know" and "there was
 *     no value" are different facts with different fixes, and the histogram already carries a
 *     separate null bucket. Without this guard, every row with a null `budget_scope` was counted
 *     as an unexplained enum.
 *   - THE CODE MUST NAME THIS FIELD. A row carrying `unknown_enum:routing_reason` says nothing
 *     about its `budget_scope`, so the presence of *any* code is not evidence about *this*
 *     column. Measured before the fix: a null `budget_scope` on a row with an unrelated
 *     routing_reason code was reported as a `deliberate` other.
 */
export function otherKindOf(row, field, known) {
  const raw = row?.[field]
  if (raw === null || raw === undefined) return null
  if (bucket(raw, known).bucket !== 'other') return null
  if (raw === 'other') {
    // The writer emitted the literal. Only a code naming THIS field could contradict that, and
    // a writer that emitted `other` deliberately does not also flag it.
    return namesField(row, field) ? 'unknown_enum' : row?.validation_codes === null ? 'indeterminate' : 'deliberate'
  }
  // A value outside the list that is not the literal `other` can only be an unknown enum; the
  // code should confirm it, but its absence does not make the value known.
  return namesField(row, field) ? 'unknown_enum' : 'indeterminate'
}

/** Does `validation_codes` flag an unknown enum for this specific field? */
function namesField(row, field) {
  return (
    typeof row?.validation_codes === 'string' && row.validation_codes.includes(`unknown_enum:${field}`)
  )
}

/** A frozen zeroed tally over {@link ROW_CLASSES}, so every class is reported even at zero. */
export function emptyClassCounts() {
  const out = {}
  for (const name of ROW_CLASSES) out[name] = 0
  return out
}
