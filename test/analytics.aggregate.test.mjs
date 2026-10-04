/**
 * Aggregation semantics: what a sum means when some of the rows are null.
 *
 * This is the file that pins the rule the whole project exists to preserve. A null is a
 * measurement that could not be taken; a zero is a measurement whose value was zero. Treating the
 * first as the second understates the worker bill and overstates savings — the one direction of
 * error that matters — and it does so while producing a number that looks completely plausible.
 *
 * Three preservations are asserted separately and all three are load-bearing: NULL stays null,
 * ZERO stays zero, and NEGATIVE stays negative. The reflex fix for each one is `?? 0`, and each
 * would be wrong in a different way.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { DEFAULT_LIMITS } from '../plugins/model-router/lib/analytics/schema.mjs'
import { findAggNodes } from '../plugins/model-router/lib/analytics/serialize.mjs'
import {
  NOW,
  denialRow,
  dispatchedRow,
  errorRow,
  gateRow,
  pricedRow,
} from './helpers/analytics-rows.mjs'

const run = (rows, opts = {}) => analyzeRows(rows, { now: NOW, window: { kind: 'all' }, ...opts })

/* ---------------------------------------------------------------- the empty */

test('no rows at all gives every aggregate a null value and the status `empty`', () => {
  const r = run([])
  const violations = []
  for (const { path, node } of findAggNodes(r)) {
    if (node.value !== null) violations.push(`${path}: ${node.value}`)
    if (node.status !== 'empty') violations.push(`${path}: status ${node.status}`)
  }
  assert.deepEqual(violations, [], 'an empty store produced a number')
})

test('an empty store reports zero events and no delegation rate at all', () => {
  const r = run([])
  assert.equal(r.summary.events.value, 0, 'a count over nothing is 0, and a count is exact')
  // A rate, unlike a count, is null: 0/0 is not 0%, and printing 0% would read as a finding
  // about the router rather than as an absence of data.
  assert.equal(r.summary.delegationRate.value, null)
  assert.equal(r.summary.delegationRate.denominator, 0)
  assert.equal(r.summary.delegationRate.display, 'no events')
})

/* ------------------------------------------------------------- one event */

test('one dispatched event gives a complete aggregate over a population of one', () => {
  const r = run([dispatchedRow()])
  const avoided = r.summary.tokensAvoided
  assert.equal(avoided.value, 8400)
  assert.equal(avoided.status, 'complete')
  assert.equal(avoided.coverage, 1)
  assert.equal(avoided.rowsTotal, 1)
  assert.equal(avoided.rowsCounted, 1)
  assert.equal(avoided.basis, 'estimated', 'a counterfactual is never actual')
  assert.equal(avoided.display, '8400 tokens')
})

test('one event is enough for a median, and every statistic equals the one sample', () => {
  const r = run([dispatchedRow({ latency_ms: 1234, provider_latency_ms: 1000 })])
  const s = r.latency.total
  assert.equal(s.n, 1)
  assert.equal(s.min, 1234)
  assert.equal(s.median, 1234)
  assert.equal(s.p95, 1234)
  assert.equal(s.max, 1234)
})

/* --------------------------------------------------------- null preservation */

test('a column that is null on every row is unavailable, never zero', () => {
  // Three unpriced delegations. The honest answer is "we do not know what this cost", and the
  // dishonest one is "$0.0000".
  const r = run([dispatchedRow(), dispatchedRow(), dispatchedRow()])
  const cost = r.summary.workerCost
  assert.equal(cost.value, null)
  assert.equal(cost.status, 'unavailable')
  assert.equal(cost.rowsTotal, 3)
  assert.equal(cost.rowsCounted, 0)
  assert.equal(cost.rowsUnavailable, 3)
  assert.equal(cost.display, 'unavailable (3 events, none measured)')
  assert.equal(cost.nullReason, 'all_rows_unavailable')
})

test('a column that is null on SOME rows is partial, and the gap travels with the number', () => {
  const r = run([pricedRow(), dispatchedRow()])
  const cost = r.summary.workerCost
  assert.equal(cost.rowsTotal, 2)
  assert.equal(cost.rowsCounted, 1)
  assert.equal(cost.rowsUnavailable, 1)
  assert.equal(cost.status, 'partial')
  assert.equal(cost.coverage, 0.5)
  // A partial sum of a non-negative column is a genuine floor, and it says so.
  assert.equal(cost.bound, 'lower')
  assert.match(cost.display, /^at least \$0\.0042 over 1 of 2 events/)
})

test('a missing usage component makes the whole token total contribute nothing', () => {
  // Strict summation: a row that reports input but not thinking tokens has an UNKNOWN total, and
  // adding the components it did report would publish a partial as a whole.
  const r = run([
    dispatchedRow(),
    dispatchedRow({ worker_thought_tokens: null, worker_billable_output_tokens: null }),
  ])
  const tokens = r.summary.workerTokens
  assert.equal(tokens.rowsTotal, 2)
  assert.equal(tokens.rowsCounted, 1, 'the incomplete row contributes nothing, not a partial')
  assert.equal(tokens.value, 9600)
})

test('nulls are never aggregated as zeros anywhere in a response', () => {
  // The general form of the rule, over every aggregate at once: a counted row set of zero must
  // always produce a null value, never a 0.
  const rows = [gateRow(), dispatchedRow(), errorRow(), denialRow()]
  const violations = []
  for (const { path, node } of findAggNodes(run(rows))) {
    if (node.rowsCounted === 0 && node.value !== null) violations.push(`${path}: ${node.value}`)
  }
  assert.deepEqual(violations, [], 'an uncounted aggregate produced a value')
})

/* --------------------------------------------------------- zero preservation */

test('a measured zero is kept as zero and reported as complete', () => {
  // An operator-configured rate of literal 0 — a local model they do not bill for. This is a
  // real measurement whose value is zero, and clamping it to null would be as wrong as the
  // reverse.
  const r = run([
    pricedRow({
      worker_input_cost: 0,
      worker_cached_input_cost: 0,
      worker_output_cost: 0,
      worker_total_cost: 0,
      worker_total_cost_status: 'actual',
    }),
  ])
  const cost = r.summary.workerCost
  assert.equal(cost.value, 0)
  assert.equal(cost.status, 'complete')
  assert.equal(cost.rowsCounted, 1)
  assert.equal(cost.display, '$0.0000')
  assert.equal(cost.nullReason, null)
})

test('a structurally zero cost and an unknown cost are counted separately', () => {
  const r = run([
    pricedRow({ worker_total_cost: 0, worker_total_cost_status: 'actual' }),
    dispatchedRow(),
  ])
  assert.equal(r.cost.structurallyZeroEvents.value, 1)
  assert.equal(r.cost.unknownCostEvents.value, 1)
  assert.equal(r.cost.knownCostEvents.value, 1, 'a zero IS a known cost')
})

test('a zero token count is a measurement, so it counts toward coverage', () => {
  const r = run([dispatchedRow({ estimated_tokens_avoided: 0 })])
  const avoided = r.summary.tokensAvoided
  assert.equal(avoided.value, 0)
  assert.equal(avoided.rowsCounted, 1)
  assert.equal(avoided.status, 'complete')
})

/* ----------------------------------------------------- negative preservation */

test('a negative sum keeps its sign and is never clamped', () => {
  const r = run([
    pricedRow({ estimated_net_savings: -0.02, estimated_net_savings_status: 'estimated' }),
  ])
  assert.equal(r.summary.netSavings.value, -0.02)
  assert.equal(r.negativeSavings.dollars.events.value, 1)
})

test('a partial sum containing a negative claims no lower bound', () => {
  // For a same-signed column a partial sum really is "at least $X". For net savings, signed by
  // construction, a partial sum bounds nothing — and without this flag a partial net figure
  // would read as a floor when it is not.
  const r = run([
    pricedRow({ estimated_net_savings: 0.05 }),
    pricedRow({ estimated_net_savings: -0.09 }),
    dispatchedRow(),
  ])
  const net = r.summary.netSavings
  assert.equal(net.bound, 'none')
  assert.equal(net.status, 'partial')
  assert.equal(net.display.startsWith('at least'), false)
  assert.ok(Math.abs(net.value - -0.04) < 1e-12)
})

test('negative tokens and negative dollars are counted over different populations', () => {
  // THE CASE THAT PROVES THEY DIFFER: positive tokens avoided with a negative cash net, because
  // the worker is priced above the primary's input rate. Reporting one count would hide it.
  const r = run([
    pricedRow({ estimated_tokens_avoided: -500, estimated_net_savings: -0.01 }),
    pricedRow({ estimated_tokens_avoided: 500, estimated_net_savings: -0.03 }),
    pricedRow(),
  ])
  assert.equal(r.negativeSavings.tokens.events.value, 1)
  assert.equal(r.negativeSavings.dollars.events.value, 2)
  assert.notEqual(
    r.negativeSavings.tokens.events.value,
    r.negativeSavings.dollars.events.value,
    'if these were ever equal by construction, one of them would be redundant',
  )
})

test('the negative totals sum only the negative rows, so the magnitude is not diluted', () => {
  const r = run([
    pricedRow({ estimated_net_savings: -0.01 }),
    pricedRow({ estimated_net_savings: -0.03 }),
    pricedRow({ estimated_net_savings: 5 }),
  ])
  const total = r.negativeSavings.dollars.total
  assert.ok(Math.abs(total.value - -0.04) < 1e-12, 'the +5 row must not be netted in here')
  assert.equal(total.rowsTotal, 2, 'the population is the negative rows alone')
  assert.equal(total.population, 'negativeDollarRows')
})

test('the worst negative cases survive the example cap, not the earliest ones', () => {
  // The first N in file order are an accident of which segment was read first; the worst N are
  // the ones worth investigating.
  const rows = []
  // From 1, not 0: `-0 / 1000` is negative zero, and `-0 < 0` is false, so that row is
  // legitimately not a negative saving. See the dedicated test below.
  for (let i = 1; i <= DEFAULT_LIMITS.maxNegativeExamples + 20; i++) {
    rows.push(pricedRow({ estimated_net_savings: -i / 1000 }))
  }
  const r = run(rows)
  const items = r.negativeSavings.examples.items
  assert.equal(items.length, DEFAULT_LIMITS.maxNegativeExamples)
  assert.equal(r.negativeSavings.examples.truncated, true)
  assert.equal(r.negativeSavings.examples.seen, rows.length)
  // Worst first, and the very worst present.
  assert.ok(items[0].estimated_net_savings <= items[1].estimated_net_savings)
  assert.ok(Math.abs(items[0].estimated_net_savings - -rows.length / 1000) < 1e-12)
})

test('negative zero is not a negative saving, and is counted as a measured zero', () => {
  // MEASURED while writing the cap test above: a row built with `-0 / 1000` was not counted as
  // negative, which is correct — `-0 < 0` is false — but it is the kind of edge that looks like
  // an off-by-one in the counter. Pinned so the next reader does not "fix" it.
  const r = run([pricedRow({ estimated_net_savings: -0 })])
  assert.equal(r.negativeSavings.dollars.events.value, 0)
  assert.equal(r.summary.netSavings.value, 0)
  assert.equal(r.summary.netSavings.rowsCounted, 1, 'it is still a measurement')
  assert.equal(r.summary.netSavings.bound, 'lower', 'and it establishes no negative direction')
})

/* ------------------------------------------------- populations, not windows */

test('a savings aggregate is scoped to dispatched rows, not to the whole window', () => {
  // `estimated_input_tokens` is null on every gate row BY CONSTRUCTION — the corpus is only
  // measured once content has been read. Aggregating savings over the whole window would report
  // `partial` forever and send an operator looking for a problem that was never there.
  const r = run([dispatchedRow(), gateRow(), gateRow(), gateRow()])
  const avoided = r.summary.tokensAvoided
  assert.equal(avoided.population, 'dispatchAttempted')
  assert.equal(avoided.rowsTotal, 1, 'the three gate rows are not in this population')
  assert.equal(avoided.status, 'complete', 'and so the measurement is complete, not 25% covered')
})

test('a count over the whole window and an aggregate over a population reconcile by name', () => {
  const r = run([dispatchedRow(), gateRow(), gateRow()])
  assert.equal(r.summary.events.value, 3, 'the window holds three routing events')
  assert.equal(r.summary.tokensAvoided.rowsTotal, 1, 'one of which could carry a savings figure')
  assert.equal(r.coverage.rowsCountable, 3)
  assert.match(r.coverage.reconciliation, /named population/)
})

/* ---------------------------------------------------- incompatible schemas */

test('a row from a future schema contributes to nothing and is counted as unreadable', () => {
  const r = run([dispatchedRow(), dispatchedRow({ schema_version: 2 })])
  assert.equal(r.coverage.rowsInWindow, 2)
  assert.equal(r.coverage.rowsIncompatible, 1)
  assert.equal(r.coverage.rowsCountable, 1)
  assert.equal(r.summary.events.value, 1, 'an unreadable row is not a routing event')
  assert.equal(r.summary.tokensAvoided.rowsTotal, 1)
  assert.equal(r.summary.tokensAvoided.value, 8400, 'and its tokens are not added')
})

test('a window of only unreadable rows reports zero events rather than throwing', () => {
  const r = run([dispatchedRow({ schema_version: 99 }), dispatchedRow({ schema_version: 99 })])
  assert.equal(r.summary.events.value, 0)
  assert.equal(r.coverage.rowsIncompatible, 2)
  assert.equal(r.summary.tokensAvoided.value, null)
  assert.equal(r.dataQuality.conditions.some((c) => c.id === 'schema_versions_unreadable'), true)
})

/* --------------------------------------------------------- mixed basis */

test('mixing actual and estimated rows degrades the basis to mixed rather than picking one', () => {
  const r = run([
    pricedRow({ worker_total_cost_status: 'actual' }),
    pricedRow({ worker_total_cost_status: 'estimated' }),
  ])
  assert.equal(r.summary.workerCost.basis, 'mixed')
  assert.equal(r.summary.workerCost.rowsActual, 1)
  assert.equal(r.summary.workerCost.rowsEstimated, 1)
})

test('an unrecognised status still contributes but forces the basis to mixed', () => {
  // Enums are open on read, so an unknown status must not drop the row. But the aggregate must
  // not then claim to be actual or estimated either.
  const r = run([pricedRow({ worker_total_cost_status: 'something_new' })])
  const cost = r.summary.workerCost
  assert.equal(cost.rowsCounted, 1, 'the row is not discarded')
  assert.equal(cost.rowsUnknownStatus, 1)
  assert.equal(cost.basis, 'mixed')
})

test('a mid-window pricing change is reported rather than smoothed over', () => {
  // Each row was priced correctly against the table in force when it was written, so the sum is
  // real. But a rate change explains a discontinuity that otherwise looks like a behaviour
  // change, so it is never silent.
  const r = run([pricedRow({ pricing_version: 'a' }), pricedRow({ pricing_version: 'b' })])
  assert.deepEqual(r.summary.workerCost.pricingVersions, ['a', 'b'])
  assert.equal(r.summary.workerCost.homogeneous, false)
})

/* ---------------------------------------------------------------- coverage */

test('cost coverage is reported as integers as well as a ratio', () => {
  // A ratio alone invites rounding: 1 row in 250 is 0.4%, and Math.round of that is 0, which
  // reads as "nothing was measured" when something was.
  const r = run([pricedRow(), dispatchedRow(), dispatchedRow(), dispatchedRow()])
  assert.deepEqual(r.summary.costCoverage, {
    knownEvents: 1,
    totalEvents: 4,
    ratio: 0.25,
    status: 'partial',
  })
})

test('coverage over an empty population is null, not zero percent', () => {
  const r = run([gateRow()])
  assert.equal(r.summary.costCoverage.totalEvents, 0)
  assert.equal(r.summary.costCoverage.ratio, null)
})

test('the headline availability says plainly what the window can support', () => {
  assert.equal(run([dispatchedRow()]).summary.headlineAvailable, 'tokens_only')
  assert.equal(run([pricedRow()]).summary.headlineAvailable, 'tokens_and_cost')
})

/* ------------------------------------------------------------- determinism */

test('row order does not change any count, coverage or status', () => {
  // Float sums can differ in their last bit under reordering, which is a property of IEEE-754
  // addition rather than of the coverage model. Every integer field must be invariant.
  const rows = [pricedRow(), dispatchedRow(), gateRow(), errorRow(), denialRow()]
  const a = run(rows)
  const b = run([...rows].reverse())
  const violations = []
  const nodesA = findAggNodes(a)
  const nodesB = new Map(findAggNodes(b).map(({ path, node }) => [path, node]))
  for (const { path, node } of nodesA) {
    const other = nodesB.get(path)
    for (const key of ['rowsTotal', 'rowsCounted', 'rowsUnavailable', 'coverage', 'status', 'basis', 'bound']) {
      if (node[key] !== other[key]) violations.push(`${path}.${key}: ${node[key]} != ${other[key]}`)
    }
  }
  assert.deepEqual(violations, [], 'a coverage figure depended on row order')
})
