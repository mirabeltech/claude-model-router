/**
 * A child process that hammers the budget ledger, for `test/governance.concurrency.test.mjs`.
 *
 * NOT named `*.test.mjs` on purpose: the runner's glob would otherwise pick it up and run it as
 * a suite with no `CMR_TEST_BUDGET_WRITER` in the environment. Same reason, same shape as
 * `test/helpers/jsonl-writer-child.mjs`.
 *
 * Why a real child process rather than `Promise.all` over in-process calls: the race this is
 * built to catch is between two OPERATING SYSTEM processes contending for one lock file. An
 * in-process loop shares the module, the event loop and any accidental in-memory state, so it
 * would pass whether or not the lock worked. Two Claude Code sessions on one machine are two
 * processes, and that is the thing being modelled.
 *
 * The spec arrives as a JSON env var rather than argv, so nothing has to survive Windows
 * command-line quoting.
 */

import { readState, reserve, settle } from '../../plugins/model-router/lib/governance/ledger.mjs'

const spec = JSON.parse(process.env.CMR_TEST_BUDGET_WRITER ?? '{}')
const { dir, now, attempts, tokensEach, limit, startFile, mode = 'reserve' } = spec

const config = {
  budget: {
    enabled: true,
    run: { maxWorkerCostUsd: null, maxInputTokens: null, maxOutputTokens: null, maxTotalTokens: null },
    daily: { maxWorkerCostUsd: null, maxTotalTokens: limit ?? null },
    monthly: { maxWorkerCostUsd: null, maxTotalTokens: null },
    onExceed: 'disable',
    onUnknownCost: 'allow',
    onUnknownUsage: 'allow',
    stateDir: dir,
    stateDirResolved: dir,
  },
}

const fs = await import('node:fs')

/** Announce readiness, then wait for the parent to drop the start file. */
process.stdout.write('ready\n')
if (typeof startFile === 'string') {
  const deadline = Date.now() + 20_000
  while (!fs.existsSync(startFile) && Date.now() < deadline) {
    // Busy wait. A sleep here would blunt the simultaneity the barrier exists to create.
  }
}

const granted = []
const refused = []

for (let i = 0; i < attempts; i += 1) {
  const id = `${process.pid}-${i}`

  if (mode === 'reserve') {
    // Read-then-reserve, which is exactly the shape that races: the decision is made from a
    // snapshot, and only the reservation is serialised by the lock.
    const before = readState(config, { now })
    const spentSoFar = before.ok ? before.state.daily.totalTokens : null

    if (spentSoFar !== null && limit !== null && spentSoFar + tokensEach > limit) {
      refused.push({ id, spentSoFar })
      continue
    }

    const claim = reserve(config, { id, tokens: tokensEach, now })
    if (claim.ok) granted.push({ id, spentSoFar })
    else refused.push({ id, reason: claim.reason })
    continue
  }

  if (mode === 'settle') {
    // Reserve then settle the same id repeatedly, to prove a concurrent settle cannot
    // double-charge and cannot lose a charge.
    // The reserve may lose a contended lock, in which case the settle correctly finds nothing
    // to convert and charges nothing. `reason` is reported so the parent can tell a real
    // conversion from that no-op — they are both `ok`, and conflating them makes the parent
    // expect a charge that never should have happened.
    const claim = reserve(config, { id, tokens: tokensEach, now })
    const s = settle(config, { id, tokens: tokensEach, costUsd: 0.01, now })
    if (s.ok) granted.push({ id, status: s.status, reason: s.reason, reserved: claim.ok })
    else refused.push({ id, reason: s.reason })
  }
}

process.stdout.write(`${JSON.stringify({ pid: process.pid, granted, refused })}\n`)
