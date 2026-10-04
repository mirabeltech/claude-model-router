/**
 * The metrics record, field by field.
 *
 * An eval row IS a telemetry event, produced by the shipped `buildEvent()`. This file pins the
 * mapping, because `buildEvent` reads the PRESENCE of `result` as "a worker call succeeded" — so
 * `result` is a three-valued switch, not a payload, and passing it wrong makes the row quietly a
 * different kind of row that still looks plausible.
 *
 * It also pins `toEvalEventInputs` against `hook/event.mjs toEventInputs()` on the single-file
 * case. There are two mappings from a routing outcome to a telemetry event, and two mappings of one
 * thing is two things that drift; the eval's exists only because `toEventInputs` hardcodes
 * `filesCount / provenFilesCount / filesInferredCount` to `1 / 1 / 0` and a corpus case may carry
 * up to twenty-five files.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { FIELD_ORDER, REQUIRED_FIELDS, SCHEMA_VERSION } from '../plugins/model-router/lib/telemetry/record.mjs'
import { toEventInputs } from '../plugins/model-router/lib/hook/event.mjs'
import { EVAL_IDENTITY, buildEvalRow, toEvalEventInputs } from './evals/row.mjs'
import { EVAL_NOW, eventIdFor } from './evals/determinism.mjs'
import { EVAL_CHAIN_BUNDLED, evalPricedChain, EVAL_PRIMARY_MODEL } from './evals/pricing.mjs'
import { evalConfig } from './evals/config.mjs'

const CONFIG = evalConfig({}, { projectDir: '/proj' })

const caseDef = (overrides = {}) => ({
  id: 'size-at-min-bytes',
  harness: 'decide',
  files: [{ path: 'files/at.ts', source: 'generated', bytes: 12_000, lines: 160 }],
  qualityCriteria: null,
  config: {},
  routingInput: {},
  safety: null,
  metadata: {},
  ...overrides,
})

const decision = (overrides = {}) =>
  Object.freeze({
    decision: 'deny',
    delegate: true,
    mode: 'bulk-reader',
    lane: 'bulkRead',
    reason: 'threshold_met',
    taskType: 'bulk_read',
    estimatedInputTokens: null,
    policyVersion: 1,
    inputWarnings: Object.freeze([]),
    ...overrides,
  })

const okResult = (overrides = {}) =>
  Object.freeze({
    ok: true,
    executed: true,
    status: 'ok',
    reason: 'completed',
    mode: 'bulk-reader',
    lane: 'bulkRead',
    provider: 'mock',
    model: 'mock-1',
    modelRequested: 'mock-1',
    text: 'a summary of about forty characters.',
    usage: Object.freeze({
      inputTokens: 3000,
      cachedInputTokens: 0,
      outputTokens: 9,
      thinkingTokens: 0,
      totalTokens: 3009,
      source: 'provider_reported',
    }),
    capabilities: Object.freeze({
      maxInputBytes: 64_000,
      supportsSystemPrompt: true,
      reportsUsage: true,
      requiresEnv: ['MOCK_WORKER_URL'],
      reportsThinkingTokens: true,
      supportsCachedInput: true,
    }),
    attempts: 1,
    latencyMs: 12,
    providerLatencyMs: 10,
    truncated: false,
    finishReason: 'stop',
    error: null,
    promptVersion: 1,
    policyVersion: 1,
    warnings: Object.freeze([]),
    ...overrides,
  })

const errResult = () =>
  Object.freeze({
    ...okResult(),
    ok: false,
    status: 'error',
    reason: 'provider_error',
    text: null,
    usage: null,
    error: Object.freeze({
      code: 'http_5xx',
      message: 'fixture failure',
      retryable: true,
      httpStatus: 500,
      detail: null,
      provider: 'mock',
    }),
  })

const row = (args) =>
  buildEvalRow({ config: CONFIG, pricingChain: EVAL_CHAIN_BUNDLED, now: EVAL_NOW, runSeed: 'test', ...args })

/* --------------------------------------------------- the four-case result switch */

test('delegated with a healthy worker produces an ok bulk_read row', () => {
  const r = row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: okResult(), corpusChars: 12_000 })
  assert.equal(r.status, 'ok')
  assert.equal(r.task_type, 'bulk_read')
  assert.equal(r.routing_decision, 'deny')
  assert.equal(r.routing_reason, 'threshold_met')
  assert.equal(r.provider, 'mock')
  assert.equal(r.model, 'mock-1', 'the model the provider reports SERVING is the pricing key')
  assert.equal(r.worker_input_tokens, 3000)
  assert.equal(r.worker_usage_source, 'provider_reported')
  assert.equal(r.retry_count, 0, 'one attempt is zero retries, and zero here is a real measurement')
  assert.equal(r.estimated_input_tokens, 3000, '12000 chars at chars/4')
  assert.equal(r.returned_answer_chars, 36, 'derived from result.text, not supplied')
  assert.equal(r.estimated_tokens_avoided, 3000 - 9, 'net of the answer')
  assert.equal(r.estimated_tokens_avoided_status, 'estimated')
})

test('delegated with a failed worker produces an error row with null usage', () => {
  const r = row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: errResult(), corpusChars: 12_000 })
  assert.equal(r.status, 'error')
  assert.equal(r.task_type, 'bulk_read', 'a delegation was attempted, so it is still a bulk_read event')
  assert.equal(r.error_code, 'http_5xx')
  assert.equal(r.worker_usage_source, 'missing', 'the string "missing", not null')
  assert.equal(r.worker_input_tokens, null)
  assert.equal(r.model, null, 'nothing was served')
  assert.equal(r.estimated_input_tokens, 3000, 'the payload WAS assembled, so the corpus size is real')
  assert.equal(r.returned_answer_chars, null, 'no answer came back')
  assert.equal(r.estimated_tokens_avoided, null, 'and so the NET is unavailable, not the gross')
  assert.equal(r.estimated_tokens_avoided_status, 'unavailable')
})

test('a gate refusal produces a skipped gate_block row that prices nothing', () => {
  const r = row({
    caseDef: caseDef(),
    decision: decision({ decision: 'allow', delegate: false, mode: null, reason: 'below_threshold' }),
    result: null,
    corpusChars: null,
    inputBytes: 11_999,
  })
  assert.equal(r.status, 'skipped')
  assert.equal(r.task_type, 'gate_block')
  assert.equal(r.routing_reason, 'below_threshold')
  assert.equal(r.provider, null)
  assert.equal(r.pricing_source, 'none')
  assert.equal(r.pricing_lookup, 'model_unknown')
  assert.equal(r.pricing_version, null)
  assert.equal(r.input_bytes, 11_999, 'the gate DID stat the file; that is a real measurement')
  assert.equal(r.estimated_input_tokens, null, 'no payload was built, so there is no corpus size')
  assert.equal(r.retry_count, null, 'no attempt was made, which is not zero retries')
})

test('the gate said delegate and no worker ran: an "other" row, not a lie in either direction', () => {
  // A decide-harness case exists precisely to stop at the gate. That state is neither a delegation
  // (`bulk_read` would claim a worker ran) nor a block (`gate_block` would claim the gate refused).
  const r = row({ caseDef: caseDef(), decision: decision(), result: null, corpusChars: null })
  assert.equal(r.task_type, 'other')
  assert.equal(r.status, 'skipped')
  assert.equal(r.routing_decision, 'deny', 'the decision it actually made is still recorded')
  assert.equal(r.routing_reason, 'threshold_met')
  assert.equal(r.estimated_tokens_avoided, null, 'and every savings column is unavailable on its own')
  assert.equal(r.estimated_net_savings, null)
})

test('a dispatch case with no result is a framework bug and throws', () => {
  // The narrower guard. At the dispatch layer the worker was supposed to run, so a missing result
  // cannot be a routing outcome.
  assert.throws(
    () => row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: null, corpusChars: null }),
    /delegated but has no dispatch result/,
  )
})

/* ------------------------------------------------- it really is a telemetry row */

test('the row carries every declared field, with null written explicitly', () => {
  // `aggregate()` gates on schema_version, so a hand-rolled shape would be counted
  // `rowsIncompatible` and silently dropped from every total.
  const r = row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: okResult(), corpusChars: 12_000 })
  assert.equal(r.schema_version, SCHEMA_VERSION)
  assert.deepEqual(Object.keys(r), [...FIELD_ORDER], 'the row must be exactly the schema, in order')
  for (const field of FIELD_ORDER) {
    assert.notEqual(r[field], undefined, `${field} is undefined; absent and null are not the same claim`)
  }
  // REQUIRED_FIELDS is the carcass set — the fields a record keeps even after the shed ladder has
  // stripped everything else. "Required" there means PRESENT, not non-null, and exactly one of them
  // is legitimately null here: `truncation_steps` is written by `serializeRecord`, not by
  // `buildEvent`, and null is the correct value for a record that was never truncated.
  const SERIALIZER_OWNED = new Set(['truncation_steps'])
  for (const field of REQUIRED_FIELDS) {
    assert.ok(Object.hasOwn(r, field), `${field} is required and must be present`)
    if (SERIALIZER_OWNED.has(field)) continue
    assert.notEqual(r[field], null, `${field} is required and must never be null on a built event`)
  }
  assert.equal(r.truncation_steps, null, 'nothing was shed, and the serializer has not run')
})

test('INV-1 holds on every measured field: value null if and only if status unavailable', () => {
  for (const args of [
    { caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: okResult(), corpusChars: 12_000 },
    { caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: errResult(), corpusChars: 12_000 },
    { caseDef: caseDef(), decision: decision({ decision: 'allow', delegate: false, reason: 'below_threshold' }), result: null, corpusChars: null },
  ]) {
    const r = row(args)
    for (const field of FIELD_ORDER) {
      if (!field.endsWith('_status')) continue
      const valueField = field.slice(0, -'_status'.length)
      if (!Object.hasOwn(r, valueField)) continue
      const unavailable = r[field] === 'unavailable'
      assert.equal(
        r[valueField] === null,
        unavailable,
        `${valueField}=${JSON.stringify(r[valueField])} with ${field}=${r[field]}`,
      )
    }
  }
})

/* ------------------------------------------------ identity, pricing, provenance */

test('identity is all null, so nothing is hashed and no salt file is created', () => {
  // buildIdentity() would create a file, and with a resolveConfig-built config it would create it
  // at a literal "~"-prefixed relative path under the working directory.
  assert.deepEqual(EVAL_IDENTITY, { session_id: null, project_id: null, project_path: null })
  const r = row({ caseDef: caseDef(), decision: decision({ delegate: false, decision: 'allow', reason: 'below_threshold' }), result: null })
  assert.equal(r.session_id, null)
  assert.equal(r.project_id, null)
  assert.equal(r.project_path, null)
  assert.equal(r.privacy_level, 'hashed', 'and all-null is consistent with the stamped privacy level')
})

test('the event id is deterministic and unmistakably synthetic', () => {
  // With session_id and project_id null, the prefix is the ONLY in-row signal that a row is not a
  // production row.
  const r = row({ caseDef: caseDef(), decision: decision({ delegate: false, decision: 'allow', reason: 'below_threshold' }), result: null })
  assert.match(r.event_id, /^eval:size-at-min-bytes:[0-9a-f]{16}$/)
  assert.equal(r.event_id, eventIdFor('size-at-min-bytes', 'test'))
  assert.notEqual(eventIdFor('size-at-min-bytes', 'other-seed'), r.event_id, 'the seed must matter')
})

test('the bundled chain prices nothing, which is the shipped reality', () => {
  const r = row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: okResult(), corpusChars: 12_000 })
  assert.equal(r.pricing_version, 'bundled-unpriced.1')
  assert.equal(r.pricing_source, 'bundled')
  assert.equal(r.pricing_lookup, 'wildcard', 'mock:* matches by wildcard')
  for (const field of ['worker_input_cost', 'worker_output_cost', 'worker_total_cost', 'estimated_net_savings']) {
    assert.equal(r[field], null, `${field} must be null against an all-null rate table`)
    assert.equal(r[`${field}_status`], 'unavailable')
  }
  assert.notEqual(r.estimated_tokens_avoided, null, 'the token figure is the honest out-of-box headline')
})

test('a priced fixture table makes the money path compute, and stamps a version that cannot be mistaken for real', () => {
  const priced = buildEvalRow({
    caseDef: caseDef({ harness: 'dispatch' }),
    decision: decision(),
    result: okResult(),
    config: { ...CONFIG, telemetry: { ...CONFIG.telemetry, primaryModel: EVAL_PRIMARY_MODEL } },
    pricingChain: evalPricedChain(),
    corpusChars: 12_000,
    now: EVAL_NOW,
    runSeed: 'test',
  })
  assert.equal(priced.pricing_version, 'eval-fixture.1')
  assert.equal(priced.worker_input_cost, (3000 * 1) / 1e6)
  assert.equal(priced.worker_total_cost_status, 'actual', 'the provider reports usage, so the worker bill is actual')
  // 2991 net tokens at the primary input rate of $10/Mtok.
  assert.equal(priced.estimated_cost_avoided, (2991 * 10) / 1e6)
  assert.equal(priced.estimated_cost_avoided_status, 'estimated', 'a counterfactual is never actual')
  assert.equal(priced.estimated_net_savings_status, 'estimated', 'and neither is the headline, in any calc_version')
})

test('the primary arm is unmeasured, and the row says so rather than leaving it blank', () => {
  const r = row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: okResult(), corpusChars: 12_000 })
  assert.equal(r.primary_usage_method, 'none')
  assert.equal(r.primary_usage_status, 'unavailable')
  for (const field of ['primary_input_tokens', 'primary_output_tokens', 'primary_total_tokens', 'primary_total_cost']) {
    assert.equal(r[field], null, `${field} must be null until a transcript reader exists`)
  }
})

test('decide() input warnings are folded into validation_codes', () => {
  const r = row({
    caseDef: caseDef(),
    decision: decision({ delegate: false, decision: 'allow', reason: 'unknown_input', taskType: 'unknown', inputWarnings: Object.freeze(['unknown_enum:taskType']) }),
    result: null,
  })
  assert.match(r.validation_codes, /unknown_enum:taskType/)
  assert.ok(r.validation_warnings >= 1)
})

/* --------------------------------------- the two mappings must not drift apart */

test('toEvalEventInputs matches the hook mapping on the single-file case', () => {
  // The eval mapping exists only to generalise filesCount/provenFilesCount/filesInferredCount,
  // which the hook hardcodes to 1/1/0. Everything else must agree, or there are two vocabularies.
  const d = decision()
  const r = okResult()
  const mine = toEvalEventInputs({ caseDef: caseDef({ harness: 'dispatch' }), decision: d, result: r, corpusChars: 12_000, inputBytes: 12_000 })
  const theirs = toEventInputs({
    decision: d,
    result: r,
    facts: { inputBytes: 12_000 },
    payload: { session_id: null, tool_use_id: 'size-at-min-bytes' },
    corpusChars: 12_000,
  })

  for (const field of [
    'taskId', 'taskType', 'routingDecision', 'routingReason', 'policyVersion', 'promptVersion',
    'taskIntentSource',
    'providerId', 'attempts', 'latencyMs', 'inputBytes', 'corpusChars',
    'filesCount', 'provenFilesCount', 'filesInferredCount',
    'returnedAnswerChars', 'returnedAnswerTokens', 'primaryUsage', 'primaryUsageMethod',
  ]) {
    assert.deepEqual(mine[field], theirs[field], `${field} disagrees between the two mappings`)
  }
})

test('a multi-file case reports its real file count, which the hook mapping cannot', () => {
  const three = caseDef({
    harness: 'dispatch',
    files: [
      { path: 'files/a.ts', source: 'generated', bytes: 6144, lines: 96 },
      { path: 'files/b.ts', source: 'generated', bytes: 5120, lines: 80 },
      { path: 'files/c.ts', source: 'generated', bytes: 4096, lines: 64 },
    ],
  })
  const inputs = toEvalEventInputs({ caseDef: three, decision: decision(), result: okResult(), corpusChars: 15_360 })
  assert.equal(inputs.filesCount, 3)
  assert.equal(inputs.provenFilesCount, 3, 'every corpus file was named by the case and verified on disk')
  assert.equal(inputs.filesInferredCount, 0)
})

test('files_count and proven_files_count are equal, so the corpus cross-check never trips', () => {
  // calculateAvoidedTokens refuses with `proven_filter_not_applied` when files > proven, which is
  // the guard against an inflated corpus — the largest over-claim risk in the model.
  const r = row({ caseDef: caseDef({ harness: 'dispatch' }), decision: decision(), result: okResult(), corpusChars: 12_000 })
  assert.equal(r.files_count, r.files_inferred_count + 1)
  assert.equal(r.count_proven_files_only, true)
  assert.notEqual(r.estimated_input_tokens, null, 'the estimate was published, so the cross-check passed')
})

test('a case naming no files reports a null count rather than a measured zero', () => {
  const inputs = toEvalEventInputs({ caseDef: caseDef({ files: [] }), decision: decision({ delegate: false, decision: 'allow', reason: 'unknown_input' }), result: null })
  assert.equal(inputs.filesCount, null, 'zero files would read as "we delegated nothing"')
  assert.equal(inputs.provenFilesCount, null)
  assert.equal(inputs.filesInferredCount, null)
})
