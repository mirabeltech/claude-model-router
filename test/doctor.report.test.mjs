/**
 * The doctor's severity model, driven from hand-built inputs.
 *
 * `test/doctor.test.mjs` SPAWNS the real script, which is the right way to pin an exit code and
 * the lines a human reads, but it is a slow and clumsy way to explore a decision matrix: every
 * case costs a process, and the only observable is stdout. This file drives the same decisions
 * directly, because they live in a pure module — the same argument
 * `test/governance.policy.test.mjs` makes about `describeGovernance()`.
 *
 * The two files are not redundant. This one says what the matrix IS; that one says the script
 * renders it and exits accordingly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apiKeyFinding,
  describeSecret,
  fail,
  FINDING_LEVELS,
  finding,
  info,
  LEVEL_FROM_GOVERNANCE,
  nodeFinding,
  pass,
  setKeyRemedy,
  summarize,
  toJson,
  warn,
} from '../plugins/model-router/lib/doctor/report.mjs'
import { GOVERNANCE_DECISIONS } from '../plugins/model-router/lib/governance/policy.mjs'

/* ------------------------------------------------------------- vocabulary */

test('there are exactly four levels, and info is one of them', () => {
  // `info` is the level that was missing. Without it, doctor emitted its echoes as raw dimmed
  // output outside the counters, which made an observation indistinguishable from a check that
  // had been skipped — and made a machine-readable report impossible.
  assert.deepEqual([...FINDING_LEVELS], ['pass', 'warn', 'fail', 'info'])
})

test('an unknown level is refused rather than silently rendered', () => {
  // Enums are open on READ in this codebase; a level is not a read value, it is a programming
  // mistake, and a typo'd level that rendered as blank would hide a finding.
  assert.throws(() => finding('warning', 'x'), /unknown finding level/)
})

test('a finding always carries a string detail, so a renderer never tests for undefined', () => {
  assert.equal(pass('a').detail, '')
  assert.equal(warn('a', undefined).detail, '')
  assert.equal(fail('a', 'd').detail, 'd')
})

test('every governance level maps to a doctor level, and nothing else does', () => {
  // The ONE adapter between the two vocabularies, mirroring statusForSource(). `describeGovernance`
  // emits only ok/warn/fail; if it ever grows a level, this must be the thing that fails.
  assert.deepEqual(Object.keys(LEVEL_FROM_GOVERNANCE).sort(), ['fail', 'ok', 'warn'])
  assert.equal(LEVEL_FROM_GOVERNANCE.ok, 'pass')
  assert.equal(LEVEL_FROM_GOVERNANCE.warn, 'warn')
  assert.equal(LEVEL_FROM_GOVERNANCE.fail, 'fail')
  for (const level of Object.values(LEVEL_FROM_GOVERNANCE)) {
    assert.ok(FINDING_LEVELS.includes(level))
  }
  // Governance decisions are a different vocabulary again and must not be confused with levels.
  assert.equal(GOVERNANCE_DECISIONS.includes('pass'), false)
})

/* ----------------------------------------------------------- the exit code */

test('only a failure moves the exit code', () => {
  // The property the whole four-level scheme rests on. A fresh install carries warnings BY
  // DESIGN — no key configured, nothing priced, no budget set — so a tool that exited non-zero
  // on its own shipped state would be useless.
  const sections = [
    { id: 'a', findings: [pass('p'), warn('w'), info('i')] },
    { id: 'b', findings: [warn('w2'), info('i2')] },
  ]
  const { counts, exitCode } = summarize(sections)
  assert.deepEqual({ ...counts }, { pass: 1, warn: 2, fail: 0, info: 2 })
  assert.equal(exitCode, 0, 'warnings and info never fail the run')

  const withFail = [...sections, { id: 'c', findings: [fail('f')] }]
  assert.equal(summarize(withFail).exitCode, 1)
  assert.equal(summarize(withFail).counts.fail, 1)
})

test('an empty report is a success, not a failure', () => {
  assert.equal(summarize([]).exitCode, 0)
  assert.deepEqual({ ...summarize([]).counts }, { pass: 0, warn: 0, fail: 0, info: 0 })
})

/* ---------------------------------------------------------------- secrets */

test('a secret is described without being revealed', () => {
  const s = describeSecret('AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY123')
  assert.equal(s.state, 'present')
  assert.match(s.detail, /37 chars/)
  // The prefix is bounded at four characters, which distinguishes a Gemini key from a paste
  // accident without being enough to use.
  assert.match(s.detail, /starts "AIza…"/)
  assert.equal(s.detail.includes('TESTKEY'), false, 'the body of the key must never appear')
})

test('the three failures people actually hit are told apart', () => {
  assert.equal(describeSecret(undefined).state, 'absent')
  assert.equal(describeSecret('').state, 'empty')
  // `$KEY` and `%KEY%` come from a shell profile that never expanded. Reporting this as "present,
  // 4 chars" is how somebody spends an afternoon on it.
  assert.equal(describeSecret('$GEMINI_API_KEY').state, 'unexpanded')
  assert.equal(describeSecret('%GEMINI_API_KEY%').state, 'unexpanded')
  assert.equal(describeSecret('${GEMINI_API_KEY}').state, 'unexpanded')
  // And it says what to do instead, because config values are never interpolated.
  assert.match(describeSecret('$K').detail, /never interpolated/)
})

test('the remedy is platform-correct, including the setx trap', () => {
  const win = setKeyRemedy('GEMINI_API_KEY', 'win32')
  assert.match(win, /setx GEMINI_API_KEY/)
  // The trap that makes people think setx did not work.
  assert.match(win, /does not affect the current shell/)
  assert.match(setKeyRemedy('GEMINI_API_KEY', 'darwin'), /export GEMINI_API_KEY/)
  assert.match(setKeyRemedy('GEMINI_API_KEY', 'linux'), /shell profile/)
})

/* --------------------------------------------------- the key-severity split */

const keyArgs = {
  keyEnv: 'GEMINI_API_KEY',
  modes: ['bulk-reader', 'code-writer'],
  platform: 'linux',
}

test('a missing key for a provider NOBODY chose is a warning', () => {
  // The shipped default. Installing this plugin requires no key, and the gate fails open on every
  // branch, so a keyless install is a working Claude Code install.
  const f = apiKeyFinding({ ...keyArgs, secret: describeSecret(undefined), configured: false })
  assert.equal(f.level, 'warn')
  assert.match(f.detail, /SHIPPED DEFAULT, not a choice you made/)
  // Both ways forward, not just the one that costs money.
  assert.match(f.detail, /export GEMINI_API_KEY/)
  assert.match(f.detail, /keyless local worker/)
})

test('a missing key for a provider somebody DID choose is a failure', () => {
  const f = apiKeyFinding({ ...keyArgs, secret: describeSecret(undefined), configured: true })
  assert.equal(f.level, 'fail')
  assert.match(f.label, /GEMINI_API_KEY is not set/)
  assert.match(f.detail, /needed by bulk-reader, code-writer/)
})

test('configured-ness changes ONLY the severity of an absent key', () => {
  // The paired property, stated over every secret state. A key that is present is a pass either
  // way; a key that is set to garbage is a failure either way, because somebody typed it. Only
  // ABSENCE is ambiguous, because only absence can mean "not set up yet".
  for (const [state, value] of [
    ['present', 'AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY123'],
    ['empty', ''],
    ['unexpanded', '$GEMINI_API_KEY'],
  ]) {
    const secret = describeSecret(value)
    assert.equal(secret.state, state)
    const a = apiKeyFinding({ ...keyArgs, secret, configured: false })
    const b = apiKeyFinding({ ...keyArgs, secret, configured: true })
    assert.equal(a.level, b.level, `${state} must not depend on whether the provider was named`)
  }
  const absent = describeSecret(undefined)
  assert.notEqual(
    apiKeyFinding({ ...keyArgs, secret: absent, configured: false }).level,
    apiKeyFinding({ ...keyArgs, secret: absent, configured: true }).level,
    'absence is the one state where intent decides',
  )
})

test('a key that is set but empty is a failure, not a warning', () => {
  // Somebody set it, so this is a definite mistake with a definite fix — unlike never setting it.
  const f = apiKeyFinding({ ...keyArgs, secret: describeSecret(''), configured: false })
  assert.equal(f.level, 'fail')
})

/* ------------------------------------------------------------------ runtime */

test('the node check cites the engines floor, not a module nothing imports', () => {
  // It used to fail citing `node:sqlite`, which is imported nowhere in the shipped tree: it was
  // reserved for an ingest step that does not exist. So the message told a Node 22.0 user their
  // install was broken for a reason that was not true.
  const old = nodeFinding({ version: '22.0.0' })
  assert.equal(old.level, 'fail')
  assert.match(old.detail, /engines requires >=22\.5/)
  assert.equal(/sqlite/i.test(old.detail), false)

  assert.equal(nodeFinding({ version: '22.5.0' }).level, 'pass', 'the floor itself must pass')
  assert.equal(nodeFinding({ version: '24.16.0' }).level, 'pass')
  assert.equal(nodeFinding({ version: '22.4.9' }).level, 'fail')
})

/* --------------------------------------------------------------------- json */

test('the JSON report carries the same findings and the same exit code as the text', () => {
  const sections = [
    { id: 'runtime', title: 'Runtime', findings: [pass('node 24'), warn('slow')], note: [] },
    { id: 'pricing', title: 'Pricing', findings: [fail('no table')], note: ['paste me'] },
  ]
  const json = toJson({
    sections,
    project: { plugin: { name: 'model-router', version: '0.1.0' } },
    mode: { live: false, offline: true, probeWrites: false },
    generatedAt: '2026-10-04T00:00:00.000Z',
    version: '0.1.0',
  })

  assert.equal(json.schemaVersion, 1)
  assert.equal(json.tool, 'router-doctor')
  assert.equal(json.exitCode, summarize(sections).exitCode)
  assert.equal(json.exitCode, 1)
  assert.deepEqual(json.counts, { pass: 1, warn: 1, fail: 1, info: 0 })
  assert.deepEqual(json.sections.map((s) => s.id), ['runtime', 'pricing'])
  // Every level in the document is drawn from the one vocabulary.
  for (const s of json.sections) {
    for (const f of s.findings) assert.ok(FINDING_LEVELS.includes(f.level))
  }
  // A raw note is carried rather than dropped, so the JSON is not a lossy view of the text.
  assert.deepEqual(json.sections[1].note, ['paste me'])
  assert.deepEqual(json.sections[0].note, [])
})

test('the JSON report is serialisable and states what it could not measure', () => {
  const json = toJson({
    sections: [],
    project: { claudeCodeVersion: null },
    mode: { live: false, offline: false, probeWrites: false },
    generatedAt: '2026-10-04T00:00:00.000Z',
    version: '0.1.0',
  })
  assert.doesNotThrow(() => JSON.stringify(json))
  // null, never a guess. A script is not told which Claude Code launched it, and "a configured
  // value is never a measured capability" applies to a version string too.
  assert.equal(JSON.parse(JSON.stringify(json)).project.claudeCodeVersion, null)
})
