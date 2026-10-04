/**
 * The routing decision engine.
 *
 * `decide(input, config)` answers one question — should this task stay on the primary model, or be
 * delegated to a worker mode — and returns a structured, frozen result. It does not execute the
 * worker, call a provider, register a hook or emit telemetry. Those belong to later layers; this
 * one is a pure function so that the gate's behaviour is a property of a table, not of a session.
 *
 * Four rules govern this file:
 *
 *  1. IT FAILS OPEN. Unconfigured worker, spent budget, sensitive path, malformed config, missing
 *     input, ambiguous classification — every one of them returns `decision: 'allow'` with
 *     `delegate: false`. A broken router must degrade to plain Claude Code, never to a blocked
 *     session. Every branch below has a test named after it.
 *
 *  2. UNKNOWN IS NEVER THE FAVORABLE VALUE. Unknown is spelled `null` and only `null`, because `0`
 *     is a measured zero. Every numeric comparison is written `isKnown(x) && x >= t` rather than
 *     `x >= t`, because `null >= 0` is `true` in JavaScript — that single coercion would let an
 *     unmeasured file count satisfy a breadth floor. Booleans resolve to their pessimistic reading.
 *
 *  3. IT IS DETERMINISTIC. No clock, no randomness, no network, no filesystem, no provider. Worker
 *     availability arrives as an input because the caller owns the readiness probe; importing
 *     `providers/index.mjs` here would put a provider module behind every tool call.
 *
 *  4. THE REASON IS A CODE, AND THE FIRST MATCHING RULE OWNS IT. Rule order is not cosmetic: it is
 *     what makes "why did routing decline 400 times" answerable. See docs/routing.md for the
 *     ordered table and the three tie-break principles behind it.
 */

import { matchesAny, normalizeSlashes, relativeTo, unsupportedSyntax } from './globs.mjs'
import {
  DELEGATABLE_TASK_TYPES,
  LANE_MODE,
  POLICY_VERSION,
  PRECISE_OUTPUTS,
  ROUTING_TASK_TYPES,
  TASK_TYPE_LANE,
  WORKER_UNAVAILABLE_REASONS,
  readPolicy,
} from './routing-policy.mjs'

/* ----------------------------------------------------------------- input shape */

/**
 * Booleans, with the pessimistic reading of "unknown" for each. These are not defaults in the
 * ordinary sense — they are the answer that cannot cause harm when we were not told:
 *
 *   targetedRead     true  — an offset/limit read is intentional; assume it was
 *   fullRead         false — do not assume a whole-file read happened
 *   recentlyEdited   true  — assume Claude needs the exact current bytes
 *   latencySensitive true  — assume someone is waiting
 *   interactive      true  — same
 *   workerAvailable  false — never assume a worker exists
 */
const BOOL_FIELDS = Object.freeze({
  targetedRead: true,
  fullRead: false,
  recentlyEdited: true,
  latencySensitive: true,
  interactive: true,
  workerAvailable: false,
})

/** Counts. Absent or malformed is `null`, which fails every threshold it is compared against. */
const COUNT_FIELDS = Object.freeze(['fileCount', 'lineCount', 'inputBytes', 'estimatedInputTokens'])

/**
 * Which lane a tool name suggests. Advisory only — it never changes a decision, because the set of
 * gated tools is declared in `hooks/hooks.json` and two places deciding that is how a gate starts
 * firing on `Write`.
 */
const TOOL_LANE = Object.freeze({
  Read: 'bulkRead',
  Grep: 'bulkRead',
  Glob: 'bulkRead',
  Bash: 'bulkRead',
  Write: 'codeWrite',
  Edit: 'codeWrite',
  NotebookEdit: 'codeWrite',
})

const MAX_PATHS = 1000
const PATH_MAX_CHARS = 4096
const TOOL_NAME_MAX_CHARS = 128
const REQUESTED_OUTPUT_MAX_CHARS = 64

const isKnown = (v) => v !== null
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Read a key without inheriting one. A caller must not be able to smuggle `__proto__` in. */
const own = (o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined)

/**
 * Normalize an untrusted routing input into the declared sixteen-field shape.
 *
 * Builds a fresh object from the field list and never spreads `raw`, the same defence
 * `projectRecord()` uses on the telemetry side. Numeric strings are NOT parsed: `'350'` becomes
 * `null` plus a warning. String coercion is legitimate only in config's environment layer, where
 * every value arrives as a string by definition; here the caller owns its own payload, and
 * accepting `'0'` or `''` invites a silent surprise.
 *
 * @returns {{input: object, warnings: string[]}}
 */
export function normalizeInput(raw) {
  const warnings = []
  const warn = (code) => warnings.push(code)

  /* task type — closed enum, unrecognized becomes `unknown`, never `general` */
  let taskType = 'unknown'
  const rawTask = own(raw, 'taskType')
  if (rawTask !== undefined && rawTask !== null) {
    if (typeof rawTask !== 'string') warn('type:taskType')
    else if (!ROUTING_TASK_TYPES.includes(rawTask)) warn(`unknown_enum:taskType`)
    else taskType = rawTask
  }

  /* booleans — pessimistic when unknown, warned only when malformed */
  const bools = {}
  const stated = new Set()
  for (const [field, pessimistic] of Object.entries(BOOL_FIELDS)) {
    const v = own(raw, field)
    if (v === undefined || v === null) bools[field] = pessimistic
    else if (typeof v === 'boolean') {
      bools[field] = v
      stated.add(field)
    } else {
      warn(`type:${field}`)
      bools[field] = pessimistic
    }
  }

  /* counts — null when unknown or malformed, so every comparison against them is false */
  const counts = {}
  for (const field of COUNT_FIELDS) {
    const v = own(raw, field)
    if (v === undefined || v === null) counts[field] = null
    else if (isCount(v)) counts[field] = v === 0 ? 0 : v // folds -0
    else {
      warn(`type:${field}`)
      counts[field] = null
    }
  }

  /* strings */
  const toolName = clampedString(own(raw, 'toolName'), TOOL_NAME_MAX_CHARS, 'toolName', warn)
  const requestedOutputRaw = clampedString(
    own(raw, 'requestedOutput'),
    REQUESTED_OUTPUT_MAX_CHARS,
    'requestedOutput',
    warn,
  )
  const requestedOutput = requestedOutputRaw === null ? null : requestedOutputRaw.trim().toLowerCase()

  let projectPath = null
  const rawProject = own(raw, 'projectPath')
  if (rawProject !== undefined && rawProject !== null) {
    if (typeof rawProject !== 'string') warn('type:projectPath')
    else projectPath = normalizeSlashes(rawProject) || null
  }

  /* paths — the corpus the gate can actually prove */
  let paths = []
  const rawPaths = own(raw, 'paths')
  if (rawPaths !== undefined && rawPaths !== null) {
    if (!Array.isArray(rawPaths)) warn('type:paths')
    else {
      const kept = []
      let dropped = false
      for (const p of rawPaths) {
        if (typeof p !== 'string' || p === '') {
          dropped = true
          continue
        }
        const n = normalizeSlashes(p.slice(0, PATH_MAX_CHARS))
        if (n !== '') kept.push(n)
        else dropped = true
      }
      if (dropped) warn('type:paths')
      if (kept.length > MAX_PATHS) warn('clamped:paths')
      paths = kept.slice(0, MAX_PATHS)
    }
  }

  /* why the worker is unavailable — a label the caller supplies, validated here */
  let workerUnavailableReason = null
  const rawWhy = own(raw, 'workerUnavailableReason')
  if (rawWhy !== undefined && rawWhy !== null) {
    if (WORKER_UNAVAILABLE_REASONS.includes(rawWhy)) workerUnavailableReason = rawWhy
    else warn('unknown_enum:workerUnavailableReason')
  }

  /* coherence — a contradiction resolves to its pessimistic side, deterministically.
   * Only two ASSERTIONS can contradict each other. `targetedRead` reads as true when unknown, so
   * testing the resolved values would make a caller who states `fullRead: true` and says nothing
   * about targeting look self-contradictory when they were merely incomplete. */
  if (stated.has('targetedRead') && stated.has('fullRead') && bools.targetedRead && bools.fullRead) {
    bools.fullRead = false
    warn('incoherent:read_shape')
  }
  const lane = TASK_TYPE_LANE[taskType]
  if (toolName !== null && TOOL_LANE[toolName] !== undefined && lane !== undefined) {
    if (TOOL_LANE[toolName] !== lane) warn('incoherent:tool_for_task')
  }

  const input = Object.freeze({
    taskType,
    toolName,
    fileCount: counts.fileCount,
    lineCount: counts.lineCount,
    inputBytes: counts.inputBytes,
    estimatedInputTokens: counts.estimatedInputTokens,
    targetedRead: bools.targetedRead,
    fullRead: bools.fullRead,
    recentlyEdited: bools.recentlyEdited,
    latencySensitive: bools.latencySensitive,
    interactive: bools.interactive,
    requestedOutput,
    paths: Object.freeze(paths),
    projectPath,
    workerAvailable: bools.workerAvailable,
    workerUnavailableReason,
  })

  return { input, warnings }
}

function clampedString(v, max, field, warn) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') {
    warn(`type:${field}`)
    return null
  }
  return v.length > max ? v.slice(0, max) : v
}

/* ---------------------------------------------------------------------- decide */

/**
 * The routing decision.
 *
 * @param {object} rawInput  Facts about the tool call. See normalizeInput for the contract.
 * @param {object} config    A resolved config object, as `loadConfig()` returns.
 * @returns {Readonly<{decision: string, delegate: boolean, mode: string|null, lane: string|null,
 *   reason: string, taskType: string, estimatedInputTokens: number|null, policyVersion: number,
 *   inputWarnings: ReadonlyArray<string>}>}
 */
export function decide(rawInput, config) {
  const { input, warnings: inputWarnings } = normalizeInput(rawInput)
  const { policy, warnings: policyWarnings } = readPolicy(config)

  const codes = [...inputWarnings, ...policyWarnings]
  for (const pattern of policy.usable ? [...policy.denyGlobs, ...policy.allowGlobs] : []) {
    // A pattern this matcher does not implement is matched literally, which usually means it
    // matches nothing. Silence there would be a safety hole with no symptom.
    if (unsupportedSyntax(pattern)) codes.push('unsupported_glob_syntax')
  }

  const build = (fields) =>
    Object.freeze({
      decision: fields.decision,
      delegate: fields.delegate,
      mode: fields.mode,
      lane: fields.lane,
      reason: fields.reason,
      taskType: input.taskType,
      estimatedInputTokens: input.estimatedInputTokens,
      policyVersion: POLICY_VERSION,
      inputWarnings: Object.freeze([...new Set(codes)].sort()),
    })

  /** Every refusal looks the same from the hook's side: the tool call proceeds untouched. */
  const primary = (reason, lane = null) =>
    build({ decision: 'allow', delegate: false, mode: null, lane, reason })

  /* 1. the developer's own off-switch, and any config we cannot trust, outrank every opinion
   *    below — and stopping here means no rule ever reads a threshold off a malformed object. */
  if (!policy.usable || policy.enabled !== true) return primary('disabled')

  /* 2a. ambiguous classification is not permission to delegate */
  if (input.taskType === 'unknown') return primary('unknown_input')

  /* 2b. the refusal list: debugging, architecture, security, precise edits and anything
   *     unclassified stay with Claude. This is an allowlist check, so a task type added later is
   *     refused until someone deliberately permits it. */
  const lane = TASK_TYPE_LANE[input.taskType]
  if (!DELEGATABLE_TASK_TYPES.includes(input.taskType) || lane === undefined) {
    return primary('task_type_excluded')
  }

  const laneConfig = policy.lanes[lane]
  if (laneConfig === undefined) return primary('disabled')

  /* 3. the lane's own off-switch. `enforce: 'off'` is reported as `allow` + `disabled` rather
   *    than a decision value of `off`, so a hook only ever sees an action it can take. */
  if (laneConfig.enabled !== true || laneConfig.enforce === 'off') return primary('disabled', lane)

  /* 4-5. someone is waiting. A worker hop costs latency that an interactive turn cannot spend. */
  if (input.interactive === true) return primary('interactive', lane)
  if (input.latencySensitive === true) return primary('latency_sensitive', lane)

  /* 6. "give me a patch" means exact bytes, which is never worker work */
  if (input.requestedOutput !== null && PRECISE_OUTPUTS.includes(input.requestedOutput)) {
    return primary('precise_output_requested', lane)
  }

  /* 7-8. the two never-delegate switches, each gated on its own config flag */
  if (policy.neverDelegate.onTargetedRead && input.targetedRead === true) {
    return primary('targeted_read', lane)
  }
  if (policy.neverDelegate.onRecentlyEdited && input.recentlyEdited === true) {
    return primary('recently_edited', lane)
  }

  /* 9. a sensitive path must not be delegated even to a ready worker, and it must report
   *    `deny_glob` rather than a sizing reason — otherwise nobody can tell whether the deny list
   *    is doing anything. All-or-nothing: per-file filtering of a corpus is the payload builder's
   *    job, not the gate's. */
  for (const p of input.paths) {
    // Each path is offered in both spellings — as given, and relative to the project root — so a
    // pattern like `src/**` works without a leading `**` segment and an absolute path still
    // matches `**/.env`. The order is fixed, so the pattern a decision blames is deterministic.
    const forms = [p]
    const relative = relativeTo(input.projectPath, p)
    if (relative !== null) forms.push(relative)

    const denied = forms.some((f) => matchesAny(policy.denyGlobs, f) !== null)
    if (!denied) continue
    const rescued = forms.some((f) => matchesAny(policy.allowGlobs, f) !== null)
    if (!rescued) return primary('deny_glob', lane)
  }

  /* 10. the deny check's "I could not run" case. If files are claimed but none are named, the
   *     corpus cannot be proven clean, and unknown is never favorable. */
  if (laneConfig.sized && isKnown(input.fileCount) && input.fileCount >= 1 && input.paths.length === 0) {
    return primary('unknown_input', lane)
  }

  /* 11. global unavailability outranks per-request sizing, so a keyless install reports
   *     `worker_not_ready` on every read instead of a misleading `below_threshold`. The caller
   *     labels WHY; the engine never reads a ledger or probes a provider. */
  if (input.workerAvailable !== true) {
    return primary(input.workerUnavailableReason ?? 'worker_not_ready', lane)
  }

  /* 12-14. sizing, for the one lane that has a corpus to measure. A lane with no thresholds
   *        skips straight to the decision; see routing-policy.mjs on why codeWrite has none. */
  if (laneConfig.sized) {
    if (isKnown(input.fileCount) && input.fileCount > laneConfig.maxFiles) {
      return primary('over_max_files', lane)
    }
    if (isKnown(input.inputBytes) && input.inputBytes > policy.workerMaxInputBytes) {
      return primary('over_max_input_bytes', lane)
    }
    if (!thresholdMet(input, laneConfig)) return primary('below_threshold', lane)
  }

  /* 15. delegate. `enforce` is already known not to be `off`, so this is deny | ask | suggest. */
  return build({
    decision: laneConfig.enforce,
    delegate: true,
    mode: LANE_MODE[lane] ?? null,
    lane,
    reason: 'threshold_met',
  })
}

/**
 * Is the payload worth delegating?
 *
 * OR across the three size proxies, AND across the categories. `minLines`, `minBytes` and
 * `minEstimatedTokens` are three proxies for ONE quantity — "is this payload big enough that a
 * worker hop pays for itself" — so any one of them answering yes is enough. AND would be more
 * conservative in isolation, but combined with "unknown never satisfies" it would hand control to
 * whichever proxy is least often measured: a Grep across ten files has no line count, and AND
 * would turn that into a permanent refusal. OR is the only semantics under which adding a proxy
 * widens coverage instead of silently narrowing it.
 *
 * `minFiles` (is this a multi-file question), `maxFiles` (a safety cap) and the size question are
 * different quantities rather than proxies for one, so they AND.
 */
function thresholdMet(input, lane) {
  const sizeSatisfied =
    (isKnown(input.lineCount) && input.lineCount >= lane.minLines) ||
    (isKnown(input.inputBytes) && input.inputBytes >= lane.minBytes) ||
    (isKnown(input.estimatedInputTokens) &&
      isKnown(lane.minEstimatedTokens) &&
      input.estimatedInputTokens >= lane.minEstimatedTokens)

  // An unknown file count fails the floor AND the cap. Unknown is not favorable in either
  // direction, and `null >= 1` would otherwise be true.
  const breadthSatisfied = isKnown(input.fileCount) && input.fileCount >= lane.minFiles
  const capRespected = isKnown(input.fileCount) && input.fileCount <= lane.maxFiles

  return sizeSatisfied && breadthSatisfied && capRespected
}

export {
  DECIDE_REASONS,
  DELEGATABLE_TASK_TYPES,
  ENFORCEMENTS,
  LANE_MODE,
  POLICY_VERSION,
  PRECISE_OUTPUTS,
  ROUTING_TASK_TYPES,
  TASK_TYPE_LANE,
  readPolicy,
} from './routing-policy.mjs'
