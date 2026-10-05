/**
 * What was still live when the hook exited. OPT-IN, and off unless an operator names a file.
 *
 * WHY THIS EXISTS. The hook was observed exiting 0xC0000409 with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file async.c, line 94` on stderr after a
 * real Gemini call, violating a contract that has no exceptions. It has since been REPRODUCED and
 * FIXED — `docs/failure-modes.md` holds the repro table and the fix — so this module is no longer
 * the thing standing between the project and a mystery. Two jobs remain for it.
 *
 * ONE: the exact libuv mechanism is still unproven. That assertion is the guard inside
 * `uv_async_send`, the cross-thread wakeup, which an on-loop socket teardown cannot reach — and the
 * repro confirmed it, because closing undici's global dispatcher before exiting still crashed 5
 * times out of 5. The remaining suspect is threadpool work that cannot be cancelled once started:
 * a DNS resolution, or an async zlib inflate of a compressed response. Neither exists on the
 * loopback path, which is the only structural difference between the providers. `activeResources`
 * is what would settle it.
 *
 * TWO: evidence for the next sighting, of this or anything like it. The fix is a drain plus an
 * unref'd backstop, and if a future handle ever holds the loop open long enough for that backstop
 * to fire, this says which handle.
 *
 * NOTHING IN-PROCESS CAN OBSERVE ITS OWN ABORT. This captures the last observable instant instead,
 * and its whole value is as a DIFF: a line from a bad run against lines from clean runs on both
 * providers. A single capture cannot distinguish "DNS was in flight" from "DNS is always in flight
 * on this path", so `scripts/smoke-hook.mjs` captures one on every run, passing or not.
 *
 * IT IS NOT THE TELEMETRY STORE, and that is not a filing preference. A line with no
 * `schema_version` is counted by `aggregate()` as `rowsIncompatible` and dropped from every total,
 * which would corrupt the coverage denominators of the one subsystem whose job is not overstating a
 * number. The store also caps a line at 64 KiB under a fixed field order, already holds this very
 * hook's row, is opt-outable by a kill switch this must outlive, and is swept by retention — which
 * would eventually delete the evidence.
 *
 * TOTAL BY CONSTRUCTION. Every path returns; nothing throws; an unset, empty, or unopenable target
 * does nothing at all. CLAUDE.md's third non-negotiable is that telemetry can never break a hook,
 * and a diagnostic that can break a hook is strictly worse than no diagnostic.
 */

import fs from 'node:fs'

import { redactSecrets } from '../redact.mjs'

/**
 * The libuv handle fields worth keeping, and the ones that must not be kept.
 *
 * `process.report.getReport()` MUST NEVER BE SERIALIZED WHOLE: it carries
 * `environmentVariables` — the developer's entire environment, API keys included — along with the
 * command line, the cwd and the loaded shared objects. Only `.libuv` is read, and only these three
 * fields of each handle. The pointer `address` and `fd` are noise, and `remoteEndpoint` is the
 * provider's IP; dropping all three is also what makes a Gemini line and an Ollama line diffable,
 * which is the comparison the hypothesis needs.
 */
const HANDLE_FIELDS = Object.freeze(['type', 'is_active', 'is_referenced'])

/** A count per handle type, which is the shape a diff reads most easily. */
function countByType(handles) {
  const counts = {}
  for (const h of handles) {
    const type = typeof h?.type === 'string' ? h.type : 'unknown'
    counts[type] = Object.hasOwn(counts, type) ? counts[type] + 1 : 1
  }
  return counts
}

function projectLibuv() {
  if (typeof process.report?.getReport !== 'function') return null
  const handles = process.report.getReport().libuv
  if (!Array.isArray(handles)) return null

  const projected = handles.map((h) => {
    const out = {}
    for (const f of HANDLE_FIELDS) out[f] = h?.[f] ?? null
    return out
  })
  return { counts: countByType(projected), handles: projected }
}

/**
 * Append one line describing what was still live. Returns true only if a line was written.
 *
 * @param {string|undefined|null} target absolute path to append to; anything falsy is a no-op
 * @param {{wroteResponse: boolean}} context the one fact only the entry point knows
 */
export function writeExitDiagnostic(target, { wroteResponse } = {}) {
  if (typeof target !== 'string' || target.trim() === '') return false

  let fd = null
  try {
    const line = {
      at: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      // Did the abort risk truncating a response Claude Code was waiting on? The first question a
      // reader of this file will ask, and the only one the engine cannot answer for itself.
      wroteResponse: wroteResponse === true,
      // The load-bearing field. `GetAddrInfoReqWrap` or `DNSChannel` present on the hosted path and
      // absent on the loopback path confirms the DNS branch; `Zlib` confirms the inflate branch;
      // neither present on a crashing run refutes both and narrows to libuv-internal work with no
      // JS-side wrapper.
      activeResources:
        typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : null,
      libuv: projectLibuv(),
    }

    // Through the shipped redactor, like every other diagnostic string in this repo: a record of a
    // leak must not become the leak.
    const buf = Buffer.from(`${redactSecrets(JSON.stringify(line))}\n`, 'utf8')

    // One openSync, ONE writeSync of one Buffer ending in \n, one closeSync — the same discipline
    // telemetry/jsonl.mjs uses, and for the same reason: two syscalls per record is what makes
    // concurrent appends interleave. A short write is accepted as a truncated line and never
    // repaired, because the repair is the second syscall.
    fd = fs.openSync(target, 'a')
    fs.writeSync(fd, buf)
    return true
  } catch {
    // There is nobody safe to report this to. stdout is a protocol channel and stderr is the thing
    // being investigated.
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing left to do about a descriptor the OS is about to reclaim anyway.
      }
    }
  }
}
