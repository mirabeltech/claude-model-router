/**
 * Provider conformance.
 *
 * Every provider runs against the SAME contract and the SAME assertions, through
 * real fetch against a local server. No API key, no network egress. A new
 * provider is wired in by adding one entry to PROVIDERS below — if it cannot pass
 * these, it is not finished.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { startProviderServer } from './helpers/provider-server.mjs'
import {
  ProviderError,
  RETRYABLE,
  codeForStatus,
  normalizeUsage,
  validateProviderModule,
  withRetry,
  assertPayloadSize,
} from '../plugins/model-router/lib/providers/contract.mjs'
import { redactSecrets } from '../plugins/model-router/lib/redact.mjs'
import {
  loadProvider,
  providerIds,
  isKnownProvider,
  readinessFor,
  billingFor,
  requiresEnvFor,
  callWorker,
} from '../plugins/model-router/lib/providers/index.mjs'
import { DEFAULTS } from '../plugins/model-router/lib/config.mjs'

/** How to drive each provider against the shared fixture server. */
const PROVIDERS = [
  {
    id: 'gemini',
    model: 'gemini-2.5-flash',
    env: { GEMINI_API_KEY: 'AIzaTESTKEYTESTKEYTESTKEY' },
    providerConfig: (base) => ({ baseUrl: base }),
    // Gemini's own path identifies the shape; the scenario rides a path prefix.
    scenarioVia: 'path',
  },
  {
    id: 'ollama',
    model: 'qwen2.5-coder:7b',
    env: {},
    providerConfig: (base) => ({ baseUrl: base }),
    scenarioVia: 'path',
  },
  {
    id: 'mock',
    model: 'mock-1',
    env: { MOCK_WORKER_URL: 'set-at-runtime' },
    providerConfig: (base) => ({ baseUrl: base }),
    scenarioVia: 'body',
  },
]

let server
test.before(async () => { server = await startProviderServer({ flakyFailures: 1 }) })
test.after(async () => { await server?.close() })

/** Build the per-provider request, routing the scenario the way that provider allows. */
function reqFor(p, scenario, extra = {}) {
  // Path prefix, not a query string: providers append their own path to baseUrl.
  const base = p.scenarioVia === 'path' ? `${server.url}/s/${scenario}` : server.url
  return {
    model: p.model,
    prompt: 'read these files and answer',
    system: 'be terse',
    timeoutMs: 4000,
    providerConfig: p.providerConfig(base),
    env: p.id === 'mock' ? { MOCK_WORKER_URL: server.url } : p.env,
    ...(p.scenarioVia === 'body' ? { scenario } : {}),
    ...extra,
  }
}

/* ------------------------------------------------------- registry contract */

test('registry exposes a stable, known provider set', () => {
  assert.deepEqual(providerIds(), ['gemini', 'mock', 'ollama'])
  assert.equal(isKnownProvider('gemini'), true)
  assert.equal(isKnownProvider('nope'), false)
})

test('loading an unknown provider is a config error that names the alternatives', async () => {
  await assert.rejects(() => loadProvider('bedrock'), (err) => {
    assert.ok(err instanceof ProviderError)
    assert.equal(err.code, 'config')
    assert.equal(err.retryable, false)
    assert.match(err.message, /gemini, mock, ollama/)
    return true
  })
})

test('the default configured provider is actually registered', () => {
  // Guards against shipping a default that cannot load.
  assert.equal(isKnownProvider(DEFAULTS.worker.provider), true)
})

test('readinessFor is synchronous and makes no network call', () => {
  assert.deepEqual(readinessFor('gemini', { GEMINI_API_KEY: 'x' }), { ready: true })
  assert.equal(readinessFor('gemini', {}).ready, false)
  assert.match(readinessFor('gemini', {}).reason, /GEMINI_API_KEY/)
  // ollama needs no key, so it is ready without any env at all
  assert.deepEqual(readinessFor('ollama', {}), { ready: true })
  assert.equal(readinessFor('nope', {}).ready, false)
})

test('readinessFor honours a custom apiKeyEnv', () => {
  assert.equal(readinessFor('gemini', { MY_KEY: 'x' }, { apiKeyEnv: 'MY_KEY' }).ready, true)
  assert.equal(readinessFor('gemini', { GEMINI_API_KEY: 'x' }, { apiKeyEnv: 'MY_KEY' }).ready, false)
})

/* ------------------------------------------- per-provider contract: success */

for (const p of PROVIDERS) {
  test(`[${p.id}] satisfies the module contract`, async () => {
    const mod = await loadProvider(p.id)
    assert.deepEqual(validateProviderModule(mod), [])
    assert.equal(mod.id, p.id)
  })

  test(`[${p.id}] returns text, usage and latency on success`, async () => {
    const mod = await loadProvider(p.id)
    const r = await mod.complete(reqFor(p, 'ok'))
    assert.match(r.text, /UserService/)
    assert.equal(r.usage.inputTokens, 1000)
    assert.equal(r.usage.outputTokens, 120)
    assert.equal(r.usage.source, 'provider_reported')
    assert.equal(r.truncated, false)
    assert.ok(typeof r.providerLatencyMs === 'number' && r.providerLatencyMs >= 0)
    assert.ok(typeof r.model === 'string' && r.model.length > 0)
  })

  test(`[${p.id}] missing usage yields null, never zero`, async () => {
    // A zero would understate worker cost and so overstate savings. It must be
    // null so every downstream money field becomes NULL.
    const mod = await loadProvider(p.id)
    const r = await mod.complete(reqFor(p, 'ok_no_usage'))
    assert.equal(r.usage.inputTokens, null)
    assert.equal(r.usage.outputTokens, null)
    assert.equal(r.usage.source, 'missing')
  })

  test(`[${p.id}] partial usage is flagged as partial, not reported`, async () => {
    const mod = await loadProvider(p.id)
    const r = await mod.complete(reqFor(p, 'ok_partial_usage'))
    assert.equal(r.usage.source, 'provider_partial')
  })

  test(`[${p.id}] a capped output is marked truncated`, async () => {
    const mod = await loadProvider(p.id)
    const r = await mod.complete(reqFor(p, 'ok_truncated'))
    assert.equal(r.truncated, true)
  })

  test(`[${p.id}] empty text is an error, not an empty summary`, async () => {
    const mod = await loadProvider(p.id)
    await assert.rejects(() => mod.complete(reqFor(p, 'empty_text')), (err) => {
      assert.equal(err.code, 'empty_response')
      assert.equal(err.retryable, false)
      return true
    })
  })

  test(`[${p.id}] oversize payloads are refused before any network call`, async () => {
    const mod = await loadProvider(p.id)
    const huge = 'x'.repeat(mod.capabilities.maxInputBytes + 1)
    const before = server.requests.length
    await assert.rejects(() => mod.complete(reqFor(p, 'ok', { prompt: huge })), (err) => {
      assert.equal(err.code, 'payload_too_large')
      assert.equal(err.retryable, false)
      return true
    })
    assert.equal(server.requests.length, before, 'must not hit the network')
  })

  /* ------------------------------------------ per-provider contract: failure */

  for (const [scenario, code, retryable] of [
    ['auth_401', 'auth', false],
    ['forbidden_403', 'auth', false],
    ['not_found_404', 'model_not_found', false],
    ['too_large_413', 'payload_too_large', false],
    ['rate_limit_429', 'rate_limit', true],
    ['server_500', 'http_5xx', true],
    ['bad_gateway_502', 'http_5xx', true],
  ]) {
    test(`[${p.id}] HTTP ${scenario} classifies as ${code}`, async () => {
      const mod = await loadProvider(p.id)
      await assert.rejects(() => mod.complete(reqFor(p, scenario)), (err) => {
        assert.ok(err instanceof ProviderError, `expected ProviderError, got ${err?.name}`)
        assert.equal(err.code, code)
        assert.equal(err.retryable, retryable)
        assert.equal(err.provider, p.id)
        return true
      })
    })
  }

  test(`[${p.id}] a non-JSON body is a parse_error, not a crash`, async () => {
    const mod = await loadProvider(p.id)
    await assert.rejects(() => mod.complete(reqFor(p, 'not_json')), (err) => {
      assert.equal(err.code, 'parse_error')
      assert.equal(err.retryable, false)
      return true
    })
  })

  test(`[${p.id}] a hung response times out as timeout, and is retryable`, async () => {
    const mod = await loadProvider(p.id)
    await assert.rejects(() => mod.complete(reqFor(p, 'hang', { timeoutMs: 150 })), (err) => {
      assert.equal(err.code, 'timeout')
      assert.equal(err.retryable, true)
      assert.match(err.message, /150ms/)
      return true
    })
  })

  test(`[${p.id}] an external abort signal is honoured`, async () => {
    const mod = await loadProvider(p.id)
    const ctl = new AbortController()
    const pending = mod.complete(reqFor(p, 'hang', { timeoutMs: 5000, signal: ctl.signal }))
    ctl.abort()
    await assert.rejects(() => pending, (err) => {
      assert.ok(err instanceof ProviderError)
      assert.equal(err.retryable, false)
      return true
    })
  })
}

/* ------------------------------------------------- gemini-specific usage traps */

test('[gemini] promptTokenCount is inclusive of cached, so uncached input is the difference', async () => {
  const mod = await loadProvider('gemini')
  const p = PROVIDERS[0]
  const r = await mod.complete(reqFor(p, 'ok_cached'))
  // prompt 1000 total, 400 of it cached => 600 billable at full input rate
  assert.equal(r.usage.inputTokens, 600)
  assert.equal(r.usage.cachedInputTokens, 400)
})

test('[gemini] thinking tokens are captured separately from candidate tokens', async () => {
  // Billed as output but excluded from candidatesTokenCount. Dropping them would
  // make reasoning free and overstate savings.
  const mod = await loadProvider('gemini')
  const r = await mod.complete(reqFor(PROVIDERS[0], 'ok_thinking'))
  assert.equal(r.usage.outputTokens, 120)
  assert.equal(r.usage.thinkingTokens, 300)
})

test('[gemini] a blocked prompt and a blocked response are both provider_safety', async () => {
  const mod = await loadProvider('gemini')
  for (const scenario of ['prompt_blocked', 'safety_blocked']) {
    await assert.rejects(() => mod.complete(reqFor(PROVIDERS[0], scenario)), (err) => {
      assert.equal(err.code, 'provider_safety')
      assert.equal(err.retryable, false)
      return true
    })
  }
})

test('[gemini] an exhausted output budget says so instead of returning nothing', async () => {
  const mod = await loadProvider('gemini')
  await assert.rejects(() => mod.complete(reqFor(PROVIDERS[0], 'empty_text')), (err) => {
    assert.equal(err.code, 'empty_response')
    assert.match(err.message, /output budget was exhausted/)
    return true
  })
})

test('[gemini] the key travels in a header, never in the URL', async () => {
  const mod = await loadProvider('gemini')
  const before = server.requests.length
  await mod.complete(reqFor(PROVIDERS[0], 'ok'))
  const seen = server.requests.slice(before)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers['x-goog-api-key'], 'AIzaTESTKEYTESTKEYTESTKEY')
  assert.ok(!seen[0].path.includes('AIza'), 'API key must not appear in the path')
})

test('[gemini] a missing key is an auth error raised before any request', async () => {
  const mod = await loadProvider('gemini')
  const before = server.requests.length
  await assert.rejects(
    () => mod.complete({ ...reqFor(PROVIDERS[0], 'ok'), env: {} }),
    (err) => { assert.equal(err.code, 'auth'); assert.equal(err.retryable, false); return true },
  )
  assert.equal(server.requests.length, before)
})

/* ------------------------------------------------ ollama-specific behaviour */

test('[ollama] a 200 response carrying an error field is still an error', async () => {
  // Ollama reports an unknown model with HTTP 200 and an `error` key.
  const mod = await loadProvider('ollama')
  await assert.rejects(() => mod.complete(reqFor(PROVIDERS[1], 'model_not_found_200')), (err) => {
    assert.equal(err.code, 'model_not_found')
    assert.equal(err.retryable, false)
    return true
  })
})

test('[ollama] needs no API key to be ready', async () => {
  const mod = await loadProvider('ollama')
  assert.deepEqual(mod.readiness({}), { ready: true })
  assert.deepEqual(mod.capabilities.requiresEnv, [])
})

/* ------------------------------------------------------------ retry policy */

test('withRetry retries a retryable failure and reports the attempt count', async () => {
  let calls = 0
  const { result, attempts } = await withRetry(async () => {
    calls++
    if (calls < 3) throw new ProviderError('rate_limit', 'slow down')
    return 'done'
  }, { maxRetries: 3, baseDelayMs: 1, random: () => 0.5 })
  assert.equal(result, 'done')
  assert.equal(attempts, 3)
  assert.equal(calls, 3)
})

test('withRetry does not retry a non-retryable failure', async () => {
  let calls = 0
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new ProviderError('auth', 'bad key') }, { maxRetries: 5, baseDelayMs: 1 }),
    (err) => { assert.equal(err.code, 'auth'); return true },
  )
  assert.equal(calls, 1, 'an auth failure must not be retried')
})

test('withRetry gives up after maxRetries and records attempts on the error', async () => {
  let calls = 0
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new ProviderError('http_5xx', 'boom') }, { maxRetries: 2, baseDelayMs: 1, random: () => 0 }),
    (err) => { assert.equal(err.attempts, 3); return true },
  )
  assert.equal(calls, 3)
})

test('withRetry backs off with jitter rather than a fixed schedule', async () => {
  const delays = []
  await assert.rejects(() => withRetry(
    async () => { throw new ProviderError('timeout', 'slow') },
    { maxRetries: 2, baseDelayMs: 100, random: () => 1, sleep: async (ms) => { delays.push(ms) } },
  ))
  assert.deepEqual(delays, [100, 200])
})

test('callWorker drives the configured provider end to end and returns attempts', async () => {
  server.resetFlaky()
  const config = {
    ...DEFAULTS,
    worker: { ...DEFAULTS.worker, provider: 'mock', model: 'mock-1', maxRetries: 2, timeoutMs: 4000 },
    providers: { mock: { baseUrl: server.url } },
  }
  const { result, attempts, providerId } = await callWorker({
    config,
    prompt: 'go',
    env: { MOCK_WORKER_URL: server.url },
    scenario: 'flaky_then_ok',
    sleep: async () => {},
  })
  assert.equal(providerId, 'mock')
  assert.equal(attempts, 2, 'one 503 then success')
  assert.match(result.text, /UserService/)
})

test('callWorker surfaces an unknown configured provider as a config error', async () => {
  const config = { ...DEFAULTS, worker: { ...DEFAULTS.worker, provider: 'not-a-provider' } }
  await assert.rejects(() => callWorker({ config, prompt: 'x' }), (err) => {
    assert.equal(err.code, 'config')
    return true
  })
})

/* ------------------------------------------------------- shared primitives */

test('codeForStatus maps every status band we care about', () => {
  assert.equal(codeForStatus(401), 'auth')
  assert.equal(codeForStatus(403), 'auth')
  assert.equal(codeForStatus(404), 'model_not_found')
  assert.equal(codeForStatus(413), 'payload_too_large')
  assert.equal(codeForStatus(429), 'rate_limit')
  assert.equal(codeForStatus(418), 'http_4xx')
  assert.equal(codeForStatus(503), 'http_5xx')
})

test('retryable set covers exactly the transient codes', () => {
  assert.deepEqual([...RETRYABLE].sort(), ['http_5xx', 'rate_limit', 'timeout', 'transport'])
})

test('an unknown error code degrades to unknown rather than throwing', () => {
  const err = new ProviderError('banana', 'x')
  assert.equal(err.code, 'unknown')
})

test('normalizeUsage treats non-numbers as null', () => {
  const u = normalizeUsage({ inputTokens: '1000', outputTokens: -5, thinkingTokens: NaN, totalTokens: undefined })
  assert.equal(u.inputTokens, null)
  assert.equal(u.outputTokens, null)
  assert.equal(u.thinkingTokens, null)
  assert.equal(u.source, 'missing')
})

test('assertPayloadSize counts the system prompt too', () => {
  const caps = { maxInputBytes: 10 }
  assert.throws(() => assertPayloadSize('12345', '123456', caps, 'x'), /over the 10 byte limit/)
  assert.equal(assertPayloadSize('123', '456', caps, 'x'), 6)
})

test('assertPayloadSize measures UTF-8 bytes, not characters', () => {
  // A CJK-commented file is ~3 bytes per character; a length check would let a
  // payload three times the ceiling through to the provider.
  const caps = { maxInputBytes: 10 }
  assert.throws(() => assertPayloadSize('中文中文', '', caps, 'x'), /12 bytes/)
})

test('redactSecrets strips every key shape we are likely to see', () => {
  const cases = [
    ['key is AIzaSyB1234567890abcdefg here', /\[redacted\]/],
    ['sk-ant-api03-abcdefghijklmnop', /\[redacted\]/],
    ['ghp_abcdefghijklmnopqrstuvwxyz01', /\[redacted\]/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.abcdefghij', /\[redacted\]/],
    ['api_key: "supersecretvalue"', /\[redacted\]/],
    ['authorization=Bearer_abc123xyz', /\[redacted\]/],
  ]
  for (const [input, expected] of cases) {
    const out = redactSecrets(input)
    assert.match(out, expected, `not redacted: ${input}`)
    assert.ok(!/supersecretvalue|AIzaSyB1234567890abcdefg/.test(out), `leaked: ${out}`)
  }
})

test('redactSecrets removes private key blocks wholesale', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEoggIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
  const out = redactSecrets(`error reading ${pem} done`)
  assert.ok(!out.includes('MIIEoggIBAAKCAQEA'))
  assert.match(out, /\[redacted\]/)
})

test('a provider error detail is redacted before it can be stored or logged', async () => {
  // The server echoes the scenario into its error body; make sure the pipeline
  // that captures `detail` is the redacting one.
  const mod = await loadProvider('mock')
  await assert.rejects(
    () => mod.complete(reqFor(PROVIDERS[2], 'server_500')),
    (err) => {
      assert.equal(err.code, 'http_5xx')
      assert.ok(!/AIza|sk-ant/.test(err.detail ?? ''))
      return true
    },
  )
})

test('validateProviderModule rejects an incomplete module', () => {
  const problems = validateProviderModule({ id: '', capabilities: { maxInputBytes: 0 } })
  assert.ok(problems.length >= 3)
  assert.ok(problems.some((p) => /id must be/.test(p)))
  assert.ok(problems.some((p) => /complete must be/.test(p)))
  assert.ok(problems.some((p) => /maxInputBytes/.test(p)))
})

/**
 * The registry answers readiness from a static table so the gate never pays to parse a provider
 * it may not call. That makes the table a SECOND copy of each module's `requiresEnv`, and a
 * second copy is a thing that drifts — silently, into a hook that reports a healthy worker as
 * unavailable or an unconfigured one as ready.
 */
test('every provider declares how it bills, and does not infer it from needing a key', async () => {
  // Governance asks one question of a provider: can a monetary budget be consumed by it. A
  // provider that forgot to answer must fail the contract check rather than default to free,
  // which is the expensive way to be wrong.
  for (const id of providerIds()) {
    const mod = await loadProvider(id)
    assert.ok(
      ['local_free', 'metered'].includes(mod.capabilities.billing),
      `${id}: capabilities.billing is ${JSON.stringify(mod.capabilities.billing)}`,
    )
  }
})

test('billing is not a restatement of requiresEnv', async () => {
  // THE DISTINCTION THIS FIELD EXISTS FOR. "Needs no API key" and "costs no money" are
  // different claims: a self-hosted metered gateway needs no key and still bills. Deriving one
  // from the other would silently exempt it from every monetary budget. The mock provider is
  // the live counter-example — it requires an env var AND is metered, so the two axes are
  // demonstrably independent rather than coincidentally aligned.
  const mock = await loadProvider('mock')
  assert.equal(mock.capabilities.billing, 'metered')
  assert.ok(mock.capabilities.requiresEnv.length > 0)

  const ollama = await loadProvider('ollama')
  assert.equal(ollama.capabilities.billing, 'local_free')
  assert.deepEqual([...ollama.capabilities.requiresEnv], [])
})

test('the registry static requirements agree with every module capabilities', async () => {
  for (const id of providerIds()) {
    const mod = await loadProvider(id)
    assert.deepEqual(
      [...requiresEnvFor(id)],
      [...mod.capabilities.requiresEnv],
      `${id}: SYNC_REQUIREMENTS and capabilities.requiresEnv disagree`,
    )
    // The same duplication, and the same hazard: governance reads the static copy so it never
    // loads a provider, which only works while the two agree.
    assert.equal(
      billingFor(id),
      mod.capabilities.billing,
      `${id}: SYNC_REQUIREMENTS and capabilities.billing disagree`,
    )
  }
})

test('requiresEnvFor returns null for an unknown provider rather than an empty list', () => {
  // An empty list reads as "this provider needs no key", which is a claim. Null is the refusal.
  for (const id of ['nope', '', null, undefined]) assert.equal(requiresEnvFor(id), null, String(id))
})
