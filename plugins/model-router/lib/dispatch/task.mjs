/**
 * The task builder: what exactly should the worker do?
 *
 * This module exists to split one question into two. `decide()` answers "should this work be
 * delegated at all", and its 16-field input is deliberately free of anything resembling a
 * question. This answers "given that it is being delegated, what is being asked for", and it is
 * the ONLY place that answer is assembled. Merging the two would let the shape of a request
 * influence whether the request is allowed, which is the one coupling the routing layer is built
 * to prevent.
 *
 * It takes the base task as a PARAMETER rather than importing it. `hook/adapter.mjs` owns the
 * frozen generic task, and the engine may not import the hook layer in either direction — the
 * dependency runs one way only and test/hook.security.test.mjs enforces it. So the caller hands
 * the base task down.
 *
 * THIS IS THE REDACTION BOUNDARY.
 *
 *     task -> content selection -> [ redaction boundary ] -> worker request
 *
 * Everything crossing into a worker request crosses here. Today the boundary applies
 * `redactSecrets()` to INTENT TEXT ONLY and passes file content through untouched. That is not an
 * oversight and it is not a claim that content is safe: outbound file content has never been
 * redacted, the filename deny list is the only control that exists, and widening the boundary to
 * content is a later phase with its own evidence. What this module provides is the single seam at
 * which that widening becomes a local change rather than an audit. See
 * docs/worker-task-construction.md.
 *
 * DETERMINISTIC. Same input, same output, byte for byte: no clock, no randomness, no model call.
 * A worker request that cannot be reproduced cannot be compared across a threshold change, which
 * is the same reason modes.mjs builds its prompts from literals.
 *
 * EVERY STRING IS BUILT WITH join('\n'), NEVER A MULTI-LINE TEMPLATE LITERAL. `core.autocrlf` is
 * on for this repo and there is no `.gitattributes`, so a literal would hold \r\n in a Windows
 * checkout and \n in a Linux one, and CI gates on both.
 */

import { redactSecrets } from '../redact.mjs'

/**
 * Bumped when the mapping from intent to mode input changes. Separate from `PROMPT_VERSION`,
 * which versions the templates this feeds, because the two can change independently: a new
 * instruction line here changes the request without changing a template.
 */
export const TASK_BUILDER_VERSION = 1

/** Hard ceiling on any single intent string once it reaches here. Bounded input, bounded prompt. */
export const MAX_INTENT_CHARS = 4000

/** The intent fields this builder understands, in the order they are rendered. */
export const TASK_INTENT_FIELDS = Object.freeze([
  'task',
  'objective',
  'requestedInformation',
  'constraints',
  'outputFormat',
])

/* --------------------------------------------------------------------- helpers */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * One intent string, made safe to send.
 *
 * Trim, redact, clamp — in that order. Redaction before clamping, because clamping first could
 * cut a secret in half and leave a prefix the redactor no longer recognises.
 */
function clean(value) {
  if (!isNonEmptyString(value)) return null
  const redacted = redactSecrets(value.trim())
  const clamped = redacted.length > MAX_INTENT_CHARS ? redacted.slice(0, MAX_INTENT_CHARS) : redacted
  return isNonEmptyString(clamped) ? clamped : null
}

/**
 * Is there anything here worth sending?
 *
 * An intent object whose every field is null is the same as no intent, and must produce the same
 * bytes as no intent — otherwise the default path would differ from the opted-out path by an
 * empty section, and two things that mean the same thing would serialize differently.
 */
function hasContent(intent) {
  if (!isPlainObject(intent)) return false
  for (const field of TASK_INTENT_FIELDS) {
    if (isNonEmptyString(intent[field])) return true
  }
  return false
}

/* ------------------------------------------------------------- the instructions */

/**
 * The standing instructions a worker gets when it has been told what the task actually is.
 *
 * These are CONTENT requirements, not a serialization schema. The bulk reader is still never told
 * to answer in JSON, YAML or any other shape — imposing one would be an artificial interpretation
 * of an answer this layer does not read, and docs/worker-dispatch.md holds that line. What these
 * say is that a stated question must be answered exhaustively and verifiably, which is precisely
 * what a generic "summarise this file" request fails to ask for.
 */
const BULK_READ_INSTRUCTIONS = Object.freeze([
  'Answer the stated task directly and first. A summary is not an answer.',
  'Find EVERY occurrence that matches, not the first one and not a representative sample.',
  'Give the file path and the line number for each occurrence.',
  'Quote the matching text exactly as written; never paraphrase an identifier or a literal.',
  'Distinguish a real match from something that merely resembles one, and say which is which.',
  'If the material does not contain the answer, say so plainly. Never invent a match or a line number.',
])

const CODE_WRITE_INSTRUCTIONS = Object.freeze([
  'Satisfy the stated objective exactly; do not broaden it and do not substitute your own.',
  'Honour every stated constraint. If one cannot be met, say which and why instead of ignoring it.',
  'Use only identifiers and APIs visible in the supplied context. Never invent one.',
])

const INSTRUCTIONS_BY_LANE = Object.freeze({
  bulkRead: BULK_READ_INSTRUCTIONS,
  codeWrite: CODE_WRITE_INSTRUCTIONS,
})

/* ------------------------------------------------------------------ the builder */

/**
 * Build the worker's mode input from the tool context and whatever intent is known.
 *
 * Returns a MODE INPUT, not a prompt. Rendering is `modes.mjs`'s job, and keeping the two apart is
 * what lets the same built task be asserted field by field in a test and rendered byte-exactly in
 * a benchmark.
 *
 * WITH NO INTENT IT IS AN IDENTITY. `{task: baseTask, files}` and nothing else — no empty
 * `instructions` array, no null `outputRequirements` — so the rendered prompt is byte-identical to
 * the one this plugin has always sent. That is the property the default configuration relies on,
 * and test/task.builder.test.mjs pins it against a captured snapshot.
 *
 * @param {object}      a.toolContext          what the caller already knows about the request
 * @param {string}      a.toolContext.baseTask the frozen fallback task, supplied by the caller
 * @param {string}      [a.toolContext.lane]   'bulkRead' | 'codeWrite'; selects the instructions
 * @param {object|null} [a.taskIntent]         a normalized task intent, or null when none is known
 * @param {Array}       [a.files]              the selected file corpus, passed through unchanged
 * @param {string|null} [a.instruction]        code-writer's base instruction, when that is the lane
 * @param {string|null} [a.context]            code-writer passthrough
 * @param {string|null} [a.reference]          code-writer passthrough
 * @returns {object} a mode input
 */
export function buildWorkerTask({
  toolContext = {},
  taskIntent = null,
  files = null,
  instruction = null,
  context = null,
  reference = null,
}) {
  const lane = toolContext?.lane === 'codeWrite' ? 'codeWrite' : 'bulkRead'
  const baseTask = isNonEmptyString(toolContext?.baseTask) ? toolContext.baseTask : null

  /* ---- code-writer: an instruction and optional surrounding material, no file list ---- */

  if (lane === 'codeWrite') {
    const intentInstruction = clean(taskIntent?.objective) ?? clean(taskIntent?.task)
    const out = {
      instruction: intentInstruction ?? (isNonEmptyString(instruction) ? instruction : baseTask),
      context,
      reference,
    }
    const enriched = enrich(taskIntent, lane, intentInstruction)
    return enriched === null ? out : { ...out, ...enriched }
  }

  /* ---- bulk-reader: a task and the files it is about ---- */

  const intentTask = clean(taskIntent?.task) ?? clean(taskIntent?.objective)
  const out = { task: intentTask ?? baseTask, files: files ?? [] }
  const enriched = enrich(taskIntent, lane, intentTask)
  return enriched === null ? out : { ...out, ...enriched }
}

/**
 * The optional half: instructions and requirements, or null when there is no intent to serve.
 *
 * `primary` is the field already consumed as the task or the instruction. It is excluded from the
 * requirements so the same sentence is not sent twice — a worker given its question once and then
 * again as a "requirement" has been told the second one matters more, which is not the intent.
 */
function enrich(taskIntent, lane, primary) {
  if (!hasContent(taskIntent)) return null

  const requirements = []
  const requested = clean(taskIntent.requestedInformation)
  const constraints = clean(taskIntent.constraints)
  const outputFormat = clean(taskIntent.outputFormat)

  // `objective` earns a line only when it was not already used as the task itself.
  const objective = clean(taskIntent.objective)
  if (objective !== null && objective !== primary) requirements.push(`Objective: ${objective}`)
  if (requested !== null) requirements.push(`Report: ${requested}`)
  if (constraints !== null) requirements.push(`Constraints: ${constraints}`)
  if (outputFormat !== null) requirements.push(`Present the answer as: ${outputFormat}`)

  return {
    instructions: [...INSTRUCTIONS_BY_LANE[lane]],
    outputRequirements: requirements.length === 0 ? null : requirements,
  }
}
