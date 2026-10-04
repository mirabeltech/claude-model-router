/**
 * The measurement layer: the only place in the plugin that touches a disk on the hot path.
 *
 * Every function here answers one question about the world and NEVER THROWS. Each returns either
 * a measurement or the pessimistic value, because this runs while a developer waits on a tool
 * call and an exception would break their session rather than merely fail to optimise it.
 *
 * It imports `node:fs` and nothing else from the runtime. There is no `child_process`, no shell,
 * no network and no path resolution beyond the two paths the payload named — a static test
 * asserts the import list, because a purity rule that is only a comment gets broken by a
 * well-meaning import six months later.
 */

import fsDefault from 'node:fs'

import { normalizeSlashes } from '../globs.mjs'
import { resolveWorker } from '../dispatch/index.mjs'
import { billingFor, isKnownProvider, readinessFor, wantsKey } from '../providers/index.mjs'

/**
 * How much of the transcript's tail is examined for a recent edit.
 *
 * A session transcript grows without bound, and reading all of it on every Read would make the
 * gate's cost a function of session length. 256 KiB covers far more than the handful of turns in
 * which "recently edited" means anything, and the cost is one bounded read plus — only when the
 * filename actually occurs — a parse of those lines.
 */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/** The tools whose use means Claude changed this file and now needs its exact current bytes. */
export const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Bounded, so a pathologically nested transcript line cannot turn into a stack overflow. */
const MAX_WALK_DEPTH = 8

/* -------------------------------------------------------------- file size */

/**
 * The file's size in bytes, from metadata alone — no content is read.
 *
 * This is the only size proxy the gate gets, which is why `statSync` is worth its syscall: it is
 * the difference between a hook that can answer the size question and one that cannot.
 *
 * Anything that is not a regular file is `null` rather than a number. A directory has a size, and
 * it is not a size that means what `inputBytes` means.
 *
 * @returns {number|null} null for a missing file, a directory, a permission error — anything
 */
export function fileBytes(filePath, { fs = fsDefault } = {}) {
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) return null
    return Number.isInteger(st.size) && st.size >= 0 ? st.size : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------- recently edited */

/** Does `value` name the same file as `target`? Both are already normalized. */
function samePath(value, target) {
  if (value === '' || target === '') return false
  if (value === target) return true
  // One side may be relative where the other is absolute. Over-matching here resolves toward
  // `true`, which refuses to delegate — the safe direction for this particular question.
  return value.endsWith(`/${target}`) || target.endsWith(`/${value}`)
}

/** Find a tool_use of an editing tool naming this path, anywhere in a parsed transcript line. */
function mentionsEditOf(node, target, depth = 0) {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return false

  if (Array.isArray(node)) {
    for (const item of node) if (mentionsEditOf(item, target, depth + 1)) return true
    return false
  }

  if (node.type === 'tool_use' && EDIT_TOOLS.includes(node.name)) {
    const edited = node.input?.file_path ?? node.input?.notebook_path ?? null
    if (typeof edited === 'string' && samePath(normalizeSlashes(edited), target)) return true
  }

  for (const key of Object.keys(node)) {
    if (mentionsEditOf(node[key], target, depth + 1)) return true
  }
  return false
}

/** Read at most the last `maxBytes` of a file, without loading the whole thing. */
export function readTail(file, maxBytes, fs) {
  let fd
  try {
    const size = fs.statSync(file).size
    const length = Math.min(size, maxBytes)
    if (length <= 0) return ''
    const buf = Buffer.allocUnsafe(length)
    fd = fs.openSync(file, 'r')
    const read = fs.readSync(fd, buf, 0, length, size - length)
    return buf.subarray(0, read).toString('utf8')
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* a leaked descriptor in a one-shot process is not worth a thrown hook */
      }
    }
  }
}

/**
 * Did Claude edit this file earlier in this session?
 *
 * `routing.neverDelegate.onRecentlyEdited` is a real safety control — a file Claude just changed
 * is one where it needs the exact current bytes, not a summary of them — and
 * docs/what-we-do-not-delegate.md advertises it as enforced. So it is MEASURED here rather than
 * asserted, which is the one place this hook spends hot-path I/O on a safety rule.
 *
 * The cheap path is the common one: read a bounded tail, then look for the file's own name in it
 * as a plain substring. If the name does not occur, no line is parsed at all.
 *
 * **Unmeasurable is `true`.** A missing `transcript_path`, an unreadable file, a parse failure —
 * all of them refuse to delegate. The consequence worth knowing is that the refusal is reported
 * as `recently_edited`, which is the gate's only vocabulary for this field: the routing contract
 * reads unknown as `true` and names the rule that fired, not the reason the fact was missing.
 *
 * @returns {boolean} true when it was edited OR could not be determined
 */
export function recentlyEdited(transcriptPath, filePath, { fs = fsDefault, maxBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  try {
    if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') return true
    if (typeof filePath !== 'string' || filePath.trim() === '') return true

    const target = normalizeSlashes(filePath)
    if (target === '') return true

    const tail = readTail(transcriptPath, maxBytes, fs)
    if (tail === '') return false

    // The basename is the discriminating part and the cheapest thing to search for. A transcript
    // that never mentions this filename cannot contain an edit of it, whatever the nesting.
    const basename = target.slice(target.lastIndexOf('/') + 1)
    if (basename === '' || tail.toLowerCase().indexOf(basename) === -1) return false

    const lines = tail.split('\n')
    // The first line is almost certainly cut in half by the tail boundary; dropping it is correct
    // rather than merely convenient, because a half line is not a record.
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (mentionsEditOf(parsed, target)) return true
    }
    return false
  } catch {
    return true
  }
}

/* --------------------------------------------------------- worker readiness */

/**
 * Can the bulk-read lane's worker run, decided WITHOUT a network call and without loading a
 * provider module?
 *
 * `readinessFor()` and `requiresEnvFor()` both answer from the registry's static table, which is
 * why the registry has one: the gate must not pay to parse a provider it may well not call, and
 * it must certainly not open a socket to find out whether it could open a socket.
 *
 * The `wantsKey` guard is now a SHARED export from the provider registry rather than a third
 * copy of the same predicate: `dispatch()` and `scripts/doctor.mjs` call the same function.
 * Without it, switching `worker.provider` to a local Ollama while leaving `worker.apiKeyEnv` at
 * its Gemini default would report a running daemon as unavailable for want of a key it does not
 * need.
 *
 * `budget_exceeded` is STILL never returned, and phase 9 did not change that — it is a decision
 * rather than an oversight. Budget enforcement now exists, but it runs AFTER `decide()` has
 * ruled, in `lib/governance/`, and not through this function. Feeding a budget verdict into the
 * gate as `workerAvailable: false` would make governance rewrite the routing classification, and
 * it would destroy the diagnostic: the row would record that the budget was spent without ever
 * recording whether the read was delegate-worthy in the first place. Routing answers one
 * question, governance answers another, and this is the seam that keeps them apart.
 *
 * `billing` is carried because governance needs exactly one fact about the provider — whether a
 * monetary budget can be consumed by it — and must obtain it without loading a provider module.
 *
 * @returns {{workerAvailable: boolean, workerUnavailableReason: string|null,
 *            provider: string|null, model: string|null, billing: string|null}}
 */
export function workerAvailability(config, env = process.env) {
  const unavailable = (provider = null, model = null) => ({
    workerAvailable: false,
    workerUnavailableReason: 'worker_not_ready',
    provider,
    model,
    billing: provider === null ? null : billingFor(provider),
  })

  try {
    const resolved = resolveWorker(config, 'bulkRead')
    if (!isKnownProvider(resolved.provider)) return unavailable(null, null)

    const readiness = readinessFor(resolved.provider, env, {
      apiKeyEnv: wantsKey(resolved.provider) ? (resolved.apiKeyEnv ?? undefined) : undefined,
    })

    if (readiness.ready !== true) return unavailable(resolved.provider, resolved.model)
    return {
      workerAvailable: true,
      workerUnavailableReason: null,
      provider: resolved.provider,
      model: resolved.model,
      billing: billingFor(resolved.provider),
    }
  } catch {
    return unavailable()
  }
}

/* ------------------------------------------------------------ file content */

/**
 * Read the file the gate has already approved, exactly once.
 *
 * Called only AFTER `decide()` has said to delegate, which is what keeps the promise that no file
 * is loaded in order to decide whether loading it was worth avoiding. The gate has also already
 * refused anything over `worker.maxInputBytes`, so the size read here is bounded by a configured
 * ceiling rather than by hope.
 *
 * A NUL byte means this is not text. `Buffer#toString('utf8')` would hand the worker a prompt full
 * of replacement characters and bill for it, so a binary file falls open to the real Read instead
 * — which is also the only thing that can render it correctly.
 *
 * @returns {{ok: true, content: string} | {ok: false, reason: string}}
 */
export function readTextContent(filePath, { fs = fsDefault } = {}) {
  let content
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (typeof content !== 'string') return { ok: false, reason: 'unreadable' }
  if (content.includes('\u0000')) return { ok: false, reason: 'binary' }
  return { ok: true, content }
}
