/**
 * Provider registry.
 *
 * The one place that knows which providers exist. Routing, hooks, skills and
 * telemetry resolve `worker.provider` through here and never import a provider
 * module directly, so adding a provider is one file plus one line of this table.
 *
 * Modules are lazy-loaded: the gate asks `readinessFor()` on the hot path and
 * must not pay to parse a provider it is not going to call.
 */

import { ProviderError, validateProviderModule, withRetry } from './contract.mjs'

/** id -> dynamic import. Keep alphabetical. */
const REGISTRY = Object.freeze({
  gemini: () => import('./gemini.mjs'),
  mock: () => import('./mock.mjs'),
  ollama: () => import('./ollama.mjs'),
})

/**
 * Answers the gate and the governance layer can give without loading a module.
 *
 * A duplicate of each provider's own `capabilities`, which exists because reading the real one
 * costs a dynamic import on the hot path. A conformance test pins both fields against every
 * module, so the duplication cannot drift silently.
 */
const SYNC_REQUIREMENTS = Object.freeze({
  gemini: { requiresEnv: ['GEMINI_API_KEY'], billing: 'metered' },
  mock: { requiresEnv: ['MOCK_WORKER_URL'], billing: 'metered' },
  ollama: { requiresEnv: [], billing: 'local_free' },
})

export function providerIds() {
  return Object.keys(REGISTRY)
}

export function isKnownProvider(id) {
  return Object.hasOwn(REGISTRY, id)
}

/**
 * Which environment variables a provider needs, WITHOUT loading its module.
 *
 * `capabilities.requiresEnv` is the same list, but reading it costs a dynamic import. The gate
 * needs the answer to decide whether `worker.apiKeyEnv` is a rename of a key this provider wants
 * or a leftover from a different one — the distinction `dispatch()` draws at index.mjs:269 — and
 * it must reach that decision on the hot path without parsing a provider it may not call.
 *
 * @returns {ReadonlyArray<string>|null} null for an unknown id, never a guess
 */
export function requiresEnvFor(id) {
  if (!isKnownProvider(id)) return null
  return Object.freeze([...SYNC_REQUIREMENTS[id].requiresEnv])
}

/**
 * Does this provider want an API key at all?
 *
 * The one authority on the question, because the answer decides whether a configured
 * `apiKeyEnv` is a RENAME of a key this provider needs or a LEFTOVER from a different one.
 * `readinessFor()` treats a supplied name as REPLACING the provider's own `requiresEnv`, so
 * forwarding `worker.apiKeyEnv` to a provider that needs no key reports a healthy local Ollama
 * as "NOT ready: GEMINI_API_KEY not set".
 *
 * This predicate used to be hand-rolled in three places — `dispatch()`, `workerAvailability()`
 * and `scripts/doctor.mjs` — and doctor's copy was keyed to the GLOBAL provider rather than the
 * one each lane resolves to, which is the phase-8 defect this export closes. Three copies of a
 * security-adjacent predicate is three places for it to drift.
 *
 * @returns {boolean} false for an unknown id: a provider we cannot identify is not one we can
 *                    claim wants a key.
 */
export function wantsKey(id) {
  const required = requiresEnvFor(id)
  return (required?.length ?? 0) > 0
}

/**
 * How this provider bills, WITHOUT loading its module.
 *
 * The one fact governance needs about a provider, and the reason it can decide a budget without
 * importing one. `local_free` means a monetary budget cannot be consumed; `metered` means it can,
 * whether or not a rate is currently known.
 *
 * @returns {string|null} null for an unknown id. Not a guess, and specifically not `local_free`
 *                        — assuming an unidentified provider is free is the expensive mistake.
 */
export function billingFor(id) {
  if (!isKnownProvider(id)) return null
  return SYNC_REQUIREMENTS[id].billing
}

const cache = new Map()

/** Load and contract-check a provider module. Throws ProviderError('config') on a bad id. */
export async function loadProvider(id) {
  if (!isKnownProvider(id)) {
    throw new ProviderError(
      'config',
      `unknown worker provider "${id}". Known providers: ${providerIds().join(', ')}`,
      { provider: id, retryable: false },
    )
  }
  if (cache.has(id)) return cache.get(id)

  let mod
  try {
    mod = await REGISTRY[id]()
  } catch (err) {
    throw new ProviderError('config', `failed to load provider "${id}": ${err?.message}`, {
      provider: id,
      retryable: false,
      cause: err,
    })
  }

  const problems = validateProviderModule(mod)
  if (problems.length > 0) {
    throw new ProviderError(
      'config',
      `provider "${id}" does not satisfy the contract: ${problems.join('; ')}`,
      { provider: id, retryable: false },
    )
  }

  cache.set(id, mod)
  return mod
}

/**
 * Synchronous readiness for the gate. No module load, no network — just "is this
 * provider id known and are its env vars present". The gate uses this to decide
 * whether blocking a read could possibly lead anywhere; if not, it fails open.
 *
 * @returns {{ready: boolean, reason?: string}}
 */
export function readinessFor(providerId, env = process.env, { apiKeyEnv } = {}) {
  if (!isKnownProvider(providerId)) {
    return { ready: false, reason: `unknown worker provider "${providerId}"` }
  }
  const required = apiKeyEnv ? [apiKeyEnv] : SYNC_REQUIREMENTS[providerId].requiresEnv
  const missing = required.filter((k) => !env?.[k])
  if (missing.length > 0) {
    return { ready: false, reason: `${providerId}: ${missing.join(', ')} not set` }
  }
  return { ready: true }
}

/**
 * The single entry point delegation scripts use. Loads the provider, applies the
 * shared retry policy, and returns the attempt count so telemetry can record
 * `retry_count` from what actually happened rather than from the config value.
 *
 * @returns {Promise<{result: import('./contract.mjs').CompletionResult, attempts: number, providerId: string}>}
 */
export async function callWorker({ config, prompt, system, signal, fetchImpl, scenario, env = process.env, sleep, random }) {
  const providerId = config?.worker?.provider
  const mod = await loadProvider(providerId)

  const req = {
    model: config.worker.model,
    prompt,
    system,
    temperature: config.worker.temperature,
    maxOutputTokens: config.worker.maxOutputTokens,
    timeoutMs: config.worker.timeoutMs,
    // The serving window to pin, or null when it could not be determined. A provider that cannot
    // pin a window ignores it; ollama turns it into num_ctx.
    contextTokens: config.worker.contextTokens ?? null,
    providerConfig: config.providers?.[providerId] ?? {},
    apiKeyEnv: config.worker.apiKeyEnv,
    env,
    signal,
    fetchImpl,
    scenario,
  }

  const { result, attempts } = await withRetry(() => mod.complete(req), {
    maxRetries: config.worker.maxRetries ?? 2,
    sleep,
    random,
  })

  return { result, attempts, providerId }
}
