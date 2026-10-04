/**
 * Governance, composed: config in, one decision out.
 *
 * This file owns the ORDER of operations and nothing else. The policy is `policy.mjs`'s, the
 * state is `ledger.mjs`'s, and neither is re-implemented here — there is no limit, no threshold
 * and no period arithmetic in this file.
 *
 * The sequence, and why each step is where it is:
 *
 *   1. `hasConfiguredLimit()`     a pure object walk. With nothing configured — the shipped
 *                                 state — the answer is reached HERE, and no file is opened.
 *   2. `readState()`              one small JSON read. Only now, only if a limit exists.
 *   3. `evaluateBudget()`         pure. Returns allow / deny / unknown.
 *   4. operator policy            `onUnknownCost` / `onUnknownUsage` turn `unknown` into an
 *                                 answer; `onExceed` decides whether a breach actually blocks.
 *   5. `reserve()`               only on the allow path, and only when a limit exists.
 *
 * TWO THINGS THIS MODULE MUST NEVER DO, both pinned by `test/governance.isolation.test.mjs`:
 * import a provider, and be imported by the routing layer. Governance receives already-derived
 * facts — a token estimate, a billing model, a provider id as a string — and never goes looking
 * for them. It reads no API key, no prompt, no transcript and no file content.
 */

import fsDefault from 'node:fs'

import { evaluateBudget, hasConfiguredLimit } from './policy.mjs'
import { readState, release, reserve, settle } from './ledger.mjs'

/**
 * The decision a hook acts on.
 *
 * `decision` is closed to allow/deny here — `unknown` is resolved into one of the two by
 * operator policy before this returns, because a hook has to do something definite. The fact
 * that it WAS unknown survives in `reason` (`cost_unknown` / `usage_unknown`), so the row still
 * records the difference between "the budget is spent" and "we could not tell".
 */
const decided = (fields) =>
  Object.freeze({
    decision: fields.decision,
    reason: fields.reason,
    scope: fields.scope ?? null,
    limit: fields.limit ?? null,
    remaining: fields.remaining ?? null,
    measurementStatus: fields.measurementStatus ?? null,
    reservationTokens: fields.reservationTokens ?? null,
    reservationStatus: fields.reservationStatus ?? 'none',
    warnings: Object.freeze([...new Set(fields.warnings ?? [])].sort()),
  })

/**
 * May this delegation proceed, and claim its headroom if so.
 *
 * @param {object}   config          a resolved config, as `loadConfig()` returns
 * @param {string}   a.id            the reservation key; the hook passes `tool_use_id`
 * @param {object}   a.request       `{inputTokens, outputTokens, totalTokens, costUsd}`, each
 *                                   nullable. Estimates — the reservation is sized from these
 *                                   and always replaced by measured usage on settle.
 * @param {string}   [a.billing]     `'local_free' | 'metered'`, from the provider's declared
 *                                   capability. Never inferred from whether a key is needed.
 * @returns {Readonly<object>} see `decided()`
 */
export function checkBudget(config, { id, request = {}, billing = null, fs = fsDefault, now = Date.now() } = {}) {
  try {
    const limits = config?.budget ?? null
    const enabled = limits?.enabled === true

    // --- 1. the short-circuit. No I/O past this point unless a limit is actually set. ---

    if (!enabled) {
      return decided({ decision: 'allow', reason: 'governance_disabled' })
    }
    if (!hasConfiguredLimit(limits)) {
      return decided({ decision: 'allow', reason: 'budget_not_configured' })
    }

    // --- 2. state. One small read, and a failure to read it must not block a session. ---

    const read = readState(config, { fs, now })
    if (!read.ok) {
      // An unreadable ledger means we cannot prove the budget is spent. Blocking on that would
      // turn a storage problem into a dead router, so it allows and says why. Doctor reports
      // the same condition as a FAIL, where it is actionable rather than mid-session.
      return decided({
        decision: 'allow',
        reason: 'invalid_budget',
        measurementStatus: 'unavailable',
        warnings: [`budget_state_${read.reason ?? 'unavailable'}`],
      })
    }

    // --- 3. the pure decision ---

    const verdict = evaluateBudget({
      limits,
      state: read.state,
      request,
      policy: { enabled: true, billing },
    })

    // --- 4. operator policy resolves `unknown`, and decides whether a breach blocks ---

    const warnings = []
    let decision = verdict.decision

    if (decision === 'unknown') {
      const strict =
        verdict.reason === 'cost_unknown'
          ? limits.onUnknownCost === 'deny'
          : limits.onUnknownUsage === 'deny'
      // UNKNOWN IS NOT ZERO, but it is not automatically a refusal either. Defaulting to deny
      // would disable delegation on every install with an unpriced model, which is all of them
      // out of the box — a governance layer that bricks the router is not a safety feature.
      decision = strict ? 'deny' : 'allow'
      warnings.push(`budget_${verdict.reason}`)
    } else if (decision === 'deny' && limits.onExceed === 'warn') {
      // The operator asked to be told rather than stopped. The reason is preserved, so the row
      // still says which budget was breached.
      decision = 'allow'
      warnings.push(`budget_exceeded_${verdict.scope ?? 'unknown'}`)
    }

    if (decision !== 'allow') {
      return decided({ ...verdict, decision, reservationStatus: 'none', warnings })
    }

    // --- 5. claim the headroom. Only now, and only because a real limit exists. ---

    const claim = reserve(config, {
      id,
      tokens: request?.totalTokens ?? 0,
      costUsd: request?.costUsd ?? null,
      fs,
      now,
    })
    if (!claim.ok) {
      // Could not reserve — a contended lock or an unwritable ledger. Allow, warn, and do not
      // pretend the call is accounted for: `reservationStatus: 'none'` is what tells the settle
      // path there is nothing to convert.
      warnings.push(`budget_reserve_${claim.reason ?? 'failed'}`)
      return decided({ ...verdict, decision: 'allow', reservationStatus: 'none', warnings })
    }

    return decided({ ...verdict, decision: 'allow', reservationStatus: claim.status, warnings })
  } catch {
    // Rule: a broken governance layer degrades to an ungoverned router, never to a blocked
    // session. Identical in spirit to the wrapper `run.mjs` puts around `decide()`.
    return decided({ decision: 'allow', reason: 'invalid_budget', warnings: ['budget_threw'] })
  }
}

/**
 * Close out a reservation once the worker call has finished, one way or another.
 *
 * Never throws and returns a status, because this runs on the way out of a hook where there is
 * nobody left to report to. `usage === null` releases rather than charges: a call that reported
 * no usage created no measurable worker usage, and inventing a number would corrupt every
 * decision after it.
 *
 * @param {string|null} a.reservationStatus  what `checkBudget()` returned; `'none'` means there
 *                                           is nothing to close and this is a no-op
 * @param {object|null} a.usage              measured provider usage, or null
 * @param {number|null} a.costUsd            measured cost, or null when unpriced
 */
export function finalizeBudget(
  config,
  { id, reservationStatus = 'none', usage = null, costUsd = null, fs = fsDefault, now = Date.now() } = {},
) {
  try {
    if (reservationStatus !== 'reserved') return { ok: true, status: 'none', reason: 'not_reserved' }

    const total = usage?.totalTokens ?? null
    const input = usage?.inputTokens ?? null
    const output = usage?.outputTokens ?? null

    // Nothing measured means nothing consumed. This is the row of the accounting table that
    // covers a refusal before dispatch, a context_exceeded refusal, a transport error and a
    // timeout — none of them created worker usage, so none may consume budget.
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      return release(config, { id, fs, now })
    }

    return settle(config, {
      id,
      tokens: total,
      inputTokens: input,
      outputTokens: output,
      costUsd,
      fs,
      now,
    })
  } catch {
    return { ok: false, status: 'none', reason: 'finalize_threw' }
  }
}

export { readState, release, reserve, settle } from './ledger.mjs'
export {
  BILLING_MODELS,
  BUDGET_MEASUREMENT_STATUSES,
  BUDGET_SCOPES,
  GOVERNANCE_DECISIONS,
  GOVERNANCE_REASONS,
  RESERVATION_STATUSES,
  evaluateBudget,
  hasConfiguredLimit,
  periodKeys,
} from './policy.mjs'
