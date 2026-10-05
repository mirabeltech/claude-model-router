/**
 * Shared hook-integration test scaffolding.
 *
 * `hookConfig()` runs the REAL resolver, the way `routingConfig()` and `dispatchConfig()` do, so
 * a new SPEC key cannot leave the helper behind. Two things are patched imperatively afterwards,
 * for the same reasons `dispatch-input.mjs` documents: `providers.mock.baseUrl` has no SPEC leaf,
 * and a sub-second `hooks.timeoutMs` is below the SPEC minimum but is exactly what a timeout test
 * needs.
 *
 * `readPayload()` is the Claude Code side of the contract as the installed binary defines it —
 * see docs/claude-code-hook-contract.md. Fields absent from this fixture are absent from the real
 * payload too, so a test that needs one has to add it deliberately.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { resolveConfig } from '../../plugins/model-router/lib/config.mjs'
import { REPO_ROOT, makeTempDir } from './telemetry-dir.mjs'

export { REPO_ROOT, makeTempDir }

/** The entry point Claude Code spawns, as hooks/hooks.json names it. */
export const HOOK_SCRIPT = path.join(REPO_ROOT, 'plugins', 'model-router', 'hooks', 'pre-tool-use.mjs')

/**
 * A resolved config with the hook enabled and a worker that the fixture server can serve.
 *
 * `apiKeyEnv` is set explicitly to the mock provider's own variable rather than left at the
 * Gemini default. That is not a convenience: `resolveWorker` inherits `worker.apiKeyEnv` across a
 * provider change, so a config that only switches `provider` asks the mock provider for
 * GEMINI_API_KEY and reports a perfectly healthy fixture as unavailable. The dispatcher behaves
 * identically, which is the point — see docs/worker-dispatch.md on the asymmetric inheritance.
 */
export function hookConfig(overrides = {}, patch = {}) {
  const config = resolveConfig({
    layers: [
      {
        name: 'test',
        data: {
          worker: { provider: 'mock', model: 'mock-1', apiKeyEnv: 'MOCK_WORKER_URL' },
          telemetry: { enabled: false },
          ...overrides,
        },
      },
    ],
  }).config

  if (patch.providers) {
    config.providers = { ...config.providers }
    for (const [id, block] of Object.entries(patch.providers)) {
      config.providers[id] = { ...config.providers[id], ...block }
    }
  }
  if (patch.hooks) config.hooks = { ...config.hooks, ...patch.hooks }
  if (patch.worker) config.worker = { ...config.worker, ...patch.worker }
  if (patch.telemetry) config.telemetry = { ...config.telemetry, ...patch.telemetry }
  return config
}

/** The same, pointed at a running fixture server. */
export function hookServerConfig(baseUrl, overrides = {}, patch = {}) {
  return hookConfig(overrides, {
    ...patch,
    providers: { gemini: { baseUrl }, ollama: { baseUrl }, mock: { baseUrl }, ...(patch.providers ?? {}) },
  })
}

/** The environment a ready mock worker needs. Never the real `process.env`. */
export function hookEnv(baseUrl, overrides = {}) {
  return { MOCK_WORKER_URL: baseUrl, ...overrides }
}

/**
 * A PreToolUse payload for a full-file Read, in the shape the installed CLI sends.
 *
 * Note what is NOT here: there is no field naming the user's question, no file size, no line
 * count and no content. Everything the gate needs beyond `file_path` has to be measured.
 */
export function readPayload(overrides = {}) {
  return {
    session_id: 'sess-1',
    prompt_id: '550e8400-e29b-41d4-a716-446655440000',
    transcript_path: '',
    cwd: REPO_ROOT,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_use_id: 'toolu_01ABC',
    tool_input: { file_path: path.join(REPO_ROOT, 'test', 'fixtures', 'corpus', 'large.ts') },
    ...overrides,
  }
}

/** The same, serialized, because that is what the hook actually receives. */
export function readStdin(overrides = {}) {
  return JSON.stringify(readPayload(overrides))
}

/* ------------------------------------------------------------------ fixtures */

/** A scratch directory holding a file of `bytes` bytes and an empty transcript. */
export function makeWorkspace(label, { bytes = 40_000, name = 'big.ts' } = {}) {
  const tmp = makeTempDir(label)
  const file = path.join(tmp.dir, name)
  // Realistic enough to summarise, and at least as big as the test asked for. Built with
  // repeat() rather than a growing concatenation: re-measuring the length every round makes a
  // multi-megabyte fixture quadratic, which is slow enough to look like a hung test.
  const unit = 'export const value = 1 // padding to reach a delegation-worthy size\n'
  const text = unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit)))
  fs.writeFileSync(file, text)

  const transcript = path.join(tmp.dir, 'transcript.jsonl')
  fs.writeFileSync(transcript, '')

  return { ...tmp, file, transcript, bytes: Buffer.byteLength(text), chars: text.length }
}

/** Write a transcript whose last turn is a `tool_use` of `tool` against `filePath`. */
export function writeEditTranscript(transcript, filePath, tool = 'Edit') {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'please change it' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'editing' },
          { type: 'tool_use', id: `toolu_${crypto.randomBytes(3).toString('hex')}`, name: tool, input: { file_path: filePath } },
        ],
      },
    }),
  ]
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`)
}

/* ------------------------------------------------------------ child process */

/**
 * Spawn the real hook the way Claude Code does, and capture the protocol exactly.
 *
 * `env` REPLACES the inherited environment apart from PATH, so a developer's own GEMINI_API_KEY
 * cannot make a test pass on a machine where it is set and fail on a machine where it is not.
 */
export function runHookProcess(stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        // Keep every test out of the developer's real telemetry store and real config files.
        CMR_TELEMETRY_ENABLED: '0',
        HOME: env.HOME ?? process.env.HOME,
        USERPROFILE: env.USERPROFILE ?? process.env.USERPROFILE,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    // `signal` is carried because a native abort is reported two different ways: Windows gives a
    // numeric status (0xC0000409), POSIX gives `code: null` with SIGABRT. Dropping the signal would
    // record a crash on Linux as a null exit code with nothing to explain it.
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    child.stdin.end(stdin)
  })
}
