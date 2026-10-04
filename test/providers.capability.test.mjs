/**
 * The optional fifth provider export: `describeModel()`.
 *
 * A sibling of providers.conformance.test.mjs rather than part of it: that suite asserts the four
 * REQUIRED symbols behave identically across every provider, and this one is about a symbol only
 * some providers have and only one currently implements. Folding them together would mean half
 * the table skipping half the tests.
 *
 * `describeModel()` is the only networked discovery in the contract, and the only thing standing
 * between a confident capability number and a fabricated one. Two properties matter more than any
 * value it returns:
 *
 *   1. IT NEVER THROWS. It is called from inside a PreToolUse hook. A rejected promise there
 *      would turn a capability probe into the reason a Read failed.
 *   2. READINESS STAYS COLD. The gate calls readiness() on the hot path, so discovery must not
 *      have leaked into it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as ollama from '../plugins/model-router/lib/providers/ollama.mjs'
import * as gemini from '../plugins/model-router/lib/providers/gemini.mjs'
import * as mock from '../plugins/model-router/lib/providers/mock.mjs'
import { validateCapabilityRecord } from '../plugins/model-router/lib/providers/capability.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULES = [
  { id: 'gemini', mod: gemini, model: 'gemini-3.8-flash', env: { GEMINI_API_KEY: 'AIzaTESTKEYTESTKEYTESTKEY' } },
  { id: 'ollama', mod: ollama, model: 'qwen2.5-coder:7b', env: {} },
  { id: 'mock', mod: mock, model: 'mock-1', env: { MOCK_WORKER_URL: 'http://127.0.0.1:1' } },
]

/* ------------------------------------------------------- the structural claims */

test('readiness stays synchronous and cold on every provider', async (t) => {
  // The gate calls readiness() while the developer waits on a tool call. If discovery had leaked
  // into it, every single Read would pay for a probe.
  const server = await startProviderServer()
  t.after(() => server.close())

  for (const { id, mod, env } of MODULES) {
    const before = server.requests.length
    const r = mod.readiness({ ...env }, { apiKeyEnv: Object.keys(env)[0] })
    assert.equal(typeof r?.ready, 'boolean', `${id} readiness did not answer synchronously`)
    assert.equal(typeof r?.then, 'undefined', `${id} readiness returned a promise`)
    assert.equal(server.requests.length, before, `${id} readiness opened a socket`)
  }
})

test('describeModel is optional, and its absence is the honest answer for most providers', () => {
  // `typeof mod.describeModel === 'function'` IS the answer to "can a window be discovered here".
  // Requiring the export would have forced a fake implementation into gemini and mock.
  assert.equal(typeof ollama.describeModel, 'function')
  assert.equal(typeof gemini.describeModel, 'undefined')
  assert.equal(typeof mock.describeModel, 'undefined')
})

test('a record from describeModel satisfies the record contract', async (t) => {
  const server = await startProviderServer()
  t.after(() => server.close())

  ollama.clearCapabilityCache()
  const rec = await ollama.describeModel({ model: 'llama3:latest', providerConfig: { baseUrl: server.url } })
  assert.deepEqual(validateCapabilityRecord(rec), [], 'malformed capability record')
  assert.equal(rec.provider, 'ollama')
  assert.equal(rec.model, 'llama3:latest')
})

/* -------------------------------------------------------------- never throws */

test('describeModel never throws, whatever the daemon does', async (t) => {
  // Every failure mode the transport can produce, plus two that are simply absurd. All of them
  // must come back as an `unknown` record rather than as a rejection.
  const server = await startProviderServer()
  t.after(() => server.close())

  const hostile = [
    ['unreachable daemon', { baseUrl: 'http://127.0.0.1:9' }],
    ['not json', { baseUrl: `${server.url}/s/not_json` }],
    ['model not found', { baseUrl: `${server.url}/s/model_not_found_200` }],
    ['garbage baseUrl', { baseUrl: 'not-a-url' }],
    // NOT in this list: `{}`. An absent baseUrl is not hostile, it means "use the default
    // 127.0.0.1:11434" — so on a machine with a daemon running it legitimately succeeds, and
    // asserting either outcome would make this test depend on whether Ollama happens to be up.
  ]

  for (const [label, providerConfig] of hostile) {
    ollama.clearCapabilityCache()
    const rec = await ollama.describeModel({ model: 'llama3:latest', providerConfig, timeoutMs: 1500 })
    assert.deepEqual(validateCapabilityRecord(rec), [], `${label}: malformed record`)
    assert.equal(rec.status, 'unknown', `${label}: claimed a window it could not have`)
    assert.equal(rec.contextTokens, null, `${label}: invented a context window`)
    assert.ok(typeof rec.detail === 'string' && rec.detail !== '', `${label}: no reason given`)
  }
})

test('a missing model name is unknown rather than an error', async (t) => {
  const server = await startProviderServer()
  t.after(() => server.close())

  for (const model of [null, undefined, '', '   ']) {
    ollama.clearCapabilityCache()
    const rec = await ollama.describeModel({ model, providerConfig: { baseUrl: server.url } })
    assert.equal(rec.status, 'unknown')
  }
})

test('discovery can be switched off, and then asks nothing', async (t) => {
  const server = await startProviderServer()
  t.after(() => server.close())

  ollama.clearCapabilityCache()
  const before = server.requests.length
  const rec = await ollama.describeModel({
    model: 'llama3:latest',
    providerConfig: { baseUrl: server.url, discoverContext: false },
  })
  assert.equal(rec.status, 'unknown')
  assert.match(rec.detail, /disabled/)
  assert.equal(server.requests.length, before, 'a disabled discovery still called out')
})

test('a successful answer is memoised, so the cost is once per model per process', async (t) => {
  // What makes discovery-by-default defensible: one localhost round trip, measured at about seven
  // milliseconds, on a path about to spend seconds inside a local model.
  const server = await startProviderServer()
  t.after(() => server.close())

  ollama.clearCapabilityCache()
  const before = server.requests.length
  await ollama.describeModel({ model: 'llama3:latest', providerConfig: { baseUrl: server.url } })
  const afterFirst = server.requests.length
  await ollama.describeModel({ model: 'llama3:latest', providerConfig: { baseUrl: server.url } })
  assert.equal(server.requests.length, afterFirst, 'the second call went back to the daemon')
  assert.ok(afterFirst > before, 'the first call never happened')
})

/* ------------------------------------------------------------ the parse rules */

test('the context length is read family-agnostically, because family is not a reliable key', () => {
  // `details.family` is `llama` for BOTH llama3 and mistral on a real install, and nothing
  // guarantees a family string matches its own metadata prefix. Two candidate keys means neither
  // is taken: a guess between them would be worse than reporting unknown.
  const f = ollama.contextTokensFrom
  assert.equal(f({ details: { family: 'llama' }, model_info: { 'llama.context_length': 8192 } }), 8192)
  assert.equal(f({ details: { family: 'qwen2' }, model_info: { 'llama.context_length': 32768 } }), 32768)
  assert.equal(f({ model_info: { 'a.context_length': 1, 'b.context_length': 2 } }), null)
  assert.equal(f({ details: { context_length: 4096 } }), 4096, 'an /api/tags-shaped body still works')
  assert.equal(f({ details: { family: 'llama' }, model_info: { 'llama.block_count': 32 } }), null)
  assert.equal(f({ details: { family: 'llama' }, model_info: { 'llama.context_length': 0 } }), null)
  for (const junk of [null, undefined, {}, 42, 'nope', []]) assert.equal(f(junk), null)
})

/* ------------------------------------------------------------------- num_ctx */

test('num_ctx is sent when the window is known, and omitted when it is not', async (t) => {
  // THE FIX ITSELF. Unset, the daemon allocates from available memory and then silently drops the
  // MIDDLE of an over-long prompt; the omission is what made that invisible. Null-when-unknown
  // keeps an undiscoverable install behaving exactly as it did before this existed.
  const server = await startProviderServer()
  t.after(() => server.close())
  const providerConfig = { baseUrl: server.url }

  await ollama.complete({ model: 'llama3:latest', prompt: 'p', providerConfig, maxOutputTokens: 512, contextTokens: 4096 })
  const withCtx = server.requests.at(-1).body
  assert.equal(withCtx.options.num_ctx, 4096)
  assert.equal(withCtx.options.num_predict, 512)

  for (const bad of [null, undefined, 0, -1, 1.5, '4096']) {
    await ollama.complete({ model: 'llama3:latest', prompt: 'p', providerConfig, maxOutputTokens: 512, contextTokens: bad })
    const body = server.requests.at(-1).body
    assert.equal('num_ctx' in body.options, false, `num_ctx was sent for ${JSON.stringify(bad)}`)
    assert.equal(body.options.num_predict, 512, 'the output request must survive regardless')
  }
})

/* ------------------------------------------------- bytes are not a context window */

test('maxInputBytes is never read as a context source', () => {
  // It is a TRANSPORT ceiling. Ollama advertises 1 MB and cannot ingest a quarter of that on an
  // 8192-token model, so treating it as context was the original category error.
  const budgetSrc = fs.readFileSync(
    path.join(HERE, '..', 'plugins', 'model-router', 'lib', 'context-budget.mjs'),
    'utf8',
  )
  assert.equal(/maxInputBytes/.test(budgetSrc), false, 'the budget module reads a byte ceiling')

  const capabilitySrc = fs.readFileSync(
    path.join(HERE, '..', 'plugins', 'model-router', 'lib', 'providers', 'capability.mjs'),
    'utf8',
  )
  const stripped = capabilitySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/maxInputBytes/.test(stripped), false, 'the capability model reads a byte ceiling')
})

test('every provider declares the two new structural capability fields', () => {
  for (const { id, mod } of MODULES) {
    assert.ok(['shared', 'separate', 'unknown'].includes(mod.capabilities.contextWindowModel), `${id}`)
    assert.equal(typeof mod.capabilities.silentInputTruncation, 'boolean', `${id}`)
  }
  // Measured, not assumed: ollama drops prompt content, gemini answers 400, and `unknown` is the
  // honest value for a fixture server standing in for an arbitrary provider.
  assert.equal(ollama.capabilities.contextWindowModel, 'shared')
  assert.equal(ollama.capabilities.silentInputTruncation, true)
  assert.equal(gemini.capabilities.contextWindowModel, 'separate')
  assert.equal(gemini.capabilities.silentInputTruncation, false)
  assert.equal(mock.capabilities.contextWindowModel, 'unknown')
})
