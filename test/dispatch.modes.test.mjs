/**
 * Prompt construction: deterministic, versioned, and built only from what the caller supplied.
 *
 * Two properties carry the weight. DETERMINISM, because an unreproducible request cannot be
 * compared across a threshold change, and because the suite asserts on prompt bytes. And
 * CONTAINMENT: the worker is told it has no filesystem, and the builder genuinely has none — a
 * mode that could name its own inputs would turn a gated read into an ungated one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INTENT_PROMPT_VERSION,
  MAX_FILES,
  MODES,
  PROMPT_VERSION,
  isKnownMode,
} from '../plugins/model-router/lib/dispatch/modes.mjs'
import {
  bulkReadIntentPayload,
  bulkReadPayload,
  codeWriteIntentPayload,
  codeWritePayload,
} from './helpers/dispatch-input.mjs'
import { buildWorkerTask } from '../plugins/model-router/lib/dispatch/task.mjs'

const bulk = MODES['bulk-reader']
const code = MODES['code-writer']

/**
 * Every payload shape the two templates can be handed, so the determinism and CR rules below
 * cover the intent-bearing sections too. An earlier version of this file iterated the two plain
 * payloads only, which meant the repo's two most load-bearing template invariants stopped at
 * the point where new sections were added.
 */
const ALL_PAYLOADS = () => [
  [bulk, bulkReadPayload()],
  [code, codeWritePayload()],
  [bulk, bulkReadIntentPayload()],
  [code, codeWriteIntentPayload()],
]

/* ----------------------------------------------------------------- determinism */

test('the same input builds a byte-identical prompt every time', () => {
  for (const [mode, payload] of ALL_PAYLOADS()) {
    const first = mode.build(payload)
    for (let i = 0; i < 50; i += 1) {
      const next = mode.build(payload)
      assert.equal(next.prompt, first.prompt, `${mode.id} prompt drifted on run ${i}`)
      assert.equal(next.system, first.system, `${mode.id} system drifted on run ${i}`)
    }
  }
})

test('no prompt contains a carriage return, so the two CI platforms agree byte for byte', () => {
  // core.autocrlf is on and there is no .gitattributes, so a multi-line template literal would
  // hold \r\n in a Windows checkout and \n in a Linux one. Every template here uses join('\n').
  for (const [mode, payload] of ALL_PAYLOADS()) {
    const { system, prompt } = mode.build(payload)
    assert.equal(system.includes('\r'), false, `${mode.id} system prompt holds a CR`)
    assert.equal(prompt.includes('\r'), false, `${mode.id} prompt holds a CR`)
  }
})

test('a prompt version is declared once for the layer and is a positive integer', () => {
  assert.ok(Number.isInteger(PROMPT_VERSION) && PROMPT_VERSION > 0)
})

/* ---------------------------------------------------------------- bulk-reader */

test('the bulk-reader prompt carries every file, its path, and the task', () => {
  const payload = bulkReadPayload({
    files: [
      { path: 'a/one.js', content: 'ONE_MARKER' },
      { path: 'b/two.js', content: 'TWO_MARKER' },
      { path: 'c/three.js', content: 'THREE_MARKER' },
    ],
    task: 'TASK_MARKER',
  })
  const { prompt } = bulk.build(payload)
  for (const marker of ['ONE_MARKER', 'TWO_MARKER', 'THREE_MARKER', 'TASK_MARKER']) {
    assert.ok(prompt.includes(marker), `${marker} is missing from the prompt`)
  }
  for (const file of payload.files) {
    assert.ok(prompt.includes(file.path), `${file.path} is missing — a path is how the worker cites a claim`)
  }
  assert.match(prompt, /# Files \(3\)/)
})

test('files keep the order the caller gave them', () => {
  // The caller's order is information — it is usually read order — so it is preserved rather
  // than sorted. Determinism means the same input gives the same prompt, not that input is normalised.
  const { prompt } = bulk.build(
    bulkReadPayload({ files: [{ path: 'z.js', content: 'Z' }, { path: 'a.js', content: 'A' }] }),
  )
  assert.ok(prompt.indexOf('z.js') < prompt.indexOf('a.js'))
})

test('a single file and many files use the same construction', () => {
  const one = bulk.build(bulkReadPayload({ files: [{ path: 'only.js', content: 'X' }] }))
  assert.match(one.prompt, /# Files \(1\)/)
  const many = bulk.build(
    bulkReadPayload({ files: Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.js`, content: `C${i}` })) }),
  )
  assert.match(many.prompt, /# Files \(40\)/)
  for (let i = 0; i < 40; i += 1) assert.ok(many.prompt.includes(`f${i}.js`))
})

test('the file fence is not something a file could forge with a markdown code block', () => {
  // A delimiter the payload can produce is a delimiter that lets one file's content be read as
  // the next file's header.
  const { prompt } = bulk.build(
    bulkReadPayload({ files: [{ path: 'readme.md', content: '```js\nconst x = 1\n```' }] }),
  )
  assert.ok(prompt.includes('```'), 'the content is passed through verbatim')
  assert.equal(prompt.split('<<<<<<<<<< FILE').length - 1, 1, 'exactly one file header')
})

test('the bulk-reader system prompt tells the worker it has no filesystem, shell or network', () => {
  const { system } = bulk.build(bulkReadPayload())
  assert.match(system, /no filesystem, no shell and no network/)
  assert.match(system, /Use only the file contents given/)
  assert.match(system, /Do not guess/)
})

test('the bulk-reader is not told to produce a particular answer shape', () => {
  // The result is returned to the primary model as prose. Imposing a schema here would be an
  // artificial semantic interpretation of an answer this layer does not read.
  const { system } = bulk.build(bulkReadPayload())
  assert.equal(/json|yaml|schema/i.test(system), false)
})

/* ----------------------------------------------------------------- code-writer */

test('the code-writer prompt carries the instruction, and context and reference when given', () => {
  const { prompt } = code.build({
    instruction: 'INSTRUCTION_MARKER',
    context: 'CONTEXT_MARKER',
    reference: 'REFERENCE_MARKER',
  })
  for (const marker of ['INSTRUCTION_MARKER', 'CONTEXT_MARKER', 'REFERENCE_MARKER']) {
    assert.ok(prompt.includes(marker))
  }
})

test('context and reference are optional, and their headings vanish with them', () => {
  const { prompt } = code.build({ instruction: 'just this' })
  assert.match(prompt, /# Instruction/)
  assert.equal(prompt.includes('# Context'), false)
  assert.equal(prompt.includes('# Reference material'), false)
})

test('the code-writer is forbidden the filesystem, the shell, tests and version control', () => {
  const { system } = code.build(codeWritePayload())
  assert.match(system, /no filesystem, no shell and no network/)
  assert.match(system, /execute a test or touch version control/)
  assert.match(system, /Your output is a proposal/)
})

/* ------------------------------------------------------------------ validation */

test('bulk-reader validation names every problem it found, not just the first', () => {
  const problems = bulk.validate({ files: [{ path: '', content: 1 }] })
  assert.ok(problems.length >= 3, `expected several problems, got ${JSON.stringify(problems)}`)
  assert.ok(problems.some((p) => /path/.test(p)))
  assert.ok(problems.some((p) => /content/.test(p)))
  assert.ok(problems.some((p) => /task/.test(p)))
})

test('valid input produces no problems at all', () => {
  assert.deepEqual(bulk.validate(bulkReadPayload()), [])
  assert.deepEqual(code.validate(codeWritePayload()), [])
  assert.deepEqual(code.validate({ instruction: 'x' }), [])
  assert.deepEqual(code.validate({ instruction: 'x', context: null, reference: undefined }), [])
})

test('a file list beyond the ceiling is refused before anything is built', () => {
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, content: '' }))
  assert.ok(bulk.validate({ files, task: 'x' }).some((p) => /at most/.test(p)))
})

test('code-writer refuses a non-string context or reference rather than stringifying it', () => {
  assert.ok(code.validate({ instruction: 'x', context: 42 }).some((p) => /context/.test(p)))
  assert.ok(code.validate({ instruction: 'x', reference: {} }).some((p) => /reference/.test(p)))
})

/* -------------------------------------------------------------------- registry */

test('isKnownMode accepts the two shipped modes and refuses everything else', () => {
  assert.equal(isKnownMode('bulk-reader'), true)
  assert.equal(isKnownMode('code-writer'), true)
  for (const bad of ['bulkRead', 'bulk_read', 'translator', '', null, undefined, 42, 'toString']) {
    assert.equal(isKnownMode(bad), false, `${String(bad)} was accepted`)
  }
})

test('there are exactly two modes — a third would need a routing lane that does not exist', () => {
  assert.equal(Object.keys(MODES).length, 2)
})

test('a mode builder reads nothing from outside its input', () => {
  // Content for paths that exist nowhere on disk builds a prompt containing exactly that content,
  // which is only possible if the builder never tried to resolve the path.
  const { prompt } = bulk.build(
    bulkReadPayload({ files: [{ path: '/etc/shadow', content: 'SUPPLIED_NOT_READ' }] }),
  )
  assert.ok(prompt.includes('SUPPLIED_NOT_READ'))
  assert.ok(prompt.includes('/etc/shadow'), 'the path is a label, never a lookup')
})

/* ------------------------------------------- phase 8: concision vs completeness */

test('concision is explicitly subordinate to coverage, not left to the model to resolve', () => {
  // THE PHASE 8 PROMPT FIX. The final rule used to read "Be concise. ... include the facts it
  // needs and nothing else", which set no precedence against the bulk-read lane requirement
  // "Find EVERY occurrence that matches, not the first one and not a representative sample".
  //
  // Strictly those are not contradictory — "nothing else" scopes to material BEYOND what was
  // asked, and does not license omitting a required fact. But a bare "Be concise" imperative in
  // the system prompt, with no stated precedence, leaves a small model free to resolve the
  // tension toward brevity, and that is the observed failure. The fix states the precedence.
  const { system } = bulk.build(bulkReadPayload())

  assert.match(system, /concise in wording, not in coverage/i)
  assert.match(system, /every fact the task asks for/i)

  // The bare imperative must be gone: it is the half of the old wording that could be read as
  // licence to answer less completely.
  assert.equal(/-\s*Be concise\./.test(system), false, 'the unqualified "Be concise." survived')
})

test('the system prompt and the lane requirements no longer pull in opposite directions', () => {
  // Asserted over the BUILT PROMPT plus the system string together, because that pair is what a
  // worker actually sees, and the two halves come from different modules (modes.mjs and
  // task.mjs). A fix to one that left the other alone would pass a single-module check.
  const input = buildWorkerTask({
    toolContext: { baseTask: 'Summarise.', lane: 'bulkRead' },
    files: [{ path: 'a.ts', content: 'const x = 1' }],
    taskIntent: { task: 'Find every call to registerHandler.' },
  })
  const { system, prompt } = bulk.build(input)

  // Both halves are present: this is the only configuration in which the conflict could arise.
  assert.match(prompt, /Find EVERY occurrence/)
  assert.match(system, /concise/i)

  // And the system half now says which wins.
  assert.match(system, /not in coverage/i)
  assert.equal(
    /\bbe brief\b|\bas short as possible\b|\bomit\b/i.test(system),
    false,
    'the system prompt acquired new brevity pressure',
  )
})

test('a semantic prompt change moved BOTH version counters, and they stay distinct', () => {
  // The system prompt is shared by both variants, so a change to it changes both requests. The
  // generic counter could not simply become 2, because 2 already belonged to the intent request:
  // a stamp two different prompts can carry is a stamp nobody can read a stored row against.
  assert.ok(PROMPT_VERSION > 2, `the generic counter must have moved past the old intent value, got ${PROMPT_VERSION}`)
  assert.notEqual(PROMPT_VERSION, INTENT_PROMPT_VERSION)
  assert.ok(Number.isInteger(PROMPT_VERSION) && Number.isInteger(INTENT_PROMPT_VERSION))

  // The generic request still reports the generic counter, and an intent request the other one.
  const generic = bulk.build(buildWorkerTask({
    toolContext: { baseTask: 'Summarise.', lane: 'bulkRead' },
    files: [{ path: 'a.ts', content: 'x' }],
    taskIntent: null,
  }))
  const intent = bulk.build(buildWorkerTask({
    toolContext: { baseTask: 'Summarise.', lane: 'bulkRead' },
    files: [{ path: 'a.ts', content: 'x' }],
    taskIntent: { task: 'Find every handler.' },
  }))
  assert.equal(generic.promptVersion, PROMPT_VERSION)
  assert.equal(intent.promptVersion, INTENT_PROMPT_VERSION)
  assert.equal(generic.system, intent.system, 'both variants share one system prompt')
})
