/**
 * The JSONL repository: an append-only local log that is both the write sink and the read store.
 *
 * THE WRITE INVARIANT, from which everything else follows:
 *
 *     ONE RECORD = ONE fs.writeSync OF ONE BUFFER ENDING IN "\n".
 *
 * Never two syscalls per record. That is what makes a concurrent append safe: POSIX requires
 * write() to an O_APPEND fd on a regular local file to be atomic with respect to other writers
 * (the kernel takes the inode lock and resolves the offset to EOF inside the call). Two writes
 * per record would expose a window in which another process can land between them, and the file
 * would contain a spliced line that either fails to parse or — worse — parses into a record
 * that is a blend of two events.
 *
 * Confidence in that claim, stated honestly because the design rests on it:
 *
 *   HIGH    POSIX (Linux, macOS), local filesystems. Specified behaviour, not folklore. The
 *           widely-repeated "atomic only up to PIPE_BUF (4 KiB)" limit applies to PIPES, not to
 *           regular files, so there is no small-write ceiling to design around.
 *   MEDIUM  Windows NTFS. libuv maps O_APPEND to FILE_APPEND_DATA, a write through such a handle
 *           goes to the current end of file, and every Windows log appender relies on it — but
 *           Microsoft publishes no cross-process atomicity guarantee the way POSIX does. So it is
 *           empirically true and contractually unspecified, which is exactly why windows-latest
 *           is a GATING CI platform and why test/telemetry.concurrency.test.mjs exists. That test
 *           is the evidence for a claim no specification will give us.
 *   UNSAFE  NFS (open(2) says O_APPEND "may lead to corrupted files"), SMB and mapped drives,
 *           cloud-synced folders (a sync agent may copy-and-replace the file under an open
 *           handle), FUSE and overlay filesystems. For these, `telemetry.shardByPid: true`
 *           removes the requirement by construction: each writer owns a private file, so
 *           cross-writer atomicity is never needed. doctor.mjs detects such paths and recommends
 *           it. This sink deliberately does NOT auto-flip the flag — silently changing the file
 *           layout would change what the reader finds and what the pruner matches, and make
 *           describe() disagree with the resolved config.
 */

import fsDefault from 'node:fs'
import {
  READ_MAX_LINE_BYTES,
  RECORD_MAX_BYTES,
  emptyReadReport,
  serializeRecord,
} from './contract.mjs'
import { redactSecrets } from '../redact.mjs'
import { listSegments, segmentPath, selectForPrune, utcDateKey } from './segments.mjs'

export const id = 'jsonl'

export const capabilities = Object.freeze({
  synchronousWrite: true,
  // The bytes reach the kernel inside append(); no flush step is required for a reader on the
  // same machine to see them. Durability against a MACHINE crash is deliberately traded away —
  // see the fsync note in append() below.
  durableOnAppend: true,
  supportsConcurrentWriters: true,
  // A JSONL log cannot GROUP BY. `npm run ingest` materialises a query store from it later.
  requiresIngest: true,
  recordCapBytes: RECORD_MAX_BYTES,
})

export const storeCapabilities = Object.freeze({
  sink: true,
  streaming: true,
  aggregatesInStore: false,
  supportsPrune: true,
  supportsIngest: false,
})

const READ_CHUNK_BYTES = 65_536
const MAX_SAMPLES = 5

/* --------------------------------------------------------------------- sink */

/**
 * Open a write handle. SYNCHRONOUS, never throws, and performs NO I/O: a session with telemetry
 * enabled that never delegates must not create a directory, and the gate's hot path must not pay
 * for a mkdir it will not use. The directory and file are created on the first append().
 *
 * @returns {import('./contract.mjs').SinkHandle}
 */
export function openSink({
  dir,
  rotation = 'daily',
  shardByPid = false,
  now = Date.now,
  pid = process.pid,
  fs = fsDefault,
  recordCapBytes = RECORD_MAX_BYTES,
  warnings = [],
} = {}) {
  const clock = typeof now === 'function' ? now : () => now

  let fd = null
  let openPath = null
  let disabled = false
  const counters = { appended: 0, bytes: 0, truncated: 0, dropped: 0, errors: 0, lastError: null }

  const fail = (reason) => {
    counters.errors += 1
    counters.lastError = reason
    return { ok: false, bytes: 0, target: openPath, truncation: null, reason }
  }

  const closeFd = () => {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* a failed close cannot be acted on */
      }
      fd = null
    }
  }

  /**
   * Ensure an fd for the CURRENT segment.
   *
   * The expected path is recomputed from the clock on every append — a string build and compare,
   * nanoseconds. Without it a long-lived process (an ingest run, a delegation loop, the
   * behavioural runner) that stays alive across UTC midnight under `rotation: daily` writes all
   * of tomorrow's events into yesterday's file. That is a real, silent bug.
   */
  const ensureFd = () => {
    const want = segmentPath({ dir, rotation, shardByPid, now: clock(), pid })
    if (fd !== null && openPath === want) return true
    if (fd !== null) closeFd()

    try {
      // recursive:true is idempotent, so there is no stat-then-mkdir TOCTOU race and no second
      // syscall on the common path where the directory already exists.
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        // A read-only or unreachable store must not cost a failed mkdir on every single record
        // for the rest of the process's life.
        disabled = true
        return false
      }
    }

    try {
      // 'a' is O_APPEND | O_CREAT | O_WRONLY. The append flag is what makes the write atomic.
      fd = fs.openSync(want, 'a')
      openPath = want
      return true
    } catch {
      disabled = true
      return false
    }
  }

  const writeOnce = (buf) => {
    // No `position` argument, ever. fs.writeSync defaults position to null, meaning "current
    // position", which O_APPEND resolves to EOF inside the kernel. Passing an explicit position
    // defeats append semantics and reintroduces the interleaving this design exists to prevent.
    const written = fs.writeSync(fd, buf)
    // fs.writeSync does NOT loop on a short write. A short write would split one record across
    // two writes, so it is counted rather than silently retried — a partial line is already on
    // disk and the reader's malformed-line tolerance is the backstop.
    if (written !== buf.length) throw Object.assign(new Error('short write'), { code: 'ESHORTWRITE' })
    return written
  }

  const append = (record) => {
    try {
      if (disabled) return fail('sink_disabled')

      const { line, bytes, truncation, problems } = serializeRecord(record, { recordCapBytes })
      if (line === null) {
        counters.dropped += 1
        return fail(problems.length > 0 ? problems[0] : 'serialize_failed')
      }
      if (truncation !== null) counters.truncated += 1

      if (!ensureFd()) return fail('open_failed')

      try {
        writeOnce(line)
      } catch (err) {
        // EBADF: the fd was closed under us. ENOENT: the file was unlinked by a pruner or a sync
        // agent. Exactly one retry with a fresh open — bounded, so "cheap and never throws" holds.
        if (err?.code === 'EBADF' || err?.code === 'ENOENT') {
          closeFd()
          openPath = null
          if (!ensureFd()) return fail('reopen_failed')
          writeOnce(line)
        } else {
          throw err
        }
      }

      // No fsyncSync. A per-record fsync costs milliseconds on every hook, and the page cache
      // already makes the bytes visible to every reader on this machine immediately. A
      // kernel-level crash can lose the tail of the file; that is the right trade for telemetry
      // and the wrong one to make silently, so it is documented here and in the schema doc.

      counters.appended += 1
      counters.bytes += line.length
      return { ok: true, bytes: line.length, target: openPath, truncation, reason: null }
    } catch (err) {
      // The outermost guard. Telemetry can never throw into the routing path, so every failure
      // becomes a returned result and a counter.
      return fail(err?.code ?? err?.message ?? 'append_failed')
    }
  }

  return {
    id,
    capabilities,
    warnings,
    append,
    /** No-op: append() has already handed the bytes to the kernel. */
    flush: () => ({ ok: true, bytes: 0, target: openPath, truncation: null, reason: null }),
    close: closeFd,
    describe: () => ({
      sink: id,
      dir,
      rotation,
      shardByPid,
      target: openPath ?? segmentPath({ dir, rotation, shardByPid, now: clock(), pid }),
      recordCapBytes,
      disabled,
    }),
    counters: () => ({ ...counters }),
  }
}

/* -------------------------------------------------------------------- reader */

/**
 * Iterate the records in one segment file.
 *
 * A SYNC generator over fs.readSync with a carry buffer. The async store.read() wraps this and
 * readSegmentSync() reuses it, so the two faces of the reader cannot diverge — and it sidesteps
 * createReadStream's error and backpressure edge cases entirely, with zero dependencies.
 *
 * Never throws. Every anomaly is counted on `report` and the iteration continues.
 */
export function* iterRecords(file, { fs = fsDefault, report = emptyReadReport() } = {}) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
  } catch (err) {
    // A file pruned or locked mid-read is data about the store, not an exception for the caller.
    report.errors.push({ file, code: err?.code ?? 'EOPEN' })
    return
  }

  report.files += 1
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  let carry = Buffer.alloc(0)
  let offset = 0
  let lineNo = 0
  let first = true
  let resyncing = false

  const sample = (reason, raw) => {
    if (report.samples.length >= MAX_SAMPLES) return
    report.samples.push({
      file,
      lineNo,
      byteOffset: offset,
      reason,
      excerpt: redactSecrets(raw.slice(0, 120)),
    })
  }

  /** Returns the record to yield, or undefined. `tail` marks the unterminated final piece. */
  const handle = (buf, tail) => {
    lineNo += 1
    report.lines += 1

    // Length is checked HERE as well as on the carry buffer, because the carry check alone only
    // fires when a line never completes inside the read window — so whether an over-long line
    // was caught would otherwise depend on chunk alignment. The writer caps a record at 64 KiB,
    // so a line past this bound is corruption or foreign data, and handing a megabyte of it to
    // JSON.parse for every such line is work the reader should refuse.
    if (buf.length > READ_MAX_LINE_BYTES) {
      report.skipped.oversize_line += 1
      sample('oversize_line', buf.toString('utf8', 0, 120))
      return undefined
    }

    // Split on \n only, then strip EXACTLY ONE trailing \r. Not a loop: "\r\r\n" means the data
    // itself ended with a \r, which is content, not a line ending.
    let end = buf.length
    if (end > 0 && buf[end - 1] === 0x0d) end -= 1
    const raw = buf.toString('utf8', 0, end)

    if (raw.trim() === '') {
      // A trailing newline at EOF always yields one empty final piece. That must be free, and it
      // must not be reported as malformed, or every healthy file would look damaged.
      report.skipped.blank += 1
      return undefined
    }
    if (raw.startsWith('#')) {
      report.skipped.comment += 1
      return undefined
    }

    let obj
    try {
      obj = JSON.parse(raw)
    } catch {
      if (tail) {
        // THE MOST VALUABLE DISTINCTION THIS READER MAKES. An unparseable TAIL is expected and
        // benign: a writer is mid-flight, or was killed. An unparseable line in the MIDDLE of a
        // file is evidence that append atomicity failed on this machine — precisely the claim no
        // specification gives us on Windows or on a network volume. doctor surfaces the counter.
        report.skipped.truncated_tail += 1
      } else {
        report.skipped.malformed += 1
        sample('malformed', raw)
      }
      return undefined
    }

    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      report.skipped.not_an_object += 1
      sample('not_an_object', raw)
      return undefined
    }
    if (typeof obj.schema_version !== 'number') {
      // A consumer computing money off a shapeless object is worse than a gap in the data.
      report.skipped.unrecognized += 1
      sample('unrecognized', raw)
      return undefined
    }

    // A record with a NEWER schema_version IS yielded. Forward compatibility is the aggregation
    // layer's filter, not the reader's — the reader stays dumb. Unknown enum values are likewise
    // preserved verbatim and never validated here.
    if (tail) report.skipped.unterminated_tail_parsed += 1
    report.yielded += 1
    return obj
  }

  try {
    for (;;) {
      let read
      try {
        read = fs.readSync(fd, chunk, 0, READ_CHUNK_BYTES, null)
      } catch (err) {
        report.errors.push({ file, code: err?.code ?? 'EREAD' })
        break
      }
      if (read === 0) break
      report.bytes += read

      let piece = chunk.subarray(0, read)
      if (first) {
        first = false
        // Strip a UTF-8 BOM, but only as the first three bytes of the file. This is a live
        // hazard rather than a theoretical one: PowerShell 5.1's `>` and Out-File write UTF-8
        // WITH a BOM, so any user who edits or regenerates a segment there produces one.
        if (piece.length >= 3 && piece[0] === 0xef && piece[1] === 0xbb && piece[2] === 0xbf) {
          piece = piece.subarray(3)
          offset += 3
        }
      }
      carry = carry.length === 0 ? Buffer.from(piece) : Buffer.concat([carry, piece])

      for (;;) {
        const nl = carry.indexOf(0x0a)
        if (nl === -1) break
        const lineBuf = carry.subarray(0, nl)
        carry = carry.subarray(nl + 1)
        if (resyncing) {
          // Discard the remainder of an oversize line and pick up at the next record boundary.
          resyncing = false
          offset += lineBuf.length + 1
          continue
        }
        const rec = handle(lineBuf, false)
        offset += lineBuf.length + 1
        if (rec !== undefined) yield rec
      }

      if (carry.length > READ_MAX_LINE_BYTES) {
        // Without this, a corrupt file containing no newline at all would grow the carry buffer
        // to the size of the whole file.
        report.skipped.oversize_line += 1
        report.lines += 1
        sample('oversize_line', carry.toString('utf8', 0, 120))
        offset += carry.length
        carry = Buffer.alloc(0)
        resyncing = true
      }
    }

    if (carry.length > 0 && !resyncing) {
      const rec = handle(carry, true)
      if (rec !== undefined) yield rec
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* nothing useful to do */
    }
  }
}

/** Read every segment in a directory synchronously. Used by tests, ingest and doctor. */
export function readSegmentsSync({ dir, fs = fsDefault, from = null, to = null } = {}) {
  const report = emptyReadReport()
  const records = []
  for (const seg of listSegments({ dir, fs, from, to })) {
    for (const rec of iterRecords(seg.file, { fs, report })) records.push(rec)
  }
  return { records, report }
}

/* -------------------------------------------------------------------- store */

/**
 * Open a read handle. Async by signature so a future Postgres or ClickHouse store satisfies the
 * same interface; JSONL fulfils it with synchronous fs calls inside async methods.
 */
export async function openStore({ dir, fs = fsDefault } = {}) {
  let report = emptyReadReport()

  return {
    id,
    storeCapabilities,

    async segments({ from = null, to = null } = {}) {
      return listSegments({ dir, fs, from, to })
    },

    /** An async iterable of records. Never throws; anomalies land on report(). */
    async *read({ from = null, to = null } = {}) {
      report = emptyReadReport()
      for (const seg of listSegments({ dir, fs, from, to })) {
        for (const rec of iterRecords(seg.file, { fs, report })) yield rec
      }
    },

    /** A snapshot of the last read: counts, five redacted samples, per-file errors. */
    report: () => JSON.parse(JSON.stringify(report)),

    async prune({ retentionDays = 90, now = Date.now(), dryRun = false } = {}) {
      return pruneSegments({ dir, retentionDays, now, dryRun, fs })
    },

    async close() {
      /* nothing is held open between calls */
    },
  }
}

/* ------------------------------------------------------------------ retention */

/**
 * Delete segments older than the retention window.
 *
 * Never called from the write path: a readdir + stat sweep per hook is unacceptable on the hot
 * path, and unlinking files from a hook while another process reads them is a surprise nobody
 * asked for. Pruning is ADVISORY — a failure is recorded and never propagated.
 */
export function pruneSegments({ dir, retentionDays = 90, now = Date.now(), dryRun = false, fs = fsDefault } = {}) {
  const segments = listSegments({ dir, fs })
  const { cutoff, eligible, kept } = selectForPrune({ segments, retentionDays, now })
  const deleted = []
  const errors = []
  let bytesFreed = 0

  for (const seg of eligible) {
    try {
      const size = fs.statSync(seg.file).size
      if (!dryRun) fs.unlinkSync(seg.file)
      deleted.push(seg.name)
      bytesFreed += size
    } catch (err) {
      // EBUSY/EPERM on Windows means the dashboard has the file open. Carry on with the rest.
      errors.push({ name: seg.name, code: err?.code ?? 'EUNLINK' })
    }
  }

  return { examined: segments.length, cutoff, today: utcDateKey(now), eligible: eligible.map((s) => s.name), deleted, kept, bytesFreed, errors, dryRun }
}
