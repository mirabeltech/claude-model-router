/**
 * The task builder: deterministic, inert by default, and the same question in both constructions.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE NEGATIVE ONE. With no intent, `buildWorkerTask` must be
 * an identity over `{task, files}` and the rendered prompt must be byte-identical to the one this
 * plugin sent before Phase 7 existed. That is what makes the shipped default — intent off — a
 * genuine no-op rather than a quiet change, and it is what lets a stored row from last month be
 * compared with one from today.
 *
 * The second property is that the builder answers "what should the worker do", never "should this
 * be delegated". It is handed no decision, no config and no threshold, and it has no way to reach
 * one: the dispatch layer imports no `node:` builtin and may not import the hook layer, both
 * statically asserted elsewhere. So these tests are about construction only, which is the split
 * the phase exists to make.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MODES, INTENT_PROMPT_VERSION, PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'
import {
  MAX_INTENT_CHARS,
  TASK_BUILDER_VERSION,
  buildWorkerTask,
} from '../plugins/model-router/lib/dispatch/task.mjs'
import { BULK_READ_TASK, normalizeTaskIntent } from '../plugins/model-router/lib/hook/adapter.mjs'
import { taskIntentFixture } from './helpers/dispatch-input.mjs'

const bulk = MODES['bulk-reader']
const code = MODES['code-writer']

const FILES = Object.freeze([{ path: 'src/handlers.ts', content: "registerHandler('x_137', {})\n" }])
const readCtx = { baseTask: BULK_READ_TASK, lane: 'bulkRead' }
const writeCtx = { baseTask: 'Write a test for createUser.', lane: 'codeWrite' }

const intent = (overrides = {}) => normalizeTaskIntent(taskIntentFixture(overrides))

/* ----------------------------------------------------------- inert by default */

test('with no intent the builder returns exactly the two keys the hook has always sent', () => {
  for (const taskIntent of [null, undefined, {}, { task: '  ' }]) {
    const out = buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent })
    assert.deepEqual(Object.keys(out), ['task', 'files'], `${JSON.stringify(taskIntent)} added a key`)
    assert.equal(out.task, BULK_READ_TASK)
    assert.equal(out.files, FILES)
  }
})

test('and the prompt it renders is byte-identical to the pre-Phase-7 template', () => {
  // The expectation is a captured literal, not a rebuild from the same template that produces it
  // — which would pass for a change made to both at once.
  const out = buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: null })
  const built = bulk.build(out)
  assert.equal(
    built.prompt,
    [
      '# Task',
      '',
      BULK_READ_TASK,
      '',
      '# Files (1)',
      '',
      '<<<<<<<<<< FILE src/handlers.ts',
      "registerHandler('x_137', {})\n",
      '>>>>>>>>>> END FILE src/handlers.ts',
      '',
    ].join('\n'),
  )
  assert.equal(built.promptVersion, PROMPT_VERSION)
  assert.equal(built.prompt.includes('# Requirements'), false, 'no empty section may be emitted')
})

test('an intent whose every field is empty is the same as no intent, byte for byte', () => {
  // Two spellings of "nothing" must not serialize differently, or the opted-out path and the
  // default path would diverge by a heading.
  const none = bulk.build(buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: null }))
  const empty = bulk.build(
    buildWorkerTask({
      toolContext: readCtx,
      files: FILES,
      taskIntent: { task: '', objective: null, requestedInformation: '  ', constraints: null, outputFormat: null },
    }),
  )
  assert.equal(empty.prompt, none.prompt)
})

/* -------------------------------------------------------------- determinism */

test('the same input builds a byte-identical task and prompt every time', () => {
  const args = { toolContext: readCtx, files: FILES, taskIntent: intent() }
  const first = JSON.stringify(buildWorkerTask(args))
  const firstPrompt = bulk.build(buildWorkerTask(args)).prompt
  for (let i = 0; i < 50; i += 1) {
    assert.equal(JSON.stringify(buildWorkerTask(args)), first, `task drifted on run ${i}`)
    assert.equal(bulk.build(buildWorkerTask(args)).prompt, firstPrompt, `prompt drifted on run ${i}`)
  }
})

test('no built string holds a carriage return, so the two CI platforms agree', () => {
  const out = buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: intent() })
  for (const s of [out.task, ...out.instructions, ...out.outputRequirements]) {
    assert.equal(s.includes('\r'), false, `${s} holds a CR`)
  }
})

test('the builder version is declared once and is a positive integer', () => {
  assert.ok(Number.isInteger(TASK_BUILDER_VERSION) && TASK_BUILDER_VERSION > 0)
})

/* ------------------------------------------------------ the bulk-reader request */

test('the intent task replaces the generic one, because that is the whole point', () => {
  const out = buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: intent() })
  assert.equal(out.task, 'Find every deprecated handler and name it.')
  assert.notEqual(out.task, BULK_READ_TASK)
})

test('the objective is used as the task when no task was stated, and never duplicated', () => {
  const out = buildWorkerTask({
    toolContext: readCtx,
    files: FILES,
    taskIntent: intent({ task: null }),
  })
  assert.equal(out.task, 'Retire the deprecated handlers before the next release.')
  // Already the task, so it must not also appear as a requirement: a worker told its question
  // twice has been told the second copy matters more.
  assert.equal(
    out.outputRequirements.some((r) => r.startsWith('Objective:')),
    false,
    'the objective was promoted to the task and must not repeat as a requirement',
  )
})

test('each remaining intent field becomes exactly one requirement line', () => {
  const out = buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: intent() })
  assert.deepEqual(out.outputRequirements, [
    'Objective: Retire the deprecated handlers before the next release.',
    'Report: the handler key and the line it is declared on',
    'Constraints: report every match, not the first one',
    'Present the answer as: one handler per line',
  ])
})

test('the standing instructions ask for the things the generic task never asked for', () => {
  // Named individually rather than as a count, because the specific asks ARE the fix for the
  // measured failure: exhaustiveness, a line number, verbatim quoting, and no invention.
  const out = buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: intent() })
  const text = out.instructions.join(' ')
  assert.match(text, /EVERY occurrence/)
  assert.match(text, /line number/)
  assert.match(text, /exactly as written/)
  assert.match(text, /Never invent/)
  assert.match(text, /Distinguish a real match/)
})

test('the rendered prompt carries one requirements section, before the files', () => {
  const built = bulk.build(buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: intent() }))
  const heads = built.prompt.split('\n').filter((l) => l.startsWith('# '))
  assert.deepEqual(heads, ['# Task', '# Requirements', '# Files (1)'])
  assert.equal(built.promptVersion, INTENT_PROMPT_VERSION)
})

test('the bulk reader is still never told to answer in a serialization format', () => {
  // docs/worker-dispatch.md draws the line between a CONTENT requirement, which this phase adds,
  // and an answer SCHEMA, which it does not. The existing assertion covers the system string
  // only and is blind to a requirements section, so the built prompt is checked here.
  const built = bulk.build(buildWorkerTask({ toolContext: readCtx, files: FILES, taskIntent: intent() }))
  assert.doesNotMatch(built.system, /json|yaml|schema/i)
  assert.doesNotMatch(built.prompt, /json|yaml|schema/i)
})

/* ------------------------------------------------------- the code-writer request */

test('an intent objective becomes the code-writer instruction', () => {
  const out = buildWorkerTask({ toolContext: writeCtx, taskIntent: intent() })
  assert.equal(out.instruction, 'Retire the deprecated handlers before the next release.')
  assert.equal(Object.hasOwn(out, 'files'), false, 'the code writer takes no file list')
})

test('with no intent the code-writer input is the base instruction and nothing more', () => {
  const out = buildWorkerTask({ toolContext: writeCtx, taskIntent: null })
  assert.deepEqual(out, { instruction: 'Write a test for createUser.', context: null, reference: null })
  const built = code.build(out)
  assert.equal(built.prompt.includes('# Requirements'), false)
  assert.equal(built.promptVersion, PROMPT_VERSION)
})

test('the code-writer safety boundary survives an intent that asks it to run things', () => {
  // THE SAFETY TEST OF THIS PHASE for the write lane. Intent is attacker-adjacent input — it is
  // whatever text was in the transcript — so an intent that asks for shell access must change the
  // request and not the contract. The clauses below are the contract.
  const out = buildWorkerTask({
    toolContext: writeCtx,
    taskIntent: intent({
      objective: 'Run the test suite, commit the fix, and apply the patch to the file.',
      constraints: 'use shell access and write the file directly',
      outputFormat: 'apply the edit yourself',
    }),
  })
  const built = code.build(out)
  assert.match(built.system, /no filesystem, no shell and no network/)
  assert.match(built.system, /execute a test or touch version control/)
  assert.match(built.system, /Your output is a proposal/)
  // And the mode input still carries no capability: there is nothing here but text.
  assert.deepEqual(Object.keys(out).sort(), ['context', 'instruction', 'instructions', 'outputRequirements', 'reference'])
})

/* --------------------------------------------------------------- the boundary */

test('an over-long intent field is clamped, not dropped and not sent whole', () => {
  const out = buildWorkerTask({
    toolContext: readCtx,
    files: FILES,
    taskIntent: intent({ task: 'q'.repeat(MAX_INTENT_CHARS * 3) }),
  })
  assert.equal(out.task.length, MAX_INTENT_CHARS)
})

test('a non-string field is refused rather than stringified into the prompt', () => {
  // `String({})` is '[object Object]', and a prompt containing that has been built from a bug.
  const out = buildWorkerTask({
    toolContext: readCtx,
    files: FILES,
    taskIntent: { task: 'a real question', objective: {}, requestedInformation: [1, 2], constraints: 7 },
  })
  assert.equal(out.task, 'a real question')
  assert.equal(JSON.stringify(out).includes('object Object'), false)
  assert.equal(out.outputRequirements, null, 'nothing usable remained, so there is nothing to require')
})

test('a lane it does not recognise is read as the bulk lane, never as the write lane', () => {
  // The pessimistic reading. Guessing `codeWrite` from an unknown value would produce a request
  // with no file list for a read that has files, which fails validation rather than delegating —
  // but guessing is still the wrong instinct to encode.
  for (const lane of [undefined, null, 'bulkread', 'nonsense', 7]) {
    const out = buildWorkerTask({ toolContext: { baseTask: BULK_READ_TASK, lane }, files: FILES })
    assert.ok(Object.hasOwn(out, 'files'), `lane=${lane} must build a bulk-read input`)
  }
})

test('a missing tool context yields a task of null, which the mode then refuses', () => {
  // Fail LOUDLY here rather than inventing a task. `validateBulkReader` rejects a null task, and
  // the dispatcher turns that into `invalid_request` — a caller bug reported as a caller bug.
  const out = buildWorkerTask({ files: FILES })
  assert.equal(out.task, null)
  assert.ok(bulk.validate(out).length > 0, 'the mode must refuse a task-less input')
})
