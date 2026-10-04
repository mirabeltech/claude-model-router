/**
 * Claude Code's Read payload as a routing input.
 *
 * This is the file that pins the mapping table in docs/hook-integration.md, field by field. The
 * invariant it exists to protect is CLAUDE.md's: an unmeasured quantity must arrive at the gate as
 * `null`, because `decide()` reads `null` pessimistically and reads a GUESS at face value. A hook
 * that filled in a plausible line count would be inventing the one number the gate trusts.
 *
 * The facts themselves — the stat, the transcript scan, the readiness check — are
 * `hook.facts.test.mjs`. This file only checks that whatever was measured lands in the right slot.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import { toRoutingInput } from '../plugins/model-router/lib/hook/adapter.mjs'
import { HOSTILE_VALUES, routingConfig } from './helpers/routing-input.mjs'
import { readPayload } from './helpers/hook-payload.mjs'

const input = (payloadOverrides = {}, facts = {}, env = {}) =>
  toRoutingInput({ payload: readPayload(payloadOverrides), facts, env })

/* -------------------------------------------------------------- the contract */

test('the routing input declares every field of the 16-field contract, including the null ones', () => {
  // "Key absent" and "key null" must never be two ways of saying the same thing, and the gate's
  // own normalizer would silently supply the pessimistic value for a key this adapter forgot.
  assert.deepEqual(Object.keys(input()).sort(), [
    'estimatedInputTokens',
    'fileCount',
    'fullRead',
    'inputBytes',
    'interactive',
    'latencySensitive',
    'lineCount',
    'paths',
    'projectPath',
    'recentlyEdited',
    'requestedOutput',
    'targetedRead',
    'taskType',
    'toolName',
    'workerAvailable',
    'workerUnavailableReason',
  ])
})

test('no field is ever undefined, because undefined and null must not both mean unknown', () => {
  for (const [k, v] of Object.entries(input())) assert.notEqual(v, undefined, k)
})

test('a Read is classified as a bulk read, which is the one lane this hook serves', () => {
  assert.equal(input().taskType, 'bulk_read')
  assert.equal(input().toolName, 'Read')
})

/* ------------------------------------------------------------------ measured */

test('the file count is one and the path is the one the payload named', () => {
  const got = input({ tool_input: { file_path: '/proj/src/a.ts' } })
  assert.equal(got.fileCount, 1)
  assert.deepEqual(got.paths, ['/proj/src/a.ts'])
})

test('byte size is whatever was measured, and null when it could not be', () => {
  assert.equal(input({}, { inputBytes: 40_000 }).inputBytes, 40_000)
  assert.equal(input({}, {}).inputBytes, null)
  assert.equal(input({}, { inputBytes: 0 }).inputBytes, 0, 'a measured zero is not unknown')
})

test('the project path comes from cwd, then CLAUDE_PROJECT_DIR, then null', () => {
  assert.equal(input({ cwd: '/proj' }).projectPath, '/proj')
  assert.equal(input({ cwd: '' }, {}, { CLAUDE_PROJECT_DIR: '/env' }).projectPath, '/env')
  assert.equal(input({ cwd: undefined }, {}, {}).projectPath, null)
})

test('targetedRead and fullRead are measured from the payload and are always opposites', () => {
  const full = input({ tool_input: { file_path: 'a.ts' } })
  assert.equal(full.targetedRead, false)
  assert.equal(full.fullRead, true)

  const targeted = input({ tool_input: { file_path: 'a.ts', offset: 10, limit: 20 } })
  assert.equal(targeted.targetedRead, true)
  assert.equal(targeted.fullRead, false)
})

test('recentlyEdited and worker availability are passed through from the facts verbatim', () => {
  const got = input({}, { recentlyEdited: false, workerAvailable: true, workerUnavailableReason: null })
  assert.equal(got.recentlyEdited, false)
  assert.equal(got.workerAvailable, true)
  assert.equal(got.workerUnavailableReason, null)
})

/* -------------------------------------------------------- deliberately unknown */

test('line count and estimated tokens are null, because measuring them needs the bytes', () => {
  // Reading a file to decide whether reading it was worth avoiding defeats the purpose. The
  // documented consequence is that `minBytes` alone answers the size question from a hook.
  assert.equal(input({}, { inputBytes: 999_999 }).lineCount, null)
  assert.equal(input({}, { inputBytes: 999_999 }).estimatedInputTokens, null)
})

test('requestedOutput is null, because a Read says nothing about the shape of the answer', () => {
  assert.equal(input().requestedOutput, null)
})

/* ------------------------------------------------------------------ asserted */

test('interactive and latencySensitive are asserted false, which is the hook layer assumption', () => {
  // Both read as `true` when unknown and both are terminal refusals, so an "honest unknown" hook
  // could never delegate and the shipped `routing.bulkRead.enforce: 'deny'` would be unreachable.
  // This is the ONLY place the plugin asserts a fact it did not measure; it is documented in
  // docs/hook-integration.md and the off-switches are elsewhere.
  assert.equal(input().interactive, false)
  assert.equal(input().latencySensitive, false)
})

test('the assumption is not configurable by accident: no payload field can flip it', () => {
  for (const v of HOSTILE_VALUES) {
    assert.equal(input({ interactive: v, latencySensitive: v }).interactive, false, String(v))
    assert.equal(input({ interactive: v, latencySensitive: v }).latencySensitive, false, String(v))
  }
})

/* ------------------------------------------------------------- hostile facts */

test('a hostile fact never throws and never becomes a favourable signal', () => {
  const config = routingConfig()
  for (const v of HOSTILE_VALUES) {
    const got = toRoutingInput({
      payload: readPayload(),
      facts: { inputBytes: v, recentlyEdited: v, workerAvailable: v, workerUnavailableReason: v },
    })
    // The gate is the authority on what a malformed value means; the adapter's job is to hand it
    // over untouched rather than to sanitise it into something plausible.
    assert.doesNotThrow(() => decide(got, config), String(v))
    const d = decide(got, config)
    if (v !== true) {
      assert.equal(d.delegate, false, `a worker availability of ${String(v)} must not delegate`)
    }
  }
})

/* --------------------------------------------------- it actually fits the gate */

test('a measured large full read of a ready worker delegates, end to end through decide()', () => {
  const d = decide(
    input({}, { inputBytes: 40_000, recentlyEdited: false, workerAvailable: true }),
    routingConfig(),
  )
  assert.equal(d.delegate, true)
  assert.equal(d.decision, 'deny', 'the shipped bulkRead lane blocks the tool call while delegating')
  assert.equal(d.mode, 'bulk-reader')
  assert.equal(d.reason, 'threshold_met')
  assert.deepEqual(d.inputWarnings, [], 'a well-formed adapter input provokes no complaint')
})

test('the adapter provokes no input warning for any ordinary Read', () => {
  const config = routingConfig()
  const cases = [
    {},
    { tool_input: { file_path: 'a.ts', offset: 1 } },
    { tool_input: { file_path: 'a.ts', limit: 50 } },
    { tool_input: { file_path: 'a.ts', pages: '1-5' } },
    { cwd: '' },
  ]
  for (const c of cases) {
    const d = decide(input(c, { inputBytes: 40_000, recentlyEdited: false, workerAvailable: true }), config)
    assert.deepEqual(d.inputWarnings, [], JSON.stringify(c))
  }
})
