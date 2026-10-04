/**
 * VERIFYING A WORKER'S SUMMARY AGAINST THE FILE IT SUMMARISED.
 *
 * The problem this exists for: a worker's answer replaces the file in Claude's context. If the
 * answer is wrong, Claude's context is wrong, and so is everything Claude does next — and nothing
 * downstream can tell. A delegation that returns a confident fabrication is worse than no
 * delegation at all, because the developer cannot see what was substituted.
 *
 * WHAT MAKES THIS CHECKABLE AT ALL, and why it is not a judge model: WE STILL HAVE THE FILE. The
 * worker's answer makes specific, mechanical claims about it — this identifier is on that line,
 * this string literal appears, this symbol exists — and every one of those can be checked exactly,
 * against the bytes, with no model and no network. This module therefore verifies CLAIMS. It does
 * not grade prose, judge usefulness, or score quality, and it must never be made to: the moment it
 * returns a number that looks like a quality score, CLAUDE.md's sixth rule is broken.
 *
 * THE ASYMMETRY THAT MAKES AN AGGRESSIVE CHECK CORRECT. A false positive here costs one wasted
 * worker call: the summary is discarded and the developer's `Read` happens normally, which is the
 * behaviour they would have had anyway. A false negative puts a fabrication into Claude's context.
 * So the cost of being wrong is wildly lopsided, and the check is tuned accordingly — the opposite
 * of a dashboard metric, where a false positive is noise somebody has to chase.
 *
 * THE THREE CHECKS, in descending confidence, and all three were validated against a real worker
 * (Ollama / mistral:latest) rather than designed on paper:
 *
 *   1. LINE CLAIMS. "`Record1` on line 11" is either true or false, and fabrication misses by a
 *      lot. MEASURED: with a line-numbered prompt the model produced three claims and all three
 *      were exact. With the un-numbered prompt it produced NONE — it silently dropped the part of
 *      the task asking for line numbers, which is why `modes.mjs` now numbers the lines it sends.
 *   2. STRING LITERALS. The task tells the worker to preserve literals exactly as written. A
 *      quoted literal that does not appear in the file was invented.
 *   3. BACKTICKED IDENTIFIERS. Restricted to code position — inside backticks — on purpose. The
 *      eval framework's advisory grounding check scans prose too and documents its own
 *      false-positive rate as roughly one per five cases, from prose casing drift and legitimate
 *      composition. Backticks are explicit: the worker put them there to mark a name it is
 *      quoting, so a backticked token absent from the file is a much stronger signal.
 *
 * PURE, and it imports NOTHING. It is handed two strings and returns a verdict, so it is testable
 * against a real worker's answer with no filesystem, no provider and no clock — and so that it can
 * sit on the hook's hot path without pulling anything onto it.
 */

/** Verdicts. `not_checkable` is NOT a pass: it means the answer made no mechanical claim. */
export const VERIFY_VERDICTS = Object.freeze(['verified', 'suspect', 'not_checkable'])

/**
 * How far a line claim may be off and still count as verified.
 *
 * Not zero, and the reason is real rather than defensive: a declaration with a doc comment above
 * it has two defensible line numbers, and `Record1` at line 11 with its comment on line 10 is the
 * shape half this corpus has. Fabrication misses by tens or hundreds of lines, so a window of two
 * costs nothing in detection and removes an entire class of argument about where a declaration
 * "is".
 */
export const LINE_TOLERANCE = 2

/**
 * The share of line claims that may be wrong before an answer is suspect.
 *
 * A third, which is deliberately generous. MEASURED: a real Gemini answer made 36 line claims and
 * got 34 right (5.6% wrong) while a fabrication got 0 of 3 right (100% wrong). The two populations
 * are nowhere near each other, so a threshold anywhere between them works and the loose end is the
 * safe one — a false positive discards a good answer.
 */
export const MAX_WRONG_LINE_RATIO = 0.34

/**
 * The share of quoted literals that may be absent before an answer is suspect.
 *
 * Also a third, and for a reason the same measurement exposed: a worker summarising a family of
 * near-identical declarations writes `"RecordN requires an id"` as a GENERALISATION of
 * `"Record1 requires an id"` through `"Record17 requires an id"`. That is good summarising and the
 * literal is legitimately absent.
 */
export const MAX_UNGROUNDED_LITERAL_RATIO = 0.34

/** Identifier-shaped, and at least three characters so `id`, `fs` and `of` do not dominate. */
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g

/** Inline code spans. Non-greedy, single-line: a fenced block is not an identifier claim. */
const CODE_SPAN = /`([^`\n]+)`/g

/** Double- and single-quoted literals of at least four characters, which excludes `""` and `'a'`. */
const QUOTED = /"([^"\n]{4,})"|'([^'\n]{4,})'/g

/**
 * A line claim: a line number paired with the code-span identifiers in the same sentence.
 *
 * BOTH ORDERS, because a real worker uses both: "defines an interface `Record1` on line 11" and
 * "On line 11, it defines an interface `Record1`". The second form is why this pairs with CODE
 * SPANS rather than with nearby words — a first draft took the nearest identifier-shaped token and
 * captured "defines", "which" and "The", which is the sort of extractor that makes a verifier look
 * broken when the worker was right.
 */
const LINE_MENTION = /\blines?\s+(\d{1,5})\b/gi

const clamp = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * A sentence that ASSERTS AN ABSENCE, which must never be checked as if it asserted a presence.
 *
 * THE FAILURE THIS FIXES, found against a real Gemini answer. The task asks the worker to "state
 * what the file does not do where that is load-bearing", and it did exactly that:
 *
 *   "No `Record18` implementation: although line 401 contains a doc comment for it, no `Record18`
 *    interface or `normalizeRecord18` function is declared."
 *
 * Every one of those symbols is correctly absent from the file. The first version of this module
 * read the sentence as three fabricated claims and discarded the whole summary — punishing the
 * worker for the single most valuable sentence in it, and for obeying the task.
 *
 * A negated claim is not checkable by "is this symbol present", so it is SKIPPED rather than
 * inverted: confirming an absence would need to rule out every spelling the worker might have
 * meant. Skipping neither confirms nor refutes, which is the honest answer.
 */
const NEGATION = /\b(no|not|never|without|absent|missing|lacks?|lacking|nor|neither|does ?n[o']?t|is ?n[o']?t|are ?n[o']?t|cannot|unimplemented|undeclared|undefined)\b/i

/**
 * Is this sentence asserting an absence?
 *
 * TWO SCOPES, each learned from a case that got it wrong.
 *
 * PROSE ONLY, with code spans and quoted literals stripped: the worker's own quoted content is not
 * the worker's grammar. `"user not found in registry"` is an INVENTED LITERAL inside an ordinary
 * positive claim, and testing the raw sentence found the `not` inside the quotes, decided the
 * sentence asserted an absence, and skipped the check — turning the clearest fabrication signal
 * available into silence.
 *
 * BEFORE THE CLAIM, not anywhere in the sentence. A negation negates what FOLLOWS it:
 *
 *   "No `Record18` interface is declared"                      -> absence, skip the claim
 *   "throws `"Record1 requires an id"` when input has no id"   -> a POSITIVE claim that happens
 *                                                                 to contain a later negation
 *
 * Whole-sentence testing skipped the second one too, and silently stopped checking a literal that
 * was genuinely present. Position is the cheapest signal that separates them without parsing.
 */
const assertsAbsence = (sentence, before = Number.POSITIVE_INFINITY) =>
  NEGATION.test(String(sentence).slice(0, before).replace(CODE_SPAN, ' ').replace(QUOTED, ' '))

/** Split into sentences, keeping it crude: a claim does not span a full stop. */
const sentencesOf = (text) =>
  String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')

/**
 * Verify a worker's answer against the files it was given.
 *
 * @param {object}   a
 * @param {string}   a.answer              the worker's answer, verbatim
 * @param {Array}    a.files               `[{path, content}]` — exactly what the worker was sent
 * @param {number}   [a.lineTolerance]     see LINE_TOLERANCE
 * @param {number}   [a.maxUngroundedRatio] fraction of backticked identifiers that may be absent
 *                                          before the answer is suspect
 * @returns {Readonly<object>}
 */
export function verifySummary({
  answer,
  files,
  lineTolerance = LINE_TOLERANCE,
  maxUngroundedRatio = 0.25,
  maxWrongLineRatio = MAX_WRONG_LINE_RATIO,
  maxUngroundedLiteralRatio = MAX_UNGROUNDED_LITERAL_RATIO,
} = {}) {
  const empty = (reason) =>
    Object.freeze({
      checkable: false,
      verdict: 'not_checkable',
      reason,
      lineClaims: Object.freeze({ total: 0, verified: 0, wrong: 0, examples: Object.freeze([]) }),
      literals: Object.freeze({ total: 0, grounded: 0, ungrounded: 0, examples: Object.freeze([]) }),
      identifiers: Object.freeze({ total: 0, grounded: 0, ungrounded: 0, examples: Object.freeze([]) }),
    })

  if (typeof answer !== 'string' || answer.trim() === '') return empty('no_answer')
  if (!Array.isArray(files) || files.length === 0) return empty('no_files')

  /* ---- the lexicon: everything the worker was actually shown ---- */

  // THE PATHS GO IN TOO. The worker is told the file path and quotes it back, so its segments are
  // legitimately part of the material it was given. Leaving them out flagged `tiny`, `real` and
  // `ts` as invented on the first run against a real answer.
  const lexicon = new Set()
  const pathTokens = new Set()
  const fileLines = []
  let corpus = ''
  for (const file of files) {
    const content = typeof file?.content === 'string' ? file.content : ''
    const path = typeof file?.path === 'string' ? file.path : ''
    corpus += `${content}\n`
    for (const m of `${content}\n${path}`.matchAll(IDENTIFIER)) lexicon.add(m[0].toLowerCase())
    // Separately, because a line claim is checked against LINES and a path has none. A real
    // answer opened with "As documented in lines 1-6 of `medium.ts`", and the filename was read
    // as a symbol claimed to be on line 1 and therefore absent.
    for (const m of path.matchAll(IDENTIFIER)) pathTokens.add(m[0].toLowerCase())
    fileLines.push(...content.split('\n'))
  }
  if (lexicon.size === 0) return empty('no_content')

  /* ---- check 1: line claims ---- */

  const lineClaims = []
  for (const sentence of sentencesOf(answer)) {
    const mentions = [...sentence.matchAll(LINE_MENTION)]
    // A sentence naming several lines cannot be paired unambiguously, and guessing would invent
    // claims the worker never made.
    if (mentions.length !== 1) continue
    const at = mentions[0].index ?? 0

    const spans = [...sentence.matchAll(CODE_SPAN)]
    if (spans.length === 0) continue

    /*
     * ONE CLAIM PER LINE MENTION: the code span NEAREST the words "line N", and no other.
     *
     * This is the single most important line in the file, and it was wrong first time round. A
     * real worker writes "On line 11, it defines an interface `Record1` that extends `Entity`,
     * adding properties `name`, `slug`, `ordinal`, `enabled` and `metadata`" — one line number
     * and nine code spans. Pairing the number with all of them manufactured eight claims the
     * worker did not make, and flagged a summary whose three real line claims were all exact.
     * The properties ARE on lines 12 to 16; nobody said otherwise.
     *
     * Nearest-span handles both orders a worker actually uses — "`Record1` on line 11" and "On
     * line 11, ... `Record1`" — because the subject of the claim sits next to the number either
     * way, while the trailing enumeration does not.
     */
    let best = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const span of spans) {
      const start = span.index ?? 0
      const distance = start > at ? start - at : at - (start + span[0].length)
      if (distance < bestDistance) {
        bestDistance = distance
        best = span
      }
    }
    const first = best === null ? null : best[1].match(IDENTIFIER)
    if (first === null || first.length === 0) continue
    // An absence claim is not a claim that the symbol is on that line.
    if (assertsAbsence(sentence, best.index ?? 0)) continue
    lineClaims.push({ name: first[0], line: Number(mentions[0][1]) })
  }

  let lineVerified = 0
  let lineWrong = 0
  const lineExamples = []
  for (const claim of lineClaims) {
    // A reference to the file's own name is not a claim about its contents.
    if (pathTokens.has(claim.name.toLowerCase())) {
      lineVerified += 1
      continue
    }
    const from = Math.max(0, claim.line - 1 - lineTolerance)
    const to = Math.min(fileLines.length, claim.line + lineTolerance)
    const near = fileLines.slice(from, to).some((l) => l.includes(claim.name))
    if (near) {
      lineVerified += 1
      continue
    }
    lineWrong += 1
    // WHERE IT ACTUALLY IS, because "wrong" without that is not actionable. A name absent from the
    // file entirely is a different and worse failure than a name cited on the wrong line.
    const actual = []
    for (const [i, l] of fileLines.entries()) {
      if (l.includes(claim.name)) actual.push(i + 1)
      if (actual.length >= 3) break
    }
    if (lineExamples.length < 5) {
      lineExamples.push(
        `${claim.name} claimed on line ${claim.line}; ${
          actual.length > 0 ? `actually on ${actual.join(', ')}` : 'absent from the file'
        }`,
      )
    }
  }

  /* ---- check 2: quoted string literals ---- */

  const literals = new Set()
  for (const sentence of sentencesOf(answer)) {
    for (const m of sentence.matchAll(QUOTED)) {
    if (assertsAbsence(sentence, m.index ?? 0)) continue
    const text = (m[1] ?? m[2] ?? '').trim()
    // A literal containing a newline, or one that is plainly a sentence of prose, is not a code
    // literal claim. The length floor plus "no sentence-ending punctuation" is a crude filter and
    // deliberately so: a false ACCEPT here costs nothing, a false REJECT costs a good summary.
    if (text.length >= 4 && !/[.!?]$/.test(text)) literals.add(text)
    }
  }
  /*
   * A literal is grounded VERBATIM, or by overlap — and the second clause is not leniency, it is
   * what tells a GENERALISATION apart from an INVENTION.
   *
   * MEASURED. Summarising a family of near-identical declarations, a real worker wrote
   * `"RecordN requires an id"` to stand for `"Record1 requires an id"` through
   * `"Record17 requires an id"`. That is good summarising and the literal is legitimately absent.
   * A fabrication — `"user not found in registry"` — shares nothing with the file at all.
   *
   * Word overlap separates them cleanly and costs one pass: the generalisation keeps every word
   * but the placeholder, the invention keeps none. Whole-literal substring search would be the
   * obvious alternative and is quadratic against a large corpus for no extra signal.
   */
  const corpusWords = new Set()
  for (const m of corpus.matchAll(/[A-Za-z_$][A-Za-z0-9_$]+/g)) corpusWords.add(m[0].toLowerCase())

  const OVERLAP_FLOOR = 0.7
  let litGrounded = 0
  let litUngrounded = 0
  const litExamples = []
  for (const text of literals) {
    if (corpus.includes(text)) {
      litGrounded += 1
      continue
    }
    // Two characters, not three: `an` and `id` are exactly the words a generalisation keeps and a
    // length-three floor throws away, which left `"RecordN requires an id"` scoring 1 of 2.
    const words = [...text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]+/g)].map((m) => m[0].toLowerCase())
    const hits = words.filter((w) => corpusWords.has(w)).length
    const overlap = words.length === 0 ? 0 : hits / words.length
    if (overlap >= OVERLAP_FLOOR) {
      litGrounded += 1
      continue
    }
    litUngrounded += 1
    if (litExamples.length < 5) litExamples.push(clamp(text))
  }

  /* ---- check 3: backticked identifiers ---- */

  const identifiers = new Set()
  for (const sentence of sentencesOf(answer)) {
    // Same rule as the line claims: "no `Record18` is declared" does not assert that `Record18`
    // exists, so its absence is not evidence of invention.
    for (const span of sentence.matchAll(CODE_SPAN)) {
      if (assertsAbsence(sentence, span.index ?? 0)) continue
      for (const id of span[1].matchAll(IDENTIFIER)) identifiers.add(id[0])
    }
  }
  let idGrounded = 0
  let idUngrounded = 0
  const idExamples = []
  for (const name of identifiers) {
    if (lexicon.has(name.toLowerCase())) idGrounded += 1
    else {
      idUngrounded += 1
      if (idExamples.length < 5) idExamples.push(name)
    }
  }

  /* ---- the verdict ---- */

  const checkable = lineClaims.length + literals.size + identifiers.size > 0
  if (!checkable) {
    return Object.freeze({
      ...empty('no_claims'),
      reason: 'no_claims',
    })
  }

  const ungroundedRatio = identifiers.size === 0 ? 0 : idUngrounded / identifiers.size
  const wrongLineRatio = lineClaims.length === 0 ? 0 : lineWrong / lineClaims.length
  const ungroundedLiteralRatio = literals.size === 0 ? 0 : litUngrounded / literals.size
  const reasons = []

  /*
   * EVERY THRESHOLD IS A RATIO. The first version made one wrong line claim or one absent literal
   * fatal on its own, which was tuned against a worker that made THREE claims — and it discarded
   * a real Gemini answer that made THIRTY-SIX and got thirty-four right.
   *
   * One miss in three is evidence. One in thirty-six is noise: a doc-comment boundary beyond the
   * tolerance, a symbol that appears in several places, a generalisation like `RecordN` standing
   * for Record1 through Record17. A detector that cannot tell those apart makes a good worker
   * unusable, which is the opposite of what it is for.
   */
  if (wrongLineRatio > maxWrongLineRatio) {
    reasons.push(`line_claims_wrong:${lineWrong}/${lineClaims.length}`)
  }
  if (ungroundedLiteralRatio > maxUngroundedLiteralRatio) {
    reasons.push(`literals_absent:${litUngrounded}/${literals.size}`)
  }
  if (ungroundedRatio > maxUngroundedRatio) {
    reasons.push(`identifiers_absent:${idUngrounded}/${identifiers.size}`)
  }

  return Object.freeze({
    checkable: true,
    verdict: reasons.length > 0 ? 'suspect' : 'verified',
    reason: reasons.length > 0 ? reasons.join(',') : 'claims_check_out',
    lineClaims: Object.freeze({
      total: lineClaims.length,
      verified: lineVerified,
      wrong: lineWrong,
      examples: Object.freeze(lineExamples),
    }),
    literals: Object.freeze({
      total: literals.size,
      grounded: litGrounded,
      ungrounded: litUngrounded,
      examples: Object.freeze(litExamples),
    }),
    identifiers: Object.freeze({
      total: identifiers.size,
      grounded: idGrounded,
      ungrounded: idUngrounded,
      examples: Object.freeze(idExamples),
    }),
  })
}

/**
 * The sentence appended to what Claude is told, when a summary was checked and did not check out.
 *
 * Claude is the one consumer that can act on this: it can re-read the file. So the caveat names
 * what failed rather than saying "this may be unreliable", which Claude cannot do anything with.
 */
export function describeVerification(result) {
  if (!result?.checkable) return null
  if (result.verdict === 'verified') return null
  const parts = []
  if (result.lineClaims.wrong > 0) {
    parts.push(
      `${result.lineClaims.wrong} of ${result.lineClaims.total} line references could not be confirmed`,
    )
  }
  if (result.literals.ungrounded > 0) {
    parts.push(`${result.literals.ungrounded} quoted literal(s) do not appear in the file`)
  }
  if (result.identifiers.ungrounded > 0) {
    parts.push(
      `${result.identifiers.ungrounded} of ${result.identifiers.total} quoted identifiers are not in the file`,
    )
  }
  if (parts.length === 0) return null
  return `This summary was checked against the file and parts of it could not be confirmed: ${parts.join('; ')}. Treat the specifics as unverified and re-read the file with offset and limit if you need them.`
}
