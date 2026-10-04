/**
 * The two worker modes, and the deterministic prompts they build.
 *
 * A mode owns exactly one thing: turning caller-supplied input into `{system, prompt}`. It does
 * not choose a provider, does not execute anything, and — the load-bearing part — does not
 * discover content. The execution layer RECEIVES file content; it never reads a file. A worker
 * that could name its own inputs would turn a gated read into an ungated one.
 *
 * PROMPTS ARE DATA, NOT GENERATION. Every string here is a literal template filled by
 * concatenation. No model is called to write a prompt for a model: that would make the request
 * non-reproducible, and an unreproducible request cannot be compared across a threshold change.
 *
 * EVERY PROMPT IS BUILT WITH join('\n'), NEVER A MULTI-LINE TEMPLATE LITERAL. `core.autocrlf` is
 * on for this repo and there is no `.gitattributes`, so a multi-line literal holds \r\n in a
 * Windows checkout and \n in a Linux one. CI gates on both platforms, so a byte-exact prompt
 * assertion would pass one leg and fail the other.
 */

import { LANE_MODE } from '../routing-policy.mjs'

/**
 * Bumped when a template changes, so a stored result can be read against the prompt that produced
 * it. One integer for the whole layer rather than one per mode: two counters is two things to
 * forget to bump. Independent of POLICY_VERSION, SCHEMA_VERSION and CALC_VERSION.
 *
 * 1 -> 3, not 1 -> 2, because 2 already belongs to INTENT_PROMPT_VERSION below and a stamp that
 * two different prompts can carry is a stamp nobody can read a stored row against. Both counters
 * moved together because the change was to the SYSTEM prompt, which both variants share: the
 * bulk reader's final rule used to say "Be concise ... include the facts it needs and nothing
 * else", which set no precedence against the lane requirement "Find EVERY occurrence that
 * matches". It was not a contradiction, but it left a small model free to resolve the tension
 * toward brevity — and that is the observed failure. It now subordinates concision to coverage
 * explicitly, which is the smallest change that removes the ambiguity.
 */
export const PROMPT_VERSION = 3

/**
 * The version a prompt reports when it carries a task intent.
 *
 * A separate integer rather than a bump of the one above, because the generic request did not
 * change: with no intent the templates still emit the bytes they always have, and a row stamped
 * `1` is still comparable with every row stored before this existed. A row stamped `2` carries
 * extra sections, so its token count is NOT comparable with a stored generic row — which is
 * exactly what a reader needs to know before subtracting one from the other.
 */
export const INTENT_PROMPT_VERSION = 4

/** Hard ceiling on how many files a single bulk-read request may carry. */
export const MAX_FILES = 1000

/* --------------------------------------------------------------------- helpers */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * The fence around a file's content. A long, unlikely marker rather than a bare ``` fence: source
 * files contain ``` all the time, and a delimiter the payload can forge is a delimiter that lets
 * one file's content be read as the next file's header.
 */
const FENCE = '<<<<<<<<<< FILE'
const FENCE_END = '>>>>>>>>>> END FILE'

/* ----------------------------------------------------------------- bulk-reader */

const BULK_READER_SYSTEM = [
  'You are a bulk file reader. You are given the complete contents of one or more files and a',
  'single question about them. Answer only from the material provided.',
  '',
  'Rules:',
  '- Use only the file contents given below. You have no filesystem, no shell and no network.',
  '- If the answer is not present in the supplied material, say so plainly. Do not guess, and do',
  '  not describe what a file probably contains.',
  '- Cite the file path when a statement comes from a particular file.',
  '- Be concise in wording, not in coverage: give every fact the task asks for, and nothing',
  '  beyond that. Your answer is read by another model that has not seen these files.',
].join('\n')

/**
 * The optional `# Requirements` block, as lines, or an empty array when there is nothing to say.
 *
 * ONE section, not two. `instructions` (the lane's standing rules) and `outputRequirements` (what
 * this particular request asked for) differ in origin but are identical in kind — both are things
 * the worker must do — and splitting them under two headings would invite a model to treat the
 * second as optional. Emitting nothing at all when both are absent is what keeps the no-intent
 * prompt byte-identical to the one this plugin has always sent.
 *
 * These are CONTENT requirements and never a serialization schema: nothing here tells a worker to
 * answer in JSON, YAML or any other shape. docs/worker-dispatch.md holds that line, and
 * test/dispatch.modes.test.mjs asserts it over the built PROMPT, not just the system string.
 */
function requirementLines(input) {
  const items = []
  for (const key of ['instructions', 'outputRequirements']) {
    if (!Array.isArray(input[key])) continue
    for (const item of input[key]) if (isNonEmptyString(item)) items.push(String(item).trim())
  }
  if (items.length === 0) return []

  const lines = ['# Requirements', '']
  for (const item of items) lines.push(`- ${item}`)
  lines.push('')
  return lines
}

/** 2 when the request carries the intent-aware sections, 1 when it is the generic request. */
function versionFor(extra) {
  return extra.length === 0 ? PROMPT_VERSION : INTENT_PROMPT_VERSION
}

function buildBulkReader(input) {
  const extra = requirementLines(input)
  const lines = ['# Task', '', String(input.task).trim(), '']
  lines.push(...extra, `# Files (${input.files.length})`, '')
  for (const file of input.files) {
    lines.push(`${FENCE} ${file.path}`, String(file.content), `${FENCE_END} ${file.path}`, '')
  }
  return { system: BULK_READER_SYSTEM, prompt: lines.join('\n'), promptVersion: versionFor(extra) }
}

function validateBulkReader(input) {
  const problems = []
  if (!isPlainObject(input)) return ['input must be an object']
  if (!Array.isArray(input.files)) problems.push('input.files must be an array')
  else if (input.files.length === 0) problems.push('input.files must not be empty')
  else if (input.files.length > MAX_FILES) problems.push(`input.files must hold at most ${MAX_FILES} entries`)
  else {
    input.files.forEach((file, i) => {
      if (!isPlainObject(file)) problems.push(`input.files[${i}] must be an object`)
      else {
        if (!isNonEmptyString(file.path)) problems.push(`input.files[${i}].path must be a non-empty string`)
        // '' is a legitimate empty file; undefined is a caller bug. The two are not the same.
        if (typeof file.content !== 'string') problems.push(`input.files[${i}].content must be a string`)
      }
    })
  }
  if (!isNonEmptyString(input.task)) problems.push('input.task must be a non-empty string')
  problems.push(...validateRequirements(input))
  return problems
}

/**
 * The two optional intent-bearing fields, checked the same way in both modes.
 *
 * Absent and null are both "no requirements". Anything else must be an array of strings: a
 * non-array is REFUSED rather than wrapped, and a non-string member is refused rather than
 * stringified, matching how `context` and `reference` have always been handled. A caller that
 * sends the wrong shape has a bug, and silently coercing it would put whatever `String(x)` made
 * of an object into a prompt.
 */
function validateRequirements(input) {
  const problems = []
  for (const key of ['instructions', 'outputRequirements']) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) {
      problems.push(`input.${key} must be an array of strings when present`)
      continue
    }
    value.forEach((item, i) => {
      if (typeof item !== 'string') problems.push(`input.${key}[${i}] must be a string`)
    })
  }
  return problems
}

/* ------------------------------------------------------------------ code-writer */

const CODE_WRITER_SYSTEM = [
  'You are a code generator. You are given an instruction, and optionally surrounding context and',
  'reference material to imitate. Produce the requested code.',
  '',
  'Rules:',
  '- Output the code itself. You have no filesystem, no shell and no network: you cannot read a',
  '  file, run a command, execute a test or touch version control.',
  '- Follow the conventions visible in the reference material rather than your own defaults.',
  '- Use only the context given. If the instruction needs something that is not supplied, state',
  '  what is missing instead of inventing an API.',
  '- Your output is a proposal. Something else decides whether it is applied.',
].join('\n')

function buildCodeWriter(input) {
  const extra = requirementLines(input)
  const lines = ['# Instruction', '', String(input.instruction).trim(), '']
  lines.push(...extra)
  if (isNonEmptyString(input.context)) lines.push('# Context', '', String(input.context).trim(), '')
  if (isNonEmptyString(input.reference)) {
    lines.push('# Reference material to imitate', '', String(input.reference).trim(), '')
  }
  return { system: CODE_WRITER_SYSTEM, prompt: lines.join('\n'), promptVersion: versionFor(extra) }
}

function validateCodeWriter(input) {
  if (!isPlainObject(input)) return ['input must be an object']
  const problems = []
  if (!isNonEmptyString(input.instruction)) problems.push('input.instruction must be a non-empty string')
  for (const key of ['context', 'reference']) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') {
      problems.push(`input.${key} must be a string when present`)
    }
  }
  problems.push(...validateRequirements(input))
  return problems
}

/* ---------------------------------------------------------------------- registry */

/**
 * Keyed off LANE_MODE's VALUES, not off hand-typed strings. A lane added to the routing policy
 * without a mode here then shows up as a missing key rather than as a mode nobody notices is
 * unreachable, and a test pins that the two tables still agree.
 */
export const MODES = Object.freeze({
  [LANE_MODE.bulkRead]: Object.freeze({
    id: LANE_MODE.bulkRead,
    lane: 'bulkRead',
    validate: validateBulkReader,
    build: buildBulkReader,
  }),
  [LANE_MODE.codeWrite]: Object.freeze({
    id: LANE_MODE.codeWrite,
    lane: 'codeWrite',
    validate: validateCodeWriter,
    build: buildCodeWriter,
  }),
})

export function isKnownMode(mode) {
  return typeof mode === 'string' && Object.hasOwn(MODES, mode)
}
