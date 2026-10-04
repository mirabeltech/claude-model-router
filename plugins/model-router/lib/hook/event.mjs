/**
 * Decision plus dispatch result, as the bag `emitEvent()` wants.
 *
 * Pure: it imports nothing and reads no clock, so the whole mapping can be asserted field by
 * field. It does not write the row — `run.mjs` does that, inside the sink's own try/catch — and
 * it computes no money. Cost is the telemetry layer's job, once, at write time.
 */

/**
 * Dispatch reasons that are also telemetry `ROUTING_REASONS` members, and may be echoed.
 *
 * Everything else must be TRANSLATED. `ROUTING_REASONS` is closed on write, and `completed`,
 * `aborted`, `unsupported_mode`, `unsupported_provider`, `payload_too_large`, `invalid_request`
 * and `provider_error` are not all members of it — passing a dispatch reason straight through
 * would stamp `unknown_enum:routing_reason` on essentially every delegated row, poisoning the one
 * signal the store has for "something is actually wrong". The table is in
 * docs/worker-dispatch.md.
 */
const ECHOES_DECISION_REASON = Object.freeze(['completed', 'routing_declined'])

/**
 * Which `routing_reason` belongs on this row.
 *
 * On a success the row records WHY the gate delegated (normally `threshold_met`), not the fact
 * that the call completed — the latter is what `status` is for, and spending the reason column on
 * it would lose the only field that explains the routing decision.
 */
export function routingReasonFor(decision, result) {
  const fallback = typeof decision?.reason === 'string' ? decision.reason : 'other'
  if (!result) return fallback
  if (ECHOES_DECISION_REASON.includes(result.reason)) return fallback
  // A context refusal is not a provider failure. The window was too small for the prompt and
  // the provider was very likely never called at all, so collapsing it into `provider_error`
  // would file the most important refusal this router makes under an unrelated cause — and
  // every byRoutingReason breakdown would stop being able to see it.
  if (result.reason === 'context_exceeded') return 'context_exceeded'
  return 'provider_error'
}

/**
 * Build the `emitEvent()` input bag for one hook invocation.
 *
 * What is deliberately NOT populated, and why:
 *
 *  - `primaryUsage` / `primaryUsageMethod: 'none'`. There is no transcript reader, so actual
 *    primary-model spend is unavailable. Estimating it from the file's size and storing it in the
 *    un-prefixed `primary_*` columns would put a counterfactual where the schema promises a
 *    measurement, and would double-count the saving for any reader that summed both.
 *  - `charsPerToken: null`. Only `calibrated_cpt` consumes it and this layer has no calibration;
 *    the shipped `chars_div_4` divides by a literal 4. Supplying a number here would be inventing
 *    a calibration nobody measured.
 *  - `countedTokens: null`. `anthropic_count_tokens` would mean calling an API to price a prompt
 *    that never existed, on the hot path.
 *
 * @param {object}      a.decision   a `decide()` result
 * @param {object|null} a.result     a `dispatch()` result, or null when nothing was dispatched
 * @param {object}      [a.facts]    what `facts.mjs` measured
 * @param {object}      [a.payload]  the hook payload, for its correlation ids
 * @param {number|null} [a.corpusChars]  characters of the file actually sent, else null
 * @param {string|null} [a.questionText] the task given to the worker, else null
 * @param {string|null} [a.taskIntentSource] where that task's intent came from, else null
 */
export function toEventInputs({
  decision,
  result = null,
  facts = {},
  payload = {},
  corpusChars = null,
  questionText = null,
  taskIntentSource = null,
  governance = null,
  verification = null,
  escalation = null,
}) {
  const dispatched = result !== null && result !== undefined
  const ok = dispatched && result.status === 'ok'

  return {
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    // Correlates the gate decision with the delegation it caused. Claude Code's own id for the
    // tool call is the natural key: it is unique per call and carries no file or prompt content.
    taskId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,

    // The EVENT taxonomy, not the routing one. A refusal is the kind of row `gate_block` names;
    // an attempted delegation is a `bulk_read` row whatever became of it.
    taskType: dispatched ? 'bulk_read' : 'gate_block',
    routingDecision: typeof decision?.decision === 'string' ? decision.decision : 'other',
    routingReason: routingReasonFor(decision, result),
    policyVersion: decision?.policyVersion ?? null,
    promptVersion: dispatched ? (result.promptVersion ?? null) : null,
    // The SOURCE, never the text. A gate row has no worker call and therefore no task, so it
    // stays null rather than claiming `none` about a request that was never made.
    taskIntentSource: dispatched ? taskIntentSource : null,

    // `result` is passed ONLY on the ok path, because buildEvent derives
    // `status = error ? 'error' : result ? 'ok' : 'skipped'` from exactly that.
    providerId: dispatched ? (result.provider ?? null) : null,
    result: ok ? result : null,
    error: dispatched ? (result.error ?? null) : null,
    capabilities: dispatched ? (result.capabilities ?? null) : null,
    // On EVERY dispatched path, not just the ok one. A `context_exceeded` refusal is the row a
    // reader most needs the window for: without it the refusal is unexplainable after the fact.
    contextBudget: dispatched ? (result.contextBudget ?? null) : null,
    contextTruncation: dispatched ? (result.contextTruncation ?? null) : null,
    attempts: dispatched ? (result.attempts ?? null) : null,
    // The dispatcher's own end-to-end measurement, or null. A gate row has no worker call, and
    // putting the hook's wall clock in a column documented as "payload assembly, every attempt,
    // and parse" would quietly give one field two meanings. Hook overhead is measured by
    // test/hook.latency.test.mjs and documented, not stored per row.
    latencyMs: dispatched ? (result.latencyMs ?? null) : null,

    // The gate proved exactly one file and the hook never adds another, so the proven filter is
    // trivially satisfied and `files_inferred_count` is 0 rather than unknown.
    filesCount: 1,
    provenFilesCount: 1,
    filesInferredCount: 0,

    inputBytes: facts.inputBytes ?? null,
    corpusChars,
    charsPerToken: null,
    // A real measurement when the provider reported one, and the operand the configured
    // `worker_prompt_tokens` method needs. Null otherwise — never estimated into existence.
    workerPromptTokens: ok ? (result.usage?.inputTokens ?? null) : null,
    countedTokens: null,

    // Left to buildEvent, which takes the answer's length off `result.text` and applies the same
    // render method to it that it applied to the corpus. Passing a token count computed here
    // would risk two methods disagreeing inside one row.
    returnedAnswerChars: null,
    returnedAnswerTokens: null,

    questionText,
    // Only on a dispatched row. A gate refusal produced no answer, so there was nothing to
    // verify, and stamping a verdict on it would invent a check that never happened.
    verification: dispatched ? verification : null,
    escalation: dispatched ? escalation : null,
    primaryUsage: null,
    primaryUsageMethod: 'none',

    // The routing engine's complaints about the input it was handed, folded in beside this
    // event's own coercion complaints, per docs/routing.md.
    extraValidationCodes: Array.isArray(decision?.inputWarnings) ? [...decision.inputWarnings] : null,

    // The budget verdict, passed through UNCHANGED. This module maps a decision onto telemetry
    // and decides nothing, so there is no re-derivation here and no default: `null` means
    // governance was never consulted, which is a different state from "governance allowed it"
    // and the columns keep the two apart.
    governance,
  }
}
