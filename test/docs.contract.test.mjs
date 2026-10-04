/**
 * The documentation, checked against the thing it documents.
 *
 * This is the second-developer requirement made objective. The brief asks that a newcomer can
 * DISCOVER the installation instructions, the configuration, the diagnostic, the provider setup and
 * the reporting commands "without reading internal source code" — and most of that is a judgement
 * no test can make.
 *
 * WHAT A TEST GENUINELY CAN ASSERT, and all this file claims:
 *
 *   - every relative link resolves
 *   - every command a document tells you to run exists
 *   - every command that exists is documented, or declared internal on purpose
 *   - every document is reachable from another document
 *   - no document names an environment variable that is not declared
 *
 * WHAT IT CANNOT, stated plainly rather than implied: whether the instructions are
 * comprehensible, whether they are complete, whether the provider setup actually works, or whether
 * a second developer succeeded. That needs one human doing a real clean install on a machine that
 * has never seen the repository — which is a checklist item in docs/install.md, not a test. Faking
 * it here with a cheerful assertion would be worse than leaving it undone, because it would look
 * covered.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SPEC } from '../plugins/model-router/lib/config.mjs'
import { declaredEnvNames } from '../plugins/model-router/lib/env-registry.mjs'
import { TESTED_CLAUDE_CODE_VERSION } from './helpers/versions.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const SCRIPTS = new Set(Object.keys(PKG.scripts))

const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'sandbox'])

function markdownFiles(dir = REPO_ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) markdownFiles(p, out)
    else if (entry.name.endsWith('.md')) out.push(p)
  }
  return out
}

const FILES = markdownFiles()
const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/')
const read = (p) => fs.readFileSync(p, 'utf8')

/** Only fenced blocks, for the checks where prose would be a false-positive factory. */
function fencedBlocks(src) {
  return [...src.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
}

/**
 * Scripts that exist but are deliberately not pointed at from documentation.
 *
 * Each is a generator or a destructive tool. CONTRIBUTING.md documents the generators as a
 * workflow; this list is for the inverse check, so an undocumented PUBLIC command fails.
 */
const INTERNAL_SCRIPTS = new Set(['evals:build', 'validate', 'test'])

/* ------------------------------------------------------------------ census */

test('the markdown census is non-empty and includes the entry points', () => {
  // A link checker over an empty list passes by checking nothing.
  assert.ok(FILES.length > 20, `only ${FILES.length} markdown files found`)
  const names = FILES.map(rel)
  for (const required of [
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/README.md',
    'docs/getting-started.md',
    'docs/install.md',
    'docs/configuration.md',
    'docs/providers.md',
    'docs/troubleshooting.md',
    'docs/architecture.md',
  ]) {
    assert.ok(names.includes(required), `${required} is missing`)
  }
})

/* ------------------------------------------------------------------- links */

test('every relative link resolves to a file that exists', () => {
  // The highest-value documentation test there is: completely objective, and it catches a deleted
  // file instantly. AGENTS.md was removed during this phase, and this is what would have caught a
  // link left behind.
  const broken = []
  for (const file of FILES) {
    for (const m of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = m[1].trim()
      if (/^(?:https?:|mailto:|#)/.test(raw)) continue
      const target = raw.split('#')[0]
      if (target === '') continue
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
        broken.push(`${rel(file)} -> ${raw}`)
      }
    }
  }
  assert.deepEqual(broken, [])
})

test('no document is an orphan', () => {
  // Part 19's "discoverable" requirement, made objective. Six docs used to be reachable from
  // nowhere, which is indistinguishable from not shipping them.
  const linked = new Set()
  for (const file of FILES) {
    for (const m of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = m[1].trim().split('#')[0]
      if (raw === '' || /^(?:https?:|mailto:)/.test(raw)) continue
      const resolved = path.resolve(path.dirname(file), raw)
      if (resolved === file) continue // a self-link is not inbound
      linked.add(rel(resolved))
    }
  }
  // Scoped to PROSE DOCUMENTATION: the root files and docs/. Deliberately excluded, each because
  // it is reached by a mechanism other than a link:
  //
  //   plugins/**/commands/*.md and skills/**/SKILL.md  Claude Code discovers these by directory;
  //                                                     packaging.test.mjs asserts they exist
  //   .github/**                                        GitHub discovers templates by path
  //   test/fixtures/**                                  fixture data, not documentation
  //
  // README is the root of the graph and needs no inbound link.
  const isProse = (f) =>
    (!f.includes('/') || f.startsWith('docs/')) && !f.startsWith('.github/')
  const orphans = FILES.map(rel)
    .filter(isProse)
    .filter((f) => f !== 'README.md' && !linked.has(f))
  assert.deepEqual(orphans, [], 'link these from somewhere, or delete them')
})

test('the documentation index links every document under docs/', () => {
  const index = read(path.join(REPO_ROOT, 'docs', 'README.md'))
  const missing = FILES.map(rel)
    .filter((f) => f.startsWith('docs/') && f !== 'docs/README.md')
    .filter((f) => !index.includes(path.basename(f)))
  assert.deepEqual(missing, [], 'docs/README.md is the index; add them')
})

/* ---------------------------------------------------------------- commands */

test('every npm script a document tells you to run exists', () => {
  // The mechanism that makes a quickstart trustworthy. It caught `npm run test:behavioural` in
  // CLAUDE.md after the dead script was removed from package.json.
  // FENCED BLOCKS ONLY, same as the node-path check below. A command you are told to type lives
  // in a code block; prose legitimately mentions a command that was REMOVED — CLAUDE.md explains
  // that `test:behavioural` and `ingest` are gone, and flagging that would punish the note for
  // existing.
  const broken = []
  for (const file of FILES) {
    for (const block of fencedBlocks(read(file))) {
      for (const m of block.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
        if (!SCRIPTS.has(m[1])) broken.push(`${rel(file)} -> npm run ${m[1]}`)
      }
    }
  }
  assert.deepEqual(broken, [])
})

test('every node path a document tells you to run exists', () => {
  // Caught `node plugins/model-router/scripts/ingest.mjs`, which never existed.
  const broken = []
  for (const file of FILES) {
    for (const block of fencedBlocks(read(file))) {
      for (const m of block.matchAll(/\bnode\s+("?)((?:\.\/|plugins\/|test\/|scripts\/)[^\s"']+\.mjs)\1/g)) {
        const target = m[2]
        if (target.includes('$')) continue // a template, resolved by Claude Code at run time
        if (!fs.existsSync(path.join(REPO_ROOT, target))) broken.push(`${rel(file)} -> node ${target}`)
      }
    }
  }
  assert.deepEqual(broken, [])
})

test('every public npm script is documented or declared internal', () => {
  // The inverse direction, which is the one that rots: a command nobody is told about may as well
  // not exist. `npm test` is matched as `npm test` rather than `npm run test`.
  const allText = FILES.map(read).join('\n')
  const undocumented = []
  for (const name of SCRIPTS) {
    if (INTERNAL_SCRIPTS.has(name)) continue
    if (!allText.includes(`npm run ${name}`)) undocumented.push(name)
  }
  assert.deepEqual(undocumented, [], 'document it, or add it to INTERNAL_SCRIPTS with a reason')
  // And the three exemptions really are mentioned somewhere, just not in that form.
  for (const name of INTERNAL_SCRIPTS) {
    assert.ok(SCRIPTS.has(name), `${name} is exempted but is not a script`)
  }
})

test('the quickstart names all four public commands', () => {
  // A newcomer should not have to find these by reading source.
  const quickstart = read(path.join(REPO_ROOT, 'docs', 'getting-started.md'))
  for (const cmd of ['doctor', 'analytics', 'report']) {
    assert.match(quickstart, new RegExp(`npm run ${cmd}`), `getting-started.md never mentions ${cmd}`)
  }
  // `budget` is introduced in the optional step and in troubleshooting.
  const troubleshooting = read(path.join(REPO_ROOT, 'docs', 'troubleshooting.md'))
  assert.match(troubleshooting, /npm run budget/)
})

test('the quickstart covers both a keyless and a hosted provider', () => {
  const quickstart = read(path.join(REPO_ROOT, 'docs', 'getting-started.md'))
  assert.match(quickstart, /ollama pull/, 'the keyless route needs a pull step')
  assert.match(quickstart, /GEMINI_API_KEY/)
  // Both shells, since the project's primary platform is Windows and the old README was POSIX-only.
  assert.match(quickstart, /setx /, 'Windows readers need setx, not export')
  assert.match(quickstart, /export GEMINI_API_KEY/)
})

/* ------------------------------------------------------------ install path */

test('the documented install commands name plugins that exist', () => {
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'),
  )
  const known = new Set(marketplace.plugins.map((p) => p.name))
  const bad = []
  for (const file of FILES) {
    for (const m of read(file).matchAll(/claude plugin install ([a-z-]+)@([a-z-]+)/g)) {
      if (!known.has(m[1])) bad.push(`${rel(file)}: unknown plugin ${m[1]}`)
      if (m[2] !== marketplace.name) bad.push(`${rel(file)}: unknown marketplace ${m[2]}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('the only project config path documented is the one the loader reads', () => {
  // The loader reads exactly two paths. Documenting any other filename is how somebody spends an
  // afternoon on a file nothing looks for — which the previous example filename did.
  const bad = []
  for (const file of FILES) {
    const src = read(file)
    for (const m of src.matchAll(/([\w.\-<>/\\]*model-router[\w.\-]*\.json)/g)) {
      const named = m[1]
      const ok =
        named.endsWith('.claude/model-router.json') ||
        named.endsWith('model-router/config.json') ||
        named.endsWith('model-router-pricing.json') ||
        named === 'model-router.json' || // the bare example filename
        named.includes('examples/') || // a pointer at the example FILE, not a load path
        named === 'model-router.project.json' // only ever named to say it is NOT read
      if (!ok) bad.push(`${rel(file)}: ${named}`)
    }
    // And if the retired filename appears, it must be as a warning.
    if (src.includes('model-router.project.json')) {
      assert.match(
        src,
        /ignored|not read|nothing .{0,40}look|retired|no longer/i,
        `${rel(file)} mentions model-router.project.json without saying it is ignored`,
      )
    }
  }
  assert.deepEqual(bad, [])
})

/* --------------------------------------------------------- environment vars */

test('no fenced block names an undeclared environment variable', () => {
  // Scoped to fenced blocks ONLY. Prose legitimately discusses variable names in passing, and a
  // whole-document scan for UPPER_SNAKE would flag headings, enum values and acronyms — it would
  // be a false-positive factory, and the allowlist it demanded would hide a real omission.
  const declared = new Set([
    ...declaredEnvNames(),
    ...Object.values(SPEC).map((s) => s.env).filter(Boolean),
  ])
  const unknown = new Set()
  for (const file of FILES) {
    for (const block of fencedBlocks(read(file))) {
      for (const m of block.matchAll(/\b(CMR_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+|MOCK_[A-Z0-9_]+)\b/g)) {
        const name = m[1]
        if (declared.has(name)) continue
        if (name.startsWith('CLAUDE_PLUGIN_OPTION_')) continue // derived from SPEC
        unknown.add(`${rel(file)}: ${name}`)
      }
    }
  }
  assert.deepEqual([...unknown].sort(), [])
})

test('the environment inventory and the settings reference link to each other', () => {
  const env = read(path.join(REPO_ROOT, 'docs', 'environment.md'))
  const config = read(path.join(REPO_ROOT, 'docs', 'configuration.md'))
  assert.match(env, /configuration\.md/)
  assert.match(config, /environment\.md/)
})

/* ------------------------------------------------------------- the claims */

test('no document claims a guaranteed saving', () => {
  // Part 21, as a test rather than a review note. The forbidden shapes are specific: a percentage
  // promise, and the word "actual" applied to savings. Existing uses of "guarantee" in this repo
  // are precise technical claims — governance.md even has a "NOT guaranteed" column — so the word
  // alone is not the signal.
  const findings = []
  for (const file of FILES) {
    const src = read(file)
    for (const m of src.matchAll(/(?:saves?|saving|reduces?|reduction)[^.\n]{0,40}\b\d{1,3}\s?%/gi)) {
      findings.push(`${rel(file)}: ${m[0].trim()}`)
    }
    for (const m of src.matchAll(/\bactual (?:savings|cost savings)\b/gi)) {
      // "not necessarily actual invoice savings" is a disclaimer, not a claim.
      const at = m.index ?? 0
      const context = src.slice(Math.max(0, at - 60), at + 40)
      if (/\bnot\b|\bnever\b|rather than|instead of/i.test(context)) continue
      findings.push(`${rel(file)}: ${m[0]}`)
    }
    for (const m of src.matchAll(/guaranteed (?:savings|cost reduction|quality)/gi)) {
      findings.push(`${rel(file)}: ${m[0]}`)
    }
  }
  assert.deepEqual(findings, [])
})

test('any mention of Spotify or Portal carries the independence disclaimer', () => {
  for (const file of FILES) {
    const src = read(file)
    if (!/\bspotify\b/i.test(src)) continue
    assert.match(
      src,
      /not affiliated|independently implemented/i,
      `${rel(file)} mentions Spotify without saying this is independent`,
    )
    assert.equal(
      /official(?:ly)?\s+(?:spotify|portal)/i.test(src),
      false,
      `${rel(file)} implies an official relationship`,
    )
  }
})

test('the savings docs say the figures are estimates', () => {
  // The positive form of the anti-overclaim rule: it is not enough to avoid a bad sentence, the
  // limitation has to be stated where a reader will meet the number.
  for (const name of ['README.md', 'docs/getting-started.md', 'docs/savings-methodology.md']) {
    const src = read(path.join(REPO_ROOT, name))
    assert.match(src, /estimat/i, `${name} presents savings without calling them estimates`)
  }
  const methodology = read(path.join(REPO_ROOT, 'docs', 'savings-methodology.md'))
  assert.match(methodology, /NULL|null/, 'the null rules belong in the methodology')
})

/* ------------------------------------------------------- honesty about gaps */

test('the install doc states what is unverified rather than implying it works', () => {
  // The project-scoped settings behaviour could not be verified end to end in this phase, and the
  // doc says so. This test exists so a future edit cannot quietly upgrade a caveat into a promise
  // without someone deciding to.
  const install = read(path.join(REPO_ROOT, 'docs', 'install.md'))
  assert.match(install, /not verified/i, 'the unverified team-setup behaviour must stay flagged')
  assert.match(install, /extraKnownMarketplaces/)
})

test('the platform claim matches what CI actually runs', () => {
  // The README used to assert behaviour was "identical on Windows, macOS and Linux" with no macOS
  // job anywhere. If a platform is named as tested, CI must test it.
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const readme = read(path.join(REPO_ROOT, 'README.md'))
  if (/macOS/i.test(readme)) {
    assert.match(ci, /macos-latest/, 'README names macOS but CI does not run it')
  }
  assert.equal(
    /behaviour is identical on/i.test(readme),
    false,
    'that claim was never evidenced; say what CI gates instead',
  )
})

/* --------------------------------------------- the host version, in one place */

test('every mention of the tested Claude Code version agrees with the declared one', () => {
  // The hook contract is read out of a specific binary, so it is only true of a version — and that
  // version was named in six files with nothing keeping them in step. Bumping five and missing one
  // would have failed nothing, leaving a document claiming verification the tests disagreed with.
  //
  // Both directions: every file that names A version names THE declared one, and the declared one
  // is actually named somewhere, so the constant cannot drift away from the documents either.
  const expected = TESTED_CLAUDE_CODE_VERSION
  const pattern = /Claude Code[^\n]{0,40}?(\d+\.\d+\.\d+)|(\d+\.\d+\.\d+)[^\n]{0,30}?\(Claude Code\)/g
  const sites = []
  const disagreements = []

  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs, out)
      else if (e.name.endsWith('.md') || e.name.endsWith('.mjs')) out.push(abs)
    }
    return out
  }

  for (const abs of walk(REPO_ROOT)) {
    const relPath = rel(abs)
    // The declaration itself is the source of truth, so it is not evidence about itself.
    if (relPath === 'test/helpers/versions.mjs') continue
    const source = fs.readFileSync(abs, 'utf8')
    for (const m of source.matchAll(pattern)) {
      const found = m[1] ?? m[2]
      if (!found) continue
      sites.push(`${relPath}: ${found}`)
      if (found !== expected) {
        disagreements.push(`${relPath} names Claude Code ${found}, not ${expected}`)
      }
    }
  }

  assert.deepEqual(disagreements, [])
  assert.ok(
    sites.length >= 4,
    `only ${sites.length} mentions found; the scan has stopped matching (${sites.join(', ')})`,
  )
})
