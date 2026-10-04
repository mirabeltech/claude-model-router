/**
 * Timing helpers, shared by the latency test and the evaluation framework.
 *
 * Hoisted out of `hook.latency.test.mjs`, which defined `median()` inline, because the eval now
 * reports the same measurements. Two definitions of one number is how a budget assertion and a
 * benchmark table come to disagree about what they measured.
 *
 * MEASUREMENTS FROM THIS MODULE ARE MACHINE-DEPENDENT and nothing asserts an exact value against
 * them. The latency test asserts loose budgets; the eval records the numbers and stamps the
 * artifact `deterministic: false`. A flaky performance test gets deleted rather than fixed, so the
 * assertions that consume these stay generous on purpose.
 */

/**
 * Median of `runs` timings in milliseconds.
 *
 * A median rather than a mean: one scheduling hiccup, one GC pause or one antivirus scan moves a
 * mean and barely touches a median, and on a shared CI runner at least one of those is certain.
 */
export async function median(runs, fn) {
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint()
    await fn()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

/**
 * Median, p95 and n together, for a series the eval reports rather than asserts.
 *
 * p95 is taken by nearest-rank on the sorted samples — with the sample counts here (tens, not
 * thousands) an interpolated percentile would imply a precision the measurement does not have.
 */
export async function series(runs, fn) {
  const samples = []
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint()
    await fn()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return summarizeSamples(samples)
}

/** Summarise samples already collected elsewhere, e.g. a dispatcher's own `latencyMs`. */
export function summarizeSamples(raw) {
  const samples = raw.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (samples.length === 0) {
    // Null, not zero. "We took no samples" and "it took no time" are different claims.
    return { n: 0, median: null, p95: null, min: null, max: null }
  }
  const at = (q) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(q * samples.length) - 1))]
  return {
    n: samples.length,
    median: samples[Math.floor((samples.length - 1) / 2)],
    p95: at(0.95),
    min: samples[0],
    max: samples[samples.length - 1],
  }
}
