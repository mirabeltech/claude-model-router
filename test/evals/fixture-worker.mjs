/**
 * The deterministic worker: an injected `fetchImpl` that returns each case's canned answer.
 *
 * WHY NOT `test/helpers/provider-server.mjs`. That server is the right tool for the dispatch and
 * provider suites — it exercises real sockets, real timeouts and real status classification across
 * twenty scenarios. But it returns ONE canned text for every scenario, so it cannot satisfy
 * per-case quality criteria, and two of its scenarios are deliberately non-deterministic
 * (`flaky_then_ok` is stateful, `hang` never responds). A benchmark needs the opposite properties.
 *
 * So this is a `fetchImpl`, not a server: no socket, no port, no listener to leak, and nothing that
 * can behave differently on a loaded CI machine than on a developer's box. The provider module,
 * the dispatcher, the retry wrapper and the payload-size guard are all still the real ones — only
 * the transport is replaced, which is the narrowest possible substitution.
 *
 * THE WIRE SHAPES ARE BORROWED FROM THE EXISTING FIXTURE VOCABULARY rather than reinvented, so one
 * set of provider-response shapes serves both suites. `mock` reads `{text, usage}`; `ollama` reads
 * `{response, prompt_eval_count, eval_count}`.
 *
 * THE USAGE NUMBERS ARE SYNTHETIC AND SAY SO. They are derived from the prompt and answer lengths
 * so they are reproducible and roughly proportional, but they are not a tokenizer's output and no
 * conclusion about a real model's token accounting may be drawn from them. The deterministic arm
 * proves the PLUMBING — that a usage block flows into `calc.mjs` and comes out with the right null
 * semantics and the right statuses. Real token counts need the live arm.
 */

/** The synthetic tokenizer. Four characters per token, matching the corpus-side estimate. */
const synthTokens = (text) => Math.max(1, Math.floor(text.length / 4))

/**
 * Build the usage block a case's answer implies.
 *
 * `cachedInputTokens` and `thinkingTokens` are reported as 0 rather than omitted, because `mock`
 * declares `supportsCachedInput: true` and `reportsThinkingTokens: true` — a provider that CAN
 * report them and did not is genuinely unknown, and `calc.mjs` would correctly null the cost.
 * Reporting zeros here keeps the deterministic arm's money path exercisable; the structural-zero
 * branches are reached by the `ollama` arm instead, whose capabilities are both false.
 */
function usageFor(prompt, system, answer) {
  const inputTokens = synthTokens(prompt) + synthTokens(system)
  const outputTokens = synthTokens(answer)
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    thinkingTokens: 0,
    totalTokens: inputTokens + outputTokens,
  }
}

const MOCK_MODEL = 'mock-1'

/**
 * A `fetchImpl` serving answers keyed by case id.
 *
 * The case id is not in the request body — the mode builder sends only the files and the task — so
 * the id travels in the URL path, the same trick `provider-server.mjs` uses to carry a scenario
 * past a provider that appends its own path. The dispatcher never inspects the base URL, so this
 * is invisible to the code under test.
 *
 * @param {Map<string,string>} answers   case id -> the answer text to return
 * @param {{failFor?: Set<string>}} [opts]  case ids that should return an HTTP 500 instead
 * @returns {{fetchImpl: Function, requests: Array<object>, baseUrlFor: Function}}
 */
export function makeFixtureWorker(answers, { failFor = new Set() } = {}) {
  const requests = []

  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    const caseId = decodeURIComponent(href.match(/\/case\/([^/?]+)/)?.[1] ?? '')
    let body = null
    try {
      body = init.body === undefined ? null : JSON.parse(init.body)
    } catch {
      body = null
    }
    requests.push({ url: href, caseId, body })

    if (failFor.has(caseId)) {
      // A real provider failure, through the real error path: `codeForStatus` maps 500 to
      // `http_5xx`, which `RETRYABLE` contains, so `withRetry` genuinely retries.
      return new Response(JSON.stringify({ error: 'fixture failure' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }

    const answer = answers.get(caseId)
    if (answer === undefined) {
      return new Response(JSON.stringify({ error: `no fixture answer for case "${caseId}"` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
    const system = typeof body?.system === 'string' ? body.system : ''
    const usage = usageFor(prompt, system, answer)

    // Ollama's wire shape, when the URL says so; otherwise mock's.
    const payload = href.includes('/api/')
      ? {
          model: body?.model ?? MOCK_MODEL,
          response: answer,
          done: true,
          done_reason: 'stop',
          prompt_eval_count: usage.inputTokens,
          eval_count: usage.outputTokens,
        }
      : {
          model: body?.model ?? MOCK_MODEL,
          text: answer,
          finish_reason: 'stop',
          truncated: false,
          usage,
        }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  /** The base URL for one case. `mock` appends `/complete`, which the matcher ignores. */
  const baseUrlFor = (caseId) => `http://fixture.invalid/case/${encodeURIComponent(caseId)}`

  return { fetchImpl, requests, baseUrlFor }
}

/**
 * Read the canned answers a corpus ships.
 *
 * Every dispatch case carries `answers/default.md`. A missing one is a corpus bug and surfaces as
 * a 404 through the real provider error path rather than as a silent pass.
 *
 * @returns {{answers: Map<string,string>, errors: string[]}}
 */
export function loadAnswers(cases, corpusDir, { fs, path }) {
  const answers = new Map()
  const errors = []
  for (const caseDef of cases) {
    if (caseDef.harness !== 'dispatch') continue
    const file = path.join(corpusDir, caseDef.id, 'answers', 'default.md')
    try {
      answers.set(caseDef.id, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    } catch (err) {
      errors.push(`missing_answer:${caseDef.id}/answers/default.md ${err?.code ?? 'unknown'}`)
    }
  }
  return { answers, errors }
}
