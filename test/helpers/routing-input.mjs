/**
 * Shared routing test scaffolding.
 *
 * Separate from `telemetry-dir.mjs` on purpose: that file is telemetry-scoped and imports
 * `node:fs` and `node:crypto`, and the routing engine is a pure function that should be tested
 * without pulling a filesystem helper into the module graph.
 *
 * `routingConfig()` builds its config by running the REAL resolver rather than hand-writing a
 * literal the way `telemetryConfig()` does. Two things fall out of that for free: the
 * invalid-threshold tests get genuine fallback-to-default behaviour instead of a fake, and the
 * helper can never drift from `DEFAULTS` when a SPEC key is added.
 */

import { resolveConfig } from '../../plugins/model-router/lib/config.mjs'

/**
 * A resolved config with `overrides` applied as a project layer.
 * @returns {object} the `config` half of resolveConfig's result
 */
export function routingConfig(overrides = {}) {
  return resolveConfig({ layers: [{ name: 'test', data: overrides }] }).config
}

/** The same, when a test needs to assert on the warnings the layer produced. */
export function routingConfigWithWarnings(overrides = {}) {
  return resolveConfig({ layers: [{ name: 'test', data: overrides }] })
}

/**
 * A DELEGATION-WORTHY bulk-read baseline: under default config this input delegates. Every
 * exclusion test then flips exactly one field, which makes the table the clearest possible
 * statement of what each rule is responsible for.
 */
export function bulkReadInput(overrides = {}) {
  return {
    taskType: 'bulk_read',
    toolName: 'Read',
    fileCount: 4,
    lineCount: 900,
    inputBytes: 40000,
    estimatedInputTokens: 10000,
    targetedRead: false,
    fullRead: true,
    recentlyEdited: false,
    latencySensitive: false,
    interactive: false,
    requestedOutput: 'summary',
    paths: ['/proj/src/a.ts', '/proj/src/b.ts', '/proj/src/c.ts', '/proj/src/d.ts'],
    projectPath: '/proj',
    workerAvailable: true,
    workerUnavailableReason: null,
    ...overrides,
  }
}

/** The code-write counterpart. The lane has no size thresholds, so sizes are incidental here. */
export function codeWriteInput(overrides = {}) {
  return bulkReadInput({
    taskType: 'code_write',
    toolName: 'Write',
    requestedOutput: 'file',
    ...overrides,
  })
}

/**
 * Values a caller should never send, and which must never become a favorable delegation signal.
 * `'350'` is in here deliberately: a numeric string is a plausible mistake from a hook that read
 * a tool argument, and parsing it would make `''` and `'0'` silently meaningful too.
 */
export const HOSTILE_VALUES = Object.freeze([
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  -1,
  -0,
  1e21,
  0.5,
  '350',
  '',
  'true',
  true,
  false,
  {},
  [],
  () => {},
])

/** Config shapes that never came out of `resolveConfig` and must all fail open. */
export const MALFORMED_CONFIGS = Object.freeze([
  undefined,
  null,
  0,
  42,
  'x',
  true,
  [],
  {},
  { enabled: true },
  { routing: null },
  { enabled: true, routing: {} },
  { enabled: true, routing: { bulkRead: {}, codeWrite: {}, neverDelegate: {} } },
])
