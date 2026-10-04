/**
 * Telemetry registry and facade.
 *
 * The one place that knows which repositories exist. Routing, hooks, skills and delegation
 * scripts call emitEvent() and never import a sink module directly, so adding SQLite or
 * ClickHouse later is one file plus one line of the table below.
 *
 * emitEvent() owns the enabled check, sink resolution, the process-wide sink cache (so the fd is
 * reused), and the outer try/catch. Nothing else calls openSink() except tests and doctor.
 */

import crypto from 'node:crypto'
import fsDefault from 'node:fs'
import { validateRepositoryModule } from './contract.mjs'
import { buildEvent } from './event.mjs'
import { buildIdentity } from './identity.mjs'
import { loadPricing } from './pricing-load.mjs'
import { resolveRates } from './pricing-lookup.mjs'
import { calculateCost } from './calc.mjs'
import * as jsonlModule from './jsonl.mjs'
import * as nullModule from './null-sink.mjs'

/**
 * id -> module. Keep alphabetical.
 *
 * Statically imported, unlike the provider registry's lazy table, and for a specific reason: the
 * write path cannot await, so a dynamic import is unusable there. Both modules are small and one
 * of them is always needed, so there is nothing to defer.
 */
const REGISTRY = Object.freeze({
  jsonl: jsonlModule,
  null: nullModule,
})

/**
 * Sinks declared in config's enum but not implemented on the write path, and where their data
 * goes instead. SQLite is deliberately absent from REGISTRY: it is MATERIALISED from the JSONL
 * log by `npm run ingest`, not written on the hot path, because a hook cannot afford a schema
 * migration or a write lock.
 */
const PLANNED = Object.freeze({
  sqlite: {
    fallbackTo: 'jsonl',
    reason: 'sqlite is materialised from the JSONL log by `npm run ingest`, not written on the hot path',
  },
})

export function repositoryIds() {
  return Object.keys(REGISTRY)
}

export function isKnownRepository(id) {
  return Object.hasOwn(REGISTRY, id)
}

/**
 * Which sink will actually be used. PURE, synchronous, never throws — so every fallback decision
 * is unit-testable with no I/O.
 *
 * THREE RULES, each deliberate:
 *
 *  1. FAIL OPEN TO `jsonl`, NEVER TO `null`. Losing data is the one outcome that is never
 *     acceptable, and JSONL is the durable write-ahead log that `ingest` can later turn into
 *     whatever the user actually asked for — so their intent stays satisfiable from data already
 *     on disk. Falling back to `null` would make a config typo silently erase telemetry.
 *  2. EXPLICIT `null` IS HONOURED EXACTLY, with no warning. The user asked for no data; that is a
 *     request, not a failure.
 *  3. The warning is RETURNED, never printed from the hot path. A hook's stdout is a protocol
 *     channel that Claude Code parses, and per-tool-call stderr noise is user-hostile. doctor
 *     surfaces it instead.
 *
 * @returns {{id: string, requested: string, fellBackFrom: string|null, warning: string|null}}
 */
export function resolveSinkId(requested) {
  if (requested === 'null') return { id: 'null', requested, fellBackFrom: null, warning: null }
  if (isKnownRepository(requested)) return { id: requested, requested, fellBackFrom: null, warning: null }

  const planned = PLANNED[requested]
  if (planned) {
    return {
      id: planned.fallbackTo,
      requested,
      fellBackFrom: requested,
      warning:
        `telemetry.sink "${requested}" is not implemented on the write path: ${planned.reason}. ` +
        `Writing ${planned.fallbackTo} instead — no events are lost.`,
    }
  }
  return {
    id: 'jsonl',
    requested,
    fellBackFrom: requested,
    warning:
      `unknown telemetry.sink "${requested}". Known: ${repositoryIds().join(', ')}. ` +
      `Writing jsonl instead — no events are lost.`,
  }
}

/**
 * Fetch and contract-check a repository module. Throws only on an unknown id — a caller that
 * named a repository that does not exist has a bug, and silently substituting one would hide it.
 * Async to match the provider registry's shape and to keep room for a lazily-loaded remote store.
 */
export async function loadRepository(id) {
  return loadRepositorySync(id)
}

/** The same, synchronously, for the write path. */
export function loadRepositorySync(id) {
  if (!isKnownRepository(id)) {
    throw new Error(`unknown telemetry repository "${id}". Known: ${repositoryIds().join(', ')}`)
  }
  const mod = REGISTRY[id]
  const problems = validateRepositoryModule(mod)
  if (problems.length > 0) {
    throw new Error(`telemetry repository "${id}" does not satisfy the contract: ${problems.join('; ')}`)
  }
  return mod
}

/* ----------------------------------------------------------------- enablement */

/**
 * Is telemetry on?
 *
 * `CLAUDE_ROUTER_TELEMETRY=0` is a documented session kill switch with no SPEC entry, so reading
 * process.env for it directly is sanctioned — but it is an undeclared side channel, so THIS IS
 * THE ONLY PLACE IN THE CODEBASE THAT READS IT, and a test pins that. The split matters:
 * CLAUDE_ROUTER_TELEMETRY=0 only silences telemetry, while CMR_ENABLED=0 stops routing.
 */
export function telemetryEnabled(config, env = process.env) {
  return config?.telemetry?.enabled === true && env?.CLAUDE_ROUTER_TELEMETRY !== '0'
}

/* ------------------------------------------------------------------ sink cache */

let cached = null

/**
 * Open a sink from config. SYNC, never throws. Returns a working handle even on failure — a
 * degraded sink that reports `ok: false` is still a sink, and the caller must not have to
 * branch on construction.
 */
export function openSinkFromConfig(config, { fs = fsDefault, now = Date.now, pid = process.pid } = {}) {
  const resolved = resolveSinkId(config?.telemetry?.sink ?? 'jsonl')
  const warnings = resolved.warning ? [resolved.warning] : []
  try {
    const mod = loadRepositorySync(resolved.id)
    return mod.openSink({
      dir: config?.telemetry?.dirResolved ?? config?.telemetry?.dir,
      rotation: config?.telemetry?.rotation ?? 'daily',
      shardByPid: config?.telemetry?.shardByPid === true,
      now,
      pid,
      fs,
      warnings,
    })
  } catch (err) {
    warnings.push(`failed to open telemetry sink "${resolved.id}": ${err?.message ?? 'unknown error'}`)
    return nullModule.openSink({ warnings })
  }
}

export async function openStoreFromConfig(config, { fs = fsDefault } = {}) {
  const resolved = resolveSinkId(config?.telemetry?.sink ?? 'jsonl')
  const mod = await loadRepository(resolved.id)
  return mod.openStore({ dir: config?.telemetry?.dirResolved ?? config?.telemetry?.dir, fs })
}

/** Clears the process-wide caches and closes any held fd. Tests only. */
export function __resetTelemetryForTests() {
  pricingCache = null
  if (cached?.sink) {
    try {
      cached.sink.close()
    } catch {
      /* nothing to do */
    }
  }
  cached = null
}

/* ------------------------------------------------------------------- pricing */

/** Per-process pricing chain, keyed on config identity. Independent of the sink cache. */
let pricingCache = null

/**
 * What did this worker call cost, in dollars, or null if we cannot say?
 *
 * EXPOSED, NOT REIMPLEMENTED. The budget ledger needs a dollar figure to accumulate, and the
 * only honest source is the same `resolveRates` + `calculateCost` pair that prices the event
 * row. A second cost implementation would be a second thing to keep in step with the pricing
 * table, and the first time they disagreed the budget and the savings report would tell the
 * operator two different stories.
 *
 * `null` is the out-of-the-box answer, and it means UNKNOWN, never $0. Every rate in the bundled
 * table ships null, so until `pricing.overrides` is configured this returns null for every
 * metered call — which is why governance has an `onUnknownCost` policy at all.
 *
 * Reuses the same per-process pricing chain `emitEvent` caches, so a governed delegation does
 * not load the pricing table twice.
 *
 * @returns {{costUsd: number|null, status: string, lookup: string}}
 */
export function priceWorkerUsage({ config, provider, model, modelRequested = null, usage = null, capabilities = null, fs = fsDefault }) {
  const unavailable = (lookup) => ({ costUsd: null, status: 'unavailable', lookup })
  try {
    // A SEPARATE CACHE FROM THE SINK'S, deliberately. Reusing `cached` would mean a pricing
    // lookup opened a telemetry sink as a side effect — harmless today, because `openSink()`
    // does no I/O until the first append, but a pricing question has no business creating a
    // writer. Governance calls this on a path where telemetry may be disabled entirely.
    if (pricingCache === null || pricingCache.config !== config) {
      const pricing = loadPricing(config, { fsImpl: fs })
      pricingCache = { config, chain: pricing.chain }
    }

    const rates = resolveRates(pricingCache.chain, {
      provider,
      servedModel: model,
      requestedModel: modelRequested,
    })
    const cost = calculateCost({ usage, rates: rates.rates, lookup: rates.lookup, capabilities })
    return { costUsd: cost.total.value, status: cost.total.status, lookup: rates.lookup }
  } catch {
    // A pricing failure must never become a hook failure, and an unpriceable call is already a
    // state the governance layer handles.
    return unavailable('no_table')
  }
}

/* -------------------------------------------------------------------- facade */

/**
 * The one call a hook or delegation script makes.
 *
 * SYNCHRONOUS, wrapped in try/catch end to end, performs no network I/O and no await, and
 * swallows every error. Telemetry can never break a hook: a developer's session must not fail
 * because a log line could not be written.
 *
 * @returns {import('./contract.mjs').AppendResult}
 */
export function emitEvent(
  inputs,
  { config, fs = fsDefault, now = Date.now, env = process.env, pid = process.pid, eventId } = {},
) {
  const skipped = (reason) => ({ ok: false, bytes: 0, target: null, truncation: null, reason })
  try {
    if (!telemetryEnabled(config, env)) return skipped('telemetry_disabled')

    // The sink, the pricing chain and the identity salt are resolved once per process. A hook
    // writes one event and exits, so this costs nothing there; a long-lived delegation loop would
    // otherwise re-read the pricing file and re-hash the salt for every record.
    if (cached === null || cached.config !== config) {
      // Close the previous handle before replacing it. A caller that builds a fresh config object
      // per call would otherwise leak one file descriptor per event, which a long-lived
      // delegation loop turns into EMFILE.
      if (cached?.sink) {
        try {
          cached.sink.close()
        } catch {
          /* a failed close cannot be acted on */
        }
      }
      const pricing = loadPricing(config, { fsImpl: fs })
      cached = {
        config,
        sink: openSinkFromConfig(config, { fs, now, pid }),
        pricingChain: pricing.chain,
        pricingWarnings: pricing.warnings,
      }
    }

    const nowMs = typeof now === 'function' ? now() : now
    const event = buildEvent({
      ...inputs,
      config,
      pricingChain: cached.pricingChain,
      identity: buildIdentity({
        config,
        sessionId: inputs?.sessionId ?? env?.CLAUDE_SESSION_ID ?? null,
        projectDir: config?.projectDir ?? null,
        fs,
      }),
      now: nowMs,
      eventId: eventId ?? crypto.randomUUID(),
    })

    return cached.sink.append(event)
  } catch (err) {
    // The outermost guard. Nothing below here can propagate.
    return skipped(err?.code ?? err?.message ?? 'emit_failed')
  }
}

/** Warnings accumulated while resolving the sink and the pricing chain. For doctor. */
export function telemetryWarnings(config, { fs = fsDefault } = {}) {
  const resolved = resolveSinkId(config?.telemetry?.sink ?? 'jsonl')
  const pricing = loadPricing(config, { fsImpl: fs })
  return {
    sink: resolved,
    pricingWarnings: pricing.warnings,
    pricingChain: pricing.chain.map((e) => ({ source: e.source, pricingVersion: e.table.pricingVersion })),
  }
}
