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
 *   node plugins/model-router/scripts/smoke-hook.mjs --provider gemini --model gemini-3.8-flash
 *   node plugins/model-router/scripts/smoke-hook.mjs --file path/to/big-file.ts
 *   node plugins/model-router/scripts/smoke-hook.mjs --scenario context-exceeded
 *   node plugins/model-router/scripts/smoke-hook.mjs --scenario unavailable
 *
 * `--scenario` exists because a smoke test that only ever exercises the happy path proves the
 * thinnest half of the contract. Against a real worker the interesting questions are what happens
 * when the prompt does NOT fit and when the daemon is NOT there, and both are cheap to arrange:
 *
 *   delegate          the default. A real delegation, a real answer.
 *   context-exceeded  configures a tiny context window, so the request is REFUSED before any
 *                     request is sent. This is the Ollama middle-drop defence, live: the model
 *                     would otherwise be handed a truncated prompt and answer it confidently.
 *   unavailable       points the provider at a port nothing is listening on, so the call fails and
 *                     the hook falls open. A worker that is down must cost the developer nothing.
 *
 * A scenario reports PASS when the router did the right thing for that scenario, which for two of
 * the three means NOT delegating. So `--scenario context-exceeded` exiting 0 is a refusal working,
 * not a delegation.
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

import { DEFAULTS } from '../lib/config.mjs'

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')

const argv = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--') ? dflt : argv[i + 1]
}

const SCENARIOS = Object.freeze(['delegate', 'context-exceeded', 'unavailable'])
const scenario = opt('scenario', 'delegate')
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown --scenario ${scenario}; expected one of ${SCENARIOS.join(', ')}`)
  process.exit(2)
}

/**
 * What each scenario must produce to count as a pass.
 *
 * `null` means "a delegation", so the default scenario keeps the original contract: exit 0 only if
 * a real summary came back. For the other two the pass condition is a specific REFUSAL, named by
 * its error code — a scenario that fell open for some unrelated reason has not demonstrated the
 * thing it was set up to demonstrate, and must not be allowed to look like a pass.
 */
const EXPECTED_ERROR = Object.freeze({
  delegate: null,
  'context-exceeded': ['context_exceeded'],
  // `transport` is a refused connection. `timeout` and `aborted` are accepted too, because a
  // firewall that blackholes rather than refusing turns the same condition into a hang.
  unavailable: ['transport', 'timeout', 'aborted'],
})

const provider = opt('provider', 'ollama')
// Defaults to the SAME model as `providers.ollama.model`, deliberately. These disagreed
// (llama3:latest here, qwen2.5-coder:7b there), which meant the quickstart told a reader to pull
// one model and then the smoke test asked for another.
const model = opt('model', provider === 'ollama' ? DEFAULTS.providers.ollama.model : null)
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
console.log(`  scenario: ${scenario}${scenario === 'delegate' ? '' : '  <-- a REFUSAL or a FALL-OPEN is the pass condition here'}`)
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

/**
 * Where the child records what was still live when it exited.
 *
 * SET ON EVERY RUN, passing or not. The native abort this was built for is fixed, but its exact
 * libuv mechanism is not proven, and a single capture cannot tell "a DNS request was in flight"
 * from "a DNS request is always in flight on this path". Only a diff between a bad run and clean
 * runs on both providers can, so the clean runs have to be captured too.
 *
 * `--diagnostic <path>` keeps the lines somewhere that outlives the scratch directory, which is
 * what an operator chasing a second sighting wants: one file, appended to across many runs, so a
 * crash arrives with its own baseline attached.
 */
const diagnostic =
  opt('diagnostic', null) ?? process.env.CLAUDE_ROUTER_EXIT_DIAGNOSTIC ?? path.join(scratch, 'exit-diagnostic.jsonl')
env.CLAUDE_ROUTER_EXIT_DIAGNOSTIC = diagnostic
console.log(`  exit log: ${diagnostic}`)
console.log('')

const minBytes = opt('min-bytes', null)
if (minBytes !== null) {
  env.CMR_MIN_BYTES = minBytes
  console.log(`  NOTE:     gate size threshold lowered to ${minBytes} bytes for this run (default is 12000)`)
  console.log('')
}
// Ollama needs no key; leaving worker.apiKeyEnv at its Gemini default is harmless there because
// readiness only forwards it for a provider whose capabilities ask for a key.
if (provider !== 'gemini') env.CMR_WORKER_API_KEY_ENV = null

if (scenario === 'context-exceeded') {
  // A window far smaller than the file. Discovery is turned OFF, or the daemon's real answer
  // would override the configured number and the request would fit after all.
  //
  // The value is held in a local rather than read back out of `env`: `env.CMR_*` on the
  // right-hand side is a READ of a SPEC variable outside the loader, which
  // test/env.inventory.test.mjs forbids — and rightly, since that is how a second reader of a
  // setting comes to exist. Writing one for a child process is fine; reading one is not.
  const contextTokens = opt('context-tokens', '256')
  env.CMR_OLLAMA_CONTEXT_TOKENS = contextTokens
  env.CMR_OLLAMA_DISCOVER_CONTEXT = '0'
  console.log(`  NOTE:     context window pinned to ${contextTokens} tokens; discovery disabled`)
  console.log('')
}
if (scenario === 'unavailable') {
  // A port nothing is listening on. Not a fake provider — the real Ollama module, a real socket,
  // a real connection refusal, which is what a stopped daemon actually looks like.
  env.CMR_OLLAMA_BASE_URL = 'http://127.0.0.1:1'
  env.CMR_OLLAMA_DISCOVER_CONTEXT = '0'
  env.CMR_HOOK_TIMEOUT_MS = '8000'
  env.CMR_WORKER_TIMEOUT_MS = '8000'
  env.CMR_WORKER_MAX_RETRIES = '0'
  console.log('  NOTE:     provider pointed at 127.0.0.1:1, where nothing is listening')
  console.log('')
}

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

  // THE WHOLE POINT OF THIS SCRIPT FOR THE libuv ABORT. A violation of "always exit 0, never write
  // stderr" is dumped with whatever was still live at exit, before cleanup can remove it, so the
  // next sighting documents itself without the operator having predicted it.
  if (code !== 0 || stderr !== '') {
    console.log('')
    console.log('  THE HOOK BROKE ITS OWN CONTRACT. What was live at exit:')
    try {
      const lines = fs.readFileSync(diagnostic, 'utf8').split('\n').filter((l) => l.trim() !== '')
      if (lines.length === 0) {
        // Itself a finding, and a strong one: it refutes "during exit" and relocates the question.
        console.log('    (no diagnostic line — the process died BEFORE the diagnostic ran)')
      }
      for (const l of lines.slice(-3)) console.log(`    ${l}`)
    } catch {
      console.log(`    (could not read ${diagnostic})`)
    }
    console.log('')
    console.log('    Attach this to docs/failure-modes.md, with a clean run on the SAME provider')
    console.log('    and a clean run on the other one. The line is only readable as a diff.')
  }

  const rows = readRows(scratch)

  if (stdout === '') {
    console.log('')
    console.log('  RESULT: the hook fell open — the Read would proceed normally.')
    const row = rows.length > 0 ? rows[rows.length - 1] : null
    if (row !== null) {
      console.log(`  gate:     ${row.routing_decision} / ${row.routing_reason}`)
      console.log(`  status:   ${row.status}${row.error_code ? ` (${row.error_code})` : ''}`)
      // NO FALSE WORKER USAGE on a path that produced none. Reported here rather than left to the
      // reader, because this is the whole reason a refusal is safe to record at all.
      console.log(`  usage:    in=${row.worker_input_tokens} out=${row.worker_output_tokens}  (null means nothing was measured)`)
      // THE VERDICT BELONGS ON THIS BRANCH TOO. A successful call whose answer was DISCARDED by
      // verification looks identical to a failed call from here — status ok, no output — and
      // without the verdict an operator cannot tell "the worker broke" from "the worker lied".
      if (row.summary_verify_verdict !== null && row.summary_verify_verdict !== undefined) {
        console.log(
          `  verified: ${row.summary_verify_verdict}` +
            (row.summary_verify_reason ? `  ${row.summary_verify_reason}` : '') +
            (row.summary_line_claims === null
              ? ''
              : `  (${row.summary_line_claims - row.summary_line_claims_wrong}/${row.summary_line_claims} line references confirmed)`),
        )
      }
      if (row.escalation_path) console.log(`  ladder:   ${row.escalation_path}`)
    } else {
      console.log('  no telemetry row was written, so the hook stopped before reaching the gate.')
    }

    // THE EXIT CODE IS SCENARIO-AWARE. For `context-exceeded` and `unavailable` a fall-open IS the
    // pass condition, so reporting failure would invert the result — and a smoke test that exits 1
    // when the router behaved correctly is a smoke test nobody can put in a pipeline.
    const expected = EXPECTED_ERROR[scenario]
    if (expected !== null) {
      const got = row?.error_code ?? null
      const ok = expected.includes(got)
      console.log('')
      console.log(
        ok
          ? `  PASS: scenario "${scenario}" expected one of [${expected.join(', ')}] and got ${got}.`
          : `  FAIL: scenario "${scenario}" expected one of [${expected.join(', ')}] but got ${got}.`,
      )
      cleanup()
      process.exit(ok ? 0 : 1)
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
    // The verification verdict, because a summary that was substituted WITHOUT its claims
    // checking out is the one outcome an operator most needs to see on a live run.
    console.log(
      `  verified: ${row.summary_verify_verdict ?? 'not checked'}` +
        (row.summary_line_claims === null
          ? ''
          : `  (${row.summary_line_claims - row.summary_line_claims_wrong}/${row.summary_line_claims} line references confirmed)`) +
        (row.summary_verify_reason === null ? '' : `  ${row.summary_verify_reason}`),
    )
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
  // A delegation happened. For a scenario that expected a refusal that is a FAILURE, however
  // healthy the answer looks: a context window of 256 tokens must not produce a summary.
  const expected = EXPECTED_ERROR[scenario]
  if (expected !== null) {
    console.log('')
    console.log(`  FAIL: scenario "${scenario}" expected a refusal (${expected.join(' or ')}) but the read was delegated.`)
    process.exit(1)
  }
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
