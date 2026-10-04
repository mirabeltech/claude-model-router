/**
 * Token and cost math. PURE: no filesystem, no network, no logging, no clock, no telemetry.
 * This module must never gain a `node:` import — a test enforces that statically.
 *
 * ONE GLOBAL RULE: any null operand yields a null result and status `unavailable`.
 *
 * There are exactly two controlled departures, each gated on a provider CAPABILITY FLAG rather
 * than on a guess, each recorded in the event, and each argued at its definition:
 *
 *   - thinking tokens absent on a provider that cannot produce them  -> a true zero
 *   - cached input absent on a provider with no cache feature        -> a true zero
 *
 * Everything else that is unknown is null. In particular an unknown or missing capabilities
 * object ALWAYS resolves toward null: we would rather publish no number than a number whose
 * operands we cannot vouch for. A wrong zero understates worker cost, which overstates savings,
 * and overstating savings is the one failure this project exists to avoid.
 *
 * Why status derivation never reads `usage.source`: the provider contract computes `source` from
 * inputTokens and outputTokens ONLY, so `provider_reported` says nothing about cached or thinking
 * tokens. Ollama returns `source: 'provider_reported'` with both hardcoded null. A derivation
 * keyed on `source` would stamp `actual` on costs whose operands are unknown. Status is therefore
 * derived from the OPERANDS — the individual token fields, the capability flags and the rates.
 */

import { MEASUREMENT } from './record.mjs'

const { ACTUAL, ESTIMATED, UNAVAILABLE } = MEASUREMENT

/* ----------------------------------------------------------------- primitives */

/** A finite non-negative number, or null. Mirrors the provider contract's num(). */
function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** A finite number of any sign, or null. For rates and money, where negatives are meaningful. */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Sum, or null if ANY argument is null. Never treats null as 0. */
export function addOrNull(...xs) {
  let total = 0
  for (const x of xs) {
    if (x === null || x === undefined) return null
    const n = finite(x)
    if (n === null) return null
    total += n
  }
  return total
}

/** Difference, or null if either side is null. No clamping: a negative result is a real result. */
export function subOrNull(a, b) {
  const x = finite(a)
  const y = finite(b)
  return x === null || y === null ? null : x - y
}

export function mulOrNull(a, b) {
  const x = finite(a)
  const y = finite(b)
  return x === null || y === null ? null : x * y
}

/**
 * Price tokens at a per-million-token rate. The ONLY place 1e6 appears in the codebase.
 *
 * Deliberately not rounded. IEEE-754 is deterministic, so leaving the raw product means
 * `router verify` can recompute a stored row and get a bit-identical value; a rounding step
 * would have to be versioned alongside the formula to keep that property.
 */
export function priceTokens(tokens, ratePerMTok) {
  const t = count(tokens)
  const r = finite(ratePerMTok)
  if (t === null || r === null) return null
  return (t * r) / 1e6
}

/**
 * The single status derivation. Every one of the event's measurement statuses comes through here,
 * so INV-1 (value === null <=> status === 'unavailable') cannot drift at a call site.
 */
export function statusFor(value, kind) {
  if (value === null || value === undefined) return UNAVAILABLE
  return kind === ACTUAL ? ACTUAL : ESTIMATED
}

/** Wrap a computed value with its status and the reason code that explains it. */
function result(value, kind, reason) {
  return { value, status: statusFor(value, kind), reason }
}

/**
 * Is a provider's reported usage a measurement we can call `actual`?
 *
 * `reportsUsage: false` is documented in the provider contract as "telemetry must mark usage as
 * estimated". An absent or malformed capabilities object cannot support an `actual` claim either,
 * so it also yields `estimated` — weaker, never stronger, than what we can prove.
 */
function usageKind(capabilities) {
  return capabilities?.reportsUsage === true ? ACTUAL : ESTIMATED
}

/* ------------------------------------------------------- billable output tokens */

/**
 * Billable output = outputTokens + thinkingTokens.
 *
 * The provider layer deliberately does NOT fold thinking into output (Gemini excludes
 * `thoughtsTokenCount` from `candidatesTokenCount`), so the fold happens here, at pricing time.
 * Thinking is billed at the OUTPUT rate, which is how vendors bill it.
 *
 * The null policy is the only one that cannot understate worker cost:
 *
 *   output null                                  -> null        (nothing to build on)
 *   output + thinking both known                 -> out + think (reported)
 *   thinking null, reportsThinkingTokens false   -> out         (structural_zero: no billing line
 *                                                                exists, so 0 is the true value)
 *   thinking null, reportsThinkingTokens true    -> null        (omission: genuinely unknown)
 *   capabilities missing or malformed            -> null        (unknown resolves toward null)
 *
 * The third and fourth rows are the whole point. Ollama cannot emit thinking tokens, so `out` is
 * a measurement. Gemini can, and simply did not report them this time, so the sum is unknown —
 * and returning `out` there would understate the bill.
 *
 * @returns {{value: number|null, status: string, assumption: string, reason: string}}
 */
export function billableOutputTokens(usage, capabilities) {
  const kind = usageKind(capabilities)
  const out = count(usage?.outputTokens)
  const think = count(usage?.thinkingTokens)

  if (out === null) {
    return { value: null, status: UNAVAILABLE, assumption: 'unknown', reason: 'output_tokens_missing' }
  }
  if (think !== null) {
    const value = out + think
    return { value, status: statusFor(value, kind), assumption: 'reported', reason: 'output_plus_thinking' }
  }
  if (capabilities?.reportsThinkingTokens === false) {
    return { value: out, status: statusFor(out, kind), assumption: 'structural_zero', reason: 'thinking_structurally_absent' }
  }
  return { value: null, status: UNAVAILABLE, assumption: 'unknown', reason: 'thinking_omitted' }
}

/**
 * Cached prompt tokens for pricing, with the same structural-zero logic.
 *
 * A provider with no cache feature has a true zero; a provider with a cache feature that did not
 * report is unknown.
 */
export function cachedInputTokensFor(usage, capabilities) {
  const cached = count(usage?.cachedInputTokens)
  if (cached !== null) return { value: cached, reason: 'cached_reported' }
  if (capabilities?.supportsCachedInput === false) return { value: 0, reason: 'cached_structurally_absent' }
  return { value: null, reason: 'cached_omitted' }
}

/**
 * Compare the component sum against the provider's own reported total.
 *
 * Audit only — a mismatch NEVER changes a cost. It is a signal that a provider parser is wrong,
 * which is a bug to fix rather than a number to adjust.
 */
export function tokenSumCheck(usage) {
  const total = count(usage?.totalTokens)
  const parts = addOrNull(
    count(usage?.inputTokens),
    count(usage?.cachedInputTokens),
    count(usage?.outputTokens),
    count(usage?.thinkingTokens),
  )
  if (total === null || parts === null) return 'unknown'
  return parts === total ? 'ok' : 'mismatch'
}

/* ------------------------------------------------------------- calculateCost */

/**
 * Price one normalized usage object against one rate row.
 *
 * @param {Object} a
 * @param {Object|null} a.usage         the provider contract's Usage shape
 * @param {Object|null} a.rates         {inputPerMTok, cachedInputPerMTok, outputPerMTok}, each
 *                                      number|null; the whole object null when no table resolved
 * @param {Object|null} a.capabilities  the provider's Capabilities
 * @param {string} a.lookup             one of PRICING_LOOKUPS
 * @returns {{input: object, cachedInput: object, output: object, total: object,
 *            billableOutputTokens: number|null, thinkingAssumption: string,
 *            cachedTokens: number|null, tokenSumCheck: string}}
 */
export function calculateCost({ usage = null, rates = null, capabilities = null, lookup = 'no_table' } = {}) {
  const kind = usageKind(capabilities)
  const billable = billableOutputTokens(usage, capabilities)
  const cached = cachedInputTokensFor(usage, capabilities)

  /**
   * One component, one rule, applied identically to input / cachedInput / output. The ordering
   * matters: a pricing problem is reported as a pricing problem even when the tokens are also
   * missing, because "add a rate" and "fix the provider parser" are different fixes.
   */
  const component = (tokens, rate) => {
    if (lookup === 'no_table') return result(null, kind, 'pricing_unavailable')
    if (lookup === 'model_unknown') return result(null, kind, 'model_unknown')
    if (rates === null) return result(null, kind, 'pricing_unavailable')
    if (finite(rate) === null) return result(null, kind, 'rate_unpriced')
    if (count(tokens) === null) return result(null, kind, 'tokens_missing')
    return result(priceTokens(tokens, rate), kind, 'priced')
  }

  // The Gemini double-charge guard: usage.inputTokens is ALREADY uncached-only
  // (max(0, promptTokenCount - cachedContentTokenCount)), so it is priced alone at the input
  // rate and the cached portion is priced separately at the cache-read rate. Pricing
  // input + cached at the input rate would charge the cached half at full price.
  const input = component(usage?.inputTokens, rates?.inputPerMTok)
  const cachedInput = component(cached.value, rates?.cachedInputPerMTok)
  const output = component(billable.value, rates?.outputPerMTok)

  if (cachedInput.value === null && cached.value === null) cachedInput.reason = cached.reason
  if (output.value === null && billable.value === null) output.reason = billable.reason

  // Null if ANY component is null — never a sum of the knowns. A partial sum presented as a
  // total understates the worker bill, and the three components stay individually readable, so
  // refusing to total loses nothing that was measured.
  const totalValue = addOrNull(input.value, cachedInput.value, output.value)
  const allActual = [input.status, cachedInput.status, output.status].every((s) => s === ACTUAL)
  const total = {
    value: totalValue,
    status: statusFor(totalValue, allActual ? ACTUAL : ESTIMATED),
    reason: totalValue === null ? 'component_unavailable' : 'sum_of_components',
  }

  return {
    input,
    cachedInput,
    output,
    total,
    billableOutputTokens: billable.value,
    thinkingAssumption: billable.assumption,
    cachedTokens: cached.value,
    tokenSumCheck: tokenSumCheck(usage),
  }
}

/* --------------------------------------------------- calculateAvoidedTokens */

const KNOWN_AVOIDED_METHODS = new Set([
  'chars_div_4',
  'calibrated_cpt',
  'worker_prompt_tokens',
  'anthropic_count_tokens',
])

/**
 * Gross counterfactual corpus size in primary-model tokens.
 *
 * Pure: the caller supplies characters and counts; this layer never reads a file and never
 * renders anything.
 *
 * Math.floor, never round — flooring keeps the figure a floor, and chars/4 already under-counts
 * source code (real code tokenizes nearer 3.0-3.6 chars/token), so the reported saving errs low
 * by construction.
 *
 * @returns {{value: number|null, status: string, reason: string, method: string}}
 */
export function calculateAvoidedTokens({
  chars = null,
  filesCount = null,
  provenFilesCount = null,
  countProvenFilesOnly = true,
  method = 'chars_div_4',
  charsPerToken = null,
  workerPromptTokens = null,
  countedTokens = null,
} = {}) {
  const fail = (reason) => ({ value: null, status: UNAVAILABLE, reason, method })

  const c = count(chars)
  if (c === null) return fail('chars_unknown')

  if (countProvenFilesOnly) {
    const proven = count(provenFilesCount)
    if (proven === null) return fail('proven_count_unknown')
    const files = count(filesCount)
    // The caller is supposed to pass pre-filtered `chars`. An inconsistency here is the only
    // detectable sign that it ignored countProvenFilesOnly, and an inflated corpus is the
    // largest over-claim risk in the whole model. Refuse rather than publish it.
    if (files !== null && files > proven) return fail('proven_filter_not_applied')
  }

  // An unknown method NEVER falls back to chars_div_4. A number must match the method stamped
  // next to it, and `avoided_method` is what makes the figure auditable.
  if (!KNOWN_AVOIDED_METHODS.has(method)) return fail('method_unknown')

  switch (method) {
    case 'chars_div_4':
      return { value: Math.floor(c / 4), status: ESTIMATED, reason: 'chars_div_4', method }

    case 'calibrated_cpt': {
      const cpt = finite(charsPerToken)
      if (cpt === null || cpt <= 0) return fail('cpt_unknown')
      return { value: Math.floor(c / cpt), status: ESTIMATED, reason: 'calibrated_cpt', method }
    }

    case 'worker_prompt_tokens': {
      const t = count(workerPromptTokens)
      if (t === null) return fail('worker_prompt_tokens_missing')
      return { value: Math.floor(t), status: ESTIMATED, reason: 'worker_prompt_tokens', method }
    }

    case 'anthropic_count_tokens': {
      const t = count(countedTokens)
      if (t === null) return fail('counted_tokens_missing')
      // Still `estimated`, never `actual`: the count is exact, but the prompt it counts never
      // existed. A counterfactual's precision does not make it a measurement.
      return { value: Math.floor(t), status: ESTIMATED, reason: 'anthropic_count_tokens', method }
    }

    default:
      return fail('method_unknown')
  }
}

/* ------------------------------------------------------ calculateTokenDelta */

/**
 * The CONTEXT NET: tokens the primary model avoids ingesting, net of the worker answer that lands
 * in its context instead.
 *
 * This is the "net, not gross" rule from the savings methodology, and it is enforced by refusing
 * to compute when the returned-answer size is unknown. There is deliberately no gross fallback:
 * a gross figure published under a net label is the exact overstatement we forbid.
 *
 * `residencyTurns` is accepted ONLY so it can be validated and stamped. calc_version 1 ignores it
 * in the arithmetic. Claude Code pays CACHE rates for resident context (~2x input to land it once,
 * then ~0.1x per later turn), so a `tokens x turns` multiplier inflates the claim 10-40x. If
 * residency is ever justified by transcript measurement it becomes an ADDITIVE cache-rate term in
 * dollar space, not a multiplier in token space — and that is a new calc_version.
 *
 * @returns {{value: number|null, status: string, reason: string, residencyApplied: number}}
 */
export function calculateTokenDelta({
  avoidedInputTokens = null,
  returnedAnswerTokens = null,
  residencyTurns = 0,
  residencySource = 'default_zero',
} = {}) {
  // Defensive: config already forces this, but calc does not trust its caller.
  const turns = residencySource === 'default_zero' ? 0 : (count(residencyTurns) ?? 0)

  const avoided = count(avoidedInputTokens)
  if (avoided === null) {
    return { value: null, status: UNAVAILABLE, reason: 'avoided_unknown', residencyApplied: 0 }
  }
  const returned = count(returnedAnswerTokens)
  if (returned === null) {
    return { value: null, status: UNAVAILABLE, reason: 'returned_answer_unknown', residencyApplied: 0 }
  }

  // Negative is legitimate and stored, never clamped: a worker answer larger than the corpus
  // proves a threshold is wrong, and that is exactly what the operator needs to see.
  // Zero is legitimate too — "this delegation saved nothing" is a real finding, not a gap.
  const value = avoided - returned
  const reason = turns > 0 ? 'net_of_answer,residency_ignored' : 'net_of_answer'
  return { value, status: ESTIMATED, reason, residencyApplied: 0 }
}

/* --------------------------------------------- calculateEstimatedCostAvoided */

/**
 * Dollar value of the context-net token delta, priced at the PRIMARY model's INPUT rate.
 *
 * Input rate alone, and this is the single most important asymmetry in the savings model: the
 * counterfactual difference is input-side only. Claude produces the same answer in both worlds —
 * the user gets the same deliverable either way — so output is a wash and appears in no term.
 * The worker's answer entering Claude's context is also input to Claude, so pricing the whole net
 * delta at one input rate is internally consistent and needs no second term.
 *
 * Status is structurally never `actual`: the operand is a counterfactual.
 *
 * @returns {{value: number|null, status: string, reason: string}}
 */
export function calculateEstimatedCostAvoided({
  tokenDelta = null,
  primaryModel = null,
  primaryRates = null,
  primaryLookup = 'no_table',
} = {}) {
  const fail = (reason) => ({ value: null, status: UNAVAILABLE, reason })

  // Checked first and short-circuiting: the default config is `primaryModel: null` because the
  // primary model is resolved from the session, never guessed. Out of the box this field is null
  // for a reason the row explains.
  if (primaryModel === null || primaryModel === undefined || primaryModel === '') {
    return fail('primary_model_unset')
  }
  if (!tokenDelta || tokenDelta.value === null || tokenDelta.value === undefined) {
    return fail(tokenDelta?.reason ?? 'token_delta_unavailable')
  }
  if (primaryLookup === 'no_table') return fail('pricing_unavailable')
  if (primaryLookup === 'model_unknown') return fail('primary_model_unknown')
  if (primaryRates === null) return fail('pricing_unavailable')

  const rate = finite(primaryRates.inputPerMTok)
  if (rate === null) return fail('primary_rate_unpriced')

  // Signed: priceTokens() rejects a negative token count, so the sign is applied after pricing
  // the magnitude. A negative delta yields negative dollars, unclamped.
  const delta = tokenDelta.value
  const magnitude = priceTokens(Math.abs(delta), rate)
  if (magnitude === null) return fail('pricing_unavailable')
  const value = delta < 0 ? -magnitude : magnitude
  return { value, status: ESTIMATED, reason: 'priced_at_input_rate' }
}

/* ---------------------------------------------- calculateEstimatedNetSavings */

/**
 * The CASH NET: what the delegation saved after paying the worker.
 *
 * No partial netting, under any circumstance. If the worker bill is unknown, reporting the
 * avoided figure as net savings publishes a gross number under a net label. With all-null bundled
 * rates that is also the LIKELY case, which is precisely why the rule has to be absolute rather
 * than pragmatic.
 *
 * Status is never `actual`, in any calc_version, forever — one operand is always a counterfactual.
 * The honest consequence is that this project's headline number can never be labelled `actual`.
 *
 * @returns {{value: number|null, status: string, reason: string}}
 */
export function calculateEstimatedNetSavings({ estimatedCostAvoided = null, workerTotalCost = null } = {}) {
  if (!estimatedCostAvoided || estimatedCostAvoided.value === null || estimatedCostAvoided.value === undefined) {
    return { value: null, status: UNAVAILABLE, reason: estimatedCostAvoided?.reason ?? 'cost_avoided_unavailable' }
  }
  if (!workerTotalCost || workerTotalCost.value === null || workerTotalCost.value === undefined) {
    return { value: null, status: UNAVAILABLE, reason: 'worker_cost_unknown' }
  }
  const value = subOrNull(estimatedCostAvoided.value, workerTotalCost.value)
  if (value === null) return { value: null, status: UNAVAILABLE, reason: 'worker_cost_unknown' }
  // Negative stored, never clamped. The reason flags it; the value stands unchanged.
  return { value, status: ESTIMATED, reason: value < 0 ? 'negative_savings' : 'net_of_worker_cost' }
}
