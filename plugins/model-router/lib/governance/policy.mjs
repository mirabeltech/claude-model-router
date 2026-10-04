/**
 * Budget governance — are we currently allowed to delegate?
 *
 * THREE DIFFERENT QUESTIONS, THREE DIFFERENT MODULES. This repo keeps them apart on purpose:
 *
 *   `routing.mjs`            would this task be APPROPRIATE to delegate?
 *   this file                are we currently ALLOWED to delegate?
 *   `context-budget.mjs`     CAN this worker safely execute this request?
 *
 * Collapsing any two of them loses a distinction that matters. A task can be perfectly
 * appropriate and still be refused because the month's budget is gone; a task can be allowed by
 * every budget and still not fit the model's context window. Answering all three from one
 * function would make "why did this not delegate" unanswerable.
 *
 * Four rules govern this module:
 *
 *  1. PURE. It imports nothing, reads no environment, opens no file, makes no network call and
 *     does not read the clock — `now` is injected. A test asserts all of that. The ledger I/O
 *     lives in `ledger.mjs`, which is the only impure file in this directory.
 *
 *  2. UNKNOWN IS NOT ZERO. An unknown cost is not a free call and an unknown token count is not
 *     a zero token count. `limit - unknown` is never evaluated as if unknown were 0; it yields
 *     `remaining: null`. This is the same rule the telemetry layer states as "a missing
 *     measurement is NULL, never 0", and it is the whole reason this module has an `unknown`
 *     decision rather than only allow/deny.
 *
 *  3. null IS NOT ZERO EITHER. A `null` limit means "no configured limit". A `0` limit means an
 *     operator deliberately configured a zero budget and nothing may be delegated. Conflating
 *     them would turn an unconfigured install into a disabled one, or a deliberate zero into a
 *     blank cheque.
 *
 *  4. FAILS OPEN, AND THE SHORT-CIRCUIT IS LOAD-BEARING. Governance disabled, nothing
 *     configured, or a malformed limit all return `allow`. A broken governance layer must
 *     degrade to an ungoverned router, never to a blocked session — the same contract
 *     `decide()` holds. And when nothing is configured the answer is reached BEFORE any ledger
 *     is read, so a default install pays no filesystem cost for a feature it is not using.
 *
 * `decision` and `reason` are separate fields. Nothing here ever returns `provider_error`: a
 * budget refusal is not a provider failure, and borrowing that code would make the two
 * indistinguishable in telemetry.
 */

/* -------------------------------------------------------------------- vocabulary */

/**
 * Closed on write. `unknown` is a real third answer, not a placeholder: it means a limit IS
 * configured and we could not measure the thing it limits. The caller turns it into allow or
 * deny according to `onUnknownCost` / `onUnknownUsage`, which is a policy choice an operator
 * owns and this module must not make for them.
 */
export const GOVERNANCE_DECISIONS = Object.freeze(['allow', 'deny', 'unknown'])

/** Every reason this module can return. A test pins that each one is reachable. */
export const GOVERNANCE_REASONS = Object.freeze([
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
])

/** Which period a decision was made against. `null` when no limit was involved. */
export const BUDGET_SCOPES = Object.freeze(['run', 'daily', 'monthly'])

/**
 * How well we know the spend we compared against.
 *
 * `measured` — the ledger holds provider-reported usage.
 * `estimated` — the request side is an estimate (bytes/4) because the call has not happened yet.
 * `unavailable` — we could not determine it. Pairs with `remaining: null`, never `remaining: 0`.
 */
export const BUDGET_MEASUREMENT_STATUSES = Object.freeze(['measured', 'estimated', 'unavailable'])

/** The lifecycle of one reservation. `overrun` is the documented case in the accounting rules. */
export const RESERVATION_STATUSES = Object.freeze([
  'none',
  'reserved',
  'settled',
  'released',
  'overrun',
])

/** How a worker's cost is determined. Declared by the provider, never inferred from a key. */
export const BILLING_MODELS = Object.freeze(['local_free', 'metered'])

/* ----------------------------------------------------------------------- helpers */

/** A configured limit: a finite number at or above zero, or null for "no limit". */
const isLimit = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0)

/** A limit that is present AND actually constrains. null is absent, not zero. */
const isSet = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A measurement we can compare. Rejects NaN, Infinity, negatives and strings. */
const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Only own keys, so a `__proto__` in a parsed ledger file cannot reach us. */
const own = (o, k) => (isPlainObject(o) && Object.hasOwn(o, k) ? o[k] : undefined)

/**
 * Remaining headroom under a limit.
 *
 * Returns null when either side is unknown — never `limit`, which would be the "unknown is
 * zero" bug — and clamps at 0 so remaining can never be reported negative even after an
 * overrun. The overrun itself is still visible, via the reservation status.
 */
function remainingUnder(limit, spent) {
  if (!isSet(limit)) return null
  if (!isAmount(spent)) return null
  return Math.max(0, limit - spent)
}

/* ------------------------------------------------------------------ period keys */

/**
 * The UTC day and month a timestamp falls in.
 *
 * UTC, never the machine's local timezone. A team sharing a budget across timezones must agree
 * on when "today" ends, and the only answer that does not depend on who is asking is UTC. It is
 * also what the telemetry segment names already use, so a budget period and a telemetry
 * partition line up instead of being off by a few hours.
 *
 * A PERIOD IS A KEY, NOT A JOB. Rollover is a key mismatch — `ledger.mjs` resets a counter when
 * the stored key no longer equals the current one — so there is nothing scheduled at midnight
 * and therefore nothing that can fail to run. Month length and leap years need no special case
 * because no arithmetic is done on dates at all.
 *
 * @param {number} now  epoch milliseconds
 * @returns {Readonly<{day: string|null, month: string|null}>} ISO keys, or nulls for a bad clock
 */
export function periodKeys(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return Object.freeze({ day: null, month: null })
  }
  const iso = new Date(now).toISOString()
  return Object.freeze({ day: iso.slice(0, 10), month: iso.slice(0, 7) })
}

/* ------------------------------------------------------- the short-circuit gate */

/**
 * Is ANY limit configured at all?
 *
 * The cheapest possible question, and the one that keeps a default install free. The caller asks
 * this BEFORE opening the ledger: with every limit `null` — which is how this ships — the answer
 * is false, no file is read, no lock is taken, and governance costs one object walk. That is
 * what makes "governance is inert until configured" a measurable property rather than a claim.
 *
 * Note `0` counts as configured. A deliberately configured zero budget is a real limit that must
 * refuse, and treating it as "nothing set" would make it a blank cheque.
 */
export function hasConfiguredLimit(limits) {
  if (!isPlainObject(limits)) return false
  for (const scope of BUDGET_SCOPES) {
    const block = own(limits, scope)
    if (!isPlainObject(block)) continue
    for (const leaf of ['maxWorkerCostUsd', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens']) {
      if (isSet(own(block, leaf))) return true
    }
  }
  return false
}

/* ---------------------------------------------------------------- diagnosis */

/**
 * Describe the governance configuration, for `scripts/doctor.mjs`.
 *
 * Pure, and returns findings rather than printing them, so the severity matrix is unit-testable
 * instead of only being observable by spawning a script and matching its stdout. The doctor
 * renders; this decides.
 *
 * THE SEVERITY RULE, matching the rest of doctor: `fail` only for a misconfiguration with a
 * definite fix. An unenforceable budget is a WARNING, because the router still works and still
 * delegates — it just cannot promise the ceiling the operator asked for. Treating that as a
 * failure would make a default install, where every rate is null, report as broken.
 *
 * `ok` findings are emitted even when nothing is wrong: a section that is silent when everything
 * is fine cannot be told apart from a section that forgot to check.
 *
 * @param {object}  a.limits          `config.budget`
 * @param {boolean} a.pricingAvailable  whether ANY rate is known for the resolved workers
 * @param {object}  a.stateWritable   `{ok, reason}` from `probeWritable()`
 * @param {Array}   a.workers         `[{mode, provider, billing, reportsUsage}]`
 * @returns {ReadonlyArray<{level: string, label: string, detail: string}>}
 */
/** Distinct provider names. Both lanes usually resolve to one worker, so "gemini, gemini" is
 *  the default outcome of a naive join and reads as a bug in the diagnostic. */
const names = (list) => [...new Set(list.map((w) => w.provider))].join(', ')

export function describeGovernance({
  limits = null,
  pricingAvailable = false,
  stateWritable = null,
  workers = [],
} = {}) {
  const out = []
  const add = (level, label, detail = '') => out.push(Object.freeze({ level, label, detail }))

  if (!isPlainObject(limits)) {
    add('fail', 'budget configuration is unreadable', 'config.budget is missing or not an object')
    return Object.freeze(out)
  }

  if (limits.enabled !== true) {
    add('ok', 'governance is disabled', 'budget.enabled is false; no limit is evaluated')
    return Object.freeze(out)
  }

  // Invalid before unconfigured: a negative limit is the one budget problem with a definite fix.
  const invalid = []
  const configured = []
  for (const scope of BUDGET_SCOPES) {
    const block = own(limits, scope)
    if (!isPlainObject(block)) continue
    for (const leaf of ['maxWorkerCostUsd', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens']) {
      const v = own(block, leaf)
      if (v === undefined) continue
      if (!isLimit(v)) invalid.push(`budget.${scope}.${leaf}=${JSON.stringify(v) ?? String(v)}`)
      else if (isSet(v)) configured.push({ scope, leaf, value: v, money: leaf === 'maxWorkerCostUsd' })
    }
  }

  for (const bad of invalid) {
    add('fail', 'a budget limit is not a number at or above zero', `${bad} — null means no limit, 0 means a zero budget`)
  }

  if (configured.length === 0) {
    add('ok', 'no budget is configured', 'every limit is null, so delegation is ungoverned and costs no I/O')
    return Object.freeze(out)
  }

  for (const c of configured) {
    const unit = c.money ? `$${c.value}` : `${c.value} tokens`
    add('ok', `budget.${c.scope}.${c.leaf} = ${unit}`, c.scope === 'run' ? 'per delegation' : `per UTC ${c.scope === 'daily' ? 'day' : 'month'}`)
  }

  // Accounting state. A configured limit that cannot be written down cannot be enforced across
  // calls, and that IS a definite fix: point `budget.stateDir` somewhere writable.
  if (stateWritable === null) {
    add('warn', 'budget accounting state was not checked', 'doctor could not probe budget.stateDir')
  } else if (stateWritable.ok !== true) {
    add(
      'fail',
      'budget accounting state is not writable',
      `${stateWritable.reason ?? 'unknown'} — a configured limit cannot be enforced without it`,
    )
  } else {
    add('ok', 'budget accounting state is writable', 'reservations and spend can be recorded')
  }

  // Cost governance: can it actually operate?
  const money = configured.filter((c) => c.money)
  if (money.length > 0) {
    const metered = workers.filter((w) => w.billing !== 'local_free')
    if (metered.length === 0) {
      add(
        'ok',
        'every configured worker is local and free',
        'a monetary budget cannot be consumed, so it will never bind — this is not a failure',
      )
    } else if (!pricingAvailable) {
      add(
        'warn',
        'a monetary budget is configured but provider pricing is unavailable',
        `worker cost is NULL for ${names(metered)}, so there is nothing to accumulate against it; set pricing.overrides`,
      )
      add(
        'warn',
        'worker cost is unknown, so a monetary budget cannot be enforced exactly',
        limits.onUnknownCost === 'deny'
          ? 'budget.onUnknownCost is deny, so delegation will be REFUSED while cost is unknown'
          : 'budget.onUnknownCost is allow, so delegation proceeds and the breach is recorded rather than prevented',
      )
    } else {
      add('ok', 'cost governance can operate', 'rates are known for every metered worker')
    }
  }

  // Token governance: can it actually bind?
  const tokens = configured.filter((c) => !c.money)
  if (tokens.length > 0) {
    const silent = workers.filter((w) => w.reportsUsage === false)
    if (silent.length > 0) {
      add(
        limits.onUnknownUsage === 'deny' ? 'ok' : 'warn',
        'a token budget is configured but a worker reports no usage',
        limits.onUnknownUsage === 'deny'
          ? `${names(silent)} reports no usage and budget.onUnknownUsage is deny, so it will be refused`
          : `${names(silent)} reports no token counts, so its calls can never exhaust the budget`,
      )
    } else {
      add('ok', 'token governance can operate', 'every configured worker reports its usage')
    }
  }

  if (limits.onExceed === 'warn') {
    add(
      'warn',
      'budget.onExceed is warn, so a reached limit does not stop delegation',
      'the breach is recorded and the worker still runs; set disable to enforce',
    )
  }

  return Object.freeze(out)
}

/* --------------------------------------------------------------- the evaluation */

const result = (fields) =>
  Object.freeze({
    decision: fields.decision,
    reason: fields.reason,
    scope: fields.scope ?? null,
    limit: fields.limit ?? null,
    remaining: fields.remaining ?? null,
    measurementStatus: fields.measurementStatus ?? null,
    reservationTokens: fields.reservationTokens ?? null,
    reservationCostUsd: fields.reservationCostUsd ?? null,
  })

/**
 * Is a token limit in this scope already spent, or would this request cross it?
 *
 * @returns {object|null} a refusal, or null if this scope does not refuse
 */
function checkTokens(scope, limit, spent, requested, reasonCode) {
  if (!isSet(limit)) return null

  // A configured zero budget refuses before anything is measured. There is no request small
  // enough to fit under zero, so measuring first would only be theatre.
  if (limit === 0) {
    return result({
      decision: 'deny',
      reason: reasonCode,
      scope,
      limit,
      remaining: 0,
      measurementStatus: 'measured',
    })
  }

  // Spend we cannot read is not spend of zero. Refusing to guess is what `unknown` is for.
  if (!isAmount(spent)) {
    return result({
      decision: 'unknown',
      reason: 'usage_unknown',
      scope,
      limit,
      remaining: null,
      measurementStatus: 'unavailable',
    })
  }

  const remaining = remainingUnder(limit, spent)

  // Already at or past the limit: refuse without needing the request size at all.
  if (remaining === 0) {
    return result({
      decision: 'deny',
      reason: reasonCode,
      scope,
      limit,
      remaining: 0,
      measurementStatus: 'measured',
    })
  }

  // "Exactly at budget denies if the NEXT usage would exceed it." An unknown request size under
  // a known remaining is allowed to proceed — the reservation is what bounds it, and refusing
  // every unmeasurable request would disable delegation on any provider that reports no usage.
  if (isAmount(requested) && requested > remaining) {
    return result({
      decision: 'deny',
      reason: reasonCode,
      scope,
      limit,
      remaining,
      measurementStatus: 'estimated',
    })
  }

  return null
}

/**
 * Is a monetary limit in this scope spent, or unenforceable?
 *
 * The cost branch is where rule 2 earns its keep. Three states are genuinely different and the
 * repo refuses to flatten them:
 *
 *   STRUCTURALLY ZERO — a local provider, declared `billing: 'local_free'`. Its cost is 0
 *       because of how it runs, not because we failed to look it up. A monetary budget simply
 *       cannot be consumed by it, so the limit is irrelevant rather than unenforceable.
 *   KNOWN — rates exist and usage was reported. Compare and decide.
 *   UNKNOWN — a metered provider whose rates are null, which is the SHIPPED state of every row
 *       in the bundled pricing table. This is not $0. It returns `unknown`, and `onUnknownCost`
 *       decides what that means for this operator.
 */
function checkCost(scope, limit, spent, requested, reasonCode, billing) {
  if (!isSet(limit)) return null

  // A structurally free worker can never spend money, so a dollar ceiling does not apply to it.
  // Note this is read from a declared provider trait, NOT inferred from "needs no API key" —
  // a self-hosted metered gateway needs no key and is certainly not free.
  if (billing === 'local_free') return null

  if (limit === 0) {
    return result({
      decision: 'deny',
      reason: reasonCode,
      scope,
      limit,
      remaining: 0,
      measurementStatus: 'measured',
    })
  }

  if (!isAmount(spent)) {
    return result({
      decision: 'unknown',
      reason: 'cost_unknown',
      scope,
      limit,
      remaining: null,
      measurementStatus: 'unavailable',
    })
  }

  const remaining = remainingUnder(limit, spent)
  if (remaining === 0) {
    return result({
      decision: 'deny',
      reason: reasonCode,
      scope,
      limit,
      remaining: 0,
      measurementStatus: 'measured',
    })
  }

  if (isAmount(requested) && requested > remaining) {
    return result({
      decision: 'deny',
      reason: reasonCode,
      scope,
      limit,
      remaining,
      measurementStatus: 'estimated',
    })
  }

  // Spend is known and there is headroom, but THIS call cannot be priced, so we cannot show it
  // fits. That is `unknown`, not `allow`.
  //
  // The asymmetry with `checkTokens` is deliberate. An unpriceable call gets a null cost
  // reservation, so nothing bounds what it may spend and proceeding is a genuine unknown. An
  // unmeasurable TOKEN count is still bounded by the reservation the estimate sized, so it can
  // proceed on the evidence of that bound. Different guarantees, different answers.
  if (!isAmount(requested)) {
    return result({
      decision: 'unknown',
      reason: 'cost_unknown',
      scope,
      limit,
      remaining,
      measurementStatus: 'estimated',
    })
  }

  return null
}

/**
 * Decide whether a delegation is allowed under the configured budgets.
 *
 * PRECEDENCE, and why it is this way round. Scopes are checked narrowest first — run, then
 * daily, then monthly — and tokens before cost within each scope.
 *
 *   - Narrowest first because a per-run limit is the one the operator can act on immediately
 *     ("send fewer files"), while an exhausted month is a wait-or-raise-the-limit situation.
 *     Reporting the actionable one is more useful than reporting the largest.
 *   - Tokens before cost because tokens are measurable on a default install and cost is not.
 *     Checking cost first would report `cost_unknown` on an install where a token budget was
 *     cleanly and correctly refusing, which reads as a broken feature.
 *
 * The first scope that refuses owns the answer, exactly as the routing rule table works.
 *
 * @param {object}      a.limits   `config.budget` — the run/daily/monthly blocks
 * @param {object}      a.state    accumulated spend, from the ledger. Absent fields are unknown.
 * @param {object}      a.request  this delegation: estimated tokens and cost, if known
 * @param {object}      a.policy   `{enabled, billing}`
 * @returns {Readonly<object>} frozen; see `result()` for the shape
 */
export function evaluateBudget({ limits, state, request, policy } = {}) {
  // --- rule 4: the short-circuit. Reached before any caller would touch the ledger. ---

  if (!isPlainObject(policy) || policy.enabled !== true) {
    return result({ decision: 'allow', reason: 'governance_disabled' })
  }

  if (!isPlainObject(limits)) {
    // A malformed budget block is the "malformed config" case: warn-shaped, never blocking.
    return result({ decision: 'allow', reason: 'invalid_budget' })
  }

  const scopes = [
    ['run', own(limits, 'run'), 'run_budget_exceeded'],
    ['daily', own(limits, 'daily'), 'daily_budget_exceeded'],
    ['monthly', own(limits, 'monthly'), 'monthly_budget_exceeded'],
  ]

  // Collect the configured limits, and refuse to trust a malformed one rather than coercing it.
  const configured = []
  for (const [scope, block, reasonCode] of scopes) {
    if (!isPlainObject(block)) continue
    const cost = own(block, 'maxWorkerCostUsd') ?? null
    const input = own(block, 'maxInputTokens') ?? null
    const output = own(block, 'maxOutputTokens') ?? null
    const total = own(block, 'maxTotalTokens') ?? null

    for (const v of [cost, input, output, total]) {
      if (!isLimit(v)) {
        // A negative or non-numeric limit is a configuration error, not a budget of zero.
        // Treating it as zero would silently disable delegation on a typo.
        return result({ decision: 'allow', reason: 'invalid_budget', scope })
      }
    }
    if (isSet(cost) || isSet(input) || isSet(output) || isSet(total)) {
      configured.push({ scope, cost, input, output, total, reasonCode })
    }
  }

  if (configured.length === 0) {
    return result({ decision: 'allow', reason: 'budget_not_configured' })
  }

  // --- a limit exists, so the request and the ledger now matter ---

  const req = isPlainObject(request) ? request : {}
  const st = isPlainObject(state) ? state : {}
  const billing = own(policy, 'billing') ?? null

  const reqInput = own(req, 'inputTokens')
  const reqOutput = own(req, 'outputTokens')
  const reqTotal = own(req, 'totalTokens')
  const reqCost = own(req, 'costUsd')

  for (const c of configured) {
    const spent = own(st, c.scope)
    // Per-run has no accumulated history by definition: the run IS this one call, so "spent so
    // far this run" is zero and the request itself is the whole of it.
    const spentTokens = c.scope === 'run' ? 0 : own(spent, 'totalTokens')
    const spentCost = c.scope === 'run' ? 0 : own(spent, 'costUsd')

    const refusal =
      checkTokens(c.scope, c.input, spentTokens, reqInput, 'token_budget_exceeded') ??
      checkTokens(c.scope, c.output, spentTokens, reqOutput, 'token_budget_exceeded') ??
      checkTokens(c.scope, c.total, spentTokens, reqTotal, c.reasonCode) ??
      checkCost(c.scope, c.cost, spentCost, reqCost, c.reasonCode, billing)

    if (refusal !== null) {
      return result({
        ...refusal,
        reservationTokens: isAmount(reqTotal) ? reqTotal : null,
        reservationCostUsd: isAmount(reqCost) ? reqCost : null,
      })
    }
  }

  // Allowed under every configured limit. Report the headroom of the NARROWEST scope that
  // actually constrains, so the row records what was nearly hit rather than the most generous
  // number available.
  const narrowest = configured[0]
  const spent = own(st, narrowest.scope)
  const tokenLimit = isSet(narrowest.total) ? narrowest.total : null
  const costLimit = isSet(narrowest.cost) ? narrowest.cost : null
  const spentTokens = narrowest.scope === 'run' ? 0 : own(spent, 'totalTokens')
  // A structurally free worker spends nothing, so its cost headroom is the whole limit — that is
  // a measured zero, not an unknown one.
  const spentCost =
    narrowest.scope === 'run' || billing === 'local_free' ? 0 : own(spent, 'costUsd')

  // Report the token limit when there is one, because that is the dimension that can actually
  // bind; fall back to the cost limit otherwise. `remaining` and `measurementStatus` move
  // together: a null remaining is always paired with `unavailable`, never with a 0.
  const limit = tokenLimit ?? costLimit
  const remaining =
    tokenLimit !== null
      ? remainingUnder(tokenLimit, spentTokens)
      : costLimit !== null
        ? remainingUnder(costLimit, spentCost)
        : null

  return result({
    decision: 'allow',
    reason: 'within_budget',
    scope: narrowest.scope,
    limit,
    remaining,
    measurementStatus: remaining === null ? 'unavailable' : 'measured',
    reservationTokens: isAmount(reqTotal) ? reqTotal : null,
    reservationCostUsd: isAmount(reqCost) ? reqCost : null,
  })
}
