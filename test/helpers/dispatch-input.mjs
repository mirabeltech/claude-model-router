/**
 * Shared dispatch test scaffolding.
 *
 * `dispatchConfig()` runs the REAL resolver, the way `routingConfig()` does, so a new SPEC key
 * cannot leave the helper behind. Two things then have to be patched imperatively afterwards:
 *
 *  - `providers.mock.baseUrl` has no SPEC leaf, and `resolveConfig` emits only DEFAULTS plus SPEC
 *    leaves, so a value supplied through a layer is dropped AND warned about. The conformance
 *    suite hand-builds the same field for the same reason.
 *  - a sub-second `timeoutMs` is below the SPEC minimum of 1000, and the timeout tests need one.
 *    The dispatcher does not re-validate ranges, so patching the resolved object is honest: it
 *    tests the dispatcher, not the config layer, which has its own suite.
 */

import { resolveConfig } from '../../plugins/model-router/lib/config.mjs'
import { POLICY_VERSION } from '../../plugins/model-router/lib/routing-policy.mjs'

/**
 * A resolved config with `overrides` applied as a project layer, then `patch` applied directly.
 *
 * @param {object} overrides  goes through the resolver and is therefore validated
 * @param {object} patch      bypasses the resolver, for values it legitimately cannot express
 */
export function dispatchConfig(overrides = {}, patch = {}) {
  const config = resolveConfig({ layers: [{ name: 'test', data: overrides }] }).config
  if (patch.providers) {
    config.providers = { ...config.providers }
    for (const [id, block] of Object.entries(patch.providers)) {
      config.providers[id] = { ...config.providers[id], ...block }
    }
  }
  if (patch.worker) config.worker = { ...config.worker, ...patch.worker }
  return config
}

/**
 * A config pointed at a running fixture server for every provider at once, so one helper serves
 * the gemini, ollama and mock legs of a test.
 */
export function serverConfig(baseUrl, overrides = {}, patch = {}) {
  return dispatchConfig(overrides, {
    ...patch,
    providers: {
      gemini: { baseUrl },
      ollama: { baseUrl },
      mock: { baseUrl },
      ...(patch.providers ?? {}),
    },
  })
}

/**
 * A DELEGATING decision, in exactly the shape `decide()` returns — nine keys, frozen, in order.
 *
 * Hand-built rather than produced by calling `decide()`, so a dispatch test does not have to
 * satisfy the 16-field routing input contract to exercise one dispatcher branch. One test in
 * `dispatch.decision.test.mjs` drives the real `decide()` to prove the two still fit together.
 *
 * Note the default `decision: 'deny'`: that is what the shipped bulkRead lane returns WHILE
 * delegating, and a fixture that quietly used 'allow' would hide the distinction.
 */
export function delegatingDecision(overrides = {}) {
  return Object.freeze({
    decision: 'deny',
    delegate: true,
    mode: 'bulk-reader',
    lane: 'bulkRead',
    reason: 'threshold_met',
    taskType: 'bulk_read',
    estimatedInputTokens: 10000,
    policyVersion: POLICY_VERSION,
    inputWarnings: Object.freeze([]),
    ...overrides,
  })
}

/** A decision that refuses to delegate, in the same shape. */
export function decliningDecision(overrides = {}) {
  return delegatingDecision({
    decision: 'allow',
    delegate: false,
    mode: null,
    lane: null,
    reason: 'below_threshold',
    ...overrides,
  })
}

/** A valid bulk-reader payload. Multi-file by default: one file is the degenerate case. */
export function bulkReadPayload(overrides = {}) {
  return {
    files: [
      { path: 'src/user-service.js', content: 'export class UserService {}\n' },
      { path: 'src/create-user.js', content: 'export function createUser() {}\n' },
    ],
    task: 'List every export and say which file it is in.',
    ...overrides,
  }
}

/** A valid code-writer payload. */
export function codeWritePayload(overrides = {}) {
  return {
    instruction: 'Write a unit test for createUser that covers the empty-name case.',
    context: 'The project uses node:test and node:assert/strict.',
    reference: "import test from 'node:test'\n",
    ...overrides,
  }
}

/**
 * A task intent with every field populated, so a test exercises the whole contract at once.
 *
 * Fully populated by default because the interesting failures are in the fields the production
 * hook cannot fill: production only ever sets `task`, so a helper that defaulted to that alone
 * would leave the other four rendered by nothing but their own unit tests.
 */
export function taskIntentFixture(overrides = {}) {
  return {
    task: 'Find every deprecated handler and name it.',
    objective: 'Retire the deprecated handlers before the next release.',
    requestedInformation: 'the handler key and the line it is declared on',
    constraints: 'report every match, not the first one',
    outputFormat: 'one handler per line',
    source: 'transcript',
    ...overrides,
  }
}

/** An intent-bearing bulk-reader payload, as `buildWorkerTask` would produce one. */
export function bulkReadIntentPayload(overrides = {}) {
  return {
    ...bulkReadPayload(),
    instructions: ['Answer the stated task directly and first.', 'Find EVERY occurrence.'],
    outputRequirements: ['Report: the handler key and its line', 'Present the answer as: one per line'],
    ...overrides,
  }
}

/** An intent-bearing code-writer payload. */
export function codeWriteIntentPayload(overrides = {}) {
  return {
    ...codeWritePayload(),
    instructions: ['Satisfy the stated objective exactly.'],
    outputRequirements: ['Constraints: use node:test only'],
    ...overrides,
  }
}

/**
 * A clock that advances by a fixed step on every read, so `latencyMs` is exact rather than
 * merely non-negative, and so a test can assert how many times the dispatcher read it.
 */
export function fixedClock(start = 1_000_000, step = 25) {
  let calls = 0
  const now = () => {
    const t = start + calls * step
    calls += 1
    return t
  }
  now.calls = () => calls
  return now
}
