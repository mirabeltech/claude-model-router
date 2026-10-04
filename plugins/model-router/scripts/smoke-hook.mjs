#!/usr/bin/env node
/**
 * Hook smoke test against a REAL worker. Opt-in, and deliberately not part of `npm test`.
 *
 * `npm test` is keyless, offline and runs on both CI platforms, so the end-to-end coverage there
 * stops at a local fixture server (test/hook.e2e.test.mjs). This script is the other half: it
 * drives the shipped hook against a worker that is actually a language model, which is the only
 * way to see that a real summary comes back and how long a real delegation takes.
 *
 * It defaults to Ollama because that needs no API key and no network egress.
 *
 * Usage:
 *   node plugins/model-router/scripts/smoke-hook.mjs
 *   node plugins/model-router/scripts/smoke-hook.mjs --model mistral:latest
 *   node plugins/model-router/scripts/smoke-hook.mjs --provider gemini --model gemini-2.5-flash
 *   node plugins/model-router/scripts/smoke-hook.mjs --file path/to/big-file.ts
 *
 * On a CPU-only machine a local model can take minutes to read tens of kilobytes, which proves
 * something about the hardware rather than about the hook. `--min-bytes` lowers the gate's size
 * threshold so the pipeline can be exercised with a small file and a fast answer; the output says
 * when it has been used, because a smoke test that quietly moved a shipped threshold is a smoke
 * test that proves less than it claims.
 *
 * Exit codes: 0 if the hook delegated and returned a summary, 1 otherwise. A refusal is reported
 * with the gate's own reason code, because "it fell open" is not a diagnosis.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--') ? dflt : argv[i + 1]
}

const provider = opt('provider', 'ollama')
const model = opt('model', provider === 'ollama' ? 'llama3:latest' : null)
const file = path.resolve(REPO_ROOT, opt('file', 'test/fixtures/corpus/large.ts'))

if (!fs.existsSync(file)) {
  console.error(`no such file: ${file}`)
  process.exit(1)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'router-smoke-'))
const transcript = path.join(scratch, 'transcript.jsonl')
// The question the worker is asked when `CMR_TASK_INTENT_SOURCE=transcript`. Settable, because the
// whole point of the intent path is that the question is not fixed.
const question = opt('task', 'Which exported symbols take no arguments? Give each one with its line.')
// A transcript with no edit of the file, so `recentlyEdited` measures false rather than falling
// back to its pessimistic reading and refusing for a reason that has nothing to do with the test.
//
// It carries a REALISTIC human turn — `promptSource` set, no `toolUseResult` — so that running
// this script with intent on exercises the real extractor rather than falling back for want of a
// record. With intent off (the default) these fields are never read.
fs.writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'user', promptSource: 'user', promptId: 'smoke-1', message: { role: 'user', content: question } }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: question, leafUuid: 'smoke-leaf', sessionId: 'smoke-session' }),
  ].join('\n') + '\n',
)

const payload = JSON.stringify({
  hook_event_name: 'PreToolUse',
  session_id: 'smoke-session',
  tool_use_id: 'toolu_smoke',
  cwd: REPO_ROOT,
  transcript_path: transcript,
  permission_mode: 'default',
  tool_name: 'Read',
  tool_input: { file_path: file },
})

const bytes = fs.statSync(file).size
console.log(`hook smoke test`)
console.log(`  worker:   ${provider}${model ? `/${model}` : ''}`)
console.log(`  file:     ${path.relative(REPO_ROOT, file)} (${bytes} bytes)`)
console.log(`  store:    ${scratch}`)
// Reported up front rather than inferred from the output, so a run whose request was not the
// one the operator expected is obvious before the worker has spent two minutes on it.
const intentSource = process.env.CMR_TASK_INTENT_SOURCE ?? 'none'
console.log(`  task:     ${intentSource === 'transcript' ? `from transcript — "${question}"` : 'the fixed generic task (CMR_TASK_INTENT_SOURCE=transcript to use the question above)'}`)
console.log('')

const env = {
  ...process.env,
  CMR_WORKER_PROVIDER: provider,
  CMR_TELEMETRY_ENABLED: '1',
  CMR_TELEMETRY_DIR: scratch,
  // A real model summarising tens of kilobytes takes longer than the interactive default, and
  // this script is measuring whether it works at all rather than whether it is fast.
  CMR_HOOK_TIMEOUT_MS: opt('timeout', '120000'),
  CMR_WORKER_TIMEOUT_MS: opt('timeout', '120000'),
}
if (model) env.CMR_BULK_READ_WORKER_MODEL = model

const minBytes = opt('min-bytes', null)
if (minBytes !== null) {
  env.CMR_MIN_BYTES = minBytes
  console.log(`  NOTE:     gate size threshold lowered to ${minBytes} bytes for this run (default is 12000)`)
  console.log('')
}
// Ollama needs no key; leaving worker.apiKeyEnv at its Gemini default is harmless there because
// readiness only forwards it for a provider whose capabilities ask for a key.
if (provider !== 'gemini') env.CMR_WORKER_API_KEY_ENV = null

const started = Date.now()
const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', 'pre-tool-use.mjs')], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (c) => (stdout += c))
child.stderr.on('data', (c) => (stderr += c))
child.stdin.end(payload)

child.on('close', (code) => {
  const elapsed = Date.now() - started
  console.log(`  exit:     ${code}`)
  console.log(`  elapsed:  ${elapsed} ms`)
  if (stderr !== '') console.log(`  stderr:   ${JSON.stringify(stderr)}  <-- the hook must never write here`)

  const rows = readRows(scratch)

  if (stdout === '') {
    console.log('')
    console.log('  RESULT: the hook fell open — the Read would proceed normally.')
    if (rows.length > 0) {
      const row = rows[rows.length - 1]
      console.log(`  gate:     ${row.routing_decision} / ${row.routing_reason}`)
      console.log(`  status:   ${row.status}${row.error_code ? ` (${row.error_code})` : ''}`)
    } else {
      console.log('  no telemetry row was written, so the hook stopped before reaching the gate.')
    }
    cleanup()
    process.exit(1)
  }

  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    console.log(`\n  RESULT: stdout was not JSON — Claude Code would ignore it.\n  ${stdout.slice(0, 300)}`)
    cleanup()
    process.exit(1)
  }

  const h = parsed.hookSpecificOutput ?? {}
  const answer = h.additionalContext ?? ''
  console.log('')
  console.log(`  decision: ${h.permissionDecision}`)
  console.log(`  answer:   ${answer.length} chars`)
  console.log('')
  console.log('  --- the worker said ---')
  for (const line of answer.trim().split('\n').slice(0, 12)) console.log(`  ${line}`)
  console.log('  -----------------------')

  if (rows.length > 0) {
    const row = rows[rows.length - 1]
    console.log('')
    console.log(`  row:      task_type=${row.task_type} status=${row.status} provider=${row.provider} model=${row.model}`)
    console.log(`  gate:     ${row.routing_decision} / ${row.routing_reason} (policy v${row.routing_policy_version})`)
    console.log(`  request:  intent=${row.task_intent_source} prompt v${row.prompt_version}`)
    console.log(`  usage:    in=${fmt(row.worker_input_tokens)} out=${fmt(row.worker_output_tokens)} source=${row.worker_usage_source}`)
    console.log(`  saving:   ${fmt(row.estimated_input_tokens)} corpus tokens - ${fmt(row.returned_answer_tokens_estimated)} answer tokens = ${fmt(row.estimated_tokens_avoided)} avoided`)
    console.log(`  cost:     worker=${fmt(row.worker_total_cost)} net=${fmt(row.estimated_net_savings)} (null means unpriced, never zero)`)
    console.log(`  latency:  ${fmt(row.latency_ms)} ms end to end`)
  }

  const good = h.permissionDecision === 'deny' && answer.trim() !== '' && code === 0 && stderr === ''
  console.log('')
  console.log(good ? '  RESULT: delegated, and a real summary came back.' : '  RESULT: the response was not a usable delegation.')
  cleanup()
  process.exit(good ? 0 : 1)
})

function fmt(v) {
  return v === null || v === undefined ? 'NULL' : String(v)
}

function readRows(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('events') && f.endsWith('.jsonl'))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(dir, f), 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          .filter(Boolean),
      )
  } catch {
    return []
  }
}

function cleanup() {
  if (argv.includes('--keep')) {
    console.log(`\n  store kept at ${scratch}`)
    return
  }
  try {
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* a leftover temp directory is not a failure */
  }
}
