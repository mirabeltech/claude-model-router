/**
 * Every section of the response except `segments`: the headline sums, the rates, the latency
 * series, the failure taxonomy, governance, capability and the delegation-value view.
 *
 * EACH AGGREGATE SLOT IS SCOPED TO A NAMED POPULATION, and that is the central design decision in
 * this file. A row is pushed into a slot only if it belongs to that slot's population, so the
 * slot's `rowsTotal` is the size of the population and its `coverage` means "of the rows where
 * this measurement COULD exist, how many did". The alternative — pushing every row into every
 * slot — makes every savings figure permanently `partial`, because `estimated_input_tokens` is
 * null on every `gate_block` row by construction. That number would be reporting the shape of the
 * schema rather than the quality of the data, and an operator would spend a long time looking for
 * a problem that was never there.
 *
 * THE FOUR CONDITIONS STAY APART. `failures` has separate counters for a worker failure, a
 * governance denial, a capability refusal and an unmeasurable cost, and no counter is derived by
 * subtracting another. There is deliberately NO total: a grand total over those four would be a
 * number whose only possible use is to be quoted, and every use of it would be wrong.
 *
 * BUDGET LIMITS ARE NEVER SUMMED. A limit is not a quantity consumed, so `budget_limit` is
 * reported as the latest observation per scope and nothing else. Adding ceilings across rows
 * produces a figure with no referent.
 */

import { extractors } from '../telemetry/aggregate.mjs'
import {
  aggFinalize,
  aggInit,
  aggPush,
  createCounters,
  createHistogram,
  createLatest,
  createSeries,
  createTopList,
  histogramFinalize,
  histogramPush,
  latestPush,
  seriesFinalize,
  seriesPush,
  topListFinalize,
  topListPush,
} from './aggregates.mjs'
import { classifyRow, emptyClassCounts, otherKindOf, predicates } from './predicates.mjs'
import {
  DEFAULT_LIMITS,
  EXAMPLE_FIELDS,
  HISTOGRAMS,
  NULL_BUCKET_KEY,
  ROW_CLASSES,
} from './schema.mjs'
import { serializeAgg, serializeCount, serializeRate, serializeUnavailable } from './serialize.mjs'
import { rowInstantMs } from './window.mjs'

/** `(row) => {value, status}` for a plain reported count with no paired status column. */
const reported = (field) => (row) => ({ value: row[field], status: 'actual' })

/** A sort key that ranks an unknown LAST rather than treating it as zero. */
const worstFirst = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY)

/**
 * How many rows fell in one histogram bucket.
 *
 * An absent key means the bucket is empty, which is a real count of zero rather than an
 * unmeasured quantity — the one reading in this file where defaulting to 0 is correct, named so
 * the `?? 0` rule can exempt it by name instead of by pattern.
 */
const bucketCount = (table, key) => (Object.hasOwn(table, key) ? table[key] : 0)

/** `(row) => {value, status}` for a column that carries its own `*_status`. */
const measured = (field) => (row) => ({ value: row[field], status: row[`${field}_status`] })

/**
 * Every aggregate in the response: its path, its extractor, and the population it covers.
 *
 * The path is the key into `DISPLAY_UNITS`, so adding a row here without adding a unit there
 * fails `serializeAgg` immediately rather than shipping an unlabelled number.
 */
export const AGG_SLOTS = Object.freeze([
  /* ---- summary: the four headline figures ---- */
  { path: 'summary.tokensAvoided', population: 'dispatchAttempted', extract: extractors.estimatedTokensAvoided },
  { path: 'summary.workerTokens', population: 'dispatchAttempted', extract: extractors.workerTokens },
  { path: 'summary.workerCost', population: 'dispatchAttempted', extract: extractors.workerTotalCost },
  { path: 'summary.netSavings', population: 'dispatchAttempted', extract: extractors.estimatedNetSavings },

  /* ---- worker usage ---- */
  { path: 'workerUsage.inputTokens', population: 'dispatchAttempted', extract: reported('worker_input_tokens') },
  { path: 'workerUsage.cachedInputTokens', population: 'dispatchAttempted', extract: reported('worker_cached_input_tokens') },
  { path: 'workerUsage.outputTokens', population: 'dispatchAttempted', extract: reported('worker_output_tokens') },
  { path: 'workerUsage.thoughtTokens', population: 'dispatchAttempted', extract: reported('worker_thought_tokens') },
  { path: 'workerUsage.billableOutputTokens', population: 'dispatchAttempted', extract: reported('worker_billable_output_tokens') },
  // Two totals, reported side by side and NEVER reconciled. `totalTokensSummed` is strict — a row
  // missing any component contributes nothing — and `totalTokensReported` is the provider's own
  // figure verbatim. Where both are complete and they disagree, that is a provider-parser bug,
  // and `worker_token_sum_check: 'mismatch'` on the offending rows locates it.
  { path: 'workerUsage.totalTokensSummed', population: 'dispatchAttempted', extract: extractors.workerTokens },
  { path: 'workerUsage.totalTokensReported', population: 'dispatchAttempted', extract: extractors.workerTokensReported },

  /* ---- savings ---- */
  { path: 'savings.estimatedInputTokens', population: 'dispatchAttempted', extract: reported('estimated_input_tokens') },
  { path: 'savings.returnedAnswerTokens', population: 'dispatchAttempted', extract: reported('returned_answer_tokens_estimated') },
  { path: 'savings.tokensAvoided', population: 'dispatchAttempted', extract: extractors.estimatedTokensAvoided },
  { path: 'savings.workerTokensConsumed', population: 'dispatchAttempted', extract: extractors.workerTokens },
  { path: 'savings.costAvoided', population: 'dispatchAttempted', extract: extractors.estimatedCostAvoided },
  { path: 'savings.netSavings', population: 'dispatchAttempted', extract: extractors.estimatedNetSavings },
  { path: 'savings.inputBytes', population: 'countable', extract: reported('input_bytes') },

  /* ---- cost ---- */
  { path: 'cost.workerInput', population: 'dispatchAttempted', extract: measured('worker_input_cost') },
  { path: 'cost.workerCachedInput', population: 'dispatchAttempted', extract: measured('worker_cached_input_cost') },
  { path: 'cost.workerOutput', population: 'dispatchAttempted', extract: measured('worker_output_cost') },
  { path: 'cost.workerTotal', population: 'dispatchAttempted', extract: extractors.workerTotalCost },
  // The primary columns are structurally unavailable today: `primary_usage_method` is `none` on
  // every row, so there is no measured baseline. Reported anyway, so the gap is visible as a
  // coverage of zero rather than as an absent section.
  { path: 'cost.primaryInput', population: 'countable', extract: measured('primary_input_cost') },
  { path: 'cost.primaryOutput', population: 'countable', extract: measured('primary_output_cost') },
  { path: 'cost.primaryTotal', population: 'countable', extract: measured('primary_total_cost') },

  /* ---- capability ---- */
  { path: 'capability.contextTokens', population: 'dispatchAttempted', extract: reported('worker_context_tokens') },
  { path: 'capability.effectiveInputCapacity', population: 'dispatchAttempted', extract: reported('worker_effective_input_capacity') },
  { path: 'capability.requestedInputTokens', population: 'dispatchAttempted', extract: reported('worker_requested_input_tokens') },
  { path: 'capability.observedPromptTokens', population: 'dispatchAttempted', extract: reported('worker_observed_prompt_tokens') },

  /* ---- governance ---- */
  // Reservation TOKENS are a quantity and may be summed. Budget LIMITS are not and never appear
  // in this list.
  { path: 'governance.reservationTokens', population: 'governanceConsulted', extract: reported('reservation_tokens') },

  /* ---- value: what the worker consumed that bought nothing ---- */
  { path: 'value.workerOverhead.cost', population: 'noUsableAnswer', extract: extractors.workerTotalCost },
  { path: 'value.workerOverhead.tokens', population: 'noUsableAnswer', extract: extractors.workerTokens },

  /* ---- negative savings: summed over only the negative rows ---- */
  { path: 'negativeSavings.tokens.total', population: 'negativeTokenRows', extract: extractors.estimatedTokensAvoided },
  { path: 'negativeSavings.dollars.total', population: 'negativeDollarRows', extract: extractors.estimatedNetSavings },
])

/** Population name -> the predicate that decides membership. */
const POPULATION_PREDICATES = Object.freeze({
  countable: predicates.countable,
  dispatchAttempted: predicates.dispatchAttempted,
  delegationOk: predicates.delegationOk,
  governanceConsulted: predicates.governanceConsulted,
  capabilityKnown: predicates.capabilityKnown,
  noUsableAnswer: predicates.noUsableAnswer,
  retryFreeDispatch: predicates.retryFreeDispatch,
  negativeTokenRows: predicates.negativeTokens,
  negativeDollarRows: predicates.negativeDollars,
  allRows: () => true,
  routingEvents: predicates.countable,
  answerDelivered: predicates.answerDelivered,
})

/** The counted conditions. Every one is reported even at zero, so an absence is visible. */
const COUNTER_NAMES = Object.freeze([
  'workerFailure',
  'governanceDenied',
  'governanceAllowed',
  'capabilityRefusal',
  'capabilityRefusalPreflight',
  'capabilityRefusalTruncationDiscarded',
  'unknownCost',
  'zeroCost',
  'knownCost',
  'usageReported',
  'usagePartial',
  'usageMissing',
  'tokenSumMismatch',
  'noUsableAnswer',
  'truncatedAnswer',
  'answerDelivered',
  'answerUnverifiedWindow',
  'retried',
  'retryCountUnknown',
  'negativeTokens',
  'negativeDollars',
  'capabilityUnknown',
  'governanceNotConsulted',
  'delegationOk',
  'dispatchAttempted',
  'countable',
])

export function createMetricState({ limits = DEFAULT_LIMITS } = {}) {
  const slots = new Map()
  for (const slot of AGG_SLOTS) slots.set(slot.path, aggInit(slot.path))

  const histograms = new Map()
  for (const path of Object.keys(HISTOGRAMS)) histograms.set(path, createHistogram())

  return {
    limits,
    classes: emptyClassCounts(),
    counters: createCounters(COUNTER_NAMES),
    slots,
    histograms,
    latency: {
      total: createSeries({ maxSamples: limits.maxLatencySamples, label: 'latency_ms' }),
      provider: createSeries({ maxSamples: limits.maxLatencySamples, label: 'provider_latency_ms' }),
      dispatchOverhead: createSeries({ maxSamples: limits.maxLatencySamples, label: 'derived' }),
      gateRowsExcluded: 0,
      overheadExcludedForRetry: 0,
      overheadExcludedForUnknownRetry: 0,
    },
    // The latest observation of each budget ceiling, by scope. Never a sum.
    budgets: new Map(),
    // PER FIELD, not one pooled counter. A single tally over every enum histogram would mix
    // `routing_reason` with `budget_scope` and report, under `routing`, an `other` that came from
    // a governance column. Measured before the fix: a null budget_scope inflated the routing
    // unknown-enum count on every row.
    otherKinds: new Map(),
    negativeExamples: createTopList({
      limit: limits.maxNegativeExamples,
      // Worst first, so the cap keeps the cases worth investigating rather than the earliest
      // ones in file order. Dollars lead because an unpriced store has none, in which case the
      // token delta is the only ordering available.
      //
      // AN UNKNOWN SORTS LAST, NOT AS ZERO. A row can be in this list for a negative token delta
      // while its cash net is unknown, and `?? 0` would have ranked that unknown between the
      // negative and positive dollar cases — placing it among the worst offenders on the
      // strength of a measurement nobody took. Infinity puts it at the end of the ordering,
      // where "we do not know" belongs.
      compare: (a, b) =>
        worstFirst(a.estimated_net_savings) - worstFirst(b.estimated_net_savings) ||
        worstFirst(a.estimated_tokens_avoided) - worstFirst(b.estimated_tokens_avoided) ||
        (a.event_id < b.event_id ? -1 : 1),
    }),
  }
}

export function pushMetrics(state, row) {
  const klass = classifyRow(row)
  state.classes[klass] += 1

  // Nothing below can be interpreted for a row whose schema this build does not know.
  if (klass === 'schemaIncompatible') return state

  for (const name of COUNTER_NAMES) {
    if (predicates[name](row)) state.counters[name] += 1
  }

  for (const slot of AGG_SLOTS) {
    if (POPULATION_PREDICATES[slot.population](row)) {
      aggPush(state.slots.get(slot.path), row, slot.extract)
    }
  }

  for (const [path, spec] of Object.entries(HISTOGRAMS)) {
    histogramPush(state.histograms.get(path), row[spec.field])
    if (spec.enum !== null) {
      const kind = otherKindOf(row, spec.field, spec.enum)
      if (kind !== null) {
        if (!state.otherKinds.has(spec.field)) {
          state.otherKinds.set(spec.field, { deliberate: 0, unknown_enum: 0, indeterminate: 0 })
        }
        state.otherKinds.get(spec.field)[kind] += 1
      }
    }
  }

  pushLatency(state.latency, row)

  if (predicates.governanceConsulted(row) && row.budget_scope !== null) {
    const scope = String(row.budget_scope)
    if (!state.budgets.has(scope)) {
      state.budgets.set(scope, { limit: createLatest(), remaining: createLatest(), status: createLatest() })
    }
    const ms = rowInstantMs(row)
    const entry = state.budgets.get(scope)
    latestPush(entry.limit, ms, row.budget_limit)
    latestPush(entry.remaining, ms, row.budget_remaining)
    latestPush(entry.status, ms, row.budget_measurement_status)
  }

  if (predicates.negativeTokens(row) || predicates.negativeDollars(row)) {
    const example = {}
    for (const field of EXAMPLE_FIELDS) example[field] = row[field] ?? null
    topListPush(state.negativeExamples, example)
  }

  return state
}

/**
 * Latency, including the one derived figure this layer is willing to compute.
 *
 * `dispatchOverheadMs = latency_ms - provider_latency_ms` IS ADMITTED ONLY WHEN
 * `retry_count === 0`, and the restriction is the whole reason the figure is trustworthy.
 * `provider_latency_ms` is documented as the HTTP round trip of the FINAL ATTEMPT ONLY, while
 * `latency_ms` covers payload assembly, every attempt and the parse. With a retry the difference
 * is dispatch overhead PLUS an unknown amount of earlier network time, so publishing it would be
 * inventing a number and labelling it a measurement.
 *
 * `retry_count === null` is excluded too, and counted separately. Excluding on an unknown is as
 * wrong as including on one, so the decision is reported rather than taken.
 */
function pushLatency(latency, row) {
  if (!predicates.dispatchAttempted(row)) {
    // Both latency columns are null on every gate_block row, by the explicit decision in
    // hook/event.mjs not to give `latency_ms` a second meaning. Counting those rows as
    // unmeasured would report a design choice as missing data.
    latency.gateRowsExcluded += 1
    return latency
  }

  seriesPush(latency.total, row.latency_ms)
  seriesPush(latency.provider, row.provider_latency_ms)

  if (typeof row.latency_ms !== 'number' || typeof row.provider_latency_ms !== 'number') return latency
  if (row.retry_count === null || row.retry_count === undefined) {
    latency.overheadExcludedForUnknownRetry += 1
    return latency
  }
  if (row.retry_count !== 0) {
    latency.overheadExcludedForRetry += 1
    return latency
  }
  seriesPush(latency.dispatchOverhead, row.latency_ms - row.provider_latency_ms)
  return latency
}

/* ------------------------------------------------------------------ finalize */

export function finalizeMetrics(state, { timeRange, gateDecisionsRecorded }) {
  const windowEmpty = !timeRange.valid || timeRange.empty
  const agg = (path) => {
    const slot = AGG_SLOTS.find((s) => s.path === path)
    return serializeAgg(aggFinalize(state.slots.get(path)), path, slot.population, { windowEmpty })
  }
  const hist = (path) => histogramFinalize(state.histograms.get(path), { nullKey: NULL_BUCKET_KEY })
  const c = state.counters
  const classes = state.classes
  const countable = c.countable

  // The routing-event denominator. Suppressing gate decisions does not make the rate wrong, it
  // makes it uncomputable: against delegations alone it would report 100%.
  const rate = (numerator, { population = 'countable', denominator = countable, complete = gateDecisionsRecorded } = {}) =>
    serializeRate(numerator, denominator, {
      population,
      denominatorComplete: complete,
      caveat: complete ? null : 'gate_rows_not_recorded',
    })

  const refusals = classes.gateRefused + classes.governanceDenied + classes.approvedNotDispatched

  return {
    summary: {
      events: serializeCount(countable, 'countable', { label: 'events' }),
      delegations: serializeCount(c.dispatchAttempted, 'dispatchAttempted', { label: 'dispatched' }),
      successes: serializeCount(c.delegationOk, 'delegationOk', { label: 'usable answers' }),
      refusals: serializeCount(refusals, 'countable', { label: 'refusals' }),
      delegationRate: rate(c.dispatchAttempted),
      tokensAvoided: agg('summary.tokensAvoided'),
      workerTokens: agg('summary.workerTokens'),
      workerCost: agg('summary.workerCost'),
      netSavings: agg('summary.netSavings'),
      costCoverage: coverageOf(state, 'summary.workerCost'),
      // What a reader can actually rely on in this window, stated once and plainly so a default
      // install is not mistaken for a broken one.
      headlineAvailable: c.knownCost === 0 ? 'tokens_only' : 'tokens_and_cost',
    },

    routing: {
      byClass: Object.fromEntries(ROW_CLASSES.map((k) => [k, classes[k]])),
      counts: {
        routingEvents: serializeCount(countable, 'routingEvents', { label: 'events' }),
        dispatchAttempted: serializeCount(c.dispatchAttempted, 'dispatchAttempted'),
        gateRefused: serializeCount(classes.gateRefused, 'countable'),
        governanceDenied: serializeCount(classes.governanceDenied, 'countable'),
        // The gate approved, governance approved, and nothing was dispatched. `content_binary`
        // and `content_unreadable` land here and NOTHING ON THE ROW SAYS SO.
        approvedNotDispatched: serializeCount(classes.approvedNotDispatched, 'countable'),
        delegationOk: serializeCount(classes.delegationOk, 'dispatchAttempted'),
        delegationError: serializeCount(classes.delegationError, 'dispatchAttempted'),
        delegationSkipped: serializeCount(classes.delegationSkipped, 'dispatchAttempted'),
      },
      approvedNotDispatchedAmbiguous: {
        ambiguous: true,
        count: classes.approvedNotDispatched,
        detail:
          'The gate approved, governance did not deny, and no worker call was attempted. `content_unreadable` and `content_binary` produce this row, but `error_code` is null and no routing_reason names them, so the cause is not recoverable from telemetry. A schema gap, reported rather than guessed.',
      },
      delegationRate: rate(c.dispatchAttempted),
      refusalRate: rate(refusals),
      successRate: serializeRate(c.delegationOk, c.dispatchAttempted, { population: 'dispatchAttempted' }),
      byDecision: hist('routing.byDecision'),
      byReason: hist('routing.byReason'),
      byTaskType: hist('routing.byTaskType'),
      byIntentSource: hist('routing.byIntentSource'),
      // `other` on a row is ambiguous between a deliberate `other` and an unknown value that
      // bucketed to it, and `validation_codes` separates them only when it names the field.
      // Keyed BY FIELD, so a count can never pool two unrelated columns.
      otherKinds: otherKindsFor(state, ['routing_decision', 'routing_reason', 'task_type', 'task_intent_source']),
    },

    workerUsage: {
      calls: serializeCount(c.dispatchAttempted, 'dispatchAttempted'),
      successful: serializeCount(c.delegationOk, 'dispatchAttempted'),
      failed: serializeCount(c.workerFailure, 'dispatchAttempted'),
      usageReported: serializeCount(c.usageReported, 'dispatchAttempted'),
      usagePartial: serializeCount(c.usagePartial, 'dispatchAttempted'),
      usageMissing: serializeCount(c.usageMissing, 'dispatchAttempted'),
      tokenSumMismatch: serializeCount(c.tokenSumMismatch, 'dispatchAttempted'),
      inputTokens: agg('workerUsage.inputTokens'),
      cachedInputTokens: agg('workerUsage.cachedInputTokens'),
      outputTokens: agg('workerUsage.outputTokens'),
      thoughtTokens: agg('workerUsage.thoughtTokens'),
      billableOutputTokens: agg('workerUsage.billableOutputTokens'),
      totalTokensSummed: agg('workerUsage.totalTokensSummed'),
      totalTokensReported: agg('workerUsage.totalTokensReported'),
      reconciliationNote:
        'The summed and reported totals are never reconciled. Where both are complete and they disagree, worker_token_sum_check names the rows.',
    },

    savings: {
      methodology: 'docs/savings-methodology.md',
      population: 'dispatchAttempted',
      populationNote:
        'Savings columns are null on every gate_block row by construction, because the corpus is only measured once content has been read. Aggregating them over the whole window would report that structural fact as a coverage gap.',
      estimatedInputTokens: agg('savings.estimatedInputTokens'),
      returnedAnswerTokens: agg('savings.returnedAnswerTokens'),
      // THE CONTEXT NET: estimated_input_tokens - returned_answer_tokens_estimated.
      tokensAvoided: agg('savings.tokensAvoided'),
      // Worker CONSUMPTION, reported beside the avoided figure and never subtracted from it.
      // Worker tokens are not saved tokens.
      workerTokensConsumed: agg('savings.workerTokensConsumed'),
      costAvoided: agg('savings.costAvoided'),
      // THE CASH NET: estimated_cost_avoided - worker_total_cost.
      netSavings: agg('savings.netSavings'),
      inputBytes: agg('savings.inputBytes'),
      byAvoidedMethod: hist('savings.byAvoidedMethod'),
      caveat:
        'Estimated savings are not necessarily actual invoice savings. The avoided figure prices a counterfactual that never ran, at the primary model input rate only.',
    },

    cost: {
      workerInput: agg('cost.workerInput'),
      workerCachedInput: agg('cost.workerCachedInput'),
      workerOutput: agg('cost.workerOutput'),
      workerTotal: agg('cost.workerTotal'),
      primaryInput: agg('cost.primaryInput'),
      primaryOutput: agg('cost.primaryOutput'),
      primaryTotal: agg('cost.primaryTotal'),
      knownCostEvents: serializeCount(c.knownCost, 'dispatchAttempted'),
      unknownCostEvents: serializeCount(c.unknownCost, 'dispatchAttempted'),
      // A configured rate of literal 0, preserved by rate(). A real measured zero, and the
      // opposite of an unknown — these two must never render the same way.
      structurallyZeroEvents: serializeCount(c.zeroCost, 'dispatchAttempted'),
      coverage: coverageOf(state, 'cost.workerTotal'),
      byPricingLookup: hist('cost.byPricingLookup'),
      byPricingSource: hist('cost.byPricingSource'),
      primaryBaseline: serializeUnavailable(
        'not_instrumented',
        'primary_usage_method is `none` on every row, so there is no measured primary-model spend to compare against.',
      ),
      // The calc layer's reason codes are not stored, so this is re-derived from the five fields
      // that are, and says so.
      nullExplanation: explainNullCost(state),
      note:
        'Cost is computed once at write time and stamped with its pricing_version and calc_version. This layer sums stored money and never re-prices a historical row.',
    },

    latency: finalizeLatency(state.latency),

    failures: {
      // DELIBERATELY NO TOTAL. A worker failure, a governance denial, a capability refusal and an
      // unpriced call are four different events, and the only use for their sum is to be quoted.
      workerFailures: serializeCount(c.workerFailure, 'dispatchAttempted'),
      byErrorCode: hist('failures.byErrorCode'),
      governanceDenials: serializeCount(c.governanceDenied, 'countable'),
      capabilityRefusals: {
        total: serializeCount(c.capabilityRefusal, 'countable'),
        // Refused before the call: no usage, no cost, nothing wasted.
        preflight: serializeCount(c.capabilityRefusalPreflight, 'countable'),
        // The call RAN, tokens were consumed, and the answer was discarded because the provider
        // silently dropped the middle of the prompt. The purest waste figure in the store.
        truncationDiscarded: serializeCount(c.capabilityRefusalTruncationDiscarded, 'countable'),
        note:
          'A context refusal is not a provider failure: the provider did nothing wrong and in the pre-flight case was never called.',
      },
      unknownCost: serializeCount(c.unknownCost, 'dispatchAttempted'),
      unknownUsage: serializeCount(c.usageMissing, 'dispatchAttempted'),
      capabilityUnknown: serializeCount(c.capabilityUnknown, 'countable'),
      retried: serializeCount(c.retried, 'dispatchAttempted'),
      retryCountUnknown: serializeCount(c.retryCountUnknown, 'dispatchAttempted'),
      truncatedAnswers: serializeCount(c.truncatedAnswer, 'dispatchAttempted'),
      retryable: serializeUnavailable(
        'classification_not_available_to_this_layer',
        'Whether an error code is retryable is declared in the provider contract, which analytics may not import. Copying that set here would be a second copy of a vocabulary nobody keeps in step.',
      ),
      note:
        'These counters are reported separately and never added. A governance denial is not a worker failure, a context refusal is not a provider failure, and an unknown cost is not a failed request.',
    },

    governance: {
      consulted: serializeCount(c.countable - c.governanceNotConsulted, 'countable'),
      // All eight columns null means governance was NEVER consulted, which is a different state
      // from "governance allowed this".
      notConsulted: serializeCount(c.governanceNotConsulted, 'countable'),
      allowed: serializeCount(c.governanceAllowed, 'countable'),
      denied: serializeCount(c.governanceDenied, 'countable'),
      byDecision: hist('governance.byDecision'),
      byReason: hist('governance.byReason'),
      byScope: hist('governance.byScope'),
      byMeasurementStatus: hist('governance.byMeasurementStatus'),
      byReservationStatus: hist('governance.byReservationStatus'),
      reservationTokens: agg('governance.reservationTokens'),
      budgetSnapshots: finalizeBudgets(state.budgets),
      note:
        'A governance denial is a successful governance decision. It is recorded on a gate_block row whose routing_reason is threshold_met, because the gate approved and governance then refused; governance_decision is the only field that distinguishes the two.',
    },

    capability: {
      known: serializeCount(c.dispatchAttempted - c.capabilityUnknown, 'dispatchAttempted'),
      unknown: serializeCount(c.capabilityUnknown, 'countable'),
      contextTokens: agg('capability.contextTokens'),
      effectiveInputCapacity: agg('capability.effectiveInputCapacity'),
      requestedInputTokens: agg('capability.requestedInputTokens'),
      observedPromptTokens: agg('capability.observedPromptTokens'),
      bySource: hist('capability.bySource'),
      byStatus: hist('capability.byStatus'),
      truncationDetected: serializeCount(c.capabilityRefusalTruncationDiscarded, 'countable'),
      note:
        'Only a provider_api source yields a measured status. A null context window is unknown, never infinite, and a configured value is never a measured capability.',
    },

    /**
     * ANSWER QUALITY, which is NOT MEASURED — and this section exists to say so where a reader
     * will actually see it.
     *
     * WHY IT IS HERE. Every other section reports a number that goes UP when delegation works:
     * delegation rate, tokens avoided, success rate. A reader scanning a healthy report concludes
     * the router is doing well, and nothing on the page contradicts that reading — while whether
     * the ANSWERS were any good is not established anywhere in this project. A dashboard that
     * cannot be read as overclaiming is worth more than one more aggregate.
     *
     * WHAT IT REPORTS, and it is all measured. Not a score, not an estimate, not a grade: four
     * counts of conditions that bound confidence in a delivered answer, each naming its
     * population, plus the explicit statement that correctness is unmeasured.
     *
     * `measured: false` IS A FIELD rather than only prose, so a consumer that renders this
     * section cannot accidentally present it as a quality figure, and a future consumer that
     * gains a real grader has something to flip.
     */
    answerQuality: {
      measured: false,
      delivered: serializeCount(c.answerDelivered, 'dispatchAttempted', { label: 'answers' }),
      // The residual risk, and the actionable line. These answers may have been built from a
      // silently truncated prompt and nothing could have detected it.
      onUnverifiedWindow: serializeCount(c.answerUnverifiedWindow, 'answerDelivered'),
      cutOffMidAnswer: serializeCount(c.truncatedAnswer, 'dispatchAttempted'),
      // The defence WORKING: truncation was detected, so the answer was thrown away rather than
      // returned. Reported beside the risk above because together they are the whole picture.
      discardedForTruncation: serializeCount(c.capabilityRefusalTruncationDiscarded, 'countable'),
      usageInconsistent: serializeCount(c.tokenSumMismatch, 'dispatchAttempted'),
      established:
        'A worker returned an answer, and these are the measured conditions that bound confidence in it. An answer whose prompt was provably truncated is discarded, not delivered.',
      notEstablished:
        'Whether any delivered answer is correct. There is no baseline comparison against the primary model and no grader, so nothing here distinguishes a good answer from a confident wrong one.',
      note:
        'NOT A QUALITY SCORE. Every figure in this section is a count of a measured condition; none of them grades an answer. See docs/release-v1.md section 7 for the evidence boundary.',
    },

    value: {
      workerOverhead: {
        population: 'noUsableAnswer',
        events: serializeCount(c.noUsableAnswer, 'dispatchAttempted'),
        cost: agg('value.workerOverhead.cost'),
        tokens: agg('value.workerOverhead.tokens'),
        // Reported BESIDE net savings and never subtracted from it. Subtracting would be a new
        // savings formula, and a partial overhead sum and a partial savings sum cover different
        // row sets, so their difference would describe no definite population.
        note:
          'Money and tokens the worker consumed that bought nothing. Reported beside estimated net savings, never subtracted from it.',
      },
    },

    negativeSavings: {
      // Two different populations, and the fixture proves they differ: a delegation can save
      // context and still cost more than it saved. Reporting one would hide the other.
      tokens: {
        events: serializeCount(c.negativeTokens, 'dispatchAttempted'),
        rate: serializeRate(c.negativeTokens, c.dispatchAttempted, { population: 'dispatchAttempted' }),
        total: agg('negativeSavings.tokens.total'),
      },
      dollars: {
        events: serializeCount(c.negativeDollars, 'dispatchAttempted'),
        rate: serializeRate(c.negativeDollars, c.dispatchAttempted, { population: 'dispatchAttempted' }),
        total: agg('negativeSavings.dollars.total'),
      },
      examples: topListFinalize(state.negativeExamples),
      note:
        'Negative savings are never clamped to zero. A negative event does not by itself mean the routing policy is wrong: it can indicate a small corpus, a verbose worker, a slow model, an unnecessary delegation, a task mismatch or a missing baseline. It is surfaced for investigation.',
    },
  }
}

/**
 * The `other` breakdown for a named set of fields, keyed by field.
 *
 * Reported per field and never summed, because the three kinds answer "can we tell why this
 * column says `other`" and that question has a different answer for each column on the same row.
 */
function otherKindsFor(state, fields) {
  const out = {}
  for (const field of fields) {
    out[field] = state.otherKinds.get(field) ?? { deliberate: 0, unknown_enum: 0, indeterminate: 0 }
  }
  return out
}

/** Measurement coverage for one aggregate, as integers plus the ratio. */
function coverageOf(state, path) {
  const a = aggFinalize(state.slots.get(path))
  return {
    knownEvents: a.rowsCounted,
    totalEvents: a.rowsTotal,
    // Null rather than 0 when there is nothing to divide: a coverage of "0%" on an empty
    // population reads as a failure to measure rather than as an absence of events.
    ratio: a.rowsTotal === 0 ? null : a.rowsCounted / a.rowsTotal,
    status: a.status,
  }
}

/**
 * Why cost is null, re-derived from the fields that ARE stored.
 *
 * The calc layer returns a `reason` for every refusal to price — `pricing_unavailable`,
 * `rate_unpriced`, `tokens_missing` — and `buildEvent()` discards all of them. So this is a
 * reconstruction from `pricing_lookup`, `pricing_source` and the usage source, and it is marked
 * `derived: true` rather than presented as the stored reason. `indeterminate` is the honest
 * bucket for the cases those fields cannot separate.
 */
function explainNullCost(state) {
  const lookups = histogramFinalize(state.histograms.get('cost.byPricingLookup'), {})
  const sources = histogramFinalize(state.histograms.get('cost.byPricingSource'), {})
  const byLookup = Object.fromEntries(lookups.buckets.map((b) => [b.key, b.count]))
  const bySource = Object.fromEntries(sources.buckets.map((b) => [b.key, b.count]))
  return {
    derived: true,
    derivedFrom: ['pricing_lookup', 'pricing_source', 'worker_usage_source'],
    noPricingTable: bucketCount(byLookup, 'no_table'),
    modelNotInTable: bucketCount(byLookup, 'model_unknown'),
    matchedByWildcard: bucketCount(byLookup, 'wildcard'),
    matchedByAlias: bucketCount(byLookup, 'requested_alias'),
    matchedExactly: bucketCount(byLookup, 'exact'),
    bundledTableAllNull: bucketCount(bySource, 'bundled'),
    noTableConfigured: bucketCount(bySource, 'none'),
    usageMissing: state.counters.usageMissing,
    note:
      'The calc layer discards its reason codes before writing, so these are re-derived from the stored lookup and source columns. Cases those columns cannot separate are not guessed.',
  }
}

/** The latest observation of each budget ceiling. Never a sum: a limit is not a quantity. */
function finalizeBudgets(budgets) {
  const out = []
  for (const [scope, entry] of [...budgets.entries()].sort()) {
    out.push({
      scope,
      limit: entry.limit.value,
      remaining: entry.remaining.value,
      measurementStatus: entry.status.value,
      observations: entry.limit.observations,
      utilization:
        typeof entry.limit.value === 'number' &&
        entry.limit.value > 0 &&
        typeof entry.remaining.value === 'number'
          ? (entry.limit.value - entry.remaining.value) / entry.limit.value
          : null,
    })
  }
  return {
    aggregated: false,
    snapshots: out,
    note:
      'The most recent non-null observation per scope. Budget limits are never summed across rows, because a limit is not a quantity consumed, and utilization is null wherever either operand is unknown.',
  }
}

/** The latency section, including the components this telemetry cannot answer. */
function finalizeLatency(latency) {
  return {
    population: 'dispatchAttempted',
    gateRowsExcluded: latency.gateRowsExcluded,
    gateRowsExcludedReason:
      'Both latency columns are null on every gate_block row: hook/event.mjs declines to give latency_ms a second meaning. A design decision, not missing data.',
    total: seriesFinalize(latency.total),
    provider: seriesFinalize(latency.provider),
    dispatchOverhead: {
      ...seriesFinalize(latency.dispatchOverhead),
      derived: true,
      formula: 'latency_ms - provider_latency_ms',
      admittedWhen: 'retry_count === 0',
      excludedForRetry: latency.overheadExcludedForRetry,
      excludedForUnknownRetry: latency.overheadExcludedForUnknownRetry,
      note:
        'provider_latency_ms covers the final attempt only, so with a retry this difference would include an unknown amount of earlier network time. Rows with a retry, and rows whose retry count is unknown, are excluded and counted.',
    },
    components: {
      hookOverheadMs: serializeUnavailable(
        'not_instrumented_by_design',
        'hook/event.mjs declines to put the hook wall clock in latency_ms, which means payload assembly plus every attempt plus the parse. Hook overhead is measured by test/hook.latency.test.mjs and documented, not stored per row.',
      ),
      governanceDecisionMs: serializeUnavailable('not_instrumented', 'No column records how long checkBudget() took.'),
      capabilityResolutionMs: serializeUnavailable('not_instrumented', 'No column records capability resolution time.'),
      timeToFirstTokenMs: serializeUnavailable('not_instrumented', 'The schema has no time-to-first-token field.'),
      perAttemptMs: serializeUnavailable(
        'final_attempt_only',
        'provider_latency_ms is the final attempt; retry_count gives a count, not durations. The schema is scalar-only, so a per-attempt array cannot exist.',
      ),
      payloadAssemblyMs: serializeUnavailable('not_separable_from_total', 'Inside latency_ms with no separate column.'),
      parseMs: serializeUnavailable('not_separable_from_total', 'Inside latency_ms with no separate column.'),
    },
    note:
      'Median, p95 and max by nearest rank with no interpolation, so every reported percentile is a value that was actually measured. The mean is deliberately null.',
  }
}
