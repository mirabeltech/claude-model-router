/**
 * Routing analytics, and above all the DENOMINATOR.
 *
 * The delegation rate is the number this dashboard exists to report, and it is the easiest number
 * in the system to get wrong: computed over worker records alone it is always 100%, and it looks
 * entirely credible. The denominator is the routing-event population — every hook invocation —
 * which only exists in the store while `telemetry.recordGateDecisions` is on.
 *
 * THE OTHER TRAP IS THE ROW TAXONOMY. A governance denial is written as a `gate_block` row whose
 * `routing_reason` is `threshold_met`, because the gate APPROVED and governance then refused. Any
 * classifier that reads `task_type === 'gate_block'` as "routing declined" folds every budget
 * denial into gate refusals and loses the governance signal completely.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { classifyRow, predicates } from '../plugins/model-router/lib/analytics/predicates.mjs'
import { GATE_REFUSAL_REASONS, ROW_CLASSES } from '../plugins/model-router/lib/analytics/schema.mjs'
import { ROUTING_REASONS } from '../plugins/model-router/lib/telemetry/record.mjs'
import {
  NOW,
  denialRow,
  dispatchedRow,
  errorRow,
  gateRow,
  pricedRow,
} from './helpers/analytics-rows.mjs'

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })

/* ------------------------------------------------------------ classification */

test('classification is exhaustive: every row lands in exactly one class', () => {
  const rows = [
    gateRow(),
    denialRow(),
    dispatchedRow(),
    errorRow(),
    dispatchedRow({ status: 'skipped', routing_reason: 'context_exceeded' }),
    gateRow({ routing_decision: 'delegated', routing_reason: 'threshold_met', governance_decision: 'allow' }),
    dispatchedRow({ schema_version: 2 }),
  ]
  const violations = []
  for (const row of rows) {
    const klass = classifyRow(row)
    if (!ROW_CLASSES.includes(klass)) violations.push(`${row.event_id}: ${klass}`)
  }
  assert.deepEqual(violations, [], 'a row classified outside the declared set')

  const r = run(rows)
  const total = Object.values(r.routing.byClass).reduce((a, b) => a + b, 0)
  assert.equal(total, rows.length, 'the classes must partition the rows, with no double counting')
})

test('a governance denial is classified as a denial, not as a gate refusal', () => {
  // The only discriminator is governance_decision. task_type is gate_block and routing_reason is
  // threshold_met, because the gate approved.
  const row = denialRow()
  assert.equal(row.task_type, 'gate_block')
  assert.equal(row.routing_reason, 'threshold_met')
  assert.equal(classifyRow(row), 'governanceDenied')

  const r = run([gateRow(), denialRow()])
  assert.equal(r.routing.byClass.gateRefused, 1)
  assert.equal(r.routing.byClass.governanceDenied, 1)
})

test('an approved row that was never dispatched is reported as ambiguous, not as a refusal', () => {
  // content_unreadable and content_binary produce this, and NOTHING ON THE ROW SAYS SO:
  // error_code is null and no routing_reason names them. A real telemetry gap, surfaced rather
  // than guessed at.
  const row = gateRow({
    routing_decision: 'delegated',
    routing_reason: 'threshold_met',
    governance_decision: 'allow',
    governance_reason: 'budget_not_configured',
  })
  assert.equal(classifyRow(row), 'approvedNotDispatched')

  const r = run([row])
  assert.equal(r.routing.counts.approvedNotDispatched.value, 1)
  assert.equal(r.routing.approvedNotDispatchedAmbiguous.ambiguous, true)
  assert.match(r.routing.approvedNotDispatchedAmbiguous.detail, /not recoverable from telemetry/)
})

test('an unreadable row is classified first, before anything else is interpreted', () => {
  // Nothing on a future-schema row can be read safely, including its task_type.
  assert.equal(classifyRow(denialRow({ schema_version: 2 })), 'schemaIncompatible')
})

test('every gate refusal reason is a routing reason, and the approving ones are excluded', () => {
  assert.deepEqual(GATE_REFUSAL_REASONS.filter((r) => !ROUTING_REASONS.includes(r)), [])
  for (const approving of ['threshold_met', 'context_exceeded', 'provider_error']) {
    assert.equal(GATE_REFUSAL_REASONS.includes(approving), false, `${approving} is not a gate refusal`)
  }
})

test('an unknown routing reason on a gate row is ambiguous rather than a refusal', () => {
  // Enums are open on read. A reason this build does not know might be a genuine new refusal in
  // a newer store, so counting it as a gate refusal would be a guess; it lands in the ambiguous
  // class, which is the honest place for it.
  assert.equal(classifyRow(gateRow({ routing_reason: 'quantum_tunnelling' })), 'approvedNotDispatched')
})

/* ------------------------------------------------------------- the denominator */

test('the delegation rate denominator is every routing event, not the delegations', () => {
  const r = run([dispatchedRow(), gateRow(), gateRow(), gateRow()])
  assert.equal(r.summary.delegationRate.numerator, 1)
  assert.equal(r.summary.delegationRate.denominator, 4)
  assert.equal(r.summary.delegationRate.value, 0.25)
  assert.equal(r.summary.delegationRate.display, '25.0% (1 of 4)')
})

test('a governance denial is in the denominator: it was a routing event', () => {
  const r = run([dispatchedRow(), denialRow()])
  assert.equal(r.summary.delegationRate.denominator, 2)
  assert.equal(r.summary.delegationRate.value, 0.5)
})

test('with gate decisions suppressed the rate is NULL, never 100%', () => {
  // THE WHOLE POINT. Against delegations alone the arithmetic gives 1.0, and a dashboard showing
  // "delegation rate: 100%" on a store that is simply not recording refusals is worse than one
  // showing nothing at all.
  const rows = [dispatchedRow(), dispatchedRow(), pricedRow()]
  const r = run(rows, { config: { telemetry: { recordGateDecisions: false } } })
  assert.equal(r.summary.delegationRate.value, null)
  assert.equal(r.summary.delegationRate.denominatorComplete, false)
  assert.equal(r.summary.delegationRate.caveat, 'gate_rows_not_recorded')
  assert.match(r.summary.delegationRate.display, /unavailable/)
  assert.equal(r.routing.delegationRate.value, null)
  assert.equal(r.routing.refusalRate.value, null)
})

test('the suppressed-denominator condition is raised from the CONFIG as evidence', () => {
  const r = run([dispatchedRow()], { config: { telemetry: { recordGateDecisions: false } } })
  const condition = r.dataQuality.conditions.find((c) => c.id === 'gate_decisions_not_recorded')
  assert.ok(condition, 'the condition must be raised')
  assert.equal(condition.severity, 'error')
  assert.equal(condition.evidence.configSaysOff, true)
  assert.ok(condition.affects.includes('summary.delegationRate'))
})

test('the suppressed-denominator condition is ALSO raised from the rows alone', () => {
  // An operator reading a report on somebody else's store has no access to their config, so the
  // absence of any gate row is independent evidence and has to stand on its own.
  const r = run([dispatchedRow(), pricedRow()], { config: { telemetry: { recordGateDecisions: true } } })
  const condition = r.dataQuality.conditions.find((c) => c.id === 'gate_decisions_not_recorded')
  assert.ok(condition, 'no gate row in a non-empty window is itself the evidence')
  assert.equal(condition.evidence.configSaysOff, false)
  assert.equal(condition.evidence.noGateRowObserved, true)
  assert.equal(condition.evidence.gateRowsSeen, 0)
})

test('one gate row is enough to make the denominator trustworthy again', () => {
  const r = run([dispatchedRow(), gateRow()])
  assert.equal(r.dataQuality.gateDecisionsRecorded, true)
  assert.equal(r.summary.delegationRate.value, 0.5)
  assert.equal(r.dataQuality.conditions.some((c) => c.id === 'gate_decisions_not_recorded'), false)
})

test('an empty window raises no denominator condition, because there is nothing to be missing', () => {
  // `countable > 0` guards the observed-evidence branch: a fresh install has no gate rows
  // because it has no rows, which is not a configuration problem.
  const r = run([])
  assert.equal(r.dataQuality.conditions.some((c) => c.id === 'gate_decisions_not_recorded'), false)
})

test('an unreadable row is excluded from the denominator', () => {
  const r = run([dispatchedRow(), gateRow(), dispatchedRow({ schema_version: 2 })])
  assert.equal(r.summary.delegationRate.denominator, 2, 'a row we cannot read is not an event')
})

/* ------------------------------------------------------------------- rates */

test('the refusal rate and the delegation rate share the same denominator', () => {
  const r = run([dispatchedRow(), gateRow(), denialRow(), gateRow()])
  assert.equal(r.routing.delegationRate.denominator, 4)
  assert.equal(r.routing.refusalRate.denominator, 4)
  assert.equal(r.routing.delegationRate.numerator + r.routing.refusalRate.numerator, 4,
    'every event either reached a worker or was refused')
})

test('the success rate is over dispatched rows, not over all events', () => {
  // Mixing these denominators would make a store with many cheap gate refusals look like a store
  // with a failing provider.
  const r = run([dispatchedRow(), errorRow(), gateRow(), gateRow()])
  assert.equal(r.routing.successRate.denominator, 2)
  assert.equal(r.routing.successRate.numerator, 1)
  assert.equal(r.routing.successRate.value, 0.5)
  assert.equal(r.routing.successRate.population, 'dispatchAttempted')
})

test('a rate over an empty population is null rather than a division by zero', () => {
  const r = run([gateRow()])
  assert.equal(r.routing.successRate.denominator, 0)
  assert.equal(r.routing.successRate.value, null)
})

/* -------------------------------------------------------------- histograms */

test('routing reasons are histogrammed with their raw values preserved', () => {
  const r = run([
    gateRow({ routing_reason: 'below_threshold' }),
    gateRow({ routing_reason: 'below_threshold' }),
    gateRow({ routing_reason: 'deny_glob' }),
    dispatchedRow(),
  ])
  const buckets = Object.fromEntries(r.routing.byReason.buckets.map((b) => [b.key, b.count]))
  assert.equal(buckets.below_threshold, 2)
  assert.equal(buckets.deny_glob, 1)
  assert.equal(buckets.threshold_met, 1)
})

test('a histogram is ordered by count descending then key ascending, a total order', () => {
  // Deterministic ordering is what makes the CI reproducibility diff meaningful.
  const r = run([
    gateRow({ routing_reason: 'deny_glob' }),
    gateRow({ routing_reason: 'recently_edited' }),
    gateRow({ routing_reason: 'below_threshold' }),
    gateRow({ routing_reason: 'below_threshold' }),
  ])
  const keys = r.routing.byReason.buckets.map((b) => b.key)
  assert.equal(keys[0], 'below_threshold', 'the biggest bucket leads')
  assert.deepEqual(keys.slice(1), ['deny_glob', 'recently_edited'], 'ties break on the key')
})

test('an unknown enum is preserved verbatim in the histogram, not rewritten', () => {
  const r = run([
    dispatchedRow({
      routing_reason: 'quantum_tunnelling',
      validation_warnings: 1,
      validation_codes: 'unknown_enum:routing_reason',
    }),
  ])
  const keys = r.routing.byReason.buckets.map((b) => b.key)
  assert.ok(keys.includes('quantum_tunnelling'), 'the raw value survives into the report')
})

test('a deliberate `other` and an unknown-bucketed `other` are counted apart where possible', () => {
  const r = run([
    dispatchedRow({ routing_reason: 'other' }),
    dispatchedRow({
      routing_reason: 'quantum_tunnelling',
      validation_codes: 'unknown_enum:routing_reason',
      validation_warnings: 1,
    }),
  ])
  assert.equal(r.routing.otherKinds.routing_reason.unknown_enum, 1)
  // A literal `other` with validation_codes null cannot be told from an unknown one that
  // bucketed to it, and the report says `indeterminate` rather than picking a side.
  assert.equal(r.routing.otherKinds.routing_reason.indeterminate, 1)
})

test('the other-kind breakdown is per field, so unrelated columns cannot pool into one count', () => {
  // MEASURED before the fix: a single pooled counter meant a null `budget_scope` — which
  // `bucket()` maps to `other`, because null is in no enum — was reported under
  // `routing.otherKinds`, inflating the routing unknown-enum count on essentially every row.
  const r = run([
    dispatchedRow({
      routing_reason: 'quantum_tunnelling',
      validation_codes: 'unknown_enum:routing_reason',
      validation_warnings: 1,
      budget_scope: null,
    }),
  ])
  assert.deepEqual(r.routing.otherKinds.routing_reason, {
    deliberate: 0,
    unknown_enum: 1,
    indeterminate: 0,
  })
  // And every routing field is reported even at zero, so an absence is visible.
  for (const field of ['routing_decision', 'task_type', 'task_intent_source']) {
    assert.deepEqual(r.routing.otherKinds[field], { deliberate: 0, unknown_enum: 0, indeterminate: 0 })
  }
})

test('a null value is never counted as an `other`, because a null is not a choice', () => {
  // `bucket(null, known)` returns 'other' since null is in no list, but "the writer chose a
  // value we do not know" and "there was no value" are different facts with different fixes —
  // and the histogram already carries a separate null bucket for the second one.
  const r = run([dispatchedRow({ routing_reason: null, task_intent_source: null })])
  assert.deepEqual(r.routing.otherKinds.routing_reason, {
    deliberate: 0,
    unknown_enum: 0,
    indeterminate: 0,
  })
  assert.equal(r.routing.byReason.nulls, 1, 'it is counted as a null instead')
})

test('an unknown-enum code for one field says nothing about another field', () => {
  const r = run([
    dispatchedRow({
      routing_reason: 'quantum_tunnelling',
      validation_codes: 'unknown_enum:routing_reason',
      validation_warnings: 1,
      task_intent_source: 'telepathy',
    }),
  ])
  assert.equal(r.routing.otherKinds.routing_reason.unknown_enum, 1)
  // The code names routing_reason only, so the unflagged intent source is indeterminate rather
  // than borrowing the other field's evidence.
  assert.equal(r.routing.otherKinds.task_intent_source.indeterminate, 1)
  assert.equal(r.routing.otherKinds.task_intent_source.unknown_enum, 0)
})

test('a null routing reason keeps its own histogram bucket rather than being dropped', () => {
  // Dropping nulls would shrink the denominator, and the percentages would still add to 100%
  // while describing a population nobody chose.
  const r = run([dispatchedRow({ routing_reason: null }), dispatchedRow()])
  assert.equal(r.routing.byReason.nulls, 1)
  assert.equal(r.routing.byReason.total, 2)
})

/* ----------------------------------------------------------- the predicates */

test('a worker failure excludes a context refusal, which is not a provider fault', () => {
  const failure = errorRow()
  const refusal = dispatchedRow({ status: 'error', routing_reason: 'context_exceeded' })
  assert.equal(predicates.workerFailure(failure), true)
  assert.equal(predicates.workerFailure(refusal), false)
})

test('a governance denial is not a worker failure and not a gate refusal', () => {
  const row = denialRow()
  assert.equal(predicates.workerFailure(row), false)
  assert.equal(predicates.governanceDenied(row), true)
  assert.equal(classifyRow(row) === 'gateRefused', false)
})

test('the four conditions are reported separately and are never added up', () => {
  const r = run([
    errorRow(),
    denialRow(),
    dispatchedRow({ status: 'skipped', routing_reason: 'context_exceeded' }),
    dispatchedRow(),
  ])
  assert.equal(r.failures.workerFailures.value, 1)
  assert.equal(r.failures.governanceDenials.value, 1)
  assert.equal(r.failures.capabilityRefusals.total.value, 1)
  assert.equal(r.failures.unknownCost.value, 1)
  // There is deliberately no total: the only use for a sum of these four is to be quoted, and
  // every such use would be wrong.
  assert.equal('total' in r.failures, false)
  assert.match(r.failures.note, /never added/)
})
