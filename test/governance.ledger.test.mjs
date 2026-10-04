/**
 * The budget ledger: the only impure part of governance.
 *
 * What this file is for, stated plainly: the ledger is the one place in governance that can lose
 * money. A reservation that is never released understates the budget forever; a settle that runs
 * twice charges twice; a rollover that does not happen carries yesterday's spend into today. All
 * three are silent failures, so each one gets a test that would catch it.
 *
 * Two rules on trial:
 *
 *  1. NEVER THROWS. Every failure is a returned status. An unreadable or unwritable ledger must
 *     degrade to an ungoverned router, never to a blocked session.
 *
 *  2. IDEMPOTENT BY ID. reserve / settle / release are keyed on the caller's id, so a replayed
 *     hook cannot double-charge and a double release is a no-op rather than a credit.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEDGER_FILENAME,
  LOCK_FILENAME,
  LOCK_STALE_MS,
  RESERVATION_TTL_MS,
  ledgerPaths,
  probeWritable,
  readState,
  release,
  reserve,
  settle,
} from '../plugins/model-router/lib/governance/ledger.mjs'
import { makeTempDir } from './helpers/telemetry-dir.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.join(HERE, '..', 'plugins', 'model-router', 'lib', 'governance', 'ledger.mjs')

const T0 = Date.parse('2026-10-04T12:00:00.000Z')

/** A config whose state dir is a fresh scratch directory. */
const configFor = (dir) => ({
  budget: {
    enabled: true,
    run: { maxWorkerCostUsd: null, maxInputTokens: null, maxOutputTokens: null, maxTotalTokens: null },
    daily: { maxWorkerCostUsd: null, maxTotalTokens: null },
    monthly: { maxWorkerCostUsd: null, maxTotalTokens: null },
    onExceed: 'disable',
    onUnknownCost: 'allow',
    onUnknownUsage: 'allow',
    stateDir: dir,
    stateDirResolved: dir,
  },
})

/** Run a body against a throwaway ledger directory. */
function withLedger(label, body) {
  const tmp = makeTempDir(label)
  try {
    return body(configFor(tmp.dir), tmp.dir)
  } finally {
    tmp.cleanup()
  }
}

/* ------------------------------------------------------------------ structure */

test('the ledger module imports only node:fs, node:path and the pure policy', () => {
  // It is a hot-path module. A socket, a child process or a provider import here would put all
  // three behind every delegated read.
  const src = fs.readFileSync(MODULE, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const specs = [...stripped.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(specs.sort(), ['./policy.mjs', 'node:fs', 'node:path'])
  assert.equal(/import\s*\(/.test(stripped), false, 'no dynamic import')
  assert.equal(/require\s*\(/.test(stripped), false, 'no require')
})

test('the reservation TTL is far above the hook deadline it has to outlive', () => {
  // A reservation reclaimed while its worker call is still running would let the same headroom
  // be spent twice, which is the exact failure reservations exist to prevent. `hooks.timeoutMs`
  // is capped at 120_000 by the config spec, so the TTL has to clear that with room to spare.
  assert.ok(RESERVATION_TTL_MS > 120_000, `TTL is ${RESERVATION_TTL_MS}`)
  // And the lock must expire far sooner than a reservation, or a dead hook wedges the budget
  // for as long as its claim survives.
  assert.ok(LOCK_STALE_MS < RESERVATION_TTL_MS, 'a stale lock must clear before a reservation')
})

/* --------------------------------------------------------------- first reads */

test('an absent ledger reads as an empty budget rather than as an error', () => {
  // First run. Nothing has been spent because nothing has happened, and that is a measured zero,
  // not an unknown one.
  withLedger('gov-absent', (config) => {
    const r = readState(config, { now: T0 })
    assert.equal(r.ok, true)
    assert.equal(r.state.daily.totalTokens, 0)
    assert.equal(r.state.monthly.costUsd, 0)
    assert.equal(r.state.daily.costStatus, 'measured')
    assert.deepEqual({ ...r.periods }, { day: '2026-10-04', month: '2026-10' })
  })
})

test('reading an absent ledger creates no file, so an unconfigured install writes nothing', () => {
  withLedger('gov-noread-write', (config, dir) => {
    readState(config, { now: T0 })
    assert.equal(fs.existsSync(path.join(dir, LEDGER_FILENAME)), false, 'a read must not write')
  })
})

test('a corrupt ledger is reported as unreadable, not silently read as zero spend', () => {
  // Numerically the same answer, but the caller has to be able to tell "nothing spent" from
  // "cannot tell", because doctor says one of those out loud and the other is routine.
  withLedger('gov-corrupt', (config, dir) => {
    fs.writeFileSync(path.join(dir, LEDGER_FILENAME), '{ this is not json')
    const r = readState(config, { now: T0 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'unreadable_ledger')
    assert.equal(r.state, null)
  })
})

test('a ledger from an unknown version is ignored rather than migrated', () => {
  withLedger('gov-version', (config, dir) => {
    fs.writeFileSync(path.join(dir, LEDGER_FILENAME), JSON.stringify({ version: 999, daily: { totalTokens: 50 } }))
    const r = readState(config, { now: T0 })
    assert.equal(r.ok, false, 'a shape we do not understand must not be read as spend')
  })
})

test('a missing state dir is a named failure, not a throw', () => {
  for (const budget of [{}, { stateDir: '' }, { stateDir: '   ' }]) {
    const r = readState({ budget }, { now: T0 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'no_state_dir')
  }
  assert.equal(ledgerPaths({ budget: {} }), null)
})

/* ------------------------------------------------------- reserve and settle */

test('a reservation counts toward spend while it is open', () => {
  // THE MECHANISM. An in-flight delegation has not reported usage yet but is going to, and a
  // budget check that ignored it would hand the same headroom to every concurrent hook.
  withLedger('gov-reserve', (config) => {
    assert.equal(reserve(config, { id: 'a', tokens: 400, now: T0 }).ok, true)
    const r = readState(config, { now: T0 })
    assert.equal(r.state.daily.totalTokens, 400, 'an open reservation is spent for now')
    assert.equal(r.state.monthly.totalTokens, 400)
    assert.equal(r.state.reservations, 1)
  })
})

test('settling replaces the estimate with measured usage', () => {
  // Measured facts only. The estimate sized the reservation and is then discarded.
  withLedger('gov-settle', (config) => {
    reserve(config, { id: 'a', tokens: 400, now: T0 })
    const s = settle(config, { id: 'a', tokens: 150, inputTokens: 100, outputTokens: 50, now: T0 })
    assert.equal(s.ok, true)
    assert.equal(s.status, 'settled')

    const r = readState(config, { now: T0 })
    assert.equal(r.state.daily.totalTokens, 150, 'the measurement replaced the 400-token estimate')
    assert.equal(r.state.reservations, 0)
  })
})

test('measured usage above the reservation is recorded as an overrun, not clamped', () => {
  // The money was really spent. A ledger that hid the overshoot would under-report the next
  // decision, which is how a budget quietly stops meaning anything.
  withLedger('gov-overrun', (config) => {
    reserve(config, { id: 'a', tokens: 100, now: T0 })
    const s = settle(config, { id: 'a', tokens: 900, now: T0 })
    assert.equal(s.status, 'overrun')
    assert.equal(readState(config, { now: T0 }).state.daily.totalTokens, 900)
  })
})

test('settling with no reported usage charges nothing, and says why', () => {
  // A provider that reports no counts cannot have them invented. The documented consequence is
  // that such a provider can never exhaust a token budget.
  withLedger('gov-nousage', (config) => {
    reserve(config, { id: 'a', tokens: 400, now: T0 })
    const s = settle(config, { id: 'a', tokens: null, now: T0 })
    assert.equal(s.ok, true)
    assert.equal(s.reason, 'usage_unknown')

    const r = readState(config, { now: T0 })
    assert.equal(r.state.daily.totalTokens, 0, 'unknown usage must not become charged usage')
    assert.equal(r.state.reservations, 0, 'but the reservation must still be let go')
  })
})

test('an unpriced call makes the running cost total a lower bound, and marks it', () => {
  // "You have spent $3" and "you have spent at least $3" are different claims. Once any call in
  // the period could not be priced, only the second one is true.
  withLedger('gov-partial', (config) => {
    reserve(config, { id: 'a', tokens: 10, now: T0 })
    settle(config, { id: 'a', tokens: 10, costUsd: null, now: T0 })
    const r = readState(config, { now: T0 })
    assert.equal(r.state.daily.costStatus, 'partial')
    assert.equal(r.state.daily.costUsd, 0, 'an unknown cost adds nothing rather than a guess')
  })
})

test('a fully priced period reports its cost as measured', () => {
  withLedger('gov-priced', (config) => {
    reserve(config, { id: 'a', tokens: 10, now: T0 })
    settle(config, { id: 'a', tokens: 10, costUsd: 0.25, now: T0 })
    const r = readState(config, { now: T0 })
    assert.equal(r.state.daily.costStatus, 'measured')
    assert.equal(r.state.daily.costUsd, 0.25)
  })
})

/* ------------------------------------------------------------- idempotency */

test('reserving the same id twice does not stack two claims', () => {
  withLedger('gov-rereserve', (config) => {
    reserve(config, { id: 'a', tokens: 400, now: T0 })
    const second = reserve(config, { id: 'a', tokens: 400, now: T0 })
    assert.equal(second.ok, true)
    assert.equal(second.reason, 'already_reserved')
    assert.equal(readState(config, { now: T0 }).state.daily.totalTokens, 400, 'not 800')
  })
})

test('settling the same id twice charges once', () => {
  // THE REPLAY INVARIANT. The JSONL sink has no write-path dedup, so a replayed hook is a real
  // possibility; the ledger is where it has to be harmless.
  withLedger('gov-resettle', (config) => {
    reserve(config, { id: 'a', tokens: 100, now: T0 })
    settle(config, { id: 'a', tokens: 100, costUsd: 1, now: T0 })
    const again = settle(config, { id: 'a', tokens: 100, costUsd: 1, now: T0 })
    assert.equal(again.ok, true)
    assert.equal(again.reason, 'not_reserved', 'the second settle finds nothing to convert')

    const r = readState(config, { now: T0 })
    assert.equal(r.state.daily.totalTokens, 100, 'charged once')
    assert.equal(r.state.daily.costUsd, 1, 'charged once')
    assert.equal(r.state.daily.calls, 1, 'counted once')
  })
})

test('settling an id that was never reserved charges nothing', () => {
  withLedger('gov-unreserved', (config) => {
    const s = settle(config, { id: 'ghost', tokens: 500, now: T0 })
    assert.equal(s.ok, true)
    assert.equal(s.reason, 'not_reserved')
    assert.equal(readState(config, { now: T0 }).state.daily.totalTokens, 0)
  })
})

test('releasing twice is a no-op rather than a credit', () => {
  withLedger('gov-rerelease', (config) => {
    reserve(config, { id: 'a', tokens: 100, now: T0 })
    assert.equal(release(config, { id: 'a', now: T0 }).status, 'released')
    const again = release(config, { id: 'a', now: T0 })
    assert.equal(again.ok, true)
    assert.equal(again.reason, 'not_reserved')
    assert.equal(readState(config, { now: T0 }).state.daily.totalTokens, 0, 'never below zero')
  })
})

test('an operation with no id is refused rather than guessed at', () => {
  withLedger('gov-noid', (config) => {
    for (const id of [null, undefined, '', 42]) {
      assert.equal(reserve(config, { id, tokens: 1, now: T0 }).reason, 'no_id', `id=${String(id)}`)
      assert.equal(settle(config, { id, tokens: 1, now: T0 }).reason, 'no_id', `id=${String(id)}`)
      assert.equal(release(config, { id, now: T0 }).reason, 'no_id', `id=${String(id)}`)
    }
  })
})

/* ------------------------------------------------------------- period rolls */

test('the daily bucket resets when the UTC day key changes', () => {
  // ROLLOVER IS A KEY MISMATCH, not a scheduled job: nothing runs at midnight, so nothing can
  // fail to run at midnight.
  withLedger('gov-dayroll', (config) => {
    reserve(config, { id: 'a', tokens: 500, now: T0 })
    settle(config, { id: 'a', tokens: 500, now: T0 })
    assert.equal(readState(config, { now: T0 }).state.daily.totalTokens, 500)

    const tomorrow = Date.parse('2026-10-05T00:00:00.000Z')
    const r = readState(config, { now: tomorrow })
    assert.equal(r.state.daily.totalTokens, 0, 'a new day starts empty')
    assert.equal(r.state.monthly.totalTokens, 500, 'but the month carries on')
  })
})

test('the monthly bucket resets when the UTC month key changes', () => {
  withLedger('gov-monthroll', (config) => {
    reserve(config, { id: 'a', tokens: 500, now: T0 })
    settle(config, { id: 'a', tokens: 500, now: T0 })

    const nextMonth = Date.parse('2026-11-01T00:00:00.000Z')
    const r = readState(config, { now: nextMonth })
    assert.equal(r.state.daily.totalTokens, 0)
    assert.equal(r.state.monthly.totalTokens, 0, 'a new month starts empty')
  })
})

test('a day rollover one millisecond after midnight already counts as the new day', () => {
  withLedger('gov-midnight', (config) => {
    const lastMoment = Date.parse('2026-10-04T23:59:59.999Z')
    reserve(config, { id: 'a', tokens: 7, now: lastMoment })
    settle(config, { id: 'a', tokens: 7, now: lastMoment })
    assert.equal(readState(config, { now: lastMoment }).state.daily.totalTokens, 7)
    assert.equal(
      readState(config, { now: Date.parse('2026-10-05T00:00:00.000Z') }).state.daily.totalTokens,
      0,
    )
  })
})

test('a month-end rollover crosses both boundaries at once', () => {
  withLedger('gov-monthend', (config) => {
    const end = Date.parse('2026-01-31T23:59:59.999Z')
    reserve(config, { id: 'a', tokens: 42, now: end })
    settle(config, { id: 'a', tokens: 42, now: end })

    const r = readState(config, { now: Date.parse('2026-02-01T00:00:00.000Z') })
    assert.equal(r.state.daily.totalTokens, 0)
    assert.equal(r.state.monthly.totalTokens, 0)
  })
})

test('an abandoned reservation expires rather than understating the budget forever', () => {
  // A hook killed between reserve and settle leaks its claim. The TTL bounds the damage; without
  // it a single killed process would hold headroom until someone deleted the file by hand.
  withLedger('gov-ttl', (config) => {
    reserve(config, { id: 'zombie', tokens: 900, now: T0 })
    assert.equal(readState(config, { now: T0 }).state.daily.totalTokens, 900)

    const later = T0 + RESERVATION_TTL_MS + 1
    assert.equal(readState(config, { now: later }).state.daily.totalTokens, 0)
    assert.equal(readState(config, { now: later }).state.reservations, 0)
  })
})

/* ---------------------------------------------------------------- the lock */

test('a stale lock is broken rather than wedging the budget', () => {
  // An exclusive-create lock left behind by a killed process would block every future
  // reservation if nothing reclaimed it. The holder stamps its own clock into the file, so
  // staleness is decided by comparing that stamp against the caller's clock.
  withLedger('gov-stalelock', (config, dir) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), String(T0 - LOCK_STALE_MS - 1000))

    const r = reserve(config, { id: 'a', tokens: 10, now: T0 })
    assert.equal(r.ok, true, `a stale lock must be reclaimed, got ${r.reason}`)
  })
})

test('an unstamped lock is judged on its mtime against the REAL clock, not the injected one', () => {
  // The two-clocks rule. An mtime is a real-system-clock value, so it may only be compared
  // against `Date.now()`. Comparing it against an injected `now` is what broke live locks and
  // lost a reservation in a four-process race — so this test deliberately passes a 2026
  // timestamp as `now` while backdating the mtime in real time, and the lock must still be
  // reclaimed on the strength of the mtime alone.
  withLedger('gov-mtimelock', (config, dir) => {
    const lock = path.join(dir, LOCK_FILENAME)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(lock, 'held by a process that died before it could stamp')
    const backdated = new Date(Date.now() - LOCK_STALE_MS - 60_000)
    fs.utimesSync(lock, backdated, backdated)

    const r = reserve(config, { id: 'a', tokens: 10, now: T0 })
    assert.equal(r.ok, true, `an unstamped stale lock must be reclaimed, got ${r.reason}`)
  })
})

test('a FRESH lock is respected, and the loser reports contention rather than corrupting', () => {
  withLedger('gov-freshlock', (config, dir) => {
    fs.mkdirSync(dir, { recursive: true })
    // Stamped with the caller's own clock, so it is provably live and must not be broken.
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), String(T0))

    const r = reserve(config, { id: 'a', tokens: 10, now: T0 })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'lock_contended')
    assert.equal(r.status, 'none', 'a failed reservation must not claim to hold anything')
  })
})

test('the lock is always released, so a second operation can proceed', () => {
  withLedger('gov-lockrelease', (config, dir) => {
    reserve(config, { id: 'a', tokens: 1, now: T0 })
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILENAME)), false, 'lock left behind')
    assert.equal(reserve(config, { id: 'b', tokens: 1, now: T0 }).ok, true)
    settle(config, { id: 'a', tokens: 1, now: T0 })
    assert.equal(fs.existsSync(path.join(dir, LOCK_FILENAME)), false, 'lock left behind')
  })
})

/* --------------------------------------------------------------- never throws */

test('an unwritable state directory returns a status rather than throwing', () => {
  // Rule 1. The caller decides to fail open; this module only has to tell the truth about why.
  const fakeFs = {
    mkdirSync: () => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' })
    },
    readFileSync: () => {
      throw Object.assign(new Error('nope'), { code: 'EACCES' })
    },
  }
  const config = configFor('C:/definitely/not/writable/ever')
  const r = reserve(config, { id: 'a', tokens: 1, fs: fakeFs, now: T0 })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'EACCES')
})

test('a filesystem that throws on every call still yields a status, never an exception', () => {
  const explode = () => {
    throw new Error('disk is on fire')
  }
  const hostileFs = {
    mkdirSync: explode,
    readFileSync: explode,
    writeFileSync: explode,
    openSync: explode,
    closeSync: explode,
    unlinkSync: explode,
    renameSync: explode,
    statSync: explode,
  }
  const config = configFor('C:/wherever')
  for (const [name, call] of [
    ['readState', () => readState(config, { fs: hostileFs, now: T0 })],
    ['reserve', () => reserve(config, { id: 'a', tokens: 1, fs: hostileFs, now: T0 })],
    ['settle', () => settle(config, { id: 'a', tokens: 1, fs: hostileFs, now: T0 })],
    ['release', () => release(config, { id: 'a', fs: hostileFs, now: T0 })],
    ['probeWritable', () => probeWritable(config, { fs: hostileFs })],
  ]) {
    const r = call()
    assert.equal(r.ok, false, `${name} must report failure`)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${name} must name the failure`)
  }
})

test('probeWritable succeeds on a real directory and leaves nothing behind', () => {
  withLedger('gov-probe', (config, dir) => {
    const r = probeWritable(config)
    assert.equal(r.ok, true, `probe failed: ${r.reason}`)
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('.probe-'))
    assert.deepEqual(leftovers, [], 'the probe cleaned up after itself')
  })
})

test('a hand-edited ledger with hostile values is sanitised rather than trusted', () => {
  // The ledger is a JSON file a human can open. Negative spend, string counts and a prototype
  // injection all have to become harmless rather than becoming budget.
  withLedger('gov-hostile', (config, dir) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, LEDGER_FILENAME),
      JSON.stringify({
        version: 1,
        day: '2026-10-04',
        month: '2026-10',
        daily: { totalTokens: -500, costUsd: 'free', calls: null },
        monthly: { totalTokens: '1e9' },
        reservations: [{ id: 'ok', tokens: -5 }, { nope: true }, 'string'],
      }),
    )
    const r = readState(config, { now: T0 })
    assert.equal(r.ok, true)
    assert.equal(r.state.daily.totalTokens, 0, 'negative spend is not negative budget')
    assert.equal(r.state.daily.costUsd, 0, 'a string cost is not a cost')
    assert.equal(r.state.monthly.totalTokens, 0, 'a numeric string is not parsed into spend')
    // Zero, not one. The surviving entry has no timestamp, so it cannot be shown to be fresh,
    // and an undateable claim is treated as expired rather than held forever. That direction is
    // deliberate: a leaked reservation understates the budget for as long as it lives, whereas
    // dropping one only risks a bounded overshoot on a single call.
    assert.equal(r.state.reservations, 0, 'an undateable reservation is treated as expired')
  })
})
