/**
 * The capability model.
 *
 * One rule carries this file: A CONFIGURED VALUE MUST NEVER BE PRESENTABLE AS A MEASURED ONE.
 * Three different numbers get called "the context limit" — what the operator set, what the
 * provider advertises, what the runtime actually served — and the only thing standing between
 * them is that `source` and `status` travel with every number through one mapping function.
 *
 * The second rule is the invariant: `contextTokens === null` exactly when `status === 'unknown'`.
 * A number with an unknown status would be a value nobody can weigh; an unknown status carrying a
 * number would be a measurement pretending to be a guess.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUNDLED_MODEL_CONTEXT,
  CAPABILITY_SOURCES,
  CAPABILITY_STATUSES,
  CAPABILITY_TRUST_ORDER,
  PROVIDER_MODEL_PATTERNS,
  bundledCapabilityFor,
  checkProviderModel,
  modelCapability,
  normalizeModelName,
  providersClaimingModel,
  resolveCapability,
  statusForSource,
  unknownCapability,
  validateCapabilityRecord,
  workerCoherence,
} from '../plugins/model-router/lib/providers/capability.mjs'
import {
  WORKER_CONTEXT_SOURCES,
  WORKER_CONTEXT_STATUSES,
} from '../plugins/model-router/lib/telemetry/record.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.join(HERE, '..', 'plugins', 'model-router', 'lib', 'providers', 'capability.mjs')

const measured = (n = 8192) =>
  modelCapability({ provider: 'ollama', model: 'llama3:latest', contextTokens: n, source: 'provider_api', measuredAt: 1 })

/* -------------------------------------------------------------------- purity */

test('the module imports nothing, so config.mjs can read it without loading a provider', () => {
  // config.mjs imports workerCoherence from here. That is only safe while this file stays pure:
  // teaching config.mjs to import provider MODULES would put all three behind every tool call.
  const src = fs.readFileSync(MODULE, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/^\s*import\s/m.test(stripped), false, 'capability.mjs must import nothing')
  assert.equal(/\bimport\s*\(/.test(stripped), false)
  assert.equal(/Date\.now|Math\.random|process\.|node:/.test(stripped), false)
})

/* ------------------------------------------------------- source and status */

test('statusForSource is total over the declared sources, and unrecognised degrades', () => {
  for (const source of CAPABILITY_SOURCES) {
    assert.ok(CAPABILITY_STATUSES.includes(statusForSource(source)), `${source} mapped outside the vocabulary`)
  }
  // An unknown source cannot become a confident status by accident.
  for (const junk of ['measured', 'guess', '', null, undefined, 42]) {
    assert.equal(statusForSource(junk), 'unknown')
  }
})

test('only provider_api earns "measured" — a configured number never does', () => {
  // THE RULE. Everything else in this module exists to keep this one true.
  assert.equal(statusForSource('provider_api'), 'measured')
  assert.equal(statusForSource('configured'), 'configured')
  assert.equal(statusForSource('bundled_default'), 'assumed')
  for (const source of CAPABILITY_SOURCES) {
    if (source !== 'provider_api') {
      assert.notEqual(statusForSource(source), 'measured', `${source} was promoted to measured`)
    }
  }
})

test('the trust order names every status exactly once', () => {
  assert.deepEqual([...CAPABILITY_TRUST_ORDER].sort(), [...CAPABILITY_STATUSES].sort())
})

test('the telemetry vocabulary matches the provider vocabulary exactly', () => {
  // record.mjs declares its own copy because a column's vocabulary is a property of the schema,
  // not of whichever layer populates it. This is what keeps the two copies honest — the same
  // arrangement DECIDE_REASONS has with ROUTING_REASONS.
  assert.deepEqual([...WORKER_CONTEXT_SOURCES], [...CAPABILITY_SOURCES])
  assert.deepEqual([...WORKER_CONTEXT_STATUSES], [...CAPABILITY_STATUSES])
})

/* ------------------------------------------------------------ the invariant */

test('contextTokens === null coincides exactly with status "unknown"', () => {
  const samples = [
    measured(),
    bundledCapabilityFor('ollama', 'llama3:latest'),
    unknownCapability({ provider: 'ollama' }),
    resolveCapability({}),
    resolveCapability({ provider: 'ollama', model: 'm', configured: 4096 }),
    modelCapability({ source: 'provider_api', contextTokens: null }),
    modelCapability({ source: 'configured', contextTokens: 0 }),
    modelCapability({ source: 'bundled_default', contextTokens: -1 }),
  ]
  for (const rec of samples) {
    assert.deepEqual(validateCapabilityRecord(rec), [], `malformed: ${JSON.stringify(rec)}`)
    assert.equal(rec.contextTokens === null, rec.status === 'unknown', JSON.stringify(rec))
  }
})

test('a source with no usable number is no claim at all, not a weaker one', () => {
  for (const n of [null, 0, -5, 1.5, '8192']) {
    const rec = modelCapability({ provider: 'ollama', model: 'm', contextTokens: n, source: 'provider_api' })
    assert.equal(rec.source, 'unknown', `${JSON.stringify(n)} kept a source that describes nothing`)
    assert.equal(rec.status, 'unknown')
    assert.equal(rec.contextTokens, null)
  }
})

test('measuredAt is only meaningful for a measurement', () => {
  assert.equal(measured().measuredAt, 1)
  const cfg = modelCapability({ provider: 'ollama', model: 'm', contextTokens: 4096, source: 'configured', measuredAt: 99 })
  assert.equal(cfg.measuredAt, null, 'a configured value cannot carry a measurement timestamp')
})

test('validateCapabilityRecord catches a forged record', () => {
  const forged = { contextTokens: 8192, source: 'configured', status: 'measured', maxOutputTokens: null, measuredAt: null, detail: null }
  assert.ok(validateCapabilityRecord(forged).some((p) => /does not match source/.test(p)))

  const numberless = { contextTokens: null, source: 'provider_api', status: 'measured', maxOutputTokens: null, measuredAt: null, detail: null }
  assert.ok(validateCapabilityRecord(numberless).some((p) => /must coincide exactly/.test(p)))

  assert.ok(validateCapabilityRecord(null).length > 0)
  assert.ok(validateCapabilityRecord([]).length > 0)
})

/* ------------------------------------------------------------- resolution */

test('the strongest available source wins when nothing is configured', () => {
  const bundled = bundledCapabilityFor('ollama', 'llama3:latest')
  assert.equal(resolveCapability({ provider: 'ollama', model: 'm', discovered: measured(), bundled }).status, 'measured')
  assert.equal(resolveCapability({ provider: 'ollama', model: 'm', bundled }).status, 'assumed')
  assert.equal(resolveCapability({ provider: 'ollama', model: 'm' }).status, 'unknown')
})

test('a configured window binds, and the WEAKER status is reported', () => {
  // An operator's assertion clamped by a measurement is still an assertion, so it must not be
  // relabelled `measured` just because a measurement participated.
  const r = resolveCapability({ provider: 'ollama', model: 'm', configured: 4096, discovered: measured(8192) })
  assert.equal(r.contextTokens, 4096)
  assert.equal(r.source, 'configured')
  assert.equal(r.status, 'configured')
})

test('a configured window above the measured one is clamped down, and says so', () => {
  // Both limits are real, so the binding one is the smaller — the same reasoning dispatch applies
  // to the two byte ceilings. Silently honouring 99999 would authorise a prompt the model cannot
  // hold, which is the failure this whole module exists to prevent.
  const r = resolveCapability({ provider: 'ollama', model: 'm', configured: 99_999, discovered: measured(8192) })
  assert.equal(r.contextTokens, 8192)
  assert.equal(r.status, 'configured')
  assert.match(r.detail, /exceeds the 8192/)
})

test('a configured window beats the bundled table without consulting it', () => {
  const r = resolveCapability({ provider: 'ollama', model: 'llama3:latest', configured: 2048, bundled: bundledCapabilityFor('ollama', 'llama3:latest') })
  assert.equal(r.contextTokens, 2048)
  assert.equal(r.status, 'configured')
})

test('nothing known yields unknown, and carries why', () => {
  const r = resolveCapability({ provider: 'ollama', model: 'nope' })
  assert.equal(r.contextTokens, null)
  assert.equal(r.status, 'unknown')
  assert.ok(typeof r.detail === 'string' && r.detail !== '')
})

/* ------------------------------------------------------------ the table */

test('a model name normalizes to its tag-stripped key', () => {
  assert.equal(normalizeModelName('llama3:latest'), 'llama3')
  assert.equal(normalizeModelName('Mistral:7B'), 'mistral')
  assert.equal(normalizeModelName('  llama3  '), 'llama3')
  for (const bad of ['', '   ', null, undefined, 42, {}]) assert.equal(normalizeModelName(bad), null)
})

test('there is NO fuzzy matching — a finetune does not inherit its base model window', () => {
  // A prefix match would turn `llama3-finetune-of-mine` into `llama3` and invent a window for a
  // model nobody has measured. That is the fabrication this module exists to prevent.
  assert.equal(normalizeModelName('llama3-finetune-of-mine'), 'llama3-finetune-of-mine')
  assert.equal(bundledCapabilityFor('ollama', 'llama3-finetune-of-mine'), null)
  assert.equal(bundledCapabilityFor('ollama', 'llama3-8b-instruct'), null)
})

test('the table is only ever an assumption', () => {
  const r = bundledCapabilityFor('ollama', 'llama3:latest')
  assert.equal(r.contextTokens, 8192)
  assert.equal(r.source, 'bundled_default')
  assert.equal(r.status, 'assumed')
  assert.match(r.detail, /not verified/)
})

test('a silent table yields null rather than a guess', () => {
  assert.equal(bundledCapabilityFor('ollama', 'never-pulled'), null)
  assert.equal(bundledCapabilityFor('gemini', 'gemini-3.8-flash'), null, 'gemini has no table, so it must stay unknown')
  assert.equal(bundledCapabilityFor('nonsense', 'llama3'), null)
  assert.equal(bundledCapabilityFor(null, null), null)
})

test('every table entry is a positive integer, and the two measured ones are what was measured', () => {
  for (const [provider, table] of Object.entries(BUNDLED_MODEL_CONTEXT)) {
    for (const [model, n] of Object.entries(table)) {
      assert.ok(Number.isInteger(n) && n > 0, `${provider}/${model} is not a positive integer`)
      assert.equal(normalizeModelName(model), model, `${model} is not already a normalized key`)
    }
  }
  // Read off this machine's daemon via /api/show. If either changes, the table is wrong.
  assert.equal(BUNDLED_MODEL_CONTEXT.ollama.llama3, 8192)
  assert.equal(BUNDLED_MODEL_CONTEXT.ollama.mistral, 32768)
})

/* ---------------------------------------------------- provider/model coherence */

test('coherence is decided negatively: only another provider’s claim is evidence', () => {
  // A positive "is this a valid ollama model" test is impossible — a local tag is any string the
  // developer pulled — so an allowlist would reject every model nobody enumerated.
  assert.equal(checkProviderModel('ollama', 'llama3:latest').status, 'ok')
  assert.equal(checkProviderModel('ollama', 'my-weird-finetune:v2').status, 'ok')
  assert.equal(checkProviderModel('gemini', 'gemini-3.8-flash').status, 'ok')
})

test('THE PHASE-4 BUG: a gemini model under the ollama provider is a mismatch', () => {
  const r = checkProviderModel('ollama', 'gemini-3.8-flash')
  assert.equal(r.status, 'mismatch')
  assert.deepEqual([...r.claimedBy], ['gemini'])
  assert.match(r.reason, /named like a gemini model/)
})

test('a missing model is unresolved, which is a third state and not a mismatch', () => {
  for (const model of [null, undefined, '', '   ']) {
    assert.equal(checkProviderModel('ollama', model).status, 'unresolved')
  }
  assert.equal(checkProviderModel(null, 'llama3').status, 'unresolved')
})

test('ollama claims no naming shape, and that emptiness is deliberate', () => {
  // Listed with an empty pattern set rather than omitted, so a reader can tell "claims nothing"
  // from "nobody has filled this in".
  assert.ok(Object.hasOwn(PROVIDER_MODEL_PATTERNS, 'ollama'))
  assert.equal(PROVIDER_MODEL_PATTERNS.ollama.length, 0)
  assert.deepEqual(providersClaimingModel('llama3:latest'), [])
  assert.deepEqual(providersClaimingModel('gemini-3.8-flash'), ['gemini'])
  assert.deepEqual(providersClaimingModel('models/gemini-1.5-pro'), ['gemini'])
})

test('a lane that states its own mismatched model is reported', () => {
  const c = workerCoherence({
    worker: { provider: 'ollama', model: 'llama3:latest' },
    workers: { bulkRead: { model: null }, codeWrite: { model: 'gemini-3.8-flash' } },
  })
  assert.equal(c.ok, false)
  assert.deepEqual(c.problems.map((p) => p.scope), ['codeWrite'])
})

test('a lane that inherits is not reported twice', () => {
  // The inherited pair is already reported as `worker`; re-reporting it per lane would turn one
  // mistake into three.
  const c = workerCoherence({
    worker: { provider: 'ollama', model: 'gemini-3.8-flash' },
    workers: { bulkRead: { model: null }, codeWrite: { model: null } },
  })
  assert.equal(c.ok, false)
  assert.deepEqual(c.problems.map((p) => p.scope), ['worker'])
})

test('a lane provider switch is evaluated against the lane’s own provider', () => {
  const c = workerCoherence({
    worker: { provider: 'gemini', model: 'gemini-3.8-flash' },
    workers: { bulkRead: { provider: 'ollama', model: 'llama3:latest' }, codeWrite: { model: null } },
  })
  assert.equal(c.ok, true, 'a lane on ollama with a local tag is coherent')
})

test('the shipped defaults are coherent', () => {
  const c = workerCoherence({ worker: { provider: 'gemini', model: 'gemini-3.8-flash' }, workers: {} })
  assert.equal(c.ok, true)
  assert.deepEqual([...c.problems], [])
})

test('coherence never substitutes or suggests a model', () => {
  // Reporting is the whole contract. A config layer that silently picked a different model would
  // be the worst possible outcome of a provider switch.
  const r = checkProviderModel('ollama', 'gemini-3.8-flash')
  assert.deepEqual(Object.keys(r).sort(), ['claimedBy', 'model', 'provider', 'reason', 'status'])
  assert.equal(r.model, 'gemini-3.8-flash', 'the reported model is the configured one, unchanged')
})
