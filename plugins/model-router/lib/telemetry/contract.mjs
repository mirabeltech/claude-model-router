/**
 * The telemetry repository contract: two interfaces, one serializer, one size guard.
 *
 * TWO ROLES, BECAUSE THE WRITE PATH'S SYNC CONSTRAINT IS A CORRECTNESS REQUIREMENT, NOT A STYLE
 * PREFERENCE. A PreToolUse hook writes its decision to stdout and exits; there is no guarantee of
 * another event-loop turn, and process.on('exit') cannot run async work. So an awaited or queued
 * write can be LOST. Sync or lossy — there is no third option.
 *
 *   EventSink   write side. SYNCHRONOUS, never-throws, no network, no await. Local filesystem
 *               only. `capabilities.synchronousWrite` must be true and the validator rejects an
 *               async openSink.
 *
 *   EventStore  read side. Async by signature. JSONL satisfies it with sync fs inside async
 *               methods; Postgres satisfies it naturally. Hosts the optional ingestBatch() and
 *               prune(), which may be async because they never run inside a hook.
 *
 * A remote backend (Postgres, ClickHouse) therefore implements EventStore ONLY, declares
 * `storeCapabilities.sink: false`, and the registry refuses to use it as a sink — loudly, in
 * config validation and in doctor, never silently at write time. The local JSONL log stays the
 * system of record, and "move to ClickHouse" becomes a change to one ingest target with zero
 * callers touched.
 *
 *   export const id                 : string
 *   export const capabilities       : SinkCapabilities    // sinks only
 *   export const storeCapabilities  : StoreCapabilities   // stores only
 *   export function openSink(opts)        -> SinkHandle   // SYNC, never throws, no I/O
 *   export async function openStore(opts) -> StoreHandle
 */

import { redactSecrets } from '../redact.mjs'
import { FIELD_ORDER, REQUIRED_FIELDS, SHED_ORDER, projectRecord } from './record.mjs'

/* ------------------------------------------------------------------ constants */

/**
 * The hard cap on one serialized line, INCLUDING its trailing newline.
 *
 * 64 KiB is well inside the single-write() regime on every filesystem we support and far above
 * any legitimate record (a `privacyLevel: hashed` event is ~1-2 KB). But it genuinely bites:
 * `telemetry.questionTextMaxChars` permits 10 000 characters, which is up to 40 KB in UTF-8 and
 * more once escaped. A record that exceeds the size at which append atomicity holds is a real
 * defect class, not a hypothetical, which is why the guard exists rather than a comment.
 */
export const RECORD_MAX_BYTES = 65_536

/** 16x the write cap. A corrupt file with no newline at all must not grow the carry buffer. */
export const READ_MAX_LINE_BYTES = 1_048_576

/** Belt against a pathological injected object. The schema itself is flat. */
export const MAX_DEPTH = 8
export const MAX_ARRAY = 2_000

/** Every string on a carcass record is clamped to this, which is what makes the carcass provably small. */
export const CARCASS_STRING_BYTES = 256

/* ------------------------------------------------------------------ typedefs */

/**
 * @typedef {Object} SinkCapabilities
 * @property {true}    synchronousWrite   Must be true. Enforced by validateRepositoryModule.
 * @property {boolean} durableOnAppend    Bytes reach the kernel in append(); no flush needed.
 * @property {boolean} supportsConcurrentWriters
 * @property {boolean} requiresIngest     true for jsonl: a query store is materialised later.
 * @property {number}  recordCapBytes
 */

/**
 * @typedef {Object} AppendResult
 * @property {boolean} ok
 * @property {number}  bytes              Bytes handed to the OS; 0 when nothing was written.
 * @property {string|null} target         Absolute segment path, or null.
 * @property {string|null} truncation     Comma-joined shed steps, or null.
 * @property {string|null} reason         Error code when !ok. Returned, never thrown.
 */

/**
 * @typedef {Object} SinkHandle
 * @property {string} id
 * @property {SinkCapabilities} capabilities
 * @property {string[]} warnings
 * @property {(record: object) => AppendResult} append   SYNC. Never throws.
 * @property {() => AppendResult} flush                  SYNC. No-op for jsonl.
 * @property {() => void} close                          SYNC. Never throws.
 * @property {() => object} describe
 * @property {() => object} counters
 */

/**
 * @typedef {Object} StoreCapabilities
 * @property {boolean} sink                 Can this backend also be a write sink?
 * @property {boolean} streaming
 * @property {boolean} aggregatesInStore    A SQL store can GROUP BY; jsonl cannot.
 * @property {boolean} supportsPrune
 * @property {boolean} supportsIngest
 */

/**
 * @typedef {Object} ReadReport
 * @property {number} files
 * @property {number} bytes
 * @property {number} lines
 * @property {number} yielded
 * @property {Object} skipped
 * @property {Array<object>} samples   At most 5, redacted.
 * @property {Array<object>} errors
 */

/** A fresh zeroed read report. One definition so every reader counts the same things. */
export function emptyReadReport() {
  return {
    files: 0,
    bytes: 0,
    lines: 0,
    yielded: 0,
    skipped: {
      blank: 0,
      comment: 0,
      malformed: 0,
      not_an_object: 0,
      unrecognized: 0,
      oversize_line: 0,
      truncated_tail: 0,
      unterminated_tail_parsed: 0,
    },
    samples: [],
    errors: [],
  }
}

/* -------------------------------------------------------------- utf-8 clamping */

/**
 * Clamp a string to at most `maxBytes` of UTF-8.
 *
 * Iterates CODE POINTS (for...of), so an astral character's surrogate pair is never split and a
 * lone surrogate is never manufactured. No ellipsis marker is appended: the marker would consume
 * budget and complicate the fit loop, and `truncation` already records that it happened.
 */
export function clampUtf8(str, maxBytes) {
  if (typeof str !== 'string') return str
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str
  let used = 0
  let out = ''
  for (const cp of str) {
    const n = Buffer.byteLength(cp, 'utf8')
    if (used + n > maxBytes) break
    out += cp
    used += n
  }
  return out
}

/* ------------------------------------------------------------- sanitization */

const isPlainObject = (v) => {
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Reduce an arbitrary value to plain objects, arrays, strings, finite numbers, booleans and null.
 *
 * THE ARCHITECTURAL MOVE: JSON.stringify is never called on untrusted input. On the tree this
 * returns, every documented stringify failure mode is unreachable — so the hazards below are
 * eliminated at the root rather than defended against one at a time.
 *
 * @returns {{value: unknown, problems: string[]}}
 */
export function sanitizeValue(value, { depth = 0, ancestors = new Set(), problems = [], path = '$' } = {}) {
  const t = typeof value

  if (value === null) return { value: null, problems }

  // undefined must never appear in a record. A declared key becomes null, which is how this
  // schema spells "unavailable"; the problem is recorded so a test can assert the writer never
  // emits one in the first place.
  if (value === undefined) {
    problems.push(`undefined:${path}`)
    return { value: null, problems }
  }

  if (t === 'string') return { value, problems }

  if (t === 'number') {
    if (Number.isFinite(value)) return { value: value === 0 ? 0 : value, problems }
    // Raw stringify turns these into null silently. The semantics are right; the SILENCE is not —
    // a NaN cost quietly becoming null hides a math bug, and it must never become 0.
    problems.push(`non_finite:${path}`)
    return { value: null, problems }
  }

  if (t === 'boolean') return { value, problems }

  if (t === 'bigint') {
    // Raw stringify THROWS on a BigInt. Within safe-integer range it is a number; beyond it, the
    // decimal string — never a silent precision loss and never an exception. A token count that
    // large is nonsense anyway, and a reader seeing a string where it expects a number treats it
    // as unavailable, which is the correct outcome.
    problems.push(`bigint:${path}`)
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? { value: Number(value), problems }
      : { value: value.toString(), problems }
  }

  if (t === 'function' || t === 'symbol') {
    problems.push(`unserializable:${path}`)
    return { value: `[unserializable:${t}]`, problems }
  }

  /* objects */

  if (value instanceof Date) {
    const ms = value.getTime()
    if (!Number.isFinite(ms)) {
      problems.push(`invalid_date:${path}`)
      return { value: null, problems }
    }
    return { value: value.toISOString(), problems }
  }

  if (value instanceof Error) {
    // Never the stack: it leaks absolute filesystem paths, and the message is redacted because an
    // API key echoed into an error is just as leaked from a store as from a log.
    return {
      value: {
        name: String(value.name ?? 'Error'),
        message: redactSecrets(String(value.message ?? '')),
        code: value.code === undefined ? null : String(value.code),
      },
      problems,
    }
  }

  if (depth >= MAX_DEPTH) {
    problems.push(`depth:${path}`)
    return { value: '[depth]', problems }
  }

  // Ancestor set, not a visited set: entries are removed on ascend, so a DAG that reaches the
  // same leaf twice still serializes fully and only a genuine cycle is cut.
  if (ancestors.has(value)) {
    problems.push(`circular:${path}`)
    return { value: '[circular]', problems }
  }

  if (Array.isArray(value)) {
    ancestors.add(value)
    const out = []
    const limit = Math.min(value.length, MAX_ARRAY)
    for (let i = 0; i < limit; i++) {
      out.push(sanitizeValue(value[i], { depth: depth + 1, ancestors, problems, path: `${path}[${i}]` }).value)
    }
    if (value.length > limit) {
      problems.push(`array_truncated:${path}`)
      out.push(`[truncated:${value.length - limit}]`)
    }
    ancestors.delete(value)
    return { value: out, problems }
  }

  if (isPlainObject(value)) {
    ancestors.add(value)
    const out = {}
    for (const k of Object.keys(value)) {
      out[k] = sanitizeValue(value[k], { depth: depth + 1, ancestors, problems, path: `${path}.${k}` }).value
    }
    ancestors.delete(value)
    return { value: out, problems }
  }

  // Map, Set, RegExp, Buffer, TypedArray, class instance, anything with a toJSON method.
  // A toJSON hook is NEVER trusted: it can throw, return a cycle, or be a side-effectful getter.
  // Refusing to descend into exotic objects removes that hazard entirely.
  const ctor = value?.constructor?.name ?? 'Object'
  problems.push(`unserializable:${path}`)
  return { value: `[unserializable:${ctor}]`, problems }
}

/** The record is flat and scalar-only, so anything else in a declared field is a caller bug. */
function flatten(value, field, problems) {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return value
  problems.push(`non_scalar:${field}`)
  if (Array.isArray(value)) return `[non_scalar:Array]`
  return `[non_scalar:${value?.constructor?.name ?? 'Object'}]`
}

/* ------------------------------------------------------------- serialization */

function measure(obj) {
  const json = JSON.stringify(obj)
  // Always measure the STRINGIFIED output, never the input string. Escaping makes any estimate
  // wrong: a lone surrogate is 6 bytes once escaped while Buffer.byteLength counts it as 3, and
  // a newline is 2. The cap is a property of the bytes we are about to write.
  return { json, bytes: Buffer.byteLength(json, 'utf8') + 1 }
}

function applyShed(working, step) {
  const current = working[step.field]
  if (step.strategy === 'clamp') {
    if (typeof current !== 'string') return false
    const clamped = clampUtf8(current, step.keepBytes)
    if (clamped === current) return false
    working[step.field] = clamped
    return true
  }
  if (current === null) return false
  working[step.field] = null
  return true
}

/** Required keys kept and clamped; everything else nulled. Provably far under the cap. */
function buildCarcass(working, steps) {
  const required = new Set(REQUIRED_FIELDS)
  const out = {}
  for (const field of FIELD_ORDER) {
    if (!required.has(field)) {
      out[field] = null
      continue
    }
    const v = working[field]
    out[field] = typeof v === 'string' ? clampUtf8(v, CARCASS_STRING_BYTES) : v
  }
  out.truncation_steps = [...steps, 'carcass'].join(',')
  return out
}

/**
 * Turn a record into exactly one line of bytes, or into nothing at all.
 *
 * Never throws. Never writes a partial line. Never drops a record for being too large — the shed
 * ladder and then the carcass guarantee something valid and complete comes out.
 *
 * @returns {{line: Buffer|null, bytes: number, truncation: string|null, problems: string[]}}
 */
export function serializeRecord(record, { recordCapBytes = RECORD_MAX_BYTES } = {}) {
  const problems = []
  try {
    const projected = projectRecord(record)
    const working = {}
    for (const field of FIELD_ORDER) {
      const sanitized = sanitizeValue(projected[field], { problems, path: field })
      working[field] = flatten(sanitized.value, field, problems)
    }

    const steps = []
    // Bounded at SHED_ORDER.length + 1 iterations, so this is O(1) and deterministic.
    for (let i = 0; i <= SHED_ORDER.length; i++) {
      working.truncation_steps = steps.length === 0 ? null : steps.join(',')
      const { json, bytes } = measure(working)

      if (bytes <= recordCapBytes) {
        // JSON.stringify escapes \n and \r inside strings per spec, so this can never fire. One
        // indexOf protects the entire line-per-record file format, which is worth two scans.
        if (json.indexOf('\n') !== -1 || json.indexOf('\r') !== -1) {
          problems.push('embedded_newline')
          break
        }
        return { line: Buffer.from(`${json}\n`, 'utf8'), bytes, truncation: working.truncation_steps, problems }
      }

      if (i === SHED_ORDER.length) break
      if (applyShed(working, SHED_ORDER[i])) steps.push(SHED_ORDER[i].step)
    }

    const carcass = buildCarcass(working, steps)
    const { json, bytes } = measure(carcass)
    if (bytes <= recordCapBytes && json.indexOf('\n') === -1 && json.indexOf('\r') === -1) {
      return { line: Buffer.from(`${json}\n`, 'utf8'), bytes, truncation: carcass.truncation_steps, problems }
    }
    problems.push('carcass_over_cap')
    return { line: null, bytes: 0, truncation: null, problems }
  } catch (err) {
    // The sanitized tree cannot make stringify throw, but a belt costs nothing and the rule is
    // that telemetry never throws into the routing path.
    problems.push(`serialize_failed:${err?.code ?? err?.name ?? 'Error'}`)
    return { line: null, bytes: 0, truncation: null, problems }
  }
}

/* -------------------------------------------------------------- validators */

/**
 * Assert a module satisfies the repository contract. Returns problem strings; empty means
 * conformant. Mirrors validateProviderModule() in the provider contract.
 */
export function validateRepositoryModule(mod) {
  const problems = []
  if (typeof mod?.id !== 'string' || mod.id === '') problems.push('id must be a non-empty string')

  const isSink = typeof mod?.openSink === 'function'
  const isStore = typeof mod?.openStore === 'function'
  if (!isSink && !isStore) problems.push('a repository module must export openSink, openStore, or both')

  if (isSink) {
    // THE load-bearing check. An async openSink means the write path can be interleaved, which
    // means a hook can exit before its event reaches the kernel.
    if (mod.openSink.constructor.name === 'AsyncFunction') problems.push('openSink must not be an async function')
    const c = mod.capabilities
    if (typeof c !== 'object' || c === null) {
      problems.push('capabilities must be an object')
    } else {
      if (c.synchronousWrite !== true) problems.push('capabilities.synchronousWrite must be true for a sink')
      for (const k of ['durableOnAppend', 'supportsConcurrentWriters', 'requiresIngest']) {
        if (typeof c[k] !== 'boolean') problems.push(`capabilities.${k} must be a boolean`)
      }
      if (!Number.isInteger(c.recordCapBytes) || c.recordCapBytes <= 0 || c.recordCapBytes > READ_MAX_LINE_BYTES) {
        problems.push(`capabilities.recordCapBytes must be a positive integer <= ${READ_MAX_LINE_BYTES}`)
      }
    }
  }

  if (isStore) {
    if (mod.openStore.constructor.name !== 'AsyncFunction') problems.push('openStore must be an async function')
    const s = mod.storeCapabilities
    if (typeof s !== 'object' || s === null) {
      problems.push('storeCapabilities must be an object')
    } else {
      for (const k of ['sink', 'streaming', 'aggregatesInStore', 'supportsPrune', 'supportsIngest']) {
        if (typeof s[k] !== 'boolean') problems.push(`storeCapabilities.${k} must be a boolean`)
      }
    }
  }

  return problems
}

/** The runtime half: a handle actually built by openSink(). */
export function validateSinkHandle(handle) {
  const problems = []
  if (typeof handle?.id !== 'string' || handle.id === '') problems.push('handle.id must be a non-empty string')
  for (const k of ['append', 'flush', 'close', 'describe', 'counters']) {
    if (typeof handle?.[k] !== 'function') problems.push(`handle.${k} must be a function`)
  }
  if (typeof handle?.append === 'function' && handle.append.constructor.name === 'AsyncFunction') {
    problems.push('handle.append must not be an async function')
  }
  if (handle?.capabilities?.synchronousWrite !== true) problems.push('handle.capabilities.synchronousWrite must be true')
  if (!Array.isArray(handle?.warnings)) problems.push('handle.warnings must be an array')
  return problems
}

export function validateStoreHandle(handle) {
  const problems = []
  if (typeof handle?.id !== 'string' || handle.id === '') problems.push('handle.id must be a non-empty string')
  for (const k of ['segments', 'read', 'report', 'close']) {
    if (typeof handle?.[k] !== 'function') problems.push(`handle.${k} must be a function`)
  }
  const s = handle?.storeCapabilities
  if (typeof s !== 'object' || s === null) problems.push('handle.storeCapabilities must be an object')
  if (s?.supportsPrune === true && typeof handle?.prune !== 'function') {
    problems.push('handle.prune must be a function when storeCapabilities.supportsPrune is true')
  }
  if (s?.supportsIngest === true && typeof handle?.ingestBatch !== 'function') {
    problems.push('handle.ingestBatch must be a function when storeCapabilities.supportsIngest is true')
  }
  return problems
}
