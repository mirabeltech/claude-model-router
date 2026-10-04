/**
 * Threshold semantics.
 *
 * OR across the three size proxies, AND across the categories. The distinction is the whole point:
 * `minLines`, `minBytes` and `minEstimatedTokens` are three proxies for ONE quantity, while
 * `minFiles`, `maxFiles` and the size question are different quantities.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { decide } from '../plugins/model-router/lib/routing.mjs'
import { DEFAULTS } from '../plugins/model-router/lib/config.mjs'
import { bulkReadInput, routingConfig } from './helpers/routing-input.mjs'

/** A baseline whose every size proxy is BELOW threshold, so each test turns exactly one on. */
const tiny = (over = {}) =>
  bulkReadInput({ fileCount: 1, lineCount: 1, inputBytes: 1, estimatedInputTokens: 1, paths: ['/proj/a.ts'], ...over })

const bulk = (over = {}) => routingConfig({ routing: { bulkRead: over } })

/* ------------------------------------------------------ OR across the proxies */

test('line count alone is enough to delegate', () => {
  assert.equal(decide(tiny({ lineCount: 350 }), routingConfig()).delegate, true)
})

test('byte size alone is enough to delegate — a short minified file is still a big payload', () => {
  assert.equal(decide(tiny({ inputBytes: 12000 }), routingConfig()).delegate, true)
})

test('an estimated token count alone is enough, once the proxy is configured', () => {
  assert.equal(decide(tiny({ estimatedInputTokens: 9000 }), bulk({ minEstimatedTokens: 9000 })).delegate, true)
})

test('no size proxy satisfied means no delegation', () => {
  assert.equal(decide(tiny(), routingConfig()).reason, 'below_threshold')
})

test('a proxy that is unmeasured does not veto a proxy that is satisfied', () => {
  // This is the argument for OR rather than AND. A Grep across ten files has no line count, and
  // AND would turn every such call into a permanent refusal.
  const d = decide(tiny({ lineCount: null, inputBytes: 40000 }), routingConfig())
  assert.equal(d.delegate, true)
})

/* ------------------------------------------------------------ the boundaries */

test('the line threshold is inclusive — exactly minLines delegates', () => {
  assert.equal(decide(tiny({ lineCount: 350 }), bulk({ minLines: 350 })).delegate, true)
})

test('one line below the line threshold does not delegate', () => {
  assert.equal(decide(tiny({ lineCount: 349 }), bulk({ minLines: 350 })).reason, 'below_threshold')
})

test('the byte threshold is inclusive', () => {
  assert.equal(decide(tiny({ inputBytes: 12000 }), bulk({ minBytes: 12000 })).delegate, true)
})

test('the token threshold is inclusive', () => {
  assert.equal(decide(tiny({ estimatedInputTokens: 500 }), bulk({ minEstimatedTokens: 500 })).delegate, true)
})

/* -------------------------------------------- AND across the file-count pair */

test('exactly maxFiles still delegates; one more does not', () => {
  const at = bulkReadInput({ fileCount: 25, paths: ['/proj/a.ts'] })
  assert.equal(decide(at, routingConfig()).delegate, true)
  assert.equal(decide({ ...at, fileCount: 26 }, routingConfig()).reason, 'over_max_files')
})

test('below minFiles does not delegate even when the payload is enormous', () => {
  const d = decide(bulkReadInput({ fileCount: 2, lineCount: 99999 }), bulk({ minFiles: 3 }))
  assert.equal(d.reason, 'below_threshold')
})

test('exactly minFiles delegates', () => {
  assert.equal(decide(bulkReadInput({ fileCount: 3 }), bulk({ minFiles: 3 })).delegate, true)
})

test('over max files is reported before below threshold, so the reason names the cap', () => {
  const d = decide(tiny({ fileCount: 900, paths: ['/proj/a.ts'] }), routingConfig())
  assert.equal(d.reason, 'over_max_files')
})

/* ------------------------------------------------- the unconfigured proxy is off */

test('minEstimatedTokens defaults to null, which means the proxy never satisfies', () => {
  // Not 0. As an OR member, 0 would satisfy for ANY known token count — a loosening of a shipped
  // threshold, which CLAUDE.md's sixth non-negotiable requires a negative eval for.
  assert.equal(DEFAULTS.routing.bulkRead.minEstimatedTokens, null)
  assert.equal(decide(tiny({ estimatedInputTokens: 10 ** 7 }), routingConfig()).reason, 'below_threshold')
})

test('the token proxy cannot be configured to its loosening value', () => {
  // `min: 1` in the SPEC means 0 falls back to the default rather than being accepted.
  const config = bulk({ minEstimatedTokens: 0 })
  assert.equal(config.routing.bulkRead.minEstimatedTokens, null)
  assert.equal(decide(tiny({ estimatedInputTokens: 5 }), config).reason, 'below_threshold')
})

test('minFiles defaults to 1, which is a no-op', () => {
  assert.equal(DEFAULTS.routing.bulkRead.minFiles, 1)
  assert.equal(decide(bulkReadInput({ fileCount: 1, paths: ['/proj/a.ts'] }), routingConfig()).delegate, true)
})

test('an unknown token count never satisfies even when the proxy is configured', () => {
  assert.equal(decide(tiny({ estimatedInputTokens: null }), bulk({ minEstimatedTokens: 1 })).reason, 'below_threshold')
})

/* ---------------------------------------------------- the worker input ceiling */

test('a payload larger than the worker can ingest is refused rather than blocked', () => {
  // The worst outcome in the system is a blocked read and no answer. If the worker provably cannot
  // take the payload, the gate must get out of the way and let Claude read it.
  const d = decide(bulkReadInput({ inputBytes: DEFAULTS.worker.maxInputBytes + 1 }), routingConfig())
  assert.equal(d.reason, 'over_max_input_bytes')
  assert.equal(d.decision, 'allow')
})

test('a payload exactly at the worker ceiling still delegates', () => {
  const d = decide(bulkReadInput({ inputBytes: DEFAULTS.worker.maxInputBytes }), routingConfig())
  assert.equal(d.delegate, true)
})

test('the ceiling follows the configured worker, not a constant', () => {
  const d = decide(bulkReadInput({ inputBytes: 50000 }), routingConfig({ worker: { maxInputBytes: 20000 } }))
  assert.equal(d.reason, 'over_max_input_bytes')
})

/* ---------------------------------------------------- the code-write lane has none */

test('the code-write lane has no size thresholds, because a hook cannot measure unwritten code', () => {
  const d = decide(
    bulkReadInput({ taskType: 'code_write', toolName: 'Write', fileCount: 1, lineCount: 1, inputBytes: 1, estimatedInputTokens: 1, paths: ['/proj/a.ts'] }),
    routingConfig(),
  )
  assert.equal(d.delegate, true)
  assert.equal(d.reason, 'threshold_met')
})

test('the code-write lane ignores maxFiles too', () => {
  const d = decide(bulkReadInput({ taskType: 'code_write', toolName: 'Write', fileCount: 9999 }), routingConfig())
  assert.equal(d.delegate, true)
})

test('under default config the code-write lane can only ever suggest, never deny', () => {
  // The lane is advisory by design, and that advisory default is what makes having no size check
  // safe. If this ever becomes `deny`, the lane needs thresholds first.
  assert.equal(DEFAULTS.routing.codeWrite.enforce, 'suggest')
  assert.equal(decide(bulkReadInput({ taskType: 'code_write', toolName: 'Write' }), routingConfig()).decision, 'suggest')
})

/* ----------------------------------------------------- invalid threshold values */

test('a threshold below its spec minimum falls back to the default rather than loosening the gate', () => {
  const resolved = routingConfig({ routing: { bulkRead: { minLines: 0 } } })
  assert.equal(resolved.routing.bulkRead.minLines, DEFAULTS.routing.bulkRead.minLines)
  assert.equal(decide(tiny({ lineCount: 10 }), resolved).reason, 'below_threshold')
})

test('a non-numeric threshold falls back to its default', () => {
  const resolved = routingConfig({ routing: { bulkRead: { minLines: 'three hundred' } } })
  assert.equal(resolved.routing.bulkRead.minLines, DEFAULTS.routing.bulkRead.minLines)
})

test('a threshold above its spec maximum falls back rather than clamping', () => {
  const resolved = routingConfig({ routing: { bulkRead: { maxFiles: 10 ** 9 } } })
  assert.equal(resolved.routing.bulkRead.maxFiles, DEFAULTS.routing.bulkRead.maxFiles)
})

test('raising a threshold narrows delegation and never widens it', () => {
  const input = bulkReadInput({ lineCount: 400, inputBytes: 100, estimatedInputTokens: 10 })
  assert.equal(decide(input, bulk({ minLines: 350 })).delegate, true)
  assert.equal(decide(input, bulk({ minLines: 500 })).delegate, false)
})
