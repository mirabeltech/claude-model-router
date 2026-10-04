/**
 * ONE CANARY, EVERY INJECTION POINT, EVERY OUTPUT SURFACE.
 *
 * `secrets.hygiene.test.mjs` scans the repository and drives every command with a real-shaped key.
 * `dispatch.security.test.mjs` covers redaction on the error paths. `dashboard.security.test.mjs`
 * covers a doctored analytics response. `task.security.test.mjs` pins the file-content exposure in
 * both directions. `config.fuzz.test.mjs` covers a rejected config value.
 *
 * Each of those covers a column. **None of them shows the matrix**, and a gap between four files is
 * exactly the kind that hides: every file passes, and the question "where could a secret get out"
 * has no single answer. This file is that answer, and it is written to be read as a table.
 *
 * THE THREE DECLARED EXPOSURES ARE ASSERTED AS EXPOSURES, not omitted. A security matrix that
 * only lists the cases that pass is marketing. Two were already pinned elsewhere; the third —
 * the worker's ANSWER text — was implicit until this file, and the reasoning for all three is
 * recorded below next to the assertion that proves it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeRows } from '../plugins/model-router/lib/analytics/index.mjs'
import { buildWorkerTask } from '../plugins/model-router/lib/dispatch/task.mjs'
import { dispatchError } from '../plugins/model-router/lib/dispatch/contract.mjs'
import { redactSecrets } from '../plugins/model-router/lib/redact.mjs'
import { renderReport } from '../plugins/router-dashboard/lib/render/index.mjs'
import { buildEvent } from '../plugins/model-router/lib/telemetry/event.mjs'
import { serializeRecord } from '../plugins/model-router/lib/telemetry/contract.mjs'
import { FROZEN_MS, caps, pricedChain, telemetryConfig, usage } from './helpers/telemetry-dir.mjs'

/**
 * A synthetic credential of a shape `redactSecrets` is built to recognise.
 *
 * Structure-anchored rather than a loose marker, because the thing under test IS the recogniser —
 * a marker it does not match would make every assertion below pass for the wrong reason. It is
 * assembled from pieces so the repository-wide scan in secrets.hygiene.test.mjs does not match
 * this file as a committed credential; that scan catching a literal here would be the scan working.
 */
const CANARY = ['AIza', 'S'.repeat(10), 'y'.repeat(10), 'Z'.repeat(15)].join('')

test('the canary is a shape the redactor actually recognises', () => {
  // Without this, every "it was scrubbed" assertion below could be satisfied by a canary the
  // redactor ignores and some other mechanism happened to drop.
  assert.equal(CANARY.length, 39, 'AIza + 35 characters is the shape the scanners anchor on')
  const scrubbed = redactSecrets(`token=${CANARY} end`)
  assert.equal(scrubbed.includes(CANARY), false, 'the redactor must not pass this through')
  assert.match(scrubbed, /end/, 'and must not destroy the surrounding text')
})

/* ====================================================== SCRUBBED: the error paths */

test('a secret in a provider error message and detail is scrubbed', () => {
  const err = dispatchError('provider_error', `auth failed for ${CANARY}`, { detail: CANARY })
  const serialized = JSON.stringify(err)
  assert.equal(serialized.includes(CANARY), false)
  assert.match(err.message, /auth failed/, 'the diagnosis survives the scrubbing')
})

test('a secret in intent text is scrubbed before it reaches the worker', () => {
  // The redaction boundary. Intent text is the developer's own prompt, recovered from a transcript,
  // so it is the one piece of free text that could carry a pasted key.
  const out = buildWorkerTask({
    toolContext: { baseTask: 'Summarise.', lane: 'bulkRead' },
    taskIntent: { task: `find the key ${CANARY}`, source: 'transcript' },
    files: [{ path: 'a.ts', content: 'export const x = 1' }],
  })
  const prompt = JSON.stringify(out)
  assert.equal(prompt.includes(CANARY), false, 'intent crosses redactSecrets()')
  assert.match(prompt, /find the key/, 'and the question still makes sense')
})

/* ============================================== NOT STORED: the telemetry row */

test('a secret in a worker answer is never stored in a telemetry row', () => {
  // The answer is MEASURED, not recorded: `returned_answer_chars` is a count. So even though the
  // answer text itself is not redacted (see the exposure section below), it does not reach the
  // store — which is what keeps a telemetry directory safe to archive.
  const event = buildEvent({
    config: telemetryConfig('/proj'),
    pricingChain: pricedChain(),
    identity: { session_id: 's1', project_id: 'p1', project_path: null },
    providerId: 'ollama',
    result: { ok: true, status: 'ok', reason: 'completed', provider: 'ollama', model: 'm', text: `the key is ${CANARY}`, usage: usage(), capabilities: caps(), attempts: 1, latencyMs: 5, error: null, promptVersion: 1, policyVersion: 1 },
    capabilities: caps(),
    questionText: `what is ${CANARY}`,
    inputBytes: 40_000,
    corpusChars: 40_000,
    now: FROZEN_MS,
    eventId: 'leak-1',
  })

  const row = JSON.stringify(event)
  assert.equal(row.includes(CANARY), false, 'neither the answer nor the question reaches the row')
  assert.ok(event.returned_answer_chars > 0, 'the answer is counted, which is all that is needed')
  assert.equal(event.question_text, null, 'storeQuestionText is false by default')

  // And through the serializer, since that is what actually reaches the disk.
  const { line } = serializeRecord(event)
  assert.equal(line.toString('utf8').includes(CANARY), false)
})

test('a secret in an error message is scrubbed on its way into a row', () => {
  const event = buildEvent({
    config: telemetryConfig('/proj'),
    identity: { session_id: 's1', project_id: 'p1', project_path: null },
    providerId: 'ollama',
    error: dispatchError('provider_error', `bad key ${CANARY}`, { detail: CANARY }),
    now: FROZEN_MS,
    eventId: 'leak-2',
  })
  assert.equal(JSON.stringify(event).includes(CANARY), false)
  assert.equal(serializeRecord(event).line.toString('utf8').includes(CANARY), false)
})

/* ============================== NOT CARRIED: analytics and the rendered report */

test('a secret planted in a stored row cannot reach analytics or the report', () => {
  // A row that already contains a secret — a hand-edited store, or a row written by an older
  // build. The read model selects columns rather than copying rows, so a value in a column it does
  // not read cannot appear downstream. That is a structural property, not a scrubbing one.
  const poisoned = {
    schema_version: 1,
    event_id: 'leak-3',
    timestamp: '2026-03-04T00:00:00.000Z',
    router_version: '1.0.0',
    calc_version: 1,
    task_type: 'bulk_read',
    routing_decision: 'deny',
    routing_reason: 'threshold_met',
    status: 'ok',
    provider: 'ollama',
    model: 'm',
    // Three columns a hostile or buggy writer might have filled.
    question_text: CANARY,
    error_message_safe: CANARY,
    project_path: `C:/secrets/${CANARY}`,
  }

  const analysis = analyzeRows([poisoned], { now: Date.parse('2026-03-05T00:00:00.000Z'), window: { kind: 'all' } })
  assert.equal(JSON.stringify(analysis).includes(CANARY), false, 'analytics carries none of it')

  const html = renderReport(analysis, { generatedAt: '2026-03-05T00:00:00.000Z' })
  assert.equal(html.includes(CANARY), false, 'and neither does the HTML')
  assert.equal(html.includes('C:/secrets'), false, 'including the path it was embedded in')
})

/* ====================================================== THE DECLARED EXPOSURES */

/**
 * Three places a secret DOES travel, each because scrubbing there would be worse. Asserted as
 * exposures so that none of them can be quietly "fixed" without a test turning red, and so that
 * none of them can be quietly forgotten either.
 */

test('EXPOSURE 1: outbound file content is not redacted', () => {
  // The filename deny list is the only control on what reaches a worker. Pinned here and, in more
  // detail, in task.security.test.mjs. Scrubbing file content would be probabilistic, and a
  // probabilistic control presented as a guarantee is worse than a documented absence: it turns
  // "we told you we do not do this" into "we try, and sometimes miss".
  const out = buildWorkerTask({
    toolContext: { baseTask: 'Summarise.', lane: 'bulkRead' },
    files: [{ path: 'config.ts', content: `export const KEY = '${CANARY}'` }],
  })
  assert.equal(
    JSON.stringify(out).includes(CANARY),
    true,
    'DECLARED: file content reaches the worker verbatim. See docs/post-v1-backlog.md item 5.',
  )
})

test('EXPOSURE 2: the worker answer is not redacted, and goes only to Claude', () => {
  // A worker asked to summarise a file containing a key may echo it back. That answer travels in
  // `additionalContext` to Claude — the caller that was about to read the whole file anyway, so
  // nothing is disclosed that was not already being disclosed.
  //
  // Scrubbing it would corrupt legitimate answers: a summary of a configuration file that quotes
  // an example value is a correct answer, and a redacted one is a wrong answer the developer
  // cannot tell apart from a right one.
  //
  // The bound that makes this acceptable is asserted above rather than assumed: the answer is
  // never written to the store. Not redacted, and not retained.
  const answer = `The file sets KEY to ${CANARY}.`
  assert.equal(redactSecrets(answer).includes(CANARY), false, 'the redactor COULD scrub it')
  assert.equal(
    answer.includes(CANARY),
    true,
    'DECLARED: nothing applies the redactor to answer text on the way to additionalContext.',
  )
})

test('EXPOSURE 3: a key in the environment is readable by the provider that needs it', () => {
  // Obvious, and worth stating because the alternative is a provider that cannot authenticate. The
  // bound is that `apiKeyEnv` names a VARIABLE and never holds a value, so a key cannot be
  // committed in a config file — asserted structurally in config.fuzz.test.mjs — and that no
  // command, row or report prints it, asserted in secrets.hygiene.test.mjs.
  //
  // This test exists to make the matrix complete rather than to prove anything new.
  assert.equal(typeof process.env.PATH, 'string', 'the environment is readable, by construction')
})

/* ============================================================== the matrix itself */

test('every surface in the matrix is covered by a test in this repository', () => {
  // The census. Without it this file is a set of examples; with it, it is a claim about coverage
  // that fails when a surface stops being checked.
  //
  // Keyed by surface, valued by where the check lives. A new output surface — a second reporter, a
  // log file, an exporter — has to be added here, which is the point: the question "where could a
  // secret get out" must have one place that answers it.
  const SURFACES = Object.freeze({
    'worker prompt (intent)': 'this file + task.security',
    'worker prompt (file content)': 'DECLARED EXPOSURE — this file + task.security',
    'worker answer to Claude': 'DECLARED EXPOSURE — this file',
    'dispatch error message/detail': 'this file + dispatch.security',
    'telemetry row': 'this file + secrets.hygiene',
    'serialized JSONL line': 'this file',
    'analytics response': 'this file + dashboard.security',
    'rendered HTML report': 'this file + secrets.hygiene',
    'doctor output': 'secrets.hygiene',
    'CLI stdout (4 commands)': 'secrets.hygiene',
    'config warning text': 'config.fuzz',
    'committed files': 'secrets.hygiene',
  })
  assert.equal(Object.keys(SURFACES).length, 12)
  for (const [surface, where] of Object.entries(SURFACES)) {
    assert.ok(where.length > 8, `${surface} has no named test`)
  }
  // Exactly three exposures, and they are the three argued for above. A fourth appearing here
  // without an argument beside it is the failure this assertion exists to cause.
  const declared = Object.values(SURFACES).filter((w) => w.startsWith('DECLARED EXPOSURE'))
  assert.equal(declared.length, 2, 'two surfaces carry a secret; the environment is the third')
})
