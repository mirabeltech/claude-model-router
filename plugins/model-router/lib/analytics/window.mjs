/**
 * What "today", "24h", "7d", "30d" and a custom range mean, in milliseconds, in UTC.
 *
 * IMPORTS NOTHING — not a node builtin, not even the rest of this layer. Every calendar edge case
 * (UTC midnight, a month boundary, a leap day, a future range, an empty range) is therefore
 * testable against a frozen `now` with no store, no filesystem and no config.
 *
 * TWO FILTERS, NOT ONE, AND THE COARSE ONE IS DELIBERATELY TOO WIDE. `listSegments()` filters by
 * the UTC date in a FILENAME; this module also produces the predicate that filters by the instant
 * in `row.timestamp`. The filename is a partition key written by the clock of whichever process
 * appended the row, so `segmentPrefilter()` widens the date range by a day on each side.
 * Narrowing it to the exact window would make the answer depend on a clock skew or a
 * cross-midnight rotation race, and the failure mode would be a silently missing event rather
 * than an error. Two extra file opens is the entire cost.
 *
 * AN UNDATED SEGMENT IS NEVER EXCLUDED BY A DATE FILTER. Under `telemetry.rotation: 'none'` the
 * store is a single `events.jsonl` that can hold a row from any day, and `listSegments()` passes
 * it through every date filter by design. So the precise per-row filter is load-bearing and not an
 * optimisation: without it, a `rotation: 'none'` store would report its entire history for every
 * window.
 *
 * BOUNDARIES ARE HALF-OPEN [from, to). Adjacent windows partition the timeline, so "today" and
 * "yesterday" can never both claim the same event, and an event exactly at midnight belongs to
 * the later day and only to the later day.
 */

const DAY_MS = 86_400_000

/**
 * The open-start boundary. Not a defaulted measurement: "from the beginning of the store" is a
 * real boundary and the epoch is where it is, which is why it is named rather than written as a
 * bare `?? 0` that reads like a zero-filled unknown.
 */
const EPOCH_MS = 0

/** Milliseconds, or null for anything that is not a finite number. */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** UTC midnight at or before `ms`. */
export function utcMidnightMs(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

/** The `YYYY-MM-DD` UTC day key for an instant. */
export function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Shift a `YYYY-MM-DD` key by whole days, through the epoch so month lengths never matter. */
export function shiftDayKey(key, days) {
  const ms = Date.parse(`${key}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return key
  return utcDayKey(ms + days * DAY_MS)
}

/**
 * The ISO week key (`YYYY-Www`) for an instant, used when a window spans more days than the date
 * dimension will bucket. Monday-based, matching ISO 8601, so a week key is comparable across
 * years without a lookup table.
 */
export function isoWeekKey(ms) {
  const d = new Date(utcMidnightMs(ms))
  // Thursday of the current ISO week determines the year, by definition.
  const day = (d.getUTCDay() + 6) % 7
  const thursday = new Date(d.getTime() + (3 - day) * DAY_MS)
  const year = thursday.getUTCFullYear()
  const jan1 = Date.parse(`${year}-01-01T00:00:00.000Z`)
  const week = Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Whole days spanned by a half-open range, rounded up. */
export function daysSpanned(fromMs, toMs) {
  if (toMs <= fromMs) return 0
  return Math.ceil((toMs - fromMs) / DAY_MS)
}

/** `YYYY-MM-DD`. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A full instant with an EXPLICIT zone: `YYYY-MM-DDTHH:MM[:SS[.sss]]` followed by `Z` or `±HH:MM`.
 *
 * The explicit zone is mandatory, and that is the whole point of this regex. ECMA-262 parses a
 * date-time string with no offset as LOCAL time, so `2026-03-04T06:30:00` means a different
 * instant on two machines — which is precisely the ambiguity this layer exists to remove. An
 * operator who means UTC can say `Z` in one keystroke; an operator who means a local time can say
 * the offset. Neither has to rely on where the process happens to be running.
 */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Parse a user-supplied boundary.
 *
 * STRICT ISO 8601 ONLY, matched against a shape before `Date.parse` ever sees it. Handing the raw
 * string to `Date.parse` and checking for NaN is not enough, and the gap is not theoretical:
 * MEASURED, `Date.parse('03/04/2026')` returns a valid instant in V8 — a non-standard
 * implementation extension, interpreted in LOCAL time. So `--start 03/04/2026` would have been
 * accepted, would have meant a different instant in two timezones, and would have produced a
 * perfectly plausible-looking report. An ambiguous boundary is refused instead.
 *
 * A bare `YYYY-MM-DD` is anchored at UTC midnight explicitly rather than relying on the spec's
 * date-only rule, which engines have historically disagreed about.
 */
export function parseBoundary(text, { endOfDay = false } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty' }
  }
  const raw = text.trim()

  if (DATE_ONLY_RE.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00.000Z`)
    if (!Number.isFinite(ms)) return { ok: false, reason: 'not_a_date' }
    // An impossible calendar date must be refused, not rolled over: Date.parse rejects
    // 2026-02-30, but a reader that built the string itself might not have.
    if (utcDayKey(ms) !== raw) return { ok: false, reason: 'not_a_date' }
    // A date-only END boundary means "through the end of that day", which under half-open
    // boundaries is midnight on the following day.
    return { ok: true, ms: endOfDay ? ms + DAY_MS : ms, dateOnly: true }
  }

  if (!INSTANT_RE.test(raw)) return { ok: false, reason: 'not_a_date' }

  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return { ok: false, reason: 'not_a_date' }
  // The shape can be legal while the date is not: 2026-02-30T00:00:00Z matches the regex, and
  // some engines roll it forward rather than rejecting it.
  if (!raw.startsWith(utcDayKey(Date.parse(`${raw.slice(0, 10)}T00:00:00.000Z`)))) {
    return { ok: false, reason: 'not_a_date' }
  }
  return { ok: true, ms, dateOnly: false }
}

/**
 * Resolve a window request into an explicit UTC range.
 *
 * Returns a `timeRange` fit to go straight into the response. `valid: false` carries a `reason`
 * and an empty range — an unparseable boundary never silently becomes a default window.
 *
 * `nowMs` HAS NO DEFAULT, deliberately. A `= Date.now()` default would make a caller that passed
 * `undefined` — a missing `--now`, an unset fixture clock — silently resolve against the real
 * wall clock, which is the one thing a reproducible window must never do. An absent clock is a
 * refusal, so the mistake surfaces as an invalid window instead of as a plausible report.
 *
 * @param {{kind?: string, start?: string|null, end?: string|null}} request
 * @param {number} nowMs
 */
export function resolveWindow(request = {}, nowMs) {
  const now = finite(nowMs)
  if (now === null) {
    return invalid('now_not_a_number', request?.kind ?? 'custom')
  }

  const kind = request.kind ?? '7d'

  if (kind === 'custom') {
    const hasStart = typeof request.start === 'string' && request.start.trim() !== ''
    const hasEnd = typeof request.end === 'string' && request.end.trim() !== ''
    if (!hasStart && !hasEnd) return invalid('custom_without_bounds', kind)

    // An open end means "up to now"; an open start means "from the beginning of the store".
    // Neither is an error, because "everything since Monday" is a reasonable thing to ask.
    const start = hasStart ? parseBoundary(request.start) : { ok: true, ms: null }
    const end = hasEnd ? parseBoundary(request.end, { endOfDay: true }) : { ok: true, ms: null }
    if (!start.ok) return invalid(`start_${start.reason}`, kind)
    if (!end.ok) return invalid(`end_${end.reason}`, kind)

    const fromMs = start.ms === null ? EPOCH_MS : start.ms
    const toMs = end.ms ?? now
    if (toMs < fromMs) return invalid('end_before_start', kind)
    return build(kind, fromMs, toMs, now, { openStart: start.ms === null, openEnd: end.ms === null })
  }

  if (kind === 'all') return build(kind, EPOCH_MS, now, now, { openStart: true, openEnd: true })
  if (kind === 'today') return build(kind, utcMidnightMs(now), now, now, {})
  if (kind === '24h') return build(kind, now - DAY_MS, now, now, {})
  // 7d and 30d are N whole UTC days ENDING WITH TODAY, not N*24 hours. "Last 7 days" that began
  // at an arbitrary time of day cannot be compared with a daily bucket, and the date dimension
  // is the main thing these windows feed.
  if (kind === '7d') return build(kind, utcMidnightMs(now) - 6 * DAY_MS, now, now, {})
  if (kind === '30d') return build(kind, utcMidnightMs(now) - 29 * DAY_MS, now, now, {})

  return invalid('unknown_window_kind', kind)
}

function invalid(reason, kind) {
  return Object.freeze({
    kind,
    valid: false,
    reason,
    fromMs: null,
    toMs: null,
    start: null,
    end: null,
    timeZone: 'UTC',
    boundaries: 'half_open',
    days: 0,
    incompletePeriod: false,
    future: false,
    empty: true,
  })
}

function build(kind, fromMs, toMs, now, { openStart = false, openEnd = false }) {
  return Object.freeze({
    kind,
    valid: true,
    reason: null,
    fromMs,
    toMs,
    start: new Date(fromMs).toISOString(),
    end: new Date(toMs).toISOString(),
    timeZone: 'UTC',
    boundaries: 'half_open',
    openStart,
    openEnd,
    days: daysSpanned(fromMs, toMs),
    // The newest day in the range is still accruing events, so a trend whose last point covers
    // four hours cannot be compared with points covering twenty-four.
    incompletePeriod: toMs > utcMidnightMs(toMs) && toMs >= now,
    // A window entirely in the future is not an error — it is a legitimate question with an
    // empty answer — but reporting "no delegations" without saying why would read as a finding.
    future: fromMs > now,
    empty: toMs <= fromMs,
  })
}

/**
 * The COARSE segment filter, as `listSegments()` wants it: `{from, to}` UTC date strings, or
 * nulls for an open side.
 *
 * Widened by one day on each side. See the module header: the filename date comes from the
 * appending process's clock, and a row written at 00:00:01 by a process whose segment had not yet
 * rotated lands in the previous day's file. The precise per-row filter is what makes the answer
 * exact, so this one only has to be a superset.
 */
export function segmentPrefilter(timeRange) {
  if (!timeRange?.valid) return { from: null, to: null }
  return {
    from: timeRange.openStart ? null : shiftDayKey(utcDayKey(timeRange.fromMs), -1),
    to: timeRange.openEnd ? null : shiftDayKey(utcDayKey(timeRange.toMs), 1),
  }
}

/**
 * The instant a row happened, or null if it cannot be determined.
 *
 * A row with no parseable timestamp is UNDATABLE, not out of range. The caller counts it
 * separately so it never looks like a window that happened to miss it.
 */
export function rowInstantMs(row) {
  const ts = row?.timestamp
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/** The PRECISE per-row predicate. Half-open: `fromMs <= t < toMs`. */
export function inWindow(timeRange, ms) {
  if (!timeRange?.valid || ms === null) return false
  return ms >= timeRange.fromMs && ms < timeRange.toMs
}

/**
 * Every UTC day key in the range, oldest first, so a date series has a point for a day on which
 * nothing happened.
 *
 * A gap rendered as "no data" and a gap rendered as zero are different claims, and a series that
 * simply omitted the quiet days would draw a line straight through them. Bounded by `maxDays`;
 * past that the caller switches to week keys and says so.
 */
export function enumerateDays(timeRange, maxDays = 366) {
  if (!timeRange?.valid || timeRange.empty) return []
  const out = []
  const last = utcMidnightMs(timeRange.toMs - 1)
  for (let ms = utcMidnightMs(timeRange.fromMs); ms <= last; ms += DAY_MS) {
    out.push(utcDayKey(ms))
    if (out.length >= maxDays) break
  }
  return out
}

/** Every ISO week key in the range, oldest first. The fallback for a very long window. */
export function enumerateWeeks(timeRange, maxWeeks = 366) {
  if (!timeRange?.valid || timeRange.empty) return []
  const seen = []
  const last = utcMidnightMs(timeRange.toMs - 1)
  for (let ms = utcMidnightMs(timeRange.fromMs); ms <= last; ms += DAY_MS) {
    const key = isoWeekKey(ms)
    if (seen[seen.length - 1] !== key) seen.push(key)
    if (seen.length >= maxWeeks) break
  }
  return seen
}
