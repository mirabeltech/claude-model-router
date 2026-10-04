/**
 * Context budgeting — does this request fit the model we are about to send it to?
 *
 * PURE, and deliberately IMPORT-FREE. Not even the capability enums are imported: this module
 * needs exactly one fact about a capability record — whether `contextTokens` is a usable number —
 * and expressing that as `=== null` rather than as a status string keeps the module reachable
 * from any layer without dragging `providers/` into anybody's import graph. It is the third pure
 * module beside config.mjs and routing.mjs, and the purity test treats it the same way.
 *
 * WHY THIS EXISTS. `assertPayloadSize` already refuses a payload over a provider's BYTE ceiling.
 * That is a transport limit and it is not a context window. A local runtime will happily accept a
 * 60 KB prompt, serve it against a 2048-token window, and silently discard the middle — measured
 * against Ollama 0.34.4, where a 17,368-token prompt came back as prompt_eval_count 2060 with the
 * first and last markers both intact and everything between them gone. Bytes cannot see that;
 * tokens can. So this module works in TOKENS throughout.
 *
 * WHAT IT REFUSES TO DO. It never decides that an unknown window is a big one. An unknown
 * capability yields verdict `unknown` and the caller owns what that means — which, for the
 * dispatcher, is "proceed under the byte ceiling and say so", because a router that cannot
 * determine a window must degrade to plain Claude Code rather than to a blocked session.
 *
 * ROUNDING RUNS IN BOTH DIRECTIONS ON PURPOSE. A request is rounded UP (never understate the
 * prompt) and a capacity is rounded DOWN (never overstate the room). telemetry/calc.mjs floors
 * because a savings figure must stay a floor, which is the opposite direction, which is exactly
 * why that function is not reused here. The divisor is the same 4 and a test pins the two equal.
 */

/** The verdict vocabulary. Closed: a caller switches on these and must not meet a fifth. */
export const BUDGET_VERDICTS = Object.freeze([
  'fits', // send it as asked
  'cap_output', // send it, but ask for fewer output tokens
  'refuse', // do not send it; the input cannot be made to fit without dropping content
  'unknown', // we cannot tell. NOT a synonym for `fits`.
])

/**
 * Why a verdict came out the way it did. One reason per verdict, first match wins, which is the
 * discipline routing.mjs already uses: when two conditions hold, the EARLIER rule owns the
 * answer, so a reader can read the ladder top to bottom and stop.
 */
export const BUDGET_REASONS = Object.freeze([
  'within_window', // fits
  'output_capped_to_fit', // cap_output: a shared window needed the room back
  'output_capped_to_limit', // cap_output: the provider's own output ceiling bit first
  'input_exceeds_window', // refuse: no output budget at all would make this fit
  'output_floor_unreachable', // refuse: it would fit, but with too little room to answer in
  'capability_unknown', // unknown: no window was resolved
  'capability_invalid', // unknown: a window was resolved and it was nonsense
  'input_size_unknown', // unknown: we were not told how big the prompt is
  'output_request_invalid', // unknown: we were not told how much output to ask for
])

/**
 * Bytes per token. The house estimate, which UNDER-counts code (real source sits nearer 3.0-3.6
 * bytes per token), and that bias is load-bearing in two places: it makes a request estimate
 * conservative, and it makes `detectSilentTruncation` quiet on a healthy call.
 */
export const TOKEN_BYTES_PER_TOKEN = 4

/**
 * The least output worth asking for. Capping a bulk-read summary below a few hundred tokens is
 * not a cap, it is a silent failure wearing a cap's clothes: the worker returns a sentence, the
 * hook substitutes it for the file, and the developer is told nothing went wrong. Below this we
 * refuse and let the real Read happen.
 */
export const MIN_USEFUL_OUTPUT_TOKENS = 256

/**
 * The windows we are willing to ASK a runtime for, smallest first.
 *
 * COARSE ON PURPOSE, and this is a correctness matter rather than a tuning one. A local runtime
 * re-allocates its KV cache when the requested window changes, which on a multi-gigabyte CPU
 * model costs seconds to minutes. The hook that calls all this has a 20-second budget
 * (`hooks.timeoutMs`), so a re-allocation triggered by nothing more than the next file being a
 * kilobyte larger does not merely cost time — it can blow the budget and abort the delegation
 * outright, wasting the whole call.
 *
 * Fine-grained rounding (the obvious `ceilTo(need, 1024)`) maximises how often that happens: two
 * reads of similar files land on different windows and evict each other. A handful of wide
 * buckets means a session normally allocates ONCE and reuses it.
 *
 * Still not simply "ask for the model's maximum": on a 128k model that would make the daemon
 * allocate a 128k cache for a 4k prompt, which is the memory-pressure problem in the other
 * direction. Buckets keep both failure modes small.
 */
export const NUM_CTX_BUCKETS = Object.freeze([4096, 8192, 16384, 32768, 65536, 131072])

/**
 * How far the `chars/4` estimate is allowed to be wrong when SIZING A WINDOW.
 *
 * The estimate under-counts code — real source sits nearer 3.0-3.6 bytes per token — so the true
 * prompt can be around a third larger than `estimateTokensFromBytes` says. Everywhere else that
 * bias is harmless or helpful: it makes a fit decision conservative and it makes
 * `detectSilentTruncation` quiet on a healthy call.
 *
 * Sizing a window is the one place it is actively dangerous, and this constant exists because it
 * bit a live run. With output capped to 512, a case estimated at 3,301 prompt tokens asked for
 * `bucket(3301 + 512)` = 4096 — and the real prompt was 4,265 tokens. Ollama truncated it
 * silently and the post-hoc detector discarded the answer. A window must cover the prompt that
 * will actually be sent, not our lower bound on it.
 *
 * 1.35 is the inverse of ~3 bytes per token against the assumed 4, i.e. the worst realistic
 * case rather than the average. Over-asking costs a larger KV cache; under-asking costs the
 * middle of the file, and the whole phase exists because that failure is silent.
 */
export const WINDOW_SIZING_MARGIN = 1.35

/** Truncation tolerance: an absolute floor, and a fraction of the estimate, whichever is larger. */
export const TRUNCATION_TOLERANCE_TOKENS = 64
export const TRUNCATION_TOLERANCE_FRACTION = 0.1

/* ------------------------------------------------------------------------ helpers */

const isCount = (v) => Number.isInteger(v) && v >= 0
const isPositiveInt = (v) => Number.isInteger(v) && v > 0

/** The smallest bucket that holds `n`, or null when `n` is larger than every bucket. */
const bucketFor = (n) => NUM_CTX_BUCKETS.find((b) => b >= n) ?? null

/** Freeze the record and its warnings list, deduped and sorted as buildResult does. */
function freeze(record) {
  const warnings = Object.freeze([...new Set(record.warnings ?? [])].sort())
  return Object.freeze({ ...record, warnings })
}

/* ------------------------------------------------------------- token estimation */

/**
 * Tokens a payload of `bytes` bytes will probably cost, rounded UP.
 *
 * Bytes rather than characters because that is what the wire carries and what
 * `assertPayloadSize` already measures; for UTF-8 `bytes >= chars`, so a multi-byte file
 * estimates high, which is the safe direction for a refusal.
 *
 * @param {number|null} bytes
 * @returns {number|null} null when the input is not a byte count
 */
export function estimateTokensFromBytes(bytes) {
  if (!isCount(bytes)) return null
  return Math.ceil(bytes / TOKEN_BYTES_PER_TOKEN)
}

/**
 * Tokens a window of `bytes` bytes can hold, rounded DOWN.
 *
 * The mirror of the above, and the asymmetry is the point: never claim room that may not exist.
 *
 * @param {number|null} bytes
 * @returns {number|null}
 */
export function capacityTokensFromBytes(bytes) {
  if (!isCount(bytes)) return null
  return Math.floor(bytes / TOKEN_BYTES_PER_TOKEN)
}

/* ------------------------------------------------------------------ the decision */

/**
 * Decide whether a request fits a model's context window, and what to ask for if it nearly does.
 *
 * @param {object} a
 * @param {string|null} [a.provider]
 * @param {string|null} [a.model]
 * @param {{contextTokens: number|null, source?: string, status?: string}|null} [a.capability]
 *   A ModelCapability record, or null. `contextTokens === null` means UNKNOWN, never infinite.
 * @param {number|null} a.requestedInputTokens   prompt + system, in tokens
 * @param {number|null} a.requestedOutputTokens  what the caller wants to generate
 * @param {'shared'|'separate'|'unknown'} [a.contextWindowModel]
 *   Whether the window covers prompt and completion together. `unknown` is read as `shared`.
 * @param {number|null} [a.providerMaxOutputTokens]  a separate output ceiling, where one exists
 * @returns {Readonly<object>} the frozen budget record
 */
export function computeContextBudget({
  provider = null,
  model = null,
  capability = null,
  requestedInputTokens,
  requestedOutputTokens,
  contextWindowModel = 'unknown',
  providerMaxOutputTokens = null,
}) {
  const warnings = []
  const contextTokens =
    capability && Number.isInteger(capability.contextTokens) ? capability.contextTokens : null

  const base = {
    provider,
    model,
    contextTokens,
    capabilitySource: capability?.source ?? 'unknown',
    capabilityStatus: capability?.status ?? 'unknown',
    contextWindowModel,
    requestedInputTokens: isCount(requestedInputTokens) ? requestedInputTokens : null,
    requestedOutputTokens: isPositiveInt(requestedOutputTokens) ? requestedOutputTokens : null,
  }

  /** Every unknown exit looks the same, so no branch can forget to null the derived fields. */
  const unknown = (reason) =>
    freeze({
      ...base,
      totalRequestedTokens: null,
      effectiveInputCapacityTokens: null,
      allowedOutputTokens: null,
      outputCapped: false,
      fits: null,
      verdict: 'unknown',
      reason,
      warnings,
    })

  /* 1. we were not told how big the prompt is */
  if (!isCount(requestedInputTokens)) return unknown('input_size_unknown')

  /* 2. we were not told how much output to ask for. A zero output request is not a request. */
  if (!isPositiveInt(requestedOutputTokens)) return unknown('output_request_invalid')

  /* 3. no window was resolved. UNKNOWN IS NOT INFINITE — this is the rule the whole file is for. */
  if (contextTokens === null) return unknown('capability_unknown')

  /* 4. a window was resolved and it was nonsense */
  if (contextTokens <= 0) {
    warnings.push('capability_nonpositive')
    return unknown('capability_invalid')
  }

  /* 5. an unspecified window model resolves pessimistically. Assuming independent input and
   *    output limits would promise capacity a shared window does not have. */
  let windowModel = contextWindowModel
  if (windowModel !== 'shared' && windowModel !== 'separate') {
    warnings.push('window_model_assumed_shared')
    windowModel = 'shared'
  }

  const totalRequestedTokens = requestedInputTokens + requestedOutputTokens

  /* 6. separate windows: the prompt is measured against the whole window, and output is bounded
   *    by its own ceiling rather than by what the prompt left behind. */
  if (windowModel === 'separate') {
    const shape = {
      ...base,
      contextWindowModel: windowModel,
      totalRequestedTokens,
      effectiveInputCapacityTokens: contextTokens,
    }
    if (requestedInputTokens > contextTokens) {
      return freeze({
        ...shape,
        allowedOutputTokens: null,
        outputCapped: false,
        fits: false,
        verdict: 'refuse',
        reason: 'input_exceeds_window',
        warnings,
      })
    }
    const capped =
      isPositiveInt(providerMaxOutputTokens) && providerMaxOutputTokens < requestedOutputTokens
    if (capped) warnings.push('output_reduced')
    return freeze({
      ...shape,
      allowedOutputTokens: capped ? providerMaxOutputTokens : requestedOutputTokens,
      outputCapped: capped,
      fits: true,
      verdict: capped ? 'cap_output' : 'fits',
      reason: capped ? 'output_capped_to_limit' : 'within_window',
      warnings,
    })
  }

  /* 7. shared window: every output token asked for is an input token given up. */
  const effectiveInputCapacityTokens = contextTokens - requestedOutputTokens
  const shape = {
    ...base,
    contextWindowModel: windowModel,
    totalRequestedTokens,
    effectiveInputCapacityTokens,
  }

  if (requestedInputTokens <= effectiveInputCapacityTokens) {
    return freeze({
      ...shape,
      allowedOutputTokens: requestedOutputTokens,
      outputCapped: false,
      fits: true,
      verdict: 'fits',
      reason: 'within_window',
      warnings,
    })
  }

  // It did not fit as asked. Give back the output budget and see what is left.
  const headroom = contextTokens - requestedInputTokens

  if (headroom >= MIN_USEFUL_OUTPUT_TOKENS) {
    warnings.push('output_reduced')
    return freeze({
      ...shape,
      // Restated against the output we are ACTUALLY going to ask for, so the identity
      // `effectiveInputCapacityTokens + allowedOutputTokens === contextTokens` holds on every
      // path that sends something. Reporting the capacity under the original, rejected request
      // would print `effectiveInput: 0` for a request that is about to succeed.
      effectiveInputCapacityTokens: contextTokens - headroom,
      allowedOutputTokens: headroom,
      outputCapped: true,
      fits: true,
      verdict: 'cap_output',
      reason: 'output_capped_to_fit',
      warnings,
    })
  }

  // Two different refusals, because they have two different fixes: send less, or pick a model
  // with a bigger window.
  return freeze({
    ...shape,
    allowedOutputTokens: null,
    outputCapped: false,
    fits: false,
    verdict: 'refuse',
    reason: headroom > 0 ? 'output_floor_unreachable' : 'input_exceeds_window',
    warnings,
  })
}

/**
 * The window to ASK a runtime for, given a budget that fits.
 *
 * Not the model's maximum: that would make a daemon allocate a 128k KV cache for a 4k prompt,
 * which on a memory-tight machine is the difference between a four-second call and a forty-second
 * one. Not the exact total either — see NUM_CTX_BUCKETS for why the granularity is coarse.
 *
 * @param {object} budget  a record from computeContextBudget
 * @returns {number|null} null when there is nothing meaningful to ask for
 */
export function requiredContextTokens(budget) {
  if (!budget || budget.verdict === 'unknown' || budget.verdict === 'refuse') return null
  if (!Number.isInteger(budget.contextTokens) || budget.contextTokens <= 0) return null
  if (!isCount(budget.requestedInputTokens) || !isPositiveInt(budget.allowedOutputTokens)) {
    return null
  }

  // The INPUT estimate is marked up, the output request is not: we chose the output number and
  // know it exactly, whereas the input is a lower bound on a count we cannot see yet.
  const need =
    Math.ceil(budget.requestedInputTokens * WINDOW_SIZING_MARGIN) + budget.allowedOutputTokens
  // Past the largest bucket, the model's own window is the only sensible answer left.
  const wanted = bucketFor(need) ?? budget.contextTokens
  return Math.min(budget.contextTokens, wanted)
}

/**
 * Did the provider quietly read less of the prompt than we sent?
 *
 * `prompt_eval_count` is the only ground truth available: it says how many prompt tokens the
 * runtime actually evaluated. Our own figure is an ESTIMATE that under-counts code, so on a
 * healthy call the observed count normally comes back HIGHER than the estimate. A shortfall is
 * therefore a strong signal rather than a rounding artefact — and the observed failure was not
 * marginal, it was 2060 against an estimated 4342.
 *
 * Returns `truncated: null` whenever either side is unavailable. An unmeasured call is not a
 * clean one, and reporting `false` here would be the reassuring zero this project forbids.
 *
 * @param {object} a
 * @param {object|null} [a.budget]
 * @param {{inputTokens: number|null}|null} [a.usage]
 * @param {{silentInputTruncation?: boolean}|null} [a.capabilities]
 * @returns {Readonly<object>}
 */
export function detectSilentTruncation({ budget = null, usage = null, capabilities = null } = {}) {
  const estimated = isCount(budget?.requestedInputTokens) ? budget.requestedInputTokens : null
  const observed = isCount(usage?.inputTokens) ? usage.inputTokens : null

  const out = (truncated, reason) =>
    Object.freeze({
      truncated,
      reason,
      estimatedPromptTokens: estimated,
      observedPromptTokens: observed,
      shortfallTokens: null,
      toleranceTokens: null,
    })

  // A provider that errors on overflow cannot have truncated silently, by definition.
  if (capabilities?.silentInputTruncation !== true) return out(false, 'not_possible')
  if (observed === null) return out(null, 'prompt_count_missing')
  if (estimated === null) return out(null, 'estimate_unknown')

  const shortfall = estimated - observed
  const tolerance = Math.max(
    TRUNCATION_TOLERANCE_TOKENS,
    Math.ceil(estimated * TRUNCATION_TOLERANCE_FRACTION),
  )
  const truncated = shortfall > tolerance

  return Object.freeze({
    truncated,
    reason: truncated ? 'prompt_shortfall' : 'prompt_count_consistent',
    estimatedPromptTokens: estimated,
    observedPromptTokens: observed,
    shortfallTokens: shortfall,
    toleranceTokens: tolerance,
  })
}
