/**
 * The measurement layer: the only part of the plugin that touches a disk on the hot path.
 *
 * Two properties matter more than any individual measurement, and both are asserted for every
 * function here:
 *
 *   1. It never throws. A broken measurement must degrade to a refused optimisation, never to a
 *      failed Read.
 *   2. Unmeasurable resolves toward refusing. `recentlyEdited` is the sharp case: an unreadable
 *      transcript returns `true`, which blocks delegation, because `neverDelegate.
 *      onRecentlyEdited` is a safety rule and a silently-skipped safety rule is worse than a
 *      missed saving.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  EDIT_TOOLS,
  TRANSCRIPT_TAIL_BYTES,
  fileBytes,
  readTextContent,
  recentlyEdited,
  workerAvailability,
} from '../plugins/model-router/lib/hook/facts.mjs'
import { hookConfig, makeWorkspace, writeEditTranscript } from './helpers/hook-payload.mjs'

/* ---------------------------------------------------------------- file bytes */

test('the file size comes from metadata, and a measured size is exact', () => {
  const ws = makeWorkspace('facts-size', { bytes: 5_000 })
  try {
    assert.equal(fileBytes(ws.file), ws.bytes)
  } finally {
    ws.cleanup()
  }
})

test('an unmeasurable size is null, never zero', () => {
  // Zero is a legitimate size — an empty file — so it must not double as "I could not tell".
  const ws = makeWorkspace('facts-size-missing')
  try {
    assert.equal(fileBytes(path.join(ws.dir, 'does-not-exist.ts')), null)
    assert.equal(fileBytes(ws.dir), null, 'a directory has a size, but not the size inputBytes means')
    assert.equal(fileBytes(''), null)
    assert.equal(fileBytes(null), null)
    assert.equal(fileBytes(undefined), null)
  } finally {
    ws.cleanup()
  }
})

test('an empty file measures zero, which is a measurement', () => {
  const ws = makeWorkspace('facts-size-empty')
  try {
    const empty = path.join(ws.dir, 'empty.ts')
    fs.writeFileSync(empty, '')
    assert.equal(fileBytes(empty), 0)
  } finally {
    ws.cleanup()
  }
})

test('a throwing filesystem yields null rather than an exception', () => {
  const fsThrows = {
    statSync() {
      throw new Error('EIO')
    },
  }
  assert.equal(fileBytes('/anything', { fs: fsThrows }), null)
})

/* ----------------------------------------------------------- recently edited */

test('a transcript with no edit of this file measures false', () => {
  const ws = makeWorkspace('facts-edit-none')
  try {
    fs.writeFileSync(ws.transcript, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`)
    assert.equal(recentlyEdited(ws.transcript, ws.file), false)
  } finally {
    ws.cleanup()
  }
})

test('an edit of this file by any editing tool measures true', () => {
  for (const tool of EDIT_TOOLS) {
    const ws = makeWorkspace('facts-edit-tool')
    try {
      writeEditTranscript(ws.transcript, ws.file, tool)
      assert.equal(recentlyEdited(ws.transcript, ws.file), true, tool)
    } finally {
      ws.cleanup()
    }
  }
})

test('an edit of a DIFFERENT file does not block this one', () => {
  const ws = makeWorkspace('facts-edit-other')
  try {
    writeEditTranscript(ws.transcript, path.join(ws.dir, 'somewhere-else.ts'))
    assert.equal(recentlyEdited(ws.transcript, ws.file), false)
  } finally {
    ws.cleanup()
  }
})

test('a read of this file is not an edit of it', () => {
  const ws = makeWorkspace('facts-edit-read')
  try {
    fs.writeFileSync(
      ws.transcript,
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: ws.file } }] },
      })}\n`,
    )
    assert.equal(recentlyEdited(ws.transcript, ws.file), false)
  } finally {
    ws.cleanup()
  }
})

test('the path comparison survives separator and case differences', () => {
  // NTFS and APFS are case-insensitive, and a transcript may record either separator.
  const ws = makeWorkspace('facts-edit-case')
  try {
    writeEditTranscript(ws.transcript, ws.file.replace(/\\/g, '/').toUpperCase())
    assert.equal(recentlyEdited(ws.transcript, ws.file), true)
  } finally {
    ws.cleanup()
  }
})

test('every unmeasurable transcript refuses to delegate', () => {
  const ws = makeWorkspace('facts-edit-unmeasurable')
  try {
    assert.equal(recentlyEdited('', ws.file), true, 'no transcript path was supplied')
    assert.equal(recentlyEdited(undefined, ws.file), true)
    assert.equal(recentlyEdited(null, ws.file), true)
    assert.equal(recentlyEdited(path.join(ws.dir, 'no-such.jsonl'), ws.file), true, 'unreadable')
    assert.equal(recentlyEdited(ws.transcript, ''), true, 'no file to ask about')
    const fsThrows = {
      statSync() {
        throw new Error('EIO')
      },
    }
    assert.equal(recentlyEdited(ws.transcript, ws.file, { fs: fsThrows }), true)
  } finally {
    ws.cleanup()
  }
})

test('an empty transcript measures false: the session has edited nothing yet', () => {
  const ws = makeWorkspace('facts-edit-empty')
  try {
    assert.equal(recentlyEdited(ws.transcript, ws.file), false)
  } finally {
    ws.cleanup()
  }
})

test('a malformed line is skipped rather than fatal, and a later real edit is still found', () => {
  const ws = makeWorkspace('facts-edit-malformed')
  try {
    const good = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: ws.file } }] },
    })
    fs.writeFileSync(ws.transcript, `{skip\nnot json\n\n${good}\n`)
    assert.equal(recentlyEdited(ws.transcript, ws.file), true)
  } finally {
    ws.cleanup()
  }
})

test('only the tail is examined, which is a documented bound and not an accident', () => {
  const ws = makeWorkspace('facts-edit-tail')
  try {
    const edit = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: ws.file } }] },
    })
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } })}\n`
    let padding = ''
    while (Buffer.byteLength(padding) < TRANSCRIPT_TAIL_BYTES * 2) padding += filler

    fs.writeFileSync(ws.transcript, `${edit}\n${padding}`)
    assert.equal(
      recentlyEdited(ws.transcript, ws.file),
      false,
      'an edit far outside the tail is not seen — the cost of the scan is bounded, not the session',
    )

    fs.writeFileSync(ws.transcript, `${padding}${edit}\n`)
    assert.equal(recentlyEdited(ws.transcript, ws.file), true, 'a recent edit is inside the tail')
  } finally {
    ws.cleanup()
  }
})

test('a half line at the tail boundary is discarded rather than parsed', () => {
  const ws = makeWorkspace('facts-edit-partial')
  try {
    const edit = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: ws.file } }] },
    })
    // The tail window starts mid-record. Taking the first line seriously would mean parsing half
    // a record, and a half record is not a record.
    fs.writeFileSync(ws.transcript, `${edit}\n`)
    assert.equal(recentlyEdited(ws.transcript, ws.file, { maxBytes: 40 }), false)
  } finally {
    ws.cleanup()
  }
})

/* ------------------------------------------------------------ worker readiness */

test('a keyless local provider is available without any environment at all', () => {
  const config = hookConfig({ worker: { provider: 'ollama', model: 'llama3', apiKeyEnv: null } })
  const got = workerAvailability(config, {})
  assert.equal(got.workerAvailable, true, 'ollama requires no key, so an empty env is ready')
  assert.equal(got.workerUnavailableReason, null)
  assert.equal(got.provider, 'ollama')
})

test('a leftover apiKeyEnv does not make a keyless provider look unavailable', () => {
  // This is the exact trap dispatch() guards at index.mjs:269: switching `worker.provider` to
  // ollama while `worker.apiKeyEnv` still says GEMINI_API_KEY must not report a running daemon
  // as unavailable for want of a key it does not use.
  const config = hookConfig({ worker: { provider: 'ollama', apiKeyEnv: 'GEMINI_API_KEY' } })
  assert.equal(workerAvailability(config, {}).workerAvailable, true)
})

test('a provider that wants a key is unavailable until the key is present', () => {
  const config = hookConfig({ worker: { provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' } })
  assert.equal(workerAvailability(config, {}).workerAvailable, false)
  assert.equal(workerAvailability(config, {}).workerUnavailableReason, 'worker_not_ready')
  assert.equal(workerAvailability(config, { GEMINI_API_KEY: 'k' }).workerAvailable, true)
})

test('apiKeyEnv renames the variable a provider needs', () => {
  const config = hookConfig({ worker: { provider: 'gemini', apiKeyEnv: 'MY_OWN_KEY' } })
  assert.equal(workerAvailability(config, { GEMINI_API_KEY: 'k' }).workerAvailable, false)
  assert.equal(workerAvailability(config, { MY_OWN_KEY: 'k' }).workerAvailable, true)
})

test('an unknown or missing provider is unavailable, never assumed', () => {
  for (const provider of ['nope', '', null, undefined]) {
    const config = hookConfig()
    config.worker = { ...config.worker, provider }
    const got = workerAvailability(config, {})
    assert.equal(got.workerAvailable, false, String(provider))
    assert.equal(got.workerUnavailableReason, 'worker_not_ready')
  }
})

test('budget_exceeded is never reported, because budget enforcement is not in this phase', () => {
  // Naming a reason nothing can produce would be a claim about a feature that does not exist.
  for (const cfg of [hookConfig(), {}, null, undefined]) {
    assert.notEqual(workerAvailability(cfg, {}).workerUnavailableReason, 'budget_exceeded')
  }
})

test('a malformed config is unavailable rather than an exception', () => {
  for (const cfg of [undefined, null, 0, 'x', [], {}, { worker: null }]) {
    assert.doesNotThrow(() => workerAvailability(cfg, {}), String(cfg))
    assert.equal(workerAvailability(cfg, {}).workerAvailable, false, String(cfg))
  }
})

test('the lane worker is what is checked, so a per-lane override is honoured', () => {
  const config = hookConfig({
    worker: { provider: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' },
    workers: { bulkRead: { provider: 'ollama' } },
  })
  assert.equal(workerAvailability(config, {}).provider, 'ollama')
  assert.equal(workerAvailability(config, {}).workerAvailable, true)
})

/* -------------------------------------------------------------- file content */

test('a text file is read once and returned whole', () => {
  const ws = makeWorkspace('facts-content', { bytes: 2_000 })
  try {
    const got = readTextContent(ws.file)
    assert.equal(got.ok, true)
    assert.equal(got.content.length, ws.chars)
  } finally {
    ws.cleanup()
  }
})

test('a binary file is refused, because a prompt full of replacement characters still bills', () => {
  const ws = makeWorkspace('facts-content-binary')
  try {
    const bin = path.join(ws.dir, 'thing.bin')
    fs.writeFileSync(bin, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]))
    const got = readTextContent(bin)
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'binary')
  } finally {
    ws.cleanup()
  }
})

test('an unreadable file is refused rather than thrown', () => {
  const ws = makeWorkspace('facts-content-missing')
  try {
    const got = readTextContent(path.join(ws.dir, 'gone.ts'))
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'unreadable')
  } finally {
    ws.cleanup()
  }
})
