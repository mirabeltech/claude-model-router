/**
 * The hook's security boundary, as gating checks rather than as prose.
 *
 * The hook is the first code in this repo that runs with a developer's ambient environment, reads
 * paths a model chose, and writes to a channel another program parses. Three claims matter, and
 * all three are checked statically where that is possible, because an architectural promise that
 * is only a comment gets broken by a well-meaning import six months from now:
 *
 *   1. No shell, no child process. A file path cannot become a command.
 *   2. Only the two paths the payload named are ever opened.
 *   3. No secret reaches stdout, stderr or the telemetry store.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { importsOf } from './helpers/imports.mjs'

import { runReadHook } from '../plugins/model-router/lib/hook/run.mjs'
import { __resetTelemetryForTests } from '../plugins/model-router/lib/telemetry/index.mjs'
import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { REPO_ROOT, hookConfig, hookEnv, makeWorkspace, readStdin } from './helpers/hook-payload.mjs'

const LIB_DIR = path.join(REPO_ROOT, 'plugins', 'model-router', 'lib')
const HOOK_DIR = path.join(LIB_DIR, 'hook')
const HOOKS_DIR = path.join(REPO_ROOT, 'plugins', 'model-router', 'hooks')

/** Source with comments removed, so a MENTION of something is never counted as a USE of it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/*
 * Import scanning is shared: see test/helpers/imports.mjs. The local copy this replaced was the
 * single-line form, which could not match a multi-line `import {
 ... 
} from` and therefore
 * missed 23 of the 199 edges in plugins/** — including dispatch/index.mjs -> ./contract.mjs and
 * -> ../context-budget.mjs, both of which the allowlist below permits and neither of which it had
 * ever actually read. Those edges are visible here for the first time.
 */
const hookFiles = () => fs.readdirSync(HOOK_DIR).filter((f) => f.endsWith('.mjs'))
const entryFiles = () => fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'))

const allHookSources = () => [
  ...hookFiles().map((f) => [`lib/hook/${f}`, fs.readFileSync(path.join(HOOK_DIR, f), 'utf8')]),
  ...entryFiles().map((f) => [`hooks/${f}`, fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8')]),
]

/* ------------------------------------------------------- no shell, no process */

const FORBIDDEN_BUILTINS = [
  'node:child_process',
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:tls',
  'node:vm',
  'node:worker_threads',
  'node:cluster',
  'node:repl',
]

test('nothing in the hook layer imports a shell, a process spawner or a socket', () => {
  // A file path chosen by a model must not be able to reach a command line. The hook never
  // executes Bash and does not intercept it either, so there is no reason for any of these.
  for (const [label, source] of allHookSources()) {
    const specs = importsOf(source)
    for (const forbidden of FORBIDDEN_BUILTINS) {
      assert.equal(specs.includes(forbidden), false, `${label} imports ${forbidden}`)
    }
  }
})

test('the hook layer imports only the two runtime builtins it needs', () => {
  const ALLOWED = ['node:fs', 'node:path']
  for (const [label, source] of allHookSources()) {
    const builtins = importsOf(source).filter((s) => s.startsWith('node:'))
    for (const b of builtins) assert.ok(ALLOWED.includes(b), `${label} imports ${b}`)
  }
})

test('the hook layer uses no dynamic require and no dynamic builtin import', () => {
  for (const [label, source] of allHookSources()) {
    const code = stripComments(source)
    assert.equal(/\brequire\s*\(/.test(code), false, `${label} must not use require`)
    assert.equal(/import\(\s*['"]node:/.test(code), false, `${label} must not dynamically import a builtin`)
  }
})

test('the hook layer never spawns, execs or evaluates anything', () => {
  for (const [label, source] of allHookSources()) {
    const code = stripComments(source)
    for (const pattern of [/\bspawn\w*\(/, /\bexec\w*\(/, /\bFunction\s*\(/, /\beval\s*\(/]) {
      assert.equal(pattern.test(code), false, `${label} matches ${pattern}`)
    }
  }
})

/* ----------------------------------------------------------- stdout is sacred */

test('nothing in the hook layer writes to the console', () => {
  // stdout is a protocol channel Claude Code parses. One stray console.log turns a working hook
  // into a malformed response, and stderr on exit 2 would become Claude's feedback.
  for (const [label, source] of allHookSources()) {
    const code = stripComments(source)
    assert.equal(/\bconsole\./.test(code), false, `${label} writes to the console`)
    assert.equal(/process\.stderr/.test(code), false, `${label} writes to stderr`)
  }
})

test('the entry point writes to stdout exactly once, and never uses exit code 2', () => {
  const source = fs.readFileSync(path.join(HOOKS_DIR, 'pre-tool-use.mjs'), 'utf8')
  const code = stripComments(source)
  assert.equal((code.match(/writeSync\(1/g) ?? []).length, 1, 'one write, on the one delegating path')
  assert.equal(/process\.exit\(\s*2\s*\)/.test(code), false, 'exit 2 would block the tool call')
  assert.match(code, /process\.exit\(0\)/, 'the hook always reports success')
})

/* ------------------------------------------------------ the architecture edges */

test('no engine layer imports the hook layer, so the dependency runs one way only', () => {
  const dirs = [LIB_DIR, path.join(LIB_DIR, 'dispatch'), path.join(LIB_DIR, 'telemetry'), path.join(LIB_DIR, 'providers')]
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      const full = path.join(dir, file)
      if (full.startsWith(HOOK_DIR)) continue
      const specs = importsOf(fs.readFileSync(full, 'utf8'))
      for (const spec of specs) {
        assert.equal(spec.includes('hook/'), false, `${file} imports ${spec} — the engine must not know about the hook`)
      }
    }
  }
})

test('the routing and dispatch layers are still pure after this phase', () => {
  // The hook is the layer that was allowed to become impure. Nothing else was.
  for (const rel of ['routing.mjs', 'routing-policy.mjs', 'globs.mjs', 'dispatch/index.mjs', 'dispatch/contract.mjs', 'dispatch/modes.mjs', 'dispatch/task.mjs']) {
    const source = fs.readFileSync(path.join(LIB_DIR, rel), 'utf8')
    const builtins = importsOf(source).filter((s) => s.startsWith('node:'))
    assert.deepEqual(builtins, [], `${rel} imports ${builtins.join(', ')}`)
  }
})

test('the adapter is pure: the protocol translation imports nothing at all', () => {
  const specs = importsOf(fs.readFileSync(path.join(HOOK_DIR, 'adapter.mjs'), 'utf8'))
  assert.deepEqual(specs, [], 'adapter.mjs must be testable against hostile input with no graph')
})

/* ----------------------------------------------------------- only two paths */

test('only the named file and the transcript are ever opened', async () => {
  const ws = makeWorkspace('security-paths', { bytes: 40_000 })
  const opened = []
  const record = (p) => {
    opened.push(String(p))
    return p
  }
  const watchful = {
    statSync: (p, ...a) => fs.statSync(record(p), ...a),
    readFileSync: (p, ...a) => fs.readFileSync(record(p), ...a),
    openSync: (p, ...a) => fs.openSync(record(p), ...a),
    readSync: (...a) => fs.readSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
  }
  try {
    await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      fs: watchful,
      dispatchImpl: async () => ({ status: 'ok', text: 'ok', provider: 'mock', model: 'm' }),
      emit: () => null,
    })
    const allowed = new Set([ws.file, ws.transcript])
    for (const p of opened) {
      assert.ok(allowed.has(p), `the hook opened ${p}, which is neither the file nor the transcript`)
    }
    assert.ok(opened.includes(ws.file), 'the approved file was read')
  } finally {
    ws.cleanup()
  }
})

test('a sensitive path is refused before its bytes are opened at all', async () => {
  const ws = makeWorkspace('security-deny', { bytes: 40_000, name: '.env.production' })
  const reads = []
  const watchful = {
    statSync: (...a) => fs.statSync(...a),
    openSync: (...a) => fs.openSync(...a),
    readSync: (...a) => fs.readSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
    readFileSync: (p, ...a) => {
      reads.push(String(p))
      return fs.readFileSync(p, ...a)
    },
  }
  try {
    fs.writeFileSync(ws.file, `${'x'.repeat(40_000)}\nAWS_SECRET=sk-ant-SUPERSECRETVALUE\n`)
    const r = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookConfig(),
      env: hookEnv('http://127.0.0.1:1'),
      fs: watchful,
      dispatchImpl: async () => {
        throw new Error('a denied file must never reach the dispatcher')
      },
      emit: () => null,
    })
    assert.equal(r.decision.reason, 'deny_glob')
    assert.equal(r.response, null)
    assert.equal(reads.includes(ws.file), false, "a secret file's contents are never loaded")
  } finally {
    ws.cleanup()
  }
})

/* -------------------------------------------------------------- no secrets */

test('a secret in the environment never reaches the response or the row', async () => {
  __resetTelemetryForTests()
  const ws = makeWorkspace('security-secrets', { bytes: 40_000 })
  const SECRET = 'sk-ant-api03-DO-NOT-LEAK-THIS-VALUE'
  try {
    const config = hookConfig({}, { telemetry: { enabled: true, dir: ws.dir, dirResolved: ws.dir } })
    const r = await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config,
      env: { ...hookEnv('http://127.0.0.1:1'), GEMINI_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET },
      dispatchImpl: async () => ({
        ok: false,
        status: 'error',
        reason: 'provider_error',
        provider: 'mock',
        model: null,
        text: null,
        usage: null,
        capabilities: null,
        attempts: 1,
        latencyMs: 3,
        // A provider that leaks the key into its own message is exactly what redactSecrets is for.
        error: { code: 'auth', message: `request failed with key ${SECRET}`, detail: SECRET, provider: 'mock' },
        promptVersion: 1,
        policyVersion: 1,
      }),
    })
    assert.equal(r.response, null, 'the failure falls open')

    const { records } = readSegmentsSync({ dir: ws.dir, fs })
    assert.equal(records.length, 1)
    assert.equal(JSON.stringify(records[0]).includes(SECRET), false, 'no row contains the key')
  } finally {
    __resetTelemetryForTests()
    ws.cleanup()
  }
})

test('error detail is redacted even when the developer opted into storing it', async () => {
  __resetTelemetryForTests()
  const ws = makeWorkspace('security-detail', { bytes: 40_000 })
  const SECRET = 'sk-ant-api03-STILL-SHOULD-NOT-LEAK'
  try {
    const config = hookConfig(
      {},
      { telemetry: { enabled: true, dir: ws.dir, dirResolved: ws.dir, storeErrorDetail: true } },
    )
    await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config,
      env: hookEnv('http://127.0.0.1:1'),
      dispatchImpl: async () => ({
        ok: false,
        status: 'error',
        reason: 'provider_error',
        provider: 'mock',
        text: null,
        usage: null,
        capabilities: null,
        attempts: 1,
        latencyMs: 3,
        error: { code: 'auth', message: 'nope', detail: `Authorization: Bearer ${SECRET}`, provider: 'mock' },
        promptVersion: 1,
        policyVersion: 1,
      }),
    })
    const { records } = readSegmentsSync({ dir: ws.dir, fs })
    assert.ok(records[0].error_message_safe, 'the detail was stored, as configured')
    assert.equal(records[0].error_message_safe.includes(SECRET), false, 'but scrubbed')
  } finally {
    __resetTelemetryForTests()
    ws.cleanup()
  }
})

test('the environment is not forwarded to the worker as part of the request', async () => {
  const ws = makeWorkspace('security-env', { bytes: 40_000 })
  try {
    let seen
    await runReadHook({
      raw: readStdin({ cwd: ws.dir, transcript_path: ws.transcript, tool_input: { file_path: ws.file } }),
      config: hookConfig(),
      env: { ...hookEnv('http://127.0.0.1:1'), SOME_PRIVATE_TOKEN: 'abc123' },
      dispatchImpl: async (args) => {
        seen = args
        return { status: 'ok', text: 'ok', provider: 'mock', model: 'm' }
      },
      emit: () => null,
    })
    // The worker request is constructed explicitly: one file, one task. Nothing from the ambient
    // environment is copied into the payload the provider will send.
    assert.deepEqual(Object.keys(seen.input).sort(), ['files', 'task'])
    assert.equal(JSON.stringify(seen.input).includes('abc123'), false)
    assert.equal(JSON.stringify(seen.input).includes('SOME_PRIVATE_TOKEN'), false)
  } finally {
    ws.cleanup()
  }
})

/* ------------------------------------------------------------- registration */

test('the registration intercepts exactly one event and one tool, with an explicit timeout', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.hooks), ['PreToolUse'], 'one event, and not PostToolUse')
  assert.equal(manifest.hooks.PreToolUse.length, 1, 'one matcher: two would fire twice on one Read')
  assert.equal(manifest.hooks.PreToolUse[0].matcher, 'Read')

  const handlers = manifest.hooks.PreToolUse[0].hooks
  assert.equal(handlers.length, 1)
  const [handler] = handlers
  assert.equal(handler.type, 'command')
  assert.equal(handler.command, 'node', 'node directly — never bash, never a shell, never jq')
  assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs'])
})

test('the registration carries no timeout, which is a workaround and not an oversight', () => {
  // Verified against Claude Code 2.1.177 in a live session: a plugin hook entry carrying BOTH
  // `args` and `timeout` is silently dropped — the hook is loaded, reported as registered, and
  // never executed. `args` alone runs. `timeout` alone (in shell form) also runs. Since exec form
  // is a CLAUDE.md non-negotiable and the hook already bounds its own slow operation with
  // `hooks.timeoutMs`, the timeout is the field that goes.
  //
  // If this is ever re-added, the hook stops running and NOTHING says so. That is why it is a
  // test rather than a comment.
  const manifest = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'))
  const [handler] = manifest.hooks.PreToolUse[0].hooks
  assert.equal(
    'timeout' in handler,
    false,
    'args + timeout together are silently ignored by Claude Code 2.1.177; see docs/claude-code-hook-contract.md',
  )
})

test('the plugin manifest does not redeclare the standard hooks file', () => {
  // `hooks/hooks.json` is loaded automatically. Naming it in `plugin.json` as well makes the CLI
  // log "Duplicate hooks file detected" and fail the whole plugin's hook load — which was the
  // state this phase inherited. `manifest.hooks` is only for ADDITIONAL hook files.
  const plugin = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'plugins', 'model-router', '.claude-plugin', 'plugin.json'), 'utf8'),
  )
  assert.equal('hooks' in plugin, false, 'declaring ./hooks/hooks.json here breaks hook loading entirely')
})

test('the registered script exists, since a missing one fails silently in production', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8'))
  const arg = manifest.hooks.PreToolUse[0].hooks[0].args[0]
  const rel = arg.replace('${CLAUDE_PLUGIN_ROOT}/', '')
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugins', 'model-router', rel)), `${rel} is missing`)
})
