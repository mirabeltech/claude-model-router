/**
 * THE ESCALATION LADDER: Ollama, then Gemini, then Claude.
 *
 * `workers.bulkRead.ladder` is an ordered list of provider ids. An answer that does not survive
 * verification escalates to the next one, and when the ladder is exhausted the hook falls open —
 * so **Claude is always the last tier, and it costs nothing to implement.** A two-entry ladder is
 * three tiers.
 *
 * IT SHIPS EMPTY, and that is a decision rather than caution. An empty ladder is exactly the
 * single-worker behaviour this plugin has always had. A default that escalated would spend money
 * and send a file to a third party without being asked, which is what CLAUDE.md's eighth rule
 * forbids.
 *
 * THE TIME BUDGET IS THE LOAD-BEARING PART, not the loop. Measured on the development machine, a
 * 7B local model takes 80 to 113 seconds on a 900-byte file, against a hook deadline whose MAXIMUM
 * is 120 seconds. Without a budget check the ladder would spend the whole deadline on tier one,
 * start tier two, get aborted, and fall open anyway — leaving the developer waiting two minutes
 * for the Read they would have had immediately. That is strictly worse than not installing the
 * plugin, which is why the budget check is tested here as carefully as the escalation itself.
 *
 * Everything below drives the REAL hook with the REAL dispatcher shape, overriding only what each
 * tier returns. One mechanism per test.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { hookConfig, hookEnv, readStdin } from './helpers/hook-payload.mjs'
import { makeTempDir } from './helpers/telemetry-dir.mjs'

const PADDING = 'export const value = 1 // padding to reach a delegation-worthy size\n'

/** A worker answer that contradicts the file: invented symbols on invented lines. */
const FABRICATED =
  'This file declares `getUserByEmail` on line 412 and `AuditLogWriter` on line 980. ' +
  'It throws `"no such tenant in the registry"` when the lookup fails.'

/** An answer whose every claim holds against a file full of `value`. */
const GROUNDED = 'This file declares `value` on line 1 and repeats that declaration throughout.'

const okResult = (provider, text) => ({
  ok: true,
  status: 'ok',
  reason: 'completed',
  provider,
  model: `${provider}-model`,
  text,
  usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
  capabilities: null,
  attempts: 1,
  latencyMs: 5,
  error: null,
  promptVersion: 5,
  policyVersion: 1,
})

const errResult = (provider) => ({
  ok: false,
  status: 'error',
  reason: 'provider_error',
  provider,
  model: `${provider}-model`,
  text: null,
  usage: null,
  capabilities: null,
  attempts: 1,
  latencyMs: 5,
  error: { code: 'http_5xx', message: 'boom' },
  promptVersion: 5,
  policyVersion: 1,
})

/**
 * Drive one Read through the real hook.
 *
 * `tiers` is what each successive dispatch returns, and `seen` records the provider each attempt
 * was CONFIGURED with — which is how the ladder's order is asserted rather than assumed.
 */
async function drive(label, { ladder = [], tiers = [], config = {}, delays = [] } = {}) {
  const tmp = makeTempDir(label)
  const projectDir = path.join(tmp.dir, 'project')
  fs.mkdirSync(projectDir, { recursive: true })
  const target = path.join(projectDir, 'big.ts')
  fs.writeFileSync(target, PADDING.repeat(Math.ceil(48_000 / PADDING.length)))
  const transcript = path.join(projectDir, 't.jsonl')
  fs.writeFileSync(transcript, '')

  const seen = []
  const rows = []
  let i = 0
  try {
    const out = await runReadHook({
      raw: readStdin({ cwd: projectDir, transcript_path: transcript, tool_input: { file_path: target } }),
      config: hookConfig({ workers: { bulkRead: { ladder } }, ...config }),
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async ({ config: tierConfig }) => {
        seen.push(tierConfig?.workers?.bulkRead?.provider ?? tierConfig?.worker?.provider ?? null)
        const delay = delays[i] ?? 0
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        const tier = tiers[i] ?? tiers.at(-1)
        i += 1
        return tier
      },
      emit: (row) => {
        rows.push(row)
        return null
      },
    })
    return { ...out, seen, rows }
  } finally {
    tmp.cleanup()
  }
}

/* ------------------------------------------------------------- the shipped default */

test('an empty ladder is exactly the single-worker behaviour, and dispatches once', async () => {
  // The anchor. If this ever escalates, the default has changed and every "opt-in" claim in the
  // documentation is false.
  const r = await drive('lad-empty', { tiers: [okResult('mock', FABRICATED)] })
  assert.equal(r.seen.length, 1, 'exactly one dispatch')
  assert.equal(r.outcome, 'summary_unverified', 'a bad answer still falls open — it just has nowhere to escalate to')
  assert.equal(r.response, null)
  assert.equal(r.rows[0].escalation, null, 'and no escalation is recorded, because none happened')
})

/* --------------------------------------------------------------- escalating */

test('a fabricated first answer escalates to the second tier, in the configured order', async () => {
  const r = await drive('lad-escalate', {
    ladder: ['ollama', 'gemini'],
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', GROUNDED)],
  })
  assert.deepEqual(r.seen, ['ollama', 'gemini'], 'tried in the configured order')
  assert.equal(r.outcome, 'delegated', 'the second answer survived verification')
  assert.ok(r.response, 'and it reached Claude')
  assert.match(r.response.hookSpecificOutput.additionalContext, /repeats that declaration/)
})

test('the escalation is recorded, including the tokens the abandoned answer really spent', async () => {
  // A ladder that hid its own waste would understate what delegation costs. Those tokens were
  // consumed whether or not the answer was kept.
  const r = await drive('lad-record', {
    ladder: ['ollama', 'gemini'],
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', GROUNDED)],
  })
  const esc = r.rows[0].escalation
  assert.equal(esc.attempts, 2)
  assert.equal(esc.path, 'ollama>gemini')
  assert.equal(esc.wastedInputTokens, 1000, "tier one's input is waste, not spend-for-value")
  assert.equal(esc.wastedOutputTokens, 100)
})

test('ONE ROW PER READ, however many workers it took', async () => {
  // Load-bearing for every existing metric. The delegation rate, refusal rate and success rate all
  // have the routing-event population as their denominator, and one Read is one routing event
  // whatever the ladder did. A row per attempt would double-count all three.
  const r = await drive('lad-onerow', {
    ladder: ['ollama', 'gemini'],
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', GROUNDED)],
  })
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0].result.provider, 'gemini', 'the row describes the answer that was RETURNED')
})

test('a first tier that ERRORS escalates too, not only one that fabricates', async () => {
  // A dead daemon is the likeliest first-tier failure by far, and it is not a verification failure.
  const r = await drive('lad-error', {
    ladder: ['ollama', 'gemini'],
    tiers: [errResult('ollama'), okResult('gemini', GROUNDED)],
  })
  assert.deepEqual(r.seen, ['ollama', 'gemini'])
  assert.equal(r.outcome, 'delegated')
  assert.ok(r.response)
})

test('a good first answer stops the ladder — no second tier is paid for', async () => {
  // The common case, and the one that must not quietly cost twice.
  const r = await drive('lad-stop', {
    ladder: ['ollama', 'gemini'],
    tiers: [okResult('ollama', GROUNDED), okResult('gemini', GROUNDED)],
  })
  assert.deepEqual(r.seen, ['ollama'], 'gemini was never called')
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.rows[0].escalation.attempts, 1)
  assert.equal(r.rows[0].escalation.wastedInputTokens, null, 'nothing was wasted, so null — not 0')
})

test('every tier failing falls open to Claude, which is the implicit last tier', async () => {
  // THE WHOLE LADDER IS Ollama -> Gemini -> Claude, and the third tier is this: zero bytes out,
  // and the developer's own Read happens. It needs no code of its own.
  const r = await drive('lad-exhausted', {
    ladder: ['ollama', 'gemini'],
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', FABRICATED)],
  })
  assert.deepEqual(r.seen, ['ollama', 'gemini'])
  assert.equal(r.outcome, 'summary_unverified')
  assert.equal(r.response, null, 'zero bytes: Claude reads the file itself')
  assert.equal(r.rows[0].escalation.attempts, 2)
})

/* ----------------------------------------------------------- the time budget */

test('a tier is not started when too little deadline remains', async () => {
  // THE TEST THIS FILE EXISTS FOR. A 7B local model takes 80 to 113 seconds against a 120-second
  // maximum deadline, so without this the ladder burns the whole budget on tier one, starts tier
  // two, is aborted, and falls open anyway — two minutes for nothing.
  //
  // Here tier one consumes most of a short deadline. Tier two must NOT be attempted.
  const r = await drive('lad-budget', {
    ladder: ['ollama', 'gemini'],
    config: { hooks: { timeoutMs: 1000 } },
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', GROUNDED)],
    delays: [900],
  })
  assert.deepEqual(r.seen, ['ollama'], 'the second tier was never started')
  assert.equal(r.response, null, 'so it falls open, having wasted only tier one')
  assert.match(r.rows[0].escalation.path, /out_of_time/, 'and the row says why it stopped')
})

test('with the deadline intact, the same ladder DOES escalate', async () => {
  // The counterfactual, so the test above cannot pass for the wrong reason. Same tiers, same
  // answers, no delay — and now tier two runs.
  const r = await drive('lad-budget-ok', {
    ladder: ['ollama', 'gemini'],
    config: { hooks: { timeoutMs: 1000 } },
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', GROUNDED)],
  })
  assert.deepEqual(r.seen, ['ollama', 'gemini'])
  assert.equal(r.outcome, 'delegated')
})

/* --------------------------------------------------------------- robustness */

test('a ladder holding junk is filtered rather than dispatched', async () => {
  // `string[]` coercion accepts any strings, so the gate on usefulness is here.
  const r = await drive('lad-junk', {
    ladder: ['', '   ', 'ollama'],
    tiers: [okResult('ollama', GROUNDED)],
  })
  assert.deepEqual(r.seen, ['ollama'], 'empty and whitespace entries are dropped')
  assert.equal(r.outcome, 'delegated')
})

test('a ladder naming an unknown provider does not break the Read', async () => {
  // An unknown provider cannot be dispatched. The ladder must treat that as a failed tier and
  // carry on, never as an exception — CLAUDE.md's second rule.
  const r = await drive('lad-unknown', {
    ladder: ['not-a-provider', 'ollama'],
    tiers: [errResult('not-a-provider'), okResult('ollama', GROUNDED)],
  })
  assert.equal(r.outcome, 'delegated')
  assert.ok(r.response)
})

test('verification off means no escalation on a bad answer, because there is no signal', async () => {
  // `verify.enabled: false` removes the only signal the ladder escalates on for a successful call.
  // An errored tier still escalates — that needs no verifier.
  const r = await drive('lad-verify-off', {
    ladder: ['ollama', 'gemini'],
    config: { verify: { enabled: false, onSuspect: 'discard', maxUngroundedIdentifierRatio: 0.25 } },
    tiers: [okResult('ollama', FABRICATED), okResult('gemini', GROUNDED)],
  })
  assert.deepEqual(r.seen, ['ollama'], 'nothing told it to escalate')
  assert.equal(r.outcome, 'delegated', 'and the unverified answer is substituted')
})
