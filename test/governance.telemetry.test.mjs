/**
 * The governance columns, as they land in the store.
 *
 * Phase 9 added eight fields. They are additive and entirely nullable, so `SCHEMA_VERSION` stays
 * 1 and a reader built against the phase-8 schema ignores them — but "additive" is a claim about
 * compatibility that has to be checked, not asserted.
 *
 * Three rules are on trial:
 *
 *  1. EVERY FIELD IS ALWAYS PRESENT. A key is never omitted and `undefined` never appears.
 *     "Absent key" and "null key" must not be two ways of saying the same thing.
 *
 *  2. null MEANS UNAVAILABLE, NEVER ZERO, and `budget_remaining === null` if and only if
 *     `budget_measurement_status === 'unavailable'`. `limit - unknown` is never computed as
 *     though unknown were zero, which would report the full budget as available.
 *
 *  3. GOVERNANCE NOT CONSULTED IS ITS OWN STATE. All eight columns are null on a row where
 *     routing refused before the budget was ever asked, and that is distinguishable from a row
 *     where governance ran and allowed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEvent } from '../plugins/model-router/lib/telemetry/event.mjs'
import {
  BUDGET_MEASUREMENT_STATUS_VALUES,
  BUDGET_SCOPE_VALUES,
  CALC_VERSION,
  FIELD_ORDER,
  GOVERNANCE_DECISION_VALUES,
  GOVERNANCE_REASON_VALUES,
  RESERVATION_STATUS_VALUES,
  SCHEMA_VERSION,
  bucket,
} from '../plugins/model-router/lib/telemetry/record.mjs'
import { serializeRecord } from '../plugins/model-router/lib/telemetry/contract.mjs'
import { telemetryConfig } from './helpers/telemetry-dir.mjs'

/** The eight columns phase 9 added. */
const GOVERNANCE_FIELDS = Object.freeze([
  'governance_decision',
  'governance_reason',
  'budget_scope',
  'budget_limit',
  'budget_remaining',
  'budget_measurement_status',
  'reservation_tokens',
  'reservation_status',
])

const event = (governance = null) =>
  buildEvent({
    config: telemetryConfig('x'),
    governance,
    now: Date.parse('2026-10-04T12:00:00.000Z'),
    eventId: '11111111-2222-3333-4444-555555555555',
  })

const allowed = {
  decision: 'allow',
  reason: 'within_budget',
  scope: 'daily',
  limit: 1000,
  remaining: 900,
  measurementStatus: 'measured',
  reservationTokens: 50,
  reservationStatus: 'reserved',
}

/* -------------------------------------------------------------- the schema */

test('the governance columns are declared in the schema exactly once each', () => {
  for (const field of GOVERNANCE_FIELDS) {
    assert.ok(FIELD_ORDER.includes(field), `${field} is missing from FIELD_ORDER`)
  }
  assert.equal(new Set(FIELD_ORDER).size, FIELD_ORDER.length, 'duplicate field in FIELD_ORDER')
})

test('adding them did not bump the schema or the calc version', () => {
  // Additive and nullable is the one change that does not break a reader, which is the whole
  // reason they went in this shape rather than as a nested object or a version bump.
  assert.equal(SCHEMA_VERSION, 1)
  assert.equal(CALC_VERSION, 1, 'no formula and no null rule changed, so the calc version holds')
})

test('every governance column is present on every row, consulted or not', () => {
  // Rule 1. `projectRecord()` turns an absent key into an explicit null, and this is the test
  // that proves the new fields ride that mechanism rather than going missing.
  for (const governance of [null, allowed]) {
    const row = event(governance)
    for (const field of GOVERNANCE_FIELDS) {
      assert.ok(field in row, `${field} absent when governance=${governance === null ? 'null' : 'set'}`)
      assert.notEqual(row[field], undefined, `${field} is undefined, which the schema forbids`)
    }
  }
})

test('a row where governance was never consulted has all eight columns null', () => {
  // Rule 3. Routing refused first, so the budget was never asked. That is not "allowed".
  const row = event(null)
  for (const field of GOVERNANCE_FIELDS) {
    assert.equal(row[field], null, `${field} should be null when governance did not run`)
  }
})

test('an allowed delegation records the decision, the scope and the headroom', () => {
  const row = event(allowed)
  assert.equal(row.governance_decision, 'allow')
  assert.equal(row.governance_reason, 'within_budget')
  assert.equal(row.budget_scope, 'daily')
  assert.equal(row.budget_limit, 1000)
  assert.equal(row.budget_remaining, 900)
  assert.equal(row.budget_measurement_status, 'measured')
  assert.equal(row.reservation_tokens, 50)
  assert.equal(row.reservation_status, 'reserved')
})

test('a refusal is distinguishable from an allowance, and from a provider error', () => {
  // The brief is explicit that `provider_error` must never stand in for a governance decision.
  // A budget refusal is not a provider failure, and a reader has to be able to tell them apart.
  const row = event({
    decision: 'deny',
    reason: 'daily_budget_exceeded',
    scope: 'daily',
    limit: 100,
    remaining: 0,
    measurementStatus: 'measured',
    reservationTokens: null,
    reservationStatus: 'none',
  })
  assert.equal(row.governance_decision, 'deny')
  assert.equal(row.governance_reason, 'daily_budget_exceeded')
  assert.equal(row.error_code, null, 'a budget refusal is not an error')
  assert.equal(row.status, 'skipped', 'and it is not a failed call either')
})

/* -------------------------------------------- unknown is not zero, in a row */

test('budget_remaining is null exactly when the measurement is unavailable', () => {
  // INV-1, applied to the governance columns. The money columns carry it via `statusFor()`;
  // these carry it because the policy layer never produces one without the other.
  const unknown = event({
    decision: 'allow',
    reason: 'cost_unknown',
    scope: 'daily',
    limit: 5,
    remaining: null,
    measurementStatus: 'unavailable',
    reservationTokens: 10,
    reservationStatus: 'reserved',
  })
  assert.equal(unknown.budget_remaining, null)
  assert.equal(unknown.budget_measurement_status, 'unavailable')

  const known = event(allowed)
  assert.notEqual(known.budget_remaining, null)
  assert.notEqual(known.budget_measurement_status, 'unavailable')
})

test('an unknown remaining is never written as zero, and a real zero is never written as null', () => {
  // THE DISTINCTION THE WHOLE PROJECT RESTS ON. "We could not tell how much is left" and
  // "nothing is left" lead to opposite decisions, so they must not share a representation.
  const cannotTell = event({
    decision: 'allow',
    reason: 'usage_unknown',
    limit: 100,
    remaining: null,
    measurementStatus: 'unavailable',
  })
  assert.equal(cannotTell.budget_remaining, null, 'unknown must not become 0')

  const exhausted = event({
    decision: 'deny',
    reason: 'daily_budget_exceeded',
    limit: 100,
    remaining: 0,
    measurementStatus: 'measured',
  })
  assert.equal(exhausted.budget_remaining, 0, 'a measured zero must not become null')
  assert.equal(exhausted.budget_measurement_status, 'measured')
})

test('a null limit stays null rather than becoming zero or infinity', () => {
  // Part 2 of the brief, in the store: "Never convert null into zero. Never convert null into
  // infinity inside telemetry."
  const row = event({ decision: 'allow', reason: 'budget_not_configured', limit: null, remaining: null })
  assert.equal(row.budget_limit, null)
  assert.equal(row.budget_remaining, null)
})

test('a configured zero limit is written as zero, not as unconfigured', () => {
  const row = event({
    decision: 'deny',
    reason: 'run_budget_exceeded',
    scope: 'run',
    limit: 0,
    remaining: 0,
    measurementStatus: 'measured',
  })
  assert.equal(row.budget_limit, 0, 'a deliberate zero budget is a real limit')
})

test('an unmeasurable reservation is null, never zero tokens', () => {
  const row = event({ decision: 'allow', reason: 'within_budget', reservationTokens: null })
  assert.equal(row.reservation_tokens, null)
})

/* ---------------------------------------------------------------- the enums */

test('the governance enums are open on read and bucket an unknown value as other', () => {
  // House rule: a writer emits only listed values, a reader preserves an unknown one verbatim
  // and buckets it as `other`. That is what lets a newer writer and an older reader coexist.
  for (const values of [
    GOVERNANCE_DECISION_VALUES,
    GOVERNANCE_REASON_VALUES,
    BUDGET_SCOPE_VALUES,
    RESERVATION_STATUS_VALUES,
  ]) {
    assert.ok(values.includes('other'), `${values.join(',')} has no other bucket`)
    const b = bucket('something-from-the-future', values)
    assert.equal(b.raw, 'something-from-the-future', 'the raw value must be preserved')
    assert.equal(b.bucket, 'other')
  }
})

test('the measurement status enum is closed, because unknown is already one of its values', () => {
  // Deliberately NO `other`: the three states are measured, estimated and unavailable, and a
  // fourth would mean we had stopped knowing what we knew.
  assert.deepEqual([...BUDGET_MEASUREMENT_STATUS_VALUES], ['measured', 'estimated', 'unavailable'])
})

test('an unrecognised governance value is preserved and flagged, not dropped', () => {
  const row = event({ decision: 'maybe', reason: 'because', scope: 'fortnightly', reservationStatus: 'pending' })
  assert.equal(row.governance_decision, 'maybe', 'the value is preserved verbatim')
  assert.ok(row.validation_warnings > 0, 'but it is flagged')
  assert.ok(
    row.validation_codes.includes('unknown_enum:governance_decision'),
    `codes were ${row.validation_codes}`,
  )
})

test('a hostile governance object cannot inject a field or a type', () => {
  const row = event({
    decision: { nope: true },
    reason: 42,
    limit: 'free',
    remaining: Number.NaN,
    reservationTokens: -5,
  })
  assert.equal(row.governance_decision, null, 'an object is not an enum value')
  assert.equal(row.governance_reason, null, 'a number is not an enum value')
  assert.equal(row.budget_limit, null, 'a string is not a limit')
  assert.equal(row.budget_remaining, null, 'NaN is not a measurement')
  assert.equal(row.reservation_tokens, null, 'a negative token count is not a count')
})

/* ----------------------------------------------------------- serialisation */

test('a row carrying governance serialises to one line and survives a round trip', () => {
  const row = event(allowed)
  const out = serializeRecord(row)
  assert.deepEqual(out.problems, [], 'serialisation reported problems')
  assert.notEqual(out.line, null, 'the record did not serialise')

  const text = out.line.toString('utf8')
  assert.equal(text.endsWith('\n'), true, 'a record must end in exactly one newline')
  assert.equal(text.trimEnd().includes('\n'), false, 'a record must be one line')

  const parsed = JSON.parse(text)
  for (const field of GOVERNANCE_FIELDS) {
    assert.deepEqual(parsed[field], row[field], `${field} did not survive the round trip`)
  }
})

test('the governance columns are serialised in FIELD_ORDER, after the existing ones', () => {
  // Key order is part of the contract: a reader diffing two rows compares them positionally.
  const row = event(allowed)
  const parsed = JSON.parse(serializeRecord(row).line.toString('utf8'))
  const keys = Object.keys(parsed)
  assert.deepEqual(keys, [...FIELD_ORDER])
  // And they are at the end, so a phase-8 reader truncating at `validation_codes` is unaffected.
  assert.deepEqual(keys.slice(-GOVERNANCE_FIELDS.length), [...GOVERNANCE_FIELDS])
})

test('the same governance verdict produces a byte-identical row', () => {
  // Determinism, which the eval framework depends on: a row must not vary between runs for the
  // same inputs, or a reproducibility check becomes a coin toss.
  const first = JSON.stringify(event(allowed))
  for (let i = 0; i < 25; i += 1) assert.equal(JSON.stringify(event(allowed)), first)
})

/* ------------------------------------------------------- no double counting */

test('the governance columns duplicate no existing cost or token column', () => {
  // Part 12: "Do not duplicate existing cost/token fields." The budget columns describe a LIMIT
  // and the headroom under it; the worker columns describe what this one call used. Two numbers
  // that look alike and mean different things is how a dashboard ends up double-counting.
  const row = event(allowed)
  assert.equal(row.worker_total_tokens, null, 'no usage was reported on this row')
  assert.equal(row.worker_total_cost, null)
  // The budget columns are populated regardless, because they describe policy rather than usage.
  assert.equal(row.budget_limit, 1000)
  assert.equal(row.reservation_tokens, 50)
})

test('a reservation that settled is recorded as settled, not as still reserved', () => {
  // The row reports what the reservation BECAME. A row claiming `reserved` after the call has
  // finished would look like a leaked claim to anyone auditing the ledger against the store.
  for (const status of ['settled', 'released', 'overrun', 'none']) {
    const row = event({ ...allowed, reservationStatus: status })
    assert.equal(row.reservation_status, status)
  }
})
