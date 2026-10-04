/**
 * The null repository: accepts everything, stores nothing, reads back nothing.
 *
 * `telemetry.sink: 'null'` is a REQUEST, not a fallback. A user who selects it has asked for no
 * data, so this module is silent — no warning, no directory created, no file touched. That is
 * exactly why the registry never *falls back* to null: silently discarding telemetry because of a
 * config typo would be indistinguishable from this, which is a thing somebody deliberately chose.
 *
 * It exists as a real module rather than an `if` in the registry so that it runs the same
 * conformance suite as the JSONL sink. An implementation that is only exercised by a branch is an
 * implementation nobody has tested.
 */

import { emptyReadReport, RECORD_MAX_BYTES } from './contract.mjs'

export const id = 'null'

export const capabilities = Object.freeze({
  synchronousWrite: true,
  durableOnAppend: false,
  supportsConcurrentWriters: true,
  requiresIngest: false,
  recordCapBytes: RECORD_MAX_BYTES,
})

export const storeCapabilities = Object.freeze({
  sink: true,
  streaming: true,
  aggregatesInStore: false,
  supportsPrune: false,
  supportsIngest: false,
})

export function openSink({ warnings = [] } = {}) {
  const counters = { appended: 0, bytes: 0, truncated: 0, dropped: 0, errors: 0, lastError: null }

  return {
    id,
    capabilities,
    warnings,
    /**
     * Reports ok with zero bytes. `ok: true` is correct: the sink did what it promised. A caller
     * that needs to know whether bytes landed reads `bytes`, or asks describe().
     */
    append: () => {
      counters.appended += 1
      return { ok: true, bytes: 0, target: null, truncation: null, reason: null }
    },
    flush: () => ({ ok: true, bytes: 0, target: null, truncation: null, reason: null }),
    close: () => {},
    describe: () => ({
      sink: id,
      dir: null,
      rotation: 'none',
      shardByPid: false,
      target: null,
      recordCapBytes: RECORD_MAX_BYTES,
      disabled: false,
    }),
    counters: () => ({ ...counters }),
  }
}

export async function openStore() {
  const report = emptyReadReport()
  return {
    id,
    storeCapabilities,
    async segments() {
      return []
    },
    // eslint-disable-next-line require-yield
    async *read() {
      /* nothing was ever stored */
    },
    report: () => JSON.parse(JSON.stringify(report)),
    async close() {},
  }
}
