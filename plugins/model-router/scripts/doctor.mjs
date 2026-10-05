#!/usr/bin/env node
/**
 * router doctor — is this installation actually able to route?
 *
 * The primary onboarding command. It checks config resolution, the runtime, what routing will do,
 * the worker chain, the hook wiring, the telemetry store, analytics tooling, pricing and
 * governance, and with --live makes one real worker call.
 *
 * FOUR LEVELS, AND ONLY ONE OF THEM FAILS. `fail` means a misconfiguration with a definite fix,
 * and is the only level that moves the exit code. `warn` means a DEGRADED router, never a broken
 * one: the gate fails open on every branch, so every warning state still leaves Claude Code
 * working exactly as it does without this plugin. `info` is an echo of what is configured rather
 * than a verdict — it used to be raw dimmed output outside the counters, which made an
 * observation indistinguishable from a check that had been skipped.
 *
 * IT WRITES NOTHING BY DEFAULT. It used to create the telemetry and governance directories in
 * order to probe them, which meant the first command a new developer ran left state behind and
 * then reported "store is empty" — having just falsified the thing it was measuring. Writability
 * is now judged by permission on the nearest existing ancestor, and the output says which of the
 * two checks it made. `--probe-writes` restores the real write for the cases where `accessSync`
 * lies: ACLs, network shares, and Windows read-only directories.
 *
 * It never prints a secret. For an API key it reports only presence, length and a short prefix,
 * so the output is safe to paste into an issue — which is what lets the bug-report template ask
 * for `--json --offline`.
 *
 * Severity decisions live in `lib/doctor/report.mjs`, which is pure, so the matrix is unit-tested
 * rather than only observable through this script's stdout. Everything here gathers and renders;
 * the interesting judgements are made there.
 *
 * Usage: node scripts/doctor.mjs [--live] [--provider <id>] [--json] [--offline]
 *                               [--probe-writes] [--no-color] [--version] [--help]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../lib/config.mjs'
import { colors, EXIT, parseFlags } from '../lib/cli.mjs'
import { ROUTER_VERSION } from '../lib/version.mjs'
import {
  apiKeyFinding,
  describeSecret,
  fail,
  info,
  LEVEL_FROM_GOVERNANCE,
  nodeFinding,
  pass,
  summarize,
  toJson,
  warn,
} from '../lib/doctor/report.mjs'
import {
  readinessFor,
  loadProvider,
  callWorker,
  providerIds,
  requiresEnvFor,
  wantsKey,
  billingFor,
} from '../lib/providers/index.mjs'
import { resolveWorker } from '../lib/dispatch/index.mjs'
import { LANE_MODE, POLICY_VERSION } from '../lib/routing-policy.mjs'
import { bundledCapabilityFor, resolveCapability } from '../lib/providers/capability.mjs'
import { FETCH_HEADERS_TIMEOUT_MS } from '../lib/providers/contract.mjs'
import { computeContextBudget, estimateTokensFromBytes } from '../lib/context-budget.mjs'
import { describeGovernance } from '../lib/governance/policy.mjs'
import { checkWritable, probeWritable, readState } from '../lib/governance/ledger.mjs'
import { resolveSinkId } from '../lib/telemetry/index.mjs'
import { readSegmentsSync } from '../lib/telemetry/jsonl.mjs'
import { loadPricing } from '../lib/telemetry/pricing-load.mjs'
import { resolveRates } from '../lib/telemetry/pricing-lookup.mjs'
import { unpricedModels } from '../lib/telemetry/pricing-table.mjs'

/** What Claude Code sets CLAUDE_PLUGIN_ROOT to: the plugin directory, two levels up from here. */
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const USAGE = `Usage: npm run doctor [-- <options>]

Diagnose whether this installation can route, and explain anything that would stop it.
Writes nothing and creates no directories unless you ask it to.

Options:
  --live            make one real worker call (costs money on a metered provider)
  --provider <id>   check this provider instead of the configured one
  --json            emit the whole report as JSON on stdout
  --offline         skip the provider capability probe (no network at all)
  --probe-writes    confirm writability by actually writing, not by asking permission
  --no-color        no ANSI escapes (also honours NO_COLOR, and pipes are plain already)
  --version         print the router version and exit
  --help            print this and exit

Exit codes:
  0  no failures. Warnings and info never affect this: a fresh install with no worker
     configured is a working Claude Code install, not a broken one.
  1  at least one FAIL — a misconfiguration with a definite fix.
  2  bad invocation.

Network: with neither --offline nor --live, the only request made is the worker capability
probe, which for Ollama is a localhost call to /api/show.`

const parsed = parseFlags(process.argv.slice(2), {
  booleans: ['live', 'json', 'offline', 'probe-writes', 'no-color', 'help', 'version'],
  values: ['provider'],
})

if (parsed.errors.length > 0) {
  for (const e of parsed.errors) console.error(e)
  console.error('\nTry: npm run doctor -- --help')
  process.exit(EXIT.USAGE)
}
// Honoured before any config load, any I/O and any network call.
if (parsed.flags.help) {
  console.log(USAGE)
  process.exit(EXIT.OK)
}
if (parsed.flags.version) {
  console.log(ROUTER_VERSION)
  process.exit(EXIT.OK)
}
if (parsed.flags.live && parsed.flags.offline) {
  console.error('--live and --offline contradict each other')
  process.exit(EXIT.USAGE)
}

const wantJson = parsed.flags.json
const wantLive = parsed.flags.live
const offline = parsed.flags.offline
const probeWrites = parsed.flags['probe-writes']
// --json is a machine channel, so it is never coloured.
const C = colors({
  noColor: parsed.flags['no-color'] || wantJson,
  env: process.env,
  isTTY: process.stdout.isTTY === true,
})

/* ------------------------------------------------------------- accumulation */

/** Sections are built as DATA, so the text and JSON renderers cannot disagree about findings. */
const sections = []
function section(id, title) {
  const s = { id, title, findings: [], note: [] }
  sections.push(s)
  return s
}

/** Read a JSON file, or null. Used for the manifests, where absence is normal, not an error. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Is a directory writable, judged WITHOUT creating it?
 *
 * Walks to the nearest existing ancestor and asks for permission. The telemetry twin of
 * `checkWritable()` in the governance ledger, and the reason doctor no longer materialises a
 * store in order to describe one.
 */
function dirWritable(dir) {
  let at = dir
  for (let depth = 0; depth < 64; depth++) {
    if (fs.existsSync(at)) break
    const up = path.dirname(at)
    if (up === at) break
    at = up
  }
  try {
    fs.accessSync(at, fs.constants.W_OK)
    return { ok: true, reason: null, checkedAt: at }
  } catch (err) {
    return { ok: false, reason: err?.code ?? 'not_writable', checkedAt: at }
  }
}

/** The budget in one phrase. "none configured" is the honest wording for every-limit-null. */
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

const { config, warnings: configWarnings, sources, coherence: configCoherence } = loadConfig()

/* ------------------------------------------------------------------ project */

/**
 * Identity, not verdicts. "Which copy of the plugin am I even running" is unanswerable today
 * when somebody has both a marketplace install and a --plugin-dir checkout, and it is the first
 * thing a bug report needs.
 */
{
  const s = section('project', 'Project')
  const manifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))
  const pkg = readJson(path.resolve(PLUGIN_ROOT, '..', '..', 'package.json'))

  if (pkg?.name) s.findings.push(info(`repo ${pkg.name} ${pkg.version ?? '?'}`))
  s.findings.push(info(`plugin ${manifest?.name ?? 'model-router'} ${manifest?.version ?? ROUTER_VERSION}`))
  s.findings.push(info('plugin root', PLUGIN_ROOT))

  // A heuristic, and labelled as one. The installed layout is not a documented contract.
  const marketplaceish = /[\\/]\.claude[\\/]plugins[\\/]/.test(PLUGIN_ROOT)
  s.findings.push(
    info(
      `install mode ${marketplaceish ? 'marketplace' : 'repo checkout or --plugin-dir'}`,
      'inferred from the plugin path, which is not a documented contract',
    ),
  )
  s.findings.push(info(`node ${process.versions.node} on ${process.platform} ${os.release()}`))
  // Deliberately NOT a compatibility verdict. A script is not told which Claude Code launched it,
  // and "a configured value is never a measured capability" applies to a version string too.
  s.findings.push(
    info('Claude Code version not detectable from a script', 'run /model-router:doctor inside a session, or see claude --version'),
  )
}

/* ------------------------------------------------------------ configuration */

{
  const s = section('configuration', 'Configuration')
  s.findings.push(pass('config resolved', `project: ${config.projectDir}`))
  if (configWarnings.length === 0) {
    s.findings.push(pass('no configuration warnings'))
  } else {
    for (const w of configWarnings) {
      // An unknown field is a typo worth surfacing; a rejected value is worse.
      const isTypo = w.reason === 'unknown field, ignored'
      s.findings.push((isTypo ? warn : fail)(`${w.field}`, `${w.scope}: ${w.reason}`))
    }
  }
  s.findings.push(
    info(
      `worker ${config.worker.provider}/${config.worker.model}`,
      `budget: ${budgetSummary(config.budget)}`,
    ),
  )
  const overridden = Object.entries(sources).filter(([, src]) => src !== 'user')
  if (overridden.length > 0) {
    s.findings.push(info('overrides', overridden.map(([f, src]) => `${f}<-${src}`).join(', ')))
  } else {
    s.findings.push(info('no overrides', 'every setting is at its bundled default'))
  }
}

/* ------------------------------------------------------------------ runtime */

{
  const s = section('runtime', 'Runtime')
  s.findings.push(nodeFinding({ version: process.versions.node }))
  if (typeof globalThis.fetch === 'function') s.findings.push(pass('global fetch available'))
  else s.findings.push(fail('global fetch missing', 'node 18+ required'))
}

/* ------------------------------------------------------------------ routing */

/** What the gate will actually do. Echoes, not verdicts, apart from the kill switch. */
{
  const s = section('routing', 'Routing')
  if (!config.enabled) {
    s.findings.push(
      warn('routing is DISABLED', 'enabled=false (or CMR_ENABLED=0) — the gate allows every read'),
    )
  } else {
    s.findings.push(pass('routing enabled'))
  }
  s.findings.push(info(`policy version ${POLICY_VERSION}`))

  const br = config.routing.bulkRead
  s.findings.push(
    info(
      `bulk-read gate: enforce=${br.enforce}`,
      `>=${br.minLines} lines OR >=${br.minBytes} bytes, files ${br.minFiles}..${br.maxFiles}`,
    ),
  )
  s.findings.push(
    info(
      `code-write gate: enforce=${config.routing.codeWrite.enforce}`,
      'advisory — no interception ships for this lane yet',
    ),
  )
  // INFO, not WARN: this is a deliberate operator choice either way, and INFO is precisely the
  // level that was missing. The detail states what leaves the machine.
  const intent = config.hooks?.taskIntent?.source ?? 'none'
  s.findings.push(
    info(
      `task intent: ${intent}`,
      intent === 'none'
        ? 'the worker gets a fixed generic task; nothing from your session leaves the machine'
        : `your newest prompt is sent to the worker, clamped to ${config.hooks.taskIntent.maxChars} chars and redacted`,
    ),
  )
  s.findings.push(
    info(
      'never delegated',
      `targeted reads, recently-edited files, and ${config.routing.denyGlobs.length} deny glob(s)`,
    ),
  )
}

/* ----------------------------------------------------------------- provider */

const providerId = parsed.values.provider ?? config.worker.provider
{
  const s = section('worker-provider', 'Worker provider')
  if (providerId !== config.worker.provider) {
    s.findings.push(info('provider overridden on the command line', providerId))
  }

  if (!providerIds().includes(providerId)) {
    s.findings.push(fail(`unknown provider "${providerId}"`, `known: ${providerIds().join(', ')}`))
  } else {
    s.findings.push(pass(`provider "${providerId}" is registered`))

    let mod = null
    try {
      mod = await loadProvider(providerId)
      s.findings.push(pass('provider module satisfies the contract'))
      s.findings.push(
        info(
          'provider capabilities',
          `maxInputBytes=${mod.capabilities.maxInputBytes} reportsUsage=${mod.capabilities.reportsUsage}` +
            ` thinkingTokens=${mod.capabilities.reportsThinkingTokens}`,
        ),
      )
    } catch (err) {
      s.findings.push(fail('provider module failed to load', err.message))
    }

    // Key presence, never the key itself — and checked against the workers a LANE will actually
    // resolve to, not against `worker.provider`.
    //
    // THE PHASE-8 DEFECT. This block used to read `config.worker.apiKeyEnv` alone, which defaults
    // to GEMINI_API_KEY because `worker.provider` defaults to gemini. It was wrong in both
    // directions, and both were measured:
    //
    //   - `workers.*.provider = ollama` with `worker.*` left at its defaults FAILED on an absent
    //     GEMINI_API_KEY and exited 1, reporting a healthy local install as broken, for want of a
    //     key no lane would ever send.
    //   - `worker.provider = ollama` with `workers.bulkRead.provider = gemini` said "no API key
    //     required" and never checked, so the one lane that needed a key failed at its first
    //     delegation instead of here.
    //
    // `wantsKey()` is the authority on whether a key is wanted and `resolveWorker()` on which
    // provider each lane names. Nothing else can answer this.
    const laneWorkers = Object.keys(LANE_MODE).map((lane) => ({ lane, ...resolveWorker(config, lane) }))
    const keyed = new Map()
    for (const w of laneWorkers) {
      if (!providerIds().includes(w.provider) || !wantsKey(w.provider)) continue
      const env = w.apiKeyEnv ?? requiresEnvFor(w.provider)?.[0] ?? null
      if (env === null) continue
      if (!keyed.has(env)) keyed.set(env, [])
      keyed.get(env).push(LANE_MODE[w.lane])
    }

    if (keyed.size === 0) {
      const local = [...new Set(laneWorkers.map((w) => w.provider))].join(', ')
      s.findings.push(pass('no API key required', `every lane runs a local provider (${local})`))
    }
    // Did ANY layer name a provider, or is this the shipped default? That is what decides whether
    // a missing key is a misconfiguration or simply an install nobody has set up yet.
    const providerConfigured =
      sources['worker.provider'] !== undefined ||
      sources['workers.bulkRead.provider'] !== undefined ||
      sources['workers.codeWrite.provider'] !== undefined ||
      sources['worker.apiKeyEnv'] !== undefined
    for (const [keyEnv, modes] of keyed) {
      s.findings.push(
        apiKeyFinding({
          keyEnv,
          modes,
          secret: describeSecret(process.env[keyEnv]),
          configured: providerConfigured,
          platform: process.platform,
        }),
      )
    }

    // Readiness for the globally-configured provider, under the same `wantsKey` guard: a supplied
    // name REPLACES the provider's own requiresEnv, so forwarding it to a provider that needs no
    // key would make a healthy local daemon look unavailable.
    const r = readinessFor(providerId, process.env, {
      apiKeyEnv: wantsKey(providerId) ? config.worker.apiKeyEnv : undefined,
    })
    if (r.ready) s.findings.push(pass('provider readiness: ready', 'the gate can route'))
    else {
      s.findings.push(
        warn('provider readiness: NOT ready', `${r.reason} — the gate fails open and allows reads`),
      )
    }
  }
}

/* -------------------------------------------------------------- worker modes */

/**
 * Which worker each mode actually resolves to.
 *
 * The only place a typo in `workers.<lane>.provider` is ever caught: the value is a free
 * non-empty string as far as the config spec is concerned, so `"gemnii"` loads without a single
 * warning and then fails at the first delegation.
 */
{
  const s = section('worker-modes', 'Worker modes')
  for (const [lane, mode] of Object.entries(LANE_MODE)) {
    const r = resolveWorker(config, lane)
    const inherited = r.inheritedProvider ? 'inherits worker.provider' : `workers.${lane}.provider`
    if (!providerIds().includes(r.provider)) {
      s.findings.push(
        fail(`${mode}: unknown provider "${r.provider}"`, `known: ${providerIds().join(', ')}`),
      )
    } else if (r.model === null) {
      s.findings.push(
        warn(
          `${mode}: ${r.provider} with no model resolved`,
          `set workers.${lane}.model or providers.${r.provider}.model`,
        ),
      )
    } else {
      // `r.apiKeyEnv` is inherited whenever the provider was, so it still names GEMINI_API_KEY for
      // a lane running Ollama. Printing that verbatim implies a key is wanted; `wantsKey()` decides.
      const key = wantsKey(r.provider) ? (r.apiKeyEnv ?? 'none configured') : 'none required'
      s.findings.push(
        pass(`${mode}: ${r.provider}/${r.model}`, `${inherited}, timeoutMs=${r.timeoutMs}, key=${key}`),
      )
    }
  }
}

/* -------------------------------------------------------- worker capability */

/**
 * Can the resolved worker actually hold the prompts we intend to send it?
 *
 * This section may use the network, unlike the gate: doctor is an interactive diagnostic the
 * developer ran on purpose, and for ollama the probe is a localhost round trip measured at about
 * seven milliseconds. The whole value of the section is telling the truth about THIS install, and
 * a bundled table cannot do that. `--offline` skips the probe entirely, which is provider-
 * agnostic and needs no new status: the capability simply falls to configured, bundled or
 * unknown, which `statusForSource()` already labels correctly.
 *
 * Everything here is WARN at worst for an undiscoverable window, because an unknown capability
 * leaves a degraded router rather than a broken one. A provider/model mismatch and an output
 * request that cannot fit are FAIL, because both are misconfigurations with a definite fix.
 */
{
  const s = section('worker-capability', 'Worker capability')

  // Reported either way: "no mismatch" is a real finding, and a section that is silent when
  // everything is fine cannot be distinguished from one that forgot to check.
  if (configCoherence.ok) {
    s.findings.push(
      pass('provider/model coherence', 'every configured worker names a model its provider could own'),
    )
  }
  for (const problem of configCoherence.problems) {
    const where = problem.scope === 'worker' ? 'worker' : `workers.${problem.scope}`
    if (problem.status === 'mismatch') {
      // Name the fix. Setting only `worker.provider: ollama` leaves `worker.model` at
      // gemini-3.8-flash, which is the single most likely way to land here.
      const owned = config.providers?.[problem.provider]?.model
      s.findings.push(
        fail(
          `${where}: provider/model mismatch`,
          `${problem.reason}${owned ? ` — set ${where}.model to a model ${problem.provider} owns, e.g. ${owned}` : ''}`,
        ),
      )
    } else {
      s.findings.push(warn(`${where}: model unresolved`, problem.reason))
    }
  }

  // A configured timeout the runtime will never honour. Only reachable with a very slow local
  // model, which is exactly who sets a long timeout in the first place.
  for (const [lane, mode] of Object.entries(LANE_MODE)) {
    const t = resolveWorker(config, lane).timeoutMs
    if (Number.isInteger(t) && t > FETCH_HEADERS_TIMEOUT_MS) {
      s.findings.push(
        warn(
          `${mode}: timeoutMs ${t} exceeds what the runtime will wait`,
          `the HTTP client gives up at ${FETCH_HEADERS_TIMEOUT_MS}ms, so a slower call fails there and not at ${t}ms`,
        ),
      )
    }
  }

  if (offline) {
    s.findings.push(
      info('capability probe skipped', '--offline: no provider was asked, so a discoverable window is not reported'),
    )
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
        !offline && typeof mod.describeModel === 'function'
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
      s.findings.push(warn(`${mode}: capability probe failed`, err?.message ?? 'unknown error'))
      continue
    }

    const label = `${mode}: ${r.provider}/${r.model}`
    const maxOut = config.worker.maxOutputTokens

    if (capability.contextTokens === null) {
      // NOT a failure. Unknown stays unknown, and the router degrades rather than breaks. Unknown
      // context is never infinite context, so the detail must not imply a number.
      const hint =
        r.provider === 'ollama'
          ? 'start the daemon so /api/show can answer, or set providers.ollama.contextTokens'
          : `no context limit is discoverable for ${r.provider} — that is a missing capability, not a fault; delegation proceeds under the byte ceiling`
      s.findings.push(
        warn(`${label}: context capability unknown`, `${capability.detail ?? 'no source'} — ${hint}`),
      )
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
      s.findings.push(
        fail(
          `${label}: maxOutputTokens ${maxOut} exceeds the ${capability.contextTokens}-token context`,
          `${prov}; no safe cap exists — lower worker.maxOutputTokens or choose a model with a larger window`,
        ),
      )
    } else if (budget.verdict === 'cap_output') {
      s.findings.push(
        warn(
          `${label}: context=${capability.contextTokens} (${prov})`,
          `maxOutputTokens=${maxOut} will be capped to ${budget.allowedOutputTokens}; effectiveInput=${budget.effectiveInputCapacityTokens}`,
        ),
      )
    } else {
      s.findings.push(
        pass(
          `${label}: context=${capability.contextTokens} (${prov})`,
          `maxOutputTokens=${maxOut}, effectiveInput=${budget.effectiveInputCapacityTokens}` +
            `${capability.status === 'assumed' ? ', NOT verified against this install' : ''}`,
        ),
      )
    }
  }
}

/* --------------------------------------------------------------- hook wiring */

{
  const s = section('hook', 'Claude Code hook')
  if (config.hooks?.enabled !== true) {
    s.findings.push(
      warn('hooks.enabled is false', 'nothing is intercepted; routing and telemetry are unaffected'),
    )
  } else {
    s.findings.push(pass('hooks.enabled', `timeoutMs=${config.hooks.timeoutMs}`))
  }

  const manifestPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')
  const manifest = readJson(manifestPath)
  if (manifest === null) {
    s.findings.push(fail('hooks.json is unreadable', manifestPath))
  } else {
    const matchers = manifest.hooks?.PreToolUse
    if (!Array.isArray(matchers) || matchers.length === 0) {
      s.findings.push(
        fail('no PreToolUse hook is registered', 'hooks.json registers nothing, so no Read is gated'),
      )
    } else {
      s.findings.push(
        pass(`PreToolUse registered for ${matchers.map((m) => m.matcher ?? '<all tools>').join(', ')}`),
      )
      // A script Claude Code cannot find is the failure mode with no symptom: the hook simply
      // never runs, every Read proceeds, and nothing anywhere says why.
      for (const matcher of matchers) {
        for (const handler of matcher.hooks ?? []) {
          const target = (handler.args ?? [])[0] ?? handler.command ?? ''
          const resolved = target.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT)
          if (!target.includes('${CLAUDE_PLUGIN_ROOT}')) {
            s.findings.push(warn(`${matcher.matcher}: hook path is not plugin-relative`, target))
          } else if (!fs.existsSync(resolved)) {
            s.findings.push(fail(`${matcher.matcher}: hook script is missing`, resolved))
          } else {
            s.findings.push(
              pass(`${matcher.matcher}: ${path.basename(resolved)} present`, `timeout=${handler.timeout ?? 'default'}s`),
            )
          }
        }
      }
    }
  }

  // Which deadline actually bounds a delegated read. The hook's budget is DESIGNED to be the
  // tighter of the two — worker.timeoutMs defaults to three minutes, a sane ceiling for a script
  // and an unacceptable one for a tool call someone is waiting on — so a shorter hook deadline is
  // information, not a misconfiguration. Only a budget too small for any worker is worth a warning.
  if (config.hooks?.enabled === true) {
    const r = resolveWorker(config, 'bulkRead')
    const budget = config.hooks.timeoutMs
    const effective = Math.min(budget ?? Infinity, r.timeoutMs ?? Infinity)
    if (Number.isInteger(budget) && budget < 5000) {
      s.findings.push(
        warn(`hooks.timeoutMs is ${budget}ms`, 'few workers answer that fast, so most delegations fall open'),
      )
    } else if (Number.isFinite(effective)) {
      s.findings.push(
        pass(
          `a delegated read is bounded at ${effective}ms`,
          effective === budget ? 'by hooks.timeoutMs' : 'by the worker timeout',
        ),
      )
    }
  }
}

/* ---------------------------------------------------------------- telemetry */

let storeReport = null
{
  const s = section('telemetry', 'Telemetry store')
  if (!config.telemetry.enabled) {
    s.findings.push(warn('telemetry is disabled', 'no events will be recorded'))
  } else {
    const dir = config.telemetry.dirResolved
    if (probeWrites) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const probe = path.join(dir, `.doctor-${process.pid}`)
        fs.writeFileSync(probe, 'probe')
        fs.unlinkSync(probe)
        s.findings.push(pass('store is writable (probed by writing)', dir))
      } catch (err) {
        s.findings.push(fail('store is NOT writable', `${dir}: ${err.code ?? err.message}`))
      }
    } else {
      const w = dirWritable(dir)
      if (w.ok) {
        s.findings.push(
          pass(
            'store path is writable (checked by permission, not probed)',
            `${dir}${w.checkedAt === dir ? '' : ` — nearest existing ancestor: ${w.checkedAt}`}; the directory is created by the first event`,
          ),
        )
        if (process.platform === 'win32') {
          s.findings.push(
            info(
              'Windows reports directory write permission unreliably',
              'run with --probe-writes to confirm by actually writing',
            ),
          )
        }
      } else {
        s.findings.push(fail('store path is NOT writable', `${w.checkedAt}: ${w.reason}`))
      }
    }

    // SQLite over a network or cloud-synced volume is a documented corruption risk, and append
    // atomicity is only guaranteed on a local filesystem.
    const looksRemote = /^\\\\/.test(dir) || /onedrive|dropbox|google drive|box sync/i.test(dir)
    if (looksRemote && !config.telemetry.shardByPid) {
      s.findings.push(
        warn('store is on a network or synced volume', 'set telemetry.shardByPid=true for safe concurrent appends'),
      )
    } else if (looksRemote) {
      s.findings.push(pass('store is on a synced volume', 'shardByPid is enabled'))
    } else {
      s.findings.push(pass('store is on a local filesystem', 'single-file appends are safe'))
    }

    s.findings.push(
      info(
        'telemetry settings',
        `sink=${config.telemetry.sink} privacy=${config.telemetry.privacyLevel}` +
          ` avoidedMethod=${config.telemetry.avoidedMethod}` +
          ` provenOnly=${config.telemetry.countProvenFilesOnly}` +
          ` residency=${config.telemetry.residencyTurns}(${config.telemetry.residencySource})`,
      ),
    )

    // The sink the config asked for is not always the sink that runs.
    const resolved = resolveSinkId(config.telemetry.sink)
    if (resolved.fellBackFrom) {
      s.findings.push(warn(`sink "${resolved.fellBackFrom}" is not implemented`, resolved.warning))
    }

    // rotation=none makes retention a complete no-op. A real trap, and cheap to catch.
    if (config.telemetry.rotation === 'none') {
      s.findings.push(
        warn(
          'rotation is "none", so retention can never prune',
          `retentionDays=${config.telemetry.retentionDays} has no effect on an undated segment`,
        ),
      )
    }

    // A malformed line in the MIDDLE of a segment is field-detectable evidence that append
    // atomicity failed on this filesystem — the one claim no specification gives us on Windows or
    // on a network volume. Reading a store that does not exist yields zero lines, not an error.
    const { report } = readSegmentsSync({ dir })
    storeReport = report
    if (report.lines > 0 && report.skipped.malformed > 0) {
      s.findings.push(
        fail(
          `${report.skipped.malformed} malformed line(s) in the store`,
          'a mid-file break means appends are not atomic here; set telemetry.shardByPid=true',
        ),
      )
    } else if (report.lines > 0) {
      s.findings.push(
        pass(
          `${report.yielded} event(s) readable, 0 malformed`,
          report.skipped.truncated_tail > 0
            ? `${report.skipped.truncated_tail} unterminated tail (a writer was mid-flight)`
            : 'appends are intact',
        ),
      )
    }
  }
}

/* ---------------------------------------------------------------- analytics */

/**
 * Is the reporting chain usable, and is there anything to report?
 *
 * "The store is empty" lives here rather than under Telemetry store: an empty store says nothing
 * about store integrity, and everything about whether analytics has input.
 */
{
  const s = section('analytics', 'Analytics')
  const analyticsCli = path.join(PLUGIN_ROOT, 'scripts', 'analytics.mjs')
  if (fs.existsSync(analyticsCli)) s.findings.push(pass('analytics CLI present', 'npm run analytics'))
  else s.findings.push(warn('analytics CLI missing', analyticsCli))

  // The dashboard is a SEPARATE, OPTIONAL plugin. Its absence is never a failure.
  const dashboard = path.resolve(PLUGIN_ROOT, '..', 'router-dashboard', 'scripts', 'report.mjs')
  if (fs.existsSync(dashboard)) s.findings.push(pass('HTML report available', 'npm run report'))
  else {
    s.findings.push(
      warn(
        'router-dashboard is not installed',
        'optional and read-only: claude plugin install router-dashboard@claude-model-router',
      ),
    )
  }

  if (storeReport === null) {
    s.findings.push(info('nothing to report', 'telemetry is disabled, so no window can be summarised'))
  } else if (storeReport.lines === 0) {
    s.findings.push(
      info(
        'nothing delegated yet',
        'the store is empty — delegate a read, then run npm run analytics',
      ),
    )
  } else {
    s.findings.push(info(`${storeReport.yielded} event(s) available to analytics`))
  }
}

/* ------------------------------------------------------------------ pricing */

let anyRateKnown = false
{
  const s = section('pricing', 'Pricing')
  const { chain, warnings: pricingWarnings } = loadPricing(config)
  for (const w of pricingWarnings) s.findings.push(warn(w.field, w.reason))

  if (chain.length === 0) {
    s.findings.push(fail('no pricing table is available', 'every cost and savings figure will be NULL'))
  } else {
    const served = chain.map((e) => `${e.source}@${e.table.pricingVersion}`).join(' -> ')
    s.findings.push(pass(`pricing chain: ${served}`, 'first match wins; tables are never merged'))
  }

  // "Is ANY rate known" is the question a monetary budget actually depends on.
  anyRateKnown = chain.some((e) =>
    Object.values(e.table.models ?? {}).some(
      (row) => Number.isFinite(row.inputPerMTok) || Number.isFinite(row.outputPerMTok),
    ),
  )

  // A row is unpriced only if no HIGHER-priority table names it: resolveRates() takes the first
  // table that has the key, so a bundled null behind a priced override is never consulted. Counting
  // it anyway made doctor report gemini-3.8-flash as unpriced on an install that had priced it.
  const named = new Set()
  const unpriced = []
  for (const e of chain) {
    for (const row of unpricedModels(e.table)) if (!named.has(row.key)) unpriced.push(row)
    for (const key of Object.keys(e.table.models ?? {})) named.add(key)
  }

  // The rows that decide whether THIS install shows dollars: every worker a lane resolves to, and
  // the primary model the counterfactual saving is priced at. The rest of the bundled table is
  // models nobody here calls, and reporting them as a warning hid the one answer that matters.
  const isPriced = (provider, model) => {
    const r = resolveRates(chain, { provider, servedModel: model, requestedModel: model })
    return r.rates !== null && (r.rates.inputPerMTok !== null || r.rates.outputPerMTok !== null)
  }
  const used = new Map()
  for (const lane of Object.keys(LANE_MODE)) {
    const r = resolveWorker(config, lane)
    if (r.provider && r.model) used.set(`${r.provider}:${r.model}`, [r.provider, r.model])
  }
  const primaryModel = config?.telemetry?.primaryModel ?? null
  if (primaryModel) used.set(`anthropic:${primaryModel}`, ['anthropic', primaryModel])
  const usedUnpriced = [...used].filter(([, [p, m]]) => !isPriced(p, m)).map(([key]) => key)

  if (usedUnpriced.length > 0) {
    s.findings.push(
      warn(
        `${usedUnpriced.length} model(s) this install uses have no rates`,
        'token savings are still reported; every DOLLAR figure stays NULL until rates are set',
      ),
    )
    for (const key of usedUnpriced) {
      const row = unpriced.find((u) => u.key === key)
      s.findings.push(info(key, row ? `verify at ${row.verify}` : 'not in any pricing table — add a row'))
    }

    // The bundled table ships every rate null on purpose: a confident wrong dollar figure is
    // worse than a refusal to price. But a null nobody explains reads as a bug, so hand over the
    // exact snippet to paste. Kept as a raw block rather than one finding per line — prefixing
    // nine lines of JSON with INFO would destroy the one property it has.
    //
    // The rates are null and the date is null, deliberately. This block once carried sample
    // numbers and today's date, and the numbers were a retired model's: pasted as-is, they priced
    // gemini-3.8-flash at well under half its real rate and stamped that as verified today. A
    // skeleton must not contain a figure anyone could mistake for a looked-up one.
    s.note.push(
      'To price them, write a table and point pricing.overrides at it (its FULL path).',
      `Replace each null with the per-million rate from the verify page, and set verifiedAt to the day you checked:`,
      '{',
      '  "pricingVersion": "my-rates.1", "unit": "per_mtok", "currency": "USD",',
      '  "models": {',
      `    "${usedUnpriced[0]}": {`,
      '      "inputPerMTok": null, "cachedInputPerMTok": null, "outputPerMTok": null,',
      `      "verify": "${unpriced.find((u) => u.key === usedUnpriced[0])?.verify ?? 'the provider pricing page'}", "verifiedAt": null`,
      '    }',
      '  }',
      '}',
    )
  } else if (!primaryModel) {
    s.findings.push(
      warn(
        'telemetry.primaryModel is not set',
        'the worker is priced, but the saving is priced at the Claude model the read would have gone to — set telemetry.primaryModel',
      ),
    )
  } else {
    s.findings.push(
      pass('every model this install uses has rates', `${[...used.keys()].join(', ')} — dollar figures will be populated`),
    )
    if (unpriced.length > 0) {
      s.findings.push(info(`${unpriced.length} other model(s) unpriced`, 'none of them is used by this configuration'))
    }
  }
}

/* ---------------------------------------------------------------- governance */

/**
 * Can the configured budgets actually be enforced, and what is spent right now?
 *
 * The findings come from `describeGovernance()`, which is pure, so the severity matrix is
 * unit-tested rather than only observable through this script's stdout. Everything here renders;
 * nothing here decides.
 */
{
  const s = section('governance', 'Governance')
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

  // Non-mutating by default, so a default install does not gain a governance directory just by
  // being asked about one.
  const stateWritable = probeWrites ? probeWritable(config) : checkWritable(config)

  for (const f of describeGovernance({
    limits: config.budget,
    pricingAvailable: anyRateKnown,
    stateWritable,
    workers,
  })) {
    const level = LEVEL_FROM_GOVERNANCE[f.level] ?? 'info'
    s.findings.push({ level, label: f.label, detail: f.detail ?? '' })
  }

  // Current spend, which is information rather than a check.
  const state = readState(config)
  if (state.ok && state.state.daily.calls + state.state.monthly.calls > 0) {
    const d = state.state.daily
    const m = state.state.monthly
    s.findings.push(
      info(
        'spend so far',
        `today (${state.periods.day}): ${d.totalTokens} tokens, ${d.calls} call(s);` +
          ` this month (${state.periods.month}): ${m.totalTokens} tokens, ${m.calls} call(s)` +
          `${d.costStatus === 'partial' ? ' — cost is a LOWER BOUND: some calls could not be priced' : ''}`,
      ),
    )
  } else if (!state.ok && state.reason !== 'no_state_dir') {
    s.findings.push(
      warn('budget accounting state could not be read', `${state.reason} — spend is unknown, not zero`),
    )
  }
}

/* --------------------------------------------------------------- live check */

if (wantLive) {
  const s = section('live', 'Live worker call')
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
    s.findings.push(pass(`call succeeded in ${Date.now() - t0}ms`, `attempts=${attempts} model=${result.model}`))

    const u = result.usage
    if (u.source === 'provider_reported') {
      s.findings.push(
        pass(
          'usage reported by provider',
          `in=${u.inputTokens} out=${u.outputTokens}` +
            `${u.cachedInputTokens ? ` cached=${u.cachedInputTokens}` : ''}` +
            `${u.thinkingTokens ? ` thinking=${u.thinkingTokens}` : ''}`,
        ),
      )
    } else {
      // Not fatal, but it means every cost on every event becomes NULL.
      s.findings.push(warn(`usage is ${u.source}`, 'worker cost will be recorded as NULL, not estimated'))
    }
    s.note.push('--- worker said ---', ...result.text.trim().split('\n').slice(0, 6))
  } catch (err) {
    s.findings.push(fail(`call failed: ${err.code ?? 'error'}`, err.message))
    if (err.detail) s.note.push(err.detail)
  }
}

/* ------------------------------------------------------------------ render */

const { counts, exitCode } = summarize(sections)

if (wantJson) {
  const manifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))
  console.log(
    JSON.stringify(
      toJson({
        sections,
        version: ROUTER_VERSION,
        generatedAt: new Date().toISOString(),
        mode: { live: wantLive, offline, probeWrites },
        project: {
          plugin: { name: manifest?.name ?? 'model-router', version: manifest?.version ?? ROUTER_VERSION },
          pluginRoot: PLUGIN_ROOT,
          node: process.versions.node,
          platform: process.platform,
          osRelease: os.release(),
          claudeCodeVersion: null,
        },
      }),
      null,
      2,
    ),
  )
  // process.exitCode, never process.exit(): on POSIX a write to a pipe is asynchronous, so
  // exiting here would discard whatever of this document is still buffered. MEASURED in
  // analytics.mjs, which truncated a 200 KB --json response at about 146 KB on Linux and macOS
  // while working perfectly on Windows, because a Windows pipe write is synchronous.
  process.exitCode = exitCode
} else {

const PAINT = { pass: C.green, warn: C.yellow, fail: C.red, info: C.dim }
console.log(`router doctor ${C.dim}${ROUTER_VERSION}${C.off}`)
for (const s of sections) {
  console.log(`\n${s.title}\n${'-'.repeat(68)}`)
  for (const f of s.findings) {
    const label = f.level.toUpperCase().padEnd(4)
    console.log(
      `  ${PAINT[f.level]}${label}${C.off}  ${f.label}${f.detail ? `  ${C.dim}${f.detail}${C.off}` : ''}`,
    )
  }
  if (s.note.length > 0) {
    console.log('')
    for (const line of s.note) console.log(`  ${C.dim}${line}${C.off}`)
  }
}
if (!wantLive) console.log(`\n${C.dim}Pass --live to make one real worker call.${C.off}`)

console.log(`\n${'='.repeat(68)}`)
if (counts.fail > 0) {
  console.log(
    `${C.red}${counts.fail} failure(s)${C.off}, ${counts.warn} warning(s) — routing will not work correctly.`,
  )
} else if (counts.warn > 0) {
  console.log(
    `${C.green}No failures${C.off}, ${C.yellow}${counts.warn} warning(s)${C.off} — ` +
      'a warning means a degraded router, never a blocked session.',
  )
} else {
  console.log(`${C.green}All checks passed.${C.off}`)
}
process.exitCode = exitCode
}
