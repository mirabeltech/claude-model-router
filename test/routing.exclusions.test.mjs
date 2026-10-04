/**
 * The refusal list.
 *
 * THIS FILE IS THE NEGATIVE EVAL that CLAUDE.md's sixth non-negotiable demands. Changing a
 * threshold or a glob default requires proving the system still refuses to delegate reasoning
 * work, and this is where that proof lives. If a change to `config.mjs` makes one of these pass
 * for the wrong reason, or makes one of them delegate, the change is wrong — not the test.
 *
 * Every test below starts from a baseline that DOES delegate and flips exactly one field, so a
 * failure names the rule that stopped working.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import {
  DELEGATABLE_TASK_TYPES,
  ROUTING_TASK_TYPES,
} from '../plugins/model-router/lib/routing-policy.mjs'
import { bulkReadInput, codeWriteInput, routingConfig } from './helpers/routing-input.mjs'

const reasonFor = (over, cfg) => decide(bulkReadInput(over), routingConfig(cfg)).reason

/* ------------------------------------------------- we never delegate reasoning */

test('debugging is never delegated', () => {
  // CLAUDE.md #6. Debugging is reasoning over a hypothesis, and a worker that cannot see the
  // hypothesis cannot help with it.
  assert.equal(reasonFor({ taskType: 'debugging' }), 'task_type_excluded')
  assert.equal(decide(bulkReadInput({ taskType: 'debugging' }), routingConfig()).delegate, false)
})

test('architecture decisions are never delegated', () => {
  assert.equal(reasonFor({ taskType: 'architecture' }), 'task_type_excluded')
})

test('security-sensitive work is never delegated', () => {
  assert.equal(reasonFor({ taskType: 'security' }), 'task_type_excluded')
})

test('a precise edit is never delegated', () => {
  assert.equal(reasonFor({ taskType: 'precise_edit' }), 'task_type_excluded')
})

test('a small payload is never delegated', () => {
  assert.equal(
    reasonFor({ fileCount: 1, lineCount: 12, inputBytes: 300, estimatedInputTokens: 60, paths: ['/proj/a.ts'] }),
    'below_threshold',
  )
})

test('unclassified general work is not delegated', () => {
  // `general` is deliberately absent from the allowlist. If unclassified work were delegatable,
  // every task the caller could not label would land in the delegating bucket.
  assert.equal(reasonFor({ taskType: 'general' }), 'task_type_excluded')
})

test('an unknown task type is not delegated', () => {
  assert.equal(reasonFor({ taskType: 'unknown' }), 'unknown_input')
})

/* ---------------------------------------------------- the allowlist, exhaustive */

for (const taskType of ROUTING_TASK_TYPES) {
  const delegatable = DELEGATABLE_TASK_TYPES.includes(taskType)
  test(`task type "${taskType}" ${delegatable ? 'may' : 'must never'} delegate`, () => {
    const input = taskType === 'code_write' ? codeWriteInput() : bulkReadInput({ taskType })
    const d = decide({ ...input, taskType }, routingConfig())
    assert.equal(d.delegate, delegatable, `${taskType} reported ${d.reason}`)
  })
}

test('a task type outside the allowlist is refused even if someone adds it to the taxonomy', () => {
  // The allowlist is the guard, not the taxonomy. Adding a category without permitting it must
  // produce a refusal, never a leak.
  const notAllowed = ROUTING_TASK_TYPES.filter((t) => !DELEGATABLE_TASK_TYPES.includes(t))
  assert.ok(notAllowed.length >= 6, 'expected most task types to be non-delegatable')
  for (const taskType of notAllowed) {
    assert.equal(decide(bulkReadInput({ taskType }), routingConfig()).delegate, false)
  }
})

/* ------------------------------------------------------------- someone waiting */

test('an interactive task stays with Claude, whatever its size', () => {
  assert.equal(reasonFor({ interactive: true, lineCount: 100000, fileCount: 20 }), 'interactive')
})

test('a latency-sensitive task stays with Claude, whatever its size', () => {
  assert.equal(reasonFor({ latencySensitive: true, lineCount: 100000, fileCount: 20 }), 'latency_sensitive')
})

test('interactive is reported before latency when both are set, so the reason is deterministic', () => {
  assert.equal(reasonFor({ interactive: true, latencySensitive: true }), 'interactive')
})

/* ------------------------------------------------------- the never-delegate pair */

test('a targeted read is treated as intentional and is not delegated', () => {
  assert.equal(reasonFor({ targetedRead: true }), 'targeted_read')
})

test('a recently edited file is not delegated — Claude needs the exact current bytes', () => {
  assert.equal(reasonFor({ recentlyEdited: true }), 'recently_edited')
})

test('turning off neverDelegate.onTargetedRead restores delegation for a targeted read', () => {
  // The switches are real switches. If this test passes while the one above fails, the flag is
  // being ignored rather than honoured.
  const d = decide(
    bulkReadInput({ targetedRead: true }),
    routingConfig({ routing: { neverDelegate: { onTargetedRead: false } } }),
  )
  assert.equal(d.delegate, true)
})

test('turning off neverDelegate.onRecentlyEdited restores delegation for an edited file', () => {
  const d = decide(
    bulkReadInput({ recentlyEdited: true }),
    routingConfig({ routing: { neverDelegate: { onRecentlyEdited: false } } }),
  )
  assert.equal(d.delegate, true)
})

/* ------------------------------------------------------------- requested output */

for (const requestedOutput of ['edit', 'patch', 'diff', 'inline_edit', 'exact']) {
  test(`a request for "${requestedOutput}" output means exact bytes and is not delegated`, () => {
    assert.equal(reasonFor({ requestedOutput }), 'precise_output_requested')
  })
}

test('a requested output is matched case-insensitively', () => {
  assert.equal(reasonFor({ requestedOutput: 'PATCH' }), 'precise_output_requested')
})

test('a summary request is not a precise output', () => {
  assert.equal(reasonFor({ requestedOutput: 'summary' }), 'threshold_met')
})

/* ----------------------------------------------------------------- deny globs */

const DENY_CASES = Object.freeze([
  ['**/.env*', '/proj/.env', '/proj/environment.ts'],
  ['**/*secret*', '/proj/src/secrets.ts', '/proj/src/sealed.ts'],
  ['**/*credential*', '/proj/lib/credentials.js', '/proj/lib/creds.js'],
  ['**/*.pem', '/proj/certs/server.pem', '/proj/certs/server.pem.txt'],
  ['**/*.key', '/proj/certs/server.key', '/proj/certs/server.keys'],
  ['**/id_rsa*', '/proj/.ssh/id_rsa.pub', '/proj/.ssh/known_hosts'],
  ['**/.git/**', '/proj/.git/config', '/proj/gitignore'],
  ['**/auth/**', '/proj/app/auth/login.ts', '/proj/app/author.ts'],
  ['**/security/**', '/proj/src/security/csp.ts', '/proj/src/secure.ts'],
])

for (const [pattern, denied, allowed] of DENY_CASES) {
  test(`the shipped deny glob ${pattern} refuses ${denied} and not ${allowed}`, () => {
    assert.equal(reasonFor({ paths: [denied] , fileCount: 1 }), 'deny_glob', `${denied} must be refused`)
    assert.equal(reasonFor({ paths: [allowed], fileCount: 1 }), 'threshold_met', `${allowed} must not be`)
  })
}

test('one sensitive path in a corpus refuses the whole corpus', () => {
  // decide() answers one question about one tool call. Per-file filtering of a corpus belongs to
  // the payload builder; a partial refusal here would mean a partial answer with no warning.
  assert.equal(reasonFor({ paths: ['/proj/src/a.ts', '/proj/.env', '/proj/src/b.ts'] }), 'deny_glob')
})

test('a sensitive path is refused even when the worker is ready and the payload is huge', () => {
  assert.equal(reasonFor({ paths: ['/proj/.env'], lineCount: 99999, fileCount: 1 }), 'deny_glob')
})

test('a sensitive path inside a tiny file reports deny_glob, not below_threshold', () => {
  // The reason code has to name the most fundamental objection, or nobody can answer "is the deny
  // list actually doing anything".
  assert.equal(
    reasonFor({ paths: ['/proj/.env'], fileCount: 1, lineCount: 2, inputBytes: 30, estimatedInputTokens: 8 }),
    'deny_glob',
  )
})

test('an allowGlob rescues a path the deny list caught', () => {
  const d = decide(
    bulkReadInput({ paths: ['/proj/src/security/csp.ts'], fileCount: 1 }),
    routingConfig({ routing: { allowGlobs: ['**/security/csp.ts'] } }),
  )
  assert.equal(d.delegate, true, 'an explicit allow must win over the category deny')
})

test('a project-relative deny glob matches an absolute path', () => {
  const d = decide(
    bulkReadInput({ paths: ['/proj/migrations/001.sql'], fileCount: 1 }),
    routingConfig({ routing: { denyGlobs: ['migrations/**'] } }),
  )
  assert.equal(d.reason, 'deny_glob')
})

test('a deny glob is matched case-insensitively', () => {
  // NTFS and APFS are case-insensitive; a case-sensitive matcher would let `.ENV` through on the
  // platform where it is literally the same file.
  assert.equal(reasonFor({ paths: ['/proj/.ENV'], fileCount: 1 }), 'deny_glob')
})

test('a Windows path separator does not evade the deny list', () => {
  assert.equal(reasonFor({ paths: ['C:\\proj\\config\\.env'], fileCount: 1, projectPath: 'C:\\proj' }), 'deny_glob')
})

/* ------------------------------------------------------------- unproven corpus */

test('claiming files without naming them is not permission to delegate', () => {
  // If the paths are unknown the corpus cannot be proven free of secrets, and unknown is never
  // the favorable value.
  assert.equal(reasonFor({ fileCount: 3, paths: [] }), 'unknown_input')
})
