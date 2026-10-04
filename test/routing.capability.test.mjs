/**
 * THE BOUNDARY. Context capability is not, and must not become, a routing input.
 *
 * This file asserts an ABSENCE, which is an unusual thing to test and the reason it exists. Phase
 * 8 taught the system that a model has a context window and that a request can be too big for it.
 * The obvious next step — "so let the gate refuse early" — is the one that must not be taken, and
 * nothing in the code says so on its own. A future reader with a plausible optimisation in hand
 * would find no obstacle. This is the obstacle.
 *
 * WHY IT IS FORBIDDEN. A per-model window is knowable three ways and the gate can use none:
 *
 *   measured    needs a network call. decide() makes none (CLAUDE.md #2).
 *   table       needs the RESOLVED model, i.e. importing lib/dispatch -> lib/providers into the
 *               gate, which puts a provider module behind every tool call.
 *   configured  the gate already reads, in the only unit it has: policy.workerMaxInputBytes,
 *               compared against raw inputBytes under reason `over_max_input_bytes`.
 *
 * So the division is: THE GATE ENFORCES WHAT CONFIG CAN EXPRESS IN BYTES; dispatch() ENFORCES
 * WHAT CAPABILITY CAN EXPRESS IN TOKENS. Everything below pins one half of that sentence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import {
  DECIDE_REASONS,
  WORKER_UNAVAILABLE_REASONS,
  readPolicy,
} from '../plugins/model-router/lib/routing-policy.mjs'
import { resolveConfig } from '../plugins/model-router/lib/config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugins', 'model-router', 'lib')

const read = (...p) => fs.readFileSync(path.join(LIB, ...p), 'utf8')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const importsOf = (src) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])

const config = () => resolveConfig({ layers: [{ name: 'test', data: { enabled: true } }] }).config

const baseInput = {
  taskType: 'bulk_read',
  toolName: 'Read',
  fileCount: 1,
  lineCount: 400,
  inputBytes: 20_000,
  targetedRead: false,
  fullRead: true,
  recentlyEdited: false,
  latencySensitive: false,
  interactive: false,
  paths: ['src/a.ts'],
  projectPath: '/p',
  workerAvailable: true,
}

/* ------------------------------------------------- the gate's shape is unchanged */

test('decide() still takes exactly sixteen fields — no context field was added', () => {
  // The declared shape. A seventeenth field here would mean the gate had started reasoning about
  // something it cannot measure without I/O.
  const d = decide(baseInput, config())
  assert.equal(d.delegate, true, 'the fixture must actually delegate, or this proves nothing')

  const accepted = [
    'taskType', 'toolName',
    'fileCount', 'lineCount', 'inputBytes', 'estimatedInputTokens',
    'targetedRead', 'fullRead', 'recentlyEdited', 'latencySensitive', 'interactive',
    'requestedOutput', 'paths', 'projectPath',
    'workerAvailable', 'workerUnavailableReason',
  ]
  assert.equal(accepted.length, 16)

  // Anything NOT on that list must be inert: passing it changes no decision.
  for (const smuggled of [
    'contextTokens', 'contextWindow', 'modelContextLimit', 'maxOutputTokens',
    'capability', 'capabilitySource', 'capabilityStatus', 'effectiveInputCapacity',
    'contextBudget', 'provider', 'model',
  ]) {
    const withExtra = decide({ ...baseInput, [smuggled]: 1 }, config())
    assert.deepEqual(
      { ...withExtra, inputWarnings: [...withExtra.inputWarnings] },
      { ...d, inputWarnings: [...d.inputWarnings] },
      `"${smuggled}" changed a routing decision`,
    )
  }
})

test('the reason vocabulary gained nothing — a context refusal is not a routing reason', () => {
  // `context_exceeded` lives in DISPATCH_REASONS. If it ever appears here, the gate has taken on
  // a judgement it cannot make without a network call or a provider import.
  for (const forbidden of [
    'context_exceeded',
    'over_context',
    'over_context_tokens',
    'context_unknown',
    'capability_unknown',
    'model_too_small',
  ]) {
    assert.equal(DECIDE_REASONS.includes(forbidden), false, `${forbidden} reached DECIDE_REASONS`)
  }
})

test('worker unavailability still has exactly two causes, and a big file is neither', () => {
  // The tempting seam: report `worker_not_ready` for an over-large file. It would report a GLOBAL
  // condition for a PER-FILE fact, and make every small read in the session look like a broken
  // worker — so the list stays closed at two.
  assert.deepEqual([...WORKER_UNAVAILABLE_REASONS], ['worker_not_ready', 'budget_exceeded'])
})

test('readPolicy still reads bytes, and knows nothing about tokens or a window', () => {
  const { policy } = readPolicy(config())
  assert.equal(policy.usable, true)
  assert.equal(typeof policy.workerMaxInputBytes, 'number')
  for (const forbidden of ['contextTokens', 'workerContextTokens', 'maxOutputTokens', 'capability', 'effectiveInputCapacityTokens']) {
    assert.equal(forbidden in policy, false, `readPolicy exposed ${forbidden} to the gate`)
  }
})

test('the gate refuses an oversized file in BYTES, under its own reason', () => {
  // The half of the division that the gate DOES own. This is what it looks like when config can
  // express the limit.
  const cfg = resolveConfig({
    layers: [{ name: 'test', data: { enabled: true, worker: { maxInputBytes: 10_000 } } }],
  }).config
  const d = decide({ ...baseInput, inputBytes: 20_000 }, cfg)
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'over_max_input_bytes')
})

/* ------------------------------------------------------ the import boundary */

test('the routing layer imports no provider, no dispatcher and no budget module', () => {
  // The structural enforcement. Even the pure modules are excluded: importing context-budget.mjs
  // would be harmless today and would be the first step toward a gate that needs a window.
  for (const file of ['routing.mjs', 'routing-policy.mjs']) {
    const specs = importsOf(stripComments(read(file)))
    for (const spec of specs) {
      assert.equal(/providers/.test(spec), false, `${file} imports ${spec}`)
      assert.equal(/dispatch/.test(spec), false, `${file} imports ${spec}`)
      assert.equal(/context-budget/.test(spec), false, `${file} imports ${spec}`)
      assert.equal(/capability/.test(spec), false, `${file} imports ${spec}`)
      assert.equal(/telemetry/.test(spec), false, `${file} imports ${spec}`)
    }
  }
})

test('the routing layer makes no network call and reads no clock', () => {
  for (const file of ['routing.mjs', 'routing-policy.mjs']) {
    const code = stripComments(read(file))
    assert.equal(/\bfetch\s*\(/.test(code), false, `${file} calls fetch`)
    assert.equal(/Date\.now|new Date\(/.test(code), false, `${file} reads the clock`)
    assert.equal(/\bawait\b|\basync\b/.test(code), false, `${file} is not synchronous`)
    assert.equal(/node:/.test(code), false, `${file} imports a builtin`)
  }
})

test('decide() is synchronous — it cannot await a capability probe even if asked to', () => {
  // The property that makes the whole argument structural rather than careful: there is nowhere
  // in decide() for a network call to go.
  const d = decide(baseInput, config())
  assert.equal(typeof d.then, 'undefined', 'decide() returned a thenable')
  assert.equal(decide.constructor.name, 'Function', 'decide() is an AsyncFunction')
})

/* ------------------------------------------------ config knows, the gate does not */

test('the new config leaves exist but are invisible to the gate', () => {
  // providers.ollama.contextTokens is real configuration. It is simply not something the routing
  // engine consults — nothing in readPolicy's flat snapshot carries it.
  const cfg = resolveConfig({
    layers: [{ name: 'test', data: { enabled: true, providers: { ollama: { contextTokens: 256 } } } }],
  }).config
  assert.equal(cfg.providers.ollama.contextTokens, 256)

  const tight = decide(baseInput, cfg)
  const loose = decide(baseInput, config())
  assert.equal(tight.delegate, loose.delegate, 'a context leaf moved a routing decision')
  assert.equal(tight.reason, loose.reason)
})

test('a 12k-token file still delegates at the gate, and is refused later by dispatch', () => {
  // The end-to-end statement of the division, as one assertion. The gate says yes on bytes; the
  // model's window is somebody else's problem, and dispatch.context.test.mjs is where it is had.
  const d = decide({ ...baseInput, inputBytes: 48_164 }, config())
  assert.equal(d.delegate, true)
  assert.equal(d.reason, 'threshold_met')
})
