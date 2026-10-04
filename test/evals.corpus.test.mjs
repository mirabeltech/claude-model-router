/**
 * The committed corpus, and the drift checks that keep it honest.
 *
 * Every case declares the byte and line count of its fixtures, and this file is where the disk gets
 * to disagree. Without these checks the corpus README and `case.json` become a second and third
 * copy of a number nobody re-measures — which is the exact failure mode `gen-config-schema.mjs`
 * and `config.schema.test.mjs` already guard for the config schema. Same discipline, same shape.
 *
 * The check that earns its keep most is `accidental_deny_glob`. `**\/security\/**` and
 * `**\/auth\/**` match ANY path segment, case-insensitively, INCLUDING the case directory's own
 * name — so a case directory called `security/` would make every file inside it deny-globbed on the
 * directory, and the case would pass for a reason that has nothing to do with what it claims to
 * test. A corpus can be quietly worthless that way.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CORPUS_DIR, corpusFingerprint, corpusTable, loadCorpus, PROMPT_CEILING_BYTES } from './evals/load.mjs'
import { CONTENT_SHAPES, EVAL_SCHEMA_VERSION } from './evals/schema.mjs'
import { evalConfig } from './evals/config.mjs'
import { runDecideCase } from './evals/routing.mjs'
import { DEFAULTS } from '../plugins/model-router/lib/config.mjs'
import { matchesAny, normalizeSlashes } from '../plugins/model-router/lib/globs.mjs'

let scratch
let corpus

test.before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-corpus-'))
  corpus = loadCorpus({ scratchDir: scratch })
})

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('the committed corpus loads with no errors', () => {
  // The single most important assertion in this file. Every bytes_mismatch, lines_mismatch,
  // undeclared_file, path_escape and accidental_deny_glob lands here, named, with its case id.
  assert.deepEqual(corpus.errors, [], `corpus errors:\n  ${corpus.errors.join('\n  ')}`)
  assert.ok(corpus.cases.length > 0, 'an empty corpus would make every other assertion vacuous')
})

test('the corpus loads with no warnings, so every category and shape is a known one', () => {
  assert.deepEqual(corpus.warnings, [], corpus.warnings.join(' | '))
})

test('every declared content shape is covered by at least one case', () => {
  // Listing a shape without a case is how a corpus comes to claim coverage it does not have, so
  // adding to CONTENT_SHAPES fails this test until a case exists.
  const covered = new Set(corpus.cases.flatMap((c) => c.shapes))
  const missing = CONTENT_SHAPES.filter((s) => !covered.has(s))
  assert.deepEqual(missing, [], `shapes with no case: ${missing.join(', ')}`)
})

test('the corpus covers both sides of the gate', () => {
  // A corpus of nothing but refusals would pass every routing assertion against a gate that never
  // delegates, and a corpus of nothing but delegations against one that always does.
  const delegate = corpus.cases.filter((c) => c.expected.class === 'delegate')
  const primary = corpus.cases.filter((c) => c.expected.class === 'primary')
  assert.ok(delegate.length >= 3, `only ${delegate.length} delegating cases`)
  assert.ok(primary.length >= 3, `only ${primary.length} primary cases`)
})

test('every harness layer is exercised', () => {
  const layers = new Set(corpus.cases.map((c) => c.harness))
  for (const want of ['decide', 'hook', 'dispatch']) {
    assert.ok(layers.has(want), `no case runs at the ${want} layer`)
  }
})

/* --------------------------------------------- the engine agrees, case by case */

test('the real decide() agrees with every case expectation, field by field', () => {
  // This is the corpus's whole claim: that these declared outcomes are the engine's outcomes. A
  // failure here means either the engine changed or a case was written from intuition rather than
  // from the refusal order.
  const disagreements = []
  for (const caseDef of corpus.cases) {
    if (caseDef.harness === 'hook') continue // driven as a child process in evals.harness.test.mjs
    const config = evalConfig(caseDef.config ?? {}, { projectDir: scratch })
    const r = runDecideCase({
      caseDef,
      absPaths: corpus.absPaths.get(caseDef.id),
      projectDir: scratch,
      config,
    })
    if (!r.agrees) disagreements.push(`${caseDef.id}: ${r.mismatches.join('; ')}`)
  }
  assert.deepEqual(disagreements, [], `\n  ${disagreements.join('\n  ')}`)
})

/* ---------------------------------------------- layout cannot do the deciding */

test('no case passes on its own layout rather than on what it tests', () => {
  // The accidental_deny_glob rule, asserted from the outside as well as inside the loader: a case
  // id or a fixture path that trips a shipped deny glob makes the case refuse for the wrong reason.
  for (const caseDef of corpus.cases) {
    const intended = caseDef.expected.reason === 'deny_glob'
    const probes = [`${caseDef.id}/case.json`, ...caseDef.files.map((f) => `${caseDef.id}/${f.path}`)]
    for (const probe of probes) {
      const hit = matchesAny(DEFAULTS.routing.denyGlobs, normalizeSlashes(probe))
      if (hit !== null && !intended) {
        assert.fail(`${caseDef.id}: "${probe}" matches the shipped deny glob "${hit}"`)
      }
    }
  }
})

test('no dispatch case would exceed the provider payload ceiling', () => {
  // mock caps a payload at 64000 bytes and rejects above it at the PROVIDER, not at the gate.
  // Without this a contributor adding a 70 KB fixture sees `payload_too_large` and blames the
  // provider rather than the fixture.
  for (const caseDef of corpus.cases) {
    if (caseDef.harness !== 'dispatch') continue
    const loaded = loadCorpus({ scratchDir: scratch })
    assert.ok(loaded.errors.every((e) => !e.startsWith('prompt_over_provider_ceiling')), loaded.errors.join(' | '))
  }
  assert.ok(PROMPT_CEILING_BYTES < 64_000, 'the ceiling must sit below the provider cap, with headroom')
})

/* ----------------------------------------------- the generated artefacts agree */

test('corpus.json carries the fingerprint of the corpus actually on disk', () => {
  // Otherwise corpusVersion is a number somebody forgets to bump, which is to say decoration.
  const declared = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'corpus.json'), 'utf8'))
  assert.equal(declared.schemaVersion, EVAL_SCHEMA_VERSION)
  assert.equal(declared.cases, corpus.cases.length)
  assert.equal(
    declared.fingerprint,
    corpusFingerprint(corpus.cases),
    'corpus.json is stale; run node test/evals/bin/build-corpus.mjs',
  )
})

test('the corpus README table matches the corpus, so it cannot drift', () => {
  const readme = fs.readFileSync(path.join(CORPUS_DIR, 'README.md'), 'utf8').replace(/\r\n/g, '\n')
  const table = corpusTable(corpus.cases)
  assert.ok(
    readme.includes(table),
    'the README table is stale; run node test/evals/bin/build-corpus.mjs',
  )
})

test('the fingerprint changes when anything the corpus declares changes', () => {
  // A fingerprint that does not move is worse than none: it certifies staleness.
  const base = corpusFingerprint(corpus.cases)
  const bumped = corpus.cases.map((c, i) => (i === 0 ? { ...c, caseVersion: c.caseVersion + 1 } : c))
  assert.notEqual(corpusFingerprint(bumped), base, 'a caseVersion bump must move the fingerprint')

  const resized = corpus.cases.map((c, i) =>
    i === 0 && c.files.length > 0 ? { ...c, files: [{ ...c.files[0], bytes: c.files[0].bytes + 1 }] } : c,
  )
  assert.notEqual(corpusFingerprint(resized), base, 'a byte-count change must move the fingerprint')
})

test('the fingerprint does not depend on case order', () => {
  const reversed = [...corpus.cases].reverse()
  assert.equal(corpusFingerprint(reversed), corpusFingerprint(corpus.cases))
})

/* ------------------------------------------------------------- fixture hygiene */

test('no fixture carries a credential-shaped string except the one case that declares it', () => {
  // The corpus must not contain secrets or user data. Exactly one case plants a non-credential, and
  // it says so in `safety.plantedSecret`; anything else matching these shapes is an accident.
  const SHAPES = Object.freeze([/sk-ant-[A-Za-z0-9_-]{8,}/, /AIza[A-Za-z0-9_-]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/])
  for (const caseDef of corpus.cases) {
    const declared = caseDef.safety?.plantedSecret ?? null
    for (const [rel, content] of corpus.contents.get(caseDef.id) ?? []) {
      for (const shape of SHAPES) {
        const m = content.match(shape)
        assert.equal(m, null, `${caseDef.id}/${rel} contains a ${shape} shaped string`)
      }
      if (declared !== null) continue
      assert.equal(
        /api[_-]?key\s*=\s*["'][^"']{12,}/i.test(content),
        false,
        `${caseDef.id}/${rel} looks like it holds a key but declares no safety.plantedSecret`,
      )
    }
  }
})

test('the one planted literal is unmistakably not a real credential', () => {
  const planting = corpus.cases.filter((c) => c.safety?.plantedSecret !== null && c.safety?.plantedSecret !== undefined)
  assert.equal(planting.length, 1, 'exactly one case should plant a secret')
  const secret = planting[0].safety.plantedSecret
  assert.match(secret, /FAKE|DO-NOT-USE|EXAMPLE/i, `${secret} must read as a non-credential to a human and a scanner`)
})

test('a case that plants a secret must account for the outbound exposure', () => {
  // Nothing redacts outbound file content, so a planted secret leaves the machine unless a deny
  // glob stops the read. The case has to say which of those it is.
  for (const caseDef of corpus.cases) {
    if ((caseDef.safety?.plantedSecret ?? null) === null) continue
    const deniedBy = matchesAny(DEFAULTS.routing.denyGlobs, normalizeSlashes(caseDef.files[0]?.path ?? ''))
    const declared = caseDef.safety?.knownExposure ?? null
    assert.ok(
      deniedBy !== null || declared !== null,
      `${caseDef.id} plants a secret but neither matches a deny glob nor declares safety.knownExposure`,
    )
  }
})

test('every generated fixture materialises to exactly the bytes and lines it declares', () => {
  // The loader already checks this; asserting it here too means a change to the materialiser is
  // caught by a named test rather than by a corpus-wide error list.
  for (const caseDef of corpus.cases) {
    const contents = corpus.contents.get(caseDef.id) ?? new Map()
    for (const file of caseDef.files) {
      if (file.source !== 'generated') continue
      const text = contents.get(file.path)
      assert.equal(Buffer.byteLength(text, 'utf8'), file.bytes, `${caseDef.id}/${file.path} bytes`)
      assert.equal(file.generator.repeat, file.lines, `${caseDef.id}/${file.path}: lines must equal repeat`)
    }
  }
})

test('a generated fixture is never also committed, because git would rewrite its line endings', () => {
  for (const caseDef of corpus.cases) {
    for (const file of caseDef.files) {
      if (file.source !== 'generated') continue
      const onDisk = path.join(CORPUS_DIR, caseDef.id, file.path)
      assert.equal(fs.existsSync(onDisk), false, `${caseDef.id}/${file.path} is declared generated but exists on disk`)
    }
  }
})

test('every dispatch case ships a canned answer', () => {
  for (const caseDef of corpus.cases) {
    if (caseDef.harness !== 'dispatch') continue
    const answer = path.join(CORPUS_DIR, caseDef.id, 'answers', 'default.md')
    assert.ok(fs.existsSync(answer), `${caseDef.id} has no answers/default.md, so the deterministic arm cannot run it`)
  }
})

/* --------------------------------------------------- the loader cannot explode */

test('the loader never throws, whatever it is pointed at', () => {
  for (const dir of [path.join(scratch, 'does-not-exist'), scratch, CORPUS_DIR]) {
    const r = loadCorpus({ scratchDir: scratch, dir })
    assert.ok(Array.isArray(r.errors), `${dir} must yield an error list rather than an exception`)
    assert.ok(Array.isArray(r.cases))
  }
})
