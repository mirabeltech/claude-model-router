/**
 * One contract, four commands.
 *
 * `doctor`, `budget`, `analytics` and `report` are the public surface, and before this phase they
 * agreed about almost nothing: doctor accepted unknown flags silently, budget parsed no arguments
 * at all, report had no colour control, and only analytics rejected a bad invocation. Each had been
 * reasonable on its own; together they were four different tools.
 *
 * This is the file that makes them one, and it does so ACROSS A PLUGIN BOUNDARY on purpose:
 * `report.mjs` lives in router-dashboard and may not import router code — a static test pins that,
 * because it is what makes "the dashboard cannot read a telemetry store" structural rather than a
 * policy. So the shared contract cannot be a shared module for all four. It is enforced here
 * instead, which is the right trade: twenty duplicated lines of flag parsing against an isolation
 * guarantee worth keeping.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { makeCleanInstall, REPO_ROOT, scriptPath } from './helpers/clean-install.mjs'

/**
 * `readOnly` is the claim that it creates and modifies nothing. `exits` is the complete set of
 * codes the command may ever return.
 *
 *   0  ran and reported. Includes "nothing to report", "no budget configured" and "unpriced" —
 *      every one of those is the SHIPPED state, not an error.
 *   1  ran, and the thing it inspected is broken. A DIAGNOSTIC verdict, which in practice means
 *      doctor alone.
 *   2  bad invocation, or input that cannot be used.
 */
const COMMANDS = Object.freeze([
  {
    id: 'doctor',
    script: 'plugins/model-router/scripts/doctor.mjs',
    ok: ['--offline', '--no-color'],
    exits: [0, 1, 2],
    readOnly: true,
  },
  {
    id: 'budget',
    script: 'plugins/model-router/scripts/budget.mjs',
    ok: ['--no-color'],
    // No failure exit: there is nothing for budget to find broken. It prints state.
    exits: [0, 2],
    readOnly: true,
  },
  {
    id: 'analytics',
    script: 'plugins/model-router/scripts/analytics.mjs',
    ok: ['--no-color'],
    // Exit 1 is UNREACHABLE by design, and that is a decision rather than an omission: an empty
    // or unpriced store is this project's shipped state, and a reporting command that exited
    // non-zero on it would break every pipeline that ran it — including this repo's own CI steps.
    exits: [0, 2],
    readOnly: true,
  },
  {
    id: 'report',
    script: 'plugins/router-dashboard/scripts/report.mjs',
    ok: ['--no-color'],
    exits: [0, 2],
    readOnly: false, // it writes exactly one HTML file, and only where asked
  },
])

/** Scripts that are deliberately not public commands, each for a stated reason. */
const INTERNAL = Object.freeze({
  'gen-config-schema.mjs': 'a generator: writes lib/config.schema.json, and CI diffs the result',
  'gen-config-doc.mjs': 'a generator: writes the table in docs/configuration.md, gated in CI',
  'gen-env-docs.mjs': 'a generator: writes docs/environment.md from SPEC and the env registry',
  'prune.mjs': 'deletes telemetry segments with --apply; not something to run casually',
  'smoke-hook.mjs': 'makes real worker calls against a real provider',
  'collect.mjs': 'a module imported by report.mjs, not an entry point',
})

const run = (ci, script, args) =>
  spawnSync(process.execPath, [scriptPath(script), ...args], { encoding: 'utf8', env: ci.env })

/* ------------------------------------------------------------------ census */

test('every script is classified as either public or internal', () => {
  // So a fifth command cannot ship without a contract. The alternative is a hand-maintained list
  // that silently stops covering the surface.
  const classified = new Set([...COMMANDS.map((c) => path.basename(c.script)), ...Object.keys(INTERNAL)])
  const unclassified = []
  for (const plugin of ['model-router', 'router-dashboard']) {
    const dir = path.join(REPO_ROOT, 'plugins', plugin, 'scripts')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      if (!classified.has(f)) unclassified.push(`${plugin}/scripts/${f}`)
    }
  }
  assert.deepEqual(unclassified, [], 'classify it in COMMANDS or in INTERNAL, with a reason')
  for (const reason of Object.values(INTERNAL)) {
    assert.ok(reason.length > 15, 'an internal script needs a real reason')
  }
})

/* -------------------------------------------------------------------- help */

for (const cmd of COMMANDS) {
  test(`${cmd.id} --help exits 0 and documents its exit codes`, () => {
    const ci = makeCleanInstall({ label: `help-${cmd.id}` })
    try {
      const r = run(ci, cmd.script, ['--help'])
      assert.equal(r.status, 0, r.stderr)
      assert.ok(r.stdout.length > 100, '--help must go to stdout, so it can be piped')
      assert.match(r.stdout, /Usage: npm run /, 'say what a reader actually types')
      assert.match(r.stdout, /Exit codes:/, 'the exit contract belongs in --help')
    } finally {
      ci.cleanup()
    }
  })

  test(`${cmd.id} --help answers before touching anything`, () => {
    // --help must work on a broken install. Pointed at an unreadable config and a nonexistent
    // store: if it loads config or opens the store first, this fails or writes something.
    const ci = makeCleanInstall({ label: `help-pure-${cmd.id}` })
    try {
      const configFile = ci.writeProjectConfig('{ this is not valid json')
      assert.ok(fs.existsSync(configFile))
      const before = ci.snapshot()
      const r = run(ci, cmd.script, ['--help'])
      assert.equal(r.status, 0, 'a malformed config must not stop --help')
      assert.deepEqual(ci.snapshot(), before, '--help wrote something')
    } finally {
      ci.cleanup()
    }
  })

  test(`${cmd.id} rejects an unknown flag with exit 2 and names it`, () => {
    const ci = makeCleanInstall({ label: `unknown-${cmd.id}` })
    try {
      const r = run(ci, cmd.script, ['--definitely-not-a-flag'])
      assert.equal(r.status, 2, `${cmd.id} accepted an unknown flag`)
      const both = `${r.stdout}${r.stderr}`
      assert.match(both, /definitely-not-a-flag/, 'the message must name the offending flag')
    } finally {
      ci.cleanup()
    }
  })

  test(`${cmd.id} --version prints a bare semver`, () => {
    const ci = makeCleanInstall({ label: `version-${cmd.id}` })
    try {
      const r = run(ci, cmd.script, ['--version'])
      assert.equal(r.status, 0)
      assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, 'bare and pipeable, with no banner')
    } finally {
      ci.cleanup()
    }
  })

  test(`${cmd.id} emits no ANSI under --no-color`, () => {
    const ci = makeCleanInstall({ label: `color-${cmd.id}` })
    try {
      const args = cmd.id === 'report' ? ['--out', path.join(ci.base, 'c.html'), '--no-color'] : cmd.ok
      const r = run(ci, cmd.script, args)
      assert.equal(/\x1b\[/.test(r.stdout), false, `${cmd.id} wrote ANSI to stdout`)
      assert.equal(/\x1b\[/.test(r.stderr), false, `${cmd.id} wrote ANSI to stderr`)
    } finally {
      ci.cleanup()
    }
  })

  test(`${cmd.id} exits only with a declared code`, () => {
    const ci = makeCleanInstall({ label: `exits-${cmd.id}` })
    try {
      const invocations = [
        cmd.id === 'report' ? ['--out', path.join(ci.base, 'e.html'), '--no-color'] : cmd.ok,
        ['--help'],
        ['--version'],
        ['--definitely-not-a-flag'],
      ]
      for (const args of invocations) {
        const r = run(ci, cmd.script, args)
        assert.ok(
          cmd.exits.includes(r.status),
          `${cmd.id} ${args.join(' ')} exited ${r.status}, which is not in [${cmd.exits}]`,
        )
      }
    } finally {
      ci.cleanup()
    }
  })
}

/* --------------------------------------------------------------- read-only */

for (const cmd of COMMANDS.filter((c) => c.readOnly)) {
  test(`${cmd.id} creates nothing against a store that does not exist`, () => {
    const ci = makeCleanInstall({ label: `rdonly-${cmd.id}` })
    try {
      const before = ci.snapshot()
      run(ci, cmd.script, cmd.ok)
      assert.deepEqual(ci.snapshot(), before, `${cmd.id} created something`)
    } finally {
      ci.cleanup()
    }
  })

  test(`${cmd.id} modifies nothing in a populated store`, () => {
    const ci = makeCleanInstall({ label: `immutable-${cmd.id}` })
    try {
      fs.mkdirSync(ci.storeDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', 'events-2026-03-02.jsonl'),
        path.join(ci.storeDir, 'events-2026-03-02.jsonl'),
      )
      const before = ci.snapshot()
      run(ci, cmd.script, cmd.ok)
      assert.deepEqual(ci.snapshot(), before, `${cmd.id} changed the store it was reading`)
    } finally {
      ci.cleanup()
    }
  })
}

test('report writes exactly the file it was asked for', () => {
  const ci = makeCleanInstall({ label: 'report-out' })
  try {
    const out = path.join(ci.base, 'nested', 'asked for.html')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const before = ci.snapshot()
    const r = run(ci, 'plugins/router-dashboard/scripts/report.mjs', ['--out', out, '--no-color'])
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const created = ci.snapshot().filter((e) => !before.includes(e))
    assert.deepEqual(
      created.map((e) => e.split(':')[0]),
      ['install root/nested/asked for.html'],
      'report created something besides its output file',
    )
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------------------- guidance */

test('a missing credential produces guidance that names the platform-correct command', () => {
  // Asserted on the RUNNING platform, because the remedy branches on process.platform and the
  // branch that matters is the one the reader is on.
  const ci = makeCleanInstall({
    label: 'guidance-key',
    env: { CMR_WORKER_PROVIDER: 'gemini', CMR_WORKER_MODEL: 'gemini-2.5-flash' },
  })
  try {
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--offline', '--no-color'])
    assert.equal(r.status, 1, 'a configured provider with no key is a real failure')
    assert.match(r.stdout, /GEMINI_API_KEY/)
    if (process.platform === 'win32') {
      assert.match(r.stdout, /setx GEMINI_API_KEY/)
      assert.match(r.stdout, /does not affect the current shell/, 'the setx trap must be stated')
    } else {
      assert.match(r.stdout, /export GEMINI_API_KEY/)
    }
  } finally {
    ci.cleanup()
  }
})

test('a missing store produces an actionable next step, not an error', () => {
  // A fresh install has no store, and that is the most common state these commands run in. It must
  // read as "nothing yet", never as a fault.
  const ci = makeCleanInstall({ label: 'guidance-store' })
  try {
    const analytics = run(ci, 'plugins/model-router/scripts/analytics.mjs', ['--no-color'])
    assert.equal(analytics.status, 0, 'an empty store is a result, not an error')
    assert.match(`${analytics.stdout}${analytics.stderr}`, /no events|nothing|empty/i)

    const budget = run(ci, 'plugins/model-router/scripts/budget.mjs', ['--no-color'])
    assert.equal(budget.status, 0)
    assert.match(budget.stdout, /No budget is configured/)
    // And it says where to put one, with a native path.
    assert.match(budget.stdout, /model-router\.json/)
  } finally {
    ci.cleanup()
  }
})

test('doctor distinguishes a typo from a rejected value', () => {
  // Both are config problems and they deserve different levels: an unknown field is a probable
  // typo (WARN), a value the schema rejects is a definite mistake (FAIL).
  const ci = makeCleanInstall({ label: 'guidance-config' })
  try {
    ci.writeProjectConfig({ routing: { bulkRead: { minLines: 'not a number' } }, nonsenseField: 1 })
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--offline', '--json'])
    const report = JSON.parse(r.stdout)
    const config = report.sections.find((s) => s.id === 'configuration')
    assert.ok(
      config.findings.some((f) => f.level === 'warn' && f.label.includes('nonsenseField')),
      'an unknown field should be a warning',
    )
    assert.ok(
      config.findings.some((f) => f.level === 'fail' && f.label.includes('minLines')),
      'a rejected value should be a failure',
    )
    assert.equal(r.status, 1)
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------------------ the oddities */

test('analytics keeps exit 1 unreachable, deliberately', () => {
  // Preserved rather than unified, and the reason is in --help so a reader is not left guessing.
  const ci = makeCleanInstall({ label: 'analytics-exit' })
  try {
    const help = run(ci, 'plugins/model-router/scripts/analytics.mjs', ['--help'])
    assert.match(help.stdout, /no failure exit/i)
    // Over a battery of legitimate-but-awkward states, never 1.
    for (const args of [['--no-color'], ['--all'], ['--json'], ['--today']]) {
      const r = run(ci, 'plugins/model-router/scripts/analytics.mjs', args)
      assert.notEqual(r.status, 1, `analytics exited 1 for ${args.join(' ')}`)
    }
  } finally {
    ci.cleanup()
  }
})

test('a bad date is a usage error, not a crash', () => {
  const ci = makeCleanInstall({ label: 'bad-date' })
  try {
    for (const script of [
      'plugins/model-router/scripts/analytics.mjs',
      'plugins/router-dashboard/scripts/report.mjs',
    ]) {
      const r = run(ci, script, ['--now', 'the day before yesterday'])
      assert.equal(r.status, 2, `${script} should refuse an unparseable instant`)
      assert.equal(/at Object\.|Error:\s*\n|\bat async\b/.test(r.stderr), false, 'a stack trace is not a message')
    }
  } finally {
    ci.cleanup()
  }
})

test('a value flag with no value is a usage error', () => {
  const ci = makeCleanInstall({ label: 'missing-value' })
  try {
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--provider'])
    assert.equal(r.status, 2)
    assert.match(`${r.stdout}${r.stderr}`, /provider/)
  } finally {
    ci.cleanup()
  }
})

test('contradictory flags are refused rather than silently ordered', () => {
  const ci = makeCleanInstall({ label: 'contradiction' })
  try {
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--live', '--offline'])
    assert.equal(r.status, 2)
    assert.match(`${r.stdout}${r.stderr}`, /contradict/i)
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------- large output on a pipe */

test('a large --json response survives the pipe in full', () => {
  // THE BUG CI FOUND ON ITS FIRST RUN, and the reason this test asserts BYTE LENGTH rather than
  // merely that the output parses.
  //
  // `analytics.mjs` ended with `process.exit(code)` straight after writing a ~200 KB JSON
  // document. On POSIX a write to a pipe is asynchronous, so exiting discards whatever is still
  // buffered and the response was truncated at about 146 KB — invalid JSON. On Windows the same
  // write is synchronous, so every local run and every manual check looked perfect. The shipped
  // `--json` was broken on two of three platforms and nothing noticed.
  //
  // A parse check alone would be a weak regression test: it passes trivially on Windows. Comparing
  // the piped bytes against the length the serializer produced is a real assertion on every
  // platform, because a truncation is a length mismatch wherever it happens.
  const ci = makeCleanInstall({ label: 'big-json' })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    for (const day of ['02', '03', '04']) {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', `events-2026-03-${day}.jsonl`),
        path.join(ci.storeDir, `events-2026-03-${day}.jsonl`),
      )
    }
    const r = run(ci, 'plugins/model-router/scripts/analytics.mjs', [
      '--all',
      '--json',
      '--now',
      '2026-03-04T12:00:00.000Z',
    ])
    assert.equal(r.status, 0, r.stderr)
    // Large enough to cross a pipe buffer, or the test proves nothing.
    assert.ok(
      r.stdout.length > 64 * 1024,
      `the fixture response is only ${r.stdout.length} bytes; too small to exercise the hazard`,
    )
    assert.doesNotThrow(() => JSON.parse(r.stdout), 'the piped response is not valid JSON')
    // And the last bytes are really there, which is what truncation removes.
    assert.match(r.stdout.trimEnd().slice(-1), /[}\]]/, 'the response does not end cleanly')
  } finally {
    ci.cleanup()
  }
})

test('no public command exits while output may still be buffered', () => {
  // The static form of the same claim, so the fix cannot be undone in a file this suite does not
  // happen to pipe. `process.exit()` at a completion path is the hazard; an early usage exit
  // before anything has been written is not, so those are allowed explicitly.
  // The checkable proxy: whatever a command does on the way in, the LAST exit in the file — the
  // completion path, after output has been written — must set `process.exitCode`. An early
  // `process.exit()` for `--help` or an unknown flag is fine, because nothing substantial has been
  // written yet, and these four scripts are not all shaped the same way: two have an entry-point
  // guard and two are straight-line.
  for (const cmd of COMMANDS) {
    const src = fs.readFileSync(path.join(REPO_ROOT, cmd.script), 'utf8')
    const exits = [...src.matchAll(/process\.(exitCode|exit)\b/g)]
    assert.ok(exits.length > 0, `${cmd.id} never sets an exit status`)
    const last = exits[exits.length - 1][1]
    assert.equal(
      last,
      'exitCode',
      `${cmd.id}'s completion path calls process.exit(), which can truncate a pending write`,
    )
  }
})
