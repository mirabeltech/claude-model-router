/**
 * Serialization and the size guard.
 *
 * The invariant under test is the one the whole file format rests on:
 *
 *     ONE RECORD = ONE BUFFER ENDING IN EXACTLY ONE "\n", AND NEVER A PARTIAL LINE.
 *
 * Plus the flatness and explicit-null rules, because a reader that cannot tell an omitted key
 * from a null key cannot tell "we measured zero" from "we did not measure".
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CARCASS_STRING_BYTES,
  RECORD_MAX_BYTES,
  clampUtf8,
  sanitizeValue,
  serializeRecord,
} from '../plugins/model-router/lib/telemetry/contract.mjs'
import { FIELD_ORDER, REQUIRED_FIELDS, projectRecord } from '../plugins/model-router/lib/telemetry/record.mjs'
import { buildProbeRecord, padToExactly } from './helpers/telemetry-dir.mjs'

const base = () => buildProbeRecord({ writerIndex: 0, seq: 1, padLen: 0, nonce: 'n' })

const parse = (rec) => {
  const { line } = serializeRecord(rec)
  return JSON.parse(line.toString('utf8'))
}

/* ------------------------------------------------------------------ the shape */

test('every declared key is present and no undeclared key survives', () => {
  const out = parse({ ...base(), smuggled: 'nope', __proto__: 'evil' })
  assert.deepEqual(Object.keys(out), [...FIELD_ORDER])
  assert.equal('smuggled' in out, false)
})

test('every value is a scalar — no object and no array, so JSONL maps one-to-one onto columns', () => {
  const out = parse({ ...base(), model: { nested: true }, finish_reason: [1, 2] })
  for (const [k, v] of Object.entries(out)) {
    const t = typeof v
    assert.ok(v === null || t === 'string' || t === 'number' || t === 'boolean', `${k} is ${t}`)
  }
  assert.match(out.model, /^\[non_scalar:/)
})

test('absence is always written as an explicit null, never as a missing key', () => {
  const out = parse(base())
  assert.equal(out.worker_input_tokens, null)
  assert.ok('worker_input_tokens' in out)
  const json = serializeRecord(base()).line.toString('utf8')
  assert.match(json, /"worker_input_tokens":null/)
})

test('every key is lower snake case, and the two pre-existing names are spelled exactly', () => {
  for (const k of FIELD_ORDER) assert.match(k, /^[a-z][a-z0-9_]*$/, k)
  assert.ok(FIELD_ORDER.includes('avoided_method'))
  assert.ok(FIELD_ORDER.includes('retry_count'))
})

test('the key order is fixed, so identical input serializes byte-identically', () => {
  const a = serializeRecord(base()).line
  const b = serializeRecord({ ...base() }).line
  assert.deepEqual(a, b)
  // Insertion order must not depend on the caller's object literal order.
  const reversed = {}
  for (const k of [...Object.keys(base())].reverse()) reversed[k] = base()[k]
  assert.deepEqual(serializeRecord(reversed).line, a)
})

test('projectRecord turns undefined into null rather than dropping the key', () => {
  const out = projectRecord({ model: undefined })
  assert.equal(out.model, null)
  assert.ok('model' in out)
})

/* -------------------------------------------------------------- one line only */

test('the buffer ends in exactly one newline and contains no other', () => {
  const { line } = serializeRecord(base())
  assert.equal(line.at(-1), 0x0a)
  let count = 0
  for (const b of line) if (b === 0x0a) count += 1
  assert.equal(count, 1)
})

test('a newline inside a value is escaped and cannot break the line-per-record format', () => {
  const { line } = serializeRecord({ ...base(), model: 'a\nb\r\nc' })
  let count = 0
  for (const b of line) if (b === 0x0a) count += 1
  assert.equal(count, 1, 'an embedded newline must not produce a second line')
  assert.equal(JSON.parse(line.toString('utf8')).model, 'a\nb\r\nc')
})

test('the terminator is LF on every platform, never the OS line ending', () => {
  const { line } = serializeRecord(base())
  assert.equal(line.includes('\r\n'), false)
})

/* ------------------------------------------------------- stringify hazards */

test('a circular reference becomes a marker instead of throwing', () => {
  const circular = { a: 1 }
  circular.self = circular
  const { value, problems } = sanitizeValue(circular)
  assert.equal(value.self, '[circular]')
  assert.match(problems.join(','), /circular/)
})

test('a shared leaf reached twice is not mistaken for a cycle', () => {
  const leaf = { x: 1 }
  const { value } = sanitizeValue({ a: leaf, b: leaf })
  assert.deepEqual(value.a, { x: 1 })
  assert.deepEqual(value.b, { x: 1 }, 'a DAG must serialize fully')
})

test('a BigInt is converted rather than thrown on', () => {
  assert.equal(sanitizeValue(123n).value, 123)
  assert.equal(sanitizeValue(2n ** 70n).value, (2n ** 70n).toString())
  assert.match(sanitizeValue(123n).problems.join(','), /bigint/)
})

test('NaN and Infinity become null and are flagged, so a math bug is visible', () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    const { value, problems } = sanitizeValue(v)
    assert.equal(value, null)
    assert.notEqual(value, 0, 'a NaN cost must never become zero')
    assert.match(problems.join(','), /non_finite/)
  }
})

test('undefined becomes null and is flagged, so the writer can be held to never emitting one', () => {
  const { value, problems } = sanitizeValue(undefined)
  assert.equal(value, null)
  assert.match(problems.join(','), /undefined/)
})

test('a toJSON hook is never called, so it cannot throw or inject a cycle', () => {
  // Raw JSON.stringify WOULD call this and blow up. The walker descends into the plain object
  // and treats toJSON as just another key, so the hazard is removed at the root rather than
  // special-cased.
  let called = false
  const hostile = {
    toJSON() {
      called = true
      throw new Error('should never run')
    },
  }
  const { value } = sanitizeValue({ field: hostile })
  assert.equal(called, false)
  assert.equal(value.field.toJSON, '[unserializable:function]')

  // And in a real record the object is flattened, because the schema is scalar-only.
  const out = JSON.parse(serializeRecord({ ...base(), model: hostile }).line.toString('utf8'))
  assert.equal(called, false)
  assert.match(out.model, /^\[non_scalar:/)
})

test('a class instance with a toJSON method is refused outright, not descended into', () => {
  class Hostile {
    toJSON() {
      throw new Error('should never run')
    }
  }
  assert.equal(sanitizeValue(new Hostile()).value, '[unserializable:Hostile]')
})

test('exotic objects are refused rather than descended into', () => {
  for (const v of [new Map(), new Set(), /re/, Buffer.from('x'), new Uint8Array(2)]) {
    assert.match(sanitizeValue(v).value, /^\[unserializable:/, String(v))
  }
})

test('a Date becomes an ISO string and an invalid Date becomes null', () => {
  assert.equal(sanitizeValue(new Date(0)).value, '1970-01-01T00:00:00.000Z')
  assert.equal(sanitizeValue(new Date(NaN)).value, null)
})

test('an Error is reduced to name, redacted message and code — never the stack', () => {
  const err = Object.assign(new Error('key is AIzaSYSOMETHINGSECRET123456'), { code: 'auth' })
  const { value } = sanitizeValue(err)
  assert.equal(value.name, 'Error')
  assert.equal(value.code, 'auth')
  assert.match(value.message, /\[redacted\]/)
  assert.equal('stack' in value, false, 'a stack leaks absolute filesystem paths')
})

test('a lone surrogate round-trips through stringify, buffer and parse', () => {
  const lone = 'a\uD800b'
  const out = parse({ ...base(), model: lone })
  assert.equal(out.model, lone)
})

test('an astral character survives intact', () => {
  const out = parse({ ...base(), model: 'ok \u{1F600} fine' })
  assert.equal(out.model, 'ok \u{1F600} fine')
})

test('deep nesting and huge arrays are bounded rather than followed forever', () => {
  let deep = { v: 1 }
  for (let i = 0; i < 20; i++) deep = { next: deep }
  assert.match(JSON.stringify(sanitizeValue(deep).value), /\[depth\]/)
  const big = sanitizeValue(new Array(5000).fill(1)).value
  assert.ok(big.length <= 2001)
  assert.match(String(big.at(-1)), /^\[truncated:/)
})

/* ------------------------------------------------------------- utf-8 clamping */

test('clampUtf8 never splits a surrogate pair or manufactures a lone surrogate', () => {
  const s = '\u{1F600}'.repeat(10) // 4 bytes each
  for (let budget = 0; budget <= 40; budget++) {
    const out = clampUtf8(s, budget)
    assert.ok(Buffer.byteLength(out, 'utf8') <= budget, `budget ${budget}`)
    assert.equal(out.length % 2, 0, `budget ${budget} split a surrogate pair`)
    assert.equal(/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false)
  }
})

test('clampUtf8 leaves a string that already fits untouched and adds no marker', () => {
  assert.equal(clampUtf8('short', 100), 'short')
})

/* ----------------------------------------------------------- the size guard */

test('a record exactly at the cap passes untruncated', () => {
  const padLen = padToExactly({
    writerIndex: 0,
    seq: 1,
    nonce: 'n',
    targetBytes: RECORD_MAX_BYTES,
    serialize: (r) => serializeRecord(r),
  })
  assert.notEqual(padLen, null, 'could not construct an exactly-at-cap record')
  const r = serializeRecord(buildProbeRecord({ writerIndex: 0, seq: 1, padLen, nonce: 'n' }))
  assert.equal(r.bytes, RECORD_MAX_BYTES)
  assert.equal(r.truncation, null)
})

test('one byte over the cap truncates, and the result still fits', () => {
  const padLen = padToExactly({
    writerIndex: 0,
    seq: 1,
    nonce: 'n',
    targetBytes: RECORD_MAX_BYTES,
    serialize: (r) => serializeRecord(r),
  })
  const r = serializeRecord(buildProbeRecord({ writerIndex: 0, seq: 1, padLen: padLen + 1, nonce: 'n' }))
  assert.notEqual(r.truncation, null)
  assert.ok(r.bytes <= RECORD_MAX_BYTES)
})

test('the shed ladder clamps free text before nulling it, and in a fixed order', () => {
  const rec = { ...base(), error_message_safe: 'E'.repeat(80_000), question_text: 'Q'.repeat(80_000) }
  const r = serializeRecord(rec)
  assert.notEqual(r.line, null)
  assert.ok(r.bytes <= RECORD_MAX_BYTES)
  assert.match(r.truncation, /^clamp:error_message_safe/)
  const out = JSON.parse(r.line.toString('utf8'))
  assert.equal(out.truncation_steps, r.truncation, 'the record records its own truncation')
})

test('truncation touches only free text and never a measurement', () => {
  const rec = {
    ...base(),
    worker_input_tokens: 600,
    worker_total_cost: 0.0012,
    estimated_tokens_avoided: 11_995,
    question_text: 'Q'.repeat(80_000),
  }
  const out = parse(rec)
  assert.equal(out.worker_input_tokens, 600)
  assert.equal(out.worker_total_cost, 0.0012)
  assert.equal(out.estimated_tokens_avoided, 11_995)
})

test('an oversized required field falls back to a carcass that is still complete and valid', () => {
  // A pathological value in a field the ladder cannot shed, e.g. a 200 KB model name from a
  // malformed config. The record must survive as a valid, parseable, every-key-present line.
  const rec = { ...base(), model: 'M'.repeat(200_000) }
  const r = serializeRecord(rec)
  assert.notEqual(r.line, null, 'the record must never be dropped')
  assert.ok(r.bytes <= RECORD_MAX_BYTES)
  assert.match(r.truncation, /carcass/)

  const out = JSON.parse(r.line.toString('utf8'))
  assert.deepEqual(Object.keys(out), [...FIELD_ORDER], 'a carcass still carries every key')
  for (const f of REQUIRED_FIELDS) assert.ok(f in out, f)
  assert.equal(out.schema_version, 1)
  assert.equal(out.status, 'ok')
  // Non-required fields are nulled, and required strings are clamped.
  assert.equal(out.model, null, 'model is not a required field, so it is nulled')
  for (const [, v] of Object.entries(out)) {
    if (typeof v === 'string') assert.ok(Buffer.byteLength(v, 'utf8') <= CARCASS_STRING_BYTES)
  }
})

test('the carcass is reached only after the ladder has been exhausted', () => {
  const r = serializeRecord({ ...base(), model: 'M'.repeat(200_000), question_text: 'Q'.repeat(200_000) })
  const steps = r.truncation.split(',')
  assert.equal(steps.at(-1), 'carcass')
  assert.ok(steps.length > 1, 'the ladder must be tried first')
})
