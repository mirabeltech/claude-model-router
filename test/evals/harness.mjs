/**
 * The harness: run a case at whichever layer it declares, and collect what the metrics and gates
 * need.
 *
 * THREE LAYERS, THREE REASONS.
 *
 *   decide   — the pure gate. No file is read and no provider exists, so a size-boundary case costs
 *              microseconds and cannot be flaky.
 *   hook     — the REAL `pre-tool-use.mjs` as a child process, over stdin and stdout. The process
 *              boundary has failure modes an in-process call cannot see, and the hook's own facts
 *              layer (the transcript scan, the stat) only runs here. This is also the only layer
 *              that measures the ~73 ms process startup.
 *   dispatch — the real `dispatch()`, the real provider module, the real retry wrapper and the real
 *              payload-size guard, with only the transport replaced by an injected `fetchImpl`.
 *
 * NO HOOK CASE IN THIS CORPUS DELEGATES, and that is not an accident of the fixtures: all four
 * expect a refusal, so none reaches a worker, so the hook layer needs no server at all. Setting
 * `MOCK_WORKER_URL` to a syntactically valid address is enough to make `workerAvailability()`
 * report ready, because the gate refuses before anything dials it. One case deliberately omits the
 * variable to exercise `worker_not_ready`.
 *
 * A DISPATCH CASE IS NEVER CALLED ON A NON-DELEGATING DECISION. `dispatch()` would return
 * `status: 'skipped', reason: 'routing_declined'`, which looks enough like a real result that the
 * row would be stamped `task_type: 'bulk_read'` on what is actually a gate refusal. `hook/run.mjs`
 * branches before dispatch and so does this.
 */

import fsDefault from 'node:fs'
import path from 'node:path'

import { dispatch } from '../../plugins/model-router/lib/dispatch/index.mjs'
import { MODES } from '../../plugins/model-router/lib/dispatch/modes.mjs'
import { buildWorkerTask } from '../../plugins/model-router/lib/dispatch/task.mjs'
import { normalizeTaskIntent } from '../../plugins/model-router/lib/hook/adapter.mjs'
import { decide } from '../../plugins/model-router/lib/routing.mjs'
import { readStdin, runHookProcess, writeEditTranscript } from '../helpers/hook-payload.mjs'
import { summarizeSamples } from '../helpers/timing.mjs'
import { EVAL_ARMS, EVAL_VARIANTS, evalConfig } from './config.mjs'
import { evaluateQuality } from './evaluators.mjs'
import { compareDecision, toRoutingInputForCase } from './routing.mjs'

const FIXTURE_WORKER_URL = 'http://fixture.invalid'

/* ------------------------------------------------------------------ decide layer */

export function runDecideCase({ caseDef, absPaths, projectDir, config }) {
  const input = toRoutingInputForCase({ caseDef, absPaths, projectDir })
  const started = process.hrtime.bigint()
  const decision = decide(input, config)
  const routingDecisionMs = Number(process.hrtime.bigint() - started) / 1e6

  return {
    caseDef,
    layer: 'decide',
    input,
    config,
    decision,
    result: null,
    output: null,
    corpusChars: null,
    hookStdout: null,
    hookExitCode: null,
    hookStderr: null,
    hookSignal: null,
    hookOutcome: null,
    timings: { routing_decision: routingDecisionMs },
    ...compareDecision(caseDef, decision),
  }
}

/* -------------------------------------------------------------------- hook layer */

/**
 * Drive the real hook child process.
 *
 * The child's environment REPLACES the developer's, via `runHookProcess`, so a real `GEMINI_API_KEY`
 * or a personal `~/.claude/model-router/config.json` cannot change a benchmark number. `HOME` and
 * `USERPROFILE` point at the scratch directory for the same reason.
 *
 * The hook's own `decide()` call is re-run in process afterwards, purely to record the decision the
 * row needs. The child's exit code and stdout are what the expectation is checked against.
 */
export async function runHookCase({ caseDef, absPaths, projectDir, config, arm = EVAL_ARMS.mock, fs = fsDefault }) {
  const filePath = absPaths.get(caseDef.files[0]?.path)
  const transcriptMode = caseDef.metadata?.transcript ?? 'empty'
  const workerMode = caseDef.metadata?.worker ?? 'present'

  const transcript = path.join(projectDir, caseDef.id, 'transcript.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  if (transcriptMode === 'edit') writeEditTranscript(transcript, filePath)
  else if (transcriptMode !== 'absent') fs.writeFileSync(transcript, '', 'utf8')

  // The hook child is configured by environment, because it calls `loadConfig()` itself. Every hook
  // case in the corpus refuses before dispatch, so no worker is ever dialled — a syntactically
  // valid URL is enough to make `workerAvailability()` report ready. One case omits it deliberately.
  const env = {
    CMR_WORKER_PROVIDER: arm.overrides.worker.provider,
    CMR_WORKER_API_KEY_ENV: arm.overrides.worker.apiKeyEnv,
    CMR_TELEMETRY_ENABLED: '0',
    CLAUDE_PROJECT_DIR: projectDir,
    HOME: projectDir,
    USERPROFILE: projectDir,
    ...(workerMode === 'absent' ? {} : { MOCK_WORKER_URL: FIXTURE_WORKER_URL, ...arm.env }),
  }

  const stdin = readStdin({
    cwd: projectDir,
    tool_input: { file_path: filePath },
    ...(transcriptMode === 'absent' ? { transcript_path: path.join(projectDir, 'no-such-transcript.jsonl') } : { transcript_path: transcript }),
  })

  const started = process.hrtime.bigint()
  const child = await runHookProcess(stdin, env)
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6

  // The decision the row records. The child computed its own; this reproduces it in process so the
  // metrics row has a decision object, and the facts that only the hook can measure are supplied
  // explicitly rather than guessed.
  const input = toRoutingInputForCase({
    caseDef,
    absPaths,
    projectDir,
    workerAvailable: workerMode !== 'absent',
  })
  if (transcriptMode === 'edit' || transcriptMode === 'absent') input.recentlyEdited = true
  const decision = decide(input, config)

  // Empty stdout means the hook declined to intervene, which is the protocol's way of saying
  // "behave as if no hook were installed".
  const intervened = child.stdout.trim() !== ''
  const hookOutcome = intervened ? 'delegated' : 'not_delegated'

  return {
    caseDef,
    layer: 'hook',
    input,
    config,
    decision,
    result: null,
    output: null,
    corpusChars: null,
    hookStdout: child.stdout,
    hookExitCode: child.code,
    hookStderr: child.stderr,
    hookSignal: child.signal,
    hookOutcome,
    timings: { total_delegated_path: totalMs, hook_startup: totalMs },
    ...compareDecision(caseDef, decision),
  }
}

/* ---------------------------------------------------------------- dispatch layer */

export async function runDispatchCase({
  caseDef,
  contents,
  absPaths,
  projectDir,
  fixture,
  arm = EVAL_ARMS.mock,
  variant = EVAL_VARIANTS.generic,
}) {
  // The arm decides the provider AND the transport, and the two must agree. On the deterministic
  // arm the mock provider is pointed at this case's fixture URL and an injected `fetchImpl` answers
  // it; on a live arm the real provider talks to the real endpoint and no fetch is injected.
  //
  // Threading the arm here is load-bearing rather than tidy: an earlier draft accepted `--arm
  // ollama`, relabelled the report "model-dependent", and went on running the fixture. A report
  // that misnames what produced it is worse than no report.
  const config = evalConfig(
    { ...arm.overrides, ...caseDef.config },
    arm.deterministic
      ? { projectDir, providers: { mock: { baseUrl: fixture.baseUrlFor(caseDef.id) } } }
      : { projectDir },
  )

  const input = toRoutingInputForCase({ caseDef, absPaths, projectDir })
  const started = process.hrtime.bigint()
  const decision = decide(input, config)
  const routingDecisionMs = Number(process.hrtime.bigint() - started) / 1e6

  // Re-read from disk rather than reuse the loader's cached text, because the cost being measured
  // is what the hook pays on the hot path: `readTextContent` opens and reads the file every time.
  const loadStarted = process.hrtime.bigint()
  const files = caseDef.files.map((f) => ({
    path: f.path,
    content: absPaths.has(f.path) ? fsDefault.readFileSync(absPaths.get(f.path), 'utf8') : (contents.get(f.path) ?? ''),
  }))
  const fileLoadMs = Number(process.hrtime.bigint() - loadStarted) / 1e6
  const corpusChars = files.reduce((sum, f) => sum + f.content.length, 0)

  /*
   * The worker's task, built by the SHIPPED builder in both variants.
   *
   * `generic` passes no intent, so `buildWorkerTask` is an identity and the request is the
   * `{files, task}` this layer has always sent — byte for byte, which is what keeps the default
   * run's golden artifact comparable with every run before this dimension existed.
   *
   * `intent` passes the case's declared intent, or the case's own task when it declared none. The
   * sentence is therefore identical across variants and only the requirements block differs,
   * which is the single variable this comparison is allowed to move.
   */
  const taskIntent = variant.intentAware
    ? normalizeTaskIntent(caseDef.taskIntent ?? { task: caseDef.task })
    : null
  const workerInput = buildWorkerTask({
    toolContext: { baseTask: caseDef.task, lane: 'bulkRead' },
    files,
    taskIntent,
  })

  // The bytes that would actually be sent, measured through the real mode builder so the gates see
  // the same prompt the provider does.
  const built = MODES['bulk-reader'].build(workerInput)

  let result = null
  if (decision.delegate === true && decision.decision === 'deny') {
    result = await dispatch({
      decision,
      config,
      input: workerInput,
      env: { MOCK_WORKER_URL: FIXTURE_WORKER_URL, ...arm.env },
      // Omitted entirely on a live arm, so the real provider uses the real fetch.
      ...(arm.deterministic ? { fetchImpl: fixture.fetchImpl } : {}),
    })
  }

  return {
    caseDef,
    layer: 'dispatch',
    input,
    config,
    decision,
    result,
    output: result?.text ?? null,
    corpusChars: result === null ? null : corpusChars,
    prompt: built.prompt,
    system: built.system,
    variant: variant.id,
    // Recorded, never derived into a ratio. A real measurement of what each construction sends.
    promptChars: built.prompt.length,
    taskIntentSource: taskIntent === null ? 'none' : 'other',
    hookStdout: null,
    hookExitCode: null,
    hookStderr: null,
    hookSignal: null,
    hookOutcome: null,
    timings: {
      routing_decision: routingDecisionMs,
      file_load: fileLoadMs,
      worker: result?.latencyMs ?? null,
      provider: result?.providerLatencyMs ?? null,
    },
    ...compareDecision(caseDef, decision),
  }
}

/* ----------------------------------------------------------------- the dispatcher */

export async function runCase({
  caseDef,
  contents,
  absPaths,
  projectDir,
  fixture,
  arm = EVAL_ARMS.mock,
  variant = EVAL_VARIANTS.generic,
  fs = fsDefault,
}) {
  const config = evalConfig({ ...arm.overrides, ...caseDef.config }, { projectDir })

  if (caseDef.harness === 'decide') {
    return runDecideCase({ caseDef, absPaths, projectDir, config })
  }
  if (caseDef.harness === 'hook') {
    return runHookCase({ caseDef, absPaths, projectDir, config, arm, fs })
  }
  return runDispatchCase({ caseDef, contents, absPaths, projectDir, fixture, arm, variant })
}

/**
 * Grade a case and attach the verdict.
 *
 * Quality is `null` for every non-dispatch case, because those declare no criteria — not because
 * they failed. `verdictMap` omits nulls entirely, so an ungraded case contributes nothing to the
 * pass-rate denominator rather than contributing a zero.
 */
export function gradeCase(ran, contents) {
  const quality = evaluateQuality(ran.output, ran.caseDef.qualityCriteria, {
    case: ran.caseDef,
    files: contents.get(ran.caseDef.id) ?? new Map(),
  })
  return { ...ran, quality }
}

export function verdictMap(graded) {
  const out = new Map()
  for (const g of graded) {
    if (g.quality.quality === true) out.set(g.caseDef.id, 'pass')
    else if (g.quality.quality === false) out.set(g.caseDef.id, 'fail')
    // null is omitted on purpose: it is not a verdict.
  }
  return out
}

/**
 * The seven latency series, each summarised separately and NEVER SUMMED.
 *
 * Two of them overlap by construction — `total_delegated_path` contains `worker`, which contains
 * `provider` — so a total would double-count. `primary_path_overhead` is what every Read pays even
 * when nothing is delegated, which is the only latency figure the primary arm genuinely owns.
 */
export function latencySeries(ran) {
  const bucket = new Map()
  for (const r of ran) {
    for (const [name, value] of Object.entries(r.timings ?? {})) {
      if (!bucket.has(name)) bucket.set(name, [])
      bucket.get(name).push(value)
    }
  }
  // A refusing hook case measures exactly the overhead the primary path pays, so it is filed under
  // its own name rather than borrowed from `total_delegated_path`.
  const refusing = ran.filter((r) => r.layer === 'hook' && r.decision.delegate === false)
  if (refusing.length > 0) {
    bucket.set('primary_path_overhead', refusing.map((r) => r.timings?.total_delegated_path ?? null))
  }

  const out = {}
  for (const [name, samples] of bucket) out[name] = summarizeSamples(samples)
  return out
}

/**
 * Did every real hook child exit the way the contract promises?
 *
 * REPORTED AS WELL AS GATED, because a gate only speaks when it fails. Without the clean-exit
 * count, "no gate failed" is indistinguishable from "no hook case ran" — which is what `--case`
 * filtering to a decide case produces — and the crash this exists for showed up twice in eight
 * runs. A green run has to be positive evidence, not silence, or an intermittent fault has no
 * history to be intermittent against.
 *
 * The denominator travels with the numbers for the same reason `not_applicable` is a real gate
 * status: a count without its population is not information.
 */
export function hookProcessHealth(ran) {
  let hookCases = 0
  let exitedZero = 0
  let emptyStderr = 0
  const incidents = []

  for (const r of ran) {
    if (r.layer !== 'hook') continue
    hookCases += 1

    const clean = r.hookExitCode === 0
    const quiet = r.hookStderr === ''
    if (clean) exitedZero += 1
    if (quiet) emptyStderr += 1
    if (clean && quiet) continue

    incidents.push({
      id: r.caseDef.id,
      code: r.hookExitCode,
      signal: r.hookSignal,
      stderrBytes: typeof r.hookStderr === 'string' ? Buffer.byteLength(r.hookStderr, 'utf8') : null,
    })
  }

  return { hookCases, exitedZero, emptyStderr, incidents }
}
