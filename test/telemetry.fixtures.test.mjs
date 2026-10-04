/**
 * The telemetry fixture corpus, measured rather than declared.
 *
 * `test/fixtures/telemetry/` is the wire-format contract between the two plugins:
 * `router-dashboard` may not import the code that wrote the bytes, so the bytes are the
 * agreement. A hand-maintained corpus with a hand-maintained README is a corpus whose README
 * will be wrong within two phases, so every number in that README is asserted here against what
 * the SHIPPED READER measured — the same precedent `evals.corpus.test.mjs` sets for the eval
 * corpus.
 *
 * It also pins the hazards themselves. A corpus that quietly lost its malformed line, or whose
 * BOM was normalised away by a git checkout, would still pass every analytics test while having
 * stopped testing the thing it exists for. So the hazards are asserted individually, by name.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readSegmentsSync } from '../plugins/model-router/lib/telemetry/jsonl.mjs'
import { FIELD_ORDER, SCHEMA_VERSION } from '../plugins/model-router/lib/telemetry/record.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const DIR = path.join(HERE, 'fixtures', 'telemetry')
const README = path.join(DIR, 'README.md')

/** The whole corpus, and one day at a time. The date filter is by SEGMENT FILENAME. */
const readAll = () => readSegmentsSync({ dir: DIR, fs })
const readDay = (day) => readSegmentsSync({ dir: DIR, fs, from: day, to: day })

/** The README table, as declared. Measured against the reader below. */
const DECLARED = Object.freeze({
  'events-2026-03-02.jsonl': { lines: 6, yielded: 6, moneyRows: 3 },
  'events-2026-03-03.jsonl': { lines: 7, yielded: 7, moneyRows: 0 },
  'events-2026-03-04.jsonl': { lines: 23, yielded: 20, moneyRows: 2 },
})

/* -------------------------------------------------------------------- census */

test('the corpus holds exactly the segments these rules cover', () => {
  // Without this, every other test in the file could pass while scanning a corpus that had
  // quietly lost a segment — or gained one nobody classified.
  const onDisk = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
  assert.deepEqual(onDisk, Object.keys(DECLARED).sort())
})

test('the empty store directory exists and is empty, because an empty window needs a real store', () => {
  const empty = path.join(DIR, 'empty')
  assert.ok(fs.statSync(empty).isDirectory())
  const segments = fs.readdirSync(empty).filter((f) => f.endsWith('.jsonl'))
  assert.deepEqual(segments, [], 'the empty store must hold no segment')
})

/* ------------------------------------------------------- the declared table */

test('every per-segment count in the README matches what the shipped reader measured', () => {
  const violations = []
  for (const [name, declared] of Object.entries(DECLARED)) {
    const day = name.slice('events-'.length, -'.jsonl'.length)
    const { records, report } = readDay(day)
    const moneyRows = records.filter((r) => r.worker_total_cost !== null).length
    if (report.lines !== declared.lines) {
      violations.push(`${name}: README says ${declared.lines} lines, reader measured ${report.lines}`)
    }
    if (report.yielded !== declared.yielded) {
      violations.push(`${name}: README says ${declared.yielded} yielded, reader measured ${report.yielded}`)
    }
    if (moneyRows !== declared.moneyRows) {
      violations.push(`${name}: README says ${declared.moneyRows} money rows, measured ${moneyRows}`)
    }
  }
  assert.deepEqual(violations, [], 'the fixture README has drifted from the fixture bytes')
})

test('the README totals match the whole-corpus read', () => {
  const { records, report } = readAll()
  assert.equal(report.files, 3, 'three segments')
  assert.equal(report.lines, 36, 'README total: 36 lines')
  assert.equal(report.yielded, 33, 'README total: 33 yielded')
  assert.equal(records.length, 33)
  const skipped = Object.values(report.skipped).reduce((a, b) => a + b, 0)
  assert.equal(skipped, 3, 'README total: 3 skipped')
  assert.equal(records.filter((r) => r.worker_total_cost !== null).length, 5, 'README total: 5 money rows')
})

/* ---------------------------------------------- the wire-format hazards */

test('the awkward segment opens with a UTF-8 BOM, because PowerShell 5.1 writes one', () => {
  // The reader strips a BOM only as the FIRST THREE BYTES. If a checkout or an editor ever
  // normalised it away, the corpus would stop testing the one thing this row is here for.
  const buf = fs.readFileSync(path.join(DIR, 'events-2026-03-04.jsonl'))
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM is missing')
})

test('a blank line and a comment line are counted, not treated as errors', () => {
  const { report } = readDay('2026-03-04')
  assert.equal(report.skipped.blank, 1)
  assert.equal(report.skipped.comment, 1)
})

test('the malformed line is MID-FILE, so it counts as malformed and never as a truncated tail', () => {
  // This is the load-bearing distinction in the whole reader. An unparseable TAIL is a writer
  // caught mid-flight and benign; an unparseable line in the MIDDLE is evidence that append
  // atomicity failed on this filesystem. A corpus that let the malformed line drift to the end
  // would still parse, and would have silently stopped testing that difference.
  const { report } = readDay('2026-03-04')
  assert.equal(report.skipped.malformed, 1, 'exactly one malformed line')
  assert.equal(report.skipped.truncated_tail, 0, 'the malformed line must not be at the tail')
  assert.equal(report.skipped.unterminated_tail_parsed, 0)
})

test('no segment ends mid-record, so a clean read reports no tail anomaly at all', () => {
  const { report } = readAll()
  assert.equal(report.skipped.truncated_tail, 0)
  assert.equal(report.skipped.oversize_line, 0)
  assert.equal(report.skipped.not_an_object, 0)
  assert.equal(report.skipped.unrecognized, 0)
  assert.deepEqual(report.errors, [], 'a committed corpus must never produce a read error')
})

test('every committed segment uses LF endings, which .gitattributes is what preserves', () => {
  // core.autocrlf on a Windows clone would rewrite every line. Parsing survives (the reader
  // strips exactly one trailing \r) but the BOM case becomes ambiguous and byte counts move.
  const violations = []
  for (const name of Object.keys(DECLARED)) {
    const text = fs.readFileSync(path.join(DIR, name), 'utf8')
    if (text.includes('\r')) violations.push(name)
  }
  assert.deepEqual(violations, [], 'a CR survived: check .gitattributes')
})

test('.gitattributes pins the corpus to LF', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8')
  assert.match(text, /test\/fixtures\/telemetry\/\*\.jsonl\s+text\s+eol=lf/)
})

/* ------------------------------------------------------------- row validity */

test('every yielded row is flat and scalar-only, because the schema forbids nesting', () => {
  const { records } = readAll()
  const violations = []
  for (const row of records) {
    for (const [key, value] of Object.entries(row)) {
      const t = typeof value
      if (value !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
        violations.push(`${row.event_id}.${key} is ${Array.isArray(value) ? 'an array' : t}`)
      }
    }
  }
  assert.deepEqual(violations, [], 'an array is nesting with extra steps')
})

test('every declared field is present on every row, because absent and null are different', () => {
  const { records } = readAll()
  const violations = []
  for (const row of records) {
    for (const field of FIELD_ORDER) {
      if (!(field in row)) violations.push(`${row.event_id} is missing ${field}`)
    }
  }
  assert.deepEqual(violations, [], 'a row dropped a declared column')
})

test('the one row carrying an undeclared key is tolerated, not rejected', () => {
  // Rows are open on read for the same reason enums are: an older reader must still ingest a
  // newer writer's row rather than discarding the window.
  const { records } = readAll()
  const extra = records.filter((r) => 'future_field_nobody_declared' in r)
  assert.equal(extra.length, 1, 'the undeclared-key row must survive the read')
})

test('a future schema_version is YIELDED by the reader and left for the aggregation layer', () => {
  // Forward compatibility is the aggregation layer's filter, not the reader's.
  const { records } = readAll()
  const future = records.filter((r) => r.schema_version !== SCHEMA_VERSION)
  assert.equal(future.length, 1, 'exactly one future-schema row')
  assert.equal(future[0].schema_version, 2)
})

/* ---------------------------------------------- the distinctions it pins */

test('the default-install segment carries no money at all — the shipped state of a new install', () => {
  // Every rate in BUNDLED_PRICING ships null, so this is what a first report actually looks
  // like. If this ever gains a money value, a rate was invented.
  const { records } = readDay('2026-03-03')
  const moneyFields = [
    'worker_input_cost',
    'worker_cached_input_cost',
    'worker_output_cost',
    'worker_total_cost',
    'primary_input_cost',
    'primary_output_cost',
    'primary_total_cost',
    'estimated_cost_avoided',
    'estimated_net_savings',
  ]
  const violations = []
  for (const row of records) {
    for (const field of moneyFields) {
      if (row[field] !== null) violations.push(`${row.event_id}.${field} = ${row[field]}`)
    }
  }
  assert.deepEqual(violations, [], 'the default-install segment must hold no priced value')
})

test('the default-install segment still reports tokens avoided — the one populated headline', () => {
  const { records } = readDay('2026-03-03')
  const avoided = records.filter((r) => r.estimated_tokens_avoided !== null)
  assert.ok(avoided.length >= 3, 'tokens avoided is the figure that survives an unpriced install')
  for (const row of avoided) assert.equal(row.estimated_tokens_avoided_status, 'estimated')
})

test('a structurally-zero cost and an unknown cost are two different rows', () => {
  // 0/actual is an operator-configured rate that rate() preserved. null/unavailable is a
  // refusal to price. Collapsing them is the single most misleading thing a report could do.
  const { records } = readAll()
  const zero = records.filter((r) => r.worker_total_cost === 0 && r.worker_total_cost_status === 'actual')
  const unknown = records.filter(
    (r) => r.worker_total_cost === null && r.worker_total_cost_status === 'unavailable',
  )
  assert.ok(zero.length >= 1, 'the corpus needs a genuine zero-cost row')
  assert.ok(unknown.length >= 1, 'the corpus needs a genuine unknown-cost row')
})

test('a governance denial keeps the gate reason that APPROVED it', () => {
  // The discriminator is governance_decision alone. task_type is gate_block and routing_reason
  // is threshold_met, so anything reading those two as "routing refused" folds budget denials
  // into gate refusals and loses the entire governance signal.
  const { records } = readAll()
  const denials = records.filter((r) => r.governance_decision === 'deny')
  assert.equal(denials.length, 3, 'three denials, one per reason')
  for (const row of denials) {
    assert.equal(row.task_type, 'gate_block')
    assert.equal(row.routing_reason, 'threshold_met', 'the gate approved; governance refused')
    assert.equal(row.status, 'skipped', 'a refusal is never an error')
    assert.equal(row.error_code, null, 'a refusal carries no error code')
  }
  assert.deepEqual(
    denials.map((r) => r.governance_reason).sort(),
    ['cost_unknown', 'daily_budget_exceeded', 'usage_unknown'],
  )
})

test('a gate refusal reached before governance leaves all eight governance columns null', () => {
  // All eight null means governance was NEVER CONSULTED, which is a different state from
  // "governance allowed this". The corpus carries one of each.
  const { records } = readAll()
  const governanceFields = [
    'governance_decision',
    'governance_reason',
    'budget_scope',
    'budget_limit',
    'budget_remaining',
    'budget_measurement_status',
    'reservation_tokens',
    'reservation_status',
  ]
  const neverConsulted = records.filter((r) => governanceFields.every((f) => r[f] === null))
  assert.ok(neverConsulted.length >= 1, 'the corpus needs a never-consulted row')
  const consulted = records.filter((r) => r.governance_decision !== null)
  assert.ok(consulted.length >= 1, 'and a consulted one')
})

test('the two kinds of context_exceeded are distinguishable, and only one of them cost money', () => {
  // Pre-flight refused before the call. The truncation discard RAN, spent real tokens, and
  // threw the answer away. Averaging them hides the only unambiguous waste figure in the store.
  const { records } = readAll()
  const refusals = records.filter((r) => r.routing_reason === 'context_exceeded')
  assert.equal(refusals.length, 2)

  const preflight = refusals.filter((r) => r.worker_input_truncation_detected !== true)
  const discarded = refusals.filter((r) => r.worker_input_truncation_detected === true)
  assert.equal(preflight.length, 1)
  assert.equal(discarded.length, 1)

  assert.equal(preflight[0].worker_input_tokens, null, 'pre-flight never called the provider')
  assert.equal(preflight[0].provider_latency_ms, null)
  assert.ok(discarded[0].worker_input_tokens > 0, 'the discard consumed real input tokens')
  assert.ok(discarded[0].provider_latency_ms > 0, 'and spent real wall-clock in the provider')
  assert.equal(discarded[0].status, 'skipped', 'and still delivered nothing usable')
})

test('a context refusal carries its capability fields, which is what makes it explainable', () => {
  const { records } = readAll()
  for (const row of records.filter((r) => r.routing_reason === 'context_exceeded')) {
    assert.notEqual(row.worker_context_tokens, null, 'the window must be on the row')
    assert.notEqual(row.worker_requested_input_tokens, null, 'and the figure it was refused on')
  }
})

test('a provider error is a different row class from every refusal', () => {
  const { records } = readAll()
  const errors = records.filter((r) => r.status === 'error')
  assert.ok(errors.length >= 3, 'the corpus needs several genuine failures')
  for (const row of errors) {
    assert.notEqual(row.error_code, null, 'a failure names its error code')
    assert.equal(row.governance_decision === 'deny', false, 'a failure is not a denial')
  }
  assert.ok(new Set(errors.map((r) => r.error_code)).size >= 2, 'more than one error code')
})

test('negative tokens and negative dollars are two different populations', () => {
  // THE ROW THAT PROVES IT: +500 tokens avoided with a -$0.013 net, because the worker is
  // priced above the primary's input rate. Reporting only one of these two counts hides a row.
  const { records } = readAll()
  const negTokens = records.filter((r) => r.estimated_tokens_avoided !== null && r.estimated_tokens_avoided < 0)
  const negDollars = records.filter((r) => r.estimated_net_savings !== null && r.estimated_net_savings < 0)
  assert.equal(negTokens.length, 1)
  assert.equal(negDollars.length, 2)

  const dollarsOnly = negDollars.filter((r) => !(r.estimated_tokens_avoided < 0))
  assert.equal(dollarsOnly.length, 1, 'one row saves context and still loses money')
  assert.ok(dollarsOnly[0].estimated_tokens_avoided > 0)
})

test('an unknown enum is preserved verbatim and flagged, never rewritten to `other`', () => {
  const { records } = readAll()
  const unknown = records.filter((r) => r.validation_codes?.includes('unknown_enum:routing_reason'))
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].routing_reason, 'quantum_tunnelling', 'the raw value survives the write')
  assert.ok(unknown[0].validation_warnings >= 1)
})

test('a deliberate `other` carries no validation code, which is why the two are indistinguishable', () => {
  // This is irreducible, and the response reports an `indeterminate` count rather than
  // pretending a deliberate `other` can be told from an unknown one that bucketed to `other`.
  const { records } = readAll()
  const deliberate = records.filter((r) => r.routing_reason === 'other')
  assert.equal(deliberate.length, 1)
  assert.equal(deliberate[0].validation_codes, null)
})

test('the approved-but-never-dispatched row is genuinely unexplained on the row', () => {
  // content_unreadable / content_binary. The gate approved, governance approved, nothing
  // dispatched, and no field says why. A real telemetry gap, and the corpus records it so the
  // analytics layer is forced to surface it as ambiguous rather than guess.
  const { records } = readAll()
  const candidates = records.filter(
    (r) =>
      r.task_type === 'gate_block' &&
      r.governance_decision === 'allow' &&
      r.routing_reason === 'threshold_met',
  )
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].error_code, null, 'nothing on the row names the cause')
})

test('an unknown capability is null, and null context is never infinite context', () => {
  const { records } = readAll()
  const unknown = records.filter((r) => r.worker_context_status === 'unknown')
  assert.ok(unknown.length >= 1)
  for (const row of unknown) {
    assert.equal(row.worker_context_tokens, null, 'contextTokens is null iff status is unknown')
    assert.equal(row.worker_context_source, 'unknown')
  }
})

test('only a provider_api source ever yields a measured capability status', () => {
  const { records } = readAll()
  const violations = []
  for (const row of records) {
    if (row.worker_context_status === 'measured' && row.worker_context_source !== 'provider_api') {
      violations.push(`${row.event_id}: measured from ${row.worker_context_source}`)
    }
  }
  assert.deepEqual(violations, [], 'a configured value is never a measured capability')
})

/* ----------------------------------------------------- the leak markers */

test('the content fields are populated on exactly one row, with markers found nowhere else', () => {
  // Leak tests assert the absence of a STRING, not the absence of a field name — that checks
  // the property that actually matters, which is that a value never reaches an output.
  const { records } = readAll()
  const marked = records.filter((r) => r.question_text !== null)
  assert.equal(marked.length, 1, 'exactly one row carries content')
  assert.equal(marked[0].question_text, 'FIXTURE-MUST-NOT-APPEAR-questiontext')
  assert.equal(marked[0].error_message_safe, 'FIXTURE-MUST-NOT-APPEAR-errormessage')
  assert.equal(marked[0].project_path, 'FIXTURE-MUST-NOT-APPEAR-projectpath')
})

test('the leak markers appear in the corpus and in no shipped source file', () => {
  // If a marker ever appeared in lib/ or scripts/, the absence assertions elsewhere would be
  // testing a string the code itself supplies, and would pass for the wrong reason.
  const MARKER = 'FIXTURE-MUST-NOT-APPEAR'
  const hits = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.mjs') && fs.readFileSync(full, 'utf8').includes(MARKER)) {
        hits.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(REPO_ROOT, 'plugins'))
  assert.deepEqual(hits, [], 'a fixture leak marker leaked into shipped source')
})

/* ----------------------------------------------------------- the README */

test('the README documents every segment the corpus holds', () => {
  const text = fs.readFileSync(README, 'utf8')
  const violations = []
  for (const name of Object.keys(DECLARED)) {
    if (!text.includes(name)) violations.push(name)
  }
  assert.deepEqual(violations, [], 'a segment exists that the README never mentions')
})

test('the README states that the corpus is measured and never generated', () => {
  // The claim is load-bearing: it is why there is no staleness CI step for this directory.
  const text = fs.readFileSync(README, 'utf8')
  assert.match(text, /measured by a test, never generated/i)
  assert.match(text, /no generator/i)
})
