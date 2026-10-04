/**
 * A packaging-level secret audit: nothing shipped, generated or printed contains a credential.
 *
 * EVERY PATTERN IS LENGTH- OR STRUCTURE-ANCHORED, which is the only reason this suite is usable at
 * all. The documentation legitimately contains `GEMINI_API_KEY`, `setx GEMINI_API_KEY "your-key"`,
 * `${GEMINI_API_KEY}` and a description of doctor printing `starts "AIza…"`. A naive
 * "does it mention a key" scan would fire on all four, somebody would add an allowlist, and the
 * allowlist would be where the first real leak went to die quietly.
 *
 * So a Google key is `AIza` plus EXACTLY 35 more characters. `AIza…`, `AIza...` and `"AIza"` do
 * not match, and a real key cannot avoid matching.
 *
 * TWO RULES ARE DELIBERATELY NOT IMPLEMENTED. A 40-character hex blob and a long base64 run are
 * the obvious additions, and both are useless here: this project HASHES paths and content on
 * purpose, so a 40-hex string is indistinguishable from a telemetry content hash, and base64
 * appears in fixtures. They would be all allowlist and no signal. Saying so here is better than
 * shipping them disabled.
 *
 * THERE IS NO ALLOWLIST FILE, on purpose. Nothing currently needs one, and an allowlist is the
 * fastest way to silence a true positive: somebody pastes a key, the suite fails, and the quickest
 * fix becomes a new allowlist line. If an unavoidable exception ever appears, the right form is an
 * inline comment on the offending line, scoped to that line and that pattern.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { makeCleanInstall, REPO_ROOT, scriptPath } from './helpers/clean-install.mjs'

/* ------------------------------------------------------------------ patterns */

export const PATTERNS = Object.freeze([
  // Google/Gemini: the prefix plus exactly 35 more. An elided example cannot reach the length.
  { id: 'gemini_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { id: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'private_key_block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
])

/**
 * A `KEY=value` assignment whose value is not obviously a placeholder.
 *
 * The one pattern that needs a notion of "a placeholder", because the docs are full of
 * `export GEMINI_API_KEY=your-key` and that must not be a finding.
 */
/*
 * Two forms only: `NAME=value` (with an optional `export`), and `setx NAME value`.
 *
 * An earlier version also accepted bare whitespace as the separator, which made the English
 * sentence "GEMINI_API_KEY is not set, so nothing will be delegated yet" an assignment whose value
 * was "is not set, so nothing...". Documentation that talks ABOUT a variable is the common case in
 * this repo, so the separator has to be the thing that actually denotes assignment.
 */
const ASSIGNMENT = new RegExp(
  [
    '^[ \\t]*(?:export[ \\t]+)?([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?)[ \\t]*=[ \\t]*(.+)$',
    '^[ \\t]*setx[ \\t]+([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?)[ \\t]+(.+)$',
  ].join('|'),
  'gm',
)

/** Is this value plainly an example rather than a credential? */
export function isPlaceholder(raw) {
  const v = String(raw).trim().replace(/^["']|["'][,;]?$/g, '').trim()
  if (v === '') return true
  if (/^(?:your|my|the|a)[-_ ]?(?:new[-_ ]?)?(?:api[-_ ]?)?(?:key|token|secret|password)\b/i.test(v)) return true
  if (/^<[^>]*>$/.test(v)) return true
  if (v === '...' || v.includes('…')) return true
  if (/^\$\{?[A-Za-z_]/.test(v) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v)) return true // a variable reference
  if (/^(?:x{3,}|placeholder|redacted|example|dummy|fake|test|changeme|none|null)/i.test(v)) return true
  if (/^\*+$/.test(v)) return true
  return false
}

/** Every finding in a blob of text, as `patternId@line`. */
export function scanText(text, label) {
  const findings = []
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    for (const { id, re } of PATTERNS) {
      if (re.test(line)) findings.push(`${label}:${i + 1}:${id}`)
    }
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    // Two alternations: groups 1/2 for `NAME=value`, groups 3/4 for `setx NAME value`.
    const name = m[1] ?? m[3]
    const value = m[2] ?? m[4]
    if (isPlaceholder(value)) continue
    const line = text.slice(0, m.index).split('\n').length
    findings.push(`${label}:${line}:env_assignment(${name})`)
  }
  return findings
}

/* -------------------------------------------------------------- the census */

const TEXT_EXT = new Set([
  '.md', '.json', '.mjs', '.js', '.ts', '.yml', '.yaml', '.txt', '.html', '.sh', '.ps1', '.jsonl',
])
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'sandbox'])

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (TEXT_EXT.has(path.extname(entry.name)) || entry.name === 'LICENSE') out.push(p)
  }
  return out
}

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/')

/**
 * The one legitimate home for credential-shaped strings: the suites whose JOB is to prove a secret
 * does not leak. They have to contain something that looks like a secret in order to feed it in.
 *
 * Declared by name with a reason, never by a pattern like "any file with security in the name" —
 * that would let a real leak hide behind a filename. Each of these is a synthetic value made of
 * repeated characters, and `test('no synthetic fixture is a real credential')` below checks that
 * claim rather than trusting it.
 */
const FIXTURE_FILES = Object.freeze({
  'test/dispatch.security.test.mjs': 'feeds synthetic keys through dispatch to prove none is sent',
  'test/hook.security.test.mjs': 'feeds synthetic keys through the hook to prove none reaches a row',
  'test/task.security.test.mjs': 'pins the redaction boundary in both directions',
  'test/providers.conformance.test.mjs': 'drives redactSecrets() over every credential shape it claims to handle',
  'test/secrets.hygiene.test.mjs': 'this suite, whose patterns and probes are example credentials',
})

const ALL_FILES = walk(REPO_ROOT)
const FILES = ALL_FILES.filter((f) => FIXTURE_FILES[rel(f)] === undefined)

/**
 * A credential-shaped value assembled at RUNTIME.
 *
 * Never written as a literal, so the repo-wide scan below stays universal: a literal test key in
 * this file would be a finding in this file, and exempting it would weaken the whole suite.
 */
const SYNTHETIC_KEY = `AIza${'Sy'}${'T'.repeat(33)}`

/* ------------------------------------------------------- the suite is armed */

test('the file census is non-empty and covers what it claims to', () => {
  // A scan over an empty list passes by scanning nothing.
  assert.ok(FILES.length > 100, `only ${FILES.length} files found`)
  const names = FILES.map(rel)
  for (const required of [
    'README.md',
    'SECURITY.md',
    'docs/configuration.md',
    'docs/providers.md',
    'examples/model-router.json',
    'plugins/model-router/lib/config.mjs',
  ]) {
    assert.ok(names.includes(required), `${required} was not scanned`)
  }
  assert.ok(names.some((n) => n.startsWith('test/fixtures/')), 'fixtures were not scanned')
})

test('the patterns catch a real-shaped key and ignore an elided one', () => {
  // Proof the suite can fail, and proof it will not fail on the documentation.
  assert.equal(SYNTHETIC_KEY.length, 39, 'a Google key is AIza plus 35')
  assert.deepEqual(scanText(SYNTHETIC_KEY, 'probe'), ['probe:1:gemini_key'])

  for (const benign of [
    'starts "AIza…"',
    'AIza...',
    'set GEMINI_API_KEY in your environment',
    'export GEMINI_API_KEY=your-key',
    'setx GEMINI_API_KEY "your-key"',
    '"apiKeyEnv": "GEMINI_API_KEY"',
    '"$GEMINI_API_KEY"',
    '${GEMINI_API_KEY}',
    'MY_API_KEY=<your-key-here>',
    'Bearer $TOKEN',
    'Bearer <token>',
  ]) {
    assert.deepEqual(scanText(benign, 'benign'), [], `false positive on: ${benign}`)
  }

  // And the assignment rule does fire on something that is not a placeholder.
  assert.ok(scanText('MY_API_KEY=A1b2C3d4E5f6G7h8', 'probe').length > 0)
})

/* ------------------------------------------------------- committed content */

test('no committed file contains a credential', () => {
  const findings = []
  for (const file of FILES) {
    findings.push(...scanText(fs.readFileSync(file, 'utf8'), rel(file)))
  }
  assert.deepEqual(findings, [])
})

test('every exempted fixture file exists, is still a security suite, and is synthetic', () => {
  // The exemption has to be audited or it is just a hole. Three claims: the file is real, it
  // actually exercises redaction (so the exemption is earned), and its credential-shaped strings
  // are low-entropy synthetics rather than anything anybody could use.
  for (const [file, reason] of Object.entries(FIXTURE_FILES)) {
    const abs = path.join(REPO_ROOT, file)
    assert.ok(fs.existsSync(abs), `${file} is exempted but does not exist`)
    assert.ok(reason.length > 20, `${file} needs a real reason`)
    const src = fs.readFileSync(abs, 'utf8')
    assert.match(
      src,
      /redact|secret|credential/i,
      `${file} is exempted from the secret scan but is not about secrets`,
    )

    // Any credential-shaped literal in these files must be obviously fabricated: a run of one
    // repeated character, an `abcdef`-style sequence, or an explicit placeholder word.
    for (const { id, re } of PATTERNS) {
      const global = new RegExp(re.source, 'g')
      for (const m of src.matchAll(global)) {
        const hit = m[0]
        const synthetic =
          /(.)\1{5,}/.test(hit) || // aaaaaa...
          /abcdef|ABCDEF|0123456789|deadbeef/i.test(hit) ||
          /placeholder|example|dummy|fake|test|redacted/i.test(hit) ||
          // Self-describing fabrications. A real credential does not announce itself, so a value
          // that says SUPERSECRET or DO-NOT-LEAK is by construction not one.
          /supersecret|do[-_]?not[-_]?leak|should[-_]?not[-_]?leak|notareal|invalid/i.test(hit) ||
          /-----BEGIN/.test(hit) // a header, with no key material in the match
        assert.ok(
          synthetic,
          `${file} contains a ${id} that does not look obviously synthetic: ${hit.slice(0, 16)}…`,
        )
      }
    }
  }
})

test('no .env file is committed', () => {
  const dotenv = FILES.map(rel).filter((f) => /(^|\/)\.env($|\.)/.test(f))
  assert.deepEqual(dotenv, [])
  // Nor any file that looks like a key store.
  const keyish = FILES.map(rel).filter((f) => /\.(?:pem|p12|pfx|key)$/.test(f))
  assert.deepEqual(keyish, [])
})

test('no config example can hold a key, because no such field exists', () => {
  // The structural version of the claim: the schema has no property that would accept one.
  const schema = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'plugins/model-router/lib/config.schema.json'), 'utf8'),
  )
  const offenders = []
  const walkSchema = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      const here = at === '' ? k : `${at}.${k}`
      // `apiKeyEnv` is the NAME of a variable and is the sanctioned spelling.
      if (/(?:apikey|token|secret|password|credential)$/i.test(k)) offenders.push(here)
      walkSchema(v, here)
    }
  }
  walkSchema(schema, '')
  assert.deepEqual(offenders, [], 'a config property would accept a raw credential')
})

/* ------------------------------------------------------ generated artefacts */

test('a generated report embeds no credential, no source content and no local path', () => {
  // The end-to-end version. dashboard.security.test.mjs already proves the RENDERER is safe over
  // doctored fields; this proves the PIPELINE is, over a real store, with a real key in the
  // environment and a real path on disk.
  const ci = makeCleanInstall({ label: 'secrets-report', env: { GEMINI_API_KEY: SYNTHETIC_KEY } })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    for (const day of ['02', '03', '04']) {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', `events-2026-03-${day}.jsonl`),
        path.join(ci.storeDir, `events-2026-03-${day}.jsonl`),
      )
    }
    const out = path.join(ci.base, 'report.html')
    const r = spawnSync(
      process.execPath,
      [
        scriptPath('plugins/router-dashboard/scripts/report.mjs'),
        '--out', out,
        '--now', '2026-03-04T12:00:00.000Z',
        '--no-color',
      ],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)

    const html = fs.readFileSync(out, 'utf8')
    assert.deepEqual(scanText(html, 'report.html'), [])
    assert.equal(html.includes(SYNTHETIC_KEY), false, 'the key reached the report')
    assert.equal(html.includes('GEMINI_API_KEY'), false, 'even the variable NAME should not appear')

    // No content from any file the router read. Trivially true today; the point is that it stays
    // true if a sample or excerpt column is ever added to the schema.
    const corpus = fs.readFileSync(
      path.join(REPO_ROOT, 'test', 'fixtures', 'corpus', 'large.ts'),
      'utf8',
    )
    const distinctive = corpus.split('\n').find((l) => l.trim().length > 40)
    assert.ok(distinctive, 'the corpus fixture should have a long line to look for')
    assert.equal(html.includes(distinctive.trim()), false, 'source content reached the report')

    // And no path from the generating machine.
    assert.equal(html.includes(os.homedir()), false, 'the home directory reached the report')
    assert.equal(html.includes(REPO_ROOT), false, 'the repository path reached the report')
    assert.equal(html.includes(ci.storeDir), false, 'the store path reached the report')
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------------------- CLI output */

test('no command prints a credential, even with a real-shaped one set', () => {
  // The behavioural half, and the one that matters: doctor.test.mjs checks this in-process with a
  // short literal, but a four-character prefix is deliberately printed, so the question is whether
  // the WHOLE value can ever appear. Run over all four commands and both streams.
  const ci = makeCleanInstall({ label: 'secrets-cli', env: { GEMINI_API_KEY: SYNTHETIC_KEY } })
  try {
    const commands = [
      ['plugins/model-router/scripts/doctor.mjs', ['--offline', '--no-color']],
      ['plugins/model-router/scripts/doctor.mjs', ['--offline', '--json']],
      ['plugins/model-router/scripts/budget.mjs', ['--no-color']],
      ['plugins/model-router/scripts/analytics.mjs', ['--no-color']],
      ['plugins/model-router/scripts/analytics.mjs', ['--json']],
    ]
    for (const [script, args] of commands) {
      const r = spawnSync(process.execPath, [scriptPath(script), ...args], {
        encoding: 'utf8',
        env: ci.env,
      })
      const label = `${path.basename(script)} ${args.join(' ')}`
      const both = `${r.stdout}\n${r.stderr}`
      assert.equal(both.includes(SYNTHETIC_KEY), false, `${label} printed the key`)
      assert.deepEqual(scanText(both, label), [], `${label} printed something credential-shaped`)
    }
  } finally {
    ci.cleanup()
  }
})

test('doctor reports a key by shape, which is what makes its output pasteable', () => {
  // The control: doctor must still say something useful about the key, or the test above would
  // pass for a tool that had simply stopped checking.
  const ci = makeCleanInstall({ label: 'secrets-shape', env: { GEMINI_API_KEY: SYNTHETIC_KEY } })
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/doctor.mjs'), '--offline', '--json'],
      { encoding: 'utf8', env: ci.env },
    )
    const report = JSON.parse(r.stdout)
    const finding = report.sections
      .flatMap((s) => s.findings)
      .find((f) => f.label.includes('GEMINI_API_KEY'))
    assert.ok(finding, 'doctor must still report on the key')
    assert.equal(finding.level, 'pass')
    assert.match(finding.detail, /39 chars/)
    assert.match(finding.detail, /starts "AIza…"/)
    // Four characters, and no more.
    assert.equal(finding.detail.includes(SYNTHETIC_KEY.slice(0, 8)), false)
  } finally {
    ci.cleanup()
  }
})

test('a telemetry row never carries the credential', () => {
  // The write path's own guarantee, over the committed fixtures: whatever a row contains, it is
  // not a key. Cheap, and it covers the store a developer would be sharing.
  const dir = path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.deepEqual(scanText(text, `fixtures/${file}`), [])
    for (const field of ['api_key', 'apiKey', 'authorization', 'Authorization']) {
      assert.equal(text.includes(field), false, `${file} carries a ${field} field`)
    }
  }
})
