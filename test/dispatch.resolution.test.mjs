/**
 * Which worker runs a lane, and which settings it inherits.
 *
 * `resolveWorker()` is pure and synchronous, so none of this needs a server. The asymmetry it
 * encodes — provider and timeout always inherit, model and API-key variable only inherit when
 * the provider did — is the whole point of the file: inheriting a model across a provider change
 * produces a config that looks valid, passes validation, and fails at call time with a Gemini
 * model name in an Ollama error.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveConfig, resolveWorker } from '../plugins/model-router/lib/dispatch/index.mjs'
import { DEFAULTS, SPEC, resolveConfig } from '../plugins/model-router/lib/config.mjs'
import { dispatchConfig } from './helpers/dispatch-input.mjs'

/* --------------------------------------------------------------- the base case */

test('with every workers leaf null, a lane runs exactly the global worker', () => {
  for (const lane of ['bulkRead', 'codeWrite']) {
    const r = resolveWorker(dispatchConfig(), lane)
    assert.equal(r.provider, DEFAULTS.worker.provider)
    assert.equal(r.model, DEFAULTS.worker.model)
    assert.equal(r.apiKeyEnv, DEFAULTS.worker.apiKeyEnv)
    assert.equal(r.timeoutMs, DEFAULTS.worker.timeoutMs)
    assert.equal(r.inheritedProvider, true)
  }
})

test('no shipped default is copied into the workers block, so the two tables cannot drift', () => {
  for (const lane of ['bulkRead', 'codeWrite']) {
    assert.deepEqual(DEFAULTS.workers[lane], {
      provider: null,
      model: null,
      apiKeyEnv: null,
      timeoutMs: null,
    })
  }
})

/* ------------------------------------------------- the cross-provider asymmetry */

test('changing a lane provider does NOT carry the global model across — it falls to that provider', () => {
  // The regression this asymmetry exists for. worker.model is 'gemini-2.5-flash'; ollama.mjs
  // takes `model || providerConfig.model`, so an inherited Gemini model would mask the configured
  // 'qwen2.5-coder:7b' and the daemon would answer HTTP 200 with a "model not found" body.
  const r = resolveWorker(dispatchConfig({ workers: { codeWrite: { provider: 'ollama' } } }), 'codeWrite')
  assert.equal(r.provider, 'ollama')
  assert.equal(r.model, DEFAULTS.providers.ollama.model)
  assert.notEqual(r.model, DEFAULTS.worker.model)
  assert.equal(r.inheritedProvider, false)
})

test('changing a lane provider does NOT carry the global API-key variable across', () => {
  // readinessFor() does `apiKeyEnv ? [apiKeyEnv] : requiresEnv`, so forwarding GEMINI_API_KEY to
  // Ollama would demand a key from a provider whose requiresEnv is empty.
  const r = resolveWorker(dispatchConfig({ workers: { bulkRead: { provider: 'ollama' } } }), 'bulkRead')
  assert.equal(r.apiKeyEnv, null)
  assert.notEqual(DEFAULTS.worker.apiKeyEnv, null, 'the base value this must not inherit')
})

test('a lane that restates the global provider still inherits its model and key', () => {
  // The rule keys on the resolved VALUE, not on "did the leaf fall back". Writing the provider
  // out explicitly is a no-op, not a reset.
  const r = resolveWorker(dispatchConfig({ workers: { bulkRead: { provider: DEFAULTS.worker.provider } } }), 'bulkRead')
  assert.equal(r.inheritedProvider, true)
  assert.equal(r.model, DEFAULTS.worker.model)
  assert.equal(r.apiKeyEnv, DEFAULTS.worker.apiKeyEnv)
})

test('an explicit lane model or key always wins, inherited provider or not', () => {
  const a = resolveWorker(
    dispatchConfig({ workers: { bulkRead: { model: 'gemini-2.5-pro', apiKeyEnv: 'BULK_KEY' } } }),
    'bulkRead',
  )
  assert.equal(a.provider, DEFAULTS.worker.provider)
  assert.equal(a.model, 'gemini-2.5-pro')
  assert.equal(a.apiKeyEnv, 'BULK_KEY')

  const b = resolveWorker(
    dispatchConfig({ workers: { codeWrite: { provider: 'ollama', model: 'codellama:13b', apiKeyEnv: 'OLLAMA_KEY' } } }),
    'codeWrite',
  )
  assert.equal(b.model, 'codellama:13b')
  assert.equal(b.apiKeyEnv, 'OLLAMA_KEY')
})

test('a provider with no configured model and no inheritance resolves to null, not to a guess', () => {
  // 'mock' has no providers.mock block in DEFAULTS. A fabricated model id would fail at the
  // provider with a confusing message instead of here with an honest one.
  const r = resolveWorker(dispatchConfig({ workers: { bulkRead: { provider: 'mock' } } }), 'bulkRead')
  assert.equal(r.provider, 'mock')
  assert.equal(r.model, null)
})

/* ------------------------------------------------------- provider-independent */

test('timeoutMs always inherits, because a millisecond budget carries no provider identity', () => {
  const r = resolveWorker(dispatchConfig({ workers: { bulkRead: { provider: 'ollama' } } }), 'bulkRead')
  assert.equal(r.timeoutMs, DEFAULTS.worker.timeoutMs)
})

test('a per-lane timeout overrides the global one for that lane only', () => {
  const config = dispatchConfig({ workers: { bulkRead: { timeoutMs: 5000 } } })
  assert.equal(resolveWorker(config, 'bulkRead').timeoutMs, 5000)
  assert.equal(resolveWorker(config, 'codeWrite').timeoutMs, DEFAULTS.worker.timeoutMs)
})

test('the two lanes resolve independently — overriding one never moves the other', () => {
  const config = dispatchConfig({ workers: { bulkRead: { provider: 'ollama' } } })
  assert.equal(resolveWorker(config, 'bulkRead').provider, 'ollama')
  assert.equal(resolveWorker(config, 'codeWrite').provider, DEFAULTS.worker.provider)
  assert.equal(resolveWorker(config, 'codeWrite').model, DEFAULTS.worker.model)
})

/* ------------------------------------------------------------- hostile config */

test('an empty-string env override is rejected by the spec and falls back to inheriting', () => {
  // nonEmpty is load-bearing: without it CMR_..._PROVIDER="" would resolve to '', and `??` does
  // not catch '', so the lane would resolve a provider id of '' instead of inheriting.
  const { config, warnings } = resolveConfig({
    layers: [],
    env: { CMR_BULK_READ_WORKER_PROVIDER: '' },
  })
  assert.equal(config.workers.bulkRead.provider, null)
  assert.ok(warnings.some((w) => w.field === 'workers.bulkRead.provider'))
  assert.equal(resolveWorker(config, 'bulkRead').provider, DEFAULTS.worker.provider)
})

test('an env override of a lane provider is applied, so CI can retarget one mode', () => {
  const { config } = resolveConfig({ layers: [], env: { CMR_CODE_WRITE_WORKER_PROVIDER: 'ollama' } })
  assert.equal(resolveWorker(config, 'codeWrite').provider, 'ollama')
  assert.equal(resolveWorker(config, 'bulkRead').provider, DEFAULTS.worker.provider)
})

test('a missing workers block or an unknown lane resolves to the global worker rather than throwing', () => {
  // The dispatcher must be callable with a config assembled by hand, including an older one.
  const legacy = { worker: { ...DEFAULTS.worker }, providers: { ...DEFAULTS.providers } }
  assert.equal(resolveWorker(legacy, 'bulkRead').provider, DEFAULTS.worker.provider)
  assert.equal(resolveWorker(dispatchConfig(), 'noSuchLane').provider, DEFAULTS.worker.provider)
})

test('the per-lane timeout bounds match the global one, so a lane cannot outlive the worker', () => {
  for (const lane of ['bulkRead', 'codeWrite']) {
    const leaf = SPEC[`workers.${lane}.timeoutMs`]
    assert.equal(leaf.min, SPEC['worker.timeoutMs'].min)
    assert.equal(leaf.max, SPEC['worker.timeoutMs'].max)
    assert.equal(leaf.nullable, true)
  }
})

/* --------------------------------------------------------------- deriveConfig */

test('deriveConfig rewrites only the four resolved worker fields and nothing else', () => {
  // callWorker reads seven worker paths plus providers.<id>. The three it reads that are NOT
  // per-mode must survive untouched, or a lane override would silently change sampling.
  const config = dispatchConfig({ workers: { bulkRead: { provider: 'ollama', timeoutMs: 9000 } } })
  const derived = deriveConfig(config, resolveWorker(config, 'bulkRead'))

  assert.equal(derived.worker.provider, 'ollama')
  assert.equal(derived.worker.model, DEFAULTS.providers.ollama.model)
  assert.equal(derived.worker.apiKeyEnv, null)
  assert.equal(derived.worker.timeoutMs, 9000)

  assert.equal(derived.worker.temperature, config.worker.temperature)
  assert.equal(derived.worker.maxOutputTokens, config.worker.maxOutputTokens)
  assert.equal(derived.worker.maxRetries, config.worker.maxRetries)
  assert.equal(derived.worker.maxInputBytes, config.worker.maxInputBytes)
  assert.equal(derived.providers, config.providers, 'providers must survive by reference')
})

test('deriveConfig does not mutate the config it was given', () => {
  // The telemetry sink caches on config identity; a dispatcher that edited the caller's object
  // would change what a later event reports about a call it did not make.
  const config = dispatchConfig({ workers: { bulkRead: { provider: 'ollama' } } })
  const before = JSON.stringify(config)
  deriveConfig(config, resolveWorker(config, 'bulkRead'))
  assert.equal(JSON.stringify(config), before)
})
