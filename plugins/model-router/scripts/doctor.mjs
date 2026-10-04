#!/usr/bin/env node
/**
 * router doctor — is this installation actually able to route?
 *
 * Checks config resolution, provider readiness, the telemetry store and (with
 * --live) one real worker call. Prints a report and exits non-zero if anything
 * would stop routing from working.
 *
 * It never prints a secret. For an API key it reports only presence, length and
 * a short prefix, so the output is safe to paste into an issue or a chat.
 *
 * Usage:
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --live            # make one real worker call
 *   node scripts/doctor.mjs --live --provider ollama
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../lib/config.mjs'
import { readinessFor, loadProvider, callWorker, providerIds, requiresEnvFor, wantsKey, billingFor } from '../lib/providers/index.mjs'
import { resolveWorker } from '../lib/dispatch/index.mjs'
import { LANE_MODE } from '../lib/routing-policy.mjs'
import { bundledCapabilityFor, resolveCapability } from '../lib/providers/capability.mjs'
import { FETCH_HEADERS_TIMEOUT_MS } from '../lib/providers/contract.mjs'
import { computeContextBudget, estimateTokensFromBytes } from '../lib/context-budget.mjs'
import { describeGovernance } from '../lib/governance/policy.mjs'
import { probeWritable, readState } from '../lib/governance/ledger.mjs'
import { resolveSinkId } from '../lib/telemetry/index.mjs'
import { readSegmentsSync } from '../lib/telemetry/jsonl.mjs'
import { loadPricing } from '../lib/telemetry/pricing-load.mjs'
import { unpricedModels } from '../lib/telemetry/pricing-table.mjs'

/** What Claude Code sets CLAUDE_PLUGIN_ROOT to: the plugin directory, two levels up from here. */
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--') ? dflt : argv[i + 1]
}

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

let failures = 0
let warnings = 0

/**
 * Whether the pricing chain carries a single usable rate.
 *
 * Set by the Pricing section and read by Governance. The bundled table ships EVERY rate as null,
 * so this is false out of the box — which is precisely why a configured dollar budget warns
 * instead of silently appearing to work.
 */
let anyRateKnown = false

function ok(label, detail = '') {
  console.log(`  ${GREEN}OK${OFF}    ${label}${detail ? `  ${DIM}${detail}${OFF}` : ''}`)
}
function warn(label, detail = '') {
  warnings++
  console.log(`  ${YELLOW}WARN${OFF}  ${label}${detail ? `  ${DIM}${detail}${OFF}` : ''}`)
}
function fail(label, detail = '') {
  failures++
  console.log(`  ${RED}FAIL${OFF}  ${label}${detail ? `  ${DIM}${detail}${OFF}` : ''}`)
}
/**
 * The budget in one phrase, for the configuration summary line.
 *
 * "none configured" is the honest wording for every-limit-null, and that is the shipped state.
 * The old summary printed `$5/day` from a default that was never enforced by anything, which
 * told the operator they had a budget when they had neither a budget nor an enforcer.
 */
function budgetSummary(budget) {
  if (budget?.enabled !== true) return 'governance off'
  const parts = []
  for (const scope of ['run', 'daily', 'monthly']) {
    const block = budget[scope] ?? {}
    if (Number.isFinite(block.maxWorkerCostUsd)) parts.push(`$${block.maxWorkerCostUsd}/${scope}`)
    if (Number.isFinite(block.maxTotalTokens)) parts.push(`${block.maxTotalTokens}tok/${scope}`)
  }
  return parts.length === 0 ? 'none configured' : parts.join(' ')
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(68)}`)
}

/**
 * Describe a secret without revealing it. Enough to tell "set, looks like a
 * Gemini key, 39 chars" from "set to an empty string" or "set to a shell
 * expansion that never expanded" — the three failures people actually hit.
 */
function describeSecret(value) {
  if (value === undefined) return { state: 'absent' }
  if (value === '') return { state: 'empty' }
  const v = String(value)
  if (/^\$|^%.*%$|^\$\{/.test(v)) return { state: 'unexpanded', detail: 'looks like a literal shell expansion' }
  return {
    state: 'present',
    detail: `${v.length} chars, starts "${v.slice(0, 4)}…"`,
  }
}

/* ------------------------------------------------------------------- report */

console.log('router doctor')

const { config, warnings: configWarnings, sources, coherence: configCoherence } = loadConfig()

section('Configuration')
ok('config resolved', `project: ${config.projectDir}`)
if (configWarnings.length === 0) {
  ok('no configuration warnings')
} else {
  for (const w of configWarnings) {
    // An unknown field is a typo worth surfacing; a rejected value is worse.
    const isTypo = w.reason === 'unknown field, ignored'
    ;(isTypo ? warn : fail)(`${w.field}`, `${w.scope}: ${w.reason}`)
  }
}

if (!config.enabled) {
  warn('routing is DISABLED', 'enabled=false (or CMR_ENABLED=0) — the gate will allow every read')
} else {
  ok('routing enabled')
}

console.log(
  `  ${DIM}worker: ${config.worker.provider}/${config.worker.model}` +
    `  bulkRead: ${config.routing.bulkRead.enforce} >${config.routing.bulkRead.minLines} lines` +
    `  budget: ${budgetSummary(config.budget)}${OFF}`,
)
const overridden = Object.entries(sources).filter(([, s]) => s !== 'user')
if (overridden.length > 0) {
  console.log(`  ${DIM}overrides: ${overridden.map(([f, s]) => `${f}<-${s}`).join(', ')}${OFF}`)
}

/* ------------------------------------------------------------------ runtime */

section('Runtime')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major > 22 || (major === 22 && minor >= 5)) {
  ok(`node ${process.versions.node}`, 'node:sqlite available')
} else {
  fail(`node ${process.versions.node}`, 'node 22.5+ required for node:sqlite')
}
ok(`platform ${process.platform}`, os.release())
if (typeof globalThis.fetch === 'function') ok('global fetch available')
else fail('global fetch missing', 'node 18+ required')

/* ----------------------------------------------------------------- provider */

section('Worker provider')
const providerId = opt('provider', config.worker.provider)
if (providerId !== config.worker.provider) {
  console.log(`  ${DIM}(overridden on the command line: ${providerId})${OFF}`)
}

if (!providerIds().includes(providerId)) {
  fail(`unknown provider "${providerId}"`, `known: ${providerIds().join(', ')}`)
} else {
  ok(`provider "${providerId}" is registered`)

  let mod = null
  try {
    mod = await loadProvider(providerId)
    ok('provider module satisfies the contract')
    console.log(
      `  ${DIM}maxInputBytes=${mod.capabilities.maxInputBytes}` +
        ` reportsUsage=${mod.capabilities.reportsUsage}` +
        ` thinkingTokens=${mod.capabilities.reportsThinkingTokens}${OFF}`,
    )
  } catch (err) {
    fail('provider module failed to load', err.message)
  }

  // Key presence, never the key itself — and checked against the workers a LANE will actually
  // resolve to, not against `worker.provider`.
  //
  // THE PHASE-8 DEFECT. This block used to read `config.worker.apiKeyEnv` alone, which defaults
  // to GEMINI_API_KEY because `worker.provider` defaults to gemini. It was wrong in both
  // directions, and both were measured:
  //
  //   - `workers.*.provider = ollama` with `worker.*` left at its defaults FAILED on an absent
  //     GEMINI_API_KEY and exited 1, reporting a perfectly healthy local install as broken, for
  //     want of a key no lane would ever send.
  //   - `worker.provider = ollama` with `workers.bulkRead.provider = gemini` said "no API key
  //     required" and never checked at all, so the one lane that did need a key failed at its
  //     first delegation instead of here.
  //
  // `wantsKey()` is the authority on whether a key is wanted and `resolveWorker()` on which
  // provider each lane names. Nothing else can answer this: the global provider is not the set
  // of providers that will run.
  const laneWorkers = Object.keys(LANE_MODE).map((lane) => ({ lane, ...resolveWorker(config, lane) }))
  const keyed = new Map()
  for (const w of laneWorkers) {
    if (!providerIds().includes(w.provider) || !wantsKey(w.provider)) continue
    // A lane that names a provider but no key of its own falls back to the provider's own
    // requirement, which is what readinessFor() would use.
    const env = w.apiKeyEnv ?? requiresEnvFor(w.provider)?.[0] ?? null
    if (env === null) continue
    if (!keyed.has(env)) keyed.set(env, [])
    keyed.get(env).push(LANE_MODE[w.lane])
  }

  if (keyed.size === 0) {
    const local = [...new Set(laneWorkers.map((w) => w.provider))].join(', ')
    ok('no API key required', `every lane runs a local provider (${local})`)
  }
  for (const [keyEnv, modes] of keyed) {
    const who = `needed by ${modes.join(', ')}`
    const s = describeSecret(process.env[keyEnv])
    if (s.state === 'present') ok(`${keyEnv} is set`, `${s.detail}, ${who}`)
    else if (s.state === 'empty') fail(`${keyEnv} is set but empty`, who)
    else if (s.state === 'unexpanded') fail(`${keyEnv} looks wrong`, `${s.detail}, ${who}`)
    else {
      fail(`${keyEnv} is not set`, `${who}; ` + (process.platform === 'win32'
        ? `setx ${keyEnv} "your-key" then restart Claude Code`
        : `export ${keyEnv}=your-key`))
    }
  }

  // Readiness for the globally-configured provider, under the same `wantsKey` guard: a supplied
  // name REPLACES the provider's own requiresEnv, so forwarding it to a provider that needs no
  // key would make a healthy local daemon look unavailable.
  const r = readinessFor(providerId, process.env, {
    apiKeyEnv: wantsKey(providerId) ? config.worker.apiKeyEnv : undefined,
  })
  if (r.ready) ok('provider readiness: ready', 'the gate can route')
  else warn('provider readiness: NOT ready', `${r.reason} — the gate will fail open and allow reads`)
}

/* -------------------------------------------------------------- worker modes */

/**
 * Which worker each mode actually resolves to.
 *
 * This is the only place a typo in `workers.<lane>.provider` is ever caught: the value is a free
 * non-empty string as far as the config spec is concerned, so `"gemnii"` loads without a single
 * warning and then fails at the first delegation.
 */
section('Worker modes')
for (const [lane, mode] of Object.entries(LANE_MODE)) {
  const r = resolveWorker(config, lane)
  const inherited = r.inheritedProvider ? 'inherits worker.provider' : `workers.${lane}.provider`
  if (!providerIds().includes(r.provider)) {
    fail(`${mode}: unknown provider "${r.provider}"`, `known: ${providerIds().join(', ')}`)
  } else if (r.model === null) {
    warn(`${mode}: ${r.provider} with no model resolved`, `set workers.${lane}.model or providers.${r.provider}.model`)
  } else {
    // `r.apiKeyEnv` is inherited whenever the provider was, so it still names GEMINI_API_KEY for
    // a lane running Ollama. Printing that verbatim implies a key is wanted; `wantsKey()` is what
    // decides whether one is.
    const key = wantsKey(r.provider) ? (r.apiKeyEnv ?? 'none configured') : 'none required'
    ok(`${mode}: ${r.provider}/${r.model}`, `${inherited}, timeoutMs=${r.timeoutMs}, key=${key}`)
  }
}

/* -------------------------------------------------------- worker capability */

/**
 * Can the resolved worker actually hold the prompts we intend to send it?
 *
 * This section may use the network, unlike the gate: doctor is an interactive diagnostic that the
 * developer ran on purpose, and for ollama the probe is a localhost round trip measured at about
 * seven milliseconds. The whole value of the section is telling the truth about THIS install, and
 * a bundled table cannot do that.
 *
 * Everything here is WARN at worst for an undiscoverable window, because an unknown capability
 * leaves a degraded router rather than a broken one — the gate still fails open to plain Claude
 * Code. A provider/model mismatch and an output request that cannot fit are FAIL, because both
 * are misconfigurations with a definite fix.
 */
section('Worker capability')

// Reported once, from the resolver, so a mismatch is named even when the model never loads.
// Stated either way: "no mismatch" is a real finding, and a section that is silent when
// everything is fine cannot be distinguished from a section that forgot to check.
if (configCoherence.ok) {
  ok('provider/model coherence', 'every configured worker names a model its provider could own')
}
for (const problem of configCoherence.problems) {
  const where = problem.scope === 'worker' ? 'worker' : `workers.${problem.scope}`
  if (problem.status === 'mismatch') {
    fail(`${where}: provider/model mismatch`, problem.reason)
  } else {
    warn(`${where}: model unresolved`, problem.reason)
  }
}

// A configured timeout the runtime will never honour. Only reachable with a very slow local
// model, which is exactly who sets a long timeout in the first place.
for (const [lane, mode] of Object.entries(LANE_MODE)) {
  const t = resolveWorker(config, lane).timeoutMs
  if (Number.isInteger(t) && t > FETCH_HEADERS_TIMEOUT_MS) {
    warn(
      `${mode}: timeoutMs ${t} exceeds what the runtime will wait`,
      `the HTTP client gives up at ${FETCH_HEADERS_TIMEOUT_MS}ms, so a slower call fails there and not at ${t}ms`,
    )
  }
}

for (const [lane, mode] of Object.entries(LANE_MODE)) {
  const r = resolveWorker(config, lane)
  if (!providerIds().includes(r.provider) || r.model === null) continue // already reported above

  const providerConfig = config.providers?.[r.provider] ?? {}
  let mod = null
  let capability = null
  try {
    mod = await loadProvider(r.provider)
    const discovered =
      typeof mod.describeModel === 'function'
        ? await mod.describeModel({ model: r.model, providerConfig })
        : null
    capability = resolveCapability({
      provider: r.provider,
      model: r.model,
      configured: providerConfig.contextTokens ?? null,
      discovered,
      bundled: bundledCapabilityFor(r.provider, r.model),
    })
  } catch (err) {
    warn(`${mode}: capability probe failed`, err?.message ?? 'unknown error')
    continue
  }

  const label = `${mode}: ${r.provider}/${r.model}`
  const maxOut = config.worker.maxOutputTokens

  if (capability.contextTokens === null) {
    // NOT a failure. Unknown stays unknown, and the router degrades rather than breaks.
    // The remedy depends on the provider: ollama has a configurable window and a daemon to ask,
    // and nothing else currently has either. Pointing a Gemini user at a leaf that does not
    // exist, or at a daemon they do not run, would be worse than saying nothing.
    const hint =
      r.provider === 'ollama'
        ? 'start the daemon so /api/show can answer, or set providers.ollama.contextTokens'
        : `no context limit is discoverable for ${r.provider}; delegation still proceeds under the byte ceiling`
    warn(`${label}: context capability unknown`, `${capability.detail ?? 'no source'} — ${hint}`)
    continue
  }

  // Sized against a prompt that is ONLY the system string plus the task, so this answers "can
  // this model be used at all" rather than "will some particular file fit".
  const budget = computeContextBudget({
    provider: r.provider,
    model: r.model,
    capability,
    requestedInputTokens: estimateTokensFromBytes(1024),
    requestedOutputTokens: maxOut,
    contextWindowModel: mod?.capabilities?.contextWindowModel ?? 'unknown',
  })

  const prov = `${capability.source}/${capability.status}`
  if (budget.verdict === 'refuse') {
    fail(
      `${label}: maxOutputTokens ${maxOut} exceeds the ${capability.contextTokens}-token context`,
      `${prov}; no safe cap exists — lower worker.maxOutputTokens or choose a model with a larger window`,
    )
  } else if (budget.verdict === 'cap_output') {
    warn(
      `${label}: context=${capability.contextTokens} (${prov})`,
      `maxOutputTokens=${maxOut} will be capped to ${budget.allowedOutputTokens}; effectiveInput=${budget.effectiveInputCapacityTokens}`,
    )
  } else {
    ok(
      `${label}: context=${capability.contextTokens} (${prov})`,
      `maxOutputTokens=${maxOut}, effectiveInput=${budget.effectiveInputCapacityTokens}${capability.status === 'assumed' ? ', NOT verified against this install' : ''}`,
    )
  }
}

/* --------------------------------------------------------------- hook wiring */

section('Claude Code hook')
if (config.hooks?.enabled !== true) {
  warn('hooks.enabled is false', 'nothing is intercepted; routing and telemetry are unaffected')
} else {
  ok('hooks.enabled', `timeoutMs=${config.hooks.timeoutMs}`)
}

{
  const manifestPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')
  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    fail('hooks.json is unreadable', err.message)
  }

  if (manifest) {
    const matchers = manifest.hooks?.PreToolUse
    if (!Array.isArray(matchers) || matchers.length === 0) {
      fail('no PreToolUse hook is registered', 'hooks.json registers nothing, so no Read is gated')
    } else {
      const tools = matchers.map((m) => m.matcher ?? '<all tools>').join(', ')
      ok(`PreToolUse registered for ${tools}`)

      // A script Claude Code cannot find is the failure mode with no symptom: the hook simply
      // never runs, every Read proceeds, and nothing anywhere says why.
      for (const matcher of matchers) {
        for (const handler of matcher.hooks ?? []) {
          const target = (handler.args ?? [])[0] ?? handler.command ?? ''
          const resolved = target.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT)
          if (!target.includes('${CLAUDE_PLUGIN_ROOT}')) {
            warn(`${matcher.matcher}: hook path is not plugin-relative`, target)
          } else if (!fs.existsSync(resolved)) {
            fail(`${matcher.matcher}: hook script is missing`, resolved)
          } else {
            ok(`${matcher.matcher}: ${path.basename(resolved)} present`, `timeout=${handler.timeout ?? 'default'}s`)
          }
        }
      }
    }
  }
}

// The configuration in which a delegation can never finish: the hook abandons the worker call
// before the worker was ever going to answer, so every read falls open after a wasted wait.
// Which deadline actually bounds a delegated read. The hook's budget is DESIGNED to be the
// tighter of the two — worker.timeoutMs defaults to three minutes, which is a sane ceiling for a
// script and an unacceptable one for a tool call someone is waiting on — so a shorter hook
// deadline is information, not a misconfiguration. Only a budget too small for any worker to
// answer within is worth a warning.
if (config.hooks?.enabled === true) {
  const r = resolveWorker(config, 'bulkRead')
  const budget = config.hooks.timeoutMs
  const effective = Math.min(budget ?? Infinity, r.timeoutMs ?? Infinity)
  if (Number.isInteger(budget) && budget < 5000) {
    warn(`hooks.timeoutMs is ${budget}ms`, 'few workers answer that fast, so most delegations will fall open')
  } else if (Number.isFinite(effective)) {
    ok(`a delegated read is bounded at ${effective}ms`, effective === budget ? 'by hooks.timeoutMs' : 'by the worker timeout')
  }
}

/* ---------------------------------------------------------------- telemetry */

section('Telemetry store')
if (!config.telemetry.enabled) {
  warn('telemetry is disabled', 'no events will be recorded')
} else {
  const dir = config.telemetry.dirResolved
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.doctor-${process.pid}`)
    fs.writeFileSync(probe, 'probe')
    fs.unlinkSync(probe)
    ok('store is writable', dir)
  } catch (err) {
    fail('store is NOT writable', `${dir}: ${err.code ?? err.message}`)
  }

  // SQLite over a network or cloud-synced volume is a documented corruption
  // risk, and append atomicity is only guaranteed on a local filesystem.
  const looksRemote = /^\\\\/.test(dir) || /onedrive|dropbox|google drive|box sync/i.test(dir)
  if (looksRemote && !config.telemetry.shardByPid) {
    warn('store is on a network or synced volume', 'set telemetry.shardByPid=true for safe concurrent appends')
  } else if (looksRemote) {
    ok('store is on a synced volume', 'shardByPid is enabled')
  } else {
    ok('store is on a local filesystem', 'single-file appends are safe')
  }

  console.log(
    `  ${DIM}sink=${config.telemetry.sink} privacy=${config.telemetry.privacyLevel}` +
      ` avoidedMethod=${config.telemetry.avoidedMethod}` +
      ` provenOnly=${config.telemetry.countProvenFilesOnly}` +
      ` residency=${config.telemetry.residencyTurns}(${config.telemetry.residencySource})${OFF}`,
  )

  // The sink the config asked for is not always the sink that runs. A fallback is reported
  // in band rather than printed from the hot path, so doctor is where it surfaces.
  const resolved = resolveSinkId(config.telemetry.sink)
  if (resolved.fellBackFrom) warn(`sink "${resolved.fellBackFrom}" is not implemented`, resolved.warning)

  // rotation=none makes retention a complete no-op. A real trap, and cheap to catch.
  if (config.telemetry.rotation === 'none') {
    warn(
      'rotation is "none", so retention can never prune',
      `retentionDays=${config.telemetry.retentionDays} has no effect on an undated segment`,
    )
  }

  // A malformed line in the MIDDLE of a segment is field-detectable evidence that append
  // atomicity failed on this filesystem — the one claim no specification gives us on Windows
  // or on a network volume. Worth checking on the developer's actual machine.
  const { report } = readSegmentsSync({ dir })
  if (report.lines === 0) {
    console.log(`  ${DIM}store is empty — nothing delegated yet${OFF}`)
  } else if (report.skipped.malformed > 0) {
    fail(
      `${report.skipped.malformed} malformed line(s) in the store`,
      'a mid-file break means appends are not atomic here; set telemetry.shardByPid=true',
    )
  } else {
    ok(
      `${report.yielded} event(s) readable, 0 malformed`,
      report.skipped.truncated_tail > 0 ? `${report.skipped.truncated_tail} unterminated tail (a writer was mid-flight)` : 'appends are intact',
    )
  }
}

/* ------------------------------------------------------------------ pricing */

section('Pricing')
{
  const { chain, warnings: pricingWarnings } = loadPricing(config)
  for (const w of pricingWarnings) warn(w.field, w.reason)

  if (chain.length === 0) {
    fail('no pricing table is available', 'every cost and savings figure will be NULL')
  } else {
    const served = chain.map((e) => `${e.source}@${e.table.pricingVersion}`).join(' -> ')
    ok(`pricing chain: ${served}`, 'first match wins; tables are never merged')
  }

  // The bundled table ships every rate as null on purpose: a confident wrong dollar figure is
  // worse than a refusal to price. But a null nobody explains reads as a bug, so doctor hands
  // over the exact snippet to paste.
  // Hoisted for the Governance section below: "is ANY rate known" is the question a monetary
  // budget actually depends on, and `chain` is scoped to this block.
  anyRateKnown = chain.some((e) =>
    Object.values(e.table.models ?? {}).some(
      (row) => Number.isFinite(row.inputPerMTok) || Number.isFinite(row.outputPerMTok),
    ),
  )

  const unpriced = chain.flatMap((e) => unpricedModels(e.table))
  if (unpriced.length > 0) {
    warn(
      `${unpriced.length} model(s) have no rates`,
      'token savings are still reported; every DOLLAR figure will be NULL until rates are set',
    )
    for (const row of unpriced.slice(0, 6)) console.log(`  ${DIM}${row.key} — verify at ${row.verify}${OFF}`)
    if (unpriced.length > 6) console.log(`  ${DIM}...and ${unpriced.length - 6} more${OFF}`)
    console.log('')
    console.log(`  ${DIM}To price them, write a table and point pricing.overrides at it:${OFF}`)
    console.log(`  ${DIM}{${OFF}`)
    console.log(`  ${DIM}  "pricingVersion": "my-rates.1", "unit": "per_mtok", "currency": "USD",${OFF}`)
    console.log(`  ${DIM}  "models": {${OFF}`)
    console.log(`  ${DIM}    "${unpriced[0].key}": {${OFF}`)
    console.log(`  ${DIM}      "inputPerMTok": 0.30, "cachedInputPerMTok": 0.075, "outputPerMTok": 2.50,${OFF}`)
    console.log(`  ${DIM}      "verify": "${unpriced[0].verify}", "verifiedAt": "${new Date().toISOString().slice(0, 10)}"${OFF}`)
    console.log(`  ${DIM}    }${OFF}`)
    console.log(`  ${DIM}  }${OFF}`)
    console.log(`  ${DIM}}${OFF}`)
  } else {
    ok('every model in the chain has rates', 'dollar figures will be populated')
  }

  // The "a budget cannot be enforced without rates" warning used to live here. It moved to the
  // Governance section below, which is the place that knows WHICH budgets are configured and
  // whether the resolved worker is even billable.
}

/* ---------------------------------------------------------------- governance */

/**
 * Can the configured budgets actually be enforced, and what is spent right now?
 *
 * The findings come from `describeGovernance()`, which is pure, so the severity matrix is
 * unit-tested rather than only observable through this script's stdout. Everything here
 * renders; nothing here decides.
 */
section('Governance')

{
  const workers = []
  for (const [lane, mode] of Object.entries(LANE_MODE)) {
    const r = resolveWorker(config, lane)
    const known = providerIds().includes(r.provider)
    let reportsUsage
    if (known) {
      try {
        reportsUsage = (await loadProvider(r.provider)).capabilities.reportsUsage
      } catch {
        // Left undefined: an unknown capability must not be reported as a confident "yes".
        reportsUsage = undefined
      }
    } else {
      reportsUsage = false
    }
    workers.push({ mode, provider: r.provider, billing: billingFor(r.provider), reportsUsage })
  }

  for (const f of describeGovernance({
    limits: config.budget,
    pricingAvailable: anyRateKnown,
    stateWritable: probeWritable(config),
    workers,
  })) {
    if (f.level === 'fail') fail(f.label, f.detail)
    else if (f.level === 'warn') warn(f.label, f.detail)
    else ok(f.label, f.detail)
  }

  // Current spend, which is information rather than a check.
  const state = readState(config)
  if (state.ok && state.state.daily.calls + state.state.monthly.calls > 0) {
    const d = state.state.daily
    const m = state.state.monthly
    console.log(
      `  ${DIM}spent today (${state.periods.day}): ${d.totalTokens} tokens, ${d.calls} call(s)` +
        `  this month (${state.periods.month}): ${m.totalTokens} tokens, ${m.calls} call(s)${OFF}`,
    )
    if (d.costStatus === 'partial') {
      console.log(`  ${DIM}cost so far is a LOWER BOUND: some calls could not be priced${OFF}`)
    }
  } else if (!state.ok && state.reason !== 'no_state_dir') {
    warn('budget accounting state could not be read', `${state.reason} — spend is unknown, not zero`)
  }
}

/* --------------------------------------------------------------- live check */

if (flag('live')) {
  section('Live worker call')
  const liveConfig = { ...config, worker: { ...config.worker, provider: providerId, maxOutputTokens: 256 } }
  const t0 = Date.now()
  try {
    const { result, attempts } = await callWorker({
      config: liveConfig,
      system: 'You are a terse code analyst. Reply with bullets only, no preamble.',
      prompt:
        'What does this file export?\n<file path="probe.ts">\nexport class UserService {\n' +
        '  create(name: string) { return { name } }\n}\nexport const VERSION = "1.0"\n</file>',
    })
    ok(`call succeeded in ${Date.now() - t0}ms`, `attempts=${attempts} model=${result.model}`)

    const u = result.usage
    if (u.source === 'provider_reported') {
      ok('usage reported by provider', `in=${u.inputTokens} out=${u.outputTokens}` +
        `${u.cachedInputTokens ? ` cached=${u.cachedInputTokens}` : ''}` +
        `${u.thinkingTokens ? ` thinking=${u.thinkingTokens}` : ''}`)
    } else {
      // Not fatal, but it means every cost on every event becomes NULL.
      warn(`usage is ${u.source}`, 'worker cost will be recorded as NULL, not estimated')
    }
    console.log(`  ${DIM}--- worker said ---${OFF}`)
    for (const line of result.text.trim().split('\n').slice(0, 6)) console.log(`  ${DIM}${line}${OFF}`)
  } catch (err) {
    fail(`call failed: ${err.code ?? 'error'}`, err.message)
    if (err.detail) console.log(`  ${DIM}${err.detail}${OFF}`)
  }
} else {
  console.log(`\n${DIM}Pass --live to make one real worker call.${OFF}`)
}

/* ----------------------------------------------------------------- summary */

console.log(`\n${'='.repeat(68)}`)
if (failures > 0) {
  console.log(`${RED}${failures} failure(s)${OFF}, ${warnings} warning(s) — routing will not work correctly.`)
  process.exit(1)
}
console.log(
  warnings > 0
    ? `${GREEN}No failures${OFF}, ${YELLOW}${warnings} warning(s)${OFF}.`
    : `${GREEN}All checks passed.${OFF}`,
)
process.exit(0)
