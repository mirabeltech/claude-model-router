/**
 * The analytics response contract.
 *
 * This is the handshake between the two plugins. `router-dashboard` may not import a single line
 * of `model-router`, so the response object is the entire agreement between them, and a field
 * that quietly changes meaning breaks a renderer nobody tested against the change.
 *
 * THE TWO CENSUS TESTS ARE THE LOAD-BEARING ONES. Every aggregate in the response must have a
 * declared unit and a declared population, and both are checked by walking the FINISHED response
 * rather than the table — a table-only check passes while a new headline ships unlabelled. The
 * unit matters because the dashboard cannot import `formatAgg()` and prints the string the engine
 * produced; the population matters because a coverage figure without its denominator is not
 * information.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeRows, SECTIONS } from '../plugins/model-router/lib/analytics/index.mjs'
import {
  ANALYTICS_CONTRACT_VERSION,
  DISPLAY_UNITS,
  EXAMPLE_FIELDS,
  FIELD_ALLOWLIST,
  FORBIDDEN_FIELDS,
  GATE_REFUSAL_REASONS,
  METRIC_KINDS,
  POPULATIONS,
  ROW_CLASSES,
  SEGMENT_DIMENSIONS,
  UNITS,
} from '../plugins/model-router/lib/analytics/schema.mjs'
import { findAggNodes, findForbiddenFields, stringifyResponse } from '../plugins/model-router/lib/analytics/serialize.mjs'
import { formatAgg, NULL_KEY } from '../plugins/model-router/lib/telemetry/aggregate.mjs'
import { FIELD_ORDER, ROUTING_REASONS } from '../plugins/model-router/lib/telemetry/record.mjs'
import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { mapReadReport } from '../plugins/model-router/lib/analytics/quality.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures', 'telemetry')
const NOW = Date.parse('2026-03-04T12:00:00.000Z')

/** The corpus, analyzed once. Every census test walks this same finished object. */
function corpusResponse(window = { kind: '7d' }, scope = {}) {
  const { records, report } = readSegmentsSync({ dir: FIXTURES, fs })
  return analyzeRows(records, { now: NOW, window, scope, read: mapReadReport(report) })
}

const RESPONSE = corpusResponse()

/* ------------------------------------------------------------------ the shape */

test('a response carries exactly the declared sections, and the version beside them', () => {
  assert.equal(RESPONSE.analytics_contract_version, ANALYTICS_CONTRACT_VERSION)
  const keys = Object.keys(RESPONSE).filter((k) => k !== 'analytics_contract_version')
  assert.deepEqual(keys.sort(), [...SECTIONS].sort(), 'the response gained or lost a section')
})

test('the engine stamps the versions it understands, so a stale reader is detectable', () => {
  assert.equal(RESPONSE.engine.contractVersion, ANALYTICS_CONTRACT_VERSION)
  assert.equal(typeof RESPONSE.engine.routerVersion, 'string')
  assert.equal(RESPONSE.engine.buildSchemaVersion, 1)
  assert.equal(RESPONSE.engine.buildCalcVersion, 1)
  assert.deepEqual(RESPONSE.engine.knownSchemaVersions, [1])
  // The dashboard groups by the same sentinel, so it has to be told what it is rather than
  // hard-coding a string that could drift.
  assert.equal(RESPONSE.engine.nullKey, NULL_KEY)
})

test('the request echoes what was asked AND what was actually filtered on', () => {
  // `--mode` has no column in schema v1 and resolves onto task_type. Nobody should have to guess
  // which column a filter consulted.
  const r = corpusResponse({ kind: '7d' }, { mode: 'bulk-reader' })
  assert.equal(r.request.scope.mode, 'bulk-reader')
  assert.equal(r.request.resolvedFilters.task_type, 'bulk_read')
  assert.deepEqual(r.request.scopeWarnings, [])
})

test('the time range states its zone and its boundary convention on every response', () => {
  assert.equal(RESPONSE.timeRange.timeZone, 'UTC')
  assert.equal(RESPONSE.timeRange.boundaries, 'half_open')
  assert.equal(RESPONSE.timeRange.valid, true)
})

/* ------------------------------------------------- the two census tests */

test('every aggregate in the response has a declared unit', () => {
  // Walking the FINISHED response, not the table. A table-only check passes while a brand-new
  // headline ships with no unit at all, and `serializeAgg` is what would then have to guess.
  const violations = []
  for (const { path: p, node } of findAggNodes(RESPONSE)) {
    if (!UNITS.includes(node.unit)) violations.push(`${p}: unit ${node.unit}`)
    if (typeof node.places !== 'number') violations.push(`${p}: no places`)
  }
  assert.deepEqual(violations, [], 'an aggregate reached the response without a usable unit')
})

test('every aggregate names a declared population, so its coverage can be interpreted', () => {
  // Savings columns are null on every gate_block row BY CONSTRUCTION, so a savings aggregate
  // over a whole window reports `partial` forever. Without the population name, `coverage: 0.31`
  // reads as a measurement problem rather than as the shape of the schema.
  const violations = []
  for (const { path: p, node } of findAggNodes(RESPONSE)) {
    if (POPULATIONS[node.population] === undefined) {
      violations.push(`${p}: undeclared population ${node.population}`)
    }
  }
  assert.deepEqual(violations, [], 'an aggregate reached the response without a named population')
})

test('every headline aggregate path appears in the DISPLAY_UNITS table', () => {
  const violations = []
  for (const { path: p, node } of findAggNodes(RESPONSE)) {
    // Segment buckets borrow a headline's unit, so only the full (non-compact) nodes are keyed
    // by their own path.
    if (node.nullReason === undefined) continue
    if (DISPLAY_UNITS[p] === undefined) violations.push(p)
  }
  assert.deepEqual(violations, [], 'a headline aggregate has no entry in DISPLAY_UNITS')
})

test('every DISPLAY_UNITS entry declares a known unit and an integer precision', () => {
  const violations = []
  for (const [p, spec] of Object.entries(DISPLAY_UNITS)) {
    if (!UNITS.includes(spec.unit)) violations.push(`${p}: ${spec.unit}`)
    if (!Number.isInteger(spec.places)) violations.push(`${p}: places ${spec.places}`)
    if (spec.unit === 'USD' && spec.places !== 4) violations.push(`${p}: money must render at 4 places`)
    if (spec.unit === 'tokens' && spec.places !== 0) violations.push(`${p}: tokens must render whole`)
  }
  assert.deepEqual(violations, [], 'a declared unit is unusable')
})

/* --------------------------------------------- display is the engine's job */

test('every aggregate display string equals formatAgg of that same aggregate', () => {
  // The dashboard cannot import formatAgg — it lives behind the /model-router/ import ban — so
  // the engine renders the string and ships it. A second copy of that one function in the
  // dashboard would reintroduce exactly the failure the rule exists to prevent: an
  // `unavailable` aggregate printed as $0.0000.
  const violations = []
  for (const { path: p, node } of findAggNodes(RESPONSE)) {
    const want = formatAgg(node, { unit: node.unit, places: node.places })
    if (node.display !== want) violations.push(`${p}: ${JSON.stringify(node.display)} != ${JSON.stringify(want)}`)
  }
  assert.deepEqual(violations, [], 'a display string was not produced by the shipped formatter')
})

test('an unavailable aggregate never renders as a zero amount', () => {
  // The whole phase exists to keep "we saved $0" apart from "we do not know the cost".
  const violations = []
  for (const { path: p, node } of findAggNodes(RESPONSE)) {
    if (node.status !== 'unavailable') continue
    if (node.value !== null) violations.push(`${p}: unavailable but value ${node.value}`)
    if (/^\$?-?0(\.0+)?( tokens)?$/.test(node.display)) violations.push(`${p}: renders as ${node.display}`)
    if (!node.display.includes('unavailable')) violations.push(`${p}: ${node.display} does not say unavailable`)
  }
  assert.deepEqual(violations, [], 'an unmeasurable figure rendered as a zero')
})

test('a null value always carries a reason, and a non-null value never does', () => {
  const violations = []
  for (const { path: p, node } of findAggNodes(RESPONSE)) {
    if (node.nullReason === undefined) continue
    if (node.value === null && node.nullReason === null) violations.push(`${p}: null with no reason`)
    if (node.value !== null && node.nullReason !== null) violations.push(`${p}: ${node.value} with a null reason`)
  }
  assert.deepEqual(violations, [], 'a null and its explanation came apart')
})

test('a partial sum of a signed column is never presented as a lower bound', () => {
  // `bound` is the honesty bit. For a same-signed column a partial sum really is "at least $X";
  // for net savings, signed by construction, a partial sum bounds nothing in either direction.
  const net = RESPONSE.summary.netSavings
  assert.equal(net.status, 'partial')
  assert.equal(net.bound, 'none', 'the corpus holds negative net savings, so there is no floor')
  assert.equal(net.display.startsWith('at least'), false, 'a signed partial must not claim a floor')

  const cost = RESPONSE.summary.workerCost
  assert.equal(cost.bound, 'lower', 'cost is non-negative, so a partial sum is a genuine floor')
  assert.ok(cost.display.startsWith('at least'))
})

/* ------------------------------------------------------- the metric kinds */

test('every metric node declares one of the known kinds', () => {
  const violations = []
  const walk = (value, p) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${p}[${i}]`))
    if (typeof value.metricKind === 'string' && !METRIC_KINDS.includes(value.metricKind)) {
      violations.push(`${p}: ${value.metricKind}`)
    }
    for (const [k, v] of Object.entries(value)) walk(v, p === '' ? k : `${p}.${k}`)
  }
  walk(RESPONSE, '')
  assert.deepEqual(violations, [], 'an unknown metric kind reached the response')
})

test('a count is never null, because a count has no coverage problem', () => {
  const violations = []
  const walk = (value, p) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${p}[${i}]`))
    if (value.metricKind === 'count' && !Number.isInteger(value.value)) {
      violations.push(`${p}: ${value.value}`)
    }
    for (const [k, v] of Object.entries(value)) walk(v, p === '' ? k : `${p}.${k}`)
  }
  walk(RESPONSE, '')
  assert.deepEqual(violations, [], 'a count was null or fractional')
})

test('an unavailable metric carries a machine-readable reason and never a value', () => {
  const violations = []
  const walk = (value, p) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${p}[${i}]`))
    if (value.metricKind === 'unavailable') {
      if (value.value !== null) violations.push(`${p}: has a value`)
      if (typeof value.reason !== 'string' || value.reason === '') violations.push(`${p}: no reason`)
      if (typeof value.detail !== 'string' || value.detail === '') violations.push(`${p}: no detail`)
    }
    for (const [k, v] of Object.entries(value)) walk(v, p === '' ? k : `${p}.${k}`)
  }
  walk(RESPONSE, '')
  assert.deepEqual(violations, [], 'an unavailable metric failed to explain itself')
})

test('a rate reports both of its operands and whether the denominator was complete', () => {
  const violations = []
  const walk = (value, p) => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${p}[${i}]`))
    if (value.metricKind === 'rate') {
      if (!Number.isInteger(value.numerator)) violations.push(`${p}: no numerator`)
      if (!Number.isInteger(value.denominator)) violations.push(`${p}: no denominator`)
      if (typeof value.denominatorComplete !== 'boolean') violations.push(`${p}: no completeness flag`)
      if (value.denominator === 0 && value.value !== null) violations.push(`${p}: divided by zero`)
      if (!value.denominatorComplete && value.value !== null) {
        violations.push(`${p}: computed against an incomplete denominator`)
      }
    }
    for (const [k, v] of Object.entries(value)) walk(v, p === '' ? k : `${p}.${k}`)
  }
  walk(RESPONSE, '')
  assert.deepEqual(violations, [], 'a rate hid one of its operands')
})

test('a series reports nearest-rank statistics and declares that it does not interpolate', () => {
  for (const s of [RESPONSE.latency.total, RESPONSE.latency.provider]) {
    assert.equal(s.metricKind, 'series')
    assert.equal(s.method, 'nearest_rank')
    assert.equal(s.interpolated, false)
    // An interpolated p95 is a latency that never happened. Every reported percentile here is a
    // value some event actually produced, so an operator can go and find it.
    assert.equal(s.mean, null, 'the mean is refused on purpose')
    assert.equal(typeof s.meanReason, 'string')
  }
})

/* ------------------------------------------------------------ the vocabulary */

test('GATE_REFUSAL_REASONS is a strict subset of ROUTING_REASONS', () => {
  // Two lists that must agree, in two files. Without this they desync the first time a reason is
  // added, and a new refusal silently becomes an `approvedNotDispatched`.
  const unknown = GATE_REFUSAL_REASONS.filter((r) => !ROUTING_REASONS.includes(r))
  assert.deepEqual(unknown, [], 'a gate refusal reason is not a routing reason')
  assert.equal(GATE_REFUSAL_REASONS.includes('threshold_met'), false, 'threshold_met means the gate APPROVED')
  assert.equal(GATE_REFUSAL_REASONS.includes('context_exceeded'), false, 'a context refusal is not a gate refusal')
  assert.equal(GATE_REFUSAL_REASONS.includes('provider_error'), false, 'a provider error is not a gate refusal')
})

test('every row class is reported, including the ones that did not occur', () => {
  assert.deepEqual(Object.keys(RESPONSE.routing.byClass).sort(), [...ROW_CLASSES].sort())
  for (const [k, v] of Object.entries(RESPONSE.routing.byClass)) {
    assert.equal(Number.isInteger(v), true, `${k} is not a count`)
  }
})

test('every segment dimension is present, keyed by its id', () => {
  const declared = SEGMENT_DIMENSIONS.map((d) => d.id).sort()
  const present = Object.keys(RESPONSE.segments).sort()
  assert.deepEqual(present, declared, 'a dimension is missing from the response')
})

test('every segment bucket declares its key kind, and the null key is the shared sentinel', () => {
  // A model genuinely named `__other__` must still be reported as itself, so consumers branch on
  // keyKind and never on the key string.
  const violations = []
  for (const [id, dim] of Object.entries(RESPONSE.segments)) {
    for (const b of dim.buckets) {
      if (!['value', 'null', 'other', 'overflow'].includes(b.keyKind)) {
        violations.push(`${id}.${b.key}: keyKind ${b.keyKind}`)
      }
      if (b.keyKind === 'null' && b.key !== NULL_KEY) violations.push(`${id}: null bucket keyed ${b.key}`)
      if (b.keyKind === 'null' && b.label !== 'unknown') violations.push(`${id}: null bucket labelled ${b.label}`)
      if (typeof b.label !== 'string' || b.label === '') violations.push(`${id}.${b.key}: no label`)
    }
  }
  assert.deepEqual(violations, [], 'a bucket key could not be interpreted')
})

/* ----------------------------------------------------------------- security */

test('the response carries no forbidden telemetry column, at any depth', () => {
  assert.deepEqual(findForbiddenFields(RESPONSE), [])
})

test('the forbidden list and the allowlist partition FIELD_ORDER exactly', () => {
  // An ALLOWLIST, not a denylist: a column added to the telemetry schema must be admitted here
  // deliberately. With a denylist, a new column carrying content would reach a rendered
  // dashboard the moment somebody grouped by it.
  assert.deepEqual([...FIELD_ALLOWLIST, ...FORBIDDEN_FIELDS].sort(), [...FIELD_ORDER].sort())
  assert.equal(FIELD_ALLOWLIST.some((f) => FORBIDDEN_FIELDS.includes(f)), false)
})

test('the fixture content markers appear nowhere in a serialized response', () => {
  // The corpus carries FIXTURE-MUST-NOT-APPEAR-* in question_text, error_message_safe and
  // project_path. Asserting the absence of those VALUES tests the property that matters, which
  // is that content never reaches an output — not merely that a key name is absent.
  const json = stringifyResponse(RESPONSE)
  assert.equal(json.includes('FIXTURE-MUST-NOT-APPEAR'), false, 'content leaked into the response')
})

test('a negative-savings example exposes only the declared diagnostic fields', () => {
  const violations = []
  for (const example of RESPONSE.negativeSavings.examples.items) {
    for (const key of Object.keys(example)) {
      if (!EXAMPLE_FIELDS.includes(key)) violations.push(key)
    }
  }
  assert.deepEqual(violations, [], 'an example carried a field the contract does not declare')
  assert.equal(EXAMPLE_FIELDS.some((f) => FORBIDDEN_FIELDS.includes(f)), false)
})

test('the reader samples are counted and withheld, because each one is a raw-line excerpt', () => {
  // A sample carries 120 characters of a RAW telemetry line plus an absolute file path, and a
  // raw line is a whole record — so it can contain any of the three content fields.
  assert.ok(RESPONSE.dataQuality.read.samplesWithheld >= 1, 'the corpus has a malformed line to sample')
  assert.equal('samples' in RESPONSE.dataQuality.read, false)
  assert.match(RESPONSE.dataQuality.read.samplesWithheldReason, /content fields/)
})

/* ------------------------------------------------------------ serialization */

test('a response round-trips through JSON without losing a key', () => {
  // JSON.stringify DROPS keys whose value is undefined, and absent is not null in this schema.
  // A section that vanished on the way to a file would tell the dashboard it does not exist.
  const back = JSON.parse(stringifyResponse(RESPONSE))
  assert.deepEqual(Object.keys(back).sort(), Object.keys(RESPONSE).sort())
  assert.equal(back.summary.workerCost.display, RESPONSE.summary.workerCost.display)
  assert.equal(back.summary.netSavings.value, RESPONSE.summary.netSavings.value)
})

test('no key anywhere in a serialized response is undefined', () => {
  const json = stringifyResponse(RESPONSE)
  assert.equal(json.includes('undefined'), false)
})

test('two analyses of the same rows with the same clock are byte-identical', () => {
  // The CI reproducibility diff rests on this. Map iteration is insertion order, so any
  // ordering that depended on which row arrived first would break it.
  assert.equal(stringifyResponse(corpusResponse()), stringifyResponse(corpusResponse()))
})

/* ----------------------------------------------------- the empty response */

test('an empty window produces a complete response, not a truncated one', () => {
  // A dashboard must be able to render a fresh install without special-casing anything.
  const empty = analyzeRows([], { now: NOW, window: { kind: '7d' } })
  assert.deepEqual(
    Object.keys(empty).filter((k) => k !== 'analytics_contract_version').sort(),
    [...SECTIONS].sort(),
  )
  assert.equal(empty.summary.events.value, 0)
  assert.equal(empty.summary.tokensAvoided.value, null)
  assert.equal(empty.summary.tokensAvoided.display, 'no events')
  assert.equal(empty.summary.delegationRate.value, null, 'a rate over no events is null, not 0%')
  assert.equal(empty.latency.total.median, null, 'no samples is not no time')
  assert.equal(empty.latency.total.n, 0)
})

test('an invalid window produces a complete response that says why', () => {
  const bad = analyzeRows([], { now: NOW, window: { kind: 'last_fortnight' } })
  assert.equal(bad.timeRange.valid, false)
  assert.equal(bad.timeRange.reason, 'unknown_window_kind')
  assert.deepEqual(
    Object.keys(bad).filter((k) => k !== 'analytics_contract_version').sort(),
    [...SECTIONS].sort(),
  )
})
