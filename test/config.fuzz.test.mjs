/**
 * HOSTILE CONFIGURATION, EVERY LEAF, EVERY SHAPE ITS KIND CANNOT HOLD.
 *
 * The resolver's contract is one sentence: a bad value falls back to its DEFAULT and a warning says
 * so. `config.layering.test.mjs` proves the precedence order and `config.schema.test.mjs` proves
 * the generated schema matches SPEC. Neither attacks it — nothing in the suite fed every leaf a
 * value of the wrong type and checked what came out.
 *
 * THE LOAD-BEARING INVARIANT, and why this is not merely a type-checking exercise:
 *
 *     AN INVALID VALUE NEVER SILENTLY BECOMES A DIFFERENT *VALID* CONFIGURATION.
 *
 * Falling back to the default is safe. Falling back to anything else is not, and the difference is
 * invisible without a test. `minBytes: "12000"` coerced to `12000` is convenient and wrong, because
 * the next person writes `minBytes: "twelve thousand"` and gets `NaN`, or `0` — and `0` means
 * delegate everything. A threshold that quietly becomes zero is the configuration bug that sends a
 * developer's credentials to a worker, so the last test here asserts CONSEQUENCES rather than types.
 *
 * Seeded rather than random, in the shape `routing.determinism.test.mjs` established: a failure has
 * to be replayable from its own output, and a fuzz that cannot be replayed is a flake generator.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, SPEC, resolveConfig } from '../plugins/model-router/lib/config.mjs'
import { decide } from '../plugins/model-router/lib/routing.mjs'
import { bulkReadInput } from './helpers/routing-input.mjs'

/** Deterministic, and the seed is in every failure message so a failure replays. */
const SEED = 20261004
function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
const setPath = (obj, dotted, value) => {
  const parts = dotted.split('.')
  let node = obj
  for (const key of parts.slice(0, -1)) {
    node[key] ??= {}
    node = node[key]
  }
  node[parts.at(-1)] = value
  return obj
}

const LEAVES = Object.keys(SPEC)
const resolved = (data, env = {}) => resolveConfig({ layers: [{ name: 'fuzz', data }], env })

/**
 * Invalid values BY KIND, because "hostile" is not a property a value has on its own.
 *
 * The first draft of this file used one list for every leaf and was wrong in an instructive way:
 * `'() => true'` is a perfectly valid non-empty string, and so is `'__proto__'`, and so is a
 * ten-thousand-character string. The resolver has no business rejecting an arbitrary
 * `worker.provider` — an unknown provider is caught later, at resolution, and reported as
 * `worker_not_ready`, which is the fail-open design working as designed. A test that demanded
 * otherwise would have been asserting a stricter contract than the product promises, or should.
 *
 * So each kind gets the values that genuinely cannot be coerced to it.
 */
const INVALID_BY_KIND = Object.freeze({
  bool: [
    ['a yes/no string', 'yes'],
    ['the string "true"', 'true'],
    ['a number', 1],
    ['an object', { a: 1 }],
    ['an array', [true]],
  ],
  int: [
    ['a word', 'twelve thousand'],
    ['a numeric string, in a FILE', '12000'],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['an object', { a: 1 }],
    ['an array', [1]],
  ],
  number: [
    ['a word', 'warm'],
    ['NaN', Number.NaN],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a boolean', false],
    ['an object', { a: 1 }],
    ['an array', [0.5]],
  ],
  string: [
    ['a number', 42],
    ['a boolean', true],
    ['an object', { a: 1 }],
    ['an array', ['a']],
  ],
  enum: [
    ['a value outside the set', 'definitely-not-a-member'],
    ['a number', 1],
    ['an object', { a: 1 }],
    ['an array', ['deny']],
  ],
  'string[]': [
    ['a bare string', 'just-one'],
    ['a number', 42],
    ['an object', { glob: '**/.env' }],
    ['an array of numbers', [1, 2, 3]],
    ['an array of objects', [{ glob: 'x' }]],
  ],
})

test('the kind table covers every kind SPEC actually uses', () => {
  // Anti-vacuity. A new SPEC kind would otherwise be fuzzed by an undefined list and skipped,
  // which is exactly how a fuzz test comes to cover less than it says it does.
  const used = [...new Set(Object.values(SPEC).map((s) => s.type))].sort()
  assert.deepEqual(used, Object.keys(INVALID_BY_KIND).sort())
})

/* ----------------------------------------------------------- the stable baseline */

test('with no layers and no environment, the result is exactly DEFAULTS and silent', () => {
  // The anchor for every comparison below. If this drifts, every "fell back to the default"
  // assertion in this file is comparing against the wrong thing.
  const r = resolveConfig()
  assert.deepEqual(r.warnings, [], 'a default install warns about nothing')
  for (const leaf of LEAVES) {
    assert.deepEqual(getPath(r.config, leaf), getPath(DEFAULTS, leaf), leaf)
  }
})

test('resolving twice from identical input gives identical output', () => {
  const data = { routing: { bulkRead: { minBytes: 5000 } } }
  const a = resolveConfig({ layers: [{ name: 'x', data: structuredClone(data) }] })
  const b = resolveConfig({ layers: [{ name: 'x', data: structuredClone(data) }] })
  assert.deepEqual(a.config, b.config)
  assert.deepEqual(a.warnings, b.warnings)
})

/* -------------------------------------------- every leaf against every invalid value */

test('every leaf rejects every value invalid for its kind, falls back, and says so', () => {
  // All 77 leaves crossed with every value that cannot be coerced to their kind. The assertion is
  // two-part deliberately: the leaf became THE DEFAULT, and a warning NAMES THE FIELD. A silent
  // fallback is half a bug, because the operator reads the file afterwards and believes it.
  const failures = []
  let checked = 0
  for (const leaf of LEAVES) {
    const dflt = getPath(DEFAULTS, leaf)
    for (const [label, value] of INVALID_BY_KIND[SPEC[leaf].type]) {
      checked += 1
      const r = resolved(setPath({}, leaf, value))
      const got = getPath(r.config, leaf)

      if (JSON.stringify(got) !== JSON.stringify(dflt)) {
        failures.push(
          `${leaf} (${SPEC[leaf].type}) <- ${label}: became ${JSON.stringify(got)}, ` +
            `not the default ${JSON.stringify(dflt)}`,
        )
        continue
      }
      if (!r.warnings.some((w) => w.field === leaf)) {
        failures.push(`${leaf} <- ${label}: fell back SILENTLY, with no warning naming the field`)
      }
    }
  }
  assert.deepEqual(failures, [])
  assert.ok(checked > 300, `only ${checked} combinations were checked; the sweep is not running`)
})

test('an invalid value for one leaf changes no other leaf', () => {
  // THE CONTAINMENT PROPERTY. Without it, "it fell back to the default" is not reassuring at all:
  // a resolver that reset the whole object on one bad field would pass the test above while
  // silently discarding an operator's entire configuration.
  const rand = lcg(SEED)
  const failures = []
  const witness = 'routing.bulkRead.minBytes'
  const witnessValue = 7777

  for (let i = 0; i < 300; i++) {
    const leaf = LEAVES[Math.floor(rand() * LEAVES.length)]
    const bad = INVALID_BY_KIND[SPEC[leaf].type]
    const [label, value] = bad[Math.floor(rand() * bad.length)]

    const data = setPath(setPath({}, witness, witnessValue), leaf, value)
    const r = resolved(data)
    const expected = leaf === witness ? getPath(DEFAULTS, witness) : witnessValue
    if (getPath(r.config, witness) !== expected) {
      failures.push(`seed ${SEED} iter ${i}: ${leaf} <- ${label} collaterally changed ${witness}`)
    }
  }
  assert.deepEqual(failures, [])
})

/* ------------------------------------------------ the coercions that must NOT happen */

test('a numeric string is never silently coerced in a config FILE', () => {
  // The convenient wrong behaviour, named. In JSON a number is a number, so a string is a mistake
  // and must be reported rather than guessed at — otherwise "twelve thousand" is the next thing
  // somebody writes and a threshold becomes NaN, or 0, which delegates everything.
  //
  // Deliberately NOT the rule for the environment, where every value is a string by construction
  // and coercion is the only contract available. That asymmetry is the point of the second half.
  for (const leaf of ['routing.bulkRead.minBytes', 'worker.timeoutMs', 'worker.maxRetries']) {
    const r = resolved(setPath({}, leaf, '12000'))
    assert.equal(getPath(r.config, leaf), getPath(DEFAULTS, leaf), `${leaf} must not accept a string`)
    assert.ok(r.warnings.some((w) => w.field === leaf), `${leaf} must warn`)
  }

  const viaEnv = resolveConfig({ env: { CMR_MIN_BYTES: '12000' } })
  assert.equal(viaEnv.config.routing.bulkRead.minBytes, 12000, 'from the environment it IS a number')
  assert.deepEqual(viaEnv.warnings, [])
})

test('an out-of-range number falls back rather than being clamped into range', () => {
  // Clamping is the other tempting shortcut and it is worse than rejecting: an operator who asked
  // for a 1 ms timeout and silently got 1000 has a configuration nobody wrote, and the number
  // they read in their own file is not the number in force.
  for (const [leaf, value] of [
    ['worker.timeoutMs', 1],
    ['worker.timeoutMs', 99_999_999],
    ['worker.maxRetries', 99],
    ['worker.temperature', 7],
    ['worker.maxInputBytes', 1],
  ]) {
    const r = resolved(setPath({}, leaf, value))
    assert.equal(
      getPath(r.config, leaf),
      getPath(DEFAULTS, leaf),
      `${leaf}=${value} must fall back, not clamp`,
    )
    assert.ok(r.warnings.some((w) => w.field === leaf), `${leaf}=${value} must warn`)
  }
})

test('an unknown enum value falls back; an enum is CLOSED on a setting', () => {
  // Enums are open on READ by convention — an unknown value buckets as `other` rather than being
  // rejected. A SETTING is the opposite: an unrecognised enforce mode cannot be honoured, so
  // guessing at one would be inventing policy on the operator's behalf.
  const r = resolved({ routing: { bulkRead: { enforce: 'maybe' } } })
  assert.equal(r.config.routing.bulkRead.enforce, DEFAULTS.routing.bulkRead.enforce)
  assert.ok(r.warnings.some((w) => w.field === 'routing.bulkRead.enforce'))
})

/* -------------------------------------------------------------- malformed containers */

test('a layer that is not an object is reported and ignored, not merged', () => {
  for (const data of ['a string', 42, true, ['an', 'array']]) {
    const r = resolveConfig({ layers: [{ name: 'bad', data }] })
    assert.deepEqual(r.config, resolveConfig().config, `${JSON.stringify(data)} must change nothing`)
    assert.ok(
      r.warnings.some((w) => w.field === '<root>'),
      `${JSON.stringify(data)} must warn at the root`,
    )
  }
})

test('a null or absent layer is skipped silently, because that is not an error', () => {
  // `readJsonLayer` returns null for a file that does not exist, which is the overwhelmingly
  // common case. Warning about it would make every default install noisy for no reason.
  const r = resolveConfig({ layers: [{ name: 'missing', data: null }, { name: 'also', data: undefined }] })
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.config, resolveConfig().config)
})

test('an unknown field is surfaced rather than swallowed', () => {
  // The most common real misconfiguration is a typo in a field name, and silence makes it
  // invisible: the operator sees no error and no effect, and concludes the setting does nothing.
  const r = resolved({ routing: { bulkRead: { minBytez: 1 } } })
  assert.ok(
    r.warnings.some((w) => w.field.includes('minBytez') && /unknown/i.test(w.reason)),
    `expected an unknown-field warning, got ${JSON.stringify(r.warnings)}`,
  )
})

test('a prototype-polluting payload cannot reach Object.prototype', () => {
  // Config comes off disk, which on a shared machine is not entirely trusted input.
  const before = Object.prototype.polluted
  resolveConfig({
    layers: [{ name: 'evil', data: JSON.parse('{"__proto__": {"polluted": true}}') }],
  })
  assert.equal(Object.prototype.polluted, before, 'Object.prototype was modified')
  assert.equal({}.polluted, undefined)
})

/* ------------------------------------- the safety property, not the type property */

test('NO MALFORMED CONFIG MAKES THE GATE DELEGATE SOMETHING IT OTHERWISE REFUSES', () => {
  // The assertion this file exists for. Everything above is about types; this is about
  // consequences. A threshold that became 0, an enforce mode that became permissive, a deny list
  // that became empty — any of those turns a config typo into an exfiltration path, and none of
  // them is visible from a type check.
  //
  // The probes are what the router must refuse whatever the configuration says, drawn from the
  // same refusal list routing.exclusions.test.mjs covers for one baseline input.
  const rand = lcg(SEED + 1)
  const PROBES = [
    ['a credential file', bulkReadInput({ paths: ['/proj/.env'], inputBytes: 500_000 })],
    ['a private key', bulkReadInput({ paths: ['/proj/deploy/id_rsa'], inputBytes: 500_000 })],
    ['a secrets module', bulkReadInput({ paths: ['/proj/src/secrets.ts'], inputBytes: 500_000 })],
    ['a targeted read', bulkReadInput({ targetedRead: true, inputBytes: 500_000 })],
    ['a recently edited file', bulkReadInput({ recentlyEdited: true, inputBytes: 500_000 })],
    [
      'no worker available',
      bulkReadInput({
        workerAvailable: false,
        workerUnavailableReason: 'worker_not_ready',
        inputBytes: 500_000,
      }),
    ],
  ]

  const failures = []
  for (let i = 0; i < 400; i++) {
    const leaf = LEAVES[Math.floor(rand() * LEAVES.length)]
    const bad = INVALID_BY_KIND[SPEC[leaf].type]
    const [label, value] = bad[Math.floor(rand() * bad.length)]
    const { config } = resolved(setPath({}, leaf, value))

    for (const [probeLabel, input] of PROBES) {
      const d = decide(input, config)
      if (d.delegate !== false || d.decision !== 'allow') {
        failures.push(
          `seed ${SEED + 1} iter ${i}: ${leaf} <- ${label} made the gate delegate ${probeLabel} ` +
            `(decision=${d.decision} delegate=${d.delegate} reason=${d.reason})`,
        )
      }
    }
  }
  assert.deepEqual(failures, [])
})

test('a deny list of the wrong type falls back to the shipped globs, not to nothing', () => {
  // The single most dangerous fallback the resolver could choose. An empty deny list is a VALID
  // setting an operator may legitimately want; a MALFORMED one must not be mistaken for it.
  for (const bad of ['**/.env', 42, { glob: '**/.env' }, [1, 2, 3], true]) {
    const r = resolved({ routing: { denyGlobs: bad } })
    assert.deepEqual(
      r.config.routing.denyGlobs,
      DEFAULTS.routing.denyGlobs,
      `denyGlobs=${JSON.stringify(bad)} must fall back to the shipped list`,
    )
    assert.equal(
      decide(bulkReadInput({ paths: ['/proj/.env'], inputBytes: 500_000 }), r.config).delegate,
      false,
      `denyGlobs=${JSON.stringify(bad)} must not disable path refusal`,
    )
  }
})

test('an explicitly emptied deny list is honoured, and the rest of the gate still holds', () => {
  // An operator who empties the list has made a choice, and the router respects it rather than
  // overriding them. What must not happen is the rest of the refusal ladder going with it.
  const emptied = resolved({ routing: { denyGlobs: [] } })
  assert.deepEqual(emptied.config.routing.denyGlobs, [], 'an empty list is a legitimate setting')
  assert.deepEqual(emptied.warnings, [], 'and not a mistake worth warning about')

  for (const probe of [
    ['a targeted read', bulkReadInput({ targetedRead: true, inputBytes: 500_000 })],
    ['a recently edited file', bulkReadInput({ recentlyEdited: true, inputBytes: 500_000 })],
  ]) {
    assert.equal(decide(probe[1], emptied.config).delegate, false, probe[0])
  }
})

/* --------------------------------------------------------------------- secrets */

test('no setting can hold a credential, so a config file cannot leak one', () => {
  // Structural rather than behavioural, and the strongest form of the claim: a key cannot appear
  // in a committed config because THERE IS NO FIELD FOR ONE. `apiKeyEnv` names a variable; it
  // never holds a value.
  //
  // The pattern deliberately excludes `Tokens`: a first draft matched /token/i and flagged
  // maxOutputTokens plus five budget leaves, which is the sort of false positive that gets a
  // security test weakened instead of fixed.
  const suspicious = LEAVES.filter((leaf) => /secret|password|credential|apikey/i.test(leaf))
  assert.ok(suspicious.length >= 1, 'the pattern must still match the apiKeyEnv leaves')
  for (const leaf of suspicious) {
    assert.ok(
      leaf.endsWith('apiKeyEnv'),
      `${leaf} is named as though it holds a credential; only *.apiKeyEnv may, and it holds a NAME`,
    )
  }
})

test('a rejected value is never echoed back in a warning', () => {
  // FOUND BY THIS FILE, AND FIXED. `coerceLeaf` had one branch that quoted the offending value:
  // `expected int, got "AIza..."`. Warnings are printed by `doctor` and land in whatever a
  // developer pastes into a bug report, and since no field holds a credential, a key in a config
  // file is always a mistake — so it was exactly the value most likely to be mistyped there.
  //
  // Every other branch in that function reports a type or a constraint, so reporting the type is
  // both safer and more consistent. The field name is already on the warning, which is what makes
  // the message actionable without the value.
  // A DISTINCTIVE MARKER, NOT A REAL-SHAPED KEY. The first draft used `AIza` plus 35 characters
  // and was correctly caught by secrets.hygiene.test.mjs's repository-wide scan — which is the
  // scan working, so the fix is not to claim an exemption. The property under test is "the value
  // is not echoed", and any string nothing else contains proves that. Real-shaped keys are
  // exercised where they belong: secrets.hygiene already drives every command with one set.
  const canary = 'CANARY-config-value-must-not-be-echoed-7f3a'
  for (const leaf of ['worker.timeoutMs', 'worker.temperature', 'routing.bulkRead.minBytes']) {
    const r = resolved(setPath({}, leaf, canary))
    const text = JSON.stringify(r.warnings)
    assert.equal(text.includes(canary), false, `${leaf} echoed the rejected value`)
    assert.ok(r.warnings.some((w) => w.field === leaf), `${leaf} must still be named`)
    assert.ok(
      r.warnings.some((w) => /expected (int|number)/.test(w.reason)),
      `${leaf} must still say what it expected`,
    )
  }
})

test('a rejected value of any shape is described by kind, never quoted', () => {
  // The general form, so the fix cannot regress through a different code path.
  const shapes = [
    ['a string', 'sensitive-looking-text'],
    ['an object', { password: 'hunter2' }],
    ['an array', ['hunter2']],
    ['a boolean', true],
  ]
  for (const [label, value] of shapes) {
    const r = resolved({ worker: { timeoutMs: value } })
    const text = JSON.stringify(r.warnings)
    assert.equal(text.includes('hunter2'), false, `${label} leaked a nested value`)
    assert.equal(text.includes('sensitive-looking-text'), false, `${label} leaked a string value`)
  }
})
