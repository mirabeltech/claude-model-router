/**
 * The per-case metrics record.
 *
 * ONE DESIGN DECISION GOVERNS THIS FILE: an eval row IS a telemetry event, produced by the shipped
 * `buildEvent()`. Nothing here computes a token, a cost or a saving.
 *
 *   > The eval reuses the shipped math; it never recomputes savings.
 *
 * Three consequences, all of them load-bearing:
 *
 *   1. Every null rule, status rule and structural zero in `calc.mjs` applies to a benchmark number
 *      for free, and cannot drift from what the plugin writes at runtime.
 *   2. `aggregate()` gates on `KNOWN_SCHEMA_VERSIONS.has(row.schema_version)`, so a hand-rolled
 *      row would be counted as `rowsIncompatible` and silently dropped from every total. A
 *      `buildEvent` row is the only shape the reader will accept.
 *   3. `buildEvent` is pure given `now` and `eventId`, so the record is reproducible.
 *
 * `emitEvent()` IS NEVER CALLED. It opens a sink, creates a salt file and appends to the user's
 * production store; the eval writes its own artifacts instead. `evals.isolation.test.mjs` asserts
 * no module under `test/evals/` imports `telemetry/index.mjs`, `telemetry/identity.mjs` or
 * `telemetry/jsonl.mjs`.
 *
 * THE FOUR-CASE SWITCH. `buildEvent` derives `status` from the PRESENCE of `result`
 * (`error ? 'error' : result ? 'ok' : 'skipped'`), so `result` is a three-valued switch rather
 * than a payload. Pass it wrong and the row is quietly a different kind of row.
 *
 *   delegated, worker ok     result = the dispatch result, error = null,    taskType bulk_read
 *   delegated, worker error  result = null,                error = r.error, taskType bulk_read
 *   gate refusal             result = null,                error = null,    taskType gate_block
 *   gate said delegate, no
 *   worker was ever asked    result = null,                error = null,    taskType other
 *
 * THE FOURTH ROW IS NOT A BUG, and working that out cost a thrown error. A `decide`-harness case
 * exists precisely to stop at the gate: it measures a routing decision and deliberately runs no
 * worker. So "the gate said delegate and nothing was dispatched" is a real, honest state — but it
 * is NOT a delegation, so it must not wear `bulk_read`, and the gate did not block it, so it must
 * not wear `gate_block` either. `other` is the truthful label, `status` is `skipped`, `corpusChars`
 * is null, and every savings column therefore comes back `unavailable` on its own. The row
 * describes what happened without claiming a worker ran.
 *
 * What genuinely cannot happen is a DISPATCH case in that state, and `buildEvalRow` still throws
 * for it: there the worker was supposed to run, so a missing result is a framework bug.
 *
 * AND THE RULE THAT MATTERS MOST: there is no `?? 0` in this file, anywhere. `validate.mjs` passes
 * a literal zero straight through and `calc.mjs`'s `count(0)` is `0`, so a defaulted zero does not
 * fail loudly — it publishes a fabricated measurement. The three that overstate savings are
 * `returnedAnswerChars`, `returnedAnswerTokens` and `corpusChars`; `evals.nulls.test.mjs` has a row
 * for each.
 */

import { buildEvent } from '../../plugins/model-router/lib/telemetry/event.mjs'
import { routingReasonFor } from '../../plugins/model-router/lib/hook/event.mjs'
import { eventIdFor } from './determinism.mjs'

/**
 * All-null identity, as a frozen literal.
 *
 * `buildIdentity()` is deliberately not called, for three independent reasons:
 *
 *   1. It CREATES A FILE — `readOrCreateSalt` does `mkdirSync` plus `writeFileSync`.
 *   2. It would create it in the wrong place. `identity.mjs` reads
 *      `telemetry.dirResolved ?? telemetry.dir ?? '.'`, and `resolveConfig` never sets
 *      `dirResolved` — only `loadConfig` grafts it on. So with an eval-built config the salt path
 *      is the literal string `~/.claude/model-router/telemetry/.salt`, a RELATIVE path containing
 *      a `~`, created under the current working directory. That pollutes the repo.
 *   3. A real salt makes `session_id` and `project_id` machine-dependent, which defeats the
 *      comparability the whole artifact exists for.
 *
 * All-null is also consistent with the `privacy_level: 'hashed'` the row stamps, which a raw
 * `session_id: 'eval'` would contradict. The case id travels in `task_id`, which is plain text.
 */
export const EVAL_IDENTITY = Object.freeze({ session_id: null, project_id: null, project_path: null })

/**
 * Map a case plus its outcome onto `buildEvent` inputs.
 *
 * Generalises the three fields `hook/event.mjs toEventInputs()` hardcodes to `1 / 1 / 0`, because
 * a corpus case may carry up to twenty-five files. `evals.row.test.mjs` pins this against
 * `toEventInputs` on the single-file case so the two mappings cannot drift.
 *
 * @param {object} a.caseDef
 * @param {object} a.decision        a `decide()` result
 * @param {object|null} a.result     a `dispatch()` result, or null
 * @param {number|null} a.corpusChars  characters actually sent; NULL when no payload was built
 * @param {number|null} a.inputBytes   a real stat; NULL on failure, never 0
 * @param {string|null} a.taskIntentSource  which variant built the worker task, else null
 */
export function toEvalEventInputs({
  caseDef,
  decision,
  result = null,
  corpusChars = null,
  inputBytes = null,
  taskIntentSource = null,
}) {
  const dispatched = result !== null && result.executed === true && result.status === 'ok'
  const failed = result !== null && result.status === 'error'

  // The gate said delegate and no worker was asked. See the header: `other`, not `bulk_read` (no
  // delegation occurred) and not `gate_block` (nothing was blocked).
  const observedOnly = result === null && decision.delegate === true

  // `files_count` and `proven_files_count` are the corpus's declared files, and they are equal
  // because every file was named by the case and verified against the disk at load. If they ever
  // diverge, `calculateAvoidedTokens` refuses with `proven_filter_not_applied` rather than
  // publishing an inflated corpus — the single largest over-claim risk in the model.
  const filesCount = caseDef.files.length === 0 ? null : caseDef.files.length

  return {
    taskId: caseDef.id,
    taskType: dispatched || failed ? 'bulk_read' : observedOnly ? 'other' : 'gate_block',
    routingDecision: decision.decision,
    routingReason: routingReasonFor(decision, result),
    policyVersion: decision.policyVersion,
    promptVersion: result?.promptVersion ?? null,
    // Mirrors the hook mapping: the source only means something on a row that made a request.
    taskIntentSource: dispatched || failed ? taskIntentSource : null,
    extraValidationCodes: decision.inputWarnings,

    providerId: result?.provider ?? null,

    // The switch. `result` only on the ok path, because `buildEvent` reads its presence as "a call
    // succeeded" — handing it a failed result would stamp `status: 'ok'` on an error row.
    result: dispatched ? result : null,
    error: failed ? result.error : null,
    capabilities: result?.capabilities ?? null,
    // Mirrors lib/hook/event.mjs: recorded on every dispatched path, including a refusal, so an
    // eval row explains its own context verdict. evals.row.test.mjs pins this against the
    // production mapping.
    contextBudget: result?.contextBudget ?? null,
    contextTruncation: result?.contextTruncation ?? null,
    attempts: result?.attempts ?? null,
    latencyMs: result?.latencyMs ?? null,

    filesCount,
    provenFilesCount: filesCount,
    filesInferredCount: filesCount === null ? null : 0,
    inputBytes,

    // Null on any path that did not assemble a payload. A zero here would make
    // `calculateAvoidedTokens` return `{value: 0, status: 'estimated'}` — a measured zero where
    // the truth is `unavailable`.
    corpusChars,

    // Left null deliberately so `buildEvent` derives the answer size from `result.text` with the
    // SAME method it used for the corpus. Supplying a number risks a mixed-method subtraction;
    // supplying 0 publishes the gross figure under the net label.
    returnedAnswerChars: null,
    returnedAnswerTokens: null,

    // Not supplied: `charsPerToken` would claim a calibration nobody measured, and
    // `workerPromptTokens` / `countedTokens` belong to avoided-methods this arm does not use.
    charsPerToken: null,
    workerPromptTokens: null,
    countedTokens: null,

    questionText: null,

    // The primary arm is structurally unmeasured: there is no transcript reader, so
    // `primary_usage_status` is `unavailable` and all six primary fields are null. Supplying
    // `primaryUsage` with method `none` would produce all-null fields with NO warning code, so
    // that combination is asserted never to be constructed rather than merely avoided.
    primaryUsage: null,
    primaryUsageMethod: 'none',
  }
}

/**
 * Build one metrics row.
 *
 * @param {object} a.caseDef
 * @param {object} a.decision
 * @param {object|null} a.result
 * @param {object} a.config
 * @param {Array} a.pricingChain
 * @param {number|null} a.corpusChars
 * @param {number|null} a.inputBytes
 * @param {string|null} [a.taskIntentSource]
 * @param {number} a.now
 * @param {string} a.runSeed
 * @param {string} [a.eventIdSuffix]  distinguishes the rows of one case across sweep thresholds
 * @returns {object} the flat event
 */
export function buildEvalRow({
  caseDef,
  decision,
  result = null,
  config,
  pricingChain,
  corpusChars = null,
  inputBytes = null,
  taskIntentSource = null,
  now,
  runSeed,
  eventIdSuffix = '',
}) {
  // Scoped to the dispatch layer deliberately. A `decide`-harness case that delegates is a
  // legitimate `other` row (see the header); a DISPATCH case without a result is not, because
  // that layer's whole job is to run the worker.
  if (caseDef.harness === 'dispatch' && decision.delegate === true && result === null) {
    throw new Error(
      `buildEvalRow: dispatch case ${caseDef.id} delegated but has no dispatch result. ` +
        'A dispatch case is supposed to run the worker, so a missing result is a framework bug, ' +
        'not a routing outcome.',
    )
  }

  return buildEvent({
    config,
    identity: EVAL_IDENTITY,
    pricingChain,
    ...toEvalEventInputs({ caseDef, decision, result, corpusChars, inputBytes, taskIntentSource }),
    now,
    eventId: eventIdFor(`${caseDef.id}${eventIdSuffix}`, runSeed),
  })
}
