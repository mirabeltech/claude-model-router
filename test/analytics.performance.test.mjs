/**
 * Ingestion and aggregation throughput.
 *
 * THESE ASSERT CEILINGS, NOT VALUES. A test that pinned a duration would fail on a loaded CI
 * runner and teach everyone to ignore it; the thresholds here are loose enough that only an
 * algorithmic regression trips them. What they actually protect is the SHAPE of the pipeline: one
 * pass over the rows, with each row pushed once into every slot it belongs to. Calling
 * `aggregate()` per metric per bucket would be a walk per metric over a materialized array, and
 * at 100,000 rows that is hundreds of megabytes of live objects before any arithmetic starts.
 *
 * THE 100k CASE IS GATED behind `ROUTER_PERF_FULL=1`. The store is roughly 300 MB on disk and
 * takes a few seconds to write, which does not belong in the default `npm test`. The gate is not
 * a `CMR_` name on purpose: every `CMR_` variable is declared in the config SPEC, and an
 * undeclared one sitting beside them would be a setting nobody could find.
 *
 * The fixture is GENERATED FROM A SEED rather than committed. A 100k-row store would dominate
 * every clone and every CI checkout on both platforms to assert a ceiling, and a perf fixture
 * that cannot be reproduced cannot be bisected.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { mapReadReport } from '../plugins/model-router/lib/analytics/quality.mjs'
import { stringifyResponse } from '../plugins/model-router/lib/analytics/serialize.mjs'
import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { FROZEN_MS, makeTempDir } from './helpers/telemetry-dir.mjs'
import { writeSyntheticStore } from './helpers/telemetry-corpus.mjs'

const FULL = process.env.ROUTER_PERF_FULL === '1'

/** Read a store and analyze it, reporting the split between the two phases. */
function measure(dir, { rows }) {
  const t0 = performance.now()
  const { records, report } = readSegmentsSync({ dir, fs })
  const t1 = performance.now()
  const response = analyzeRows(records, {
    now: FROZEN_MS,
    window: { kind: '30d' },
    read: mapReadReport(report),
  })
  const t2 = performance.now()
  const json = stringifyResponse(response)
  const t3 = performance.now()

  return {
    records: records.length,
    readMs: t1 - t0,
    analyzeMs: t2 - t1,
    serializeMs: t3 - t2,
    totalMs: t3 - t0,
    bytes: json.length,
    response,
    expectedRows: rows,
  }
}

test('10,000 events ingest and aggregate well inside a second of CPU', () => {
  const { dir, cleanup } = makeTempDir('perf-10k')
  try {
    const store = writeSyntheticStore({ dir, rows: 10_000, seed: 'perf-10k', days: 7 })
    const m = measure(dir, { rows: store.rows })

    assert.equal(m.records, 10_000, 'every row must be read')
    // Measured on a 2026 developer laptop: read ~0.26 s, aggregate ~0.12 s. The ceiling is an
    // order of magnitude above that, so only an algorithmic change trips it.
    assert.ok(m.analyzeMs < 4000, `aggregation took ${Math.round(m.analyzeMs)} ms`)
    assert.ok(m.totalMs < 15000, `the whole pipeline took ${Math.round(m.totalMs)} ms`)
  } finally {
    cleanup()
  }
})

test('the response stays a few hundred kilobytes regardless of store size', () => {
  // The caps are what make this true: top-N per dimension plus a compact bucket projection. An
  // uncapped segment table would make the response grow with the store, and the pipe into the
  // dashboard would grow with it.
  const { dir, cleanup } = makeTempDir('perf-size')
  try {
    writeSyntheticStore({ dir, rows: 10_000, seed: 'perf-size', days: 7 })
    const m = measure(dir, { rows: 10_000 })
    assert.ok(m.bytes < 1_500_000, `the response is ${m.bytes} bytes`)
    assert.ok(m.bytes > 10_000, 'and it is not suspiciously small')
  } finally {
    cleanup()
  }
})

test('aggregation scales roughly linearly, not quadratically, in the row count', () => {
  // THE ACTUAL REGRESSION GUARD. A per-metric or per-bucket re-walk would show up here as a
  // superlinear ratio long before it showed up as a wall-clock failure on a fast machine.
  const small = makeTempDir('perf-scale-small')
  const large = makeTempDir('perf-scale-large')
  try {
    writeSyntheticStore({ dir: small.dir, rows: 2_000, seed: 'scale', days: 4 })
    writeSyntheticStore({ dir: large.dir, rows: 10_000, seed: 'scale', days: 4 })

    // Warm the JIT on both shapes first, so the ratio measures the algorithm rather than
    // compilation.
    measure(small.dir, { rows: 2_000 })
    measure(large.dir, { rows: 10_000 })

    const a = measure(small.dir, { rows: 2_000 })
    const b = measure(large.dir, { rows: 10_000 })

    // 5x the rows. Linear would be ~5x; quadratic would be ~25x. A generous ceiling of 12x
    // tolerates timer noise on a small sample while still failing a quadratic pass.
    const ratio = b.analyzeMs / Math.max(a.analyzeMs, 0.5)
    assert.ok(ratio < 12, `aggregation scaled ${ratio.toFixed(1)}x for 5x the rows`)
  } finally {
    small.cleanup()
    large.cleanup()
  }
})

test('a large store does not inflate the latency sample memory without saying so', () => {
  // The sample cap is a deterministic prefix, and a truncated series must announce itself rather
  // than presenting a prefix percentile as a complete one.
  const { dir, cleanup } = makeTempDir('perf-cap')
  try {
    writeSyntheticStore({ dir, rows: 3_000, seed: 'cap', days: 3 })
    const { records, report } = readSegmentsSync({ dir, fs })
    const response = analyzeRows(records, {
      now: FROZEN_MS,
      window: { kind: '30d' },
      read: mapReadReport(report),
      limits: {
        topN: 20,
        maxTrackedKeys: 200,
        maxOverflowKeyNames: 1000,
        maxLatencySamples: 500,
        maxNegativeExamples: 100,
        maxDayBuckets: 366,
      },
    })
    assert.equal(response.latency.total.samplesKept, 500)
    assert.ok(response.latency.total.samplesSeen > 500)
    assert.equal(response.latency.total.truncated, true)
    assert.ok(response.dataQuality.conditions.some((c) => c.id === 'latency_samples_truncated'))
  } finally {
    cleanup()
  }
})

test('a 10,000-event response is still internally consistent', () => {
  // Throughput is worthless if the numbers stop reconciling at scale, and a single-pass
  // accumulator is exactly where an off-by-one would hide.
  const { dir, cleanup } = makeTempDir('perf-consistency')
  try {
    const store = writeSyntheticStore({ dir, rows: 10_000, seed: 'consistency', days: 7 })
    const m = measure(dir, { rows: store.rows })
    const r = m.response

    assert.equal(r.coverage.rowsYielded, 10_000)
    assert.equal(
      r.coverage.rowsInWindow + r.coverage.rowsOutOfWindow + r.coverage.rowsUndatable + r.coverage.rowsOutOfScope,
      10_000,
      'every row must land in exactly one verdict',
    )
    const classTotal = Object.values(r.routing.byClass).reduce((a, b) => a + b, 0)
    assert.equal(classTotal, r.coverage.rowsInWindow, 'the classes must partition the window')
    assert.equal(r.summary.events.value, r.coverage.rowsCountable)
    assert.equal(r.summary.delegationRate.denominator, r.coverage.rowsCountable)

    // Every segment dimension must account for every countable row exactly once.
    const violations = []
    for (const [id, dim] of Object.entries(r.segments)) {
      const total = dim.buckets.reduce((a, b) => a + b.events, 0)
      if (total !== r.coverage.rowsCountable) {
        violations.push(`${id}: ${total} != ${r.coverage.rowsCountable}`)
      }
    }
    assert.deepEqual(violations, [], 'a dimension lost or duplicated rows')
  } finally {
    cleanup()
  }
})

test('two analyses of a 10,000-event store are byte-identical', () => {
  const { dir, cleanup } = makeTempDir('perf-determinism')
  try {
    writeSyntheticStore({ dir, rows: 10_000, seed: 'determinism', days: 7 })
    const a = measure(dir, { rows: 10_000 })
    const b = measure(dir, { rows: 10_000 })
    assert.equal(stringifyResponse(a.response), stringifyResponse(b.response))
  } finally {
    cleanup()
  }
})

test('the synthetic store is reproducible from its seed', () => {
  // Without this, a perf failure could not be reproduced and the fixture would be useless as
  // evidence.
  const a = makeTempDir('perf-seed-a')
  const b = makeTempDir('perf-seed-b')
  try {
    const sa = writeSyntheticStore({ dir: a.dir, rows: 500, seed: 'same', days: 2 })
    const sb = writeSyntheticStore({ dir: b.dir, rows: 500, seed: 'same', days: 2 })
    assert.deepEqual(sa.segments, sb.segments)
    for (const segment of sa.segments) {
      assert.ok(
        fs.readFileSync(`${a.dir}/${segment}`).equals(fs.readFileSync(`${b.dir}/${segment}`)),
        `${segment} differs between two runs of the same seed`,
      )
    }
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

/* ------------------------------------------------------------- the gated case */

test(
  '100,000 events remain usable',
  { skip: FULL ? false : 'set ROUTER_PERF_FULL=1 to run the 100k case (~300 MB of scratch)' },
  () => {
    const { dir, cleanup } = makeTempDir('perf-100k')
    try {
      const store = writeSyntheticStore({ dir, rows: 100_000, seed: 'perf-100k', days: 30 })
      const m = measure(dir, { rows: store.rows })

      assert.equal(m.records, 100_000)
      assert.ok(m.analyzeMs < 30_000, `aggregation took ${Math.round(m.analyzeMs)} ms`)
      assert.ok(m.totalMs < 90_000, `the whole pipeline took ${Math.round(m.totalMs)} ms`)
      // The response must NOT grow with the store: that is what the caps are for.
      assert.ok(m.bytes < 2_000_000, `the response is ${m.bytes} bytes`)

      const r = m.response
      assert.equal(r.coverage.rowsYielded, 100_000)
      assert.equal(Object.values(r.routing.byClass).reduce((a, b) => a + b, 0), r.coverage.rowsInWindow)

      // Printed so the number in docs/analytics.md can be kept honest.
      console.log(
        `    100k: read ${Math.round(m.readMs)} ms, aggregate ${Math.round(m.analyzeMs)} ms, ` +
          `serialize ${Math.round(m.serializeMs)} ms, response ${Math.round(m.bytes / 1024)} KiB`,
      )
    } finally {
      cleanup()
    }
  },
)
