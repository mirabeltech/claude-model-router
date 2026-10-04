/**
 * Time windows.
 *
 * Every boundary in this layer is UTC and every range is half-open. Both choices are here to stop
 * the same store answering two different questions: a local-timezone boundary makes "savings
 * yesterday" unreproducible between two developers reading the same log, and a closed range lets
 * an event at exactly midnight be claimed by two adjacent windows at once.
 *
 * `window.mjs` imports nothing, so all of this runs against a frozen number with no store.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  daysSpanned,
  enumerateDays,
  enumerateWeeks,
  inWindow,
  isoWeekKey,
  parseBoundary,
  resolveWindow,
  rowInstantMs,
  segmentPrefilter,
  shiftDayKey,
  utcDayKey,
  utcMidnightMs,
} from '../plugins/model-router/lib/analytics/window.mjs'

const DAY = 86_400_000
const ms = (iso) => Date.parse(iso)

/** Mid-day, so no window boundary is anywhere near a rotation edge by accident. */
const NOW = ms('2026-03-04T12:00:00.000Z')

/* --------------------------------------------------------------- primitives */

test('UTC midnight is found by flooring, not by mutating a Date', () => {
  assert.equal(utcMidnightMs(NOW), ms('2026-03-04T00:00:00.000Z'))
  // Already midnight: flooring must be idempotent, or `today` would jump back a day at 00:00.
  assert.equal(utcMidnightMs(ms('2026-03-04T00:00:00.000Z')), ms('2026-03-04T00:00:00.000Z'))
  assert.equal(utcMidnightMs(ms('2026-03-04T23:59:59.999Z')), ms('2026-03-04T00:00:00.000Z'))
})

test('a day key is shifted through the epoch, so month lengths never have to be known', () => {
  assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28')
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDayKey('2026-12-31', 1), '2027-01-01')
  // 2028 is a leap year; 2026 is not. Arithmetic on the epoch gets both right for free.
  assert.equal(shiftDayKey('2028-02-28', 1), '2028-02-29')
  assert.equal(shiftDayKey('2026-02-28', 1), '2026-03-01')
})

test('days spanned is zero for an empty range and never negative', () => {
  assert.equal(daysSpanned(NOW, NOW), 0)
  assert.equal(daysSpanned(NOW, NOW - DAY), 0)
  assert.equal(daysSpanned(ms('2026-03-01T00:00:00Z'), ms('2026-03-08T00:00:00Z')), 7)
  // A partial day still counts as a day: it is a bucket that exists.
  assert.equal(daysSpanned(ms('2026-03-01T00:00:00Z'), ms('2026-03-01T00:00:01Z')), 1)
})

/* ------------------------------------------------------------- boundaries */

test('a bare date is anchored at UTC midnight, never handed to local-time parsing rules', () => {
  // Date.parse of a date-only string is UTC per spec, but engines have disagreed, and the whole
  // point of this layer is that two machines agree about which day an event fell in.
  const r = parseBoundary('2026-03-04')
  assert.equal(r.ok, true)
  assert.equal(r.ms, ms('2026-03-04T00:00:00.000Z'))
  assert.equal(r.dateOnly, true)
})

test('a date-only END boundary means through the end of that day', () => {
  // Under half-open boundaries "--end 2026-03-04" has to resolve to midnight on the 5th, or the
  // last day an operator asked for would be silently excluded.
  const r = parseBoundary('2026-03-04', { endOfDay: true })
  assert.equal(r.ms, ms('2026-03-05T00:00:00.000Z'))
})

test('an impossible calendar date is refused rather than silently rolled over', () => {
  assert.equal(parseBoundary('2026-02-30').ok, false)
  assert.equal(parseBoundary('2026-13-01').ok, false)
  assert.equal(parseBoundary('2026-00-10').ok, false)
})

test('an unparseable boundary is a refusal, never a fallback to now', () => {
  // Resolving a typo to `now` would report a window the operator never asked for, and the
  // numbers would look perfectly plausible.
  for (const bad of ['', '   ', 'yesterday', 'last week', '03/04/2026', 'NaN', '2026-3-4x']) {
    assert.equal(parseBoundary(bad).ok, false, `${JSON.stringify(bad)} must be refused`)
  }
})

test('a full ISO instant is taken exactly as given', () => {
  const r = parseBoundary('2026-03-04T06:30:00.000Z')
  assert.equal(r.ms, ms('2026-03-04T06:30:00.000Z'))
  assert.equal(r.dateOnly, false)
})

test('a US-style date is refused, because Date.parse would read it in LOCAL time', () => {
  // MEASURED before the fix: parseBoundary('03/04/2026') returned {ok:true, ms:1772562600000}.
  // Date.parse accepts that form as a V8 implementation extension and interprets it in the
  // machine's timezone, so `--start 03/04/2026` meant a different instant on two developers'
  // laptops and still produced a perfectly plausible report. Checking Date.parse for NaN is not
  // enough; the shape has to be checked first.
  assert.equal(parseBoundary('03/04/2026').ok, false)
  assert.equal(parseBoundary('March 4 2026').ok, false)
  assert.equal(parseBoundary('2026/03/04').ok, false)
})

test('a date-time with no zone is refused, because the spec reads it in local time', () => {
  // ECMA-262 parses a date-time string with no offset as local time, so this one string means
  // two different instants in two places. An operator who means UTC adds `Z`; one who means a
  // local time adds the offset. Guessing on their behalf is what this layer exists not to do.
  assert.equal(parseBoundary('2026-03-04T06:30:00').ok, false)
  assert.equal(parseBoundary('2026-03-04T06:30').ok, false)
  assert.equal(parseBoundary('2026-03-04T06:30:00Z').ok, true)
  assert.equal(parseBoundary('2026-03-04T06:30:00+05:30').ok, true)
  assert.equal(
    parseBoundary('2026-03-04T06:30:00+05:30').ms,
    ms('2026-03-04T01:00:00.000Z'),
    'an explicit offset is honoured, not stripped',
  )
})

test('a legal shape with an illegal date is still refused', () => {
  // 2026-02-30T00:00:00Z matches the instant shape, and an engine that rolled it forward to
  // March 2nd would answer a question nobody asked.
  assert.equal(parseBoundary('2026-02-30T00:00:00Z').ok, false)
})

/* ----------------------------------------------------------- window kinds */

test('today runs from UTC midnight to now, and is flagged incomplete', () => {
  const w = resolveWindow({ kind: 'today' }, NOW)
  assert.equal(w.valid, true)
  assert.equal(w.start, '2026-03-04T00:00:00.000Z')
  assert.equal(w.end, '2026-03-04T12:00:00.000Z')
  assert.equal(w.timeZone, 'UTC')
  assert.equal(w.boundaries, 'half_open')
  // The day is still accruing events, so a trend whose last point covers twelve hours must not
  // be compared with points covering twenty-four.
  assert.equal(w.incompletePeriod, true)
})

test('24h is a rolling day and is NOT the same window as today', () => {
  const today = resolveWindow({ kind: 'today' }, NOW)
  const rolling = resolveWindow({ kind: '24h' }, NOW)
  assert.equal(rolling.start, '2026-03-03T12:00:00.000Z')
  assert.notEqual(rolling.fromMs, today.fromMs, 'conflating the two is a 12-hour error here')
})

test('7d and 30d are whole UTC days ending with today, not N times 24 hours', () => {
  // A window that began at an arbitrary time of day cannot be compared with a daily bucket, and
  // the date dimension is the main thing these windows feed.
  const w7 = resolveWindow({ kind: '7d' }, NOW)
  assert.equal(w7.start, '2026-02-26T00:00:00.000Z')
  assert.equal(w7.days, 7)

  const w30 = resolveWindow({ kind: '30d' }, NOW)
  assert.equal(w30.start, '2026-02-03T00:00:00.000Z')
  assert.equal(w30.days, 30)
})

test('a 7d window crossing a month boundary spans exactly seven day buckets', () => {
  const w = resolveWindow({ kind: '7d' }, ms('2026-03-02T09:00:00.000Z'))
  assert.equal(w.start, '2026-02-24T00:00:00.000Z')
  assert.deepEqual(enumerateDays(w), [
    '2026-02-24',
    '2026-02-25',
    '2026-02-26',
    '2026-02-27',
    '2026-02-28',
    '2026-03-01',
    '2026-03-02',
  ])
})

test('a 7d window ending on a leap day spans the leap day correctly', () => {
  const w = resolveWindow({ kind: '7d' }, ms('2028-02-29T09:00:00.000Z'))
  assert.deepEqual(enumerateDays(w).at(-1), '2028-02-29')
  assert.equal(enumerateDays(w).length, 7)
  assert.equal(enumerateDays(w)[0], '2028-02-23')
})

test('a window resolved exactly at UTC midnight is complete, not incomplete', () => {
  // At 00:00:00.000 the "today" window is zero-length and nothing has accrued, so flagging it
  // incomplete would be true but useless; the empty flag is the honest signal.
  const w = resolveWindow({ kind: 'today' }, ms('2026-03-04T00:00:00.000Z'))
  assert.equal(w.fromMs, w.toMs)
  assert.equal(w.empty, true)
  assert.equal(w.incompletePeriod, false)
  assert.deepEqual(enumerateDays(w), [], 'an empty range enumerates no day at all')
})

test('an unknown window kind is refused and names itself', () => {
  const w = resolveWindow({ kind: 'last_fortnight' }, NOW)
  assert.equal(w.valid, false)
  assert.equal(w.reason, 'unknown_window_kind')
  assert.equal(w.kind, 'last_fortnight')
  assert.equal(w.fromMs, null, 'an invalid window must carry no range at all')
})

test('an absent or non-numeric now is refused rather than defaulting to the real clock', () => {
  // MEASURED before the fix: resolveWindow({kind:'7d'}, undefined) returned a VALID window,
  // because the signature carried a `nowMs = Date.now()` default. A caller with an unset
  // fixture clock or a missing --now therefore resolved against the wall clock and produced a
  // report that looked fine and could not be reproduced. The default parameter was the bug.
  assert.equal(resolveWindow({ kind: '7d' }, Number.NaN).valid, false)
  assert.equal(resolveWindow({ kind: '7d' }, undefined).valid, false)
  assert.equal(resolveWindow({ kind: '7d' }).valid, false)
  assert.equal(resolveWindow({ kind: '7d' }, null).valid, false)
  assert.equal(resolveWindow({ kind: '7d' }, '1772625600000').valid, false, 'a string clock is not a clock')
})

/* --------------------------------------------------------- custom windows */

test('a custom window with both bounds uses them verbatim, end-of-day inclusive', () => {
  const w = resolveWindow({ kind: 'custom', start: '2026-03-02', end: '2026-03-03' }, NOW)
  assert.equal(w.valid, true)
  assert.equal(w.start, '2026-03-02T00:00:00.000Z')
  assert.equal(w.end, '2026-03-04T00:00:00.000Z')
  assert.deepEqual(enumerateDays(w), ['2026-03-02', '2026-03-03'])
})

test('a custom window with no bounds at all is a usage error', () => {
  const w = resolveWindow({ kind: 'custom' }, NOW)
  assert.equal(w.valid, false)
  assert.equal(w.reason, 'custom_without_bounds')
})

test('an open start means from the beginning of the store, and says so', () => {
  const w = resolveWindow({ kind: 'custom', end: '2026-03-03' }, NOW)
  assert.equal(w.valid, true)
  assert.equal(w.openStart, true)
  assert.equal(w.fromMs, 0)
})

test('an open end means up to now, and says so', () => {
  const w = resolveWindow({ kind: 'custom', start: '2026-03-01' }, NOW)
  assert.equal(w.valid, true)
  assert.equal(w.openEnd, true)
  assert.equal(w.toMs, NOW)
})

test('an end before the start is refused, not silently swapped', () => {
  // Swapping would answer a different question than the one asked, with no indication.
  const w = resolveWindow({ kind: 'custom', start: '2026-03-05', end: '2026-03-01' }, NOW)
  assert.equal(w.valid, false)
  assert.equal(w.reason, 'end_before_start')
})

test('a bad bound names which side was bad', () => {
  assert.equal(resolveWindow({ kind: 'custom', start: 'nope', end: '2026-03-01' }, NOW).reason, 'start_not_a_date')
  assert.equal(resolveWindow({ kind: 'custom', start: '2026-03-01', end: 'nope' }, NOW).reason, 'end_not_a_date')
})

test('a window wholly in the future is valid and flagged, not an error', () => {
  // It is a legitimate question with an empty answer. Reporting "no delegations" without saying
  // the window has not happened yet would read as a finding about the router.
  const w = resolveWindow({ kind: 'custom', start: '2027-01-01', end: '2027-01-07' }, NOW)
  assert.equal(w.valid, true)
  assert.equal(w.future, true)
  assert.equal(w.empty, false)
})

test('a single-instant window is valid, empty, and claims nothing', () => {
  const w = resolveWindow(
    { kind: 'custom', start: '2026-03-04T12:00:00.000Z', end: '2026-03-04T12:00:00.000Z' },
    NOW,
  )
  assert.equal(w.valid, true)
  assert.equal(w.empty, true)
  assert.equal(inWindow(w, NOW), false, 'half-open: an empty range contains nothing, not one point')
})

/* -------------------------------------------------- the half-open boundary */

test('an event exactly at the start is in, and one exactly at the end is out', () => {
  // This is what makes adjacent windows partition the timeline. Without it, a midnight event is
  // counted twice across two reports and the totals do not reconcile.
  const w = resolveWindow({ kind: 'custom', start: '2026-03-02', end: '2026-03-02' }, NOW)
  assert.equal(inWindow(w, ms('2026-03-02T00:00:00.000Z')), true)
  assert.equal(inWindow(w, ms('2026-03-02T23:59:59.999Z')), true)
  assert.equal(inWindow(w, ms('2026-03-03T00:00:00.000Z')), false)
  assert.equal(inWindow(w, ms('2026-03-01T23:59:59.999Z')), false)
})

test('two adjacent windows partition an instant: exactly one claims it', () => {
  const earlier = resolveWindow({ kind: 'custom', start: '2026-03-02', end: '2026-03-02' }, NOW)
  const later = resolveWindow({ kind: 'custom', start: '2026-03-03', end: '2026-03-03' }, NOW)
  const midnight = ms('2026-03-03T00:00:00.000Z')
  assert.equal(inWindow(earlier, midnight) ? 1 : 0, 0)
  assert.equal(inWindow(later, midnight) ? 1 : 0, 1)
})

test('an invalid window contains nothing, so a bad request cannot aggregate rows', () => {
  const w = resolveWindow({ kind: 'nonsense' }, NOW)
  assert.equal(inWindow(w, NOW), false)
})

/* --------------------------------------------------- the row instant */

test('a row with no parseable timestamp is undatable, which is not the same as out of range', () => {
  assert.equal(rowInstantMs({ timestamp: '2026-03-04T12:00:00.000Z' }), NOW)
  assert.equal(rowInstantMs({ timestamp: 'not a time' }), null)
  assert.equal(rowInstantMs({ timestamp: null }), null)
  assert.equal(rowInstantMs({ timestamp: 1234 }), null, 'a number is not an ISO string')
  assert.equal(rowInstantMs({}), null)
  assert.equal(rowInstantMs(null), null)
})

test('an undatable row is never in any window', () => {
  const w = resolveWindow({ kind: 'all' }, NOW)
  assert.equal(inWindow(w, rowInstantMs({ timestamp: 'garbage' })), false)
})

/* --------------------------------------------------- the segment prefilter */

test('the segment prefilter is widened by a day on each side, deliberately', () => {
  // The filename date comes from the clock of whichever process appended the row, so a row
  // written just after midnight can land in the previous day's file. Narrowing this to the exact
  // window would make the answer depend on a clock skew, and the failure would be a silently
  // missing event. The precise per-row filter is what makes the answer exact.
  const w = resolveWindow({ kind: 'custom', start: '2026-03-02', end: '2026-03-03' }, NOW)
  assert.deepEqual(segmentPrefilter(w), { from: '2026-03-01', to: '2026-03-05' })
})

test('the prefilter is a superset of the window it is derived from', () => {
  const violations = []
  for (const kind of ['today', '24h', '7d', '30d']) {
    const w = resolveWindow({ kind }, NOW)
    const pre = segmentPrefilter(w)
    if (pre.from !== null && pre.from >= utcDayKey(w.fromMs)) {
      violations.push(`${kind}: prefilter from ${pre.from} does not precede ${utcDayKey(w.fromMs)}`)
    }
    if (pre.to !== null && pre.to <= utcDayKey(w.toMs)) {
      violations.push(`${kind}: prefilter to ${pre.to} does not follow ${utcDayKey(w.toMs)}`)
    }
  }
  assert.deepEqual(violations, [], 'the coarse filter must never be narrower than the window')
})

test('an open side of a custom window produces a null prefilter bound, not a date', () => {
  // listSegments() treats null as "no bound". Supplying a computed date here would exclude
  // segments the operator asked for.
  const w = resolveWindow({ kind: 'custom', end: '2026-03-03' }, NOW)
  assert.equal(segmentPrefilter(w).from, null)
  const w2 = resolveWindow({ kind: 'custom', start: '2026-03-01' }, NOW)
  assert.equal(segmentPrefilter(w2).to, null)
})

test('an invalid window prefilters nothing, so no segment is opened on a bad request', () => {
  assert.deepEqual(segmentPrefilter(resolveWindow({ kind: 'bogus' }, NOW)), { from: null, to: null })
  assert.deepEqual(segmentPrefilter(null), { from: null, to: null })
})

/* ------------------------------------------------------------- enumeration */

test('every day in the window gets a bucket, including days on which nothing happened', () => {
  // A series that omitted the quiet days would draw a line straight through them, which asserts
  // a measurement that was never taken.
  const w = resolveWindow({ kind: '7d' }, NOW)
  const days = enumerateDays(w)
  assert.equal(days.length, 7)
  assert.equal(days[0], '2026-02-26')
  assert.equal(days.at(-1), '2026-03-04')
})

test('day enumeration is capped, so a decade-long custom window cannot blow up the response', () => {
  const w = resolveWindow({ kind: 'custom', start: '2016-01-01', end: '2026-01-01' }, NOW)
  assert.equal(enumerateDays(w, 366).length, 366)
})

test('a long window falls back to ISO week keys, which stay comparable across a year end', () => {
  const w = resolveWindow({ kind: 'custom', start: '2025-12-15', end: '2026-01-15' }, NOW)
  const weeks = enumerateWeeks(w)
  assert.ok(weeks.length >= 4 && weeks.length <= 6, `got ${weeks.length} weeks`)
  assert.deepEqual([...weeks].sort(), weeks, 'week keys must sort chronologically as strings')
  assert.deepEqual([...new Set(weeks)], weeks, 'no week appears twice')
})

test('an ISO week key uses the Thursday rule, so a year boundary lands in the right year', () => {
  // 2026-01-01 is a Thursday, so it belongs to 2026-W01. 2025-12-29 is the Monday of that same
  // ISO week and must agree, or a weekly series would show two buckets for one week.
  assert.equal(isoWeekKey(ms('2026-01-01T00:00:00Z')), '2026-W01')
  assert.equal(isoWeekKey(ms('2025-12-29T00:00:00Z')), '2026-W01')
})

/* -------------------------------------------------------------- the shape */

test('a resolved window is frozen, so a consumer cannot retune the range it was given', () => {
  const w = resolveWindow({ kind: '7d' }, NOW)
  assert.throws(() => {
    w.fromMs = 0
  }, TypeError)
})

test('every window kind resolves to a complete, self-describing range', () => {
  const required = ['kind', 'valid', 'reason', 'fromMs', 'toMs', 'start', 'end', 'timeZone', 'boundaries', 'days', 'incompletePeriod', 'future', 'empty']
  const violations = []
  for (const kind of ['today', '24h', '7d', '30d', 'all']) {
    const w = resolveWindow({ kind }, NOW)
    for (const key of required) {
      if (!(key in w)) violations.push(`${kind} is missing ${key}`)
    }
    if (w.timeZone !== 'UTC') violations.push(`${kind} is not UTC`)
  }
  assert.deepEqual(violations, [], 'a window must describe itself completely')
})
