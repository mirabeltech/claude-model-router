/**
 * Pricing chains for the evaluation framework.
 *
 * The chain is passed to `buildEvent()` EXPLICITLY and `loadPricing(config)` is never called, so a
 * `pricing.overrides` file on the developer's disk cannot move a benchmark number. That is the
 * same discipline `config.mjs` applies to settings: the eval reads its inputs from a declared
 * layer, never from the machine it happens to run on.
 *
 * THE DEFAULT ARM IS THE BUNDLED CHAIN, and it reports every monetary field as `unavailable`.
 * That is not a gap in the framework — it is the shipped reality faithfully reproduced.
 * `BUNDLED_PRICING` carries every rate as `null` on purpose, because a confident wrong dollar
 * figure is worse than a refusal to price, so out of the box the only populated headline is
 * `estimated_tokens_avoided`. A benchmark that quietly substituted plausible rates would be
 * measuring a product nobody ships.
 */

import { BUNDLED_PRICING } from '../../plugins/model-router/lib/telemetry/pricing-table.mjs'

/** No table at all: every cost is null with reason `pricing_unavailable`, lookup `no_table`. */
export const EVAL_CHAIN_NONE = Object.freeze([])

/**
 * What a user actually gets. Rows exist for every shipped model, and every rate in them is null,
 * so costs come back null with reason `rate_unpriced` — distinguishable from `model_unknown`,
 * which is the difference between "fill in a rate" and "add a row".
 */
export const EVAL_CHAIN_BUNDLED = Object.freeze([Object.freeze({ table: BUNDLED_PRICING, source: 'bundled' })])

/**
 * A fully priced FIXTURE table, for proving the money path computes at all.
 *
 * `pricingVersion` is `eval-fixture.1` and could never be mistaken for a real price list, which
 * matters because every row these rates touch is stamped with it. The rates are round numbers
 * chosen to make arithmetic checkable by hand, not estimates of anybody's price.
 *
 * A `mock:*` row is mandatory here: `test/helpers/telemetry-dir.mjs pricedTable()` has gemini,
 * ollama and anthropic rows but no mock one, so reusing it would yield `lookup: 'model_unknown'`
 * and a silently null cost on the deterministic arm.
 */
export function evalPricedChain(extraModels = {}) {
  const row = (provider, model, input, cachedInput, output) => ({
    provider,
    model,
    inputPerMTok: input,
    cachedInputPerMTok: cachedInput,
    cacheWritePerMTok: null,
    outputPerMTok: output,
    thinkingBilledAsOutput: true,
    verify: 'eval fixture: not a real price list',
    verifiedAt: null,
  })

  return [
    {
      table: {
        pricingVersion: 'eval-fixture.1',
        unit: 'per_mtok',
        currency: 'USD',
        models: {
          'mock:*': row('mock', '*', 1, 0.1, 4),
          'ollama:*': row('ollama', '*', 1, 0.1, 4),
          'anthropic:claude-opus-5': row('anthropic', 'claude-opus-5', 10, 1, 40),
          ...extraModels,
        },
      },
      source: 'file',
    },
  ]
}

/**
 * The primary model used when the priced arm needs one.
 *
 * `telemetry.primaryModel` defaults to null because the primary model is resolved from the session
 * and never guessed, which is why `estimated_cost_avoided` is null out of the box with reason
 * `primary_model_unset`. Naming one here is what lets the priced arm demonstrate that the
 * counterfactual arithmetic works — it does not make the figure a measurement.
 */
export const EVAL_PRIMARY_MODEL = 'claude-opus-5'
