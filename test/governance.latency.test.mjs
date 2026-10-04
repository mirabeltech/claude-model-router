/**
 * THE GOVERNANCE PERFORMANCE TABLE, WITH CODE BEHIND IT.
 *
 * `docs/governance.md` §11 publishes five measured numbers, headlined by `checkBudget` at
 * **0.0008 ms median** on a default install, and says they were taken "with
 * `process.hrtime.bigint()`, 2000 iterations after warmup". Until this file, that was the only
 * measured claim in the repository with no committed harness: every other quoted number traces to
 * `hook.latency.test.mjs`, `analytics.performance.test.mjs` or the eval runner's `timings.json`.
 * Grepping for `warmup` or `iterations` found the prose line and nothing else.
 *
 * A published number nobody can reproduce is not evidence, and the headline one is load-bearing:
 * the whole argument for shipping governance enabled-but-unconfigured is that an install which is
 * not using it pays almost nothing. That claim deserves a harness.
 *
 * WHAT IS ASSERTED AND WHAT IS ONLY REPORTED. The numbers are machine-dependent, so the assertions
 * are generous ceilings chosen to catch an ORDER-OF-MAGNITUDE regression — the short-circuit being
 * removed, a `readFileSync` creeping onto the default path — and nothing tighter. The measured
 * values go to `t.diagnostic()` so a run records them without a budget that fails on a noisy
 * runner. `test/helpers/timing.mjs` says it plainly: a flaky performance test gets deleted rather
 * than fixed.
 *
 * THE STRUCTURAL ASSERTION IS THE REAL ONE. A timing can be slow for a dozen irrelevant reasons,
 * so the claim that matters — the default path performs NO FILESYSTEM I/O AT ALL — is asserted by
 * counting syscalls against an fs whose every method throws, not by watching a clock.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkBudget,
  evaluateBudget,
  finalizeBudget,
  hasConfiguredLimit,
} from '../plugins/model-router/lib/governance/index.mjs'
import { makeTempDir } from './helpers/telemetry-dir.mjs'
import { series } from './helpers/timing.mjs'

/** The doc says 2000 iterations after warmup. Matched, so the numbers are comparable. */
const ITERATIONS = 2000
const WARMUP = 200
const NOW = 1767225600000

const unconfigured = (stateDir) => ({
  budget: {
    enabled: true,
    run: { maxWorkerCostUsd: null, maxInputTokens: null, maxOutputTokens: null, maxTotalTokens: null },
    daily: { maxWorkerCostUsd: null, maxTotalTokens: null },
    monthly: { maxWorkerCostUsd: null, maxTotalTokens: null },
    onExceed: 'disable',
    onUnknownCost: 'allow',
    onUnknownUsage: 'allow',
    stateDir,
    stateDirResolved: stateDir,
  },
})

const withDailyLimit = (stateDir) => {
  const c = unconfigured(stateDir)
  c.budget.daily.maxTotalTokens = 1_000_000
  return c
}

const request = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUsd: null }

/** Run a warmup, then a measured series. Synchronous work, wrapped for the shared helper. */
async function measure(fn) {
  for (let i = 0; i < WARMUP; i += 1) fn()
  return series(ITERATIONS, async () => {
    fn()
  })
}

const report = (t, label, s) =>
  t.diagnostic(
    `${label}: median ${s.median.toFixed(4)} ms, p95 ${s.p95.toFixed(4)} ms (n=${s.n}, after ${WARMUP} warmup)`,
  )

/* ----------------------------------------------- the pure predicates and the decision */

test('hasConfiguredLimit on the shipped all-null state', async (t) => {
  const limits = unconfigured('C:/never').budget
  const s = await measure(() => hasConfiguredLimit(limits))
  report(t, 'hasConfiguredLimit (all null)', s)
  // Published as 0.0005 ms median. A 1 ms ceiling is three orders of magnitude of headroom: it
  // catches this becoming a filesystem call, and nothing else.
  assert.ok(s.median < 1, `${s.median.toFixed(4)} ms is three orders slower than published`)
})

test('evaluateBudget with nothing configured, and with a daily token limit', async (t) => {
  const state = { periods: {}, reservations: [] }
  const nothing = await measure(() =>
    evaluateBudget({
      limits: unconfigured('C:/never').budget,
      state,
      request,
      policy: { enabled: true, billing: 'local_free' },
    }),
  )
  report(t, 'evaluateBudget (nothing configured)', nothing)
  assert.ok(nothing.median < 1, `${nothing.median.toFixed(4)} ms`)

  const configured = await measure(() =>
    evaluateBudget({
      limits: withDailyLimit('C:/never').budget,
      state,
      request,
      policy: { enabled: true, billing: 'local_free' },
    }),
  )
  report(t, 'evaluateBudget (a daily token limit)', configured)
  assert.ok(configured.median < 1, `${configured.median.toFixed(4)} ms`)
})

/* ------------------------------------------- the headline: the default-install short circuit */

test('checkBudget on a default install short-circuits, and is under a microsecond', async (t) => {
  // THE PUBLISHED HEADLINE: 0.0008 ms median, 0.0019 ms p95.
  //
  // The fs here throws on every method, so if the short-circuit ever stopped working this test
  // would fail LOUDLY rather than merely slowly — which is the better failure, and the reason the
  // timing assertion can afford to be generous.
  const explode = () => {
    throw new Error('the default path must not touch the filesystem')
  }
  const hostileFs = new Proxy({}, { get: () => explode })
  const config = unconfigured('C:/never')

  const s = await measure(() =>
    checkBudget(config, { id: 'perf', request, billing: 'local_free', fs: hostileFs, now: NOW }),
  )
  report(t, 'checkBudget (default install, short-circuit)', s)
  assert.ok(s.median < 1, `${s.median.toFixed(4)} ms median: the short-circuit has regressed`)
  assert.ok(s.p95 < 5, `${s.p95.toFixed(4)} ms p95`)
})

test('the default path performs NO filesystem call at all, counted rather than timed', () => {
  // The structural form of the claim above, and the one that actually guards it. A timing can
  // regress for a dozen reasons that have nothing to do with this; a syscall count cannot.
  const touched = []
  const countingFs = new Proxy(
    {},
    {
      get: (_t, prop) => (...args) => {
        touched.push(String(prop))
        throw new Error(`fs.${String(prop)}(${args.length} args) must not be called`)
      },
    },
  )
  const g = checkBudget(unconfigured('C:/never'), {
    id: 'perf',
    request,
    billing: 'local_free',
    fs: countingFs,
    now: NOW,
  })
  assert.equal(g.decision, 'allow')
  assert.equal(g.reason, 'budget_not_configured')
  assert.deepEqual(touched, [], 'a default install opens nothing, creates nothing, locks nothing')
})

/* ------------------------------------------- the configured round trip, against a real disk */

test('a configured budget round trip stays far inside the hook deadline', async (t) => {
  // Published as 4.05 ms median for checkBudget + finalizeBudget: two lock cycles and two
  // read-modify-writes. Measured against a REAL directory, because the cost being reported is the
  // filesystem's, and an injected fs would measure nothing of interest.
  //
  // Fewer iterations than the pure cases: 2000 real lock cycles would make this the slowest file
  // in the suite for no extra information. The ceiling is the honest claim — well inside the
  // hook's 20-second deadline, on a path that was about to spend seconds in a model anyway.
  const tmp = makeTempDir('gov-latency')
  try {
    const config = withDailyLimit(tmp.dir)
    const roundTrip = (i) => {
      const g = checkBudget(config, {
        id: `perf-${i}`,
        request,
        billing: 'local_free',
        now: NOW,
      })
      finalizeBudget(config, {
        id: `perf-${i}`,
        reservationStatus: g.reservationStatus,
        usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
        costUsd: null,
        now: NOW,
      })
    }
    for (let i = 0; i < 20; i += 1) roundTrip(i)
    let n = 0
    const s = await series(200, async () => {
      n += 1
      roundTrip(1000 + n)
    })
    report(t, 'checkBudget + finalizeBudget (configured, real ledger)', s)
    assert.ok(
      s.median < 250,
      `${s.median.toFixed(2)} ms median for one governed call is well past the published 4 ms`,
    )
  } finally {
    tmp.cleanup()
  }
})

test('the ledger does not grow without bound across a long run', async (t) => {
  // Not a latency claim but it belongs here: a reservation list that never shrank would make every
  // subsequent checkBudget slower, so the round-trip number above would only hold for a fresh
  // install. Settling removes the reservation, which is what keeps the cost flat.
  const tmp = makeTempDir('gov-latency-growth')
  try {
    const config = withDailyLimit(tmp.dir)
    for (let i = 0; i < 300; i += 1) {
      const g = checkBudget(config, { id: `grow-${i}`, request, billing: 'local_free', now: NOW })
      finalizeBudget(config, {
        id: `grow-${i}`,
        reservationStatus: g.reservationStatus,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: null,
        now: NOW,
      })
    }
    const s = await series(100, async () => {
      const g = checkBudget(config, { id: 'grow-final', request, billing: 'local_free', now: NOW })
      finalizeBudget(config, {
        id: 'grow-final',
        reservationStatus: g.reservationStatus,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        costUsd: null,
        now: NOW,
      })
    })
    report(t, 'checkBudget + finalizeBudget after 300 settled calls', s)
    assert.ok(
      s.median < 250,
      `${s.median.toFixed(2)} ms after 300 calls suggests the reservation list is growing`,
    )
  } finally {
    tmp.cleanup()
  }
})
