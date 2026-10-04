/**
 * Recovering intent from a session transcript: the off switch, the record shapes, and failing shut.
 *
 * THE OFF SWITCH IS THE FIRST TEST AND THE MOST IMPORTANT ONE. `hooks.taskIntent.source` defaults
 * to `none`, and with `none` this module must not open a file at all — not "read it and discard
 * the result", which would leak prompt text into process memory and cost a syscall on every Read.
 * The test asserts that through an injected `fs` that throws if touched, because a default that
 * is only honoured on the way out is not a default anyone can rely on.
 *
 * The record shapes are drawn from a live transcript of this project under Claude Code 2.1.177 and
 * are recorded in docs/claude-code-hook-contract.md. They are a runtime detail of a tool that
 * changes, which is exactly why every unexpected shape here must mean "no intent" rather than
 * "some intent" — a future format that this module half-understands would send a fragment of
 * something to a worker, and a fragment is worse than nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { extractTaskIntent } from '../plugins/model-router/lib/hook/intent.mjs'

let dir

test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-extract-'))
})

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A transcript file holding these records, one JSON object per line. */
let seq = 0
function transcript(records) {
  const file = path.join(dir, `t-${(seq += 1)}.jsonl`)
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  return file
}

/** The newest-prompt record Claude Code appends. */
const lastPrompt = (text) => ({ type: 'last-prompt', lastPrompt: text, leafUuid: 'u', sessionId: 's' })

/** A genuine human turn: tagged with promptSource, carrying no tool result. */
const humanTurn = (text, extra = {}) => ({
  type: 'user',
  promptId: 'p1',
  promptSource: 'user',
  message: { role: 'user', content: text },
  ...extra,
})

/** A tool-result turn. Also `type: 'user'`, which is the whole trap. */
const toolResult = (text) => ({
  type: 'user',
  message: { role: 'user', content: text },
  toolUseResult: { stdout: text },
  sourceToolAssistantUUID: 'a1',
})

const ON = { source: 'transcript' }

/* --------------------------------------------------------------- the off switch */

test('with the default source it returns null WITHOUT opening a file', () => {
  // An fs that throws on contact. The assertion is not merely that the answer is null; it is that
  // no disk was touched to produce it, which is what makes `none` free on the hot path.
  const hostile = {
    statSync: () => assert.fail('statSync must not be called when intent is off'),
    openSync: () => assert.fail('openSync must not be called when intent is off'),
    readSync: () => assert.fail('readSync must not be called when intent is off'),
    closeSync: () => assert.fail('closeSync must not be called when intent is off'),
  }
  const file = transcript([lastPrompt('find the deprecated handler')])

  assert.equal(extractTaskIntent(file, { fs: hostile }), null)
  assert.equal(extractTaskIntent(file, { fs: hostile, source: 'none' }), null)
  // An unrecognised source is off, not on. Failing open here would mean a typo'd config value
  // started forwarding prompt text.
  assert.equal(extractTaskIntent(file, { fs: hostile, source: 'TRANSCRIPT' }), null)
  assert.equal(extractTaskIntent(file, { fs: hostile, source: 'llm' }), null)
})

test('with the switch on, a real transcript yields the prompt', () => {
  const file = transcript([lastPrompt('find every deprecated handler and give me the line')])
  assert.deepEqual(extractTaskIntent(file, { fs, ...ON }), {
    task: 'find every deprecated handler and give me the line',
    source: 'transcript',
  })
})

/* ------------------------------------------------------------ the record shapes */

test('the newest prompt wins, because it is the one that explains the read happening now', () => {
  const file = transcript([lastPrompt('an older question'), lastPrompt('the current question')])
  assert.equal(extractTaskIntent(file, { fs, ...ON }).task, 'the current question')
})

test('a human turn is recognised when no last-prompt record is present', () => {
  const file = transcript([humanTurn('what does this module do')])
  assert.equal(extractTaskIntent(file, { fs, ...ON }).task, 'what does this module do')
})

test('a content-block array is flattened, and only its text blocks are taken', () => {
  const file = transcript([
    humanTurn(null, {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'first part' },
          { type: 'image', source: { data: 'ignored' } },
          { type: 'text', text: 'second part' },
        ],
      },
    }),
  ])
  assert.equal(extractTaskIntent(file, { fs, ...ON }).task, 'first part\nsecond part')
})

test('a TOOL RESULT is never mistaken for a question, however user-shaped it is', () => {
  // The sharpest trap in the format. A tool result is `type: 'user'` with `role: 'user'`, so a
  // reader that keyed on either would feed a file's own contents back as the question about it —
  // and the answer would be a summary of a summary with no one the wiser.
  const file = transcript([
    lastPrompt('the real question'),
    toolResult('export const RETRY_CEILING = 7 // contents of the file that was just read'),
  ])
  const got = extractTaskIntent(file, { fs, ...ON })
  assert.equal(got.task, 'the real question')
  assert.equal(got.task.includes('RETRY_CEILING'), false)
})

test('a tool result alone yields nothing at all, rather than yielding itself', () => {
  const file = transcript([toolResult('file contents')])
  assert.equal(extractTaskIntent(file, { fs, ...ON }), null)
})

test("a subagent's turn is skipped, because its prompt is not the developer's", () => {
  const file = transcript([
    humanTurn('what the developer asked'),
    lastPrompt('what a subagent was told'),
  ])
  // The sidechain record is skipped, so the walk continues past it to the human turn.
  const side = transcript([
    humanTurn('what the developer asked'),
    { ...lastPrompt('what a subagent was told'), isSidechain: true },
  ])
  assert.equal(extractTaskIntent(file, { fs, ...ON }).task, 'what a subagent was told')
  assert.equal(extractTaskIntent(side, { fs, ...ON }).task, 'what the developer asked')
})

/* --------------------------------------------------------------- the boundary */

test('the text is clamped to maxChars, and the ceiling is honoured exactly', () => {
  const file = transcript([lastPrompt('x'.repeat(5000))])
  assert.equal(extractTaskIntent(file, { fs, ...ON, maxChars: 40 }).task.length, 40)
  assert.equal(extractTaskIntent(file, { fs, ...ON, maxChars: 600 }).task.length, 600)
})

test('a zero or nonsensical ceiling means nothing may cross, not that nothing is enforced', () => {
  const file = transcript([lastPrompt('a question')])
  for (const maxChars of [0, -1, null, 'lots', 1.5]) {
    assert.equal(extractTaskIntent(file, { fs, ...ON, maxChars }), null, `maxChars=${maxChars}`)
  }
})

test('only the tail is examined, so cost does not grow with session length', () => {
  // The prompt sits before a megabyte of later records, so a bounded read cannot see it. Null is
  // the correct answer: the alternative is a read whose cost is a function of how long the
  // developer has been working.
  const noise = Array.from({ length: 4000 }, (_, i) => toolResult(`chunk ${i} ${'y'.repeat(200)}`))
  const file = transcript([lastPrompt('buried far behind the window'), ...noise])
  assert.equal(extractTaskIntent(file, { fs, ...ON, maxBytes: 4096 }), null)
  // And with a window large enough to reach it, the same transcript answers.
  assert.equal(
    extractTaskIntent(file, { fs, ...ON, maxBytes: 64 * 1024 * 1024 }).task,
    'buried far behind the window',
  )
})

test('the half line at the tail boundary is dropped rather than parsed', () => {
  const file = transcript([lastPrompt('the first question'), lastPrompt('the second question')])
  const size = fs.statSync(file).size
  // A window ten bytes short of the whole file, so the FIRST record is a fragment and the second
  // is intact. The surviving whole record must be the answer and the fragment must contribute
  // nothing — including not throwing, which is what an unguarded JSON.parse of a fragment does.
  const got = extractTaskIntent(file, { fs, ...ON, maxBytes: size - 10 })
  assert.equal(got.task, 'the second question')

  // And the whole file read whole still finds the newest record, which is the case the `floor`
  // guard exists for: a short transcript must not lose its only prompt to a fragment rule.
  assert.equal(extractTaskIntent(file, { fs, ...ON }).task, 'the second question')
})

/* ------------------------------------------------------------- failing shut */

test('every unusable transcript yields null, and none of them throws', () => {
  const empty = transcript([])
  const blank = path.join(dir, 'blank.jsonl')
  fs.writeFileSync(blank, '', 'utf8')
  const garbage = path.join(dir, 'garbage.jsonl')
  fs.writeFileSync(garbage, 'not json\nstill not json\n{"unterminated":\n', 'utf8')
  const futureFormat = transcript([{ type: 'some-future-record', payload: { prompt: 'unreachable' } }])
  const noText = transcript([lastPrompt(''), lastPrompt('   '), humanTurn(null, { message: {} })])

  for (const [label, file] of [
    ['no path', null],
    ['empty string path', ''],
    ['whitespace path', '   '],
    ['missing file', path.join(dir, 'does-not-exist.jsonl')],
    ['a directory', dir],
    ['no records', empty],
    ['zero bytes', blank],
    ['unparseable lines', garbage],
    ['an unrecognised record type', futureFormat],
    ['records with no usable text', noText],
  ]) {
    assert.equal(extractTaskIntent(file, { fs, ...ON }), null, `${label} must yield null`)
  }
})

test('an fs that throws on every call is survived, not propagated', () => {
  // This runs on the hot path while a developer waits on a tool call. A thrown error here would
  // be a broken session rather than a missed optimisation.
  const throwing = {
    statSync: () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    },
    openSync: () => {
      throw new Error('nope')
    },
    readSync: () => {
      throw new Error('nope')
    },
    closeSync: () => {
      throw new Error('nope')
    },
  }
  assert.equal(extractTaskIntent('/anything', { fs: throwing, ...ON }), null)
})

/* ---------------------------------------------------------------- determinism */

test('the same transcript yields the same intent every time', () => {
  const file = transcript([lastPrompt('a stable question')])
  const first = extractTaskIntent(file, { fs, ...ON })
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(extractTaskIntent(file, { fs, ...ON }), first, `drifted on run ${i}`)
  }
})
