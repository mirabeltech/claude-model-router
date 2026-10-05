/**
 * `router doctor` — the user-facing diagnostic.
 *
 * Until phase 8 this script had no tests at all, which is an odd gap for the one thing a
 * developer runs when the router is misbehaving: a doctor that misreports is worse than no
 * doctor, because it sends somebody to fix the wrong thing.
 *
 * SPAWNED, NOT IMPORTED. doctor.mjs runs its checks at module scope and ends in
 * `process.exit()`, so importing it would end the test run. Spawning it is also the honest
 * boundary: what matters is the exit code and the lines a human reads, not internal state.
 *
 * EVERY CASE IS NETWORK-FREE AND DAEMON-FREE. Capability discovery is switched off with
 * `CMR_OLLAMA_DISCOVER_CONTEXT=0` and the window supplied by config, so these assertions hold
 * on a machine with no Ollama installed and in CI. `HOME`/`USERPROFILE` and the telemetry
 * directory point at a scratch dir, so a developer's own `~/.claude/model-router/config.json`
 * cannot change a verdict.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { providerIds } from '../plugins/model-router/lib/providers/index.mjs'
import * as geminiMod from '../plugins/model-router/lib/providers/gemini.mjs'
import * as ollamaMod from '../plugins/model-router/lib/providers/ollama.mjs'
import * as mockMod from '../plugins/model-router/lib/providers/mock.mjs'

/** Every registered provider, so the capability check below covers the whole registry. */
const PROVIDER_MODULES = { gemini: geminiMod, ollama: ollamaMod, mock: mockMod }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'plugins', 'model-router', 'scripts', 'doctor.mjs')

/** ANSI off, so an assertion matches what the script means rather than how it is coloured. */
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

function runDoctor(env = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'))
  try {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        // A minimal environment: PATH for node, and nothing inherited that could carry a real
        // key or a personal config.
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: scratch,
        USERPROFILE: scratch,
        CLAUDE_PROJECT_DIR: scratch,
        CMR_TELEMETRY_DIR: path.join(scratch, 'telemetry'),
        // Never probe a daemon from a test.
        CMR_OLLAMA_DISCOVER_CONTEXT: '0',
        ...env,
      },
    })
    return { ...res, out: strip(res.stdout ?? '') }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** The findings of one severity, as an array of lines. */
const linesOf = (out, severity) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(severity))

/* ----------------------------------------------------------------- it runs at all */

test('doctor runs to completion and reports a summary', () => {
  const r = runDoctor()
  assert.equal(typeof r.status, 'number', 'doctor did not exit cleanly')
  assert.match(r.out, /router doctor/)
  assert.match(r.out, /failure\(s\)|All checks passed|No failures/)
})

test('the exit code is 1 if and only if something FAILED', () => {
  // Warnings never affect it, which is the contract that lets a degraded install stay green.
  const r = runDoctor()
  const failed = linesOf(r.out, 'FAIL').length > 0
  assert.equal(r.status, failed ? 1 : 0, `${linesOf(r.out, 'FAIL').length} failures but exit ${r.status}`)
})

/* ---------------------------------------------------------------- healthy install */

test('a healthy local worker is all OK and exits 0', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
  })

  assert.deepEqual(linesOf(r.out, 'FAIL'), [], 'a healthy local install must not fail')
  assert.equal(r.status, 0)

  // The brief's healthy example: provider, model, context, max output, effective input.
  assert.match(r.out, /bulk-reader: ollama\/llama3:latest: context=8192/)
  assert.match(r.out, /maxOutputTokens=512/)
  assert.match(r.out, /effectiveInput=7680/)
  // 8192 - 512 = 7680, so the arithmetic on screen is the budget module's, not a retelling.

  // A local provider needs no key, and readiness must not demand one.
  assert.match(r.out, /no API key required/)
  assert.match(r.out, /provider readiness: ready/)
})

test('a configured window is labelled configured, never measured', () => {
  // The rule the whole capability model rests on, as a human reads it off the screen.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
  })
  assert.match(r.out, /\(configured\/configured\)/)
  assert.equal(/\(configured\/measured\)/.test(r.out), false, 'a configured value was shown as measured')
})

test('coherence is stated even when there is nothing wrong', () => {
  // A section that is silent when everything is fine cannot be told apart from a section that
  // forgot to check.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
  })
  assert.match(r.out, /provider\/model coherence/)
})

/* ------------------------------------------------------------------- the warnings */

test('an undiscoverable window is a WARNING, not a failure', () => {
  // A window we cannot determine leaves a DEGRADED router, not a broken one: the gate still
  // fails open to plain Claude Code. Failing here would tell the developer to stop using a
  // setup that works.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'some-model-nobody-measured:v1',
  })
  assert.match(r.out, /context capability unknown/)
  assert.deepEqual(linesOf(r.out, 'FAIL'), [])
  assert.equal(r.status, 0)
})

test('the unknown-window hint is provider-specific and does not invent a config leaf', () => {
  // Pointing a Gemini user at `providers.gemini.contextTokens`, which does not exist, or at a
  // daemon they do not run, is worse than saying nothing.
  const ollama = runDoctor({ CMR_ENABLED: 'true', CMR_WORKER_PROVIDER: 'ollama', CMR_WORKER_MODEL: 'unmeasured:v1' })
  assert.match(ollama.out, /providers\.ollama\.contextTokens/)

  const gemini = runDoctor({ CMR_ENABLED: 'true', GEMINI_API_KEY: 'AIzaTESTKEYTESTKEYTESTKEY' })
  assert.match(gemini.out, /context capability unknown/)
  assert.equal(/providers\.gemini\.contextTokens/.test(gemini.out), false, 'invented a leaf that does not exist')
})

test('an output request that would be capped is a WARNING naming the cap', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '8000',
  })
  assert.match(r.out, /will be capped to \d+/)
  assert.equal(r.status, 0, 'a cap is survivable, so it must not fail')
})

/* ------------------------------------------------------------------- the failures */

test('a provider/model mismatch FAILS and names both sides', () => {
  // THE PHASE-4 BUG: switching `worker.provider` and forgetting `worker.model`.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'gemini-3.8-flash',
  })
  const fails = linesOf(r.out, 'FAIL').join(' ')
  assert.match(fails, /provider\/model mismatch/)
  assert.match(r.out, /named like a gemini model/)
  assert.match(r.out, /provider is "ollama"/)
  assert.equal(r.status, 1)

  // Reported, never repaired: doctor must not print a corrected model as though it had applied one.
  assert.equal(/using gemini instead|switched to|substituted/i.test(r.out), false)
})

test('an output request with no safe cap FAILS', () => {
  // A window so small that even a minimal prompt cannot coexist with a useful answer.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '256',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '8192',
  })
  const fails = linesOf(r.out, 'FAIL').join(' ')
  assert.match(fails, /exceeds the 256-token context|no safe cap exists/)
  assert.equal(r.status, 1)
})

/*
 * THE KEY-SEVERITY PAIR. Phase 8 pinned a missing key as an unconditional FAIL, to stop the
 * capability section softening it. Phase 11 split it, and the two halves below are what keep that
 * original guarantee intact while fixing what it got wrong.
 *
 * What it got wrong: `worker.provider` defaults to gemini and installing requires no key, so the
 * SHIPPED STATE of every new install reported itself broken and exited 1 — while the gate fails
 * open on every branch, meaning Claude Code was working perfectly. Exiting 1 on your own defaults
 * trains everyone to ignore the tool.
 *
 * What it got right, and what the second half still pins: if somebody ASKED for gemini, a missing
 * key is a misconfiguration with a definite fix, and must stay a FAIL.
 *
 * The two cases differ in exactly one thing — whether any layer named the provider — which is the
 * same distinction the codebase already draws between a configured value and a measured one, and
 * between `null` (no limit) and `0` (a chosen limit). Written as a pair deliberately: either half
 * alone could be satisfied by a tool that ignored the question.
 */
test('an unconfigured install warns about the key it never chose, and does not fail', () => {
  const r = runDoctor({ CMR_ENABLED: 'true' }) // nobody named a provider; gemini is the default
  const warns = linesOf(r.out, 'WARN').join(' ')
  assert.match(warns, /GEMINI_API_KEY is not set/)
  assert.match(warns, /SHIPPED DEFAULT, not a choice you made/)
  assert.deepEqual(linesOf(r.out, 'FAIL'), [], 'an install nobody configured is not a broken one')
  assert.equal(r.status, 0)
  // And it names both ways forward rather than only the one that costs money.
  assert.match(r.out, /keyless local worker/)
})

test('a configured provider with no key is still a FAILURE and is not reclassified', () => {
  // Identical to the case above apart from somebody naming the provider. That alone turns "not
  // set up yet" into "asked for gemini, and gemini cannot run".
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'gemini',
    CMR_WORKER_MODEL: 'gemini-3.8-flash',
  })
  const fails = linesOf(r.out, 'FAIL').join(' ')
  assert.match(fails, /GEMINI_API_KEY is not set/)
  assert.equal(r.status, 1)
  // The softening guard phase 8 added, kept: the FAIL must not be downgraded to a warning here.
  assert.equal(/SHIPPED DEFAULT/.test(fails), false)
})

test('a key is checked against the providers the LANES resolve to, not the global one', () => {
  // THE PHASE-8 DEFECT, direction 1: a FALSE FAILURE. `worker.provider` defaults to gemini and
  // `worker.apiKeyEnv` to GEMINI_API_KEY, so overriding only the lanes to a local Ollama left
  // doctor failing on a key no lane would ever send, and exiting 1 on a perfectly healthy
  // install. MEASURED before the fix: `FAIL GEMINI_API_KEY is not set`, exit 1.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_BULK_READ_WORKER_PROVIDER: 'ollama',
    CMR_BULK_READ_WORKER_MODEL: 'llama3:latest',
    CMR_CODE_WRITE_WORKER_PROVIDER: 'ollama',
    CMR_CODE_WRITE_WORKER_MODEL: 'llama3:latest',
  })

  assert.deepEqual(linesOf(r.out, 'FAIL'), [], 'no lane runs gemini, so no gemini key is needed')
  assert.equal(r.status, 0)
  assert.match(r.out, /no API key required/)
  // And it says WHY, rather than leaving the reader to infer it from the global provider.
  assert.match(r.out, /every lane runs a local provider \(ollama\)/)
})

test('a lane that needs a key is checked even when the global provider does not', () => {
  // THE PHASE-8 DEFECT, direction 2: a FALSE PASS, and the more dangerous half. With the key
  // check keyed to `worker.provider`, a local global provider reported "no API key required"
  // and never looked, so the one lane that did need a key failed at its first delegation
  // instead of here. MEASURED before the fix: `OK no API key required`, exit 0.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_BULK_READ_WORKER_PROVIDER: 'gemini',
    CMR_BULK_READ_WORKER_MODEL: 'gemini-3.8-flash',
  })

  const fails = linesOf(r.out, 'FAIL').join(' ')
  assert.match(fails, /GEMINI_API_KEY is not set/)
  // Naming the lane is the whole point: the operator has to know WHICH worker is broken.
  assert.match(fails, /needed by bulk-reader/)
  assert.equal(r.status, 1)
  assert.equal(/no API key required/.test(r.out), false, 'a keyed lane must not report as local')
})

test('a lane running a local provider is not described as wanting a key', () => {
  // `resolveWorker()` inherits `apiKeyEnv` whenever it inherited the provider, so the resolved
  // record still names GEMINI_API_KEY for a lane running Ollama. Printing that verbatim implies
  // a key is wanted; wantsKey() is what decides whether one is.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
  })
  assert.match(r.out, /code-writer: ollama\/llama3:latest.*key=none required/)
  assert.equal(/code-writer: ollama.*key=GEMINI_API_KEY/.test(r.out), false,
    'a local lane must not advertise a key it does not use')
})

/* -------------------------------------------------------------- governance */

test('the governance section states its finding even on a default install', () => {
  // Every limit ships null, so the honest report is "nothing is configured" — not silence, and
  // certainly not a number nobody set. The old summary line printed `$5/day` from a default
  // that was enforced by nothing at all.
  const r = runDoctor({ CMR_ENABLED: 'true', CMR_WORKER_PROVIDER: 'ollama', CMR_WORKER_MODEL: 'llama3:latest' })
  assert.match(r.out, /Governance/)
  assert.match(r.out, /no budget is configured/)
  assert.match(r.out, /budget: none configured/)
  assert.equal(/budget: \$5\/day/.test(r.out), false, 'a budget nobody configured must not be advertised')
})

test('a configured token budget is reported with its scope and period', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_DAILY_MAX_TOTAL_TOKENS: '500000',
  })
  assert.match(r.out, /budget\.daily\.maxTotalTokens = 500000 tokens/)
  assert.match(r.out, /per UTC day/)
  assert.match(r.out, /budget accounting state is writable/)
  assert.deepEqual(linesOf(r.out, 'FAIL'), [], 'a healthy token budget must not fail')
})

test('a monetary budget with no rates WARNS and does not fail', () => {
  // THE STATE ANYONE WHO SETS A DOLLAR BUDGET LANDS IN, because every bundled rate is null.
  // Failing here would report a working router as broken; saying nothing would let the operator
  // believe a ceiling was being enforced when none can be.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    GEMINI_API_KEY: 'test-key-value',
    CMR_DAILY_BUDGET_USD: '5',
  })
  assert.match(r.out, /monetary budget is configured but provider pricing is unavailable/)
  assert.match(r.out, /cannot be enforced exactly/)
  assert.deepEqual(linesOf(r.out, 'FAIL'), [], 'an unenforceable budget is a warning, not a failure')
  assert.equal(r.status, 0)
})

test('a monetary budget on a local worker is not reported as a pricing problem', () => {
  // `billing: local_free` is a declared provider trait, so a dollar ceiling on Ollama can never
  // be consumed. Warning about missing rates here would be noise about a limit that does not
  // apply — and it is exactly the noise a naive "is anything priced" check would produce.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_DAILY_BUDGET_USD: '5',
  })
  assert.match(r.out, /every configured worker is local and free/)
  assert.equal(
    /monetary budget is configured but provider pricing is unavailable/.test(r.out),
    false,
    'a free worker must not be warned about rates it will never use',
  )
})

test('a negative budget is a FAILURE and names the leaf', () => {
  // Caught by the config layer, which is the single authority on leaf validation. The value
  // falls back to its default rather than being read as a zero budget — a negative limit is a
  // typo, and reading it as zero would silently disable all delegation.
  const r = runDoctor({ CMR_ENABLED: 'true', CMR_DAILY_MAX_TOTAL_TOKENS: '-5' })
  const fails = linesOf(r.out, 'FAIL').join(' ')
  assert.match(fails, /budget\.daily\.maxTotalTokens/)
  assert.match(fails, /below minimum 0/)
  assert.equal(r.status, 1)
})

test('onExceed warn is surfaced, because a budget that stops nothing is a surprise', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_DAILY_MAX_TOTAL_TOKENS: '100',
    CMR_BUDGET_ON_EXCEED: 'warn',
  })
  assert.match(r.out, /does not stop delegation/)
  assert.equal(r.status, 0, 'it is a warning, not a failure')
})

test('governance disabled is reported as disabled, not as unconfigured', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_BUDGET_ENABLED: '0',
    CMR_DAILY_MAX_TOTAL_TOKENS: '100',
  })
  assert.match(r.out, /governance is disabled/)
  assert.equal(/budget\.daily\.maxTotalTokens = 100/.test(r.out), false, 'a disabled limit is not enforced')
})

test('doctor never prints a spend figure it could not measure', () => {
  // Unknown spend is not zero spend. On a fresh install there is no ledger, so doctor reports
  // the configuration and stays silent about spend rather than printing a confident 0.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_DAILY_MAX_TOTAL_TOKENS: '100',
  })
  assert.equal(/spent today/.test(r.out), false, 'nothing has been spent, so there is nothing to report')
})

test('a key is never printed, only described', () => {
  const secret = 'AIzaSUPERSECRETVALUE1234567890'
  const r = runDoctor({ CMR_ENABLED: 'true', GEMINI_API_KEY: secret })
  assert.equal(r.out.includes(secret), false, 'doctor printed the key')
  assert.match(r.out, /GEMINI_API_KEY is set/)
  assert.match(r.out, /\d+ chars/)
})

test('a timeout the runtime will never honour is a WARNING', () => {
  // `worker.timeoutMs` accepts up to thirty minutes, but Node's HTTP client stops waiting for
  // response headers at 300s, so anything above that silently fails there instead. MEASURED: a
  // call needing ~305s came back as a `transport` error, i.e. "network failure", when it was a
  // timeout. Whoever sets a long timeout is running a slow local model and is exactly the person
  // who needs to be told the number will not be honoured.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    // Needed, or the coherence clamp FAILS for an unrelated reason: the default 8192-token
    // output request leaves no room at all inside an 8192-token window.
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
    CMR_WORKER_TIMEOUT_MS: '900000',
  })
  assert.match(r.out, /timeoutMs 900000 exceeds what the runtime will wait/)
  assert.match(r.out, /gives up at 300000ms/)
  assert.equal(r.status, 0, 'an unhonoured timeout is survivable, so it must not fail')
})

test('a timeout inside the reachable range says nothing', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
    CMR_WORKER_TIMEOUT_MS: '180000',
  })
  assert.equal(/exceeds what the runtime will wait/.test(r.out), false)
})

/* --------------------------------------------------------------- no network at all */

test('doctor asks no daemon anything when discovery is off', () => {
  // The guarantee that makes every case above safe in CI. Pointed at a dead port, a run with
  // discovery disabled must still succeed rather than stall or fail on a connection.
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_OLLAMA_BASE_URL: 'http://127.0.0.1:9',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
  })
  assert.equal(r.status, 0)
  assert.match(r.out, /context=8192/)
})

/* ------------------------------- key requirements come from the provider contract */

/**
 * THE PHASE 8 CLOSURE DEFECT. A healthy local Ollama was reported as
 * `provider readiness: NOT ready — gemini: GEMINI_API_KEY not set`.
 *
 * The cause: `worker.apiKeyEnv` still says `GEMINI_API_KEY` after someone switches
 * `worker.provider` to ollama alone, and `readinessFor()` treats a supplied name as REPLACING
 * the provider's own `requiresEnv` rather than adding to it. Dispatch already guarded this at
 * step 8; doctor did not, so the two disagreed about the same install.
 *
 * The tests below pin the PAIR, not either half alone. One absent environment variable has to
 * produce opposite verdicts for two providers, and the thing that decides is the provider's
 * declared `capabilities.requiresEnv` — never a list of provider names kept in doctor.
 */

test('ollama is ready without GEMINI_API_KEY, because ollama never asked for one', () => {
  const r = runDoctor({
    CMR_ENABLED: 'true',
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
    // Deliberately left as the shipped default, which is the whole point: the config still
    // NAMES a Gemini variable after a provider switch, and that must not make ollama unready.
    // CMR_WORKER_API_KEY_ENV is not set.
  })

  assert.match(r.out, /no API key required/)
  assert.match(r.out, /provider readiness: ready/)
  assert.equal(/readiness: NOT ready/.test(r.out), false, 'a local provider was reported unready')
  assert.equal(/GEMINI_API_KEY is not set/.test(r.out), false, 'a key ollama never wanted was demanded')
  assert.deepEqual(linesOf(r.out, 'FAIL'), [], 'a healthy local install must not fail')
  assert.equal(r.status, 0)
})

test('gemini is NOT ready without GEMINI_API_KEY, and says which variable is missing', () => {
  const r = runDoctor({ CMR_ENABLED: 'true' }) // shipped default provider is gemini

  assert.match(r.out, /GEMINI_API_KEY is not set/)
  assert.match(r.out, /provider readiness: NOT ready/)
  assert.match(r.out, /GEMINI_API_KEY not set/, 'the reason must name the variable')
  // READINESS is the claim here, and it is independent of severity: the provider is genuinely
  // not ready either way. Whether that is a WARN or a FAIL depends on whether anyone asked for
  // gemini, which the key-severity pair above covers. Nobody did here, so the router is merely
  // not set up: not ready, not broken.
  assert.match(linesOf(r.out, 'WARN').join(' '), /GEMINI_API_KEY is not set/)
  assert.equal(r.status, 0)
})

test('gemini becomes ready once the key it asked for is present', () => {
  // The control for the test above: the verdict tracks the key, not the provider.
  const r = runDoctor({ CMR_ENABLED: 'true', GEMINI_API_KEY: 'AIzaTESTKEYTESTKEYTESTKEY' })
  assert.match(r.out, /GEMINI_API_KEY is set/)
  assert.match(r.out, /provider readiness: ready/)
  assert.equal(/readiness: NOT ready/.test(r.out), false)
})

test('one absent variable, two providers, opposite verdicts', () => {
  // The paired property stated directly. Identical environment apart from the provider — and
  // BOTH arms name their provider explicitly, so the only variable is which one. Leaving the
  // gemini arm unconfigured would make this a test about the key-severity split instead, and the
  // contrast it is trying to draw is about the provider's own requirement.
  const shared = { CMR_ENABLED: 'true' }
  const ollama = runDoctor({
    ...shared,
    CMR_WORKER_PROVIDER: 'ollama',
    CMR_WORKER_MODEL: 'llama3:latest',
    CMR_OLLAMA_CONTEXT_TOKENS: '8192',
    CMR_WORKER_MAX_OUTPUT_TOKENS: '512',
  })
  const gemini = runDoctor({
    ...shared,
    CMR_WORKER_PROVIDER: 'gemini',
    CMR_WORKER_MODEL: 'gemini-3.8-flash',
  })

  assert.match(ollama.out, /provider readiness: ready/)
  assert.match(gemini.out, /provider readiness: NOT ready/)
  assert.equal(ollama.status, 0)
  assert.equal(gemini.status, 1)
})

test('the requirement is read from each provider capability, not from a list of names', () => {
  // THE ANTI-ALLOWLIST GUARD, and the reason it is written over every registered provider rather
  // than over the two that motivated the bug: an allowlist that happened to agree about ollama
  // and gemini would still pass a two-provider test, and would be wrong for the next provider
  // somebody adds. Here doctor's own verdict is checked against what the provider module
  // declares, for every provider in the registry.
  for (const id of providerIds()) {
    const mod = PROVIDER_MODULES[id]
    assert.ok(mod, `${id} is registered but not loaded by this test`)
    const wantsKey = mod.capabilities.requiresEnv.length > 0

    const r = runDoctor({
      CMR_ENABLED: 'true',
      CMR_WORKER_PROVIDER: id,
      CMR_WORKER_MODEL: 'some-model',
      // No key variables of any kind are provided, for any provider.
    })

    if (wantsKey) {
      assert.match(r.out, /is not set/, `${id} declares requiresEnv but doctor asked for no key`)
      assert.match(r.out, /readiness: NOT ready/, `${id} needs a key but was reported ready`)
    } else {
      assert.match(r.out, /no API key required/, `${id} needs no key but doctor demanded one`)
      assert.match(r.out, /readiness: ready/, `${id} needs no key but was reported unready`)
    }
  }
})

test('pricing: an override that prices the models in use passes, and the bundled nulls behind it are not counted', () => {
  // Found 2026-10-05: with gemini-3.8-flash and the primary model priced in an override file,
  // doctor still warned "9 model(s) have no rates" and listed gemini-3.8-flash among them,
  // because it counted the bundled null rows that the override shadows and resolveRates() never
  // consults.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-doctor-pricing-'))
  try {
    const file = path.join(dir, 'pricing.json')
    const priced = (i, o) => ({ inputPerMTok: i, cachedInputPerMTok: null, outputPerMTok: o, verify: 't', verifiedAt: '2026-10-05' })
    fs.writeFileSync(
      file,
      JSON.stringify({
        pricingVersion: 't.1',
        unit: 'per_mtok',
        currency: 'USD',
        models: { 'gemini:gemini-3.8-flash': priced(0.75, 3.75), 'anthropic:claude-opus-5-5': priced(4, 20) },
      }),
    )
    const r = runDoctor({
      CMR_ENABLED: 'true',
      GEMINI_API_KEY: 'test-key-value',
      CMR_PRICING_OVERRIDES: file,
      CMR_PRIMARY_MODEL: 'claude-opus-5-5',
    })
    assert.match(r.out, /every model this install uses has rates/)
    assert.doesNotMatch(r.out, /model\(s\) (this install uses )?have no rates/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pricing: the paste-ready skeleton carries no rate and no verification date', () => {
  // It once carried 0.30 / 0.075 / 2.50 — a retired model's rates, well under half of
  // gemini-3.8-flash's — and stamped today's date as verifiedAt. Pasted as-is, that is a confident
  // wrong dollar figure that claims to have been checked.
  const r = runDoctor({ CMR_ENABLED: 'true', GEMINI_API_KEY: 'test-key-value' })
  assert.match(r.out, /1 model\(s\) this install uses have no rates/)
  assert.match(r.out, /"gemini:gemini-3\.8-flash"/)
  assert.match(r.out, /"inputPerMTok": null, "cachedInputPerMTok": null, "outputPerMTok": null/)
  assert.match(r.out, /"verifiedAt": null/)
  assert.doesNotMatch(r.out, /PerMTok": \d/)
})
