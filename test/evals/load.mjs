/**
 * Corpus loading, and the drift checks that keep a case honest.
 *
 * The loader NEVER THROWS. A corpus typo is a named error with a case id attached, because the
 * person reading the failure is usually the person who made it, and a stack trace does not say
 * which of seventeen directories is wrong. `evals.corpus.test.mjs` asserts the error list is
 * empty; `evals.schema.test.mjs` asserts each error code can actually fire.
 *
 * FOUR CHECKS HERE EARN THEIR KEEP, and none of them is in the brief:
 *
 *   bytes/lines/sha mismatch   a case declares a size; the disk is the authority. Without this the
 *                              corpus README becomes a second copy of a number that drifts.
 *   undeclared_file            a file present in files/ but absent from case.json is either dead
 *                              weight or a silent input. Both are bugs.
 *   accidental_deny_glob       `**\/security\/**` and `**\/auth\/**` match ANY path segment,
 *                              case-insensitively, including the case directory's own name. A case
 *                              directory called `security/` makes every file inside it deny-globbed
 *                              on the DIRECTORY, so the case would pass for a reason that has
 *                              nothing to do with what it claims to test. This is the single
 *                              highest-value rule in the file.
 *   prompt_over_provider_ceiling  `mock` caps a payload at 64 000 bytes and rejects above it at the
 *                              provider, not at the gate. Without this check a contributor adding a
 *                              70 KB fixture gets `payload_too_large` and blames the provider.
 *
 * LINE ENDINGS: committed text is LF-normalised BEFORE it is measured. `core.autocrlf` is
 * effectively true on Windows and this repo ships no `.gitattributes`, so the byte length of a
 * committed `.ts` file is not a checkout-invariant property. Generated files sidestep the problem
 * entirely — git never sees their bytes — which is why `generated` is the default source.
 */

import crypto from 'node:crypto'
import fsDefault from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULTS } from '../../plugins/model-router/lib/config.mjs'
import { addOrNull } from '../../plugins/model-router/lib/telemetry/calc.mjs'
import { matchesAny, normalizeSlashes } from '../../plugins/model-router/lib/globs.mjs'
import { MODES } from '../../plugins/model-router/lib/dispatch/modes.mjs'
import { countLines, validateCase } from './schema.mjs'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const CORPUS_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'evals')

/**
 * Below `mock`'s 64 000-byte cap, with room for the system prompt and the file markers. A case over
 * this is rejected at load with a name, rather than failing later as a provider error.
 */
export const PROMPT_CEILING_BYTES = 60_000

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** LF-normalise. The one place this happens, so a measurement and an assertion cannot disagree. */
const toLf = (text) => text.replace(/\r\n/g, '\n')

/** The deny globs the plugin actually ships, read from DEFAULTS rather than re-typed. */
const SHIPPED_DENY_GLOBS = Object.freeze([...DEFAULTS.routing.denyGlobs])

/* ------------------------------------------------------------------ materialise */

/**
 * Write a case's `generated` files into a scratch directory, byte-exactly and reproducibly.
 *
 * `{unit, repeat}` is joined with an explicit LF and terminated with one, so the result is
 * identical on both CI platforms. The returned map is declared-path -> absolute-path, which is
 * what the harness needs to drive a real hook against a real file.
 *
 * @returns {{paths: Map<string,string>, errors: string[]}}
 */
export function materialiseGenerated(caseDef, scratchDir, { fs = fsDefault } = {}) {
  const paths = new Map()
  const errors = []
  for (const file of caseDef.files) {
    if (file.source !== 'generated') continue
    const abs = path.join(scratchDir, caseDef.id, file.path)
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      const body = new Array(file.generator.repeat).fill(file.generator.unit).join('\n') + '\n'
      fs.writeFileSync(abs, body, 'utf8')
      paths.set(file.path, abs)
    } catch (err) {
      errors.push(`materialise_failed:${caseDef.id}/${file.path} ${err?.code ?? 'unknown'}`)
    }
  }
  return { paths, errors }
}

/* ------------------------------------------------------------- the deny-glob rule */

/**
 * Every string the shipped deny globs get a chance to match: the case id (which becomes a path
 * segment), each declared path in full, and each of its segments standing alone.
 */
function denyGlobHazards(caseDef) {
  const hits = []
  const probe = (label, candidate) => {
    const matched = matchesAny(SHIPPED_DENY_GLOBS, normalizeSlashes(candidate))
    if (matched !== null) hits.push({ label, candidate, pattern: matched })
  }

  // A case id becomes a directory name under test/fixtures/evals/, so it is matched as a segment.
  probe('id', `${caseDef.id}/case.json`)
  for (const file of caseDef.files) {
    if (file.path === null) continue
    probe(`files[].path`, `${caseDef.id}/${file.path}`)
  }
  return hits
}

/* ----------------------------------------------------------------- the prompt size */

/**
 * The bytes this case's payload would actually send, measured through the REAL mode builder rather
 * than estimated — the file markers and the system prompt are part of the payload the provider
 * caps, so estimating here would under-count exactly where it matters.
 */
export function promptBytesFor(caseDef, contents) {
  if (caseDef.harness !== 'dispatch') return null
  const files = caseDef.files.map((f) => ({ path: f.path, content: contents.get(f.path) ?? '' }))
  const mode = MODES['bulk-reader']
  const built = mode.build({ files, task: caseDef.task })
  return Buffer.byteLength(built.system, 'utf8') + Buffer.byteLength(built.prompt, 'utf8')
}

/* --------------------------------------------------------------------- loadCase */

/**
 * Load and verify one case directory.
 *
 * @param {string} dir          absolute path to the case directory
 * @param {{fs?: object, scratchDir: string}} opts
 * @returns {{case: object|null, files: Map<string,string>, absPaths: Map<string,string>,
 *            errors: string[], warnings: string[]}}
 */
export function loadCase(dir, { fs = fsDefault, scratchDir } = {}) {
  const empty = { case: null, files: new Map(), absPaths: new Map(), errors: [], warnings: [] }
  const dirName = path.basename(dir)

  let raw
  try {
    raw = JSON.parse(toLf(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')))
  } catch (err) {
    return { ...empty, errors: [`unreadable_case:${dirName}/case.json ${err?.code ?? 'parse_error'}`] }
  }

  const { case: caseDef, errors, warnings } = validateCase(raw)
  if (caseDef === null) return { ...empty, errors: errors.map((e) => `${dirName}: ${e}`), warnings }

  // The id is the directory name. Two names for one thing is two things that drift apart, and the
  // id is what every report, gate failure and sweep row is keyed on.
  if (caseDef.id !== dirName) {
    errors.push(`id_dir_mismatch:${dirName} declares id "${caseDef.id}"`)
  }

  for (const hit of denyGlobHazards(caseDef)) {
    const intended =
      caseDef.expected.reason === 'deny_glob' && caseDef.safety?.denyGlobIntent === hit.pattern
    if (!intended) {
      errors.push(
        `accidental_deny_glob:${caseDef.id} ${hit.label} "${hit.candidate}" matches the shipped deny glob "${hit.pattern}", ` +
          `so this case would refuse on its own layout rather than on what it tests`,
      )
    }
  }

  /* --- contents: committed from the case dir, generated into scratch --- */
  const files = new Map()
  const absPaths = new Map()

  const { paths: generated, errors: genErrors } = materialiseGenerated(caseDef, scratchDir, { fs })
  for (const e of genErrors) errors.push(e)

  for (const file of caseDef.files) {
    if (file.path === null) continue

    const abs = file.source === 'generated' ? generated.get(file.path) : path.join(dir, file.path)
    if (abs === undefined) continue

    // Re-check containment after resolution. The textual rule in schema.mjs catches a literal
    // "..", this catches a symlink or a normalisation the string rule did not anticipate.
    const root = file.source === 'generated' ? path.join(scratchDir, caseDef.id) : dir
    const rel = path.relative(root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      errors.push(`path_escape:${caseDef.id}/${file.path} resolves outside its case directory`)
      continue
    }

    let text
    try {
      text = toLf(fs.readFileSync(abs, 'utf8'))
    } catch (err) {
      errors.push(`unreadable_file:${caseDef.id}/${file.path} ${err?.code ?? 'unknown'}`)
      continue
    }

    files.set(file.path, text)
    absPaths.set(file.path, abs)

    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes !== file.bytes) {
      errors.push(`bytes_mismatch:${caseDef.id}/${file.path} declares ${file.bytes}, measured ${bytes} (LF-normalised)`)
    }
    const lines = countLines(text)
    if (lines !== file.lines) {
      errors.push(`lines_mismatch:${caseDef.id}/${file.path} declares ${file.lines}, measured ${lines}`)
    }
    if (file.sha256 !== null) {
      const actual = sha256(text)
      if (actual !== file.sha256) {
        errors.push(`sha_mismatch:${caseDef.id}/${file.path} declares ${file.sha256.slice(0, 12)}…, measured ${actual.slice(0, 12)}…`)
      }
    }
  }

  /* --- a file on disk that no case declares, and a generated file committed by mistake --- */
  const declaredCommitted = new Set(caseDef.files.filter((f) => f.source === 'committed').map((f) => f.path))
  const declaredGenerated = new Set(caseDef.files.filter((f) => f.source === 'generated').map((f) => f.path))
  for (const rel of listFilesUnder(path.join(dir, 'files'), fs)) {
    const declaredPath = `files/${rel}`
    if (declaredGenerated.has(declaredPath)) {
      errors.push(
        `generated_file_committed:${caseDef.id}/${declaredPath} is declared generated but exists on disk; ` +
          `git would rewrite its line endings`,
      )
    } else if (!declaredCommitted.has(declaredPath)) {
      errors.push(`undeclared_file:${caseDef.id}/${declaredPath} is on disk but absent from case.json`)
    }
  }

  /* --- the provider ceiling --- */
  const promptBytes = promptBytesFor(caseDef, files)
  if (promptBytes !== null && promptBytes > PROMPT_CEILING_BYTES) {
    errors.push(
      `prompt_over_provider_ceiling:${caseDef.id} would send ${promptBytes} bytes; ` +
        `the ceiling is ${PROMPT_CEILING_BYTES} because the mock provider caps a payload at 64000`,
    )
  }

  return { case: caseDef, files, absPaths, errors, warnings, promptBytes }
}

/** Relative paths of every regular file under `dir`, or [] when it does not exist. */
function listFilesUnder(dir, fs, prefix = '') {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFilesUnder(path.join(dir, entry.name), fs, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/* ------------------------------------------------------------------- loadCorpus */

/**
 * Load every case directory under `CORPUS_DIR`.
 *
 * @returns {{cases: object[], byId: Map<string,object>, contents: Map<string,Map<string,string>>,
 *            absPaths: Map<string,Map<string,string>>, errors: string[], warnings: string[]}}
 */
export function loadCorpus({ fs = fsDefault, scratchDir, dir = CORPUS_DIR } = {}) {
  const cases = []
  const byId = new Map()
  const contents = new Map()
  const absPaths = new Map()
  const errors = []
  const warnings = []

  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return { cases, byId, contents, absPaths, errors: [`unreadable_corpus:${dir} ${err?.code ?? 'unknown'}`], warnings }
  }

  // Dot-prefixed names are skipped the same way the telemetry reader skips `.salt`: a scratch or
  // editor file in the corpus directory is not a case.
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort()

  for (const name of dirs) {
    const loaded = loadCase(path.join(dir, name), { fs, scratchDir })
    for (const e of loaded.errors) errors.push(e)
    for (const w of loaded.warnings) warnings.push(`${name}: ${w}`)
    if (loaded.case === null) continue

    if (byId.has(loaded.case.id)) {
      errors.push(`duplicate_id:${loaded.case.id} appears more than once`)
      continue
    }
    byId.set(loaded.case.id, loaded.case)
    cases.push(loaded.case)
    contents.set(loaded.case.id, loaded.files)
    absPaths.set(loaded.case.id, loaded.absPaths)
  }

  return { cases, byId, contents, absPaths, errors, warnings }
}

/* ------------------------------------------------------- fingerprint and README */

/**
 * A hash over what the corpus IS, so `corpusVersion` cannot be a number somebody forgets to bump.
 * `corpus.json` carries it and a test asserts the two agree, which makes the version falsifiable
 * instead of decorative.
 */
export function corpusFingerprint(cases) {
  const rows = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => {
      const files = c.files.map((f) => `${f.path}:${f.bytes}:${f.lines}:${f.sha256 ?? '-'}`).join(',')
      return `${c.id}|${c.caseVersion}|${c.harness}|${c.expected.class}|${c.expected.reason}|${files}`
    })
  return sha256(rows.join('\n'))
}

/**
 * The corpus README's table rows, generated.
 *
 * A hand-written table drifts, which is the exact failure the loader's `bytes_mismatch` check
 * exists to prevent — so the README is generated and `evals.corpus.test.mjs` asserts the committed
 * file still matches. Same discipline as `gen-config-schema.mjs` and `config.schema.test.mjs`.
 */
export function corpusTable(cases) {
  const rows = [...cases].sort((a, b) => (a.id < b.id ? -1 : 1))
  const lines = [
    '| case | harness | expected | reason | bytes | shapes |',
    '|---|---|---|---|---|---|',
  ]
  for (const c of rows) {
    // Null-strict: a case with no files, or one whose size is unknown, renders an em dash rather
    // than a zero. A README that prints 0 bytes for an unmeasured fixture is a README that lies.
    const bytes = c.files.length === 0 ? null : addOrNull(...c.files.map((f) => f.bytes))
    lines.push(
      `| \`${c.id}\` | ${c.harness} | ${c.expected.class} | \`${c.expected.reason}\` | ` +
        `${bytes === null ? '—' : bytes.toLocaleString('en-US')} | ${c.shapes.join(', ')} |`,
    )
  }
  return lines.join('\n')
}
