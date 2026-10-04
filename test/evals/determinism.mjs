/**
 * Reproducibility: stable event ids, and the projection that can actually be compared byte for
 * byte across machines.
 *
 * THE PROBLEM THIS SOLVES. A `buildEvent()` row carries
 *
 *   tz_offset_minutes: -new Date(now).getTimezoneOffset()
 *
 * which is MACHINE-LOCAL. Both CI platforms gate, so the same injected `now` produces a different
 * value on a Windows developer box than on Linux CI, and a full row is therefore not a
 * byte-comparable artifact however carefully the clock is frozen. Forcing `process.env.TZ` after
 * startup is unreliable on Windows, so the fix is not to fight it: compare a PROJECTION that omits
 * the fields which legitimately vary, and keep the full rows as a separate artifact that is
 * recorded rather than diffed.
 *
 * That resolves a second collision too. Real latency measurement and a byte-identical golden file
 * cannot coexist in one artifact — one of them has to be lying. So the framework writes three:
 *
 *   rows.jsonl     every field of every row. Recorded, never compared.
 *   stable.jsonl   the projection. THE golden; two runs must match byte for byte.
 *   timings.json   the named latency series, stamped `deterministic: false`.
 */

import crypto from 'node:crypto'

import { FIELD_ORDER } from '../../plugins/model-router/lib/telemetry/record.mjs'

/** The frozen clock. Mid-day UTC, matching `telemetry-dir.mjs FROZEN_MS`, so no daily-rotation
 *  boundary is near enough to make a test fail once a day. */
export const EVAL_NOW = Date.parse('2026-03-04T12:00:00.000Z')

export const EVAL_EVENT_ID_PREFIX = 'eval'

/**
 * Fields omitted from the golden projection, each for a stated reason.
 *
 *   tz_offset_minutes    machine-local, as argued above
 *   latency_ms           a real wall-clock measurement; identical across runs would be the bug
 *   provider_latency_ms  same
 *
 * Nothing else is omitted. In particular no SAVINGS field is omitted: those must be reproducible,
 * and if one ever is not, that is a finding rather than something to project away.
 */
export const EVAL_VOLATILE_FIELDS = Object.freeze(['tz_offset_minutes', 'latency_ms', 'provider_latency_ms'])

const VOLATILE = new Set(EVAL_VOLATILE_FIELDS)

/**
 * A deterministic event id that is also unmistakably synthetic.
 *
 * `buildEvent` writes `eventId` through verbatim with no UUID constraint, so a sha256 formatted to
 * look like a UUID would be both an invalid UUIDv4 and — worse — indistinguishable from a
 * production row at a glance. With `session_id` and `project_id` both null, this prefix is the
 * only in-row signal that a row came from the eval. A test asserts it.
 */
export function eventIdFor(caseId, runSeed) {
  const digest = crypto.createHash('sha256').update(`${caseId}|${runSeed}`, 'utf8').digest('hex')
  return `${EVAL_EVENT_ID_PREFIX}:${caseId}:${digest.slice(0, 16)}`
}

/**
 * Project a row onto the comparable fields, in `FIELD_ORDER`.
 *
 * Iterating `FIELD_ORDER` rather than the row's own keys means the projection's key order is a
 * property of the schema, not of insertion order, so two runs cannot differ by ordering alone.
 */
export function stableProjection(row) {
  const out = {}
  for (const field of FIELD_ORDER) {
    if (VOLATILE.has(field)) continue
    // Written explicitly, including null. An absent key and a null key are not two ways of saying
    // the same thing — `record.mjs` makes that rule and the projection keeps it.
    out[field] = Object.hasOwn(row, field) ? row[field] : null
  }
  return out
}

/** One JSONL line of the golden artifact. */
export function stableLine(row) {
  return JSON.stringify(stableProjection(row)) + '\n'
}

/**
 * The seven latency series, named and kept apart.
 *
 * NEVER SUMMED. A single "total" would hide which of seven costs moved, and two of these overlap
 * by construction — `total_delegated_path` contains `worker`, which contains `provider` — so
 * adding them would double-count. The brief's ~73 ms process startup is `hook_startup`.
 */
export const LATENCY_SERIES = Object.freeze([
  'hook_startup',
  'routing_decision',
  'file_load',
  'worker',
  'provider',
  'total_delegated_path',
  'primary_path_overhead',
])

/**
 * Provenance for one run: everything needed to say what produced these numbers.
 *
 * `modelDependent` is derived from the arm rather than passed, so a live run cannot be filed as
 * reproducible by forgetting a flag.
 */
export function buildProvenance({
  evalSchemaVersion,
  corpusFingerprint,
  corpusCases,
  arm,
  config,
  pricingVersion,
  pricingSource,
  runSeed,
  startedAt,
  versions,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
}) {
  return {
    evalSchemaVersion,
    corpusFingerprint,
    corpusCases,
    arm: arm.id,
    deterministic: arm.deterministic,
    modelDependent: !arm.deterministic,
    provider: config?.worker?.provider ?? null,
    modelRequested: config?.worker?.model ?? null,
    pricingVersion,
    pricingSource,
    runSeed,
    startedAt,
    frozenClock: EVAL_NOW,
    platform,
    arch,
    nodeVersion,
    ...versions,
  }
}
