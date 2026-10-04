/**
 * What this renderer accepts, and what it refuses.
 *
 * `router-dashboard` installs independently of `model-router` and may not import a single line of
 * it, so an analytics response is the entire agreement between the two plugins. That makes the
 * version check here load-bearing rather than ceremonial: a response from a newer engine may have
 * given a field a new meaning, and rendering it anyway would produce a report that looks right
 * and is wrong.
 *
 * SO AN UNKNOWN CONTRACT VERSION IS REFUSED, NOT COERCED. The failure mode of refusing is an
 * operator who has to upgrade one of two plugins; the failure mode of guessing is a dashboard
 * that quietly misreports money.
 *
 * IT VALIDATES SHAPE, NOT VALUES. Whether a figure is plausible is the engine's business — this
 * layer has no idea what a reasonable cost looks like and must not acquire an opinion, because an
 * opinion here would become a second methodology.
 */

/** Contract versions this renderer understands. */
export const SUPPORTED_CONTRACT_VERSIONS = Object.freeze([1])

/** Sections a response must carry before it is worth rendering. */
export const REQUIRED_SECTIONS = Object.freeze([
  'engine',
  'request',
  'timeRange',
  'summary',
  'routing',
  'workerUsage',
  'savings',
  'cost',
  'latency',
  'failures',
  'governance',
  'capability',
  'value',
  'negativeSavings',
  'segments',
  'coverage',
  'dataQuality',
])

/**
 * Check a parsed response.
 *
 * @returns {{ok: true, response: object} | {ok: false, reason: string, detail: string}}
 */
export function acceptResponse(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object', detail: 'An analytics response is a JSON object.' }
  }

  const version = parsed.analytics_contract_version
  if (typeof version !== 'number') {
    return {
      ok: false,
      reason: 'no_contract_version',
      detail:
        'The input carries no analytics_contract_version. It is probably not an analytics response — the producer is `analytics --json`.',
    }
  }
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(version)) {
    return {
      ok: false,
      reason: 'unsupported_contract_version',
      detail:
        `This renderer understands analytics contract ${SUPPORTED_CONTRACT_VERSIONS.join(', ')} and was handed version ${version}. ` +
        'A newer contract may have given a field a new meaning, so rendering it anyway would produce a report that looks right and is wrong. Upgrade router-dashboard, or generate the response with a matching model-router.',
    }
  }

  const missing = REQUIRED_SECTIONS.filter((s) => parsed[s] === undefined || parsed[s] === null)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'incomplete_response',
      detail: `The response is missing: ${missing.join(', ')}.`,
    }
  }

  return { ok: true, response: parsed }
}

/**
 * Parse text into a response, with a usable message when it is not one.
 *
 * The common mistakes are piping the human output instead of `--json`, and piping nothing at all
 * because a shell swallowed the redirect. Both get named, because "Unexpected token" sends the
 * reader to the wrong place.
 */
export function parseResponse(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') {
    return {
      ok: false,
      reason: 'empty_input',
      detail: 'Nothing arrived on the input. Did the analytics command run with --json?',
    }
  }
  if (!trimmed.startsWith('{')) {
    return {
      ok: false,
      reason: 'not_json',
      detail:
        'The input does not begin with `{`. This looks like the human-readable report rather than the JSON one; add --json to the analytics command.',
    }
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    return { ok: false, reason: 'malformed_json', detail: `The input is not valid JSON: ${err.message}` }
  }
  return acceptResponse(parsed)
}
