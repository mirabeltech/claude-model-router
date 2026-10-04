/**
 * Which rows are in the population. THE DENOMINATOR LIVES HERE AND NOWHERE ELSE.
 *
 * Separated from predicates.mjs on purpose. The two look alike and are not: a SELECTOR decides
 * what the window contains, a PREDICATE decides what a metric counts within it. A single file
 * holding both is how an edit meant for a numerator silently moves a denominator, and the
 * delegation rate is precisely the metric that would then report a different number for the same
 * store without anybody noticing.
 *
 * EVERY SCOPE FILTER IS EQUALITY ON A STORED SCALAR. No globbing, no regex, no free-text search.
 * Searching a telemetry store is a different feature with a different threat model, and a regex
 * filter here would be a way to probe fields this layer is explicitly not allowed to surface —
 * `--provider '.*'` is harmless, but a filter language is a short step from a predicate over
 * `question_text`.
 *
 * A row is sorted into exactly one of four verdicts, and three of them are counted rather than
 * merged. `undatable` in particular is NOT `out_of_window`: a row with an unparseable timestamp
 * has not been excluded by the window, it has failed to say when it happened, and folding the two
 * together would make a corrupted clock look like a quiet afternoon.
 */

import { inWindow, rowInstantMs } from './window.mjs'
import { MODE_ALIASES } from './schema.mjs'

/**
 * The scope filters, with the column each one tests.
 *
 * `mode` is the odd one out and is handled separately: there is no `mode` column in schema
 * version 1, so it resolves onto `task_type` through {@link MODE_ALIASES}.
 */
export const SCOPE_FIELDS = Object.freeze({
  provider: 'provider',
  model: 'model',
  projectId: 'project_id',
  sessionId: 'session_id',
  taskType: 'task_type',
  status: 'status',
  routingReason: 'routing_reason',
  errorCode: 'error_code',
})

/** The verdicts a selector can return. Each is counted separately in `coverage`. */
export const VERDICTS = Object.freeze(['in', 'undatable', 'out_of_window', 'out_of_scope'])

/**
 * Resolve a requested scope into the filters that will actually be applied, plus whatever could
 * not be resolved.
 *
 * `--mode bulk-reader` becomes `task_type === 'bulk_read'`, and the response echoes that so
 * nobody has to guess which column was consulted. An unrecognised mode is NOT silently dropped
 * and NOT silently matched: it resolves to a filter that selects nothing, with a warning. Enums
 * are open on read, so a mode this build does not know might be a real value in a newer store —
 * matching everything would be worse than matching nothing, because it would answer a different
 * question without saying so.
 */
export function describeScope(scope = {}) {
  const filters = {}
  const warnings = []

  for (const [key, field] of Object.entries(SCOPE_FIELDS)) {
    const value = scope[key]
    if (value === undefined || value === null || value === '') continue
    filters[field] = String(value)
  }

  if (scope.mode !== undefined && scope.mode !== null && scope.mode !== '') {
    const requested = String(scope.mode)
    const resolved = MODE_ALIASES[requested]
    if (resolved === undefined) {
      warnings.push({
        scope: 'mode',
        value: requested,
        reason: `unknown worker mode; known modes are ${Object.keys(MODE_ALIASES).join(', ')}`,
      })
      // A filter that matches nothing, rather than one that matches everything. See above.
      filters.task_type = `\u0000unmatchable:${requested}`
    } else if (filters.task_type !== undefined && filters.task_type !== resolved) {
      warnings.push({
        scope: 'mode',
        value: requested,
        reason: `conflicts with the requested taskType ${filters.task_type}; nothing can match both`,
      })
      filters.task_type = `\u0000unmatchable:${requested}`
    } else {
      filters.task_type = resolved
    }
  }

  return {
    // What was asked for, verbatim, so a report can repeat the question back.
    requested: Object.freeze({ ...scope }),
    // What is actually tested, by stored column name. This is the honest record.
    filters: Object.freeze(filters),
    warnings: Object.freeze(warnings),
    active: Object.keys(filters).length > 0,
  }
}

/**
 * Build the row selector for a window and a scope.
 *
 * Returns `(row) => verdict`. The window is tested before the scope so an out-of-range row is
 * never attributed to a filter the operator set, which matters when they are narrowing a scope to
 * find out why a number is zero.
 */
export function buildSelector({ timeRange, scope = {} }) {
  const described = scope.filters ? scope : describeScope(scope)
  const entries = Object.entries(described.filters)

  return function select(row) {
    const ms = rowInstantMs(row)
    if (ms === null) return 'undatable'
    if (!inWindow(timeRange, ms)) return 'out_of_window'
    for (const [field, want] of entries) {
      // Compared as strings so a stored null never equals a requested '' by coercion, and so a
      // numeric-looking model id matches the way it was typed.
      if (String(row?.[field] ?? '\u0000null') !== want) return 'out_of_scope'
    }
    return 'in'
  }
}

/** A zeroed verdict tally, so every verdict is reported even when it never fired. */
export function emptyVerdictCounts() {
  return { in: 0, undatable: 0, out_of_window: 0, out_of_scope: 0 }
}
