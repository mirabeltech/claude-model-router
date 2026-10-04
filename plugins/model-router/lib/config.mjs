/**
 * Layered configuration for model-router.
 *
 * Resolution order, later wins:
 *   bundled defaults
 *   -> ~/.claude/model-router/config.json          (per developer)
 *   -> <project>/.claude/model-router.json         (per project, committed = team-shareable)
 *   -> CMR_* environment variables
 *   -> CLAUDE_PLUGIN_OPTION_* (plugin userConfig)
 *
 * Two rules govern everything here:
 *
 *  1. FAIL OPEN. A malformed config file, an unreadable path or a bad field value must never
 *     throw out of loadConfig(). Each bad leaf falls back to its default and records a warning.
 *     This module is loaded by a PreToolUse hook; an exception here would break the developer's
 *     session, which is strictly worse than ignoring their typo.
 *
 *  2. NO I/O IN THE CORE. resolveConfig() is pure over injected layers so the whole resolution
 *     order is unit-testable without touching disk. loadConfig() is the thin I/O wrapper.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// capability.mjs is PURE and import-free, so this pulls no provider module, no network and no I/O
// onto the hot path — it brings a naming table and two predicates. The alternative, teaching
// config.mjs to import provider MODULES, would put all three providers behind every tool call.
import { workerCoherence } from './providers/capability.mjs'

export const CONFIG_VERSION = 1

/* ------------------------------------------------------------------ defaults */

export const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  enabled: true,

  worker: {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKeyEnv: 'GEMINI_API_KEY',
    timeoutMs: 180000,
    maxRetries: 2,
    maxInputBytes: 2000000,
    temperature: 0.2,
    maxOutputTokens: 8192,
  },

  // Per-mode refinement of `worker` above. `null` means "inherit", so no shipped default is
  // copied here and the two tables cannot drift. A model name and an env-var name only mean
  // something relative to a provider, so neither is inherited across a provider change.
  workers: {
    bulkRead: { provider: null, model: null, apiKeyEnv: null, timeoutMs: null },
    codeWrite: { provider: null, model: null, apiKeyEnv: null, timeoutMs: null },
  },

  providers: {
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5-coder:7b',
      // null, NOT a number. A shipped default here would be a fabricated capability, and it
      // would be wrong for whichever model the developer actually pulled. Unset means "ask the
      // daemon, then fall back to the bundled table, then stay honestly unknown".
      contextTokens: null,
      discoverContext: true,
    },
  },

  routing: {
    bulkRead: {
      enabled: true,
      enforce: 'deny',
      minLines: 350,
      minBytes: 12000,
      // A third size proxy, OR'd with the two above. `null` means the proxy is unconfigured and
      // therefore never satisfies — 0 would satisfy for ANY known token count, which is a
      // loosening, and a loosening of a shipped threshold needs a negative eval first.
      minEstimatedTokens: null,
      // Floor on breadth, AND'd with the size question. 1 is a no-op; raising it only narrows.
      minFiles: 1,
      maxFiles: 25,
    },
    codeWrite: {
      enabled: true,
      enforce: 'suggest',
    },
    // Never delegated. Security-critical content must not leave for a third-party worker.
    denyGlobs: [
      '**/.env*',
      '**/*secret*',
      '**/*credential*',
      '**/*.pem',
      '**/*.key',
      '**/id_rsa*',
      '**/.git/**',
      '**/auth/**',
      '**/security/**',
    ],
    allowGlobs: [],
    neverDelegate: {
      onTargetedRead: true,
      onRecentlyEdited: true,
    },
  },

  // The Claude Code integration layer. `enabled` is an off-switch for interception alone: it
  // stops the hook from asking the gate, and leaves routing, telemetry and the scripts intact.
  hooks: {
    enabled: true,
    // The hook's OWN time budget, which is not the worker's. `worker.timeoutMs` defaults to
    // 180000 and `worker.maxRetries` to 2, so a hook that waited for the worker could block an
    // interactive Read for minutes. The adapter aborts its dispatch at this deadline and falls
    // open to the original Read instead.
    timeoutMs: 20000,

    // Where the worker's task comes from. OFF by default, and the default is the whole point.
    //
    // A PreToolUse payload says WHICH file Claude wants and never WHY, so with `none` the worker
    // gets the frozen generic task and the request is byte-identical to the one this plugin has
    // always sent. `transcript` recovers the newest prompt from the session transcript the hook
    // is already given — which means the developer's own prompt text leaves the machine and
    // reaches a third-party worker. That is a choice only the developer can make, so it is opt-in
    // rather than a default someone discovers afterwards. See docs/worker-task-construction.md.
    taskIntent: {
      source: 'none',
      // A bound on what crosses the boundary, not a quality knob. A prompt is usually a sentence;
      // the ceiling exists so a pasted stack trace cannot become most of the worker's payload.
      maxChars: 600,
    },
  },

  // Verifying the worker's answer against the file it summarised, BEFORE the answer replaces that
  // file in Claude's context.
  //
  // WHY THIS IS ON BY DEFAULT, when nearly nothing else in this project is. A wrong summary is the
  // one failure the developer cannot see: the file never reaches Claude, so a fabrication is
  // indistinguishable from a good summary until something built on it breaks. And the check is
  // deterministic — we still have the file, so "`Record1` is on line 11" is simply true or false.
  // It costs no network call, no model and no measurable time.
  //
  // THE ASYMMETRY IS WHAT JUSTIFIES `discard`. A false positive discards a good summary and the
  // developer gets the ordinary `Read` they would have had anyway — one wasted worker call. A
  // false negative puts an invented line number, symbol or literal into Claude's context and
  // everything after it inherits the error. Those costs are not comparable, so the default favours
  // the cheap mistake. See docs/summary-verification.md.
  verify: {
    enabled: true,
    // `discard` falls open to the real Read. `warn` substitutes the summary anyway and appends a
    // caveat naming what could not be confirmed — useful when a worker is known to be weak at
    // line numbers but still worth reading. `off` records the verdict and acts on nothing.
    onSuspect: 'discard',
    // The share of backticked identifiers that may be absent from the file before the answer is
    // suspect. A wrong line number or an invented string literal is enough on its own; identifiers
    // get a ratio because a long answer legitimately names a library type or a concept from the
    // task. 0 would make any such mention fatal.
    maxUngroundedIdentifierRatio: 0.25,
  },

  // Governance: how much worker usage is allowed, and what happens at the limit. Separate from
  // `routing`, which answers whether a task is APPROPRIATE to delegate, and from the capability
  // model, which answers whether the worker CAN run it. Three different questions.
  //
  // EVERY LIMIT SHIPS null, AND null IS NOT ZERO. `null` means "no configured limit"; `0` means
  // an operator deliberately configured a zero budget; a negative number is invalid and
  // `min: 0` rejects it. null is never coerced to 0, and never to infinity in telemetry.
  //
  // Shipping null rather than a number is the same argument as `providers.ollama.contextTokens`:
  // a shipped limit would be a fabricated policy. It would also be unenforceable — every rate in
  // the bundled pricing table is null, so worker cost is NULL out of the box and a monetary
  // budget has nothing to accumulate against. Token budgets are the only dimension that can bind
  // on a default install, and they bind only once someone sets one.
  budget: {
    enabled: true,

    // Per-run: one delegation. The only scope with no persisted state, so it needs no ledger
    // and cannot drift. This is where a runaway guard belongs.
    run: {
      maxWorkerCostUsd: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxTotalTokens: null,
    },

    // Per UTC day and per UTC month. The period is a KEY, not a scheduled job: a rollover is a
    // key mismatch, so there is nothing to run at midnight and nothing to miss.
    daily: {
      maxWorkerCostUsd: null,
      maxTotalTokens: null,
    },
    monthly: {
      maxWorkerCostUsd: null,
      maxTotalTokens: null,
    },

    // What a reached limit does. `disable` denies delegation and the request continues on plain
    // Claude Code; `warn` records the breach and delegates anyway. Neither fails the developer's
    // request — budget exhaustion means "worker acceleration unavailable", never "task failed".
    onExceed: 'disable',

    // UNKNOWN COST IS NOT ZERO COST, but it is not a reason to break a working router either.
    // `allow` records the fact and proceeds, which is what the fail-open rule requires and what
    // keeps an unpriced provider usable; `deny` is the opt-in for an operator who needs a
    // monetary ceiling enforced exactly. A provider whose cost is STRUCTURALLY zero — a local
    // one, declared `billing: 'local_free'` — is not "unknown" and is unaffected by either.
    onUnknownCost: 'allow',

    // Same shape for usage. A provider that reports no token counts cannot have them invented,
    // so under `allow` it can never exhaust a token budget. That exposure is documented rather
    // than hidden, and `deny` is the strict setting.
    onUnknownUsage: 'allow',

    // Where the accounting ledger lives. Separate from the telemetry store: telemetry is an
    // append-only record of what happened, this is small mutable state about what is allowed.
    stateDir: '~/.claude/model-router/governance',
  },

  telemetry: {
    enabled: true,
    sink: 'jsonl',
    dir: '~/.claude/model-router/telemetry',
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
    // A refusal is a measurement: "why did routing decline 400 times" is only answerable if the
    // refusals are on the record, and `task_type: 'gate_block'` exists for exactly those rows.
    // Off, the store holds delegations only and the denominator is lost.
    recordGateDecisions: true,
  },

  pricing: {
    source: 'bundled',
    overrides: null,
  },
})

/* ---------------------------------------------------------------------- spec
 *
 * One flat table of leaf descriptors drives validation AND the environment
 * overlay, so the two can never disagree about a field's type or legal values.
 */

/**
 * A value's KIND, for a rejection message that must not quote the value.
 *
 * `typeof` alone calls an array an object and null an object, which is the one distinction an
 * operator looking at a config file actually needs.
 */
const describeType = (v) => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  return typeof v
}

const S = (type, extra = {}) => ({ type, ...extra })

export const SPEC = Object.freeze({
  'version': S('int', { min: 1 }),
  'enabled': S('bool', { env: 'CMR_ENABLED' }),

  'worker.provider': S('string', { env: 'CMR_WORKER_PROVIDER', nonEmpty: true }),
  'worker.model': S('string', { env: 'CMR_WORKER_MODEL', nonEmpty: true }),
  'worker.apiKeyEnv': S('string', { env: 'CMR_WORKER_API_KEY_ENV', nonEmpty: true }),
  'worker.timeoutMs': S('int', { env: 'CMR_WORKER_TIMEOUT_MS', min: 1000, max: 1800000 }),
  'worker.maxRetries': S('int', { env: 'CMR_WORKER_MAX_RETRIES', min: 0, max: 10 }),
  'worker.maxInputBytes': S('int', { env: 'CMR_WORKER_MAX_INPUT_BYTES', min: 1024, max: 50000000 }),
  'worker.temperature': S('number', { env: 'CMR_WORKER_TEMPERATURE', min: 0, max: 2 }),
  'worker.maxOutputTokens': S('int', { env: 'CMR_WORKER_MAX_OUTPUT_TOKENS', min: 1, max: 1000000 }),

  'workers.bulkRead.provider': S('string', { env: 'CMR_BULK_READ_WORKER_PROVIDER', nonEmpty: true, nullable: true }),
  'workers.bulkRead.model': S('string', { env: 'CMR_BULK_READ_WORKER_MODEL', nonEmpty: true, nullable: true }),
  'workers.bulkRead.apiKeyEnv': S('string', { env: 'CMR_BULK_READ_WORKER_API_KEY_ENV', nonEmpty: true, nullable: true }),
  'workers.bulkRead.timeoutMs': S('int', { env: 'CMR_BULK_READ_WORKER_TIMEOUT_MS', min: 1000, max: 1800000, nullable: true }),

  'workers.codeWrite.provider': S('string', { env: 'CMR_CODE_WRITE_WORKER_PROVIDER', nonEmpty: true, nullable: true }),
  'workers.codeWrite.model': S('string', { env: 'CMR_CODE_WRITE_WORKER_MODEL', nonEmpty: true, nullable: true }),
  'workers.codeWrite.apiKeyEnv': S('string', { env: 'CMR_CODE_WRITE_WORKER_API_KEY_ENV', nonEmpty: true, nullable: true }),
  'workers.codeWrite.timeoutMs': S('int', { env: 'CMR_CODE_WRITE_WORKER_TIMEOUT_MS', min: 1000, max: 1800000, nullable: true }),

  'providers.gemini.baseUrl': S('string', { env: 'CMR_GEMINI_BASE_URL', nonEmpty: true }),
  'providers.ollama.baseUrl': S('string', { env: 'CMR_OLLAMA_BASE_URL', nonEmpty: true }),
  'providers.ollama.model': S('string', { env: 'CMR_OLLAMA_MODEL', nonEmpty: true }),
  // A window below the smallest useful answer is not a configuration, it is a typo.
  'providers.ollama.contextTokens': S('int', { env: 'CMR_OLLAMA_CONTEXT_TOKENS', min: 256, max: 10000000, nullable: true }),
  'providers.ollama.discoverContext': S('bool', { env: 'CMR_OLLAMA_DISCOVER_CONTEXT' }),

  'routing.bulkRead.enabled': S('bool', { env: 'CMR_BULK_READ_ENABLED' }),
  'routing.bulkRead.enforce': S('enum', { env: 'CMR_BULK_READ_ENFORCE', values: ['deny', 'ask', 'suggest', 'off'] }),
  'routing.bulkRead.minLines': S('int', { env: 'CMR_MIN_LINES', min: 1, max: 1000000 }),
  'routing.bulkRead.minBytes': S('int', { env: 'CMR_MIN_BYTES', min: 1, max: 100000000 }),
  'routing.bulkRead.minEstimatedTokens': S('int', {
    env: 'CMR_MIN_ESTIMATED_TOKENS',
    min: 1,
    max: 100000000,
    nullable: true,
  }),
  'routing.bulkRead.minFiles': S('int', { env: 'CMR_MIN_FILES', min: 1, max: 1000 }),
  'routing.bulkRead.maxFiles': S('int', { env: 'CMR_MAX_FILES', min: 1, max: 1000 }),

  'routing.codeWrite.enabled': S('bool', { env: 'CMR_CODE_WRITE_ENABLED' }),
  'routing.codeWrite.enforce': S('enum', { env: 'CMR_CODE_WRITE_ENFORCE', values: ['deny', 'ask', 'suggest', 'off'] }),

  'routing.denyGlobs': S('string[]', { env: 'CMR_DENY_GLOBS' }),
  'routing.allowGlobs': S('string[]', { env: 'CMR_ALLOW_GLOBS' }),
  'routing.neverDelegate.onTargetedRead': S('bool', { env: 'CMR_NEVER_ON_TARGETED_READ' }),
  'routing.neverDelegate.onRecentlyEdited': S('bool', { env: 'CMR_NEVER_ON_RECENTLY_EDITED' }),

  'hooks.enabled': S('bool', { env: 'CMR_HOOKS_ENABLED' }),
  // The ceiling is below worker.timeoutMs's on purpose: a hook is not a place to wait 30 minutes.
  'hooks.timeoutMs': S('int', { env: 'CMR_HOOK_TIMEOUT_MS', min: 1000, max: 120000 }),
  'hooks.taskIntent.source': S('enum', {
    env: 'CMR_TASK_INTENT_SOURCE',
    values: ['none', 'transcript'],
  }),
  'hooks.taskIntent.maxChars': S('int', { env: 'CMR_TASK_INTENT_MAX_CHARS', min: 0, max: 4000 }),

  // Answer verification. `enabled` ships true: a wrong summary is the one failure a developer
  // cannot see, and the check is deterministic because the file is still in hand.
  'verify.enabled': S('bool', { env: 'CMR_VERIFY_ENABLED' }),
  'verify.onSuspect': S('enum', {
    env: 'CMR_VERIFY_ON_SUSPECT',
    values: ['discard', 'warn', 'off'],
  }),
  'verify.maxUngroundedIdentifierRatio': S('number', {
    env: 'CMR_VERIFY_MAX_UNGROUNDED_RATIO',
    min: 0,
    max: 1,
  }),

  // Governance. Every limit is `nullable` because `null` is the shipped default and means "no
  // configured limit" — a distinct state from `0`, which is a configured zero budget. `min: 0`
  // is what rejects a negative budget, and the `int` type is what rejects a fractional token
  // count. `CMR_DAILY_BUDGET_USD` keeps its old spelling so an operator's muscle memory and any
  // existing shell profile survive the move from the flat `budget.dailyWorkerCostUsdLimit`.
  'budget.enabled': S('bool', { env: 'CMR_BUDGET_ENABLED' }),

  'budget.run.maxWorkerCostUsd': S('number', { env: 'CMR_RUN_BUDGET_USD', min: 0, max: 1000000, nullable: true }),
  'budget.run.maxInputTokens': S('int', { env: 'CMR_RUN_MAX_INPUT_TOKENS', min: 0, max: 1000000000, nullable: true }),
  'budget.run.maxOutputTokens': S('int', { env: 'CMR_RUN_MAX_OUTPUT_TOKENS', min: 0, max: 1000000000, nullable: true }),
  'budget.run.maxTotalTokens': S('int', { env: 'CMR_RUN_MAX_TOTAL_TOKENS', min: 0, max: 1000000000, nullable: true }),

  'budget.daily.maxWorkerCostUsd': S('number', { env: 'CMR_DAILY_BUDGET_USD', min: 0, max: 1000000, nullable: true }),
  'budget.daily.maxTotalTokens': S('int', { env: 'CMR_DAILY_MAX_TOTAL_TOKENS', min: 0, max: 1000000000000, nullable: true }),

  'budget.monthly.maxWorkerCostUsd': S('number', { env: 'CMR_MONTHLY_BUDGET_USD', min: 0, max: 1000000, nullable: true }),
  'budget.monthly.maxTotalTokens': S('int', { env: 'CMR_MONTHLY_MAX_TOTAL_TOKENS', min: 0, max: 1000000000000, nullable: true }),

  'budget.onExceed': S('enum', { env: 'CMR_BUDGET_ON_EXCEED', values: ['disable', 'warn'] }),
  'budget.onUnknownCost': S('enum', { env: 'CMR_BUDGET_ON_UNKNOWN_COST', values: ['allow', 'deny'] }),
  'budget.onUnknownUsage': S('enum', { env: 'CMR_BUDGET_ON_UNKNOWN_USAGE', values: ['allow', 'deny'] }),
  'budget.stateDir': S('string', { env: 'CMR_BUDGET_STATE_DIR', nonEmpty: true }),

  'telemetry.enabled': S('bool', { env: 'CMR_TELEMETRY_ENABLED' }),
  'telemetry.sink': S('enum', { env: 'CMR_TELEMETRY_SINK', values: ['jsonl', 'sqlite', 'null'] }),
  'telemetry.dir': S('string', { env: 'CMR_TELEMETRY_DIR', nonEmpty: true }),
  'telemetry.rotation': S('enum', { env: 'CMR_TELEMETRY_ROTATION', values: ['daily', 'none'] }),
  'telemetry.shardByPid': S('bool', { env: 'CMR_TELEMETRY_SHARD_BY_PID' }),
  'telemetry.retentionDays': S('int', { env: 'CMR_TELEMETRY_RETENTION_DAYS', min: 1, max: 36500 }),

  'telemetry.primaryModel': S('string', { env: 'CMR_PRIMARY_MODEL', nullable: true }),
  'telemetry.avoidedMethod': S('enum', {
    env: 'CMR_AVOIDED_METHOD',
    values: ['chars_div_4', 'calibrated_cpt', 'worker_prompt_tokens', 'anthropic_count_tokens'],
  }),
  'telemetry.counterfactualRender': S('enum', { env: 'CMR_COUNTERFACTUAL_RENDER', values: ['raw', 'read_tool'] }),
  'telemetry.countProvenFilesOnly': S('bool', { env: 'CMR_COUNT_PROVEN_ONLY' }),
  'telemetry.residencyTurns': S('int', { env: 'CMR_RESIDENCY_TURNS', min: 0, max: 10000 }),
  'telemetry.residencySource': S('enum', {
    env: 'CMR_RESIDENCY_SOURCE',
    values: ['default_zero', 'config', 'transcript_measured'],
  }),

  'telemetry.privacyLevel': S('enum', { env: 'CMR_PRIVACY_LEVEL', values: ['hashed', 'labeled', 'verbose'] }),
  'telemetry.saltScope': S('enum', { env: 'CMR_SALT_SCOPE', values: ['install', 'team'] }),
  'telemetry.storeProjectLabel': S('bool', { env: 'CMR_STORE_PROJECT_LABEL' }),
  'telemetry.storeFilePaths': S('bool', { env: 'CMR_STORE_FILE_PATHS' }),
  'telemetry.storeGitBranch': S('bool', { env: 'CMR_STORE_GIT_BRANCH' }),
  'telemetry.storeQuestionText': S('bool', { env: 'CMR_STORE_QUESTION_TEXT' }),
  'telemetry.questionTextMaxChars': S('int', { env: 'CMR_QUESTION_TEXT_MAX_CHARS', min: 0, max: 10000 }),
  'telemetry.storeErrorDetail': S('bool', { env: 'CMR_STORE_ERROR_DETAIL' }),
  'telemetry.storeContentHash': S('bool', { env: 'CMR_STORE_CONTENT_HASH' }),
  'telemetry.recordGateDecisions': S('bool', { env: 'CMR_RECORD_GATE_DECISIONS' }),

  'pricing.source': S('enum', { env: 'CMR_PRICING_SOURCE', values: ['bundled', 'file'] }),
  'pricing.overrides': S('string', { env: 'CMR_PRICING_OVERRIDES', nullable: true }),
})

/* ------------------------------------------------------------------- helpers */

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.')
  const last = keys.pop()
  let cur = obj
  for (const k of keys) {
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  cur[last] = value
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

/** Deep merge of plain objects. Arrays replace wholesale — merging glob lists by index is nonsense. */
function deepMerge(base, overlay) {
  if (overlay === undefined) return base
  if (overlay === null) return null
  if (Array.isArray(overlay) || typeof overlay !== 'object') return overlay
  const out = Array.isArray(base) || typeof base !== 'object' || base === null ? {} : { ...base }
  for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(out[k], v)
  return out
}

/* ---------------------------------------------------------------- coercion */

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

/**
 * Coerce one leaf against its spec.
 * @returns {{ok: true, value: any} | {ok: false, reason: string}}
 */
export function coerceLeaf(spec, raw, { fromEnv = false } = {}) {
  if (raw === undefined) return { ok: false, reason: 'undefined' }

  if (raw === null) {
    if (spec.nullable) return { ok: true, value: null }
    return { ok: false, reason: 'null is not allowed' }
  }

  switch (spec.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (fromEnv && typeof raw === 'string') {
        const v = raw.trim().toLowerCase()
        if (TRUE.has(v)) return { ok: true, value: true }
        if (FALSE.has(v)) return { ok: true, value: false }
      }
      return { ok: false, reason: `expected boolean, got ${typeof raw}` }
    }

    case 'int':
    case 'number': {
      let n = raw
      if (fromEnv && typeof raw === 'string') {
        if (raw.trim() === '') return { ok: false, reason: 'empty string' }
        n = Number(raw)
      }
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        // THE TYPE, NEVER THE VALUE. This was the one branch in this function that echoed the
        // rejected value back, and a warning is printed by `doctor` and lands in whatever a
        // developer pastes into a bug report. A key mistyped into a numeric field — there is no
        // field that holds a credential, so a key in a config file is always a mistake — would
        // have been echoed verbatim. The field name is already on the warning, so the type alone
        // is just as actionable, and every other branch here already reports only a type.
        return { ok: false, reason: `expected ${spec.type}, got ${describeType(raw)}` }
      }
      if (spec.type === 'int' && !Number.isInteger(n)) return { ok: false, reason: 'expected an integer' }
      if (spec.min !== undefined && n < spec.min) return { ok: false, reason: `below minimum ${spec.min}` }
      if (spec.max !== undefined && n > spec.max) return { ok: false, reason: `above maximum ${spec.max}` }
      return { ok: true, value: n }
    }

    case 'string': {
      if (typeof raw !== 'string') return { ok: false, reason: `expected string, got ${typeof raw}` }
      if (spec.nonEmpty && raw.trim() === '') return { ok: false, reason: 'must not be empty' }
      return { ok: true, value: raw }
    }

    case 'enum': {
      if (typeof raw !== 'string') return { ok: false, reason: `expected string, got ${typeof raw}` }
      if (!spec.values.includes(raw)) {
        return { ok: false, reason: `must be one of ${spec.values.join(', ')}` }
      }
      return { ok: true, value: raw }
    }

    case 'string[]': {
      // From env, a comma-separated list is the only sane encoding.
      const arr = fromEnv && typeof raw === 'string'
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : raw
      if (!Array.isArray(arr)) return { ok: false, reason: `expected an array, got ${typeof raw}` }
      if (!arr.every((s) => typeof s === 'string')) return { ok: false, reason: 'expected an array of strings' }
      return { ok: true, value: arr }
    }

    default:
      return { ok: false, reason: `unknown spec type ${spec.type}` }
  }
}

/* ---------------------------------------------------------------- resolution */

/**
 * Pure resolution. No disk, no process.env — everything is injected, so the
 * whole precedence order is testable.
 *
 * @param {object}   opts
 * @param {object[]} opts.layers  JSON layers in increasing precedence, each {name, data}
 * @param {object}   opts.env     environment map (CMR_* and CLAUDE_PLUGIN_OPTION_*)
 * @returns {{config: object, warnings: Array<{scope: string, field: string, reason: string}>, sources: object}}
 */
export function resolveConfig({ layers = [], env = {} } = {}) {
  const warnings = []
  const sources = {}

  // 1. merge file layers over the defaults
  let merged = clone(DEFAULTS)
  for (const layer of layers) {
    if (!layer || layer.data == null) continue
    if (typeof layer.data !== 'object' || Array.isArray(layer.data)) {
      warnings.push({ scope: layer.name, field: '<root>', reason: 'expected a JSON object' })
      continue
    }
    merged = deepMerge(merged, layer.data)
    for (const field of Object.keys(SPEC)) {
      if (getPath(layer.data, field) !== undefined) sources[field] = layer.name
    }
  }

  // 2. overlay the environment (highest precedence: CI and kill switches must win)
  for (const [field, spec] of Object.entries(SPEC)) {
    if (!spec.env) continue
    const raw = env[spec.env]
    if (raw === undefined) continue
    const r = coerceLeaf(spec, raw, { fromEnv: true })
    if (r.ok) {
      setPath(merged, field, r.value)
      sources[field] = `env:${spec.env}`
    } else {
      warnings.push({ scope: `env:${spec.env}`, field, reason: r.reason })
    }
  }

  // 3. overlay plugin userConfig (CLAUDE_PLUGIN_OPTION_<KEY>), lowest-friction UI layer
  for (const [field, spec] of Object.entries(SPEC)) {
    const key = `CLAUDE_PLUGIN_OPTION_${field.replace(/[.\-]/g, '_').toUpperCase()}`
    const raw = env[key]
    if (raw === undefined) continue
    const r = coerceLeaf(spec, raw, { fromEnv: true })
    if (r.ok) {
      setPath(merged, field, r.value)
      sources[field] = `pluginOption:${key}`
    } else {
      warnings.push({ scope: `pluginOption:${key}`, field, reason: r.reason })
    }
  }

  // 4. validate every known leaf; a bad value falls back to its default (fail open)
  const out = clone(DEFAULTS)
  for (const [field, spec] of Object.entries(SPEC)) {
    const candidate = getPath(merged, field)
    const dflt = getPath(DEFAULTS, field)
    if (candidate === undefined) {
      setPath(out, field, clone(dflt))
      continue
    }
    const r = coerceLeaf(spec, candidate)
    if (r.ok) {
      setPath(out, field, r.value)
    } else {
      setPath(out, field, clone(dflt))
      warnings.push({ scope: sources[field] ?? 'merged', field, reason: `${r.reason}; using default` })
      delete sources[field]
    }
  }

  // 5. surface unknown keys rather than swallowing them — a typo'd field name is
  //    the most common real misconfiguration and silence makes it invisible.
  for (const field of unknownLeaves(merged)) {
    warnings.push({ scope: sources[field] ?? 'merged', field, reason: 'unknown field, ignored' })
  }

  // 6. cross-field coherence
  if (out.telemetry.residencyTurns > 0 && out.telemetry.residencySource === 'default_zero') {
    // A non-zero residency with no stated provenance would silently inflate the
    // cached savings figure. Refuse it rather than publish an unattributable number.
    out.telemetry.residencyTurns = 0
    warnings.push({
      scope: sources['telemetry.residencyTurns'] ?? 'merged',
      field: 'telemetry.residencyTurns',
      reason: 'residencyTurns > 0 requires residencySource "config" or "transcript_measured"; forced to 0',
    })
  }

  // 6b. an output request that cannot leave room for a prompt. Only checkable when the operator
  //     stated a window: the discovered one is not available here, because resolveConfig is pure
  //     and makes no network call.
  const ollamaCtx = out.providers.ollama.contextTokens
  if (ollamaCtx !== null && out.worker.maxOutputTokens >= ollamaCtx) {
    // Clamped to ctx - 1 rather than to some fraction: config's job is COHERENCE, not policy.
    // Whether the remaining room is enough to be USEFUL is MIN_USEFUL_OUTPUT_TOKENS's question,
    // and a usefulness floor here would be a second copy of a policy constant.
    out.worker.maxOutputTokens = ollamaCtx - 1
    warnings.push({
      scope: sources['worker.maxOutputTokens'] ?? 'merged',
      field: 'worker.maxOutputTokens',
      reason: `maxOutputTokens >= providers.ollama.contextTokens (${ollamaCtx}) leaves no room for a prompt; reduced to ${ollamaCtx - 1}`,
    })
  }

  // 6c. provider/model coherence. WARNS AND CHANGES NOTHING: no substitution, no fallback to
  //     Gemini, no fallback to Ollama. resolveConfig cannot throw (a PreToolUse hook loads it)
  //     and it must not guess. The runtime answer is left to the provider, which reports a bad
  //     model from the daemon itself — a true report, strictly better than our name-shape guess.
  const coherence = workerCoherence(out)
  for (const problem of coherence.problems) {
    const field = problem.scope === 'worker' ? 'worker.model' : `workers.${problem.scope}.model`
    warnings.push({ scope: sources[field] ?? 'merged', field, reason: problem.reason })
  }

  return { config: out, warnings, sources, coherence }
}

/**
 * Keys that are legal anywhere but carry no configuration. `$schema` is the one
 * users are told to add for editor autocomplete, so reporting it as a typo would
 * train them to ignore our warnings.
 */
const IGNORED_KEYS = new Set(['$schema', '//'])

/** Leaf paths present in `obj` that the SPEC does not know about. */
function unknownLeaves(obj, prefix = '', acc = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const dotted = prefix ? `${prefix}.${k}` : k
    if (SPEC[dotted] || IGNORED_KEYS.has(k)) continue
    const isPlain = v !== null && typeof v === 'object' && !Array.isArray(v)
    const hasKnownDescendant = Object.keys(SPEC).some((s) => s.startsWith(`${dotted}.`))
    if (isPlain && hasKnownDescendant) unknownLeaves(v, dotted, acc)
    else acc.push(dotted)
  }
  return acc
}

/* ------------------------------------------------------------------ paths */

/** Expand a leading `~` against the user's home directory. */
export function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string') return p
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2))
  return p
}

export function userConfigPath(home = os.homedir()) {
  return path.join(home, '.claude', 'model-router', 'config.json')
}

export function projectConfigPath(projectDir) {
  return path.join(projectDir, '.claude', 'model-router.json')
}

/* ---------------------------------------------------------------- loading */

/**
 * Read + parse a JSON file. Never throws: a missing file is silence, an
 * unparseable one is a warning. Either way the caller keeps running.
 */
export function readJsonLayer(name, file, warnings) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    try {
      return { name, data: JSON.parse(stripJsonComments(text)) }
    } catch (err) {
      warnings.push({ scope: name, field: '<file>', reason: `invalid JSON in ${file}: ${err.message}` })
      return null
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      warnings.push({ scope: name, field: '<file>', reason: `cannot read ${file}: ${err.code ?? err.message}` })
    }
    return null
  }
}

/**
 * Strip `//` and block comments so a documented config file is still loadable.
 * String-aware, so a `//` inside a glob or URL survives.
 */
export function stripJsonComments(text) {
  let out = ''
  let inStr = false
  let esc = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === '\n') { inLine = false; out += c }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++ }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && n === '/') { inLine = true; i++; continue }
    if (c === '/' && n === '*') { inBlock = true; i++; continue }
    out += c
  }
  return out
}

/**
 * Load the effective configuration. The entry point used by hooks and scripts.
 * Never throws.
 */
export function loadConfig({
  env = process.env,
  projectDir = env.CLAUDE_PROJECT_DIR || process.cwd(),
  home = os.homedir(),
} = {}) {
  const warnings = []
  const layers = []

  const userLayer = readJsonLayer('user', userConfigPath(home), warnings)
  if (userLayer) layers.push(userLayer)

  const projectLayer = readJsonLayer('project', projectConfigPath(projectDir), warnings)
  if (projectLayer) layers.push(projectLayer)

  const resolved = resolveConfig({ layers, env })
  resolved.warnings = [...warnings, ...resolved.warnings]

  // Absolute paths, resolved once, so no downstream consumer re-implements `~`.
  resolved.config.telemetry.dirResolved = expandHome(resolved.config.telemetry.dir, home)
  resolved.config.budget.stateDirResolved = expandHome(resolved.config.budget.stateDir, home)
  resolved.config.projectDir = projectDir

  return resolved
}

/**
 * Is routing active at all? The single question the gate asks first.
 * `CLAUDE_ROUTER_TELEMETRY=0` only silences telemetry; `CMR_ENABLED=0` stops routing.
 */
export function routingEnabled(config) {
  return config?.enabled === true
}
