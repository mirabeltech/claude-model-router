/**
 * A scriptable HTTP server that impersonates each worker provider's wire format.
 *
 * Providers are tested through real fetch rather than through injected fakes, so
 * timeouts, aborts, non-JSON bodies and status classification are exercised for
 * real. A hand-rolled fake would pass tests that the actual transport fails.
 *
 * The scenario comes from the `?scenario=` query or the request body, so one
 * server covers every failure mode for every provider.
 */

import http from 'node:http'

export const SCENARIOS = Object.freeze([
  'ok',
  'ok_no_usage',
  'ok_partial_usage',
  'ok_cached',
  'ok_thinking',
  'ok_truncated',
  // A SUCCESSFUL call that quietly read only a fraction of the prompt — the Ollama failure this
  // phase exists to catch. `ok_truncated` is the other thing: the provider saying it ran out of
  // OUTPUT budget, which is loud and already handled. This one reports nothing wrong at all.
  'ok_prompt_truncated',
  'empty_text',
  'safety_blocked',
  'prompt_blocked',
  'model_not_found_200',
  'auth_401',
  'forbidden_403',
  'not_found_404',
  'too_large_413',
  'rate_limit_429',
  'server_500',
  'bad_gateway_502',
  'not_json',
  'hang',
  'flaky_then_ok',
])

/**
 * @param {{flakyFailures?: number}} [opts]
 * @returns {Promise<{url: string, close: () => Promise<void>, requests: object[], resetFlaky: () => void}>}
 */
export async function startProviderServer(opts = {}) {
  const requests = []
  let flakyRemaining = opts.flakyFailures ?? 1

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { /* a malformed request body is itself a case */ }

      const url = new URL(req.url, 'http://localhost')
      // Scenario rides as a PATH PREFIX (/s/<scenario>/...), not a query string:
      // providers append their own path to the configured baseUrl, which would
      // leave a query string stranded in the middle of the URL.
      const m = url.pathname.match(/^\/s\/([a-z0-9_]+)(\/.*)?$/)
      const scenario = m?.[1] || url.searchParams.get('scenario') || body.scenario || 'ok'
      const rest = m?.[2] ?? url.pathname
      const shape = url.searchParams.get('shape') || detectShape(rest)

      requests.push({ path: url.pathname, headers: req.headers, body, scenario, shape })

      if (scenario === 'hang') return // never responds; the client's timeout must fire

      if (scenario === 'flaky_then_ok') {
        if (flakyRemaining > 0) {
          flakyRemaining--
          return send(res, 503, { error: 'temporarily unavailable' })
        }
        return send(res, 200, payloadFor(shape, 'ok'))
      }

      const status = STATUS_FOR[scenario]
      if (status) return send(res, status, { error: { code: status, message: `scenario ${scenario}` } })

      if (scenario === 'not_json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('<html>gateway error</html>')
      }

      return send(res, 200, payloadFor(shape, scenario))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    resetFlaky: () => { flakyRemaining = opts.flakyFailures ?? 1 },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const STATUS_FOR = Object.freeze({
  auth_401: 401,
  forbidden_403: 403,
  not_found_404: 404,
  too_large_413: 413,
  rate_limit_429: 429,
  server_500: 500,
  bad_gateway_502: 502,
})

function detectShape(pathname) {
  if (pathname.includes(':generateContent')) return 'gemini'
  if (pathname.startsWith('/api/')) return 'ollama'
  return 'mock'
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/* ------------------------------------------------------- per-shape payloads */

const TEXT = 'exports: UserService (class), createUser (fn)'

function payloadFor(shape, scenario) {
  if (shape === 'gemini') return geminiPayload(scenario)
  if (shape === 'ollama') return ollamaPayload(scenario)
  return mockPayload(scenario)
}

function geminiPayload(scenario) {
  const base = {
    candidates: [{ content: { parts: [{ text: TEXT }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-3.8-flash-001',
    // promptTokenCount is INCLUSIVE of cachedContentTokenCount — the trap this
    // fixture exists to pin down.
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 120, totalTokenCount: 1120 },
  }
  switch (scenario) {
    case 'ok_no_usage':
      return { ...base, usageMetadata: undefined }
    case 'ok_partial_usage':
      return { ...base, usageMetadata: { promptTokenCount: 1000 } }
    case 'ok_cached':
      return {
        ...base,
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 400,
          candidatesTokenCount: 120,
          totalTokenCount: 1120,
        },
      }
    case 'ok_thinking':
      return {
        ...base,
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 120,
          thoughtsTokenCount: 300,
          totalTokenCount: 1420,
        },
      }
    case 'ok_truncated':
      return { ...base, candidates: [{ content: { parts: [{ text: TEXT }] }, finishReason: 'MAX_TOKENS' }] }
    case 'empty_text':
      return { ...base, candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }
    case 'safety_blocked':
      return { ...base, candidates: [{ finishReason: 'SAFETY' }] }
    case 'prompt_blocked':
      return { promptFeedback: { blockReason: 'SAFETY' } }
    default:
      return base
  }
}

function ollamaPayload(scenario) {
  const base = {
    model: 'qwen2.5-coder:7b',
    message: { role: 'assistant', content: TEXT },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 1000,
    eval_count: 120,
  }
  switch (scenario) {
    case 'ok_no_usage':
      return { model: base.model, message: base.message, done: true, done_reason: 'stop' }
    case 'ok_partial_usage':
      return { ...base, eval_count: undefined }
    case 'ok_truncated':
      return { ...base, done_reason: 'length' }
    case 'ok_prompt_truncated':
      // done_reason 'stop': the daemon reports a perfectly normal completion. The only evidence
      // that most of the prompt was discarded is prompt_eval_count being far below what we sent,
      // which is exactly the shape measured live (2060 read of an estimated 4342).
      return { ...base, prompt_eval_count: 120, eval_count: 20 }
    case 'empty_text':
      return { ...base, message: { role: 'assistant', content: '' } }
    case 'model_not_found_200':
      return { error: 'model "nope" not found, try pulling it first' }
    case 'safety_blocked':
    case 'prompt_blocked':
      return { error: 'refused' }
    default:
      return base
  }
}

function mockPayload(scenario) {
  const base = {
    text: TEXT,
    model: 'mock-1',
    usage: { inputTokens: 1000, outputTokens: 120, totalTokens: 1120 },
  }
  switch (scenario) {
    case 'ok_no_usage':
      return { text: TEXT, model: 'mock-1' }
    case 'ok_partial_usage':
      return { ...base, usage: { inputTokens: 1000 } }
    case 'ok_cached':
      return { ...base, usage: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 120, totalTokens: 1120 } }
    case 'ok_thinking':
      return { ...base, usage: { inputTokens: 1000, outputTokens: 120, thinkingTokens: 300, totalTokens: 1420 } }
    case 'ok_truncated':
      return { ...base, truncated: true, finishReason: 'length' }
    case 'ok_prompt_truncated':
      // 120 prompt tokens read, however many were actually sent. Nothing in the response says
      // anything is wrong, which is precisely why the shortfall has to be computed.
      return { ...base, usage: { inputTokens: 120, outputTokens: 20, totalTokens: 140 } }
    case 'empty_text':
      return { ...base, text: '' }
    default:
      return base
  }
}
