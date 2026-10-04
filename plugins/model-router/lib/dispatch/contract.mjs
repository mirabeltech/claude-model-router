/**
 * The dispatch vocabulary, and the one place that builds a dispatch result.
 *
 * This file holds no branches of its own. It exists so `index.mjs` evaluates its flow against a
 * fixed key list and can never assemble a result object two different ways, and so the error
 * vocabulary is written down once rather than re-typed at each throw site.
 *
 * THREE RULES GOVERN THE LAYER:
 *
 *  1. FAILING TO DELEGATE IS FAILING OPEN. The executor's safe failure is to make no provider
 *     call, because the caller then does the work itself. This is CLAUDE.md's second
 *     non-negotiable seen from the other side: the gate must never block a session, and the
 *     dispatcher must never invent an answer.
 *
 *  2. RETRY LIVES IN withRetry() AND NOWHERE ELSE. The dispatcher calls callWorker(), which owns
 *     the shared retry policy. A second backoff here would multiply the first, not replace it.
 *
 *  3. DISPATCHER ERRORS ARE NOT ProviderError. Its constructor does
 *     `this.code = ERROR_CODES.includes(code) ? code : 'unknown'`, so a ProviderError built with
 *     'aborted' would silently become 'unknown'. Dispatcher-owned codes therefore ride on a plain
 *     frozen object built by dispatchError() below.
 */

import { ERROR_CODES } from '../providers/contract.mjs'
import { redactSecrets } from '../redact.mjs'

/* ------------------------------------------------------------------------ enums */

/**
 * Which branch of the flow owned the outcome. Ordered by branch order, so the list doubles as the
 * rule table in docs/worker-dispatch.md.
 *
 * `routing_declined`, NOT `routing_denied`: decide() returns `decision: 'deny'` WHILE delegating
 * — `deny` means "block this tool call and return the worker's answer in place of the file" — so
 * `decision === 'deny' && delegate === true` is the happy path. A reason spelled `routing_denied`
 * reads backwards.
 */
export const DISPATCH_REASONS = Object.freeze([
  'completed',
  'routing_declined',
  'invalid_request',
  'unsupported_mode',
  'unsupported_provider',
  'provider_unavailable',
  'payload_too_large',
  'context_exceeded',
  'provider_error',
  'aborted',
])

/** Reasons the dispatcher owns rather than passes through. Each has an error code of the same name. */
export const DISPATCH_OWNED_CODES = Object.freeze([
  'invalid_request',
  'provider_unavailable',
  'aborted',
  'unsupported_mode',
  'unsupported_provider',
  // Distinct from the provider layer's `payload_too_large`, which is a BYTE ceiling. This one is
  // a token window, it is never retryable, and its fix is a different model rather than a
  // different knob. Conflating them would make the two unanswerable apart in a stored row.
  'context_exceeded',
])

/**
 * The closed vocabulary `error.code` can carry: every provider code verbatim, plus the five
 * conditions the provider layer cannot express because they arise before or outside a call.
 *
 * DERIVED from ERROR_CODES rather than re-typed, so adding a provider code cannot desync the two.
 */
export const DISPATCH_ERROR_CODES = Object.freeze([...ERROR_CODES, ...DISPATCH_OWNED_CODES])

/**
 * Every key of a dispatch result, in order. The single source for both buildResult() and the
 * contract test, so a field cannot be added to one without the other noticing.
 *
 * `text`, `usage`, `model`, `providerLatencyMs`, `truncated` and `finishReason` are named exactly
 * as CompletionResult names them. That makes a result a structural SUPERSET of CompletionResult,
 * so the phase that writes telemetry passes it straight to buildEvent() as `result` — and a
 * translation layer is a place for two vocabularies to drift apart.
 */
export const RESULT_KEYS = Object.freeze([
  'ok',
  'executed',
  'status',
  'reason',
  'mode',
  'lane',
  'provider',
  'model',
  'modelRequested',
  'text',
  'usage',
  'capabilities',
  // One nested record rather than eight flattened columns; `capabilities` already sets that
  // precedent, and it keeps RESULT_KEYS growth at one key per concept.
  'contextBudget',
  'contextTruncation',
  'attempts',
  'latencyMs',
  'providerLatencyMs',
  'truncated',
  'finishReason',
  'error',
  'promptVersion',
  'policyVersion',
  'warnings',
])

/** What `status` may be. Assigned to the telemetry column, never translated into it. */
export const DISPATCH_STATUSES = Object.freeze(['ok', 'error', 'skipped'])

/* --------------------------------------------------------------------- typedefs */

/**
 * @typedef {Object} DispatchError
 * @property {string} code            one of DISPATCH_ERROR_CODES
 * @property {string} message         redacted
 * @property {boolean} retryable
 * @property {number|null} httpStatus
 * @property {string|null} detail     redacted
 * @property {string|null} provider
 */

/**
/**
 * @typedef {Object} ContextBudget
 * @property {number|null} contextTokens      the resolved window; null means unknown
 * @property {string} capabilitySource        a member of CAPABILITY_SOURCES
 * @property {string} capabilityStatus        a member of CAPABILITY_STATUSES
 * @property {string} contextWindowModel      shared | separate | unknown
 * @property {number|null} requestedInputTokens
 * @property {number|null} requestedOutputTokens
 * @property {number|null} totalRequestedTokens
 * @property {number|null} effectiveInputCapacityTokens
 * @property {number|null} allowedOutputTokens
 * @property {boolean} outputCapped
 * @property {boolean|null} fits              null is UNKNOWN, never false
 * @property {string} verdict                 a member of BUDGET_VERDICTS
 * @property {string} reason                  a member of BUDGET_REASONS
 */

/**
 * @typedef {Object} ResolvedWorker
 * @property {string|null} provider
 * @property {string|null} model
 * @property {string|null} apiKeyEnv
 * @property {number|null} timeoutMs
 * @property {boolean} inheritedProvider
 */

/* ---------------------------------------------------------------------- builders */

/** Every field at its "nothing happened" value, so buildResult never has to guess one. */
const EMPTY = Object.freeze({
  ok: false,
  executed: false,
  status: 'error',
  reason: 'invalid_request',
  mode: null,
  lane: null,
  provider: null,
  model: null,
  modelRequested: null,
  text: null,
  usage: null,
  capabilities: null,
  contextBudget: null,
  contextTruncation: null,
  attempts: null,
  latencyMs: null,
  providerLatencyMs: null,
  truncated: null,
  finishReason: null,
  error: null,
  promptVersion: null,
  policyVersion: null,
  warnings: [],
})

/**
 * Assemble a result in RESULT_KEYS order. Absent and null must not be two ways of saying one
 * thing, so every key is written and no key is ever `undefined`.
 */
export function buildResult(fields) {
  const merged = { ...EMPTY, ...fields }
  // Derived, never passed in: one place decides what "ok" means.
  merged.ok = merged.status === 'ok'
  merged.warnings = Object.freeze([...new Set(merged.warnings ?? [])].sort())
  if (merged.usage) Object.freeze(merged.usage)
  if (merged.contextBudget) Object.freeze(merged.contextBudget)
  if (merged.contextTruncation) Object.freeze(merged.contextTruncation)

  const out = {}
  for (const key of RESULT_KEYS) {
    const v = merged[key]
    out[key] = v === undefined ? null : v
  }
  return Object.freeze(out)
}

/**
 * A dispatcher-owned failure. A plain frozen object, never a ProviderError — see rule 3 above.
 *
 * Both `message` and `detail` are redacted regardless of origin. httpJson() scrubs `detail` but
 * not `message`, and parseOllamaResponse() interpolates raw daemon text straight into a message,
 * so scrubbing only what this layer writes itself would leave that hole open.
 */
export function dispatchError(
  code,
  message,
  { retryable = false, httpStatus = null, detail = null, provider = null } = {},
) {
  return Object.freeze({
    code: DISPATCH_ERROR_CODES.includes(code) ? code : 'unknown',
    message: redactSecrets(typeof message === 'string' ? message : String(message ?? '')),
    retryable,
    httpStatus,
    detail: detail === null || detail === undefined ? null : redactSecrets(String(detail)),
    provider,
  })
}

/**
 * Classify a thrown ProviderError, separating a caller abort from everything else.
 *
 * THE ABORT IS IDENTIFIED BY THE SIGNAL, NEVER BY THE MESSAGE. httpJson() reports a cancel as
 * ProviderError('transport', '<p>: request cancelled') — the SAME code a dead socket produces —
 * so string-matching the message would break the moment anyone rewords it.
 *
 * Checking the signal is exact because httpJson composes `AbortSignal.any([signal, timeoutCtl])`:
 * aborting the caller's signal leaves `timeoutCtl.signal.aborted` false, and the hard timeout
 * never touches the caller's signal. Signal first, because if both fired the caller's intent wins.
 *
 * @returns {{error: DispatchError, reason: string}}
 */
export function fromProviderError(err, signal) {
  const base = {
    retryable: err?.retryable === true,
    httpStatus: err?.httpStatus ?? null,
    detail: err?.detail ?? null,
    provider: err?.provider ?? null,
  }

  if (signal?.aborted === true) {
    return {
      reason: 'aborted',
      error: dispatchError('aborted', err?.message ?? 'the caller aborted the request', {
        ...base,
        retryable: false,
      }),
    }
  }

  const code = typeof err?.code === 'string' ? err.code : 'unknown'
  return {
    reason: 'provider_error',
    error: dispatchError(code, err?.message ?? 'the worker provider failed', base),
  }
}
