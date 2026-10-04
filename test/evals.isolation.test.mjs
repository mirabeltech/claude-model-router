/**
 * The architecture rules of the evaluation framework, enforced statically.
 *
 * A COMMENT IS NOT ENFORCEMENT. Three promises hold this framework together, and all three are the
 * kind that decay silently under maintenance, so each is a grep rather than a convention:
 *
 *   1. THE EVAL WRITES NOTHING. It calls `buildEvent()` and never `emitEvent()`, so no telemetry
 *      sink is opened, no salt file is created, and the user's production store is never touched.
 *      The import graph is the proof: reaching `telemetry/index.mjs` is how that would start.
 *
 *   2. THE EVAL NEVER READS THE USER'S CONFIG. `loadConfig()` reads `~/.claude/model-router/
 *      config.json` and `process.env`, either of which would make a benchmark number depend on the
 *      machine it ran on. Only `resolveConfig` with an explicit layer is allowed.
 *
 *   3. NO `?? 0` DOWNSTREAM OF A MEASUREMENT. `aggregate.mjs` is explicit that an unavailable Agg
 *      must never render as $0.00, and `formatAgg` takes the whole Agg so it cannot. But printing
 *      `agg.value` directly throws on null, and the reflex fix is `?? 0` — which renders "we do not
 *      know" as "zero" and is the exact overstatement the project exists to avoid.
 *
 * This file follows the precedent of `telemetry.isolation.test.mjs`, which pins the purity of
 * `calc.mjs` and the dispatch layer the same way.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { importsOf } from './helpers/imports.mjs'

import { REPO_ROOT } from './evals/load.mjs'

const EVALS_DIR = path.join(REPO_ROOT, 'test', 'evals')

/** Every `.mjs` under `test/evals/`, including `bin/`. */
function evalFiles(dir = EVALS_DIR, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...evalFiles(path.join(dir, entry.name), rel))
    else if (entry.name.endsWith('.mjs')) out.push(rel)
  }
  return out.sort()
}

const read = (rel) => fs.readFileSync(path.join(EVALS_DIR, rel), 'utf8')

/*
 * Import scanning is shared: see test/helpers/imports.mjs. It is a lexer rather than a regex, and
 * a measured strict superset of the four local copies that used to exist — this one missed nothing,
 * so the swap changed no result here.
 */
const FILES = evalFiles()

test('the framework holds the files these rules cover', () => {
  // A scan over a stale list passes by scanning nothing — the same trap `telemetry.isolation`
  // guards with its "holds exactly the files the rules cover" test.
  assert.ok(FILES.length >= 12, `only ${FILES.length} modules found under test/evals/`)
  for (const expected of [
    'schema.mjs', 'load.mjs', 'evaluators.mjs', 'gates.mjs', 'config.mjs', 'pricing.mjs',
    'row.mjs', 'determinism.mjs', 'metrics.mjs', 'sweep.mjs', 'harness.mjs', 'report.mjs',
    'fixture-worker.mjs', 'routing.mjs', 'bin/run.mjs', 'bin/build-corpus.mjs',
  ]) {
    assert.ok(FILES.includes(expected), `${expected} is missing from test/evals/`)
  }
})

/* --------------------------------------------------------- 1. the eval writes nothing */

test('no eval module reaches the telemetry sink, the salt, or the store', () => {
  // These three are how a write would begin. `buildEvent` and the pure read-side modules are fine;
  // the facade, the identity layer and the sink are not.
  const FORBIDDEN = Object.freeze(['telemetry/index.mjs', 'telemetry/identity.mjs', 'telemetry/jsonl.mjs', 'telemetry/null-sink.mjs'])
  const reaching = []
  for (const file of FILES) {
    for (const spec of importsOf(read(file))) {
      for (const forbidden of FORBIDDEN) {
        if (spec.includes(forbidden)) reaching.push(`${file} -> ${spec}`)
      }
    }
  }
  assert.deepEqual(reaching, [], 'an eval row must never be written to the user telemetry store')
})

test('no eval module calls emitEvent, openSink or buildIdentity', () => {
  // The import check above is the structural guarantee; this one catches a re-export or a
  // destructure that smuggles the symbol in under another name.
  const offenders = []
  for (const file of FILES) {
    const source = read(file)
    for (const symbol of ['emitEvent', 'openSink', 'openStore', 'buildIdentity', 'readOrCreateSalt']) {
      // Allow the word inside a comment, since several files explain WHY they do not call these.
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(stripped)) offenders.push(`${file} calls ${symbol}()`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('the only telemetry entry point the eval uses is buildEvent', () => {
  const source = read('row.mjs')
  assert.match(source, /import \{ buildEvent \} from/, 'row.mjs must build its rows with the shipped builder')
})

/* ------------------------------------------- 2. the eval never reads the user config */

test('no eval module calls loadConfig', () => {
  // `loadConfig` reads ~/.claude/model-router/config.json and process.env. A developer with
  // `minLines: 50`, or a CMR_MIN_BYTES in CI, would silently get different benchmark numbers.
  const offenders = []
  for (const file of FILES) {
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
    if (/\bloadConfig\s*\(/.test(stripped)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], 'the eval must build configs from DEFAULTS through resolveConfig')
})

test('no eval module reads process.env for a setting', () => {
  // The env layer is declared in SPEC and tested there. An eval reading it directly would bypass
  // the layering and make a result depend on the shell it ran in. `process.argv`, `process.platform`
  // and the runner's own TEMP lookup are legitimate and excluded by name.
  const ALLOWED = Object.freeze(new Set(['bin/run.mjs', 'bin/build-corpus.mjs', 'harness.mjs']))
  const offenders = []
  for (const file of FILES) {
    if (ALLOWED.has(file)) continue
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
    if (/process\.env\./.test(stripped)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], 'only the runner and the harness may consult the environment, and only for paths')
})

test('the config builder starts from DEFAULTS with an empty env', () => {
  const source = read('config.mjs')
  assert.match(source, /resolveConfig\(\{\s*layers:/, 'it must go through the real resolver')
  assert.match(source, /env:\s*\{\}/, 'with an empty env, so no CMR_ variable can reach it')
})

/* -------------------------------------------------- 3. no zero-for-null substitution */

test('no eval module substitutes zero for a missing measurement', () => {
  // `?? 0` and `|| 0` are the two spellings. Both turn "unavailable" into "zero", which understates
  // worker cost or overstates savings depending on the column.
  const offenders = []
  for (const file of FILES) {
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
    for (const m of stripped.matchAll(/\?\?\s*0\b|\|\|\s*0\b/g)) {
      offenders.push(`${file}: ${m[0]}`)
    }
  }
  assert.deepEqual(offenders, [], 'a missing measurement is NULL, never 0')
})

test('the renderer prints aggregates through formatAgg, never a bare value', () => {
  // `formatAgg` takes the whole Agg so coverage and basis travel with every number, and so an
  // unavailable Agg renders as "unavailable" rather than as $0.00.
  const source = read('report.mjs')
  assert.match(source, /formatAgg\(/, 'the report must use the shipped formatter')
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
  assert.equal(/\.value\.toFixed/.test(stripped), false, 'formatting a raw Agg value crashes on null')
})

test('the framework recomputes no savings of its own', () => {
  // The brief is explicit: reuse the Phase 2 math, implement no second calculation. `1e6` is the
  // pricing constant and `/ 4` is the chars-per-token estimate; both belong to calc.mjs alone.
  const MATH_DIR = Object.freeze(['metrics.mjs', 'sweep.mjs', 'row.mjs', 'report.mjs', 'determinism.mjs'])
  for (const file of MATH_DIR) {
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
    assert.equal(/1e6|1_000_000/.test(stripped), false, `${file} contains a pricing divisor; pricing belongs to calc.mjs`)
    assert.equal(/\/\s*4\b/.test(stripped), false, `${file} divides by 4; the token estimate belongs to calc.mjs`)
  }
})

test('the metrics layer imports its aggregation rather than reimplementing it', () => {
  const source = read('metrics.mjs')
  assert.match(source, /from '\.\.\/\.\.\/plugins\/model-router\/lib\/telemetry\/aggregate\.mjs'/)
  assert.equal(/function sumStrict|function addAgg/.test(source), false, 'no second null-strict sum')
})

/* -------------------------------------------------------------- purity of the core */

test('the pure modules import no node builtin', () => {
  // `schema.mjs` and `evaluators.mjs` are tables and string functions. A `node:` import is the
  // cheapest exact proxy for the filesystem, network or clock dependency they must not acquire.
  for (const file of ['schema.mjs', 'evaluators.mjs']) {
    const source = read(file)
    const builtins = importsOf(source).filter((s) => s.startsWith('node:'))
    assert.deepEqual(builtins, [], `${file} must stay pure`)
    assert.equal(/import\(\s*['"]node:/.test(source), false, `${file} must not dynamically import a builtin`)
  }
})

test('no eval module spawns a shell except the harness, which drives the real hook', () => {
  // The hook must be exercised as a real child process — the process boundary has failure modes an
  // in-process call cannot see — but that is the ONLY reason to spawn anything, and it goes through
  // the existing `runHookProcess` helper rather than a second spawner.
  const offenders = []
  for (const file of FILES) {
    for (const spec of importsOf(read(file))) {
      if (/child_process/.test(spec)) offenders.push(`${file} -> ${spec}`)
    }
  }
  assert.deepEqual(offenders, [], 'the harness must reuse runHookProcess rather than spawning directly')
  assert.match(read('harness.mjs'), /runHookProcess/, 'and the harness must use it')
})

test('the eval depends on the plugin and the plugin never depends on the eval', () => {
  // The dependency runs one way only. A plugin module importing from test/evals/ would ship eval
  // code to every user and make the plugin unbuildable standalone.
  const libDir = path.join(REPO_ROOT, 'plugins', 'model-router')
  const reaching = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name.endsWith('.mjs')) {
        for (const spec of importsOf(fs.readFileSync(abs, 'utf8'))) {
          if (/test\/evals|test\\evals/.test(spec)) reaching.push(`${path.relative(REPO_ROOT, abs)} -> ${spec}`)
        }
      }
    }
  }
  walk(libDir)
  assert.deepEqual(reaching, [])
})

test('no eval module writes outside a scratch directory or the corpus build', () => {
  // Only the corpus generator writes into the repo, and only under test/fixtures/evals/. Everything
  // else writes to a mkdtemp scratch that is removed in a finally.
  const WRITERS = Object.freeze(new Set(['bin/build-corpus.mjs', 'bin/run.mjs', 'load.mjs', 'harness.mjs']))
  const offenders = []
  for (const file of FILES) {
    if (WRITERS.has(file)) continue
    const stripped = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
    if (/writeFileSync|writeSync|appendFileSync|mkdirSync|rmSync/.test(stripped)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], 'only the generator, the runner, the loader and the harness may write')
})
