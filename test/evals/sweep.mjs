/**
 * The threshold sweep.
 *
 * PURE given the cached per-case worker results. It mutates no config, reads no config file, and
 * exports no notion of "better".
 *
 * THE SELECTION BIAS THIS FILE EXISTS TO AVOID. The obvious implementation runs the worker once per
 * case and then, for each threshold, FILTERS to the rows that delegated. That is wrong in a way
 * that flatters the system: as the threshold rises, fewer and larger cases delegate, so
 * avoided-tokens-per-delegation climbs monotonically and the table reads as "higher is better" —
 * an endorsement manufactured out of nothing but a shrinking denominator.
 *
 * So `rowsTotal` is the FULL CASE SET at every threshold. A case that does not delegate at a given
 * threshold is present as a gate row contributing `null`, which is what it actually is. `coverage`
 * then falls as the threshold rises and `formatAgg` prints
 *
 *     at least 184203 tokens over 9 of 21 events, 12 unmeasured
 *
 * which structurally cannot be read as a recommendation.
 *
 * THE WORKER STILL RUNS ONCE PER CASE. Its output does not depend on `minBytes`, so re-calling it
 * per threshold would burn time and, on the live arm, money, for identical answers. Only the ROW is
 * re-synthesised, and `buildEvent` is pure, so that is cheap.
 *
 * THERE IS DELIBERATELY NO `bestThreshold()`. Not a comment saying not to use one — the absence of
 * the function is the enforcement, and `evals.sweep.test.mjs` asserts the module exports no such
 * thing. Choosing a production threshold is a policy act that belongs to a human reading this
 * table, which is why the output carries `selectedThreshold: null` and `recommended: null`
 * literally rather than leaving the fields out.
 */

import { decide } from '../../plugins/model-router/lib/routing.mjs'
import { evalConfig } from './config.mjs'
import { aggregate, countBy, formatAgg, passRate, qualityExtractor } from './metrics.mjs'
import { buildEvalRow } from './row.mjs'

/**
 * The thresholds the sweep walks, in bytes.
 *
 * Chosen around the one live size rule rather than on round numbers. `minBytes` ships at 12 000 and
 * is compared with `>=`, so the three values that actually discriminate are 11999, 12000 and 12001;
 * 1 KB anchors "far below", and 24 KB and 50 KB show what happens when the floor rises past most of
 * the corpus. The brief's 1/4/8 KB points are dropped because no rule sits between them — they
 * would produce three identical rows and suggest a resolution the measurement does not have.
 */
export const DEFAULT_THRESHOLDS = Object.freeze([1024, 11999, 12000, 12001, 24576, 51200])

/**
 * Walk the thresholds.
 *
 * @param {object} a
 * @param {Array<object>} a.cached   one entry per case: {caseDef, routingInput, result, corpusChars,
 *                                   inputBytes, absPaths}
 * @param {ReadonlyArray<number>} a.thresholds
 * @param {Map<string,'pass'|'fail'>} a.verdicts
 * @param {Array} a.pricingChain
 * @param {number} a.now
 * @param {string} a.runSeed
 * @returns {{thresholds: Array<object>, selectedThreshold: null, recommended: null}}
 */
export function sweep({ cached, thresholds = DEFAULT_THRESHOLDS, verdicts, pricingChain, now, runSeed }) {
  const points = thresholds.map((minBytes) => ({
    minBytes,
    ...sweepPoint({ cached, lane: { minBytes }, verdicts, pricingChain, now, runSeed, eventIdSuffix: `@${minBytes}` }),
  }))

  return {
    thresholds: points,
    // Written explicitly, not omitted. An absent field invites a reader to supply their own answer;
    // an explicit null says the framework declined to.
    selectedThreshold: null,
    recommended: null,
  }
}

/**
 * One sweep point: re-decide every case under one `routing.bulkRead` patch and re-synthesise the
 * rows. Extracted from `sweep()` so a second knob costs a table entry rather than a second copy
 * of the anti-selection-bias logic below.
 *
 * THE WORKER IS NOT RE-RUN, and that is sound for any ROUTING knob: a threshold changes what
 * `decide()` answers, never what the worker would have said about the same bytes.
 */
export function sweepPoint({ cached, lane, verdicts, pricingChain, now, runSeed, eventIdSuffix }) {
// A fresh config per point, built from DEFAULTS through the real resolver. The user's config is
  // never read and the base config is never mutated, so the points are independent.
  const rows = []
  const delegated = []
  const retained = []

  for (const entry of cached) {
    const config = evalConfig(
      { ...entry.caseDef.config, routing: { ...entry.caseDef.config?.routing, bulkRead: { ...entry.caseDef.config?.routing?.bulkRead, ...lane } } },
      { projectDir: entry.projectDir },
    )
    const decision = decide(entry.routingInput, config)
    const delegates = decision.delegate === true && decision.decision === 'deny'

    // Every case yields a row at every threshold. The non-delegating ones are gate rows whose
    // savings columns are null — present in the denominator, contributing nothing.
    const row = buildEvalRow({
      caseDef: entry.caseDef,
      decision,
      result: delegates ? entry.result : null,
      config,
      pricingChain,
      corpusChars: delegates ? entry.corpusChars : null,
      inputBytes: entry.inputBytes,
      now,
      runSeed,
      eventIdSuffix,
    })
    rows.push(row)
    ;(delegates ? delegated : retained).push(entry.caseDef.id)
  }

  // A verdict only counts at a threshold where the case actually delegated. The worker ran once,
  // but at a threshold that retains the case on the primary model NO ANSWER WOULD EXIST, so
  // carrying the verdict forward would credit a quality pass to a delegation that never happened
  // — and the pass rate would read the same at every threshold, which is exactly the kind of
  // number that cannot be wrong and therefore says nothing.
  const delegatedIds = new Set(delegated)
  const activeVerdicts = new Map([...verdicts].filter(([id]) => delegatedIds.has(id)))

  const tokensAvoided = aggregate(rows, (r) => ({
    value: r.estimated_tokens_avoided,
    status: r.estimated_tokens_avoided_status,
  }))
  const workerTotalCost = aggregate(rows, (r) => ({
    value: r.worker_total_cost,
    status: r.worker_total_cost_status,
  }))
  const netSavings = aggregate(rows, (r) => ({
    value: r.estimated_net_savings,
    status: r.estimated_net_savings_status,
  }))
  const qualityAgg = aggregate(rows, qualityExtractor(activeVerdicts))

  const latencies = rows
    .map((r) => r.latency_ms)
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b)

  return {
    rowsTotal: rows.length,
    delegatedCount: delegated.length,
    retainedCount: retained.length,
    delegated,
    retained,
    tokensAvoided,
    workerTotalCost,
    netSavings,
    quality: passRate(qualityAgg),
    // Cases whose NET token change is negative: the worker answer cost more context than the
    // corpus it replaced. These are the evidence a threshold is wrong, so they are listed by id
    // rather than counted.
    negativeSavings: rows
      .filter((r) => typeof r.estimated_tokens_avoided === 'number' && r.estimated_tokens_avoided < 0)
      .map((r) => negativeSavingsRow(r, verdicts)),
    costAvailability: {
      rowsCounted: workerTotalCost.rowsCounted,
      rowsUnavailable: workerTotalCost.rowsUnavailable,
      status: workerTotalCost.status,
    },
    latencyMs: {
      n: latencies.length,
      median: latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) / 2)],
      max: latencies.length === 0 ? null : latencies[latencies.length - 1],
    },
    byRoutingReason: Object.fromEntries(countBy(rows, (r) => r.routing_reason)),
}
}

/**
 * Render the sweep.
 *
 * One line per threshold, through `formatAgg` so coverage travels with every number, and no column
 * that compares two thresholds to each other. The closing note is part of the output, not a
 * comment: a table of thresholds with a blank space where the recommendation would go is an
 * invitation, so the absence is stated.
 */
export function renderSweep(table, { indent = '  ' } = {}) {
  const lines = []
  for (const p of table.thresholds) {
    lines.push(
      `${indent}minBytes=${String(p.minBytes).padStart(6)}  ` +
        `delegated ${String(p.delegatedCount).padStart(2)}/${p.rowsTotal}  ` +
        `tokens: ${formatAgg(p.tokensAvoided, { unit: 'tokens', places: 0 })}`,
    )
    lines.push(
      `${indent}${' '.repeat(14)}  quality ${p.quality.value === null ? 'unavailable' : `${p.quality.passed}/${p.quality.graded}`}  ` +
        `cost: ${p.costAvailability.status} (${p.costAvailability.rowsCounted} priced, ${p.costAvailability.rowsUnavailable} unpriced)  ` +
        `negative: ${p.negativeSavings.length}`,
    )
  }
  lines.push('')
  lines.push(`${indent}selectedThreshold: null — measurement only. Choosing a production threshold`)
  lines.push(`${indent}is a policy act, and this framework deliberately exports no notion of better.`)
  return lines.join('\n')
}

/* ------------------------------------------------------------ the other knobs */

/**
 * The routing knobs a sweep can walk, beyond `minBytes`.
 *
 * INDEPENDENT ONE-KNOB-AT-A-TIME SWEEPS, not a cartesian product. Five knobs crossed would be
 * combinatorially large and, given the corpus, nearly every cell would be a duplicate row — and a
 * product also makes each result unattributable to a single cause.
 *
 * `points` are chosen around the values that DISCRIMINATE, the same rule DEFAULT_THRESHOLDS
 * follows. Round numbers between two rules produce identical rows and imply a resolution the
 * measurement has not got.
 */
export const SWEEP_KNOBS = Object.freeze([
  Object.freeze({
    knob: 'minBytes',
    points: DEFAULT_THRESHOLDS,
    note: 'every case carries bytes, so this is the one richly measurable size rule',
  }),
  Object.freeze({
    knob: 'minLines',
    points: Object.freeze([1, 100, 350, 351, 800, 1000]),
    note: 'ships at 350; only cases that DECLARE routingInput.lineCount can respond',
  }),
  Object.freeze({
    knob: 'minEstimatedTokens',
    // null is the shipped value and means "this proxy is off", so it belongs in the walk.
    points: Object.freeze([null, 256, 1024, 3000, 12000]),
    note: 'ships null (off); requires routingInput.estimatedInputTokens, which the hook never supplies',
  }),
  Object.freeze({
    knob: 'maxFiles',
    points: Object.freeze([1, 2, 3, 25]),
    note: 'ships at 25; the corpus tops out at three files per case',
  }),
  Object.freeze({
    knob: 'minFiles',
    points: Object.freeze([1, 2, 3]),
    note: 'ships at 1; raising it refuses every single-file case at once',
  }),
])

/**
 * Walk each knob independently and report, FIRST, whether it could move anything at all.
 *
 * MEASURABILITY IS COMPUTED, NOT ASSERTED. A knob is measurable here when the set of delegating
 * cases actually changes across its points. The alternative — printing six numerically identical
 * rows and leaving the reader to notice — is how a sweep comes to imply a resolution it does not
 * have. `decide()` guards every size clause with `isKnown(x) && x >= t`, so a field no case
 * declares can never fire its rule, and the honest output for such a knob is a sentence rather
 * than a table.
 */
export function sweepKnobs({ cached, knobs = SWEEP_KNOBS, verdicts, pricingChain, now, runSeed }) {
  const out = []

  for (const spec of knobs) {
    const points = spec.points.map((value) => ({
      value,
      ...sweepPoint({
        cached,
        lane: { [spec.knob]: value },
        verdicts,
        pricingChain,
        now,
        runSeed,
        eventIdSuffix: `@${spec.knob}=${value}`,
      }),
    }))

    // The signature of a knob that cannot move: one identical delegating set at every point.
    const signatures = new Set(points.map((p) => p.delegated.join(',')))
    const movedCases = new Set()
    for (const p of points) for (const id of p.delegated) movedCases.add(id)
    const stable = new Set(points[0]?.delegated ?? [])
    const responsive = [...movedCases].filter((id) => points.some((p) => !p.delegated.includes(id)) && stable.size > 0)

    out.push({
      knob: spec.knob,
      note: spec.note,
      measurable: signatures.size > 1,
      distinctOutcomes: signatures.size,
      // Named, not counted: which cases a knob can actually move is the useful fact.
      responsiveCases: signatures.size > 1 ? responsive.sort() : [],
      points,
    })
  }

  return {
    knobs: out,
    // Same refusal as `sweep()`, restated per knob rather than weakened by being spread over five.
    selected: null,
    recommended: null,
  }
}

/**
 * One negative-savings case, with the attributes worth correlating against.
 *
 * Unclamped, and CORRELATION ONLY: nothing here changes a routing rule. A negative net means the
 * worker's answer cost more context than the corpus it replaced, which is evidence about a
 * threshold rather than an instruction about one.
 */
export function negativeSavingsRow(r, verdicts) {
  return {
    id: r.task_id,
    netTokens: r.estimated_tokens_avoided,
    // The two operands, so a reader can see WHICH side made it negative.
    corpusTokensAvoided: r.estimated_tokens_avoided_gross ?? null,
    returnedAnswerTokens: r.returned_answer_tokens ?? null,
    inputBytes: r.input_bytes ?? null,
    filesCount: r.files_count ?? null,
    workerOutputTokens: r.worker_output_tokens ?? null,
    workerInputTokens: r.worker_input_tokens ?? null,
    workerLatencyMs: r.latency_ms ?? null,
    routingReason: r.routing_reason ?? null,
    promptVersion: r.prompt_version ?? null,
    taskIntentSource: r.task_intent_source ?? null,
    // Phase 8 additions: a negative result on a truncated prompt is a different finding from a
    // negative result on a complete one.
    contextTokens: r.worker_context_tokens ?? null,
    contextStatus: r.worker_context_status ?? null,
    truncationDetected: r.worker_input_truncation_detected ?? null,
    quality: verdicts?.get?.(r.task_id) ?? null,
  }
}

/**
 * Render the knob sweep. Measurability first, because a table of numbers for a knob that cannot
 * move anything is worse than no table.
 */
export function renderKnobSweep(table, { indent = '  ' } = {}) {
  const lines = []
  for (const k of table.knobs) {
    lines.push(`${indent}${k.knob}`)
    if (!k.measurable) {
      lines.push(`${indent}  NOT MEASURABLE in this corpus — every point delegates the same cases.`)
      lines.push(`${indent}  ${k.note}`)
      lines.push('')
      continue
    }
    lines.push(`${indent}  measurable: ${k.responsiveCases.length} case(s) respond — ${k.responsiveCases.join(', ')}`)
    for (const p of k.points) {
      lines.push(
        `${indent}    ${k.knob}=${String(p.value).padStart(6)}  ` +
          `delegated ${String(p.delegatedCount).padStart(2)}/${p.rowsTotal}  ` +
          `tokens: ${formatAgg(p.tokensAvoided, { unit: 'tokens', places: 0 })}  ` +
          `negative: ${p.negativeSavings.length}`,
      )
    }
    lines.push('')
  }
  lines.push(`${indent}selected: null — measurement only, per knob. An objective function would`)
  lines.push(`${indent}need quality, cost and latency all available; cost is not.`)
  return lines.join('\n')
}
