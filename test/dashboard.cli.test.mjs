/**
 * `npm run report`, the three ways a response reaches it, and the one way it refuses.
 *
 * `runReport` takes `argv`, `log`, `warn`, `readStdin`, `collect`, `fsImpl` and `cwd` as
 * parameters, following `prune.mjs` — the house pattern for a CLI you want to unit-test in
 * process. The collector is injected, so the resolution order and the error paths are testable
 * without a child process and without a router installed.
 *
 * The convenience path IS exercised against a real spawn in one test, because an injected
 * collector would never have caught an argv or encoding mistake.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { analyzeRows, stringifyResponse } from '../plugins/model-router/lib/analytics/index.mjs'
import { runReport } from '../plugins/router-dashboard/scripts/report.mjs'
import { candidatePaths, collectFromStore, findRouterScript } from '../plugins/router-dashboard/scripts/collect.mjs'
import { NOW, dispatchedRow, pricedRow } from './helpers/analytics-rows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const FIXTURES = path.join(HERE, 'fixtures', 'telemetry')
const REPORT_SCRIPT = path.join(REPO_ROOT, 'plugins', 'router-dashboard', 'scripts', 'report.mjs')
const STAMP = '2026-03-04T12:00:00.000Z'

const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

/** A real response, as the engine produces it. */
function response(rows = [pricedRow(), dispatchedRow()]) {
  return analyzeRows(rows, { now: NOW, window: { kind: 'all' } })
}

/** Run runReport in process, capturing both streams. */
function run(argv, { stdin = null, collect = null, cwd = null } = {}) {
  const scratch = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  const out = []
  const err = []
  const status = runReport({
    argv,
    log: (s) => out.push(String(s)),
    warn: (s) => err.push(strip(String(s))),
    readStdin: () => stdin,
    collect: collect ?? (() => ({ ok: false, reason: 'router_not_found', detail: 'no router' })),
    cwd: scratch,
  })
  return { status, out: out.join('\n'), err: err.join('\n'), scratch }
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true })

/* --------------------------------------------------------------- --input */

test('--input reads a response from a file and writes a report', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-input-'))
  try {
    const input = path.join(scratch, 'a.json')
    fs.writeFileSync(input, stringifyResponse(response()), 'utf8')
    const r = run(['--input', input, '--now', STAMP], { cwd: scratch })
    assert.equal(r.status, 0)
    const written = r.out.trim()
    assert.ok(fs.existsSync(written), `the report was not written to ${written}`)
    assert.match(fs.readFileSync(written, 'utf8'), /^<!doctype html>/)
  } finally {
    cleanup(scratch)
  }
})

test('the last line of stdout is the absolute path and nothing else', () => {
  // So `npm run --silent report` is usable inside a $(...).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-path-'))
  try {
    const input = path.join(scratch, 'a.json')
    fs.writeFileSync(input, stringifyResponse(response()), 'utf8')
    const r = run(['--input', input, '--now', STAMP], { cwd: scratch })
    const lines = r.out.trim().split('\n')
    assert.equal(lines.length, 1, 'stdout must carry only the path')
    assert.equal(path.isAbsolute(lines[0]), true)
  } finally {
    cleanup(scratch)
  }
})

test('informational output goes to stderr so the path stays parseable', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-streams-'))
  try {
    const input = path.join(scratch, 'a.json')
    fs.writeFileSync(input, stringifyResponse(response()), 'utf8')
    const r = run(['--input', input, '--now', STAMP], { cwd: scratch })
    assert.match(r.err, /read /)
    assert.equal(r.out.includes('read '), false)
  } finally {
    cleanup(scratch)
  }
})

test('a missing input file is a usage error that names the file', () => {
  const r = run(['--input', path.join(os.tmpdir(), 'definitely-not-here.json')])
  assert.equal(r.status, 2)
  assert.match(r.err, /cannot read/)
  cleanup(r.scratch)
})

/* ---------------------------------------------------------------- stdin */

test('a piped response is used when stdin is not a terminal', () => {
  const r = run(['--now', STAMP], { stdin: stringifyResponse(response()) })
  try {
    assert.equal(r.status, 0)
    assert.match(r.err, /read stdin/)
    assert.ok(fs.existsSync(r.out.trim()))
  } finally {
    cleanup(r.scratch)
  }
})

test('--input wins over stdin, because an explicit argument is an explicit choice', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-prec-'))
  try {
    const input = path.join(scratch, 'a.json')
    fs.writeFileSync(input, stringifyResponse(response()), 'utf8')
    const r = run(['--input', input, '--now', STAMP], { stdin: '{"nonsense":true}', cwd: scratch })
    assert.equal(r.status, 0)
    assert.match(r.err, new RegExp('read .*a\\.json'))
  } finally {
    cleanup(scratch)
  }
})

test('the human report piped by mistake is diagnosed, not rendered', () => {
  const r = run(['--now', STAMP], { stdin: '====\nmodel-router analytics\n====' })
  assert.equal(r.status, 2)
  assert.match(r.err, /not_json/)
  assert.match(r.err, /add --json/)
  cleanup(r.scratch)
})

test('malformed JSON on stdin is reported as malformed', () => {
  const r = run(['--now', STAMP], { stdin: '{"analytics_contract_version":' })
  assert.equal(r.status, 2)
  assert.match(r.err, /malformed_json/)
  cleanup(r.scratch)
})

test('a response from a newer contract is refused rather than rendered', () => {
  const newer = { ...response(), analytics_contract_version: 99 }
  const r = run(['--now', STAMP], { stdin: JSON.stringify(newer) })
  assert.equal(r.status, 2)
  assert.match(r.err, /unsupported_contract_version/)
  cleanup(r.scratch)
})

/* ------------------------------------------------------------- collection */

test('with no input and no pipe, the collector is consulted', () => {
  let called = null
  const r = run(['--7d', '--provider', 'ollama', '--now', STAMP], {
    collect: (opts) => {
      called = opts
      return { ok: true, json: stringifyResponse(response()), script: '/fake/analytics.mjs' }
    },
  })
  try {
    assert.equal(r.status, 0)
    assert.deepEqual(called.passthrough, ['--7d', '--provider', 'ollama', '--now', STAMP])
  } finally {
    cleanup(r.scratch)
  }
})

test('a missing router prints instructions and exits 2, not a stack trace', () => {
  // Installed alone, the dashboard is a renderer rather than a reporter. Saying so in one screen
  // is better than leaving the user to discover it.
  const r = run(['--now', STAMP], {
    collect: () => ({ ok: false, reason: 'router_not_found', detail: 'no router here' }),
  })
  assert.equal(r.status, 2)
  assert.match(r.err, /no router here/)
  cleanup(r.scratch)
})

test('a router that fails is reported with its own stderr', () => {
  const r = run(['--now', STAMP], {
    collect: () => ({ ok: false, reason: 'router_failed', detail: 'analytics.mjs exited 2:\nbad flag' }),
  })
  assert.equal(r.status, 2)
  assert.match(r.err, /router_failed/)
  assert.match(r.err, /bad flag/)
  cleanup(r.scratch)
})

/* ------------------------------------------------------- the collector itself */

test('the collector looks in both real plugin layouts and nowhere else', () => {
  // Side-by-side plugins, and this repository's own plugins/<name>/ tree. A wrong guess that
  // happened to find something executable would be worse than finding nothing.
  const paths = candidatePaths('/plugins/router-dashboard')
  assert.equal(paths.length, 2)
  for (const p of paths) assert.match(p, /model-router[\\/]scripts[\\/]analytics\.mjs$/)
})

test('an explicit --router accepts the plugin directory or the script itself', () => {
  const routerDir = path.join(REPO_ROOT, 'plugins', 'model-router')
  const script = path.join(routerDir, 'scripts', 'analytics.mjs')
  assert.equal(findRouterScript({ explicit: routerDir }), script)
  assert.equal(findRouterScript({ explicit: script }), script)
  assert.equal(findRouterScript({ explicit: path.join(os.tmpdir(), 'nope') }), null)
})

test('the collector resolves the router inside this repository', () => {
  const found = findRouterScript({ root: path.join(REPO_ROOT, 'plugins', 'router-dashboard') })
  assert.notEqual(found, null, 'the sibling probe must find the router in this repo')
  assert.match(found, /analytics\.mjs$/)
})

test('a path with a space survives the spawn, because the argv is an array', () => {
  // A shell string would split it into two arguments; the test asserts the arguments the
  // collector actually passes rather than trusting the comment that says so.
  let seen = null
  const res = collectFromStore({
    explicit: '/weird path/model-router',
    fsImpl: { existsSync: () => true },
    spawn: (exe, argv, opts) => {
      seen = { exe, argv, opts }
      return { status: 0, stdout: '{}' }
    },
    passthrough: ['--7d'],
  })
  assert.equal(res.ok, true)
  assert.equal(seen.opts.shell, false, 'shell:false is what makes the array meaningful')
  assert.equal(seen.argv[0], path.join('/weird path/model-router', 'scripts', 'analytics.mjs'))
  assert.equal(seen.argv[1], '--json')
  assert.deepEqual(seen.argv.slice(2), ['--7d'])
})

test('the collector asks for json, always', () => {
  let seen = null
  collectFromStore({
    explicit: '/x/model-router',
    fsImpl: { existsSync: () => true },
    spawn: (exe, argv) => {
      seen = argv
      return { status: 0, stdout: '{}' }
    },
  })
  assert.ok(seen.includes('--json'))
})

test('a spawn error is reported rather than thrown', () => {
  const res = collectFromStore({
    explicit: '/x/model-router',
    fsImpl: { existsSync: () => true },
    spawn: () => ({ error: new Error('ENOENT') }),
  })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'spawn_failed')
})

/* ------------------------------------------------------------------ output */

test('--out controls the destination', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-out-'))
  try {
    const target = path.join(scratch, 'custom.html')
    const r = run(['--now', STAMP, '--out', target], { stdin: stringifyResponse(response()) })
    assert.equal(r.status, 0)
    assert.equal(r.out.trim(), path.resolve(target))
    assert.ok(fs.existsSync(target))
  } finally {
    cleanup(scratch)
  }
})

test('the default filename carries the UTC date, matching the .gitignore reservation', () => {
  const r = run(['--now', STAMP], { stdin: stringifyResponse(response()) })
  try {
    assert.match(path.basename(r.out.trim()), /^router-report-2026-03-04\.html$/)
  } finally {
    cleanup(r.scratch)
  }
})

test('an unwritable destination is a usage error, not a crash', () => {
  const r = run(['--now', STAMP, '--out', path.join(os.tmpdir(), 'no-such-dir-here', 'x.html')], {
    stdin: stringifyResponse(response()),
  })
  assert.equal(r.status, 2)
  assert.match(r.err, /cannot write/)
  cleanup(r.scratch)
})

test('an unparseable --now is refused rather than falling back to the wall clock', () => {
  const r = run(['--now', 'teatime'], { stdin: stringifyResponse(response()) })
  assert.equal(r.status, 2)
  assert.match(r.err, /--now is not an instant/)
  cleanup(r.scratch)
})

test('an unknown option is refused', () => {
  const r = run(['--nonsense'])
  assert.equal(r.status, 2)
  assert.match(r.err, /unknown option: --nonsense/)
  cleanup(r.scratch)
})

test('--help exits 0 and names the three input routes', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  assert.match(r.out, /--input/)
  assert.match(r.out, /stdin/)
  assert.match(r.out, /analytics CLI/)
  cleanup(r.scratch)
})

test('two runs over the same response produce byte-identical HTML', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-det-'))
  try {
    const json = stringifyResponse(response())
    const a = path.join(scratch, 'a.html')
    const b = path.join(scratch, 'b.html')
    run(['--now', STAMP, '--out', a], { stdin: json, cwd: scratch })
    run(['--now', STAMP, '--out', b], { stdin: json, cwd: scratch })
    assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'))
  } finally {
    cleanup(scratch)
  }
})

test('the loud data-quality conditions are surfaced on stderr', () => {
  const rows = [dispatchedRow({ schema_version: 2 }), pricedRow()]
  const r = run(['--now', STAMP], { stdin: stringifyResponse(analyzeRows(rows, { now: NOW, window: { kind: 'all' } })) })
  try {
    assert.match(r.err, /warn: schema_versions_unreadable/)
  } finally {
    cleanup(r.scratch)
  }
})

/* --------------------------------------------- the real end-to-end path */

test('the real spawn path produces a report from the fixture store', () => {
  // The one test that does not inject the collector. An injected one would never catch an argv
  // or an encoding mistake in the thing a user actually runs.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-e2e-'))
  try {
    const target = path.join(scratch, 'e2e.html')
    const res = spawnSync(
      process.execPath,
      [REPORT_SCRIPT, '--7d', '--now', STAMP, '--out', target],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: scratch,
          USERPROFILE: scratch,
          CLAUDE_PROJECT_DIR: scratch,
          CMR_TELEMETRY_DIR: FIXTURES,
        },
      },
    )
    assert.equal(res.status, 0, `report failed: ${strip(res.stderr ?? '')}`)
    assert.equal(res.stdout.trim(), path.resolve(target))
    const html = fs.readFileSync(target, 'utf8')
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /model-router . delegation report|delegation report/)
    // And the end-to-end path is subject to the same content ban as every other path.
    assert.equal(html.includes('FIXTURE-MUST-NOT-APPEAR'), false)
  } finally {
    cleanup(scratch)
  }
})

test('the real spawn path on an empty store still writes a complete report', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'report-empty-'))
  try {
    const target = path.join(scratch, 'empty.html')
    const res = spawnSync(process.execPath, [REPORT_SCRIPT, '--7d', '--now', STAMP, '--out', target], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: scratch,
        USERPROFILE: scratch,
        CLAUDE_PROJECT_DIR: scratch,
        CMR_TELEMETRY_DIR: path.join(FIXTURES, 'empty'),
      },
    })
    assert.equal(res.status, 0)
    const html = fs.readFileSync(target, 'utf8')
    assert.match(html, /no events/)
    // THE SHIPPED STATE: if this ever prints a price, a rate was invented between the pricing
    // table and the HTML.
    assert.equal(/\$[0-9]/.test(html), false, 'a default install must produce no dollar figure')
  } finally {
    cleanup(scratch)
  }
})
