/**
 * The bundled pricing table.
 *
 * EVERY RATE IS null, DELIBERATELY. The project's position is that a confident wrong dollar
 * figure is worse than a refusal to price, so rates ship as null with a `verify` URL rather than
 * as plausible-looking numbers that rot silently when a vendor changes its price list.
 *
 * The accepted consequence, stated plainly: out of the box, with default config, every monetary
 * field on every event is NULL — worker cost, cost avoided, net savings, all of it. The honest
 * out-of-box headline is `estimated_tokens_avoided`, which is fully populated and non-monetary.
 * `scripts/doctor.mjs` prints a paste-ready override snippet so the nulls are a prompt to act
 * rather than a mystery.
 *
 * This is a .mjs frozen export rather than a .json file for one concrete reason: importing JSON
 * requires `with { type: 'json' }`, which on some Node 22 lines still prints an experimental
 * warning. The writer runs inside hooks whose stdout Claude Code parses, and a stray warning on
 * that channel is exactly the class of failure the "telemetry can never break a hook" rule
 * exists to prevent. A user's override file is plain JSON and is read with readFileSync.
 *
 * To price a model: copy this row into your overrides file and fill the rates from `verify`.
 * Remember that rows are never merged — the override row wins ENTIRELY, so fill every rate you
 * want priced, not just the one you looked up.
 */

/**
 * @typedef {Object} Rates
 * @property {number|null} inputPerMTok        Uncached prompt tokens, USD per million.
 * @property {number|null} cachedInputPerMTok  Cache-READ tokens, USD per million.
 * @property {number|null} outputPerMTok       Output tokens, USD per million. Thinking bills here.
 * @property {number|null} [cacheWritePerMTok] Reserved; unused in calc_version 1.
 */

/**
 * @typedef {Object} PricingTable
 * @property {string} pricingVersion  Stamped onto every event this table prices.
 * @property {'per_mtok'} unit        Required literal. A per-token table is rejected at load.
 * @property {'USD'} currency         Required literal in v1.
 * @property {Record<string, Rates & {provider: string, model: string, verify: string,
 *           verifiedAt: string|null, thinkingBilledAsOutput: boolean}>} models
 */

const row = (provider, model, verify) =>
  Object.freeze({
    provider,
    model,
    // null is "deliberately unpriced", NOT zero. calculateCost() turns it into a NULL cost.
    inputPerMTok: null,
    cachedInputPerMTok: null,
    cacheWritePerMTok: null,
    outputPerMTok: null,
    // Documents that thinking tokens are priced at outputPerMTok rather than at a rate of
    // their own. calc_version 1 has no separate thinking rate.
    thinkingBilledAsOutput: true,
    verify,
    // The ISO date a human checked the rate against `verify`. null means never verified, which
    // is the only honest value for a table that ships unpriced.
    verifiedAt: null,
  })

/**
 * Keys are `${provider}:${model}`, never the model alone. The same model name served through
 * `ollama` and through a cloud API cost wildly different amounts, so keying on the model would
 * price a local model at cloud rates.
 */
export const BUNDLED_PRICING = Object.freeze({
  pricingVersion: 'bundled-unpriced.1',
  unit: 'per_mtok',
  currency: 'USD',
  models: Object.freeze({
    'gemini:gemini-3.8-flash': row('gemini', 'gemini-3.8-flash', 'https://ai.google.dev/pricing'),
    'gemini:gemini-3.1-flash-lite': row('gemini', 'gemini-3.1-flash-lite', 'https://ai.google.dev/pricing'),
    'gemini:gemini-3.5-flash-lite': row('gemini', 'gemini-3.5-flash-lite', 'https://ai.google.dev/pricing'),
    'gemini:gemini-3.1-pro-preview': row('gemini', 'gemini-3.1-pro-preview', 'https://ai.google.dev/pricing'),

    // Wildcard: local inference has no per-token bill. Users who do not track hardware cost can
    // set these to 0 in an override, which yields a genuine `actual` zero rather than a NULL.
    'ollama:*': row(
      'ollama',
      '*',
      'local inference — set rates to 0 in pricing.overrides if you do not track hardware cost',
    ),

    'mock:*': row('mock', '*', 'test provider — not billable'),

    // Primary (counterfactual) models. Priced at inputPerMTok only by
    // calculateEstimatedCostAvoided, since the counterfactual difference is input-side.
    'anthropic:claude-opus-5': row('anthropic', 'claude-opus-5', 'https://claude.com/pricing'),
    'anthropic:claude-sonnet-5-5': row('anthropic', 'claude-sonnet-5-5', 'https://claude.com/pricing'),
    'anthropic:claude-haiku-4-5-20251001': row(
      'anthropic',
      'claude-haiku-4-5-20251001',
      'https://claude.com/pricing',
    ),
  }),
})

/** Rows whose every rate is null. Used by doctor to report what still needs a rate. */
export function unpricedModels(table = BUNDLED_PRICING) {
  const out = []
  for (const [key, r] of Object.entries(table?.models ?? {})) {
    const priced = [r.inputPerMTok, r.cachedInputPerMTok, r.outputPerMTok].some(
      (x) => typeof x === 'number' && Number.isFinite(x),
    )
    if (!priced) out.push({ key, verify: r.verify })
  }
  return out
}
