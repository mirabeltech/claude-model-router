/**
 * The benchmark runner.
 *
 * Run: node test/evals/bin/run.mjs [--arm mock|ollama] [--sweep] [--case <id>] [--priced]
 *                                  [--variant generic|intent] [--ab]
 *                                  [--json <dir>] [--seed <text>] [--no-color] [--quiet]
 *
 * The default run is OFFLINE AND KEYLESS: the `mock` provider with an injected `fetchImpl`, no
 * socket, no API key, no network egress. It is reproducible, so it can gate. `--arm ollama` runs a
 * real local model and the report labels every number model-dependent.
 *
 * ARGUMENT PARSING FOLLOWS THE HOUSE PATTERN — the hand-rolled `flag`/`opt` pair from
 * `doctor.mjs` and `smoke-hook.mjs`, no dependency.
 *
 * THREE ARTIFACTS, because a byte-comparable golden and a real latency series cannot both live in
 * one file:
 *
 *   rows.jsonl    every field of every row. Recorded, never diffed.
 *   stable.jsonl  the projection, omitting the machine-local and genuinely-timed fields. THE
 *                 golden: two runs on any platform must match byte for byte.
 *   report.json   routing, quality, metrics, gates, sweep, latency and provenance, nulls preserved.
 *
 * `--ab` RUNS THE CORPUS TWICE, once per worker-task construction, and reports the two side by
 * side. Each variant is a full independent pass — its own rows, verdicts, metrics and gates —
 * because every one of those keys on the bare case id, and interleaving two variants into one
 * pass would silently keep whichever wrote last. The first variant's results stay in the usual
 * top-level report fields, so a default run's artifacts are unchanged.
 *
 * WHAT THE A/B TABLE MAY AND MAY NOT SAY. It reports each variant's measurements beside each
 * other and computes NO delta, ratio or percentage between them. On the deterministic arm both
 * variants are served the same authored answer, so their quality is identical by construction
 * and says nothing about either construction — see docs/benchmark-methodology.md. Prompt size
 * and token counts are real on every arm; quality is only real on a live one.
 *
 * Exit code is 1 if any case disagreed with its expectation or any non-advisory gate failed, in
 * any variant. Advisories never affect it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CALC_VERSION, ROUTER_VERSION, SCHEMA_VERSION } from '../../../plugins/model-router/lib/telemetry/record.mjs'
import { CONFIG_VERSION } from '../../../plugins/model-router/lib/config.mjs'
import { POLICY_VERSION } from '../../../plugins/model-router/lib/routing-policy.mjs'
import { PROMPT_VERSION } from '../../../plugins/model-router/lib/dispatch/modes.mjs'

import { EVAL_ARMS, EVAL_VARIANTS } from '../config.mjs'
import { buildProvenance, EVAL_NOW, stableLine } from '../determinism.mjs'
import { makeFixtureWorker, loadAnswers } from '../fixture-worker.mjs'
import { gradeCase, latencySeries, runCase, verdictMap } from '../harness.mjs'
import { runGates, snapshotDir } from '../gates.mjs'
import { CORPUS_DIR, loadCorpus } from '../load.mjs'
import { buildComparison } from '../metrics.mjs'
import { EVAL_SCHEMA_VERSION } from '../schema.mjs'
import { EVAL_CHAIN_BUNDLED, evalPricedChain, EVAL_PRIMARY_MODEL } from '../pricing.mjs'
import { renderReport } from '../report.mjs'
import { confusionTable } from '../routing.mjs'
import { buildEvalRow } from '../row.mjs'
import { DEFAULT_THRESHOLDS, SWEEP_KNOBS, sweep, sweepKnobs } from '../sweep.mjs'

/* ------------------------------------------------------------------- arguments */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--') ? dflt : argv[i + 1]
}

const armId = opt('arm', 'mock')
const arm = EVAL_ARMS[armId]
if (arm === undefined) {
  console.error(`unknown arm "${armId}"; known arms: ${Object.keys(EVAL_ARMS).join(', ')}`)
  process.exit(2)
}

const wantAb = flag('ab')
const variantId = opt('variant', null)
if (variantId !== null && EVAL_VARIANTS[variantId] === undefined) {
  console.error(`unknown variant "${variantId}"; known variants: ${Object.keys(EVAL_VARIANTS).join(', ')}`)
  process.exit(2)
}
// `--ab` means both, in the frozen declaration order so `generic` is always the primary pass and
// its rows always land first in the artifacts.
const variants = wantAb
  ? Object.values(EVAL_VARIANTS)
  : [variantId === null ? EVAL_VARIANTS.generic : EVAL_VARIANTS[variantId]]

const only = opt('case', null)
const runSeed = opt('seed', 'phase-6')
const outDir = opt('json', null)
const wantSweep = flag('sweep')
const priced = flag('priced')
const quiet = flag('quiet')
const color = !flag('no-color')

/* ----------------------------------------------------------------------- setup */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'router-evals-'))
let exitCode = 0

try {
  const loaded = loadCorpus({ scratchDir: scratch })
  if (loaded.errors.length > 0) {
    console.error('the corpus does not load cleanly:')
    for (const e of loaded.errors) console.error(`  ${e}`)
    process.exit(1)
  }

  const cases = only === null ? loaded.cases : loaded.cases.filter((c) => c.id === only)
  if (cases.length === 0) {
    console.error(only === null ? 'the corpus is empty' : `no case with id "${only}"`)
    process.exit(2)
  }

  const { answers, errors: answerErrors } = loadAnswers(cases, CORPUS_DIR, { fs, path })
  if (answerErrors.length > 0) {
    console.error('missing canned answers:')
    for (const e of answerErrors) console.error(`  ${e}`)
    process.exit(1)
  }

  // Pricing. The BUNDLED chain is the default because it is what a user actually gets, and it
  // reports every monetary field as unavailable — the shipped reality, faithfully reproduced.
  // `--priced` substitutes an obviously-synthetic fixture table to prove the money path computes.
  const pricingChain = priced ? evalPricedChain() : EVAL_CHAIN_BUNDLED
  const primaryModel = priced ? EVAL_PRIMARY_MODEL : null

  const fixture = makeFixtureWorker(answers)

  // The witness for `corpus_unmodified_by_the_run`, taken before anything runs.
  const dirBefore = snapshotDir(CORPUS_DIR)

  /* --------------------------------------------------------------------- run */

  /**
   * One complete pass over the corpus for one worker-task construction.
   *
   * Everything downstream of `ran` keys on the bare case id — `verdictMap`, the quality
   * extractor, the confusion table — so a pass is the unit of isolation. Two variants sharing one
   * pass would have the second overwrite the first's verdict and nothing would say so.
   */
  const pass = async (variant) => {
    const ran = []
    for (const caseDef of cases) {
      const result = await runCase({
        caseDef,
        contents: loaded.contents.get(caseDef.id) ?? new Map(),
        absPaths: loaded.absPaths.get(caseDef.id) ?? new Map(),
        projectDir: scratch,
        fixture,
        arm,
        variant,
      })
      ran.push(gradeCase(result, loaded.contents))
    }

    const rows = ran.map((r) =>
      buildEvalRow({
        caseDef: r.caseDef,
        decision: r.decision,
        result: r.result,
        config: primaryModel === null ? r.config : { ...r.config, telemetry: { ...r.config.telemetry, primaryModel } },
        pricingChain,
        corpusChars: r.corpusChars,
        inputBytes: r.input.inputBytes,
        taskIntentSource: r.taskIntentSource === undefined ? null : r.taskIntentSource,
        now: EVAL_NOW,
        runSeed,
        // Empty for `generic`, so its rows are byte-identical to the rows this runner produced
        // before the dimension existed and the golden keeps its meaning.
        eventIdSuffix: variant.eventIdSuffix,
      }),
    )

    const verdicts = verdictMap(ran)
    const latency = latencySeries(ran)
    const metrics = buildComparison({ rows, verdicts, latency })
    const routing = confusionTable(
      ran.map((r) => ({ caseDef: r.caseDef, decision: r.decision, agrees: r.agrees, mismatches: r.mismatches })),
    )

    return { variant, ran, rows, verdicts, latency, metrics, routing }
  }

  const passes = []
  for (const variant of variants) passes.push(await pass(variant))

  // The primary pass populates the usual top-level report fields, so a default run's report and
  // artifacts are shaped exactly as before.
  const primary = passes[0]
  const { ran, rows, verdicts, latency, metrics, routing } = primary

  const dirAfter = snapshotDir(CORPUS_DIR)

  /* ------------------------------------------------------------------ gates */

  /** Gates run per pass: a leak in one construction must not be averaged away by the other. */
  const gatesFor = (p) =>
    runGates({
      cases: p.ran.map((r, i) => ({
        caseDef: r.caseDef,
        artifacts: {
          row: p.rows[i],
          output: r.output,
          prompt: r.prompt ?? null,
          system: r.system ?? null,
          hookStdout: r.hookStdout,
          quality: r.quality,
          files: loaded.contents.get(r.caseDef.id) ?? new Map(),
          routingInput: r.input,
          config: r.config,
        },
      })),
      run: { dirBefore, dirAfter, fs },
    })

  const gatesByVariant = passes.map((p) => ({ variant: p.variant.id, results: gatesFor(p) }))
  const gateResults = gatesByVariant[0].results

  /* ------------------------------------------------------------------ sweep */

  // Assembled once and shared by both sweeps: the worker already ran, and a ROUTING knob changes
  // only what decide() answers about the same bytes.
  const sweepCached = wantSweep
    ? ran
        .filter((r) => r.layer !== 'hook')
        .map((r) => ({
          caseDef: r.caseDef,
          routingInput: r.input,
          result: r.result,
          corpusChars: r.corpusChars,
          inputBytes: r.input.inputBytes,
          projectDir: scratch,
        }))
    : null

  const sweepTable = wantSweep
    ? sweep({
        cached: sweepCached,
        thresholds: DEFAULT_THRESHOLDS,
        verdicts,
        pricingChain,
        now: EVAL_NOW,
        runSeed,
      })
    : null

  // The other four knobs, swept independently. Reported alongside rather than merged into the
  // minBytes table, so the one richly measurable rule is not averaged in with four that are not.
  const knobTable = wantSweep
    ? sweepKnobs({
        cached: sweepCached,
        knobs: SWEEP_KNOBS,
        verdicts,
        pricingChain,
        now: EVAL_NOW,
        runSeed,
      })
    : null

  /* ----------------------------------------------------------------- report */

  const report = {
    provenance: buildProvenance({
      evalSchemaVersion: EVAL_SCHEMA_VERSION,
      corpusFingerprint: JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'corpus.json'), 'utf8')).fingerprint,
      corpusCases: cases.length,
      arm,
      config: rows[0] === undefined ? {} : { worker: { provider: rows[0].provider ?? arm.id, model: rows[0].model_requested } },
      pricingVersion: rows[0]?.pricing_version ?? null,
      pricingSource: rows[0]?.pricing_source ?? null,
      runSeed,
      startedAt: new Date().toISOString(),
      versions: {
        policyVersion: POLICY_VERSION,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSION,
        calcVersion: CALC_VERSION,
        configVersion: CONFIG_VERSION,
        routerVersion: ROUTER_VERSION,
      },
    }),
    routing,
    quality: {
      rate: metrics.quality,
      failures: ran
        .filter((r) => r.quality.quality === false)
        .map((r) => ({
          id: r.caseDef.id,
          failed: [...r.quality.failed],
          detail: r.quality.results.filter((x) => !x.pass).map((x) => `${x.kind}: missing ${x.missing.join(', ')}`),
        })),
      ungraded: ran.filter((r) => r.quality.quality === null).map((r) => ({ id: r.caseDef.id, reason: r.quality.reason })),
    },
    metrics,
    latency,
    gates: gateResults.gates,
    advisories: gateResults.advisories,
    sweep: sweepTable,
    knobSweep: knobTable,

    /**
     * The A/B block: each construction's own measurements, side by side, and NO comparison.
     *
     * There is deliberately no delta, ratio or "winner" field here, and not merely as a matter of
     * presentation. On the deterministic arm the fixture worker keys its canned answer off the
     * case id and not off the prompt, so BOTH variants receive the identical authored answer and
     * their quality is equal by construction. A quality delta computed from that would be an
     * artifact of the fixture, and authoring a second, better answer for the intent variant would
     * be worse — it would let whoever wrote it decide which construction wins.
     *
     * `qualityIsMeasured` says plainly which it is, derived from the arm rather than passed, so a
     * live run cannot be filed as offline or an offline run read as evidence about a model.
     */
    ab:
      passes.length < 2
        ? null
        : {
            qualityIsMeasured: !arm.deterministic,
            note: arm.deterministic
              ? 'Both variants were served the same authored answer, so quality is identical by construction and measures the evaluators, not the construction. Prompt size and token counts are real. Run --arm ollama for a quality comparison.'
              : 'Quality is measured against a live model and is model-dependent, not reproducible.',
            variants: passes.map((p) => ({
              variant: p.variant.id,
              intentAware: p.variant.intentAware,

              /**
               * PER CASE, lifted straight off the row. Nothing here is summed, averaged or
               * divided: every value is the measurement the shipped builder already stamped, and
               * a case that produced no measurement reports null rather than a zero that would
               * sum as "free". Reading two variants' tables side by side is the comparison; the
               * subtraction, if anyone wants one, is theirs to do and to justify.
               */
              cases: p.ran.map((r, i) => ({
                id: r.caseDef.id,
                delegated: p.rows[i].task_type === 'bulk_read',
                promptChars: r.promptChars === undefined ? null : r.promptChars,
                promptVersion: p.rows[i].prompt_version,
                taskIntentSource: p.rows[i].task_intent_source,
                workerInputTokens: p.rows[i].worker_input_tokens,
                workerOutputTokens: p.rows[i].worker_output_tokens,
                estimatedTokensAvoided: p.rows[i].estimated_tokens_avoided,
                costStatus: p.rows[i].worker_total_cost_status,
                status: p.rows[i].status,
                errorCode: p.rows[i].error_code,
                // Phase 8. On a live arm the window is the difference between a case that ran
                // and a case that was refused, and `requestedInputTokens` against
                // `effectiveInputCapacity` is what makes a refusal legible without opening
                // rows.jsonl. `truncationDetected` is the one that must never be averaged: a
                // single `true` invalidates the answer it accompanies.
                contextTokens: p.rows[i].worker_context_tokens,
                contextStatus: p.rows[i].worker_context_status,
                requestedInputTokens: p.rows[i].worker_requested_input_tokens,
                effectiveInputCapacity: p.rows[i].worker_effective_input_capacity,
                observedPromptTokens: p.rows[i].worker_observed_prompt_tokens,
                truncationDetected: p.rows[i].worker_input_truncation_detected,
                quality: r.quality.quality,
                qualityReason: r.quality.reason,
                failed: [...r.quality.failed],
              })),

              // The shipped aggregates, passed through untouched so the null semantics and the
              // coverage/basis/bound fields travel with the number.
              quality: p.metrics.quality,
              workerTokens: p.metrics.workerArm.workerTokens,
              tokensAvoided: p.metrics.workerArm.tokensAvoided,
              cost: p.metrics.workerArm.cost,
              statusCounts: p.metrics.statusCounts,
              latency: p.latency,
              routingDisagreements: p.routing.disagreements,
              gateFailures: gatesByVariant.find((g) => g.variant === p.variant.id).results.failures,
            })),
          },
  }

  if (!quiet) console.log(renderReport(report, { color }))

  /* --------------------------------------------------------------- artifacts */

  if (outDir !== null) {
    fs.mkdirSync(outDir, { recursive: true })
    // Every pass's rows, in variant order. With one variant this is exactly what it always was.
    const allRows = passes.flatMap((p) => p.rows)
    fs.writeFileSync(path.join(outDir, 'rows.jsonl'), allRows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')
    fs.writeFileSync(path.join(outDir, 'stable.jsonl'), allRows.map(stableLine).join(''), 'utf8')
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, jsonReplacer, 2) + '\n', 'utf8')
    fs.writeFileSync(
      path.join(outDir, 'timings.json'),
      JSON.stringify({ deterministic: false, note: 'machine-dependent; never compared, never summed across series', series: latency }, null, 2) + '\n',
      'utf8',
    )
    if (!quiet) console.log(`\nartifacts written to ${outDir}`)
  }

  // Any variant. A disagreement or a gate failure in the second pass is still a failure, and
  // reading only the primary pass would make `--ab` the cheapest way to hide one.
  for (const p of passes) {
    if (p.routing.disagreements.length > 0) exitCode = 1
  }
  for (const g of gatesByVariant) {
    if (g.results.failures.length > 0) exitCode = 1
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

process.exit(exitCode)

/**
 * Maps become objects and undefined becomes null.
 *
 * `JSON.stringify` DROPS an undefined value, which would make a field absent rather than null —
 * and `record.mjs` is explicit that absent and null are not two ways of saying the same thing.
 */
function jsonReplacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value)
  return value === undefined ? null : value
}
