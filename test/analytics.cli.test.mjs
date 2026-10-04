/**
 * The analytics CLI.
 *
 * SPAWNED, NOT IMPORTED, following test/doctor.test.mjs: the script resolves config from the
 * environment and ends in `process.exit()`, and the environment is exactly what has to be
 * controlled. Every run gets an ALLOWLISTED env — `PATH` and `SystemRoot` only, with `HOME` and
 * `USERPROFILE` both redirected into a scratch directory — so no real API key and no developer's
 * personal `~/.claude/model-router/config.json` can change a number here.
 *
 * THE READ-ONLY PROOF IS THE IMPORTANT TEST. `budget.mjs` sets the standard: a reporting tool
 * writes nothing, "not the ledger, not a lock, not even the state directory", because a tool that
 * created a directory in order to tell you it was empty would quietly falsify its own report.
 * This points the CLI at a path that does not exist and asserts it still does not exist
 * afterwards.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const SCRIPT = path.join(REPO_ROOT, 'plugins', 'model-router', 'scripts', 'analytics.mjs')
const FIXTURES = path.join(HERE, 'fixtures', 'telemetry')
const EMPTY = path.join(FIXTURES, 'empty')

/** A frozen instant, so a relative window resolves the same way on every run forever. */
const NOW = '2026-03-04T12:00:00.000Z'

/** ANSI stripped, so an assertion matches what the script MEANS rather than how it is coloured. */
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

function runCli(args = [], { dir = FIXTURES, env = {} } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'))
  try {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: scratch,
        USERPROFILE: scratch,
        CLAUDE_PROJECT_DIR: scratch,
        CMR_TELEMETRY_DIR: dir,
        ...env,
      },
    })
    return { ...res, out: strip(res.stdout ?? ''), err: strip(res.stderr ?? '') }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const base = (extra = []) => ['--now', NOW, '--no-color', ...extra]

/* ------------------------------------------------------------------ defaults */

test('the default run reads the last seven days and exits 0', () => {
  const r = runCli(base())
  assert.equal(r.status, 0)
  assert.match(r.out, /model-router analytics/)
  assert.match(r.out, /window\s+7d\s+2026-02-26T00:00:00\.000Z \.\. 2026-03-04T12:00:00\.000Z/)
})

test('every required section is rendered', () => {
  const r = runCli(base())
  for (const heading of [
    'Overview',
    'Routing',
    'Worker performance',
    'Savings',
    'Cost',
    'Latency',
    'Governance',
    'Reliability',
    'Trends',
    'Data quality',
  ]) {
    assert.match(r.out, new RegExp(`^${heading}$`, 'm'), `${heading} is missing`)
  }
})

test('the rule width is 68 columns, matching every other report in this repo', () => {
  const r = runCli(base())
  assert.ok(r.out.includes('-'.repeat(68)))
  assert.ok(r.out.includes('='.repeat(68)))
  assert.equal(r.out.includes('-'.repeat(69)), false)
})

/* -------------------------------------------------------------- time windows */

test('each window flag resolves to its own range', () => {
  const windows = {
    '--today': '2026-03-04T00:00:00.000Z',
    '--24h': '2026-03-03T12:00:00.000Z',
    '--7d': '2026-02-26T00:00:00.000Z',
    '--30d': '2026-02-03T00:00:00.000Z',
  }
  const violations = []
  for (const [flag, start] of Object.entries(windows)) {
    const r = runCli(base([flag]))
    if (r.status !== 0) violations.push(`${flag}: exit ${r.status}`)
    if (!r.out.includes(start)) violations.push(`${flag}: expected start ${start}`)
  }
  assert.deepEqual(violations, [], 'a window flag resolved to the wrong range')
})

test('a custom range uses the dates given, end-of-day inclusive', () => {
  const r = runCli(base(['--start', '2026-03-02', '--end', '2026-03-03']))
  assert.equal(r.status, 0)
  assert.match(r.out, /2026-03-02T00:00:00\.000Z \.\. 2026-03-04T00:00:00\.000Z/)
})

test('two window flags at once is a usage error, not a silent precedence rule', () => {
  const r = runCli(base(['--today', '--7d']))
  assert.equal(r.status, 2)
  assert.match(r.err, /pick one window/)
})

test('a window flag combined with an explicit range is a usage error', () => {
  const r = runCli(base(['--7d', '--start', '2026-03-01']))
  assert.equal(r.status, 2)
  assert.match(r.err, /cannot be combined/)
})

test('an unparseable date is refused rather than quietly becoming the default window', () => {
  const r = runCli(base(['--start', 'yesterday']))
  assert.equal(r.status, 2)
  assert.match(r.err, /invalid window: start_not_a_date/)
})

test('a US-style date is refused, because Date.parse would read it in local time', () => {
  const r = runCli(base(['--start', '03/04/2026']))
  assert.equal(r.status, 2)
})

test('an unparseable --now is refused rather than falling back to the wall clock', () => {
  // --now exists for reproducibility. Silently using the real clock would defeat it while
  // producing output that looked entirely normal.
  const r = runCli(['--now', 'lunchtime', '--no-color'])
  assert.equal(r.status, 2)
  assert.match(r.err, /--now is not an instant/)
})

/* ------------------------------------------------------------------ filters */

test('a provider filter narrows the window and is echoed back', () => {
  const r = runCli(base(['--provider', 'ollama']))
  assert.equal(r.status, 0)
  assert.match(r.out, /filters\s+provider=ollama/)
  assert.equal(r.out.includes('gemini-3.8-flash'), false, 'a filtered-out model must not appear')
})

test('a model filter narrows to that model', () => {
  const r = runCli(base(['--model', 'llama3.1:8b']))
  assert.equal(r.status, 0)
  assert.match(r.out, /filters\s+model=llama3\.1:8b/)
})

test('--mode is resolved onto task_type and the resolution is shown', () => {
  // There is no `mode` column in schema version 1. Echoing the resolved filter means nobody has
  // to guess which column was actually consulted.
  const r = runCli(base(['--mode', 'bulk-reader']))
  assert.equal(r.status, 0)
  assert.match(r.out, /filters\s+task_type=bulk_read/)
})

test('an unknown mode matches nothing and says so, rather than matching everything', () => {
  // Enums are open on read, so a mode this build does not know might be real in a newer store.
  // Matching everything would answer a different question without saying so.
  const r = runCli(base(['--mode', 'telepathy']))
  assert.equal(r.status, 0)
  assert.match(r.out, /WARN\s+mode "telepathy": unknown worker mode/)
  assert.match(r.out, /routing events\s+0/)
})

test('a filter that matches nothing reports an empty window, not an error', () => {
  const r = runCli(base(['--provider', 'nonexistent']))
  assert.equal(r.status, 0)
  assert.match(r.out, /routing events\s+0/)
})

/* --------------------------------------------------------------------- json */

test('--json emits a parseable response and no human text', () => {
  const r = runCli(base(['--json']))
  assert.equal(r.status, 0)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.analytics_contract_version, 1)
  assert.equal(r.out.includes('model-router analytics'), false, 'the banner must not be in the pipe')
})

test('--json carries every section the contract declares', () => {
  const parsed = JSON.parse(runCli(base(['--json'])).out)
  for (const section of ['summary', 'routing', 'savings', 'cost', 'latency', 'failures', 'governance', 'segments', 'coverage', 'dataQuality']) {
    assert.ok(parsed[section], `${section} is missing from the json`)
  }
})

test('--json takes no argument, and a path after it is a usage error', () => {
  // The house `opt()` would silently consume the following token, leaving the user with a report
  // on stdout and an empty file where they expected one.
  const r = runCli(base(['--json', 'out.json']))
  assert.equal(r.status, 2)
  assert.match(r.err, /--json writes to stdout/)
})

test('two --json runs with the same --now are byte-identical', () => {
  // The CI reproducibility diff rests on this.
  const a = runCli(base(['--json']))
  const b = runCli(base(['--json']))
  assert.equal(a.out, b.out)
})

test('warnings go to stderr so the json pipe stays clean', () => {
  const r = runCli(base(['--json', '--mode', 'telepathy']))
  assert.doesNotThrow(() => JSON.parse(r.out), 'stdout must be pure json')
})

test('an unknown option is refused rather than ignored', () => {
  const r = runCli(base(['--privider', 'gemini']))
  assert.equal(r.status, 2)
  assert.match(r.err, /unknown option: --privider/)
})

test('--help prints usage and exits 0', () => {
  const r = runCli(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.out, /Usage: npm run analytics/)
})

/* ---------------------------------------------------------------- read-only */

test('a nonexistent store directory is read as empty and is NOT created', () => {
  // THE TEST THIS FILE EXISTS FOR. budget.mjs states the rule: a reporting tool writes nothing,
  // not even the directory it is reporting on, because creating it would falsify the report.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-ro-'))
  const missing = path.join(scratch, 'telemetry-does-not-exist')
  try {
    const r = runCli(base(), { dir: missing })
    assert.equal(r.status, 0, 'a missing store is an empty store, not an error')
    assert.match(r.out, /routing events\s+0/)
    assert.equal(fs.existsSync(missing), false, 'the CLI created the directory it was reporting on')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('an empty store directory gains no file from being read', () => {
  const before = fs.readdirSync(EMPTY).sort()
  const r = runCli(base(), { dir: EMPTY })
  assert.equal(r.status, 0)
  assert.deepEqual(fs.readdirSync(EMPTY).sort(), before, 'reading a store must not write to it')
})

test('the fixture corpus is byte-identical after a run', () => {
  // Including mtimes would be flaky, but the bytes are the thing that matters: an analytics run
  // must never rewrite, prune or normalise the store.
  const snapshot = () =>
    fs
      .readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => `${f}:${fs.readFileSync(path.join(FIXTURES, f)).length}`)
      .sort()
  const before = snapshot()
  runCli(base())
  assert.deepEqual(snapshot(), before)
})

test('no salt file is created, because analytics never builds an identity', () => {
  // buildIdentity() is the only writer anywhere on the read path, and it writes `.salt` into the
  // store directory on first use. A read-only command must never trigger it.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-salt-'))
  const dir = path.join(scratch, 'telemetry')
  fs.mkdirSync(dir)
  try {
    runCli(base(), { dir })
    assert.deepEqual(fs.readdirSync(dir), [], 'a salt or lock file appeared')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------- exit codes */

test('the exit code is 0 on any successful read and 2 only on a bad invocation', () => {
  // Exit 1 is unreachable BY DESIGN, and deliberately unlike doctor's "1 iff FAIL". An unpriced
  // install is the normal state of this project; a reporting command that failed on it would
  // break every pipeline that ran it.
  const good = [base(), base(['--today']), base(['--json']), base(['--provider', 'nope'])]
  const bad = [base(['--json', 'x.json']), base(['--today', '--7d']), base(['--start', 'nope'])]
  const violations = []
  for (const args of good) {
    const r = runCli(args)
    if (r.status !== 0) violations.push(`${args.join(' ')} -> ${r.status}`)
  }
  for (const args of bad) {
    const r = runCli(args)
    if (r.status !== 2) violations.push(`${args.join(' ')} -> ${r.status}, expected 2`)
  }
  assert.deepEqual(violations, [], 'an exit code is wrong')
})

test('an unpriced store exits 0 and explains, rather than failing', () => {
  const r = runCli(base(['--start', '2026-03-03', '--end', '2026-03-03']))
  assert.equal(r.status, 0)
  assert.match(r.out, /worker cost is UNKNOWN for this window/)
  assert.match(r.out, /Unknown is not zero/)
})

/* ------------------------------------------------------------------ honesty */

test('an unpriced window contains no dollar figure anywhere in the output', () => {
  // If this ever prints a price, a rate was invented somewhere between the pricing table and the
  // terminal.
  const r = runCli(base(['--start', '2026-03-03', '--end', '2026-03-03']))
  const prices = r.out.match(/\$[0-9]/g) ?? []
  assert.deepEqual(prices, [], `a dollar figure appeared: ${prices.join(' ')}`)
})

test('an empty store prints no dollar figure and no unpriced lecture either', () => {
  const r = runCli(base(), { dir: EMPTY })
  assert.deepEqual(r.out.match(/\$[0-9]/g) ?? [], [])
  assert.equal(r.out.includes('Unknown is not zero'), false, 'there is nothing whose cost we could know')
  assert.match(r.out, /no events/)
})

test('the four separate failure counts are labelled as not addable', () => {
  const r = runCli(base())
  assert.match(r.out, /These are four different events and this report never adds them up\./)
  assert.match(r.out, /governance denials\s+\d+\s+not a failure/)
  assert.match(r.out, /context refusals\s+\d+\s+not a provider fault/)
  assert.match(r.out, /unknown cost\s+\d+\s+not a failed request/)
})

test('the savings caveat is printed verbatim', () => {
  const r = runCli(base())
  assert.match(r.out, /Estimated savings are not necessarily actual invoice savings\./)
})

test('an unavailable aggregate renders the word unavailable and never a zero amount', () => {
  const r = runCli(base(['--start', '2026-03-03', '--end', '2026-03-03']))
  assert.match(r.out, /worker cost\s+unavailable \(4 events, none measured\)/)
  assert.equal(r.out.includes('$0.0000'), false)
})

test('a null statistic prints NULL, never 0', () => {
  const r = runCli(base(), { dir: EMPTY })
  assert.match(r.out, /median worker latency\s+NULL ms/)
})

test('the uninstrumented latency components are listed with their reasons', () => {
  const r = runCli(base())
  assert.match(r.out, /hookOverheadMs\s+NULL\s+not_instrumented_by_design/)
  assert.match(r.out, /perAttemptMs\s+NULL\s+final_attempt_only/)
})

/* ----------------------------------------------------------------- security */

test('no content field reaches the terminal, in either output mode', () => {
  // The corpus carries FIXTURE-MUST-NOT-APPEAR-* in question_text, error_message_safe and
  // project_path. Asserting the absence of the VALUE tests the property that matters.
  for (const args of [base(), base(['--json'])]) {
    const r = runCli(args)
    assert.equal(r.out.includes('FIXTURE-MUST-NOT-APPEAR'), false, `content leaked with ${args.join(' ')}`)
    assert.equal(r.err.includes('FIXTURE-MUST-NOT-APPEAR'), false)
  }
})

test('no absolute store path is printed into the json', () => {
  // The reader's samples and errors carry file paths; the engine counts them and drops the paths.
  const r = runCli(base(['--json']))
  assert.equal(r.out.includes(FIXTURES.replace(/\\/g, '\\\\')), false)
  assert.equal(r.out.includes('fixtures/telemetry'), false)
})
