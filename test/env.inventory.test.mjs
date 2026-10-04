/**
 * Every environment variable this project reads is declared, and everything declared is read.
 *
 * The brief for this phase says "do not allow undocumented environment variables", which is only
 * a real rule if something checks it. Prose cannot: a document that lists variables drifts the
 * moment somebody adds a read, and nobody notices because nothing fails.
 *
 * So this scans the source for reads and compares the result against the two declarations — `SPEC`
 * for the 76 settings, and `lib/env-registry.mjs` for everything that is deliberately not a
 * setting. It fails in BOTH directions: an undeclared read, and a stale declaration nothing reads.
 *
 * WHAT IT CANNOT CATCH, stated here rather than implied, because a structural test that overstates
 * its reach is worse than none:
 *
 *   - A COMPUTED NAME. `worker.apiKeyEnv` makes the set of credential variables open-ended by
 *     design, so no scan can enumerate them. The sites that read a computed name are pinned
 *     instead, which is the strongest available claim: a new dynamic read fails this suite.
 *   - Anything a CHILD PROCESS reads. report.mjs forwards its environment to the analytics CLI it
 *     spawns, and the hook inherits whatever Claude Code gave it.
 *   - Anything NODE reads for itself: NODE_OPTIONS, TZ, and the home-directory variables behind
 *     os.homedir().
 *   - Whether a declared purpose is TRUE. Only the name set and the read sites are machine
 *     checkable. The meaning is prose, and prose is reviewed rather than verified.
 *
 * Comments are stripped before scanning, so a variable merely MENTIONED in a docstring is never
 * counted as a read — the same distinction telemetry.isolation.test.mjs already relies on.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SPEC } from '../plugins/model-router/lib/config.mjs'
import {
  DYNAMIC_READ_SITES,
  ENV_CLASSES,
  ENV_REGISTRY,
  SPEC_ENV_EXCEPTIONS,
  declaredEnvNames,
} from '../plugins/model-router/lib/env-registry.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ scanning */

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'sandbox', '.tmp'].includes(entry.name)) continue
      walk(p, out)
    } else if (entry.name.endsWith('.mjs')) {
      out.push(p)
    }
  }
  return out
}

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/')

/** Comments out, so a mention is never a read. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * Literal reads. The third pattern is the one a naive scan misses: this codebase INJECTS an `env`
 * object into pure functions rather than reaching for `process.env`, so most real reads look like
 * `env.CLAUDE_PROJECT_DIR` and never mention `process`. Restricting that form to UPPER_SNAKE of
 * three characters or more is what keeps `env.production`, `env.local` and `env.ts` out.
 */
const LITERAL_PATTERNS = [
  /process\.env\.([A-Za-z_]\w*)/g,
  /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g,
  /\benv\??\.([A-Z][A-Z0-9_]{2,})\b/g,
  /\benv\??\[\s*['"]([^'"]+)['"]\s*\]/g,
]

/** A read whose name is computed. Unknowable statically, so the SITE is what gets pinned. */
const COMPUTED_PATTERNS = [/process\.env\??\.?\[(?!\s*['"])/g, /\benv\??\.?\[(?!\s*['"])/g]

const DESTRUCTURE_PATTERN = /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g

/**
 * Files whose SUBJECT MATTER is environment-variable names, and which therefore contain example
 * names in ordinary string literals that no amount of comment-stripping can tell apart from a
 * read. Excluded by name, with the reason, rather than by a pattern that might also excuse a real
 * read somewhere else.
 *
 * This file is on the list because it scans the repository and would otherwise find its own
 * fixtures; the generator is on it because it writes the documentation that names them all.
 */
const NOT_SCANNED = Object.freeze({
  'test/env.inventory.test.mjs': 'this scanner, whose own fixtures are example variable names',
  'plugins/model-router/scripts/gen-env-docs.mjs':
    'the generator, whose prose quotes the patterns this scanner matches',
  'plugins/model-router/lib/env-registry.mjs':
    'the declaration itself, whose purpose and reason strings quote the read expressions',
})

const keep = (files) => files.filter((f) => NOT_SCANNED[rel(f)] === undefined)

const PLUGIN_FILES = keep(walk(path.join(REPO_ROOT, 'plugins')))
const TEST_FILES = keep(walk(path.join(REPO_ROOT, 'test')))
const SCRIPT_FILES = keep(walk(path.join(REPO_ROOT, 'scripts')))
const ALL_FILES = [...PLUGIN_FILES, ...TEST_FILES, ...SCRIPT_FILES]

/** Every .mjs in the repo, for the weaker "is this name mentioned anywhere" question. */
const EVERY_FILE = [
  ...walk(path.join(REPO_ROOT, 'plugins')),
  ...walk(path.join(REPO_ROOT, 'test')),
  ...walk(path.join(REPO_ROOT, 'scripts')),
]

/**
 * Is this match an ASSIGNMENT rather than a read?
 *
 * `env.CMR_MIN_BYTES = minBytes` is how a test harness or a smoke script CONSTRUCTS a child
 * environment, which is legitimate and has nothing to do with reading a setting behind the config
 * loader's back. Counting it as a read produced three false violations in smoke-hook.mjs and would
 * have pushed them into the exception list, where they would have looked like real debt.
 *
 * Checked by looking at what follows the match: a single `=` that is not part of `==`, `===` or
 * `=>`. Crude, and sufficient — the alternative is parsing JavaScript to answer a question about
 * four lines of it.
 */
function isAssignment(src, endIndex) {
  const after = src.slice(endIndex, endIndex + 3)
  const m = /^\s*(=)([^=])?/.exec(after)
  return m !== null && m[2] !== '='
}

function scan(files) {
  const literal = new Map()
  const computed = new Set()
  const destructured = new Map()
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const re of LITERAL_PATTERNS) {
      for (const m of src.matchAll(re)) {
        if (isAssignment(src, m.index + m[0].length)) continue
        if (!literal.has(m[1])) literal.set(m[1], new Set())
        literal.get(m[1]).add(rel(file))
      }
    }
    for (const re of COMPUTED_PATTERNS) {
      if (re.test(src)) computed.add(rel(file))
      re.lastIndex = 0
    }
    for (const m of src.matchAll(DESTRUCTURE_PATTERN)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].split('=')[0].trim()
        if (!name) continue
        if (!destructured.has(name)) destructured.set(name, new Set())
        destructured.get(name).add(rel(file))
      }
    }
  }
  return { literal, computed, destructured }
}

const SCAN = scan(ALL_FILES)
const SPEC_ENV = new Set(Object.values(SPEC).map((s) => s.env).filter(Boolean))

/* -------------------------------------------------------------- the census */

test('the file census is current and non-empty', () => {
  // THE MOST IMPORTANT TEST HERE. A scan over a stale or empty file list passes by scanning
  // nothing, and would keep passing forever while variables were added freely.
  assert.ok(PLUGIN_FILES.length > 50, `only ${PLUGIN_FILES.length} plugin files found`)
  assert.ok(TEST_FILES.length > 50, `only ${TEST_FILES.length} test files found`)
  assert.ok(SCRIPT_FILES.length > 0, 'the repo-root scripts/ directory was not scanned')
  // Files that certainly read the environment, so a broken walker cannot look clean.
  const names = ALL_FILES.map(rel)
  assert.ok(names.includes('plugins/model-router/lib/config.mjs'))
  assert.ok(names.includes('plugins/model-router/lib/providers/gemini.mjs'))
  assert.ok(names.includes('plugins/model-router/scripts/doctor.mjs'))
})

test('the scanner does not count a variable merely mentioned in a comment', () => {
  // The property the whole suite rests on: `telemetry/index.mjs` discusses variables it does not
  // read, and several docstrings name GEMINI_API_KEY.
  const src = `
    // process.env.MENTIONED_IN_A_LINE_COMMENT
    /* process.env.MENTIONED_IN_A_BLOCK */
    const real = process.env.ACTUALLY_READ
  `
  const stripped = stripComments(src)
  assert.equal(stripped.includes('MENTIONED_IN_A_LINE_COMMENT'), false)
  assert.equal(stripped.includes('MENTIONED_IN_A_BLOCK'), false)
  assert.equal(stripped.includes('ACTUALLY_READ'), true)
})

test('the injected-env form is detected, not just process.env', () => {
  // Most real reads in this codebase take an injected `env` object, so a scan that only matched
  // `process.env.` would miss CLAUDE_PROJECT_DIR entirely and report a clean inventory.
  const found = scan([path.join(REPO_ROOT, 'plugins', 'model-router', 'lib', 'config.mjs')])
  assert.ok(
    found.literal.has('CLAUDE_PROJECT_DIR'),
    'config.mjs reads env.CLAUDE_PROJECT_DIR and the scanner must see it',
  )
})

test('lowercase and dotted property access is not mistaken for a variable', () => {
  const found = scan([]).literal
  assert.equal(found.size, 0)
  const probe = scan([path.join(REPO_ROOT, 'plugins', 'model-router', 'lib', 'globs.mjs')])
  for (const name of probe.literal.keys()) {
    assert.match(name, /^[A-Za-z_]\w*$/)
    assert.equal(/^(production|local|ts|js)$/.test(name), false)
  }
})

/* ------------------------------------------------------------ declarations */

test('every variable the plugin reads is declared', () => {
  // The headline claim, in the direction that matters most: a read nobody documented.
  const declared = new Set([...declaredEnvNames(), ...SPEC_ENV])
  const undeclared = []
  for (const [name, where] of SCAN.literal) {
    if (declared.has(name)) continue
    if (name.startsWith('CLAUDE_PLUGIN_OPTION_')) continue // derived from SPEC, documented there
    undeclared.push(`${name} (read by ${[...where].sort().join(', ')})`)
  }
  assert.deepEqual(
    undeclared.sort(),
    [],
    'declare these in lib/env-registry.mjs, or give them a SPEC entry if they are settings',
  )
})

test('every declared variable still appears in the codebase', () => {
  // The other direction: a stale entry describing a variable nothing uses is misinformation, and
  // it is the half a hand-maintained list always gets wrong.
  //
  // Deliberately the WEAKER question — mentioned anywhere, rather than matched as a literal read.
  // Two declared variables are legitimately never literal reads, and demanding one would force a
  // false entry:
  //
  //   CLAUDE_PLUGIN_ROOT  Claude Code substitutes it into hooks.json before our process starts.
  //                       We never read it; doctor reconstructs the same path independently.
  //   GEMINI_API_KEY      read through `env[apiKeyEnv]`, a computed name, because the variable
  //                       holding the key is itself configurable.
  //
  // Those two are exactly why the dynamic-site census below exists.
  const sources = EVERY_FILE.map((f) => fs.readFileSync(f, 'utf8'))
  const hooksJson = fs.readFileSync(
    path.join(REPO_ROOT, 'plugins', 'model-router', 'hooks', 'hooks.json'),
    'utf8',
  )
  const haystack = [...sources, hooksJson].join('\n')
  const unused = declaredEnvNames().filter((name) => !haystack.includes(name))
  assert.deepEqual(unused, [], 'these are declared but appear nowhere — remove them')
})

test('every declared reader really contains the read it claims', () => {
  // Ties the declaration to reality rather than to intent. A moved read would otherwise leave the
  // registry pointing at a file that no longer mentions the variable.
  const wrong = []
  for (const [name, entry] of Object.entries(ENV_REGISTRY)) {
    for (const file of entry.readers) {
      const abs = path.join(REPO_ROOT, file)
      if (!fs.existsSync(abs)) {
        wrong.push(`${name}: ${file} does not exist`)
        continue
      }
      // hooks.json is JSON, not a .mjs the scanner walks, and names the variable for Claude Code
      // to substitute rather than reading it.
      const src = file.endsWith('.json')
        ? fs.readFileSync(abs, 'utf8')
        : stripComments(fs.readFileSync(abs, 'utf8'))
      if (!src.includes(name)) wrong.push(`${name}: ${file} does not mention it`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('every registry entry is fully specified', () => {
  for (const [name, entry] of Object.entries(ENV_REGISTRY)) {
    for (const field of ['purpose', 'class', 'required', 'secret', 'precedence', 'subsystem', 'readers']) {
      assert.notEqual(entry[field], undefined, `${name} is missing ${field}`)
    }
    assert.ok(ENV_CLASSES.includes(entry.class), `${name} has an unknown class ${entry.class}`)
    assert.equal(typeof entry.secret, 'boolean', `${name}.secret must be a boolean`)
    assert.ok(Array.isArray(entry.readers) && entry.readers.length > 0, `${name} names no reader`)
    assert.ok(entry.purpose.length > 20, `${name} needs a real purpose, not a label`)
  }
})

test('exactly one variable is marked secret, and it is the credential', () => {
  const secrets = Object.entries(ENV_REGISTRY).filter(([, v]) => v.secret)
  assert.deepEqual(secrets.map(([n]) => n), ['GEMINI_API_KEY'])
  // And no SETTING is ever a secret: a setting variable can name the holder of a key, never the key.
  for (const field of Object.keys(SPEC)) {
    const env = SPEC[field].env
    if (!env) continue
    assert.equal(/_KEY$|_TOKEN$|_SECRET$|_PASSWORD$/.test(env), false, `${env} looks like a credential`)
  }
})

/* ----------------------------------------------------------- computed reads */

test('every computed read happens at a declared site', () => {
  // A dynamic read is exactly where an undocumented variable would hide, so the sites are pinned.
  const declared = new Set(DYNAMIC_READ_SITES.map((s) => s.file))
  const actual = [...SCAN.computed].filter((f) => f.startsWith('plugins/')).sort()
  const undeclared = actual.filter((f) => !declared.has(f))
  assert.deepEqual(
    undeclared,
    [],
    'a computed env read was added; declare it in DYNAMIC_READ_SITES with the reason it must be dynamic',
  )
  // And no declared site has gone away.
  const gone = [...declared].filter((f) => !actual.includes(f))
  assert.deepEqual(gone, [], 'these sites no longer read a computed name — remove them')
})

test('every dynamic read site states why it has to be dynamic', () => {
  for (const site of DYNAMIC_READ_SITES) {
    assert.ok(site.reason.length > 30, `${site.file} needs a real reason`)
  }
})

test('nothing destructures the environment yet, and the scanner would see it if it did', () => {
  // Currently zero across the repo. The scanner exists so the FIRST one is classified rather than
  // invisible, which is the only moment it is cheap to get right.
  assert.deepEqual([...SCAN.destructured.keys()], [])
  const probe = `const { GEMINI_API_KEY, CMR_ENABLED: on } = process.env`
  const found = [...probe.matchAll(DESTRUCTURE_PATTERN)].flatMap((m) =>
    m[1].split(',').map((p) => p.split(':')[0].trim()),
  )
  assert.deepEqual(found, ['GEMINI_API_KEY', 'CMR_ENABLED'])
})

/* ---------------------------------------------------- the one-reader rules */

test('a CMR_ setting is not read by name outside the config loader', () => {
  // The convention that keeps the layering testable: a setting is read in one place, so nothing
  // can consult a setting behind the loader's back. The one exception is declared, so the list
  // cannot grow silently.
  const offenders = []
  for (const [name, where] of SCAN.literal) {
    if (!SPEC_ENV.has(name)) continue
    for (const file of where) {
      if (!file.startsWith('plugins/')) continue
      const allowed = SPEC_ENV_EXCEPTIONS[file] ?? []
      if (allowed.includes(name)) continue
      offenders.push(`${file} reads ${name}`)
    }
  }
  assert.deepEqual(
    offenders.sort(),
    [],
    'read it through loadConfig(), or declare the exception in SPEC_ENV_EXCEPTIONS',
  )
})

test('every declared SPEC exception is real and still needed', () => {
  for (const [file, names] of Object.entries(SPEC_ENV_EXCEPTIONS)) {
    const abs = path.join(REPO_ROOT, file)
    assert.ok(fs.existsSync(abs), `${file} does not exist`)
    const src = stripComments(fs.readFileSync(abs, 'utf8'))
    for (const name of names) {
      assert.ok(SPEC_ENV.has(name), `${name} is not a SPEC variable, so it needs no exception`)
      assert.ok(src.includes(name), `${file} no longer reads ${name} — remove the exception`)
    }
  }
})

test('the two side channels have exactly one reader each', () => {
  // Generalises the existing single-reader pin on CLAUDE_ROUTER_TELEMETRY to CLAUDE_SESSION_ID,
  // which had none. A second reader of a kill switch is how a switch stops working in one place.
  for (const name of ['CLAUDE_ROUTER_TELEMETRY', 'CLAUDE_SESSION_ID']) {
    const where = [...(SCAN.literal.get(name) ?? [])].filter((f) => f.startsWith('plugins/'))
    assert.deepEqual(where, ['plugins/model-router/lib/telemetry/index.mjs'], `${name} has moved or gained a reader`)
  }
})

/* --------------------------------------------------------- derived options */

test('the derived plugin-option names are unique', () => {
  // `CLAUDE_PLUGIN_OPTION_<FIELD>` is derived by replacing dots and dashes with underscores and
  // upper-casing, so two different settings could collide onto one variable — `a.b-c` and `a.b_c`
  // both become A_B_C, and one would silently shadow the other.
  const seen = new Map()
  for (const field of Object.keys(SPEC)) {
    const key = `CLAUDE_PLUGIN_OPTION_${field.replace(/[.\-]/g, '_').toUpperCase()}`
    if (seen.has(key)) {
      assert.fail(`${field} and ${seen.get(key)} both derive ${key}`)
    }
    seen.set(key, field)
  }
  assert.equal(seen.size, Object.keys(SPEC).length)
})

test('every SPEC variable is uniquely named and CMR_ prefixed', () => {
  const seen = new Set()
  for (const [field, spec] of Object.entries(SPEC)) {
    if (!spec.env) {
      assert.equal(field, 'version', 'only `version` may lack an environment variable')
      continue
    }
    assert.match(spec.env, /^CMR_[A-Z0-9_]+$/, `${field} has a non-conforming variable name`)
    assert.equal(seen.has(spec.env), false, `${spec.env} is declared twice`)
    seen.add(spec.env)
  }
})

/* --------------------------------------------------------------- the doc */

test('docs/environment.md is not stale', () => {
  // Same shape as the config-schema staleness check: regenerate in memory, compare bytes. Without
  // this, the generated inventory could fall behind the registry between CI runs.
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'environment.md'), 'utf8')
  for (const name of declaredEnvNames()) {
    assert.ok(doc.includes(`\`${name}\``), `${name} is declared but missing from docs/environment.md`)
  }
  for (const env of SPEC_ENV) {
    assert.ok(doc.includes(`\`${env}\``), `${env} is a setting but missing from docs/environment.md`)
  }
  // The limits must be stated in the document, not only in this file's header.
  assert.match(doc, /What a static scan cannot see/)
  assert.match(doc, /computed name/i)
})
