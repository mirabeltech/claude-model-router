/**
 * The package as a package: manifests, versions, hook registration, declared paths and claims.
 *
 * Nothing here tests behaviour. It tests the things a user hits BEFORE any behaviour runs, which
 * is exactly the class of defect that had accumulated unnoticed: `marketplace.json` was never
 * parsed by a single test, two npm scripts ran files that do not exist, three version fields were
 * tied to nothing, and a manifest declared three skills that were empty directories.
 *
 * `claude plugin validate --strict` catches some of this and is run by CI. It is not run from here:
 * `npm test` must stay offline and keyless, and the CLI is not guaranteed to be installed.
 *
 * Scoped deliberately. This file owns the REPO-WIDE generalisations; the plugin-specific shapes
 * stay where they are. `test/hook.security.test.mjs` keeps model-router's own hook shape — one
 * event, one matcher, and that the matcher is `Read` — because that is routing policy, not
 * packaging, and its comments carry the live-verified Claude Code findings.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  JSON_TARGETS,
  MODULE_TARGETS,
  readSourceVersion,
  renderVersionModule,
} from '../scripts/sync-version.mjs'
import { ROUTER_VERSION } from '../plugins/model-router/lib/version.mjs'
import { DASHBOARD_VERSION } from '../plugins/router-dashboard/lib/version.mjs'
import {
  CALC_VERSION,
  SCHEMA_VERSION,
} from '../plugins/model-router/lib/telemetry/record.mjs'
import { CONFIG_VERSION } from '../plugins/model-router/lib/config.mjs'
import { POLICY_VERSION } from '../plugins/model-router/lib/routing-policy.mjs'
import { ANALYTICS_CONTRACT_VERSION } from '../plugins/model-router/lib/analytics/schema.mjs'
import { INTENT_PROMPT_VERSION, PROMPT_VERSION } from '../plugins/model-router/lib/dispatch/modes.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel))

const PKG = readJson('package.json')
const MARKETPLACE = readJson('.claude-plugin/marketplace.json')
const PLUGIN_DIRS = fs
  .readdirSync(path.join(REPO_ROOT, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
const MANIFESTS = Object.fromEntries(
  PLUGIN_DIRS.map((name) => [name, readJson(`plugins/${name}/.claude-plugin/plugin.json`)]),
)

/* ------------------------------------------------------------ one version */

test('every release version equals the root package.json version', () => {
  // Built as a labelled map so one failure names every field at once, rather than failing on
  // whichever of the seven a test happened to check first.
  const source = readSourceVersion(REPO_ROOT)
  const actual = {
    'package.json': PKG.version,
    'marketplace.version': MARKETPLACE.version,
    ...Object.fromEntries(
      MARKETPLACE.plugins.map((p) => [`marketplace.plugins[${p.name}]`, p.version]),
    ),
    ...Object.fromEntries(
      Object.entries(MANIFESTS).map(([name, m]) => [`${name}/plugin.json`, m.version]),
    ),
    ROUTER_VERSION,
    DASHBOARD_VERSION,
  }
  const expected = Object.fromEntries(Object.keys(actual).map((k) => [k, source]))
  assert.deepEqual(actual, expected, 'run: npm run sync:version')
})

test('the version is a plain semver triple', () => {
  assert.match(PKG.version, /^\d+\.\d+\.\d+$/)
})

test('the generated version modules are not stale', () => {
  // Makes staleness fail under `npm test`, not only under CI's git diff gate.
  for (const target of MODULE_TARGETS) {
    const want = renderVersionModule({
      constName: target.constName,
      version: readSourceVersion(REPO_ROOT),
    })
    const got = fs.readFileSync(path.join(REPO_ROOT, target.file), 'utf8')
    assert.equal(got, want, `${target.file} is stale — run: npm run sync:version`)
  }
})

test('the release version is not a contract version', () => {
  // Eight counters answer "can you still read my data" and bump on their own schedule. Named
  // together here so a future attempt to unify them with the release number has to delete a test
  // that says why not.
  for (const [name, value] of [
    ['SCHEMA_VERSION', SCHEMA_VERSION],
    ['CALC_VERSION', CALC_VERSION],
    ['CONFIG_VERSION', CONFIG_VERSION],
    ['POLICY_VERSION', POLICY_VERSION],
    ['PROMPT_VERSION', PROMPT_VERSION],
    ['INTENT_PROMPT_VERSION', INTENT_PROMPT_VERSION],
    ['ANALYTICS_CONTRACT_VERSION', ANALYTICS_CONTRACT_VERSION],
  ]) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer`)
  }
  // Cross-plugin compatibility is NEGOTIATED through the contract version, never inferred from a
  // release number — which is why the two plugins can share one version safely.
  assert.notEqual(String(ANALYTICS_CONTRACT_VERSION), PKG.version)
})

/* ------------------------------------------------- marketplace coherence */

test('marketplace.json declares exactly the plugins that exist on disk', () => {
  assert.deepEqual(MARKETPLACE.plugins.map((p) => p.name).sort(), PLUGIN_DIRS)
})

test('every marketplace source resolves to a plugin directory with a manifest', () => {
  for (const entry of MARKETPLACE.plugins) {
    // `source` is relative to the repo root AND `metadata.pluginRoot` exists, which is the shape
    // that invites a double prefix. validate --strict does not catch that.
    assert.equal(entry.source, `./plugins/${entry.name}`, `${entry.name} has an unexpected source`)
    assert.ok(exists(`plugins/${entry.name}`), `${entry.source} does not exist`)
    assert.ok(exists(`plugins/${entry.name}/.claude-plugin/plugin.json`))
  }
  assert.equal(MARKETPLACE.metadata.pluginRoot, './plugins')
})

test('every marketplace entry name matches the manifest it points at', () => {
  for (const entry of MARKETPLACE.plugins) {
    assert.equal(MANIFESTS[entry.name].name, entry.name)
  }
})

test('marketplace keywords match the manifest they duplicate', () => {
  // Two hand-maintained copies of one list is exactly what drifts.
  for (const entry of MARKETPLACE.plugins) {
    assert.deepEqual(
      [...(entry.keywords ?? [])].sort(),
      [...(MANIFESTS[entry.name].keywords ?? [])].sort(),
      `${entry.name}: marketplace and manifest keywords disagree`,
    )
  }
})

test('the dashboard is never described as reading a telemetry store', () => {
  // It renders a response it is handed; it cannot read a store, and nothing under its lib/ imports
  // even a node builtin. The claim was forbidden in the plugin manifest and still shipped in
  // marketplace.json unguarded — and in the footer of every generated report.
  const strings = [
    MARKETPLACE.plugins.find((p) => p.name === 'router-dashboard').description,
    MANIFESTS['router-dashboard'].description,
    fs.readFileSync(
      path.join(REPO_ROOT, 'plugins/router-dashboard/lib/render/sections.mjs'),
      'utf8',
    ),
  ]
  for (const s of strings) {
    assert.equal(
      /reads?\s+(?:the\s+)?(?:model-router\s+)?telemetry store/i.test(s),
      false,
      'the dashboard does not read a store',
    )
  }
  assert.match(MANIFESTS['router-dashboard'].description, /analytics response/i)
})

/* ------------------------------------------------------------ npm scripts */

test('every npm script runs a file that exists', () => {
  // Caught `ingest` -> scripts/ingest.mjs and `test:behavioural` -> test/behavioural/run.mjs, both
  // of which never existed. A documented command that cannot run is worse than an absent feature.
  const NON_NODE_RUNNERS = ['claude']
  const broken = []
  for (const [name, command] of Object.entries(PKG.scripts)) {
    for (const segment of command.split('&&')) {
      const argv = segment.trim().split(/\s+/)
      if (argv[0] !== 'node') {
        assert.ok(
          NON_NODE_RUNNERS.includes(argv[0]),
          `script "${name}" uses an unrecognised runner "${argv[0]}"`,
        )
        continue
      }
      const target = argv.slice(1).find((a) => !a.startsWith('-'))
      if (target === undefined) continue
      const clean = target.replace(/^["']|["']$/g, '')
      if (clean.includes('*')) {
        // A glob: assert it matches something, without depending on an experimental fs.globSync.
        const base = clean.split('*')[0].replace(/\/$/, '')
        assert.ok(exists(base), `script "${name}" globs under ${base}, which does not exist`)
        continue
      }
      if (!exists(clean)) broken.push(`${name} -> ${clean}`)
    }
  }
  assert.deepEqual(broken, [])
})

test('every plugin script is reachable from an npm script', () => {
  // `prune.mjs` and `gen-config-schema.mjs` were invocable only by path, so nobody ran them.
  const NOT_A_COMMAND = new Set([
    // Imported by report.mjs rather than invoked. It is the only file permitted to spawn.
    'plugins/router-dashboard/scripts/collect.mjs',
  ])
  const commands = Object.values(PKG.scripts).join(' ')
  const unreachable = []
  for (const plugin of PLUGIN_DIRS) {
    const dir = path.join(REPO_ROOT, 'plugins', plugin, 'scripts')
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      const rel = `plugins/${plugin}/scripts/${file}`
      if (NOT_A_COMMAND.has(rel)) continue
      if (!commands.includes(rel)) unreachable.push(rel)
    }
  }
  assert.deepEqual(unreachable, [], 'add an npm script, or declare it as not a command')
})

/* ------------------------------------------------------------------ hooks */

/** Every hook registration in the repo, from both the auto-loaded file and any manifest key. */
function allHookRegistrations() {
  const out = []
  for (const plugin of PLUGIN_DIRS) {
    const files = []
    const auto = `plugins/${plugin}/hooks/hooks.json`
    if (exists(auto)) files.push({ file: auto, source: 'auto' })
    const declared = MANIFESTS[plugin].hooks
    if (typeof declared === 'string') {
      files.push({ file: path.posix.join(`plugins/${plugin}`, declared), source: 'manifest' })
    }
    for (const { file, source } of files) {
      const manifest = readJson(file)
      for (const [event, matchers] of Object.entries(manifest.hooks ?? {})) {
        for (const [blockIndex, matcher] of (matchers ?? []).entries()) {
          for (const handler of matcher.hooks ?? []) {
            out.push({ plugin, file, source, event, blockIndex, matcher: matcher.matcher ?? '*', handler })
          }
        }
      }
    }
  }
  return out
}

const HOOKS = allHookRegistrations()

test('at least one hook is registered, so the checks below are not vacuous', () => {
  assert.ok(HOOKS.length > 0)
})

test('no hook is registered twice, in any of the three ways it can be', () => {
  // Three genuinely distinct duplicates, and the third is the silent killer the other two cannot
  // see: a hooks file that is BOTH auto-discovered and named in plugin.json makes Claude Code
  // report "Duplicate hooks file detected" and fail the whole plugin's hook load.
  const identity = new Set()
  for (const h of HOOKS) {
    const script = (h.handler.args ?? [])[0] ?? h.handler.command ?? ''
    const key = `${h.plugin}|${h.event}|${h.matcher}|${script}`
    assert.equal(identity.has(key), false, `duplicate hook entry: ${key}`)
    identity.add(key)
  }

  const blocks = new Set()
  for (const h of HOOKS) {
    // Two separate matcher blocks for the same event+matcher would fire the hook twice per tool use.
    const key = `${h.plugin}|${h.event}|${h.matcher}|${h.blockIndex}`
    blocks.add(key)
    const collapsed = `${h.plugin}|${h.event}|${h.matcher}`
    const sameMatcherDifferentBlock = [...blocks].filter(
      (k) => k.startsWith(`${collapsed}|`) && k !== key,
    )
    assert.deepEqual(
      sameMatcherDifferentBlock,
      [],
      `${h.matcher} appears in more than one ${h.event} block`,
    )
  }

  for (const plugin of PLUGIN_DIRS) {
    const autoLoaded = exists(`plugins/${plugin}/hooks/hooks.json`)
    const declared = MANIFESTS[plugin].hooks !== undefined
    assert.equal(
      autoLoaded && declared,
      false,
      `${plugin}: hooks.json is auto-discovered AND named in plugin.json, which fails the whole hook load`,
    )
  }
})

test('no plugin manifest declares a hooks key', () => {
  // Generalised over both plugins; hook.security.test.mjs pins it for model-router specifically,
  // with the live-verified reasoning.
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    assert.equal('hooks' in manifest, false, `${name}/plugin.json must not declare hooks`)
  }
})

test('every hook handler is exec form with no timeout and a resolvable script', () => {
  for (const h of HOOKS) {
    const { handler } = h
    assert.equal(handler.type, 'command')
    assert.equal(handler.command, 'node', 'never bash, never a shell string')
    assert.ok(Array.isArray(handler.args) && handler.args.length >= 1)
    // `args` together with `timeout` is silently never executed.
    assert.equal('timeout' in handler, false, `${h.file}: a handler with args must not set timeout`)

    const script = handler.args[0]
    assert.ok(script.startsWith('${CLAUDE_PLUGIN_ROOT}/'), `${script} is not plugin-relative`)
    const resolved = script.replace('${CLAUDE_PLUGIN_ROOT}', `plugins/${h.plugin}`)
    assert.ok(exists(resolved), `${resolved} does not exist`)

    for (const piece of [handler.command, ...handler.args]) {
      assert.equal(/[&|;]|\$\(/.test(piece.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '')), false,
        `${piece} looks like a shell construct`)
    }
  }
})

/* -------------------------------------------------------- declared paths */

test('every declared component path exists and is non-empty', () => {
  // This is what forces honesty about skills: model-router declared "./skills/" against three
  // EMPTY directories, and `plugin validate --strict` accepts an empty directory.
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    for (const key of ['skills', 'commands', 'agents']) {
      const declared = manifest[key]
      if (declared === undefined) continue
      const rel = path.posix.join(`plugins/${name}`, declared)
      assert.ok(exists(rel), `${name} declares ${key} at ${declared}, which does not exist`)
      const entries = fs.readdirSync(path.join(REPO_ROOT, rel))
      assert.ok(entries.length > 0, `${name} declares ${key} at ${declared}, which is empty`)
      if (key === 'skills') {
        for (const entry of entries) {
          const skillDir = path.join(REPO_ROOT, rel, entry)
          if (!fs.statSync(skillDir).isDirectory()) continue
          const skill = path.join(skillDir, 'SKILL.md')
          assert.ok(fs.existsSync(skill), `${entry} has no SKILL.md`)
          const front = fs.readFileSync(skill, 'utf8')
          assert.match(front, /^---[\s\S]*?\bname:/m, `${entry}/SKILL.md needs a name`)
          assert.match(front, /^---[\s\S]*?\bdescription:/m, `${entry}/SKILL.md needs a description`)
        }
      }
    }
  }
})

test('an auto-loaded component directory is never left empty', () => {
  // `commands/` and `skills/` auto-load when the manifest is silent, so an empty one is a
  // declaration by another route. The three empty skill directories were invisible to git, which
  // does not track empty directories, and so survived review.
  for (const plugin of PLUGIN_DIRS) {
    for (const key of ['commands', 'skills', 'agents']) {
      const rel = `plugins/${plugin}/${key}`
      if (!exists(rel)) continue
      assert.ok(
        fs.readdirSync(path.join(REPO_ROOT, rel)).length > 0,
        `${rel} exists but is empty — delete it or fill it`,
      )
    }
  }
})

test('no plugin carries an undeclared top-level directory', () => {
  const ALLOWED = new Set(['.claude-plugin', 'lib', 'scripts', 'hooks', 'skills', 'commands', 'agents'])
  for (const plugin of PLUGIN_DIRS) {
    const entries = fs
      .readdirSync(path.join(REPO_ROOT, 'plugins', plugin), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    const unexpected = entries.filter((e) => !ALLOWED.has(e))
    assert.deepEqual(unexpected, [], `${plugin} has an unrecognised directory`)
  }
})

/* ----------------------------------------------------------------- claims */

test('no manifest string makes a forbidden claim', () => {
  // Scoped to MANIFESTS and marketplace.json only. The README legitimately credits Spotify's
  // `shunt` as inspiration with a not-affiliated disclaimer, and must not be a false positive here.
  const FORBIDDEN = [
    [/\bguarantee(s|d)?\b/i, 'nothing here is guaranteed; every bundled rate ships null'],
    [/\bofficial\b/i, 'this is not an Anthropic or Spotify product'],
    [/\bspotify\b|\bportal\b/i, 'inspired-by belongs in the README, not a manifest'],
    [/\b(?:up to|at least)\s*\d+\s*%/i, 'no percentage savings claim'],
    [/\bfree\b|\bzero[- ]cost\b/i, 'the worker costs money; we just cannot always price it'],
  ]
  const strings = [
    MARKETPLACE.name,
    MARKETPLACE.description,
    ...MARKETPLACE.plugins.flatMap((p) => [p.name, p.description, ...(p.keywords ?? [])]),
    ...Object.values(MANIFESTS).flatMap((m) => [
      m.name,
      m.displayName,
      m.description,
      ...(m.keywords ?? []),
      ...Object.values(m.userConfig ?? {}).flatMap((o) => [o.title, o.description]),
    ]),
  ].filter(Boolean)

  const findings = []
  for (const s of strings) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(s)) findings.push(`${why}: ${JSON.stringify(s.slice(0, 80))}`)
    }
  }
  assert.deepEqual(findings, [])
})

test('a manifest that mentions a component ships that component', () => {
  // The RULE behind the skills fix, rather than a hardcoded string, so it keeps working after the
  // next description rewrite. Both descriptions claimed "skills steer delegation" while the plugin
  // shipped none.
  for (const [name, manifest] of Object.entries(MANIFESTS)) {
    const blurbs = [manifest.description ?? '']
    const entry = MARKETPLACE.plugins.find((p) => p.name === name)
    if (entry) blurbs.push(entry.description ?? '')
    for (const blurb of blurbs) {
      if (/\bskills?\b/i.test(blurb)) {
        const dir = `plugins/${name}/skills`
        assert.ok(
          exists(dir) && fs.readdirSync(path.join(REPO_ROOT, dir)).length > 0,
          `${name} describes skills but ships none`,
        )
      }
      if (/\bslash commands?\b/i.test(blurb)) {
        const dir = `plugins/${name}/commands`
        assert.ok(
          exists(dir) && fs.readdirSync(path.join(REPO_ROOT, dir)).length > 0,
          `${name} describes slash commands but ships none`,
        )
      }
    }
  }
})

/* ------------------------------------------------------------- the CLIs */

test('every public command answers --version with the release version', () => {
  // A marketplace install has no other way to be asked its version: `npm ls` is meaningless on a
  // private package, and the installed path is not a documented contract. It is also the first
  // thing a bug report needs.
  //
  // The hook is deliberately NOT in this list: it reads stdin, writes at most one JSON object and
  // must not grow a flag parser.
  const COMMANDS = [
    'plugins/model-router/scripts/doctor.mjs',
    'plugins/model-router/scripts/budget.mjs',
    'plugins/model-router/scripts/analytics.mjs',
    'plugins/router-dashboard/scripts/report.mjs',
  ]
  for (const cmd of COMMANDS) {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, cmd), '--version'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })
    assert.equal(r.status, 0, `${cmd} --version exited ${r.status}: ${r.stderr}`)
    assert.equal(r.stdout.trim(), PKG.version, `${cmd} reported the wrong version`)
  }
})

/* -------------------------------------------------------- compatibility */

test('CI tests the Node floor that package.json declares', () => {
  // Makes the compatibility decision self-enforcing rather than a one-time edit. Regex over YAML
  // is a smell; it is acceptable here because the file is ours and the assertion is
  // substring-presence, not a structural parse.
  const floor = PKG.engines.node.replace(/^[^\d]*/, '')
  const [major, minor] = floor.split('.')
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
  const versions = [...ci.matchAll(/node(?:-version)?:\s*'?([\d.]+)'?/g)].map((m) => m[1])
  assert.ok(versions.length > 0, 'no node versions found in ci.yml')
  assert.ok(
    versions.some((v) => v === floor || v.startsWith(`${major}.${minor}`)),
    `engines.node declares >=${floor} but CI tests only ${versions.join(', ')}`,
  )
})

test('package.json makes no claim it cannot keep', () => {
  // `os` and `cpu` are npm INSTALL gates on a package that is never npm-installed. Declaring them
  // would imply a restriction nothing enforces, and the macOS CI leg disproves it anyway.
  assert.equal('os' in PKG, false)
  assert.equal('cpu' in PKG, false)
  assert.equal(PKG.private, true, 'this package publishes nothing to npm')
  assert.equal(PKG.license, 'Apache-2.0')
  for (const manifest of Object.values(MANIFESTS)) {
    assert.equal(manifest.license, PKG.license, 'a plugin manifest disagrees about the license')
  }
})

test('the version sync targets cover every file that carries a version', () => {
  // A new manifest, or a third plugin, must be added to the sync table or it will drift silently.
  const covered = new Set([...JSON_TARGETS.map((t) => t.file), ...MODULE_TARGETS.map((t) => t.file)])
  for (const plugin of PLUGIN_DIRS) {
    assert.ok(
      covered.has(`plugins/${plugin}/.claude-plugin/plugin.json`),
      `plugins/${plugin}/.claude-plugin/plugin.json is not in the sync table`,
    )
  }
  assert.ok(covered.has('.claude-plugin/marketplace.json'))
})
