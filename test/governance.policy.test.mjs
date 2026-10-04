/**
 * The governance policy, as a pure decision.
 *
 * Four rules are on trial in this file, and each has its own section:
 *
 *  1. PURITY. `policy.mjs` imports nothing, reads no clock and touches no disk. The budget
 *     decision has to be cheap enough to sit on the hot path of every delegated read, and the
 *     only way to keep it that way is to make the impurity impossible rather than discouraged.
 *
 *  2. UNKNOWN IS NOT ZERO. An unknown cost is not a free call. `limit - unknown` is never
 *     evaluated as though unknown were 0, which would silently hand out the full budget.
 *
 *  3. null IS NOT ZERO EITHER. `null` is "no configured limit"; `0` is a configured zero budget
 *     that must refuse everything. Conflating them breaks in both directions at once.
 *
 *  4. FAILS OPEN. Disabled, unconfigured and malformed all return `allow`. A broken governance
 *     layer degrades to an ungoverned router, never to a blocked session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUDGET_MEASUREMENT_STATUSES,
  BUDGET_SCOPES,
  GOVERNANCE_DECISIONS,
  GOVERNANCE_REASONS,
  describeGovernance,
  evaluateBudget,
  hasConfiguredLimit,
  periodKeys,
} from '../plugins/model-router/lib/governance/policy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.join(HERE, '..', 'plugins', 'model-router', 'lib', 'governance', 'policy.mjs')

/** No limits at all, which is exactly what this project ships. */
const noLimits = () => ({
  enabled: true,
  run: { maxWorkerCostUsd: null, maxInputTokens: null, maxOutputTokens: null, maxTotalTokens: null },
  daily: { maxWorkerCostUsd: null, maxTotalTokens: null },
  monthly: { maxWorkerCostUsd: null, maxTotalTokens: null },
})

const limits = (over = {}) => {
  const base = noLimits()
  for (const [scope, block] of Object.entries(over)) base[scope] = { ...base[scope], ...block }
  return base
}

const spent = (over = {}) => ({
  run: { totalTokens: 0, costUsd: 0 },
  daily: { totalTokens: 0, costUsd: 0 },
  monthly: { totalTokens: 0, costUsd: 0 },
  ...over,
})

const decide = (over = {}) =>
  evaluateBudget({
    limits: noLimits(),
    state: spent(),
    request: {},
    policy: { enabled: true, billing: 'metered' },
    ...over,
  })

/* ------------------------------------------------------------------- purity */

test('the module imports nothing at all, so it is reachable from any layer', () => {
  // The same contract context-budget.mjs holds. It is what lets the hook call this without
  // dragging a provider, a clock or a filesystem onto the hot path.
  const src = fs.readFileSync(MODULE, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/^\s*import\s/m.test(stripped), false, 'policy.mjs must import nothing')
  assert.equal(/import\s*\(/.test(stripped), false, 'policy.mjs must not import dynamically')
  assert.equal(/require\s*\(/.test(stripped), false, 'policy.mjs must not require')
})

test('the module reads no clock, no randomness and no environment', () => {
  // `now` is injected everywhere it is needed. A budget decision that read the clock itself
  // could not be tested at a period boundary without also moving the machine's clock.
  const src = fs.readFileSync(MODULE, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/Date\.now/.test(stripped), false, 'policy.mjs must not read the clock')
  assert.equal(/Math\.random/.test(stripped), false, 'policy.mjs must not use randomness')
  assert.equal(/process\./.test(stripped), false, 'policy.mjs must not read process')
  assert.equal(/fetch\s*\(/.test(stripped), false, 'policy.mjs must not make a network call')
})

test('the decision is deterministic and frozen', () => {
  const first = JSON.stringify(decide({ limits: limits({ daily: { maxTotalTokens: 100 } }) }))
  for (let i = 0; i < 50; i += 1) {
    assert.equal(JSON.stringify(decide({ limits: limits({ daily: { maxTotalTokens: 100 } }) })), first)
  }
  assert.ok(Object.isFrozen(decide()), 'the result must be frozen')
})

/* --------------------------------------------------------------- fails open */

test('governance disabled allows, and says so rather than staying silent', () => {
  const r = evaluateBudget({ limits: noLimits(), policy: { enabled: false } })
  assert.equal(r.decision, 'allow')
  assert.equal(r.reason, 'governance_disabled')
})

test('a missing policy object allows rather than throwing', () => {
  // The caller handed us nothing. Blocking on that would turn a programming error into a dead
  // session, which is the one outcome the fail-open rule exists to prevent.
  for (const policy of [undefined, null, 'yes', 0, []]) {
    const r = evaluateBudget({ limits: noLimits(), policy })
    assert.equal(r.decision, 'allow', `policy=${JSON.stringify(policy)}`)
    assert.equal(r.reason, 'governance_disabled')
  }
})

test('a malformed budget block allows, and is reported as invalid rather than as zero', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const r = evaluateBudget({ limits: bad, policy: { enabled: true } })
    assert.equal(r.decision, 'allow', `limits=${JSON.stringify(bad)}`)
    assert.equal(r.reason, 'invalid_budget')
  }
})

test('a NEGATIVE limit is a configuration error, never a budget of zero', () => {
  // THE DANGEROUS CONFUSION. Reading -1 as "zero budget" would silently disable all delegation
  // on a typo; reading it as a real limit would make every comparison nonsense. It is neither:
  // it is invalid, it is reported, and it does not block.
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: -1 } }),
    policy: { enabled: true },
  })
  assert.equal(r.decision, 'allow')
  assert.equal(r.reason, 'invalid_budget')
  assert.equal(r.scope, 'daily', 'the offending scope is named')
})

test('a non-finite or non-numeric limit is invalid, and is not coerced', () => {
  for (const bad of [Number.NaN, Infinity, '500', true, {}]) {
    const r = evaluateBudget({
      limits: limits({ run: { maxTotalTokens: bad } }),
      policy: { enabled: true },
    })
    assert.equal(r.decision, 'allow', `limit=${String(bad)}`)
    assert.equal(r.reason, 'invalid_budget', `limit=${String(bad)}`)
  }
})

/* ------------------------------------------------------- null is not zero */

test('every limit null means no configured limit, not a zero budget', () => {
  // This is the SHIPPED configuration, so this test is the one that proves a default install is
  // ungoverned rather than frozen.
  const r = decide({ request: { totalTokens: 10_000_000, costUsd: 999 } })
  assert.equal(r.decision, 'allow')
  assert.equal(r.reason, 'budget_not_configured')
  assert.equal(r.limit, null)
  assert.equal(r.remaining, null)
})

test('hasConfiguredLimit is false for all-null and true for a configured zero', () => {
  // The short-circuit gate. It has to treat 0 as configured, or a deliberate zero budget would
  // be read as "nothing set" and become a blank cheque.
  assert.equal(hasConfiguredLimit(noLimits()), false)
  assert.equal(hasConfiguredLimit(limits({ run: { maxTotalTokens: 0 } })), true)
  assert.equal(hasConfiguredLimit(limits({ daily: { maxWorkerCostUsd: 0 } })), true)
  assert.equal(hasConfiguredLimit(limits({ monthly: { maxTotalTokens: 1 } })), true)
  for (const bad of [null, undefined, 'x', 3, []]) assert.equal(hasConfiguredLimit(bad), false)
})

test('a configured zero budget refuses everything, including a request of one token', () => {
  const r = evaluateBudget({
    limits: limits({ run: { maxTotalTokens: 0 } }),
    state: spent(),
    request: { totalTokens: 1 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.limit, 0)
  assert.equal(r.remaining, 0)
})

test('a configured zero budget refuses even a request whose size is unknown', () => {
  // There is no request small enough to fit under zero, so an unmeasurable one must not slip
  // through on the grounds that we could not size it.
  const r = evaluateBudget({
    limits: limits({ run: { maxTotalTokens: 0 } }),
    state: spent(),
    request: {},
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
})

/* ------------------------------------------------------------ token budgets */

test('a request comfortably under the limit is allowed, and reports its headroom', () => {
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 100, costUsd: 0 } }),
    request: { totalTokens: 50 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'allow')
  assert.equal(r.reason, 'within_budget')
  assert.equal(r.scope, 'daily')
  assert.equal(r.limit, 1000)
  assert.equal(r.remaining, 900)
  assert.equal(r.measurementStatus, 'measured')
})

test('exactly at the budget denies, because the next usage would exceed it', () => {
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 1000, costUsd: 0 } }),
    request: { totalTokens: 1 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.reason, 'daily_budget_exceeded')
  assert.equal(r.remaining, 0)
})

test('a request that would cross the limit denies even though spend is still under it', () => {
  // The whole point of checking before dispatching: 900 spent of 1000 is fine, and a 200-token
  // request on top of it is not.
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 900, costUsd: 0 } }),
    request: { totalTokens: 200 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.remaining, 100)
  assert.equal(r.measurementStatus, 'estimated', 'the request side is an estimate, and says so')
})

test('a request exactly filling the remaining budget is allowed', () => {
  // Boundary: `>` not `>=`. Spending the last of a budget you were given is not an overrun.
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 900, costUsd: 0 } }),
    request: { totalTokens: 100 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'allow')
})

test('past the budget denies without needing the request size at all', () => {
  // Overspend is reachable: measured usage can exceed what was reserved. Remaining clamps at 0
  // and is never reported negative, which is the invariant; the breach is still a refusal.
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 1500, costUsd: 0 } }),
    request: {},
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.remaining, 0, 'remaining must never go negative')
})

test('input and output token limits are enforced separately from the total', () => {
  const base = { state: spent(), policy: { enabled: true, billing: 'metered' } }
  const onInput = evaluateBudget({
    ...base,
    limits: limits({ run: { maxInputTokens: 100 } }),
    request: { inputTokens: 500, outputTokens: 1, totalTokens: 501 },
  })
  assert.equal(onInput.decision, 'deny')
  assert.equal(onInput.reason, 'token_budget_exceeded')

  const onOutput = evaluateBudget({
    ...base,
    limits: limits({ run: { maxOutputTokens: 100 } }),
    request: { inputTokens: 1, outputTokens: 500, totalTokens: 501 },
  })
  assert.equal(onOutput.decision, 'deny')
  assert.equal(onOutput.reason, 'token_budget_exceeded')

  // And a generous per-component limit does not accidentally cap the total.
  const neither = evaluateBudget({
    ...base,
    limits: limits({ run: { maxInputTokens: 1000, maxOutputTokens: 1000 } }),
    request: { inputTokens: 500, outputTokens: 500, totalTokens: 1000 },
  })
  assert.equal(neither.decision, 'allow')
})

test('per-run spend is always zero, because a run is one call', () => {
  // A per-run limit has no history to accumulate. If the ledger's daily figure leaked into the
  // run scope, the second delegation of the day would be refused by a per-call limit.
  const r = evaluateBudget({
    limits: limits({ run: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 999_999, costUsd: 500 } }),
    request: { totalTokens: 500 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'allow', 'a per-run limit must not see the day total')
})

/* ----------------------------------------------- unknown is not zero: usage */

test('unknown spend returns unknown, and never full headroom', () => {
  // RULE 2. If spend were read as 0 the whole budget would be handed out on the strength of a
  // measurement we did not have.
  for (const bad of [undefined, null, Number.NaN, 'lots', -5]) {
    const r = evaluateBudget({
      limits: limits({ daily: { maxTotalTokens: 1000 } }),
      state: { daily: { totalTokens: bad } },
      request: { totalTokens: 10 },
      policy: { enabled: true, billing: 'metered' },
    })
    assert.equal(r.decision, 'unknown', `spent=${String(bad)}`)
    assert.equal(r.reason, 'usage_unknown', `spent=${String(bad)}`)
    assert.equal(r.remaining, null, 'unknown headroom is null, never the limit')
    assert.equal(r.measurementStatus, 'unavailable')
  }
})

test('an unknown request size under known headroom proceeds, because the reservation bounds it', () => {
  // The asymmetry with cost, stated deliberately. A token request is bounded by the reservation
  // the estimate sized; refusing every unmeasurable one would disable delegation on any provider
  // that reports no usage, which is a worse failure than a bounded overshoot.
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 1000 } }),
    state: spent({ daily: { totalTokens: 10, costUsd: 0 } }),
    request: {},
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'allow')
})

/* ------------------------------------------------ unknown is not zero: cost */

test('a metered call with no known price returns unknown, not allow', () => {
  // THE DEFAULT STATE OF THIS PROJECT. Every rate in the bundled pricing table is null, so a
  // configured dollar budget cannot be shown to cover this call. Reporting that as "within
  // budget" would be the "unknown cost is free" bug in its most expensive form.
  const r = evaluateBudget({
    limits: limits({ daily: { maxWorkerCostUsd: 1 } }),
    state: spent(),
    request: { totalTokens: 10 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'unknown')
  assert.equal(r.reason, 'cost_unknown')
})

test('a structurally free provider is exempt from a monetary budget, and is not merely unknown', () => {
  // `local_free` is a DECLARED provider trait. The cost is zero because of how the model runs,
  // which is a different claim from "we could not look up a rate" — and the difference is why a
  // local Ollama install is not disabled by a dollar budget it can never consume.
  const r = evaluateBudget({
    limits: limits({ daily: { maxWorkerCostUsd: 1 } }),
    state: spent(),
    request: { totalTokens: 10 },
    policy: { enabled: true, billing: 'local_free' },
  })
  assert.equal(r.decision, 'allow')
  assert.equal(r.reason, 'within_budget')
  assert.equal(r.remaining, 1, 'a free worker has the whole budget available, measurably')
  assert.equal(r.measurementStatus, 'measured')
})

test('unknown accumulated cost returns unknown rather than assuming nothing was spent', () => {
  const r = evaluateBudget({
    limits: limits({ monthly: { maxWorkerCostUsd: 10 } }),
    state: { monthly: { costUsd: null } },
    request: { costUsd: 0.5 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'unknown')
  assert.equal(r.reason, 'cost_unknown')
  assert.equal(r.remaining, null)
})

test('a known cost over the remaining budget denies', () => {
  const r = evaluateBudget({
    limits: limits({ monthly: { maxWorkerCostUsd: 10 } }),
    state: spent({ monthly: { totalTokens: 0, costUsd: 9.8 } }),
    request: { costUsd: 0.5 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.reason, 'monthly_budget_exceeded')
  // 10 - 9.8, floating point and all. The assertion is on the refusal, not on the arithmetic.
  assert.ok(r.remaining < 0.3, `remaining was ${r.remaining}`)
})

/* ------------------------------------------------------------- precedence */

test('the narrowest scope that refuses owns the answer', () => {
  // Run before daily before monthly, because a per-run breach is the one the operator can act on
  // immediately ("send fewer files") while an exhausted month is a wait-or-raise situation.
  const r = evaluateBudget({
    limits: limits({
      run: { maxTotalTokens: 10 },
      daily: { maxTotalTokens: 10 },
      monthly: { maxTotalTokens: 10 },
    }),
    state: spent({ daily: { totalTokens: 500 }, monthly: { totalTokens: 500 } }),
    request: { totalTokens: 100 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.scope, 'run', 'the narrowest breached scope is reported')
})

test('tokens are checked before cost within a scope', () => {
  // Tokens are measurable on a default install and cost is not. Checking cost first would report
  // `cost_unknown` on an install where a token budget was correctly and cleanly refusing, which
  // reads as a broken feature rather than an enforced one.
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 10, maxWorkerCostUsd: 5 } }),
    state: spent({ daily: { totalTokens: 100, costUsd: 0 } }),
    request: { totalTokens: 10 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'deny')
  assert.equal(r.reason, 'daily_budget_exceeded')
  assert.equal(r.measurementStatus, 'measured', 'not cost_unknown')
})

test('a scope with no limits is skipped entirely rather than treated as zero', () => {
  const r = evaluateBudget({
    limits: limits({ monthly: { maxTotalTokens: 1_000_000 } }),
    state: spent({ monthly: { totalTokens: 1, costUsd: 0 } }),
    request: { totalTokens: 10 },
    policy: { enabled: true, billing: 'metered' },
  })
  assert.equal(r.decision, 'allow')
  assert.equal(r.scope, 'monthly', 'the only configured scope is the one reported')
})

/* --------------------------------------------------------------- UTC periods */

test('period keys are UTC, and are derived with no date arithmetic', () => {
  assert.deepEqual({ ...periodKeys(Date.parse('2026-10-04T12:00:00.000Z')) }, {
    day: '2026-10-04',
    month: '2026-10',
  })
})

test('the day rolls at midnight UTC, to the millisecond', () => {
  const before = periodKeys(Date.parse('2026-10-04T23:59:59.999Z'))
  const after = periodKeys(Date.parse('2026-10-05T00:00:00.000Z'))
  assert.equal(before.day, '2026-10-04')
  assert.equal(after.day, '2026-10-05')
  assert.equal(before.month, after.month, 'a day rollover inside a month must not move the month')
})

test('month and year boundaries roll, including a 31-day month and new year', () => {
  assert.equal(periodKeys(Date.parse('2026-01-31T23:59:59.999Z')).month, '2026-01')
  assert.equal(periodKeys(Date.parse('2026-02-01T00:00:00.000Z')).month, '2026-02')
  assert.equal(periodKeys(Date.parse('2026-12-31T23:59:59.999Z')).month, '2026-12')
  assert.equal(periodKeys(Date.parse('2027-01-01T00:00:00.000Z')).month, '2027-01')
})

test('leap and non-leap February need no special case', () => {
  // 2028 is a leap year, 2026 is not. Because the keys are substrings of an ISO string and no
  // arithmetic is done on dates, month length is simply never consulted.
  assert.equal(periodKeys(Date.parse('2028-02-29T00:00:00.000Z')).day, '2028-02-29')
  assert.equal(periodKeys(Date.parse('2028-02-29T00:00:00.000Z')).month, '2028-02')
  assert.equal(periodKeys(Date.parse('2026-02-28T23:59:59.999Z')).day, '2026-02-28')
  assert.equal(periodKeys(Date.parse('2026-03-01T00:00:00.000Z')).month, '2026-03')
})

test('a bad clock yields null keys rather than a wrong period', () => {
  for (const bad of [Number.NaN, Infinity, null, undefined, '2026-10-04']) {
    const k = periodKeys(bad)
    assert.equal(k.day, null, `now=${String(bad)}`)
    assert.equal(k.month, null, `now=${String(bad)}`)
  }
})

/* ------------------------------------------------------------- vocabularies */

test('every decision and reason emitted is a declared one', () => {
  const inputs = [
    { limits: noLimits(), policy: { enabled: false } },
    { limits: null, policy: { enabled: true } },
    { limits: limits({ run: { maxTotalTokens: -1 } }), policy: { enabled: true } },
    { limits: noLimits(), state: spent(), request: {}, policy: { enabled: true } },
    {
      limits: limits({ daily: { maxTotalTokens: 100 } }),
      state: spent(),
      request: { totalTokens: 1 },
      policy: { enabled: true },
    },
    {
      limits: limits({ daily: { maxTotalTokens: 100 } }),
      state: spent({ daily: { totalTokens: 100 } }),
      request: { totalTokens: 1 },
      policy: { enabled: true },
    },
    {
      limits: limits({ run: { maxInputTokens: 1 } }),
      state: spent(),
      request: { inputTokens: 100 },
      policy: { enabled: true },
    },
    {
      limits: limits({ monthly: { maxTotalTokens: 100 } }),
      state: spent({ monthly: { totalTokens: 100 } }),
      request: { totalTokens: 1 },
      policy: { enabled: true },
    },
    {
      limits: limits({ daily: { maxTotalTokens: 100 } }),
      state: { daily: {} },
      request: { totalTokens: 1 },
      policy: { enabled: true },
    },
    {
      limits: limits({ daily: { maxWorkerCostUsd: 1 } }),
      state: spent(),
      request: {},
      policy: { enabled: true, billing: 'metered' },
    },
  ]

  const decisions = new Set()
  const reasons = new Set()
  const scopes = new Set()
  const statuses = new Set()
  for (const input of inputs) {
    const r = evaluateBudget(input)
    decisions.add(r.decision)
    reasons.add(r.reason)
    if (r.scope !== null) scopes.add(r.scope)
    if (r.measurementStatus !== null) statuses.add(r.measurementStatus)
  }

  for (const d of decisions) assert.ok(GOVERNANCE_DECISIONS.includes(d), `undeclared decision ${d}`)
  for (const x of reasons) assert.ok(GOVERNANCE_REASONS.includes(x), `undeclared reason ${x}`)
  for (const x of scopes) assert.ok(BUDGET_SCOPES.includes(x), `undeclared scope ${x}`)
  for (const x of statuses) {
    assert.ok(BUDGET_MEASUREMENT_STATUSES.includes(x), `undeclared status ${x}`)
  }

  // And the completeness half: a declared decision nothing can produce is a claim about a
  // feature that does not exist.
  assert.deepEqual([...decisions].sort(), [...GOVERNANCE_DECISIONS].sort())
  assert.deepEqual([...scopes].sort(), [...BUDGET_SCOPES].sort())
})

test('every declared reason is reachable by some input', () => {
  // The check that catches a rule written and then shadowed by an earlier one. `within_budget`
  // and the rest each need a distinct input to produce them.
  const reached = new Set()
  const cases = [
    ['governance_disabled', { limits: noLimits(), policy: { enabled: false } }],
    ['budget_not_configured', { limits: noLimits(), state: spent(), policy: { enabled: true } }],
    [
      'within_budget',
      {
        limits: limits({ daily: { maxTotalTokens: 100 } }),
        state: spent(),
        request: { totalTokens: 1 },
        policy: { enabled: true },
      },
    ],
    [
      'run_budget_exceeded',
      {
        limits: limits({ run: { maxTotalTokens: 1 } }),
        state: spent(),
        request: { totalTokens: 99 },
        policy: { enabled: true },
      },
    ],
    [
      'daily_budget_exceeded',
      {
        limits: limits({ daily: { maxTotalTokens: 1 } }),
        state: spent({ daily: { totalTokens: 9 } }),
        request: {},
        policy: { enabled: true },
      },
    ],
    [
      'monthly_budget_exceeded',
      {
        limits: limits({ monthly: { maxTotalTokens: 1 } }),
        state: spent({ monthly: { totalTokens: 9 } }),
        request: {},
        policy: { enabled: true },
      },
    ],
    [
      'token_budget_exceeded',
      {
        limits: limits({ run: { maxInputTokens: 1 } }),
        state: spent(),
        request: { inputTokens: 99 },
        policy: { enabled: true },
      },
    ],
    [
      'cost_unknown',
      {
        limits: limits({ daily: { maxWorkerCostUsd: 1 } }),
        state: spent(),
        request: {},
        policy: { enabled: true, billing: 'metered' },
      },
    ],
    [
      'usage_unknown',
      {
        limits: limits({ daily: { maxTotalTokens: 1 } }),
        state: { daily: {} },
        request: {},
        policy: { enabled: true },
      },
    ],
    ['invalid_budget', { limits: 'nope', policy: { enabled: true } }],
  ]

  for (const [expected, input] of cases) {
    const r = evaluateBudget(input)
    assert.equal(r.reason, expected, `expected ${expected}, got ${r.reason}`)
    reached.add(r.reason)
  }
  assert.deepEqual([...reached].sort(), [...GOVERNANCE_REASONS].sort(), 'a declared reason is unreachable')
})

/* --------------------------------------------------------------- diagnosis */

const localWorker = { mode: 'bulk-reader', provider: 'ollama', billing: 'local_free', reportsUsage: true }
const meteredWorker = { mode: 'bulk-reader', provider: 'gemini', billing: 'metered', reportsUsage: true }

const diagnose = (over = {}) =>
  describeGovernance({
    limits: noLimits(),
    pricingAvailable: false,
    stateWritable: { ok: true },
    workers: [localWorker],
    ...over,
  })

const levels = (findings) => findings.map((f) => f.level)
const labels = (findings) => findings.map((f) => f.label).join(' | ')

test('the diagnosis states a finding even when nothing is wrong', () => {
  // A section that is silent when everything is fine cannot be told apart from a section that
  // forgot to check. That is doctor's own convention, applied here.
  const f = diagnose()
  assert.ok(f.length > 0, 'an unconfigured budget must still report something')
  assert.deepEqual(levels(f), ['ok'])
  assert.match(labels(f), /no budget is configured/)
})

test('a disabled budget is reported as disabled and nothing else is checked', () => {
  const f = diagnose({ limits: { ...noLimits(), enabled: false }, stateWritable: { ok: false } })
  assert.deepEqual(levels(f), ['ok'], 'an unwritable ledger is irrelevant when nothing is enforced')
  assert.match(labels(f), /governance is disabled/)
})

test('an unreadable budget block is a failure, because it means config did not resolve', () => {
  for (const bad of [null, 'nope', 42]) {
    const f = describeGovernance({ limits: bad })
    assert.deepEqual(levels(f), ['fail'], `limits=${String(bad)}`)
  }
})

test('a negative limit is a FAILURE, with the offending leaf named', () => {
  // The one budget problem with a definite fix, so it is the one that fails rather than warns.
  const f = diagnose({ limits: limits({ daily: { maxTotalTokens: -5 } }) })
  assert.ok(levels(f).includes('fail'), `expected a failure in ${labels(f)}`)
  assert.match(f.find((x) => x.level === 'fail').detail, /maxTotalTokens=-5/)
})

test('an unwritable state directory is a FAILURE only when a limit is configured', () => {
  // Nothing to record if nothing is enforced, so an unwritable directory is not a problem yet.
  const idle = diagnose({ stateWritable: { ok: false, reason: 'EACCES' } })
  assert.deepEqual(levels(idle), ['ok'], labels(idle))

  const live = diagnose({
    limits: limits({ daily: { maxTotalTokens: 100 } }),
    stateWritable: { ok: false, reason: 'EACCES' },
  })
  assert.ok(levels(live).includes('fail'), `expected a failure in ${labels(live)}`)
  assert.match(labels(live), /not writable/)
})

test('an unchecked state directory warns rather than claiming it is fine', () => {
  const f = diagnose({ limits: limits({ daily: { maxTotalTokens: 100 } }), stateWritable: null })
  assert.ok(levels(f).includes('warn'), labels(f))
  assert.match(labels(f), /was not checked/)
})

test('a monetary budget with no rates WARNS, and never fails', () => {
  // THE DEFAULT INSTALL. Every bundled rate is null, so this is the state anyone who sets a
  // dollar budget lands in. Failing would report a working router as broken.
  const f = diagnose({
    limits: limits({ daily: { maxWorkerCostUsd: 5 } }),
    workers: [meteredWorker],
    pricingAvailable: false,
  })
  assert.equal(levels(f).includes('fail'), false, `nothing here is a failure: ${labels(f)}`)
  assert.ok(levels(f).filter((l) => l === 'warn').length >= 2, labels(f))
  assert.match(labels(f), /pricing is unavailable/)
  assert.match(labels(f), /cannot be enforced exactly/)
})

test('a monetary budget on a structurally free worker is fine, and says why', () => {
  // The distinction `billing` exists for. A dollar ceiling on a local model can never bind, and
  // that is not a misconfiguration — it is a limit that does not apply.
  const f = diagnose({ limits: limits({ daily: { maxWorkerCostUsd: 5 } }), workers: [localWorker] })
  assert.equal(levels(f).includes('warn'), false, `expected no warning: ${labels(f)}`)
  assert.match(labels(f), /local and free/)
})

test('a monetary budget with rates available reports that cost governance can operate', () => {
  const f = diagnose({
    limits: limits({ monthly: { maxWorkerCostUsd: 5 } }),
    workers: [meteredWorker],
    pricingAvailable: true,
  })
  assert.match(labels(f), /cost governance can operate/)
  assert.equal(levels(f).includes('warn'), false, labels(f))
})

test('the unknown-cost warning says which way the switch is set', () => {
  // `allow` and `deny` have opposite consequences, so a warning that did not name the setting
  // would leave the operator unable to tell whether delegation was proceeding or being refused.
  const permissive = diagnose({
    limits: limits({ daily: { maxWorkerCostUsd: 5 } }),
    workers: [meteredWorker],
  })
  assert.match(JSON.stringify(permissive), /proceeds/)

  const strict = diagnose({
    limits: { ...limits({ daily: { maxWorkerCostUsd: 5 } }), onUnknownCost: 'deny' },
    workers: [meteredWorker],
  })
  assert.match(JSON.stringify(strict), /REFUSED/)
})

test('a token budget against a usage-silent worker warns that it cannot bind', () => {
  // The documented exposure, surfaced where someone will see it rather than only in a doc.
  const f = diagnose({
    limits: limits({ daily: { maxTotalTokens: 100 } }),
    workers: [{ ...localWorker, reportsUsage: false }],
  })
  assert.ok(levels(f).includes('warn'), labels(f))
  assert.match(JSON.stringify(f), /can never exhaust the budget/)
})

test('the same silent worker under onUnknownUsage deny is fine, because it will be refused', () => {
  const f = diagnose({
    limits: { ...limits({ daily: { maxTotalTokens: 100 } }), onUnknownUsage: 'deny' },
    workers: [{ ...localWorker, reportsUsage: false }],
  })
  assert.equal(levels(f).includes('warn'), false, labels(f))
  assert.match(JSON.stringify(f), /will be refused/)
})

test('onExceed warn is reported, because a budget that does not stop anything is a surprise', () => {
  const f = diagnose({
    limits: { ...limits({ daily: { maxTotalTokens: 100 } }), onExceed: 'warn' },
  })
  assert.ok(levels(f).includes('warn'), labels(f))
  assert.match(labels(f), /does not stop delegation/)
})

test('duplicate providers across lanes are named once, not once per lane', () => {
  // Both lanes normally resolve to the same worker, so a naive join produces "gemini, gemini"
  // and reads as a bug in the diagnostic itself.
  const f = diagnose({
    limits: limits({ daily: { maxWorkerCostUsd: 5 } }),
    workers: [meteredWorker, { ...meteredWorker, mode: 'code-writer' }],
  })
  assert.equal(/gemini, gemini/.test(JSON.stringify(f)), false, JSON.stringify(f))
})

test('every finding carries a level the renderer understands, and is frozen', () => {
  const inputs = [
    {},
    { limits: null },
    { limits: { ...noLimits(), enabled: false } },
    { limits: limits({ daily: { maxTotalTokens: -1 } }) },
    { limits: limits({ daily: { maxTotalTokens: 1 } }), stateWritable: { ok: false } },
    { limits: limits({ daily: { maxWorkerCostUsd: 1 } }), workers: [meteredWorker] },
  ]
  for (const input of inputs) {
    const f = diagnose(input)
    assert.ok(Object.isFrozen(f), 'the finding list must be frozen')
    for (const finding of f) {
      assert.ok(['ok', 'warn', 'fail'].includes(finding.level), `bad level ${finding.level}`)
      assert.equal(typeof finding.label, 'string')
      assert.equal(typeof finding.detail, 'string')
      assert.ok(Object.isFrozen(finding))
    }
  }
})

/* ----------------------------------------------------------------- hostility */

test('a prototype-polluted state object cannot reach the comparison', () => {
  // The ledger is a JSON file on disk. A hand-edited or corrupted one must not be able to inject
  // a limit or a spend through the prototype chain.
  const hostile = JSON.parse('{"__proto__": {"daily": {"totalTokens": 0}}}')
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 100 } }),
    state: hostile,
    request: { totalTokens: 1 },
    policy: { enabled: true, billing: 'metered' },
  })
  // No own `daily` key, so spend is unknown — not the injected zero.
  assert.equal(r.decision, 'unknown')
  assert.equal(r.reason, 'usage_unknown')
})

test('a request of hostile types is treated as unmeasured, not coerced', () => {
  const r = evaluateBudget({
    limits: limits({ daily: { maxTotalTokens: 100 } }),
    state: spent({ daily: { totalTokens: 50 } }),
    request: { totalTokens: '500', inputTokens: {}, costUsd: [] },
    policy: { enabled: true, billing: 'metered' },
  })
  // '500' is not parsed into a number that would have breached the limit.
  assert.equal(r.decision, 'allow')
  assert.equal(r.reservationTokens, null, 'an unparseable request size reserves nothing')
})
