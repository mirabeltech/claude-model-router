/**
 * Static architecture rules for the analytics layer.
 *
 * These are the claims docs/analytics.md makes about layering, and PROSE CANNOT ENFORCE A
 * LAYERING RULE. A comment saying "this module imports no provider" is a comment; six months from
 * now a well-meaning import will land next to it and the comment will still be there.
 *
 * The three things this file proves, in order of how badly they would be missed:
 *
 *   1. ANALYTICS COMPUTES NO MONEY. Cost was priced once at write time and stamped with its
 *      pricing version; a second pricing implementation anywhere in this layer would re-price
 *      history against today's table and report a figure for a bill nobody was ever sent.
 *   2. ANALYTICS IS NOT ON THE HOT PATH. It may read telemetry and config; it may not touch a
 *      provider, the hook, the dispatcher or governance, and nothing in those layers may reach
 *      back into it.
 *   3. ANALYTICS NEVER SURFACES CONTENT. The three content columns appear in exactly one place —
 *      the list that forbids them.
 *
 * It follows the pattern of test/governance.isolation.test.mjs, including the directory census,
 * which is the most important test in the file: without it every other rule here could pass while
 * scanning nothing at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { importsOf } from './helpers/imports.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const LIB = path.join(REPO_ROOT, 'plugins', 'model-router', 'lib')
const ANALYTICS_DIR = path.join(LIB, 'analytics')

/** Source with comments removed, so a MENTION of something is never counted as a USE of it. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/*
 * Import scanning is shared: see test/helpers/imports.mjs. It is a lexer rather than a regex, and
 * a measured strict superset of the four local copies that used to exist — this one missed nothing,
 * so the swap changed no result here.
 */
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8')
const source = (file) => stripComments(read(ANALYTICS_DIR, file))

/**
 * The analytics layer, file by file, with what each is ALLOWED to import.
 *
 * Exact specifiers rather than basenames: `index.mjs` and `contract.mjs` each exist in three
 * different directories in this repo, so a basename check would silently permit the wrong one.
 */
const ANALYTICS_LAYER = Object.freeze({
  // Pure tables. Imports the schema vocabulary and the null-key sentinel, nothing else.
  'schema.mjs': Object.freeze(['../telemetry/record.mjs', '../telemetry/aggregate.mjs']),
  // Calendar arithmetic. Imports NOTHING, so every edge case is testable against a frozen number.
  'window.mjs': Object.freeze([]),
  'select.mjs': Object.freeze(['./window.mjs', './schema.mjs']),
  'predicates.mjs': Object.freeze(['../telemetry/record.mjs', '../telemetry/aggregate.mjs', './schema.mjs']),
  // The streaming restatement of the fold. Imports the module it must stay equal to.
  'aggregates.mjs': Object.freeze(['../telemetry/aggregate.mjs', './schema.mjs']),
  'metrics.mjs': Object.freeze([
    '../telemetry/aggregate.mjs',
    './aggregates.mjs',
    './predicates.mjs',
    './schema.mjs',
    './serialize.mjs',
    './window.mjs',
  ]),
  'segments.mjs': Object.freeze([
    '../telemetry/aggregate.mjs',
    './aggregates.mjs',
    './predicates.mjs',
    './schema.mjs',
    './window.mjs',
  ]),
  'quality.mjs': Object.freeze(['./predicates.mjs', './schema.mjs']),
  'serialize.mjs': Object.freeze(['../telemetry/aggregate.mjs', './aggregates.mjs', './schema.mjs']),
  'text.mjs': Object.freeze(['../telemetry/aggregate.mjs', './schema.mjs']),
  // Composition, plus the one store-facing call. It owns the order of operations and nothing else.
  'index.mjs': Object.freeze([
    '../telemetry/record.mjs',
    '../telemetry/aggregate.mjs',
    '../telemetry/index.mjs',
    './metrics.mjs',
    './quality.mjs',
    './schema.mjs',
    './segments.mjs',
    './select.mjs',
    './serialize.mjs',
    './window.mjs',
  ]),
})

const FILES = Object.keys(ANALYTICS_LAYER)

/* ------------------------------------------------------------------- census */

test('the analytics layer holds exactly the files these rules cover', () => {
  // A new file added to the directory must be classified deliberately. Without this, every other
  // test in this file could pass while scanning nothing at all.
  const onDisk = fs
    .readdirSync(ANALYTICS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
  assert.deepEqual(onDisk, [...FILES].sort())
})

test('every analytics file imports only what it is allowed to', () => {
  const violations = []
  for (const [file, allowed] of Object.entries(ANALYTICS_LAYER)) {
    for (const spec of importsOf(source(file))) {
      if (!allowed.includes(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'an unapproved import in the analytics layer')
})

/* --------------------------------------------------- analytics -> telemetry */

test('analytics reads the telemetry layer, which is the one dependency it is meant to have', () => {
  // A positive pin as well as a negative one: a layer that imported nothing at all would pass
  // every forbidden-reach test below while having stopped doing its job.
  const reaching = []
  for (const file of FILES) {
    for (const spec of importsOf(source(file))) {
      if (spec.includes('telemetry/')) reaching.push(`${file} -> ${spec}`)
    }
  }
  assert.ok(reaching.length >= 6, `analytics should read telemetry; found ${reaching.length} edges`)
})

test('analytics builds every aggregate through the shipped fold, never its own', () => {
  // A mirrored coverage model would have its own tests, would pass them, and would drift from
  // the one `aggregate()` uses. There is one implementation of the NULL-is-not-zero rule.
  assert.match(source('aggregates.mjs'), /from '\.\.\/telemetry\/aggregate\.mjs'/)
  assert.match(source('aggregates.mjs'), /export \{\s*aggInit/)
})

test('every aggregate reaches a screen through formatAgg, never through a bare value', () => {
  // formatAgg takes the whole Agg precisely so a caller cannot bypass the coverage information
  // that makes the number honest. An `unavailable` Agg must never render as $0.0000.
  assert.match(source('serialize.mjs'), /formatAgg\(/)
  const violations = []
  for (const file of FILES) {
    if (file === 'serialize.mjs' || file === 'text.mjs') continue
    if (/\.value\.toFixed/.test(source(file))) violations.push(`${file} formats a raw value`)
  }
  assert.deepEqual(violations, [], 'formatting a raw Agg value crashes on NULL')
})

/* ------------------------------------------------------- the forbidden reach */

test('analytics never imports a provider', () => {
  const violations = []
  for (const file of FILES) {
    for (const spec of importsOf(source(file))) {
      if (/provider/i.test(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'analytics must not import a provider')
})

test('analytics never imports the hook, the dispatcher, governance or the router', () => {
  const violations = []
  for (const file of FILES) {
    for (const spec of importsOf(source(file))) {
      if (/\bhook\b|dispatch|governance|routing|context-budget|globs|redact/i.test(spec)) {
        violations.push(`${file} imports ${spec}`)
      }
    }
  }
  assert.deepEqual(violations, [], 'analytics reached into a layer it must not know about')
})

test('analytics never imports a pricing module or the calc layer', () => {
  // THE MOST IMPORTANT ONE. Cost was computed once at write time and stamped with its pricing
  // version. Re-pricing a historical row against today's table would produce a number for a bill
  // that was never incurred.
  const violations = []
  for (const file of FILES) {
    for (const spec of importsOf(source(file))) {
      if (/pricing|calc\.mjs/i.test(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'analytics must not be able to price anything')
})

test('analytics contains no pricing arithmetic of its own', () => {
  // The import ban is the structural guarantee; this catches a hand-rolled copy that imports
  // nothing. A per-million divisor or a chars/4 estimate here would be a second methodology.
  const violations = []
  for (const file of FILES) {
    const src = source(file)
    for (const banned of ['perMTok', 'resolveRates', 'calculateCost', 'priceTokens', '1e6', '1_000_000']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'analytics must not compute money')
})

test('analytics performs no network I/O', () => {
  const violations = []
  for (const file of FILES) {
    const src = source(file)
    for (const banned of ['fetch(', 'XMLHttpRequest', 'node:http', 'node:https', 'node:net', 'node:tls', 'WebSocket']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'analytics must not reach the network')
})

test('analytics spawns nothing and evaluates nothing', () => {
  const violations = []
  for (const file of FILES) {
    const src = source(file)
    for (const banned of ['child_process', 'spawn(', 'execSync', 'eval(', 'new Function']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'analytics must not spawn or evaluate')
})

/* ------------------------------------------------------------------ purity */

test('no analytics module imports a node builtin, so the whole engine is pure', () => {
  // Achievable because openStoreFromConfig() defaults its own `fs`. The payoff is that every
  // metric in this layer is unit-testable from an in-memory array, with no store and no clock.
  const violations = []
  for (const file of FILES) {
    for (const spec of importsOf(source(file))) {
      if (spec.startsWith('node:')) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'the analytics layer must stay free of node builtins')
})

test('analytics writes nothing, not even a directory it is about to report on', () => {
  // A reporting tool that created the store directory in order to tell you it was empty would
  // quietly falsify the thing it was reporting on.
  const violations = []
  for (const file of FILES) {
    const src = source(file)
    if (/writeFileSync|writeSync|appendFileSync|mkdirSync|rmSync|unlinkSync|openSync/.test(src)) {
      violations.push(file)
    }
  }
  assert.deepEqual(violations, [], 'analytics must never write')
})

test('analytics never builds an identity, which is the only writer on the read path', () => {
  // buildIdentity() creates the salt file. Calling it from a read would make a read-only command
  // write, on the first run, in the one place nobody would look.
  const violations = []
  for (const file of FILES) {
    const src = source(file)
    for (const symbol of ['buildIdentity', 'readOrCreateSalt', 'emitEvent', 'openSink']) {
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(src)) violations.push(`${file} calls ${symbol}()`)
    }
  }
  assert.deepEqual(violations, [], 'analytics called into the write path')
})

test('analytics reads no CMR_ environment variable directly', () => {
  // Config layering is tested in config.mjs; a second reader would bypass it.
  const violations = []
  for (const file of FILES) {
    const hits = [...source(file).matchAll(/CMR_[A-Z0-9_]+/g)].map((m) => m[0])
    for (const hit of hits) violations.push(`${file} reads ${hit}`)
  }
  assert.deepEqual(violations, [], 'a setting with a SPEC entry was read from the environment')
})

test('analytics reads process.env nowhere at all', () => {
  const violations = []
  for (const file of FILES) {
    if (source(file).includes('process.env')) violations.push(file)
  }
  assert.deepEqual(violations, [], 'analytics must take its configuration as an argument')
})

/* -------------------------------------------------------------- determinism */

test('analytics uses no random source, so the same store always gives the same answer', () => {
  // Reservoir sampling would have bounded the latency memory exactly and was rejected for this:
  // a p95 that moves between two runs of the same input cannot be used as evidence.
  const violations = []
  for (const file of FILES) {
    const src = source(file)
    if (/Math\.random|crypto\.randomUUID|randomBytes/.test(src)) violations.push(file)
  }
  assert.deepEqual(violations, [], 'analytics must be reproducible')
})

test('analytics reads no clock of its own; the clock is always injected', () => {
  // A report that silently used the wall clock could not be reproduced, and --now exists so a
  // fixture-dated store can be analyzed at all.
  const violations = []
  for (const file of FILES) {
    if (/Date\.now\(\)/.test(source(file))) violations.push(file)
  }
  assert.deepEqual(violations, [], 'the clock must be a parameter, never ambient')
})

/* ---------------------------------------------------------------- the zeros */

test('the analytics layer never defaults an unknown measurement to zero', () => {
  // The reflex fix for a null is `?? 0`, and it is wrong in every direction that matters: it
  // understates the worker bill or overstates savings, and it does so plausibly.
  //
  // THE EXEMPTIONS ARE BY NAME, NOT BY PATTERN. Three readings of "absent" genuinely are zero,
  // and each is behind a named helper so this list stays short and auditable rather than growing
  // into a regex that quietly permits the real thing it is meant to catch:
  //
  //   `countSeen`    — a reader counter that was not reported: it saw none of them.
  //   `bucketCount`  — an absent histogram key: that bucket is empty.
  //   `.get(k) ?? 0` — incrementing a counting Map for a key seen for the first time.
  //
  // Every one of those counts ROWS. None of them stands in for a measured quantity.
  const EXEMPT = /countSeen\(|bucketCount\(|\.get\([^)]*\) \?\? 0\) \+ 1/
  const offenders = []
  for (const file of FILES) {
    for (const line of source(file).split('\n')) {
      if (!/\?\?\s*0\b/.test(line) && !/\|\|\s*0\b/.test(line)) continue
      if (EXEMPT.test(line)) continue
      offenders.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], 'an unknown measurement must stay null, never become 0')
})

test('an unknown never sorts as zero in the negative-examples ordering', () => {
  // MEASURED before the fix: the comparator used `?? 0`, which ranked a row whose cash net is
  // UNKNOWN between the negative and positive dollar cases — putting it among the worst
  // offenders on the strength of a measurement nobody took. An unknown sorts last instead.
  const src = source('metrics.mjs')
  assert.match(src, /const worstFirst = /)
  assert.match(src, /POSITIVE_INFINITY/)
  assert.equal(/estimated_net_savings \?\? 0/.test(src), false)
})

/* --------------------------------------------------------------- content */

test('no analytics module names a content column except the list that forbids it', () => {
  // question_text and error_message_safe can hold text a developer typed or a provider returned;
  // project_path is a filesystem path. None is an analytics input.
  const offenders = []
  for (const file of FILES) {
    if (file === 'schema.mjs') continue // FORBIDDEN_FIELDS is declared there, by definition.
    const src = source(file)
    for (const field of ['question_text', 'error_message_safe', 'project_path']) {
      if (src.includes(field)) offenders.push(`${file} names ${field}`)
    }
  }
  assert.deepEqual(offenders, [], 'a content column was named outside the list that forbids it')
})

test('schema.mjs names the content columns only inside FORBIDDEN_FIELDS', () => {
  const src = source('schema.mjs')
  const forbiddenBlock = src.match(/FORBIDDEN_FIELDS\s*=\s*Object\.freeze\(\[[^\]]*\]\)/)
  assert.ok(forbiddenBlock, 'the forbidden list must be a literal, so this test can find it')
  const elsewhere = src.replace(forbiddenBlock[0], '')
  for (const field of ['question_text', 'error_message_safe', 'project_path']) {
    assert.equal(elsewhere.includes(field), false, `${field} appears outside FORBIDDEN_FIELDS`)
  }
})

/* ------------------------------------------------------------- the callers */

test('nothing on the hot path reaches into analytics', () => {
  // The engine is a reader. If the hook ever imported it, a dashboard concern would be running
  // inside a PreToolUse hook with a 60-second budget and a fail-open contract.
  const callers = []
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'analytics') walk(next, path.join(rel, entry.name))
        continue
      }
      if (!entry.name.endsWith('.mjs')) continue
      const src = stripComments(fs.readFileSync(next, 'utf8'))
      if (importsOf(src).some((spec) => /analytics/.test(spec))) {
        callers.push(path.join(rel, entry.name).split(path.sep).join('/'))
      }
    }
  }
  walk(LIB)
  assert.deepEqual(callers.sort(), [], 'no module under lib/ may import analytics')
})

test('analytics is reached only from the scripts that report', () => {
  const callers = []
  const scripts = path.join(REPO_ROOT, 'plugins', 'model-router', 'scripts')
  for (const entry of fs.readdirSync(scripts, { withFileTypes: true })) {
    if (!entry.name.endsWith('.mjs')) continue
    const src = stripComments(fs.readFileSync(path.join(scripts, entry.name), 'utf8'))
    if (importsOf(src).some((spec) => /analytics/.test(spec))) callers.push(entry.name)
  }
  assert.deepEqual(callers.sort(), ['analytics.mjs'], 'analytics gained an unexpected caller')
})

/* ---------------------------------------------------------- the one-way edge */

test('the telemetry layer never depends on analytics', () => {
  // Analytics is built on telemetry, so the edge has to run one way only. A cycle would put a
  // reporting concern inside the module the hook writes through.
  const reaching = []
  const telemetry = path.join(LIB, 'telemetry')
  for (const entry of fs.readdirSync(telemetry, { withFileTypes: true })) {
    if (!entry.name.endsWith('.mjs')) continue
    const src = stripComments(fs.readFileSync(path.join(telemetry, entry.name), 'utf8'))
    for (const spec of importsOf(src)) {
      if (/analytics/.test(spec)) reaching.push(`${entry.name} -> ${spec}`)
    }
  }
  assert.deepEqual(reaching, [], 'the telemetry layer must not know analytics exists')
})

test('aggregate.mjs stayed pure through the fold refactor', () => {
  // The fold was extracted so analytics could stream through it. If that refactor had dragged a
  // node builtin into aggregate.mjs, the whole read model would have stopped being unit-testable.
  const src = stripComments(read(LIB, 'telemetry', 'aggregate.mjs'))
  const builtins = importsOf(src).filter((s) => s.startsWith('node:'))
  assert.deepEqual(builtins, [], 'aggregate.mjs must never gain a node import')
  assert.match(src, /export function aggMerge/)
  assert.match(src, /export function aggregate\(rows, extract\)/, 'the batch signature is unchanged')
})
