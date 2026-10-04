#!/usr/bin/env node
/**
 * `npm run budget` — what the governance layer currently allows, and what has been spent.
 *
 * READ-ONLY. It opens no socket, calls no worker and writes nothing: not the ledger, not a lock,
 * not even the state directory. That matters more than it sounds, because the one property the
 * whole budget design rests on is that an unconfigured install never touches the disk — a
 * reporting tool that created the directory in order to tell you it was empty would quietly
 * falsify the thing it was reporting on.
 *
 * It answers four questions a developer actually asks:
 *
 *   1. Is anything being enforced at all?
 *   2. How much is left, and is that number trustworthy?
 *   3. Is anything in flight right now?
 *   4. When does the period roll over?
 *
 * Severity lives in `scripts/doctor.mjs`. This prints state, not verdicts.
 */

import { loadConfig } from '../lib/config.mjs'
import { hasConfiguredLimit, periodKeys } from '../lib/governance/policy.mjs'
import { readState } from '../lib/governance/ledger.mjs'

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

const { config } = loadConfig()
const budget = config.budget
const now = Date.now()
const periods = periodKeys(now)

console.log(`\nrouter budget  ${DIM}${periods.day} (UTC)${OFF}`)
console.log('='.repeat(68))

if (budget?.enabled !== true) {
  console.log(`\n${YELLOW}Governance is disabled.${OFF}  ${DIM}budget.enabled is false${OFF}`)
  console.log(`${DIM}No limit is evaluated and no accounting state is read or written.${OFF}\n`)
  process.exit(0)
}

if (!hasConfiguredLimit(budget)) {
  // The shipped state, and worth saying in full: "no budget" is not "zero budget".
  console.log(`\n${GREEN}No budget is configured.${OFF}  ${DIM}every limit is null${OFF}`)
  console.log(`${DIM}Delegation is ungoverned, and governance costs no filesystem I/O at all.${OFF}`)
  console.log(`${DIM}Set one in ${config.projectDir}/.claude/model-router.json, for example:${OFF}`)
  console.log(`${DIM}  { "budget": { "run": { "maxTotalTokens": 200000 } } }${OFF}`)
  console.log(`${DIM}A TOKEN budget binds wherever the provider reports usage. A DOLLAR budget${OFF}`)
  console.log(`${DIM}additionally needs pricing.overrides — see npm run doctor.${OFF}\n`)
  process.exit(0)
}

/* ------------------------------------------------------------------ limits */

const unit = (leaf, v) => (leaf === 'maxWorkerCostUsd' ? `$${v}` : `${v} tokens`)

console.log('\nConfigured limits')
console.log('-'.repeat(68))
for (const scope of ['run', 'daily', 'monthly']) {
  const block = budget[scope] ?? {}
  const set = Object.entries(block).filter(([, v]) => Number.isFinite(v))
  if (set.length === 0) {
    console.log(`  ${DIM}${scope.padEnd(8)} no limit${OFF}`)
    continue
  }
  for (const [leaf, v] of set) {
    console.log(`  ${scope.padEnd(8)} ${leaf.padEnd(18)} ${unit(leaf, v)}`)
  }
}

console.log(
  `\n  ${DIM}on exceed: ${budget.onExceed}` +
    `  unknown cost: ${budget.onUnknownCost}` +
    `  unknown usage: ${budget.onUnknownUsage}${OFF}`,
)

/* ------------------------------------------------------------------- spend */

const state = readState(config, { now })

console.log('\nSpend')
console.log('-'.repeat(68))

if (!state.ok) {
  // Unknown spend is NOT zero spend, and this is the one place a developer might mistake the
  // two, so it is spelled out rather than printed as 0.
  console.log(`  ${YELLOW}spend is UNKNOWN${OFF}  ${DIM}${state.reason}${OFF}`)
  console.log(`  ${DIM}Unknown is not zero. The router fails open, so delegation continues;${OFF}`)
  console.log(`  ${DIM}npm run doctor reports this as an error when a limit is configured.${OFF}\n`)
  process.exit(0)
}

/** Headroom under a limit, or null when either side is unknown — never the limit itself. */
const remaining = (limit, spent) =>
  Number.isFinite(limit) && Number.isFinite(spent) ? Math.max(0, limit - spent) : null

for (const [scope, label] of [
  ['daily', `today      ${periods.day}`],
  ['monthly', `this month ${periods.month}`],
]) {
  const s = state.state[scope]
  const tokenLimit = budget[scope]?.maxTotalTokens ?? null
  const costLimit = budget[scope]?.maxWorkerCostUsd ?? null

  const left = remaining(tokenLimit, s.totalTokens)
  const tokens =
    tokenLimit === null
      ? `${s.totalTokens} tokens`
      : `${s.totalTokens} / ${tokenLimit} tokens  ${left === null ? '(remaining unknown)' : `(${left} left)`}`

  // A cost total assembled from calls that could not be priced is a LOWER BOUND, and saying
  // "at least" is the difference between a measurement and a guess.
  const costLeft = remaining(costLimit, s.costUsd)
  const prefix = s.costStatus === 'partial' ? 'at least ' : ''
  const cost =
    costLimit === null
      ? `${prefix}$${s.costUsd.toFixed(4)}`
      : `${prefix}$${s.costUsd.toFixed(4)} / $${costLimit}  ${costLeft === null ? '(remaining unknown)' : `($${costLeft.toFixed(4)} left)`}`

  console.log(`  ${label}`)
  console.log(`    ${DIM}calls  ${s.calls}${OFF}`)
  console.log(`    ${DIM}tokens ${tokens}${OFF}`)
  console.log(`    ${DIM}cost   ${cost}${OFF}`)
  if (s.costStatus === 'partial') {
    console.log(`    ${YELLOW}cost is a LOWER BOUND${OFF}  ${DIM}some calls could not be priced${OFF}`)
  }
}

/* ------------------------------------------------------------ reservations */

if (state.state.reservations > 0) {
  console.log(
    `\n  ${DIM}${state.state.reservations} reservation(s) in flight, counted as spent until they settle.${OFF}`,
  )
  console.log(`  ${DIM}An abandoned one expires on its own; nothing has to be cleaned up by hand.${OFF}`)
}

console.log(
  `\n${DIM}Periods are UTC and roll over by key, so there is nothing scheduled at midnight.${OFF}`,
)
console.log(`${DIM}State: ${budget.stateDirResolved ?? budget.stateDir}${OFF}\n`)
process.exit(0)
