/**
 * A tiny glob matcher for the routing deny and allow lists.
 *
 * `routing.denyGlobs` is a security control, not a convenience, so it has to be matched rather
 * than merely documented. That rules out shelling out to a library (zero dependencies) and rules
 * out `node:path` (this module is on the purity list — no builtin, no I/O, no clock).
 *
 * Three decisions that look arbitrary and are not:
 *
 *  1. MATCHING IS CASE-INSENSITIVE, via lower-casing both sides. The list exists to protect
 *     secrets, and NTFS and APFS are case-insensitive. A case-sensitive matcher lets `.ENV`
 *     through on the platform where it is literally the same file.
 *
 *  2. `**` MATCHES ZERO OR MORE SEGMENTS. The pattern for dotenv files therefore matches `.env`
 *     at the repository root as well as `a/b/.env`. The one-or-more reading would leave the most
 *     obvious secret in the repo unprotected by the most obvious pattern for it.
 *
 *  3. BRACES, CHARACTER CLASSES AND NEGATION ARE NOT SUPPORTED, LOUDLY. A pattern like
 *     `**` + `/*.{pem,key}` is one a reasonable person writes, and silently matching nothing
 *     would be a safety hole with no symptom. Such a pattern is matched literally AND reported
 *     through unsupportedSyntax(), which the router surfaces as an input warning.
 *
 * No catastrophic backtracking is possible by construction: the only quantified atoms emitted
 * are `[^/]*`, `[^/]`, `.*` and a single `(?:.*\/)?` per `**` segment.
 */

/** Characters whose glob meaning we do not implement. A pattern containing one is matched literally. */
const UNSUPPORTED = /[{}[\]!()]/

/** Bounded so a hostile config cannot grow the cache without limit. */
const CACHE_LIMIT = 256
const PATTERN_MAX_CHARS = 1024
const cache = new Map()

/**
 * One spelling for a path: forward slashes, no duplicate separators, no trailing separator,
 * lower-cased. Comparing anything else means comparing two spellings of the same file.
 */
export function normalizeSlashes(p) {
  if (typeof p !== 'string' || p === '') return ''
  const flat = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const trimmed = flat.length > 1 ? flat.replace(/\/+$/, '') : flat
  return trimmed.toLowerCase()
}

/** True when `pattern` uses syntax this matcher does not implement. */
export function unsupportedSyntax(pattern) {
  return typeof pattern === 'string' && UNSUPPORTED.test(pattern)
}

/**
 * Compile a glob to an anchored RegExp. Returns null for anything unusable, so a bad pattern
 * degrades to "matches nothing" rather than throwing out of a hook.
 */
export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern === '' || pattern.length > PATTERN_MAX_CHARS) return null
  const hit = cache.get(pattern)
  if (hit !== undefined) return hit

  const glob = normalizeSlashes(pattern)
  let out = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      // A `**` followed by a separator spans zero or more whole segments; a trailing `**`
      // spans the rest of the path, separators included.
      i += 2
      if (glob[i] === '/') {
        i += 1
        out += '(?:.*\\/)?'
      } else {
        out += '.*'
      }
    } else if (c === '*') {
      out += '[^/]*'
      i += 1
    } else if (c === '?') {
      out += '[^/]'
      i += 1
    } else {
      // Everything else, including the unsupported metacharacters, is a literal.
      out += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&')
      i += 1
    }
  }
  out += '$'

  let re = null
  try {
    re = new RegExp(out)
  } catch {
    re = null
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(pattern, re)
  return re
}

/** True when the normalized `path` matches `pattern`. */
export function matchesGlob(pattern, path) {
  const re = globToRegExp(pattern)
  if (re === null) return false
  const p = normalizeSlashes(path)
  return p !== '' && re.test(p)
}

/**
 * The FIRST pattern that matches, or null. Returning the pattern rather than a boolean is what
 * lets a decision name which deny rule fired without re-running the scan.
 */
export function matchesAny(patterns, path) {
  if (!Array.isArray(patterns)) return null
  for (const pattern of patterns) {
    if (matchesGlob(pattern, path)) return pattern
  }
  return null
}

/**
 * Strip `projectPath` off the front of `path`, so a pattern like `src/**` works without a
 * leading `**` segment. Returns null when `path` is not under `projectPath`.
 */
export function relativeTo(projectPath, path) {
  const base = normalizeSlashes(projectPath)
  const full = normalizeSlashes(path)
  if (base === '' || full === '' || !full.startsWith(`${base}/`)) return null
  return full.slice(base.length + 1)
}
