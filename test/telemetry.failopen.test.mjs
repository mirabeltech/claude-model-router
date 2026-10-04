/**
 * A SINK THAT CANNOT WRITE, AND THE HOOK THAT RETURNS ANYWAY.
 *
 * CLAUDE.md's third non-negotiable: "Telemetry can never break a hook." The sink is wrapped in
 * try/catch end to end, is synchronous, performs no network I/O and no `await`, and swallows every
 * error. `telemetry.contract.test.mjs:323` proves it never throws — but none of the REASONS it
 * returns instead were ever asserted. Grepping `emit_failed`, `reopen_failed` and `ESHORTWRITE`
 * across `test/` found nothing, so "it degrades gracefully" was tested while "it says what went
 * wrong" was not. A sink that fails silently and a sink that fails with a diagnosis are the same
 * thing to a `try/catch` and completely different things to an operator.
 *
 * WHY HERE AND NOT IN telemetry.contract.test.mjs. That file is the per-repository conformance
 * loop — `for (const r of repositories)`, the same assertions against every sink implementation. A
 * lying-`fs` matrix is the opposite shape: specific injections against one implementation.
 *
 * THE CLASSIFICATION, and it is not uniform:
 *
 *   emit_failed        FAIL OPEN     the hook returns its answer; one row is lost
 *   ESHORTWRITE        SAFE REFUSAL  one record = one writeSync, so a short write is NOT retried;
 *                                    retrying would split a record and corrupt every reader
 *   reopen_failed      FAIL CLOSED for data, FAIL OPEN for the session; the sink disables itself
 *   null-sink fallback FAIL CLOSED for data, FAIL OPEN for the session — see the note below
 *   priceWorkerUsage   SAFE REFUSAL  null cost, never a guessed rate (CLAUDE.md rule 6)
 *
 * THE MODULE-GLOBAL TRAP. Both the sink cache and the pricing cache in `telemetry/index.mjs` are
 * process-wide and keyed on config identity. Without `__resetTelemetryForTests()` on both sides of
 * every case, these tests pass or fail depending on the order `node --test` happens to run them in.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { openSink } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import {
  __resetTelemetryForTests,
  emitEvent,
  openSinkFromConfig,
  priceWorkerUsage,
} from '../plugins/model-router/lib/telemetry/index.mjs'
import { buildProbeRecord } from './helpers/telemetry-dir.mjs'

const NOWHERE = 'C:/telemetry/never/touched'
const FROZEN = 1767225600000

const errno = (code) => Object.assign(new Error(code), { code })
const record = () => buildProbeRecord({ writerIndex: 0, seq: 1, padLen: 0, nonce: 'n' })

const config = (over = {}) => ({
  telemetry: {
    enabled: true,
    sink: 'jsonl',
    dirResolved: NOWHERE,
    rotation: 'daily',
    shardByPid: false,
    storeFilePaths: false,
    storeProjectLabel: false,
    storeQuestionText: false,
    identityScope: 'install',
    ...over,
  },
})

/** An fs on which opening and writing both work, so a baseline can succeed. */
const workingFs = () => {
  const written = []
  return {
    written,
    mkdirSync: () => {},
    openSync: () => 9,
    closeSync: () => {},
    writeSync: (_fd, buf) => {
      written.push(buf)
      return buf.length
    },
  }
}

/* --------------------------------------------------------------------- emitEvent */

test('emitEvent reports a code, then a message, then emit_failed — in that order', () => {
  // `err?.code ?? err?.message ?? 'emit_failed'` is the contract, and the LITERAL is the LAST
  // resort: it appears only for a throw carrying neither. Asserting all four cases is what makes
  // the precedence a pinned contract rather than an accident of the expression's shape — a
  // reordering that put the message first would still produce a plausible-looking reason.
  //
  // `now` is the injection point because emitEvent calls it AFTER the sink and the pricing chain
  // are resolved and BEFORE buildIdentity — so no salt file is created and no descriptor opens.
  for (const [label, thrower, expected] of [
    ['an object with neither code nor message', () => { throw {} }, 'emit_failed'],
    ['a thrown null', () => { throw null }, 'emit_failed'],
    ['an Error with a message', () => { throw new Error('boom') }, 'boom'],
    ['an errno Error, where the code wins', () => { throw errno('EIO') }, 'EIO'],
  ]) {
    __resetTelemetryForTests()
    try {
      const r = emitEvent({}, { config: config(), env: {}, now: thrower, fs: workingFs() })
      assert.equal(r.ok, false, label)
      assert.equal(r.reason, expected, label)
      assert.equal(r.bytes, 0, label)
    } finally {
      __resetTelemetryForTests()
    }
  }
})

test('a request for no telemetry is distinguishable from a failure to write telemetry', () => {
  // `ok` alone cannot carry this. A skipped emit reports `ok: false` — correct, since no bytes
  // landed — so `ok: false` covers BOTH "you asked for nothing" and "the disk is full". The
  // `reason` is the only thing that separates them, which is precisely why the reason strings in
  // this file are worth pinning rather than treating as debug text.
  for (const [label, cfg, env] of [
    ['telemetry.enabled: false', config({ enabled: false }), {}],
    ['CLAUDE_ROUTER_TELEMETRY=0', config(), { CLAUDE_ROUTER_TELEMETRY: '0' }],
  ]) {
    __resetTelemetryForTests()
    try {
      const explode = () => {
        throw new Error('a disabled sink must touch nothing')
      }
      const r = emitEvent({}, {
        config: cfg, env, now: () => FROZEN, fs: new Proxy({}, { get: () => explode }),
      })
      assert.equal(r.ok, false, label)
      assert.equal(r.reason, 'telemetry_disabled', `${label}: a request honoured, not an error`)
      assert.equal(r.bytes, 0, label)
    } finally {
      __resetTelemetryForTests()
    }
  }
})

/* ------------------------------------------------------------- the write path */

test('a short write is counted, never retried, because a retry would split one record', () => {
  // CLAUDE.md rule 4: one record = one fs.writeSync of one Buffer ending in "\n". fs.writeSync
  // does not loop on a short write, and neither does this sink — retrying would put half a record
  // on disk and then the rest after whatever another writer appended in between.
  //
  // The WRITE COUNT is asserted alongside the reason, which is the part that matters: a future
  // "helpful" retry loop would still report ESHORTWRITE and would still be wrong.
  let writes = 0
  const shortFs = {
    mkdirSync: () => {},
    openSync: () => 9,
    closeSync: () => {},
    writeSync: (_fd, buf) => {
      writes += 1
      return buf.length - 1
    },
  }
  const sink = openSink({ dir: NOWHERE, now: () => FROZEN, pid: 1, fs: shortFs })
  const r = sink.append(record())
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ESHORTWRITE')
  assert.equal(writes, 1, 'exactly one writeSync per record, on success and on failure alike')
  assert.equal(sink.counters().errors, 1)
  assert.equal(sink.counters().lastError, 'ESHORTWRITE')
  assert.equal(sink.counters().appended, 0, 'a record that did not land is not an appended record')
})

test('a descriptor closed underneath the sink is reopened exactly once', () => {
  // EBADF means the fd went away — a pruner, a sync agent, an antivirus. One retry with a fresh
  // open, because "cheap and never throws" has to survive a real cause; an unbounded retry on the
  // hook hot path would be worse than losing the row.
  let opens = 0
  let writes = 0
  const flakyFs = {
    mkdirSync: () => {},
    closeSync: () => {},
    openSync: () => {
      opens += 1
      return 9
    },
    writeSync: (_fd, buf) => {
      writes += 1
      if (writes === 1) throw errno('EBADF')
      return buf.length
    },
  }
  const sink = openSink({ dir: NOWHERE, now: () => FROZEN, pid: 1, fs: flakyFs })
  const r = sink.append(record())
  assert.equal(r.ok, true, 'the retry succeeded, so the row landed')
  assert.equal(opens, 2, 'exactly one reopen')
  assert.equal(writes, 2)
})

test('a reopen that also fails disables the sink rather than retrying forever', () => {
  // FAIL CLOSED for the data, FAIL OPEN for the session: `disabled` is latched, so the next append
  // costs one boolean rather than another syscall. An unbounded retry is the failure mode that
  // would actually break a hook, which is the thing rule 3 forbids.
  let opens = 0
  const deadFs = {
    mkdirSync: () => {},
    closeSync: () => {},
    openSync: () => {
      opens += 1
      if (opens === 1) return 9
      throw errno('EACCES')
    },
    writeSync: () => {
      throw errno('EBADF')
    },
  }
  const sink = openSink({ dir: NOWHERE, now: () => FROZEN, pid: 1, fs: deadFs })
  const first = sink.append(record())
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'reopen_failed')
  assert.equal(sink.describe().disabled, true, 'the sink latches off')

  const opensAfterFailure = opens
  const second = sink.append(record())
  assert.equal(second.reason, 'sink_disabled', 'and says so, rather than repeating the diagnosis')
  assert.equal(opens, opensAfterFailure, 'a disabled sink performs no further I/O at all')
})

test('a directory that cannot be created fails open once and never retries the mkdir', () => {
  let mkdirs = 0
  const sink = openSink({
    dir: NOWHERE,
    now: () => FROZEN,
    pid: 1,
    fs: {
      mkdirSync: () => {
        mkdirs += 1
        throw errno('EACCES')
      },
      openSync: () => 9,
      closeSync: () => {},
      writeSync: (_fd, b) => b.length,
    },
  })
  assert.equal(sink.append(record()).reason, 'open_failed')
  assert.equal(sink.append(record()).reason, 'sink_disabled')
  assert.equal(mkdirs, 1, 'one attempt; a per-event mkdir on an unwritable path is a syscall storm')
})

test('openSink itself performs no I/O, so a session that never delegates creates nothing', () => {
  // The installing-changes-nothing promise, at the sink level. The directory and the file are
  // created on the first append, not on construction.
  const explode = () => {
    throw new Error('openSink must not touch the filesystem')
  }
  const sink = openSink({
    dir: NOWHERE, now: () => FROZEN, pid: 1, fs: new Proxy({}, { get: () => explode }),
  })
  assert.equal(sink.id, 'jsonl')
  assert.equal(sink.describe().disabled, false)
})

/* ------------------------------------------------- construction, and the null fallback */

test('a sink that cannot be constructed degrades to a null sink AND returns a warning', () => {
  // THE ONE ROW IN THIS FILE WORTH ARGUING ABOUT, and the warning is why it is acceptable.
  //
  // resolveSinkId's rule 1 says, in capitals, "FAIL OPEN TO jsonl, NEVER TO null. Losing data is
  // the one outcome that is never acceptable" — and this catch returns a null sink, whose append()
  // reports `{ok: true, bytes: 0}`. A caller checking `ok` sees success and the row is gone.
  //
  // Those two are not in conflict as code: RESOLUTION cannot choose null, CONSTRUCTION can. And
  // when construction fails there is no working sink left to fall back to, so the alternative
  // would be a handle that throws — which rule 3 forbids outright. What makes it defensible is
  // the warning, which doctor surfaces. So the warning is asserted here as load-bearing, not
  // incidental: without it this is silent data loss, and nothing else in the suite checks it.
  const hostile = {
    telemetry: {
      enabled: true,
      sink: 'jsonl',
      get dirResolved() {
        throw new Error('nope')
      },
    },
  }
  const h = openSinkFromConfig(hostile, { fs: {}, now: () => FROZEN, pid: 1 })
  assert.equal(h.id, 'null', 'the handle is usable, which is the point')
  assert.equal(h.warnings.length, 1, 'and the one mitigation is present')
  assert.match(h.warnings[0], /failed to open telemetry sink "jsonl"/)
  assert.match(h.warnings[0], /nope/, 'the cause is carried, or the warning is not actionable')

  const r = h.append(record())
  assert.equal(r.ok, true, 'documented: the null sink did what it promised')
  assert.equal(r.bytes, 0, 'and `bytes` is the field that tells the truth about data landing')
})

test('an unknown sink name falls back to jsonl, never to null, and warns', () => {
  // The other half of rule 1, and the case it was written for: a config typo must not erase
  // telemetry. This is resolution rather than construction, and here the rule holds exactly.
  const h = openSinkFromConfig(config({ sink: 'postgres' }), {
    fs: workingFs(), now: () => FROZEN, pid: 1,
  })
  assert.equal(h.id, 'jsonl', 'a typo loses no events')
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /unknown telemetry\.sink "postgres"/)
})

test('an explicit null sink is honoured exactly, with no warning at all', () => {
  // Rule 2. The user asked for no data; that is a request, not a failure, and warning about it
  // would be the router second-guessing a deliberate choice on every single call.
  const h = openSinkFromConfig(config({ sink: 'null' }), { fs: {}, now: () => FROZEN, pid: 1 })
  assert.equal(h.id, 'null')
  assert.deepEqual(h.warnings, [])
})

/* -------------------------------------------------------------- pricing refusal */

test('pricing that cannot be computed is null with a status, never a guessed rate', () => {
  // SAFE REFUSAL, and CLAUDE.md rule 6 exactly: an unpriced model is NULL, never a guessed rate.
  // Driven through the parameter surface, so what is tested is that no input can make the pricing
  // path throw into a hook.
  for (const [label, args] of [
    ['usage that throws on read', {
      config: config(), provider: 'ollama', model: 'm',
      usage: { get inputTokens() { throw new Error('x') } },
    }],
    ['a pricing file that cannot be read', {
      config: config(), provider: 'ollama', model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 },
      fs: { readFileSync: () => { throw errno('EACCES') }, existsSync: () => true },
    }],
  ]) {
    __resetTelemetryForTests()
    try {
      const p = priceWorkerUsage(args)
      assert.equal(p.costUsd, null, label)
      assert.equal(p.status, 'unavailable', `${label}: unavailable, not 'measured' with a zero`)
      assert.equal(typeof p.lookup, 'string', `${label}: and it still says where it looked`)
    } finally {
      __resetTelemetryForTests()
    }
  }
})

test('the try/catch starts AFTER destructuring, which is a real limit worth stating', () => {
  // MEASURED, and recorded here rather than papered over. Both emitEvent and priceWorkerUsage
  // destructure their options in the PARAMETER LIST, so a throwing getter on a top-level property
  // — `{ get config() { throw } }` — is evaluated before the function body and escapes the catch.
  //
  // Not a defect, and deliberately not "fixed": these options objects are built by hook/run.mjs
  // and analytics/index.mjs from a loadConfig() result, never from host or provider input, so the
  // case is unreachable in production. CLAUDE.md rule 3 says the sink is wrapped end to end, and
  // this is the precise boundary of "end to end" — asserted so that the claim stays honest and so
  // that nobody discovers it by finding a crash.
  assert.throws(
    () => priceWorkerUsage({
      get config() { throw new Error('escapes the catch') },
      provider: 'ollama', model: 'm', usage: { inputTokens: 1, outputTokens: 1 },
    }),
    /escapes the catch/,
  )
  // A getter one level DOWN is inside the catch, which is the shape any real input would take.
  assert.equal(
    priceWorkerUsage({
      config: { get telemetry() { throw new Error('inside') } },
      provider: 'ollama', model: 'm', usage: { inputTokens: 1, outputTokens: 1 },
    }).status,
    'unavailable',
  )
})

test('the bundled table prices nothing, so a default install reports no dollar figure', () => {
  // Not a failure path, but it belongs beside them: `null` here is the SHIPPED state, and a test
  // that only ever saw priced models would not notice it changing.
  __resetTelemetryForTests()
  try {
    const p = priceWorkerUsage({
      config: config(), provider: 'ollama', model: 'qwen2.5-coder:7b',
      usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
    })
    assert.equal(p.costUsd, null, 'every bundled rate ships null')
    assert.equal(p.status, 'unavailable')
  } finally {
    __resetTelemetryForTests()
  }
})
