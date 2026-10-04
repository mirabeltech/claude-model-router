/**
 * ONE import scanner, stronger than every per-directory copy of the regex it is meant to replace.
 *
 * WHY THIS EXISTS. There are EIGHT copies of an `importsOf` regex under `test/`, in FOUR distinct
 * bodies, and two of them are measurably weaker than the rest. Measured against the 199 distinct
 * resolvable edges in `plugins/**` + `scripts/**`:
 *
 *   body A  governance / analytics / evals / dashboard isolation   misses  0
 *   body B  telemetry.isolation.test.mjs, hook.security.test.mjs   misses 23
 *   body C  routing.capability.test.mjs                           misses  3
 *   body D  test/evals/gates.mjs scanForCapability                misses  1
 *
 * Body B cannot see a multi-line `import {\n ... \n} from '...'`, and two of those 23 misses are
 * load-bearing rather than cosmetic:
 *
 *   - the dispatch allowlist never sees dispatch/index.mjs -> ./contract.mjs, nor
 *     -> ../context-budget.mjs. Both ARE on the allowlist, so that test is correct today BY LUCK.
 *   - the routing-purity test cannot see a multi-line `import {\n ... \n} from 'node:fs'`.
 *     CLAUDE.md's second non-negotiable is currently protected by a DIFFERENT file's raw-source
 *     /node:/ check rather than by the test whose stated job it is.
 *
 * Body D has no `export ... from` pattern at all, and its output gates a non-advisory security
 * gate.
 *
 * WHY A LEXER AND NOT A BETTER REGEX. Comment-stripping is not sufficient, because the false
 * positives in this repository are in CODE, inside string literals:
 *
 *   test/evals/evaluators.mjs        a keyword stoplist containing 'import', 'from', 'export'
 *   test/evals.determinism.test.mjs  source.includes("from '../../../plugins/.../record.mjs'")
 *   test/evals.gates.test.mjs        "const a = await import('node:child_process')\n..."
 *
 * All three were produced by a strip-comments-then-regex first draft. So string literals are
 * replaced by an OPAQUE PLACEHOLDER before any pattern runs, and the specifier is recovered by
 * index: a keyword inside a string is no longer a keyword. Regex literals are dropped whole,
 * because a quote inside one desynchronises a naive scanner for the rest of the file.
 *
 * A SUBSTITUTED TEMPLATE IS NOT A MISS. A dynamic import of a built-up path is an edge this
 * scanner cannot resolve. It is reported in `computed` so a caller can REFUSE it, rather than
 * silently losing it.
 *
 * MEASURED over every .mjs file in the repository: zero bogus specifiers, zero bare specifiers
 * that are not `node:*`, and a strict superset of all four existing bodies on every product file.
 */

/** Placeholder sentinel for a string literal. Cannot occur in source: a C0 control character. */
const MARK = '\u0001'

/**
 * Placeholder for a template literal that HAS a substitution, and so is not a resolvable
 * specifier. A distinct sentinel rather than a shared one, because such a template is only worth
 * reporting when it sits in an import position: a built-up path in a log message is not an edge,
 * and this repository has 172 substituted templates against 0 dynamic specifiers.
 */
const TMPL = '\u0002'

/**
 * Replace comments and regex literals with whitespace, and string literals with a placeholder.
 *
 * @param {string} src
 * @returns {{code: string, strings: string[]}}
 */
export function lex(src) {
  const strings = []
  let out = ''
  let i = 0
  // The last significant code character, which is how regex-vs-division is decided.
  let prev = ''
  const n = src.length
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r'
  const push = (c) => {
    out += c
    if (!isSpace(c)) prev = c
  }
  const emit = (raw) => {
    strings.push(raw)
    out += `${MARK}${strings.length - 1}${MARK}`
    prev = MARK
  }

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      out += ' '
      continue
    }
    if (c === '"' || c === "'") {
      i += 1
      let raw = ''
      let closed = false
      while (i < n) {
        if (src[i] === '\\') {
          raw += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (src[i] === c) {
          closed = true
          break
        }
        // An unterminated literal is a syntax error, not an edge. Stop at the line end.
        if (src[i] === '\n') break
        raw += src[i]
        i += 1
      }
      if (closed) i += 1
      emit(raw)
      continue
    }
    if (c === '`') {
      i += 1
      let raw = ''
      let substituted = false
      while (i < n) {
        if (src[i] === '\\') {
          raw += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          substituted = true
          let depth = 1
          i += 2
          while (i < n && depth > 0) {
            if (src[i] === '{') depth += 1
            else if (src[i] === '}') depth -= 1
            i += 1
          }
          continue
        }
        if (src[i] === '`') break
        raw += src[i]
        i += 1
      }
      i += 1
      if (substituted) {
        // Marked rather than dropped: in an import position this must be able to FAIL a graph.
        out += TMPL
        prev = TMPL
      } else {
        // A no-substitution template is a legal specifier.
        emit(raw)
      }
      continue
    }
    // A regex literal. Dropped whole: it can contain quotes, slashes and import-shaped text.
    if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      i += 1
      let inClass = false
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) break
        else if (src[i] === '\n') break
        i += 1
      }
      i += 1
      while (i < n && /[dgimsuvy]/.test(src[i])) i += 1
      out += ' 0 '
      prev = '0'
      continue
    }
    push(c)
    i += 1
  }
  return { code: out, strings }
}

/**
 * The import clause: identifiers, braces, commas, `as`, `*`, whitespace.
 *
 * NOT an unconstrained span. That is what let `source.includes("from '...'")` be read as an import
 * in the first draft: an unconstrained span crosses a statement boundary and joins an unrelated
 * `import` to an unrelated `from`.
 */
const CLAUSE = '[A-Za-z0-9_$,{}\\s*]*?'
const REF = `${MARK}(\\d+)${MARK}`

const FORMS = Object.freeze([
  // import x from 'a' / import {a, b as c} from 'a' / export * from 'a' / export {a} from 'a'
  new RegExp(`\\b(?:import|export)\\b${CLAUSE}\\bfrom\\s*${REF}`, 'g'),
  // import 'a' — the bare side-effect form
  new RegExp(`\\bimport\\s*${REF}`, 'g'),
  // await import('a')
  new RegExp(`\\bimport\\s*\\(\\s*${REF}`, 'g'),
  // require('a')
  new RegExp(`\\brequire\\s*\\(\\s*${REF}`, 'g'),
])

/**
 * A specifier this scanner cannot resolve, which must FAIL a graph rather than vanish from it.
 *
 * Only `import()` and `require()` are checked, because a STATIC import specifier is required by
 * the grammar to be a string literal. There is no such thing as `import x from someVariable`, so
 * a pattern for that case could only ever produce false positives — `for (const from of list)`
 * matches `from\s+[A-Za-z]`, and this repository contains exactly that shape.
 */
const NON_LITERAL = Object.freeze([
  new RegExp(`\\bimport\\s*\\(\\s*[A-Za-z_$${TMPL}]`, 'g'),
  new RegExp(`\\brequire\\s*\\(\\s*[A-Za-z_$${TMPL}]`, 'g'),
])

/**
 * Every static, dynamic and require specifier in one source text, deduped, in no particular order.
 *
 * @param {string} source
 * @returns {{specs: string[], computed: string[]}}
 */
export function scanImports(source) {
  const { code, strings } = lex(source)
  const specs = new Set()
  for (const re of FORMS) for (const m of code.matchAll(re)) specs.add(strings[Number(m[1])])
  const computed = []
  for (const re of NON_LITERAL) for (const m of code.matchAll(re)) computed.push(m[0].trim())
  return { specs: [...specs], computed }
}

/** The shape the eight existing copies have, so a call site can be swapped one line at a time. */
export const importsOf = (source) => scanImports(source).specs
