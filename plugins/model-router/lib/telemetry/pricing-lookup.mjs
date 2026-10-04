/**
 * Pricing resolution. PURE: operates on in-memory tables, never touches the filesystem.
 * This module must never gain a `node:` import — a test enforces that statically.
 *
 * Two rules, both load-bearing:
 *
 *  1. FIRST MATCH WINS; TABLES ARE NEVER MERGED. Enforced at ROW granularity. If an override
 *     file has a row for a model with only `inputPerMTok` set, that row wins entirely and the
 *     absent `outputPerMTok` is null (unpriced) rather than inherited from the bundled table.
 *     A field-level merge would blend two vendors' price lists into a number nobody published.
 *
 *  2. NO PREFIX, NORMALIZATION OR FUZZY MATCHING. A key of `gemini-3.8-flash` must not match a
 *     served `gemini-3.8-flash-thinking-max`: that would price an unknown model at a known
 *     model's rate, which is a guessed rate. An unmatched model is a refusal, not a best effort.
 */

/** Tables declaring anything other than per-million-token USD are rejected rather than converted. */
export const REQUIRED_UNIT = 'per_mtok'
export const REQUIRED_CURRENCY = 'USD'

/**
 * Is this object a usable pricing table?
 *
 * The `unit` literal is the guard that matters: a hand-written per-token table would otherwise
 * produce costs 10^6 times too low and look entirely plausible on a dashboard.
 *
 * @returns {string[]} problems; empty means usable
 */
export function validatePricingTable(table) {
  const problems = []
  if (typeof table !== 'object' || table === null) return ['table must be an object']
  if (typeof table.pricingVersion !== 'string' || table.pricingVersion === '') {
    problems.push('pricingVersion must be a non-empty string')
  }
  if (table.unit !== REQUIRED_UNIT) {
    problems.push(`unit must be "${REQUIRED_UNIT}" (got ${JSON.stringify(table.unit)})`)
  }
  if (table.currency !== REQUIRED_CURRENCY) {
    problems.push(`currency must be "${REQUIRED_CURRENCY}" (got ${JSON.stringify(table.currency)})`)
  }
  if (typeof table.models !== 'object' || table.models === null) {
    problems.push('models must be an object keyed by "provider:model"')
  }
  return problems
}

/** A finite number, or null. A rate of 0 is legitimate and must survive this. */
function rate(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Normalize one table row to the Rates shape, so a sparse override row reads as unpriced. */
function ratesFrom(row) {
  return {
    inputPerMTok: rate(row?.inputPerMTok),
    cachedInputPerMTok: rate(row?.cachedInputPerMTok),
    cacheWritePerMTok: rate(row?.cacheWritePerMTok),
    outputPerMTok: rate(row?.outputPerMTok),
  }
}

function keyFor(provider, model) {
  return `${provider}:${model}`
}

/**
 * Resolve rates for one call.
 *
 * @param {Array<{table: object, source: string}>} chain  ordered; first ROW hit wins
 * @param {Object} a
 * @param {string|null} a.provider
 * @param {string|null} a.servedModel     CompletionResult.model — what the provider says it ran
 * @param {string|null} a.requestedModel  config.worker.model — what we asked for
 * @returns {{rates: object|null, lookup: string, pricingSource: string, pricingVersion: string|null,
 *            matchedKey: string|null}}
 */
export function resolveRates(chain, { provider = null, servedModel = null, requestedModel = null } = {}) {
  const tables = Array.isArray(chain) ? chain.filter((e) => e && e.table) : []
  if (tables.length === 0) {
    return { rates: null, lookup: 'no_table', pricingSource: 'none', pricingVersion: null, matchedKey: null }
  }
  if (provider === null || provider === undefined || provider === '') {
    return { rates: null, lookup: 'model_unknown', pricingSource: 'none', pricingVersion: null, matchedKey: null }
  }

  // Candidate keys in priority order. `requested_alias` exists because Gemini reports
  // `gemini-3.8-flash-001` for a configured `gemini-3.8-flash`, so the served name misses a table
  // keyed on the configured name. The wildcard lets a user price all of one provider in one row.
  const candidates = []
  if (servedModel) candidates.push([keyFor(provider, servedModel), 'exact'])
  if (requestedModel && requestedModel !== servedModel) {
    candidates.push([keyFor(provider, requestedModel), 'requested_alias'])
  }
  candidates.push([keyFor(provider, '*'), 'wildcard'])

  // Row granularity: for each key, walk every table before moving to the next key. This is what
  // makes "first match wins" mean "the highest-priority table that has THIS row", so an override
  // file containing only one model does not shadow the bundled table for every other model.
  for (const [key, lookup] of candidates) {
    for (const entry of tables) {
      const row = entry.table?.models?.[key]
      if (row) {
        return {
          rates: ratesFrom(row),
          lookup,
          pricingSource: entry.source,
          pricingVersion: entry.table.pricingVersion ?? null,
          matchedKey: key,
        }
      }
    }
  }

  // A model present in no table. Distinguished from a null-rate row by `lookup`, which is what
  // tells an operator whether to add a row or to fill in a rate.
  //
  // `pricingSource` names the table a row should be added to; `pricingVersion` stays null,
  // because no table priced this event and a version stamp would claim otherwise.
  return {
    rates: null,
    lookup: 'model_unknown',
    pricingSource: tables[0].source,
    pricingVersion: null,
    matchedKey: null,
  }
}
