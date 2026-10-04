/**
 * A LEDGER THAT LIES, AND THE ROUTER THAT KEEPS WORKING ANYWAY.
 *
 * CLAUDE.md's ninth non-negotiable says governance "fails open on every branch". Until this file,
 * not one of those branches had a test. Grepping `budget_threw`, `budget_state_`, `budget_reserve_`
 * and `finalize_threw` across `test/` returned nothing at all — the entire error surface of the
 * layer that is allowed to stop a delegation was unexercised.
 *
 * WHY HERE AND NOT IN AN EXISTING FILE. `governance.ledger.test.mjs` is about the ledger
 * primitives, and it already drives them with a hostile `fs`; `governance.integration.test.mjs`
 * drives the real hook. The untested seam is the one in between: nobody asserted that
 * `checkBudget()` turns a `{ok: false}` ledger read into `allow` plus a warning that names the
 * failure. That is a composition-level claim, so it gets a composition-level file.
 *
 * WHAT IS INJECTED, AND WHAT IS NOT. `ledger.mjs` takes `fs` and `now` as parameters, so every row
 * below is reached from the public parameter surface with a stub. Nothing here monkeypatches a
 * module, and nothing touches a real filesystem — which also means these tests say something about
 * the shipped code rather than about a patched copy of it.
 *
 * THE CLASSIFICATION. Every row is FAIL OPEN except the last, and that asymmetry is the point:
 *
 *   checkBudget    FAIL OPEN     a storage problem must not become a dead router
 *   finalizeBudget SAFE REFUSAL  it declines to MUTATE, because charging a number nobody measured
 *                                would corrupt every decision after it
 *
 * Three traps, each of which silently produces a vacuous test:
 *
 *   1. THE LIMIT MUST BE A TOKEN LIMIT. A configured `maxWorkerCostUsd` with `costUsd: null` makes
 *      `evaluateBudget()` return `cost_unknown`, which `onUnknownCost` resolves at step 4 — before
 *      `reserve()` is ever called. A cost limit never reaches the reservation branch.
 *   2. THE CLOCK MUST BE FROZEN. `periodKeys()` keys the ledger by UTC day and month, so a live
 *      clock makes a daily-scope row depend on when the suite runs.
 *   3. THE SHIPPED CONFIG REACHES NOTHING. With every limit `null`, `checkBudget` short-circuits on
 *      a pure object walk and never opens the ledger — which is exactly why
 *      `hook.failopen.test.mjs:174`'s lying-`fs` row does not reach governance at all.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkBudget, finalizeBudget } from '../plugins/model-router/lib/governance/index.mjs'

const STATE_DIR = 'C:/governance/never/touched'
/** Frozen: 2026-01-01T00:00:00Z. Trap 2. */
const NOW = 1767225600000

const errno = (code) => Object.assign(new Error(code), { code })
const ENOENT = errno('ENOENT')

/** A filesystem on which the ledger does not exist yet — the ordinary first-run state. */
const freshFs = () => ({
  readFileSync: () => {
    throw ENOENT
  },
  mkdirSync: () => {},
  writeFileSync: () => {},
  renameSync: () => {},
  unlinkSync: () => {},
  closeSync: () => {},
  openSync: () => 7,
  statSync: () => ({ mtimeMs: NOW }),
})

/**
 * A config with exactly one configured limit, and it is a TOKEN limit. Trap 1.
 *
 * `daily` rather than `run`, so the row also proves the period keys are computed from the injected
 * clock rather than from `Date.now()`.
 */
const budgeted = (over = {}) => ({
  budget: {
    enabled: true,
    run: { maxWorkerCostUsd: null, maxInputTokens: null, maxOutputTokens: null, maxTotalTokens: null },
    daily: { maxWorkerCostUsd: null, maxTotalTokens: 1_000_000 },
    monthly: { maxWorkerCostUsd: null, maxTotalTokens: null },
    onExceed: 'disable',
    onUnknownCost: 'allow',
    onUnknownUsage: 'allow',
    stateDir: STATE_DIR,
    stateDirResolved: STATE_DIR,
    ...over,
  },
})

const request = { inputTokens: 100, outputTokens: 200, totalTokens: 300, costUsd: null }

/* ------------------------------------------------------------------ the baseline */

test('the baseline reserves, so every failure row below is a real difference', () => {
  // Without this, none of the rows that follow can be told apart from "governance was never
  // consulted in the first place" — which is what the shipped all-null config produces.
  const g = checkBudget(budgeted(), {
    id: 'base', request, billing: 'local_free', fs: freshFs(), now: NOW,
  })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reason, 'within_budget')
  assert.equal(g.reservationStatus, 'reserved')
  assert.deepEqual([...g.warnings], [])
})

test('the shipped default never opens the ledger at all', () => {
  // Trap 3, asserted rather than described. An fs whose every method throws proves the
  // short-circuit is real: with no limit configured there is no I/O to fail.
  const explode = () => {
    throw new Error('the ledger must not be touched')
  }
  const noLimits = budgeted({ daily: { maxWorkerCostUsd: null, maxTotalTokens: null } })
  const g = checkBudget(noLimits, {
    id: 'x', request, fs: new Proxy({}, { get: () => explode }), now: NOW,
  })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reason, 'budget_not_configured')
  assert.deepEqual([...g.warnings], [])
})

/* ------------------------------------------------- step 2: the state read failed */

test('a ledger with nowhere to live allows, and reports its measurement as unavailable', () => {
  const g = checkBudget(budgeted({ stateDir: null, stateDirResolved: null }), {
    id: 'x', request, fs: freshFs(), now: NOW,
  })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reason, 'invalid_budget')
  assert.equal(g.measurementStatus, 'unavailable', 'an unprovable budget is unavailable, not measured')
  assert.equal(g.remaining, null, 'and remaining is null, never 0 — CLAUDE.md rule 6')
  assert.deepEqual([...g.warnings], ['budget_state_no_state_dir'])
})

test('a corrupt ledger is treated as unreadable, not as zero spend', () => {
  // The realistic case, and the one that matters most: a torn write. Reading it as zero spend
  // would silently reset the budget, which is the one failure mode a budget must not have.
  const g = checkBudget(budgeted(), {
    id: 'x', request, now: NOW,
    fs: { ...freshFs(), readFileSync: () => '{not json' },
  })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reason, 'invalid_budget')
  assert.equal(g.measurementStatus, 'unavailable')
  assert.deepEqual([...g.warnings], ['budget_state_unreadable_ledger'])
})

test('an unreadable ledger allows and says so', () => {
  const g = checkBudget(budgeted(), {
    id: 'x', request, now: NOW,
    fs: { ...freshFs(), readFileSync: () => { throw errno('EACCES') } },
  })
  assert.equal(g.decision, 'allow')
  assert.deepEqual([...g.warnings], ['budget_state_unreadable_ledger'])
})

/* ------------------------------------------- step 5: the reservation could not be taken */

test('a reservation that cannot be taken allows, warns, and does not claim to be accounted for', () => {
  // The subtle half. `reservationStatus: 'none'` is what tells finalizeBudget() there is nothing
  // to convert; reporting 'reserved' here would make the settle path charge against a reservation
  // that was never written, and a lost update is worse than an unenforced budget.
  //
  // Note that `reason` stays 'within_budget': the VERDICT was reached and is preserved. Only the
  // bookkeeping failed, and conflating the two would lose which of them went wrong.
  for (const [label, fsStub, expected] of [
    [
      'an unwritable state directory',
      { ...freshFs(), mkdirSync: () => { throw errno('EACCES') } },
      'budget_reserve_EACCES',
    ],
    [
      'a full disk',
      {
        ...freshFs(),
        // The lock is created with flag 'wx' and must succeed, or the failure is contention
        // rather than a write failure and this row would be testing the wrong branch.
        writeFileSync: (_p, _b, opts) => {
          if (opts?.flag === 'wx') return
          throw errno('ENOSPC')
        },
      },
      'budget_reserve_ENOSPC',
    ],
  ]) {
    const g = checkBudget(budgeted(), { id: 'x', request, fs: fsStub, now: NOW })
    assert.equal(g.decision, 'allow', label)
    assert.equal(g.reason, 'within_budget', `${label}: the verdict survives; only the claim failed`)
    assert.equal(g.reservationStatus, 'none', label)
    assert.deepEqual([...g.warnings], [expected], label)
  }
})

test('a payload with no tool_use_id is never reserved, and still delegates', () => {
  // Not a fault: hook/run.mjs passes null when Claude Code sent no tool_use_id, because without an
  // id a reservation cannot be settled idempotently. The router must still work.
  const g = checkBudget(budgeted(), { id: null, request, fs: freshFs(), now: NOW })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reservationStatus, 'none')
  assert.deepEqual([...g.warnings], ['budget_reserve_no_id'])
})

test('a contended lock allows rather than waiting, because a hook has a deadline', () => {
  // Every exclusive create fails, which is what a lock held by another process looks like from
  // here. Blocking would spend the hook's budget on a queue; CLAUDE.md's bounded-overshoot claim
  // is the honest consequence of choosing not to.
  const g = checkBudget(budgeted(), {
    id: 'x', request, now: NOW,
    fs: { ...freshFs(), writeFileSync: (_p, _b, opts) => { if (opts?.flag === 'wx') throw errno('EEXIST') } },
  })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reservationStatus, 'none')
  assert.deepEqual([...g.warnings], ['budget_reserve_lock_contended'])
})

/* --------------------------------------------------------- the outer catch: step 6 */

test('governance throwing anywhere at all still allows', () => {
  // Driven through the PARAMETER SURFACE — a hostile config, a hostile request — rather than by
  // replacing a module, because the claim under test is "no input to this function can stop a
  // session", and a monkeypatched internal would not test that claim.
  const hostileConfig = {
    get budget() {
      throw new Error('boom')
    },
  }
  const hostileRequest = {
    inputTokens: 100,
    outputTokens: 200,
    costUsd: null,
    get totalTokens() {
      throw new Error('boom')
    },
  }
  for (const [label, cfg, req] of [
    ['a config that throws on read', hostileConfig, request],
    ['a request that throws on read', budgeted(), hostileRequest],
  ]) {
    const g = checkBudget(cfg, { id: 'x', request: req, fs: freshFs(), now: NOW })
    assert.equal(g.decision, 'allow', label)
    assert.equal(g.reason, 'invalid_budget', label)
    assert.deepEqual([...g.warnings], ['budget_threw'], label)
  }
})

test('every failure path returns the same frozen shape, so a telemetry row is never half-written', () => {
  // hook/event.mjs maps eight governance columns off this object. A failure path that omitted a
  // key would write `undefined` into a row, and the schema's rule is that absent and null are
  // never two ways of saying the same thing.
  const KEYS = [
    'decision', 'reason', 'scope', 'limit', 'remaining',
    'measurementStatus', 'reservationTokens', 'reservationStatus', 'warnings',
  ].sort()
  const cases = [
    ['no state dir', budgeted({ stateDirResolved: null, stateDir: null }), freshFs()],
    ['corrupt ledger', budgeted(), { ...freshFs(), readFileSync: () => '{' }],
    ['unwritable', budgeted(), { ...freshFs(), mkdirSync: () => { throw errno('EACCES') } }],
    ['threw', { get budget() { throw new Error('x') } }, freshFs()],
  ]
  for (const [label, cfg, fsStub] of cases) {
    const g = checkBudget(cfg, { id: 'x', request, fs: fsStub, now: NOW })
    assert.deepEqual(Object.keys(g).sort(), KEYS, label)
    assert.ok(Object.isFrozen(g), `${label}: the decision must not be mutable by its caller`)
  }
})

/* ----------------------------------------------------------------- finalizeBudget */

test('finalize refuses to charge what it cannot compute, and never throws', () => {
  // NOT fail-open and NOT fail-closed. It declines to MUTATE: the reservation is left to expire
  // rather than charged against a number nobody measured. That is the only honest option, and it
  // is why the bounded-overshoot claim in docs/governance.md is bounded rather than absolute.
  const r = finalizeBudget({ get budget() { throw new Error('boom') } }, {
    id: 'f', reservationStatus: 'reserved', usage: null, fs: freshFs(), now: NOW,
  })
  assert.deepEqual(r, { ok: false, status: 'none', reason: 'finalize_threw' })
})

test('finalize with nothing reserved is a no-op, not an error', () => {
  // The common case by far: governance was never consulted, so there is nothing to close. It must
  // be distinguishable from a failure, or every default install would log one on every call.
  const explode = () => {
    throw new Error('must not be touched')
  }
  const r = finalizeBudget(budgeted(), {
    id: 'f', reservationStatus: 'none', fs: new Proxy({}, { get: () => explode }), now: NOW,
  })
  assert.deepEqual(r, { ok: true, status: 'none', reason: 'not_reserved' })
})

test('unmeasured usage releases the reservation instead of charging a guess', () => {
  // CLAUDE.md rule 6 at the governance layer: missing usage is NULL, never 0. A refusal before
  // dispatch, a context_exceeded, a transport error and a timeout all land here, and none of them
  // created worker usage, so none may consume budget.
  const written = []
  const fsStub = {
    ...freshFs(),
    readFileSync: () => JSON.stringify({
      version: 1,
      reservations: [{ id: 'f', tokens: 300, costUsd: null, at: NOW }],
      periods: {},
    }),
    writeFileSync: (p, body, opts) => {
      if (opts?.flag === 'wx') return
      written.push(String(body))
    },
  }
  for (const usage of [null, {}, { totalTokens: null }, { totalTokens: Number.NaN }]) {
    written.length = 0
    const r = finalizeBudget(budgeted(), {
      id: 'f', reservationStatus: 'reserved', usage, fs: fsStub, now: NOW,
    })
    assert.equal(r.ok, true, JSON.stringify(usage))
    assert.ok(
      written.every((body) => !/"tokens":\s*300/.test(body) || /"reservations":\s*\[\]/.test(body)),
      'an unmeasured call must not be settled as if 300 tokens had been spent',
    )
  }
})
