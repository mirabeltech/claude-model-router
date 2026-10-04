/**
 * Governance analytics.
 *
 * A GOVERNANCE DENIAL IS A SUCCESSFUL GOVERNANCE DECISION. It is not a routing failure, not a
 * worker failure, and not an error of any kind: the budget layer was asked whether the project
 * was allowed to spend, and it said no. A dashboard that files denials under failures reports a
 * working budget as a broken router.
 *
 * THE ROW MAKES THIS HARD IN THREE WAYS, and each gets its own test here:
 *
 *   - the denial is written as a `gate_block` row whose `routing_reason` is `threshold_met`,
 *     because the gate APPROVED before governance refused;
 *   - `status` is `skipped` with `error_code: null`, so it is not an error;
 *   - all eight governance columns null means governance was NEVER CONSULTED, which is a
 *     different state from "governance allowed this", and the two must not be merged.
 *
 * AND BUDGET LIMITS ARE NEVER SUMMED. A limit is not a quantity consumed. Adding `budget_limit`
 * across rows produces a number with no referent at all, so the only honest aggregate of a
 * configured ceiling is its most recent observation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { AGG_SLOTS } from '../plugins/model-router/lib/analytics/metrics.mjs'
import { predicates } from '../plugins/model-router/lib/analytics/predicates.mjs'
import { NOW, denialRow, dispatchedRow, errorRow, gateRow } from './helpers/analytics-rows.mjs'

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })

/* ------------------------------------------------------- allow versus deny */

test('an allowed delegation is counted as allowed, not merely as not denied', () => {
  const r = run([dispatchedRow()])
  assert.equal(r.governance.allowed.value, 1)
  assert.equal(r.governance.denied.value, 0)
  assert.equal(r.governance.consulted.value, 1)
  assert.equal(r.governance.notConsulted.value, 0)
})

test('a denial is counted as a denial and as nothing else', () => {
  const r = run([denialRow()])
  assert.equal(r.governance.denied.value, 1)
  assert.equal(r.failures.governanceDenials.value, 1)
  // Not a worker failure, not a capability refusal, not an unknown cost.
  assert.equal(r.failures.workerFailures.value, 0)
  assert.equal(r.failures.capabilityRefusals.total.value, 0)
  assert.equal(r.failures.unknownCost.value, 0)
})

test('a denial is a skipped row with no error code, so it is not an error', () => {
  const row = denialRow()
  assert.equal(row.status, 'skipped')
  assert.equal(row.error_code, null)
  assert.equal(predicates.workerFailure(row), false)
})

test('a denial keeps the gate reason that approved it, and only governance_decision refuses', () => {
  const r = run([denialRow()])
  const reasons = Object.fromEntries(r.routing.byReason.buckets.map((b) => [b.key, b.count]))
  assert.equal(reasons.threshold_met, 1, 'the gate approved this request')
  assert.equal(r.routing.byClass.governanceDenied, 1)
  assert.equal(r.routing.byClass.gateRefused, 0, 'and it is not filed as a gate refusal')
})

test('the routing and governance decisions are reported as two separate verdicts', () => {
  // "Routing: delegation appropriate. Governance: denied, daily budget exceeded." Two answers to
  // two questions, and collapsing them loses the whole point of the separation.
  const r = run([denialRow()])
  assert.equal(r.routing.counts.dispatchAttempted.value, 0)
  assert.equal(r.governance.denied.value, 1)
  const govReasons = Object.fromEntries(r.governance.byReason.buckets.map((b) => [b.key, b.count]))
  assert.equal(govReasons.daily_budget_exceeded, 1)
  assert.match(r.governance.note, /gate approved and governance then refused/)
})

/* ---------------------------------------------------- consulted or not */

test('all eight governance columns null means NEVER CONSULTED, not allowed', () => {
  // A gate refusal reached before the budget layer ran. Counting it as an allow would overstate
  // how often governance actually said yes.
  const row = gateRow()
  assert.equal(predicates.governanceNotConsulted(row), true)
  const r = run([row])
  assert.equal(r.governance.notConsulted.value, 1)
  assert.equal(r.governance.allowed.value, 0)
  assert.equal(r.governance.consulted.value, 0)
})

test('consulted, allowed and denied reconcile exactly', () => {
  const r = run([gateRow(), dispatchedRow(), denialRow()])
  assert.equal(r.governance.notConsulted.value, 1)
  assert.equal(r.governance.allowed.value, 1)
  assert.equal(r.governance.denied.value, 1)
  assert.equal(r.governance.consulted.value, r.governance.allowed.value + r.governance.denied.value)
})

/* ----------------------------------------------------------- denial reasons */

test('each denial reason is reported separately, including the unmeasurable ones', () => {
  // `cost_unknown` and `usage_unknown` are refusals BECAUSE a measurement was missing. They are
  // successful governance decisions about an unknown, not failures to decide.
  const r = run([
    denialRow({ governance_reason: 'daily_budget_exceeded' }),
    denialRow({ governance_reason: 'monthly_budget_exceeded', budget_scope: 'monthly' }),
    denialRow({ governance_reason: 'cost_unknown', budget_remaining: null, budget_measurement_status: 'unavailable' }),
    denialRow({ governance_reason: 'usage_unknown', budget_remaining: null, budget_measurement_status: 'unavailable' }),
  ])
  const reasons = Object.fromEntries(r.governance.byReason.buckets.map((b) => [b.key, b.count]))
  assert.deepEqual(reasons, {
    daily_budget_exceeded: 1,
    monthly_budget_exceeded: 1,
    cost_unknown: 1,
    usage_unknown: 1,
  })
  assert.equal(r.governance.denied.value, 4)
  assert.equal(r.failures.workerFailures.value, 0, 'none of these is a failure')
})

test('a denial on an unknown cost does not also count as an unknown-cost event', () => {
  // `unknownCost` requires a SUCCESSFUL dispatch. A denial never reached the provider, so
  // counting it in both places would double-report one row under two different stories.
  const r = run([denialRow({ governance_reason: 'cost_unknown' })])
  assert.equal(r.governance.denied.value, 1)
  assert.equal(r.cost.unknownCostEvents.value, 0)
})

test('the measurement status of a budget decision is reported, not assumed', () => {
  const r = run([
    denialRow({ budget_measurement_status: 'measured' }),
    denialRow({ budget_measurement_status: 'unavailable', budget_remaining: null }),
  ])
  const statuses = Object.fromEntries(r.governance.byMeasurementStatus.buckets.map((b) => [b.key, b.count]))
  assert.equal(statuses.measured, 1)
  assert.equal(statuses.unavailable, 1)
})

/* -------------------------------------------------------------- reservations */

test('reservation statuses are reported, including an overrun', () => {
  const r = run([
    dispatchedRow({ reservation_status: 'settled', reservation_tokens: 9000 }),
    dispatchedRow({ reservation_status: 'overrun', reservation_tokens: 12000 }),
    denialRow({ reservation_status: 'released', reservation_tokens: 10000 }),
  ])
  const statuses = Object.fromEntries(r.governance.byReservationStatus.buckets.map((b) => [b.key, b.count]))
  assert.equal(statuses.settled, 1)
  assert.equal(statuses.overrun, 1)
  assert.equal(statuses.released, 1)
})

test('reservation TOKENS are a quantity and may be summed', () => {
  const r = run([
    dispatchedRow({ reservation_tokens: 9000, reservation_status: 'settled' }),
    dispatchedRow({ reservation_tokens: 1000, reservation_status: 'settled' }),
  ])
  assert.equal(r.governance.reservationTokens.value, 10000)
  assert.equal(r.governance.reservationTokens.population, 'governanceConsulted')
})

/* ------------------------------------------------------------ budget limits */

test('no aggregate anywhere reads a budget limit, because a limit is not a quantity', () => {
  // A static check over the slot table, so the rule survives somebody adding a headline later.
  const source = AGG_SLOTS.map((s) => s.path).join(' ')
  assert.equal(/budget_limit|budget_remaining|budgetLimit|budgetRemaining/.test(source), false)
})

test('a budget ceiling is reported as its latest observation, never as a sum', () => {
  // Three rows, same daily limit. A sum would say $4.50, which is not a budget anybody set.
  const r = run([
    denialRow({ budget_limit: 1.5, budget_remaining: 0.4, timestamp: '2026-03-04T01:00:00.000Z' }),
    denialRow({ budget_limit: 1.5, budget_remaining: 0.2, timestamp: '2026-03-04T02:00:00.000Z' }),
    denialRow({ budget_limit: 1.5, budget_remaining: 0, timestamp: '2026-03-04T03:00:00.000Z' }),
  ])
  assert.equal(r.governance.budgetSnapshots.aggregated, false)
  const daily = r.governance.budgetSnapshots.snapshots.find((s) => s.scope === 'daily')
  assert.equal(daily.limit, 1.5, 'not 4.5')
  assert.equal(daily.remaining, 0, 'the most recent observation, by instant')
  assert.equal(daily.observations, 3)
  assert.match(r.governance.budgetSnapshots.note, /never summed/)
})

test('the latest observation is chosen by instant, not by arrival order', () => {
  const r = run([
    denialRow({ budget_remaining: 0, timestamp: '2026-03-04T03:00:00.000Z' }),
    denialRow({ budget_remaining: 0.9, timestamp: '2026-03-04T01:00:00.000Z' }),
  ])
  const daily = r.governance.budgetSnapshots.snapshots.find((s) => s.scope === 'daily')
  assert.equal(daily.remaining, 0, 'the 03:00 row is newer than the 01:00 row that arrived second')
})

test('utilization is computed only when both operands are known', () => {
  const r = run([
    denialRow({ budget_scope: 'daily', budget_limit: 2, budget_remaining: 0.5 }),
    denialRow({ budget_scope: 'monthly', budget_limit: 20, budget_remaining: null, budget_measurement_status: 'unavailable' }),
    denialRow({ budget_scope: 'run', budget_limit: null, budget_remaining: null, budget_measurement_status: 'unavailable' }),
  ])
  const byScope = Object.fromEntries(r.governance.budgetSnapshots.snapshots.map((s) => [s.scope, s]))
  assert.equal(byScope.daily.utilization, 0.75)
  // Unknown remaining means unknown utilization. Substituting 0 would report a spent budget as
  // untouched, or an untouched one as spent, depending on which way the guess went.
  assert.equal(byScope.monthly.utilization, null)
  assert.equal(byScope.run.utilization, null)
  assert.equal(byScope.run.limit, null, 'no limit configured is null, never 0 and never infinity')
})

test('each budget scope is snapshotted separately', () => {
  const r = run([
    denialRow({ budget_scope: 'daily', budget_limit: 1.5 }),
    denialRow({ budget_scope: 'monthly', budget_limit: 30 }),
  ])
  const scopes = r.governance.budgetSnapshots.snapshots.map((s) => s.scope)
  assert.deepEqual(scopes, ['daily', 'monthly'], 'sorted, so the output is deterministic')
})

test('a window with no governance rows reports no snapshots rather than a zeroed one', () => {
  const r = run([gateRow()])
  assert.deepEqual(r.governance.budgetSnapshots.snapshots, [])
})

/* -------------------------------------------------- against the other kinds */

test('a worker failure is not a governance denial, and neither is a context refusal', () => {
  const r = run([
    errorRow(),
    dispatchedRow({ status: 'skipped', routing_reason: 'context_exceeded', error_code: null }),
    denialRow(),
  ])
  assert.equal(r.failures.workerFailures.value, 1)
  assert.equal(r.failures.capabilityRefusals.total.value, 1)
  assert.equal(r.failures.governanceDenials.value, 1)
  assert.equal(r.governance.denied.value, 1, 'exactly one of the three is a denial')
})

test('a denial is still a routing event, so it stays in the delegation-rate denominator', () => {
  // It was a real hook invocation that a real developer waited on. Dropping it would overstate
  // the delegation rate.
  const r = run([dispatchedRow(), denialRow()])
  assert.equal(r.summary.delegationRate.denominator, 2)
  assert.equal(r.summary.delegationRate.numerator, 1)
})

test('a denied row contributes no worker tokens and no cost, because no call was made', () => {
  const r = run([denialRow()])
  assert.equal(r.summary.workerTokens.value, null)
  assert.equal(r.summary.workerCost.value, null)
  assert.equal(r.summary.workerTokens.rowsTotal, 0, 'a denial is not in the dispatched population')
})
