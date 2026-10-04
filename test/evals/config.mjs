/**
 * Configs for the evaluation framework.
 *
 * ONE RULE, AND IT IS STRONGER THAN "DO NOT MUTATE THE USER'S CONFIG": this module never READS the
 * user's config. `resolveConfig` is called with an explicit layer list and `env: {}`, so a
 * developer's `~/.claude/model-router/config.json` setting `minLines: 50`, or a `CMR_MIN_BYTES` in
 * CI, cannot change a benchmark result. `loadConfig()` is never called from anywhere under
 * `test/evals/`, and `evals.isolation.test.mjs` asserts that statically.
 *
 * The two-argument shape follows the precedent set by `dispatchConfig` and `hookConfig`:
 * `overrides` go through the REAL resolver so they are validated and cannot drift from `DEFAULTS`,
 * and `patch` is applied afterwards for the things the resolver legitimately cannot express.
 * There are exactly two of those, both documented at the call site below.
 */

import { resolveConfig } from '../../plugins/model-router/lib/config.mjs'

/**
 * The base layer every arm starts from.
 *
 * `apiKeyEnv` is stated explicitly rather than inherited: `resolveWorker` carries
 * `worker.apiKeyEnv` across a provider change, so switching only `provider` to `mock` would leave
 * the dispatcher asking for `GEMINI_API_KEY` and reporting `worker_not_ready`.
 *
 * `telemetry.enabled: false` because the eval writes its own artifacts and must never append to
 * the user's production store. The framework calls `buildEvent()` directly and never `emitEvent()`,
 * so this is belt as well as braces.
 */
export const EVAL_BASE_LAYER = Object.freeze({
  enabled: true,
  worker: Object.freeze({
    provider: 'mock',
    model: 'mock-1',
    apiKeyEnv: 'MOCK_WORKER_URL',
  }),
  telemetry: Object.freeze({ enabled: false }),
})

/** Deep clone that keeps plain objects plain, so `resolveConfig`'s deep merge sees what it expects. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = clone(v)
    return out
  }
  return value
}

/** Merge `overlay` into `base` in place, creating intermediate objects as needed. */
function mergeInto(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (base[key] === null || typeof base[key] !== 'object' || Array.isArray(base[key])) base[key] = {}
      mergeInto(base[key], value)
    } else {
      base[key] = value
    }
  }
  return base
}

/**
 * Build a resolved config for one eval arm or one sweep point.
 *
 * @param {object} [overrides]  a config layer; validated by the real resolver
 * @param {object} [patch]      applied after resolution, for what the resolver cannot express
 * @returns {{config: object, warnings: Array<object>}}
 */
export function evalConfigWithWarnings(overrides = {}, patch = {}) {
  const layer = mergeInto(clone(EVAL_BASE_LAYER), clone(overrides))
  const resolved = resolveConfig({ layers: [{ name: 'eval', data: layer }], env: {} })

  // Two things the resolver cannot carry, and why:
  //
  //   providers.mock.baseUrl — `mock` has no SPEC leaf for a base URL, so the resolver drops the
  //     key and warns "unknown field, ignored". It has to be grafted on afterwards.
  //   sub-second timeoutMs   — the SPEC minimum is 1000, which is correct for production and far
  //     too long for a test that means to prove a deadline fires.
  //
  // `config.projectDir` is also set here because `resolveConfig` does not set it — only
  // `loadConfig` does — and the gate matches deny globs relative to it.
  const config = mergeInto(resolved.config, clone(patch))

  return { config, warnings: resolved.warnings }
}

/** The common case: just the config. */
export function evalConfig(overrides = {}, patch = {}) {
  return evalConfigWithWarnings(overrides, patch).config
}

/**
 * The deterministic arm and the live arm.
 *
 * Two arms rather than one, because `ollama` reports `reportsThinkingTokens: false` and
 * `supportsCachedInput: false` while `mock` reports both true — so running both reaches BOTH of
 * calc.mjs's structural-zero branches through real provider modules, with no capability-injection
 * seam invented for the purpose. A seam that let an eval claim a capability a provider does not
 * have would be worse than no coverage.
 */
/**
 * What a LIVE arm has to be given so the comparison it produces means anything.
 *
 * MEASURED, not guessed. A first attempt at the live A/B over one corpus case produced this:
 *
 *   generic  status=error timeout   worker latency 541357 ms   (3 attempts x the 180s default)
 *   intent   status=ok              worker latency 141709 ms
 *
 * It would have read as "intent is dramatically better". It is nothing of the kind. CPU-only
 * prompt evaluation on this hardware runs about 12.6 tok/s, so a 3,300-token prompt needs ~262
 * seconds and could NEVER complete inside the shipped 180-second provider timeout. The generic
 * variant ran first, burned three doomed attempts, and in doing so warmed the model for the
 * intent variant that followed.
 *
 * Two things therefore have to change for a live arm, and neither touches the product:
 *
 *   timeoutMs   raised, because the shipped default is sized for a hosted provider and a local
 *               CPU model is one to two orders of magnitude slower per token.
 *   maxRetries  ZERO. A retry cannot fix a timeout caused by arithmetic — the prompt is simply
 *               bigger than the budget — so retrying triples the cost of a doomed call and
 *               changes no answer. Worse, it silently warms the model for whatever runs next,
 *               which is exactly how the confound above was manufactured.
 *
 * The deterministic `mock` arm keeps the shipped defaults: its whole point is that the timeout
 * and retry paths behave as they ship.
 */
const LIVE_WORKER_BUDGET = Object.freeze({
  /**
   * Under the 300s ceiling Node's HTTP client imposes (providers/contract.mjs
   * FETCH_HEADERS_TIMEOUT_MS), so a slow call fails with OUR timeout and a legible message
   * rather than as an opaque `transport` error at a number nobody configured.
   */
  timeoutMs: 280_000,
  /**
   * ZERO, and this is the important one. A retry cannot fix a timeout caused by arithmetic —
   * the prompt is simply bigger than the budget — so retrying triples the cost of a doomed call
   * and changes no answer. Worse, the attempts warm the model for whatever is measured next,
   * which is how a first run manufactured "generic timed out at 541s, intent succeeded at 141s"
   * out of nothing but running order.
   */
  maxRetries: 0,
  /**
   * Chosen for ANSWER QUALITY, not for any one machine's speed.
   *
   * Tighter caps were tried while chasing timeouts — 192, then 96 — and neither helped. Measured
   * directly with a bare fetch and no harness, this machine reads prompts at 22.3 tok/s and
   * generates at 6.4 tok/s, so a ~4,265-token corpus case spends ~191s on the prompt before
   * producing a token. Cutting the output budget cannot touch that, and a 96-token cap timed out
   * exactly as a 512-token one did: the bottleneck was never output.
   *
   * So the cap is a value that is generous for the answers these cases want — the one
   * naturally-stopping sample observed used 30 tokens — and that will not cut an answer short on
   * hardware fast enough to run the experiment at all. On a GPU a corpus case is seconds.
   */
  maxOutputTokens: 512,
  /**
   * Pinned, because a benchmark should not sample. At the shipped 0.2 the same prompt stopped at
   * 30 output tokens on one run and ran to the cap on another — a swing that is the difference
   * between a graded result and a timeout. Noise that large makes an n=1-per-cell comparison
   * unreadable, and nothing here needs a non-zero temperature.
   */
  temperature: 0,
})

export const EVAL_ARMS = Object.freeze({
  /** Offline, no key, no network: the arm that gates CI. */
  mock: Object.freeze({
    id: 'mock',
    deterministic: true,
    overrides: { worker: { provider: 'mock', model: 'mock-1', apiKeyEnv: 'MOCK_WORKER_URL' } },
    env: Object.freeze({ MOCK_WORKER_URL: 'http://fixture.invalid' }),
  }),
  /**
   * A real local model. Model-dependent, reported separately, and never required.
   *
   * llama3:latest has an 8192-token architectural context, measured via /api/show. Two corpus
   * cases exceed it — shape-large-single-file and shape-buried-fact — and will be REFUSED with
   * `context_exceeded` rather than silently served from a middle-truncated prompt. That refusal
   * is the correct result on this arm, not a regression.
   */
  ollama: Object.freeze({
    id: 'ollama',
    deterministic: false,
    overrides: {
      worker: {
        provider: 'ollama',
        model: 'llama3:latest',
        apiKeyEnv: 'OLLAMA_UNUSED',
        ...LIVE_WORKER_BUDGET,
      },
    },
    env: Object.freeze({}),
  }),
  /**
   * The same local runtime with a 32768-token model, so the whole corpus fits.
   *
   * A SECOND ARM rather than a replacement, and the pairing is the experiment: run both and a
   * quality difference between generic and intent-aware tasks can be told apart from "the model's
   * window was too small for this case". With only the llama3 arm the two explanations are
   * indistinguishable, and the honest verdict would have to be inconclusive for a reason that
   * was removable.
   */
  'ollama-mistral': Object.freeze({
    id: 'ollama-mistral',
    deterministic: false,
    overrides: {
      worker: {
        provider: 'ollama',
        model: 'mistral:latest',
        apiKeyEnv: 'OLLAMA_UNUSED',
        ...LIVE_WORKER_BUDGET,
      },
    },
    env: Object.freeze({}),
  }),
})

export function armIds() {
  return Object.keys(EVAL_ARMS)
}

/**
 * The two worker-task constructions, as an A/B dimension orthogonal to the arm.
 *
 * `generic` is what the plugin shipped before Phase 7 and what it still ships by default: the
 * task alone, with no standing instructions and no requirements. `intent` is the same question
 * routed through `buildWorkerTask`, which adds the lane's instructions and whatever the case
 * declared in `taskIntent`.
 *
 * ONE VARIABLE MOVES. Both variants run the same corpus, the same routing decision, the same
 * files, the same provider, the same model and the same config — and in the `intent` variant the
 * task sentence itself is the same sentence, because a case without an explicit `taskIntent`
 * falls back to its own `task`. So the only difference is the requirements block, which is the
 * thing being measured.
 *
 * `eventIdSuffix` is empty for `generic` ON PURPOSE. It makes a default run's rows byte-identical
 * to the rows produced before this dimension existed, so the golden artifact keeps its meaning
 * and the only new rows are the ones that were genuinely added. The separator differs from the
 * sweep's `@` so a variant row can never be mistaken for a threshold row.
 */
export const EVAL_VARIANTS = Object.freeze({
  generic: Object.freeze({ id: 'generic', intentAware: false, eventIdSuffix: '' }),
  intent: Object.freeze({ id: 'intent', intentAware: true, eventIdSuffix: '#intent' }),
})

/** Frozen order, so two runs iterate identically and the golden cannot reorder itself. */
export function variantIds() {
  return Object.keys(EVAL_VARIANTS)
}
