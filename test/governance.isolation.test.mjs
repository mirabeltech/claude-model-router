/**
 * Architectural rules for `lib/governance/`, enforced statically.
 *
 * These are the claims `docs/governance.md` makes about layering, and prose cannot enforce a
 * layering rule. Each one is checked by reading the source rather than by calling it, because
 * the failures being prevented are of the form "someone adds an import" — which no behavioural
 * test would notice until it had already cost a provider load on the hot path.
 *
 * THE DIRECTORY CENSUS IS THE MOST IMPORTANT TEST IN THIS FILE. A scan over a stale list of
 * files passes by scanning nothing, so a new module dropped into `lib/governance/` must be
 * classified deliberately rather than inheriting silence.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugins', 'model-router', 'lib')
const GOV_DIR = path.join(LIB, 'governance')

/** Source with comments removed, so a MENTION of something is never counted as a USE of it. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** Every import specifier, including the dynamic and require forms. */
function importsOf(source) {
  const specs = []
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*from\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  return specs
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8')
const govSource = (file) => stripComments(read(GOV_DIR, file))

/**
 * The governance layer, file by file, with what each is ALLOWED to import.
 *
 * Exact specifiers rather than basenames: `index.mjs` and `contract.mjs` exist in three
 * different directories in this repo, so a basename check would silently permit the wrong one.
 */
const GOVERNANCE_LAYER = Object.freeze({
  // Pure. The whole point: a budget decision cheap enough to sit on the hot path.
  'policy.mjs': Object.freeze([]),
  // The only impure file. Hot-path I/O, so the builtin list is as short as facts.mjs's.
  'ledger.mjs': Object.freeze(['node:fs', 'node:path', './policy.mjs']),
  // Composition only. It owns the order of operations and nothing else.
  'index.mjs': Object.freeze(['node:fs', './policy.mjs', './ledger.mjs']),
})

/* ------------------------------------------------------------------- census */

test('the governance layer holds exactly the files these rules cover', () => {
  // A new file added to the directory must be classified deliberately. Without this, every
  // other test in the file could pass while scanning nothing at all.
  const onDisk = fs
    .readdirSync(GOV_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
  assert.deepEqual(onDisk, Object.keys(GOVERNANCE_LAYER).sort())
})

test('every governance file imports only what it is allowed to', () => {
  const violations = []
  for (const [file, allowed] of Object.entries(GOVERNANCE_LAYER)) {
    for (const spec of importsOf(govSource(file))) {
      if (!allowed.includes(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'an unapproved import in the governance layer')
})

/* --------------------------------------------------- governance reaches out */

test('governance never imports a provider', () => {
  // Invariant 9. Governance needs exactly one fact about a provider — whether a monetary budget
  // can be consumed by it — and receives it as the string `billing`. Importing a provider would
  // put a dynamic import, and potentially a socket, behind every budget decision.
  const violations = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    for (const spec of importsOf(govSource(file))) {
      if (/provider/i.test(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'governance must not import a provider')
})

test('governance performs no network I/O', () => {
  // Invariant 10. Checked as an absence of the mechanisms rather than of the behaviour, because
  // a budget decision that could block on a socket would be a budget decision that could hang
  // a session.
  const violations = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    const src = govSource(file)
    for (const banned of ['fetch(', 'XMLHttpRequest', 'node:http', 'node:https', 'node:net', 'node:tls', 'WebSocket']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'governance must not reach the network')
})

test('governance spawns nothing and evaluates nothing', () => {
  const violations = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    const src = govSource(file)
    for (const banned of ['child_process', 'spawn(', 'exec(', 'execSync', 'eval(', 'new Function']) {
      if (src.includes(banned)) violations.push(`${file} contains ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'governance must not spawn or evaluate')
})

test('governance imports neither the routing nor the dispatch layer', () => {
  // It must be usable without them, and must not be able to re-ask a question they own.
  const violations = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    for (const spec of importsOf(govSource(file))) {
      if (/routing|dispatch|\bhook\b/.test(spec)) violations.push(`${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'governance must not import routing, dispatch or the hook layer')
})

test('governance reads no secret, no prompt and no file content', () => {
  // The security boundary. Governance operates on already-derived facts: a token count, a
  // billing model, a configured limit. It has no business touching a key, a transcript or the
  // contents of the file being delegated.
  const violations = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    const src = govSource(file)
    for (const banned of ['apiKeyEnv', 'API_KEY', 'transcript', 'prompt', 'questionText', 'redactSecrets']) {
      if (src.includes(banned)) violations.push(`${file} mentions ${banned}`)
    }
  }
  assert.deepEqual(violations, [], 'governance must not touch secrets, prompts or content')
})

test('governance reads no CMR_ environment variable directly', () => {
  // Config access goes through `loadConfig()`. A direct env read would be a setting that exists
  // outside the SPEC, and therefore outside the layering the config tests enforce.
  const violations = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    const src = govSource(file)
    if (/CMR_/.test(src)) violations.push(`${file} names a CMR_ variable`)
    if (/process\.env/.test(src)) violations.push(`${file} reads process.env`)
  }
  assert.deepEqual(violations, [], 'governance must take its settings from config alone')
})

/* -------------------------------------------- the routing layer stays clean */

test('the routing layer never reads budget state', () => {
  // Invariant 8, and the load-bearing half of the whole design. `decide()` answers "would this
  // be appropriate to delegate" from the facts of one tool call. If it could read a ledger it
  // would no longer be a pure function of its input, and a budget would be able to rewrite a
  // routing classification.
  const violations = []
  for (const file of ['routing.mjs', 'routing-policy.mjs']) {
    const src = stripComments(read(LIB, file))
    for (const spec of importsOf(src)) {
      if (/governance|ledger/.test(spec)) violations.push(`${file} imports ${spec}`)
    }
    // Not just the import: the routing layer must not name a budget leaf either, which is how
    // it would read a limit out of the config object it is already handed.
    for (const leaf of ['maxWorkerCostUsd', 'maxTotalTokens', 'onExceed', 'stateDir', 'budget.']) {
      if (src.includes(leaf)) violations.push(`${file} names ${leaf}`)
    }
  }
  assert.deepEqual(violations, [], 'routing must not read budget state')
})

test('readPolicy does not copy a budget leaf into the routing snapshot', () => {
  // The specific smuggling route: `readPolicy()` is the one place that reads the shape of
  // config, so a budget leaf copied into the policy snapshot would reach the rule table without
  // routing ever importing anything.
  const src = stripComments(read(LIB, 'routing-policy.mjs'))
  assert.equal(/config\.budget/.test(src), false, 'readPolicy must not reach config.budget')
})

test('the dispatch layer does not import governance', () => {
  // Dispatch answers "can this worker safely execute this request" and must not also decide
  // whether it is allowed to. Keeping governance out also keeps `lib/dispatch/*` free of the
  // `node:` imports the ledger needs, which a static test in telemetry.isolation already pins.
  const violations = []
  for (const file of fs.readdirSync(path.join(LIB, 'dispatch')).filter((f) => f.endsWith('.mjs'))) {
    const src = stripComments(read(LIB, 'dispatch', file))
    for (const spec of importsOf(src)) {
      if (/governance|ledger/.test(spec)) violations.push(`dispatch/${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'dispatch must not import governance')
})

test('the telemetry layer does not import governance', () => {
  // Telemetry records a decision that was already made. If it could compute one, the row and
  // the enforcement could disagree about the same call.
  const violations = []
  for (const file of fs.readdirSync(path.join(LIB, 'telemetry')).filter((f) => f.endsWith('.mjs'))) {
    const src = stripComments(read(LIB, 'telemetry', file))
    for (const spec of importsOf(src)) {
      if (/governance|ledger/.test(spec)) violations.push(`telemetry/${file} imports ${spec}`)
    }
  }
  assert.deepEqual(violations, [], 'telemetry must not import governance')
})

test('governance is reached only from the hook orchestrator and the scripts', () => {
  // One entry point on the hot path. If a second layer started calling `checkBudget()` the
  // ordering guarantee — routing, then governance, then capability — would stop being a
  // property of one file and become a convention nobody checks.
  const callers = []
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'governance') walk(next, path.join(rel, entry.name))
        continue
      }
      if (!entry.name.endsWith('.mjs')) continue
      const src = stripComments(fs.readFileSync(next, 'utf8'))
      if (importsOf(src).some((spec) => /governance/.test(spec))) {
        callers.push(path.join(rel, entry.name).split(path.sep).join('/'))
      }
    }
  }
  walk(LIB)
  assert.deepEqual(callers.sort(), ['hook/run.mjs'], 'governance gained an unexpected caller')
})

/* ------------------------------------------------------------ the zero rule */

test('the governance layer never defaults an unknown measurement to zero', () => {
  // The project-wide rule, stated here as a source check because it is the one mistake that
  // would make every number in this layer wrong in the same direction. `?? 0` on a measurement
  // turns "we could not tell" into "nothing was spent", which hands out the whole budget.
  //
  // `count()` in ledger.mjs is the ONE sanctioned coercion, and it is applied to values being
  // written INTO a period total where a non-number means "contributed nothing", never to a
  // limit or to a comparison. Everything else must stay null.
  const offenders = []
  for (const file of Object.keys(GOVERNANCE_LAYER)) {
    const src = govSource(file)
    for (const line of src.split('\n')) {
      if (/\?\?\s*0\b/.test(line) || /\|\|\s*0\b/.test(line)) {
        // The reservation request is allowed to default to zero: a delegation whose size we
        // cannot estimate reserves nothing, which is the conservative direction for a claim.
        if (line.includes('totalTokens ?? 0') || line.includes('tokens ?? 0')) continue
        offenders.push(`${file}: ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'an unknown measurement must stay null, never become 0')
})

test('the policy module computes no money and prices nothing', () => {
  // There is one pricing implementation in this repo and it lives in the telemetry layer. A
  // second one here would be a second thing to keep in step with the pricing table, and the
  // first time they disagreed the budget and the savings report would tell two different
  // stories about the same call.
  const src = govSource('policy.mjs')
  for (const banned of ['1e6', '1_000_000', 'perMTok', 'resolveRates', 'calculateCost', '/ 4']) {
    assert.equal(src.includes(banned), false, `policy.mjs must not price: found ${banned}`)
  }
})
