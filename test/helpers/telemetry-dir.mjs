/**
 * Shared telemetry test scaffolding.
 *
 * Everything here is injection-based, mirroring the house style: the library takes `dir`, `now`,
 * `pid` and `fs` as options, so a test never mutates process.env and never writes outside
 * `test/.tmp/` (which .gitignore already reserves). A per-pid directory suffix keeps parallel
 * `node --test` processes from colliding.
 *
 * The clock is FROZEN rather than real. Without that, a run at 23:59:59.9 UTC rolls the daily
 * segment mid-test and a "one shared file" assertion fails — a genuine flake that fires once a
 * day and is almost impossible to reproduce.
 */

import { FIXTURE_ROUTER_VERSION } from './versions.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 2026-03-04T12:00:00.000Z — mid-day UTC, so no rotation boundary is anywhere near. */
export const FROZEN_MS = Date.parse('2026-03-04T12:00:00.000Z')
export const FROZEN_DATE = '2026-03-04'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const TMP_ROOT = path.join(REPO_ROOT, 'test', '.tmp')

/**
 * A fresh empty directory under test/.tmp, removed by cleanup().
 *
 * WHY cleanup() RETRIES. On Windows a directory cannot be removed while any handle into it is
 * open, and the suites that spawn child writers — governance.concurrency, telemetry.concurrency —
 * call cleanup() as soon as the last child reports, which is before the OS has finished tearing
 * those processes down. `force: true` only suppresses ENOENT, so the EBUSY or EPERM propagated and
 * the directory was left behind: a full run was leaving sixteen scratch directories under
 * test/.tmp, each holding a ledger and a lock file.
 *
 * `maxRetries` with a delay is the documented remedy, and it is also why cleanup() never throws.
 * A test must not fail because the filesystem was slow to let go of a directory it no longer
 * needs, and a leaked scratch directory must not be invisible either — hence the sweep in
 * test/resources.test.mjs, which asserts the tree is empty after a run.
 */
export function makeTempDir(label) {
  const dir = path.join(TMP_ROOT, `${label}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  const remove = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  remove()
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    cleanup() {
      try {
        remove()
      } catch {
        // Last resort only. A scratch directory that outlives its test is a hygiene problem, not
        // a correctness one, and failing the test here would report the wrong defect.
      }
    },
  }
}

/**
 * A resolved-config shape good enough for the telemetry layer, without reading a config file.
 * Mirrors what loadConfig() produces, including the grafted `dirResolved` and `projectDir`.
 */
export function telemetryConfig(dir, overrides = {}) {
  return {
    enabled: true,
    projectDir: dir,
    worker: { provider: 'gemini', model: 'gemini-3.8-flash' },
    pricing: { source: 'bundled', overrides: null },
    telemetry: {
      enabled: true,
      sink: 'jsonl',
      dir,
      dirResolved: dir,
      rotation: 'daily',
      shardByPid: false,
      retentionDays: 90,
      primaryModel: null,
      avoidedMethod: 'chars_div_4',
      counterfactualRender: 'raw',
      countProvenFilesOnly: true,
      residencyTurns: 0,
      residencySource: 'default_zero',
      privacyLevel: 'hashed',
      saltScope: 'install',
      storeProjectLabel: false,
      storeFilePaths: false,
      storeGitBranch: false,
      storeQuestionText: false,
      questionTextMaxChars: 200,
      storeErrorDetail: false,
      storeContentHash: false,
      ...overrides,
    },
  }
}

/** The Capabilities shape, defaulting to what every shipped provider currently reports. */
export function caps(overrides = {}) {
  return {
    maxInputBytes: 2_000_000,
    supportsSystemPrompt: true,
    reportsUsage: true,
    requiresEnv: [],
    reportsThinkingTokens: true,
    supportsCachedInput: true,
    ...overrides,
  }
}

/** A normalized Usage object. Defaults match the Gemini fixture the conformance suite locks. */
export function usage(overrides = {}) {
  return {
    inputTokens: 600,
    cachedInputTokens: 400,
    outputTokens: 120,
    thinkingTokens: 300,
    totalTokens: 1420,
    source: 'provider_reported',
    ...overrides,
  }
}

/** A fully-priced table, so the cost paths can be exercised at all. */
export function pricedTable(overrides = {}) {
  return {
    pricingVersion: 'test.1',
    unit: 'per_mtok',
    currency: 'USD',
    models: {
      'gemini:gemini-3.8-flash': {
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        inputPerMTok: 0.3,
        cachedInputPerMTok: 0.075,
        outputPerMTok: 2.5,
        thinkingBilledAsOutput: true,
        verify: 'test',
        verifiedAt: '2026-03-04',
      },
      'ollama:*': {
        provider: 'ollama',
        model: '*',
        inputPerMTok: 0,
        cachedInputPerMTok: 0,
        outputPerMTok: 0,
        thinkingBilledAsOutput: true,
        verify: 'test',
        verifiedAt: '2026-03-04',
      },
      'anthropic:claude-opus-5': {
        provider: 'anthropic',
        model: 'claude-opus-5',
        inputPerMTok: 15,
        cachedInputPerMTok: 1.5,
        outputPerMTok: 75,
        thinkingBilledAsOutput: true,
        verify: 'test',
        verifiedAt: '2026-03-04',
      },
      ...overrides,
    },
  }
}

export function pricedChain(table = pricedTable()) {
  return [{ table, source: 'file' }]
}

/* ------------------------------------------------ concurrency probe records */

/**
 * A self-checking record for the concurrency test, built from DECLARED schema fields so it goes
 * through the real serializer and the real sink rather than a test-only path.
 *
 * It is self-checking on three independent axes, so a byte-level splice from another writer
 * breaks at least one of them even when the spliced line still happens to parse:
 *
 *   1. the pad is a single repeated character which must equal `model` (the writer's pad char) —
 *      a splice from another writer injects a different fill char, caught even mid-field.
 *   2. the pad's length must equal the length recorded in `session_id` — a splice that changes
 *      length is caught.
 *   3. `finish_reason` must equal sha256(task_id|padLen|nonce) truncated — a splice in the header
 *      fields is caught.
 *
 * TWO FIELD CHOICES THAT MATTER, both forced by the size guard rather than by taste:
 *
 *   - The pad lives in `question_text`, which IS in SHED_ORDER, and that is deliberate. A record
 *     is only legitimately large through a shed field: the guard clamps those to fit, and
 *     carcasses any record made large through a field it cannot shrink. So the only way to build
 *     a valid, untruncated, exactly-at-cap record is to size a shed field so that it fits
 *     without shedding — which is exactly the boundary the off-by-one assertion probes.
 *   - The length marker lives in `session_id` as a ZERO-PADDED fixed-width string. A plain
 *     integer gains a digit as the pad grows, which makes serialized size jump by two bytes at
 *     each power of ten and leaves some target sizes unreachable. Fixed width makes size an
 *     exact `base + padLen`, so the at-cap record can be hit precisely.
 */
export const PAD_CHARS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const LEN_WIDTH = 10

export function probeCheck(taskId, padLen, nonce) {
  return crypto.createHash('sha256').update(`${taskId}|${padLen}|${nonce}`).digest('hex').slice(0, 16)
}

export function buildProbeRecord({ writerIndex, seq, padLen, nonce }) {
  const padChar = PAD_CHARS[writerIndex % PAD_CHARS.length]
  const taskId = `w${writerIndex}:${seq}`
  return {
    schema_version: 1,
    event_id: `${taskId}-${nonce}`,
    timestamp: new Date(FROZEN_MS).toISOString(),
    tz_offset_minutes: 0,
    router_version: FIXTURE_ROUTER_VERSION,
    calc_version: 1,
    pricing_version: null,
    pricing_source: 'none',
    currency: 'USD',
    privacy_level: 'hashed',
    session_id: String(padLen).padStart(LEN_WIDTH, '0'),
    question_text: padChar.repeat(padLen),
    task_id: taskId,
    task_type: 'delegation',
    routing_decision: 'delegated',
    routing_reason: 'threshold_met',
    model: padChar,
    files_count: seq,
    input_bytes: seq,
    finish_reason: probeCheck(taskId, padLen, nonce),
    status: 'ok',
    truncation_steps: null,
    validation_warnings: 0,
    validation_codes: null,
  }
}

/** Verify a read-back probe record against all three axes. Returns a problem string, or null. */
export function checkProbeRecord(rec, nonce) {
  const pad = rec.question_text
  if (typeof pad !== 'string') return `question_text is not a string on ${rec.task_id}`
  if (typeof rec.session_id !== 'string' || rec.session_id.length !== LEN_WIDTH) {
    return `session_id is not a ${LEN_WIDTH}-char length marker on ${rec.task_id}`
  }
  const declared = Number(rec.session_id)
  if (pad.length !== declared) return `pad length ${pad.length} != declared ${declared} on ${rec.task_id}`
  if (pad.length > 0) {
    const uniq = new Set(pad)
    if (uniq.size !== 1) return `pad on ${rec.task_id} contains ${uniq.size} distinct chars (spliced)`
    if (!uniq.has(rec.model)) return `pad char on ${rec.task_id} is not ${rec.model} (spliced)`
  }
  const want = probeCheck(rec.task_id, declared, nonce)
  if (rec.finish_reason !== want) return `check mismatch on ${rec.task_id}`
  return null
}

/**
 * Find the pad length that serializes to EXACTLY `targetBytes`.
 *
 * BINARY SEARCH, not a fixed-point iteration, because the pad lives in a shed field: the moment
 * padLen overshoots the cap the guard clamps the field and the measured size COLLAPSES instead of
 * growing, so size is not a usable error signal above the fit point. The predicate "fits and was
 * not truncated" is monotone in padLen, which binary search can use and iteration cannot.
 *
 * Measured against the real serializer rather than estimated from input lengths, because escaping
 * rules make any such estimate wrong.
 */
export function padToExactly({ writerIndex, seq, nonce, targetBytes, serialize }) {
  const fits = (padLen) => {
    const { bytes, truncation } = serialize(buildProbeRecord({ writerIndex, seq, padLen, nonce }))
    return { ok: truncation === null && bytes <= targetBytes, bytes }
  }

  let lo = 0
  let hi = targetBytes
  if (!fits(lo).ok) return null
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid).ok) lo = mid
    else hi = mid - 1
  }
  return fits(lo).bytes === targetBytes ? lo : null
}
