/**
 * The case format's rejection paths.
 *
 * A LOADER WHOSE REJECTIONS ARE UNTESTED ACCEPTS EVERYTHING. Every check in `validateCase` exists
 * because some way of writing a case would otherwise assert nothing it meant to, so each one gets a
 * deliberately broken case here and must name itself in the failure. If a check stops firing, the
 * corpus silently gets weaker and no other test notices.
 *
 * The asymmetry this file pins hardest is the enum one. `category` is OPEN and buckets an unknown
 * value, per the house rule; every field in `expected` is CLOSED and rejects. That is not an
 * inconsistency — an open enum on an EXPECTATION makes the expectation unfalsifiable, because a
 * typo'd reason bucketing to `other` produces a case that can never fail. `routing-policy.mjs`
 * makes the same call for the same reason.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONTENT_SHAPES,
  EVAL_SCHEMA_VERSION,
  HARNESSES,
  ROUTING_INPUT_FIELDS,
  bucketCategory,
  countLines,
  validateCase,
} from './evals/schema.mjs'
import { DECIDE_REASONS, ROUTING_TASK_TYPES } from '../plugins/model-router/lib/routing-policy.mjs'
import { EVALUATOR_KINDS } from './evals/evaluators.mjs'
import { TASK_INTENT_FIELDS } from '../plugins/model-router/lib/dispatch/task.mjs'

/** A case that validates, so every test below can break exactly one thing. */
function goodCase(overrides = {}) {
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    id: 'size-at-min-bytes',
    caseVersion: 1,
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'A file exactly at minBytes delegates',
    rationale: 'minBytes is compared with >=, so 12000 satisfies the size floor.',
    harness: 'decide',
    files: [
      { path: 'files/at.ts', source: 'generated', bytes: 12000, lines: 160, generator: { unit: 'x', repeat: 160 } },
    ],
    expected: {
      class: 'delegate',
      reason: 'threshold_met',
      taskType: 'bulk_read',
      decision: 'deny',
      lane: 'bulkRead',
      mode: 'bulk-reader',
    },
    ...overrides,
  }
}

const errorsFor = (overrides) => validateCase(goodCase(overrides)).errors.join(' | ')

/**
 * A DISPATCH case that validates. The baseline above is a `decide` case, and a dispatch case needs
 * three more things — `task`, the two dispatch fields in `expected`, and `qualityCriteria`. Without
 * them those requirements fire and mask whatever the test under them actually meant to break.
 */
function goodDispatchCase(overrides = {}) {
  const { expected, ...rest } = overrides
  return goodCase({
    harness: 'dispatch',
    task: 'Which exported symbols take no arguments?',
    qualityCriteria: { requiredTerms: ['export'] },
    ...rest,
    expected: {
      class: 'delegate',
      reason: 'threshold_met',
      taskType: 'bulk_read',
      decision: 'deny',
      lane: 'bulkRead',
      mode: 'bulk-reader',
      dispatchStatus: 'ok',
      dispatchReason: 'completed',
      ...expected,
    },
  })
}

const dispatchErrorsFor = (overrides) => validateCase(goodDispatchCase(overrides)).errors.join(' | ')

test('the baseline case validates, so a failure below is the field under test', () => {
  const r = validateCase(goodCase())
  assert.deepEqual(r.errors, [], 'the baseline must be clean or every other test is meaningless')
  assert.equal(r.case.id, 'size-at-min-bytes')
})

/* ------------------------------------------------- one broken case per rejection */

const REJECTIONS = Object.freeze([
  ['schemaVersion', { schemaVersion: 2 }, 'invalid_case:schemaVersion'],
  ['schemaVersion absent', { schemaVersion: undefined }, 'invalid_case:schemaVersion'],
  ['id not kebab-case', { id: 'Size_At_Min' }, 'invalid_case:id'],
  ['id too short', { id: 'ab' }, 'invalid_case:id'],
  ['caseVersion zero', { caseVersion: 0 }, 'invalid_case:caseVersion'],
  ['category not a string', { category: 7 }, 'invalid_case:category'],
  ['shapes empty', { shapes: [] }, 'invalid_case:shapes'],
  ['title missing', { title: undefined }, 'invalid_case:title'],
  ['rationale missing', { rationale: undefined }, 'invalid_case:rationale'],
  ['harness unknown', { harness: 'guess' }, 'invalid_case:harness'],
  ['files not an array', { files: 'files/at.ts' }, 'invalid_case:files'],
  ['file path absolute', { files: [{ path: '/etc/passwd', source: 'committed', bytes: 1, lines: 1 }] }, 'invalid_case:files[0].path'],
  ['file path traversal', { files: [{ path: 'files/../../x.ts', source: 'committed', bytes: 1, lines: 1 }] }, 'path_escape:files[0].path'],
  ['file path backslash', { files: [{ path: 'files\\at.ts', source: 'committed', bytes: 1, lines: 1 }] }, 'invalid_case:files[0].path'],
  ['file source unknown', { files: [{ path: 'files/at.ts', source: 'downloaded', bytes: 1, lines: 1 }] }, 'invalid_case:files[0].source'],
  ['generated without a generator', { files: [{ path: 'files/at.ts', source: 'generated', bytes: 1, lines: 1 }] }, 'invalid_case:files[0].generator'],
  ['committed with a generator', { files: [{ path: 'files/at.ts', source: 'committed', bytes: 1, lines: 1, generator: { unit: 'x', repeat: 1 } }] }, 'invalid_case:files[0].generator'],
  ['bad sha length', { files: [{ path: 'files/at.ts', source: 'committed', bytes: 1, lines: 1, sha256: 'abc' }] }, 'invalid_case:files[0].sha256'],
  ['duplicate file path', {
    files: [
      { path: 'files/at.ts', source: 'committed', bytes: 1, lines: 1 },
      { path: 'files/at.ts', source: 'committed', bytes: 1, lines: 1 },
    ],
  }, 'duplicate path'],
  ['routingInput unknown key', { routingInput: { lineCountt: 350 } }, 'invalid_case:routingInput.lineCountt'],
  ['unknown top-level key', { surprise: true }, 'invalid_case:<root>.surprise'],
  ['metadata not an object', { metadata: [] }, 'invalid_case:metadata'],
  ['safety unknown field', { safety: { plantedSecrets: 'x' } }, 'invalid_case:safety.plantedSecrets'],
])

for (const [label, broken, code] of REJECTIONS) {
  test(`a case with ${label} is rejected and names itself`, () => {
    const errors = errorsFor(broken)
    assert.ok(errors.includes(code), `expected an error naming ${code}, got: ${errors || '(none)'}`)
    assert.equal(validateCase(goodCase(broken)).case, null, 'a rejected case must not be returned')
  })
}

test('a non-object case is rejected without throwing', () => {
  for (const raw of [null, undefined, 42, 'case', [], () => {}]) {
    const r = validateCase(raw)
    assert.equal(r.case, null)
    assert.ok(r.errors.length > 0, `${JSON.stringify(raw)} must be rejected`)
  }
})

/* --------------------------------------------- expectations are closed, not open */

test('a typo in expected.reason is REJECTED, not bucketed — otherwise the case can never fail', () => {
  const errors = errorsFor({ expected: { ...goodCase().expected, reason: 'thresold_met' } })
  assert.ok(errors.includes('invalid_case:expected.reason'), errors)
})

for (const field of ['taskType', 'decision', 'lane', 'mode']) {
  test(`a typo in expected.${field} is rejected`, () => {
    const errors = errorsFor({ expected: { ...goodCase().expected, [field]: 'nonsense' } })
    assert.ok(errors.includes(`invalid_case:expected.${field}`), errors)
  })
}

test('every expected.reason the schema accepts is a reason the engine can actually produce', () => {
  // Imported, never re-typed. A reason added to DECIDE_REASONS is accepted in the same commit.
  for (const reason of DECIDE_REASONS) {
    const klass = reason === 'threshold_met' ? 'delegate' : 'primary'
    const decision = reason === 'threshold_met' ? 'deny' : 'allow'
    const r = validateCase(goodCase({ expected: { ...goodCase().expected, reason, class: klass, decision } }))
    assert.deepEqual(r.errors, [], `${reason} should be accepted: ${r.errors.join(' | ')}`)
  }
})

test('class and reason must agree, because threshold_met is the only delegating reason', () => {
  // routing.mjs has exactly one build() with delegate: true. `class` is redundant with `reason` on
  // purpose — it is the half a reviewer reads — and the cross-check is what stops a skim landing on
  // the wrong side of the gate.
  const errors = errorsFor({ expected: { ...goodCase().expected, class: 'primary' } })
  assert.ok(errors.includes('contradicts reason'), errors)

  const other = errorsFor({
    expected: { ...goodCase().expected, class: 'delegate', reason: 'below_threshold', decision: 'allow' },
  })
  assert.ok(other.includes('contradicts reason'), other)
})

/* --------------------------------------- descriptive enums stay open and bucket */

test('an unknown category is preserved, bucketed as other, and warned — never rejected', () => {
  const r = validateCase(goodCase({ category: 'archaeology' }))
  assert.deepEqual(r.errors, [], 'a descriptive enum must not reject')
  assert.equal(r.case.category, 'archaeology', 'the value is preserved verbatim')
  assert.equal(r.case.categoryBucket, 'other', 'and bucketed for grouping')
  assert.ok(r.warnings.includes('unknown_enum:category=archaeology'), r.warnings.join(' | '))
})

test('an unknown shape warns but loads, and counts toward no required shape', () => {
  const r = validateCase(goodCase({ shapes: ['medium_file', 'interpretive_dance'] }))
  assert.deepEqual(r.errors, [])
  assert.ok(r.warnings.some((w) => w.includes('interpretive_dance')), r.warnings.join(' | '))
  assert.equal(CONTENT_SHAPES.includes('interpretive_dance'), false)
})

test('bucketCategory handles a non-string without throwing', () => {
  assert.deepEqual(bucketCategory(undefined), { category: null, categoryBucket: 'other' })
  assert.deepEqual(bucketCategory('bulk_read'), { category: 'bulk_read', categoryBucket: 'bulk_read' })
})

/* ----------------------------------------------- harness-specific requirements */

test('a hook case may not carry a task, because the hook sends a frozen literal', () => {
  // hook/run.mjs sends BULK_READ_TASK and nothing else: a PreToolUse payload says which file,
  // never why. A per-case task there would be a claim about behaviour that does not exist.
  const errors = errorsFor({
    harness: 'hook',
    task: 'summarise this',
    expected: { ...goodCase().expected, outcome: 'delegated' },
  })
  assert.ok(errors.includes('task_on_hook_case'), errors)
})

test('a dispatch case requires a task and quality criteria', () => {
  const noTask = errorsFor({ harness: 'dispatch', expected: { ...goodCase().expected, dispatchStatus: 'ok', dispatchReason: 'completed' } })
  assert.ok(noTask.includes('invalid_case:task'), noTask)
  assert.ok(noTask.includes('invalid_case:qualityCriteria'), noTask)
})

test('a hook case requires an outcome and a decide case refuses one', () => {
  const hookNoOutcome = errorsFor({ harness: 'hook' })
  assert.ok(hookNoOutcome.includes('invalid_case:expected.outcome'), hookNoOutcome)

  const decideWithOutcome = errorsFor({ expected: { ...goodCase().expected, outcome: 'delegated' } })
  assert.ok(decideWithOutcome.includes('only meaningful for a hook case'), decideWithOutcome)
})

test('dispatchStatus and dispatchReason are refused outside a dispatch case', () => {
  const errors = errorsFor({ expected: { ...goodCase().expected, dispatchStatus: 'ok' } })
  assert.ok(errors.includes('only meaningful for a dispatch case'), errors)
})

test('files may be empty only for a decide case', () => {
  assert.deepEqual(validateCase(goodCase({ files: [] })).errors, [], 'a decide case may name no files')
  const hook = errorsFor({ files: [], harness: 'hook', expected: { ...goodCase().expected, outcome: 'not_delegated' } })
  assert.ok(hook.includes('may only be empty for a decide case'), hook)
})

/* ------------------------------------- quality criteria on an unmeasurable case */

test('qualityCriteria on a primary case is REJECTED, not ignored', () => {
  // With no output every criterion is vacuously satisfied or vacuously skipped. Ignoring the block
  // would make the corpus look several times better covered than it is.
  const errors = errorsFor({
    expected: { ...goodCase().expected, class: 'primary', reason: 'below_threshold', decision: 'allow' },
    qualityCriteria: { requiredTerms: ['anything'] },
  })
  assert.ok(errors.includes('quality_on_primary_case'), errors)
})

test('a malformed criterion fails the case at load rather than quietly not running', () => {
  const unknownKind = errorsFor({ qualityCriteria: { vibeCheck: ['x'] } })
  assert.ok(unknownKind.includes('unknown quality criterion'), unknownKind)

  const shortForbidden = errorsFor({ qualityCriteria: { forbiddenTerms: ['3'] } })
  assert.ok(shortForbidden.includes('allowShort'), shortForbidden)

  const exactCount = errorsFor({ qualityCriteria: { counts: [{ term: 'export', expected: 3 }] } })
  assert.ok(exactCount.includes('min and/or max'), exactCount)
})

test('every evaluator kind is accepted by the loader, so the two cannot desync', () => {
  const SPEC_FOR = {
    requiredTerms: ['alpha'],
    forbiddenTerms: ['beta'],
    requiredEntities: ['gamma'],
    fileReferences: ['files/at.ts'],
    counts: [{ term: 'delta', min: 1 }],
    exactFacts: ['epsilon'],
    lineCitations: [{ fact: 'zeta', line: 10, decoyLines: [20] }],
  }
  for (const kind of EVALUATOR_KINDS) {
    assert.ok(Object.hasOwn(SPEC_FOR, kind), `${kind} has no spec in this test; a new kind needs one`)
    const r = validateCase(goodCase({ qualityCriteria: { [kind]: SPEC_FOR[kind] } }))
    assert.deepEqual(r.errors, [], `${kind} should be accepted: ${r.errors.join(' | ')}`)
  }
})

/* ----------------------------------------------------------------- countLines */

test('countLines treats a trailing newline as terminating the last line, not starting a new one', () => {
  // THE one definition, because "1389 lines" is otherwise three different numbers. The repo's
  // original corpus README used split('\n').length, which counts the empty position after a
  // trailing newline and so reported a 2-line file as 3.
  const CASES = Object.freeze([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['a\n\n', 2],
    ['\n', 1],
  ])
  for (const [text, want] of CASES) {
    assert.equal(countLines(text), want, `countLines(${JSON.stringify(text)})`)
  }
  assert.equal(countLines(null), 0, 'a non-string counts as nothing rather than throwing')
})

/* ---------------------------------------------------------------- vocabularies */

test('the sixteen routing input fields match the engine exactly', () => {
  assert.equal(ROUTING_INPUT_FIELDS.length, 16, 'decide() declares sixteen input fields')
  // Spot-check the two whose absence would silently weaken a case: an unknown key is rejected, so a
  // misspelling cannot be dropped by the engine's own Object.hasOwn reads.
  assert.ok(ROUTING_INPUT_FIELDS.includes('targetedRead'))
  assert.ok(ROUTING_INPUT_FIELDS.includes('estimatedInputTokens'))
})

test('the harness list is closed and holds exactly the three layers that exist', () => {
  assert.deepEqual([...HARNESSES], ['decide', 'hook', 'dispatch'])
})

test('expected.taskType accepts every routing task type, including the undelegatable ones', () => {
  for (const taskType of ROUTING_TASK_TYPES) {
    const r = validateCase(
      goodCase({
        expected: { ...goodCase().expected, taskType, class: 'primary', reason: 'task_type_excluded', decision: 'allow' },
      }),
    )
    assert.deepEqual(r.errors, [], `${taskType}: ${r.errors.join(' | ')}`)
  }
})

/* ------------------------------------------------------- the task-intent block */

test('the schema accepts the same task-intent fields the engine renders, and no others', () => {
  // `schema.mjs` re-declares the field list rather than importing it, because it is deliberately
  // the one framework module with no engine dependency beyond the routing vocabulary. That makes
  // a drift possible, so it is asserted here: a field the schema accepted and the builder never
  // rendered would be a field an author could set to no effect.
  for (const field of TASK_INTENT_FIELDS) {
    assert.deepEqual(
      validateCase(goodDispatchCase({ taskIntent: { [field]: 'a value' } })).errors,
      [],
      `${field} must be an accepted task-intent field`,
    )
  }
  assert.match(
    dispatchErrorsFor({ taskIntent: { requestedInfo: 'typo' } }),
    /taskIntent\.requestedInfo is not a known task-intent field/,
    'an unknown field inside the block must be rejected, not ignored as slack',
  )
})

test('a task intent is rejected on a hook case, with a code that names the reason', () => {
  // The same argument as `task_on_hook_case`, one step sharper: a hook case's intent comes from a
  // session transcript the harness does not write, gated by a flag the eval does not set. A case
  // file declaring one would describe a request the hook cannot make.
  assert.match(
    errorsFor({ harness: 'hook', task: undefined, taskIntent: { task: 'x' } }),
    /task_intent_on_hook_case/,
  )
  assert.match(
    errorsFor({ harness: 'decide', task: undefined, taskIntent: { task: 'x' } }),
    /task_intent_on_hook_case/,
  )
})

test('an all-empty task intent is rejected rather than accepted as a no-op', () => {
  // Otherwise a case would advertise an intent it does not have, and its `intent` variant would
  // differ from its `generic` variant by nothing at all while claiming to be a comparison.
  assert.match(dispatchErrorsFor({ taskIntent: {} }), /taskIntent must populate at least one field/)
  // Blank after trim is rejected, not counted: `normalizeTaskIntent` would discard it, and a case
  // whose intent variant is identical to its generic one is not a comparison.
  assert.match(
    dispatchErrorsFor({ taskIntent: { task: '   ' } }),
    /taskIntent\.task must be 1-2000 non-blank characters/,
  )
  assert.match(dispatchErrorsFor({ taskIntent: { task: '   ' } }), /taskIntent must populate at least one field/)
  assert.match(dispatchErrorsFor({ taskIntent: 'a string' }), /taskIntent must be an object/)
})

test('the frozen case carries taskIntent as an explicit null when none was declared', () => {
  // Absent and null must not be two ways of saying the same thing — the module's own rule.
  const r = validateCase(goodDispatchCase())
  assert.deepEqual(r.errors, [])
  assert.ok(Object.hasOwn(r.case, 'taskIntent'))
  assert.equal(r.case.taskIntent, null)
})
