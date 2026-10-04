/**
 * Turning a case into a routing input, and comparing the real decision against the expectation.
 *
 * PURE: no filesystem, no clock. The caller supplies the resolved absolute paths and the project
 * directory; this module only shapes them.
 *
 * THE BASELINE IS DELIBERATELY DELEGATION-WORTHY, the same discipline `bulkReadInput()` uses in
 * `test/helpers/routing-input.mjs`: every field starts at the value that permits delegation, and a
 * case flips exactly what it means to test. A failure then names the rule that stopped working,
 * rather than leaving the reader to work out which of sixteen fields was responsible.
 *
 * `lineCount` is the one field whose baseline differs by harness, and that difference is the point
 * of the `lines-350` pair:
 *
 *   decide — the file's real line count, because a caller at that layer can supply one
 *   hook   — null, because `hook/adapter.mjs` leaves it null by design and so `minLines` is
 *            unreachable in production
 *
 * Asserting one number for both would hide the discrepancy the corpus exists to measure.
 */

import { decide } from '../../plugins/model-router/lib/routing.mjs'
import { addOrNull } from '../../plugins/model-router/lib/telemetry/calc.mjs'

/**
 * Build the sixteen-field routing input for a case.
 *
 * @param {object} a.caseDef
 * @param {Map<string,string>} a.absPaths  declared path -> absolute path on disk
 * @param {string} a.projectDir            the scratch root the fixtures were materialised under
 * @param {boolean} [a.workerAvailable]    the harness owns the readiness probe, so it is injected
 * @returns {object} a routing input, ready for `decide()`
 */
export function toRoutingInputForCase({ caseDef, absPaths, projectDir, workerAvailable = true }) {
  // Null-strict, via the shipped sum. A file whose size could not be measured must make the TOTAL
  // unknown rather than contribute a silent zero: a partial sum presented as a corpus size is the
  // understatement that `calculateAvoidedTokens` refuses for the same reason.
  const declaredBytes = caseDef.files.length === 0 ? null : addOrNull(...caseDef.files.map((f) => f.bytes))
  const declaredLines = caseDef.files.length === 0 ? null : addOrNull(...caseDef.files.map((f) => f.lines))
  const paths = caseDef.files.map((f) => absPaths.get(f.path)).filter((p) => p !== undefined)

  const base = {
    taskType: 'bulk_read',
    toolName: 'Read',
    requestedOutput: null,
    projectPath: projectDir,
    paths,
    workerUnavailableReason: null,

    // Every boolean at its permissive value, so a refusal is always attributable to a flip.
    targetedRead: false,
    fullRead: true,
    recentlyEdited: false,
    latencySensitive: false,
    interactive: false,
    workerAvailable,

    fileCount: caseDef.files.length,
    lineCount: caseDef.harness === 'hook' ? null : declaredLines,
    inputBytes: declaredBytes,

    // Null, matching the hook: `minEstimatedTokens` defaults to null and so is never satisfiable.
    // Supplying a number here would make the corpus exercise a threshold production cannot reach.
    estimatedInputTokens: null,
  }

  // The case's own overrides come last and are already closed against the sixteen field names by
  // `validateCase`, so an unknown key cannot arrive here and be silently dropped.
  return { ...base, ...caseDef.routingInput }
}

/**
 * Compare a real decision against a case's `expected` block, field by field.
 *
 * `inputWarnings` is a SUBSET match — the case names the warnings it cares about and the engine may
 * legitimately add others — while every other declared field is compared exactly. A case that
 * declares `lane: null` means it, because `null` is a meaningful lane for a refusal that happens
 * before a lane is known.
 *
 * @returns {{agrees: boolean, mismatches: string[]}}
 */
export function compareDecision(caseDef, decision) {
  const mismatches = []
  const expected = caseDef.expected

  const check = (field, actual, want) => {
    if (actual !== want) mismatches.push(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`)
  }

  check('delegate', decision.delegate, expected.class === 'delegate')
  check('reason', decision.reason, expected.reason)
  check('taskType', decision.taskType, expected.taskType)
  check('decision', decision.decision, expected.decision)
  check('lane', decision.lane, expected.lane)
  check('mode', decision.mode, expected.mode)

  for (const want of expected.inputWarnings) {
    if (!decision.inputWarnings.includes(want)) {
      mismatches.push(`inputWarnings: expected to include ${JSON.stringify(want)}, got [${decision.inputWarnings.join(', ')}]`)
    }
  }

  return { agrees: mismatches.length === 0, mismatches }
}

/**
 * Run the gate for one case and report whether it agreed.
 *
 * @returns {{decision: object, agrees: boolean, mismatches: string[], input: object}}
 */
export function runDecideCase({ caseDef, absPaths, projectDir, config, workerAvailable = true }) {
  const input = toRoutingInputForCase({ caseDef, absPaths, projectDir, workerAvailable })
  const decision = decide(input, config)
  const { agrees, mismatches } = compareDecision(caseDef, decision)
  return { decision, agrees, mismatches, input }
}

/**
 * The routing confusion table.
 *
 * Reported as four raw cells plus the individual cases, and DELIBERATELY NOT as an accuracy
 * metric. The expected classes are defined by the corpus author, not measured, so a single
 * percentage would dress an author's intent up as a system property. The per-case list travels
 * with the table so an aggregate cannot hide a failure.
 *
 * @returns {{cells: object, cases: Array<object>, disagreements: Array<object>}}
 */
export function confusionTable(results) {
  const cells = {
    expectedPrimaryActualPrimary: 0,
    expectedPrimaryActualDelegate: 0,
    expectedDelegateActualPrimary: 0,
    expectedDelegateActualDelegate: 0,
  }
  const cases = []
  for (const r of results) {
    const wanted = r.caseDef.expected.class
    const actual = r.decision.delegate ? 'delegate' : 'primary'
    const key =
      wanted === 'primary'
        ? actual === 'primary'
          ? 'expectedPrimaryActualPrimary'
          : 'expectedPrimaryActualDelegate'
        : actual === 'primary'
          ? 'expectedDelegateActualPrimary'
          : 'expectedDelegateActualDelegate'
    cells[key] += 1
    cases.push({
      id: r.caseDef.id,
      expectedClass: wanted,
      actualClass: actual,
      expectedReason: r.caseDef.expected.reason,
      actualReason: r.decision.reason,
      agrees: r.agrees,
      mismatches: r.mismatches,
    })
  }
  return { cells, cases, disagreements: cases.filter((c) => !c.agrees) }
}
