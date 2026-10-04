/**
 * Static architecture rules for the dashboard plugin.
 *
 * `router-dashboard` reads a telemetry store and renders it. It must never import router code and
 * never recompute money: cost is computed once at write time and stamped with its pricing and
 * calc versions, and a second implementation on the read side would re-price history against
 * today's table. A COMMENT IS NOT ENFORCEMENT, so these are the rules as tests.
 *
 * THE CENSUS IS THE MOST IMPORTANT TEST IN THIS FILE, and it is here for a specific reason. The
 * existing ban in `telemetry.isolation.test.mjs` walked `plugins/router-dashboard/` when the
 * directory held exactly one JSON file and no `.mjs` at all — so it passed by scanning nothing,
 * for the whole of phases 0 to 9. Every rule below would do the same without an exact file list.
 *
 * ONE NARROW EXEMPTION IS GRANTED AND NAMED. `scripts/collect.mjs` may touch `child_process`,
 * because `npm run report` has to be one command and a spawn is not an import. The exemption is
 * bounded by four further assertions rather than taken on trust.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const DASHBOARD = path.join(REPO_ROOT, 'plugins', 'router-dashboard')

/** Source with comments removed, so a MENTION of something is never counted as a USE of it. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Every import specifier, including the dynamic and require forms. */
function importsOf(source) {
  const specs = []
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

/**
 * The plugin, file by file, with what each is ALLOWED to import.
 *
 * `lib/**` imports only from `lib/**` and NOTHING ELSE — not even a node builtin. That is the
 * strongest available statement that the renderer cannot read a store, cannot spawn and cannot
 * write: it is a pure string function, and `scripts/` owns every byte of I/O.
 */
const DASHBOARD_LAYER = Object.freeze({
  'lib/contract.mjs': Object.freeze([]),
  'lib/format.mjs': Object.freeze([]),
  'lib/html.mjs': Object.freeze([]),
  'lib/version.mjs': Object.freeze([]),
  'lib/render/chart.mjs': Object.freeze(['../html.mjs', '../format.mjs']),
  'lib/render/sections.mjs': Object.freeze(['../html.mjs', '../format.mjs', './chart.mjs']),
  'lib/render/index.mjs': Object.freeze(['../html.mjs', './sections.mjs', '../version.mjs']),
  'scripts/collect.mjs': Object.freeze(['node:child_process', 'node:fs', 'node:path', 'node:url']),
  'scripts/report.mjs': Object.freeze([
    'node:fs',
    'node:path',
    '../lib/contract.mjs',
    '../lib/version.mjs',
    '../lib/render/index.mjs',
    './collect.mjs',
  ]),
})

const FILES = Object.keys(DASHBOARD_LAYER)
const LIB_FILES = FILES.filter((f) => f.startsWith('lib/'))

/** The one file permitted to spawn a process. */
const SPAWN_EXEMPT = Object.freeze(new Set(['scripts/collect.mjs']))

const read = (rel) => fs.readFileSync(path.join(DASHBOARD, rel), 'utf8')
const source = (rel) => stripComments(read(rel))

/** Every .mjs under the plugin, as slash-joined relative ids. */
function dashboardFiles(dir = DASHBOARD, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...dashboardFiles(path.join(dir, entry.name), rel))
    else if (entry.name.endsWith('.mjs')) out.push(rel)
  }
  return out.sort()
}

/* ------------------------------------------------------------------- census */

test('the dashboard holds exactly the files these rules cover', () => {
  // MEASURED: before this phase, `plugins/router-dashboard/` contained one JSON manifest and
  // zero .mjs files, so the existing import ban in telemetry.isolation.test.mjs walked an empty
  // tree and passed by scanning nothing. A new file must be classified deliberately.
  assert.deepEqual(dashboardFiles(), [...FILES].sort())
})

test('the plugin ships at least the modules the report needs', () => {
  assert.ok(dashboardFiles().length >= 8, `only ${dashboardFiles().length} modules found`)
})

test('every dashboard file imports only what it is allowed to', () => {
  const violations = []
  for (const [file, allowed] of Object.entries(DASHBOARD_LAYER)) {
    for (const spec of importsOf(source(file))) {
      if (!allowed.includes(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'an unapproved import in the dashboard')
})

/* ----------------------------------------------- the one ban that is absolute */

test('no dashboard file imports router code', () => {
  // The dashboard installs independently, so the JSONL format plus the analytics response is the
  // whole contract between the two plugins. An import edge would make that contract a fiction.
  const violations = []
  for (const file of dashboardFiles()) {
    for (const spec of importsOf(source(file))) {
      if (/model-router/.test(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'the dashboard must never import model-router')
})

test('no dashboard file imports a provider, the hook, the dispatcher or governance', () => {
  const violations = []
  for (const file of dashboardFiles()) {
    for (const spec of importsOf(source(file))) {
      if (/provider|\bhook\b|dispatch|governance|telemetry|routing/i.test(spec)) {
        violations.push(`${file} imports ${spec}`)
      }
    }
  }
  assert.deepEqual(violations, [], 'the dashboard reached into the router')
})

test('the dashboard computes no money of its own', () => {
  // Cost was priced once at write time and stamped with its pricing_version. A rate here would
  // be a second pricing model, which is the thing this split exists to prevent.
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    for (const banned of ['perMTok', 'resolveRates', 'calculateCost', 'priceTokens', '1e6', '1_000_000', 'inputPerMTok']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'the dashboard must not price anything')
})

test('the dashboard estimates no tokens of its own', () => {
  // chars/4 is the router's counterfactual method, stamped on every row as `avoided_method`. A
  // copy here would be a second methodology that nobody would keep in step.
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    if (/\/\s*4\b/.test(src) && !/slice|padStart|repeat/.test(src)) violations.push(`${file} divides by 4`)
    if (src.includes('chars_div_4')) violations.push(`${file} names an avoided method`)
  }
  assert.deepEqual(violations, [], 'the dashboard must not estimate tokens')
})

/* ----------------------------------------------------------- the pure lib */

test('no lib module imports a node builtin, so the renderer is a pure string function', () => {
  // This is what makes "the dashboard cannot read a store" a structural fact rather than a
  // policy: there is no `fs` in scope to read one with.
  const violations = []
  for (const file of LIB_FILES) {
    for (const spec of importsOf(source(file))) {
      if (spec.startsWith('node:')) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'the render layer must stay free of node builtins')
})

test('no lib module writes, reads or deletes a file', () => {
  const violations = []
  for (const file of LIB_FILES) {
    const src = source(file)
    if (/writeFileSync|readFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|openSync/.test(src)) {
      violations.push(file)
    }
  }
  assert.deepEqual(violations, [], 'the render layer must touch no file')
})

test('no lib module reaches the network', () => {
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    for (const banned of ['fetch(', 'XMLHttpRequest', 'node:http', 'node:https', 'node:net', 'node:tls', 'WebSocket', 'createServer']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'the report is a file, not a server')
})

test('the rendered document loads nothing from the network either', () => {
  // A report has to open on a machine with no internet and keep working in a year, so the CSS
  // and the charts are inline and there is no script tag at all.
  //
  // COMMENTS ARE STRIPPED FIRST. html.mjs explains in its header why a model id is a good place
  // to hide a `<script>` tag, and reading the raw source counted that explanation as a tag.
  const src = source('lib/html.mjs')
  assert.equal(/<script/i.test(src), false, 'the document must run no script')
  assert.equal(/<link/i.test(src), false, 'and load no stylesheet')
  assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(src), false, 'and fetch nothing')
})

/* --------------------------------------------- the one exemption, bounded */

test('collect.mjs is the ONLY file that may touch child_process', () => {
  // A spawn is not an import, so the router-code ban holds unchanged — but the capability still
  // exists at exactly one auditable point, and the census is what makes that claim checkable.
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    const spawns = ['child_process', 'spawnSync', 'spawn(', 'fork('].some((b) => src.includes(b))
    if (spawns && !SPAWN_EXEMPT.has(file)) violations.push(`${file} spawns a process`)
  }
  assert.deepEqual(violations, [], 'only collect.mjs may spawn')
})

test('nothing in the plugin evaluates code, including collect.mjs', () => {
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    for (const banned of ['exec(', 'execSync', 'execFile', 'eval(', 'new Function']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'exec and eval are banned everywhere, exemption or not')
})

test('collect.mjs spawns an argv array with shell:false', () => {
  // A shell string would make a plugin path containing a space into two arguments, and one
  // containing an ampersand into two commands.
  const src = source('scripts/collect.mjs')
  assert.match(src, /shell:\s*false/)
  assert.match(src, /spawn\(execPath,\s*\[script, '--json'/, 'the command must be an array')
})

test('the spawn site renders nothing and the render layer spawns nothing', () => {
  // Checked on IMPORT EDGES, not on substrings. A prose word like "collection" in a caption is
  // not a dependency, and matching it made this test fail on a sentence about latency samples.
  const collect = importsOf(source('scripts/collect.mjs'))
  assert.equal(collect.some((s) => /render/.test(s)), false, 'the collector must not render')
  const violations = []
  for (const file of LIB_FILES) {
    for (const spec of importsOf(source(file))) {
      if (/collect|scripts\//.test(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'the render layer must not reach into scripts/')
})

/* ------------------------------------------------------------- read-only */

test('the dashboard writes exactly one file, and only from report.mjs', () => {
  // Writing the report is the point; writing anything else is not. In particular it must never
  // create a telemetry directory, a lock, or a config file.
  const writers = []
  for (const file of dashboardFiles()) {
    if (/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|writeSync/.test(source(file))) {
      writers.push(file)
    }
  }
  assert.deepEqual(writers, ['scripts/report.mjs'], 'only the report script may write')
})

test('report.mjs creates no directory, so it cannot bring a store into existence', () => {
  const src = source('scripts/report.mjs')
  assert.equal(src.includes('mkdirSync'), false, 'a reporting tool must not create directories')
  assert.equal(src.includes('rmSync'), false)
})

test('the dashboard never mutates a configuration', () => {
  // It is observational. Nothing in this phase may change a routing threshold, a budget or a
  // provider default, and the simplest guarantee is that the plugin cannot write a config at all.
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    for (const banned of ['model-router.json', 'config.json', 'loadConfig', 'resolveConfig', 'SPEC']) {
      if (src.includes(banned)) violations.push(`${file} names ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'the dashboard must not touch configuration')
})

test('the dashboard reads no CMR_ environment variable', () => {
  // A CMR_ name here would be an undeclared setting beside a config SPEC that declares every
  // other one. The router path is a flag instead.
  const violations = []
  for (const file of dashboardFiles()) {
    const hits = [...source(file).matchAll(/CMR_[A-Z0-9_]+/g)].map((m) => m[0])
    for (const hit of hits) violations.push(`${file} reads ${hit}`)
  }
  assert.deepEqual(violations, [], 'the dashboard must take its input as an argument')
})

/* ---------------------------------------------------------------- content */

test('no dashboard file names a content column', () => {
  // question_text, error_message_safe and project_path never reach the response, and naming one
  // here would be the first step toward rendering it.
  const violations = []
  for (const file of dashboardFiles()) {
    const src = source(file)
    for (const field of ['question_text', 'error_message_safe', 'project_path']) {
      if (src.includes(field)) violations.push(`${file} names ${field}`)
    }
  }
  assert.deepEqual(violations, [], 'a content column was named in the dashboard')
})

test('every interpolated value in the HTML layer goes through an escaper', () => {
  // A telemetry store holds model ids and error codes that came from a remote service, and the
  // report is a local file a browser will execute.
  const src = source('lib/html.mjs')
  assert.match(src, /export function escapeHtml/)
  assert.match(src, /replace\(\/&\/g, '&amp;'\)/)
  const violations = []
  for (const file of ['lib/render/sections.mjs', 'lib/render/chart.mjs']) {
    if (!source(file).includes('escapeHtml')) violations.push(`${file} interpolates without escaping`)
  }
  assert.deepEqual(violations, [], 'an unescaped interpolation')
})

/* ---------------------------------------------------------------- the zeros */

test('the dashboard never defaults an unknown measurement to zero', () => {
  const EXEMPT = /\.length|padStart|padEnd|slice|toFixed|repeat|Math\.max\(m, /
  const offenders = []
  for (const file of dashboardFiles()) {
    for (const line of source(file).split('\n')) {
      if (!/\?\?\s*0\b/.test(line) && !/\|\|\s*0\b/.test(line)) continue
      if (EXEMPT.test(line)) continue
      offenders.push(`${file}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], 'an unknown measurement must stay null, never become 0')
})

/* ----------------------------------------------------------------- manifest */

test('the plugin manifest declares a skills directory that exists', () => {
  // `claude plugin validate --strict` does not catch a dangling skills reference, and the
  // manifest has pointed at a missing directory since it was written.
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
  if (manifest.skills !== undefined) {
    const dir = path.join(DASHBOARD, manifest.skills.replace(/^\.\//, ''))
    assert.ok(fs.existsSync(dir), `the manifest declares ${manifest.skills}, which does not exist`)
    // The skill this phase delivers must be real. The router plugin's own skill directories
    // are still empty and belong to the packaging phase, so this checks only our own.
    const own = path.join(dir, 'router-report', 'SKILL.md')
    assert.ok(fs.existsSync(own), 'skills/router-report/SKILL.md is missing')
  }
})

test('the manifest describes a report rather than a store reader', () => {
  // The description said the plugin "reads the model-router telemetry store", which was never
  // true and is now definitely not: it renders an analytics response it is handed.
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
  // Case-insensitive: the stale description began with a capital R, and a case-sensitive check
  // passed against it for the wrong reason.
  assert.equal(/reads the model-router telemetry store/i.test(manifest.description), false)
  assert.match(manifest.description, /analytics response/i)
})
