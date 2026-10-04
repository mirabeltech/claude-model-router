/**
 * Telemetry-boundary coercion. PURE: no filesystem, no network, no logging.
 * This module must never gain a `node:` import — a test enforces that statically.
 *
 * The provider contract's num() guards numbers coming out of a provider. It does NOT cover the
 * numbers telemetry gets from everywhere else: corpus character counts, byte counts, file counts,
 * end-to-end latencies, attempt counts. Those come from the delegation script, and a script bug
 * must not be able to publish a fabricated measurement.
 *
 * THE GOVERNING PRINCIPLE: never clamp a measurement to make it valid.
 *
 * A negative token count becomes null, not 0. Clamping to 0 fabricates a measurement — and
 * specifically fabricates the one (zero worker tokens) that understates worker cost and therefore
 * overstates savings. The only clamp in this file is -0 -> 0, which changes no magnitude.
 *
 * Validation NEVER throws and NEVER drops the event. It nulls the field, records a code, and lets
 * the event through: a hook must not break, and silently discarding the evidence of a bug is
 * worse than storing a row with one null in it.
 */

/**
 * A corrupted byte count turned into dollars is the headline-overstatement failure mode, and a
 * 1e15-token event would dominate every aggregate it appeared in. So there is a ceiling, and
 * exceeding it is treated as corruption rather than as a very large measurement.
 */
export const MAX_PLAUSIBLE_TOKENS = 1e12
export const MAX_PLAUSIBLE_BYTES = 1e12
export const MAX_PLAUSIBLE_MS = 86_400_000 * 7

/**
 * Collects codes without throwing. One instance per event; the counts land on the row as
 * `validation_warnings` and `validation_codes`.
 */
export function createWarnings() {
  const codes = []
  return {
    codes,
    add(code) {
      codes.push(code)
    },
    get count() {
      return codes.length
    },
    /** Sorted and de-duplicated, joined flat — the record is scalar-only, so no array. */
    serialize() {
      if (codes.length === 0) return null
      return [...new Set(codes)].sort().join(',')
    },
  }
}

const noWarn = { add() {} }

/** null and undefined are legitimately absent: no code, no complaint. */
function absent(v) {
  return v === null || v === undefined
}

function check(v, field, warn, { max, requireInteger, allowNegative }) {
  if (absent(v)) return null
  if (typeof v !== 'number') {
    // Strings are never coerced. '1234' means the caller passed raw JSON straight through, and
    // coercing it would hide that bug behind a plausible number.
    warn.add(`type:${field}`)
    return null
  }
  if (!Number.isFinite(v)) {
    warn.add(`nonfinite:${field}`)
    return null
  }
  if (v === 0) return 0 // folds -0 to 0, the one clamp in this file
  if (v < 0 && !allowNegative) {
    warn.add(`negative:${field}`)
    return null
  }
  if (requireInteger && !Number.isInteger(v)) {
    warn.add(`fractional:${field}`)
    return null
  }
  if (max !== undefined && Math.abs(v) > max) {
    warn.add(`implausible:${field}`)
    return null
  }
  return v
}

/**
 * A count a provider reported. Strict: a fractional value means the provider parser is wrong,
 * not that the count is genuinely fractional, so it is refused rather than rounded.
 */
export function toReportedCount(v, field, warn = noWarn) {
  return check(v, field, warn, { max: MAX_PLAUSIBLE_TOKENS, requireInteger: true, allowNegative: false })
}

/**
 * A count an estimator produced. A float is floored rather than refused, because flooring
 * under-counts and under-counting is the safe direction for a savings figure.
 */
export function toEstimatedCount(v, field, warn = noWarn) {
  const n = check(v, field, warn, { max: MAX_PLAUSIBLE_TOKENS, requireInteger: false, allowNegative: false })
  return n === null ? null : Math.floor(n)
}

/** A byte count. Caller-owned and always knowable, so 0 is legitimate. */
export function toByteCount(v, field, warn = noWarn) {
  return check(v, field, warn, { max: MAX_PLAUSIBLE_BYTES, requireInteger: true, allowNegative: false })
}

/**
 * A duration. A negative value means clock skew or a non-monotonic clock, so it is null rather
 * than 0 — "the call took no time" is a different claim from "we failed to measure it".
 */
export function toDurationMs(v, field, warn = noWarn) {
  const n = check(v, field, warn, { max: MAX_PLAUSIBLE_MS, requireInteger: false, allowNegative: false })
  return n === null ? null : Math.round(n)
}

/** Money read back from calc. Any sign: negative savings are a valid result, not a bad reading. */
export function toMoney(v, field, warn = noWarn) {
  if (absent(v)) return null
  if (typeof v !== 'number') {
    warn.add(`type:${field}`)
    return null
  }
  if (!Number.isFinite(v)) {
    warn.add(`nonfinite:${field}`)
    return null
  }
  return v === 0 ? 0 : v
}

/**
 * A signed token delta. Like toMoney but integral: `estimated_tokens_avoided` is negative when a
 * verbose worker answer costs more context than the corpus it replaced.
 */
export function toSignedCount(v, field, warn = noWarn) {
  const n = check(v, field, warn, { max: MAX_PLAUSIBLE_TOKENS, requireInteger: false, allowNegative: true })
  return n === null ? null : Math.trunc(n)
}

/**
 * retry_count from the registry's 1-based `attempts`.
 *
 * Never defaulted to 0: "we do not know how many attempts there were" and "there were no retries"
 * are different facts, and conflating them would make a retry-rate chart quietly wrong.
 */
export function toRetryCount(attempts, warn = noWarn) {
  if (absent(attempts)) return null
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
    warn.add('invalid:attempts')
    return null
  }
  return attempts - 1
}

/** A string field, or null. Non-strings are refused rather than stringified. */
export function toText(v, field, warn = noWarn) {
  if (absent(v)) return null
  if (typeof v !== 'string') {
    warn.add(`type:${field}`)
    return null
  }
  return v
}

/** A boolean field, or null. */
export function toBool(v, field, warn = noWarn) {
  if (absent(v)) return null
  if (typeof v !== 'boolean') {
    warn.add(`type:${field}`)
    return null
  }
  return v
}

/**
 * An open enum. An unrecognized value is PRESERVED, not refused — the convention is that enums
 * are open on read and bucketed as `other` at presentation time. A code is still recorded so a
 * drifting vocabulary is visible.
 */
export function toEnum(v, field, known, warn = noWarn) {
  if (absent(v)) return null
  if (typeof v !== 'string') {
    warn.add(`type:${field}`)
    return null
  }
  if (!known.includes(v)) warn.add(`unknown_enum:${field}`)
  return v
}
