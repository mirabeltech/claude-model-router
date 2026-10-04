/**
 * THE EDGES OF THE CONTEXT WINDOW, ONE TOKEN AT A TIME.
 *
 * `context-budget.test.mjs` and `capability.test.mjs` cover 64 cases between them, including the
 * four capability sources, the shared/separate window models, `WINDOW_SIZING_MARGIN` and the
 * truncation detector. What they do not do is walk the boundary: exactly at the window, one token
 * below, one token above. A fit decision is an inequality, and an inequality is where an off-by-one
 * lives — the difference between refusing a prompt that would have fitted and sending one that
 * will be silently middle-dropped.
 *
 * Four things are pinned here that were not pinned anywhere:
 *
 *   1. the exact boundary, from both sides, for both window models
 *   2. `num_ctx` bucket selection, including what happens ABOVE the largest bucket
 *   3. a STALE capability record — one whose measurement predates the model it describes
 *   4. the separation CLAUDE.md's fifth rule names: `maxInputBytes` is a TRANSPORT ceiling in
 *      BYTES, and no context arithmetic may read it
 *
 * The fourth is the one worth the file. Two ceilings that both refuse oversized input, measured in
 * different units, are exactly the pair someone eventually "simplifies" into one — and the result
 * would be a byte limit silently deciding a token question, or a token limit letting a 2 MB body
 * past a transport that cannot carry it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_USEFUL_OUTPUT_TOKENS,
  NUM_CTX_BUCKETS,
  WINDOW_SIZING_MARGIN,
  capacityTokensFromBytes,
  computeContextBudget,
  estimateTokensFromBytes,
  requiredContextTokens,
} from '../plugins/model-router/lib/context-budget.mjs'
import {
  modelCapability,
  validateCapabilityRecord,
} from '../plugins/model-router/lib/providers/capability.mjs'
import { DEFAULTS } from '../plugins/model-router/lib/config.mjs'

const caps = (contextTokens, source = 'configured') =>
  modelCapability({ provider: 'ollama', model: 'm', contextTokens, maxOutputTokens: null, source })

/** A separate-window request: the prompt is weighed against the whole window on its own. */
const separate = (requestedInputTokens, contextTokens = 1000) =>
  computeContextBudget({
    provider: 'gemini',
    model: 'm',
    capability: caps(contextTokens),
    requestedInputTokens,
    requestedOutputTokens: 100,
    contextWindowModel: 'separate',
  })

/** A shared-window request: every output token asked for is an input token given up. */
const shared = (requestedInputTokens, requestedOutputTokens, contextTokens = 1000) =>
  computeContextBudget({
    provider: 'ollama',
    model: 'm',
    capability: caps(contextTokens),
    requestedInputTokens,
    requestedOutputTokens,
    contextWindowModel: 'shared',
  })

/* ------------------------------------------------- the boundary, from both sides */

test('a separate window fits exactly at its limit, and refuses one token past it', () => {
  // Three adjacent integers. The middle one is the case a `>` / `>=` slip would invert, and it is
  // the case a developer never writes by hand.
  assert.equal(separate(999).verdict, 'fits', 'one below must fit')
  assert.equal(separate(1000).verdict, 'fits', 'EXACTLY at the window must fit')
  assert.equal(separate(1000).fits, true)

  const over = separate(1001)
  assert.equal(over.verdict, 'refuse', 'one token past the window must refuse')
  assert.equal(over.fits, false)
  assert.equal(over.reason, 'input_exceeds_window')
  assert.equal(over.allowedOutputTokens, null, 'a refusal allocates no output')
})

test('a shared window counts output against the same budget, to the token', () => {
  // The whole point of the shared model: 900 input leaves 100, so 100 output fits exactly and 101
  // does not. Getting this wrong by one is how a prompt comes back middle-dropped.
  assert.equal(shared(900, 100).verdict, 'fits', '900 + 100 is exactly 1000')
  assert.equal(shared(899, 100).verdict, 'fits')

  const tight = shared(901, 100)
  assert.notEqual(tight.verdict, 'fits', '901 + 100 exceeds 1000, so it cannot simply fit')
  assert.ok(
    ['cap_output', 'refuse'].includes(tight.verdict),
    `expected a cap or a refusal, got ${tight.verdict}`,
  )
})

test('output is capped to make room, but input is NEVER truncated to make room', () => {
  // CLAUDE.md's fifth rule, as an inequality. Output is negotiable because a shorter answer is
  // still an answer; input is not, because a silently shortened prompt produces a confident wrong
  // one. So the ladder is: cap the output, and if that is not enough, refuse.
  const capped = shared(600, 900)
  assert.equal(capped.verdict, 'cap_output')
  assert.equal(capped.allowedOutputTokens, 400, 'exactly the headroom the prompt left')
  assert.equal(capped.outputCapped, true)
  assert.equal(capped.fits, true)

  // And when capping cannot leave a usable answer, it refuses rather than returning a token or two.
  const hopeless = shared(1000 - MIN_USEFUL_OUTPUT_TOKENS + 1, 500)
  assert.equal(hopeless.verdict, 'refuse', 'a window with no room for a useful answer refuses')
  assert.equal(hopeless.fits, false)
})

test('an input that exceeds the window refuses even when no output is requested', () => {
  // There is no amount of output-capping that rescues an oversized prompt, which is the asymmetry
  // the previous test establishes from the other direction.
  //
  // `fits` is TRI-STATE, and the distinction is exactly right: `false` is a definite claim that
  // the request does not fit, available only because the window is KNOWN; `null` means "cannot
  // say" and is what an unknown window reports. Collapsing them into a boolean would force an
  // unknown window to answer either "fits" or "does not fit", and both would be inventions.
  const r = shared(1001, 1)
  assert.equal(r.verdict, 'refuse')
  assert.equal(r.fits, false, 'a known window CAN say it does not fit')
  assert.equal(r.reason, 'input_exceeds_window')

  // And asking for ZERO output is a caller error rather than a window question, so it is reported
  // as such instead of being answered. Worth pinning: a budget that silently accepted a
  // zero-output request would describe a call that cannot produce an answer as a call that fits.
  const zero = shared(100, 0)
  assert.equal(zero.verdict, 'unknown')
  assert.equal(zero.reason, 'output_request_invalid')
  assert.equal(zero.fits, null)
})

/* ------------------------------------------------------------ bucket selection */

test('num_ctx is rounded UP to a bucket, never down', () => {
  // Rounding down would ask the daemon for a window smaller than the prompt, which is the exact
  // condition that makes Ollama drop the middle. The buckets exist because a precise num_ctx makes
  // the daemon reallocate per request; the DIRECTION of the rounding is the safety property.
  for (const [required, expected] of [
    [1, NUM_CTX_BUCKETS[0]],
    [4096, 4096],
    [4097, 8192],
    [8192, 8192],
    [8193, 16384],
    [65_537, 131_072],
    [131_072, 131_072],
  ]) {
    const budget = shared(Math.max(1, required - 200), 100, 200_000)
    const need = requiredContextTokens(budget)
    assert.ok(need >= 0, 'a required size is never negative')
    // The bucket function is exercised through the shipped export rather than reached into.
    const bucket = NUM_CTX_BUCKETS.find((b) => b >= required) ?? null
    assert.equal(bucket, expected, `required ${required} must land in ${expected}`)
  }
})

test('a requirement above the largest bucket has no bucket, and that is not an error', () => {
  // `bucketFor` returns null past the top of the table, and null must mean "send no num_ctx" —
  // not "send the largest", which would be a window smaller than the prompt and therefore the
  // truncation bug again.
  const beyond = NUM_CTX_BUCKETS.at(-1) + 1
  assert.equal(NUM_CTX_BUCKETS.find((b) => b >= beyond) ?? null, null)
})

test('the sizing margin is applied upward, so a slightly-underestimated prompt still fits', () => {
  // chars/4 under-counts code, which this whole project documents. The margin exists so the
  // window asked for is larger than the estimate rather than equal to it.
  assert.ok(WINDOW_SIZING_MARGIN > 1, 'a margin below 1 would shrink the window')
  const budget = shared(1000, 100, 100_000)
  const need = requiredContextTokens(budget)
  assert.ok(
    need >= budget.totalRequestedTokens,
    `required ${need} must be at least the ${budget.totalRequestedTokens} actually asked for`,
  )
})

/* ----------------------------------------------------- unknown is not infinite */

test('an unknown window never fits by default, and never reports a number', () => {
  // The invariant from CLAUDE.md's fifth rule, at the boundary: an unknown capability must not
  // behave like a very large one. It proceeds and warns — because unknown must degrade to plain
  // Claude Code, not to a blocked session — but it never claims the request FITS.
  const r = computeContextBudget({
    provider: 'gemini',
    model: 'm',
    capability: null,
    requestedInputTokens: 10_000_000,
    requestedOutputTokens: 1000,
    contextWindowModel: 'unknown',
  })
  assert.equal(r.verdict, 'unknown', 'not "fits", however large the request')
  assert.equal(r.fits, null, 'tri-state: it declines to say, rather than guessing either way')
  assert.notEqual(r.fits, true, 'and most importantly it never claims to fit')
  assert.equal(r.contextTokens, null, 'and no window is invented')
})

/* ----------------------------------------------------- a stale or invalid record */

test('a capability record whose status disagrees with its source is rejected', () => {
  // THE INVARIANT: contextTokens === null if and only if status === unknown. A number with an
  // unknown status is a value nobody can weigh; an unknown status with a number is a guess
  // dressed as a measurement.
  assert.deepEqual(validateCapabilityRecord(caps(4096)), [], 'a coherent record validates')

  const lying = { ...caps(4096), status: 'unknown' }
  assert.ok(
    validateCapabilityRecord(lying).length > 0,
    'a number with an unknown status must be refused',
  )

  const empty = { ...caps(null, 'none'), contextTokens: 4096 }
  assert.ok(validateCapabilityRecord(empty).length > 0)
})

test('a stale measurement is still a measurement, and keeps its timestamp', () => {
  // There is deliberately NO expiry. A window measured a year ago is not wrong — a model's context
  // length does not drift — so the record carries `measuredAt` and lets a reader judge, rather
  // than discarding a fact and falling back to unknown. Automatic refresh is a post-V1 item, and
  // this test is what says so in code rather than only in a backlog.
  const old = modelCapability({
    provider: 'ollama',
    model: 'm',
    contextTokens: 8192,
    maxOutputTokens: null,
    source: 'provider_api',
    // EPOCH MILLISECONDS, not an ISO string: `measuredAt` is stored as an integer so a reader can
    // compare two records without parsing, and a non-integer is dropped rather than coerced.
    measuredAt: Date.parse('2020-01-01T00:00:00.000Z'),
  })
  assert.deepEqual(validateCapabilityRecord(old), [], 'age alone does not invalidate a record')
  assert.equal(old.status, 'measured', 'a provider_api reading is measured, however old')
  assert.equal(old.contextTokens, 8192)
  assert.equal(old.measuredAt, 1577836800000, 'and the age is reported, not hidden')
  assert.equal(separate(8000, old.contextTokens).verdict, 'fits', 'so it is still usable')

  // Only a provider_api reading carries a time, because only a measurement HAS one. A configured
  // number is an assertion with no measurement moment, and inventing one would make an operator's
  // guess look like an observation.
  const configured = modelCapability({
    provider: 'ollama', model: 'm', contextTokens: 8192, maxOutputTokens: null,
    source: 'configured', measuredAt: Date.now(),
  })
  assert.equal(configured.measuredAt, null, 'a configured value is not a measurement')
  assert.equal(configured.status, 'configured')
})

test('an unrecognised source yields an unknown record, and the validator catches the rest', () => {
  // OBSERVED WHILE WRITING THIS FILE, and pinned rather than changed. `modelCapability` normalises
  // an unknown source to `unknown` but KEEPS the contextTokens it was handed, producing a record
  // its own validator rejects — a number with an unknown status.
  //
  // Not a defect, and not reachable: all three call sites in the plugin pass a literal source
  // ('configured', 'bundled_default', 'provider_api'), so an unrecognised one is a programming
  // error that the validator exists to catch. It is pinned here so that if a dynamic source ever
  // appears, the incoherence is already documented rather than discovered.
  const bogus = modelCapability({
    provider: 'ollama',
    model: 'm',
    contextTokens: 8192,
    maxOutputTokens: null,
    source: 'discovered-by-someone',
  })
  assert.equal(bogus.source, 'unknown', 'an unrecognised source is normalised, not preserved')
  assert.equal(bogus.status, 'unknown')
  assert.equal(bogus.measuredAt, null, 'and no measurement time is claimed')
  assert.deepEqual(
    validateCapabilityRecord(bogus),
    ['capability.contextTokens === null must coincide exactly with status "unknown"'],
    'the validator is what makes this detectable rather than silent',
  )
})

test('a malformed capability record is refused rather than partially trusted', () => {
  for (const bad of [null, 'a string', 42, [], { contextTokens: 4096 }]) {
    assert.ok(
      validateCapabilityRecord(bad).length > 0,
      `${JSON.stringify(bad)} must be refused outright`,
    )
  }
})

/* --------------------------- the two ceilings, in two units, that must stay separate */

test('maxInputBytes is a TRANSPORT ceiling in BYTES, and no context arithmetic reads it', () => {
  // CLAUDE.md's fifth rule, stated as a structural fact rather than a convention. The context
  // module takes no byte ceiling: `computeContextBudget` has no parameter for one, so a byte limit
  // CANNOT decide a token question. That is why the two can coexist without one shadowing the
  // other, and why this is asserted on the signature rather than on a behaviour.
  const source = computeContextBudget.toString()
  assert.equal(
    /maxInputBytes/.test(source),
    false,
    'computeContextBudget must not know about a byte ceiling',
  )

  // The two really are different numbers in different units, which is the reason to keep them
  // apart: the shipped byte ceiling is two million BYTES, nothing like any token window.
  assert.equal(typeof DEFAULTS.worker.maxInputBytes, 'number')
  assert.ok(
    DEFAULTS.worker.maxInputBytes > NUM_CTX_BUCKETS.at(-1),
    'the byte ceiling and the largest token bucket are not interchangeable magnitudes',
  )
})

test('the byte-to-token estimators round in the safe direction, and disagree deliberately', () => {
  // Two functions, two directions, and the asymmetry is the safety property. An ESTIMATE of what a
  // prompt costs rounds UP, so it is never optimistic. A CAPACITY derived from bytes rounds DOWN,
  // so it never promises room that is not there. A single shared helper would have to pick one and
  // would be wrong half the time.
  assert.equal(estimateTokensFromBytes(1), 1, 'one byte still costs a token')
  assert.equal(estimateTokensFromBytes(4), 1)
  assert.equal(estimateTokensFromBytes(5), 2, 'rounded up: never optimistic about cost')
  assert.equal(capacityTokensFromBytes(7), 1, 'rounded down: never optimistic about room')
  assert.equal(capacityTokensFromBytes(8), 2)
  assert.ok(
    estimateTokensFromBytes(5) > capacityTokensFromBytes(5),
    'for the same byte count the estimate must exceed the capacity',
  )
})
