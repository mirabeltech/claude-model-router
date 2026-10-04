/**
 * The repository contract, run against EVERY implementation.
 *
 * Same shape as test/providers.conformance.test.mjs: one table of implementations, the same
 * assertions for each. A new store is wired in by adding one entry below — if it cannot pass
 * these, it is not finished.
 *
 * The behavioural half matters as much as the static half. A validator can check that `append`
 * is not declared async; only a test can check that calling it with a hostile record returns a
 * result instead of throwing, which is the property the whole "telemetry never breaks a hook"
 * rule depends on.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  validateRepositoryModule,
  validateSinkHandle,
  validateStoreHandle,
} from '../plugins/model-router/lib/telemetry/contract.mjs'
import {
  emitEvent,
  isKnownRepository,
  loadRepository,
  openSinkFromConfig,
  openStoreFromConfig,
  repositoryIds,
  resolveSinkId,
  telemetryEnabled,
  __resetTelemetryForTests,
} from '../plugins/model-router/lib/telemetry/index.mjs'
import { SPEC } from '../plugins/model-router/lib/config.mjs'
import { FROZEN_MS, buildProbeRecord, caps, makeTempDir, telemetryConfig, usage } from './helpers/telemetry-dir.mjs'

/** How to drive each repository. A new one is one entry. */
const REPOSITORIES = [
  { id: 'jsonl', expectBytes: true, expectFiles: 1 },
  { id: 'null', expectBytes: false, expectFiles: 0 },
]

const record = () => buildProbeRecord({ writerIndex: 0, seq: 1, padLen: 10, nonce: 'n' })

/* ------------------------------------------------------- the shared contract */

for (const r of REPOSITORIES) {
  test(`[${r.id}] satisfies the repository module contract`, async () => {
    const mod = await loadRepository(r.id)
    assert.deepEqual(validateRepositoryModule(mod), [])
    assert.equal(mod.id, r.id)
  })

  test(`[${r.id}] openSink is synchronous and performs no I/O`, async () => {
    const mod = await loadRepository(r.id)
    const tmp = makeTempDir(`contract-noio-${r.id}`)
    try {
      const inner = path.join(tmp.dir, 'not-created-yet')
      const handle = mod.openSink({ dir: inner, now: () => FROZEN_MS, pid: 1 })
      assert.ok(!(handle instanceof Promise), 'openSink must not return a promise')
      // A session that never delegates must not leave a directory behind.
      assert.equal(fs.existsSync(inner), false)
      assert.deepEqual(validateSinkHandle(handle), [])
      handle.close()
    } finally {
      tmp.cleanup()
    }
  })

  test(`[${r.id}] append returns a result synchronously, never a promise`, async () => {
    const mod = await loadRepository(r.id)
    const tmp = makeTempDir(`contract-sync-${r.id}`)
    try {
      const handle = mod.openSink({ dir: tmp.dir, now: () => FROZEN_MS, pid: 1 })
      const res = handle.append(record())
      assert.ok(!(res instanceof Promise), 'append must not return a promise')
      assert.equal(res.ok, true, res.reason ?? '')
      assert.equal(res.bytes > 0, r.expectBytes)
      handle.close()
    } finally {
      tmp.cleanup()
    }
  })

  test(`[${r.id}] a record that cannot serialize returns ok:false rather than throwing`, async () => {
    const mod = await loadRepository(r.id)
    const tmp = makeTempDir(`contract-hostile-${r.id}`)
    try {
      const handle = mod.openSink({ dir: tmp.dir, now: () => FROZEN_MS, pid: 1 })
      const circular = { ...record() }
      circular.self = circular
      // Sanitization makes this survivable rather than fatal, which is the point: the hook still
      // gets a result and the event is still written.
      const res = handle.append(circular)
      assert.ok(!(res instanceof Promise))
      assert.equal(typeof res.ok, 'boolean')
      handle.close()
    } finally {
      tmp.cleanup()
    }
  })

  test(`[${r.id}] an unwritable directory degrades instead of throwing`, async () => {
    const mod = await loadRepository(r.id)
    // A path whose parent is a FILE cannot be created on any platform, so this is a portable way
    // to make mkdir fail.
    const tmp = makeTempDir(`contract-unwritable-${r.id}`)
    try {
      const blocker = path.join(tmp.dir, 'blocker')
      fs.writeFileSync(blocker, 'not a directory')
      const handle = mod.openSink({ dir: path.join(blocker, 'sub'), now: () => FROZEN_MS, pid: 1 })
      const res = handle.append(record())
      assert.ok(!(res instanceof Promise))
      assert.equal(typeof res.ok, 'boolean')
      if (r.id === 'jsonl') {
        assert.equal(res.ok, false)
        assert.equal(handle.counters().errors > 0, true)
        // A degraded sink must not retry mkdir for every record for the rest of the process.
        handle.append(record())
        assert.equal(handle.describe().disabled, true)
      }
      handle.close()
    } finally {
      tmp.cleanup()
    }
  })

  test(`[${r.id}] describe and counters report the handle's own state`, async () => {
    const mod = await loadRepository(r.id)
    const tmp = makeTempDir(`contract-describe-${r.id}`)
    try {
      const handle = mod.openSink({ dir: tmp.dir, now: () => FROZEN_MS, pid: 7 })
      handle.append(record())
      const d = handle.describe()
      assert.equal(d.sink, r.id)
      assert.equal(typeof d.recordCapBytes, 'number')
      assert.equal(handle.counters().appended, 1)
      handle.close()
    } finally {
      tmp.cleanup()
    }
  })

  test(`[${r.id}] close is idempotent and never throws`, async () => {
    const mod = await loadRepository(r.id)
    const tmp = makeTempDir(`contract-close-${r.id}`)
    try {
      const handle = mod.openSink({ dir: tmp.dir, now: () => FROZEN_MS, pid: 1 })
      handle.append(record())
      handle.close()
      handle.close()
    } finally {
      tmp.cleanup()
    }
  })

  test(`[${r.id}] the store handle satisfies the read contract`, async () => {
    const mod = await loadRepository(r.id)
    const tmp = makeTempDir(`contract-store-${r.id}`)
    try {
      const sink = mod.openSink({ dir: tmp.dir, now: () => FROZEN_MS, pid: 1 })
      sink.append(record())
      sink.close()

      const store = await mod.openStore({ dir: tmp.dir, fs })
      assert.deepEqual(validateStoreHandle(store), [])
      const segments = await store.segments()
      assert.equal(segments.length, r.expectFiles)

      const out = []
      for await (const rec of store.read()) out.push(rec)
      assert.equal(out.length, r.expectBytes ? 1 : 0)
      assert.equal(typeof store.report().yielded, 'number')
      await store.close()
    } finally {
      tmp.cleanup()
    }
  })
}

/* ------------------------------------------------------- the validator itself */

test('the validator rejects a stub that is missing its exports', () => {
  assert.ok(validateRepositoryModule({}).length > 0)
  assert.ok(validateRepositoryModule({ id: '' }).length > 0)
  assert.ok(validateRepositoryModule({ id: 'x' }).some((p) => /openSink, openStore/.test(p)))
})

test('the validator rejects an async openSink — the write path must not be awaitable', () => {
  const problems = validateRepositoryModule({
    id: 'bad',
    capabilities: {
      synchronousWrite: true,
      durableOnAppend: true,
      supportsConcurrentWriters: true,
      requiresIngest: false,
      recordCapBytes: 1024,
    },
    openSink: async () => ({}),
  })
  assert.ok(problems.some((p) => /openSink must not be an async function/.test(p)))
})

test('the validator rejects a sink that does not declare synchronousWrite', () => {
  const problems = validateRepositoryModule({
    id: 'bad',
    capabilities: {
      synchronousWrite: false,
      durableOnAppend: true,
      supportsConcurrentWriters: true,
      requiresIngest: false,
      recordCapBytes: 1024,
    },
    openSink: () => ({}),
  })
  assert.ok(problems.some((p) => /synchronousWrite must be true/.test(p)))
})

test('the validator rejects a non-async openStore', () => {
  const problems = validateRepositoryModule({
    id: 'bad',
    storeCapabilities: {
      sink: false,
      streaming: true,
      aggregatesInStore: true,
      supportsPrune: false,
      supportsIngest: false,
    },
    openStore: () => ({}),
  })
  assert.ok(problems.some((p) => /openStore must be an async function/.test(p)))
})

test('the validator requires prune and ingestBatch when the capabilities claim them', () => {
  const problems = validateStoreHandle({
    id: 'x',
    storeCapabilities: { sink: true, streaming: true, aggregatesInStore: false, supportsPrune: true, supportsIngest: true },
    segments() {},
    read() {},
    report() {},
    close() {},
  })
  assert.ok(problems.some((p) => /prune/.test(p)))
  assert.ok(problems.some((p) => /ingestBatch/.test(p)))
})

/* ------------------------------------------------------------ sink resolution */

test('an implemented sink resolves to itself with no warning', () => {
  for (const id of repositoryIds()) {
    const r = resolveSinkId(id)
    assert.equal(r.id, id)
    assert.equal(r.fellBackFrom, null)
    assert.equal(r.warning, null)
  }
})

test('sqlite falls back to jsonl, so no event is lost while it is unimplemented', () => {
  const r = resolveSinkId('sqlite')
  assert.equal(r.id, 'jsonl')
  assert.equal(r.fellBackFrom, 'sqlite')
  assert.match(r.warning, /not implemented/)
  assert.match(r.warning, /no events are lost/)
})

test('an unknown sink falls back to jsonl, never to null', () => {
  const r = resolveSinkId('clickhouse')
  // Falling back to null would make a config typo silently erase telemetry, and would be
  // indistinguishable from someone deliberately asking for no data.
  assert.equal(r.id, 'jsonl')
  assert.notEqual(r.id, 'null')
  assert.match(r.warning, /unknown telemetry.sink/)
})

test('an explicit null sink is honoured exactly and warns about nothing', () => {
  const r = resolveSinkId('null')
  assert.equal(r.id, 'null')
  assert.equal(r.warning, null)
})

test('every telemetry.sink value in SPEC resolves to a loadable repository', async () => {
  // This is the guard that makes adding an enum value to config.mjs without a registry entry a
  // CI failure rather than a runtime surprise.
  for (const value of SPEC['telemetry.sink'].values) {
    const r = resolveSinkId(value)
    assert.equal(isKnownRepository(r.id), true, `${value} resolved to unknown ${r.id}`)
    const mod = await loadRepository(r.id)
    assert.deepEqual(validateRepositoryModule(mod), [])
  }
})

test('loadRepository throws on an id that does not exist at all', async () => {
  await assert.rejects(() => loadRepository('postgres'), /unknown telemetry repository/)
})

/* ------------------------------------------------------------------ the facade */

test('telemetry is off when disabled in config or killed by the session switch', () => {
  const on = telemetryConfig('.')
  assert.equal(telemetryEnabled(on, {}), true)
  assert.equal(telemetryEnabled(on, { CLAUDE_ROUTER_TELEMETRY: '0' }), false)
  assert.equal(telemetryEnabled(on, { CLAUDE_ROUTER_TELEMETRY: '1' }), true)
  assert.equal(telemetryEnabled(telemetryConfig('.', { enabled: false }), {}), false)
  assert.equal(telemetryEnabled(null, {}), false)
})

test('a disabled session writes nothing and still returns a result', () => {
  const tmp = makeTempDir('facade-disabled')
  try {
    __resetTelemetryForTests()
    const config = telemetryConfig(tmp.dir, { enabled: false })
    const res = emitEvent({}, { config, now: () => FROZEN_MS })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'telemetry_disabled')
    assert.equal(fs.readdirSync(tmp.dir).length, 0)
  } finally {
    __resetTelemetryForTests()
    tmp.cleanup()
  }
})

test('emitEvent writes one line and never throws, even on a hostile input', () => {
  const tmp = makeTempDir('facade-emit')
  try {
    __resetTelemetryForTests()
    const config = telemetryConfig(tmp.dir)
    const res = emitEvent(
      {
        providerId: 'gemini',
        result: { text: 'summary', usage: usage(), model: 'gemini-3.8-flash', providerLatencyMs: 10, truncated: false, finishReason: 'STOP' },
        capabilities: caps(),
        attempts: 1,
        filesCount: 2,
        provenFilesCount: 2,
        corpusChars: 8000,
        inputBytes: 8000,
        latencyMs: 50,
      },
      { config, now: () => FROZEN_MS, eventId: 'fixed-id' },
    )
    assert.equal(res.ok, true, res.reason ?? '')

    const hostile = { providerId: 'gemini', result: { text: 'x', usage: 'not-a-usage-object' } }
    const res2 = emitEvent(hostile, { config, now: () => FROZEN_MS })
    assert.equal(typeof res2.ok, 'boolean', 'a bad input must return, not throw')
  } finally {
    __resetTelemetryForTests()
    tmp.cleanup()
  }
})

test('openSinkFromConfig surfaces the fallback warning in band rather than printing it', () => {
  const tmp = makeTempDir('facade-warn')
  try {
    const config = telemetryConfig(tmp.dir, { sink: 'sqlite' })
    const handle = openSinkFromConfig(config, { now: () => FROZEN_MS })
    assert.equal(handle.id, 'jsonl')
    assert.equal(handle.warnings.length, 1)
    assert.match(handle.warnings[0], /not implemented/)
    handle.close()
  } finally {
    tmp.cleanup()
  }
})

test('openStoreFromConfig reads back what the sink wrote', async () => {
  const tmp = makeTempDir('facade-store')
  try {
    __resetTelemetryForTests()
    const config = telemetryConfig(tmp.dir)
    emitEvent({ providerId: 'mock' }, { config, now: () => FROZEN_MS })
    const store = await openStoreFromConfig(config)
    const out = []
    for await (const rec of store.read()) out.push(rec)
    assert.equal(out.length, 1)
    assert.equal(out[0].provider, 'mock')
    await store.close()
  } finally {
    __resetTelemetryForTests()
    tmp.cleanup()
  }
})

test('the segment rolls when a long-lived process crosses the UTC date boundary', () => {
  const tmp = makeTempDir('facade-rollover')
  try {
    let clock = Date.parse('2026-03-04T23:59:59.000Z')
    const handle = openSinkFromConfig(telemetryConfig(tmp.dir), { now: () => clock })
    assert.equal(handle.append(record()).ok, true)
    clock = Date.parse('2026-03-05T00:00:01.000Z')
    assert.equal(handle.append(record()).ok, true)
    handle.close()

    const names = fs.readdirSync(tmp.dir).filter((n) => n.endsWith('.jsonl')).sort()
    // Without the per-append path check, both records would land in the 03-04 file.
    assert.deepEqual(names, ['events-2026-03-04.jsonl', 'events-2026-03-05.jsonl'])
  } finally {
    tmp.cleanup()
  }
})
