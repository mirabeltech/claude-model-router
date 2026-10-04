/**
 * The budget configuration surface.
 *
 * `coerceLeaf` does the work, so this file is not retesting the config engine. It pins the
 * SEMANTICS of the budget leaves specifically, because they are the ones where a coercion
 * mistake is expensive in a way a type error is not:
 *
 *   null  -> no configured limit          (the shipped default)
 *   0     -> a configured zero budget     (refuse everything)
 *   -1    -> invalid                      (NOT a zero budget, and must not disable delegation)
 *
 * Any two of those collapsing into one another is a silent failure. A `null` read as `0` turns
 * an unconfigured install into a frozen one; a `0` read as "unset" turns a deliberate stop into
 * a blank cheque; a negative read as `0` disables delegation on a typo.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, SPEC, coerceLeaf, loadConfig, resolveConfig } from '../plugins/model-router/lib/config.mjs'
import { buildJsonSchema } from '../plugins/model-router/lib/config-schema.mjs'
import { hasConfiguredLimit } from '../plugins/model-router/lib/governance/policy.mjs'

/** Every budget leaf in the SPEC, as dotted paths. */
const BUDGET_LEAVES = Object.keys(SPEC).filter((k) => k.startsWith('budget.'))

/** The numeric limit leaves, which are the ones with the dangerous semantics. */
const LIMIT_LEAVES = BUDGET_LEAVES.filter((k) => /\.max[A-Z]/.test(k))

const get = (o, dotted) => dotted.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), o)

const resolve = (data, env = {}) => resolveConfig({ layers: [{ name: 'test', data }], env })

/* ---------------------------------------------------------------- the shape */

test('the budget block declares run, daily and monthly scopes and nothing else', () => {
  const scopes = new Set(
    BUDGET_LEAVES.filter((k) => k.split('.').length === 3).map((k) => k.split('.')[1]),
  )
  assert.deepEqual([...scopes].sort(), ['daily', 'monthly', 'run'])
})

test('the flat dailyWorkerCostUsdLimit leaf is gone, leaving one spelling per limit', () => {
  // It was renamed rather than kept alongside the nested block. Two spellings of one limit is
  // exactly the drift the SPEC/DEFAULTS parity tests exist to prevent, and the one that would
  // have been read by nothing while appearing to be configured.
  assert.equal(Object.hasOwn(SPEC, 'budget.dailyWorkerCostUsdLimit'), false)
  assert.equal(get(DEFAULTS, 'budget.dailyWorkerCostUsdLimit'), undefined)
})

test('the daily cost limit keeps its original environment variable', () => {
  // Operator muscle memory and any existing shell profile survive the rename. The leaf moved;
  // the knob people already type did not.
  assert.equal(SPEC['budget.daily.maxWorkerCostUsd'].env, 'CMR_DAILY_BUDGET_USD')
})

test('every limit leaf is nullable, because unset has to be expressible', () => {
  for (const leaf of LIMIT_LEAVES) {
    assert.equal(SPEC[leaf].nullable, true, `${leaf} must accept null`)
  }
})

test('every token limit is an integer leaf and every cost limit is a number leaf', () => {
  // A fractional token count is not a quantity that exists; a fractional dollar certainly is.
  for (const leaf of LIMIT_LEAVES) {
    const expected = /Tokens$/.test(leaf) ? 'int' : 'number'
    assert.equal(SPEC[leaf].type, expected, `${leaf} should be ${expected}`)
  }
})

test('every limit leaf has a floor of zero, which is what rejects a negative budget', () => {
  for (const leaf of LIMIT_LEAVES) {
    assert.equal(SPEC[leaf].min, 0, `${leaf} must not accept a negative limit`)
  }
})

/* ------------------------------------------------------------- the defaults */

test('every budget limit ships null, so governance is inert until configured', () => {
  // THE DEFAULT-INSTALL GUARANTEE. If any limit shipped a number, Phase 9 would be a production
  // policy change rather than infrastructure, and an upgrade would start refusing delegations
  // nobody asked it to refuse.
  for (const leaf of LIMIT_LEAVES) {
    assert.equal(get(DEFAULTS, leaf), null, `${leaf} must ship as null`)
  }
  assert.equal(hasConfiguredLimit(DEFAULTS.budget), false, 'the shipped budget configures nothing')
})

test('the shipped policy switches are conservative but do not break a free provider', () => {
  // `allow` on both unknown paths is what keeps an unpriced or usage-silent provider working.
  // Defaulting either to `deny` would disable delegation on a default install, because every
  // rate in the bundled pricing table ships null.
  assert.equal(DEFAULTS.budget.enabled, true)
  assert.equal(DEFAULTS.budget.onExceed, 'disable')
  assert.equal(DEFAULTS.budget.onUnknownCost, 'allow')
  assert.equal(DEFAULTS.budget.onUnknownUsage, 'allow')
})

test('the state directory defaults outside the plugin, beside the telemetry store', () => {
  // It has to survive an uninstall for the same reason the telemetry dir does: a budget that
  // reset whenever the plugin was reinstalled would not be a budget.
  assert.equal(DEFAULTS.budget.stateDir, '~/.claude/model-router/governance')
  assert.notEqual(DEFAULTS.budget.stateDir, DEFAULTS.telemetry.dir, 'mutable state is not the log')
})

/* ---------------------------------------------------------------- coercion */

test('null is accepted on every limit leaf', () => {
  for (const leaf of LIMIT_LEAVES) {
    const r = coerceLeaf(SPEC[leaf], null)
    assert.equal(r.ok, true, `${leaf} rejected null: ${r.reason}`)
    assert.equal(r.value, null, `${leaf} coerced null into ${r.value}`)
  }
})

test('zero is accepted and stays zero, distinct from null', () => {
  for (const leaf of LIMIT_LEAVES) {
    const r = coerceLeaf(SPEC[leaf], 0)
    assert.equal(r.ok, true, `${leaf} rejected 0: ${r.reason}`)
    assert.equal(r.value, 0, `${leaf} did not keep 0`)
    assert.notEqual(r.value, null, `${leaf} turned a configured zero into "unset"`)
  }
})

test('a positive limit is accepted', () => {
  for (const leaf of LIMIT_LEAVES) {
    const r = coerceLeaf(SPEC[leaf], 5)
    assert.equal(r.ok, true, `${leaf} rejected 5: ${r.reason}`)
    assert.equal(r.value, 5)
  }
})

test('a negative limit is rejected, and the default is used instead', () => {
  for (const leaf of LIMIT_LEAVES) {
    const r = coerceLeaf(SPEC[leaf], -1)
    assert.equal(r.ok, false, `${leaf} accepted -1`)
  }
})

test('a fractional token limit is rejected, while a fractional dollar limit is not', () => {
  assert.equal(coerceLeaf(SPEC['budget.daily.maxTotalTokens'], 1.5).ok, false)
  assert.equal(coerceLeaf(SPEC['budget.daily.maxWorkerCostUsd'], 1.5).ok, true)
})

test('a non-finite limit is rejected rather than stored', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(coerceLeaf(SPEC['budget.daily.maxTotalTokens'], bad).ok, false, String(bad))
    assert.equal(coerceLeaf(SPEC['budget.daily.maxWorkerCostUsd'], bad).ok, false, String(bad))
  }
})

test('a string limit in a JSON file is a mistake, and is surfaced rather than parsed', () => {
  // The repo's deliberate asymmetry: an env var is text and must be parsed, a JSON file saying
  // "500" is a typo worth reporting. Silently parsing it would hide a real configuration error.
  assert.equal(coerceLeaf(SPEC['budget.daily.maxTotalTokens'], '500').ok, false)
  assert.equal(
    coerceLeaf(SPEC['budget.daily.maxTotalTokens'], '500', { fromEnv: true }).value,
    500,
    'but the same text from an env var is parsed',
  )
})

test('the policy switches reject an unlisted value', () => {
  assert.equal(coerceLeaf(SPEC['budget.onExceed'], 'explode').ok, false)
  assert.equal(coerceLeaf(SPEC['budget.onUnknownCost'], 'maybe').ok, false)
  assert.equal(coerceLeaf(SPEC['budget.onUnknownUsage'], 'sometimes').ok, false)
  assert.equal(coerceLeaf(SPEC['budget.stateDir'], '').ok, false, 'an empty path is not a path')
})

/* ----------------------------------------------------------------- layering */

test('a project file can configure a budget, and the value survives resolution', () => {
  const r = resolve({ budget: { daily: { maxTotalTokens: 1234, maxWorkerCostUsd: 2.5 } } })
  assert.deepEqual(r.warnings, [])
  assert.equal(r.config.budget.daily.maxTotalTokens, 1234)
  assert.equal(r.config.budget.daily.maxWorkerCostUsd, 2.5)
  // And the leaves it did not name are still null rather than inheriting the one it did.
  assert.equal(r.config.budget.monthly.maxTotalTokens, null)
})

test('a negative budget in a file warns and falls back to the default, never blocking', () => {
  // FAILS OPEN. `loadConfig()` never throws, so a bad budget degrades to an unconfigured one
  // rather than to a router that refuses everything.
  const r = resolve({ budget: { daily: { maxTotalTokens: -5 } } })
  assert.equal(r.config.budget.daily.maxTotalTokens, null, 'the default is null, so it stays null')
  assert.ok(
    r.warnings.some((w) => w.field === 'budget.daily.maxTotalTokens'),
    `expected a warning, got ${JSON.stringify(r.warnings)}`,
  )
})

test('every budget leaf can be set from its environment variable', () => {
  const env = {}
  for (const leaf of BUDGET_LEAVES) {
    const spec = SPEC[leaf]
    env[spec.env] = spec.type === 'bool' ? 'true' : spec.type === 'enum' ? spec.values[0] : spec.type === 'string' ? '/tmp/x' : '7'
  }
  const r = resolve({}, env)
  for (const leaf of BUDGET_LEAVES) {
    assert.equal(r.sources[leaf], `env:${SPEC[leaf].env}`, `${leaf} did not come from its env var`)
  }
  assert.equal(r.config.budget.daily.maxTotalTokens, 7)
})

test('an unknown budget key is reported rather than silently ignored', () => {
  const r = resolve({ budget: { dailyWorkerCostUsdLimit: 5 } })
  assert.ok(
    r.warnings.some((w) => w.field === 'budget.dailyWorkerCostUsdLimit' && w.reason.includes('unknown')),
    `the old flat key must be reported, got ${JSON.stringify(r.warnings)}`,
  )
})

test('loadConfig resolves the state directory once, like the telemetry directory', () => {
  // So no downstream consumer re-implements `~`. The ledger reads `stateDirResolved`.
  const { config } = loadConfig({ env: {}, projectDir: 'C:/nowhere', home: 'C:/Users/example' })
  assert.equal(typeof config.budget.stateDirResolved, 'string')
  assert.equal(config.budget.stateDirResolved.includes('~'), false, 'the tilde must be expanded')
  assert.ok(config.budget.stateDirResolved.includes('example'), 'it must expand to the given home')
})

test('stateDirResolved is derived, so it is not reported as an unknown field', () => {
  // It is set after `unknownLeaves()` runs, exactly as `telemetry.dirResolved` is.
  const { warnings } = loadConfig({ env: {}, projectDir: 'C:/nowhere', home: 'C:/Users/example' })
  assert.equal(
    warnings.some((w) => String(w.field).includes('stateDirResolved')),
    false,
    `a derived key must not be flagged: ${JSON.stringify(warnings)}`,
  )
})

/* ------------------------------------------------------------------ schema */

test('the generated schema describes every budget leaf, with its default and bounds', () => {
  const schema = buildJsonSchema()
  for (const leaf of BUDGET_LEAVES) {
    const node = leaf.split('.').reduce((acc, k) => acc?.properties?.[k], schema)
    assert.ok(node, `${leaf} is missing from the generated schema`)
    assert.deepEqual(node.default, get(DEFAULTS, leaf), `${leaf} default disagrees with DEFAULTS`)
  }
})

test('a nullable limit is expressed as a type union in the schema', () => {
  const schema = buildJsonSchema()
  const node = schema.properties.budget.properties.daily.properties.maxTotalTokens
  assert.deepEqual(node.type, ['integer', 'null'], 'null must be a legal value in the schema too')
  assert.equal(node.minimum, 0)
})

test('every budget leaf carries prose, not just an environment variable name', () => {
  // A leaf with no DESCRIPTIONS entry ships with only "Env override: CMR_X." — which is how the
  // flat `dailyWorkerCostUsdLimit` shipped undocumented for eight phases. Governance semantics
  // are too easy to get wrong to leave to the reader.
  const schema = buildJsonSchema()
  const bare = []
  for (const leaf of BUDGET_LEAVES) {
    const node = leaf.split('.').reduce((acc, k) => acc?.properties?.[k], schema)
    const prose = String(node.description ?? '').replace(/Env override: \w+\./, '').trim()
    if (prose.length === 0) bare.push(leaf)
  }
  assert.deepEqual(bare, [], 'these budget leaves have no description')
})

test('the budget object rejects an unknown property in the schema', () => {
  const schema = buildJsonSchema()
  assert.equal(schema.properties.budget.additionalProperties, false)
  for (const scope of ['run', 'daily', 'monthly']) {
    assert.equal(schema.properties.budget.properties[scope].additionalProperties, false, scope)
  }
})

test('a per-direction daily ceiling is an unknown field, dropped with a warning', () => {
  // THE SPEC/POLICY ASYMMETRY, pinned rather than "fixed". `policy.mjs` iterates four limit leaves
  // across all three scopes, but SPEC declares maxInputTokens and maxOutputTokens for `run` only.
  // So `budget.daily.maxInputTokens` looks plausible, would be read by the policy walker, and is
  // rejected by config validation.
  //
  // Deliberately left that way. Declaring eight more leaves is scope the limit does not earn — a
  // per-direction ceiling across a whole UTC day has no actionable remedy when you hit it — and
  // narrowing the policy loop would make a module that imports NOTHING depend on SPEC, which is
  // the property that lets config.mjs read the coherence rules without pulling a provider onto
  // the hot path.
  //
  // What matters is that the value never reaches the policy silently. It does not: it is dropped
  // before `config.budget` is assembled, so describeGovernance() never sees it.
  const r = resolveConfig({
    layers: [{ name: 'project', data: { budget: { daily: { maxInputTokens: 1000 } } } }],
    env: {},
  })

  const unknown = r.warnings.filter((w) => w.reason === 'unknown field, ignored')
  assert.equal(unknown.length, 1, 'exactly one warning, naming the leaf')
  assert.equal(unknown[0].field, 'budget.daily.maxInputTokens')
  assert.equal(r.config.budget.daily.maxInputTokens, undefined, 'and it is absent from the result')

  // The control: the same leaf under `run` is a real setting and resolves.
  const ok = resolveConfig({
    layers: [{ name: 'project', data: { budget: { run: { maxInputTokens: 1000 } } } }],
    env: {},
  })
  assert.deepEqual(ok.warnings, [])
  assert.equal(ok.config.budget.run.maxInputTokens, 1000)
})
