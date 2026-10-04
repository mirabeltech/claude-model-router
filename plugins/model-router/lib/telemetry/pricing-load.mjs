/**
 * Build the pricing chain from config. The thin I/O wrapper around the pure lookup, mirroring the
 * readJsonLayer() pattern in config.mjs: synchronous, fail-open, never throws.
 *
 * A bad pricing file must never break a hook. An unreadable or schema-invalid override is dropped
 * from the chain with a warning, and `pricing_source` on the event records whichever table
 * actually served — so the data says what happened rather than what was configured.
 */

import fs from 'node:fs'
import { BUNDLED_PRICING } from './pricing-table.mjs'
import { validatePricingTable } from './pricing-lookup.mjs'

/**
 * Resolve `pricing.source` / `pricing.overrides` into an ordered chain for resolveRates().
 *
 * | pricing.source | overrides | chain                    |
 * |----------------|-----------|--------------------------|
 * | bundled        | null      | [bundled]                |
 * | bundled        | set       | [overrides, bundled]     |
 * | file           | set       | [overrides]  (no fallback) |
 * | file           | null      | []           -> every cost NULL |
 *
 * `source: 'file'` deliberately does NOT fall back to bundled: a user who declares their own
 * table has said the bundled rates do not apply to them, and quietly reintroducing those rates
 * would price their events against numbers they rejected.
 *
 * @returns {{chain: Array<{table: object, source: string}>, warnings: Array<object>}}
 */
export function loadPricing(config, { fsImpl = fs, readFile } = {}) {
  const warnings = []
  const chain = []
  const source = config?.pricing?.source ?? 'bundled'
  const overridesPath = config?.pricing?.overrides ?? null

  if (overridesPath) {
    const loaded = readOverrides(overridesPath, { fsImpl, readFile })
    if (loaded.table) {
      chain.push({ table: loaded.table, source: 'file' })
    } else {
      warnings.push({ scope: 'pricing', field: 'pricing.overrides', reason: loaded.reason })
    }
  } else if (source === 'file') {
    warnings.push({
      scope: 'pricing',
      field: 'pricing.overrides',
      reason: 'pricing.source is "file" but pricing.overrides is not set; no rates are available',
    })
  }

  if (source !== 'file') chain.push({ table: BUNDLED_PRICING, source: 'bundled' })

  return { chain, warnings }
}

/** Read and validate one override file. Returns {table} or {reason}; never throws. */
export function readOverrides(filePath, { fsImpl = fs, readFile } = {}) {
  let text
  try {
    text = readFile ? readFile(filePath) : fsImpl.readFileSync(filePath, 'utf8')
  } catch (err) {
    return { table: null, reason: `cannot read ${filePath}: ${err?.code ?? err?.message ?? 'unknown error'}` }
  }

  let parsed
  try {
    // Strip a UTF-8 BOM: PowerShell's Out-File writes one, and JSON.parse rejects it.
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (err) {
    return { table: null, reason: `${filePath} is not valid JSON: ${err?.message ?? 'parse error'}` }
  }

  const problems = validatePricingTable(parsed)
  if (problems.length > 0) {
    return { table: null, reason: `${filePath} is not a usable pricing table: ${problems.join('; ')}` }
  }
  return { table: parsed, reason: null }
}
