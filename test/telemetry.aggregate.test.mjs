/**
 * Aggregation.
 *
 * The hard problem: summing a column where some rows are NULL. Treating NULL as zero presents
 * partial coverage as complete, and depending on the column that either understates the worker
 * bill or overstates savings. So a sum here is never a bare number — it carries its own coverage,
 * and `formatAgg` is the only sanctioned way it reaches a screen.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NULL_KEY,
  aggregate,
  aggregateGrouped,
  byDate,
  byModel,
  byProvider,
  byTaskType,
  byTaskTypeBucketed,
  byWriterLocalDate,
  eventsByDate,
  eventsByModel,
  eventsByProject,
  eventsByProvider,
  eventsByTaskType,
  extractors,
  formatAgg,
  groupBy,
  summarize,
} from '../plugins/model-router/lib/telemetry/aggregate.mjs'
import * as aggregateModule from '../plugins/model-router/lib/telemetry/aggregate.mjs'

/** A minimal stored row. Only the fields an extractor reads need to be present. */
const row = (o = {}) => ({
  schema_version: 1,
  timestamp: '2026-03-04T12:00:00.000Z',
  tz_offset_minutes: 0,
  calc_version: 1,
  pricing_version: 'test.1',
  provider: 'gemini',
  model: 'gemini-3.8-flash',
  project_id: 'p1',
  task_type: 'bulk_read',
  worker_input_tokens: 600,
  worker_cached_input_tokens: 400,
  worker_output_tokens: 120,
  worker_thought_tokens: 300,
  worker_total_tokens: 1420,
  worker_total_cost: 0.001,
  worker_total_cost_status: 'actual',
  estimated_tokens_avoided: 11_995,
  estimated_tokens_avoided_status: 'estimated',
  estimated_cost_avoided: 0.18,
  estimated_cost_avoided_status: 'estimated',
  estimated_net_savings: 0.179,
  estimated_net_savings_status: 'estimated',
  ...o,
})

/* ------------------------------------------------------------------ coverage */

test('a column with no nulls is complete and sums exactly', () => {
  const a = aggregate([row(), row(), row()], extractors.workerTotalCost)
  assert.equal(a.status, 'complete')
  assert.equal(a.coverage, 1)
  assert.equal(Math.round(a.value * 1e6), 3000)
  assert.equal(a.rowsCounted, 3)
  assert.equal(a.rowsUnavailable, 0)
})

test('a column with some nulls is partial, and the skipped rows travel with the number', () => {
  const rows = [
    row(),
    row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' }),
    row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' }),
  ]
  const a = aggregate(rows, extractors.workerTotalCost)
  assert.equal(a.status, 'partial')
  assert.equal(a.rowsCounted, 1)
  assert.equal(a.rowsUnavailable, 2)
  assert.equal(Math.round(a.value * 1e6), 1000, 'nulls are skipped, not zeroed')
})

test('a column where every row is null sums to null, not to zero', () => {
  const rows = [1, 2, 3].map(() => row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' }))
  const a = aggregate(rows, extractors.workerTotalCost)
  assert.equal(a.status, 'unavailable')
  assert.equal(a.value, null)
  // "Saved nothing" and "we do not know" must not render identically.
  assert.notEqual(a.value, 0)
})

test('an empty row set is empty, with a null value and zero coverage', () => {
  const a = aggregate([], extractors.workerTotalCost)
  assert.equal(a.status, 'empty')
  assert.equal(a.value, null)
  assert.equal(a.coverage, 0)
})

test('a row with an unreadable schema version is excluded and counted, never silently included', () => {
  const rows = [row(), row({ schema_version: 99 }), row({ schema_version: undefined })]
  const a = aggregate(rows, extractors.workerTotalCost)
  assert.equal(a.rowsIncompatible, 2)
  assert.equal(a.rowsCounted, 1)
  assert.equal(Math.round(a.value * 1e6), 1000)
})

/* --------------------------------------------------------------------- basis */

test('the basis reports whether the contributing rows were measured or estimated', () => {
  assert.equal(aggregate([row(), row()], extractors.workerTotalCost).basis, 'actual')
  assert.equal(aggregate([row(), row()], extractors.estimatedNetSavings).basis, 'estimated')
  const mixed = [row(), row({ worker_total_cost_status: 'estimated' })]
  assert.equal(aggregate(mixed, extractors.workerTotalCost).basis, 'mixed')
  assert.equal(aggregate([], extractors.workerTotalCost).basis, 'unavailable')
})

test('an unrecognised status still contributes but degrades the basis to mixed', () => {
  // Enums are open on read, so the row is not thrown away — but the basis must not claim to be
  // actual on the strength of a value nobody recognises.
  const a = aggregate([row({ worker_total_cost_status: 'from_the_future' })], extractors.workerTotalCost)
  assert.equal(a.rowsCounted, 1)
  assert.equal(a.rowsUnknownStatus, 1)
  assert.equal(a.basis, 'mixed')
})

/* --------------------------------------------------------------------- bound */

test('a same-signed partial sum is a genuine lower bound', () => {
  const rows = [row(), row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' })]
  assert.equal(aggregate(rows, extractors.workerTotalCost).bound, 'lower')
})

test('a signed column with a negative row bounds nothing', () => {
  // estimated_net_savings is signed by construction, so a partial sum must not read as a floor.
  const rows = [row(), row({ estimated_net_savings: -0.05 })]
  assert.equal(aggregate(rows, extractors.estimatedNetSavings).bound, 'none')
})

/* ----------------------------------------------------------------- extractors */

test('total worker tokens is strict: a row missing any component contributes nothing', () => {
  const rows = [row(), row({ worker_output_tokens: null })]
  const a = aggregate(rows, extractors.workerTokens)
  assert.equal(a.value, 1420, 'only the complete row contributed')
  assert.equal(a.rowsCounted, 1)
  assert.equal(a.rowsUnavailable, 1)
})

test('the provider-reported total is a second column and is never reconciled with the components', () => {
  const rows = [row({ worker_total_tokens: 9999 })]
  const components = aggregate(rows, extractors.workerTokens)
  const reported = aggregate(rows, extractors.workerTokensReported)
  assert.equal(components.value, 1420)
  assert.equal(reported.value, 9999)
})

test('the five required headline totals are produced over one row set', () => {
  const rows = [row(), row()]
  const s = summarize(rows)
  for (const k of ['workerTokens', 'estimatedTokensAvoided', 'estimatedCostAvoided', 'workerTotalCost', 'estimatedNetSavings']) {
    assert.equal(s[k].rowsTotal, 2, k)
    assert.notEqual(s[k].value, null, k)
  }
  assert.equal(s.estimatedTokensAvoided.value, 23_990)
})

test('addAgg does not exist — two aggregates can have different coverage', () => {
  // Combination happens at the row level, inside an extractor, with strict null propagation.
  // Adding two Agg values would compute over an undefined row set.
  assert.equal('addAgg' in aggregateModule, false)
  assert.equal(typeof aggregateModule.addAgg, 'undefined')
})

/* ------------------------------------------------------------------ versions */

test('mixed pricing versions are summed but never silently', () => {
  const rows = [row(), row({ pricing_version: 'test.2' })]
  const a = aggregate(rows, extractors.workerTotalCost)
  assert.deepEqual(a.pricingVersions, ['test.1', 'test.2'])
  assert.equal(a.homogeneous, false)
  assert.notEqual(a.value, null, 'each row was priced correctly when written, so the sum is real')
})

test('a single-version window reports as homogeneous', () => {
  const a = aggregate([row(), row()], extractors.workerTotalCost)
  assert.deepEqual(a.pricingVersions, ['test.1'])
  assert.deepEqual(a.calcVersions, [1])
  assert.equal(a.homogeneous, true)
})

/* ------------------------------------------------------------------ grouping */

test('grouping by date defaults to UTC', () => {
  assert.equal(byDate(row()), '2026-03-04')
  assert.equal(byDate(row({ timestamp: '2026-03-04T23:30:00.000Z' })), '2026-03-04')
})

test('an explicit timezone buckets the same instant into a different day', () => {
  // Two developers must not disagree about which day a delegation fell in unless they ask to.
  const r = row({ timestamp: '2026-03-04T23:30:00.000Z' })
  assert.equal(byDate(r, { timeZone: 'UTC' }), '2026-03-04')
  assert.equal(byDate(r, { timeZone: 'Australia/Brisbane' }), '2026-03-05')
})

test('the writer\'s local day is recoverable from the stamped offset', () => {
  const r = row({ timestamp: '2026-03-04T23:30:00.000Z', tz_offset_minutes: 600 })
  assert.equal(byWriterLocalDate(r), '2026-03-05')
  assert.equal(byWriterLocalDate(row({ tz_offset_minutes: null })), null)
})

test('a malformed timestamp groups as null rather than throwing', () => {
  assert.equal(byDate(row({ timestamp: 'not a date' })), null)
  assert.equal(byDate(row({ timestamp: null })), null)
})

test('a null group key gets its own bucket and is neither dropped nor merged', () => {
  const rows = [row(), row({ provider: null }), row({ provider: null })]
  const groups = groupBy(rows, byProvider)
  assert.equal(groups.get('gemini').length, 1)
  assert.equal(groups.get(NULL_KEY).length, 2)
  // Dropping them would shrink the denominator and overstate coverage.
  assert.equal([...groups.values()].reduce((n, g) => n + g.length, 0), 3)
})

test('an unknown task type keeps its own group and also rolls up as other', () => {
  const rows = [row(), row({ task_type: 'weird' })]
  assert.deepEqual([...groupBy(rows, byTaskType).keys()], ['bulk_read', 'weird'])
  const bucketed = groupBy(rows, (r) => byTaskTypeBucketed(r, ['bulk_read', 'code_write']))
  assert.deepEqual([...bucketed.keys()], ['bulk_read', 'other'])
})

test('grouped aggregation produces one coverage-bearing total per group', () => {
  const rows = [
    row({ provider: 'gemini' }),
    row({ provider: 'ollama', worker_total_cost: 0 }),
    row({ provider: 'ollama', worker_total_cost: null, worker_total_cost_status: 'unavailable' }),
  ]
  const byProv = aggregateGrouped(rows, byProvider, extractors.workerTotalCost)
  assert.equal(byProv.get('gemini').status, 'complete')
  assert.equal(byProv.get('ollama').status, 'partial')
  assert.equal(byProv.get('ollama').value, 0, 'a measured zero is a value, not a gap')
})

test('grouping by model and project works off the stored fields', () => {
  const rows = [row(), row({ model: 'gemini-3.1-pro-preview', project_id: 'p2' })]
  assert.deepEqual([...groupBy(rows, byModel).keys()], ['gemini-3.8-flash', 'gemini-3.1-pro-preview'])
  assert.equal(aggregateGrouped(rows, (r) => r.project_id, extractors.workerTokens).size, 2)
})

/* ----------------------------------------------------------------- selection */

test('the selection helpers filter by date, project, provider, model and task type', () => {
  const rows = [
    row(),
    row({ timestamp: '2026-04-01T00:00:00.000Z', provider: 'ollama', model: 'qwen', project_id: 'p2', task_type: 'code_write' }),
  ]
  assert.equal(eventsByDate(rows, { from: '2026-03-01', to: '2026-03-31' }).length, 1)
  assert.equal(eventsByProject(rows, 'p2').length, 1)
  assert.equal(eventsByProvider(rows, 'gemini').length, 1)
  assert.equal(eventsByModel(rows, 'qwen').length, 1)
  assert.equal(eventsByTaskType(rows, 'code_write').length, 1)
  assert.equal(eventsByDate(rows, {}).length, 2)
})

/* ---------------------------------------------------------------- formatting */

test('an unavailable aggregate never renders as a dollar amount', () => {
  const rows = [row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' })]
  const out = formatAgg(aggregate(rows, extractors.workerTotalCost))
  assert.match(out, /unavailable/)
  assert.equal(out.includes('$0.00'), false)
})

test('a partial aggregate renders its coverage in the string', () => {
  const rows = [row(), row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' })]
  const out = formatAgg(aggregate(rows, extractors.workerTotalCost))
  assert.match(out, /1 of 2 events/)
  assert.match(out, /at least/)
  assert.match(out, /1 unmeasured/)
})

test('a partial signed aggregate is not presented as a floor', () => {
  const rows = [row({ estimated_net_savings: -0.05 }), row({ estimated_net_savings: null, estimated_net_savings_status: 'unavailable' })]
  const out = formatAgg(aggregate(rows, extractors.estimatedNetSavings))
  assert.equal(out.includes('at least'), false)
})

test('a complete aggregate renders the plain number', () => {
  const out = formatAgg(aggregate([row()], extractors.workerTotalCost))
  assert.equal(out, '$0.0010')
})

test('a token aggregate renders in tokens, not dollars', () => {
  const out = formatAgg(aggregate([row()], extractors.estimatedTokensAvoided), { unit: 'tokens' })
  assert.equal(out, '11995 tokens')
})

test('an empty aggregate says so', () => {
  assert.equal(formatAgg(aggregate([], extractors.workerTotalCost)), 'no events')
})

/* ------------------------------------------------------- anti-inflation rule */

test('residency turns cannot inflate an aggregate, because nothing multiplies by them', () => {
  const plain = [row(), row()]
  const resident = [row({ residency_turns: 40 }), row({ residency_turns: 40 })]
  assert.equal(
    aggregate(resident, extractors.estimatedTokensAvoided).value,
    aggregate(plain, extractors.estimatedTokensAvoided).value,
  )
  assert.equal(
    aggregate(resident, extractors.estimatedNetSavings).value,
    aggregate(plain, extractors.estimatedNetSavings).value,
  )
})

/* ---------------------------------------------------------------- the fold */

/*
 * `aggregate()` is now defined in terms of aggInit/aggPush/aggFinalize so the analytics layer can
 * stream rows through the SAME coverage model instead of reimplementing it. These tests are what
 * make that refactor safe: a second implementation of the NULL-is-not-zero rule would drift
 * silently, because each copy would have its own tests passing.
 */

/** A seeded xorshift, so a failing case is reproducible from the printed seed. */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x1_0000_0000
  }
}

/** Rows chosen to hit every branch in aggPush: null, negative, zero, bad status, bad schema. */
function randomRows(r, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const roll = r()
    if (roll < 0.12) out.push(row({ schema_version: 99 }))
    else if (roll < 0.2) out.push(row({ schema_version: undefined }))
    else if (roll < 0.35) {
      out.push(row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' }))
    } else if (roll < 0.45) out.push(row({ worker_total_cost: -0.004 }))
    else if (roll < 0.55) out.push(row({ worker_total_cost: 0, worker_total_cost_status: 'actual' }))
    else if (roll < 0.62) out.push(row({ worker_total_cost_status: 'estimated' }))
    else if (roll < 0.68) out.push(row({ worker_total_cost_status: 'something_new' }))
    else if (roll < 0.74) out.push(row({ pricing_version: `test.${Math.floor(r() * 4)}` }))
    else if (roll < 0.8) out.push(row({ calc_version: 1 + Math.floor(r() * 3) }))
    else if (roll < 0.86) out.push(row({ worker_output_tokens: null }))
    else if (roll < 0.92) out.push(row({ estimated_net_savings: -(r() * 0.1) }))
    else out.push(row({ worker_total_cost: r() * 0.01 }))
  }
  return out
}

const EVERY_EXTRACTOR = Object.entries(extractors)

test('folding row by row is identical to aggregating the array', () => {
  // The streaming path and the batch path must agree on every field of the Agg, not just the
  // value: `coverage`, `basis`, `bound` and `homogeneous` are the honesty bits, and a drift in
  // any of them would publish a partial sum as a complete one.
  const violations = []
  for (let seed = 1; seed <= 500; seed++) {
    const rows = randomRows(rng(seed), 1 + (seed % 23))
    for (const [name, extract] of EVERY_EXTRACTOR) {
      const batch = aggregate(rows, extract)
      const state = aggregateModule.aggInit(name)
      for (const r of rows) aggregateModule.aggPush(state, r, extract)
      const folded = aggregateModule.aggFinalize(state)
      try {
        assert.deepEqual(folded, batch)
      } catch {
        violations.push(`seed ${seed}, ${name}: fold != aggregate`)
      }
    }
  }
  assert.deepEqual(violations, [], 'the streaming fold disagreed with aggregate()')
})

test('the fold and the array agree on the degenerate inputs too', () => {
  const cases = [
    [],
    [row()],
    [row({ schema_version: 99 })],
    [row({ worker_total_cost: null, worker_total_cost_status: 'unavailable' })],
  ]
  for (const rows of cases) {
    for (const [name, extract] of EVERY_EXTRACTOR) {
      const state = aggregateModule.aggInit(name)
      for (const r of rows) aggregateModule.aggPush(state, r, extract)
      assert.deepEqual(aggregateModule.aggFinalize(state), aggregate(rows, extract))
    }
  }
})

test('merging states over disjoint parts reproduces the whole, exactly on every count', () => {
  // This is what lets a segment dimension fold its long tail into an `other` bucket. It is legal
  // only because the buckets PARTITION the window: aggMerge unions two row sets that do not
  // overlap, and aggFinalize then recomputes coverage from the exact counts of the union. It is
  // not addAgg() — nothing here adds two finalized values whose coverage differs.
  //
  // EVERY FIELD EXCEPT `value` IS ASSERTED EXACTLY, because those are the honesty bits and they
  // are all integers, booleans or sets. `value` is checked separately below: MEASURED, a
  // partitioned sum of a USD column lands within one ULP of the single-pass sum
  // (0.012318034292198722 vs 0.01231803429219872), because IEEE-754 addition is not associative.
  // Asserting bit equality on a float sum here would be asserting that float addition reorders
  // losslessly, which is false — and the coverage model, which is what this merge exists to
  // preserve, is unaffected.
  const violations = []
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed)
    const rows = randomRows(r, 3 + (seed % 17))
    const k = 1 + Math.floor(r() * 4)
    const parts = Array.from({ length: k }, () => [])
    rows.forEach((row_, i) => parts[i % k].push(row_))

    for (const [name, extract] of EVERY_EXTRACTOR) {
      const folded = parts
        .map((part) => {
          const s = aggregateModule.aggInit(name)
          for (const row_ of part) aggregateModule.aggPush(s, row_, extract)
          return s
        })
        .reduce(aggregateModule.aggMerge)

      const merged = aggregateModule.aggFinalize(folded)
      const batch = aggregate(rows, extract)

      const { value: mergedValue, ...mergedRest } = merged
      const { value: batchValue, ...batchRest } = batch
      try {
        assert.deepEqual(mergedRest, batchRest)
      } catch {
        violations.push(`seed ${seed}, ${name}, ${k} parts: coverage differs`)
        continue
      }

      if (batchValue === null || mergedValue === null) {
        if (batchValue !== mergedValue) violations.push(`seed ${seed}, ${name}: one value is null`)
        continue
      }
      // A relative tolerance, floored so an exact zero compares cleanly. Four orders of
      // magnitude above one ULP and still twelve below a hundredth of a cent.
      const tolerance = Math.max(Math.abs(batchValue), 1) * 1e-12
      if (Math.abs(batchValue - mergedValue) > tolerance) {
        violations.push(`seed ${seed}, ${name}: ${mergedValue} is not ${batchValue}`)
      }
    }
  }
  assert.deepEqual(violations, [], 'a partitioned merge disagreed with the whole')
})

test('a partitioned merge is exact, not merely close, on an integer column', () => {
  // Token counts are integers, so there is no associativity excuse available for them: if a
  // token total ever drifted under a merge, the arithmetic would be wrong rather than rounded.
  const violations = []
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed)
    const rows = randomRows(r, 3 + (seed % 17))
    const k = 1 + Math.floor(r() * 4)
    const parts = Array.from({ length: k }, () => [])
    rows.forEach((row_, i) => parts[i % k].push(row_))

    for (const name of ['workerTokens', 'workerTokensReported', 'estimatedTokensAvoided']) {
      const extract = extractors[name]
      const folded = parts
        .map((part) => {
          const s = aggregateModule.aggInit(name)
          for (const row_ of part) aggregateModule.aggPush(s, row_, extract)
          return s
        })
        .reduce(aggregateModule.aggMerge)
      try {
        assert.deepEqual(aggregateModule.aggFinalize(folded), aggregate(rows, extract))
      } catch {
        violations.push(`seed ${seed}, ${name}, ${k} parts`)
      }
    }
  }
  assert.deepEqual(violations, [], 'an integer column drifted under a partitioned merge')
})

test('merging an empty state changes nothing, so an absent bucket is not a missing row', () => {
  const rows = randomRows(rng(7), 11)
  const build = () => {
    const s = aggregateModule.aggInit('workerTotalCost')
    for (const r of rows) aggregateModule.aggPush(s, r, extractors.workerTotalCost)
    return s
  }
  const identity = aggregateModule.aggMerge(build(), aggregateModule.aggInit('workerTotalCost'))
  assert.deepEqual(aggregateModule.aggFinalize(identity), aggregate(rows, extractors.workerTotalCost))
})

test('merging is commutative, so bucket iteration order cannot change a reported number', () => {
  // Map iteration order is insertion order, which depends on which row arrived first. If merge
  // were not commutative, the same store would report different figures on a re-read.
  const a = aggregateModule.aggInit('k')
  const b = aggregateModule.aggInit('k')
  for (const r of randomRows(rng(3), 9)) aggregateModule.aggPush(a, r, extractors.workerTotalCost)
  for (const r of randomRows(rng(4), 9)) aggregateModule.aggPush(b, r, extractors.workerTotalCost)
  assert.deepEqual(
    aggregateModule.aggFinalize(aggregateModule.aggMerge(a, b)),
    aggregateModule.aggFinalize(aggregateModule.aggMerge(b, a)),
  )
})

test('merging two different columns throws rather than summing unlike things', () => {
  // Disjointness is the caller's to guarantee and cannot be checked here. The column can be.
  const a = aggregateModule.aggInit('workerTotalCost')
  const b = aggregateModule.aggInit('estimatedNetSavings')
  assert.throws(() => aggregateModule.aggMerge(a, b), /workerTotalCost != estimatedNetSavings/)
})

test('a fresh state finalizes to the same empty Agg as an empty array', () => {
  assert.deepEqual(
    aggregateModule.aggFinalize(aggregateModule.aggInit()),
    aggregate([], extractors.workerTotalCost),
  )
})

test('aggPush returns the state it mutated, so a reduce over rows is expressible', () => {
  const rows = [row(), row()]
  const out = rows.reduce(
    (s, r) => aggregateModule.aggPush(s, r, extractors.workerTotalCost),
    aggregateModule.aggInit('workerTotalCost'),
  )
  assert.equal(aggregateModule.aggFinalize(out).rowsCounted, 2)
})
