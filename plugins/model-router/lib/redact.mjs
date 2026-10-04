/**
 * Secret scrubbing, shared by every layer that turns an error or a payload into a stored string.
 *
 * This lives at the top of `lib/` rather than inside `providers/` because telemetry needs it too,
 * and a dependency edge from the telemetry layer into the provider layer — purely to borrow a
 * string function — is a dependency edge that will one day carry something heavier. A second copy
 * of the regex set is not an option either: a second copy is a copy that falls behind.
 *
 * Pure, synchronous, no imports. It must stay that way; a test asserts it imports nothing at all.
 */

/**
 * Strip anything key-shaped before an error string is logged or stored.
 * Applied to every provider error detail, not only to telemetry, because an API
 * key echoed into a hook's stderr is just as leaked.
 */
export function redactSecrets(s) {
  if (typeof s !== 'string') return s
  return s
    .replace(/\b(sk-ant-[A-Za-z0-9_\-]{8,})/g, '[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_\-]{16,})/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_\-]{10,}/g, '[redacted]')
    .replace(/\b(gh[pous]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g, '[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\b(\s*[:=]\s*)("?)[^\s"',}]+\3/gi, '$1$2[redacted]')
}
