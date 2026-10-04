/**
 * The budget ledger — the only impure file in `lib/governance/`.
 *
 * It holds the small mutable state that `policy.mjs` reasons over: how much has been spent in
 * the current UTC day and month, and which delegations are in flight right now. It is
 * deliberately NOT the telemetry store. Telemetry is an append-only record of what happened;
 * this is a tiny mutable answer to "what is allowed next". Mixing them would mean reading a
 * growing JSONL file on the hot path to answer a question that fits in 400 bytes, which is
 * exactly the large telemetry scan the performance rule forbids.
 *
 * Four rules:
 *
 *  1. NEVER THROWS. Every failure is a returned status. A ledger that cannot be read or written
 *     must degrade to an ungoverned router, never to a blocked session — so an unreadable
 *     ledger reports `unavailable` and the caller fails open.
 *
 *  2. INJECTED I/O. `fs` and `now` are parameters. The only builtins imported are `node:fs` and
 *     `node:path`, matching `lib/hook/facts.mjs`, which is the other sanctioned hot-path I/O
 *     module. No network, no child process, no provider, no dynamic import.
 *
 *  3. RESERVATIONS ARE WHAT CLOSE THE RACE. Two hooks that each merely READ a spend of $0.80
 *     under a $1.00 limit would both conclude $0.15 was available and together spend $1.10.
 *     A reservation is written under a lock and counted toward spend while it is open, so the
 *     second hook sees $0.95 committed-plus-reserved and refuses. The lock is the same
 *     `openSync(..., 'wx')` trick `telemetry/identity.mjs` already uses to create the salt:
 *     O_EXCL is atomic on both POSIX and Windows, needs no dependency, and the loser of the
 *     race retries rather than corrupting anything.
 *
 *  4. IDEMPOTENT BY ID. `reserve`, `settle` and `release` are all keyed on a caller-supplied id
 *     (the `tool_use_id`), so a repeated settle cannot double-count and a replayed hook cannot
 *     charge twice. This is what makes the "replay does not double-count" invariant true here
 *     rather than merely aspirational.
 *
 * HONEST LIMITS, stated rather than papered over:
 *
 *   - The lock is advisory within this codebase. A process that writes `ledger.json` without
 *     taking it can still corrupt accounting; nothing outside this module does.
 *   - On a network share (SMB, NFS, OneDrive) `O_EXCL` creation is not reliably atomic, so
 *     cross-machine enforcement over a shared `budget.stateDir` is NOT guaranteed. Keep the
 *     state directory local. `scripts/doctor.mjs` cannot detect this and does not claim to.
 *   - A killed process leaks its reservation until the TTL expires, during which the budget is
 *     understated by that reservation. The TTL is far above the hook's own deadline, so this
 *     only happens to a hook that was killed outright.
 */

import fsDefault from 'node:fs'
import path from 'node:path'

import { periodKeys } from './policy.mjs'

/** Bumped if the on-disk shape changes. An unrecognised version is ignored, never migrated. */
export const LEDGER_VERSION = 1

export const LEDGER_FILENAME = 'ledger.json'
export const LOCK_FILENAME = 'ledger.lock'

/**
 * How long a reservation may stay open before it is treated as abandoned.
 *
 * Five minutes, against a hook deadline (`hooks.timeoutMs`) that defaults to 20 seconds and is
 * capped at 120. The gap is deliberate: a reservation reclaimed while its worker call is still
 * running would let the same budget be spent twice, which is the exact failure reservations
 * exist to prevent. Only a hook killed outright reaches this.
 */
export const RESERVATION_TTL_MS = 300_000

/**
 * How long a lock may be held before another process breaks it.
 *
 * Every critical section here is a read, a mutate and a write of one small file, so a lock held
 * for seconds means the holder died. Short enough that a dead hook does not wedge the budget,
 * long enough that a slow filesystem does not cause two writers to overlap.
 */
export const LOCK_STALE_MS = 10_000

/**
 * Bounded retries while another process holds the lock.
 *
 * Sized against the two numbers that matter: the critical section is a read, a mutate and a
 * write of one small file — sub-millisecond — while the hook's own deadline (`hooks.timeoutMs`)
 * defaults to 20 seconds. So waiting is nearly free and giving up is not: a reservation that
 * fails to be taken makes the caller fail OPEN, which silently weakens the budget exactly when
 * contention proves it is being used.
 *
 * MEASURED: with 60 attempts at a flat 1 ms, a four-process race over 100 reservations refused
 * one of them roughly every third run under a loaded machine. The escalating backoff below
 * raises the worst-case wait to a few hundred milliseconds and removed it.
 */
const LOCK_ATTEMPTS = 120

/**
 * Milliseconds to wait between attempts.
 *
 * A tight spin is NOT good enough here, and that is measured rather than assumed: with four
 * processes contending, a no-delay loop of 50 `openSync` calls completes in microseconds, long
 * before the holder has finished its read-modify-write, so every loser reported `lock_contended`
 * and reservations were silently refused. Backing off by a millisecond per attempt turns the
 * same budget into one that actually serialises.
 */
const LOCK_BACKOFF_MS = 1

/** After this many attempts, back off harder: the holder is clearly doing real work. */
const LOCK_BACKOFF_ESCALATE_AFTER = 20
const LOCK_BACKOFF_LONG_MS = 5

/**
 * Block for a few milliseconds, synchronously, without burning a core.
 *
 * `Atomics.wait` on a throwaway buffer is the only true synchronous sleep in Node, and this path
 * has to stay synchronous: it is reached from a hook whose whole contract is that it never
 * awaits anything it did not have to. Falls back to returning immediately where `Atomics.wait`
 * is not permitted, which degrades to the old tight spin rather than failing.
 */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* a spin is a worse wait, not a broken one */
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const own = (o, k) => (isPlainObject(o) && Object.hasOwn(o, k) ? o[k] : undefined)
const isAmount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const count = (v) => (isAmount(v) ? v : 0)

/** An empty period bucket. `costUnknownCalls` is why a cost total can be a lower bound. */
const emptyPeriod = () => ({ totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, costUnknownCalls: 0 })

const emptyLedger = (keys) => ({
  version: LEDGER_VERSION,
  day: keys.day,
  month: keys.month,
  daily: emptyPeriod(),
  monthly: emptyPeriod(),
  reservations: [],
})

/* -------------------------------------------------------------------------- paths */

/**
 * Where the ledger lives. `stateDirResolved` is set once by `loadConfig()`, like
 * `telemetry.dirResolved`, so no consumer re-implements `~`.
 */
export function ledgerPaths(config) {
  const dir = config?.budget?.stateDirResolved ?? config?.budget?.stateDir ?? null
  if (typeof dir !== 'string' || dir.trim() === '') return null
  return Object.freeze({
    dir,
    file: path.join(dir, LEDGER_FILENAME),
    lock: path.join(dir, LOCK_FILENAME),
  })
}

/* --------------------------------------------------------------------- the lock */

/**
 * Take the lock, or report why not.
 *
 * `'wx'` is O_EXCL: the kernel either creates the file or fails with EEXIST, with no window in
 * between for a second process to slip through. The loser spins; if the holder looks dead
 * (mtime older than LOCK_STALE_MS) the lock is broken once and retried.
 */
function acquire(paths, { fs, now }) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      // CREATED AND STAMPED IN ONE CALL. An earlier version opened the lock with 'wx' and then
      // wrote the timestamp through the fd, which left a window where a contender could read the
      // file before the stamp landed, see no timestamp, and fall through to the mtime branch
      // below. That branch then broke a LIVE lock, two processes entered the critical section
      // together and a reservation was lost — measured as 99 of 100 surviving a four-process
      // race. One call closes the window.
      fs.writeFileSync(paths.lock, String(now), { flag: 'wx' })
      return { ok: true }
    } catch (err) {
      // THE CONTENTION CLASS IS THREE CODES ON WINDOWS, NOT ONE.
      //
      // EEXIST is the ordinary "someone holds it" answer. EPERM and EACCES mean the same thing
      // often enough that they have to be retried too: a lock another process has just unlinked
      // sits in a PENDING-DELETE state until its last handle closes, and an exclusive create
      // against it fails with EPERM rather than EEXIST. Treating that as fatal made a
      // four-process race report `{reason: 'EPERM'}` and fail open — measured, and only under
      // load, which is exactly when a budget is being relied upon.
      //
      // An earlier attempt distinguished the two by checking whether the lock still existed.
      // That check is itself racy — the pending-delete window closes between the failed create
      // and the stat — and it still reported EPERM about one run in three. Retrying the whole
      // class and deciding only once the budget is exhausted has no such window.
      //
      // The accepted cost: a genuinely unwritable directory now takes the full retry budget
      // before reporting, and reports it as contention. `mkdirSync` above catches most
      // permission problems first, and `probeWritable()` is what diagnoses the rest for doctor.
      // Either way the caller behaves identically — it fails open and records a warning.
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM' && err?.code !== 'EACCES') {
        return { ok: false, reason: err?.code ?? 'lock_failed' }
      }

      // Held. Break it only if the holder is provably stale, and NEVER on a clock the stamp did
      // not come from.
      //
      // Two clocks exist here and mixing them is the bug above. `now` is injected — a test pins
      // a fixed 2026 timestamp — while an mtime comes from the real system clock. So each is
      // only ever compared against itself: a stamp against `now`, an mtime against `Date.now()`.
      // Comparing a stamp to an mtime makes staleness depend on the skew between the caller's
      // clock and the filesystem's, which breaks live locks in one direction and wedges the
      // budget forever in the other.
      try {
        const stamped = Number.parseInt(fs.readFileSync(paths.lock, 'utf8').trim(), 10)
        const stale = Number.isFinite(stamped)
          ? now - stamped > LOCK_STALE_MS
          : Date.now() - fs.statSync(paths.lock).mtimeMs > LOCK_STALE_MS
        if (stale) {
          fs.unlinkSync(paths.lock)
          continue
        }
      } catch {
        // It vanished between the EEXIST and the read, which means the holder released it.
        continue
      }

      pause(attempt < LOCK_BACKOFF_ESCALATE_AFTER ? LOCK_BACKOFF_MS : LOCK_BACKOFF_LONG_MS)
    }
  }
  return { ok: false, reason: 'lock_contended' }
}

function releaseLock(paths, { fs }) {
  try {
    fs.unlinkSync(paths.lock)
  } catch {
    /* already gone, which is the same outcome */
  }
}

/* --------------------------------------------------------------- read and write */

/** Parse the ledger, dropping anything we do not recognise rather than migrating it. */
function parse(raw, keys) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(data) || own(data, 'version') !== LEDGER_VERSION) return null

  const period = (block) => {
    const b = isPlainObject(block) ? block : {}
    return {
      totalTokens: count(own(b, 'totalTokens')),
      inputTokens: count(own(b, 'inputTokens')),
      outputTokens: count(own(b, 'outputTokens')),
      costUsd: count(own(b, 'costUsd')),
      calls: count(own(b, 'calls')),
      costUnknownCalls: count(own(b, 'costUnknownCalls')),
    }
  }

  const reservations = Array.isArray(own(data, 'reservations'))
    ? data.reservations
        .filter((r) => isPlainObject(r) && typeof own(r, 'id') === 'string')
        .map((r) => ({
          id: r.id,
          tokens: isAmount(own(r, 'tokens')) ? r.tokens : 0,
          costUsd: isAmount(own(r, 'costUsd')) ? r.costUsd : null,
          at: isAmount(own(r, 'at')) ? r.at : 0,
        }))
    : []

  return {
    version: LEDGER_VERSION,
    day: typeof own(data, 'day') === 'string' ? data.day : keys.day,
    month: typeof own(data, 'month') === 'string' ? data.month : keys.month,
    daily: period(own(data, 'daily')),
    monthly: period(own(data, 'monthly')),
    reservations,
  }
}

/**
 * Roll the periods forward and drop abandoned reservations.
 *
 * ROLLOVER IS A KEY MISMATCH, not a scheduled job. If the stored day is not today's key, the
 * daily bucket is zeroed; same for the month. Nothing runs at midnight, so nothing can fail to
 * run at midnight, and month length and leap years need no special case because no date
 * arithmetic happens anywhere.
 */
function roll(ledger, keys, now) {
  const out = { ...ledger }
  if (out.day !== keys.day) {
    out.day = keys.day
    out.daily = emptyPeriod()
  }
  if (out.month !== keys.month) {
    out.month = keys.month
    out.monthly = emptyPeriod()
  }
  out.reservations = (out.reservations ?? []).filter((r) => now - r.at <= RESERVATION_TTL_MS)
  return out
}

function load(paths, { fs, now }) {
  const keys = periodKeys(now)
  let raw = null
  try {
    raw = fs.readFileSync(paths.file, 'utf8')
  } catch (err) {
    // No ledger yet is the normal first-run state, and an empty budget is the right answer.
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return roll(emptyLedger(keys), keys, now)
    return null
  }
  const parsed = parse(raw, keys)
  // A corrupt ledger is treated as absent rather than as zero spend... which is the same thing
  // numerically, but the caller is told via `reason` so doctor can say so out loud.
  if (parsed === null) return null
  return roll(parsed, keys, now)
}

/**
 * Write the ledger as atomically as the platform allows.
 *
 * Temp file then rename, so a crash mid-write leaves the previous ledger intact rather than a
 * half-written one. Rename-over-existing works on Windows (MoveFileEx with REPLACE_EXISTING),
 * but can fail with EPERM/EACCES if a reader holds the target open, so a direct write is the
 * documented fallback — a torn ledger is recoverable (it parses as absent and fails open),
 * whereas a failed write would silently stop all accounting.
 */
function store(paths, ledger, { fs }) {
  const buf = Buffer.from(`${JSON.stringify(ledger)}\n`, 'utf8')
  const tmp = `${paths.file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, paths.file)
    return { ok: true }
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing to clean */
    }
    try {
      fs.writeFileSync(paths.file, buf)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err?.code ?? 'write_failed' }
    }
  }
}

/* -------------------------------------------------------------- the public API */

/**
 * Spend so far, in the shape `evaluateBudget()` reads.
 *
 * OPEN RESERVATIONS COUNT AS SPENT. That is the whole mechanism: an in-flight delegation has
 * not reported its usage yet, but it is going to, and a budget check that ignored it would let
 * every concurrent hook spend the same headroom.
 *
 * @returns {{ok: boolean, state: object|null, reason: string|null, periods: object}}
 */
export function readState(config, { fs = fsDefault, now = Date.now() } = {}) {
  const keys = periodKeys(now)
  const paths = ledgerPaths(config)
  if (paths === null) return { ok: false, state: null, reason: 'no_state_dir', periods: keys }

  let ledger
  try {
    ledger = load(paths, { fs, now })
  } catch (err) {
    return { ok: false, state: null, reason: err?.code ?? 'read_failed', periods: keys }
  }
  if (ledger === null) {
    return { ok: false, state: null, reason: 'unreadable_ledger', periods: keys }
  }

  let heldTokens = 0
  let heldCost = 0
  for (const r of ledger.reservations) {
    heldTokens += count(r.tokens)
    heldCost += count(r.costUsd)
  }

  const scope = (b) => ({
    totalTokens: b.totalTokens + heldTokens,
    costUsd: b.costUsd + heldCost,
    calls: b.calls,
    // A cost total assembled from calls whose cost we could not price is a LOWER BOUND, and
    // saying so is the difference between "you have spent $3" and "you have spent at least $3".
    costStatus: b.costUnknownCalls > 0 ? 'partial' : 'measured',
  })

  return {
    ok: true,
    reason: null,
    periods: keys,
    state: {
      // Per-run has no history: the run is one call, so the policy supplies zero itself.
      run: { totalTokens: 0, costUsd: 0, calls: 0, costStatus: 'measured' },
      daily: scope(ledger.daily),
      monthly: scope(ledger.monthly),
      reservations: ledger.reservations.length,
    },
  }
}

/**
 * Claim headroom for a delegation about to happen.
 *
 * Idempotent: reserving an id that is already open returns the existing reservation rather than
 * stacking a second one.
 */
export function reserve(config, { id, tokens = 0, costUsd = null, fs = fsDefault, now = Date.now() } = {}) {
  const paths = ledgerPaths(config)
  if (paths === null) return { ok: false, status: 'none', reason: 'no_state_dir' }
  if (typeof id !== 'string' || id === '') return { ok: false, status: 'none', reason: 'no_id' }

  try {
    fs.mkdirSync(paths.dir, { recursive: true })
  } catch (err) {
    return { ok: false, status: 'none', reason: err?.code ?? 'mkdir_failed' }
  }

  const lock = acquire(paths, { fs, now })
  if (!lock.ok) return { ok: false, status: 'none', reason: lock.reason }

  try {
    const ledger = load(paths, { fs, now })
    if (ledger === null) return { ok: false, status: 'none', reason: 'unreadable_ledger' }

    if (ledger.reservations.some((r) => r.id === id)) {
      return { ok: true, status: 'reserved', reason: 'already_reserved' }
    }

    ledger.reservations.push({
      id,
      tokens: count(tokens),
      costUsd: isAmount(costUsd) ? costUsd : null,
      at: now,
    })

    const written = store(paths, ledger, { fs })
    if (!written.ok) return { ok: false, status: 'none', reason: written.reason }
    return { ok: true, status: 'reserved', reason: null }
  } catch (err) {
    return { ok: false, status: 'none', reason: err?.code ?? 'reserve_failed' }
  } finally {
    releaseLock(paths, { fs })
  }
}

/**
 * Convert a reservation into measured spend.
 *
 * MEASURED FACTS ONLY. The estimate that sized the reservation is discarded; what lands in the
 * ledger is what the provider reported. `tokens: null` means the provider reported nothing, and
 * nothing is then charged — an exposure documented in `docs/governance.md` rather than hidden,
 * because inventing a number here would corrupt every budget that followed.
 *
 * Returns `status: 'overrun'` when the measured usage exceeded what was reserved. The overrun is
 * recorded rather than clamped: the money was really spent, and a ledger that hid it would
 * under-report the next decision.
 */
export function settle(
  config,
  { id, tokens = null, inputTokens = null, outputTokens = null, costUsd = null, fs = fsDefault, now = Date.now() } = {},
) {
  const paths = ledgerPaths(config)
  if (paths === null) return { ok: false, status: 'none', reason: 'no_state_dir' }
  if (typeof id !== 'string' || id === '') return { ok: false, status: 'none', reason: 'no_id' }

  const lock = acquire(paths, { fs, now })
  if (!lock.ok) return { ok: false, status: 'none', reason: lock.reason }

  try {
    const ledger = load(paths, { fs, now })
    if (ledger === null) return { ok: false, status: 'none', reason: 'unreadable_ledger' }

    const held = ledger.reservations.find((r) => r.id === id) ?? null
    // Rule 4: a settle for an id we are not holding is a no-op, not a second charge. This is
    // what makes a replayed hook harmless.
    if (held === null) return { ok: true, status: 'settled', reason: 'not_reserved' }

    ledger.reservations = ledger.reservations.filter((r) => r.id !== id)

    const measuredTokens = isAmount(tokens) ? tokens : null
    const usageKnown = measuredTokens !== null
    const costKnown = isAmount(costUsd)

    for (const bucket of [ledger.daily, ledger.monthly]) {
      bucket.calls += 1
      if (usageKnown) {
        bucket.totalTokens += measuredTokens
        bucket.inputTokens += count(inputTokens)
        bucket.outputTokens += count(outputTokens)
      }
      if (costKnown) bucket.costUsd += costUsd
      // An unpriced call makes the running cost total a lower bound from here on.
      else bucket.costUnknownCalls += 1
    }

    const written = store(paths, ledger, { fs })
    if (!written.ok) return { ok: false, status: 'none', reason: written.reason }

    const overran = usageKnown && measuredTokens > count(held.tokens)
    return {
      ok: true,
      status: overran ? 'overrun' : 'settled',
      reason: usageKnown ? null : 'usage_unknown',
    }
  } catch (err) {
    return { ok: false, status: 'none', reason: err?.code ?? 'settle_failed' }
  } finally {
    releaseLock(paths, { fs })
  }
}

/**
 * Give a reservation back without charging it.
 *
 * The path for every delegation that never reached the worker, or reached it and failed without
 * reporting usage: a refusal before dispatch, a `context_exceeded` refusal, a transport error,
 * a timeout. None of them created worker usage, so none of them may consume budget.
 */
export function release(config, { id, fs = fsDefault, now = Date.now() } = {}) {
  const paths = ledgerPaths(config)
  if (paths === null) return { ok: false, status: 'none', reason: 'no_state_dir' }
  if (typeof id !== 'string' || id === '') return { ok: false, status: 'none', reason: 'no_id' }

  const lock = acquire(paths, { fs, now })
  if (!lock.ok) return { ok: false, status: 'none', reason: lock.reason }

  try {
    const ledger = load(paths, { fs, now })
    if (ledger === null) return { ok: false, status: 'none', reason: 'unreadable_ledger' }

    const before = ledger.reservations.length
    ledger.reservations = ledger.reservations.filter((r) => r.id !== id)
    // Idempotent: releasing twice is not an error, it is the second one finding nothing to do.
    if (ledger.reservations.length === before) return { ok: true, status: 'released', reason: 'not_reserved' }

    const written = store(paths, ledger, { fs })
    if (!written.ok) return { ok: false, status: 'none', reason: written.reason }
    return { ok: true, status: 'released', reason: null }
  } catch (err) {
    return { ok: false, status: 'none', reason: err?.code ?? 'release_failed' }
  } finally {
    releaseLock(paths, { fs })
  }
}

/**
 * Can the state directory actually be written?
 *
 * Used by doctor, never on the hot path. A configured budget with an unwritable state directory
 * cannot be enforced, and that is a FAIL with a definite fix rather than a silent degradation.
 */
export function probeWritable(config, { fs = fsDefault } = {}) {
  const paths = ledgerPaths(config)
  if (paths === null) return { ok: false, reason: 'no_state_dir' }
  const probe = path.join(paths.dir, `.probe-${process.pid}`)
  try {
    fs.mkdirSync(paths.dir, { recursive: true })
    fs.writeFileSync(probe, Buffer.from('', 'utf8'))
    fs.unlinkSync(probe)
    return { ok: true, reason: null }
  } catch (err) {
    return { ok: false, reason: err?.code ?? 'not_writable' }
  }
}
