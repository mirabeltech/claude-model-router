/**
 * Pricing resolution.
 *
 * Two properties carry the whole design: an unmatched model is a REFUSAL rather than a best
 * effort, and tables are never merged at field granularity. Both exist because a guessed rate
 * produces a confident wrong dollar figure, which is worse than no figure at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { BUNDLED_PRICING, unpricedModels } from '../plugins/model-router/lib/telemetry/pricing-table.mjs'
import { resolveRates, validatePricingTable } from '../plugins/model-router/lib/telemetry/pricing-lookup.mjs'
import { loadPricing, readOverrides } from '../plugins/model-router/lib/telemetry/pricing-load.mjs'
import { makeTempDir, pricedTable } from './helpers/telemetry-dir.mjs'

const bundled = [{ table: BUNDLED_PRICING, source: 'bundled' }]
const priced = [{ table: pricedTable(), source: 'file' }]

/* --------------------------------------------------------- the bundled table */

test('every bundled rate ships null, so no event is priced against a guess', () => {
  for (const [key, row] of Object.entries(BUNDLED_PRICING.models)) {
    for (const f of ['inputPerMTok', 'cachedInputPerMTok', 'outputPerMTok']) {
      assert.equal(row[f], null, `${key}.${f} must ship null`)
    }
    assert.equal(typeof row.verify, 'string', `${key} must carry a verify pointer`)
    assert.equal(row.verifiedAt, null, `${key}.verifiedAt must be null on an unpriced table`)
  }
})

test('the bundled table declares per-million-token USD', () => {
  assert.equal(BUNDLED_PRICING.unit, 'per_mtok')
  assert.equal(BUNDLED_PRICING.currency, 'USD')
  assert.equal(typeof BUNDLED_PRICING.pricingVersion, 'string')
  assert.deepEqual(validatePricingTable(BUNDLED_PRICING), [])
})

test('doctor can list what still needs a rate', () => {
  const rows = unpricedModels(BUNDLED_PRICING)
  assert.equal(rows.length, Object.keys(BUNDLED_PRICING.models).length)
  assert.ok(rows.every((r) => typeof r.verify === 'string'))
  assert.equal(unpricedModels(pricedTable()).length, 0)
})

/* ------------------------------------------------------------ table validation */

test('a per-token table is rejected rather than silently producing costs a million times low', () => {
  const problems = validatePricingTable({ ...pricedTable(), unit: 'per_token' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unit must be "per_mtok"/)
})

test('a non-USD table is rejected rather than converted', () => {
  const problems = validatePricingTable({ ...pricedTable(), currency: 'EUR' })
  assert.match(problems.join(' '), /currency must be "USD"/)
})

test('a table with no pricingVersion is rejected — an event must be able to name its table', () => {
  assert.match(validatePricingTable({ ...pricedTable(), pricingVersion: '' }).join(' '), /pricingVersion/)
})

/* ------------------------------------------------------------------- lookup */

test('an exact provider and served model match wins first', () => {
  const r = resolveRates(priced, { provider: 'gemini', servedModel: 'gemini-2.5-flash', requestedModel: 'gemini-2.5-flash' })
  assert.equal(r.lookup, 'exact')
  assert.equal(r.rates.inputPerMTok, 0.3)
  assert.equal(r.pricingSource, 'file')
  assert.equal(r.pricingVersion, 'test.1')
})

test('a served model with a vendor suffix falls back to the requested name, not to a prefix match', () => {
  // Gemini reports gemini-2.5-flash-001 for a configured gemini-2.5-flash.
  const r = resolveRates(priced, {
    provider: 'gemini',
    servedModel: 'gemini-2.5-flash-001',
    requestedModel: 'gemini-2.5-flash',
  })
  assert.equal(r.lookup, 'requested_alias')
  assert.equal(r.rates.inputPerMTok, 0.3)
})

test('no prefix matching: an unknown variant is a refusal, never a known model\'s rate', () => {
  const r = resolveRates(priced, {
    provider: 'gemini',
    servedModel: 'gemini-2.5-flash-thinking-max',
    requestedModel: 'gemini-2.5-flash-thinking-max',
  })
  assert.equal(r.lookup, 'model_unknown')
  assert.equal(r.rates, null)
  assert.equal(r.pricingVersion, null, 'nothing priced this row, so no version may be stamped')
})

test('a wildcard row prices a whole provider in one line', () => {
  const r = resolveRates(priced, { provider: 'ollama', servedModel: 'qwen2.5-coder:7b', requestedModel: 'qwen2.5-coder:7b' })
  assert.equal(r.lookup, 'wildcard')
  assert.equal(r.rates.inputPerMTok, 0)
})

test('the pricing key includes the provider, so a local model is never priced at cloud rates', () => {
  const table = pricedTable({
    'ollama:gemini-2.5-flash': {
      provider: 'ollama',
      model: 'gemini-2.5-flash',
      inputPerMTok: 0,
      cachedInputPerMTok: 0,
      outputPerMTok: 0,
      verify: 'local',
      verifiedAt: null,
    },
  })
  const chain = [{ table, source: 'file' }]
  const cloud = resolveRates(chain, { provider: 'gemini', servedModel: 'gemini-2.5-flash' })
  const local = resolveRates(chain, { provider: 'ollama', servedModel: 'gemini-2.5-flash' })
  assert.equal(cloud.rates.inputPerMTok, 0.3)
  assert.equal(local.rates.inputPerMTok, 0)
})

test('an empty chain is no_table, which is distinct from an unknown model', () => {
  const r = resolveRates([], { provider: 'gemini', servedModel: 'gemini-2.5-flash' })
  assert.equal(r.lookup, 'no_table')
  assert.equal(r.pricingSource, 'none')
  assert.equal(r.pricingVersion, null)
})

test('a null provider cannot be priced', () => {
  assert.equal(resolveRates(priced, { provider: null, servedModel: 'x' }).lookup, 'model_unknown')
})

test('a present row with null rates is exact, so it is distinguishable from an unknown model', () => {
  const r = resolveRates(bundled, { provider: 'gemini', servedModel: 'gemini-2.5-flash' })
  assert.equal(r.lookup, 'exact')
  assert.equal(r.rates.inputPerMTok, null)
  // Both yield a null cost; pricing_lookup is what tells an operator which fix applies.
  assert.notEqual(r.lookup, 'model_unknown')
})

/* ----------------------------------------------- never merged, row granularity */

test('an override row wins entirely — an absent rate does not inherit from the bundled table', () => {
  const sparse = {
    pricingVersion: 'sparse.1',
    unit: 'per_mtok',
    currency: 'USD',
    models: {
      'gemini:gemini-2.5-flash': {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        inputPerMTok: 0.3,
        verify: 'test',
        verifiedAt: null,
      },
    },
  }
  const chain = [
    { table: sparse, source: 'file' },
    { table: pricedTable(), source: 'bundled' },
  ]
  const r = resolveRates(chain, { provider: 'gemini', servedModel: 'gemini-2.5-flash' })
  assert.equal(r.rates.inputPerMTok, 0.3)
  // A field-level merge would blend two price lists into a number nobody published.
  assert.equal(r.rates.outputPerMTok, null)
  assert.equal(r.pricingVersion, 'sparse.1')
})

test('a one-row override does not shadow the lower table for every other model', () => {
  const oneRow = {
    pricingVersion: 'one.1',
    unit: 'per_mtok',
    currency: 'USD',
    models: {
      'gemini:gemini-2.5-flash': { provider: 'gemini', model: 'gemini-2.5-flash', inputPerMTok: 9, verify: 't', verifiedAt: null },
    },
  }
  const chain = [
    { table: oneRow, source: 'file' },
    { table: pricedTable(), source: 'bundled' },
  ]
  const overridden = resolveRates(chain, { provider: 'gemini', servedModel: 'gemini-2.5-flash' })
  const untouched = resolveRates(chain, { provider: 'anthropic', servedModel: 'claude-opus-5' })
  assert.equal(overridden.rates.inputPerMTok, 9)
  assert.equal(overridden.pricingSource, 'file')
  assert.equal(untouched.rates.inputPerMTok, 15)
  assert.equal(untouched.pricingSource, 'bundled', 'the bundled table still serves rows the override lacks')
})

/* ------------------------------------------------------------------ loading */

test('the default chain is the bundled table alone', () => {
  const { chain, warnings } = loadPricing({ pricing: { source: 'bundled', overrides: null } })
  assert.equal(chain.length, 1)
  assert.equal(chain[0].source, 'bundled')
  assert.deepEqual(warnings, [])
})

test('source file with no overrides path leaves no rates at all, with a warning', () => {
  const { chain, warnings } = loadPricing({ pricing: { source: 'file', overrides: null } })
  assert.equal(chain.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].reason, /no rates are available/)
})

test('source file does not fall back to the bundled table', () => {
  const tmp = makeTempDir('pricing-file')
  try {
    const file = path.join(tmp.dir, 'rates.json')
    fs.writeFileSync(file, JSON.stringify(pricedTable()))
    const { chain } = loadPricing({ pricing: { source: 'file', overrides: file } })
    assert.equal(chain.length, 1)
    assert.equal(chain[0].source, 'file')
  } finally {
    tmp.cleanup()
  }
})

test('an unreadable overrides file is dropped with a warning and nothing throws', () => {
  const { chain, warnings } = loadPricing({
    pricing: { source: 'bundled', overrides: path.join('does', 'not', 'exist.json') },
  })
  assert.equal(chain.length, 1)
  assert.equal(chain[0].source, 'bundled')
  assert.match(warnings[0].reason, /cannot read/)
})

test('an invalid-JSON overrides file is dropped with a warning and nothing throws', () => {
  const tmp = makeTempDir('pricing-bad')
  try {
    const file = path.join(tmp.dir, 'rates.json')
    fs.writeFileSync(file, '{ not json')
    const { chain, warnings } = loadPricing({ pricing: { source: 'bundled', overrides: file } })
    assert.equal(chain.length, 1)
    assert.equal(chain[0].source, 'bundled')
    assert.match(warnings[0].reason, /not valid JSON/)
  } finally {
    tmp.cleanup()
  }
})

test('a schema-invalid overrides file is dropped with a warning', () => {
  const tmp = makeTempDir('pricing-invalid')
  try {
    const file = path.join(tmp.dir, 'rates.json')
    fs.writeFileSync(file, JSON.stringify({ ...pricedTable(), unit: 'per_token' }))
    const { chain, warnings } = loadPricing({ pricing: { source: 'bundled', overrides: file } })
    assert.equal(chain.length, 1)
    assert.equal(chain[0].source, 'bundled')
    assert.match(warnings[0].reason, /not a usable pricing table/)
  } finally {
    tmp.cleanup()
  }
})

test('the published override schema is valid JSON and matches what the bundled table provides', () => {
  // The schema is what a user writes their overrides file against, so it must not drift from the
  // rows the loader actually accepts.
  const schemaPath = path.join('plugins', 'model-router', 'lib', 'telemetry', 'pricing.schema.json')
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
  assert.equal(schema.properties.unit.const, 'per_mtok')
  assert.equal(schema.properties.currency.const, 'USD')
  assert.deepEqual(schema.required, ['pricingVersion', 'unit', 'currency', 'models'])

  const rowRequired = schema.properties.models.additionalProperties.required
  for (const [key, row] of Object.entries(BUNDLED_PRICING.models)) {
    for (const f of rowRequired) assert.ok(f in row, `${key} is missing the required field ${f}`)
  }
  for (const f of ['inputPerMTok', 'cachedInputPerMTok', 'outputPerMTok', 'verify', 'verifiedAt']) {
    assert.ok(f in schema.properties.models.additionalProperties.properties, `schema omits ${f}`)
  }
})

test('a BOM-prefixed overrides file still parses — PowerShell writes one', () => {
  const tmp = makeTempDir('pricing-bom')
  try {
    const file = path.join(tmp.dir, 'rates.json')
    fs.writeFileSync(file, `﻿${JSON.stringify(pricedTable())}`, 'utf8')
    const { table, reason } = readOverrides(file)
    assert.equal(reason, null)
    assert.equal(table.pricingVersion, 'test.1')
  } finally {
    tmp.cleanup()
  }
})
