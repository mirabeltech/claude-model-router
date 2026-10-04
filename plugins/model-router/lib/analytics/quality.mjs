/**
 * Honesty bookkeeping: what was scanned, what was accepted, what was rejected, and why.
 *
 * THE POINT OF THIS SECTION is to make one confusion impossible: "we saved $0" versus "we do not
 * know the cost". Every other section reports numbers; this one reports how much of the window
 * those numbers actually cover, and names the conditions that bound them.
 *
 * THE READER'S SAMPLES ARE NOT COPIED THROUGH, and that is a security decision rather than a
 * tidiness one. `store.report().samples[]` carries a 120-character excerpt of a RAW LINE plus the
 * absolute path of the file it came from. A raw line is a whole telemetry record, so it can
 * contain `question_text`, `error_message_safe` and `project_path` — the three fields this layer
 * is forbidden to surface. The counters are copied; the excerpts and the paths are dropped.
 *
 * MALFORMED IS NOT THE SAME AS A TRUNCATED TAIL, and the response keeps them apart because they
 * mean opposite things. An unparseable line at the END of a segment is a writer caught mid-flight
 * and is entirely benign. An unparseable line in the MIDDLE is evidence that append atomicity
 * failed on this filesystem, which is the one reader counter that should change an operator's
 * behaviour.
 */

import { DATA_QUALITY_CONDITIONS } from './schema.mjs'
import { predicates } from './predicates.mjs'

/** The per-row quality tallies. Everything here is a count; none of it is a measurement. */
export function createQualityState() {
  return {
    schemaVersions: new Map(),
    unknownEnumRows: 0,
    unknownEnumCodes: new Map(),
    validationWarningRows: 0,
    missingUsageRows: 0,
    partialUsageRows: 0,
    tokenSumMismatchRows: 0,
    missingCostRows: 0,
    knownCostRows: 0,
    zeroCostRows: 0,
    missingLatencyRows: 0,
    missingSavingsRows: 0,
    truncatedRecordRows: 0,
    gateRows: 0,
    pricedRows: 0,
    truncationDetectedRows: 0,
    capabilityUnknownRows: 0,
    primaryUsageRows: 0,
  }
}

export function pushQuality(state, row) {
  const version = row?.schema_version
  const key = typeof version === 'number' ? String(version) : 'unreadable'
  state.schemaVersions.set(key, (state.schemaVersions.get(key) ?? 0) + 1)

  // A row from a future schema is counted and then left alone: nothing below it can be
  // interpreted safely, and guessing would be worse than reporting the gap.
  if (!predicates.countable(row)) return state

  if (typeof row.validation_warnings === 'number' && row.validation_warnings > 0) {
    state.validationWarningRows += 1
  }
  if (predicates.hasUnknownEnum(row)) {
    state.unknownEnumRows += 1
    for (const code of row.validation_codes.split(',')) {
      if (code.startsWith('unknown_enum:')) {
        const field = code.slice('unknown_enum:'.length)
        state.unknownEnumCodes.set(field, (state.unknownEnumCodes.get(field) ?? 0) + 1)
      }
    }
  }
  // `truncation_steps` records that THIS RECORD was shed to fit the size guard. It is a third
  // distinct meaning of "truncation", unrelated to a truncated answer or a truncated prompt, and
  // conflating any two of the three would misattribute a sink problem to a provider.
  if (typeof row.truncation_steps === 'string' && row.truncation_steps !== '') {
    state.truncatedRecordRows += 1
  }

  if (row.task_type === 'gate_block') state.gateRows += 1
  if (predicates.priced(row)) state.pricedRows += 1
  if (predicates.usageMissing(row)) state.missingUsageRows += 1
  if (predicates.usagePartial(row)) state.partialUsageRows += 1
  if (predicates.tokenSumMismatch(row)) state.tokenSumMismatchRows += 1
  if (predicates.capabilityRefusalTruncationDiscarded(row)) state.truncationDetectedRows += 1
  if (predicates.capabilityUnknown(row)) state.capabilityUnknownRows += 1
  if (row.primary_usage_method !== null && row.primary_usage_method !== 'none') {
    state.primaryUsageRows += 1
  }

  if (predicates.knownCost(row)) {
    state.knownCostRows += 1
    if (predicates.zeroCost(row)) state.zeroCostRows += 1
  } else if (!predicates.dispatchAttempted(row)) {
    // A gate row has no cost BY CONSTRUCTION — no call was made. Counting it as a missing
    // measurement would report a structural fact as a data-quality problem and would make cost
    // coverage look broken on a perfectly healthy store.
  } else {
    state.missingCostRows += 1
  }

  if (predicates.dispatchAttempted(row)) {
    if (row.latency_ms === null) state.missingLatencyRows += 1
    if (row.estimated_tokens_avoided === null) state.missingSavingsRows += 1
  }

  return state
}

/**
 * Map the reader's report into the response, keeping the counters and dropping the samples.
 *
 * `accepted` is `yielded`: lines the reader handed over. `rejected` is everything it skipped,
 * itemised — a single total would merge the benign (a blank line from a trailing newline) with
 * the alarming (a malformed line mid-file), which is the distinction most worth preserving.
 */
/**
 * A COUNT of things the reader saw. An absent counter means it saw none of them, which is a real
 * zero rather than an unmeasured quantity — the one place in this layer where defaulting to 0 is
 * the correct reading, and it is named so the `?? 0` rule can exempt it by name.
 */
const countSeen = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function mapReadReport(report) {
  const skipped = report?.skipped ?? {}
  const rejected = Object.values(skipped).reduce((a, b) => a + countSeen(b), 0)
  return Object.freeze({
    segmentsRead: countSeen(report?.files),
    bytesScanned: countSeen(report?.bytes),
    linesScanned: countSeen(report?.lines),
    recordsAccepted: countSeen(report?.yielded),
    recordsRejected: rejected,
    rejectionReasons: Object.freeze({
      blank: countSeen(skipped.blank),
      comment: countSeen(skipped.comment),
      malformed: countSeen(skipped.malformed),
      notAnObject: countSeen(skipped.not_an_object),
      unrecognized: countSeen(skipped.unrecognized),
      oversizeLine: countSeen(skipped.oversize_line),
      truncatedTail: countSeen(skipped.truncated_tail),
      unterminatedTailParsed: countSeen(skipped.unterminated_tail_parsed),
    }),
    // The reader's error list is counted, not copied: an error object carries the path of the
    // file it failed on.
    readErrors: Array.isArray(report?.errors) ? report.errors.length : 0,
    // DELIBERATELY ABSENT: report.samples. Each sample is an excerpt of a raw telemetry line
    // plus an absolute file path, and a raw line can hold any content field.
    samplesWithheld: Array.isArray(report?.samples) ? report.samples.length : 0,
    samplesWithheldReason: 'a raw-line excerpt can contain content fields this layer never surfaces',
  })
}

/**
 * Raise the conditions that bound the numbers, each with the severity and blast radius declared
 * in `DATA_QUALITY_CONDITIONS`.
 *
 * A condition is raised from EVIDENCE, never from a default. `gate_decisions_not_recorded` in
 * particular is checked two independent ways — what the config says and what the rows show —
 * because an operator reading a report on somebody else's store has no access to the first.
 */
export function finalizeQuality(state, { read, timeRange, coverage, config = null, limits = {} }) {
  const conditions = []
  const raise = (id, extra = {}) => {
    const declared = DATA_QUALITY_CONDITIONS[id]
    if (declared === undefined) throw new Error(`finalizeQuality: undeclared condition ${id}`)
    conditions.push({ id, severity: declared.severity, affects: declared.affects, detail: declared.detail, ...extra })
  }

  const countable = coverage.rowsInWindow - coverage.rowsIncompatible
  const configEvidence = config?.telemetry?.recordGateDecisions === false
  const observedEvidence = countable > 0 && state.gateRows === 0
  const gateRowsMissing = configEvidence || observedEvidence

  if (gateRowsMissing) {
    raise('gate_decisions_not_recorded', {
      evidence: {
        configSaysOff: configEvidence,
        noGateRowObserved: observedEvidence,
        gateRowsSeen: state.gateRows,
        countableRows: countable,
      },
    })
  }

  if (read.rejectionReasons.malformed > 0) {
    raise('malformed_records', { count: read.rejectionReasons.malformed })
  }
  if (coverage.rowsIncompatible > 0) {
    raise('schema_versions_unreadable', { count: coverage.rowsIncompatible })
  }
  if (countable > 0 && state.knownCostRows === 0) {
    raise('pricing_all_null', { countableRows: countable })
  }
  if (countable > 0 && state.primaryUsageRows === 0) {
    raise('primary_usage_unavailable', { countableRows: countable })
  }
  if (state.unknownEnumRows > 0) {
    raise('unknown_enum_values', {
      count: state.unknownEnumRows,
      fields: Object.fromEntries(state.unknownEnumCodes),
    })
  }
  if (state.missingUsageRows > 0) {
    raise('usage_unreported', { count: state.missingUsageRows })
  }
  if (state.tokenSumMismatchRows > 0) {
    raise('token_sum_mismatch', { count: state.tokenSumMismatchRows })
  }
  if (state.truncationDetectedRows > 0) {
    raise('truncation_detected', { count: state.truncationDetectedRows })
  }
  if (timeRange.valid && timeRange.incompletePeriod) {
    raise('incomplete_period', { newestBucketPartial: true })
  }
  if (limits.dayBucketsExceeded) {
    raise('window_exceeds_day_bucket_limit', { days: timeRange.days })
  }
  if (limits.segmentsTruncated) {
    raise('segments_truncated', { dimensions: limits.truncatedDimensions ?? [] })
  }
  if (limits.latencyTruncated) {
    raise('latency_samples_truncated', {})
  }

  const severities = { error: 0, warn: 0, info: 0 }
  for (const c of conditions) severities[c.severity] += 1

  return Object.freeze({
    read,
    schemaVersions: Object.fromEntries(
      [...state.schemaVersions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ),
    rows: Object.freeze({
      validationWarnings: state.validationWarningRows,
      unknownEnums: state.unknownEnumRows,
      unknownEnumFields: Object.fromEntries(state.unknownEnumCodes),
      // Records the SINK shed to fit the size guard. A third, unrelated meaning of truncation.
      shedRecords: state.truncatedRecordRows,
      missingUsage: state.missingUsageRows,
      partialUsage: state.partialUsageRows,
      tokenSumMismatch: state.tokenSumMismatchRows,
      missingCost: state.missingCostRows,
      knownCost: state.knownCostRows,
      zeroCost: state.zeroCostRows,
      missingLatency: state.missingLatencyRows,
      missingSavings: state.missingSavingsRows,
      capabilityUnknown: state.capabilityUnknownRows,
      priced: state.pricedRows,
      gateDecisions: state.gateRows,
    }),
    gateDecisionsRecorded: !gateRowsMissing,
    conditions: Object.freeze(conditions),
    severities: Object.freeze(severities),
    // The one sentence this whole section exists to support.
    note:
      'A null is a measurement that could not be taken. It is never a zero, and no figure in this response substitutes one for the other.',
  })
}
