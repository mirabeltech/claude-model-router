/**
 * The evaluation case format, version 1.
 *
 * PURE: no filesystem, no network, no clock. `evals.isolation.test.mjs` enforces the absence of a
 * `node:` import, so this module can be reasoned about as a table rather than as a program.
 *
 * ENUM OPENNESS IS ASYMMETRIC HERE, AND THE ASYMMETRY IS THE POINT.
 *
 * The house rule is that enums are open on read: an unknown value is preserved and bucketed as
 * `other`, never rejected. That rule is right for a DESCRIPTIVE field, where a reader's job is to
 * survive data it did not anticipate. It is wrong for an EXPECTATION, because
 *
 *   > an open enum on an expectation makes the expectation unfalsifiable.
 *
 * `reason: 'thresold_met'` bucketing quietly to `other` turns a typo into a case that can never
 * fail, and a corpus of cases that cannot fail is worse than no corpus. So `category`, `shapes`,
 * `files[].role` and `metadata` are open and bucket; every field inside `expected` is closed and
 * REJECTS. `routing-policy.mjs` makes the same call for the same reason: "an open enum on a
 * security input would let a typo'd `architecure` fall straight past the exclusion list".
 *
 * Every closed list is IMPORTED from the engine, never re-typed. A reason code added to
 * `DECIDE_REASONS` is accepted by this loader in the same commit, and one removed stops being
 * accepted — the discipline `DISPATCH_ERROR_CODES` uses to stay in step with `ERROR_CODES`.
 */

import {
  DECIDE_REASONS,
  ENFORCEMENTS,
  LANE_MODE,
  ROUTING_TASK_TYPES,
} from '../../plugins/model-router/lib/routing-policy.mjs'
import { DISPATCH_REASONS, DISPATCH_STATUSES } from '../../plugins/model-router/lib/dispatch/contract.mjs'
import { OUTCOMES } from '../../plugins/model-router/lib/hook/run.mjs'
import { EVALUATOR_KINDS, validateCriteria } from './evaluators.mjs'

/** Bumped when a field changes meaning or disappears. A mismatch rejects rather than warns. */
export const EVAL_SCHEMA_VERSION = 1

/* ------------------------------------------------------------------- vocabulary */

/**
 * Descriptive. OPEN: an unrecognised category is preserved and bucketed, because what a case is
 * "about" is a label for humans and no assertion reads it.
 */
export const EVAL_CATEGORIES = Object.freeze([
  'bulk_read',
  'multi_file_read',
  'small_read',
  'debugging',
  'architecture',
  'security',
  'precise_edit',
  'ambiguous',
])

/**
 * The content shapes the corpus covers. OPEN, and `evals.corpus.test.mjs` asserts every one of
 * these is covered by at least one case — so adding a shape here without a case fails the suite,
 * which is the point of listing them.
 *
 * TWO SHAPES THE BRIEF ASKS FOR ARE DELIBERATELY ABSENT: `debugging_request` and
 * `architecture_request`. A content shape is a property of bytes on disk, and "debugging" is not
 * one — it is a `taskType`, and no shipped code path emits it (`hook/adapter.mjs` hardcodes
 * `taskType: 'bulk_read'`). A case asserting "a debugging request stays primary" would assert that
 * a string is absent from a two-element array, before any path, byte or glob is read, with its
 * own `files/` never opened.
 *
 * That ground is covered instead, and far more strongly, by `evals.protected.test.mjs`: every
 * corpus case crossed with every non-delegatable task type, starting from inputs that DO delegate.
 * See docs/evaluation.md.
 */
export const CONTENT_SHAPES = Object.freeze([
  'small_file',
  'medium_file',
  'large_file',
  'multiple_files',
  'repetitive_content',
  'high_noise',
  'buried_in_large',
  'security_sensitive',
  'precise_edit_request',
  'ambiguous_request',
])

/**
 * Which layer runs the case. CLOSED.
 *
 *   decide   — the pure gate only. No files are read, no provider exists.
 *   hook     — the real `pre-tool-use.mjs` child process over stdin/stdout.
 *   dispatch — the worker, through `dispatch()` with an injected fetch.
 */
export const HARNESSES = Object.freeze(['decide', 'hook', 'dispatch'])

/**
 * CLOSED. `generated` is the DEFAULT for a reason that cost real debugging to find: `core.autocrlf`
 * is effectively true on Windows and this repo ships no `.gitattributes`, so the byte length of a
 * committed `.ts` file is not a checkout-invariant property. A generated fixture is materialised
 * from a `{unit, repeat}` pair with an explicit LF join, so git never sees the bytes and git cannot
 * rewrite them. See docs/benchmark-methodology.md.
 */
export const FILE_SOURCES = Object.freeze(['committed', 'generated'])

/** Descriptive. OPEN. */
export const FILE_ROLES = Object.freeze(['subject', 'noise', 'decoy'])

/** CLOSED. Two values, and `threshold_met` is the only reason that may pair with `delegate`. */
export const EXPECTED_CLASSES = Object.freeze(['primary', 'delegate'])

/**
 * The sixteen fields `normalizeInput()` declares. CLOSED: an unknown key in a case's
 * `routingInput` is a typo that would otherwise be silently dropped by the engine's own
 * `Object.hasOwn` reads, leaving a case that asserts nothing it meant to.
 */
export const ROUTING_INPUT_FIELDS = Object.freeze([
  'taskType',
  'toolName',
  'requestedOutput',
  'projectPath',
  'paths',
  'workerUnavailableReason',
  'targetedRead',
  'fullRead',
  'recentlyEdited',
  'latencySensitive',
  'interactive',
  'workerAvailable',
  'fileCount',
  'lineCount',
  'inputBytes',
  'estimatedInputTokens',
])

export const SAFETY_FIELDS = Object.freeze([
  'plantedSecret',
  'allowedEntities',
  'denyGlobIntent',
  'knownExposure',
])

const LANES = Object.freeze(Object.keys(LANE_MODE))
const MODES = Object.freeze(Object.values(LANE_MODE))

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FILES_PER_CASE = 25
const MAX_TITLE = 120
const MAX_RATIONALE = 600
const MAX_TASK = 2000

/**
 * The task-intent fields a case may declare, and the ceiling on each.
 *
 * Imported-shaped rather than imported, because `schema.mjs` is statically asserted to pull in no
 * `node:` builtin and is deliberately the one module in the framework with no engine dependency
 * beyond the routing vocabulary. The names are checked against the engine's own list by
 * test/evals.schema.test.mjs, which is where a drift would surface.
 */
const TASK_INTENT_FIELDS = Object.freeze([
  'task',
  'objective',
  'requestedInformation',
  'constraints',
  'outputFormat',
])
const MAX_INTENT_FIELD = 2000

/* ------------------------------------------------------------------- primitives */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isInt = (v) => typeof v === 'number' && Number.isInteger(v)
const own = (o, k) => (isObject(o) && Object.hasOwn(o, k) ? o[k] : undefined)

function isText(v, max) {
  return typeof v === 'string' && v.length >= 1 && v.length <= max
}

/**
 * Lines in a text. THE one definition, exported and unit-tested, because "1389 lines" is otherwise
 * three different numbers depending on who counted: a trailing newline terminates the last line
 * rather than starting a new one.
 */
export function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * Bucket a descriptive enum per the house open-on-read rule: preserve the value, add the bucket.
 * A reader grouping by `categoryBucket` sees `other`; a reader printing `category` sees what the
 * case actually said.
 */
export function bucketCategory(value) {
  const known = typeof value === 'string' && EVAL_CATEGORIES.includes(value)
  return { category: typeof value === 'string' ? value : null, categoryBucket: known ? value : 'other' }
}

/* ------------------------------------------------------------------ file entries */

function validateFileEntry(raw, index, errors) {
  const where = `files[${index}]`
  if (!isObject(raw)) {
    errors.push(`invalid_case:${where} must be an object`)
    return null
  }

  const path = own(raw, 'path')
  // The string rule comes first and is deliberately strict. `path.relative()` is checked again at
  // load time against the resolved directory, but a textual rule is what keeps a traversal out of
  // a committed case file in the first place.
  if (typeof path !== 'string' || path === '') {
    errors.push(`invalid_case:${where}.path must be a non-empty string`)
  } else if (path.includes('\\')) {
    errors.push(`invalid_case:${where}.path must use forward slashes`)
  } else if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    errors.push(`invalid_case:${where}.path must be relative`)
  } else if (path.split('/').includes('..')) {
    errors.push(`path_escape:${where}.path may not contain ".."`)
  }

  const source = own(raw, 'source')
  if (!FILE_SOURCES.includes(source)) {
    errors.push(`invalid_case:${where}.source must be one of ${FILE_SOURCES.join(' | ')}`)
  }

  const bytes = own(raw, 'bytes')
  if (!isInt(bytes) || bytes < 0) errors.push(`invalid_case:${where}.bytes must be an integer >= 0`)

  const lines = own(raw, 'lines')
  if (!isInt(lines) || lines < 0) errors.push(`invalid_case:${where}.lines must be an integer >= 0`)

  const sha256 = own(raw, 'sha256')
  if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(sha256))) {
    errors.push(`invalid_case:${where}.sha256 must be 64 lowercase hex characters`)
  }

  const generator = own(raw, 'generator')
  if (source === 'generated') {
    if (!isObject(generator) || typeof generator.unit !== 'string' || generator.unit === '') {
      errors.push(`invalid_case:${where}.generator needs a non-empty unit for a generated file`)
    } else if (!isInt(generator.repeat) || generator.repeat < 1) {
      errors.push(`invalid_case:${where}.generator.repeat must be an integer >= 1`)
    }
  } else if (generator !== undefined) {
    errors.push(`invalid_case:${where}.generator is only meaningful when source is "generated"`)
  }

  const role = own(raw, 'role')
  if (role !== undefined && typeof role !== 'string') {
    errors.push(`invalid_case:${where}.role must be a string when present`)
  }

  return Object.freeze({
    path: typeof path === 'string' ? path : null,
    source: FILE_SOURCES.includes(source) ? source : null,
    bytes: isInt(bytes) ? bytes : null,
    lines: isInt(lines) ? lines : null,
    sha256: sha256 === undefined ? null : String(sha256),
    generator: isObject(generator)
      ? Object.freeze({ unit: generator.unit, repeat: generator.repeat })
      : null,
    role: typeof role === 'string' ? role : null,
    roleBucket: FILE_ROLES.includes(role) ? role : 'other',
  })
}

/* --------------------------------------------------------------------- expected */

function validateExpected(raw, harness, errors) {
  if (!isObject(raw)) {
    errors.push('invalid_case:expected must be an object')
    return null
  }

  const closed = (field, known) => {
    const v = own(raw, field)
    if (!known.includes(v)) {
      errors.push(`invalid_case:expected.${field} must be one of ${known.join(' | ')}`)
      return null
    }
    return v
  }

  const klass = closed('class', EXPECTED_CLASSES)
  const reason = closed('reason', DECIDE_REASONS)
  const taskType = closed('taskType', ROUTING_TASK_TYPES)
  const decision = closed('decision', ENFORCEMENTS)

  // The cross-check that stops a skim from landing on the wrong side of the gate. `class` is
  // redundant with `reason` on purpose: `class` is the half a reviewer reads, and `threshold_met`
  // is the ONLY delegating reason in the engine — routing.mjs has exactly one build() with
  // delegate: true. A case whose two halves disagree is unloadable rather than merely wrong.
  if (klass !== null && reason !== null) {
    const impliedByReason = reason === 'threshold_met' ? 'delegate' : 'primary'
    if (klass !== impliedByReason) {
      errors.push(
        `invalid_case:expected class "${klass}" contradicts reason "${reason}", which implies "${impliedByReason}"`,
      )
    }
  }

  const lane = own(raw, 'lane')
  if (lane !== undefined && lane !== null && !LANES.includes(lane)) {
    errors.push(`invalid_case:expected.lane must be null or one of ${LANES.join(' | ')}`)
  }
  const mode = own(raw, 'mode')
  if (mode !== undefined && mode !== null && !MODES.includes(mode)) {
    errors.push(`invalid_case:expected.mode must be null or one of ${MODES.join(' | ')}`)
  }

  const inputWarnings = own(raw, 'inputWarnings')
  if (
    inputWarnings !== undefined &&
    (!Array.isArray(inputWarnings) || !inputWarnings.every((w) => typeof w === 'string' && w !== ''))
  ) {
    errors.push('invalid_case:expected.inputWarnings must be an array of non-empty strings')
  }

  // Harness-specific expectations. Required where the harness produces them, rejected where it
  // cannot — an expectation about an outcome the harness never computes is a claim nothing checks.
  const outcome = own(raw, 'outcome')
  if (harness === 'hook') {
    if (!OUTCOMES.includes(outcome)) {
      errors.push(`invalid_case:expected.outcome is required for a hook case and must be one of ${OUTCOMES.length} OUTCOMES`)
    }
  } else if (outcome !== undefined) {
    errors.push('invalid_case:expected.outcome is only meaningful for a hook case')
  }

  const dispatchStatus = own(raw, 'dispatchStatus')
  const dispatchReason = own(raw, 'dispatchReason')
  if (harness === 'dispatch') {
    if (!DISPATCH_STATUSES.includes(dispatchStatus)) {
      errors.push(`invalid_case:expected.dispatchStatus must be one of ${DISPATCH_STATUSES.join(' | ')}`)
    }
    if (!DISPATCH_REASONS.includes(dispatchReason)) {
      errors.push(`invalid_case:expected.dispatchReason must be one of ${DISPATCH_REASONS.join(' | ')}`)
    }
  } else {
    if (dispatchStatus !== undefined) errors.push('invalid_case:expected.dispatchStatus is only meaningful for a dispatch case')
    if (dispatchReason !== undefined) errors.push('invalid_case:expected.dispatchReason is only meaningful for a dispatch case')
  }

  return Object.freeze({
    class: klass,
    reason,
    taskType,
    decision,
    lane: lane === undefined ? null : lane,
    mode: mode === undefined ? null : mode,
    inputWarnings: Object.freeze(Array.isArray(inputWarnings) ? [...inputWarnings] : []),
    outcome: outcome === undefined ? null : outcome,
    dispatchStatus: dispatchStatus === undefined ? null : dispatchStatus,
    dispatchReason: dispatchReason === undefined ? null : dispatchReason,
  })
}

/* ----------------------------------------------------------------- validateCase */

/**
 * Validate one raw `case.json` object.
 *
 * Never throws. A malformed case is a named error, not a stack trace: a corpus typo must say which
 * field in which case, because the person reading the failure is usually the person who made it.
 *
 * @returns {{case: object|null, errors: string[], warnings: string[]}}
 */
export function validateCase(raw) {
  const errors = []
  const warnings = []

  if (!isObject(raw)) {
    return { case: null, errors: ['invalid_case:<root> must be a JSON object'], warnings }
  }

  /* --- schema version. Checked first and fatal: every rule below is version 1's rule. --- */
  const schemaVersion = own(raw, 'schemaVersion')
  if (schemaVersion !== EVAL_SCHEMA_VERSION) {
    return {
      case: null,
      errors: [`invalid_case:schemaVersion must be ${EVAL_SCHEMA_VERSION}, got ${JSON.stringify(schemaVersion)}`],
      warnings,
    }
  }

  const id = own(raw, 'id')
  if (typeof id !== 'string' || !ID_RE.test(id) || id.length < 3 || id.length > 64) {
    errors.push('invalid_case:id must be 3-64 characters of lowercase kebab-case')
  }

  const caseVersion = own(raw, 'caseVersion')
  if (!isInt(caseVersion) || caseVersion < 1) errors.push('invalid_case:caseVersion must be an integer >= 1')

  const { category, categoryBucket } = bucketCategory(own(raw, 'category'))
  if (category === null) errors.push('invalid_case:category must be a string')
  else if (categoryBucket === 'other') warnings.push(`unknown_enum:category=${category}`)

  const rawShapes = own(raw, 'shapes')
  let shapes = []
  if (!Array.isArray(rawShapes) || rawShapes.length === 0 || !rawShapes.every((s) => typeof s === 'string' && s !== '')) {
    errors.push('invalid_case:shapes must be a non-empty array of strings')
  } else {
    shapes = [...rawShapes]
    for (const s of shapes) {
      if (!CONTENT_SHAPES.includes(s)) warnings.push(`unknown_enum:shapes=${s}`)
    }
  }

  if (!isText(own(raw, 'title'), MAX_TITLE)) errors.push(`invalid_case:title must be 1-${MAX_TITLE} characters`)

  // Required, and the corpus's entire value. A case without an argument for why its expectation
  // holds is a number somebody will later "fix" by editing the expectation.
  if (!isText(own(raw, 'rationale'), MAX_RATIONALE)) {
    errors.push(`invalid_case:rationale must be 1-${MAX_RATIONALE} characters naming the rule that owns the outcome`)
  }

  const harness = own(raw, 'harness')
  if (!HARNESSES.includes(harness)) {
    errors.push(`invalid_case:harness must be one of ${HARNESSES.join(' | ')}`)
  }

  /* --- task: required for dispatch, REJECTED for hook --- */
  const task = own(raw, 'task')
  if (harness === 'dispatch') {
    if (!isText(task, MAX_TASK)) errors.push(`invalid_case:task is required for a dispatch case (1-${MAX_TASK} chars)`)
  } else if (task !== undefined) {
    // The hook sends the frozen BULK_READ_TASK literal and nothing else — a PreToolUse payload says
    // which file, never why. A per-case task there is a claim about behaviour that does not exist.
    errors.push(`task_on_hook_case:task is not sent by the ${harness} harness; only a dispatch case may carry one`)
  }

  /* --- taskIntent: optional for dispatch, REJECTED for hook, closed field by field ---
   *
   * Rejected on a hook case for the same reason `task` is, and it is a sharper reason here. A hook
   * case's intent comes from a session transcript the harness does not write, gated by a config
   * flag the eval does not set. A case file declaring one would describe a request the hook
   * cannot make, which is the kind of green check that cannot go red.
   *
   * Every field is CLOSED. An unknown key inside the block is an error rather than ignored slack,
   * because a typo'd `requestedInfo` silently dropping would leave a case asserting less than its
   * author wrote — the same argument the `expected` block rests on.
   */
  const taskIntent = own(raw, 'taskIntent')
  if (taskIntent !== undefined) {
    if (harness !== 'dispatch') {
      errors.push(
        `task_intent_on_hook_case:taskIntent is not reachable through the ${harness} harness; ` +
          'only a dispatch case may carry one',
      )
    } else if (!isObject(taskIntent)) {
      errors.push('invalid_case:taskIntent must be an object')
    } else {
      let populated = 0
      for (const key of Object.keys(taskIntent)) {
        if (!TASK_INTENT_FIELDS.includes(key)) {
          errors.push(`invalid_case:taskIntent.${key} is not a known task-intent field`)
        }
      }
      for (const field of TASK_INTENT_FIELDS) {
        const value = taskIntent[field]
        if (value === undefined || value === null) continue
        // Blank-after-trim is rejected rather than counted, because `normalizeTaskIntent` trims
        // and would discard it. A case declaring an intent the builder then ignores would run its
        // `intent` variant identically to its `generic` one while claiming to be a comparison.
        if (!isText(value, MAX_INTENT_FIELD) || value.trim() === '') {
          errors.push(`invalid_case:taskIntent.${field} must be 1-${MAX_INTENT_FIELD} non-blank characters`)
        } else {
          populated += 1
        }
      }
      if (populated === 0) {
        errors.push('invalid_case:taskIntent must populate at least one field, or be omitted')
      }
    }
  }

  /* --- files --- */
  const rawFiles = own(raw, 'files')
  let files = []
  if (!Array.isArray(rawFiles)) {
    errors.push('invalid_case:files must be an array')
  } else if (rawFiles.length > MAX_FILES_PER_CASE) {
    errors.push(`invalid_case:files may hold at most ${MAX_FILES_PER_CASE} entries`)
  } else {
    if (rawFiles.length === 0 && harness !== 'decide') {
      errors.push('invalid_case:files may only be empty for a decide case')
    }
    files = rawFiles.map((f, i) => validateFileEntry(f, i, errors)).filter((f) => f !== null)
    const seen = new Set()
    for (const f of files) {
      if (f.path === null) continue
      if (seen.has(f.path)) errors.push(`invalid_case:files has a duplicate path ${f.path}`)
      seen.add(f.path)
    }
  }

  /* --- routingInput: closed against the engine's sixteen fields --- */
  const rawRouting = own(raw, 'routingInput')
  const routingInput = {}
  if (rawRouting !== undefined) {
    if (!isObject(rawRouting)) {
      errors.push('invalid_case:routingInput must be an object')
    } else {
      for (const key of Object.keys(rawRouting)) {
        if (!ROUTING_INPUT_FIELDS.includes(key)) {
          errors.push(`invalid_case:routingInput.${key} is not one of the sixteen decide() input fields`)
        } else {
          routingInput[key] = rawRouting[key]
        }
      }
    }
  }

  const config = own(raw, 'config')
  if (config !== undefined && !isObject(config)) errors.push('invalid_case:config must be an object')

  /* --- expected --- */
  const expected = validateExpected(own(raw, 'expected'), harness, errors)

  /* --- qualityCriteria: required for dispatch, REJECTED on a primary case --- */
  const qualityCriteria = own(raw, 'qualityCriteria')
  if (expected?.class === 'primary' && qualityCriteria !== undefined) {
    // With no output, every criterion is vacuously satisfied or vacuously skipped. Ignoring the
    // block would make the corpus look several times better covered than it is, so it is rejected.
    errors.push('quality_on_primary_case:qualityCriteria cannot be measured on a case expected to stay primary')
  } else if (harness === 'dispatch') {
    if (!isObject(qualityCriteria) || Object.keys(qualityCriteria).length === 0) {
      errors.push(`invalid_case:qualityCriteria is required for a dispatch case; kinds: ${EVALUATOR_KINDS.join(', ')}`)
    } else {
      for (const p of validateCriteria(qualityCriteria)) errors.push(`invalid_case:qualityCriteria ${p}`)
    }
  } else if (qualityCriteria !== undefined) {
    for (const p of validateCriteria(qualityCriteria)) errors.push(`invalid_case:qualityCriteria ${p}`)
  }

  /* --- safety --- */
  const rawSafety = own(raw, 'safety')
  let safety = null
  if (rawSafety !== undefined) {
    if (!isObject(rawSafety)) {
      errors.push('invalid_case:safety must be an object')
    } else {
      for (const key of Object.keys(rawSafety)) {
        if (!SAFETY_FIELDS.includes(key)) errors.push(`invalid_case:safety.${key} is not a known safety field`)
      }
      const allowed = rawSafety.allowedEntities
      if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.every((s) => typeof s === 'string'))) {
        errors.push('invalid_case:safety.allowedEntities must be an array of strings')
      }
      safety = Object.freeze({
        plantedSecret: typeof rawSafety.plantedSecret === 'string' ? rawSafety.plantedSecret : null,
        allowedEntities: Object.freeze(Array.isArray(allowed) ? [...allowed] : []),
        denyGlobIntent: typeof rawSafety.denyGlobIntent === 'string' ? rawSafety.denyGlobIntent : null,
        knownExposure: typeof rawSafety.knownExposure === 'string' ? rawSafety.knownExposure : null,
      })
    }
  }

  const metadata = own(raw, 'metadata')
  if (metadata !== undefined && !isObject(metadata)) errors.push('invalid_case:metadata must be an object')

  /* --- unknown top-level keys are an error, not slack --- */
  const KNOWN_TOP = new Set([
    'schemaVersion', 'id', 'caseVersion', 'category', 'shapes', 'title', 'rationale', 'harness',
    'task', 'taskIntent', 'files', 'routingInput', 'config', 'expected', 'qualityCriteria',
    'safety', 'metadata',
  ])
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP.has(key)) errors.push(`invalid_case:<root>.${key} is not a known case field`)
  }

  if (errors.length > 0) return { case: null, errors, warnings }

  return {
    case: Object.freeze({
      schemaVersion,
      id,
      caseVersion,
      category,
      categoryBucket,
      shapes: Object.freeze(shapes),
      title: raw.title,
      rationale: raw.rationale,
      harness,
      task: harness === 'dispatch' ? task : null,
      // Explicitly null rather than absent: this module's own rule is that the two must not be
      // two ways of saying the same thing.
      taskIntent:
        harness === 'dispatch' && isObject(taskIntent) ? Object.freeze({ ...taskIntent }) : null,
      files: Object.freeze(files),
      routingInput: Object.freeze(routingInput),
      config: Object.freeze(config === undefined ? {} : config),
      expected,
      qualityCriteria: qualityCriteria === undefined ? null : Object.freeze(qualityCriteria),
      safety,
      metadata: Object.freeze(metadata === undefined ? {} : metadata),
    }),
    errors,
    warnings,
  }
}
