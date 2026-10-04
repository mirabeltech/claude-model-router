/**
 * The routing input contract.
 *
 * One governing assertion, repeated per field: UNKNOWN IS NEVER THE FAVORABLE VALUE. Absent,
 * null, malformed and hostile all have to land on the answer that cannot cause harm, and `0` has
 * to stay distinguishable from "we were not told".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide, normalizeInput } from '../plugins/model-router/lib/routing.mjs'
import { HOSTILE_VALUES, bulkReadInput, routingConfig } from './helpers/routing-input.mjs'

const norm = (raw) => normalizeInput(raw).input
const warns = (raw) => normalizeInput(raw).warnings

/* ----------------------------------------------------------------- the shape */

test('the normalized input carries exactly the declared sixteen fields', () => {
  assert.deepEqual(Object.keys(norm(bulkReadInput())).sort(), [
    'estimatedInputTokens',
    'fileCount',
    'fullRead',
    'inputBytes',
    'interactive',
    'latencySensitive',
    'lineCount',
    'paths',
    'projectPath',
    'recentlyEdited',
    'requestedOutput',
    'targetedRead',
    'taskType',
    'toolName',
    'workerAvailable',
    'workerUnavailableReason',
  ])
})

test('the normalized input and its path list are frozen', () => {
  const input = norm(bulkReadInput())
  assert.ok(Object.isFrozen(input))
  assert.ok(Object.isFrozen(input.paths))
})

test('an inherited key is not read — a caller cannot smuggle one in via the prototype', () => {
  // The same defence projectRecord() uses on the telemetry side. Reading via Object.hasOwn means
  // a polluted Object.prototype cannot turn an absent field into a favorable one.
  const hostile = JSON.parse('{"__proto__": {"workerAvailable": true}, "taskType": "bulk_read"}')
  assert.equal(norm(hostile).workerAvailable, false)
})

test('a __proto__ or constructor key in the input never reaches the normalized object', () => {
  const input = norm({ taskType: 'bulk_read', constructor: 'x', __proto__: null })
  assert.equal(Object.hasOwn(input, 'constructor'), false)
  assert.equal(input.taskType, 'bulk_read')
})

/* ------------------------------------------------------------- the null >= 0 trap */

test('an unknown count never satisfies a threshold, because null >= 0 is true in JavaScript', () => {
  // This is the single sharpest footgun in the file. `null >= 1` is false but `null >= 0` is TRUE,
  // because null coerces to 0 in a relational comparison. Every comparison in routing.mjs is
  // therefore written `isKnown(x) && x >= t`. If someone removes an isKnown() guard, this fails.
  assert.equal(null >= 0, true, 'the language still behaves as this test is guarding against')
  const d = decide(bulkReadInput({ fileCount: null }), routingConfig({ routing: { bulkRead: { minFiles: 1 } } }))
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'below_threshold')
})

test('an unknown file count fails the floor and the cap at the same time', () => {
  const d = decide(bulkReadInput({ fileCount: null }), routingConfig())
  assert.equal(d.reason, 'below_threshold', 'not over_max_files — unknown is unfavorable both ways')
})

/* ------------------------------------------------------------------- counts */

for (const field of ['fileCount', 'lineCount', 'inputBytes', 'estimatedInputTokens']) {
  test(`${field} accepts only a non-negative integer; everything else becomes null`, () => {
    assert.equal(norm({ [field]: 7 })[field], 7)
    assert.equal(norm({ [field]: 0 })[field], 0, 'a measured zero is not unknown')
    for (const v of [NaN, Infinity, -Infinity, -1, 0.5, '350', '', 'true', true, false, {}, [], () => {}]) {
      assert.equal(norm({ [field]: v })[field], null, `${field} accepted ${String(v)}`)
    }
  })

  test(`${field} is null when absent or explicitly null, with no warning either way`, () => {
    assert.equal(norm({})[field], null)
    assert.equal(norm({ [field]: null })[field], null)
    assert.equal(warns({ [field]: null }).length, 0, 'absence is a legitimate answer, not a defect')
  })

  test(`a malformed ${field} is warned about, so the row records that the gate was blind`, () => {
    assert.deepEqual(warns({ [field]: '350' }), [`type:${field}`])
  })
}

test('a numeric string is not parsed — string coercion belongs to the config env layer only', () => {
  assert.equal(norm({ lineCount: '900' }).lineCount, null)
})

test('negative zero folds to zero so two spellings of a measured zero cannot diverge', () => {
  assert.equal(Object.is(norm({ inputBytes: -0 }).inputBytes, 0), true)
})

/* ----------------------------------------------------------------- booleans */

const PESSIMISTIC = Object.freeze({
  targetedRead: true,
  fullRead: false,
  recentlyEdited: true,
  latencySensitive: true,
  interactive: true,
  workerAvailable: false,
})

for (const [field, pessimistic] of Object.entries(PESSIMISTIC)) {
  test(`an unknown ${field} reads as ${pessimistic}, the answer that cannot cause harm`, () => {
    assert.equal(norm({})[field], pessimistic)
    assert.equal(norm({ [field]: null })[field], pessimistic)
  })

  test(`a malformed ${field} reads as ${pessimistic} and is warned about`, () => {
    for (const v of ['true', 1, {}, []]) {
      assert.equal(norm({ [field]: v })[field], pessimistic, `${field} accepted ${String(v)}`)
      assert.ok(warns({ [field]: v }).includes(`type:${field}`))
    }
  })

  test(`an explicit ${field} is honoured in both directions`, () => {
    assert.equal(norm({ [field]: true })[field], true)
    assert.equal(norm({ [field]: false })[field], false)
  })
}

test('missing worker availability does not produce delegation', () => {
  // The caller owns the readiness probe. Silence means "I did not check", not "it is ready".
  const input = bulkReadInput()
  delete input.workerAvailable
  const d = decide(input, routingConfig())
  assert.equal(d.delegate, false)
  assert.equal(d.reason, 'worker_not_ready')
})

/* ---------------------------------------------------------------- task type */

test('an absent task type becomes unknown, never general', () => {
  // `general` is a real category a caller can assert; it must not also be the fallback, or an
  // unlabelled task would silently acquire a classification it was never given.
  assert.equal(norm({}).taskType, 'unknown')
  assert.equal(norm({ taskType: null }).taskType, 'unknown')
})

test('an unrecognized task type becomes unknown and is warned about', () => {
  // The input enums are CLOSED, unlike the telemetry record enums. An open enum on a security
  // input would let a typo'd `architecure` fall straight past the exclusion list.
  assert.equal(norm({ taskType: 'architecure' }).taskType, 'unknown')
  assert.deepEqual(warns({ taskType: 'architecure' }), ['unknown_enum:taskType'])
})

test('a non-string task type becomes unknown with a type warning', () => {
  assert.equal(norm({ taskType: 7 }).taskType, 'unknown')
  assert.deepEqual(warns({ taskType: 7 }), ['type:taskType'])
})

/* -------------------------------------------------------------------- paths */

test('paths are normalized to one spelling: forward slashes, lower case, no trailing separator', () => {
  assert.deepEqual(norm({ paths: ['C:\\Proj\\Src\\A.TS', '/x//y/'] }).paths, ['c:/proj/src/a.ts', '/x/y'])
})

test('a non-array paths value becomes an empty list with a warning', () => {
  assert.deepEqual(norm({ paths: 'a.ts' }).paths, [])
  assert.ok(warns({ paths: 'a.ts' }).includes('type:paths'))
})

test('non-string entries are dropped from paths and warned about', () => {
  assert.deepEqual(norm({ paths: ['a.ts', 7, null, '', 'b.ts'] }).paths, ['a.ts', 'b.ts'])
  assert.ok(warns({ paths: ['a.ts', 7] }).includes('type:paths'))
})

test('an absurd path list is clamped and the clamp is recorded', () => {
  const many = Array.from({ length: 1500 }, (_, i) => `/p/f${i}.ts`)
  assert.equal(norm({ paths: many }).paths.length, 1000)
  assert.ok(warns({ paths: many }).includes('clamped:paths'))
})

test('an over-long path is truncated rather than rejected', () => {
  const long = `/p/${'a'.repeat(6000)}.ts`
  assert.equal(norm({ paths: [long] }).paths[0].length, 4096)
})

/* ------------------------------------------------------------------ strings */

test('an over-long tool name is clamped', () => {
  assert.equal(norm({ toolName: 'R'.repeat(500) }).toolName.length, 128)
})

test('requestedOutput is lower-cased and trimmed so matching is not whitespace-sensitive', () => {
  assert.equal(norm({ requestedOutput: '  PATCH ' }).requestedOutput, 'patch')
})

test('a non-string projectPath becomes null with a warning', () => {
  assert.equal(norm({ projectPath: 7 }).projectPath, null)
  assert.ok(warns({ projectPath: 7 }).includes('type:projectPath'))
})

test('an unrecognized worker-unavailable label is discarded and warned about', () => {
  // The label must stay inside the telemetry reason vocabulary or it would poison the enum.
  assert.equal(norm({ workerUnavailableReason: 'because' }).workerUnavailableReason, null)
  assert.deepEqual(warns({ workerUnavailableReason: 'because' }), ['unknown_enum:workerUnavailableReason'])
})

test('a discarded worker-unavailable label falls back to worker_not_ready, not to delegation', () => {
  const d = decide(bulkReadInput({ workerAvailable: false, workerUnavailableReason: 'because' }), routingConfig())
  assert.equal(d.reason, 'worker_not_ready')
})

/* --------------------------------------------------------------- coherence */

test('a read that claims to be both targeted and full resolves to its pessimistic side', () => {
  const { input, warnings } = normalizeInput({ targetedRead: true, fullRead: true })
  assert.equal(input.targetedRead, true)
  assert.equal(input.fullRead, false)
  assert.ok(warnings.includes('incoherent:read_shape'))
})

test('a tool name from the wrong lane is recorded but never changes the decision', () => {
  // The set of gated tools is declared in hooks.json. Two places deciding that is how a gate
  // starts firing on Write.
  const d = decide(bulkReadInput({ toolName: 'Write' }), routingConfig())
  assert.equal(d.delegate, true, 'the tool name is advisory only')
  assert.ok(d.inputWarnings.includes('incoherent:tool_for_task'))
})

/* ------------------------------------------------------------------ warnings */

test('input warnings are deduplicated and sorted, so the field is deterministic', () => {
  const d = decide({ taskType: 'bulk_read', fileCount: '1', lineCount: '2', inputBytes: '3' }, routingConfig())
  assert.deepEqual(d.inputWarnings, ['type:fileCount', 'type:inputBytes', 'type:lineCount'])
  assert.ok(Object.isFrozen(d.inputWarnings))
})

test('a clean input produces no warnings at all', () => {
  assert.deepEqual(decide(bulkReadInput(), routingConfig()).inputWarnings, [])
})

test('normalizeInput never throws, whatever it is handed', () => {
  for (const v of HOSTILE_VALUES) {
    assert.doesNotThrow(() => normalizeInput(v), `normalizeInput threw on ${String(v)}`)
    assert.equal(norm(v).taskType, 'unknown')
  }
})
