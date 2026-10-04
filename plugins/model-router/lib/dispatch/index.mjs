/**
 * The worker dispatcher.
 *
 * It takes a decision the routing engine already approved, builds the prompt for that mode,
 * resolves a provider through the registry, executes exactly one worker call and returns a
 * normalized result. It is the layer that joins three others; it owns none of their jobs.
 *
 *   decision (routing)  ->  mode (prompt)  ->  registry  ->  provider  ->  result
 *
 * WHAT THIS LAYER DOES NOT DO:
 *
 *  - It does not decide. `delegate` already answered that; the dispatcher re-reads no threshold,
 *    no glob and no budget. A second copy of a routing rule is a second rule to keep in sync.
 *  - It does not retry. callWorker() applies the shared policy in withRetry(); a backoff here
 *    would multiply that one rather than replace it.
 *  - It does not branch on a provider. Per-mode settings reach callWorker() through a derived
 *    config, so adding a provider stays one file plus one registry line.
 *  - It does not emit telemetry, and imports nothing from lib/telemetry. It returns the facts a
 *    later integration layer needs; that layer decides whether a row is written.
 *  - It does not touch the filesystem, the shell or the network directly. It has no `node:`
 *    import at all, which a test enforces.
 */

import {
  buildResult,
  dispatchError,
  fromProviderError,
} from './contract.mjs'
import { MODES, PROMPT_VERSION, isKnownMode } from './modes.mjs'
import { assertPayloadSize } from '../providers/contract.mjs'
import { callWorker, isKnownProvider, loadProvider, readinessFor, wantsKey } from '../providers/index.mjs'
import { bundledCapabilityFor, resolveCapability } from '../providers/capability.mjs'
import {
  computeContextBudget,
  detectSilentTruncation,
  estimateTokensFromBytes,
  requiredContextTokens,
} from '../context-budget.mjs'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/* -------------------------------------------------------------------- resolution */

/**
 * Resolve which worker a lane runs on. Pure and synchronous, so doctor and the tests can ask the
 * question without executing anything.
 *
 * `null` in a `workers.<lane>` leaf means INHERIT. The inheritance is deliberately asymmetric:
 *
 *   provider   inherits always — there is one global worker and a lane only refines it
 *   model      inherits ONLY when the provider did, else falls to providers.<id>.model
 *   apiKeyEnv  inherits ONLY when the provider did
 *   timeoutMs  inherits always
 *
 * A model id and an env-var name are meaningful only relative to a provider. Inheriting
 * `worker.model` across a provider change is the bug this asymmetry exists to prevent: with
 * `worker.model` at its default, `{workers: {codeWrite: {provider: 'ollama'}}}` would otherwise
 * ask Ollama for 'gemini-3.8-flash', and ollama.mjs takes `model || providerConfig.model`, so the
 * configured 'qwen2.5-coder:7b' would never be consulted. The daemon answers HTTP 200 with a
 * "model not found" body and the only clue is a Gemini model name in an Ollama error.
 *
 * A millisecond budget carries no provider identity, so it always inherits. `temperature`,
 * `maxOutputTokens` and `maxRetries` stay on `worker.*` for the same reason and are not per-mode.
 *
 * @returns {import('./contract.mjs').ResolvedWorker}
 */
export function resolveWorker(config, lane) {
  const base = isPlainObject(config?.worker) ? config.worker : {}
  const laneCfg = isPlainObject(config?.workers?.[lane]) ? config.workers[lane] : {}

  const provider = laneCfg.provider ?? base.provider ?? null
  // Keyed on the resolved VALUE, not on "did it fall back", so a lane that restates the same
  // provider explicitly still inherits the model and key that belong to it.
  const inheritedProvider = provider === (base.provider ?? null)

  const providerModel = isPlainObject(config?.providers?.[provider])
    ? (config.providers[provider].model ?? null)
    : null

  return Object.freeze({
    provider,
    model: laneCfg.model ?? (inheritedProvider ? (base.model ?? null) : providerModel),
    apiKeyEnv: laneCfg.apiKeyEnv ?? (inheritedProvider ? (base.apiKeyEnv ?? null) : null),
    timeoutMs: laneCfg.timeoutMs ?? (base.timeoutMs ?? null),
    inheritedProvider,
  })
}

/**
 * Project a resolved worker back onto `config.worker`, which is the shape callWorker() reads.
 *
 * Shallow by design: `config.providers` survives by reference so callWorker resolves the right
 * `providers.<id>` block, and every other setting it reads — temperature, maxOutputTokens,
 * maxRetries — is carried through untouched. The derived object is never mutated and never
 * reaches the telemetry sink, whose cache is keyed on config identity.
 */
export function deriveConfig(config, resolved, overrides = {}) {
  return {
    ...config,
    worker: {
      ...config.worker,
      provider: resolved.provider,
      model: resolved.model,
      apiKeyEnv: resolved.apiKeyEnv,
      timeoutMs: resolved.timeoutMs,
      // Per-request, derived from the context budget rather than configured. `maxOutputTokens`
      // may have been reduced to leave room for the prompt; `contextTokens` is the window to
      // pin. Both stay out of `worker.*` in the real config, because neither is a setting.
      ...overrides,
    },
  }
}

/**
 * Resolve the model's context window: what the operator configured, what the provider reports,
 * what our table assumes — in that order of authority, with unknown left unknown.
 *
 * Lives here rather than in capability.mjs because it is the one place that knows about provider
 * MODULES rather than records. Never throws: a discovery that fails is an `unknown` capability,
 * and `unknown` proceeds.
 */
async function resolveModelCapability({ mod, provider, model, providerConfig, describeModelImpl, signal, fetchImpl, now }) {
  const discover = describeModelImpl ?? mod?.describeModel
  let discovered = null
  if (typeof discover === 'function') {
    try {
      discovered = await discover({ model, providerConfig, signal, fetchImpl, now })
    } catch {
      // describeModel is contractually non-throwing, but a third-party provider is not a
      // promise — and a capability probe may never be the reason a Read fails.
      discovered = null
    }
  }

  return resolveCapability({
    provider,
    model,
    configured: providerConfig?.contextTokens ?? null,
    discovered,
    bundled: bundledCapabilityFor(provider, model),
  })
}

/* ---------------------------------------------------------------------- dispatch */

/**
 * Execute one worker call for an approved decision.
 *
 * Never throws: every failure is a result with `status: 'error'` and a classified `error.code`.
 * A thrown dispatcher is a dispatcher a caller has to wrap, and a caller that wraps is a caller
 * that can swallow.
 *
 * @param {object}   a
 * @param {object}   a.decision     a decide() result
 * @param {object}   a.config       a resolved config
 * @param {object}   a.input        the mode's input payload
 * @param {AbortSignal} [a.signal]
 * @param {object}   [a.env]
 * @param {Function} [a.fetchImpl]  injected for tests
 * @param {string}   [a.scenario]   injected for tests
 * @param {Function} [a.sleep]      injected for tests; retry backoff
 * @param {Function} [a.random]     injected for tests; retry jitter
 * @param {Function} [a.now]        injected for tests; the only clock this layer reads
 * @param {Function} [a.describeModelImpl]  injected for tests; REPLACES the provider's own
 *   discovery function, never a claimed capability. It is how the context-refusal branch is
 *   reached without baking a fake window into a shipped provider.
 * @returns {Promise<Readonly<object>>}
 */
export async function dispatch({
  decision,
  config,
  input,
  signal,
  env = process.env,
  fetchImpl,
  scenario,
  sleep,
  random,
  now = Date.now,
  describeModelImpl,
}) {
  const startedAt = now()
  const warnings = []
  // The only other read of the clock. Every exit goes through here so no path can forget it.
  const finish = (fields) => buildResult({ ...fields, latencyMs: now() - startedAt, warnings })

  /* 1. the decision and the config must be usable at all */
  if (!isPlainObject(decision)) {
    return finish({
      status: 'error',
      reason: 'invalid_request',
      error: dispatchError('invalid_request', 'decision must be an object'),
    })
  }
  if (!isPlainObject(config) || !isPlainObject(config.worker)) {
    return finish({
      status: 'error',
      reason: 'invalid_request',
      error: dispatchError('invalid_request', 'config must be a resolved config object'),
    })
  }

  const policyVersion = typeof decision.policyVersion === 'number' ? decision.policyVersion : null
  const stamp = { policyVersion, promptVersion: PROMPT_VERSION }

  if (typeof decision.delegate !== 'boolean') {
    return finish({
      ...stamp,
      status: 'error',
      reason: 'invalid_request',
      error: dispatchError('invalid_request', 'decision.delegate must be a boolean'),
    })
  }

  /* 2. routing said no. Not an error: the caller does the work itself, which is the safe path. */
  if (decision.delegate !== true) {
    return finish({
      ...stamp,
      status: 'skipped',
      reason: 'routing_declined',
      mode: null,
      lane: null,
    })
  }

  /* 3. an already-cancelled caller gets no call made on its behalf */
  if (signal?.aborted === true) {
    return finish({
      ...stamp,
      status: 'skipped',
      reason: 'aborted',
      mode: decision.mode ?? null,
      error: dispatchError('aborted', 'the caller aborted before dispatch began'),
    })
  }

  /* 4. the mode must have a builder */
  if (!isKnownMode(decision.mode)) {
    return finish({
      ...stamp,
      status: 'error',
      reason: 'unsupported_mode',
      mode: typeof decision.mode === 'string' ? decision.mode : null,
      error: dispatchError(
        'unsupported_mode',
        `no worker mode named "${decision.mode}". Known modes: ${Object.keys(MODES).join(', ')}`,
      ),
    })
  }

  const mode = MODES[decision.mode]
  // The mode's own lane is authoritative for config lookup: MODES is keyed off LANE_MODE, so it
  // cannot disagree with the policy table, whereas a hand-built decision can.
  const lane = mode.lane
  if (decision.lane !== undefined && decision.lane !== null && decision.lane !== lane) {
    warnings.push('lane_mode_mismatch')
  }
  const located = { ...stamp, mode: mode.id, lane }

  /* 5. the mode's own input contract */
  const problems = mode.validate(input)
  if (problems.length > 0) {
    return finish({
      ...located,
      status: 'error',
      reason: 'invalid_request',
      error: dispatchError('invalid_request', `${mode.id} input is unusable: ${problems.join('; ')}`),
    })
  }

  /* 6. which worker runs this lane */
  const resolved = resolveWorker(config, lane)
  const identified = { ...located, provider: resolved.provider, modelRequested: resolved.model }

  // Checked BEFORE loadProvider, which would otherwise throw with code 'config' and lose the
  // distinction between "that provider does not exist" and "that provider is misconfigured".
  if (!isKnownProvider(resolved.provider)) {
    return finish({
      ...identified,
      status: 'error',
      reason: 'unsupported_provider',
      error: dispatchError(
        'unsupported_provider',
        `unknown worker provider "${resolved.provider}" for mode ${mode.id}`,
        { provider: resolved.provider },
      ),
    })
  }

  /* 7. load the module — capabilities are needed before the call and on the error path */
  let mod
  try {
    mod = await loadProvider(resolved.provider)
  } catch (err) {
    return finish({
      ...identified,
      status: 'error',
      reason: 'unsupported_provider',
      error: dispatchError('unsupported_provider', err?.message ?? 'provider failed to load', {
        provider: resolved.provider,
        detail: err?.detail ?? null,
      }),
    })
  }
  const capabilities = mod.capabilities ?? null
  const withCaps = { ...identified, capabilities }

  /* 8. readiness: synchronous, and never a network probe */
  // `apiKeyEnv` RENAMES a key the provider needs; it does not invent one. readinessFor() treats a
  // supplied name as REPLACING the provider's own `requiresEnv`, so forwarding it to a provider
  // that needs no key at all would make a local Ollama daemon unavailable for want of a Gemini
  // key — which is what `worker.apiKeyEnv` still says after someone switches `worker.provider`
  // alone. The capability list is the authority on whether a key is wanted; the config names it.
  // `wantsKey()` is that authority, shared with `workerAvailability()` and the doctor so the
  // three cannot drift; a conformance test pins it against `capabilities.requiresEnv`.
  const readiness = readinessFor(resolved.provider, env, {
    apiKeyEnv: wantsKey(resolved.provider) ? (resolved.apiKeyEnv ?? undefined) : undefined,
  })
  if (!readiness.ready) {
    return finish({
      ...withCaps,
      status: 'error',
      reason: 'provider_unavailable',
      error: dispatchError('provider_unavailable', readiness.reason ?? 'provider is not ready', {
        provider: resolved.provider,
      }),
    })
  }

  /* 8b. the model's context window. Async, bounded, local, and AFTER readiness so an
   *      unavailable provider is never probed. Never throws; failure is `unknown`, and
   *      `unknown` proceeds, because a router that cannot determine a window must degrade to
   *      plain Claude Code rather than to a blocked session. */
  // Named apart from `capabilities` deliberately: that is the PROVIDER's static flag block, this
  // is THIS MODEL's context record. One letter between two different things is a future bug.
  const modelCapability = await resolveModelCapability({
    mod,
    provider: resolved.provider,
    model: resolved.model,
    providerConfig: config.providers?.[resolved.provider] ?? {},
    describeModelImpl,
    signal,
    fetchImpl,
    now,
  })
  const withCap = { ...withCaps, capability: modelCapability }

  /* 9. build the payload, then refuse an oversized one before any socket is opened */
  const { system, prompt, promptVersion } = mode.build(input)

  /**
   * From here on the stamp reports the version of the prompt that was ACTUALLY built, not the
   * layer's current one. The two differ whenever a request carries a task intent: the templates
   * emit extra sections and report `INTENT_PROMPT_VERSION`, and a row that did not say so would
   * invite a reader to subtract its token count from a generic row's.
   *
   * The eight exits above keep the plain `stamp`, because none of them built a prompt. Hoisting
   * `mode.build` above them to make one stamp serve everything would mean assembling a payload
   * for a provider that is not installed or not ready, and step 8's ordering is deliberate.
   */
  const built = {
    ...withCap,
    promptVersion: Number.isInteger(promptVersion) ? promptVersion : PROMPT_VERSION,
  }

  let payloadBytes = null
  try {
    // The configured ceiling and the provider's own are both real limits, so the binding one is
    // the smaller. Checking only config.worker.maxInputBytes would never fire for ollama or mock,
    // whose capabilities are below the 2 MB default; checking only capabilities would ignore the
    // knob entirely. assertPayloadSize is reused so the message reads identically either way.
    const ceiling = Math.min(
      Number.isInteger(config.worker.maxInputBytes) ? config.worker.maxInputBytes : Infinity,
      Number.isInteger(capabilities?.maxInputBytes) ? capabilities.maxInputBytes : Infinity,
    )
    // assertPayloadSize RETURNS the byte count it measured, so step 9b below needs no new
    // primitive — which matters because this module has no `node:` import and a test enforces it.
    // An infinite ceiling becomes MAX_SAFE_INTEGER rather than skipping the call, so the byte
    // count is measured on every path; the comparison inside can then never fire.
    const effectiveCeiling = Number.isFinite(ceiling) ? ceiling : Number.MAX_SAFE_INTEGER
    payloadBytes = assertPayloadSize(
      prompt,
      system,
      { maxInputBytes: effectiveCeiling },
      resolved.provider,
    )
  } catch (err) {
    return finish({
      ...built,
      status: 'error',
      reason: 'payload_too_large',
      error: dispatchError('payload_too_large', err?.message ?? 'payload is too large', {
        provider: resolved.provider,
      }),
    })
  }

  /* 9b. does the built prompt fit this MODEL's window? The ceiling above is a transport limit in
   *      bytes; this is a context limit in tokens, and the two have different fixes — raise the
   *      knob, versus pick a model with a bigger window. */
  const budget = computeContextBudget({
    provider: resolved.provider,
    model: resolved.model,
    capability: modelCapability,
    requestedInputTokens: estimateTokensFromBytes(payloadBytes),
    requestedOutputTokens: config.worker.maxOutputTokens,
    contextWindowModel: capabilities?.contextWindowModel ?? 'unknown',
  })
  const budgeted = { ...built, contextBudget: budget }

  if (budget.verdict === 'refuse') {
    // Refuse rather than truncate. For a bulk read, dropping file content invalidates the whole
    // optimisation: the answer would be built from material the developer cannot see missing.
    return finish({
      ...budgeted,
      status: 'error',
      reason: 'context_exceeded',
      error: dispatchError(
        'context_exceeded',
        `${resolved.model} has a ${budget.contextTokens}-token context (${budget.capabilitySource}); this request needs ${budget.totalRequestedTokens}. Send fewer or smaller files, or configure a model with a larger context window.`,
        { provider: resolved.provider },
      ),
    })
  }
  if (budget.verdict === 'cap_output') warnings.push('output_capped')
  if (budget.verdict === 'unknown') warnings.push(`context_${budget.reason}`)

  /* 10. one call. Retry, timeout and abort composition all live below this line. */
  const derived = deriveConfig(config, resolved, {
    // A capped output is the one adjustment that loses nothing: it trades answer length for
    // prompt room. Input is never traded.
    maxOutputTokens: budget.allowedOutputTokens ?? config.worker.maxOutputTokens,
    contextTokens: requiredContextTokens(budget),
  })
  try {
    const { result, attempts } = await callWorker({
      config: derived,
      prompt,
      system,
      signal,
      fetchImpl,
      scenario,
      env,
      sleep,
      random,
    })
    // The post-hoc net. prompt_eval_count says how much prompt the runtime ACTUALLY read, so a
    // material shortfall means content was dropped on the way in.
    const truncation = detectSilentTruncation({ budget, usage: result.usage, capabilities })

    if (truncation.truncated === true) {
      // DISCARD the answer rather than return it with a warning. Ollama drops the MIDDLE, so a
      // summary built from head and tail is a confabulation risk on exactly the content nobody
      // can see is missing — and hook/run.mjs substitutes this text for the real Read whenever
      // the status is ok, which would make a telemetry warning invisible to the person misled.
      warnings.push('input_silently_truncated')
      return finish({
        ...budgeted,
        status: 'error',
        reason: 'context_exceeded',
        executed: true,
        model: result.model ?? null,
        usage: result.usage ?? null,
        attempts: attempts ?? null,
        providerLatencyMs: result.providerLatencyMs ?? null,
        contextTruncation: truncation,
        error: dispatchError(
          'context_exceeded',
          `the worker read ${truncation.observedPromptTokens} prompt tokens of an estimated ${truncation.estimatedPromptTokens}; file content was dropped on the way in, so the answer is discarded.`,
          { provider: resolved.provider },
        ),
      })
    }

    return finish({
      ...budgeted,
      status: 'ok',
      reason: 'completed',
      executed: true,
      model: result.model ?? null,
      text: result.text ?? null,
      usage: result.usage ?? null,
      attempts: attempts ?? null,
      providerLatencyMs: result.providerLatencyMs ?? null,
      truncated: result.truncated ?? null,
      finishReason: result.finishReason ?? null,
      contextTruncation: truncation,
    })
  } catch (err) {
    const { error, reason } = fromProviderError(err, signal)
    return finish({
      ...budgeted,
      status: 'error',
      reason,
      // A throw from callWorker means an attempt was made; withRetry stamps how many.
      executed: true,
      attempts: err?.attempts ?? null,
      error,
    })
  }
}
