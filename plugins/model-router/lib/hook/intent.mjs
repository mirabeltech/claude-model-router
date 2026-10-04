/**
 * Recovering what the developer actually asked for, when they have opted in to that.
 *
 * WHY THIS MODULE EXISTS. A PreToolUse payload names the file and never the reason. That was
 * verified against the installed binary rather than taken from the published field list — see
 * docs/claude-code-hook-contract.md — and it is why the worker's default task is a frozen
 * "summarise this file" literal. A generic task is a fair request for a generic question, and a
 * poor one for "find every deprecated call and give me the line", which is the request a bulk
 * read usually serves.
 *
 * WHAT IS AVAILABLE, AND WHAT IS NOT. The payload carries `transcript_path`, and this hook
 * already opens that file on every invocation to measure `recentlyEdited`. The transcript holds
 * the prompt in STRUCTURED records — a `last-prompt` record Claude Code appends, and `user`
 * records tagged with `promptSource` — so this is a field read, not a heuristic scrape of prose.
 * Nothing else is taken: no assistant turns, no tool results, no system prompt, no earlier
 * conversation. One string, the newest one.
 *
 * WHY IT IS OFF BY DEFAULT. Reading it means the developer's own prompt text is sent to a worker
 * model that may be a third party. `hooks.taskIntent.source` defaults to `none`, and with `none`
 * this module returns null before touching a disk, so the request stays byte-identical to the one
 * the plugin has always sent. Opting in is a deliberate act, which is the only way a decision
 * about someone's data should be made.
 *
 * WHAT IT CANNOT DO. It cannot influence routing. `decide()` has already run by the time this is
 * called — see lib/hook/run.mjs, where the ordering is the enforcement and
 * test/evals.protected.test.mjs pins it. Intent reaches the task builder and nothing else, so no
 * prompt text can change whether a file is delegated, only what is asked about it.
 *
 * Like every module in this layer it NEVER THROWS: a transcript that is missing, truncated,
 * malformed, empty or written by a future version yields null and the generic task.
 */

import fsDefault from 'node:fs'

import { readTail, TRANSCRIPT_TAIL_BYTES } from './facts.mjs'

/** The record type Claude Code appends carrying the newest prompt verbatim. */
const LAST_PROMPT_RECORD = 'last-prompt'

/** Bounded, so a deeply nested content array cannot turn into a stack overflow. */
const MAX_BLOCKS = 64

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * The text of one transcript record, if that record is a human prompt.
 *
 * Two shapes are accepted and everything else is ignored:
 *
 *   1. `{type: 'last-prompt', lastPrompt}` — the dedicated record, preferred because it is the
 *      runtime's own answer to "what did they last ask" rather than our reconstruction of it.
 *   2. `{type: 'user', promptSource, message}` — the human turn. `promptSource` is what separates
 *      it from the `user` records that carry tool RESULTS, which also have `role: 'user'` and
 *      would otherwise feed a file's own contents back as the question.
 *
 * A sidechain record is skipped: that is a subagent's turn, and its prompt is not the developer's.
 */
function promptTextOf(record) {
  if (!isPlainObject(record)) return null
  if (record.isSidechain === true) return null

  if (record.type === LAST_PROMPT_RECORD) {
    return isNonEmptyString(record.lastPrompt) ? record.lastPrompt : null
  }

  if (record.type !== 'user') return null
  // A tool result is not a question. Both fields are checked because either one alone identifies
  // the record, and a future build dropping one should not silently reclassify the other.
  if (record.toolUseResult !== undefined || record.sourceToolAssistantUUID !== undefined) return null
  if (!isNonEmptyString(record.promptSource)) return null

  return messageText(record.message)
}

/** A message's text, from either the string form or the content-block array form. */
function messageText(message) {
  if (!isPlainObject(message)) return null
  const content = message.content
  if (isNonEmptyString(content)) return content
  if (!Array.isArray(content)) return null

  const parts = []
  for (const block of content.slice(0, MAX_BLOCKS)) {
    if (isPlainObject(block) && block.type === 'text' && isNonEmptyString(block.text)) {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * The newest human prompt in a session transcript, as a raw task-intent candidate.
 *
 * Walks the bounded tail BACKWARDS, because the newest prompt is the one that explains the read
 * happening now, and stopping at the first hit means a long transcript costs no more than a short
 * one. The first line of a tail is almost certainly cut in half by the byte boundary, so it is
 * dropped — a half line is not a record.
 *
 * @param {string|null} transcriptPath  from the hook payload
 * @param {object}      [a.fs]          injected, so a test drives this without a real transcript
 * @param {string}      [a.source]      the configured source; anything but 'transcript' is off
 * @param {number}      [a.maxChars]    ceiling on what may cross the boundary
 * @param {number}      [a.maxBytes]    ceiling on how much transcript is examined
 * @returns {{task: string, source: string}|null} a candidate for `normalizeTaskIntent`, or null
 */
export function extractTaskIntent(
  transcriptPath,
  { fs = fsDefault, source = 'none', maxChars = 600, maxBytes = TRANSCRIPT_TAIL_BYTES } = {},
) {
  try {
    // The off switch, checked before any I/O. With the default configuration this module costs
    // one comparison and never opens a file.
    if (source !== 'transcript') return null
    if (!isNonEmptyString(transcriptPath)) return null

    const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 0
    if (limit === 0) return null

    const tail = readTail(transcriptPath, maxBytes, fs)
    if (tail === '') return null

    /**
     * Whether the first line is a fragment, decided rather than assumed.
     *
     * `recentlyEdited` drops line 0 unconditionally, and for its purpose that is nearly free: it
     * scans a long session for an edit and a transcript short enough to fit entirely in the
     * window is not the case it was written for. Here it would be a real bug. The most common
     * transcript this reads is a SHORT one — a developer's first question in a fresh session is
     * exactly when the file holds one or two records — and dropping line 0 there would discard
     * the only prompt present and silently fall back to the generic task.
     *
     * So the file is measured. The first line is a fragment only if the read actually started
     * past byte zero.
     */
    let truncated = true
    try {
      truncated = fs.statSync(transcriptPath).size > maxBytes
    } catch {
      // Unmeasurable: assume the pessimistic case and skip the first line. A fragment parsed as a
      // record is the failure worth avoiding.
    }
    const floor = truncated ? 1 : 0

    const lines = tail.split('\n')
    for (let i = lines.length - 1; i >= floor; i -= 1) {
      const line = lines[i]
      if (line.trim() === '') continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const text = promptTextOf(parsed)
      if (text === null) continue

      const trimmed = text.trim()
      return {
        task: trimmed.length > limit ? trimmed.slice(0, limit) : trimmed,
        source: 'transcript',
      }
    }
    return null
  } catch {
    // Unreadable, unparseable, a permission error, a surprise from a future transcript format —
    // all of it means the same thing to the caller: no intent, so send the generic task.
    return null
  }
}
