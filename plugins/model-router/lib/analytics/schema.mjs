/**
 * The frozen analytics response contract: the section list, the metric table, the dimension
 * table, and the two field lists that bound what may leave this layer.
 *
 * THIS FILE ANSWERS "what shape will the dashboard get". It does not answer "what do the numbers
 * mean" (predicates.mjs) or "how are they computed" (metrics.mjs). It computes nothing, reads no
 * row and holds no state, so the contract can be asserted against a hand-authored golden
 * response before any aggregation code exists.
 *
 * THE INVARIANT: every aggregate in the response names the POPULATION it was computed over.
 * A coverage figure is meaningless without its denominator, and the single most misleading number
 * this engine could emit is a savings sum whose `status: 'partial'` reflects nothing but the fact
 * that `gate_block` rows carry no savings columns at all. `estimated_input_tokens` is only set
 * once content has been read, so a savings aggregate over every row in a window reports
 * `coverage ≈ delegations / rows` as a PERMANENT STRUCTURAL ARTEFACT rather than as a measurement
 * gap. Naming the population is what turns that number back into information.
 *
 * FIELD_ALLOWLIST IS AN ALLOWLIST AND NOT A DENYLIST, deliberately. A column added to the
 * telemetry schema must be admitted here before it can reach a response. With a denylist, a new
 * column that happened to carry user content would reach a rendered dashboard the moment somebody
 * grouped by it, and the omission would look like a feature rather than a leak.
 */

import {
  AVOIDED_METHODS,
  BUDGET_MEASUREMENT_STATUS_VALUES,
  BUDGET_SCOPE_VALUES,
  FIELD_ORDER,
  GOVERNANCE_DECISION_VALUES,
  GOVERNANCE_REASON_VALUES,
  PRICING_LOOKUPS,
  PRICING_SOURCES,
  RESERVATION_STATUS_VALUES,
  ROUTING_DECISIONS,
  ROUTING_REASONS,
  STATUS_VALUES,
  TASK_INTENT_SOURCES,
  TASK_TYPES,
  WORKER_CONTEXT_SOURCES,
  WORKER_CONTEXT_STATUSES,
} from '../telemetry/record.mjs'
import { NULL_KEY } from '../telemetry/aggregate.mjs'

/**
 * Bumped when a field changes meaning or disappears. Adding a nullable field does not bump it —
 * the same rule `SCHEMA_VERSION` follows in record.mjs, for the same reason: a dashboard built
 * against version 1 must keep working against a response that merely gained a section.
 */
export const ANALYTICS_CONTRACT_VERSION = 1

/** The top-level sections, in order. A response has exactly these keys and no others. */
export const SECTIONS = Object.freeze([
  'engine',
  'request',
  'timeRange',
  'summary',
  'routing',
  'workerUsage',
  'savings',
  'cost',
  'latency',
  'failures',
  'governance',
  'capability',
  'answerQuality',
  'value',
  'negativeSavings',
  'segments',
  'coverage',
  'dataQuality',
])

/* ------------------------------------------------------------- metric kinds */

/**
 * Four metric shapes, each tagged so a consumer cannot misread one as another.
 *
 * `agg`   — a sum with its coverage. `value: null` means nothing contributed, never zero.
 * `rate`  — a ratio of two counts. It is NOT an Agg: a ratio has no measurement status, and
 *           giving it one would invite a `basis: 'actual'` on a number that is a quotient of
 *           counts. `value: null` when the denominator is zero OR incomplete.
 * `count` — an exact integer. Counts have no coverage problem, only a schema gate, so a count is
 *           never null.
 * `unavailable` — a metric the phase asks for that this telemetry cannot answer. It carries a
 *           machine-readable `reason` so a dashboard can say *why* rather than printing a dash.
 */
export const METRIC_KINDS = Object.freeze(['agg', 'rate', 'count', 'series', 'unavailable'])

/** Units an aggregate may carry. `count` is for integer sums, not for the `count` metric kind. */
export const UNITS = Object.freeze(['USD', 'tokens', 'ms', 'bytes', 'count', 'ratio'])

/**
 * Why an aggregate's value is null. Derived from the accumulated state, never guessed, and only
 * ever set when `value === null`.
 */
export const NULL_REASONS = Object.freeze([
  'no_rows_in_window',
  'no_rows_in_population',
  'all_rows_unavailable',
  'all_rows_incompatible',
])

/* -------------------------------------------------------------- row classes */

/**
 * The eight row classes, closed and disjoint, in the order `classifyRow()` tests them.
 *
 * `governanceDenied` comes before `gateRefused` because it has to. A budget refusal is written as
 * a `gate_block` row whose `routing_reason` is `threshold_met` — the gate APPROVED, and only
 * `governance_decision` records that governance then refused. Testing `task_type` first would
 * file every budget denial under gate refusals and lose the governance signal entirely.
 */
export const ROW_CLASSES = Object.freeze([
  'schemaIncompatible',
  'governanceDenied',
  'gateRefused',
  'approvedNotDispatched',
  'delegationOk',
  'delegationError',
  'delegationSkipped',
])

/**
 * The routing reasons that mean THE GATE DECLINED. A subset of ROUTING_REASONS, and a test
 * asserts every member is still a member there, so the two cannot desync.
 *
 * Three reasons are deliberately absent. `threshold_met` means the gate approved. `provider_error`
 * and `context_exceeded` are recorded on rows where the gate approved and something later refused
 * or failed, so counting them as gate refusals would attribute a dispatch outcome to the gate.
 */
export const GATE_REFUSAL_REASONS = Object.freeze([
  'below_threshold',
  'over_max_files',
  'targeted_read',
  'recently_edited',
  'deny_glob',
  'allow_glob',
  'worker_not_ready',
  'budget_exceeded',
  'disabled',
  'skill_invoked',
  'task_type_excluded',
  'interactive',
  'latency_sensitive',
  'unknown_input',
  'precise_output_requested',
  'over_max_input_bytes',
])

/**
 * The named populations a metric may be aggregated over. Every `agg` and `rate` in the response
 * declares one of these, and the name travels with the number.
 */
export const POPULATIONS = Object.freeze({
  allRows: 'every row in the window, including rows this build cannot read',
  countable: 'every readable row in the window — the routing-event population',
  routingEvents: 'one row is one hook invocation, so this equals `countable`',
  dispatchAttempted: 'rows where a worker call was attempted (task_type is not gate_block)',
  delegationOk: 'dispatched rows that returned a usable answer',
  answerDelivered: 'dispatched rows that returned a non-empty answer to Claude — the population whose correctness is not measured',
  governanceConsulted: 'rows where at least one governance column is non-null',
  capabilityKnown: 'rows with a resolved worker context window',
  noUsableAnswer: 'dispatched rows that delivered nothing usable — the worker-overhead population',
  retryFreeDispatch: 'dispatched rows with retry_count exactly 0',
  negativeTokenRows: 'rows whose estimated_tokens_avoided is negative',
  negativeDollarRows: 'rows whose estimated_net_savings is negative',
})

/* ------------------------------------------------------------ display units */

/**
 * Every aggregate path in the response, with the unit and precision it renders at.
 *
 * WHY THIS IS A TABLE AND NOT A PARAMETER. `formatAgg()` is documented as the only sanctioned way
 * an aggregate reaches a screen, and the dashboard is a separate plugin that may not import it.
 * So the engine renders the string and ships it. That only stays honest if every aggregate has a
 * declared unit: a census test walks the finished response, finds every node with
 * `metricKind: 'agg'`, and fails if its path is absent here. A new headline therefore cannot ship
 * unlabelled, and a money column cannot ship formatted as tokens.
 */
export const DISPLAY_UNITS = Object.freeze({
  'summary.tokensAvoided': { unit: 'tokens', places: 0 },
  'summary.workerTokens': { unit: 'tokens', places: 0 },
  'summary.workerCost': { unit: 'USD', places: 4 },
  'summary.netSavings': { unit: 'USD', places: 4 },

  'workerUsage.inputTokens': { unit: 'tokens', places: 0 },
  'workerUsage.cachedInputTokens': { unit: 'tokens', places: 0 },
  'workerUsage.outputTokens': { unit: 'tokens', places: 0 },
  'workerUsage.thoughtTokens': { unit: 'tokens', places: 0 },
  'workerUsage.billableOutputTokens': { unit: 'tokens', places: 0 },
  'workerUsage.totalTokensSummed': { unit: 'tokens', places: 0 },
  'workerUsage.totalTokensReported': { unit: 'tokens', places: 0 },

  'savings.estimatedInputTokens': { unit: 'tokens', places: 0 },
  'savings.returnedAnswerTokens': { unit: 'tokens', places: 0 },
  'savings.tokensAvoided': { unit: 'tokens', places: 0 },
  'savings.workerTokensConsumed': { unit: 'tokens', places: 0 },
  'savings.costAvoided': { unit: 'USD', places: 4 },
  'savings.netSavings': { unit: 'USD', places: 4 },
  'savings.inputBytes': { unit: 'bytes', places: 0 },

  'cost.workerInput': { unit: 'USD', places: 4 },
  'cost.workerCachedInput': { unit: 'USD', places: 4 },
  'cost.workerOutput': { unit: 'USD', places: 4 },
  'cost.workerTotal': { unit: 'USD', places: 4 },
  'cost.primaryInput': { unit: 'USD', places: 4 },
  'cost.primaryOutput': { unit: 'USD', places: 4 },
  'cost.primaryTotal': { unit: 'USD', places: 4 },

  'capability.contextTokens': { unit: 'tokens', places: 0 },
  'capability.effectiveInputCapacity': { unit: 'tokens', places: 0 },
  'capability.requestedInputTokens': { unit: 'tokens', places: 0 },
  'capability.observedPromptTokens': { unit: 'tokens', places: 0 },

  'governance.reservationTokens': { unit: 'tokens', places: 0 },

  'value.workerOverhead.cost': { unit: 'USD', places: 4 },
  'value.workerOverhead.tokens': { unit: 'tokens', places: 0 },

  'negativeSavings.tokens.total': { unit: 'tokens', places: 0 },
  'negativeSavings.dollars.total': { unit: 'USD', places: 4 },
})

/**
 * The aggregates each segment bucket carries, with their units. Buckets use a compact projection
 * of the Agg — a full one per bucket per dimension would be most of the response.
 */
export const SEGMENT_METRICS = Object.freeze({
  workerTokens: { unit: 'tokens', places: 0 },
  tokensAvoided: { unit: 'tokens', places: 0 },
  workerCost: { unit: 'USD', places: 4 },
  costAvoided: { unit: 'USD', places: 4 },
  netSavings: { unit: 'USD', places: 4 },
})

/* --------------------------------------------------------------- dimensions */

/**
 * The ten segment dimensions.
 *
 * `governance_reason`, `pricing_lookup`, `worker_context_source` and `avoided_method` are
 * deliberately NOT here. They appear as histograms inside their own sections, which is where an
 * operator looks for them anyway, and keeping them out saves four more full cross-products.
 *
 * `errorCode` is an OPEN string dimension and its vocabulary is not redeclared.
 * `DISPATCH_ERROR_CODES` lives in `lib/dispatch/contract.mjs`, which this layer may not import,
 * and a copy of a vocabulary nobody keeps in step is worse than no copy. The consequence is
 * reported rather than hidden: `failures.retryable` is `unavailable`, because `RETRYABLE` is a
 * provider-contract set too.
 */
export const SEGMENT_DIMENSIONS = Object.freeze([
  { id: 'date', field: 'timestamp', enum: null, note: 'UTC calendar day; the only dimension that may invent keys' },
  { id: 'provider', field: 'provider', enum: null },
  { id: 'model', field: 'model', enum: null },
  { id: 'project', field: 'project_id', enum: null },
  { id: 'session', field: 'session_id', enum: null },
  { id: 'taskType', field: 'task_type', enum: TASK_TYPES },
  { id: 'routingDecision', field: 'routing_decision', enum: ROUTING_DECISIONS },
  { id: 'routingReason', field: 'routing_reason', enum: ROUTING_REASONS },
  { id: 'status', field: 'status', enum: STATUS_VALUES },
  { id: 'errorCode', field: 'error_code', enum: null, note: 'open: the code vocabulary is not this layer to declare' },
  // The delegation-value axis: one bucket per provider/model/mode combination, which is the
  // grain the value question is actually asked at. Derived rather than read from a column, like
  // `date`, because no single column holds it — and `mode` is `task_type`, since schema v1 has
  // no mode column at all.
  {
    id: 'workerProfile',
    field: 'provider|model|task_type',
    enum: null,
    note: 'derived composite; the grain of the delegation-value view',
  },
])

/** The separator in a composite dimension key. Chosen because no stored enum contains it. */
export const PROFILE_SEPARATOR = ' / '

/** Histograms reported inside their own sections rather than as general dimensions. */
export const HISTOGRAMS = Object.freeze({
  'routing.byDecision': { field: 'routing_decision', enum: ROUTING_DECISIONS },
  'routing.byReason': { field: 'routing_reason', enum: ROUTING_REASONS },
  'routing.byTaskType': { field: 'task_type', enum: TASK_TYPES },
  'routing.byIntentSource': { field: 'task_intent_source', enum: TASK_INTENT_SOURCES },
  'governance.byDecision': { field: 'governance_decision', enum: GOVERNANCE_DECISION_VALUES },
  'governance.byReason': { field: 'governance_reason', enum: GOVERNANCE_REASON_VALUES },
  'governance.byScope': { field: 'budget_scope', enum: BUDGET_SCOPE_VALUES },
  'governance.byMeasurementStatus': { field: 'budget_measurement_status', enum: BUDGET_MEASUREMENT_STATUS_VALUES },
  'governance.byReservationStatus': { field: 'reservation_status', enum: RESERVATION_STATUS_VALUES },
  'capability.bySource': { field: 'worker_context_source', enum: WORKER_CONTEXT_SOURCES },
  'capability.byStatus': { field: 'worker_context_status', enum: WORKER_CONTEXT_STATUSES },
  'cost.byPricingLookup': { field: 'pricing_lookup', enum: PRICING_LOOKUPS },
  'cost.byPricingSource': { field: 'pricing_source', enum: PRICING_SOURCES },
  'savings.byAvoidedMethod': { field: 'avoided_method', enum: AVOIDED_METHODS },
  'failures.byErrorCode': { field: 'error_code', enum: null },
})

/**
 * Bucket keys that are not stored values.
 *
 * THE WIRE KEY FOR A NULL GROUP STAYS `NULL_KEY`, imported rather than redeclared, with the human
 * word in a separate `label`. Mapping null onto the string `'unknown'` would be wrong for at least
 * one dimension: `worker_context_source` has a literal `'unknown'` member, so the two would merge
 * "we never resolved a context window" with "the provider told us it does not know" — two
 * different facts with two different fixes. Keeping NULL_KEY also means a consumer that runs
 * `groupBy()` itself produces keys that match the engine's exactly.
 *
 * A raw value that happens to equal one of these sentinels is emitted with `keyKind: 'value'`.
 * CONSUMERS DISAMBIGUATE ON `keyKind`, NEVER ON THE KEY STRING.
 */
export const NULL_BUCKET_KEY = NULL_KEY
export const OTHER_KEY = '__other__'
export const OVERFLOW_KEY = '__overflow__'
export const KEY_KINDS = Object.freeze(['value', 'null', 'other', 'overflow'])

/**
 * Cardinality bounds. Two caps with two different meanings, both surfaced on the dimension.
 *
 * `maxTrackedKeys` is a LIVE cap: once a dimension holds this many keys, every new key folds into
 * `__overflow__`. It bounds memory during the pass, which `model` and `session` can otherwise
 * blow up without limit.
 *
 * `topN` is a FINALIZE cap: buckets are ordered by row count descending then key ascending — a
 * total order, so ties are deterministic — and the tail's unfinalized states are merged into
 * `__other__`. Merging states rather than values is what keeps `__other__`'s coverage exact.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxTrackedKeys: 200,
  topN: 20,
  maxOverflowKeyNames: 1000,
  maxLatencySamples: 200_000,
  maxNegativeExamples: 100,
  maxDayBuckets: 366,
})

/** Below this many points a series is reported but no direction is ever stated. */
export const MIN_TREND_POINTS = 7

/* ------------------------------------------------------------ data quality */

/**
 * Every data-quality condition the engine can raise, with its severity and what it affects.
 *
 * `gate_decisions_not_recorded` is the one that matters most. The delegation rate's denominator is
 * the whole routing-event population, which only exists if gate decisions are being written. With
 * them suppressed the rate would be computed over delegations alone and would report 100%, so the
 * rate is emitted as null and this condition explains why.
 */
export const DATA_QUALITY_CONDITIONS = Object.freeze({
  gate_decisions_not_recorded: {
    severity: 'error',
    affects: ['summary.delegationRate', 'routing.delegationRate', 'routing.refusalRate'],
    detail:
      'telemetry.recordGateDecisions is off, or no gate_block row appears in this window, so the routing-event denominator is incomplete and no delegation rate can be computed.',
  },
  malformed_records: {
    severity: 'error',
    affects: ['coverage.rowsYielded'],
    detail:
      'An unparseable line was found mid-file. A truncated TAIL is a writer caught mid-flight and benign; a malformed line in the MIDDLE is evidence that append atomicity failed on this filesystem. Consider telemetry.shardByPid.',
  },
  pricing_all_null: {
    severity: 'info',
    affects: ['summary.workerCost', 'summary.netSavings', 'cost', 'savings.costAvoided', 'savings.netSavings'],
    detail:
      'No row in this window carries a priced cost. Every rate in the bundled pricing table ships null, so this is the expected state of a default install: a refusal to price, not a missing measurement.',
  },
  primary_usage_unavailable: {
    severity: 'info',
    affects: ['cost.primaryInput', 'cost.primaryOutput', 'cost.primaryTotal'],
    detail:
      'primary_usage_method is `none` on every row, so there is no measured primary-model baseline to compare against. The avoided figures remain counterfactual estimates.',
  },
  schema_versions_unreadable: {
    severity: 'warn',
    affects: ['coverage.rowsIncompatible'],
    detail: 'Rows written by a newer schema were read and excluded from every aggregate.',
  },
  unknown_enum_values: {
    severity: 'warn',
    affects: ['segments.routingReason', 'segments.taskType'],
    detail:
      'A stored enum value this build does not know was preserved verbatim and bucketed as `other`.',
  },
  incomplete_period: {
    severity: 'info',
    affects: ['segments.date'],
    detail: 'The newest bucket covers a partial day, so a trend across it compares unlike spans.',
  },
  window_exceeds_day_bucket_limit: {
    severity: 'info',
    affects: ['segments.date'],
    detail: 'The window spans more days than the bucket cap, so the date dimension switched to weeks.',
  },
  segments_truncated: {
    severity: 'warn',
    affects: ['segments'],
    detail: 'A dimension exceeded its tracked-key cap, so the tail is reported as `__overflow__`.',
  },
  latency_samples_truncated: {
    severity: 'warn',
    affects: ['latency'],
    detail: 'More latency samples were seen than kept, so the reported percentiles cover a prefix.',
  },
  usage_unreported: {
    severity: 'info',
    affects: ['workerUsage'],
    detail:
      'Some dispatched rows report no usage at all, so worker token totals cover fewer events than were dispatched.',
  },
  token_sum_mismatch: {
    severity: 'warn',
    affects: ['workerUsage.totalTokensReported', 'workerUsage.totalTokensSummed'],
    detail:
      'On some rows the provider total disagrees with the sum of its components. Both are reported and neither is reconciled; the disagreement locates a provider-parser bug.',
  },
  truncation_detected: {
    severity: 'error',
    affects: ['failures.capabilityRefusals.truncationDiscarded'],
    detail:
      'On some rows the provider read less of the prompt than was sent, so the answer was discarded after the call was paid for.',
  },
})

/** Reasons a metric the phase asks for cannot be answered from this telemetry at all. */
export const UNAVAILABLE_REASONS = Object.freeze([
  'not_instrumented',
  'not_instrumented_by_design',
  'not_separable_from_total',
  'final_attempt_only',
  'classification_not_available_to_this_layer',
])

/* ------------------------------------------------------------ field policy */

/**
 * Telemetry columns that may NEVER leave this layer, in any form.
 *
 * `question_text` and `error_message_safe` can hold text the developer typed or a provider
 * returned. `project_path` is a filesystem path, written only when `telemetry.storeFilePaths` is
 * on. None of the three is an analytics input, and a dashboard that printed one would publish
 * content the router was careful never to send anywhere.
 *
 * The reader's own `samples[]` is excluded for the same reason and is not a column at all: each
 * sample carries a 120-character excerpt of a RAW LINE plus an absolute file path, and a raw line
 * can contain any of the three fields above. `dataQuality` copies the counters and never the
 * samples.
 */
export const FORBIDDEN_FIELDS = Object.freeze(['question_text', 'error_message_safe', 'project_path'])

/**
 * Every telemetry column this layer may read. The complement of FORBIDDEN_FIELDS over
 * FIELD_ORDER, computed rather than typed so the two lists cannot fall out of step — a test
 * asserts they partition FIELD_ORDER exactly.
 */
export const FIELD_ALLOWLIST = Object.freeze(FIELD_ORDER.filter((f) => !FORBIDDEN_FIELDS.includes(f)))

/**
 * The row fields a negative-savings example may carry. Enough to diagnose the case — the operands
 * of both nets, the corpus size, the model that produced it — and nothing that is content.
 */
export const EXAMPLE_FIELDS = Object.freeze([
  'event_id',
  'task_id',
  'timestamp',
  'provider',
  'model',
  'task_type',
  'routing_reason',
  'estimated_input_tokens',
  'returned_answer_tokens_estimated',
  'estimated_tokens_avoided',
  'estimated_cost_avoided',
  'worker_total_cost',
  'estimated_net_savings',
  'input_bytes',
  'files_count',
  'latency_ms',
])

/* ----------------------------------------------------------- time semantics */

/** The window kinds. Every boundary is UTC and every range is half-open [from, to). */
export const WINDOW_KINDS = Object.freeze(['today', '24h', '7d', '30d', 'custom', 'all'])

/**
 * Worker modes, mapped onto the column that actually exists.
 *
 * There is no `mode` column in schema version 1. The dispatch layer's lane names are
 * `bulk-reader` and `code-writer`; what reaches a row is `task_type`. So `--mode` filters on
 * `task_type` through this frozen table, and the resolved filter is echoed back in the response
 * so nobody has to guess which column was consulted. Adding a column is a telemetry change and
 * is out of this phase's remit.
 */
export const MODE_ALIASES = Object.freeze({
  'bulk-reader': 'bulk_read',
  bulk_read: 'bulk_read',
  'code-writer': 'code_write',
  code_write: 'code_write',
})
