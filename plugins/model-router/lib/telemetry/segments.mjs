/**
 * Segment filenames: build, parse, list, and select for pruning.
 *
 * ONE DEFINITION OF "WHAT IS A SEGMENT", shared by the sink, the reader and the pruner. That
 * sharing is the guarantee that retention can never delete a file the reader would have read, and
 * that the reader never tries to parse a file the sink did not write.
 *
 * | rotation | shardByPid | filename                          |
 * |----------|------------|-----------------------------------|
 * | daily    | false      | events-2026-10-02.jsonl           |
 * | daily    | true       | events-2026-10-02.p48213.jsonl    |
 * | none     | false      | events.jsonl                      |
 * | none     | true       | events.p48213.jsonl               |
 *
 * THE DATE IS UTC, AND THAT IS A PARTITION KEY, NOT A CALENDAR LABEL:
 *
 *  1. `telemetry.saltScope: 'team'` already anticipates a shared store. Under local time the same
 *     instant lands in different files for two developers, and a merged store cannot be pruned or
 *     reasoned about consistently.
 *  2. DST breaks monotonicity. Local time has a repeated hour and a missing one, so on a
 *     fall-back night a record written at 01:30 can be an hour AFTER another written at 01:30 and
 *     file boundaries stop being time-ordered. UTC has neither pathology.
 *  3. toISOString() is spec-pinned; toLocaleDateString depends on the ICU build, which differs
 *     between full-icu and small-icu Node builds and so between CI platforms.
 *
 * The cost is zero, because local-day PRESENTATION is recovered at read time: every record
 * carries `timestamp` plus `tz_offset_minutes`, so the dashboard buckets by local day from the
 * record rather than from the filename. Partition in UTC, present in local.
 */

import path from 'node:path'

export const SEGMENT_PREFIX = 'events'
export const SEGMENT_EXT = '.jsonl'

/** Anchored at both ends, so events.jsonl.gz, events.tmp and *.sqlite can never match. */
export const SEGMENT_RE = /^events(?:-(\d{4})-(\d{2})-(\d{2}))?(?:\.p(\d+))?\.jsonl$/

/** retentionDays is already >= 1 in SPEC; the floor makes "never prune today" structural. */
export const MIN_KEEP_DAYS = 1

/** 'YYYY-MM-DD' in UTC. */
export function utcDateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Shift a 'YYYY-MM-DD' key by whole days, still in UTC. */
export function shiftDateKey(key, days) {
  return utcDateKey(Date.parse(`${key}T00:00:00.000Z`) + days * 86_400_000)
}

export function segmentName({ rotation = 'daily', shardByPid = false, now = Date.now(), pid = 0 } = {}) {
  const datePart = rotation === 'daily' ? `-${utcDateKey(typeof now === 'function' ? now() : now)}` : ''
  const pidPart = shardByPid ? `.p${pid}` : ''
  return `${SEGMENT_PREFIX}${datePart}${pidPart}${SEGMENT_EXT}`
}

export function segmentPath({ dir, rotation = 'daily', shardByPid = false, now = Date.now(), pid = 0 }) {
  return path.join(dir, segmentName({ rotation, shardByPid, now, pid }))
}

/**
 * Parse a filename into {date, pid}, or null if it is not a segment.
 *
 * The date is re-serialized and compared, so `events-2026-02-31.jsonl` is rejected rather than
 * silently treated as 2026-03-03 — which matters because the pruner selects on this date.
 */
export function parseSegmentName(name) {
  const m = SEGMENT_RE.exec(name)
  if (!m) return null
  const [, y, mo, d, pid] = m
  let date = null
  if (y) {
    const key = `${y}-${mo}-${d}`
    const ms = Date.parse(`${key}T00:00:00.000Z`)
    if (!Number.isFinite(ms) || utcDateKey(ms) !== key) return null
    date = key
  }
  return { date, pid: pid === undefined ? null : Number(pid) }
}

export function isSegmentName(name) {
  return parseSegmentName(name) !== null
}

/**
 * Undated segments sort first, because flipping `rotation` from daily to none leaves a mixed-mode
 * directory that the reader must still handle. Beyond this, segment order is NOT a time order:
 * any consumer needing true chronology sorts by `record.timestamp`.
 */
export function compareSegments(a, b) {
  const da = a.date ?? '0000-00-00'
  const db = b.date ?? '0000-00-00'
  if (da !== db) return da < db ? -1 : 1
  return (a.pid ?? -1) - (b.pid ?? -1)
}

/**
 * List the segments in a directory, sorted.
 *
 * Skips, in order: dot-prefixed names (reserved — doctor.mjs already writes `.doctor-<pid>`
 * probes there, the salt lives at `.salt`, and the concurrency test's barrier is `.start`),
 * anything that is not a regular file, and anything SEGMENT_RE rejects.
 *
 * @returns {Array<{name: string, file: string, date: string|null, pid: number|null}>}
 */
export function listSegments({ dir, fs, from = null, to = null }) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    // A missing or unreadable store directory is an empty store, not an error. Nothing has been
    // written yet is the overwhelmingly common case.
    return []
  }

  const out = []
  for (const dirent of entries) {
    const name = dirent.name
    if (name.startsWith('.')) continue
    if (!dirent.isFile()) continue
    const parsed = parseSegmentName(name)
    if (!parsed) continue
    // An undated segment can hold a record from any day, so a date filter must never exclude it.
    if (parsed.date !== null) {
      if (from && parsed.date < from) continue
      if (to && parsed.date > to) continue
    }
    out.push({ name, file: path.join(dir, name), date: parsed.date, pid: parsed.pid })
  }
  return out.sort(compareSegments)
}

/**
 * Which segments are old enough to delete.
 *
 * SELECTION IS BY FILENAME DATE, NEVER BY mtime. A cloud-sync rehydrate, a restore, a git
 * checkout or an antivirus touch rewrites mtime, so mtime would delete the wrong files or refuse
 * to delete the right ones. The filename is immutable and auditable, and this function is
 * testable with a frozen clock and zero real files.
 *
 * Undated segments (`rotation: 'none'`) are never eligible — so retention is a COMPLETE NO-OP
 * under that rotation. That is a real trap, and doctor warns about exactly that combination.
 *
 * @returns {{cutoff: string, eligible: Array<object>, kept: Array<{name: string, reason: string}>}}
 */
export function selectForPrune({ segments = [], retentionDays = 90, now = Date.now() } = {}) {
  const days = Math.max(MIN_KEEP_DAYS, Number.isFinite(retentionDays) ? Math.floor(retentionDays) : MIN_KEEP_DAYS)
  const cutoff = shiftDateKey(utcDateKey(now), -days)
  const eligible = []
  const kept = []

  for (const seg of segments) {
    if (seg.date === null) {
      kept.push({ name: seg.name, reason: 'undated segment (rotation=none) is never pruned' })
      continue
    }
    if (seg.date < cutoff) eligible.push(seg)
    else kept.push({ name: seg.name, reason: `within retention (${seg.date} >= ${cutoff})` })
  }

  return { cutoff, eligible, kept }
}
