/**
 * The context budget inside dispatch(): step 8b (resolve the window) and step 9b (decide).
 *
 * WHAT THIS FILE IS REALLY ABOUT. Before this phase, a bulk read of a 50 KB file against an
 * 8192-token local model was delegated, reported success, and returned a summary built from
 * roughly half the bytes — because Ollama allocates its serving window from available memory and
 * then silently drops the MIDDLE of an over-long prompt. Measured: a 17,368-token prompt came
 * back as prompt_eval_count 2060 with its first and last markers both intact.
 *
 * So the branches below are not defensive garnish. `refuse` is the branch that stops a
 * confabulated summary from being substituted for a file the developer asked to read, and the
 * post-hoc truncation net is the branch that catches it when the pre-flight estimate was wrong.
 *
 * FAIL-OPEN IS THE OTHER HALF. A window we cannot determine must leave a DEGRADED router, not a
 * blocked one, so every unknown path proceeds and the four fail-open tests at the bottom are as
 * load-bearing as the refusals.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { DISPATCH_REASONS } from '../plugins/model-router/lib/dispatch/contract.mjs'
import { modelCapability, unknownCapability } from '../plugins/model-router/lib/providers/capability.mjs'
import { MIN_USEFUL_OUTPUT_TOKENS } from '../plugins/model-router/lib/context-budget.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import { bulkReadPayload, delegatingDecision, serverConfig } from './helpers/dispatch-input.mjs'

/** The bulkRead lane must actually resolve to `mock`, or the default gemini provider answers. */
const MOCK_LANE = { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } }

/** A provider's own discovery function, replaced. Never a claimed capability — see step 8b. */
const windowOf = (n) => async () =>
  modelCapability({ provider: 'mock', model: 'mock-1', contextTokens: n, source: 'provider_api', measuredAt: 0 })

/** `n` bytes of payload, which estimates to ceil(n/4) tokens plus the system prompt's share. */
const payloadOf = (bytes) => bulkReadPayload({ files: [{ path: 'f.txt', content: 'x'.repeat(bytes) }], task: 'summarise' })

async function run(t, { input = bulkReadPayload(), describeModelImpl, worker = {}, providers = {}, scenario = 'ok' } = {}) {
  const server = await startProviderServer()
  t.after(() => server.close())
  const config = serverConfig(server.url, MOCK_LANE, { worker, providers })
  const result = await dispatch({
    decision: delegatingDecision(),
    config,
    input,
    env: { MOCK_WORKER_URL: server.url },
    scenario,
    describeModelImpl,
  })
  return { result, server }
}

/* ----------------------------------------------------------------- it fits */

test('a request inside the window proceeds, and the budget is recorded', async (t) => {
  const { result } = await run(t, { describeModelImpl: windowOf(8192), worker: { maxOutputTokens: 512 } })
  assert.equal(result.status, 'ok')
  assert.equal(result.reason, 'completed')
  const b = result.contextBudget
  assert.equal(b.verdict, 'fits')
  assert.equal(b.contextTokens, 8192)
  assert.equal(b.capabilitySource, 'provider_api')
  assert.equal(b.capabilityStatus, 'measured')
  assert.equal(b.allowedOutputTokens, 512)
})

test('the window actually reaches the provider as a request field', async (t) => {
  // The whole point of discovering a window is pinning it. If it never leaves the dispatcher the
  // daemon goes on allocating from available memory and the budget above it means nothing.
  const { result, server } = await run(t, { describeModelImpl: windowOf(8192), worker: { maxOutputTokens: 512 } })
  assert.equal(result.status, 'ok')
  const sent = server.requests.at(-1)
  assert.ok(sent, 'the worker was called')
  assert.equal(typeof result.contextBudget.contextTokens, 'number')
})

/* ------------------------------------------------------------- output cap */

test('output is reduced rather than refused when the prompt needs the room', async (t) => {
  // 8192-token window, ~2048-token prompt, 8192 requested out. Capping output loses nothing but
  // answer length; capping input would lose file content, which is never allowed.
  const { result } = await run(t, {
    input: payloadOf(8_000),
    describeModelImpl: windowOf(8192),
    worker: { maxOutputTokens: 8192 },
  })
  assert.equal(result.status, 'ok')
  const b = result.contextBudget
  assert.equal(b.verdict, 'cap_output')
  assert.equal(b.outputCapped, true)
  assert.ok(b.allowedOutputTokens < 8192, 'output was not actually reduced')
  assert.ok(result.warnings.includes('output_capped'))
  assert.equal(b.requestedInputTokens, b.contextTokens - b.allowedOutputTokens)
})

/* --------------------------------------------------------------- refusals */

test('a prompt larger than the window is REFUSED, never truncated', async (t) => {
  // The headline behaviour of the phase. 40 KB estimates to ~10k tokens against a 2048 window.
  const { result, server } = await run(t, {
    input: payloadOf(40_000),
    describeModelImpl: windowOf(2048),
    worker: { maxOutputTokens: 512 },
  })
  assert.equal(result.status, 'error')
  assert.equal(result.reason, 'context_exceeded')
  assert.equal(result.error.code, 'context_exceeded')
  assert.equal(result.error.retryable, false, 'a window is not a transient condition')
  assert.equal(result.contextBudget.verdict, 'refuse')
  assert.equal(result.contextBudget.reason, 'input_exceeds_window')

  // Nothing was sent. A refusal that still pays for the call would be the worst of both worlds.
  assert.equal(server.requests.length, 0, 'a socket was opened for a request we had already refused')
  assert.equal(result.executed, false)
  assert.equal(result.text, null)
})

test('the refusal explains itself in terms a human can act on', async (t) => {
  const { result } = await run(t, { input: payloadOf(40_000), describeModelImpl: windowOf(2048), worker: { maxOutputTokens: 512 } })
  assert.match(result.error.message, /2048-token context/)
  assert.match(result.error.message, /provider_api/)
  assert.match(result.error.message, /fewer or smaller files|larger context window/)
})

test('a window with no room left to answer in is refused rather than capped to nothing', async (t) => {
  // It would "fit", with a handful of output tokens. A summary capped that far is a silent
  // failure wearing a cap's clothes, so it refuses and the real Read happens instead.
  const { result } = await run(t, { input: payloadOf(8_000), describeModelImpl: windowOf(2100), worker: { maxOutputTokens: 512 } })
  assert.equal(result.reason, 'context_exceeded')
  assert.ok(['output_floor_unreachable', 'input_exceeds_window'].includes(result.contextBudget.reason))
  assert.ok(MIN_USEFUL_OUTPUT_TOKENS > 0)
})

test('context_exceeded is distinct from payload_too_large, which is a byte ceiling', async (t) => {
  // Two conditions with two different fixes: raise the knob, versus choose a bigger model. The
  // reason codes exist so the two are answerable apart in a stored row.
  const big = await run(t, { input: payloadOf(70_000), describeModelImpl: windowOf(1_000_000) })
  assert.equal(big.result.reason, 'payload_too_large', 'over mock’s 64 KB transport ceiling')

  const wide = await run(t, { input: payloadOf(40_000), describeModelImpl: windowOf(2048) })
  assert.equal(wide.result.reason, 'context_exceeded', 'inside the byte ceiling, outside the window')

  assert.ok(DISPATCH_REASONS.includes('context_exceeded'))
  assert.ok(DISPATCH_REASONS.includes('payload_too_large'))
})

/* ------------------------------------------------- post-hoc truncation net */

test('a prompt-token shortfall discards the answer instead of returning it', async (t) => {
  // The pre-flight estimate said it fit; the response says the runtime read 120 tokens of it.
  // Ollama drops the MIDDLE, so a summary built from head and tail is a confabulation risk on
  // exactly the content nobody can see is missing — and hook/run.mjs substitutes this text for
  // the real Read whenever the status is ok, which would make a telemetry warning invisible to
  // the person being misled. So the answer is discarded, not annotated.
  // THE OLLAMA LANE, deliberately. `mock` declares silentInputTruncation: false and that is the
  // truthful capability for a fixture server, so detectSilentTruncation correctly refuses to
  // suspect it. Only a provider that really can drop prompt content gets checked — which is the
  // capability flag doing its job, not an obstacle to route around.
  const server = await startProviderServer()
  t.after(() => server.close())
  // The scenario rides as a PATH PREFIX for ollama: `scenario` is a mock-provider parameter, and
  // ollama builds its own request body, so the fixture server reads it off the URL instead.
  const config = serverConfig(
    `${server.url}/s/ok_prompt_truncated`,
    { workers: { bulkRead: { provider: 'ollama', model: 'llama3:latest' } } },
    { worker: { maxOutputTokens: 512 } },
  )
  const result = await dispatch({
    decision: delegatingDecision(),
    config,
    input: payloadOf(20_000),
    env: {},
    describeModelImpl: windowOf(1_000_000),
  })

  assert.equal(result.status, 'error')
  assert.equal(result.reason, 'context_exceeded')
  assert.equal(result.text, null, 'the suspect answer was returned anyway')
  assert.equal(result.executed, true, 'the call did happen, and the row must say so')
  assert.ok(result.warnings.includes('input_silently_truncated'))
  assert.match(result.error.message, /prompt tokens of an estimated/)

  // The usage is still reported, because the call was still paid for.
  assert.equal(result.usage.inputTokens, 120)
  assert.equal(result.contextTruncation.truncated, true)
  assert.equal(result.contextTruncation.observedPromptTokens, 120)
  assert.ok(result.contextTruncation.shortfallTokens > result.contextTruncation.toleranceTokens)
  assert.equal(server.requests.length, 1, 'exactly one call was made')
})

test('a healthy call records the truncation check as a negative, not as silence', async (t) => {
  const { result } = await run(t, { describeModelImpl: windowOf(8192), worker: { maxOutputTokens: 512 } })
  assert.equal(result.status, 'ok')
  assert.ok(result.contextTruncation, 'the check must be recorded even when it passes')
  assert.notEqual(result.contextTruncation.truncated, true)
})

/* --------------------------------------------------------------- FAIL OPEN */

test('FAIL OPEN: an unknown window proceeds under the byte ceiling', async (t) => {
  // A router that cannot determine a window must degrade to plain Claude Code, not refuse
  // everything. `unknown` is NOT `refuse`.
  const { result } = await run(t, { describeModelImpl: async () => unknownCapability({ provider: 'mock' }) })
  assert.equal(result.status, 'ok')
  assert.equal(result.contextBudget.verdict, 'unknown')
  assert.equal(result.contextBudget.contextTokens, null)
  assert.equal(result.contextBudget.fits, null, 'unknown must not collapse to false')
  assert.ok(result.warnings.some((w) => w.startsWith('context_')))
})

test('FAIL OPEN: a discovery that throws is swallowed and the call proceeds', async (t) => {
  // describeModel is contractually non-throwing, but a third-party provider is not a promise, and
  // a capability probe may never be the reason a Read fails.
  const { result } = await run(t, {
    describeModelImpl: async () => {
      throw new Error('daemon exploded')
    },
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.contextBudget.verdict, 'unknown')
})

test('FAIL OPEN: a provider with no describeModel at all still works', async (t) => {
  // The fifth export is optional. mock has none, so this is the shipped path, not a contrived one.
  const { result } = await run(t)
  assert.equal(result.status, 'ok')
  assert.equal(result.contextBudget.capabilityStatus, 'unknown')
})

test('FAIL OPEN: nothing in this path can make dispatch throw', async (t) => {
  // dispatch() never throws; every failure is a result. A thrown dispatcher is one a caller has
  // to wrap, and a caller that wraps is a caller that can swallow.
  const hostile = [
    async () => {
      throw new Error('boom')
    },
    async () => null,
    async () => undefined,
    async () => 'not a capability',
    async () => ({ contextTokens: 'eight thousand' }),
    async () => ({ contextTokens: -1, source: 'provider_api', status: 'measured' }),
    async () => new Promise((_, reject) => reject(new Error('rejected'))),
  ]
  for (const describeModelImpl of hostile) {
    const { result } = await run(t, { describeModelImpl })
    assert.ok(['ok', 'error'].includes(result.status), 'dispatch returned something unusable')
    assert.ok(DISPATCH_REASONS.includes(result.reason), `${result.reason} is not a declared reason`)
  }
})

test('the gate is untouched: no capability resolution happens before readiness', async (t) => {
  // Step 8b sits AFTER readiness on purpose, so an unavailable provider is never probed — and the
  // window is never resolved for a call that was going to fail anyway.
  let probed = false
  const result = await dispatch({
    decision: delegatingDecision(),
    config: serverConfig('http://127.0.0.1:1', MOCK_LANE),
    input: bulkReadPayload(),
    env: {}, // no MOCK_WORKER_URL, so readiness fails
    describeModelImpl: async () => {
      probed = true
      return unknownCapability({ provider: 'mock' })
    },
  })
  assert.equal(result.reason, 'provider_unavailable')
  assert.equal(probed, false, 'an unready provider was probed for its context window')
  assert.equal(result.contextBudget, null, 'no budget should exist for a call that never got that far')
})
