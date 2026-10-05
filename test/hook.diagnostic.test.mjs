/**
 * The opt-in exit diagnostic, against the real child process.
 *
 * TWO CLAIMS, AND THE FIRST ONE IS THE IMPORTANT ONE. Unset, this must change nothing whatsoever —
 * CLAUDE.md's third non-negotiable is that a measurement can never break a hook, and a diagnostic
 * written to investigate a crash would be a poor thing to crash on. Set, it must produce one intact
 * line that carries the one fact the investigation needs and none of the facts it must not carry.
 *
 * `process.report.getReport()` IS THE HAZARD. It contains `environmentVariables`, so a careless
 * serialization would write the developer's `GEMINI_API_KEY` into a file and call it diagnostics.
 * The leak test below is paired in both directions — the key must be absent AND the three
 * dangerous section names must be absent — so a future rewrite that keeps the key out by accident
 * but starts dumping the command line still fails.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { makeWorkspace, readStdin, runHookProcess } from './helpers/hook-payload.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'

const MODULE = path.join(
  import.meta.dirname,
  '..',
  'plugins',
  'model-router',
  'lib',
  'hook',
  'exit-diagnostic.mjs',
)

let server
test.before(async () => {
  server = await startProviderServer()
})
test.after(async () => {
  await server?.close()
})

function childEnv(dir, extra = {}) {
  return {
    CMR_WORKER_PROVIDER: 'mock',
    CMR_WORKER_API_KEY_ENV: 'MOCK_WORKER_URL',
    MOCK_WORKER_URL: server.url,
    CMR_TELEMETRY_ENABLED: '0',
    CLAUDE_PROJECT_DIR: dir,
    HOME: dir,
    USERPROFILE: dir,
    ...extra,
  }
}

const stdinFor = (ws) =>
  readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } })

/** The one line the diagnostic wrote, parsed. */
function readLine(file) {
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(raw.endsWith('\n'), 'the record must end in a newline')
  const lines = raw.split('\n').filter((l) => l !== '')
  assert.equal(lines.length, 1, `expected one record, got ${lines.length}`)
  return { raw, line: JSON.parse(lines[0]) }
}

/* ------------------------------------------------------- unset changes nothing */

test('unset, the diagnostic writes nothing and the hook is byte-identical', async () => {
  // THE RULE-3 TEST. The default install must not be able to tell this code exists.
  const ws = makeWorkspace('diag-off', { bytes: 40_000 })
  try {
    const before = fs.readdirSync(ws.dir).sort()
    const r = await runHookProcess(stdinFor(ws), childEnv(ws.dir))

    assert.equal(r.code, 0)
    assert.equal(r.stderr, '')
    assert.ok(r.stdout.startsWith('{'), 'the response is still a JSON object')
    assert.deepEqual(fs.readdirSync(ws.dir).sort(), before, 'no file appeared anywhere')
  } finally {
    ws.cleanup()
  }
})

test('an empty or whitespace target is a silent no-op', async () => {
  for (const target of ['', '   ']) {
    const ws = makeWorkspace('diag-empty', { bytes: 40_000 })
    try {
      const before = fs.readdirSync(ws.dir).sort()
      const r = await runHookProcess(
        stdinFor(ws),
        childEnv(ws.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: target }),
      )
      assert.equal(r.code, 0, `target ${JSON.stringify(target)} must still exit 0`)
      assert.equal(r.stderr, '')
      assert.deepEqual(fs.readdirSync(ws.dir).sort(), before)
    } finally {
      ws.cleanup()
    }
  }
})

/* ------------------------------------------------------------ set, it records */

test('set, it appends exactly one line naming what was live at exit', async () => {
  const ws = makeWorkspace('diag-on', { bytes: 40_000 })
  const target = path.join(ws.dir, 'exit.jsonl')
  try {
    const r = await runHookProcess(
      stdinFor(ws),
      childEnv(ws.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: target }),
    )
    assert.equal(r.code, 0)
    assert.equal(r.stderr, '')

    const { line } = readLine(target)
    assert.equal(typeof line.at, 'string')
    assert.equal(typeof line.pid, 'number')
    assert.equal(line.node, process.version)
    assert.equal(line.platform, process.platform)
    assert.equal(typeof line.wroteResponse, 'boolean')
    assert.ok(Array.isArray(line.activeResources), 'the load-bearing field must be an array')
    assert.ok(line.libuv !== undefined, 'the handle projection must be present')
    assert.equal(typeof line.libuv.counts, 'object')
  } finally {
    ws.cleanup()
  }
})

test('wroteResponse records whether a response reached stdout', async () => {
  // The one fact only the entry point knows, and the first thing a reader of a crashing line asks.
  const delegating = makeWorkspace('diag-wrote', { bytes: 40_000 })
  const refusing = makeWorkspace('diag-nowrote', { bytes: 200 })
  try {
    const a = path.join(delegating.dir, 'exit.jsonl')
    const rA = await runHookProcess(
      stdinFor(delegating),
      childEnv(delegating.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: a }),
    )
    assert.notEqual(rA.stdout, '', 'the big file must delegate, or this asserts nothing')
    assert.equal(readLine(a).line.wroteResponse, true)

    const b = path.join(refusing.dir, 'exit.jsonl')
    const rB = await runHookProcess(
      stdinFor(refusing),
      childEnv(refusing.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: b }),
    )
    assert.equal(rB.stdout, '', 'the small file must refuse')
    assert.equal(readLine(b).line.wroteResponse, false)
  } finally {
    delegating.cleanup()
    refusing.cleanup()
  }
})

test('two concurrent hooks append two intact lines', async () => {
  // One record is one writeSync of one Buffer, which is what keeps a concurrent append from
  // interleaving. The same property telemetry.concurrency.test.mjs pins for the sink.
  const a = makeWorkspace('diag-conc-a', { bytes: 40_000 })
  const b = makeWorkspace('diag-conc-b', { bytes: 40_000 })
  const target = path.join(a.dir, 'shared.jsonl')
  try {
    await Promise.all([
      runHookProcess(stdinFor(a), childEnv(a.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: target })),
      runHookProcess(stdinFor(b), childEnv(b.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: target })),
    ])

    const lines = fs.readFileSync(target, 'utf8').split('\n').filter((l) => l !== '')
    assert.equal(lines.length, 2, 'both records must be present')
    const pids = new Set()
    for (const l of lines) pids.add(JSON.parse(l).pid)
    assert.equal(pids.size, 2, 'two distinct processes, two intact records')
  } finally {
    a.cleanup()
    b.cleanup()
  }
})

/* ------------------------------------------------------------- what it must not carry */

test('the environment never reaches the file, in either direction', async () => {
  const PLANTED = 'AIzaSyFAKE0000000000000000000000000000000'
  const ws = makeWorkspace('diag-secret', { bytes: 40_000 })
  const target = path.join(ws.dir, 'exit.jsonl')
  try {
    const r = await runHookProcess(
      stdinFor(ws),
      childEnv(ws.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: target, GEMINI_API_KEY: PLANTED }),
    )
    assert.equal(r.code, 0)

    const { raw } = readLine(target)
    assert.equal(raw.includes(PLANTED), false, 'the planted key must not survive')
    for (const section of ['environmentVariables', 'commandLine', 'sharedObjects', 'userLimits']) {
      assert.equal(raw.includes(section), false, `getReport().${section} must never be serialized`)
    }
    assert.equal(/remoteEndpoint|localEndpoint/.test(raw), false, 'socket endpoints are dropped')
  } finally {
    ws.cleanup()
  }
})

test('the module reads the report once and never serializes it whole', () => {
  // A static pin, because the dynamic test above can only prove the key was absent on one run with
  // one set of live handles. This proves the shape of the code that produced it.
  const source = fs.readFileSync(MODULE, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '')
  assert.equal((code.match(/getReport\(\)/g) ?? []).length, 1, 'exactly one call to getReport')
  assert.equal(/stringify\([^)]*getReport/.test(code), false, 'the report is never stringified whole')
  assert.match(code, /\.libuv/, 'only the libuv section is read')
  assert.equal((code.match(/writeSync/g) ?? []).length, 1, 'one record is one writeSync')
  assert.equal(/writeSync\(1\b/.test(code), false, 'the diagnostic must never touch stdout')
  assert.match(code, /redactSecrets\(/, 'the line crosses the shipped redactor')
})

/* -------------------------------------------------------- hostile targets are inert */

test('an unopenable target never disturbs the hook', async () => {
  const ws = makeWorkspace('diag-hostile', { bytes: 40_000 })
  try {
    const targets = [
      path.join(ws.dir, 'no-such-dir', 'exit.jsonl'), // parent does not exist
      ws.dir, // a directory
      path.join(ws.dir, 'big.ts', 'under-a-file.jsonl'), // a path through a regular file
    ]
    for (const target of targets) {
      const r = await runHookProcess(
        stdinFor(ws),
        childEnv(ws.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: target }),
      )
      assert.equal(r.code, 0, `target ${target} must still exit 0`)
      assert.equal(r.stderr, '', `target ${target} must not write stderr`)
      assert.ok(r.stdout.startsWith('{'), `target ${target} must not disturb the response`)
    }
  } finally {
    ws.cleanup()
  }
})

test('the diagnostic directory is never created', async () => {
  // Creating a directory as a side effect of asking a question is what checkWritable() exists to
  // avoid, and it is why the operator supplies an absolute path rather than the plugin deriving
  // one from a config that may not have loaded.
  const ws = makeWorkspace('diag-nomkdir', { bytes: 40_000 })
  const dir = path.join(ws.dir, 'should-not-appear')
  try {
    await runHookProcess(
      stdinFor(ws),
      childEnv(ws.dir, { CLAUDE_ROUTER_EXIT_DIAGNOSTIC: path.join(dir, 'exit.jsonl') }),
    )
    assert.equal(fs.existsSync(dir), false, 'a diagnostic must not create a directory')
  } finally {
    ws.cleanup()
  }
})
