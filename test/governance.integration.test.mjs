/**
 * Routing, then governance, then capability — through the real hook.
 *
 * THE ORDER IS THE DESIGN, and this file is what makes that more than a comment:
 *
 *   routing      `decide()`        would this task be APPROPRIATE to delegate?
 *   governance   `checkBudget()`   are we currently ALLOWED to delegate?
 *   capability   inside dispatch   CAN this worker safely execute this request?
 *
 * Three properties follow, and each has a test here:
 *
 *  1. Governance is never consulted when routing already refused. A read that was not
 *     delegate-worthy must not consume a reservation, and must not be reported as a budget
 *     refusal — the two are different answers and the row has to keep them apart.
 *  2. A governance refusal is the PRIMARY FALLBACK, never a failure. `response === null` is how
 *     this hook tells Claude Code to run the original Read, so budget exhaustion degrades to
 *     plain Claude Code rather than to a broken session.
 *  3. Nothing that failed to reach the worker creates worker usage.
 *
 * The dispatcher is stubbed, because the question under test is what the ORCHESTRATOR does with
 * a budget — not whether a provider works.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { readState } from '../plugins/model-router/lib/governance/ledger.mjs'
import { hookConfig, hookEnv, makeWorkspace, readStdin } from './helpers/hook-payload.mjs'

/** A dispatcher that records its calls and returns a fixed successful answer. */
function stubDispatch(overrides = {}) {
  const calls = []
  const impl = async (args) => {
    calls.push(args)
    return {
      ok: true,
      executed: true,
      status: 'ok',
      reason: 'completed',
      mode: 'bulk-reader',
      lane: 'bulkRead',
      provider: 'mock',
      model: 'mock-1',
      modelRequested: 'mock-1',
      text: 'THE WORKER SUMMARY',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, source: 'provider_reported' },
      capabilities: null,
      attempts: 1,
      latencyMs: 12,
      providerLatencyMs: 10,
      truncated: false,
      finishReason: 'stop',
      error: null,
      promptVersion: 1,
      policyVersion: 1,
      warnings: [],
      ...overrides,
    }
  }
  impl.calls = calls
  return impl
}

/** A dispatcher that fails the way a refused context does: no usage at all. */
const refusingDispatch = (reason, extra = {}) =>
  stubDispatch({
    ok: false,
    status: 'error',
    reason,
    text: null,
    usage: null,
    finishReason: null,
    error: { code: reason, message: 'refused', retryable: false },
    ...extra,
  })

/**
 * Run the hook with a budget configured, against a throwaway ledger.
 *
 * `rows` collects what telemetry WOULD have been written, so the governance columns can be
 * asserted without going near a real sink.
 */
async function run({ budget = {}, payload = {}, bytes = 40_000, dispatchImpl, stateDir } = {}) {
  const ws = makeWorkspace('gov-int', { bytes })
  const dir = stateDir ?? path.join(ws.dir, 'governance')
  const impl = dispatchImpl ?? stubDispatch()
  const rows = []
  try {
    const config = hookConfig({ telemetry: { enabled: false } })
    config.budget = {
      ...config.budget,
      ...budget,
      run: { ...config.budget.run, ...(budget.run ?? {}) },
      daily: { ...config.budget.daily, ...(budget.daily ?? {}) },
      monthly: { ...config.budget.monthly, ...(budget.monthly ?? {}) },
      stateDir: dir,
      stateDirResolved: dir,
    }

    const out = await runReadHook({
      raw: readStdin({
        cwd: ws.dir,
        transcript_path: ws.transcript,
        tool_input: { file_path: ws.file },
        ...payload,
      }),
      config,
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: impl,
      emit: (inputs) => {
        rows.push(inputs)
        return null
      },
    })
    // Read the ledger HERE, not in the caller: `dir` lives inside the workspace, and the
    // `finally` below deletes it. A caller reading afterwards would silently measure a fresh
    // empty ledger and every accounting assertion would pass by reading nothing.
    return {
      ...out,
      config,
      dir,
      calls: impl.calls,
      rows,
      ledgerExists: fs.existsSync(dir),
      state: readState(config).state,
    }
  } finally {
    ws.cleanup()
  }
}

/**
 * The pre-dispatch estimate for the standard 40 KB fixture.
 *
 * Governance checks an ESTIMATE before the call and settles MEASURED usage after it, so a limit
 * meant to admit the first delegation has to clear the estimate rather than the measurement.
 * Derived here rather than hardcoded so a change to the estimator does not quietly turn these
 * tests into assertions about nothing.
 */
const ESTIMATE_40K = Math.ceil(40_000 / 4) + 8192

/* ------------------------------------------------ the shipped configuration */

test('with no budget configured the hook delegates and writes no ledger at all', async () => {
  // THE MOST IMPORTANT TEST IN THIS FILE. Every limit ships null, so governance must short
  // circuit on a pure object walk: no directory created, no file written, no lock taken. If this
  // ever fails, a default install has started paying filesystem cost for a feature nobody asked
  // for, and the latency budget this hook lives inside is 20 seconds for everything.
  const r = await run()
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.calls.length, 1)
  assert.equal(r.ledgerExists, false, 'an unconfigured budget must not touch the disk')

  const row = r.rows.at(-1)
  assert.equal(row.governance.decision, 'allow')
  assert.equal(row.governance.reason, 'budget_not_configured')
  assert.equal(row.governance.reservationStatus, 'none', 'nothing to reserve, nothing reserved')
})

test('governance disabled is reported as disabled, not as unconfigured', async () => {
  const r = await run({ budget: { enabled: false, daily: { maxTotalTokens: 1 } } })
  assert.equal(r.outcome, 'delegated', 'a disabled budget enforces nothing, even a 1-token one')
  assert.equal(r.rows.at(-1).governance.reason, 'governance_disabled')
  assert.equal(r.ledgerExists, false)
})

/* ------------------------------------------------------------- routing first */

test('a routing refusal never consults governance', async () => {
  // Invariant 7 and the diagnostic argument together. A small read is not delegate-worthy, and
  // that is the answer the row must carry — not a budget verdict, and certainly not a
  // reservation. Governance running first would have overwritten `below_threshold`.
  const r = await run({ bytes: 200, budget: { daily: { maxTotalTokens: 0 } } })
  assert.equal(r.outcome, 'not_delegated')
  assert.equal(r.decision.reason, 'below_threshold', 'the ROUTING reason survives')
  assert.equal(r.calls.length, 0)
  assert.equal(r.rows.at(-1).governance, null, 'governance must not have been consulted')
  assert.equal(r.ledgerExists, false, 'a routing refusal creates no budget state')
})

test('a routing refusal on a never-delegate path still never consults governance', async () => {
  const r = await run({
    payload: { tool_input: { file_path: 'C:/project/.env.production', offset: 1, limit: 10 } },
    budget: { daily: { maxTotalTokens: 0 } },
  })
  assert.notEqual(r.outcome, 'delegated')
  assert.equal(r.calls.length, 0)
  assert.equal(r.rows.at(-1)?.governance ?? null, null)
})

/* --------------------------------------------------- governance then refuses */

test('a governance refusal falls back to plain Claude Code rather than failing', async () => {
  // Invariant 11, and Part 11 of the brief: budget exhaustion means "worker acceleration
  // unavailable", never "task failed". `response === null` is this hook's way of saying
  // "write nothing, run the original Read".
  const r = await run({ budget: { daily: { maxTotalTokens: 0 } } })
  assert.equal(r.outcome, 'governance_denied')
  assert.equal(r.response, null, 'the developer must still get their file')
  assert.equal(r.calls.length, 0, 'no worker call, so no money can be spent')

  const row = r.rows.at(-1)
  assert.equal(row.governance.decision, 'deny')
  assert.equal(row.governance.reason, 'daily_budget_exceeded')
  assert.equal(row.governance.scope, 'daily')
})

test('a governance refusal still records that routing WOULD have delegated', async () => {
  // THE WHOLE REASON GOVERNANCE RUNS AFTER THE GATE. Both facts survive: the read was
  // delegate-worthy, and the budget would not allow it. Folding the budget into the gate would
  // leave only the second half, and "why did this not delegate" would be unanswerable.
  const r = await run({ budget: { daily: { maxTotalTokens: 0 } } })
  assert.equal(r.decision.delegate, true, 'routing said yes')
  assert.equal(r.decision.reason, 'threshold_met')
  assert.equal(r.rows.at(-1).governance.decision, 'deny', 'governance said not now')
})

test('a governance refusal costs no file read and no reservation', async () => {
  // Placement, verified: the check sits before `readTextContent`, so a refused delegation does
  // not pay to open the file it was never going to send.
  const r = await run({ budget: { run: { maxTotalTokens: 1 } } })
  assert.equal(r.outcome, 'governance_denied')
  assert.equal(r.rows.at(-1).governance.reservationStatus, 'none')

  assert.equal(r.state.daily.totalTokens, 0, 'a refusal creates zero worker usage')
  assert.equal(r.state.reservations, 0, 'and holds no reservation')
})

test('onExceed warn delegates anyway and records the breach', async () => {
  // The operator asked to be told rather than stopped. The reason still names the budget that
  // was crossed, so "warn" does not mean "silent".
  const r = await run({ budget: { onExceed: 'warn', daily: { maxTotalTokens: 1 } } })
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.calls.length, 1)
  const g = r.rows.at(-1).governance
  assert.equal(g.decision, 'allow')
  assert.equal(g.reason, 'daily_budget_exceeded', 'the breach is on the record')
  assert.ok(g.warnings.includes('budget_exceeded_daily'), `warnings were ${JSON.stringify(g.warnings)}`)
})

/* --------------------------------------------------- governance then allows */

test('an allowed delegation reserves, dispatches, and settles at measured usage', async () => {
  // The full happy path. The reservation is sized from an estimate and replaced by what the
  // provider actually reported — 120 tokens, not the much larger estimate a 40 KB file implies.
  const r = await run({ budget: { daily: { maxTotalTokens: 10_000_000 } } })
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.calls.length, 1)

  const g = r.rows.at(-1).governance
  assert.equal(g.decision, 'allow')
  assert.equal(g.reservationStatus, 'settled')
  assert.ok(g.reservationTokens > 120, 'the reservation was an estimate, and a generous one')

  assert.equal(r.state.daily.totalTokens, 120, 'the LEDGER holds measured usage, not the estimate')
  assert.equal(r.state.reservations, 0, 'the reservation was converted, not left open')
})

test('spend accumulates across delegations, and the limit eventually binds', async () => {
  // End to end, and the thing a developer would actually notice: the budget runs out.
  //
  // The limit has to clear ESTIMATE_40K, because the pre-dispatch check reasons over the
  // estimate while the ledger accumulates the much smaller measured usage. Setting it just
  // above one estimate means the first call is admitted and later ones are refused as the
  // settled spend eats the headroom the next estimate needs.
  const tmp = makeWorkspace('gov-int-accum', { bytes: 40_000 })
  try {
    const dir = path.join(tmp.dir, 'state')
    const limit = ESTIMATE_40K + 300
    const outcomes = []
    for (let i = 0; i < 6; i += 1) {
      const r = await run({
        budget: { daily: { maxTotalTokens: limit } },
        payload: { tool_use_id: `call-${i}` },
        stateDir: dir,
      })
      outcomes.push(r.outcome)
    }

    const delegated = outcomes.filter((o) => o === 'delegated').length
    const denied = outcomes.filter((o) => o === 'governance_denied').length

    assert.ok(delegated >= 1, `nothing delegated at all: ${JSON.stringify(outcomes)}`)
    assert.ok(denied >= 1, `the budget never bound: ${JSON.stringify(outcomes)}`)
    assert.equal(delegated + denied, 6, `unexpected outcome in ${JSON.stringify(outcomes)}`)

    // Once refused, it stays refused: settled spend does not evaporate between calls.
    assert.equal(outcomes.at(-1), 'governance_denied', 'an exhausted budget must stay exhausted')

    // And the ledger agrees with what actually ran: 120 measured tokens per delegation.
    const state = readState({ budget: { stateDir: dir, stateDirResolved: dir } }).state
    assert.equal(state.daily.totalTokens, delegated * 120)
    assert.equal(state.daily.calls, delegated)
    assert.equal(state.reservations, 0, 'no reservation survived its call')
  } finally {
    tmp.cleanup()
  }
})

/* ----------------------------------------- nothing unspent creates usage */

test('a context_exceeded refusal creates zero worker usage', async () => {
  // Invariant 2. The worker never ran — the context model refused before the call — so the
  // reservation has to come back in full. Charging it would make an unsendable file cost budget.
  const r = await run({
    budget: { daily: { maxTotalTokens: 10_000_000 } },
    dispatchImpl: refusingDispatch('context_exceeded'),
  })
  assert.equal(r.outcome, 'worker_failed')
  assert.equal(r.response, null, 'the original Read still proceeds')

  assert.equal(r.state.daily.totalTokens, 0, 'a refused context must not consume budget')
  assert.equal(r.state.daily.calls, 0, 'and must not count as a call')
  assert.equal(r.state.reservations, 0, 'the reservation was released, not leaked')
  assert.equal(r.rows.at(-1).governance.reservationStatus, 'released')
})

test('a provider error with no reported usage creates zero worker usage', async () => {
  const r = await run({
    budget: { daily: { maxTotalTokens: 10_000_000 } },
    dispatchImpl: refusingDispatch('provider_error'),
  })
  assert.equal(r.state.daily.totalTokens, 0)
  assert.equal(r.state.reservations, 0)
})

test('an aborted call creates zero worker usage', async () => {
  const r = await run({
    budget: { daily: { maxTotalTokens: 10_000_000 } },
    dispatchImpl: refusingDispatch('aborted'),
  })
  assert.equal(r.state.daily.totalTokens, 0)
  assert.equal(r.state.reservations, 0)
})

test('a FAILED call that did report usage is charged, because those tokens were spent', async () => {
  // The other side of the rule. A timeout after the model had already read the prompt really
  // did consume input tokens, and a ledger that forgave them would under-report every decision
  // that followed.
  const r = await run({
    budget: { daily: { maxTotalTokens: 10_000_000 } },
    dispatchImpl: refusingDispatch('provider_error', {
      usage: { inputTokens: 500, outputTokens: 0, totalTokens: 500, source: 'provider_reported' },
    }),
  })
  assert.equal(r.state.daily.totalTokens, 500, 'measured usage on a failed call still counts')
  assert.equal(r.state.reservations, 0)
})

test('a successful call reporting no usage charges nothing, and leaks no reservation', async () => {
  // The documented exposure: a provider that reports no counts can never exhaust a token
  // budget. It must not, however, leave its reservation held.
  const r = await run({
    budget: { daily: { maxTotalTokens: 10_000_000 } },
    dispatchImpl: stubDispatch({ usage: null }),
  })
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.state.daily.totalTokens, 0, 'unknown usage is never charged usage')
  assert.equal(r.state.reservations, 0, 'but the reservation is still released')
})

test('an unreadable file releases the reservation it had already taken', async () => {
  // The gate approved, the budget approved, and then the file turned out to be binary. The
  // reservation was already open at that point, so this path has to give it back.
  const tmp = makeWorkspace('gov-int-binary', { bytes: 40_000 })
  try {
    const dir = path.join(tmp.dir, 'state')
    const binary = path.join(tmp.dir, 'blob.ts')
    fs.writeFileSync(binary, Buffer.concat([Buffer.alloc(1000, 0), Buffer.alloc(40_000, 0x41)]))

    const config = hookConfig({ telemetry: { enabled: false } })
    config.budget = {
      ...config.budget,
      daily: { ...config.budget.daily, maxTotalTokens: 10_000_000 },
      stateDir: dir,
      stateDirResolved: dir,
    }

    const impl = stubDispatch()
    const out = await runReadHook({
      raw: readStdin({ cwd: tmp.dir, transcript_path: tmp.transcript, tool_input: { file_path: binary } }),
      config,
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: impl,
      emit: () => null,
    })

    assert.equal(out.outcome, 'content_binary')
    assert.equal(impl.calls.length, 0, 'the worker was never called')
    const state = readState(config).state
    assert.equal(state.reservations, 0, 'the reservation must not be leaked')
    assert.equal(state.daily.totalTokens, 0)
  } finally {
    tmp.cleanup()
  }
})

/* ------------------------------------------------------------- degradation */

test('an unwritable ledger allows rather than blocking the session', async () => {
  // FAILS OPEN. A storage problem must not become a dead router. Doctor reports the same
  // condition as an error, where it is actionable instead of mid-session.
  const r = await run({
    budget: { daily: { maxTotalTokens: 10 } },
    stateDir: '\u0000:/not/a/path',
  })
  assert.equal(r.outcome, 'delegated', 'an unusable ledger must not refuse delegation')
  const g = r.rows.at(-1).governance
  assert.equal(g.decision, 'allow')
  assert.ok(
    g.warnings.some((w) => w.startsWith('budget_')),
    `the failure must be recorded, warnings were ${JSON.stringify(g.warnings)}`,
  )
})

test('a payload with no tool_use_id still delegates, and reserves nothing', async () => {
  // The reservation key is Claude Code's own id for the tool call. Without one a reservation
  // cannot be settled idempotently, so none is taken — and the read is not punished for it.
  const r = await run({
    budget: { daily: { maxTotalTokens: 10_000_000 } },
    payload: { tool_use_id: null },
  })
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.rows.at(-1).governance.reservationStatus, 'none')
})
