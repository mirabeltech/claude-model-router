/**
 * Deterministic quality evaluators.
 *
 * PURE: no filesystem, no network, no clock, no randomness. This module must never gain a `node:`
 * import — `evals.isolation.test.mjs` enforces that statically, the same way
 * `telemetry.isolation.test.mjs` enforces it for `calc.mjs`.
 *
 * THE ONE RULE HERE is the quality analogue of CLAUDE.md #5, "a missing measurement is NULL,
 * never 0":
 *
 *   null  — the question was never asked (no output existed, or the case declared no criteria)
 *   false — the question was asked and answered wrongly
 *
 * Conflating those two is how a seventeen-case corpus, twelve of which refuse to delegate, reports
 * "100% quality" off five answers. `evaluateQuality` owns the distinction; an individual evaluator
 * never sees a null output and so never has to decide.
 *
 * WHAT THESE MEASURE, HONESTLY: a planted fact with decoys is a question whose right answer is
 * known in advance, and that is the only accuracy these evaluators can establish. Everywhere else
 * they measure vocabulary — whether the answer uses the corpus's own names. No evaluator here
 * reads a summary for truth; that is what the deliberately omitted LLM judge would be for, and
 * `docs/evaluation.md` records the contract it would have to meet.
 *
 * `score` exists for reporting and is NEVER thresholded. A 0.8 is not a pass. `pass` is the only
 * field a gate reads, because a tunable cutoff is a routing decision wearing a measurement's hat.
 */

/* ------------------------------------------------------------------- primitives */

const isNonEmptyString = (v) => typeof v === 'string' && v !== ''
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString)

/** The shortest forbidden phrase accepted without an explicit override. */
export const FORBIDDEN_MIN_CHARS = 4

const lower = (s) => s.toLowerCase()

/** Case-insensitive substring. Deliberately not word-boundary: identifiers appear inside prose. */
function contains(haystack, needle) {
  return lower(haystack).includes(lower(needle))
}

/** Count non-overlapping occurrences without building a RegExp out of untrusted text. */
function occurrences(haystack, needle) {
  const h = lower(haystack)
  const n = lower(needle)
  if (n === '') return 0
  let count = 0
  let at = h.indexOf(n)
  while (at !== -1) {
    count += 1
    at = h.indexOf(n, at + n.length)
  }
  return count
}

/**
 * Does `text` cite `n` as a standalone integer?
 *
 * An adjacent digit always disqualifies a match, so line 7 is not found inside "17" or "71".
 *
 * A dot is trickier, and getting it wrong costs a false negative in both directions. "7.2" and
 * "v0.7" must not count, but "declared on line 700." must — a sentence-ending period is the most
 * natural way to cite a line, and rejecting it would fail a correct answer. So a dot disqualifies
 * only when it is a DECIMAL POINT, which is to say only when a digit sits on its far side.
 */
function citesNumber(text, n) {
  const s = String(n)
  const digit = (c) => c !== undefined && c !== '' && /[0-9]/.test(c)

  let at = text.indexOf(s)
  while (at !== -1) {
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + s.length] ?? ''
    // A decimal point before the match means a fractional part: "0.700". After it, "700.5".
    const decimalBefore = before === '.' && digit(text[at - 2])
    const decimalAfter = after === '.' && digit(text[at + s.length + 1])
    if (!digit(before) && !digit(after) && !decimalBefore && !decimalAfter) return true
    at = text.indexOf(s, at + 1)
  }
  return false
}

/** Is `needle` present in any corpus file? The corpus is the authority on what exists. */
function inCorpus(ctx, needle) {
  const files = ctx?.files
  if (!files || typeof files.values !== 'function') return false
  for (const content of files.values()) {
    if (typeof content === 'string' && contains(content, needle)) return true
  }
  return false
}

/**
 * One evaluator's verdict.
 *
 * `found` and `missing` are what make a failure actionable without re-running anything: a bare
 * `pass: false` sends the reader back to the corpus to work out which term it was.
 */
function verdict(kind, { pass, found = [], missing = [], detail = null, score = null }) {
  const total = found.length + missing.length
  return Object.freeze({
    kind,
    pass,
    score: score !== null ? score : total === 0 ? 1 : found.length / total,
    found: Object.freeze([...found]),
    missing: Object.freeze([...missing]),
    detail,
  })
}

/* -------------------------------------------------------------------- the table */

/**
 * Seven kinds. Each is `{validate(spec) -> string[], run(output, spec, ctx) -> Verdict}`, and a
 * `validate` returning a non-empty array makes the whole case unloadable rather than silently
 * skipping the criterion.
 *
 * Two deviations from the brief's list, both argued in docs/evaluation.md:
 *
 *   `structuredOutput` is DROPPED. BULK_READER_SYSTEM asks for prose, so no shipped prompt
 *   produces JSON, and an evaluator with no case is dead code that reads as coverage.
 *
 *   `lineCitations` is ADDED. BULK_READ_TASK asks for "every significant declaration with the
 *   line it is on", and a confidently wrong line number is the most common worker failure.
 *   Nothing else in this table would catch it.
 */
export const EVALUATORS = Object.freeze({
  /** Vocabulary. Tests that the answer uses the corpus's words, not that it understood them. */
  requiredTerms: Object.freeze({
    validate: (spec) => (isStringList(spec) ? [] : ['requiredTerms must be a non-empty array of strings']),
    run: (output, spec) => {
      const found = spec.filter((t) => contains(output, t))
      const missing = spec.filter((t) => !contains(output, t))
      return verdict('requiredTerms', { pass: missing.length === 0, found, missing })
    },
  }),

  /**
   * Negated vocabulary, and the kind most prone to false positives — which is why a term shorter
   * than FORBIDDEN_MIN_CHARS is rejected at load unless the case says `allowShort`. A bare "3"
   * matches a line number, a version and a byte count, and a gate nobody trusts is not a gate.
   */
  forbiddenTerms: Object.freeze({
    validate: (spec) => {
      if (isStringList(spec)) {
        const short = spec.filter((t) => t.length < FORBIDDEN_MIN_CHARS)
        return short.length === 0
          ? []
          : [`forbiddenTerms under ${FORBIDDEN_MIN_CHARS} chars need the {terms, allowShort} form: ${short.join(', ')}`]
      }
      if (spec && typeof spec === 'object' && !Array.isArray(spec) && isStringList(spec.terms)) {
        return spec.allowShort === true ? [] : ['forbiddenTerms object form requires allowShort: true']
      }
      return ['forbiddenTerms must be a non-empty array of strings, or {terms, allowShort}']
    },
    run: (output, spec) => {
      const terms = Array.isArray(spec) ? spec : spec.terms
      const violated = terms.filter((t) => contains(output, t))
      const clean = terms.filter((t) => !contains(output, t))
      return verdict('forbiddenTerms', {
        pass: violated.length === 0,
        found: clean,
        missing: violated,
        detail: violated.length === 0 ? null : `present but forbidden: ${violated.join(', ')}`,
        score: terms.length === 0 ? 1 : clean.length / terms.length,
      })
    },
  }),

  /**
   * An identifier must appear in the answer AND exist in the corpus. The second half is what makes
   * this more than `requiredTerms`: it fails a case whose own expectation names something the
   * fixtures do not contain, so a typo in the corpus surfaces as a corpus bug rather than as a
   * worker failure.
   */
  requiredEntities: Object.freeze({
    validate: (spec) => (isStringList(spec) ? [] : ['requiredEntities must be a non-empty array of strings']),
    run: (output, spec, ctx) => {
      const found = []
      const missing = []
      const unverifiable = []
      for (const e of spec) {
        if (!inCorpus(ctx, e)) unverifiable.push(e)
        else if (contains(output, e)) found.push(e)
        else missing.push(e)
      }
      return verdict('requiredEntities', {
        pass: missing.length === 0 && unverifiable.length === 0,
        found,
        missing: [...missing, ...unverifiable],
        detail:
          unverifiable.length === 0 ? null : `not present in the corpus at all: ${unverifiable.join(', ')}`,
      })
    },
  }),

  /**
   * Did the answer cite the files it was given? Weak on its own — an answer that names everything
   * passes — so a case pairing this with `counts` is the useful shape.
   */
  fileReferences: Object.freeze({
    validate: (spec) => (isStringList(spec) ? [] : ['fileReferences must be a non-empty array of paths']),
    run: (output, spec) => {
      const base = (p) => p.split('/').pop()
      const found = spec.filter((p) => contains(output, base(p)))
      const missing = spec.filter((p) => !contains(output, base(p)))
      return verdict('fileReferences', { pass: missing.length === 0, found, missing })
    },
  }),

  /**
   * Occurrence counts, ALWAYS as a range. An exact count is brittle to phrasing — "two handlers",
   * "2 handlers" and "a pair of handlers" are the same answer — so a bare `expected` is rejected
   * at load rather than producing a failure the worker could not have avoided.
   */
  counts: Object.freeze({
    validate: (spec) => {
      if (!Array.isArray(spec) || spec.length === 0) return ['counts must be a non-empty array']
      const problems = []
      for (const c of spec) {
        if (!c || typeof c !== 'object') {
          problems.push('each counts entry must be an object')
          continue
        }
        if (Object.hasOwn(c, 'expected')) {
          problems.push(`counts entry "${c.term}" uses an exact expected; use min and/or max instead`)
        }
        if (!isNonEmptyString(c.term)) problems.push('each counts entry needs a non-empty term')
        const hasMin = Number.isInteger(c.min)
        const hasMax = Number.isInteger(c.max)
        if (!hasMin && !hasMax) problems.push(`counts entry "${c.term}" needs min, max, or both`)
        if (hasMin && hasMax && c.min > c.max) problems.push(`counts entry "${c.term}" has min greater than max`)
      }
      return problems
    },
    run: (output, spec) => {
      const found = []
      const missing = []
      for (const c of spec) {
        const n = occurrences(output, c.term)
        const okMin = !Number.isInteger(c.min) || n >= c.min
        const okMax = !Number.isInteger(c.max) || n <= c.max
        const label = `${c.term}=${n} (min=${c.min ?? '-'} max=${c.max ?? '-'})`
        if (okMin && okMax) found.push(label)
        else missing.push(label)
      }
      return verdict('counts', { pass: missing.length === 0, found, missing })
    },
  }),

  /**
   * A planted fact. `mustAppearInFiles` is the half that catches fabrication: a value present in
   * the answer and absent from the corpus is invented, whatever else is true of it.
   *
   * What this CANNOT check is a relation — "X calls Y" — because that needs a parser, and parsing
   * TypeScript with zero dependencies is not on the table.
   */
  exactFacts: Object.freeze({
    validate: (spec) => {
      if (isStringList(spec)) return []
      if (!Array.isArray(spec) || spec.length === 0) return ['exactFacts must be a non-empty array']
      const problems = []
      for (const f of spec) {
        if (isNonEmptyString(f)) continue
        if (!f || typeof f !== 'object' || !isNonEmptyString(f.literal)) {
          problems.push('each exactFacts entry must be a string, or {literal, mustAppearInFiles}')
        }
      }
      return problems
    },
    run: (output, spec, ctx) => {
      const found = []
      const missing = []
      for (const raw of spec) {
        const literal = typeof raw === 'string' ? raw : raw.literal
        const mustExist = typeof raw === 'string' ? true : raw.mustAppearInFiles !== false
        const inOutput = contains(output, literal)
        const exists = !mustExist || inCorpus(ctx, literal)
        if (inOutput && exists) found.push(literal)
        else missing.push(exists ? literal : `${literal} (not in the corpus)`)
      }
      return verdict('exactFacts', { pass: missing.length === 0, found, missing })
    },
  }),

  /**
   * The line number a declaration is on, with decoys.
   *
   * A citation passes only when the answer names the fact, cites the right line as a standalone
   * integer, and cites none of the declared decoy lines. The decoys are what make this falsifiable:
   * without them, an answer listing every number from 1 to 900 would pass.
   */
  lineCitations: Object.freeze({
    validate: (spec) => {
      if (!Array.isArray(spec) || spec.length === 0) return ['lineCitations must be a non-empty array']
      const problems = []
      for (const c of spec) {
        if (!c || typeof c !== 'object') {
          problems.push('each lineCitations entry must be an object')
          continue
        }
        if (!isNonEmptyString(c.fact)) problems.push('each lineCitations entry needs a non-empty fact')
        if (!Number.isInteger(c.line) || c.line < 1) {
          problems.push(`lineCitations entry "${c.fact}" needs an integer line of at least 1`)
        }
        if (Object.hasOwn(c, 'decoyLines')) {
          const d = c.decoyLines
          if (!Array.isArray(d) || !d.every((n) => Number.isInteger(n) && n >= 1)) {
            problems.push(`lineCitations entry "${c.fact}" has a malformed decoyLines`)
          } else if (d.includes(c.line)) {
            problems.push(`lineCitations entry "${c.fact}" lists its own line as a decoy`)
          }
        }
      }
      return problems
    },
    run: (output, spec) => {
      const found = []
      const missing = []
      for (const c of spec) {
        const decoys = (c.decoyLines ?? []).filter((n) => citesNumber(output, n))
        const namesFact = contains(output, c.fact)
        const citesRight = citesNumber(output, c.line)
        if (namesFact && citesRight && decoys.length === 0) {
          found.push(`${c.fact}@${c.line}`)
        } else {
          const why = !namesFact
            ? 'fact absent'
            : !citesRight
              ? `line ${c.line} not cited`
              : `decoy lines cited: ${decoys.join(', ')}`
          missing.push(`${c.fact}@${c.line} (${why})`)
        }
      }
      return verdict('lineCitations', { pass: missing.length === 0, found, missing })
    },
  }),
})

/**
 * Derived, never re-typed. `schema.mjs` validates a case's criteria keys against this, so a kind
 * added here is accepted by the loader in the same commit, and a kind removed here stops being
 * accepted — the discipline DISPATCH_ERROR_CODES uses to stay in step with ERROR_CODES.
 */
export const EVALUATOR_KINDS = Object.freeze(Object.keys(EVALUATORS))

/* ------------------------------------------------------------- quality verdicts */

export const QUALITY_REASONS = Object.freeze(['no_output', 'no_criteria', 'empty_output', 'evaluated'])

/**
 * Validate a whole `qualityCriteria` block. Returns problem strings; empty means usable.
 *
 * Called by the loader, not by the runner: a malformed criterion is a corpus bug that must fail
 * loudly at load, never a criterion that quietly does not run.
 */
export function validateCriteria(criteria) {
  if (criteria === null || criteria === undefined) return []
  if (typeof criteria !== 'object' || Array.isArray(criteria)) return ['qualityCriteria must be an object']
  const problems = []
  const kinds = Object.keys(criteria)
  if (kinds.length === 0) problems.push('qualityCriteria is present but empty')
  for (const kind of kinds) {
    const impl = EVALUATORS[kind]
    if (!impl) {
      problems.push(`unknown quality criterion "${kind}"; known kinds: ${EVALUATOR_KINDS.join(', ')}`)
      continue
    }
    for (const p of impl.validate(criteria[kind])) problems.push(p)
  }
  return problems
}

/**
 * Grade one answer.
 *
 * @param {string|null} output     the worker's text. `null` means NO OUTPUT EXISTED.
 * @param {object|null} criteria   the case's `qualityCriteria`
 * @param {{case?: object, files?: Map<string,string>}} [ctx]
 * @returns {Readonly<{quality: boolean|null, reason: string,
 *                     results: ReadonlyArray<object>, failed: ReadonlyArray<string>,
 *                     score: number|null}>}
 */
export function evaluateQuality(output, criteria, ctx = {}) {
  const none = (reason) =>
    Object.freeze({ quality: null, reason, results: Object.freeze([]), failed: Object.freeze([]), score: null })

  // Order matters. "No criteria" is checked first because a case with nothing to measure is
  // ungraded whether or not the worker answered, and reporting it as `no_output` would blame the
  // worker for the corpus's silence.
  if (criteria === null || criteria === undefined) return none('no_criteria')
  if (typeof criteria !== 'object' || Array.isArray(criteria) || Object.keys(criteria).length === 0) {
    return none('no_criteria')
  }
  if (typeof output !== 'string') return none('no_output')

  // An empty string is a MEASURED empty answer, not an absent one — the same zero-versus-null
  // distinction the telemetry layer makes, and the same call run.mjs makes when it downgrades
  // outcome `delegated` to `empty_answer`. It fails rather than abstaining.
  if (output === '') {
    return Object.freeze({
      quality: false,
      reason: 'empty_output',
      results: Object.freeze([]),
      failed: Object.freeze(Object.keys(criteria).sort()),
      score: 0,
    })
  }

  const results = []
  for (const kind of Object.keys(criteria).sort()) {
    results.push(EVALUATORS[kind].run(output, criteria[kind], ctx))
  }
  const failed = results
    .filter((r) => !r.pass)
    .map((r) => r.kind)
    .sort()
  const score = results.reduce((sum, r) => sum + r.score, 0) / results.length

  return Object.freeze({
    quality: failed.length === 0,
    reason: 'evaluated',
    results: Object.freeze(results),
    failed: Object.freeze(failed),
    score,
  })
}

/* --------------------------------------------------------- the advisory lexicon */

/**
 * Tokens that are never evidence of invention: language keywords, the builtins, the type
 * vocabulary, and the words BULK_READER_SYSTEM itself puts in the worker's mouth.
 *
 * This list exists only for the ADVISORY `no_invented_entities` gate. It is not a gate's
 * authority — see gates.mjs for why that gate can never be promoted to one.
 */
export const COMMON_LEXICON = Object.freeze(
  new Set([
    'const', 'let', 'var', 'function', 'functions', 'return', 'class', 'classes', 'extends',
    'import', 'imports', 'export', 'exports', 'from', 'default', 'async', 'await', 'yield', 'new',
    'this', 'super', 'typeof', 'instanceof', 'void', 'delete', 'for', 'while', 'if', 'else',
    'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'interface', 'type',
    'types', 'enum', 'namespace', 'declare', 'implements', 'readonly', 'public', 'private',
    'protected', 'static', 'abstract', 'satisfies', 'keyof', 'infer', 'string', 'number',
    'boolean', 'object', 'symbol', 'bigint', 'null', 'undefined', 'any', 'unknown', 'never',
    'true', 'false', 'promise', 'array', 'map', 'set', 'date', 'json', 'math', 'error', 'regexp',
    'buffer', 'console', 'process', 'require', 'module', 'the', 'and', 'that', 'file', 'files',
    'line', 'lines', 'name', 'names', 'declaration', 'declarations', 'purpose', 'structure',
    'summary', 'method', 'methods', 'constant', 'constants', 'engineer', 'significant',
    'paraphrase', 'invent', 'content', 'parameter', 'parameters', 'argument', 'arguments',
    'returns', 'value', 'values', 'field', 'fields', 'module', 'modules',
  ]),
)

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g

/**
 * Every identifier-shaped token in a text, lower-cased. A tokenizer, not a parser: zero
 * dependencies, deterministic, and fast enough to run over 50 KB per case.
 */
export function tokenize(text) {
  const out = new Set()
  if (typeof text !== 'string') return out
  for (const m of text.matchAll(IDENTIFIER_RE)) out.add(lower(m[0]))
  return out
}

/**
 * Tokens in CODE position only — inside backticks or quotes, or shaped in a way prose does not
 * produce (camelCase with an inner capital, snake_case, SCREAMING_SNAKE, Thing.method, foo()).
 *
 * Scanning prose instead would return "purpose", "structure" and "declaration" on the first run,
 * and the advisory would die of false positives the same day.
 */
export function codePositionTokens(text) {
  const out = new Set()
  if (typeof text !== 'string') return out

  const spans = []
  for (const m of text.matchAll(/`([^`\n]{1,200})`/g)) spans.push(m[1])
  for (const m of text.matchAll(/"([^"\n]{1,200})"/g)) spans.push(m[1])
  for (const m of text.matchAll(/'([^'\n]{1,200})'/g)) spans.push(m[1])
  for (const span of spans) {
    for (const t of tokenize(span)) out.add(t)
  }

  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*\s*\(\)/g)) {
    for (const t of tokenize(m[0])) out.add(t)
  }
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g)) out.add(lower(m[0]))
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g)) out.add(lower(m[0]))
  for (const m of text.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
    for (const t of tokenize(m[0])) out.add(t)
  }

  return out
}
