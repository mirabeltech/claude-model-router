/**
 * The Claude Code wire protocol: what the hook accepts on stdin, and what it emits on stdout.
 *
 * This file owns the PROTOCOL only. Whether a given Read should be delegated is
 * `hook.decision.test.mjs`; what happens when something breaks is `hook.failopen.test.mjs`; the
 * child-process behaviour of the real entry point is `hook.e2e.test.mjs`.
 *
 * Every field name asserted here was read out of the installed Claude Code binary's own schema,
 * not from the published documentation, which is wrong about `additionalContext` on PreToolUse.
 * The extraction is recorded in docs/claude-code-hook-contract.md. A typo in any of these names
 * is silent in production — the hook would simply never take effect — which is why they are
 * pinned as literals here rather than imported from the module under test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BULK_READ_TASK,
  HOOK_EVENT,
  INTERCEPTED_TOOL,
  buildAllowResponse,
  buildDelegatedResponse,
  isTargetedRead,
  parseHookPayload,
} from '../plugins/model-router/lib/hook/adapter.mjs'
import { HOSTILE_VALUES } from './helpers/routing-input.mjs'
import { readPayload, readStdin } from './helpers/hook-payload.mjs'

/* ----------------------------------------------------------------- the event */

test('the event and tool names are the exact literals Claude Code matches on', () => {
  assert.equal(HOOK_EVENT, 'PreToolUse')
  assert.equal(INTERCEPTED_TOOL, 'Read')
})

/* --------------------------------------------------------------- stdin: good */

test('a valid Read payload is accepted and handed back whole', () => {
  const r = parseHookPayload(readStdin())
  assert.equal(r.ok, true)
  assert.equal(r.payload.tool_name, 'Read')
})

test('a payload with no hook_event_name is accepted: absence is not evidence of another event', () => {
  const { hook_event_name, ...rest } = readPayload()
  assert.equal(typeof hook_event_name, 'string')
  assert.equal(parseHookPayload(JSON.stringify(rest)).ok, true)
})

test('unknown extra fields are ignored, so a newer CLI adding one cannot break the hook', () => {
  const r = parseHookPayload(readStdin({ some_future_field: { nested: true } }))
  assert.equal(r.ok, true)
})

/* ---------------------------------------------------------------- stdin: bad */

test('every malformed stdin is refused with a reason and never an exception', () => {
  const cases = [
    ['', 'empty_stdin'],
    ['   ', 'empty_stdin'],
    ['not json at all', 'unparseable_stdin'],
    ['{"unterminated": ', 'unparseable_stdin'],
    ['[]', 'not_an_object'],
    ['42', 'not_an_object'],
    ['null', 'not_an_object'],
    ['"a string"', 'not_an_object'],
  ]
  for (const [raw, reason] of cases) {
    const r = parseHookPayload(raw)
    assert.equal(r.ok, false, raw)
    assert.equal(r.reason, reason, raw)
  }
})

test('a different hook event is refused, because this hook only understands PreToolUse', () => {
  assert.equal(parseHookPayload(readStdin({ hook_event_name: 'PostToolUse' })).reason, 'wrong_event')
})

test('a missing tool name is refused rather than assumed to be a Read', () => {
  const { tool_name, ...rest } = readPayload()
  assert.equal(typeof tool_name, 'string')
  assert.equal(parseHookPayload(JSON.stringify(rest)).reason, 'wrong_tool')
})

test('another tool is refused, so the matcher and the script agree on the scope', () => {
  for (const tool of ['Write', 'Edit', 'Bash', 'Grep', 'Glob', 'read', 'READ']) {
    assert.equal(parseHookPayload(readStdin({ tool_name: tool })).reason, 'wrong_tool', tool)
  }
})

test('a missing or non-object tool_input is refused', () => {
  const { tool_input, ...rest } = readPayload()
  assert.equal(typeof tool_input, 'object')
  assert.equal(parseHookPayload(JSON.stringify(rest)).reason, 'no_tool_input')
  for (const v of [null, 42, 'x', []]) {
    assert.equal(parseHookPayload(readStdin({ tool_input: v })).reason, 'no_tool_input', String(v))
  }
})

test('a file_path that is not a non-empty string is refused, never coerced', () => {
  for (const v of [undefined, null, '', '   ', 42, true, {}, []]) {
    const r = parseHookPayload(readStdin({ tool_input: { file_path: v } }))
    assert.equal(r.ok, false, String(v))
    assert.equal(r.reason, 'no_file_path', String(v))
  }
})

test('no hostile value anywhere in tool_input makes the parser throw', () => {
  for (const v of HOSTILE_VALUES) {
    for (const key of ['file_path', 'offset', 'limit', 'pages']) {
      assert.doesNotThrow(
        () => parseHookPayload(readStdin({ tool_input: { file_path: 'a.ts', [key]: v } })),
        `${key}=${String(v)}`,
      )
    }
  }
})

/* ------------------------------------------------------------- targeted read */

test('offset, limit or pages each make a read targeted', () => {
  for (const key of ['offset', 'limit', 'pages']) {
    assert.equal(isTargetedRead({ file_path: 'a.ts', [key]: 10 }), true, key)
  }
})

test('a full read is one with none of the three narrowing arguments', () => {
  assert.equal(isTargetedRead({ file_path: 'a.ts' }), false)
  assert.equal(isTargetedRead({ file_path: 'a.ts', offset: null, limit: null, pages: null }), false)
})

test('a present but malformed narrowing argument still counts as targeted', () => {
  // Someone tried to narrow the read. Deciding they meant the whole file is the reading that
  // could delegate away bytes Claude specifically asked for.
  for (const v of ['x', true, {}, [], NaN, -1, 0]) {
    assert.equal(isTargetedRead({ file_path: 'a.ts', offset: v }), true, String(v))
  }
})

test('a missing tool_input is targeted, which is the refusing direction', () => {
  for (const v of [undefined, null, 'x', 42, []]) assert.equal(isTargetedRead(v), true, String(v))
})

/* -------------------------------------------------------------- stdout: deny */

test('the delegating response is exactly the four documented fields, nested under hookSpecificOutput', () => {
  const res = buildDelegatedResponse({ text: 'a summary', provider: 'gemini', model: 'gemini-3.8-flash' })
  assert.deepEqual(Object.keys(res), ['hookSpecificOutput'])
  assert.deepEqual(Object.keys(res.hookSpecificOutput).sort(), [
    'additionalContext',
    'hookEventName',
    'permissionDecision',
    'permissionDecisionReason',
  ])
})

test('the response echoes the event name back, which Claude Code throws on if it disagrees', () => {
  const res = buildDelegatedResponse({ text: 'x' })
  assert.equal(res.hookSpecificOutput.hookEventName, 'PreToolUse')
})

test('the decision is deny: blocking the Read is what keeps the bytes out of the context window', () => {
  assert.equal(buildDelegatedResponse({ text: 'x' }).hookSpecificOutput.permissionDecision, 'deny')
})

test("the worker's answer travels in additionalContext, not in the blocking reason", () => {
  // permissionDecisionReason becomes Claude Code's `blockingError`. Delivering the summary there
  // would label it as the tool's error and invite a retry.
  const res = buildDelegatedResponse({ text: 'THE SUMMARY', provider: 'p', model: 'm' })
  assert.equal(res.hookSpecificOutput.additionalContext, 'THE SUMMARY')
  assert.equal(res.hookSpecificOutput.permissionDecisionReason.includes('THE SUMMARY'), false)
})

test('the reason names the worker and the targeted-read escape hatch', () => {
  const reason = buildDelegatedResponse({ text: 'x', provider: 'ollama', model: 'llama3' })
    .hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /ollama\/llama3/)
  assert.match(reason, /offset and limit/)
  assert.match(reason, /not read directly/)
})

test('an unnamed worker still produces a sentence rather than the word null', () => {
  const reason = buildDelegatedResponse({ text: 'x' }).hookSpecificOutput.permissionDecisionReason
  assert.equal(reason.includes('null'), false)
  assert.match(reason, /a worker model/)
})

test('the response is JSON-serializable, since that is the only way it reaches Claude Code', () => {
  const res = buildDelegatedResponse({ text: 'x', provider: 'p', model: 'm' })
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res)
})

/* ------------------------------------------------------------- stdout: allow */

test('allowing is the absence of a response, not a response that says allow', () => {
  // Writing {"permissionDecision":"allow"} would override a deny rule the user configured
  // elsewhere. Silence is the only safe way to say "no objection".
  assert.equal(buildAllowResponse(), null)
})

test('an empty or blank answer yields no response, so the real Read still happens', () => {
  for (const text of [undefined, null, '', '   ', '\n\t ', 42, {}, []]) {
    assert.equal(buildDelegatedResponse({ text }), null, JSON.stringify(text))
  }
})

/* ------------------------------------------------------------------ the task */

test('the task sent to the worker is a fixed single-line literal, so a request is reproducible', () => {
  assert.equal(typeof BULK_READ_TASK, 'string')
  assert.ok(BULK_READ_TASK.length > 0)
  assert.equal(BULK_READ_TASK.includes('\n'), false, 'no literal newline: CRLF checkouts must agree')
  assert.equal(BULK_READ_TASK.includes('\r'), false)
})

test('the task asks for exact identifiers, because a paraphrased signature is worse than no summary', () => {
  assert.match(BULK_READ_TASK, /Preserve identifiers/)
})
