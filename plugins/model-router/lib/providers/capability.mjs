/**
 * Model capability records — what we know about a model's context window, and how we know it.
 *
 * PURE and IMPORT-FREE, like context-budget.mjs beside it. A record built here is data; the
 * arithmetic that consumes it lives there, and the discovery that populates it lives in a
 * provider module.
 *
 * THE DISTINCTION THIS FILE EXISTS TO ENFORCE. Three different numbers get called "the context
 * limit", and conflating them is how a router ends up promising capacity it does not have:
 *
 *   1. what the operator configured      — an application limit, not a measurement
 *   2. what the provider advertises      — an architectural ceiling for the weights
 *   3. what the runtime actually served  — the only ground truth, and only after the call
 *
 * Measured against Ollama 0.34.4: /api/show reports llama3:latest as an 8192-token model, and the
 * daemon served a 17,368-token prompt as 2060 evaluated tokens. Both numbers are true. Reporting
 * the first as evidence of the second is the failure, so `source` and `status` travel with every
 * number and `statusForSource()` is the only place the mapping exists.
 *
 * `capabilities.maxInputBytes` is NOT in this file and never will be: it is a transport ceiling in
 * bytes, it is provider-wide rather than per-model, and no context math may read it.
 */

/**
 * Where a context number came from, weakest to strongest in trust.
 *
 * `bundled_default` is OUR table's opinion and is never promoted to a measurement: the developer
 * may have pulled a tag nobody here has ever run.
 */
export const CAPABILITY_SOURCES = Object.freeze([
  'provider_api', // asked the provider and it answered
  'configured', // the operator stated it
  'bundled_default', // our static table said so
  'unknown', // nothing said so; contextTokens is null
])

/**
 * How much the number is worth. Deliberately NOT a synonym of `source`: `configured` is a real
 * source and an explicitly non-measured status, which is the whole point.
 */
export const CAPABILITY_STATUSES = Object.freeze([
  'measured', // only provider_api earns this
  'configured', // an application limit; a human asserted it
  'assumed', // our table's opinion
  'unknown',
])

/** Trust order, so a resolver never re-derives precedence from a chain of conditionals. */
export const CAPABILITY_TRUST_ORDER = Object.freeze(['unknown', 'assumed', 'configured', 'measured'])

/**
 * The ONLY place source -> status exists.
 *
 * The exact analogue of telemetry/calc.mjs `statusFor()`, and it exists for the same reason: the
 * rule "a configured value must never be presentable as a measured capability" should be one line
 * of code rather than a convention every call site is trusted to remember.
 *
 * @param {string} source  a member of CAPABILITY_SOURCES
 * @returns {string} a member of CAPABILITY_STATUSES
 */
export function statusForSource(source) {
  if (source === 'provider_api') return 'measured'
  if (source === 'configured') return 'configured'
  if (source === 'bundled_default') return 'assumed'
  return 'unknown'
}

/* --------------------------------------------------------------------- constructors */

/**
 * The honest answer when nothing is known.
 *
 * INVARIANT, asserted by test: `contextTokens === null` if and only if `status === 'unknown'`.
 *
 * @param {object} a
 * @param {string|null} [a.provider]
 * @param {string|null} [a.model]
 * @param {string|null} [a.detail]  why it is unknown; must already be redacted by the caller
 * @returns {Readonly<object>} a ModelCapability
 */
export function unknownCapability({ provider = null, model = null, detail = null } = {}) {
  return Object.freeze({
    provider,
    model,
    contextTokens: null,
    maxOutputTokens: null,
    source: 'unknown',
    status: 'unknown',
    measuredAt: null,
    detail: typeof detail === 'string' && detail !== '' ? detail : null,
  })
}

/**
 * Build a capability record. Any unusable context value degrades the whole record to `unknown`
 * rather than keeping a source that now describes nothing.
 *
 * @param {object} a
 * @param {string|null} [a.provider]
 * @param {string|null} [a.model]
 * @param {number|null} [a.contextTokens]
 * @param {number|null} [a.maxOutputTokens]
 * @param {string} a.source  a member of CAPABILITY_SOURCES
 * @param {number|null} [a.measuredAt]  epoch ms; only meaningful for provider_api
 * @param {string|null} [a.detail]
 * @returns {Readonly<object>}
 */
export function modelCapability({
  provider = null,
  model = null,
  contextTokens = null,
  maxOutputTokens = null,
  source,
  measuredAt = null,
  detail = null,
}) {
  const ctx = Number.isInteger(contextTokens) && contextTokens > 0 ? contextTokens : null
  const src = CAPABILITY_SOURCES.includes(source) ? source : 'unknown'

  // A source without a number is not a weaker claim, it is no claim.
  if (ctx === null) return unknownCapability({ provider, model, detail })

  return Object.freeze({
    provider,
    model,
    contextTokens: ctx,
    maxOutputTokens: Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null,
    source: src,
    status: statusForSource(src),
    measuredAt: src === 'provider_api' && Number.isInteger(measuredAt) ? measuredAt : null,
    detail: typeof detail === 'string' && detail !== '' ? detail : null,
  })
}

/* ------------------------------------------------------------------------ resolution */

/**
 * Pick the capability to act on from the three things that may know.
 *
 * Precedence is NOT simply "strongest status wins". When an operator has configured a number and
 * the provider reports a different one, both limits are real, so the binding one is the smaller —
 * the same reasoning dispatch already applies to the two byte ceilings. The resulting record is
 * then labelled `configured`, the WEAKER of the two statuses, because an operator's assertion
 * clamped by a measurement is still an assertion.
 *
 * @param {object} a
 * @param {string|null} [a.provider]
 * @param {string|null} [a.model]
 * @param {number|null} [a.configured]  providers.<id>.contextTokens
 * @param {object|null} [a.discovered]  a ModelCapability from describeModel(), or null
 * @param {object|null} [a.bundled]     a ModelCapability from bundledCapabilityFor(), or null
 * @returns {Readonly<object>}
 */
export function resolveCapability({
  provider = null,
  model = null,
  configured = null,
  discovered = null,
  bundled = null,
}) {
  const cfg = Number.isInteger(configured) && configured > 0 ? configured : null
  const disc = discovered && Number.isInteger(discovered.contextTokens) ? discovered.contextTokens : null
  const bun = bundled && Number.isInteger(bundled.contextTokens) ? bundled.contextTokens : null

  if (cfg !== null) {
    const binding = disc === null ? cfg : Math.min(cfg, disc)
    const detail =
      disc !== null && cfg > disc
        ? `configured ${cfg} exceeds the ${disc} the provider reports; using ${binding}`
        : null
    return modelCapability({ provider, model, contextTokens: binding, source: 'configured', detail })
  }

  if (disc !== null) return discovered
  if (bun !== null) return bundled

  return unknownCapability({
    provider,
    model,
    detail: discovered?.detail ?? 'no configured, discovered or bundled context limit',
  })
}

/* ---------------------------------------------------------------------- the table */

/**
 * Normalize a model name to its table key: strip the tag, lowercase, trim.
 *
 * NO fuzzy or prefix matching. A prefix match would turn `llama3-finetune-of-mine` into `llama3`
 * and invent a window for a model nobody has measured, which is precisely the fabrication this
 * module exists to prevent.
 *
 * @param {string|null} model
 * @returns {string|null}
 */
export function normalizeModelName(model) {
  if (typeof model !== 'string') return null
  const trimmed = model.trim().toLowerCase()
  if (trimmed === '') return null
  const colon = trimmed.indexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/**
 * Known architectural context windows, by normalized model name. An ASSUMPTION, never a
 * measurement — every lookup reports source `bundled_default` and status `assumed`.
 *
 * EDITING RULE: when unsure, OMIT the entry. A missing entry resolves to `unknown`, which fails
 * open to plain Claude Code. An entry that guesses HIGH authorizes a prompt the model will
 * silently truncate, which is the one failure this whole phase exists to prevent.
 *
 * `llama3` and `mistral` are measured values, read from this machine's daemon via
 * GET /api/tags -> details.context_length. The rest are vendor-documented.
 */
export const BUNDLED_MODEL_CONTEXT = Object.freeze({
  ollama: Object.freeze({
    llama3: 8192, // measured
    mistral: 32768, // measured
    'qwen2.5-coder': 32768, // vendor-documented; the shipped default model
    'llama3.1': 131072,
    'llama3.2': 131072,
  }),
})

/**
 * The bundled opinion for a provider/model pair, or null when the table is silent.
 *
 * @param {string|null} provider
 * @param {string|null} model
 * @returns {Readonly<object>|null}
 */
export function bundledCapabilityFor(provider, model) {
  const table = typeof provider === 'string' ? BUNDLED_MODEL_CONTEXT[provider] : undefined
  if (!table) return null

  const key = normalizeModelName(model)
  if (key === null || !Object.hasOwn(table, key)) return null

  return modelCapability({
    provider,
    model,
    contextTokens: table[key],
    source: 'bundled_default',
    detail: `bundled table entry for "${key}"; not verified against this install`,
  })
}

/* ------------------------------------------------------------ provider/model coherence */

/**
 * Which provider CLAIMS a model name, by shape.
 *
 * Coherence is decided NEGATIVELY, and that is the whole design. A positive "is this a valid
 * ollama model" test is impossible: a local tag is any string the developer pulled or built, so
 * an allowlist would reject every model nobody here enumerated. But "this name belongs to a
 * DIFFERENT provider" is decidable and catches the real misconfiguration — switching
 * `worker.provider` and forgetting `worker.model`, which is exactly the mistake dispatch already
 * warns about for `apiKeyEnv`.
 *
 * So ollama claims nothing and is listed with an empty pattern set deliberately, not by omission.
 */
export const PROVIDER_MODEL_PATTERNS = Object.freeze({
  gemini: Object.freeze([/^(models\/)?gemini-/i]),
  // Local tags are arbitrary. Claiming a shape here would make a legitimate name look wrong.
  ollama: Object.freeze([]),
  mock: Object.freeze([]),
})

/**
 * The providers whose naming shape matches `model`.
 *
 * @param {string|null} model
 * @returns {string[]} provider ids, sorted
 */
export function providersClaimingModel(model) {
  if (typeof model !== 'string' || model.trim() === '') return []
  const name = model.trim()
  const out = []
  for (const [provider, patterns] of Object.entries(PROVIDER_MODEL_PATTERNS)) {
    if (patterns.some((re) => re.test(name))) out.push(provider)
  }
  return out.sort()
}

/**
 * Is this provider/model pair coherent?
 *
 * Three outcomes, and the third is the interesting one:
 *   `ok`          — nobody else claims this name, so we cannot prove it wrong
 *   `unresolved`  — there is no model to check
 *   `mismatch`    — another registered provider claims this name and ours does not
 *
 * Never substitutes a model and never suggests one. A wrong name is reported; what to do about it
 * belongs to the human reading the report.
 *
 * @param {string|null} provider
 * @param {string|null} model
 * @returns {Readonly<{status: string, provider: string|null, model: string|null, claimedBy: string[], reason: string|null}>}
 */
export function checkProviderModel(provider, model) {
  const out = (status, reason, claimedBy = []) =>
    Object.freeze({ status, provider: provider ?? null, model: model ?? null, claimedBy: Object.freeze(claimedBy), reason })

  if (typeof model !== 'string' || model.trim() === '') {
    return out('unresolved', 'no model is configured for this provider')
  }
  if (typeof provider !== 'string' || provider.trim() === '') {
    return out('unresolved', 'no provider is configured')
  }

  const claimants = providersClaimingModel(model)
  if (claimants.length === 0 || claimants.includes(provider)) return out('ok', null, claimants)

  return out(
    'mismatch',
    `model "${model}" is named like a ${claimants.join('/')} model, but the provider is "${provider}"`,
    claimants,
  )
}

/**
 * Coherence of every worker pair a config describes: the global one, and any lane that states a
 * model of its own.
 *
 * A lane whose model is null INHERITS, and the inherited pair is already reported as `worker`, so
 * re-reporting it per lane would turn one mistake into three. Only `provider` inheritance is
 * reproduced here — one `??` — rather than importing resolveWorker, because config.mjs may not
 * reach into the dispatch layer and a second copy of the full inheritance table would be a
 * second thing to keep in sync.
 *
 * @param {object} config  a resolved config
 * @returns {Readonly<object>}
 */
export function workerCoherence(config) {
  const worker = config?.worker ?? {}
  const checks = { worker: checkProviderModel(worker.provider ?? null, worker.model ?? null) }

  for (const lane of ['bulkRead', 'codeWrite']) {
    const laneCfg = config?.workers?.[lane] ?? {}
    if (laneCfg.model === null || laneCfg.model === undefined) continue
    checks[lane] = checkProviderModel(laneCfg.provider ?? worker.provider ?? null, laneCfg.model)
  }

  const problems = Object.entries(checks).filter(([, c]) => c.status !== 'ok')
  return Object.freeze({
    ok: problems.length === 0,
    checks: Object.freeze(checks),
    problems: Object.freeze(problems.map(([scope, c]) => Object.freeze({ scope, ...c }))),
  })
}

/* ---------------------------------------------------------------------- conformance */

/**
 * Problems with a capability record, as strings. Empty means well-formed.
 *
 * Used by the provider conformance suite so a `describeModel` implementation cannot quietly
 * return a shape nothing else understands.
 *
 * @param {object} rec
 * @returns {string[]}
 */
export function validateCapabilityRecord(rec) {
  const problems = []
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return ['capability must be a plain object']
  }

  if (!CAPABILITY_SOURCES.includes(rec.source)) {
    problems.push(`capability.source must be one of ${CAPABILITY_SOURCES.join(', ')}`)
  }
  if (!CAPABILITY_STATUSES.includes(rec.status)) {
    problems.push(`capability.status must be one of ${CAPABILITY_STATUSES.join(', ')}`)
  }
  if (CAPABILITY_SOURCES.includes(rec.source) && rec.status !== statusForSource(rec.source)) {
    problems.push(`capability.status "${rec.status}" does not match source "${rec.source}"`)
  }

  const ctx = rec.contextTokens
  if (ctx !== null && !(Number.isInteger(ctx) && ctx > 0)) {
    problems.push('capability.contextTokens must be a positive integer or null')
  }

  // The invariant. A number with an unknown status would be a value nobody can weigh; an unknown
  // status with a number would be a measurement pretending to be a guess.
  if ((ctx === null) !== (rec.status === 'unknown')) {
    problems.push('capability.contextTokens === null must coincide exactly with status "unknown"')
  }

  if (rec.maxOutputTokens !== null && !(Number.isInteger(rec.maxOutputTokens) && rec.maxOutputTokens > 0)) {
    problems.push('capability.maxOutputTokens must be a positive integer or null')
  }
  if (rec.measuredAt !== null && !Number.isInteger(rec.measuredAt)) {
    problems.push('capability.measuredAt must be an integer or null')
  }
  if (rec.measuredAt !== null && rec.source !== 'provider_api') {
    problems.push('capability.measuredAt is only meaningful when source is "provider_api"')
  }
  if (rec.detail !== null && typeof rec.detail !== 'string') {
    problems.push('capability.detail must be a string or null')
  }

  return problems
}
