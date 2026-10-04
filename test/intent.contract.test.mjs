/**
 * The task-intent contract: normalization, the shape of "nothing", and what is never invented.
 *
 * One rule carries this file. UNKNOWN STAYS NULL. `normalizeTaskIntent` narrows and discards; it
 * has no branch that fills a field in, and the tests below are written to fail if one is ever
 * added — because the whole safety argument for forwarding intent at all is that what reaches the
 * worker is what the developer actually wrote, clamped, and nothing else.
 *
 * The second rule is that "no intent" has exactly ONE representation: `null`. An all-null object
 * and `null` must not be two ways of saying the same thing, because the builder downstream keys
 * on that distinction to decide whether to emit a section at all — and two spellings of "nothing"
 * would mean the default path and the opted-out path could differ by an empty heading.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BULK_READ_TASK,
  TASK_INTENT_FIELDS,
  TASK_INTENT_SOURCE,
  normalizeTaskIntent,
} from '../plugins/model-router/lib/hook/adapter.mjs'
import { TASK_INTENT_SOURCES } from '../plugins/model-router/lib/telemetry/record.mjs'
import { TASK_INTENT_FIELDS as BUILDER_FIELDS } from '../plugins/model-router/lib/dispatch/task.mjs'

/* ------------------------------------------------------------------ the vocabulary */

test('the adapter and the builder agree on the field list, name for name and in order', () => {
  // Two modules declare it because the adapter imports nothing at all by design. That makes a
  // drift possible, so it is asserted rather than trusted: a field the adapter accepts and the
  // builder never renders would be a field that silently does nothing.
  assert.deepEqual([...TASK_INTENT_FIELDS], [...BUILDER_FIELDS])
})

test('every source the adapter can emit is a value the telemetry layer will store', () => {
  // The adapter cannot import the enum, so the two are checked against each other here. A source
  // the adapter produced and `toEnum` did not recognise would stamp `unknown_enum` on every
  // delegated row, poisoning the one signal the store has for "something is actually wrong".
  for (const source of Object.values(TASK_INTENT_SOURCE)) {
    assert.ok(TASK_INTENT_SOURCES.includes(source), `${source} is not a storable task_intent_source`)
  }
})

/* ------------------------------------------------------- the shape of nothing */

test('an absent, empty or malformed intent is null, which is the one spelling of nothing', () => {
  for (const raw of [
    undefined,
    null,
    {},
    'a string',
    42,
    [],
    [{ task: 'x' }],
    { task: '' },
    { task: '   ' },
    { task: null },
    { unrelated: 'ignored' },
    { task: 42 },
    { task: {} },
  ]) {
    assert.equal(normalizeTaskIntent(raw), null, `${JSON.stringify(raw)} must normalize to null`)
  }
})

test('an object whose only populated field is unknown is nothing, not something', () => {
  // Otherwise a typo'd field name would produce an intent with no content, and the builder would
  // emit a requirements section holding only the lane's standing instructions — a changed request
  // caused by a spelling mistake.
  assert.equal(normalizeTaskIntent({ requestedInfo: 'typo' }), null)
})

/* ------------------------------------------------------------- normalization */

test('a populated field survives verbatim apart from surrounding whitespace', () => {
  const intent = normalizeTaskIntent({ task: '  Find every deprecated call.\n' })
  assert.equal(intent.task, 'Find every deprecated call.')
})

test('every contract field is present on the result, with null for the ones not supplied', () => {
  // A key is never omitted. "Absent" and "null" must not be two ways of saying the same thing —
  // the same rule the telemetry record keeps, for the same reason.
  const intent = normalizeTaskIntent({ task: 'Name the exports.' })
  assert.deepEqual(Object.keys(intent).sort(), [...TASK_INTENT_FIELDS, 'source'].sort())
  for (const field of TASK_INTENT_FIELDS) {
    if (field !== 'task') assert.equal(intent[field], null, `${field} must be null, not absent`)
  }
})

test('all five fields are carried when all five are supplied', () => {
  const raw = {
    task: 'Find every deprecated handler.',
    objective: 'Retire them before the release.',
    requestedInformation: 'the key and the line',
    constraints: 'every match, not the first',
    outputFormat: 'one per line',
  }
  const intent = normalizeTaskIntent(raw)
  for (const field of TASK_INTENT_FIELDS) assert.equal(intent[field], raw[field])
})

test('nothing is inferred: a field that was not supplied is never derived from one that was', () => {
  // The load-bearing test of this file. Production can only ever fill `task`, and an
  // implementation that "helpfully" copied it into `objective`, or guessed an `outputFormat` from
  // its wording, would be inventing intent — which the phase brief forbids and which would make
  // the worker's request something the developer did not ask for.
  const intent = normalizeTaskIntent({ task: 'Return the answer as JSON, listing every match.' })
  assert.equal(intent.objective, null)
  assert.equal(intent.requestedInformation, null)
  assert.equal(intent.constraints, null)
  assert.equal(intent.outputFormat, null)
})

/* ------------------------------------------------------------------- the source */

test('a recognised source is kept and an unrecognised one becomes null, never a guess', () => {
  assert.equal(normalizeTaskIntent({ task: 'x', source: 'transcript' }).source, 'transcript')
  assert.equal(normalizeTaskIntent({ task: 'x', source: 'none' }).source, 'none')
  for (const bad of ['Transcript', 'other', 'llm', '', null, undefined, 7, {}]) {
    assert.equal(normalizeTaskIntent({ task: 'x', source: bad }).source, null, `${bad} must not be kept`)
  }
})

/* --------------------------------------------------------------------- freezing */

test('the result is frozen, so nothing downstream can add a field after the fact', () => {
  const intent = normalizeTaskIntent({ task: 'x' })
  assert.ok(Object.isFrozen(intent))
  assert.throws(() => {
    'use strict'
    intent.task = 'something else'
  })
})

/* ------------------------------------------------------- the default is untouched */

test('the frozen generic task is unchanged, single-line, and still says what it always said', () => {
  // It remains the default request, so it remains pinned. A CR here would make the two CI
  // platforms disagree byte for byte on every stored row.
  assert.equal(BULK_READ_TASK.includes('\n'), false)
  assert.equal(BULK_READ_TASK.includes('\r'), false)
  assert.match(BULK_READ_TASK, /Preserve identifiers/)
  assert.match(BULK_READ_TASK, /Summarise this file/)
})
