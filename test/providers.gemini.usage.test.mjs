/**
 * Gemini usage parsing against the shape a REAL response has.
 *
 * Gemini's JSON omits a zero-valued count rather than sending 0. A live call on 2026-10-05
 * returned promptTokenCount 5805, candidatesTokenCount 1349, totalTokenCount 7154 and NEITHER
 * cachedContentTokenCount nor thoughtsTokenCount. Parsed as two nulls, that made the strict worker
 * token sum — and every cost figure built on it — unavailable on every real call, while the
 * loopback fixture (which sends every field) passed.
 *
 * The rule pinned here: an omitted count becomes 0 only as far as the response itself proves it,
 * and never in the direction that would understate cost.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { extractUsage } from '../plugins/model-router/lib/providers/gemini.mjs'

test('the measured live shape: both counts omitted, total proves them zero', () => {
  const u = extractUsage({ promptTokenCount: 5805, candidatesTokenCount: 1349, totalTokenCount: 7154 })
  assert.equal(u.inputTokens, 5805)
  assert.equal(u.cachedInputTokens, 0)
  assert.equal(u.outputTokens, 1349)
  assert.equal(u.thinkingTokens, 0)
  assert.equal(u.totalTokens, 7154)
  assert.equal(u.source, 'provider_reported')
})

test('an unattributed remainder in the total keeps thinking UNKNOWN, never zero', () => {
  // 300 tokens the response does not attribute could be billed reasoning. Calling them 0 would
  // understate cost, which is the direction this parser must never err in.
  const u = extractUsage({ promptTokenCount: 5805, candidatesTokenCount: 1349, totalTokenCount: 7454 })
  assert.equal(u.thinkingTokens, null)
})

test('no total at all keeps thinking unknown', () => {
  const u = extractUsage({ promptTokenCount: 5805, candidatesTokenCount: 1349 })
  assert.equal(u.thinkingTokens, null)
})

test('reported counts are used verbatim, and cached input is subtracted once', () => {
  const u = extractUsage({
    promptTokenCount: 1000,
    cachedContentTokenCount: 400,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 300,
    totalTokenCount: 1500,
  })
  assert.equal(u.inputTokens, 600)
  assert.equal(u.cachedInputTokens, 400)
  assert.equal(u.thinkingTokens, 300)
})

test('no usage block is still missing, never a row of zeros', () => {
  for (const meta of [undefined, null, 'x']) {
    const u = extractUsage(meta)
    assert.equal(u.inputTokens, null)
    assert.equal(u.cachedInputTokens, null)
    assert.equal(u.thinkingTokens, null)
    assert.equal(u.source, 'missing')
  }
  // A block with no prompt count says nothing about cache either.
  assert.equal(extractUsage({ candidatesTokenCount: 5 }).cachedInputTokens, null)
})
