/**
 * The security boundary: what the dispatcher is allowed to touch, and what it is allowed to say.
 *
 * The structural half — no `node:` import, no console, no telemetry edge — is enforced in
 * `telemetry.isolation.test.mjs`, which is where this repo keeps architecture rules so they fail
 * CI rather than sit in a comment. This file covers the behavioural half: secrets must not
 * survive into a result, and supplied content must not become a filesystem lookup.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { dispatch } from '../plugins/model-router/lib/dispatch/index.mjs'
import { dispatchError, fromProviderError } from '../plugins/model-router/lib/dispatch/contract.mjs'
import { ProviderError } from '../plugins/model-router/lib/providers/contract.mjs'
import { startProviderServer } from './helpers/provider-server.mjs'
import { REPO_ROOT } from './helpers/telemetry-dir.mjs'
import { bulkReadPayload, delegatingDecision, serverConfig } from './helpers/dispatch-input.mjs'

let server
test.before(async () => { server = await startProviderServer() })
test.after(async () => { await server?.close() })

const GEMINI_SECRET = 'AIzaSyTESTTESTTESTTESTTESTTESTTEST'
const ANTHROPIC_SECRET = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa'

const mockConfig = () =>
  serverConfig(server.url, { workers: { bulkRead: { provider: 'mock', model: 'mock-1' } } })

/* ------------------------------------------------------------------ redaction */

test('a secret in an error message is scrubbed, not only one in the detail', () => {
  // httpJson redacts `detail` but never `message`, and parseOllamaResponse interpolates raw
  // daemon text straight into a message. Scrubbing only what this layer writes itself would
  // leave that path open, so both fields are scrubbed regardless of who wrote them.
  const err = new ProviderError('unknown', `ollama: upstream rejected key ${GEMINI_SECRET}`, {
    provider: 'ollama',
    detail: `authorization: Bearer ${ANTHROPIC_SECRET}`,
  })
  const { error } = fromProviderError(err, undefined)
  assert.equal(error.message.includes(GEMINI_SECRET), false, 'the message leaked a key')
  assert.equal(error.detail.includes(ANTHROPIC_SECRET), false, 'the detail leaked a key')
  assert.match(error.message, /\[redacted\]/)
  assert.match(error.detail, /\[redacted\]/)
})

test('redaction runs on an aborted error too, not only on the provider-error path', () => {
  const err = new ProviderError('transport', `cancelled while sending ${GEMINI_SECRET}`, { provider: 'gemini' })
  const ctl = new AbortController()
  ctl.abort()
  const { error, reason } = fromProviderError(err, ctl.signal)
  assert.equal(reason, 'aborted')
  assert.equal(error.message.includes(GEMINI_SECRET), false)
})

test('dispatchError scrubs every secret shape the shared helper knows about', () => {
  const shapes = [
    GEMINI_SECRET,
    ANTHROPIC_SECRET,
    'ghp_aaaaaaaaaaaaaaaaaaaa',
    'api_key=supersecretvalue',
    'authorization: Bearer abcdefghijklmnop',
  ]
  for (const secret of shapes) {
    const e = dispatchError('unknown', `failed: ${secret}`, { detail: `also: ${secret}` })
    assert.equal(e.message.includes(secret), false, `message leaked ${secret}`)
    assert.equal(e.detail.includes(secret), false, `detail leaked ${secret}`)
  }
})

test('a non-string message is coerced rather than thrown on, and still scrubbed', () => {
  assert.equal(typeof dispatchError('unknown', undefined).message, 'string')
  assert.equal(typeof dispatchError('unknown', { toString: () => GEMINI_SECRET }).message, 'string')
  assert.equal(dispatchError('unknown', { toString: () => GEMINI_SECRET }).message.includes(GEMINI_SECRET), false)
})

/* ---------------------------------------------------------- nothing leaks out */

test('a key present in the environment never appears anywhere in a result', async () => {
  const r = await dispatch({
    decision: delegatingDecision(),
    config: serverConfig(`${server.url}/s/auth_401`, {
      workers: { bulkRead: { provider: 'gemini', model: 'gemini-2.5-flash' } },
    }),
    input: bulkReadPayload(),
    env: { GEMINI_API_KEY: GEMINI_SECRET },
    sleep: async () => {},
  })
  assert.equal(r.status, 'error')
  assert.equal(JSON.stringify(r).includes(GEMINI_SECRET), false, 'the API key reached the result')
})

test('a secret inside the corpus does not come back in the result', async () => {
  // The worker sees the content the caller chose to send; the RESULT is what gets logged, and it
  // must not become a second copy of whatever was in those files.
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload({
      files: [{ path: '.env', content: `ANTHROPIC_API_KEY=${ANTHROPIC_SECRET}\n` }],
      task: 'what is configured here',
    }),
    env: { MOCK_WORKER_URL: server.url },
    scenario: 'ok',
  })
  assert.equal(JSON.stringify(r).includes(ANTHROPIC_SECRET), false)
})

test('the result never carries the prompt it sent, so a log of results is not a log of corpora', async () => {
  const marker = 'UNIQUE_CORPUS_MARKER_7f3a'
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload({ files: [{ path: 'a.js', content: marker }] }),
    env: { MOCK_WORKER_URL: server.url },
    scenario: 'ok',
  })
  assert.equal(JSON.stringify(r).includes(marker), false, 'the corpus came back inside the result')
})

/* ------------------------------------------------------- no ambient authority */

test('a path in the input is a label, never a lookup — no file is read and none is written', async () => {
  // The execution layer RECEIVES content. A worker that could name its own inputs would turn a
  // gated read into an ungated one.
  const real = path.join(REPO_ROOT, 'package.json')
  const onDisk = fs.readFileSync(real, 'utf8')
  const before = fs.statSync(real).mtimeMs

  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload({
      files: [{ path: real, content: 'SUBSTITUTE_CONTENT_NOT_FROM_DISK' }],
      task: 'describe it',
    }),
    env: { MOCK_WORKER_URL: server.url },
    scenario: 'ok',
  })

  assert.equal(r.status, 'ok')
  const sent = server.requests.at(-1).body.prompt
  assert.ok(sent.includes('SUBSTITUTE_CONTENT_NOT_FROM_DISK'))
  assert.equal(sent.includes('"devDependencies"'), false, 'the real file was read from disk')
  assert.equal(sent.includes(onDisk.slice(0, 80)), false)
  assert.equal(fs.statSync(real).mtimeMs, before, 'the dispatcher wrote to the project')
})

test('a traversal or absolute path in a file label changes nothing, because nothing resolves it', async () => {
  for (const p of ['../../etc/passwd', '/etc/shadow', 'C:\\Windows\\System32\\config\\SAM', '~/.ssh/id_rsa']) {
    const r = await dispatch({
      decision: delegatingDecision(),
      config: mockConfig(),
      input: bulkReadPayload({ files: [{ path: p, content: 'INERT' }] }),
      env: { MOCK_WORKER_URL: server.url },
      scenario: 'ok',
    })
    assert.equal(r.status, 'ok', `${p} was treated as something other than a label`)
    assert.ok(server.requests.at(-1).body.prompt.includes('INERT'))
  }
})

test('shell metacharacters in input are inert, because nothing is ever executed', async () => {
  const hostile = '$(rm -rf /); `whoami`; && shutdown -h now'
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload({ files: [{ path: 'evil.sh', content: hostile }], task: hostile }),
    env: { MOCK_WORKER_URL: server.url },
    scenario: 'ok',
  })
  assert.equal(r.status, 'ok')
  assert.ok(server.requests.at(-1).body.prompt.includes(hostile), 'passed through as text, nothing more')
})

test('the dispatcher takes the gate s word on which paths are allowed, and says so', async () => {
  // A deny-globbed path reaching the dispatcher means the caller skipped the gate. Re-checking
  // here would put a second copy of the security rule in a second place, and two copies drift.
  // What matters is that the dispatcher does not CLAIM to have checked: nothing in the result
  // asserts the corpus was screened.
  const r = await dispatch({
    decision: delegatingDecision(),
    config: mockConfig(),
    input: bulkReadPayload({ files: [{ path: 'config/.env.production', content: 'K=V' }] }),
    env: { MOCK_WORKER_URL: server.url },
    scenario: 'ok',
  })
  assert.equal(r.status, 'ok')
  assert.equal(Object.keys(r).some((k) => /glob|screen|allow|denied/i.test(k)), false)
})
