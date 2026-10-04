/**
 * Cost and coverage.
 *
 * Out of the box this layer reports no money at all, and that is the correct behaviour rather
 * than a gap: every rate in the bundled pricing table ships `null`, so every money column on
 * every row is null until an operator configures `pricing.overrides`. The job of these tests is
 * to make sure that state is reported as a REFUSAL TO PRICE and never as a measured zero.
 *
 * THREE ZEROS ARE KEPT APART, and the whole section hinges on it:
 *
 *   - `0` with status `actual` — an operator configured a rate of literal zero, usually for a
 *     local model they do not pay for. A real measurement whose value is zero.
 *   - `null` with status `unavailable` — we cannot state the price. Not zero.
 *   - a sum of no rows — also null, and for a third reason again.
 *
 * NO PRICING HAPPENS HERE. Cost was computed once at write time and stamped with its
 * `pricing_version`; re-pricing a historical row against today's table would produce a figure for
 * a bill that was never incurred.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { NOW, dispatchedRow, errorRow, gateRow, pricedRow } from './helpers/analytics-rows.mjs'

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })

/* ------------------------------------------------------- the shipped state */

test('a default install reports cost as unavailable, with zero coverage', () => {
  const r = run([dispatchedRow(), dispatchedRow(), dispatchedRow()])
  assert.equal(r.cost.workerTotal.value, null)
  assert.equal(r.cost.workerTotal.status, 'unavailable')
  assert.equal(r.cost.coverage.knownEvents, 0)
  assert.equal(r.cost.coverage.totalEvents, 3)
  assert.equal(r.cost.coverage.ratio, 0)
  assert.equal(r.summary.headlineAvailable, 'tokens_only')
})

test('an unpriced window raises the pricing condition as INFO, not as an error', () => {
  // It is the expected state of a new install. Reporting it as a failure would train an operator
  // to ignore the data-quality section, which is where the genuinely alarming conditions live.
  const r = run([dispatchedRow()])
  const condition = r.dataQuality.conditions.find((c) => c.id === 'pricing_all_null')
  assert.ok(condition)
  assert.equal(condition.severity, 'info')
  assert.match(condition.detail, /refusal to price, not a missing measurement/)
})

test('a default install still reports tokens avoided, which is the figure that survives', () => {
  const r = run([dispatchedRow(), dispatchedRow()])
  assert.equal(r.summary.tokensAvoided.value, 16800)
  assert.equal(r.summary.tokensAvoided.status, 'complete')
})

/* ------------------------------------------------------------- known cost */

test('a priced window sums the stored cost and reports the basis as actual', () => {
  const r = run([pricedRow(), pricedRow()])
  assert.ok(Math.abs(r.cost.workerTotal.value - 0.0084) < 1e-12)
  assert.equal(r.cost.workerTotal.status, 'complete')
  assert.equal(r.cost.workerTotal.basis, 'actual')
  assert.equal(r.cost.coverage.ratio, 1)
  assert.equal(r.summary.headlineAvailable, 'tokens_and_cost')
})

test('the cost components are reported separately and are not re-derived from the total', () => {
  const r = run([pricedRow()])
  assert.equal(r.cost.workerInput.value, 0.0027)
  assert.equal(r.cost.workerCachedInput.value, 0)
  assert.equal(r.cost.workerOutput.value, 0.0015)
  assert.equal(r.cost.workerTotal.value, 0.0042)
})

/* ------------------------------------------------------ structurally zero */

test('a configured rate of zero is a known cost of zero, not an unknown', () => {
  // Preserved by `rate()` on the write side precisely so it survives as a real zero. An operator
  // running a local model has genuinely spent nothing, and that is worth being able to say.
  const r = run([
    pricedRow({
      provider: 'ollama',
      model: 'llama3.1:8b',
      worker_input_cost: 0,
      worker_cached_input_cost: 0,
      worker_output_cost: 0,
      worker_total_cost: 0,
      worker_total_cost_status: 'actual',
    }),
  ])
  assert.equal(r.cost.workerTotal.value, 0)
  assert.equal(r.cost.workerTotal.status, 'complete')
  assert.equal(r.cost.workerTotal.display, '$0.0000')
  assert.equal(r.cost.knownCostEvents.value, 1)
  assert.equal(r.cost.structurallyZeroEvents.value, 1)
  assert.equal(r.cost.unknownCostEvents.value, 0)
})

test('a zero cost and an unknown cost render differently, which is the point', () => {
  const zero = run([pricedRow({ worker_total_cost: 0, worker_total_cost_status: 'actual' })])
  const unknown = run([dispatchedRow()])
  assert.equal(zero.cost.workerTotal.display, '$0.0000')
  assert.equal(unknown.cost.workerTotal.display, 'unavailable (1 event, none measured)')
  assert.notEqual(zero.cost.workerTotal.display, unknown.cost.workerTotal.display)
})

/* --------------------------------------------------------- partial coverage */

test('partial coverage is reported as integers, a ratio and a lower bound together', () => {
  // The example from the phase brief: one priced call in five. The dashboard must make the 20%
  // obvious rather than printing a confident dollar figure.
  const rows = [pricedRow(), dispatchedRow(), dispatchedRow(), dispatchedRow(), dispatchedRow()]
  const r = run(rows)
  assert.deepEqual(r.cost.coverage, {
    knownEvents: 1,
    totalEvents: 5,
    ratio: 0.2,
    status: 'partial',
  })
  assert.equal(r.cost.workerTotal.bound, 'lower')
  assert.match(r.cost.workerTotal.display, /^at least \$0\.0042 over 1 of 5 events, 4 unmeasured$/)
})

test('a coverage ratio is never rounded into existence or out of it by the engine', () => {
  // 1 in 250 is 0.4%, and Math.round of that is 0 — which reads as "nothing measured" when
  // something was. The engine ships the integers so a renderer never has to round.
  const rows = [pricedRow(), ...Array.from({ length: 249 }, () => dispatchedRow())]
  const r = run(rows)
  assert.equal(r.cost.coverage.knownEvents, 1)
  assert.equal(r.cost.coverage.totalEvents, 250)
  assert.equal(r.cost.coverage.ratio, 1 / 250)
})

/* --------------------------------------------------- savings null propagation */

test('net savings is null whenever the worker bill is unknown, even with an avoided figure', () => {
  // The cash net refuses to compute rather than publishing the avoided figure under a net label.
  // With unpriced rates that is also the likely case, which is why the rule is absolute.
  const r = run([
    dispatchedRow({ estimated_cost_avoided: 0.02, estimated_cost_avoided_status: 'estimated' }),
  ])
  assert.equal(r.savings.costAvoided.value, 0.02)
  assert.equal(r.savings.netSavings.value, null, 'no net without a worker cost')
  assert.equal(r.savings.netSavings.status, 'unavailable')
})

test('a null operand never becomes a zero anywhere in the savings chain', () => {
  const r = run([dispatchedRow()])
  for (const key of ['estimatedInputTokens', 'returnedAnswerTokens', 'tokensAvoided']) {
    assert.notEqual(r.savings[key].value, 0, `${key} must not be zero-filled`)
  }
  assert.equal(r.savings.costAvoided.value, null)
  assert.equal(r.savings.netSavings.value, null)
})

test('the savings section names its population and says why', () => {
  const r = run([dispatchedRow(), gateRow(), gateRow()])
  assert.equal(r.savings.population, 'dispatchAttempted')
  assert.match(r.savings.populationNote, /null on every gate_block row by construction/)
  assert.equal(r.savings.tokensAvoided.rowsTotal, 1)
})

test('worker consumption is reported beside tokens avoided and never subtracted from it', () => {
  // Worker tokens are worker CONSUMPTION, not saved tokens. The two live side by side so nobody
  // has to infer which is which.
  const r = run([dispatchedRow()])
  assert.equal(r.savings.tokensAvoided.value, 8400)
  assert.equal(r.savings.workerTokensConsumed.value, 9600)
  assert.notEqual(r.savings.tokensAvoided.value, r.savings.workerTokensConsumed.value)
})

test('the savings caveat states plainly that this is not an invoice', () => {
  assert.match(run([]).savings.caveat, /not necessarily actual invoice savings/)
})

/* ------------------------------------------------------- the primary baseline */

test('the primary baseline is structurally unavailable and says so rather than being absent', () => {
  const r = run([pricedRow()])
  assert.equal(r.cost.primaryTotal.value, null)
  assert.equal(r.cost.primaryBaseline.metricKind, 'unavailable')
  assert.equal(r.cost.primaryBaseline.reason, 'not_instrumented')
  assert.match(r.cost.primaryBaseline.detail, /primary_usage_method is `none`/)
  assert.ok(r.dataQuality.conditions.some((c) => c.id === 'primary_usage_unavailable'))
})

/* ---------------------------------------------------- why the cost is null */

test('the null-cost explanation is derived, and labelled as derived', () => {
  // The calc layer returns a reason for every refusal to price and buildEvent() discards all of
  // them, so this is a reconstruction from the columns that ARE stored. Presenting it as the
  // stored reason would be a small lie that a future reader would build on.
  const r = run([
    dispatchedRow({ pricing_lookup: 'no_table' }),
    dispatchedRow({ pricing_lookup: 'model_unknown' }),
    pricedRow({ pricing_lookup: 'exact' }),
  ])
  const e = r.cost.nullExplanation
  assert.equal(e.derived, true)
  assert.deepEqual(e.derivedFrom, ['pricing_lookup', 'pricing_source', 'worker_usage_source'])
  assert.equal(e.noPricingTable, 1)
  assert.equal(e.modelNotInTable, 1)
  assert.equal(e.matchedExactly, 1)
  assert.match(e.note, /discards its reason codes/)
})

test('an unknown cost on a successful call is not counted as a failure', () => {
  const r = run([dispatchedRow()])
  assert.equal(r.cost.unknownCostEvents.value, 1)
  assert.equal(r.failures.workerFailures.value, 0)
  assert.equal(r.summary.successes.value, 1, 'the call succeeded; only its price is unknown')
})

test('a failed call is not counted as an unknown cost, because it is a different fact', () => {
  // `unknownCost` requires status ok. A timeout has no cost either, but filing it under
  // unknown-cost would hide a provider failure inside a pricing statistic.
  const r = run([errorRow()])
  assert.equal(r.cost.unknownCostEvents.value, 0)
  assert.equal(r.failures.workerFailures.value, 1)
})

/* ------------------------------------------------------------- no re-pricing */

test('the cost section states that it sums stored money and never re-prices', () => {
  assert.match(run([]).cost.note, /sums stored money and never re-prices/)
})

test('a mid-window pricing version change is surfaced on the aggregate', () => {
  const r = run([pricedRow({ pricing_version: '2026-01' }), pricedRow({ pricing_version: '2026-02' })])
  assert.deepEqual(r.cost.workerTotal.pricingVersions, ['2026-01', '2026-02'])
  assert.equal(r.cost.workerTotal.homogeneous, false, 'a rate change explains a discontinuity')
})

/* ------------------------------------------------------------ worker overhead */

test('worker overhead is money spent for nothing, and is never netted off savings', () => {
  // Subtracting it would be a new savings formula, and a partial overhead sum and a partial
  // savings sum cover different row sets, so their difference would describe no population.
  const r = run([
    pricedRow(),
    pricedRow({ status: 'error', error_code: 'timeout', routing_reason: 'provider_error' }),
  ])
  assert.equal(r.value.workerOverhead.events.value, 1)
  assert.equal(r.value.workerOverhead.population, 'noUsableAnswer')
  assert.match(r.value.workerOverhead.note, /never subtracted from it/)
  // The failed row carries a stored cost here, so the overhead is real and knowable.
  assert.equal(r.value.workerOverhead.cost.rowsTotal, 1)
})

test('a pre-flight context refusal is not worker overhead, because nothing was spent', () => {
  const r = run([
    gateRow({
      task_type: 'bulk_read',
      routing_reason: 'context_exceeded',
      worker_input_truncation_detected: null,
      status: 'skipped',
    }),
  ])
  // It IS in the noUsableAnswer population — it was dispatched and delivered nothing — but it
  // contributes no cost, so the overhead figure stays honest about what was actually paid.
  assert.equal(r.value.workerOverhead.cost.value, null)
  assert.equal(r.value.workerOverhead.cost.rowsCounted, 0)
})

test('a truncation discard IS worker overhead: the call ran and the answer was thrown away', () => {
  const r = run([
    pricedRow({
      routing_reason: 'context_exceeded',
      worker_input_truncation_detected: true,
      status: 'skipped',
      error_code: null,
    }),
  ])
  assert.equal(r.value.workerOverhead.events.value, 1)
  assert.equal(r.value.workerOverhead.cost.value, 0.0042, 'real money, no usable answer')
})
