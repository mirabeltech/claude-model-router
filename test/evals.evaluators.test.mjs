/**
 * Evaluator correctness.
 *
 * AN EVALUATOR THAT HAS NEVER FAILED IS AN EVALUATOR NOBODY HAS TESTED. Every kind gets a PAIR
 * here — one answer it must pass and one it must fail — plus a completeness assertion that no kind
 * can ship without both. Without the pair, a criterion that silently always passes looks exactly
 * like a criterion the worker always satisfies, and the corpus reports a quality rate it has not
 * earned.
 *
 * The other half of this file is the null-versus-false rule, which is CLAUDE.md #5 applied to
 * quality:
 *
 *   null  — the question was never asked (no output, or no criteria)
 *   false — asked and answered wrongly
 *
 * `''` is FALSE, not null: an empty string is a MEASURED empty answer, the same distinction the
 * telemetry layer draws between `0` and `null`, and the same call `hook/run.mjs` makes when it
 * downgrades outcome `delegated` to `empty_answer`.
 *
 * Needs no provider and no network, so it runs inside `npm test` rather than behind an opt-in flag.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMON_LEXICON,
  EVALUATORS,
  EVALUATOR_KINDS,
  FORBIDDEN_MIN_CHARS,
  QUALITY_REASONS,
  codePositionTokens,
  evaluateQuality,
  tokenize,
  validateCriteria,
} from './evals/evaluators.mjs'

/** A tiny corpus the entity and fact evaluators can verify claims against. */
const FILES = new Map([
  ['files/dispatch.ts', 'export function resolveWorker() {\n  const RETRY_CEILING = 7\n  return { provider: 1 }\n}\n'],
  ['files/globs.ts', 'export function matchesGlob(pattern, p) {\n  return false\n}\n'],
])
const CTX = { files: FILES }

/**
 * One pass/fail pair per kind. `spec` is the criterion, `passing` must grade true, `failing` must
 * grade false, and `why` says what the failing answer did wrong.
 */
const PAIRS = Object.freeze([
  {
    kind: 'requiredTerms',
    spec: ['resolveWorker', 'provider'],
    passing: 'It defines resolveWorker and returns a provider.',
    failing: 'It defines something and returns a thing.',
    why: 'neither required term appears',
  },
  {
    kind: 'forbiddenTerms',
    spec: ['probably', 'appears to'],
    passing: 'It defines resolveWorker.',
    failing: 'It probably defines resolveWorker.',
    why: 'a hedging phrase appears',
  },
  {
    kind: 'requiredEntities',
    spec: ['resolveWorker', 'matchesGlob'],
    passing: 'Two functions: resolveWorker and matchesGlob.',
    failing: 'Two functions: resolveWorker and deriveConfig.',
    why: 'one required entity is absent from the answer',
  },
  {
    kind: 'fileReferences',
    spec: ['files/dispatch.ts', 'files/globs.ts'],
    passing: 'See dispatch.ts and globs.ts.',
    failing: 'See dispatch.ts.',
    why: 'one declared file is never cited',
  },
  {
    kind: 'counts',
    spec: [{ term: 'export', min: 2, max: 4 }],
    passing: 'There is one export here and another export there.',
    failing: 'There is one export here.',
    why: 'the occurrence count is below min',
  },
  {
    kind: 'exactFacts',
    spec: [{ literal: 'RETRY_CEILING = 7' }],
    passing: 'The file sets RETRY_CEILING = 7 near the top.',
    failing: 'The file sets RETRY_CEILING = 9 near the top.',
    why: 'the planted value is wrong',
  },
  {
    kind: 'lineCitations',
    spec: [{ fact: 'RETRY_CEILING', line: 2, decoyLines: [7, 9] }],
    passing: 'RETRY_CEILING is declared on line 2.',
    failing: 'RETRY_CEILING is declared on line 9.',
    why: 'a decoy line is cited instead of the right one',
  },
])

test('every evaluator kind has a pass/fail pair in this file', () => {
  // Completeness, so a kind added to EVALUATORS cannot ship unproven.
  const covered = new Set(PAIRS.map((p) => p.kind))
  const missing = EVALUATOR_KINDS.filter((k) => !covered.has(k))
  assert.deepEqual(missing, [], `kinds with no pass/fail pair: ${missing.join(', ')}`)
  assert.equal(PAIRS.length, EVALUATOR_KINDS.length, 'no pair may cover a kind that does not exist')
})

for (const pair of PAIRS) {
  test(`${pair.kind} passes the answer it should`, () => {
    const r = evaluateQuality(pair.passing, { [pair.kind]: pair.spec }, CTX)
    assert.equal(r.quality, true, `${pair.kind}: ${JSON.stringify(r.results)}`)
    assert.equal(r.reason, 'evaluated')
  })

  test(`${pair.kind} fails the answer it should, because ${pair.why}`, () => {
    const r = evaluateQuality(pair.failing, { [pair.kind]: pair.spec }, CTX)
    assert.equal(r.quality, false, `${pair.kind} did not catch it: ${JSON.stringify(r.results)}`)
    assert.deepEqual([...r.failed], [pair.kind])
    assert.ok(r.results[0].missing.length > 0, 'a failure must name what was missing')
  })
}

/* ---------------------------------------------------- null versus false versus 0 */

test('an absent output is null, not false — availability is not quality', () => {
  // A worker crash is an availability fact. Grading it as a quality failure conflates two problems
  // with two different fixes, and drags the pass rate down for a question nobody asked.
  for (const absent of [null, undefined, 0, 42, {}, []]) {
    const r = evaluateQuality(absent, { requiredTerms: ['x'] }, CTX)
    assert.equal(r.quality, null, `${JSON.stringify(absent)} must be ungraded`)
    assert.equal(r.reason, 'no_output')
    assert.equal(r.score, null, 'an ungraded case has no score, not a score of zero')
  }
})

test('an empty string is false, not null — it is a measured empty answer', () => {
  const r = evaluateQuality('', { requiredTerms: ['x'] }, CTX)
  assert.equal(r.quality, false)
  assert.equal(r.reason, 'empty_output')
  assert.equal(r.score, 0, 'a measured failure scores zero; an unmeasured one scores null')
})

test('no criteria is null, and is checked before the output', () => {
  // A case with nothing to measure is ungraded whether or not the worker answered. Reporting it as
  // `no_output` would blame the worker for the corpus's silence.
  for (const empty of [null, undefined, {}]) {
    const r = evaluateQuality('a perfectly good answer', empty, CTX)
    assert.equal(r.quality, null)
    assert.equal(r.reason, 'no_criteria')
  }
  assert.equal(evaluateQuality(null, {}, CTX).reason, 'no_criteria', 'no criteria wins over no output')
})

test('every reason this module can report is in the declared list', () => {
  const seen = [
    evaluateQuality(null, { requiredTerms: ['x'] }, CTX).reason,
    evaluateQuality('x', null, CTX).reason,
    evaluateQuality('', { requiredTerms: ['x'] }, CTX).reason,
    evaluateQuality('x', { requiredTerms: ['x'] }, CTX).reason,
  ]
  for (const reason of seen) assert.ok(QUALITY_REASONS.includes(reason), `${reason} is not declared`)
  assert.deepEqual([...new Set(seen)].sort(), [...QUALITY_REASONS].sort(), 'every declared reason is reachable')
})

test('a failing criterion among passing ones fails the whole verdict', () => {
  const r = evaluateQuality('resolveWorker is probably here', {
    requiredTerms: ['resolveWorker'],
    forbiddenTerms: ['probably'],
  }, CTX)
  assert.equal(r.quality, false, 'all criteria must hold, not most of them')
  assert.deepEqual([...r.failed], ['forbiddenTerms'])
})

test('score is reported but never thresholded — a 0.8 is not a pass', () => {
  const r = evaluateQuality('resolveWorker is probably here', {
    requiredTerms: ['resolveWorker'],
    forbiddenTerms: ['probably'],
  }, CTX)
  assert.equal(r.score, 0.5, 'half the criteria held')
  assert.equal(r.quality, false, 'and the verdict is still a failure')
})

/* ------------------------------------------------ the evaluators own guard rails */

test('requiredEntities fails an expectation the corpus cannot support', () => {
  // The half that makes this more than requiredTerms: a case naming something absent from its own
  // fixtures is a CORPUS bug, and it must surface as a failure rather than as a worker failure.
  const r = EVALUATORS.requiredEntities.run('I mention notInTheCorpus', ['notInTheCorpus'], CTX)
  assert.equal(r.pass, false)
  assert.match(r.detail, /not present in the corpus/)
})

test('exactFacts refuses a literal the corpus does not contain', () => {
  const r = EVALUATORS.exactFacts.run('RETRY_CEILING = 11', [{ literal: 'RETRY_CEILING = 11' }], CTX)
  assert.equal(r.pass, false, 'present in the answer and absent from the corpus is fabrication')
})

test('lineCitations needs the fact, the right line, and no decoy', () => {
  const spec = [{ fact: 'RETRY_CEILING', line: 2, decoyLines: [7] }]
  const run = (text) => EVALUATORS.lineCitations.run(text, spec, CTX).pass
  assert.equal(run('RETRY_CEILING is on line 2.'), true)
  assert.equal(run('It is on line 2.'), false, 'the fact must be named')
  assert.equal(run('RETRY_CEILING is somewhere.'), false, 'the line must be cited')
  assert.equal(run('RETRY_CEILING is on line 2, not 7.'), false, 'citing a decoy fails even alongside the right line')
})

test('a line number is matched as a standalone integer, so a period does not defeat it', () => {
  // "declared on line 700." is the most natural way to cite a line, and an over-eager dot guard
  // would fail a correct answer. A dot only disqualifies when it is a decimal point.
  const spec = [{ fact: 'X', line: 7 }]
  const run = (text) => EVALUATORS.lineCitations.run(text, spec, CTX).pass
  assert.equal(run('X on line 7.'), true, 'a sentence-ending period is not a decimal point')
  assert.equal(run('X on line 7'), true)
  assert.equal(run('X at 7.2'), false, 'a decimal does not cite line 7')
  assert.equal(run('X at v0.7'), false)
  assert.equal(run('X on line 17'), false, 'an adjacent digit disqualifies')
  assert.equal(run('X on line 70'), false)
})

test('counts is always a range, because an exact count is brittle to phrasing', () => {
  assert.ok(validateCriteria({ counts: [{ term: 'export', expected: 3 }] }).length > 0)
  assert.deepEqual(validateCriteria({ counts: [{ term: 'export', min: 1 }] }), [])
  assert.ok(validateCriteria({ counts: [{ term: 'export', min: 5, max: 2 }] }).length > 0, 'min above max is a typo')
})

test('a short forbidden term needs an explicit override, because it false-positives', () => {
  // A bare "3" matches a line number, a version and a byte count. A gate nobody trusts gets
  // disabled rather than fixed, so the corpus has to opt in deliberately.
  assert.ok(validateCriteria({ forbiddenTerms: ['3'] }).length > 0)
  assert.deepEqual(validateCriteria({ forbiddenTerms: { terms: ['3'], allowShort: true } }), [])
  assert.equal('abcd'.length, FORBIDDEN_MIN_CHARS, 'the floor is four characters')
})

test('an unknown criterion kind is a load error, not a criterion that quietly does not run', () => {
  const problems = validateCriteria({ vibeCheck: ['x'] })
  assert.ok(problems.some((p) => p.includes('unknown quality criterion')), problems.join(' | '))
})

/* ------------------------------------------------------------ the tokenizers */

test('tokenize finds identifiers and lower-cases them', () => {
  const t = tokenize('export function resolveWorker() { const RETRY_CEILING = 7 }')
  assert.ok(t.has('resolveworker'))
  assert.ok(t.has('retry_ceiling'))
  assert.equal(t.has('7'), false, 'a bare number is not an identifier')
})

test('codePositionTokens reads code positions and leaves prose alone', () => {
  // Scanning prose would return "purpose", "structure" and "declaration" on the first run, and the
  // advisory that consumes this would die of false positives the same day.
  const t = codePositionTokens('The purpose of this file is to declare `resolveWorker` and MANIFEST_VERSION.')
  assert.ok(t.has('resolveworker'), 'a backticked identifier is in code position')
  assert.ok(t.has('manifest_version'), 'SCREAMING_SNAKE is code-shaped wherever it sits')
  assert.equal(t.has('purpose'), false, 'an ordinary prose word is not a candidate')
  assert.equal(t.has('declare'), false)
})

test('the common lexicon covers the words the shipped prompt puts in the worker mouth', () => {
  for (const word of ['export', 'function', 'declaration', 'purpose', 'line', 'file']) {
    assert.ok(COMMON_LEXICON.has(word), `${word} must never read as an invented entity`)
  }
})

test('an evaluator never sees a null output, so it needs no null handling of its own', () => {
  // evaluateQuality owns absence. This asserts the contract rather than the implementation, so an
  // evaluator written later cannot be blamed for a crash on null.
  for (const kind of EVALUATOR_KINDS) {
    const r = evaluateQuality(null, { [kind]: PAIRS.find((p) => p.kind === kind).spec }, CTX)
    assert.equal(r.results.length, 0, `${kind} must not have been invoked`)
  }
})
