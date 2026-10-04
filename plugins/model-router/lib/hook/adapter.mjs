/**
 * The pure half of the Claude Code integration: payload in, routing input out, response out.
 *
 * This module imports NOTHING — not a `node:` builtin, not another lib module — so the protocol
 * translation can be tested against hostile input without a filesystem, a config or a clock. It
 * knows two vocabularies and translates between them. It decides nothing, reads nothing and
 * executes nothing.
 *
 * The Claude Code side of the contract was read out of the installed binary rather than inferred
 * from the published docs, which are wrong about `additionalContext`. See
 * docs/claude-code-hook-contract.md for the extraction and the exact version it was taken from.
 */

/** The one event this plugin registers, and the literal the response must echo back. */
export const HOOK_EVENT = 'PreToolUse'

/** The one tool it intercepts. Bash is deliberately absent — see docs/hook-integration.md. */
export const INTERCEPTED_TOOL = 'Read'

/** The version of the task text below, stamped so a stored row names the request it made. */
export const TASK_VERSION = 1

/**
 * The task handed to the worker when nothing is known about why the file is wanted.
 *
 * A PreToolUse payload says WHICH file Claude wants and never WHY — verified against the installed
 * binary, not inferred; see docs/claude-code-hook-contract.md. So unless the developer has opted
 * in to `hooks.taskIntent.source: 'transcript'`, there is no question to forward and this is what
 * the worker is asked. It remains the default, because recovering the question means sending the
 * developer's own prompt text to a third-party worker.
 *
 * It is a fixed literal for the same reason `modes.mjs` versions its prompts: a request that
 * cannot be reproduced cannot be compared across a threshold change. Built by join rather than as
 * a multi-line template literal because `core.autocrlf` is on and there is no `.gitattributes`,
 * so a literal would hold CRLF in a Windows checkout and LF in a Linux one, and CI gates on both.
 */
export const BULK_READ_TASK = [
  'Summarise this file for an engineer who has not seen it.',
  'Cover its purpose, its structure, and every significant declaration with the line it is on.',
  'Preserve identifiers, signatures and string literals exactly as written; never paraphrase a name.',
  'State what the file does not do where that is load-bearing.',
].join(' ')

/* ------------------------------------------------------------- the task intent */

/** The source labels this adapter can produce. `other` is the telemetry layer's read-side bucket. */
export const TASK_INTENT_SOURCE = Object.freeze({ none: 'none', transcript: 'transcript' })

/** The fields a task intent may carry. Everything is nullable; nothing is ever inferred. */
export const TASK_INTENT_FIELDS = Object.freeze([
  'task',
  'objective',
  'requestedInformation',
  'constraints',
  'outputFormat',
])

/**
 * Coerce whatever was recovered into the task-intent contract, or `null`.
 *
 * UNKNOWN STAYS NULL. This function narrows and discards; it never fills a field in. In this
 * release only `task` can be populated, because the one thing available is a prompt string, and
 * `objective`, `requestedInformation`, `constraints` and `outputFormat` have no honest source —
 * deriving them would mean guessing at structure the developer did not write. They are in the
 * contract so a caller that genuinely knows them (a skill, a test, an eval case) can say so, and
 * so the worker templates have something stable to render.
 *
 * Returns `null` rather than an all-null object when there is nothing to say, so "no intent" has
 * exactly one representation and the builder below it cannot accidentally emit an empty section.
 *
 * @param {object|null} raw
 * @returns {object|null} a frozen intent, or null
 */
export function normalizeTaskIntent(raw) {
  if (!isPlainObject(raw)) return null

  const out = {}
  let any = false
  for (const field of TASK_INTENT_FIELDS) {
    const value = raw[field]
    if (isNonEmptyString(value)) {
      out[field] = value.trim()
      any = true
    } else {
      out[field] = null
    }
  }
  if (!any) return null

  // A source that was not supplied is not assumed. `none` would claim the generic task produced
  // this intent, which is a contradiction, so an unrecognised label becomes null and the caller's
  // own telemetry mapping decides what to record.
  out.source =
    raw.source === TASK_INTENT_SOURCE.transcript || raw.source === TASK_INTENT_SOURCE.none
      ? raw.source
      : null

  return Object.freeze(out)
}

/* ------------------------------------------------------------------ parsing */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * Parse and validate one hook invocation's stdin.
 *
 * Returns a REASON rather than throwing, because every rejection here ends the same way — the
 * original Read proceeds — and the reason is only ever used for a test name and a doctor line.
 *
 * @param {string} raw  the bytes read from stdin
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 */
export function parseHookPayload(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'empty_stdin' }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'unparseable_stdin' }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'not_an_object' }

  // An ABSENT event name is tolerated: the field is documented, but its absence is not evidence
  // of a different event. A PRESENT and different one is, and that is where interception stops.
  if (parsed.hook_event_name !== undefined && parsed.hook_event_name !== HOOK_EVENT) {
    return { ok: false, reason: 'wrong_event' }
  }
  if (parsed.tool_name !== INTERCEPTED_TOOL) return { ok: false, reason: 'wrong_tool' }
  if (!isPlainObject(parsed.tool_input)) return { ok: false, reason: 'no_tool_input' }
  if (!isNonEmptyString(parsed.tool_input.file_path)) return { ok: false, reason: 'no_file_path' }

  return { ok: true, payload: parsed }
}

/** The path this invocation is about. Only meaningful once `parseHookPayload` has said ok. */
export function filePathOf(payload) {
  return payload.tool_input.file_path
}

/**
 * Is this a targeted read — one where Claude asked for a specific region?
 *
 * Any of the three narrowing arguments means yes. `pages` is in the list because a PDF page range
 * is the same intent expressed for a different file type, and `neverDelegate.onTargetedRead`
 * should not depend on which reader the tool happened to use.
 *
 * A PRESENT but malformed value still counts as targeted, and a missing `tool_input` counts too:
 * someone tried to narrow the read, and deciding they meant the whole file is the one reading
 * that could delegate away bytes Claude specifically asked for.
 */
export function isTargetedRead(toolInput) {
  if (!isPlainObject(toolInput)) return true
  const given = (v) => v !== undefined && v !== null
  return given(toolInput.offset) || given(toolInput.limit) || given(toolInput.pages)
}

/* ------------------------------------------------------- routing translation */

/**
 * Claude Code's Read payload, plus the facts someone else measured, as a routing input.
 *
 * Every field of `decide()`'s 16-field contract is supplied explicitly, including the ones whose
 * value is `null`, so this table can be checked against docs/routing.md line by line. Nothing is
 * inferred: an unmeasured quantity stays `null` and the gate applies its own pessimistic reading.
 *
 * Two values are ASSERTED rather than measured, and this is the only place in the plugin where
 * that happens:
 *
 *   interactive: false        A PreToolUse payload carries no session posture, and both fields
 *   latencySensitive: false   read as `true` when unknown, which is a terminal refusal — so an
 *                             "honest unknown" hook could never delegate at all and the shipped
 *                             `routing.bulkRead.enforce: 'deny'` default would be unreachable.
 *                             The off-switches are `hooks.enabled`, `routing.bulkRead.enforce:
 *                             'off'` and `CMR_ENABLED=0`, not these two fields.
 *
 * `lineCount` and `estimatedInputTokens` stay null BY DESIGN. Both need the file's bytes, and
 * reading a file to decide whether reading it is worth avoiding defeats the purpose. The
 * consequence is stated in docs/hook-integration.md: the size question is answered by `minBytes`
 * alone, so the advertised `minLines` threshold never fires from the hook.
 *
 * @param {object} a.payload  a payload `parseHookPayload` accepted
 * @param {object} [a.facts]  measured by lib/hook/facts.mjs; every field may be null
 * @param {object} [a.env]    read only for CLAUDE_PROJECT_DIR, as a fallback for `cwd`
 */
export function toRoutingInput({ payload, facts = {}, env = {} }) {
  const toolInput = payload.tool_input
  const targeted = isTargetedRead(toolInput)

  return {
    taskType: 'bulk_read',
    toolName: payload.tool_name,

    // One file, named and proven. The gate cannot screen a corpus it was not given, and this hook
    // never infers siblings — `files_inferred_count` is 0 on every row it writes.
    fileCount: 1,
    paths: [filePathOf(payload)],
    projectPath: isNonEmptyString(payload.cwd) ? payload.cwd : (env.CLAUDE_PROJECT_DIR ?? null),

    inputBytes: facts.inputBytes ?? null,
    lineCount: null,
    estimatedInputTokens: null,

    targetedRead: targeted,
    fullRead: !targeted,
    recentlyEdited: facts.recentlyEdited ?? null,

    latencySensitive: false,
    interactive: false,

    // A Read says nothing about the shape of the answer Claude wants, and this field exists only
    // to EXCLUDE. Inventing a value could only cause a wrong refusal or a wrong delegation.
    requestedOutput: null,

    workerAvailable: facts.workerAvailable ?? null,
    workerUnavailableReason: facts.workerUnavailableReason ?? null,
  }
}

/* ------------------------------------------------------------- the response */

/**
 * The response that delegates: block the Read, and hand Claude the worker's answer instead.
 *
 * `permissionDecision: 'deny'` is what keeps the file's bytes out of the context window, which is
 * the entire saving. `permissionDecisionReason` becomes Claude Code's `blockingError`, so it
 * explains the block and nothing else; the answer travels in `additionalContext`, which the
 * PreToolUse runner emits ALONGSIDE a deny rather than instead of it. Putting the summary in the
 * reason would deliver it labelled as the tool's error, which invites a retry or a workaround.
 *
 * The reason names the escape hatch deliberately: a targeted re-read is the documented way for
 * Claude to get exact bytes, and the gate lets one straight through.
 *
 * @returns {object|null} null when there is no answer worth substituting, which falls open
 */
export function buildDelegatedResponse({ text, provider = null, model = null, caveat = null }) {
  if (!isNonEmptyString(text)) return null

  const worker = [provider, model].filter(isNonEmptyString).join('/') || 'a worker model'

  const reason = [
    `This file was not read directly: model-router delegated it to ${worker} to keep its full`,
    'contents out of your context. A summary of the whole file has been added to your context',
    'instead. Do not repeat this Read. If you need exact bytes from a specific region, read it',
    'again with offset and limit — a targeted read is never delegated.',
  ]
  // The caveat goes in the REASON, not in additionalContext: additionalContext is the worker's
  // answer and nothing else should be mixed into it, or a later reader cannot tell which words
  // came from the worker. Claude is the one consumer that can act on a caveat — it can re-read.
  if (isNonEmptyString(caveat)) reason.push(caveat)

  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: 'deny',
      permissionDecisionReason: reason.join(' '),
      additionalContext: text,
    },
  }
}

/**
 * The response that does nothing: `null`, meaning write no bytes at all.
 *
 * Every fail-open path returns this. Exit 0 with empty stdout is how Claude Code is told the hook
 * has no objection, and it is indistinguishable from the hook not being installed — which is
 * exactly the degradation this plugin promises.
 */
export function buildAllowResponse() {
  return null
}
