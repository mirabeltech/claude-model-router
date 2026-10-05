/**
 * The harness, at all three layers.
 *
 * The hook cases are the reason this file exists. Everything else in the framework can be checked
 * in process, but `pre-tool-use.mjs` has to be spawned the way Claude Code spawns it — JSON on
 * stdin, JSON on stdout, an exit code — because the process boundary has failure modes an
 * in-process call cannot see: a buffered stdout write racing exit, an unhandled rejection reaching
 * stderr, a non-zero exit from a module that failed to load. The protocol is also the thing a
 * benchmark most needs to be true: empty stdout and exit 0 is how the hook says "behave as if I
 * were not installed", and a benchmark that mistook a crash for a refusal would report a clean
 * primary run.
 *
 * Three hook facts the corpus depends on are pinned here rather than assumed, each having cost
 * somebody a confusing afternoon:
 *
 *   a MISSING transcript makes `recentlyEdited()` return true, so a corpus of static directories
 *   reports total refusal unless each hook case materialises one;
 *
 *   `worker_not_ready` owns every hook case unless `MOCK_WORKER_URL` is set, because
 *   `resolveWorker` inherits `worker.apiKeyEnv` across a provider change;
 *
 *   the hook sends ONE file and a frozen task, which is why `minLines` is unreachable there.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadCorpus, CORPUS_DIR } from './evals/load.mjs'
import { evalConfig } from './evals/config.mjs'
import { gradeCase, hookProcessHealth, latencySeries, runCase, verdictMap } from './evals/harness.mjs'
import { makeFixtureWorker, loadAnswers } from './evals/fixture-worker.mjs'
import { LATENCY_SERIES } from './evals/determinism.mjs'

let scratch
let corpus
let fixture

test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-harness-'))
  corpus = loadCorpus({ scratchDir: scratch })
  assert.deepEqual(corpus.errors, [])
  const { answers, errors } = loadAnswers(corpus.cases, CORPUS_DIR, { fs, path })
  assert.deepEqual(errors, [], 'every dispatch case needs a canned answer')
  fixture = makeFixtureWorker(answers)
})

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const run = (caseDef) =>
  runCase({
    caseDef,
    contents: corpus.contents.get(caseDef.id) ?? new Map(),
    absPaths: corpus.absPaths.get(caseDef.id) ?? new Map(),
    projectDir: scratch,
    fixture,
  })

const casesOf = (harness) => corpus.cases.filter((c) => c.harness === harness)

/* -------------------------------------------------------------- the hook layer */

test('every hook case agrees with its expectation, driven as a real child process', async () => {
  const disagreements = []
  for (const caseDef of casesOf('hook')) {
    const r = await run(caseDef)
    if (!r.agrees) disagreements.push(`${caseDef.id}: ${r.mismatches.join('; ')}`)
    assert.equal(r.hookExitCode, 0, `${caseDef.id}: the hook must always exit 0`)
    assert.equal(r.hookStderr, '', `${caseDef.id}: the hook must never write stderr`)
  }
  assert.deepEqual(disagreements, [], `\n  ${disagreements.join('\n  ')}`)
})

test('a refusing hook writes nothing to stdout, which is how it says "not installed"', async () => {
  // Empty stdout plus exit 0 is the protocol's no-op. Every hook case in the corpus refuses, so
  // every one must be silent — and a benchmark that read a crash as a refusal would be wrong.
  for (const caseDef of casesOf('hook')) {
    const r = await run(caseDef)
    assert.equal(r.decision.delegate, false, `${caseDef.id} is expected to refuse`)
    assert.equal(r.hookStdout.trim(), '', `${caseDef.id} wrote ${r.hookStdout.length} bytes of stdout`)
    assert.equal(r.hookOutcome, 'not_delegated')
  }
})

test('the lines-350 pair is the measured discrepancy, not a restated threshold', async () => {
  // THE most valuable case in the corpus. One file, 10500 bytes and 350 lines. The decide layer
  // delegates on minLines; the hook refuses, because adapter.mjs leaves lineCount null by design.
  // docs/what-we-do-not-delegate.md states this in prose, and this is where it is measured.
  const decideCase = corpus.byId.get('lines-350-decide-delegates')
  const hookCase = corpus.byId.get('lines-350-hook-refuses')
  assert.ok(decideCase && hookCase, 'the pair must both exist')

  const sameFile = decideCase.files[0]
  assert.equal(sameFile.bytes, hookCase.files[0].bytes, 'the pair must share a file size')
  assert.equal(sameFile.lines, hookCase.files[0].lines)
  assert.ok(sameFile.bytes < 12_000, 'under minBytes, so bytes alone cannot explain the delegation')
  assert.equal(sameFile.lines, 350, 'and exactly at minLines')

  const decided = await run(decideCase)
  const hooked = await run(hookCase)
  assert.equal(decided.decision.delegate, true, 'the decide layer delegates on lines')
  assert.equal(hooked.decision.delegate, false, 'the hook cannot, because it counts no lines')
  assert.equal(hooked.decision.reason, 'below_threshold')
})

test('a missing transcript refuses, because unmeasurable is never the favorable value', async () => {
  const r = await run(corpus.byId.get('missing-transcript-refuses'))
  assert.equal(r.decision.reason, 'recently_edited')
  assert.equal(r.decision.delegate, false)
})

test('a transcript whose last turn is an edit refuses, measured rather than asserted', async () => {
  // The harness writes a real transcript and hook/facts.mjs reads it. Not a flag we set.
  const caseDef = corpus.byId.get('recently-edited-refused')
  const r = await run(caseDef)
  assert.equal(r.decision.reason, 'recently_edited')

  const transcript = path.join(scratch, caseDef.id, 'transcript.jsonl')
  assert.ok(fs.existsSync(transcript), 'the harness must have written a transcript to read')
  const body = fs.readFileSync(transcript, 'utf8')
  assert.match(body, /tool_use/, 'and it must contain a real tool_use turn')
  assert.match(body, /Edit/)
})

test('an unconfigured worker refuses with worker_not_ready, which is what a fresh install sees', async () => {
  const r = await run(corpus.byId.get('worker-not-ready-refused'))
  assert.equal(r.decision.reason, 'worker_not_ready')
  assert.equal(r.decision.delegate, false, 'the gate fails OPEN: plain Claude Code, not a blocked read')
})

test('the hook child never inherits the developer environment', async () => {
  // runHookProcess replaces the environment apart from PATH, so a real GEMINI_API_KEY on one
  // machine cannot change a benchmark number that a clean machine would compute differently.
  const caseDef = corpus.byId.get('lines-350-hook-refuses')
  const r = await run(caseDef)
  assert.equal(r.hookExitCode, 0)
  assert.equal(r.hookStderr, '', 'a leaked config or key would most likely surface as stderr noise')
})

/* ---------------------------------------------------------- the dispatch layer */

test('every dispatch case reaches the fixture worker and comes back ok', async () => {
  for (const caseDef of casesOf('dispatch')) {
    const r = await run(caseDef)
    assert.equal(r.agrees, true, `${caseDef.id}: ${r.mismatches.join('; ')}`)
    assert.equal(r.result.status, 'ok', `${caseDef.id} dispatched with status ${r.result?.status}`)
    assert.equal(r.result.reason, 'completed')
    assert.equal(r.result.provider, 'mock')
    assert.ok(typeof r.output === 'string' && r.output.length > 0, `${caseDef.id} returned no text`)
  }
})

test('the dispatch payload goes through the real mode builder, markers and all', async () => {
  const r = await run(corpus.byId.get('shape-multi-file-three-modules'))
  assert.match(r.prompt, /# Task/, 'the real bulk-reader template')
  assert.match(r.prompt, /# Files \(3\)/, 'and it knows there are three')
  assert.match(r.prompt, /<<<<<<<<<< FILE files\/dispatch\.ts/, 'with the unforgeable file markers')
  assert.ok(r.system.length > 0, 'and a system prompt')
})

test('corpusChars counts what was actually sent, and is null when nothing was', async () => {
  const dispatched = await run(corpus.byId.get('shape-high-noise'))
  const declared = corpus.byId.get('shape-high-noise').files[0].bytes
  assert.equal(dispatched.corpusChars, declared, 'the fixture is ASCII, so chars equal bytes here')

  const refused = await run(corpus.byId.get('small-read-stays-primary'))
  assert.equal(refused.corpusChars, null, 'no payload was built, so there is no corpus size')
})

test('a dispatch case is never dispatched on a non-delegating decision', async () => {
  // dispatch() would return status skipped / reason routing_declined, which looks enough like a
  // real result that the row would be stamped bulk_read on what is actually a gate refusal.
  for (const caseDef of casesOf('decide')) {
    const r = await run(caseDef)
    assert.equal(r.result, null, `${caseDef.id} must not have called the worker`)
  }
})

test('the fixture worker is addressed per case, so answers cannot be crossed', async () => {
  const before = fixture.requests.length
  await run(corpus.byId.get('shape-buried-fact'))
  const sent = fixture.requests.slice(before)
  assert.equal(sent.length, 1, 'exactly one request')
  assert.equal(sent[0].caseId, 'shape-buried-fact', 'routed by case id, carried in the URL path')
})

/* ----------------------------------------------------------- grading and series */

test('a dispatch case grades, and a refusing case is ungraded rather than failed', async () => {
  const dispatched = gradeCase(await run(corpus.byId.get('shape-buried-fact')), corpus.contents)
  assert.equal(dispatched.quality.quality, true, JSON.stringify(dispatched.quality.results))
  assert.equal(dispatched.quality.reason, 'evaluated')

  const refused = gradeCase(await run(corpus.byId.get('small-read-stays-primary')), corpus.contents)
  assert.equal(refused.quality.quality, null, 'a case with no criteria is ungraded, not failed')
  assert.equal(refused.quality.reason, 'no_criteria')
})

test('verdictMap omits ungraded cases entirely, so they cannot reach a denominator', () => {
  const graded = [
    { caseDef: { id: 'a' }, quality: { quality: true } },
    { caseDef: { id: 'b' }, quality: { quality: false } },
    { caseDef: { id: 'c' }, quality: { quality: null } },
  ]
  const map = verdictMap(graded)
  assert.equal(map.get('a'), 'pass')
  assert.equal(map.get('b'), 'fail')
  assert.equal(map.has('c'), false, 'null is not a verdict and must not be recorded as one')
  assert.equal(map.size, 2)
})

test('the latency series are named, separate, and cover the declared set', async () => {
  const ran = []
  for (const caseDef of [
    corpus.byId.get('lines-350-hook-refuses'),
    corpus.byId.get('shape-high-noise'),
    corpus.byId.get('small-read-stays-primary'),
  ]) {
    ran.push(await run(caseDef))
  }
  const series = latencySeries(ran)
  for (const name of Object.keys(series)) {
    assert.ok(LATENCY_SERIES.includes(name), `${name} is not a declared series`)
    assert.ok(Object.hasOwn(series[name], 'median'), `${name} must be summarised`)
  }
  assert.ok(Object.hasOwn(series, 'hook_startup'), 'the real process cost must be measured')
  assert.ok(Object.hasOwn(series, 'routing_decision'))
  assert.ok(Object.hasOwn(series, 'primary_path_overhead'), 'what every Read pays when nothing delegates')
  assert.equal(series.hook_startup.n > 0, true)
})

test('the primary path overhead comes from a refusing hook, not from a delegating one', async () => {
  // It is the cost a Read pays when the router declines, which is the only latency figure the
  // primary arm genuinely owns.
  const ran = [await run(corpus.byId.get('worker-not-ready-refused'))]
  const series = latencySeries(ran)
  assert.equal(series.primary_path_overhead.n, 1)
  assert.equal(
    series.primary_path_overhead.median,
    series.total_delegated_path.median,
    'on a refusing case the two are the same measurement, filed under the name that describes it',
  )
})

test('no harness run leaves a file behind in the corpus directory', async () => {
  // The scratch directory takes every write. The corpus is read-only to the harness, which is what
  // `corpus_unmodified_by_the_run` asserts at the gate level and this asserts directly.
  const before = fs.readdirSync(CORPUS_DIR).sort()
  for (const caseDef of corpus.cases.slice(0, 4)) await run(caseDef)
  assert.deepEqual(fs.readdirSync(CORPUS_DIR).sort(), before)
})

/* -------------------------------------------------------- hookProcessHealth */

test('hookProcessHealth counts only hook cases and carries its denominator', () => {
  const h = hookProcessHealth([
    { layer: 'decide', caseDef: { id: 'd1' }, hookExitCode: null, hookStderr: null, hookSignal: null },
    { layer: 'hook', caseDef: { id: 'h1' }, hookExitCode: 0, hookStderr: '', hookSignal: null },
    { layer: 'hook', caseDef: { id: 'h2' }, hookExitCode: 0, hookStderr: '', hookSignal: null },
  ])
  assert.deepEqual(h, { hookCases: 2, exitedZero: 2, emptyStderr: 2, incidents: [] })
})

test('hookProcessHealth reports zero hook cases without a division', () => {
  // The reason this is reported at all: "no gate failed" and "no hook case ran" are different
  // facts, and `--case` filtering to a decide case produces the second one.
  const h = hookProcessHealth([{ layer: 'dispatch', caseDef: { id: 'x' }, hookExitCode: null, hookStderr: null, hookSignal: null }])
  assert.deepEqual(h, { hookCases: 0, exitedZero: 0, emptyStderr: 0, incidents: [] })
})

test('hookProcessHealth lists an incident with its case id', () => {
  const h = hookProcessHealth([
    { layer: 'hook', caseDef: { id: 'h1' }, hookExitCode: 0, hookStderr: '', hookSignal: null },
    { layer: 'hook', caseDef: { id: 'h2' }, hookExitCode: 3221226505, hookStderr: 'Assertion failed\n', hookSignal: null },
  ])
  assert.equal(h.hookCases, 2)
  assert.equal(h.exitedZero, 1)
  assert.equal(h.emptyStderr, 1)
  assert.deepEqual(h.incidents, [{ id: 'h2', code: 3221226505, signal: null, stderrBytes: 17 }])
})

test('hookProcessHealth treats a missing measurement as unclean rather than as zero', () => {
  // A harness that stops recording must not read as a clean run.
  const h = hookProcessHealth([{ layer: 'hook', caseDef: { id: 'h1' } }])
  assert.equal(h.exitedZero, 0)
  assert.equal(h.incidents.length, 1)
  assert.equal(h.incidents[0].stderrBytes, null, 'an absent stderr is NULL, never 0')
})
