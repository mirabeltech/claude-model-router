/**
 * The orchestrator: one hook invocation, start to finish.
 *
 * It owns the ORDER of operations and nothing else. The protocol translation is in adapter.mjs,
 * the measurements are in facts.mjs, the telemetry mapping is in event.mjs, the decision is
 * `decide()`'s and the worker call is `dispatch()`'s. Nothing here re-implements any of them —
 * there is no threshold, no glob, no provider branch and no prompt in this file.
 *
 * Two invariants hold on every path:
 *
 *   1. The function returns a response or null. It NEVER throws, and null means "write nothing",
 *      which is how Claude Code is told to run the original Read.
 *   2. The response is decided BEFORE the telemetry row is written, and writing the row cannot
 *      change it. A failure to measure must never become a failure to read a file.
 *
 * THREE DECISIONS, IN THIS ORDER, AND THE ORDER IS THE DESIGN:
 *
 *   routing      `decide()`        would this task be APPROPRIATE to delegate?
 *   governance   `checkBudget()`   are we currently ALLOWED to delegate?
 *   capability   inside dispatch   CAN this worker safely execute this request?
 *
 * Governance sits after routing and before the file is read, which means a budget refusal costs
 * no file read, no transcript read and no worker call. It is deliberately NOT folded into the
 * gate: `decide()` stays a pure function of the tool call with no ledger behind it, and the row
 * records both whether the read was delegate-worthy AND whether the budget allowed it. Collapsing
 * the two would leave "why did this not delegate" with only half an answer.
 */

import fsDefault from 'node:fs'

import { decide as decideDefault } from '../routing.mjs'
import { routingEnabled } from '../config.mjs'
import { estimateTokensFromBytes } from '../context-budget.mjs'
import { dispatch as dispatchDefault } from '../dispatch/index.mjs'
import { checkBudget, finalizeBudget } from '../governance/index.mjs'
import { emitEvent as emitEventDefault, priceWorkerUsage } from '../telemetry/index.mjs'
import { buildWorkerTask } from '../dispatch/task.mjs'
import {
  BULK_READ_TASK,
  buildDelegatedResponse,
  filePathOf,
  normalizeTaskIntent,
  parseHookPayload,
  toRoutingInput,
} from './adapter.mjs'
import { fileBytes, readTextContent, recentlyEdited, workerAvailability } from './facts.mjs'
import { extractTaskIntent } from './intent.mjs'
import { describeVerification, verifySummary } from '../verify/summary.mjs'
import { toEventInputs } from './event.mjs'

/**
 * Verify one tier's answer against the file, or return null when verification is off.
 *
 * Wrapped, because a verifier that threw would break a hook and CLAUDE.md's third rule does not
 * care that this one is pure. A throw falls back to the pre-verification behaviour: no verdict,
 * so no escalation and no caveat.
 */
function verifyAnswer(result, config, filePath, content) {
  if (config?.verify?.enabled === false) return null
  try {
    return verifySummary({
      answer: result.text,
      files: [{ path: filePath, content }],
      maxUngroundedRatio: config?.verify?.maxUngroundedIdentifierRatio ?? 0.25,
    })
  } catch {
    return null
  }
}

/** Every way this can end. Returned for tests and for the doctor's self-check, never printed. */
export const OUTCOMES = Object.freeze([
  'hooks_disabled',
  'routing_disabled',
  // The worker answered, and its claims about the file did not check out. The answer is thrown
  // away and the developer gets the ordinary Read — see lib/verify/summary.mjs for why that is
  // the cheap mistake rather than the expensive one.
  'summary_unverified',
  'empty_stdin',
  'unparseable_stdin',
  'not_an_object',
  'wrong_event',
  'wrong_tool',
  'no_tool_input',
  'no_file_path',
  'routing_threw',
  'not_delegated',
  'not_enforced',
  'governance_denied',
  'content_unreadable',
  'content_binary',
  'worker_failed',
  'empty_answer',
  'delegated',
  'hook_threw',
])

/**
 * Run the hook.
 *
 * @param {object}      a.raw            the bytes read from stdin
 * @param {object}      a.config         a resolved config, as `loadConfig()` returns
 * @param {object}      [a.env]
 * @param {object}      [a.fs]           injected for tests
 * @param {Function}    [a.decideImpl]   injected for tests; the gate is specified never to throw,
 *                                       and the seam exists to prove the wrapper around it works
 * @param {Function}    [a.dispatchImpl] injected for tests
 * @param {Function}    [a.emit]         injected for tests; must never throw
 * @returns {Promise<{response: object|null, outcome: string, decision: object|null,
 *                    result: object|null, wrote: object|null}>}
 */
export async function runReadHook({
  raw,
  config,
  env = process.env,
  fs = fsDefault,
  decideImpl = decideDefault,
  dispatchImpl = dispatchDefault,
  emit = emitEventDefault,
}) {
  /** Ends the invocation without a decision, and therefore without a row. */
  const bail = (outcome) => ({ response: null, outcome, decision: null, result: null, wrote: null })

  try {
    // The developer's own off-switches come first, so a disabled plugin costs one object read and
    // does not write a row about work it declined to consider.
    if (config?.hooks?.enabled !== true) return bail('hooks_disabled')
    if (!routingEnabled(config)) return bail('routing_disabled')

    const parsed = parseHookPayload(raw)
    if (!parsed.ok) return bail(parsed.reason)
    const payload = parsed.payload
    const filePath = filePathOf(payload)

    /* ---- facts. Metadata only: no file content is read to reach a decision. ---- */

    // The reservation key, and the same id `toEventInputs()` writes as `task_id`. Claude Code's
    // own id for the tool call is unique per call and carries no file or prompt content, which
    // makes it the one identifier a budget ledger may safely hold. Without it a reservation
    // cannot be settled idempotently, so an id-less payload is simply never reserved.
    const taskId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null

    const availability = workerAvailability(config, env)
    const facts = {
      inputBytes: fileBytes(filePath, { fs }),
      recentlyEdited: recentlyEdited(payload.transcript_path, filePath, { fs }),
      workerAvailable: availability.workerAvailable,
      workerUnavailableReason: availability.workerUnavailableReason,
    }

    /* ---- the decision. Once, synchronously, from facts alone. ---- */

    let decision
    try {
      decision = decideImpl(toRoutingInput({ payload, facts, env }), config)
    } catch {
      // decide() is specified never to throw. Wrapped anyway: the cost of being wrong about that
      // is a broken session, and the cost of the wrapper is nothing.
      return bail('routing_threw')
    }

    /** Write the row. Last thing on every path that reached a decision, and never load-bearing. */
    const record = (
      outcome,
      {
        result = null,
        corpusChars = null,
        task = null,
        intentSource = null,
        governance = null,
        verification = null,
        escalation = null,
      } = {},
    ) => {
      // A SUSPECT SUMMARY IS NOT SUBSTITUTED when the operator asked for `discard`: the response
      // is null, which is the same fall-open every other failure path produces, and the developer
      // gets their own Read. `warn` substitutes it and appends a caveat naming what failed.
      const discarded = outcome === 'summary_unverified'
      const response =
        result && result.status === 'ok' && !discarded
          ? buildDelegatedResponse({
              text: result.text,
              provider: result.provider,
              model: result.model,
              caveat:
                config?.verify?.onSuspect === 'warn' ? describeVerification(verification) : null,
            })
          : null

      let wrote = null
      try {
        const gateOnly = result === null
        // A delegation is always accounted for. A refusal is too by default, because "why did
        // routing decline 400 times" is only answerable if the refusals are on the record.
        if (!gateOnly || config?.telemetry?.recordGateDecisions !== false) {
          wrote = emit(
            toEventInputs({
              decision,
              result,
              facts,
              payload,
              corpusChars,
              verification,
              escalation,
              answerDiscarded: discarded,
              // The task that was actually built, which is the generic literal unless the
              // developer opted in. Still governed by `telemetry.storeQuestionText`, which is
              // false by default, so recovered prompt text is not stored merely by being used.
              questionText: result === null ? null : task,
              taskIntentSource: intentSource,
              // null means governance was never consulted, which is a different state from
              // "governance allowed this" and the columns keep them apart.
              governance,
            }),
            { config, env },
          )
        }
      } catch {
        // emitEvent already swallows everything; this is the belt to that braces. A telemetry
        // failure must not reach the developer as a failed Read.
        wrote = null
      }

      return {
        response,
        outcome: response ? outcome : outcome === 'delegated' ? 'empty_answer' : outcome,
        decision,
        result,
        wrote,
      }
    }

    if (decision.delegate !== true) return record('not_delegated')

    // Only `deny` is acted on. `suggest` means "delegate-worthy, but do not block", and no
    // delegation-steering skill ships, so nothing acts on it; `ask` would prompt the developer to
    // approve a read rather than delegate it. Both are recorded and both let the Read through.
    if (decision.decision !== 'deny') return record('not_enforced')

    /* ---- governance. AFTER the gate has ruled, BEFORE anything is spent. ----
     *
     * Placed here so a budget refusal costs nothing: no file read, no transcript read, no worker
     * call. The estimate it reasons over is already on hand — `facts.inputBytes` was measured for
     * the gate — and `estimateTokensFromBytes` is the same estimator the context model uses, so
     * there is no second notion of how big a request is.
     *
     * `costUsd` is null and that is the honest value: before the call, this delegation has no
     * known price. A configured monetary budget therefore reports `cost_unknown`, which
     * `budget.onUnknownCost` resolves — it does not silently assume the call is free.
     *
     * Inert under the shipped configuration. Every limit ships null, so `checkBudget()` returns
     * on a pure object walk without opening the ledger.
     */

    const estimatedInput = estimateTokensFromBytes(facts.inputBytes)
    // The worst case the worker is permitted to produce, which is the right number to reserve:
    // reserving the expected output would under-count exactly when a run goes long.
    const maxOutput = Number.isInteger(config?.worker?.maxOutputTokens)
      ? config.worker.maxOutputTokens
      : null
    const governance = checkBudget(config, {
      id: taskId,
      request: {
        inputTokens: estimatedInput,
        outputTokens: maxOutput,
        totalTokens: estimatedInput === null ? null : estimatedInput + (maxOutput ?? 0),
        costUsd: null,
      },
      billing: availability.billing ?? null,
      fs,
    })

    // A denial is the PRIMARY FALLBACK, not a failure: `record()` returns `response: null` for a
    // row with no result, which is how this hook tells Claude Code to run the original Read.
    // Budget exhaustion means "worker acceleration unavailable", never "task failed".
    if (governance.decision !== 'allow') return record('governance_denied', { governance })

    /* ---- the file. Read ONCE, and only now that the gate has approved it. ---- */

    /** Hand back reserved headroom that will never be spent. Idempotent, and never throws. */
    const releaseReservation = () =>
      finalizeBudget(config, {
        id: taskId,
        reservationStatus: governance.reservationStatus,
        usage: null,
        fs,
      })

    const content = readTextContent(filePath, { fs })
    if (!content.ok) {
      // Reserved, then never dispatched. No worker usage was created, so none may be charged.
      releaseReservation()
      return record(content.reason === 'binary' ? 'content_binary' : 'content_unreadable', { governance })
    }

    /* ---- the task. AFTER the decision, which is what keeps intent out of routing. ----
     *
     * The ordering is the enforcement, not a convention. `decide()` has already returned by the
     * time any prompt text exists in this scope, so there is no call order in which intent could
     * influence whether the file is delegated — only what the worker is asked about it. Doing it
     * here rather than beside the other facts also means a refusing invocation never pays for the
     * second transcript read, which test/hook.latency.test.mjs measures.
     *
     * Both calls are inert under the shipped configuration: `source` defaults to `none`, so
     * `extractTaskIntent` returns null before opening a file and `buildWorkerTask` returns exactly
     * the generic input this plugin has always sent.
     */

    const taskIntent = normalizeTaskIntent(
      extractTaskIntent(payload.transcript_path, {
        fs,
        source: config?.hooks?.taskIntent?.source ?? 'none',
        maxChars: config?.hooks?.taskIntent?.maxChars ?? 600,
      }),
    )
    const input = buildWorkerTask({
      toolContext: { baseTask: BULK_READ_TASK, lane: 'bulkRead' },
      files: [{ path: filePath, content: content.content }],
      taskIntent,
    })
    const intentSource = taskIntent === null ? 'none' : 'transcript'

    /* ---- the worker, or workers, under the HOOK's deadline rather than the worker's. ----
     *
     * THE ESCALATION LADDER. `workers.<lane>.ladder` is an ordered list of provider ids; an answer
     * that does not survive verification escalates to the next one. The ladder ships EMPTY, which
     * is exactly the single-worker behaviour this plugin has always had.
     *
     * CLAUDE IS ALWAYS THE LAST TIER, and it costs nothing to implement: when the ladder is
     * exhausted this function falls open and the developer's own Read happens. So a two-entry
     * ladder is three tiers.
     *
     * THE TIME BUDGET IS THE LOAD-BEARING PART, not the loop. Measured on the development machine,
     * a 7B local model takes 80 to 113 seconds on a 900-byte file against a hook deadline whose
     * MAXIMUM is 120 seconds. Without a budget check the ladder would spend the entire deadline on
     * tier one, start tier two, get aborted, and fall open anyway — leaving the developer waiting
     * two minutes for the Read they would have had immediately. That is strictly worse than not
     * installing the plugin, so a tier is only attempted when enough deadline remains for it to
     * plausibly finish.
     */

    const deadlineMs = Number.isInteger(config?.hooks?.timeoutMs) ? config.hooks.timeoutMs : 20000
    const startedAt = Date.now()

    /** The ladder, or a single-element ladder standing for the configured worker. */
    // Trimmed before filtering: `string[]` coercion accepts any strings, so a hand-edited config
    // holding `'  '` or `' ollama '` reaches here. A whitespace-only entry is not a provider, and
    // dispatching it would waste a tier on a certainty.
    const ladder = Array.isArray(config?.workers?.bulkRead?.ladder)
      ? config.workers.bulkRead.ladder
          .filter((id) => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id !== '')
      : []
    const tiers = ladder.length > 0 ? ladder : [null]

    /**
     * How long a tier needs before it is worth starting.
     *
     * A fraction of what is left rather than a fixed number, because the tiers differ by orders of
     * magnitude: a hosted model answers in seconds and a local one in minutes. Requiring a quarter
     * of the original deadline is a crude floor that stops a doomed attempt without pretending to
     * predict a latency this code cannot know.
     */
    const MIN_TIER_FRACTION = 0.25
    const remainingMs = () => deadlineMs - (Date.now() - startedAt)

    let result = null
    let attempts = 0
    const path = []
    // Usage spent on answers that were DISCARDED. Those tokens were really consumed, so they are
    // recorded rather than forgotten — a ladder that hid its own waste would understate what
    // delegation costs, which is the thing this project refuses to do anywhere else.
    let wastedInput = 0
    let wastedOutput = 0
    let lastVerification = null

    for (const [index, tierProvider] of tiers.entries()) {
      if (index > 0 && remainingMs() < deadlineMs * MIN_TIER_FRACTION) {
        // Out of time. Stop rather than start an attempt that will be aborted.
        path.push('out_of_time')
        break
      }

      const tierConfig =
        tierProvider === null
          ? config
          : { ...config, workers: { ...config.workers, bulkRead: { ...config.workers?.bulkRead, provider: tierProvider, model: null, apiKeyEnv: null } } }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1000, remainingMs()))
      timer.unref?.()
      let attempt
      try {
        attempt = await dispatchImpl({
          decision,
          config: tierConfig,
          input,
          signal: controller.signal,
          env,
        })
      } finally {
        clearTimeout(timer)
      }

      attempts += 1
      path.push(attempt?.provider ?? tierProvider ?? 'unknown')
      result = attempt

      // A tier that errored escalates. A tier that answered is verified, and only an answer whose
      // claims contradict the file escalates — see lib/verify/summary.mjs.
      if (attempt?.status === 'ok') {
        lastVerification = verifyAnswer(attempt, config, filePath, content.content)
        const suspect =
          lastVerification?.verdict === 'suspect' && config?.verify?.onSuspect !== 'off'
        if (!suspect) break
      }

      // This answer is being abandoned, so its tokens are waste rather than spend-for-value.
      if (index < tiers.length - 1) {
        wastedInput += attempt?.usage?.inputTokens ?? 0
        wastedOutput += attempt?.usage?.outputTokens ?? 0
      }
    }

    const escalation =
      tiers.length > 1 || attempts > 1
        ? Object.freeze({
            attempts,
            path: path.join('>'),
            wastedInputTokens: wastedInput === 0 ? null : wastedInput,
            wastedOutputTokens: wastedOutput === 0 ? null : wastedOutput,
          })
        : null

    /* ---- accounting. Measured facts only, and exactly once. ----
     *
     * `usage` is whatever the provider reported, or null. Null RELEASES the reservation rather
     * than charging it: a transport error, a timeout, an abort and a `context_exceeded` refusal
     * all reach here having created no worker usage, and inventing a number for them would
     * corrupt every decision that followed. A failed call that DID report usage is charged,
     * because those tokens were really consumed.
     *
     * Cost comes from `priceWorkerUsage()`, which is the same `resolveRates` + `calculateCost`
     * pair that prices the event row — not a second cost implementation. It returns null for an
     * unpriced model, and null means unknown, never zero.
     */
    const usage = result.usage ?? null
    const priced =
      usage === null
        ? { costUsd: null }
        : priceWorkerUsage({
            config,
            provider: result.provider ?? availability.provider,
            model: result.model ?? availability.model,
            modelRequested: result.modelRequested ?? null,
            usage,
            capabilities: result.capabilities ?? null,
            fs,
          })

    const settled = finalizeBudget(config, {
      id: taskId,
      reservationStatus: governance.reservationStatus,
      usage,
      costUsd: priced.costUsd,
      fs,
    })

    // The row reports what the reservation actually BECAME, not what it was when it was taken.
    const accounted = Object.freeze({
      ...governance,
      reservationStatus: settled.status === 'none' ? governance.reservationStatus : settled.status,
    })

    /* ---- verification. The file is still in hand, so the answer's claims are checkable. ----
     *
     * This runs AFTER accounting, deliberately: the worker call happened and its tokens were
     * really consumed, so it is charged whether or not we keep the answer. Discarding an answer
     * does not un-spend it, and a row that hid the spend would understate what delegation costs.
     *
     * Wrapped, because a verifier that threw would break a hook — and CLAUDE.md's third rule
     * does not care that this one is pure. A throw here must fall back to the pre-verification
     * behaviour, which is to substitute the answer.
     */
    // Computed inside the ladder loop above, because the verdict is what decides whether to
    // escalate. The last tier's verdict is the one that describes the answer actually returned.
    const verification = lastVerification

    const stamps = {
      corpusChars: content.content.length,
      task: input.task,
      intentSource,
      governance: accounted,
      verification,
      escalation,
    }
    if (result.status !== 'ok') return record('worker_failed', { result, ...stamps })
    if (verification?.verdict === 'suspect' && config?.verify?.onSuspect === 'discard') {
      return record('summary_unverified', { result, ...stamps })
    }
    return record('delegated', { result, ...stamps })
  } catch {
    return bail('hook_threw')
  }
}
