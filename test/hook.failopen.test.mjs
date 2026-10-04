/**
 * The fail-open matrix: one test per row of the table in docs/hook-integration.md.
 *
 * This is the file that enforces CLAUDE.md's second non-negotiable at the integration layer. The
 * gate itself fails open by returning `allow`; the HOOK fails open by writing no bytes, which is
 * indistinguishable from not being installed. Every row below asserts the same two things —
 * `response === null` and no exception — because there is exactly one safe answer to everything
 * going wrong, and it is "let Claude read the file".
 *
 * A row that starts passing for a different reason is as much a regression as one that fails, so
 * the outcome code is asserted alongside the response.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { OUTCOMES, runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { hookConfig, hookEnv, makeWorkspace, readPayload, readStdin } from './helpers/hook-payload.mjs'
import { HOSTILE_VALUES } from './helpers/routing-input.mjs'

const okResult = {
  ok: true,
  status: 'ok',
  reason: 'completed',
  provider: 'mock',
  model: 'mock-1',
  text: 'A SUMMARY',
  usage: null,
  capabilities: null,
  attempts: 1,
  latencyMs: 5,
  error: null,
  promptVersion: 1,
  policyVersion: 1,
}

/** Run over a delegation-worthy workspace, overriding one thing at a time. */
async function run(overrides = {}) {
  const ws = makeWorkspace('failopen', { bytes: 40_000 })
  try {
    const out = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => okResult,
      emit: () => null,
      ...overrides,
    })
    return { ...out, ws }
  } finally {
    ws.cleanup()
  }
}

/** The baseline must DELEGATE, or every test below passes for the wrong reason. */
test('the baseline delegates, so each row below isolates exactly one failure', async () => {
  const r = await run()
  assert.equal(r.outcome, 'delegated')
  assert.ok(r.response)
})

/* -------------------------------------------------------------- off-switches */

test('hooks disabled falls open', async () => {
  const r = await run({ config: hookConfig({ hooks: { enabled: false } }) })
  assert.equal(r.outcome, 'hooks_disabled')
  assert.equal(r.response, null)
})

test('routing disabled falls open', async () => {
  const r = await run({ config: hookConfig({ enabled: false }) })
  assert.equal(r.outcome, 'routing_disabled')
  assert.equal(r.response, null)
})

test('a config that never came out of the resolver falls open without throwing', async () => {
  for (const config of [undefined, null, 0, 42, 'x', true, [], {}, { hooks: {} }, { hooks: { enabled: true } }]) {
    const r = await run({ config })
    assert.equal(r.response, null, JSON.stringify(config))
    assert.ok(OUTCOMES.includes(r.outcome), `${r.outcome} is a declared outcome`)
  }
})

test('an unusable config with hooks switched on still falls open at the gate', async () => {
  // `readPolicy()` supplies no missing default: a leaf that is absent means the caller handed the
  // engine something that never was a config, and guessing a threshold there is worse than
  // refusing. The hook must survive that rather than crash on the decision it gets back.
  const r = await run({ config: { enabled: true, hooks: { enabled: true }, routing: {} } })
  assert.equal(r.response, null)
  assert.equal(r.decision?.reason, 'disabled')
})

/* --------------------------------------------------------------- bad stdin */

test('every malformed stdin falls open', async () => {
  const cases = [
    ['', 'empty_stdin'],
    ['nonsense', 'unparseable_stdin'],
    ['[]', 'not_an_object'],
    ['null', 'not_an_object'],
  ]
  for (const [raw, outcome] of cases) {
    const r = await run({ raw })
    assert.equal(r.outcome, outcome, raw)
    assert.equal(r.response, null, raw)
    assert.equal(r.decision, null, 'the gate is never consulted about a payload we could not read')
  }
})

test('stdin that is not a string at all falls open', async () => {
  for (const raw of HOSTILE_VALUES) {
    const r = await run({ raw })
    assert.equal(r.response, null, String(raw))
  }
})

test('a payload for another tool or another event falls open', async () => {
  assert.equal((await run({ raw: readStdin({ tool_name: 'Write' }) })).outcome, 'wrong_tool')
  assert.equal((await run({ raw: readStdin({ hook_event_name: 'PostToolUse' }) })).outcome, 'wrong_event')
  const { tool_input, ...noInput } = readPayload()
  assert.equal(typeof tool_input, 'object')
  assert.equal((await run({ raw: JSON.stringify(noInput) })).outcome, 'no_tool_input')
  assert.equal((await run({ raw: readStdin({ tool_input: {} }) })).outcome, 'no_file_path')
})

/* ----------------------------------------------------- unmeasurable facts */

test('a file that cannot be stat-ed falls open through below_threshold', async () => {
  const ws = makeWorkspace('failopen-missing')
  try {
    const r = await runReadHook({
      raw: readStdin({
        cwd: ws.dir,
        transcript_path: ws.transcript,
        tool_input: { file_path: path.join(ws.dir, 'not-here.ts') },
      }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => okResult,
      emit: () => null,
    })
    assert.equal(r.decision.reason, 'below_threshold', 'an unmeasured size satisfies no proxy')
    assert.equal(r.response, null)
  } finally {
    ws.cleanup()
  }
})

test('a directory handed in as a file path falls open', async () => {
  const ws = makeWorkspace('failopen-dir')
  try {
    const r = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.dir } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => okResult,
      emit: () => null,
    })
    assert.equal(r.response, null)
  } finally {
    ws.cleanup()
  }
})

test('an unreadable transcript falls open, because the safety rule cannot be checked', async () => {
  const r = await run({ raw: readStdin({ transcript_path: '/no/such/transcript.jsonl' }) })
  assert.equal(r.response, null)
  assert.equal(r.decision.reason, 'recently_edited')
})

test('a filesystem that throws on everything falls open', async () => {
  const boom = () => {
    throw new Error('EIO')
  }
  const r = await run({ fs: { statSync: boom, readFileSync: boom, openSync: boom, readSync: boom, closeSync: boom } })
  assert.equal(r.response, null)
})

/* ------------------------------------------------------- the layers throwing */

test('a throwing gate falls open, even though the gate is specified never to throw', async () => {
  const r = await run({
    decideImpl: () => {
      throw new Error('impossible')
    },
  })
  assert.equal(r.outcome, 'routing_threw')
  assert.equal(r.response, null)
})

test('a gate returning nonsense falls open rather than being trusted', async () => {
  for (const decision of [null, undefined, 42, 'deny', {}, { delegate: true }, { decision: 'deny' }]) {
    const r = await run({ decideImpl: () => decision })
    assert.equal(r.response, null, JSON.stringify(decision))
  }
})

test('a throwing dispatcher falls open', async () => {
  const r = await run({
    dispatchImpl: async () => {
      throw new Error('provider exploded')
    },
  })
  assert.equal(r.outcome, 'hook_threw')
  assert.equal(r.response, null)
})

test('a dispatcher returning nonsense falls open', async () => {
  for (const result of [null, undefined, 42, 'ok', {}, { status: 'ok' }, { status: 'ok', text: '' }]) {
    const r = await run({ dispatchImpl: async () => result })
    assert.equal(r.response, null, JSON.stringify(result))
  }
})

test('every dispatch failure status falls open', async () => {
  for (const status of ['error', 'skipped']) {
    const r = await run({ dispatchImpl: async () => ({ ...okResult, ok: false, status, error: { code: 'x' } }) })
    assert.equal(r.outcome, 'worker_failed', status)
    assert.equal(r.response, null, status)
  }
})

test('an answer that is blank falls open, so an empty summary never replaces a file', async () => {
  for (const text of [null, undefined, '', '   ', 42, {}]) {
    const r = await run({ dispatchImpl: async () => ({ ...okResult, text }) })
    assert.equal(r.outcome, 'empty_answer', JSON.stringify(text))
    assert.equal(r.response, null)
  }
})

/* ------------------------------------------------------------- telemetry */

test('a throwing telemetry sink does not change the response', async () => {
  // The whole point of the ordering in run.mjs: the response is decided before the row is
  // written, and writing the row cannot reach back and alter it.
  const thrower = () => {
    throw new Error('disk full')
  }
  const delegated = await run({ emit: thrower })
  assert.equal(delegated.outcome, 'delegated')
  assert.ok(delegated.response, 'a successful delegation survives a failed write')
  assert.equal(delegated.response.hookSpecificOutput.additionalContext, 'A SUMMARY')

  const refused = await run({ emit: thrower, config: hookConfig({ routing: { bulkRead: { enforce: 'off' } } }) })
  assert.equal(refused.response, null, 'and a refusal is still a refusal')
})

test('a telemetry sink returning nonsense does not change the response', async () => {
  for (const ret of [undefined, null, 0, 'x', {}]) {
    const r = await run({ emit: () => ret })
    assert.equal(r.outcome, 'delegated', JSON.stringify(ret))
    assert.ok(r.response)
  }
})

/* --------------------------------------------------------------- invariants */

test('the hook never throws, for any combination of broken input', async () => {
  const configs = [undefined, null, {}, hookConfig(), hookConfig({ enabled: false })]
  const raws = ['', 'nope', '[]', readStdin(), readStdin({ tool_input: {} })]
  for (const config of configs) {
    for (const raw of raws) {
      await assert.doesNotReject(() => run({ config, raw }), `${JSON.stringify(config)} / ${raw}`)
    }
  }
})

test('every outcome the hook can report is a declared one', async () => {
  const seen = new Set()
  seen.add((await run()).outcome)
  seen.add((await run({ raw: '' })).outcome)
  seen.add((await run({ config: hookConfig({ hooks: { enabled: false } }) })).outcome)
  seen.add((await run({ config: hookConfig({ enabled: false }) })).outcome)
  seen.add((await run({ raw: readStdin({ tool_name: 'Bash' }) })).outcome)
  seen.add((await run({ decideImpl: () => { throw new Error('x') } })).outcome)
  seen.add((await run({ dispatchImpl: async () => { throw new Error('x') } })).outcome)
  for (const outcome of seen) assert.ok(OUTCOMES.includes(outcome), outcome)
})

test('the response, when there is one, is always serializable JSON', async () => {
  const r = await run()
  assert.doesNotThrow(() => JSON.stringify(r.response))
  assert.deepEqual(JSON.parse(JSON.stringify(r.response)), r.response)
})
