/**
 * Determinism.
 *
 * The same facts and the same configuration must always produce the same decision. A gate whose
 * answer depends on a clock, a counter or a key order is a gate nobody can reproduce a complaint
 * about, and it would make the stored `routing_reason` column meaningless.
 *
 * The purity half of this claim — no builtin import, no Date, no Math.random, no process — is
 * asserted statically in test/telemetry.isolation.test.mjs, next to the other architecture rules.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import { ROUTING_TASK_TYPES } from '../plugins/model-router/lib/routing-policy.mjs'
import { bulkReadInput, routingConfig } from './helpers/routing-input.mjs'

/** A deterministic PRNG, so a failure is reproducible rather than a once-a-month mystery. */
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 200 inputs spanning the whole field space, built from a fixed seed. */
function corpus() {
  const rnd = lcg(20261002)
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const count = () => pick([null, 0, 1, 3, 25, 26, 350, 12000, 40000, 3000000])
  const bool = () => pick([true, false, null])
  const out = []
  for (let i = 0; i < 200; i++) {
    out.push({
      taskType: pick([...ROUTING_TASK_TYPES, 'nonsense', null]),
      toolName: pick(['Read', 'Write', 'Grep', null, 7]),
      fileCount: count(),
      lineCount: count(),
      inputBytes: count(),
      estimatedInputTokens: count(),
      targetedRead: bool(),
      fullRead: bool(),
      recentlyEdited: bool(),
      latencySensitive: bool(),
      interactive: bool(),
      requestedOutput: pick(['summary', 'patch', 'file', null, '']),
      paths: pick([[], ['/proj/src/a.ts'], ['/proj/.env'], ['/proj/src/a.ts', '/proj/auth/b.ts']]),
      projectPath: pick(['/proj', null]),
      workerAvailable: bool(),
      workerUnavailableReason: pick(['worker_not_ready', 'budget_exceeded', null, 'because']),
    })
  }
  return out
}

/** Rebuild an object with its keys in reverse insertion order. */
const reorder = (o) => Object.fromEntries(Object.entries(o).reverse())

test('200 varied inputs decide identically on a second pass', () => {
  const config = routingConfig()
  for (const input of corpus()) {
    const a = decide(input, config)
    const b = decide(input, config)
    assert.deepEqual(a, b, `diverged for ${JSON.stringify(input)}`)
  }
})

test('key insertion order does not change a decision', () => {
  // An object is a bag of facts, not a sequence. If a rule ever read Object.keys order this fails.
  const config = routingConfig()
  for (const input of corpus()) {
    assert.deepEqual(decide(input, config), decide(reorder(input), config), `order mattered for ${JSON.stringify(input)}`)
  }
})

test('a freshly resolved config decides the same as the one before it', () => {
  // Config resolution must be reproducible too, or the gate is only deterministic within a run.
  for (const input of corpus()) {
    assert.deepEqual(decide(input, routingConfig()), decide(input, routingConfig()))
  }
})

test('the result and its warning list are frozen, so no caller can edit a decision after the fact', () => {
  const d = decide(bulkReadInput(), routingConfig())
  assert.ok(Object.isFrozen(d))
  assert.ok(Object.isFrozen(d.inputWarnings))
  assert.throws(() => {
    'use strict'
    d.decision = 'deny'
  })
})

test('deciding twice does not mutate the input or the config', () => {
  const input = bulkReadInput()
  const config = routingConfig()
  const inputBefore = JSON.stringify(input)
  const configBefore = JSON.stringify(config)
  decide(input, config)
  decide(input, config)
  assert.equal(JSON.stringify(input), inputBefore)
  assert.equal(JSON.stringify(config), configBefore)
})

test('the result key order is fixed, so a serialized decision is byte-stable', () => {
  const config = routingConfig()
  const shape = Object.keys(decide(bulkReadInput(), config))
  for (const input of corpus()) {
    assert.deepEqual(Object.keys(decide(input, config)), shape)
  }
})

test('the glob cache cannot make a repeated decision differ from the first', () => {
  // The matcher memoizes compiled patterns and clears the cache when it fills. A decision taken
  // after a clear must equal the one taken before it.
  const config = routingConfig()
  const input = bulkReadInput({ paths: ['/proj/src/a.ts'] })
  const first = decide(input, config)
  for (let i = 0; i < 400; i++) {
    decide(bulkReadInput({ paths: [`/proj/src/f${i}.ts`] }), routingConfig({ routing: { denyGlobs: [`**/f${i}-x.ts`] } }))
  }
  assert.deepEqual(decide(input, config), first)
})
