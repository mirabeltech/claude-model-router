/**
 * Generate the evaluation corpus.
 *
 * Run: node test/evals/bin/build-corpus.mjs
 *
 * The corpus is COMMITTED, and this script is what produces it — the same arrangement as
 * `gen-config-schema.mjs` and `config.schema.json`. `evals.corpus.test.mjs` asserts the committed
 * corpus still loads clean and that the README matches `corpusTable()`, so a hand edit that drifts
 * from the generator fails the suite.
 *
 * WHY A GENERATOR RATHER THAN SEVENTEEN HAND-WRITTEN FILES: every case declares the byte and line
 * count of its fixtures, and the loader checks those against the disk. Hand-maintaining a declared
 * byte count is exactly the drift the check exists to catch. Here the numbers are MEASURED from
 * the content this script just produced, so they cannot be wrong by construction.
 *
 * TWO FIXTURE KINDS, and the choice is forced by git:
 *
 *   generated — a {unit, repeat} pair, materialised into a scratch dir at load time with an
 *               explicit LF join. Git never sees the bytes, so `core.autocrlf` cannot rewrite them.
 *               This is the DEFAULT, and every size-boundary case uses it.
 *   committed — content whose structure cannot be expressed as a repeated unit: a planted fact
 *               among decoys, bundle-shaped noise, a planted secret. These are LF-normalised by
 *               the loader before measurement, which is the mitigation rather than the cure.
 *
 * Every byte of fixture content below is synthetic and written for this corpus. There is no
 * external source material, and the only secret-shaped string is an obvious non-credential.
 */

import fs from 'node:fs'
import path from 'node:path'

import { CORPUS_DIR, corpusFingerprint, corpusTable, loadCorpus } from '../load.mjs'
import { EVAL_SCHEMA_VERSION } from '../schema.mjs'

/* ------------------------------------------------------------------- generators */

/**
 * A `{unit, repeat}` that materialises to EXACTLY `targetBytes`.
 *
 * The materialised body is `repeat` copies of `unit` joined by LF and terminated by one, so
 * bytes = repeat * (unit.length + 1) and lines = repeat. `targetBytes` must therefore be divisible
 * by `repeat`, and this throws rather than silently rounding — a fixture that is approximately the
 * declared size is a fixture whose boundary case proves nothing.
 */
function unitFor(targetBytes, repeat, seed) {
  if (targetBytes % repeat !== 0) {
    throw new Error(`${targetBytes} bytes is not divisible by ${repeat} lines; pick a different factorisation`)
  }
  const unitLen = targetBytes / repeat - 1
  if (unitLen < 1) throw new Error(`${targetBytes}/${repeat} leaves no room for content`)
  // Pad with a comment tail so the line still reads as source, then clip to the exact length.
  const padded = (seed + ' // ' + 'pad'.repeat(unitLen)).slice(0, unitLen)
  if (padded.length !== unitLen) throw new Error(`could not build a ${unitLen}-char unit`)
  return { unit: padded, repeat }
}

const tsLine = (n) => `export const field${n} = { id: ${n}, label: 'row ${n}' }`

/* ------------------------------------------------------- committed fixture bodies */

/**
 * 300 near-identical handler registrations with exactly one marked deprecated.
 *
 * The point is a worker that pattern-matches instead of reading: every block looks the same, so an
 * answer naming `x_136` or `x_138` has guessed from position rather than read the flag. The
 * neighbours are the forbidden terms for precisely that reason.
 */
function repetitiveBody() {
  const lines = ['// Generated handler table. Exactly one entry is deprecated.', '']
  for (let i = 0; i < 300; i += 1) {
    const key = `x_${String(i).padStart(3, '0')}`
    const extra = i === 137 ? ", deprecated: true" : ''
    lines.push(`registerHandler('${key}', { retries: ${i % 5}${extra} })`)
  }
  return lines.join('\n') + '\n'
}

/**
 * The Phase 7 regression fixture: THREE deprecated entries among three hundred identical ones,
 * plus one comment that says the word without being a match.
 *
 * This exists because of a measured failure, not a hypothesis. A live `ollama/llama3` run on
 * `shape-repetitive-content` — one deprecated entry in a near-identical table — used real tokens,
 * avoided real tokens, and answered wrongly: it neither identified the deprecation nor named the
 * entity. That fixture can only catch "found the one" and so cannot distinguish three failure
 * modes that look identical from the outside:
 *
 *   - stopping at the first hit, which a single-target fixture rewards;
 *   - citing a line from position rather than from reading, which neighbours catch;
 *   - counting a documentation example as an occurrence, which nothing in the corpus caught.
 *
 * So: three real targets at known lines, and one near-miss. The comment rides on an EXISTING row
 * rather than occupying a line of its own, because inserting a line would shift every line number
 * after it and the whole value of this fixture is that `3 + i` is the line of `x_<i>` for every i.
 */
const MULTI_DEPRECATED = Object.freeze({
  /** Indices marked `deprecated: true`. Spread across the file so none is findable by position. */
  targets: Object.freeze([137, 244, 371]),
  /** Says "deprecated: true" inside a comment. A worker counting four has not read, it has grepped. */
  decoy: 88,
  rows: 400,
  /** Line of row i. Two header lines precede the table, and nothing shifts thereafter. */
  lineOf: (i) => 3 + i,
})

function multiDeprecatedBody() {
  const lines = [
    '// Generated handler table. Three entries are deprecated. One comment mentions the flag.',
    '',
  ]
  for (let i = 0; i < MULTI_DEPRECATED.rows; i += 1) {
    const key = `x_${String(i).padStart(3, '0')}`
    const extra = MULTI_DEPRECATED.targets.includes(i) ? ', deprecated: true' : ''
    const comment =
      i === MULTI_DEPRECATED.decoy ? ' // example: pass deprecated: true to retire a handler' : ''
    lines.push(`registerHandler('${key}', { retries: ${i % 5}${extra} })${comment}`)
  }
  return lines.join('\n') + '\n'
}

/** `x_137`-style keys for the target indices, and the lines they sit on. */
const multiKeys = () => MULTI_DEPRECATED.targets.map((i) => `x_${String(i).padStart(3, '0')}`)
const multiLines = () => MULTI_DEPRECATED.targets.map((i) => MULTI_DEPRECATED.lineOf(i))

/**
 * Bundle-shaped line soup with three real declarations buried in it.
 *
 * Models the realistic worst case for a reader: long machine-generated lines where the three
 * things a human would care about are indistinguishable by position.
 */
function highNoiseBody() {
  const lines = ['/* eslint-disable */ /* prettier-ignore */ // bundled output, do not edit', '']
  const noise = (n) =>
    `!function(e,t){for(var r=${n};r--;)e[r]=t(r,${n * 7 % 97},"${'z'.repeat(24)}")}(window.__b${n}||{},function(a,b,c){return a+b+c.length});`
  for (let i = 0; i < 120; i += 1) {
    if (i === 37) lines.push('export function parseManifest(input) { return JSON.parse(input) }')
    else if (i === 74) lines.push('export const MANIFEST_VERSION = 4')
    else if (i === 101) lines.push('export class ManifestWriter { write(m) { return String(m) } }')
    else lines.push(noise(i + 1))
  }
  return lines.join('\n') + '\n'
}

/**
 * One fact buried deep among four decoys of the same shape.
 *
 * `RETRY_CEILING = 7` sits at a known line, and four other `*_CEILING` constants hold 3, 5, 9 and
 * 11 at known lines elsewhere. That is what makes the `lineCitations` check falsifiable: an answer
 * that cites a decoy's line number fails, so citing "a line" is not enough.
 */
function buriedFactBody() {
  const DECOYS = Object.freeze([
    { line: 120, name: 'CONNECT_CEILING', value: 3 },
    { line: 310, name: 'PARSE_CEILING', value: 5 },
    { line: 520, name: 'QUEUE_CEILING', value: 9 },
    { line: 840, name: 'FLUSH_CEILING', value: 11 },
  ])
  const TARGET = Object.freeze({ line: 700, name: 'RETRY_CEILING', value: 7 })
  const placed = new Map([[TARGET.line, `export const ${TARGET.name} = ${TARGET.value}`]])
  for (const d of DECOYS) placed.set(d.line, `export const ${d.name} = ${d.value}`)

  const lines = []
  for (let n = 1; n <= 900; n += 1) {
    lines.push(placed.get(n) ?? tsLine(n))
  }
  return { body: lines.join('\n') + '\n', target: TARGET, decoys: DECOYS }
}

/**
 * A plausible config module with a planted non-credential.
 *
 * The literal matches `redactSecrets()`'s `key=value` branch (`api_key` + quoted payload) so the
 * leakage gates have something real to find, while reading unmistakably as a non-secret to a
 * human and to a scanner. The filename is deliberately innocuous: the point of this case is that
 * the filename deny list is the plugin's ONLY control over outbound content, so a secret behind an
 * ordinary name is delegated. See docs/evaluation.md.
 */
const PLANTED_SECRET = 'FAKE-DO-NOT-USE-0000000000000000'

function appConfigBody() {
  const lines = [
    '// Service configuration. Values are placeholders for local development.',
    '',
    'export const serviceName = "billing-gateway"',
    'export const regionList = ["us-east-1", "eu-west-2", "ap-south-1"]',
    `export const api_key = "${PLANTED_SECRET}"`,
    'export const requestTimeoutMs = 30000',
    'export const retryBudget = 4',
    '',
  ]
  for (let i = 0; i < 280; i += 1) {
    lines.push(`export const tunable${i} = { weight: ${i % 13}, enabled: ${i % 3 === 0} }`)
  }
  return lines.join('\n') + '\n'
}

/* ------------------------------------------------------------------- the manifest */

const buried = buriedFactBody()

/**
 * Every case, declaratively. `files[].bytes` and `files[].lines` are filled in by `emit()` from
 * the content it writes, so nothing below states a size that could be wrong.
 */
const CASES = [
  /* --------------------------------------------------- group A: the size boundary */
  {
    id: 'size-just-below-min-bytes',
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'One byte below minBytes stays with Claude',
    rationale:
      'Rules 1-11 all pass, so thresholdMet decides: 11999 < minBytes 12000, lineCount 169 < minLines 350, and minEstimatedTokens is null by default. Size is unsatisfied, so rule 14 owns the refusal.',
    harness: 'decide',
    generated: [{ path: 'files/below.ts', bytes: 11999, repeat: 169, seed: 'export const belowThreshold = true' }],
    expected: { class: 'primary', reason: 'below_threshold', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'size-at-min-bytes',
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'Exactly minBytes delegates, because the comparison is inclusive',
    rationale:
      'minBytes is compared with >=, so 12000 satisfies the size floor. This is the case that proves the gate is not a constant function; without it a gate that never delegates would pass every other size case.',
    harness: 'decide',
    generated: [{ path: 'files/at.ts', bytes: 12000, repeat: 160, seed: 'export const atThreshold = true' }],
    expected: { class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny', lane: 'bulkRead', mode: 'bulk-reader' },
  },
  {
    id: 'size-just-above-min-bytes',
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'One byte above minBytes delegates on bytes alone',
    rationale:
      'Only 11 lines, so minLines cannot be what satisfied the floor; 12001 >= 12000 did. Pairs with size-just-below to bracket the boundary from both sides.',
    harness: 'decide',
    generated: [{ path: 'files/above.ts', bytes: 12001, repeat: 11, seed: 'export const aboveThreshold = true' }],
    expected: { class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny', lane: 'bulkRead', mode: 'bulk-reader' },
  },
  {
    id: 'small-read-stays-primary',
    category: 'small_read',
    shapes: ['small_file'],
    title: 'A small file is never worth a round trip',
    rationale:
      'CLAUDE.md #6: small files stay with Claude. 53 bytes and one line fail every size floor, so rule 14 refuses. Mirrors test/fixtures/corpus/small.ts.',
    harness: 'decide',
    generated: [{ path: 'files/tiny.ts', bytes: 53, repeat: 1, seed: 'export const tiny = 1' }],
    expected: { class: 'primary', reason: 'below_threshold', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'lines-350-decide-delegates',
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'minLines satisfies the size floor on its own at the decide layer',
    rationale:
      'thresholdMet ORs its three size signals. 10500 bytes is under minBytes, but 350 lines meets minLines exactly, so size is satisfied. Pairs with lines-350-hook-refuses on the identical file.',
    harness: 'decide',
    generated: [{ path: 'files/wide.ts', bytes: 10500, repeat: 350, seed: 'export const row = 1' }],
    routingInput: { lineCount: 350 },
    expected: { class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny', lane: 'bulkRead', mode: 'bulk-reader' },
  },
  {
    id: 'lines-350-hook-refuses',
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'The same file refuses through the hook, because the hook cannot count lines',
    rationale:
      'hook/adapter.mjs leaves lineCount null by design, so minLines is unreachable in production and only minBytes decides. 10500 < 12000, so the hook refuses the file the decide layer delegates. This is the only case that MEASURES the discrepancy docs/what-we-do-not-delegate.md states in prose.',
    harness: 'hook',
    generated: [{ path: 'files/wide.ts', bytes: 10500, repeat: 350, seed: 'export const row = 1' }],
    expected: {
      class: 'primary', reason: 'below_threshold', taskType: 'bulk_read', decision: 'allow',
      lane: 'bulkRead', outcome: 'not_delegated',
    },
  },

  /* ------------------------------------------------ group B: the live refusal rules */
  {
    id: 'targeted-read-refused',
    category: 'bulk_read',
    shapes: ['large_file'],
    title: 'An offset or limit read is intentional and is never delegated',
    rationale:
      'Rule 7. Claude asking for a slice has already decided what it needs, and a summary of the whole file is not that. Large enough to delegate on size, so the refusal can only be the targeted-read rule.',
    harness: 'decide',
    generated: [{ path: 'files/big.ts', bytes: 24576, repeat: 384, seed: 'export const entry = { ok: true }' }],
    routingInput: { targetedRead: true, fullRead: false },
    expected: { class: 'primary', reason: 'targeted_read', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'recently-edited-refused',
    category: 'bulk_read',
    shapes: ['large_file'],
    title: 'A file Claude just edited is read in full, from a real transcript',
    rationale:
      'Rule 8, and MEASURED rather than asserted: the harness writes a transcript whose last turn is an Edit against this path, and hook/facts.mjs recentlyEdited() reads it. Claude needs the exact current bytes after its own edit, not a summary of them.',
    harness: 'hook',
    generated: [{ path: 'files/big.ts', bytes: 24576, repeat: 384, seed: 'export const entry = { ok: true }' }],
    metadata: { transcript: 'edit' },
    expected: {
      class: 'primary', reason: 'recently_edited', taskType: 'bulk_read', decision: 'allow',
      lane: 'bulkRead', outcome: 'not_delegated',
    },
  },
  {
    id: 'missing-transcript-refuses',
    category: 'bulk_read',
    shapes: ['large_file'],
    title: 'An unreadable transcript refuses, because unknown is never the favorable value',
    rationale:
      'recentlyEdited() returns true when it cannot measure, and the gate has no vocabulary for "unknown". A corpus of static directories has no transcript, so this is the trap that makes a first harness run report total refusal — it is pinned here rather than rediscovered.',
    harness: 'hook',
    generated: [{ path: 'files/big.ts', bytes: 24576, repeat: 384, seed: 'export const entry = { ok: true }' }],
    metadata: { transcript: 'absent' },
    expected: {
      class: 'primary', reason: 'recently_edited', taskType: 'bulk_read', decision: 'allow',
      lane: 'bulkRead', outcome: 'not_delegated',
    },
  },
  {
    id: 'worker-not-ready-refused',
    category: 'bulk_read',
    shapes: ['large_file'],
    title: 'No configured worker means plain Claude Code, not a blocked read',
    rationale:
      'Rule 11, and the gate failing open. This is what a fresh install sees before a worker is configured, and it must degrade to ordinary behaviour rather than to a denied Read.',
    harness: 'hook',
    generated: [{ path: 'files/big.ts', bytes: 24576, repeat: 384, seed: 'export const entry = { ok: true }' }],
    metadata: { worker: 'absent' },
    expected: {
      class: 'primary', reason: 'worker_not_ready', taskType: 'bulk_read', decision: 'allow',
      lane: 'bulkRead', outcome: 'not_delegated',
    },
  },
  {
    id: 'over-max-files-tight-cap',
    category: 'multi_file_read',
    shapes: ['multiple_files'],
    title: 'More files than the cap refuses on the cap, before any size rule',
    rationale:
      'Rule 12 precedes rule 14, so over_max_files owns the reason even though these files are tiny. The cap is tightened to 2 by config rather than shipping 26 fixtures: the corpus must not pay for a branch an override reaches free.',
    harness: 'decide',
    generated: [
      { path: 'files/a.ts', bytes: 100, repeat: 2, seed: 'export const a = 1' },
      { path: 'files/b.ts', bytes: 100, repeat: 2, seed: 'export const b = 2' },
      { path: 'files/c.ts', bytes: 100, repeat: 2, seed: 'export const c = 3' },
    ],
    config: { routing: { bulkRead: { maxFiles: 2 } } },
    expected: { class: 'primary', reason: 'over_max_files', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'over-max-bytes-tight-ceiling',
    category: 'bulk_read',
    shapes: ['medium_file'],
    title: 'A payload over the worker ceiling refuses rather than truncating',
    rationale:
      'Rule 13. The ceiling is lowered to 1024 by config instead of shipping a 2 MB fixture. Refusing beats truncating: a worker summarising half a file produces a confident answer about content it never saw.',
    harness: 'decide',
    generated: [{ path: 'files/wide.ts', bytes: 4000, repeat: 80, seed: 'export const wide = true' }],
    config: { worker: { maxInputBytes: 1024 } },
    expected: { class: 'primary', reason: 'over_max_input_bytes', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'unnamed-corpus-refused',
    category: 'ambiguous',
    shapes: ['ambiguous_request'],
    title: 'Claiming files without naming them is not permission to delegate',
    rationale:
      'Rule 10. A caller reporting fileCount 3 with an empty paths array cannot have its paths checked against the deny list, so the gate cannot prove the corpus is safe to send. Unknown input refuses.',
    harness: 'decide',
    generated: [],
    routingInput: { fileCount: 3, paths: [] },
    expected: { class: 'primary', reason: 'unknown_input', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'precise-output-requested',
    category: 'precise_edit',
    shapes: ['precise_edit_request'],
    title: 'A request for a patch is never answered with a summary',
    rationale:
      'Rule 6. requestedOutput "patch" is in PRECISE_OUTPUTS, and a precise output needs exact bytes. This exercises a genuinely different branch from the task-type allowlist, which three identical task_type_excluded cases would not.',
    harness: 'decide',
    generated: [{ path: 'files/big.ts', bytes: 24576, repeat: 384, seed: 'export const entry = { ok: true }' }],
    routingInput: { requestedOutput: 'patch' },
    expected: { class: 'primary', reason: 'precise_output_requested', taskType: 'bulk_read', decision: 'allow', lane: 'bulkRead' },
  },
  {
    id: 'ambiguous-unknown-enum',
    category: 'ambiguous',
    shapes: ['ambiguous_request'],
    title: 'A misspelled task type becomes unknown and refuses one rule earlier',
    rationale:
      'A deliberate "architecure" typo. normalizeInput folds an unrecognised taskType to unknown and warns, so rule 2a owns this rather than rule 2b task_type_excluded. Exercises real normalisation code, and pins the one-rule difference between the two codes.',
    harness: 'decide',
    generated: [{ path: 'files/big.ts', bytes: 24576, repeat: 384, seed: 'export const entry = { ok: true }' }],
    routingInput: { taskType: 'architecure' },
    expected: {
      class: 'primary', reason: 'unknown_input', taskType: 'unknown', decision: 'allow',
      inputWarnings: ['unknown_enum:taskType'],
    },
  },

  /* ------------------------------------------------- group C: content shapes (worker) */
  {
    id: 'shape-multi-file-three-modules',
    category: 'multi_file_read',
    shapes: ['multiple_files'],
    title: 'Which of three modules defines a given function',
    rationale:
      'A multi-file payload is reachable only at the dispatch layer: run.mjs sends exactly one file. Tests that the answer attributes a declaration to the right file rather than summarising all three generically.',
    harness: 'dispatch',
    task: 'Which of these three modules defines resolveWorker, and what does it return? Name the file.',
    generated: [
      { path: 'files/dispatch.ts', bytes: 6144, repeat: 96, seed: 'export function resolveWorker() { return { provider: 1 } }' },
      { path: 'files/telemetry.ts', bytes: 5120, repeat: 80, seed: 'export function buildEvent() { return {} }' },
      { path: 'files/globs.ts', bytes: 4096, repeat: 64, seed: 'export function matchesGlob() { return false }' },
    ],
    qualityCriteria: {
      requiredEntities: ['resolveWorker'],
      fileReferences: ['files/dispatch.ts'],
      forbiddenTerms: ['probably', 'appears to', 'might be', 'I cannot tell'],
    },
    answer: [
      'files/dispatch.ts defines resolveWorker, which returns an object carrying a provider field.',
      '',
      'files/telemetry.ts defines buildEvent and files/globs.ts defines matchesGlob. Neither of',
      'those two declares resolveWorker.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'shape-repetitive-content',
    category: 'bulk_read',
    shapes: ['repetitive_content'],
    title: 'One deprecated entry among three hundred identical ones',
    rationale:
      'Catches a worker that pattern-matches instead of reading. Every block is near-identical, so an answer naming a neighbour has guessed from position; the neighbours are forbidden terms for exactly that reason.',
    harness: 'dispatch',
    task: 'Exactly one handler in this file is marked deprecated. Which key is it?',
    committed: [{ path: 'files/handlers.ts', body: repetitiveBody() }],
    qualityCriteria: {
      exactFacts: ['x_137'],
      forbiddenTerms: ['x_136', 'x_138', 'x_1137', 'x_013'],
      counts: [{ term: 'deprecated', min: 1, max: 4 }],
    },
    answer: [
      'The handler x_137 is the only entry in this table marked deprecated.',
      '',
      'Every other registration omits the deprecated flag; they differ only in their retries value,',
      'which cycles through 0 to 4.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'shape-high-noise',
    category: 'bulk_read',
    shapes: ['high_noise'],
    title: 'Three real declarations buried in bundled output',
    rationale:
      'Models the realistic worst case: long machine-generated lines where the three things a human cares about are indistinguishable by position. Tests recall of the signal, not tolerance of the noise.',
    harness: 'dispatch',
    task: 'Name every exported declaration in this file. Ignore the bundled noise.',
    committed: [{ path: 'files/bundle.js', body: highNoiseBody() }],
    qualityCriteria: {
      requiredEntities: ['parseManifest', 'MANIFEST_VERSION', 'ManifestWriter'],
      counts: [{ term: 'export', min: 3 }],
    },
    answer: [
      'Three declarations are exported from this file:',
      '',
      '- parseManifest, a function that parses a manifest string',
      '- MANIFEST_VERSION, a constant',
      '- ManifestWriter, a class with a write method',
      '',
      'Each export sits at the top level. The remaining lines are bundled output and export nothing.',
      '',
      'The first of the three reads:',
      '',
      '```ts',
      'export function parseManifest(input) { return JSON.parse(input) }',
      '```',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'shape-buried-fact',
    category: 'bulk_read',
    shapes: ['buried_in_large'],
    title: 'One constant deep in a long file, among four decoys of the same shape',
    rationale:
      'The only deterministic accuracy question in the corpus: a planted fact with decoys has a right answer known in advance. Four other *_CEILING constants hold 3, 5, 9 and 11 at known lines, so citing "a line" is not enough — citing a decoy line fails.',
    harness: 'dispatch',
    task: 'What is the retry ceiling in this file, and on which line is it declared?',
    committed: [{ path: 'files/engine.ts', body: buried.body }],
    qualityCriteria: {
      exactFacts: [{ literal: `${buried.target.name} = ${buried.target.value}` }],
      lineCitations: [
        { fact: buried.target.name, line: buried.target.line, decoyLines: buried.decoys.map((d) => d.line) },
      ],
      forbiddenTerms: buried.decoys.map((d) => `${buried.target.name} = ${d.value}`),
    },
    answer: [
      `The retry ceiling is ${buried.target.name} = ${buried.target.value}, declared on line ${buried.target.line}.`,
      '',
      'Four other ceiling constants appear elsewhere in the file and hold different values, but the',
      'retry one is the constant asked about.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'shape-large-single-file',
    category: 'bulk_read',
    shapes: ['large_file'],
    title: 'A fifty-kilobyte file, near the mock provider ceiling',
    rationale:
      'The largest payload the corpus sends. Also guards the 60000-byte prompt ceiling: raise this fixture and the loader says why dispatch would fail, instead of the provider reporting payload_too_large and taking the blame.',
    harness: 'dispatch',
    task: 'Summarise this file for an engineer who has not seen it.',
    generated: [{ path: 'files/huge.ts', bytes: 51200, repeat: 800, seed: 'export const record = { kind: "row" }' }],
    qualityCriteria: {
      requiredEntities: ['record'],
      forbiddenTerms: ['I cannot', 'unable to read', 'truncated'],
    },
    answer: [
      'This file is a long table of exported constants. Each line declares a record object whose',
      'kind field is set to the string row.',
      '',
      'There is no logic here: the file is data, repeated eight hundred times.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },

  /* ------------------------------------------------------------- group D: security */
  {
    id: 'secret-in-plain-filename',
    category: 'security',
    shapes: ['security_sensitive'],
    title: 'A secret behind an ordinary filename is delegated, and that is the finding',
    rationale:
      'The filename deny list is the plugin\'s ONLY control over outbound content: nothing redacts file content on the way to the worker. app-config.ts matches no deny glob, so this delegates and the planted literal leaves the machine. The outbound gate pins that as a declared known exposure so it goes red if the deny list is ever weakened.',
    harness: 'dispatch',
    task: 'Does this configuration contain a hard-coded credential? Answer yes or no and name the field, without quoting its value.',
    committed: [{ path: 'files/app-config.ts', body: appConfigBody() }],
    qualityCriteria: {
      requiredEntities: ['api_key'],
      requiredTerms: ['yes'],
    },
    answer: [
      'Yes. The field api_key holds a hard-coded credential.',
      '',
      'Its value is not reproduced here. The rest of the file is ordinary configuration: a service',
      'name, a region list, a request timeout and a retry budget, followed by tunable constants.',
    ].join('\n'),
    safety: {
      plantedSecret: PLANTED_SECRET,
      knownExposure:
        'File content is not redacted on the outbound path. The filename deny list is the only control, and app-config.ts matches none of it.',
    },
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },

  /* ------------------------------------------- Phase 7: the intent regression cases
   *
   * Five cases added because a live run failed in a way the corpus could not express. Each
   * declares a `taskIntent`, which is what makes it an A/B case: the `generic` variant sends the
   * `task` sentence alone, the `intent` variant sends the same sentence plus the requirements
   * built from the block below, and nothing else differs.
   *
   * Their `expected` blocks are identical to every other delegating dispatch case. That is on
   * purpose: this phase changed what the worker is ASKED, never what the router decides, and a
   * new case with a novel expected class would be the first sign that it had.
   *
   * On the deterministic arm all five pass, and that result says nothing about either
   * construction — the fixture worker returns the authored answer below whatever prompt it
   * receives. They exist to be run with `--ab --arm ollama`, where the answer comes from a model.
   */
  {
    id: 'intent-buried-in-repetition',
    category: 'bulk_read',
    shapes: ['repetitive_content'],
    title: 'The measured live failure, with the line citation the generic task never asked for',
    rationale:
      'Reproduces the failure that motivated Phase 7: ollama/llama3 was given a near-identical table and identified neither the deprecation nor the entity. Same shape as shape-repetitive-content, but the intent demands the entity AND its line, and the neighbouring lines are decoys so a citation guessed from position fails.',
    harness: 'dispatch',
    task: 'Exactly one handler in this file is marked deprecated. Which key is it, and on which line?',
    taskIntent: {
      task: 'Exactly one handler in this file is marked deprecated. Which key is it, and on which line?',
      requestedInformation: 'the handler key exactly as written, and the line number it is declared on',
      constraints: 'every row looks alike, so read the flag rather than inferring from position',
    },
    committed: [{ path: 'files/handlers.ts', body: repetitiveBody() }],
    qualityCriteria: {
      exactFacts: ['x_137'],
      forbiddenTerms: ['x_136', 'x_138', 'x_1137', 'x_013'],
      lineCitations: [{ fact: 'x_137', line: 140, decoyLines: [136, 138, 139, 141] }],
    },
    answer: [
      'The handler x_137 is the only entry marked deprecated. It is declared on line 140 of',
      'files/handlers.ts:',
      '',
      '```ts',
      "registerHandler('x_137', { retries: 2, deprecated: true })",
      '```',
      '',
      'Every other registration omits the flag and differs only in its retries value.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'intent-multiple-occurrences',
    category: 'bulk_read',
    shapes: ['repetitive_content'],
    title: 'Three deprecated entries, so stopping at the first one fails',
    rationale:
      'A single-target fixture rewards a worker that stops reading at the first hit, because there is nothing after it. Three targets make exhaustiveness falsifiable: the counts range needs all three keys present, and a worker that found one scores the same as a worker that found none.',
    harness: 'dispatch',
    task: 'Find every handler in this file marked deprecated. List each key.',
    taskIntent: {
      task: 'Find every handler in this file marked deprecated. List each key.',
      requestedInformation: 'every matching handler key, not a sample and not the first one',
      constraints: 'there is more than one match; do not stop at the first',
      outputFormat: 'one key per line',
    },
    committed: [{ path: 'files/handlers.ts', body: multiDeprecatedBody() }],
    qualityCriteria: {
      exactFacts: multiKeys(),
      counts: [{ term: 'x_', min: 3, max: 20 }],
    },
    answer: [
      'Three handlers are marked deprecated:',
      '',
      ...multiKeys(),
      '',
      'A fourth row carries the word in a comment that documents the flag, not a deprecation.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'intent-line-citation-required',
    category: 'bulk_read',
    shapes: ['repetitive_content'],
    title: 'Three citations, each falsifiable against its own neighbours',
    rationale:
      'A confidently wrong line number is the most common worker failure and the hardest to notice, because the answer reads correctly. Three citations are checked, each with the rows either side as decoys, so an answer that is right about the keys and wrong about where they are fails.',
    harness: 'dispatch',
    task: 'Every handler marked deprecated: give the key and the exact line it is declared on.',
    taskIntent: {
      task: 'Every handler marked deprecated: give the key and the exact line it is declared on.',
      requestedInformation: 'the key and the line number for each match',
      constraints: 'cite the line the declaration is actually on; do not estimate it',
      outputFormat: 'key followed by its line number',
    },
    committed: [{ path: 'files/handlers.ts', body: multiDeprecatedBody() }],
    qualityCriteria: {
      exactFacts: multiKeys(),
      lineCitations: multiKeys().map((key, i) => ({
        fact: key,
        line: multiLines()[i],
        // The rows either side of this target, minus any line that is itself a target.
        decoyLines: [multiLines()[i] - 1, multiLines()[i] + 1].filter((n) => !multiLines().includes(n)),
      })),
    },
    answer: [
      'Three handlers are marked deprecated, in files/handlers.ts:',
      '',
      ...multiKeys().map((key, i) => `- ${key} on line ${multiLines()[i]}`),
      '',
      'No other registration carries the flag.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'intent-fact-among-distractors',
    category: 'bulk_read',
    shapes: ['high_noise'],
    title: 'Three real declarations in bundled soup, each to be named and placed',
    rationale:
      'Pairs with shape-high-noise on the same content but a harder question: that case asks what the exports are, this one asks where they are. Long machine-generated lines give a worker nothing to orient by, so a line number here is either read or invented.',
    harness: 'dispatch',
    task: 'This file is bundled output with a few real declarations in it. Name each one and give its line.',
    taskIntent: {
      task: 'This file is bundled output with a few real declarations in it. Name each one and give its line.',
      requestedInformation: 'each top-level declaration, its exact name, and the line it is on',
      constraints: 'the surrounding lines are minified bundle output and declare nothing; do not report them',
    },
    committed: [{ path: 'files/bundle.js', body: highNoiseBody() }],
    qualityCriteria: {
      requiredEntities: ['parseManifest', 'MANIFEST_VERSION', 'ManifestWriter'],
      lineCitations: [
        { fact: 'parseManifest', line: 40, decoyLines: [39, 41] },
        { fact: 'MANIFEST_VERSION', line: 77, decoyLines: [76, 78] },
        { fact: 'ManifestWriter', line: 104, decoyLines: [103, 105] },
      ],
    },
    answer: [
      'Three real declarations sit in files/bundle.js:',
      '',
      '- parseManifest, a function, on line 40',
      '- MANIFEST_VERSION, a constant equal to 4, on line 77',
      '- ManifestWriter, a class with a write method, on line 104',
      '',
      'Every other line is bundled output and declares nothing at the top level.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
  {
    id: 'intent-entity-extraction',
    category: 'bulk_read',
    shapes: ['buried_in_large'],
    title: 'Entity extraction where one near-miss says the word without being a match',
    rationale:
      'The one criterion no other case carries: a documented EXAMPLE of the flag, on an ordinary row. A worker that pattern-matches on the word reports four keys and names x_088, which is a forbidden term here. This is what "distinguish an actual match from something that resembles one" means operationally.',
    harness: 'dispatch',
    task: 'Which handler keys are deprecated? Return the keys exactly as written and nothing else.',
    taskIntent: {
      task: 'Which handler keys are deprecated? Return the keys exactly as written and nothing else.',
      requestedInformation: 'the deprecated handler keys, verbatim',
      constraints:
        'one row mentions the flag in a comment as documentation; that row is not deprecated. Report only real matches.',
      outputFormat: 'the keys alone',
    },
    committed: [{ path: 'files/handlers.ts', body: multiDeprecatedBody() }],
    qualityCriteria: {
      exactFacts: multiKeys(),
      forbiddenTerms: ['x_088', 'x_089', 'x_087'],
    },
    answer: [
      'Deprecated handler keys:',
      '',
      ...multiKeys(),
      '',
      'One further row mentions the flag in a trailing comment documenting its use; that handler is',
      'not itself deprecated, so it is not listed.',
    ].join('\n'),
    expected: {
      class: 'delegate', reason: 'threshold_met', taskType: 'bulk_read', decision: 'deny',
      lane: 'bulkRead', mode: 'bulk-reader', dispatchStatus: 'ok', dispatchReason: 'completed',
    },
  },
]

/* ---------------------------------------------------------------------- emission */

function emit() {
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true })
  fs.mkdirSync(CORPUS_DIR, { recursive: true })

  for (const spec of CASES) {
    const dir = path.join(CORPUS_DIR, spec.id)
    fs.mkdirSync(dir, { recursive: true })

    const files = []

    for (const g of spec.generated ?? []) {
      const { unit, repeat } = unitFor(g.bytes, g.repeat, g.seed)
      // Measured from what the loader will materialise, not asserted.
      const body = new Array(repeat).fill(unit).join('\n') + '\n'
      files.push({
        path: g.path,
        source: 'generated',
        bytes: Buffer.byteLength(body, 'utf8'),
        lines: repeat,
        generator: { unit, repeat },
      })
    }

    for (const c of spec.committed ?? []) {
      const abs = path.join(dir, c.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, c.body, 'utf8')
      files.push({
        path: c.path,
        source: 'committed',
        bytes: Buffer.byteLength(c.body, 'utf8'),
        lines: c.body === '' ? 0 : c.body.split('\n').length - (c.body.endsWith('\n') ? 1 : 0),
      })
    }

    const caseJson = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      id: spec.id,
      caseVersion: 1,
      category: spec.category,
      shapes: spec.shapes,
      title: spec.title,
      rationale: spec.rationale,
      harness: spec.harness,
      ...(spec.task === undefined ? {} : { task: spec.task }),
      // Fixed position, right after the task it elaborates. CI runs `evals:build` and diffs the
      // tree, so a key emitted in a varying place would fail on key order alone.
      ...(spec.taskIntent === undefined ? {} : { taskIntent: spec.taskIntent }),
      files,
      ...(spec.routingInput === undefined ? {} : { routingInput: spec.routingInput }),
      ...(spec.config === undefined ? {} : { config: spec.config }),
      expected: spec.expected,
      ...(spec.qualityCriteria === undefined ? {} : { qualityCriteria: spec.qualityCriteria }),
      ...(spec.safety === undefined ? {} : { safety: spec.safety }),
      ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
    }
    fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(caseJson, null, 2) + '\n', 'utf8')

    // The canned answer the deterministic arm returns for this case. Crafted to satisfy the
    // criteria above, which is the point: the deterministic arm proves the PLUMBING and the
    // evaluators, not a model's ability. Adversarial variants live in _answers/ and are what
    // prove the evaluators can fail.
    if (spec.answer !== undefined) {
      fs.mkdirSync(path.join(dir, 'answers'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'answers', 'default.md'), spec.answer + '\n', 'utf8')
    }
  }

  return CASES.length
}

/* ------------------------------------------------------------------------- main */

const scratch = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'eval-build-'))
try {
  const written = emit()

  // Load what was just written, so the fingerprint and README describe the real corpus rather
  // than the manifest's intentions. A loader error here is a generator bug and must be loud.
  const loaded = loadCorpus({ scratchDir: scratch })
  if (loaded.errors.length > 0) {
    console.error('the generated corpus does not load cleanly:')
    for (const e of loaded.errors) console.error(`  ${e}`)
    process.exit(1)
  }

  const fingerprint = corpusFingerprint(loaded.cases)
  fs.writeFileSync(
    path.join(CORPUS_DIR, 'corpus.json'),
    JSON.stringify({ schemaVersion: EVAL_SCHEMA_VERSION, cases: loaded.cases.length, fingerprint }, null, 2) + '\n',
    'utf8',
  )

  const readme = [
    '# Evaluation corpus',
    '',
    '<!-- Generated by `node test/evals/bin/build-corpus.mjs`. Do not edit by hand:',
    '     `evals.corpus.test.mjs` asserts this table still matches `corpusTable()`. -->',
    '',
    'Synthetic cases for the evaluation framework. Every byte here is written for this corpus — no',
    'external source material — and the only secret-shaped string is an obvious non-credential.',
    '',
    'Sizes are stated relative to the one live size rule, `routing.bulkRead.minBytes` (12 000).',
    'A `generated` fixture is materialised from a `{unit, repeat}` pair at load time so that git',
    'never sees its bytes and `core.autocrlf` cannot rewrite them; a `committed` fixture is one',
    'whose structure cannot be expressed as a repeated unit, and the loader LF-normalises it before',
    'measuring. See [`docs/evaluation.md`](../../../docs/evaluation.md).',
    '',
    corpusTable(loaded.cases),
    '',
    `Fingerprint: \`${fingerprint.slice(0, 16)}…\` over ${loaded.cases.length} cases.`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(CORPUS_DIR, 'README.md'), readme, 'utf8')

  console.log(`wrote ${written} cases to ${path.relative(process.cwd(), CORPUS_DIR)}`)
  console.log(`fingerprint ${fingerprint}`)
  if (loaded.warnings.length > 0) {
    console.log('warnings:')
    for (const w of loaded.warnings) console.log(`  ${w}`)
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
