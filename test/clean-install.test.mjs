/**
 * A fresh install, exercised end to end in a temporary directory.
 *
 * Simulates what a second developer gets: no existing router state, no secrets, no
 * developer-specific paths, no assumption about the working directory, and no pulled Ollama model.
 * Plugin discovery, config creation, doctor, a real router invocation, and the analytics and report
 * commands — in that order, because that is the documented flow.
 *
 * "OFFLINE" IS STATED PRECISELY. Two mechanisms, for two different claims:
 *
 *   - Gate and capability claims run IN PROCESS with an injected implementation, so no socket
 *     exists at all. That is the strongest form.
 *   - End-to-end claims spawn the real scripts against a loopback mock provider, because there the
 *     point IS that the real process boundary works. That is "keyless and network-free beyond
 *     loopback", not "no network", and calling it the former would be a small lie in a file whose
 *     whole purpose is to be trustworthy about install state.
 *
 * The delegating tests set the worker to `mock`, which DEVIATES from the shipped default of
 * `gemini`. They prove the MECHANISM works on a clean install; that the shipped default lane falls
 * open without a key is proven separately in `test/team.safety.test.mjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { spawn } from 'node:child_process'

import { makeCleanInstall, REPO_ROOT, scriptPath } from './helpers/clean-install.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import { loadConfig } from '../plugins/model-router/lib/config.mjs'

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))

/**
 * Spawn a child ASYNCHRONOUSLY and await it.
 *
 * Required wherever the test also runs the loopback provider server. `spawnSync` blocks the
 * parent's event loop, so an in-process HTTP server cannot accept the connection — the request
 * never arrives and the worker call sits there until the hook's 20-second deadline fires. The
 * first version of these tests did exactly that and reported "the worker was never called", which
 * was true and had nothing to do with the code under test.
 *
 * Worth knowing because the failure looks like a router bug and is a harness bug.
 */
function spawnAsync(args, { input = '', env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

/* ------------------------------------------------------- plugin discovery */

test('the marketplace resolves its plugins from an arbitrary working directory', () => {
  // Manifest CORRECTNESS is packaging.test.mjs's job. The claim here is narrower and different:
  // resolution must not depend on where the process was started, because a consumer runs
  // `claude plugin marketplace add` from wherever they happen to be.
  const marketplace = readJson('.claude-plugin/marketplace.json')
  const cwdBefore = process.cwd()
  try {
    process.chdir(os.tmpdir())
    for (const entry of marketplace.plugins) {
      const resolved = path.resolve(REPO_ROOT, entry.source)
      assert.ok(fs.existsSync(resolved), `${entry.source} did not resolve from ${process.cwd()}`)
      assert.ok(fs.existsSync(path.join(resolved, '.claude-plugin', 'plugin.json')))
    }
  } finally {
    process.chdir(cwdBefore)
  }
})

test('the hook command resolves when the plugin lives somewhere unexpected', () => {
  const manifest = readJson('plugins/model-router/hooks/hooks.json')
  const pluginRoot = path.join(REPO_ROOT, 'plugins', 'model-router')
  const handlers = manifest.hooks.PreToolUse.flatMap((m) => m.hooks)
  assert.ok(handlers.length > 0)
  for (const handler of handlers) {
    const resolved = handler.args[0].replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    assert.ok(fs.existsSync(resolved))
  }
})

/* ----------------------------------------------------- config, from nothing */

test('with no config file anywhere, loading yields defaults and zero warnings', () => {
  // The state every new install is in. A single warning here would mean a fresh install starts by
  // telling the developer something is wrong.
  const ci = makeCleanInstall({ label: 'ci-noconfig' })
  try {
    const before = ci.snapshot()
    const { config, warnings, sources } = loadConfig({
      env: { CLAUDE_PROJECT_DIR: ci.projectDir },
      home: ci.home,
      projectDir: ci.projectDir,
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.worker.provider, 'gemini', 'the shipped default')
    // Nothing in `sources` means nothing overrode a default, which is what doctor reports.
    assert.deepEqual(Object.keys(sources), [])
    assert.deepEqual(ci.snapshot(), before, 'loading a config must not create a file')
  } finally {
    ci.cleanup()
  }
})

test('a per-developer config is found, and says so', () => {
  const ci = makeCleanInstall({ label: 'ci-userconfig' })
  try {
    ci.writeUserConfig({ routing: { bulkRead: { minLines: 500 } } })
    const { config, warnings, sources } = loadConfig({
      env: {},
      home: ci.home,
      projectDir: ci.projectDir,
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.routing.bulkRead.minLines, 500)
    assert.equal(sources['routing.bulkRead.minLines'], 'user')
  } finally {
    ci.cleanup()
  }
})

test('a project config overrides the per-developer one', () => {
  // The team-sharing mechanism: a committed project file beats each developer's personal file.
  const ci = makeCleanInstall({ label: 'ci-projectconfig' })
  try {
    ci.writeUserConfig({ routing: { bulkRead: { minLines: 500 } } })
    ci.writeProjectConfig({ routing: { bulkRead: { minLines: 900 } } })
    const { config, warnings, sources } = loadConfig({
      env: {},
      home: ci.home,
      projectDir: ci.projectDir,
    })
    assert.deepEqual(warnings, [])
    assert.equal(config.routing.bulkRead.minLines, 900)
    assert.equal(sources['routing.bulkRead.minLines'], 'project')
  } finally {
    ci.cleanup()
  }
})

test('a config file at any other path is silently ignored', () => {
  // Worth pinning because it is the most common "my setting does nothing" support question. There
  // is no upward walk and no other recognised filename — including the one the examples directory
  // used to be named after.
  const ci = makeCleanInstall({ label: 'ci-wrongpath' })
  try {
    for (const wrong of [
      path.join(ci.projectDir, 'model-router.json'),
      path.join(ci.projectDir, 'model-router.project.json'),
      path.join(ci.projectDir, '.model-router.json'),
    ]) {
      fs.writeFileSync(wrong, JSON.stringify({ routing: { bulkRead: { minLines: 42 } } }))
    }
    const { config, warnings } = loadConfig({ env: {}, home: ci.home, projectDir: ci.projectDir })
    assert.deepEqual(warnings, [], 'an ignored file must not even produce a warning')
    assert.equal(config.routing.bulkRead.minLines, 350, 'the default must still be in force')
  } finally {
    ci.cleanup()
  }
})

/* --------------------------------------------------------------- doctor */

test('doctor on a clean install exits 0 and names what is missing', () => {
  const ci = makeCleanInstall({ label: 'ci-doctor' })
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/doctor.mjs'), '--json', '--offline'],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.equal(report.counts.fail, 0)
    // Every section reports something. A silent section cannot be told from a skipped one.
    for (const section of report.sections) {
      assert.ok(section.findings.length > 0, `${section.id} reported nothing`)
    }
    assert.deepEqual(
      report.sections.map((s) => s.id).slice(0, 4),
      ['project', 'configuration', 'runtime', 'routing'],
      'identity first, then what the gate will do',
    )
  } finally {
    ci.cleanup()
  }
})

test('a keyless local worker with no model pulled is a WARNING, not a failure', () => {
  // THE "no existing Ollama model" CASE. Pointed at a closed loopback port, so the capability
  // probe gets ECONNREFUSED — which is what a developer who has not started the daemon sees.
  // An undiscoverable window must degrade, never block.
  const ci = makeCleanInstall({
    label: 'ci-ollama-down',
    env: {
      CMR_WORKER_PROVIDER: 'ollama',
      CMR_WORKER_MODEL: 'qwen2.5-coder:7b',
      CMR_OLLAMA_BASE_URL: 'http://127.0.0.1:1',
    },
  })
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/doctor.mjs'), '--json'],
      { encoding: 'utf8', env: ci.env },
    )
    const report = JSON.parse(r.stdout)
    assert.equal(report.counts.fail, 0, 'a stopped daemon is not a misconfiguration')
    assert.equal(r.status, 0)

    // The capability falls back to the BUNDLED table, which knows this model — so the finding is a
    // PASS, and the thing that matters is that it is honest about provenance. `assumed`, never
    // `measured`, and it says so in the detail.
    const capability = report.sections.find((s) => s.id === 'worker-capability')
    const sized = capability.findings.filter((f) => /context=/.test(f.label))
    assert.ok(sized.length > 0, 'the capability should still be reported')
    for (const f of sized) {
      assert.match(f.label, /bundled_default\/assumed/, 'an unreachable daemon cannot measure')
      assert.equal(/provider_api|measured/.test(f.label), false, 'nothing here was measured')
      assert.match(f.detail, /NOT verified against this install/)
    }

    // And no key is wanted, because ollama needs none.
    const provider = report.sections.find((s) => s.id === 'worker-provider')
    assert.ok(provider.findings.some((f) => /no API key required/.test(f.label)))
  } finally {
    ci.cleanup()
  }
})

test('a local model the bundled table does not know is unknown, and warns', () => {
  // The other half: `BUNDLED_MODEL_CONTEXT` is an EXACT tag-stripped lookup, so a model nobody has
  // measured gets no number at all. Unknown must warn and must never be treated as unlimited.
  const ci = makeCleanInstall({
    label: 'ci-ollama-unknown',
    env: {
      CMR_WORKER_PROVIDER: 'ollama',
      CMR_WORKER_MODEL: 'some-model-nobody-has-measured',
      CMR_OLLAMA_BASE_URL: 'http://127.0.0.1:1',
    },
  })
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/doctor.mjs'), '--json'],
      { encoding: 'utf8', env: ci.env },
    )
    const report = JSON.parse(r.stdout)
    assert.equal(report.counts.fail, 0, 'an unmeasurable window degrades, it does not break')
    assert.equal(r.status, 0)
    const capability = report.sections.find((s) => s.id === 'worker-capability')
    const unknown = capability.findings.filter((f) => /capability unknown|probe failed/i.test(f.label))
    assert.ok(unknown.length > 0, 'an unknown window must be reported')
    for (const f of unknown) assert.equal(f.level, 'warn', 'unknown is a warning, never a failure')
  } finally {
    ci.cleanup()
  }
})

/* ------------------------------------------------- a real router invocation */

test('a real delegation runs end to end against a loopback worker', async () => {
  // The whole point of the phase, in one test: the SHIPPED hook, spawned as Claude Code would spawn
  // it, against a real HTTP worker, writing a real telemetry row into a fresh store.
  const server = await startProviderServer()
  const ci = makeCleanInstall({
    label: 'ci-delegate',
    env: {
      CMR_WORKER_PROVIDER: 'mock',
      CMR_WORKER_MODEL: 'mock-1',
      // REQUIRED, and a real footgun: `worker.apiKeyEnv` stays at its Gemini default when only
      // the provider is overridden, and a supplied key name REPLACES the provider's own
      // `requiresEnv`. Leaving it alone makes readiness check GEMINI_API_KEY, so the gate declines
      // with `worker_not_ready` and the mock is never called — which is exactly what happened on
      // the first run of this test.
      CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
      MOCK_WORKER_URL: server.url,
      CMR_TELEMETRY_ENABLED: 'true',
    },
  })
  try {
    // A file worth delegating, and an empty transcript so `recentlyEdited` is measurable as false.
    const target = path.join(ci.projectDir, 'big.ts')
    const unit = 'export const value = 1 // padding to reach a delegation-worthy size\n'
    fs.writeFileSync(target, unit.repeat(700))
    const transcript = path.join(ci.projectDir, 'transcript.jsonl')
    fs.writeFileSync(transcript, '')

    const payload = JSON.stringify({
      session_id: 'clean-install',
      transcript_path: transcript,
      cwd: ci.projectDir,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_use_id: 'toolu_clean',
      tool_input: { file_path: target },
    })

    const hook = await spawnAsync([scriptPath('plugins/model-router/hooks/pre-tool-use.mjs')], {
      input: payload,
      env: ci.env,
    })
    assert.equal(hook.status, 0, 'the hook must always exit 0')
    assert.equal(hook.stderr, '', 'the hook must never write to stderr')

    const response = JSON.parse(hook.stdout)
    const out = response.hookSpecificOutput
    assert.equal(out.permissionDecision, 'deny', 'the raw read should be replaced')
    // The ANSWER rides on additionalContext; permissionDecisionReason is the notice explaining to
    // Claude why the file was not handed over. Asserting the answer is the stronger claim: it is
    // what proves a worker actually ran rather than that the gate merely declined.
    assert.match(out.additionalContext, /exports|UserService/i, 'the worker answer did not arrive')
    assert.match(out.permissionDecisionReason, /delegated it to mock\/mock-1/)
    assert.ok(server.requests.length > 0, 'the worker was never called')

    // Exactly one row, in the store the environment pointed at.
    const segments = fs.readdirSync(ci.storeDir).filter((f) => f.endsWith('.jsonl'))
    assert.equal(segments.length, 1, `expected one segment, got ${segments.join(', ')}`)
    const lines = fs
      .readFileSync(path.join(ci.storeDir, segments[0]), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
    assert.equal(lines.length, 1, 'one delegation is one row')
    const row = JSON.parse(lines[0])
    assert.equal(row.status, 'ok')
    assert.equal(row.task_type, 'bulk_read')
  } finally {
    ci.cleanup()
    await server.close()
  }
})

test('with the worker stopped, the same read falls open', async () => {
  // The control, and the guarantee that matters most: identical setup, server closed.
  const server = await startProviderServer()
  const url = server.url
  await server.close()

  const ci = makeCleanInstall({
    label: 'ci-fallopen',
    env: {
      CMR_WORKER_PROVIDER: 'mock',
      CMR_WORKER_MODEL: 'mock-1',
      CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
      MOCK_WORKER_URL: url,
      CMR_TELEMETRY_ENABLED: 'true',
    },
  })
  try {
    const target = path.join(ci.projectDir, 'big.ts')
    const unit = 'export const value = 1 // padding to reach a delegation-worthy size\n'
    fs.writeFileSync(target, unit.repeat(700))
    const transcript = path.join(ci.projectDir, 'transcript.jsonl')
    fs.writeFileSync(transcript, '')

    const hook = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/hooks/pre-tool-use.mjs')],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 'clean-install',
          transcript_path: transcript,
          cwd: ci.projectDir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_use_id: 'toolu_fallopen',
          tool_input: { file_path: target },
        }),
        env: ci.env,
      },
    )
    assert.equal(hook.status, 0, 'the hook must always exit 0, even when the worker is gone')
    assert.equal(hook.stderr, '')
    const decision = hook.stdout.trim() === ''
      ? 'allow'
      : (JSON.parse(hook.stdout).hookSpecificOutput?.permissionDecision ?? 'allow')
    assert.notEqual(decision, 'deny', 'an unreachable worker must leave the read allowed')
  } finally {
    ci.cleanup()
  }
})

/* ---------------------------------------------------- analytics and report */

test('analytics and report read the store a delegation just wrote', async () => {
  const server = await startProviderServer()
  const ci = makeCleanInstall({
    label: 'ci-report',
    env: {
      CMR_WORKER_PROVIDER: 'mock',
      CMR_WORKER_MODEL: 'mock-1',
      // REQUIRED, and a real footgun: `worker.apiKeyEnv` stays at its Gemini default when only
      // the provider is overridden, and a supplied key name REPLACES the provider's own
      // `requiresEnv`. Leaving it alone makes readiness check GEMINI_API_KEY, so the gate declines
      // with `worker_not_ready` and the mock is never called — which is exactly what happened on
      // the first run of this test.
      CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
      MOCK_WORKER_URL: server.url,
      CMR_TELEMETRY_ENABLED: 'true',
    },
  })
  try {
    const target = path.join(ci.projectDir, 'big.ts')
    const unit = 'export const value = 1 // padding to reach a delegation-worthy size\n'
    fs.writeFileSync(target, unit.repeat(700))
    const transcript = path.join(ci.projectDir, 'transcript.jsonl')
    fs.writeFileSync(transcript, '')
    const delegated = await spawnAsync(
      [scriptPath('plugins/model-router/hooks/pre-tool-use.mjs')],
      {
        input: JSON.stringify({
          session_id: 'clean-install',
          transcript_path: transcript,
          cwd: ci.projectDir,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_use_id: 'toolu_report',
          tool_input: { file_path: target },
        }),
        env: ci.env,
      },
    )
    assert.equal(delegated.status, 0)
    assert.notEqual(delegated.stdout.trim(), '', 'the read should have been delegated')

    const analytics = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/analytics.mjs'), '--all', '--json'],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(analytics.status, 0, analytics.stderr)
    const response = JSON.parse(analytics.stdout)
    assert.equal(response.summary.delegations.value, 1)
    // `delegations` counts dispatch ATTEMPTS, so an errored call satisfies it. Assert the success
    // too: an earlier version of this test passed with a 20-second abort because the harness had
    // blocked its own server.
    assert.equal(response.summary.successes.value, 1, 'the delegation must have succeeded')
    // Cost is NULL on a default install, never 0: every bundled rate ships null.
    assert.equal(response.summary.workerCost.value, null)

    const out = path.join(ci.base, 'clean.html')
    const report = spawnSync(
      process.execPath,
      [scriptPath('plugins/router-dashboard/scripts/report.mjs'), '--input', '-', '--out', out, '--no-color'],
      { encoding: 'utf8', input: analytics.stdout, env: ci.env },
    )
    // `--input -` is not supported; the documented route is stdin, so feed it that way.
    const viaStdin = report.status === 0
      ? report
      : spawnSync(
          process.execPath,
          [scriptPath('plugins/router-dashboard/scripts/report.mjs'), '--out', out, '--no-color'],
          { encoding: 'utf8', input: analytics.stdout, env: ci.env },
        )
    assert.equal(viaStdin.status, 0, `${viaStdin.stdout}\n${viaStdin.stderr}`)
    const html = fs.readFileSync(out, 'utf8')
    assert.ok(html.includes('<!doctype html>') || html.includes('<!DOCTYPE html>'))
    // A default install must show no dollar figure at all.
    assert.equal(/\$[0-9]/.test(html), false, 'a price was invented on a clean install')
  } finally {
    ci.cleanup()
    await server.close()
  }
})

/* -------------------------------------------------------------- isolation */

test('after the whole sequence, nothing exists outside the scratch root', () => {
  // The guarantee the entire suite depends on. Checked last, over a fresh fixture, so a leak
  // introduced by any of the above would show up here.
  const ci = makeCleanInstall({ label: 'ci-isolation' })
  try {
    const homeBefore = fs.existsSync(path.join(os.homedir(), '.claude', 'model-router'))
    for (const [script, args] of [
      ['plugins/model-router/scripts/doctor.mjs', ['--offline', '--no-color']],
      ['plugins/model-router/scripts/budget.mjs', ['--no-color']],
      ['plugins/model-router/scripts/analytics.mjs', ['--no-color']],
    ]) {
      spawnSync(process.execPath, [scriptPath(script), ...args], { encoding: 'utf8', env: ci.env })
    }
    // The developer's real directory is in whatever state it was already in — these commands must
    // not have created it.
    assert.equal(
      fs.existsSync(path.join(os.homedir(), '.claude', 'model-router')),
      homeBefore,
      'a command touched the real home directory',
    )
    const probe = spawnSync(process.execPath, [scriptPath('test/helpers/homedir-probe.mjs')], {
      encoding: 'utf8',
      env: ci.env,
    })
    assert.equal(probe.stdout.trim(), ci.home)
  } finally {
    ci.cleanup()
  }
})
