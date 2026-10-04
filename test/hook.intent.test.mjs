/**
 * The hook end to end with intent on and off: what the worker is sent, and what is recorded.
 *
 * `intent.extraction.test.mjs` tests the reader in isolation and `task.builder.test.mjs` tests the
 * construction. This file is the one that runs the whole shipped path — the real hook, the real
 * gate, the real dispatcher, a real socket — and asserts the thing a developer would actually
 * notice: with the flag at its default the worker receives the request it has always received, and
 * with the flag on it receives the developer's question instead.
 *
 * It also pins the ordering that makes the phase safe. A refusing invocation must not read the
 * transcript for intent at all, because intent is extracted after the gate has ruled — so a file
 * the router declines never has prompt text assembled for it in the first place.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { BULK_READ_TASK } from '../plugins/model-router/lib/hook/adapter.mjs'
import { INTENT_PROMPT_VERSION, PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'
import { hookEnv, hookServerConfig, makeWorkspace, readStdin } from './helpers/hook-payload.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

let server
test.before(async () => {
  server = await startProviderServer()
})
test.after(async () => {
  await server?.close()
})

const QUESTION = 'find every deprecated handler in here and give me the line it is on'

/** A transcript whose newest record is a human prompt. */
function writePrompt(transcript, text = QUESTION) {
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', promptSource: 'user', promptId: 'p1', message: { role: 'user', content: text } }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: text, leafUuid: 'u1', sessionId: 's1' }),
    ].join('\n') + '\n',
    'utf8',
  )
}

/**
 * Run the shipped hook against the fixture server.
 *
 * `source` goes through the REAL resolver as a project layer, so a test cannot set a value the
 * SPEC would reject — which is the point of routing config through `hookServerConfig`.
 */
async function run({ source = undefined, maxChars = undefined, prompt = QUESTION, bytes = 40_000, configOverrides = {} } = {}) {
  const ws = makeWorkspace('intent', { bytes })
  if (prompt !== null) writePrompt(ws.transcript, prompt)
  const before = server.requests.length
  try {
    const taskIntent = {}
    if (source !== undefined) taskIntent.source = source
    if (maxChars !== undefined) taskIntent.maxChars = maxChars

    const out = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookServerConfig(server.url, {
        ...configOverrides,
        ...(Object.keys(taskIntent).length === 0 ? {} : { hooks: { taskIntent } }),
      }),
      env: hookEnv(server.url),
      emit: () => null,
    })
    const sent = server.requests.slice(before)
    return { ...out, sent, ws }
  } finally {
    ws.cleanup()
  }
}

/** The prompt the worker actually received on the wire. */
const promptOf = (sent) => sent[0].body.prompt

/* -------------------------------------------------------------- off by default */

test('by default the worker gets the frozen generic task and no requirements', async () => {
  const r = await run()
  assert.equal(r.outcome, 'delegated')
  assert.equal(r.sent.length, 1)

  const prompt = promptOf(r.sent)
  assert.ok(prompt.includes(BULK_READ_TASK), 'the generic task must still be the request')
  assert.equal(prompt.includes('# Requirements'), false)
  assert.equal(prompt.includes(QUESTION), false, "the developer's prompt must not be sent")
  assert.equal(r.result.promptVersion, PROMPT_VERSION)
})

test('an explicit source of none is the same as the default, and sends nothing extra', async () => {
  const r = await run({ source: 'none' })
  assert.equal(promptOf(r.sent).includes(QUESTION), false)
  assert.equal(r.result.promptVersion, PROMPT_VERSION)
})

/* ---------------------------------------------------------------- opted in */

test('with the flag on the worker is told what is actually being looked for', async () => {
  const r = await run({ source: 'transcript' })
  assert.equal(r.outcome, 'delegated')

  const prompt = promptOf(r.sent)
  assert.ok(prompt.includes(QUESTION), "the developer's question becomes the task")
  assert.match(prompt, /# Requirements/)
  assert.match(prompt, /EVERY occurrence/)
  assert.match(prompt, /line number/)
  // The generic literal is replaced, not appended to: two tasks in one prompt is two questions.
  assert.equal(prompt.includes(BULK_READ_TASK), false)
  assert.equal(r.result.promptVersion, INTENT_PROMPT_VERSION)
})

test('the file content is still sent exactly once, whichever construction is used', async () => {
  // The saving is unchanged by this phase: one delegation is one provider call carrying one copy
  // of the file. An intent-aware prompt that sent the corpus twice would halve the benefit.
  for (const source of ['none', 'transcript']) {
    const r = await run({ source })
    assert.equal(r.sent.length, 1, `${source} must make exactly one call`)
    const prompt = promptOf(r.sent)
    assert.equal(prompt.split('<<<<<<<<<< FILE').length - 1, 1, `${source} must fence one file`)
  }
})

test('the maxChars ceiling is enforced on the live path, not just in the reader', async () => {
  const long = 'why does this fail: ' + 'q'.repeat(2000)
  const r = await run({ source: 'transcript', maxChars: 50, prompt: long })
  const prompt = promptOf(r.sent)
  assert.ok(prompt.includes(long.slice(0, 50)))
  assert.equal(prompt.includes(long.slice(0, 80)), false, 'the ceiling must actually bind')
})

/* ------------------------------------------------------------ failing open */

test('an unusable transcript falls back to the generic task rather than failing the read', async () => {
  // Every one of these is a normal condition, not an error: a fresh session, a transcript that is
  // still being written, a format this build does not recognise. None may cost the developer a
  // delegation, and none may cost them their Read.
  //
  // A DELETED transcript is deliberately not in this list. It never reaches the worker at all:
  // `recentlyEdited` reads an unmeasurable transcript as `true`, which is a terminal refusal by
  // design, so the gate declines the read before intent is considered. That is asserted on its
  // own below rather than folded in here, because "refused by the gate" and "delegated with the
  // generic task" are different outcomes and conflating them would hide one.
  const cases = [
    ['no prompt record', (t) => fs.writeFileSync(t, JSON.stringify({ type: 'assistant' }) + '\n')],
    ['empty file', (t) => fs.writeFileSync(t, '')],
    ['unparseable', (t) => fs.writeFileSync(t, 'not json at all\n')],
    ['only a tool result', (t) => fs.writeFileSync(t, JSON.stringify({ type: 'user', toolUseResult: { stdout: 'x' }, message: { role: 'user', content: 'file bytes' } }) + '\n')],
    ['a future record type', (t) => fs.writeFileSync(t, JSON.stringify({ type: 'some-future-thing', prompt: 'unreachable' }) + '\n')],
  ]
  for (const [label, mutate] of cases) {
    const ws = makeWorkspace('intent-open')
    writePrompt(ws.transcript)
    mutate(ws.transcript)
    const before = server.requests.length
    try {
      const out = await runReadHook({
        raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
        config: hookServerConfig(server.url, { hooks: { taskIntent: { source: 'transcript' } } }),
        env: hookEnv(server.url),
        emit: () => null,
      })
      assert.equal(out.outcome, 'delegated', `${label} must still delegate`)
      const prompt = server.requests.slice(before)[0].body.prompt
      assert.ok(prompt.includes(BULK_READ_TASK), `${label} must fall back to the generic task`)
    } finally {
      ws.cleanup()
    }
  }
})

test('a missing transcript is refused by the gate, so intent never comes into it', async () => {
  // Pinned separately because the reason matters. `recentlyEdited` reads an unmeasurable
  // transcript as `true` — the pessimistic reading documented in what-we-do-not-delegate.md —
  // and that is a terminal refusal. Turning intent on does not change it, and should not: a
  // transcript the hook cannot read is a session it cannot reason about.
  const ws = makeWorkspace('intent-missing')
  fs.rmSync(ws.transcript, { force: true })
  try {
    const out = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookServerConfig(server.url, { hooks: { taskIntent: { source: 'transcript' } } }),
      env: hookEnv(server.url),
      emit: () => null,
    })
    assert.equal(out.outcome, 'not_delegated')
    assert.equal(out.decision.reason, 'recently_edited')
    assert.equal(out.response, null, 'and the original Read proceeds')
  } finally {
    ws.cleanup()
  }
})

/* -------------------------------------------------- the ordering, behaviourally */

test('a REFUSED read performs no intent read at all, because the gate rules first', async () => {
  // The behavioural half of the guarantee that evals.protected.test.mjs pins by call order. A
  // counting `fs` proves it: the gate's own transcript read for `recentlyEdited` happens, and
  // nothing reads it a second time on a path that never reaches the worker.
  const ws = makeWorkspace('intent-order', { bytes: 100 })
  writePrompt(ws.transcript)
  try {
    const real = fs
    let opens = 0
    const counting = {
      ...real,
      statSync: (...a) => real.statSync(...a),
      openSync: (p, ...a) => {
        if (String(p) === ws.transcript) opens += 1
        return real.openSync(p, ...a)
      },
      readSync: (...a) => real.readSync(...a),
      closeSync: (...a) => real.closeSync(...a),
      readFileSync: (...a) => real.readFileSync(...a),
    }

    // 100 bytes is far below minBytes, so the gate refuses on size.
    const refused = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookServerConfig(server.url, { hooks: { taskIntent: { source: 'transcript' } } }),
      env: hookEnv(server.url),
      fs: counting,
      emit: () => null,
    })
    assert.equal(refused.outcome, 'not_delegated')
    assert.equal(opens, 1, 'exactly one transcript read: the gate\'s own, and none for intent')
  } finally {
    ws.cleanup()
  }
})

/* ----------------------------------------------------------------- telemetry */

test('the row records the source and never the recovered text by default', async () => {
  // `storeQuestionText` is false by default, so opting in to USING a prompt does not opt in to
  // STORING it. The source is recorded because "which construction produced this row" is the one
  // thing a reader needs in order to not compare the incomparable.
  for (const [source, expected, promptVersion] of [
    [undefined, 'none', PROMPT_VERSION],
    ['transcript', 'transcript', INTENT_PROMPT_VERSION],
  ]) {
    const ws = makeWorkspace('intent-row')
    writePrompt(ws.transcript)
    const rows = []
    try {
      await runReadHook({
        raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
        config: hookServerConfig(server.url, source === undefined ? {} : { hooks: { taskIntent: { source } } }),
        env: hookEnv(server.url),
        emit: (inputs) => {
          rows.push(inputs)
          return null
        },
      })
    } finally {
      ws.cleanup()
    }
    assert.equal(rows.length, 1)
    assert.equal(rows[0].taskIntentSource, expected, `source ${source}`)
    assert.equal(rows[0].promptVersion, promptVersion, `promptVersion for source ${source}`)
  }
})

test('a refused read records no source, because no request was made', async () => {
  const ws = makeWorkspace('intent-gate', { bytes: 100 })
  writePrompt(ws.transcript)
  const rows = []
  try {
    await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookServerConfig(server.url, { hooks: { taskIntent: { source: 'transcript' } } }),
      env: hookEnv(server.url),
      emit: (inputs) => {
        rows.push(inputs)
        return null
      },
    })
  } finally {
    ws.cleanup()
  }
  // Null rather than 'none': 'none' would claim the generic task was sent, and nothing was.
  assert.equal(rows[0].taskIntentSource, null)
  assert.equal(rows[0].taskType, 'gate_block')
})

test('the question text offered to telemetry is the task that was actually built', async () => {
  const ws = makeWorkspace('intent-question')
  writePrompt(ws.transcript)
  const rows = []
  try {
    await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookServerConfig(server.url, { hooks: { taskIntent: { source: 'transcript' } } }),
      env: hookEnv(server.url),
      emit: (inputs) => {
        rows.push(inputs)
        return null
      },
    })
  } finally {
    ws.cleanup()
  }
  // Offered, not stored: the sink drops it unless storeQuestionText is on. Recording the generic
  // literal here while sending something else would make the row describe a request never made.
  assert.equal(rows[0].questionText, QUESTION)
})
