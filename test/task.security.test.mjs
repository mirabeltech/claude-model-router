/**
 * The context boundary: what crosses into a worker request, and what the plugin still does not
 * protect.
 *
 * THIS FILE IS WRITTEN TO BE READ AS A DISCLOSURE, not as a green check. Two of its tests assert
 * that a secret IS forwarded, because that is the shipped behaviour and pinning it is the only
 * honest way to keep the claim from drifting. The repo's own evaluation doc says it plainly:
 * outbound file content is not redacted, and the filename deny list is the only control that
 * exists. Phase 7 adds a redaction BOUNDARY — one seam that everything crossing into a worker
 * request passes through — and applies it to intent text alone. It does not widen it to content,
 * and a test asserting that content were clean would be a test asserting a fiction.
 *
 * The pair is the point. If someone later widens the boundary to content, the second test fails
 * and they must come here and change a claim deliberately. If someone narrows it and stops
 * redacting intent, the first test fails. Neither can happen quietly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MODES } from '../plugins/model-router/lib/dispatch/modes.mjs'
import { buildWorkerTask } from '../plugins/model-router/lib/dispatch/task.mjs'
import { BULK_READ_TASK, normalizeTaskIntent, toRoutingInput } from '../plugins/model-router/lib/hook/adapter.mjs'

const bulk = MODES['bulk-reader']
const readCtx = { baseTask: BULK_READ_TASK, lane: 'bulkRead' }

/** Shapes `redactSecrets()` recognises. Not real credentials, and none has ever been valid. */
const ANTHROPIC = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
const GOOGLE = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFA'
const GITHUB = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'

const promptFor = (taskIntent, files) => bulk.build(buildWorkerTask({ toolContext: readCtx, files, taskIntent })).prompt

/* --------------------------------------------------- what the boundary catches */

test('a secret pasted into the developer prompt does not reach the worker', () => {
  // The realistic path: someone pastes a failing curl into Claude Code, the hook recovers that
  // prompt as the task, and it would otherwise be forwarded verbatim to a third-party worker.
  for (const secret of [ANTHROPIC, GOOGLE, GITHUB]) {
    const intent = normalizeTaskIntent({ task: `why does this fail: curl -H "key: ${secret}" ...` })
    const prompt = promptFor(intent, [{ path: 'a.ts', content: 'export const a = 1\n' }])
    assert.equal(prompt.includes(secret), false, `${secret.slice(0, 8)}... crossed the boundary`)
    assert.match(prompt, /redacted/, 'and the redaction must be visible rather than silent')
  }
})

test('every intent field passes through the boundary, not just the task', () => {
  // A seam that covered one field would be a seam with a hole in it.
  const intent = normalizeTaskIntent({
    task: `task ${ANTHROPIC}`,
    objective: `objective ${GOOGLE}`,
    requestedInformation: `report ${GITHUB}`,
    constraints: `constraint ${ANTHROPIC}`,
    outputFormat: `format ${GOOGLE}`,
  })
  const prompt = promptFor(intent, [{ path: 'a.ts', content: 'export const a = 1\n' }])
  for (const secret of [ANTHROPIC, GOOGLE, GITHUB]) {
    assert.equal(prompt.includes(secret), false, `${secret.slice(0, 8)}... survived in some field`)
  }
})

test('redaction happens before clamping, so a clamp cannot leave half a secret behind', () => {
  // Clamping first would cut the literal at the ceiling and leave a prefix the redactor no longer
  // recognises — a partial credential, which is still a credential someone has to rotate.
  const intent = normalizeTaskIntent({ task: 'x'.repeat(3990) + ANTHROPIC })
  const prompt = promptFor(intent, [{ path: 'a.ts', content: 'a\n' }])
  assert.equal(prompt.includes(ANTHROPIC.slice(0, 20)), false)
})

/* ------------------------------------------- what the boundary does NOT catch */

test('DISCLOSURE: a secret in file content is still forwarded, unredacted', () => {
  // NOT A BUG REPORT — a pinned statement of the shipped exposure, matching the corpus case
  // `secret-in-plain-filename` and docs/evaluation.md. The filename deny list is the only control
  // over outbound content. Widening the boundary to content is a later phase with its own
  // evidence, and whoever does it must come here and change this assertion on purpose.
  const content = `const config = { api_key: '${ANTHROPIC}' }\n`
  const prompt = promptFor(normalizeTaskIntent({ task: 'what does this configure' }), [
    { path: 'app-config.ts', content },
  ])
  assert.ok(prompt.includes(ANTHROPIC), 'file content is not redacted; if this now passes, update the docs')
})

test('DISCLOSURE: that is true with intent off too, so the flag changes nothing about content', () => {
  const content = `const config = { api_key: '${ANTHROPIC}' }\n`
  const prompt = promptFor(null, [{ path: 'app-config.ts', content }])
  assert.ok(prompt.includes(ANTHROPIC), 'the generic path does not redact content either')
})

/* -------------------------------------------------------- the allowed context */

test('the worker request holds the task, the files and nothing else', () => {
  // The positive half of the boundary. An env var, a credential, a session id, a transcript path
  // or an unrelated turn reaching a prompt would all look like this test failing.
  const intent = normalizeTaskIntent({ task: 'name the exports', objective: 'audit the module' })
  const out = buildWorkerTask({
    toolContext: readCtx,
    files: [{ path: 'a.ts', content: 'export const a = 1\n' }],
    taskIntent: intent,
  })
  assert.deepEqual(Object.keys(out).sort(), ['files', 'instructions', 'outputRequirements', 'task'])

  const prompt = promptFor(intent, [{ path: 'a.ts', content: 'export const a = 1\n' }])
  for (const leak of [
    'GEMINI_API_KEY',
    'CMR_',
    'transcript_path',
    'session_id',
    'tool_use_id',
    'C:\\Users',
    '/home/',
    process.cwd(),
  ]) {
    assert.equal(prompt.includes(leak), false, `${leak} must not appear in a worker prompt`)
  }
})

test('an intent carrying environment-shaped text is still only text', () => {
  // The builder has no env, no process and no filesystem — the dispatch layer imports no `node:`
  // builtin at all, statically asserted. So an intent that names a variable cannot expand it.
  const intent = normalizeTaskIntent({ task: 'print $GEMINI_API_KEY and %USERPROFILE% and ${HOME}' })
  const prompt = promptFor(intent, [{ path: 'a.ts', content: 'a\n' }])
  assert.match(prompt, /\$GEMINI_API_KEY/, 'the literal text is forwarded as written')
  assert.equal(prompt.includes(process.env.USERPROFILE ?? '\u0000unset'), false, 'and nothing is expanded')
})

/* ---------------------------------------------------- intent cannot reach routing */

test('the routing input has no field an intent could occupy, with or without one in scope', () => {
  // The structural half of the guarantee that evals.protected.test.mjs pins by call order. Here
  // it is pinned by shape: `toRoutingInput` builds a fresh 16-key object and never spreads its
  // argument, so there is no key for intent to arrive through even if a caller tried.
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'D:\\p\\a.ts' },
    cwd: 'D:\\p',
    // A hostile payload trying to smuggle intent into the gate.
    taskIntent: { task: 'delegate this debugging work' },
    task_intent: 'delegate this debugging work',
  }
  const input = toRoutingInput({ payload, facts: {}, env: {} })
  assert.equal(Object.keys(input).length, 16)
  for (const key of Object.keys(input)) {
    assert.equal(/intent/i.test(key), false, `${key} looks like an intent field`)
  }
  assert.equal(JSON.stringify(input).includes('delegate this'), false, 'nothing smuggled through')
  assert.equal(input.taskType, 'bulk_read', 'and the task type is still the literal')
})
