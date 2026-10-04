/**
 * The policy snapshot, the off-switches, and the configuration surface.
 *
 * `readPolicy()` deliberately supplies no missing default. Everything that reaches the rule table
 * has already been through `resolveConfig()`, so a missing or wrong-typed leaf means the caller
 * handed the engine something that never was a config — which is CLAUDE.md's "malformed config"
 * case, and the required answer is to fail open rather than guess a threshold.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import { readPolicy } from '../plugins/model-router/lib/routing-policy.mjs'
import { DEFAULTS, SPEC, resolveConfig } from '../plugins/model-router/lib/config.mjs'
import { MALFORMED_CONFIGS, bulkReadInput, routingConfig } from './helpers/routing-input.mjs'

/* --------------------------------------------------------------- off-switches */

test('the master switch stops routing without blocking anything', () => {
  const d = decide(bulkReadInput(), routingConfig({ enabled: false }))
  assert.equal(d.decision, 'allow')
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'disabled')
  assert.equal(d.lane, null, 'a globally disabled router does not name a lane it never consulted')
})

test('disabling a lane stops that lane only', () => {
  const config = routingConfig({ routing: { bulkRead: { enabled: false } } })
  assert.equal(decide(bulkReadInput(), config).reason, 'disabled')
  assert.equal(decide(bulkReadInput({ taskType: 'code_write', toolName: 'Write' }), config).delegate, true)
})

test('a disabled lane still names the lane, so the dashboard can tell which switch is off', () => {
  const d = decide(bulkReadInput(), routingConfig({ routing: { bulkRead: { enabled: false } } }))
  assert.equal(d.lane, 'bulkRead')
})

test('enforce off disables the lane as surely as enabled false', () => {
  for (const over of [{ enabled: false }, { enforce: 'off' }]) {
    assert.equal(decide(bulkReadInput(), routingConfig({ routing: { bulkRead: over } })).reason, 'disabled')
  }
})

test('the master switch is checked before the task type, so a disabled router never explains itself', () => {
  // Rule ordering: the developer's own off-switch outranks every policy opinion below it. A
  // disabled gate that answered `task_type_excluded` would be offering a critique nobody asked for.
  const d = decide(bulkReadInput({ taskType: 'debugging' }), routingConfig({ enabled: false }))
  assert.equal(d.reason, 'disabled')
})

/* ------------------------------------------------------------ malformed config */

test('every malformed config fails open to allow + disabled', () => {
  for (const config of MALFORMED_CONFIGS) {
    const d = decide(bulkReadInput(), config)
    assert.equal(d.decision, 'allow', `config ${JSON.stringify(config)} must fail open`)
    assert.equal(d.delegate, false)
    assert.equal(d.reason, 'disabled')
  }
})

test('a malformed config says which leaf was unusable, so doctor can point at it', () => {
  assert.deepEqual(readPolicy(null).warnings, ['invalid_config:<root>'])
  assert.deepEqual(readPolicy({}).warnings, ['invalid_config:routing'])
  assert.deepEqual(readPolicy({ routing: {}, enabled: 'yes' }).warnings, ['invalid_config:enabled'])
})

test('the unusable-leaf code reaches the decision as an input warning', () => {
  assert.deepEqual(decide(bulkReadInput(), {}).inputWarnings, ['invalid_config:routing'])
})

test('a config missing the worker input ceiling is unusable rather than unbounded', () => {
  // Rule 13 cannot be evaluated without a ceiling, and an unevaluable safety check must not be
  // silently skipped. Requiring it folds the case into the existing malformed-config branch.
  const config = routingConfig()
  delete config.worker.maxInputBytes
  const d = decide(bulkReadInput(), config)
  assert.equal(d.reason, 'disabled')
  assert.ok(d.inputWarnings.includes('invalid_config:worker.maxInputBytes'))
})

test('a threshold of the wrong type makes the policy unusable rather than guessing a default', () => {
  const config = routingConfig()
  config.routing.bulkRead.minLines = 'lots'
  assert.equal(decide(bulkReadInput(), config).reason, 'disabled')
})

test('readPolicy never throws, whatever it is handed', () => {
  for (const config of [...MALFORMED_CONFIGS, Symbol.iterator, new Map(), new Date(0)]) {
    assert.doesNotThrow(() => readPolicy(config))
    assert.equal(readPolicy(config).policy.usable === true, false)
  }
})

/* ----------------------------------------------------------- the snapshot shape */

test('the policy snapshot is frozen all the way down', () => {
  const { policy } = readPolicy(routingConfig())
  assert.ok(Object.isFrozen(policy))
  assert.ok(Object.isFrozen(policy.lanes))
  assert.ok(Object.isFrozen(policy.lanes.bulkRead))
  assert.ok(Object.isFrozen(policy.denyGlobs))
  assert.ok(Object.isFrozen(policy.neverDelegate))
})

test('the snapshot copies the glob lists rather than aliasing the config', () => {
  const config = routingConfig()
  const { policy } = readPolicy(config)
  assert.notEqual(policy.denyGlobs, config.routing.denyGlobs)
  assert.deepEqual([...policy.denyGlobs], config.routing.denyGlobs)
})

test('only the bulk-read lane is marked as sized', () => {
  const { policy } = readPolicy(routingConfig())
  assert.equal(policy.lanes.bulkRead.sized, true)
  assert.equal(policy.lanes.codeWrite.sized, false)
})

/* ------------------------------------------------------ the configuration surface */

test('the two new routing keys are declared in the spec with env overrides', () => {
  assert.ok(SPEC['routing.bulkRead.minEstimatedTokens'])
  assert.ok(SPEC['routing.bulkRead.minFiles'])
  assert.equal(SPEC['routing.bulkRead.minEstimatedTokens'].env, 'CMR_MIN_ESTIMATED_TOKENS')
  assert.equal(SPEC['routing.bulkRead.minFiles'].env, 'CMR_MIN_FILES')
})

test('the token proxy is nullable and cannot be set to zero', () => {
  assert.equal(SPEC['routing.bulkRead.minEstimatedTokens'].nullable, true)
  assert.equal(SPEC['routing.bulkRead.minEstimatedTokens'].min, 1)
})

test('the five pre-existing bulk-read defaults are unchanged', () => {
  // A regression pin. Phase 3 added two keys; it must not have moved a shipped threshold, because
  // moving one requires a negative eval first.
  assert.equal(DEFAULTS.routing.bulkRead.enabled, true)
  assert.equal(DEFAULTS.routing.bulkRead.enforce, 'deny')
  assert.equal(DEFAULTS.routing.bulkRead.minLines, 350)
  assert.equal(DEFAULTS.routing.bulkRead.minBytes, 12000)
  assert.equal(DEFAULTS.routing.bulkRead.maxFiles, 25)
})

test('the shipped deny list still covers every category it claimed', () => {
  assert.deepEqual(DEFAULTS.routing.denyGlobs, [
    '**/.env*',
    '**/*secret*',
    '**/*credential*',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa*',
    '**/.git/**',
    '**/auth/**',
    '**/security/**',
  ])
  assert.deepEqual(DEFAULTS.routing.allowGlobs, [], 'nothing is pre-rescued')
})

test('an environment override reaches the gate', () => {
  // CI and kill switches have to win over a committed project config.
  const { config } = resolveConfig({
    layers: [{ name: 'project', data: { routing: { bulkRead: { minLines: 10 } } } }],
    env: { CMR_MIN_LINES: '5000' },
  })
  assert.equal(config.routing.bulkRead.minLines, 5000)
  assert.equal(decide(bulkReadInput({ lineCount: 900, inputBytes: 10, estimatedInputTokens: 10 }), config).reason, 'below_threshold')
})

test('an unparseable deny glob is reported rather than silently matching nothing', () => {
  // Someone writing a brace expansion would otherwise get no protection and no signal.
  const d = decide(bulkReadInput(), routingConfig({ routing: { denyGlobs: ['**/*.{pem,key}'] } }))
  assert.ok(d.inputWarnings.includes('unsupported_glob_syntax'))
})

test('a supported deny list produces no glob warning', () => {
  assert.deepEqual(decide(bulkReadInput(), routingConfig()).inputWarnings, [])
})
