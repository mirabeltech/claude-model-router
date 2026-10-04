/**
 * The A/B dimension: two constructions, one variable, and no number that compares them.
 *
 * The framework's standing rule is that it measures and never decides, and an A/B mode is exactly
 * where that rule is easiest to break — because a table with two columns invites a third holding
 * the difference. So the assertions here are mostly about what the mode must NOT produce:
 *
 *   - no delta, ratio or percentage between variants, anywhere in the report;
 *   - no claim about quality on the deterministic arm, where both variants are served the same
 *     authored answer and their quality is therefore equal by construction;
 *   - no change to the default run, whose rows must stay byte-identical to the rows this runner
 *     produced before the dimension existed.
 *
 * The one thing it must produce is a real measurement of what each construction SENDS, because
 * prompt size is genuinely observable offline and is the honest part of an offline comparison.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { EVAL_VARIANTS, variantIds } from './evals/config.mjs'
import { INTENT_PROMPT_VERSION, PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'
import { eventIdFor } from './evals/determinism.mjs'
import { loadAnswers, makeFixtureWorker } from './evals/fixture-worker.mjs'
import { loadCorpus, CORPUS_DIR } from './evals/load.mjs'
import { runCase } from './evals/harness.mjs'

let scratch
let corpus
let fixture

test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-variants-'))
  corpus = loadCorpus({ scratchDir: scratch })
  assert.deepEqual(corpus.errors, [], 'the corpus must load before it can be run twice')
  fixture = makeFixtureWorker(loadAnswers(corpus.cases, CORPUS_DIR, { fs, path }).answers)
})

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const run = (caseDef, variant) =>
  runCase({
    caseDef,
    contents: corpus.contents.get(caseDef.id) ?? new Map(),
    absPaths: corpus.absPaths.get(caseDef.id) ?? new Map(),
    projectDir: scratch,
    fixture,
    variant,
  })

/** A delegating dispatch case, which is the only kind the variant dimension touches. */
const aDispatchCase = () =>
  corpus.cases.find((c) => c.harness === 'dispatch' && c.expected.class === 'delegate')

/** The five Phase 7 regression cases, which are the ones that declare an intent. */
const intentCases = () => corpus.cases.filter((c) => c.taskIntent !== null)

/* ------------------------------------------------------------- the declaration */

test('there are exactly two variants, and generic is first so it is always the primary pass', () => {
  assert.deepEqual(variantIds(), ['generic', 'intent'])
  assert.equal(EVAL_VARIANTS.generic.intentAware, false)
  assert.equal(EVAL_VARIANTS.intent.intentAware, true)
})

test('only the intent variant takes an event-id suffix, so a default run is unchanged', () => {
  // THE DETERMINISM GUARANTEE. An empty suffix for `generic` is what keeps `stable.jsonl` from a
  // default run byte-identical to the artifact produced before this dimension existed.
  assert.equal(EVAL_VARIANTS.generic.eventIdSuffix, '')
  assert.equal(eventIdFor('a-case' + EVAL_VARIANTS.generic.eventIdSuffix, 's'), eventIdFor('a-case', 's'))
  assert.notEqual(eventIdFor('a-case' + EVAL_VARIANTS.intent.eventIdSuffix, 's'), eventIdFor('a-case', 's'))
})

test('the variant suffix cannot be mistaken for a sweep suffix', () => {
  // `sweep.mjs` uses `@<minBytes>` for the same purpose. Sharing a separator would make a row id
  // ambiguous between "the intent variant" and "a threshold point".
  assert.equal(EVAL_VARIANTS.intent.eventIdSuffix.includes('@'), false)
  assert.match(EVAL_VARIANTS.intent.eventIdSuffix, /^#/)
})

/* --------------------------------------------------------------- one variable */

test('both variants send the same question, the same files and the same decision', () => {
  // The experiment is only valid if one thing moves. The task sentence is identical because a
  // case without a declared intent falls back to its own task, and a case with one declares the
  // same sentence as its intent task.
  const caseDef = aDispatchCase()
  const [a, b] = [EVAL_VARIANTS.generic, EVAL_VARIANTS.intent].map((v) => run(caseDef, v))
  return Promise.all([a, b]).then(([generic, intent]) => {
    assert.deepEqual(generic.decision, intent.decision, 'the routing decision must not move')
    assert.equal(generic.corpusChars, intent.corpusChars, 'the file corpus must not move')
    assert.equal(generic.config.worker.provider, intent.config.worker.provider)
    assert.equal(generic.config.worker.model, intent.config.worker.model)
    assert.ok(intent.prompt.startsWith(generic.prompt.slice(0, 40)), 'the task section is identical')
  })
})

test('the generic variant renders the prompt the shipped default renders', async () => {
  const ran = await run(aDispatchCase(), EVAL_VARIANTS.generic)
  assert.equal(ran.variant, 'generic')
  assert.equal(ran.taskIntentSource, 'none')
  assert.equal(ran.prompt.includes('# Requirements'), false)
  assert.equal(ran.result.promptVersion, PROMPT_VERSION)
})

test('the intent variant adds the requirements section and says so in the version', async () => {
  const ran = await run(aDispatchCase(), EVAL_VARIANTS.intent)
  assert.equal(ran.variant, 'intent')
  // `other`, not `transcript`: the eval's intent comes from a case file, and labelling it
  // `transcript` would file a caller-supplied intent as one recovered from a session.
  assert.equal(ran.taskIntentSource, 'other')
  assert.match(ran.prompt, /# Requirements/)
  assert.equal(ran.result.promptVersion, INTENT_PROMPT_VERSION)
})

test('the intent construction sends strictly more, and the difference is measured not guessed', async () => {
  const caseDef = aDispatchCase()
  const generic = await run(caseDef, EVAL_VARIANTS.generic)
  const intent = await run(caseDef, EVAL_VARIANTS.intent)
  assert.ok(intent.promptChars > generic.promptChars, 'the requirements section has a real cost')
  assert.equal(intent.promptChars, intent.prompt.length, 'and it is the measured length, not an estimate')
  assert.ok(
    intent.result.usage.inputTokens > generic.result.usage.inputTokens,
    'which the provider then reports as more input tokens',
  )
})

/* ---------------------------------------------- what offline quality cannot say */

test('both variants receive the identical authored answer, so offline quality cannot compare them', () => {
  // The reason the A/B block reports `qualityIsMeasured: false` on the deterministic arm. The
  // fixture worker keys its canned answer off the case id in the URL and never off the prompt, so
  // an intent-aware prompt gets the same text back. That is deliberate: authoring a second,
  // better answer for the intent variant would let whoever wrote it decide which construction
  // wins, which is the one thing a benchmark must not let anyone do.
  const caseDef = aDispatchCase()
  return Promise.all([run(caseDef, EVAL_VARIANTS.generic), run(caseDef, EVAL_VARIANTS.intent)]).then(
    ([generic, intent]) => {
      assert.equal(generic.output, intent.output, 'the deterministic arm cannot distinguish the two')
    },
  )
})

/* --------------------------------------------------------------- the corpus */

test('the Phase 7 regression cases declare an intent, and the rest are untouched', () => {
  const declared = intentCases().map((c) => c.id).sort()
  assert.deepEqual(declared, [
    'intent-buried-in-repetition',
    'intent-entity-extraction',
    'intent-fact-among-distractors',
    'intent-line-citation-required',
    'intent-multiple-occurrences',
  ])
  // Every other case has an explicit null rather than an absent key.
  for (const c of corpus.cases) {
    if (declared.includes(c.id)) continue
    assert.equal(c.taskIntent, null, `${c.id} must carry an explicit null`)
  }
})

test('the regression cases changed no routing expectation, because this phase changed no routing', () => {
  for (const c of intentCases()) {
    assert.equal(c.expected.class, 'delegate')
    assert.equal(c.expected.reason, 'threshold_met')
    assert.equal(c.expected.taskType, 'bulk_read')
    assert.equal(c.expected.decision, 'deny')
    assert.equal(c.expected.dispatchStatus, 'ok')
  }
})

test('each regression case pins a failure mode, and between them they cover the reported one', () => {
  // The live failure was: a repetitive table, a buried fact, a requested entity, and a line that
  // was never cited. Each is somebody's criterion here, so no single case carries the whole claim.
  const kinds = new Map(intentCases().map((c) => [c.id, Object.keys(c.qualityCriteria ?? {})]))
  assert.ok(kinds.get('intent-buried-in-repetition').includes('lineCitations'))
  assert.ok(kinds.get('intent-multiple-occurrences').includes('counts'))
  assert.ok(kinds.get('intent-line-citation-required').includes('lineCitations'))
  assert.ok(kinds.get('intent-fact-among-distractors').includes('requiredEntities'))
  assert.ok(kinds.get('intent-entity-extraction').includes('forbiddenTerms'))
})

test('the line citations name real lines, so a passing answer is a correct answer', async () => {
  // A citation fixture is only worth running if the declared line is where the fact actually is.
  // A wrong expectation here would make every honest worker fail and every careless one pass.
  for (const caseDef of intentCases()) {
    for (const cite of caseDef.qualityCriteria.lineCitations ?? []) {
      const files = corpus.contents.get(caseDef.id) ?? new Map()
      const text = [...files.values()][0]
      const lines = text.split('\n')
      assert.ok(
        lines[cite.line - 1].includes(cite.fact),
        `${caseDef.id}: line ${cite.line} does not hold ${cite.fact}; it holds "${lines[cite.line - 1]}"`,
      )
      for (const decoy of cite.decoyLines) {
        assert.equal(
          lines[decoy - 1].includes(cite.fact),
          false,
          `${caseDef.id}: decoy line ${decoy} also holds ${cite.fact}, so it cannot falsify anything`,
        )
      }
    }
  }
})

test('the near-miss row really does say the word without being a match', async () => {
  // `intent-entity-extraction` forbids `x_088`, and that forbiddance is only meaningful if the
  // row genuinely mentions the flag. Otherwise the case asserts nothing.
  const caseDef = corpus.cases.find((c) => c.id === 'intent-entity-extraction')
  const text = [...(corpus.contents.get(caseDef.id) ?? new Map()).values()][0]
  const decoyRow = text.split('\n').find((l) => l.includes("'x_088'"))
  assert.match(decoyRow, /deprecated/, 'the decoy row must mention the flag')
  assert.match(decoyRow, /\/\/ example/, 'as a comment, so it is not an actual deprecation')
  assert.equal(decoyRow.includes('deprecated: true })'), false, 'and not as a real field')
})
