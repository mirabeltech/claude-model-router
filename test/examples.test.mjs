/**
 * The shipped examples, checked against the loader that will actually read them.
 *
 * An example is documentation that executes, which makes it the worst place for rot: a reader
 * copies it, gets a warning they did not cause, and distrusts the tool. So every file in
 * `examples/` is parsed, resolved and required to produce ZERO warnings — not "no errors", zero
 * warnings, because an unknown field is exactly the kind of drift a SPEC rename causes.
 *
 * CENSUSED, not enumerated. The list comes from `readdirSync`, so a new example is picked up
 * automatically. The previous version of this check named one file by hand, and when that file was
 * renamed the check failed for the only reason a hand-written list ever fails.
 *
 * Paths resolve from `import.meta.url`, never the working directory, so the suite passes from
 * anywhere.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULTS,
  resolveConfig,
  stripJsonComments,
} from '../plugins/model-router/lib/config.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples')

/**
 * A pricing table is not a router config: it is the file `pricing.overrides` points at, so it has
 * its own schema and must not be fed to `resolveConfig`. Named here rather than detected, so
 * adding one cannot accidentally exempt an example from validation.
 */
const PRICING_TABLES = new Set(['pricing-overrides.json'])

const FILES = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort()
const CONFIGS = FILES.filter((f) => !PRICING_TABLES.has(f))

const read = (file) => fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8')
const parse = (file) => JSON.parse(stripJsonComments(read(file)))

/* ------------------------------------------------------------------ census */

test('the examples directory is non-empty and every file is accounted for', () => {
  assert.ok(FILES.length > 0, 'no examples found — the census would pass by checking nothing')
  // The primary example, the one every doc tells a reader to copy first.
  assert.ok(FILES.includes('model-router.json'))
  for (const file of FILES) {
    assert.ok(
      CONFIGS.includes(file) || PRICING_TABLES.has(file),
      `${file} is neither a router config nor a declared pricing table, so nothing validates it`,
    )
  }
})

test('every example is accompanied by a README that names it', () => {
  // An example nobody is pointed at is an example nobody maintains.
  const readme = fs.readFileSync(path.join(EXAMPLES_DIR, 'README.md'), 'utf8')
  for (const file of FILES) {
    assert.ok(readme.includes(file), `examples/README.md does not mention ${file}`)
  }
})

/* -------------------------------------------------------------- validation */

for (const file of FILES) {
  test(`${file} parses after comments are stripped`, () => {
    // The REAL stripper, imported rather than reimplemented: a local copy would accept things the
    // loader rejects, and the point is to agree with the loader.
    assert.doesNotThrow(() => parse(file))
  })
}

for (const file of CONFIGS) {
  test(`${file} resolves with zero warnings`, () => {
    // The pure function, so this touches no disk and cannot read the developer's own config.
    const { warnings } = resolveConfig({ layers: [{ name: 'example', data: parse(file) }], env: {} })
    assert.deepEqual(warnings, [], `${file} produced ${warnings.length} warning(s)`)
  })

  test(`${file} introduces no unknown field`, () => {
    // Named separately from the test above even though it is a subset of it, because this is the
    // failure a SPEC rename causes and the message should say so.
    const { warnings } = resolveConfig({ layers: [{ name: 'example', data: parse(file) }], env: {} })
    const unknown = warnings.filter((w) => w.reason === 'unknown field, ignored')
    assert.deepEqual(unknown, [], 'a renamed or misspelled setting')
  })
}

test('every example declares where it is meant to be copied', () => {
  // The loader reads exactly two paths and nothing else, so an example that does not say which
  // one it belongs in is the start of a support question.
  for (const file of CONFIGS) {
    const text = read(file)
    assert.match(
      text,
      /\.claude[\\/]model-router\.json|~\/\.claude\/model-router\/config\.json|either config path/,
      `${file} does not name its destination`,
    )
  }
})

/* ------------------------------------------------------- the deny-list trap */

test('the primary example never narrows the shipped deny list', () => {
  // ARRAYS REPLACE, THEY DO NOT MERGE. The example's own comment used to claim deny globs were
  // "added to, not replacing", which is false: a project file's list becomes the WHOLE list. It
  // happened to be safe only because the example re-listed all nine defaults.
  //
  // So the hazard is real and silent: the day a tenth default glob is added, every team that
  // copied this file loses that protection with no warning anywhere. This test is what turns that
  // into a failing build instead of a quiet regression.
  const data = parse('model-router.json')
  const theirs = data.routing.denyGlobs
  assert.ok(Array.isArray(theirs))
  const missing = DEFAULTS.routing.denyGlobs.filter((g) => !theirs.includes(g))
  assert.deepEqual(
    missing,
    [],
    'the example must repeat every shipped deny glob, because its list REPLACES the defaults',
  )
})

test('the resolved example really does protect everything the defaults do', () => {
  // The property stated through the loader rather than over the literal, so it holds even if the
  // merge semantics ever change.
  const { config } = resolveConfig({
    layers: [{ name: 'example', data: parse('model-router.json') }],
    env: {},
  })
  for (const glob of DEFAULTS.routing.denyGlobs) {
    assert.ok(config.routing.denyGlobs.includes(glob), `${glob} is no longer denied`)
  }
  assert.ok(config.routing.denyGlobs.includes('**/migrations/**'), 'and it adds its own')
})

/* ------------------------------------------------------------- no secrets */

test('no example contains anything shaped like a credential', () => {
  // There is no config field that holds a key, so a key in one of these files could only be a
  // mistake. Checked here as well as in the repo-wide scan because these files are the ones people
  // copy, edit and then commit.
  for (const file of FILES) {
    const text = read(file)
    assert.equal(/\bAIza[0-9A-Za-z_-]{35}\b/.test(text), false, `${file} contains a Gemini key`)
    assert.equal(/\bsk-[A-Za-z0-9_-]{20,}\b/.test(text), false, `${file} contains an sk- key`)
    // The one legitimate way to reference a key is by variable NAME. Checked over the PARSED
    // data, not the raw text: several examples discuss `apiKeyEnv` in a comment without setting
    // it, and a text match would demand a field that is not there.
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        if (k === 'apiKeyEnv' && v !== null) {
          assert.match(
            String(v),
            /^[A-Z][A-Z0-9_]*$/,
            `${file}: apiKeyEnv must be a variable NAME, not a value`,
          )
        }
        walk(v)
      }
    }
    walk(parse(file))
  }
})

test('no example pretends config values are interpolated', () => {
  // `"${GEMINI_API_KEY}"` is read as that literal string. An example doing it would teach the
  // single most common authentication failure in this project.
  for (const file of FILES) {
    const data = parse(file)
    const walk = (node, at) => {
      if (typeof node === 'string') {
        assert.equal(
          /^\$\{|^\$[A-Za-z_]|^%.*%$/.test(node),
          false,
          `${file} at ${at} looks like a shell expansion, which is never expanded`,
        )
        return
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`)
      }
    }
    walk(data, '')
  }
})

/* --------------------------------------------------------- pricing tables */

for (const file of PRICING_TABLES) {
  test(`${file} is shaped like a pricing table and prices nothing by default`, () => {
    const data = parse(file)
    assert.equal(typeof data.pricingVersion, 'string')
    assert.equal(data.unit, 'per_mtok')
    assert.equal(data.currency, 'USD')
    assert.ok(data.models && Object.keys(data.models).length > 0)

    for (const [key, row] of Object.entries(data.models)) {
      assert.match(key, /^[a-z0-9_-]+:/, `${key} must be provider:model`)
      assert.equal(typeof row.verify, 'string', `${key} must say where to verify the rate`)
      assert.match(row.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${key} must carry a verification date`)
      for (const rate of ['inputPerMTok', 'outputPerMTok']) {
        const v = row[rate]
        assert.ok(
          v === null || (typeof v === 'number' && v >= 0),
          `${key}.${rate} must be null (unpriced) or a non-negative number`,
        )
      }
    }

    // A HOSTED model must ship unpriced. Published rates change without notice, and a stale rate
    // in a template is a confident wrong dollar figure — the thing this project refuses to emit.
    // A local model may legitimately be a literal 0, which is a measurement, not a guess.
    const hosted = Object.entries(data.models).filter(([k]) => !k.startsWith('ollama:'))
    for (const [key, row] of hosted) {
      assert.equal(row.inputPerMTok, null, `${key} must ship unpriced in a template`)
      assert.equal(row.outputPerMTok, null, `${key} must ship unpriced in a template`)
    }
  })
}
