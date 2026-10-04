/**
 * Basic routing decisions.
 *
 * The happy path and the enforcement mapping. What each individual rule refuses lives in
 * routing.exclusions.test.mjs; what the result object is allowed to contain lives in
 * routing.contract.test.mjs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import { ENFORCEMENTS, LANE_MODE } from '../plugins/model-router/lib/routing-policy.mjs'
import {
  HOSTILE_VALUES,
  bulkReadInput,
  codeWriteInput,
  routingConfig,
} from './helpers/routing-input.mjs'

/* ------------------------------------------------------------- the happy path */

test('a large multi-file read delegates to the bulk-reader', () => {
  const d = decide(bulkReadInput(), routingConfig())
  assert.equal(d.delegate, true)
  assert.equal(d.mode, 'bulk-reader')
  assert.equal(d.lane, 'bulkRead')
  assert.equal(d.reason, 'threshold_met')
})

test('the default bulkRead enforcement is deny, so the gate blocks the read and steers', () => {
  // This is the one lane that blocks. If the default ever becomes advisory, the savings claim in
  // docs/savings-methodology.md ("hook-proven files only") loses its evidence.
  assert.equal(decide(bulkReadInput(), routingConfig()).decision, 'deny')
})

test('a code-write delegates but only ever advises under default config', () => {
  const d = decide(codeWriteInput(), routingConfig())
  assert.equal(d.delegate, true)
  assert.equal(d.mode, 'code-writer')
  assert.equal(d.lane, 'codeWrite')
  assert.equal(d.decision, 'suggest', 'a hook cannot know a Write is boilerplate before it exists')
})

test('a single large file delegates — one file is enough with minFiles at its default of 1', () => {
  const d = decide(bulkReadInput({ fileCount: 1, paths: ['/proj/src/big.ts'] }), routingConfig())
  assert.equal(d.delegate, true)
  assert.equal(d.reason, 'threshold_met')
})

test('a single small file stays with Claude', () => {
  const d = decide(
    bulkReadInput({ fileCount: 1, lineCount: 40, inputBytes: 900, estimatedInputTokens: 200, paths: ['/proj/a.ts'] }),
    routingConfig(),
  )
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'below_threshold')
})

test('multiple sufficiently large files delegate', () => {
  const d = decide(bulkReadInput({ fileCount: 12, lineCount: 4000, paths: Array.from({ length: 12 }, (_, i) => `/proj/f${i}.ts`) }), routingConfig())
  assert.equal(d.delegate, true)
})

/* ------------------------------------------------------- enforcement mapping */

for (const enforce of ['deny', 'ask', 'suggest']) {
  test(`a delegated bulk read reports decision "${enforce}" when the lane is configured that way`, () => {
    const d = decide(bulkReadInput(), routingConfig({ routing: { bulkRead: { enforce } } }))
    assert.equal(d.delegate, true)
    assert.equal(d.decision, enforce, 'the lane enforcement IS the decision on the delegate path')
  })
}

test('enforce "off" is reported as allow + disabled, never as a decision value of "off"', () => {
  // A hook written as `if (d.decision === 'allow') proceed` must never meet a value it cannot act
  // on. The nuance lives in the reason code, which is where this repo puts nuance.
  const d = decide(bulkReadInput(), routingConfig({ routing: { bulkRead: { enforce: 'off' } } }))
  assert.equal(d.decision, 'allow')
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'disabled')
})

test('every refusal reports decision "allow", so a broken router degrades to plain Claude Code', () => {
  const refusals = [
    bulkReadInput({ taskType: 'debugging' }),
    bulkReadInput({ interactive: true }),
    bulkReadInput({ workerAvailable: false }),
    bulkReadInput({ lineCount: 1, inputBytes: 1, estimatedInputTokens: 1 }),
    bulkReadInput({ paths: ['/proj/.env'] }),
  ]
  for (const input of refusals) {
    const d = decide(input, routingConfig())
    assert.equal(d.decision, 'allow', `${d.reason} must not block the tool call`)
    assert.equal(d.delegate, false)
    assert.equal(d.mode, null)
  }
})

test('the decision is always one of the four actions a hook can take', () => {
  for (const enforce of ['deny', 'ask', 'suggest', 'off']) {
    for (const input of [bulkReadInput(), codeWriteInput(), bulkReadInput({ taskType: 'debugging' })]) {
      const d = decide(input, routingConfig({ routing: { bulkRead: { enforce }, codeWrite: { enforce } } }))
      assert.ok(ENFORCEMENTS.includes(d.decision), `got ${d.decision}`)
    }
  }
})

/* ------------------------------------------------------------- pass-through */

test('estimatedInputTokens is echoed back verbatim so Phase 4 need not recompute it', () => {
  assert.equal(decide(bulkReadInput({ estimatedInputTokens: 18420 }), routingConfig()).estimatedInputTokens, 18420)
})

test('an unknown estimatedInputTokens comes back as null, never as 0', () => {
  // A measured zero and an unmeasured quantity must not be two ways of saying the same thing.
  const d = decide(bulkReadInput({ estimatedInputTokens: null }), routingConfig())
  assert.equal(d.estimatedInputTokens, null)
  assert.notEqual(d.estimatedInputTokens, 0)
})

test('a measured zero survives as 0', () => {
  assert.equal(decide(bulkReadInput({ estimatedInputTokens: 0 }), routingConfig()).estimatedInputTokens, 0)
})

test('the normalized task type is reported even when the input named something unrecognized', () => {
  assert.equal(decide(bulkReadInput({ taskType: 'architecure' }), routingConfig()).taskType, 'unknown')
})

test('mode is null exactly when delegate is false', () => {
  const inputs = [
    bulkReadInput(),
    codeWriteInput(),
    bulkReadInput({ taskType: 'debugging' }),
    bulkReadInput({ workerAvailable: false }),
    bulkReadInput({ lineCount: 1, inputBytes: 1, estimatedInputTokens: 1 }),
  ]
  for (const input of inputs) {
    const d = decide(input, routingConfig())
    assert.equal(d.mode === null, d.delegate === false, `${d.reason}: mode ${d.mode}, delegate ${d.delegate}`)
    if (d.delegate) assert.equal(d.mode, LANE_MODE[d.lane])
  }
})

/* --------------------------------------------------------- hostile arguments */

test('decide never throws, whatever it is handed', () => {
  // A hook that throws is a hook that breaks the session. There is no input for which refusing to
  // answer is better than answering `allow`.
  for (const v of HOSTILE_VALUES) {
    for (const input of [v, { taskType: v }, { paths: v }, { fileCount: v }, { projectPath: v }]) {
      const d = decide(input, routingConfig())
      assert.equal(d.decision, 'allow', `input ${JSON.stringify(input)} must fail open`)
      assert.equal(d.delegate, false)
    }
  }
})

test('decide does not mutate its input', () => {
  const input = bulkReadInput()
  const before = JSON.stringify(input)
  decide(input, routingConfig())
  assert.equal(JSON.stringify(input), before)
})

test('a frozen input is accepted', () => {
  // The caller may well reuse one frozen fact object across two lanes.
  const input = Object.freeze(bulkReadInput())
  assert.equal(decide(input, routingConfig()).delegate, true)
})

test('an input carrying extra keys is accepted and the extras are ignored', () => {
  const d = decide({ ...bulkReadInput(), nonsense: 1, enabled: false }, routingConfig())
  assert.equal(d.delegate, true)
  assert.equal(Object.hasOwn(d, 'nonsense'), false)
})
