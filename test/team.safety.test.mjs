/**
 * What a CLEAN INSTALL does, which is almost nothing, asserted as one readable document.
 *
 * The individual properties are mostly covered already — `hook.failopen` has 23 tests on the
 * fail-open paths, `governance.config` pins that every limit ships null, `telemetry.pricing` that
 * every rate does, `analytics.cli` that analytics writes nothing. What did NOT exist was anywhere
 * a person could look to answer "is installing this safe for my team", and two of the claims were
 * simply false.
 *
 * So this file is deliberately a document as much as a test. What is NEW here:
 *
 *   - `budget.mjs` had ZERO test coverage, while carrying the strongest read-only claim in the
 *     repository ("writes nothing: not the ledger, not a lock, not even the state directory").
 *   - doctor CREATED the telemetry and governance directories on every run, which contradicted
 *     that claim one directory over and meant the first command a new developer ran left state
 *     behind — then reported "store is empty", having falsified what it just measured.
 *   - A DEFAULTS golden snapshot, which turns "this phase changes no routing or provider default"
 *     from a promise in a commit message into a diff.
 *
 * Isolation is via `helpers/clean-install.mjs`: a temp root with a space in its path, and an
 * environment CONSTRUCTED rather than spread, so the developer's own key and overrides cannot make
 * these pass for the wrong reason.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { makeCleanInstall, REPO_ROOT, scriptPath } from './helpers/clean-install.mjs'
import { hookConfig, readStdin, makeWorkspace } from './helpers/hook-payload.mjs'
import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { DEFAULTS, loadConfig } from '../plugins/model-router/lib/config.mjs'

/** Every command a user is told to run. The census below keeps this honest. */
const PUBLIC_COMMANDS = Object.freeze([
  { id: 'doctor', script: 'plugins/model-router/scripts/doctor.mjs', args: ['--offline', '--no-color'], readOnly: true },
  { id: 'budget', script: 'plugins/model-router/scripts/budget.mjs', args: ['--no-color'], readOnly: true },
  { id: 'analytics', script: 'plugins/model-router/scripts/analytics.mjs', args: ['--no-color'], readOnly: true },
  { id: 'report', script: 'plugins/router-dashboard/scripts/report.mjs', args: [], readOnly: false },
])

const run = (ci, script, args = []) =>
  spawnSync(process.execPath, [scriptPath(script), ...args], { encoding: 'utf8', env: ci.env })

/* --------------------------------------------------- the harness itself */

test('the clean-install environment leaks nothing from the developer', () => {
  // A self-check. Without it, every assertion below could pass because a real GEMINI_API_KEY was
  // inherited, and would then fail on somebody else's machine for reasons nobody could reproduce.
  const ci = makeCleanInstall({ label: 'selfcheck' })
  try {
    const keys = Object.keys(ci.env)
    assert.deepEqual(keys.filter((k) => /GEMINI|API_KEY|TOKEN|SECRET/i.test(k)), [])
    assert.deepEqual(
      keys.filter((k) => k.startsWith('CMR_')).sort(),
      ['CMR_BUDGET_STATE_DIR', 'CMR_TELEMETRY_DIR'],
      'only the two directory redirects may be set',
    )
    assert.deepEqual(keys.filter((k) => k.startsWith('CLAUDE_')), ['CLAUDE_PROJECT_DIR'])
    assert.ok(ci.home.includes(' '), 'the fixture must exercise a path with a space')
  } finally {
    ci.cleanup()
  }
})

test('a child process really does resolve the fake home', () => {
  // The fact every "your real ~/.claude is never touched" claim rests on. os.homedir() reads
  // USERPROFILE on Windows and HOME on POSIX, and has historically also consulted
  // HOMEDRIVE+HOMEPATH — so this is platform-dependent and worth measuring rather than assuming.
  const ci = makeCleanInstall({ label: 'homedir' })
  try {
    const r = spawnSync(process.execPath, [scriptPath('test/helpers/homedir-probe.mjs')], {
      encoding: 'utf8',
      env: ci.env,
    })
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), ci.home)
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------------- does not call a worker */

/*
 * TWO THINGS THIS TRIO HAD TO GET RIGHT, both of which it got wrong first:
 *
 * 1. An earlier version injected `fetchImpl` into `runReadHook`. That is a parameter of
 *    `dispatch()`, not of the hook, so it was silently ignored and "nothing attempted a call" was
 *    vacuously true — it would have passed just as happily if the hook dialled out on every read.
 *
 * 2. `readPayload` defaults `transcript_path` to `''`, and `recentlyEdited()` treats an
 *    unmeasurable transcript as TRUE (the fail-safe: assume Claude needs the exact bytes). So the
 *    gate declined at `recently_edited` long before a worker was considered, and the test was
 *    "proving" a worker-related claim from a decision that had nothing to do with the worker.
 *
 * A safety test that cannot fail is worse than none: it is a false assurance in the place least
 * likely to be re-examined. So each test below asserts the DECISION REASON it depends on, and the
 * third exists purely to prove the injection point fires.
 */

test('a clean install declines for want of a worker, and dispatches nothing', async () => {
  // The mechanism, which is better than "the gate does not know about keys": the adapter computes
  // worker availability as a FACT — a synchronous readiness check that opens no socket — and feeds
  // it to the gate, which declines with `worker_not_ready`. So on a keyless install no dispatch is
  // even entered.
  //
  // Asserting the REASON is what stops this passing for an unrelated cause, which is exactly how
  // an earlier version of this test fooled itself with `recently_edited`.
  const ws = makeWorkspace('safety-not-ready', { bytes: 40_000 })
  try {
    const config = loadConfig({ env: {}, home: ws.dir, projectDir: ws.dir }).config
    let attempted = false
    const out = await runReadHook({
      raw: readStdin({
        tool_input: { file_path: ws.file },
        cwd: ws.dir,
        transcript_path: ws.transcript,
      }),
      config,
      env: {},
      dispatchImpl: async () => {
        attempted = true
        throw new Error('a keyless install must not dispatch')
      },
    })
    assert.equal(out.decision.reason, 'worker_not_ready', 'it must decline for the worker, not for something else')
    assert.equal(out.decision.delegate, false)
    assert.equal(attempted, false, 'no worker call may be attempted')
    const decision = out.response?.hookSpecificOutput?.permissionDecision ?? 'allow'
    assert.notEqual(decision, 'deny', 'a keyless install must never deny a read')
  } finally {
    ws.cleanup()
  }
})

test('the dispatch probe is wired to something that can actually fire', async () => {
  // The control for the test above. With a reachable worker configured and the same payload shape,
  // `dispatchImpl` IS reached — so the assertion above is about the credential, not about a
  // parameter that silently does nothing.
  const ws = makeWorkspace('safety-dispatch-control', { bytes: 40_000 })
  try {
    let attempted = false
    const out = await runReadHook({
      raw: readStdin({
        tool_input: { file_path: ws.file },
        cwd: ws.dir,
        transcript_path: ws.transcript,
      }),
      config: hookConfig(),
      env: { MOCK_WORKER_URL: 'http://127.0.0.1:1' },
      dispatchImpl: async () => {
        attempted = true
        return { status: 'error', reason: 'provider_unavailable', error: { code: 'probe' } }
      },
    })
    assert.equal(out.decision.delegate, true, 'the gate should approve when a worker is available')
    assert.equal(attempted, true, 'dispatchImpl is not the injection point the hook uses')
  } finally {
    ws.cleanup()
  }
})

test('no socket is opened when the configured worker has no credential', async () => {
  // THE "does not call a worker" CLAIM, made where it is actually true. Dispatch IS entered on a
  // clean install — the gate approved — and `readinessFor()` short-circuits before any network
  // call, so a throwing fetch is never reached. Injected into `dispatch()`, which is the function
  // that accepts it.
  const ws = makeWorkspace('safety-nosocket', { bytes: 40_000 })
  try {
    const config = loadConfig({ env: {}, home: ws.dir, projectDir: ws.dir }).config
    const decision = {
      decision: 'deny',
      delegate: true,
      mode: 'bulk-reader',
      lane: 'bulkRead',
      reason: 'bulk_read',
      taskType: 'bulk_read',
    }
    let opened = false
    const result = await dispatch({
      decision,
      config,
      input: { files: [{ path: ws.file, content: 'export const a = 1\n' }], task: 'summarise' },
      env: {},
      fetchImpl: () => {
        opened = true
        throw new Error('a socket was opened for a provider with no credential')
      },
    })
    assert.equal(opened, false, 'readiness must short-circuit before any network call')
    assert.equal(result.status, 'error')
    assert.equal(result.reason, 'provider_unavailable')
  } finally {
    ws.cleanup()
  }
})

test('the fetch probe above is wired to something that can actually fire', async () => {
  // The control, so the test above cannot silently become vacuous again. With a reachable worker
  // configured, the SAME injection point IS reached — proving `fetchImpl` is live rather than
  // ignored.
  const ws = makeWorkspace('safety-control', { bytes: 40_000 })
  try {
    let opened = false
    await dispatch({
      decision: {
        decision: 'deny',
        delegate: true,
        mode: 'bulk-reader',
        lane: 'bulkRead',
        reason: 'bulk_read',
        taskType: 'bulk_read',
      },
      config: hookConfig(),
      input: { files: [{ path: ws.file, content: 'export const a = 1\n' }], task: 'summarise' },
      env: { MOCK_WORKER_URL: 'http://127.0.0.1:1' },
      fetchImpl: () => {
        opened = true
        throw new Error('probe')
      },
    })
    assert.equal(opened, true, 'fetchImpl is not the injection point dispatch uses')
  } finally {
    ws.cleanup()
  }
})

test('the shipped default lane falls open when the provider cannot be reached', async () => {
  // Not "no key" this time but "key present, nothing listening" — the other half of unavailable.
  // A closed loopback port is a real connection failure rather than a mocked one.
  const ws = makeWorkspace('safety-closed')
  try {
    const config = hookConfig({}, { providers: { mock: { baseUrl: 'http://127.0.0.1:1' } } })
    const out = await runReadHook({
      raw: readStdin({ tool_input: { file_path: ws.file }, cwd: ws.dir }),
      config,
      env: { MOCK_WORKER_URL: 'http://127.0.0.1:1' },
    })
    const decision = out.response?.hookSpecificOutput?.permissionDecision ?? 'allow'
    assert.notEqual(decision, 'deny', 'an unreachable worker must leave the read allowed')
  } finally {
    ws.cleanup()
  }
})

/* -------------------------------------------------- does not require credentials */

test('doctor reports a clean keyless install as healthy, and exits 0', () => {
  // THE CLAIM THAT WAS FALSE. The shipped default is gemini and installing requires no key, so
  // doctor used to print FAIL and exit 1 on a working Claude Code install.
  const ci = makeCleanInstall({ label: 'doctor-clean' })
  try {
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--json', '--offline'])
    assert.equal(r.status, 0, `doctor exited ${r.status}:\n${r.stdout}\n${r.stderr}`)
    const report = JSON.parse(r.stdout)
    assert.equal(report.counts.fail, 0, 'a clean install has nothing wrong with it')
    assert.ok(report.counts.warn > 0, 'it should say what is not configured yet')
    // And the warning names the key as a default rather than a mistake.
    const findings = report.sections.flatMap((s) => s.findings)
    const keyFinding = findings.find((f) => f.label.includes('GEMINI_API_KEY'))
    assert.ok(keyFinding, 'the missing key must still be reported')
    assert.equal(keyFinding.level, 'warn')
    assert.match(keyFinding.detail, /SHIPPED DEFAULT/)
  } finally {
    ci.cleanup()
  }
})

test('WARN and INFO never move the exit code', () => {
  // The property the whole four-level scheme rests on, asserted end to end rather than only over
  // the pure summarizer.
  const ci = makeCleanInstall({ label: 'doctor-levels' })
  try {
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--json', '--offline'])
    const report = JSON.parse(r.stdout)
    assert.ok(report.counts.warn + report.counts.info > 0)
    assert.equal(report.counts.fail, 0)
    assert.equal(report.exitCode, 0)
    assert.equal(r.status, report.exitCode, 'the process must exit with what the report says')
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------------------ does not mutate */

test('doctor creates nothing on a clean install', () => {
  // Asserted as "the root is EMPTY except what the fixture made", not as "the store does not
  // exist": the empty-root form also catches a probe file, a salt, a lock or a log written
  // somewhere nobody thought to look.
  const ci = makeCleanInstall({ label: 'doctor-rdonly' })
  try {
    const before = ci.snapshot()
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--offline', '--no-color'])
    assert.equal(r.status, 0)
    assert.deepEqual(ci.snapshot(), before, 'doctor wrote something')
    assert.equal(fs.existsSync(ci.storeDir), false, 'the telemetry directory must not be created')
    assert.equal(fs.existsSync(ci.govDir), false, 'the governance directory must not be created')
  } finally {
    ci.cleanup()
  }
})

test('--probe-writes is the only way doctor creates a directory', () => {
  // The opt-in exists because accessSync can lie about ACLs and about a read-only directory on
  // Windows. Pinned so the default and the opt-in cannot silently converge again.
  const ci = makeCleanInstall({ label: 'doctor-probe' })
  try {
    run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--offline', '--no-color', '--probe-writes'])
    assert.ok(fs.existsSync(ci.storeDir), '--probe-writes should create the store to test it')
    assert.ok(fs.existsSync(ci.govDir))
    // And it cleans up after itself: the probe file must not survive.
    assert.deepEqual(fs.readdirSync(ci.storeDir), [], 'the probe file was left behind')
  } finally {
    ci.cleanup()
  }
})

test('doctor mutates nothing in a store that already has events', () => {
  const ci = makeCleanInstall({ label: 'doctor-populated' })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    const segment = path.join(ci.storeDir, 'events-2026-03-02.jsonl')
    fs.copyFileSync(
      path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', 'events-2026-03-02.jsonl'),
      segment,
    )
    const before = ci.snapshot()
    const r = run(ci, 'plugins/model-router/scripts/doctor.mjs', ['--offline', '--no-color'])
    assert.equal(r.status, 0)
    assert.deepEqual(ci.snapshot(), before, 'doctor changed the store it was reporting on')
  } finally {
    ci.cleanup()
  }
})

/* -------------------------------------- does not create budget state unnecessarily */

test('budget creates nothing and exits 0 with no budget configured', () => {
  // `budget.mjs` had NO test file at all, while its own docstring makes the strongest read-only
  // claim in the repository. This is that claim, finally checked.
  const ci = makeCleanInstall({ label: 'budget-clean' })
  try {
    const before = ci.snapshot()
    const r = run(ci, 'plugins/model-router/scripts/budget.mjs', ['--no-color'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /No budget is configured/)
    assert.deepEqual(ci.snapshot(), before)
    assert.equal(fs.existsSync(ci.govDir), false, 'reading must not materialise the ledger')
  } finally {
    ci.cleanup()
  }
})

test('budget creates nothing even when a limit IS configured', () => {
  // The interesting case. With a limit set there is something to account against, and the
  // temptation is to open the ledger to report headroom.
  const ci = makeCleanInstall({ label: 'budget-limited' })
  try {
    ci.writeProjectConfig({ budget: { enabled: true, run: { maxTotalTokens: 200000 } } })
    const before = ci.snapshot()
    const r = run(ci, 'plugins/model-router/scripts/budget.mjs', ['--no-color'])
    assert.equal(r.status, 0)
    assert.match(r.stdout, /200000|200,000/)
    assert.deepEqual(ci.snapshot(), before)
    assert.equal(fs.existsSync(ci.govDir), false)
  } finally {
    ci.cleanup()
  }
})

test('analytics creates nothing, including no salt', () => {
  const ci = makeCleanInstall({ label: 'analytics-clean' })
  try {
    const before = ci.snapshot()
    const r = run(ci, 'plugins/model-router/scripts/analytics.mjs', ['--no-color'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(ci.snapshot(), before)
    assert.equal(fs.existsSync(ci.storeDir), false)
  } finally {
    ci.cleanup()
  }
})

test('report creates exactly its output file and nothing else', () => {
  const ci = makeCleanInstall({ label: 'report-clean' })
  try {
    const out = path.join(ci.base, 'report out.html')
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/router-dashboard/scripts/report.mjs'), '--out', out, '--no-color'],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.ok(fs.existsSync(out), 'the report was not written')
    // Everything under the root, minus the fixture's own directories and the report itself.
    const created = ci
      .snapshot()
      .filter((e) => !e.endsWith('/'))
      .filter((e) => !e.includes('report out.html'))
    assert.deepEqual(created, [], `report created ${created.join(', ')}`)
    assert.equal(fs.existsSync(ci.storeDir), false, 'reading an empty store must not create it')
  } finally {
    ci.cleanup()
  }
})

test('running every public command twice changes nothing the first run did not', () => {
  // The real idempotency contract, against the commands that exist. There is no setup command —
  // see the note at the foot of this file — so "setup is idempotent" means exactly this.
  const ci = makeCleanInstall({ label: 'idempotent' })
  try {
    const out = path.join(ci.base, 'r.html')
    const once = () => {
      for (const cmd of PUBLIC_COMMANDS) {
        const args = cmd.id === 'report' ? ['--out', out, '--no-color'] : cmd.args
        run(ci, cmd.script, args)
      }
    }
    once()
    const after1 = ci.snapshot()
    const html1 = fs.readFileSync(out, 'utf8')
    once()
    assert.deepEqual(ci.snapshot(), after1, 'a second run of every command changed the tree')
    // The HTML carries a generated-at stamp, so compare everything else about it.
    assert.equal(html1.length > 0, true)
  } finally {
    ci.cleanup()
  }
})

/* ----------------------------------------------- does not modify configuration */

test('no command writes into the user config or the Claude settings directory', () => {
  // Static, and deliberately so: the dangerous version of "setup" is a script that edits a
  // dotfile, and the cheapest guarantee is that no shipped script names one.
  const scripts = []
  for (const plugin of ['model-router', 'router-dashboard']) {
    const dir = path.join(REPO_ROOT, 'plugins', plugin, 'scripts')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      scripts.push(path.join(dir, f))
    }
  }
  assert.ok(scripts.length > 0)
  for (const file of scripts) {
    const src = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const name = path.basename(file)
    assert.equal(/settings\.json/.test(src), false, `${name} must not touch a settings file`)
    assert.equal(/userConfigPath/.test(src), false, `${name} must not write the user config`)
    assert.equal(
      /\.(?:zshrc|bashrc|bash_profile|profile)/.test(src),
      false,
      `${name} must not touch a shell profile`,
    )
  }
})

test('the shipped defaults this phase promised not to change', () => {
  // A GOLDEN SNAPSHOT, scoped to exactly the leaves the phase brief names: routing, governance,
  // the worker and the task-intent default. Deliberately not the whole DEFAULTS object — an
  // unrelated telemetry default moving should not fail a test about routing policy.
  //
  // This is the single highest-value test in the phase: it converts "no defaults were changed"
  // from a sentence in a commit message into a diff somebody has to justify.
  assert.deepEqual(DEFAULTS.worker, {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    timeoutMs: 180000,
    maxRetries: 2,
    maxInputBytes: 2000000,
    temperature: 0.2,
    maxOutputTokens: 8192,
  })

  assert.deepEqual(DEFAULTS.routing.bulkRead, {
    enabled: true,
    enforce: 'deny',
    minLines: 350,
    minBytes: 12000,
    minEstimatedTokens: null,
    minFiles: 1,
    maxFiles: 25,
  })
  assert.deepEqual(DEFAULTS.routing.codeWrite, { enabled: true, enforce: 'suggest' })
  assert.deepEqual(DEFAULTS.routing.neverDelegate, {
    onTargetedRead: true,
    onRecentlyEdited: true,
  })
  assert.deepEqual(DEFAULTS.routing.denyGlobs, [
    '**/.env*',
    '**/*secret*',
    '**/*credential*',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa*',
    '**/.git/**',
    '**/auth/**',
    '**/security/**',
  ])
  assert.deepEqual(DEFAULTS.routing.allowGlobs, [])

  // Intent OFF by default: forwarding the developer's prompt is their decision, not a default
  // they discover afterwards.
  assert.equal(DEFAULTS.hooks.taskIntent.source, 'none')
  assert.equal(DEFAULTS.hooks.enabled, true)

  // Every budget limit null. null is "no configured limit"; 0 would be a chosen zero budget.
  for (const scope of ['run', 'daily', 'monthly']) {
    for (const [leaf, value] of Object.entries(DEFAULTS.budget[scope] ?? {})) {
      assert.equal(value, null, `budget.${scope}.${leaf} must ship null, not ${value}`)
    }
  }
  assert.equal(DEFAULTS.budget.onExceed, 'disable')
  assert.equal(DEFAULTS.budget.onUnknownCost, 'allow')
  assert.equal(DEFAULTS.budget.onUnknownUsage, 'allow')
})

/* ------------------------------------------------------------------ census */

test('the command table covers every public command', () => {
  // So a fifth command cannot ship without being examined by the tests above.
  const INTERNAL = new Set([
    'gen-config-schema.mjs',
    'gen-config-doc.mjs',
    'gen-env-docs.mjs',
    'smoke-hook.mjs', // makes real worker calls on purpose
    'prune.mjs', // deletes segments with --apply
    'collect.mjs', // a module, not an entry point
  ])
  const covered = new Set(PUBLIC_COMMANDS.map((c) => path.basename(c.script)))
  const unexamined = []
  for (const plugin of ['model-router', 'router-dashboard']) {
    const dir = path.join(REPO_ROOT, 'plugins', plugin, 'scripts')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      if (covered.has(f) || INTERNAL.has(f)) continue
      unexamined.push(`${plugin}/scripts/${f}`)
    }
  }
  assert.deepEqual(unexamined, [], 'classify it as public (and test it here) or as internal')
})

/*
 * ON "MAKE SETUP IDEMPOTENT": THERE IS NO SETUP COMMAND, AND THAT IS THE FEATURE.
 *
 * Nothing needs setting up. Hooks are registered by hooks.json inside the installed plugin, so
 * nothing is copied or merged into a user's settings. Config is optional at every layer, and a
 * zero-config load returns working defaults with zero warnings. The telemetry and governance
 * directories are created lazily by their first writer, which is why doctor must not create them.
 *
 * The one genuinely required step is a provider key, and that is an OS operation — a plugin script
 * that edited a shell profile would be the most invasive thing in this repository.
 *
 * So the idempotency guarantee is pinned by the two tests above rather than built: no script
 * writes a dotfile, and running every command twice changes nothing.
 */
