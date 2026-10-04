/**
 * The threshold sweep, and the selection bias it must not have.
 *
 * THE BUG THIS FILE EXISTS TO PREVENT. The obvious sweep runs the worker once per case and then,
 * per threshold, FILTERS to the rows that delegated. The denominator shrinks as the threshold
 * rises, so avoided-tokens-per-delegation climbs monotonically and the table reads as "higher is
 * better" — an endorsement manufactured out of nothing but selection bias. Worse, it would look
 * entirely reasonable in review.
 *
 * So `rowsTotal` is asserted CONSTANT across every threshold. A case that does not delegate is
 * present as a row contributing null, which is what it actually is. Coverage falls; the per-row
 * figure does not inflate.
 *
 * The other half is the absence of a recommendation. A sweep that names a best threshold is the
 * threshold optimisation CLAUDE.md #6 forbids, so this file asserts the module exports no argmax —
 * the ABSENCE OF THE FUNCTION is the enforcement, because a comment saying "do not add one" is not.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as sweepModule from './evals/sweep.mjs'
import { DEFAULT_THRESHOLDS, renderSweep, sweep } from './evals/sweep.mjs'
import { EVAL_NOW } from './evals/determinism.mjs'
import { EVAL_CHAIN_BUNDLED, evalPricedChain } from './evals/pricing.mjs'
import { evalConfig } from './evals/config.mjs'
import { loadCorpus } from './evals/load.mjs'
import { toRoutingInputForCase } from './evals/routing.mjs'
import { DEFAULTS } from '../plugins/model-router/lib/config.mjs'

let scratch
let cached
let verdicts

const workerResult = (text) =>
  Object.freeze({
    ok: true, executed: true, status: 'ok', reason: 'completed', mode: 'bulk-reader', lane: 'bulkRead',
    provider: 'mock', model: 'mock-1', modelRequested: 'mock-1', text,
    usage: Object.freeze({ inputTokens: 3000, cachedInputTokens: 0, outputTokens: 10, thinkingTokens: 0, totalTokens: 3010, source: 'provider_reported' }),
    capabilities: Object.freeze({ maxInputBytes: 64_000, supportsSystemPrompt: true, reportsUsage: true, requiresEnv: [], reportsThinkingTokens: true, supportsCachedInput: true }),
    attempts: 1, latencyMs: 20, providerLatencyMs: 18, truncated: false, finishReason: 'stop',
    error: null, promptVersion: 1, policyVersion: 1, warnings: Object.freeze([]),
  })

test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-sweep-'))
  const corpus = loadCorpus({ scratchDir: scratch })
  assert.deepEqual(corpus.errors, [])

  // The worker ran ONCE per case, which is the valid half of the caching idea: its output does not
  // depend on minBytes.
  cached = corpus.cases
    .filter((c) => c.harness !== 'hook')
    .map((caseDef) => ({
      caseDef,
      routingInput: toRoutingInputForCase({
        caseDef,
        absPaths: corpus.absPaths.get(caseDef.id),
        projectDir: scratch,
      }),
      result: caseDef.harness === 'dispatch' ? workerResult('a summary of this file.') : null,
      corpusChars: caseDef.harness === 'dispatch' ? caseDef.files.reduce((s, f) => s + f.bytes, 0) : null,
      inputBytes: caseDef.files.reduce((s, f) => s + f.bytes, 0) || null,
      projectDir: scratch,
    }))

  verdicts = new Map(cached.filter((c) => c.result !== null).map((c) => [c.caseDef.id, 'pass']))
})

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const run = (thresholds = DEFAULT_THRESHOLDS, chain = EVAL_CHAIN_BUNDLED) =>
  sweep({ cached, thresholds, verdicts, pricingChain: chain, now: EVAL_NOW, runSeed: 'sweep-test' })

/* ----------------------------------------------- the denominator never shrinks */

test('rowsTotal is the full case set at every threshold, so coverage moves and the figure does not inflate', () => {
  const table = run()
  const totals = new Set(table.thresholds.map((p) => p.rowsTotal))
  assert.equal(totals.size, 1, `rowsTotal varied across thresholds: ${[...totals].join(', ')}`)
  assert.equal([...totals][0], cached.length, 'every case must be present at every threshold')
})

test('a rising threshold lowers the delegated count, not the per-row figure', () => {
  const table = run([1024, 24576, 51200])
  const counts = table.thresholds.map((p) => p.delegatedCount)
  assert.ok(counts[0] > counts[counts.length - 1], `delegation should fall as the floor rises: ${counts.join(' -> ')}`)
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] <= counts[i - 1], `delegation rose from ${counts[i - 1]} to ${counts[i]}`)
  }
})

test('coverage falls with the delegated count, which is what makes the table unreadable as an endorsement', () => {
  const table = run([1024, 51200])
  const low = table.thresholds[0].tokensAvoided
  const high = table.thresholds[1].tokensAvoided
  assert.equal(low.rowsTotal, high.rowsTotal, 'same denominator')
  assert.ok(high.rowsCounted <= low.rowsCounted, 'fewer rows contribute at the higher floor')
  assert.ok(high.rowsUnavailable >= low.rowsUnavailable, 'and more are unmeasured')
})

test('the delegated and retained lists partition the corpus exactly', () => {
  for (const p of run().thresholds) {
    assert.equal(p.delegatedCount + p.retainedCount, p.rowsTotal, `${p.minBytes} loses or double-counts a case`)
    assert.equal(p.delegated.length, p.delegatedCount)
    assert.equal(new Set([...p.delegated, ...p.retained]).size, p.rowsTotal, 'no case may appear in both')
  }
})

/* --------------------------------------------- the boundary is actually measured */

test('the three thresholds around minBytes discriminate, which is why they are the ones chosen', () => {
  // 11999 / 12000 / 12001 is where the corpus is built to be sensitive. The brief's 1/4/8 KB points
  // are dropped because no rule sits between them: they would produce identical rows and imply a
  // resolution the measurement does not have.
  const table = run([11999, 12000, 12001])
  const [below, at, above] = table.thresholds.map((p) => p.delegatedCount)
  assert.ok(below > at, `11999 should delegate more than 12000: ${below} vs ${at}`)
  assert.ok(at > above, `12000 should delegate more than 12001: ${at} vs ${above}`)
})

test('the default thresholds bracket the shipped minBytes from both sides', () => {
  const shipped = DEFAULTS.routing.bulkRead.minBytes
  assert.ok(DEFAULT_THRESHOLDS.includes(shipped), `the shipped ${shipped} must be a sweep point`)
  assert.ok(DEFAULT_THRESHOLDS.some((t) => t < shipped), 'and at least one point below it')
  assert.ok(DEFAULT_THRESHOLDS.some((t) => t > shipped), 'and at least one above')
})

/* ------------------------------------------------- quality tracks delegation */

test('a verdict only counts at a threshold where the case actually delegated', () => {
  // The worker ran once, but at a threshold that retains the case on the primary model NO ANSWER
  // WOULD EXIST. Carrying the verdict forward would credit a quality pass to a delegation that
  // never happened — and the rate would read identically at every threshold, which is the kind of
  // number that cannot be wrong and therefore says nothing.
  const table = run([1024, 51200])
  const low = table.thresholds[0].quality
  const high = table.thresholds[1].quality
  assert.ok(high.graded < low.graded, `graded should fall with delegation: ${low.graded} -> ${high.graded}`)
  assert.equal(low.total, high.total, 'while the total stays the whole corpus')
})

test('a minBytes sweep cannot starve the gate, because minLines is an independent OR branch', () => {
  // A FINDING, not a quirk, and it is the sweep's most useful output. `thresholdMet` ORs its three
  // size signals, so a file that already clears `minLines` (350) delegates at ANY minBytes — even
  // an absurd five megabytes. Anyone reading a minBytes sweep and concluding "a high floor stops
  // delegation" would be wrong, and this is where that is written down. Tuning minBytes alone has
  // a floor it cannot go below.
  //
  // The expectation is DERIVED from the corpus rather than written as a count. A hardcoded number
  // is a census, and a census fails whenever a case is added for an unrelated reason — which says
  // nothing about whether the property still holds. Deriving it asserts the property in both
  // directions: every case that clears minLines delegates, and nothing else does.
  // Clearing minLines satisfies the SIZE question and nothing else. A case refused for a reason
  // that is not about size — a targeted read, a precise-output request, an unrecognised task type
  // — is still refused however large it is, which is the rule order working as documented. So the
  // expectation is "expects to delegate AND clears minLines", and the cases in the first group but
  // not the second are what prove size is not the only gate.
  const clearsMinLines = cached
    .filter((c) => c.caseDef.expected.class === 'delegate')
    .filter((c) => c.caseDef.files.reduce((s, f) => s + f.lines, 0) >= DEFAULTS.routing.bulkRead.minLines)
    .map((c) => c.caseDef.id)
    .sort()
  assert.ok(clearsMinLines.length >= 3, 'the corpus needs cases that clear minLines for this to mean anything')

  const table = run([5_000_000])
  const p = table.thresholds[0]
  assert.deepEqual(
    [...p.delegated].sort(),
    clearsMinLines,
    'the cases delegating under an absurd byte floor must be exactly those that clear minLines',
  )
  for (const id of p.delegated) {
    const entry = cached.find((c) => c.caseDef.id === id)
    const lines = entry.caseDef.files.reduce((s, f) => s + f.lines, 0)
    assert.ok(lines >= DEFAULTS.routing.bulkRead.minLines, `${id} delegates with only ${lines} lines`)
  }
})

test('a threshold where nothing delegates reports unavailable quality, not zero', () => {
  // Reached by sweeping only the cases that cannot clear minLines, since minBytes alone cannot
  // retain the ones that do.
  const belowMinLines = cached.filter(
    (c) => c.caseDef.files.reduce((s, f) => s + f.lines, 0) < DEFAULTS.routing.bulkRead.minLines,
  )
  assert.ok(belowMinLines.length > 0, 'the corpus needs cases that depend on bytes alone')

  const table = sweep({
    cached: belowMinLines,
    thresholds: [5_000_000],
    verdicts,
    pricingChain: EVAL_CHAIN_BUNDLED,
    now: EVAL_NOW,
    runSeed: 'sweep-test',
  })
  const p = table.thresholds[0]
  assert.equal(p.delegatedCount, 0, 'nothing can clear a five-megabyte floor on bytes alone')
  assert.equal(p.quality.value, null, 'zero over zero is unavailable')
  assert.equal(p.quality.passed, null, 'and the numerator is null, not 0')
  assert.equal(p.tokensAvoided.value, null, 'nothing contributed, so the sum is null rather than 0')
  assert.equal(p.rowsTotal, belowMinLines.length, 'while every case is still in the denominator')
})

/* -------------------------------------------------------- no recommendation */

test('the sweep exports no argmax, and the absence of the function is the enforcement', () => {
  for (const forbidden of [
    'bestThreshold', 'recommendThreshold', 'optimalThreshold', 'pickThreshold', 'selectThreshold',
    // The multi-knob sweep is the obvious place for an argmax to reappear, now that there are
    // five knobs to compare instead of one value to walk.
    'bestKnob', 'recommendKnob', 'bestConfiguration', 'rankKnobs', 'scoreKnob', 'optimise',
  ]) {
    assert.equal(sweepModule[forbidden], undefined, `sweep.mjs must not export ${forbidden}`)
  }
})

/* --------------------------------------------------- the other routing knobs */

test('every declared knob is a real routing.bulkRead leaf with points that could discriminate', () => {
  const lane = DEFAULTS.routing.bulkRead
  for (const spec of sweepModule.SWEEP_KNOBS) {
    assert.ok(Object.hasOwn(lane, spec.knob), `${spec.knob} is not a routing.bulkRead leaf`)
    assert.ok(spec.points.length >= 2, `${spec.knob} has nothing to walk`)
    assert.equal(new Set(spec.points).size, spec.points.length, `${spec.knob} repeats a point`)
    assert.ok(typeof spec.note === 'string' && spec.note !== '', `${spec.knob} has no note`)
  }
})

test('the shipped value of each knob is inside its own walk, so the default is measured too', () => {
  // A sweep that never evaluates the value actually in production measures everything except the
  // thing a reader most wants to know.
  const lane = DEFAULTS.routing.bulkRead
  for (const spec of sweepModule.SWEEP_KNOBS) {
    assert.ok(spec.points.includes(lane[spec.knob]), `${spec.knob} never walks its shipped value ${lane[spec.knob]}`)
  }
})

test('measurability is COMPUTED, not declared — an inert knob says so instead of printing rows', () => {
  // The point of the field. `decide()` guards every size clause with `isKnown(x) && x >= t`, so a
  // knob whose input no case supplies can never fire its rule, and six numerically identical rows
  // would imply a resolution the measurement has not got.
  const table = sweepModule.sweepKnobs({
    cached,
    knobs: [
      { knob: 'minBytes', points: [1024, 51200], note: 'bytes are always known' },
      { knob: 'minEstimatedTokens', points: [null, 256, 99999], note: 'no case declares this' },
    ],
    verdicts: new Map(),
    pricingChain: EVAL_CHAIN_BUNDLED,
    now: EVAL_NOW,
    runSeed: 'seed',
  })

  const byKnob = Object.fromEntries(table.knobs.map((k) => [k.knob, k]))
  assert.equal(byKnob.minBytes.measurable, true)
  assert.ok(byKnob.minBytes.distinctOutcomes > 1)

  assert.equal(byKnob.minEstimatedTokens.measurable, false, 'a knob no case can respond to was called measurable')
  assert.equal(byKnob.minEstimatedTokens.distinctOutcomes, 1)
  assert.deepEqual(byKnob.minEstimatedTokens.responsiveCases, [], 'an inert knob must name no responsive case')
})

test('an unmeasurable knob is rendered as a sentence, never as a table of equal rows', () => {
  const table = sweepModule.sweepKnobs({
    cached,
    knobs: [{ knob: 'minEstimatedTokens', points: [null, 256, 99999], note: 'no case declares this' }],
    verdicts: new Map(),
    pricingChain: EVAL_CHAIN_BUNDLED,
    now: EVAL_NOW,
    runSeed: 'seed',
  })
  const text = sweepModule.renderKnobSweep(table)
  assert.match(text, /NOT MEASURABLE/)
  assert.equal(/minEstimatedTokens=\s*\d/.test(text), false, 'it printed point rows anyway')
})

test('the knob sweep refuses a recommendation in the same two words the threshold sweep does', () => {
  const table = sweepModule.sweepKnobs({
    cached,
    knobs: [{ knob: 'minBytes', points: [1024, 51200], note: 'n' }],
    verdicts: new Map(),
    pricingChain: EVAL_CHAIN_BUNDLED,
    now: EVAL_NOW,
    runSeed: 'seed',
  })
  assert.ok(Object.hasOwn(table, 'selected'))
  assert.equal(table.selected, null)
  assert.ok(Object.hasOwn(table, 'recommended'))
  assert.equal(table.recommended, null)
  for (const k of table.knobs) {
    for (const key of Object.keys(k)) {
      assert.equal(/delta|best|optimal|recommend|rank|score/i.test(key), false, `${key} ranks a knob`)
    }
  }
})

test('rowsTotal stays the full case set at every point of every knob', () => {
  // The anti-selection-bias invariant, restated for the knobs. A shrinking denominator is how a
  // sweep manufactures an endorsement out of nothing.
  const table = sweepModule.sweepKnobs({
    cached,
    verdicts: new Map(),
    pricingChain: EVAL_CHAIN_BUNDLED,
    now: EVAL_NOW,
    runSeed: 'seed',
  })
  for (const k of table.knobs) {
    for (const point of k.points) {
      assert.equal(point.rowsTotal, cached.length, `${k.knob}=${point.value} dropped cases from the denominator`)
      assert.equal(point.delegatedCount + point.retainedCount, cached.length)
    }
  }
})

test('a negative-savings case is reported with the attributes worth correlating, unclamped', () => {
  // Part 11 asks whether negative results correlate with small files, high worker output, poor
  // task fit and so on, so the row carries those operands rather than a single number.
  const row = sweepModule.negativeSavingsRow(
    {
      task_id: 'c',
      estimated_tokens_avoided: -166,
      returned_answer_tokens: 179,
      input_bytes: 52,
      files_count: 1,
      worker_output_tokens: 179,
      worker_input_tokens: 20,
      latency_ms: 900,
      routing_reason: 'threshold_met',
      prompt_version: 3,
      task_intent_source: 'none',
      worker_context_tokens: 8192,
      worker_context_status: 'measured',
      worker_input_truncation_detected: false,
    },
    new Map([['c', 'fail']]),
  )
  assert.equal(row.netTokens, -166, 'a negative net must never be clamped')
  assert.equal(row.returnedAnswerTokens, 179)
  assert.equal(row.quality, 'fail')
  assert.equal(row.truncationDetected, false)
  // No verdict, no recommendation, no cause attributed.
  for (const key of Object.keys(row)) {
    assert.equal(/cause|blame|recommend|fix|should/i.test(key), false, `${key} attributes a cause`)
  }
})

test('the output states selectedThreshold as an explicit null rather than omitting it', () => {
  // An absent field invites a reader to supply their own answer; an explicit null says the
  // framework declined to.
  const table = run()
  assert.ok(Object.hasOwn(table, 'selectedThreshold'))
  assert.equal(table.selectedThreshold, null)
  assert.ok(Object.hasOwn(table, 'recommended'))
  assert.equal(table.recommended, null)
})

test('the rendered sweep says in words that it recommends nothing', () => {
  const text = renderSweep(run([12000]))
  assert.match(text, /selectedThreshold: null/)
  assert.match(text, /measurement only/)
  assert.equal(/\brecommend(ed|s)\b\s*:?\s*\d/.test(text), false, 'no rendered recommendation of a value')
})

test('the sweep reports no threshold-to-threshold delta', () => {
  // Subtracting two thresholds sums is adding aggregates to each other across different coverage
  // sets, which `aggregate.mjs` refuses by design (it exports no addAgg). The rendered table has no
  // delta column, and the data carries no delta field.
  for (const p of run().thresholds) {
    for (const key of Object.keys(p)) {
      assert.equal(/delta|improvement|gain|versus/i.test(key), false, `${key} compares two thresholds`)
    }
  }
})

/* --------------------------------------------------------- isolation and purity */

test('the sweep never mutates the base config nor reads the user config', () => {
  const before = JSON.stringify(evalConfig({}, { projectDir: scratch }))
  run()
  const after = JSON.stringify(evalConfig({}, { projectDir: scratch }))
  assert.equal(before, after, 'a sweep point must not leak into the next')
})

test('a case config override survives the sweep, so a tightened cap keeps applying', () => {
  // `over-max-files-tight-cap` sets maxFiles 2 and `over-max-bytes-tight-ceiling` sets
  // maxInputBytes 1024. Those must not be lost when the sweep rewrites minBytes.
  const table = run([1024])
  const p = table.thresholds[0]
  assert.ok(p.retained.includes('over-max-files-tight-cap'), 'the file cap must still refuse')
  assert.ok(p.retained.includes('over-max-bytes-tight-ceiling'), 'the byte ceiling must still refuse')
  assert.equal(p.byRoutingReason.over_max_files, 1)
  assert.equal(p.byRoutingReason.over_max_input_bytes, 1)
})

test('the sweep is deterministic: the same inputs give the same table', () => {
  assert.deepEqual(JSON.stringify(run()), JSON.stringify(run()))
})

test('negative-savings cases are listed by id, not merely counted', () => {
  // A negative is the evidence a threshold is wrong, so it has to be addressable. With the fixture
  // worker the corpus has none, and the field must still be a list rather than absent.
  for (const p of run().thresholds) {
    assert.ok(Array.isArray(p.negativeSavings), `${p.minBytes} must carry a list`)
    for (const n of p.negativeSavings) {
      assert.equal(typeof n.id, 'string', 'a negative case must be named')
      assert.ok(n.netTokens < 0)
    }
  }
})

test('cost availability is reported per threshold, and is unavailable on the shipped table', () => {
  for (const p of run().thresholds) {
    assert.equal(p.costAvailability.rowsCounted, 0, 'the bundled table prices nothing')
    assert.equal(p.workerTotalCost.value, null)
  }
  // And it does compute against a priced fixture, so the column is not dead.
  const priced = run([1024], evalPricedChain())
  assert.ok(priced.thresholds[0].costAvailability.rowsCounted > 0, 'a priced table must populate the cost column')
})

test('latency is summarised per threshold without being summed across series', () => {
  for (const p of run().thresholds) {
    assert.ok(Object.hasOwn(p.latencyMs, 'median'))
    if (p.latencyMs.n === 0) assert.equal(p.latencyMs.median, null, 'no samples means null, not 0')
  }
})
