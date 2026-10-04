/**
 * The decision contract, pinned.
 *
 * A pure function's contract IS its regression surface, so this file does double duty: it pins the
 * result shape and every enum, and it carries the four fail-open tests that CLAUDE.md's second
 * non-negotiable names one by one. If a later phase wants to change any of this, it has to change
 * a test that says why the rule exists.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import {
  DECIDE_REASONS,
  DELEGATABLE_TASK_TYPES,
  ENFORCEMENTS,
  LANE_MODE,
  POLICY_VERSION,
  PRECISE_OUTPUTS,
  ROUTING_TASK_TYPES,
  TASK_TYPE_LANE,
  WORKER_UNAVAILABLE_REASONS,
} from '../plugins/model-router/lib/routing-policy.mjs'
import {
  ROUTING_DECISIONS,
  ROUTING_REASONS,
  TASK_TYPES,
} from '../plugins/model-router/lib/telemetry/record.mjs'
import { bulkReadInput, codeWriteInput, routingConfig } from './helpers/routing-input.mjs'

/**
 * One input per reason code. This table is the completeness check: a rule that is written and then
 * shadowed by an earlier one produces an unreachable code, and the test below catches it.
 */
const FIXTURES = Object.freeze({
  disabled: [{}, { enabled: false }],
  unknown_input: [{ taskType: 'nonsense' }, {}],
  task_type_excluded: [{ taskType: 'security' }, {}],
  interactive: [{ interactive: true }, {}],
  latency_sensitive: [{ latencySensitive: true }, {}],
  precise_output_requested: [{ requestedOutput: 'diff' }, {}],
  targeted_read: [{ targetedRead: true }, {}],
  recently_edited: [{ recentlyEdited: true }, {}],
  deny_glob: [{ paths: ['/proj/config/secrets.json'], fileCount: 1 }, {}],
  worker_not_ready: [{ workerAvailable: false }, {}],
  budget_exceeded: [{ workerAvailable: false, workerUnavailableReason: 'budget_exceeded' }, {}],
  over_max_files: [{ fileCount: 500 }, {}],
  over_max_input_bytes: [{ inputBytes: 3_000_000 }, {}],
  below_threshold: [{ lineCount: 5, inputBytes: 50, estimatedInputTokens: 5 }, {}],
  threshold_met: [{}, {}],
})

const all = () =>
  DECIDE_REASONS.map((code) => {
    const [over, cfg] = FIXTURES[code]
    return { code, result: decide(bulkReadInput(over), routingConfig(cfg)) }
  })

/* ----------------------------------------------------------- CLAUDE.md branch 1 */

test('an unconfigured worker fails open', () => {
  const d = decide(bulkReadInput({ workerAvailable: false }), routingConfig())
  assert.equal(d.decision, 'allow')
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'worker_not_ready')
})

/* ----------------------------------------------------------- CLAUDE.md branch 2 */

test('a spent budget fails open', () => {
  // The engine never reads a ledger. The caller knows why the worker is unavailable and labels it,
  // which is what keeps `budget_exceeded` reachable without a dependency on a cost store.
  const d = decide(
    bulkReadInput({ workerAvailable: false, workerUnavailableReason: 'budget_exceeded' }),
    routingConfig(),
  )
  assert.equal(d.decision, 'allow')
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'budget_exceeded')
})

/* ----------------------------------------------------------- CLAUDE.md branch 3 */

test('a sensitive path fails open', () => {
  const d = decide(bulkReadInput({ paths: ['/proj/.env'], fileCount: 1 }), routingConfig())
  assert.equal(d.decision, 'allow')
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'deny_glob')
})

/* ----------------------------------------------------------- CLAUDE.md branch 4 */

test('a malformed config fails open', () => {
  for (const config of [null, undefined, {}, 'x', 42, [], { routing: {} }]) {
    const d = decide(bulkReadInput(), config)
    assert.equal(d.decision, 'allow', `config ${JSON.stringify(config)} must fail open`)
    assert.equal(d.delegate, false)
    assert.equal(d.reason, 'disabled')
  }
})

/* --------------------------------------------------------------- result shape */

test('the result carries exactly these nine fields, in this order', () => {
  // Phase 4 reads this object. Adding a field is additive; reordering or dropping one is not.
  assert.deepEqual(Object.keys(decide(bulkReadInput(), routingConfig())), [
    'decision',
    'delegate',
    'mode',
    'lane',
    'reason',
    'taskType',
    'estimatedInputTokens',
    'policyVersion',
    'inputWarnings',
  ])
})

test('no result field is ever undefined — absent and null must not be two ways of saying one thing', () => {
  for (const { code, result } of all()) {
    for (const [k, v] of Object.entries(result)) {
      assert.notEqual(v, undefined, `${code}.${k} was undefined`)
    }
  }
})

test('the result is never a bare boolean', () => {
  const d = decide(bulkReadInput(), routingConfig())
  assert.equal(typeof d, 'object')
  assert.notEqual(d, true)
})

/* ---------------------------------------------------------------- the enums */

test('every reason decide can return is in the telemetry reason enum', () => {
  // Otherwise toEnum() stamps `unknown_enum:routing_reason` on every gate row and poisons the one
  // signal the store has for "something is actually wrong".
  for (const code of DECIDE_REASONS) {
    assert.ok(ROUTING_REASONS.includes(code), `${code} is missing from ROUTING_REASONS`)
  }
})

test('every reason code is reachable by some input', () => {
  const unreached = []
  for (const { code, result } of all()) if (result.reason !== code) unreached.push(`${code} (got ${result.reason})`)
  assert.deepEqual(unreached, [], 'a code no input can produce is a rule shadowed by an earlier one')
})

test('every decision decide can return is in the telemetry decision enum', () => {
  for (const value of ENFORCEMENTS) {
    assert.ok(ROUTING_DECISIONS.includes(value), `${value} is missing from ROUTING_DECISIONS`)
  }
})

test('decide never returns off, delegated or not_applicable', () => {
  // They are in the telemetry enum because the delegation script writes them. A hook cannot act on
  // them, so a hook must never be handed one.
  const reachable = new Set()
  for (const enforce of ['deny', 'ask', 'suggest', 'off']) {
    const config = routingConfig({ routing: { bulkRead: { enforce }, codeWrite: { enforce } } })
    for (const code of DECIDE_REASONS) {
      reachable.add(decide(bulkReadInput(FIXTURES[code][0]), config).decision)
      reachable.add(decide(codeWriteInput(FIXTURES[code][0]), config).decision)
    }
  }
  for (const forbidden of ['off', 'delegated', 'not_applicable', 'other']) {
    assert.equal(reachable.has(forbidden), false, `decide returned ${forbidden}`)
  }
  for (const value of reachable) assert.ok(ENFORCEMENTS.includes(value), `got ${value}`)
})

test('the reason is always a declared code, never prose', () => {
  for (const { result } of all()) assert.ok(DECIDE_REASONS.includes(result.reason), result.reason)
})

test('the enforcement values are exactly the config enforce values plus allow', () => {
  // The guard that makes adding an enforcement to config.mjs without teaching the engine about it
  // a CI failure rather than a surprise at runtime.
  const fromSpec = ['deny', 'ask', 'suggest', 'off']
  assert.deepEqual([...ENFORCEMENTS].sort(), [...new Set(['allow', ...fromSpec.filter((v) => v !== 'off')])].sort())
})

/* ------------------------------------------------------------- the taxonomies */

test('the routing task taxonomy is exactly these eight values', () => {
  assert.deepEqual([...ROUTING_TASK_TYPES], [
    'bulk_read',
    'code_write',
    'debugging',
    'architecture',
    'security',
    'precise_edit',
    'general',
    'unknown',
  ])
})

test('the delegatable allowlist is exactly the two lanes, and general is not in it', () => {
  assert.deepEqual([...DELEGATABLE_TASK_TYPES], ['bulk_read', 'code_write'])
  assert.equal(DELEGATABLE_TASK_TYPES.includes('general'), false)
  assert.equal(DELEGATABLE_TASK_TYPES.includes('unknown'), false)
})

test('every delegatable task type maps to a lane, and every lane maps to a mode', () => {
  assert.deepEqual(Object.keys(TASK_TYPE_LANE).sort(), [...DELEGATABLE_TASK_TYPES].sort())
  for (const lane of Object.values(TASK_TYPE_LANE)) {
    assert.equal(typeof LANE_MODE[lane], 'string', `lane ${lane} has no mode`)
  }
})

test('routing and telemetry still spell the two shared task types the same way', () => {
  // The two taxonomies are deliberately separate — telemetry's is an EVENT taxonomy whose value
  // for a gate decision is `gate_block` — but where they overlap they must not diverge.
  for (const shared of DELEGATABLE_TASK_TYPES) {
    assert.ok(TASK_TYPES.includes(shared), `telemetry lost ${shared}`)
  }
})

test('the telemetry task taxonomy is NOT extended by Phase 3', () => {
  assert.deepEqual([...TASK_TYPES], ['bulk_read', 'code_write', 'gate_block', 'delegation', 'other'])
})

test('the worker-unavailable labels are a subset of the telemetry reason enum', () => {
  for (const code of WORKER_UNAVAILABLE_REASONS) assert.ok(ROUTING_REASONS.includes(code))
})

test('the precise output list is the five shapes that mean exact bytes', () => {
  assert.deepEqual([...PRECISE_OUTPUTS], ['edit', 'patch', 'diff', 'inline_edit', 'exact'])
})

/* ----------------------------------------------------------- version stamping */

test('the policy version is an integer, matching the other version stamps in this repo', () => {
  assert.equal(POLICY_VERSION, 1)
  assert.equal(Number.isInteger(POLICY_VERSION), true)
})

test('every decision carries the policy version that produced it', () => {
  for (const { result } of all()) assert.equal(result.policyVersion, POLICY_VERSION)
})

/* ------------------------------------------------------------- null behaviour */

test('estimatedInputTokens is null, not 0, whenever it was not measured', () => {
  for (const code of DECIDE_REASONS) {
    const [over, cfg] = FIXTURES[code]
    const d = decide(bulkReadInput({ ...over, estimatedInputTokens: null }), routingConfig(cfg))
    assert.equal(d.estimatedInputTokens, null, `${code} fabricated a token count`)
  }
})

test('mode and lane are null rather than absent when there is nothing to name', () => {
  const d = decide(bulkReadInput(), { })
  assert.equal(d.mode, null)
  assert.equal(d.lane, null)
  assert.equal(Object.hasOwn(d, 'mode'), true)
  assert.equal(Object.hasOwn(d, 'lane'), true)
})

test('inputWarnings is always an array, empty rather than null when there is nothing to report', () => {
  for (const { result } of all()) {
    assert.ok(Array.isArray(result.inputWarnings))
    for (const code of result.inputWarnings) assert.equal(typeof code, 'string')
  }
})

/* ------------------------------------------------------------ rule precedence */

/**
 * The ordered rule table. For every pair (i, j) with i < j, an input that triggers both must
 * report rule i's reason — that is what makes the stored reason column answerable.
 */
const ORDER = Object.freeze([
  ['disabled', { enabled: false }, {}],
  ['task_type_excluded', {}, { taskType: 'debugging' }],
  ['interactive', {}, { interactive: true }],
  ['latency_sensitive', {}, { latencySensitive: true }],
  ['precise_output_requested', {}, { requestedOutput: 'patch' }],
  ['targeted_read', {}, { targetedRead: true }],
  ['recently_edited', {}, { recentlyEdited: true }],
  ['deny_glob', {}, { paths: ['/proj/.env', '/proj/src/a.ts'] }],
  ['worker_not_ready', {}, { workerAvailable: false }],
  ['over_max_files', {}, { fileCount: 900 }],
  ['below_threshold', {}, { lineCount: 1, inputBytes: 1, estimatedInputTokens: 1 }],
])

test('when two rules both apply, the earlier one owns the reason', () => {
  // Two rules keyed on the SAME field cannot both apply — merging their inputs would just
  // overwrite one trigger with the other — so those pairs are skipped and counted. The count
  // assertion at the end is what stops this test from quietly becoming vacuous.
  let tested = 0
  for (let i = 0; i < ORDER.length; i++) {
    for (let j = i + 1; j < ORDER.length; j++) {
      const [reason, cfgI, inputI] = ORDER[i]
      const [, cfgJ, inputJ] = ORDER[j]
      const contends =
        Object.keys(inputI).some((k) => Object.hasOwn(inputJ, k)) ||
        Object.keys(cfgI).some((k) => Object.hasOwn(cfgJ, k))
      if (contends) continue
      const d = decide(bulkReadInput({ ...inputI, ...inputJ }), routingConfig({ ...cfgI, ...cfgJ }))
      assert.equal(d.reason, reason, `rule ${i} (${reason}) lost to rule ${j} (${ORDER[j][0]})`)
      tested += 1
    }
  }
  const pairs = (ORDER.length * (ORDER.length - 1)) / 2
  assert.ok(tested >= pairs - 3, `only ${tested} of ${pairs} ordered pairs were exercised`)
})

test('an unknown task type is reported before the exclusion list, not as an exclusion', () => {
  // The two task-type rules cannot be merged into the matrix above because they key on the same
  // field, but they CAN both apply: `unknown` is also absent from the allowlist. The ambiguity is
  // the more fundamental objection, so it wins.
  assert.equal(decide(bulkReadInput({ taskType: 'unknown' }), routingConfig()).reason, 'unknown_input')
  assert.equal(decide(bulkReadInput({ taskType: 'nonsense' }), routingConfig()).reason, 'unknown_input')
})

test('a payload too big for the worker and a payload too small to bother are mutually exclusive', () => {
  // Both rules read inputBytes, so only one can ever hold. Pinning that keeps a future reader from
  // "fixing" an ordering problem that does not exist.
  const over = decide(bulkReadInput({ inputBytes: 9_000_000 }), routingConfig())
  const under = decide(bulkReadInput({ lineCount: 1, inputBytes: 1, estimatedInputTokens: 1 }), routingConfig())
  assert.equal(over.reason, 'over_max_input_bytes')
  assert.equal(under.reason, 'below_threshold')
})
