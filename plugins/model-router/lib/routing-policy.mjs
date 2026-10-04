/**
 * The routing vocabulary, and the one place that reads the shape of `config.routing`.
 *
 * This file holds no branches of its own. It exists so that `routing.mjs` evaluates its rule
 * table against a flat, already-validated snapshot and can never write `config?.routing?.bulkRead
 * ?.minLines ?? 350` inline. A second copy of a default is exactly the drift that the SPEC and
 * DEFAULTS parity tests in `config.mjs` exist to prevent, and an inline `??` would reintroduce it
 * one expression at a time.
 *
 * TWO AXES, ONE OBJECT. A routing result answers two different questions and they must not be
 * conflated:
 *
 *   `delegate`  — the POLICY answer: should a worker do this work?
 *   `decision`  — the ENFORCEMENT answer: what does the PreToolUse hook do to THIS tool call?
 *
 * `decision` owns the repo's existing gate vocabulary because three artifacts already pin it:
 * CLAUDE.md's second non-negotiable, README's gate diagram, and the frozen `ROUTING_DECISIONS`
 * enum in `lib/telemetry/record.mjs`. That makes the mapping to telemetry an assignment rather
 * than a translation, and a translation layer is a place for two vocabularies to drift apart.
 *
 * Pure: no builtin import, no clock, no I/O, no randomness. A test asserts all of that.
 */

/**
 * Bumped when the rule table or a reason's meaning changes, so a stored decision can be read
 * against the policy that produced it. Independent of SCHEMA_VERSION and CALC_VERSION.
 */
export const POLICY_VERSION = 1

/* ------------------------------------------------------------------------ enums */

/**
 * What kind of work was asked for. This is an INPUT taxonomy and is deliberately NOT the
 * telemetry `task_type` enum, which is an EVENT taxonomy ("what kind of row is this") whose value
 * for a gate decision is `gate_block`. They overlap on exactly the two delegatable lanes, and a
 * test pins that those two spellings still agree.
 *
 * Closed on write, unlike the telemetry record enums. An open enum on a security input would let
 * a typo'd `architecure` fall straight past the exclusion list; an unrecognized value becomes
 * `unknown`, which the rule table then refuses.
 */
export const ROUTING_TASK_TYPES = Object.freeze([
  'bulk_read',
  'code_write',
  'debugging',
  'architecture',
  'security',
  'precise_edit',
  'general',
  'unknown',
])

/**
 * An ALLOWLIST, not a denylist. A task type added later is non-delegatable until someone
 * deliberately adds it here, so the failure mode of forgetting is a refusal rather than a leak.
 * `general` is absent on purpose: if unclassified work were delegatable, every task the caller
 * could not label would land in the delegating bucket.
 */
export const DELEGATABLE_TASK_TYPES = Object.freeze(['bulk_read', 'code_write'])

/** Which config block rules a task type. Keys must equal DELEGATABLE_TASK_TYPES. */
export const TASK_TYPE_LANE = Object.freeze({ bulk_read: 'bulkRead', code_write: 'codeWrite' })

/**
 * The worker mode a delegated lane names.
 *
 * These were intended to equal the names of shipped delegation skills. No such skill ships, so
 * today they are the mode identifiers `dispatch/modes.mjs` resolves a prompt from, and nothing
 * outside this repository depends on the spelling.
 */
export const LANE_MODE = Object.freeze({ bulkRead: 'bulk-reader', codeWrite: 'code-writer' })

/**
 * Everything `decide()` can put in `decision`. Note `off`, `delegated` and `not_applicable` are
 * in the telemetry enum but NOT here: they describe rows the delegation script writes, not actions
 * a hook can take. A hook written as `if (d.decision === 'allow') proceed` must never be
 * surprised, so a lane configured `enforce: 'off'` returns `allow` with reason `disabled` and the
 * nuance lives in the reason code, where this repo puts nuance.
 */
export const ENFORCEMENTS = Object.freeze(['allow', 'deny', 'ask', 'suggest'])

/** A requested output shape that means "exact bytes", which is never worker work. */
export const PRECISE_OUTPUTS = Object.freeze(['edit', 'patch', 'diff', 'inline_edit', 'exact'])

/**
 * The closed subset of `ROUTING_REASONS` that `decide()` can ever return. Two tests pin it: that
 * it is a subset of the telemetry enum, and that every member is REACHABLE by some input — the
 * completeness check that catches a rule written and then shadowed by an earlier one.
 *
 * `allow_glob` is intentionally absent: an allow-glob rescue that ends in delegation reports
 * `threshold_met`, and the per-file allow record belongs to the payload builder, not the gate.
 */
export const DECIDE_REASONS = Object.freeze([
  'disabled',
  'unknown_input',
  'task_type_excluded',
  'interactive',
  'latency_sensitive',
  'precise_output_requested',
  'targeted_read',
  'recently_edited',
  'deny_glob',
  'worker_not_ready',
  'budget_exceeded',
  'over_max_files',
  'over_max_input_bytes',
  'below_threshold',
  'threshold_met',
])

/** Labels the caller may attach to an unavailable worker. Anything else degrades to the first. */
export const WORKER_UNAVAILABLE_REASONS = Object.freeze(['worker_not_ready', 'budget_exceeded'])

/** Threshold leaves the bulkRead lane needs. Every one must be present and well-typed. */
const BULK_READ_INTS = Object.freeze(['minLines', 'minBytes', 'minFiles', 'maxFiles'])

/* ---------------------------------------------------------------------- helpers */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A count we can compare against. Rejects NaN, Infinity, fractions, negatives and strings. */
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')

/* ------------------------------------------------------------------- readPolicy */

/**
 * Flatten `config` into the snapshot the rule table reads.
 *
 * Deliberately does NOT supply a missing default. The config layer already guarantees every SPEC
 * leaf is present and in range by the time `loadConfig()` returns, so a leaf that is missing or
 * wrong-typed here means the caller handed us something that never went through `resolveConfig`.
 * That is the "malformed config" case from CLAUDE.md's second non-negotiable, and the required
 * behaviour is to fail open — so the snapshot is marked unusable and the rule table stops at
 * `disabled` rather than guessing a threshold.
 *
 * @returns {{policy: object, warnings: string[]}}
 */
export function readPolicy(config) {
  const warnings = []
  const unusable = (reason) => {
    warnings.push(`invalid_config:${reason}`)
    return { policy: Object.freeze({ usable: false, enabled: false }), warnings }
  }

  if (!isPlainObject(config)) return unusable('<root>')
  const routing = config.routing
  if (!isPlainObject(routing)) return unusable('routing')
  if (typeof config.enabled !== 'boolean') return unusable('enabled')

  const worker = config.worker
  // Enforced as a hard requirement rather than an optional cap: a gate that blocks a read the
  // worker provably cannot ingest produces the worst outcome in the system — a blocked read and
  // no answer — so the ceiling has to be knowable before any delegation is allowed.
  if (!isPlainObject(worker) || !isCount(worker.maxInputBytes) || worker.maxInputBytes < 1) {
    return unusable('worker.maxInputBytes')
  }

  const bulkRead = routing.bulkRead
  const codeWrite = routing.codeWrite
  const neverDelegate = routing.neverDelegate
  if (!isPlainObject(bulkRead)) return unusable('routing.bulkRead')
  if (!isPlainObject(codeWrite)) return unusable('routing.codeWrite')
  if (!isPlainObject(neverDelegate)) return unusable('routing.neverDelegate')

  for (const key of BULK_READ_INTS) {
    if (!isCount(bulkRead[key]) || bulkRead[key] < 1) return unusable(`routing.bulkRead.${key}`)
  }
  // null is the shipped default and means "this proxy is off", so it is valid; 0 is not, because
  // it would make the proxy satisfy for any known token count at all.
  const met = bulkRead.minEstimatedTokens
  if (met !== null && (!isCount(met) || met < 1)) return unusable('routing.bulkRead.minEstimatedTokens')

  for (const [block, key] of [[bulkRead, 'bulkRead'], [codeWrite, 'codeWrite']]) {
    if (typeof block.enabled !== 'boolean') return unusable(`routing.${key}.enabled`)
    if (!ENFORCEMENTS.includes(block.enforce) && block.enforce !== 'off') {
      return unusable(`routing.${key}.enforce`)
    }
  }
  if (typeof neverDelegate.onTargetedRead !== 'boolean') return unusable('routing.neverDelegate.onTargetedRead')
  if (typeof neverDelegate.onRecentlyEdited !== 'boolean') return unusable('routing.neverDelegate.onRecentlyEdited')
  if (!isStringArray(routing.denyGlobs)) return unusable('routing.denyGlobs')
  if (!isStringArray(routing.allowGlobs)) return unusable('routing.allowGlobs')

  const policy = Object.freeze({
    usable: true,
    enabled: config.enabled,
    workerMaxInputBytes: worker.maxInputBytes,
    denyGlobs: Object.freeze([...routing.denyGlobs]),
    allowGlobs: Object.freeze([...routing.allowGlobs]),
    neverDelegate: Object.freeze({
      onTargetedRead: neverDelegate.onTargetedRead,
      onRecentlyEdited: neverDelegate.onRecentlyEdited,
    }),
    lanes: Object.freeze({
      bulkRead: Object.freeze({
        enabled: bulkRead.enabled,
        enforce: bulkRead.enforce,
        minLines: bulkRead.minLines,
        minBytes: bulkRead.minBytes,
        minEstimatedTokens: met,
        minFiles: bulkRead.minFiles,
        maxFiles: bulkRead.maxFiles,
        // The lane measures a corpus that exists, so it is the only lane with size thresholds.
        sized: true,
      }),
      codeWrite: Object.freeze({
        enabled: codeWrite.enabled,
        enforce: codeWrite.enforce,
        // A hook cannot measure code that has not been written yet, so there is nothing to
        // threshold. Advisory enforcement is what keeps this safe, not a size check.
        sized: false,
      }),
    }),
  })

  return { policy, warnings }
}
