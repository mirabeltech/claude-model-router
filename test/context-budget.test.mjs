/**
 * Context budget math.
 *
 * The arithmetic is trivial; what is worth testing is the NULL DISCIPLINE around it. Three rules
 * carry the whole file:
 *
 *   1. unknown is not `fits`, and it is not `false` either — `fits` is tri-state
 *   2. a request rounds UP and a capacity rounds DOWN, in opposite directions, on purpose
 *   3. input is never traded away; only output is
 *
 * The divisor is pinned against telemetry/calc.mjs rather than shared with it, because the two
 * round opposite ways and one function cannot be correct for both.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUDGET_REASONS,
  BUDGET_VERDICTS,
  MIN_USEFUL_OUTPUT_TOKENS,
  NUM_CTX_BUCKETS,
  WINDOW_SIZING_MARGIN,
  TOKEN_BYTES_PER_TOKEN,
  TRUNCATION_TOLERANCE_FRACTION,
  TRUNCATION_TOLERANCE_TOKENS,
  capacityTokensFromBytes,
  computeContextBudget,
  detectSilentTruncation,
  estimateTokensFromBytes,
  requiredContextTokens,
} from '../plugins/model-router/lib/context-budget.mjs'
import { calculateAvoidedTokens } from '../plugins/model-router/lib/telemetry/calc.mjs'
import { modelCapability, unknownCapability } from '../plugins/model-router/lib/providers/capability.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = path.join(HERE, '..', 'plugins', 'model-router', 'lib', 'context-budget.mjs')

const cap = (contextTokens, source = 'provider_api') =>
  modelCapability({ provider: 'ollama', model: 'm', contextTokens, source, measuredAt: 1 })

const budget = (over = {}) =>
  computeContextBudget({
    capability: cap(8192),
    requestedInputTokens: 4000,
    requestedOutputTokens: 512,
    contextWindowModel: 'shared',
    ...over,
  })

/* ------------------------------------------------------------------- purity */

test('the module imports nothing at all, so it is reachable from any layer', () => {
  // The claim that this can sit beside config.mjs and routing.mjs as a third pure module is only
  // as good as this check. Not even the capability enums are imported: the module needs one fact
  // about a record (`contextTokens === null`) and buying type safety it cannot enforce anyway
  // would cost it the isolation.
  const src = fs.readFileSync(MODULE, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/^\s*import\s/m.test(stripped), false, 'context-budget.mjs must import nothing')
  assert.equal(/\bimport\s*\(/.test(stripped), false, 'no dynamic import either')
  assert.equal(/\brequire\s*\(/.test(stripped), false, 'no require')
})

test('it reads no clock and no randomness, so a budget is a function of its inputs', () => {
  const src = fs.readFileSync(MODULE, 'utf8')
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/Date\.now|new Date|Math\.random|process\./.test(stripped), false)
})

test('the same input yields a byte-identical budget every time', () => {
  const first = JSON.stringify(budget())
  for (let i = 0; i < 50; i += 1) assert.equal(JSON.stringify(budget()), first, `drifted on run ${i}`)
})

test('the returned record and its warnings are frozen', () => {
  const b = budget()
  assert.ok(Object.isFrozen(b))
  assert.ok(Object.isFrozen(b.warnings))
})

/* -------------------------------------------------------- token estimation */

test('a request rounds UP and a capacity rounds DOWN — the asymmetry is the point', () => {
  // Never understate a prompt; never overstate the room. Same divisor, opposite directions.
  assert.equal(estimateTokensFromBytes(4001), 1001)
  assert.equal(capacityTokensFromBytes(4001), 1000)
  assert.equal(estimateTokensFromBytes(4000), 1000)
  assert.equal(capacityTokensFromBytes(4000), 1000)
})

test('the divisor matches telemetry/calc.mjs exactly, so the two cannot drift apart', () => {
  // Duplicated rather than imported BECAUSE the rounding differs — calc.mjs floors to keep a
  // savings figure a floor. This test is what makes the duplication safe.
  assert.equal(TOKEN_BYTES_PER_TOKEN, 4)
  for (const n of [0, 4, 400, 12_000, 51_200, 1_000_000]) {
    const mine = estimateTokensFromBytes(n)
    const theirs = calculateAvoidedTokens({ chars: n, countProvenFilesOnly: false }).value
    assert.equal(mine, theirs, `${n} bytes: ${mine} here, ${theirs} in calc.mjs`)
  }
})

test('a non-count is null rather than zero', () => {
  for (const bad of [null, undefined, -1, 1.5, '4000', NaN, Infinity, {}]) {
    assert.equal(estimateTokensFromBytes(bad), null, `${JSON.stringify(bad)} estimated to a number`)
    assert.equal(capacityTokensFromBytes(bad), null)
  }
  assert.equal(estimateTokensFromBytes(0), 0, 'zero bytes is a real measurement')
})

/* ------------------------------------------------------------ the verdicts */

test('every verdict and reason the module can emit is in its declared vocabulary', () => {
  const seen = new Set()
  const reasons = new Set()
  const cases = [
    budget(),
    budget({ requestedInputTokens: 7000, requestedOutputTokens: 8192 }),
    budget({ requestedInputTokens: 8100 }),
    budget({ requestedInputTokens: 99_999 }),
    budget({ capability: null }),
    budget({ capability: { contextTokens: 0, source: 'provider_api', status: 'measured' } }),
    budget({ requestedInputTokens: null }),
    budget({ requestedOutputTokens: 0 }),
    budget({ capability: cap(1_000_000), contextWindowModel: 'separate', providerMaxOutputTokens: 256 }),
  ]
  for (const b of cases) {
    seen.add(b.verdict)
    reasons.add(b.reason)
    assert.ok(BUDGET_VERDICTS.includes(b.verdict), `${b.verdict} is not a declared verdict`)
    assert.ok(BUDGET_REASONS.includes(b.reason), `${b.reason} is not a declared reason`)
  }
  // The completeness check that catches a branch written and then shadowed by an earlier one.
  assert.deepEqual([...seen].sort(), [...BUDGET_VERDICTS].sort())
  assert.deepEqual([...reasons].sort(), [...BUDGET_REASONS].sort())
})

test('a request that fits is sent unchanged', () => {
  const b = budget()
  assert.equal(b.verdict, 'fits')
  assert.equal(b.reason, 'within_window')
  assert.equal(b.fits, true)
  assert.equal(b.allowedOutputTokens, 512)
  assert.equal(b.outputCapped, false)
  assert.equal(b.effectiveInputCapacityTokens, 7680)
  assert.equal(b.totalRequestedTokens, 4512)
})

test('an exact fit fits — the boundary is inclusive', () => {
  // 7680 + 512 === 8192. An off-by-one here would refuse a request that is precisely legal.
  const b = budget({ requestedInputTokens: 7680 })
  assert.equal(b.verdict, 'fits')
  const over = budget({ requestedInputTokens: 7681 })
  assert.notEqual(over.verdict, 'fits')
})

test('output is reduced to the headroom when the prompt needs the room back', () => {
  const b = budget({ requestedInputTokens: 7000, requestedOutputTokens: 8192 })
  assert.equal(b.verdict, 'cap_output')
  assert.equal(b.reason, 'output_capped_to_fit')
  assert.equal(b.allowedOutputTokens, 1192)
  assert.equal(b.outputCapped, true)
  assert.ok(b.warnings.includes('output_reduced'))
  // The identity that makes the reported capacity meaningful on a path that is about to succeed.
  assert.equal(b.effectiveInputCapacityTokens + b.allowedOutputTokens, b.contextTokens)
})

test('a window that cannot leave room to answer in is refused, not capped to a token', () => {
  // 8192 - 8100 = 92 tokens of headroom. Capping a summary to 92 tokens is a silent failure
  // dressed as a success, so it refuses instead.
  const b = budget({ requestedInputTokens: 8100 })
  assert.equal(b.verdict, 'refuse')
  assert.equal(b.reason, 'output_floor_unreachable')
  assert.equal(b.fits, false)
  assert.equal(b.allowedOutputTokens, null)
  assert.ok(MIN_USEFUL_OUTPUT_TOKENS > 92)
})

test('input alone over the window is refused, and the reason says which problem it is', () => {
  // A different reason from the one above, because it has a different fix: send less, versus
  // choose a model with a bigger window.
  const b = budget({ requestedInputTokens: 99_999 })
  assert.equal(b.verdict, 'refuse')
  assert.equal(b.reason, 'input_exceeds_window')
})

test('input is NEVER traded away — no verdict reduces the input', () => {
  // The rule the whole phase exists to enforce. There is no field for a reduced input, and no
  // branch may invent one.
  for (const inputTokens of [100, 4000, 7680, 8100, 12_800, 99_999]) {
    const b = budget({ requestedInputTokens: inputTokens })
    assert.equal(b.requestedInputTokens, inputTokens, 'the requested input was rewritten')
    assert.equal('allowedInputTokens' in b, false, 'a truncated-input field appeared')
  }
})

/* -------------------------------------------------------------- unknown */

test('an unknown capability is unknown, never infinite and never a fit', () => {
  for (const capability of [null, unknownCapability({ provider: 'ollama' }), { contextTokens: null }]) {
    const b = budget({ capability })
    assert.equal(b.verdict, 'unknown')
    assert.equal(b.reason, 'capability_unknown')
    // Tri-state. `false` would mean "measured, and it does not fit", which is a different claim.
    assert.equal(b.fits, null)
    assert.equal(b.contextTokens, null)
    assert.equal(b.effectiveInputCapacityTokens, null)
    assert.equal(b.allowedOutputTokens, null)
  }
})

test('a nonpositive window is invalid rather than enormous', () => {
  // FORGED records, deliberately. modelCapability() already degrades a nonpositive window to
  // `unknown`, so a record built through the constructors can never reach this branch — which is
  // the right layering and also means the branch is defence against an UNVALIDATED record. This
  // module takes a plain object, and a third-party describeModel() is not a promise, so the guard
  // earns its place; reaching it just requires bypassing the constructor the way such a provider
  // would.
  for (const n of [0, -1, -8192]) {
    const b = budget({ capability: { contextTokens: n, source: 'provider_api', status: 'measured' } })
    assert.equal(b.verdict, 'unknown')
    assert.equal(b.reason, 'capability_invalid')
    assert.ok(b.warnings.includes('capability_nonpositive'))
  }
})

test('the constructors make that branch unreachable, which is why it is only defence', () => {
  // The companion to the test above: through the sanctioned path, a nonpositive window is simply
  // unknown long before the budget sees it.
  for (const n of [0, -1]) {
    assert.equal(cap(n).contextTokens, null)
    assert.equal(budget({ capability: cap(n) }).reason, 'capability_unknown')
  }
})

test('an unmeasured prompt size or output request is unknown, not assumed', () => {
  for (const bad of [null, undefined, -1, 1.5, '4000']) {
    assert.equal(budget({ requestedInputTokens: bad }).reason, 'input_size_unknown')
  }
  for (const bad of [null, undefined, 0, -1, 1.5, '512']) {
    assert.equal(budget({ requestedOutputTokens: bad }).reason, 'output_request_invalid')
  }
})

test('the ladder order is fixed: an unusable input is reported before an unusable window', () => {
  // Two problems at once must yield the EARLIER reason, so a reader can read the rules top to
  // bottom and stop at the first match.
  const b = computeContextBudget({ capability: null, requestedInputTokens: null, requestedOutputTokens: null })
  assert.equal(b.reason, 'input_size_unknown')
})

test('an unspecified window model resolves pessimistically to shared', () => {
  // Assuming independent input and output limits would promise capacity a shared window has not
  // got, so the unknown case takes the formula that can only ever refuse more.
  for (const windowModel of [undefined, 'unknown', 'nonsense']) {
    const b = budget({ contextWindowModel: windowModel })
    assert.equal(b.contextWindowModel, 'shared')
    assert.ok(b.warnings.includes('window_model_assumed_shared'))
    assert.equal(b.effectiveInputCapacityTokens, 7680, 'output was not taken out of the window')
  }
})

/* ------------------------------------------------------------- separate windows */

test('a separate window measures the prompt against the whole context', () => {
  const b = budget({ capability: cap(1_000_000), requestedInputTokens: 500_000, requestedOutputTokens: 8192, contextWindowModel: 'separate' })
  assert.equal(b.verdict, 'fits')
  assert.equal(b.effectiveInputCapacityTokens, 1_000_000, 'output was wrongly deducted')
  assert.equal(b.allowedOutputTokens, 8192)
})

test("a separate provider's own output ceiling caps output without touching the prompt", () => {
  const b = budget({ capability: cap(1_000_000), requestedInputTokens: 5000, requestedOutputTokens: 8192, contextWindowModel: 'separate', providerMaxOutputTokens: 4096 })
  assert.equal(b.verdict, 'cap_output')
  assert.equal(b.reason, 'output_capped_to_limit')
  assert.equal(b.allowedOutputTokens, 4096)
})

/* ------------------------------------------------------- requiredContextTokens */

test('the window asked for is a coarse bucket, never the model maximum', () => {
  // Asking for the maximum would make a daemon allocate a 128k KV cache for a 4k prompt.
  const b = budget({ capability: cap(131_072), requestedInputTokens: 4000, requestedOutputTokens: 512 })
  assert.equal(requiredContextTokens(b), 8192)
  assert.ok(NUM_CTX_BUCKETS.includes(requiredContextTokens(b)))
  assert.ok(requiredContextTokens(b) < b.contextTokens)
})

test('the buckets are coarse because a CHANGED window costs a model reload', () => {
  // MEASURED against the live daemon: re-requesting the same window costs 1.0s with
  // load_duration 0.0s, while changing it costs 11.0s of which 8.5s is pure model load. The hook
  // that calls all this has a 20-second budget, so a reallocation triggered by nothing more than
  // the next file being a kilobyte larger can abort the delegation outright.
  //
  // The claim is COMPARATIVE, because it has to be: a bucket boundary still falls somewhere, and
  // requests either side of one do get different windows. What matters is how many allocations a
  // spread of realistic file sizes provokes.
  const sizes = [800, 1900, 3100, 3600, 3850, 4100, 5200, 6400, 7600]
  const asked = sizes.map((t) =>
    requiredContextTokens(budget({ capability: cap(8192), requestedInputTokens: t, requestedOutputTokens: 512 })),
  )
  const buckets = new Set(asked)
  const fineGrained = new Set(sizes.map((t) => Math.min(8192, Math.ceil((t + 512) / 1024) * 1024)))

  assert.ok(
    buckets.size < fineGrained.size,
    `buckets must provoke fewer allocations: ${buckets.size} vs ${fineGrained.size} for 1024-rounding`,
  )
  assert.ok(buckets.size <= 2, `nine file sizes should share at most two windows, got ${[...buckets]}`)
  for (const w of buckets) assert.ok(NUM_CTX_BUCKETS.includes(w) || w === 8192)
})

test('every bucket is a sane window, ascending, and the first one is usable', () => {
  assert.ok(NUM_CTX_BUCKETS.length >= 2)
  for (let i = 1; i < NUM_CTX_BUCKETS.length; i += 1) {
    assert.ok(NUM_CTX_BUCKETS[i] > NUM_CTX_BUCKETS[i - 1], 'buckets must ascend')
  }
  assert.ok(NUM_CTX_BUCKETS[0] >= MIN_USEFUL_OUTPUT_TOKENS * 2, 'the smallest bucket must hold a prompt and an answer')
})

test('the requested window covers the REAL prompt, not our under-count of it', () => {
  // THE REGRESSION. This exact case shipped broken and a live run caught it: a prompt estimated
  // at 3,301 tokens was really 4,265, so `bucket(3301 + 512)` asked for a 4096-token window and
  // Ollama silently truncated the prompt to fit it. `chars/4` under-counts code, so a window
  // sized from the estimate can be smaller than the prompt it has to hold.
  const estimated = 3301
  const real = 4265 // measured, for this corpus case
  const output = 512

  const b = budget({ capability: cap(8192), requestedInputTokens: estimated, requestedOutputTokens: output })
  const asked = requiredContextTokens(b)

  assert.ok(
    asked >= real + output,
    `asked for ${asked} tokens of window for a ${real}-token prompt plus ${output} of output`,
  )
  // And the margin is what makes that true, not luck: the un-marked-up need would have fit a
  // smaller bucket.
  assert.ok(WINDOW_SIZING_MARGIN > 1, 'the estimate must be marked up when sizing a window')
  assert.ok(estimated * WINDOW_SIZING_MARGIN >= real, 'the margin must cover the observed bias')
})

test('the margin is applied to the input estimate only, never to the output request', () => {
  // We chose the output number and know it exactly. The input is a lower bound on a count we
  // cannot see until the response comes back, which is the only reason either needs a margin.
  const b = budget({ capability: cap(131_072), requestedInputTokens: 1000, requestedOutputTokens: 512 })
  assert.equal(b.allowedOutputTokens, 512, 'the output request must not be inflated')
  assert.equal(b.requestedInputTokens, 1000, 'the recorded estimate must stay the estimate')
  // Only the WINDOW asked for carries the margin.
  assert.ok(requiredContextTokens(b) >= Math.ceil(1000 * WINDOW_SIZING_MARGIN) + 512)
})

test('marking up the window never asks for more than the model has', () => {
  for (const [ctx, inTok] of [[8192, 7600], [4096, 3000], [2048, 1000]]) {
    const b = budget({ capability: cap(ctx), requestedInputTokens: inTok, requestedOutputTokens: 256 })
    if (b.verdict === 'refuse' || b.verdict === 'unknown') continue
    assert.ok(requiredContextTokens(b) <= ctx, `asked for more than the ${ctx}-token window`)
  }
})

test('a request past the largest bucket falls back to the model window, not to null', () => {
  // A 200k-token prompt on a 1M-token model: no bucket holds it, but the model does.
  const b = budget({ capability: cap(1_000_000), requestedInputTokens: 200_000, requestedOutputTokens: 512 })
  assert.equal(b.verdict, 'fits')
  assert.equal(requiredContextTokens(b), 1_000_000)
})

test('the window asked for never exceeds what the model has', () => {
  const b = budget({ requestedInputTokens: 7000, requestedOutputTokens: 8192 })
  assert.equal(requiredContextTokens(b), 8192)
  assert.ok(requiredContextTokens(b) <= b.contextTokens)

  // Also true when the model's window is below the smallest bucket.
  const tiny = budget({ capability: cap(3000), requestedInputTokens: 1000, requestedOutputTokens: 512 })
  assert.ok(requiredContextTokens(tiny) <= 3000)
})

test('there is nothing to ask for when the verdict is unknown or refuse', () => {
  assert.equal(requiredContextTokens(budget({ capability: null })), null)
  assert.equal(requiredContextTokens(budget({ requestedInputTokens: 99_999 })), null)
  assert.equal(requiredContextTokens(null), null)
  assert.equal(requiredContextTokens(undefined), null)
})

/* ------------------------------------------------------ truncation detection */

test('the measured Ollama failure is detected', () => {
  // The actual numbers from the live probe: an estimated 4342-token prompt served as 2060.
  const t = detectSilentTruncation({
    budget: { requestedInputTokens: 4342 },
    usage: { inputTokens: 2060 },
    capabilities: { silentInputTruncation: true },
  })
  assert.equal(t.truncated, true)
  assert.equal(t.reason, 'prompt_shortfall')
  assert.equal(t.shortfallTokens, 2282)
  assert.ok(t.shortfallTokens > t.toleranceTokens)
})

test('a healthy call is quiet, because chars/4 under-counts code', () => {
  // On an untruncated call the observed count normally comes back HIGHER than the estimate, so a
  // shortfall is a signal rather than a rounding artefact. Measured: 4108 observed vs ~4100.
  const t = detectSilentTruncation({
    budget: { requestedInputTokens: 4100 },
    usage: { inputTokens: 4108 },
    capabilities: { silentInputTruncation: true },
  })
  assert.equal(t.truncated, false)
  assert.equal(t.reason, 'prompt_count_consistent')
  assert.ok(t.shortfallTokens < 0)
})

test('a shortfall inside the tolerance is not called truncation', () => {
  const estimated = 10_000
  const tolerance = Math.max(TRUNCATION_TOLERANCE_TOKENS, Math.ceil(estimated * TRUNCATION_TOLERANCE_FRACTION))
  const caps = { silentInputTruncation: true }
  const at = detectSilentTruncation({ budget: { requestedInputTokens: estimated }, usage: { inputTokens: estimated - tolerance }, capabilities: caps })
  assert.equal(at.truncated, false, 'exactly at the tolerance must not trip')
  const over = detectSilentTruncation({ budget: { requestedInputTokens: estimated }, usage: { inputTokens: estimated - tolerance - 1 }, capabilities: caps })
  assert.equal(over.truncated, true)
})

test('an unmeasured call is null, never a reassuring false, and says WHICH half is missing', () => {
  // The `reason` assertions are the point of this test, not decoration. Without them these three
  // cases were indistinguishable from each other: all that was checked was `truncated === null`,
  // so swapping `prompt_count_missing` and `estimate_unknown` in the product code would have
  // failed nothing. Two unknowns with one name is one unknown, and the two are not the same
  // problem — a missing prompt count means the provider did not report, while a missing estimate
  // means we never computed a budget for this call at all.
  const caps = { silentInputTruncation: true }

  const noCount = detectSilentTruncation({ budget: { requestedInputTokens: 100 }, usage: { inputTokens: null }, capabilities: caps })
  assert.equal(noCount.truncated, null)
  assert.equal(noCount.reason, 'prompt_count_missing')
  assert.equal(noCount.estimatedPromptTokens, 100, 'the half we DO have is still reported')
  assert.equal(noCount.observedPromptTokens, null)

  const noUsage = detectSilentTruncation({ budget: { requestedInputTokens: 100 }, usage: null, capabilities: caps })
  assert.equal(noUsage.truncated, null)
  assert.equal(noUsage.reason, 'prompt_count_missing', 'no usage object at all is the same gap')

  const noEstimate = detectSilentTruncation({ budget: null, usage: { inputTokens: 100 }, capabilities: caps })
  assert.equal(noEstimate.truncated, null)
  assert.equal(noEstimate.reason, 'estimate_unknown')
  assert.equal(noEstimate.estimatedPromptTokens, null)
  assert.equal(noEstimate.observedPromptTokens, 100)

  // Checked in the order the function checks them: a call missing BOTH halves reports the count,
  // because without an observation there is nothing to compare an estimate against anyway.
  assert.equal(detectSilentTruncation({ budget: null, usage: null, capabilities: caps }).reason, 'prompt_count_missing')

  const impossible = detectSilentTruncation({})
  assert.equal(impossible.truncated, false, 'no capability to truncate => not possible')
  assert.equal(impossible.reason, 'not_possible', 'and that false is a reading, not an absence')
})

test('a provider that errors on overflow cannot have truncated silently', () => {
  // `false` here is a real reading, not an absence: the condition is structurally impossible.
  const t = detectSilentTruncation({
    budget: { requestedInputTokens: 10_000 },
    usage: { inputTokens: 1 },
    capabilities: { silentInputTruncation: false },
  })
  assert.equal(t.truncated, false)
  assert.equal(t.reason, 'not_possible')
})
