/**
 * Build one flat telemetry event.
 *
 * Pure given its injected `now` and `eventId`: no filesystem, no network, no clock of its own.
 * Identity hashing and pricing-table loading are done by the caller (index.mjs) and passed in,
 * which is what keeps this module unit-testable without touching disk.
 *
 * It consumes the NORMALIZED provider response and never re-parses a provider's wire format. The
 * Gemini cached-input subtraction and the thinking-tokens-excluded-from-output separation are
 * already applied by the provider layer; duplicating either here is how the two layers would
 * drift and how a cached token would get charged twice.
 *
 * DEFENCE IN DEPTH: the provider's own numbers are re-validated at this boundary. The registry
 * contract-checks a provider module's exports, not its arithmetic, and a provider may be
 * third-party code.
 */

import {
  CALC_VERSION,
  CURRENCY,
  ROUTER_VERSION,
  SCHEMA_VERSION,
  AVOIDED_METHODS,
  COUNTERFACTUAL_RENDERS,
  MEASUREMENT,
  PRIMARY_USAGE_METHODS,
  RESIDENCY_SOURCES,
  ROUTING_DECISIONS,
  ROUTING_REASONS,
  STATUS_VALUES,
  SUMMARY_VERIFY_VERDICTS,
  TASK_INTENT_SOURCES,
  TASK_TYPES,
  USAGE_SOURCES,
  WORKER_CONTEXT_SOURCES,
  WORKER_CONTEXT_STATUSES,
  BUDGET_MEASUREMENT_STATUS_VALUES,
  BUDGET_SCOPE_VALUES,
  GOVERNANCE_DECISION_VALUES,
  GOVERNANCE_REASON_VALUES,
  RESERVATION_STATUS_VALUES,
} from './record.mjs'
import {
  calculateAvoidedTokens,
  calculateCost,
  calculateEstimatedCostAvoided,
  calculateEstimatedNetSavings,
  calculateTokenDelta,
} from './calc.mjs'
import { resolveRates } from './pricing-lookup.mjs'
import { clampUtf8 } from './contract.mjs'
import { redactSecrets } from '../redact.mjs'
import {
  createWarnings,
  toBool,
  toByteCount,
  toDurationMs,
  toEnum,
  toEstimatedCount,
  toMoney,
  toReportedCount,
  toRetryCount,
  toSignedCount,
  toText,
} from './validate.mjs'

/** The counterfactual model's provider, for the `provider:model` pricing key. */
export const DEFAULT_PRIMARY_PROVIDER = 'anthropic'

/** Clamp by characters, not bytes — `questionTextMaxChars` is a character budget. */
function clampChars(str, maxChars) {
  if (typeof str !== 'string') return null
  const cps = Array.from(str)
  return cps.length <= maxChars ? str : cps.slice(0, maxChars).join('')
}

/**
 * Apply the configured avoided-method to the worker's returned answer, so the subtraction in
 * calculateTokenDelta is apples-to-apples.
 *
 * This is deliberately NOT `worker_output_tokens`: that is the worker's tokenizer counting the
 * worker's output, whereas the subtrahend has to be what the PRIMARY model would spend ingesting
 * that text. For the two methods that cannot be applied to an arbitrary string
 * (`worker_prompt_tokens`, `anthropic_count_tokens`) the caller must supply the number, and
 * absent it the delta is unavailable rather than mixed-method.
 */
function estimateAnswerTokens({ method, chars, charsPerToken, supplied }) {
  if (supplied !== null && supplied !== undefined) return supplied
  if (chars === null) return null
  if (method === 'chars_div_4') return Math.floor(chars / 4)
  if (method === 'calibrated_cpt' && typeof charsPerToken === 'number' && charsPerToken > 0) {
    return Math.floor(chars / charsPerToken)
  }
  return null
}

/**
 * @param {Object} a
 * @param {object} a.config                resolved config from loadConfig()
 * @param {object} [a.identity]            from buildIdentity(): {session_id, project_id, project_path}
 * @param {Array}  [a.pricingChain]        from loadPricing(): ordered [{table, source}]
 * @param {string} [a.providerId]
 * @param {object|null} [a.result]         CompletionResult, or null when no call was made
 * @param {object|null} [a.capabilities]   the provider's Capabilities
 * @param {number|null} [a.attempts]       1-based, from callWorker()
 * @param {object|null} [a.error]          ProviderError, or null
 * @param {object|null} [a.primaryUsage]   measured primary usage; Phase 3+, null before then
 * @param {number} a.now                   injected epoch ms
 * @param {string} a.eventId               injected uuid
 * @returns {object} the flat event
 */
export function buildEvent({
  config,
  identity = {},
  pricingChain = [],

  taskId = null,
  taskType = 'delegation',
  routingDecision = 'delegated',
  routingReason = 'threshold_met',
  policyVersion = null,
  promptVersion = null,
  taskIntentSource = null,

  // Codes the CALLER already collected — today, `decide()`'s `inputWarnings`, which docs/routing.md
  // specifies folding into validation_codes. They join this event's own coercion complaints rather
  // than occupying a field of their own, because a reader asking "did anything look wrong on this
  // row" wants one answer, not two lists to union.
  extraValidationCodes = null,
  // The governance verdict, as `checkBudget()` returned it, or null when governance was never
  // evaluated — which is every row where routing refused first. null here means all eight
  // governance columns are null, and that is a meaningful state: "not asked", not "allowed".
  governance = null,

  providerId = null,
  result = null,
  capabilities = null,
  // Taken separately from `result` rather than only off it, because `result` is passed ONLY on
  // the ok path (status is derived from its presence) — and a context REFUSAL is precisely the
  // row where the window that caused it must be recorded.
  contextBudget = null,
  contextTruncation = null,
  attempts = null,
  error = null,

  filesCount = null,
  provenFilesCount = null,
  filesInferredCount = null,
  inputBytes = null,
  corpusChars = null,
  charsPerToken = null,
  workerPromptTokens = null,
  countedTokens = null,

  returnedAnswerChars = null,
  returnedAnswerTokens = null,

  latencyMs = null,
  // The answer-verification result, or null when verification did not run. See
  // lib/verify/summary.mjs: null means "not checked", which is weaker than a `not_checkable`
  // verdict and must not be confused with it.
  verification = null,
  // The escalation record, or null when the ladder was not used. See lib/hook/run.mjs.
  escalation = null,
  questionText = null,

  primaryUsage = null,
  primaryUsageMethod = 'none',
  primaryProvider = DEFAULT_PRIMARY_PROVIDER,

  now = Date.now(),
  eventId = '00000000-0000-0000-0000-000000000000',
}) {
  const warn = createWarnings()
  const t = config?.telemetry ?? {}
  const usage = result?.usage ?? null

  // Folded first so they are counted and sorted alongside everything this function finds itself.
  // A non-array, or a non-string member, is ignored rather than stringified: a malformed warning
  // list must not become a warning that looks like a measurement.
  if (Array.isArray(extraValidationCodes)) {
    for (const code of extraValidationCodes) {
      if (typeof code === 'string' && code !== '') warn.add(code)
    }
  }

  /* ------------------------------------------------------------ worker money */

  const worker = resolveRates(pricingChain, {
    provider: providerId,
    servedModel: result?.model ?? null,
    requestedModel: config?.worker?.model ?? null,
  })

  // Re-validate the provider's counts before they reach the math (defence in depth).
  const checkedUsage = usage
    ? {
        inputTokens: toReportedCount(usage.inputTokens, 'worker_input_tokens', warn),
        cachedInputTokens: toReportedCount(usage.cachedInputTokens, 'worker_cached_input_tokens', warn),
        outputTokens: toReportedCount(usage.outputTokens, 'worker_output_tokens', warn),
        thinkingTokens: toReportedCount(usage.thinkingTokens, 'worker_thought_tokens', warn),
        totalTokens: toReportedCount(usage.totalTokens, 'worker_total_tokens', warn),
        source: usage.source,
      }
    : null

  const cost = calculateCost({
    usage: checkedUsage,
    rates: worker.rates,
    capabilities,
    lookup: worker.lookup,
  })

  /* ----------------------------------------------------------- counterfactual */

  const avoidedMethod = toEnum(t.avoidedMethod ?? 'chars_div_4', 'avoided_method', AVOIDED_METHODS, warn)
  const chars = toEstimatedCount(corpusChars, 'corpus_chars', warn)

  const avoided = calculateAvoidedTokens({
    chars,
    filesCount: toEstimatedCount(filesCount, 'files_count', warn),
    provenFilesCount: toEstimatedCount(provenFilesCount, 'proven_files_count', warn),
    countProvenFilesOnly: t.countProvenFilesOnly !== false,
    method: avoidedMethod ?? 'unknown',
    charsPerToken,
    workerPromptTokens: toReportedCount(workerPromptTokens, 'worker_prompt_tokens', warn),
    countedTokens: toReportedCount(countedTokens, 'counted_tokens', warn),
  })

  const answerChars = toEstimatedCount(
    returnedAnswerChars ?? (typeof result?.text === 'string' ? result.text.length : null),
    'returned_answer_chars',
    warn,
  )
  const answerTokens = estimateAnswerTokens({
    method: avoidedMethod,
    chars: answerChars,
    charsPerToken,
    supplied: toEstimatedCount(returnedAnswerTokens, 'returned_answer_tokens', warn),
  })

  const delta = calculateTokenDelta({
    avoidedInputTokens: avoided.value,
    returnedAnswerTokens: answerTokens,
    residencyTurns: t.residencyTurns ?? 0,
    residencySource: t.residencySource ?? 'default_zero',
  })

  /* ----------------------------------------------------------- primary money */

  const primaryModel = t.primaryModel ?? null
  const primary = resolveRates(pricingChain, {
    provider: primaryModel ? primaryProvider : null,
    servedModel: primaryModel,
    requestedModel: primaryModel,
  })

  const costAvoided = calculateEstimatedCostAvoided({
    tokenDelta: delta,
    primaryModel,
    primaryRates: primary.rates,
    primaryLookup: primary.lookup,
  })

  const netSavings = calculateEstimatedNetSavings({
    estimatedCostAvoided: costAvoided,
    workerTotalCost: cost.total,
  })

  // Primary-model usage is ACTUAL SPEND, never the counterfactual. Before a transcript reader
  // exists there is no measured source, so every primary field is null and the status says so.
  // `actual` is reserved; inventing a number here is explicitly forbidden.
  const primaryMeasured = primaryUsage !== null && primaryUsageMethod === 'transcript_measured'
  const primaryCost = primaryMeasured
    ? calculateCost({
        usage: primaryUsage,
        rates: primary.rates,
        capabilities: { reportsUsage: true, reportsThinkingTokens: true, supportsCachedInput: true },
        lookup: primary.lookup,
      })
    : null

  /* -------------------------------------------------------------- outcome */

  // Nullish rather than `?? null` on each use: absent and null must stay one thing here, and
  // toReportedCount/toEnum/toBool all map undefined to null anyway.
  const budget = contextBudget ?? result?.contextBudget ?? null
  const truncation = contextTruncation ?? result?.contextTruncation ?? null

  const status = error ? 'error' : result ? 'ok' : 'skipped'

  const errorDetail = error ? (error.detail ?? error.message ?? null) : null
  const errorMessageSafe =
    t.storeErrorDetail === true && typeof errorDetail === 'string'
      ? clampUtf8(redactSecrets(errorDetail), 1000)
      : null

  const storedQuestion =
    t.storeQuestionText === true && typeof questionText === 'string'
      ? redactSecrets(clampChars(questionText, t.questionTextMaxChars ?? 200))
      : null

  /* ---------------------------------------------------------------- assemble */

  /* governance (phase 9). Written from an already-made decision; nothing here re-decides
   * anything, and no budget arithmetic happens in the telemetry layer. Coerced before the
   * record literal so its validation complaints reach `warn` before the counters are read. */
  const gov = {
    governance_decision: toEnum(
      governance?.decision ?? null,
      'governance_decision',
      GOVERNANCE_DECISION_VALUES,
      warn,
    ),
    governance_reason: toEnum(governance?.reason ?? null, 'governance_reason', GOVERNANCE_REASON_VALUES, warn),
    budget_scope: toEnum(governance?.scope ?? null, 'budget_scope', BUDGET_SCOPE_VALUES, warn),
    // A limit is a configured number, so `toMoney` is the right boundary for the dollar case and
    // is harmless for a token count: both are finite non-negative and neither is clamped.
    budget_limit: toMoney(governance?.limit ?? null, 'budget_limit', warn),
    budget_remaining: toMoney(governance?.remaining ?? null, 'budget_remaining', warn),
    budget_measurement_status: toEnum(
      governance?.measurementStatus ?? null,
      'budget_measurement_status',
      BUDGET_MEASUREMENT_STATUS_VALUES,
      warn,
    ),
    reservation_tokens: toReportedCount(governance?.reservationTokens ?? null, 'reservation_tokens', warn),
    reservation_status: toEnum(
      governance?.reservationStatus ?? null,
      'reservation_status',
      RESERVATION_STATUS_VALUES,
      warn,
    ),
  }

  return {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    timestamp: new Date(now).toISOString(),
    // Signed minutes AHEAD of UTC (+600 = UTC+10), the inverse of Date#getTimezoneOffset, so a
    // reader can bucket by the writer's local day without re-deriving the sign convention.
    tz_offset_minutes: -new Date(now).getTimezoneOffset(),
    router_version: ROUTER_VERSION,
    calc_version: CALC_VERSION,
    pricing_version: worker.pricingVersion,
    pricing_source: worker.pricingSource,
    currency: CURRENCY,
    privacy_level: t.privacyLevel ?? 'hashed',
    session_id: identity.session_id ?? null,
    project_id: identity.project_id ?? null,
    project_path: identity.project_path ?? null,

    task_id: toText(taskId, 'task_id', warn),
    task_type: toEnum(taskType, 'task_type', TASK_TYPES, warn),
    routing_decision: toEnum(routingDecision, 'routing_decision', ROUTING_DECISIONS, warn),
    routing_reason: toEnum(routingReason, 'routing_reason', ROUTING_REASONS, warn),
    routing_policy_version: toReportedCount(policyVersion, 'routing_policy_version', warn),
    prompt_version: toReportedCount(promptVersion, 'prompt_version', warn),
    task_intent_source: toEnum(taskIntentSource, 'task_intent_source', TASK_INTENT_SOURCES, warn),
    provider: toText(providerId, 'provider', warn),
    model: toText(result?.model ?? null, 'model', warn),
    model_requested: toText(config?.worker?.model ?? null, 'model_requested', warn),
    pricing_lookup: worker.lookup,

    worker_usage_source: usage ? toEnum(usage.source, 'worker_usage_source', USAGE_SOURCES, warn) : 'missing',
    provider_reports_usage: toBool(capabilities?.reportsUsage ?? null, 'provider_reports_usage', warn),
    provider_reports_thinking_tokens: toBool(
      capabilities?.reportsThinkingTokens ?? null,
      'provider_reports_thinking_tokens',
      warn,
    ),
    provider_supports_cached_input: toBool(
      capabilities?.supportsCachedInput ?? null,
      'provider_supports_cached_input',
      warn,
    ),
    worker_input_tokens: checkedUsage?.inputTokens ?? null,
    worker_cached_input_tokens: checkedUsage?.cachedInputTokens ?? null,
    worker_output_tokens: checkedUsage?.outputTokens ?? null,
    worker_thought_tokens: checkedUsage?.thinkingTokens ?? null,
    // The provider's own total, verbatim and never recomputed, so the component arithmetic stays
    // checkable against the source of truth.
    worker_total_tokens: checkedUsage?.totalTokens ?? null,
    worker_billable_output_tokens: cost.billableOutputTokens,
    worker_thinking_assumption: cost.thinkingAssumption,
    worker_token_sum_check: cost.tokenSumCheck,

    /* worker context capability. Read off the dispatch result's nested records rather than from
     * new top-level inputs, because `result` is already a structural superset of what this layer
     * needs and a parallel input would be a second way to say the same thing. */
    worker_context_tokens: toReportedCount(budget?.contextTokens, 'worker_context_tokens', warn),
    worker_context_source: toEnum(budget?.capabilitySource, 'worker_context_source', WORKER_CONTEXT_SOURCES, warn),
    worker_context_status: toEnum(budget?.capabilityStatus, 'worker_context_status', WORKER_CONTEXT_STATUSES, warn),
    worker_configured_max_output_tokens: toReportedCount(budget?.requestedOutputTokens, 'worker_configured_max_output_tokens', warn),
    worker_effective_input_capacity: toReportedCount(budget?.effectiveInputCapacityTokens, 'worker_effective_input_capacity', warn),
    // ESTIMATED, not reported: this is our own chars/4 figure for the assembled prompt, which is
    // what the refusal decision was actually made on. `worker_input_tokens` beside it is the
    // provider's own count, and is null on a refusal because no call happened.
    worker_requested_input_tokens: toEstimatedCount(budget?.requestedInputTokens, 'worker_requested_input_tokens', warn),
    // REPORTED, not estimated: this is the provider's own count, taken from the truncation
    // check rather than from the usage block, because the usage block does not survive a
    // discarded answer and this is exactly the row where the number matters.
    worker_observed_prompt_tokens: toReportedCount(truncation?.observedPromptTokens, 'worker_observed_prompt_tokens', warn),
    worker_input_truncation_detected: toBool(truncation?.truncated, 'worker_input_truncation_detected', warn),

    primary_model: toText(primaryModel, 'primary_model', warn),
    primary_usage_method: toEnum(primaryUsageMethod, 'primary_usage_method', PRIMARY_USAGE_METHODS, warn),
    primary_usage_status: primaryMeasured ? MEASUREMENT.ACTUAL : MEASUREMENT.UNAVAILABLE,
    primary_input_tokens: primaryMeasured ? toReportedCount(primaryUsage.inputTokens, 'primary_input_tokens', warn) : null,
    primary_output_tokens: primaryMeasured
      ? toReportedCount(primaryUsage.outputTokens, 'primary_output_tokens', warn)
      : null,
    primary_total_tokens: primaryMeasured ? toReportedCount(primaryUsage.totalTokens, 'primary_total_tokens', warn) : null,

    worker_input_cost: toMoney(cost.input.value, 'worker_input_cost', warn),
    worker_input_cost_status: cost.input.status,
    worker_cached_input_cost: toMoney(cost.cachedInput.value, 'worker_cached_input_cost', warn),
    worker_cached_input_cost_status: cost.cachedInput.status,
    worker_output_cost: toMoney(cost.output.value, 'worker_output_cost', warn),
    worker_output_cost_status: cost.output.status,
    worker_total_cost: toMoney(cost.total.value, 'worker_total_cost', warn),
    worker_total_cost_status: cost.total.status,

    primary_input_cost: primaryCost ? toMoney(primaryCost.input.value, 'primary_input_cost', warn) : null,
    primary_input_cost_status: primaryCost ? primaryCost.input.status : MEASUREMENT.UNAVAILABLE,
    primary_output_cost: primaryCost ? toMoney(primaryCost.output.value, 'primary_output_cost', warn) : null,
    primary_output_cost_status: primaryCost ? primaryCost.output.status : MEASUREMENT.UNAVAILABLE,
    primary_total_cost: primaryCost ? toMoney(primaryCost.total.value, 'primary_total_cost', warn) : null,
    primary_total_cost_status: primaryCost ? primaryCost.total.status : MEASUREMENT.UNAVAILABLE,

    avoided_method: avoidedMethod,
    counterfactual_render: toEnum(
      t.counterfactualRender ?? 'raw',
      'counterfactual_render',
      COUNTERFACTUAL_RENDERS,
      warn,
    ),
    count_proven_files_only: t.countProvenFilesOnly !== false,
    residency_turns: t.residencyTurns ?? 0,
    residency_source: toEnum(t.residencySource ?? 'default_zero', 'residency_source', RESIDENCY_SOURCES, warn),
    files_count: toEstimatedCount(filesCount, 'files_count', warn),
    files_inferred_count: toEstimatedCount(filesInferredCount, 'files_inferred_count', warn),
    input_bytes: toByteCount(inputBytes, 'input_bytes', warn),
    estimated_input_tokens: avoided.value,
    returned_answer_chars: answerChars,
    returned_answer_tokens_estimated: answerTokens,
    estimated_tokens_avoided: toSignedCount(delta.value, 'estimated_tokens_avoided', warn),
    estimated_tokens_avoided_status: delta.status,
    estimated_cost_avoided: toMoney(costAvoided.value, 'estimated_cost_avoided', warn),
    estimated_cost_avoided_status: costAvoided.status,
    estimated_net_savings: toMoney(netSavings.value, 'estimated_net_savings', warn),
    estimated_net_savings_status: netSavings.status,

    status: toEnum(status, 'status', STATUS_VALUES, warn),
    error_code: toText(error?.code ?? null, 'error_code', warn),
    error_message_safe: errorMessageSafe,
    latency_ms: toDurationMs(latencyMs, 'latency_ms', warn),
    // Kept distinct from latency_ms because the provider contract is explicit that it covers the
    // HTTP round trip of the final attempt only — not retries, not payload assembly, not parse.
    provider_latency_ms: toDurationMs(result?.providerLatencyMs ?? null, 'provider_latency_ms', warn),
    retry_count: toRetryCount(attempts ?? error?.attempts ?? null, warn),
    truncated: toBool(result?.truncated ?? null, 'truncated', warn),
    finish_reason: toText(result?.finishReason ?? null, 'finish_reason', warn),

    question_text: storedQuestion,
    truncation_steps: null,
    validation_warnings: warn.count,
    validation_codes: warn.serialize(),
    // Verification. `verification === null` means it did not run, and every column stays null —
    // never 0, which would read as "zero line claims were wrong" about a check nobody performed.
    summary_verify_verdict: toEnum(
      verification?.verdict ?? null,
      'summary_verify_verdict',
      SUMMARY_VERIFY_VERDICTS,
      warn,
    ),
    summary_verify_reason: toText(verification?.reason ?? null, 'summary_verify_reason', warn),
    summary_line_claims: toReportedCount(
      verification?.lineClaims?.total ?? null,
      'summary_line_claims',
      warn,
    ),
    summary_line_claims_wrong: toReportedCount(
      verification?.lineClaims?.wrong ?? null,
      'summary_line_claims_wrong',
      warn,
    ),

    escalation_attempts: toReportedCount(escalation?.attempts ?? null, 'escalation_attempts', warn),
    escalation_path: toText(escalation?.path ?? null, 'escalation_path', warn),
    escalation_wasted_input_tokens: toReportedCount(
      escalation?.wastedInputTokens ?? null,
      'escalation_wasted_input_tokens',
      warn,
    ),
    escalation_wasted_output_tokens: toReportedCount(
      escalation?.wastedOutputTokens ?? null,
      'escalation_wasted_output_tokens',
      warn,
    ),

    // Coerced ABOVE, not here. Two constraints pull in opposite directions and this satisfies
    // both: the warning counters are read in source order, so a field coerced after them loses
    // its complaints (measured: an unrecognised governance_decision reported
    // validation_warnings 0), while the eval row path preserves this literal's key order and
    // compares it against FIELD_ORDER, where these columns come last. Hoisting the coercion and
    // spreading the result here is the only arrangement that is correct on both counts.
    ...gov,
  }
}
