import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULTS,
  SPEC,
  CONFIG_VERSION,
  resolveConfig,
  coerceLeaf,
  stripJsonComments,
  expandHome,
  routingEnabled,
} from '../plugins/model-router/lib/config.mjs'

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o)

/* -------------------------------------------------------------- precedence */

test('defaults resolve cleanly with no layers and no env', () => {
  const { config, warnings } = resolveConfig()
  assert.equal(warnings.length, 0, `unexpected warnings: ${JSON.stringify(warnings)}`)
  assert.equal(config.version, CONFIG_VERSION)
  assert.equal(config.enabled, true)
  assert.equal(config.worker.provider, 'gemini')
  assert.equal(config.routing.bulkRead.minLines, 350)
  assert.equal(config.telemetry.residencyTurns, 0)
  assert.equal(config.telemetry.countProvenFilesOnly, true)
})

test('project layer beats user layer', () => {
  const { config, sources } = resolveConfig({
    layers: [
      { name: 'user', data: { routing: { bulkRead: { minLines: 500 } } } },
      { name: 'project', data: { routing: { bulkRead: { minLines: 200 } } } },
    ],
  })
  assert.equal(config.routing.bulkRead.minLines, 200)
  assert.equal(sources['routing.bulkRead.minLines'], 'project')
})

test('env beats both file layers — CI and kill switches must win', () => {
  const { config, sources } = resolveConfig({
    layers: [
      { name: 'user', data: { worker: { provider: 'openai' } } },
      { name: 'project', data: { worker: { provider: 'groq' } } },
    ],
    env: { CMR_WORKER_PROVIDER: 'ollama' },
  })
  assert.equal(config.worker.provider, 'ollama')
  assert.equal(sources['worker.provider'], 'env:CMR_WORKER_PROVIDER')
})

test('CMR_ENABLED=0 is an effective kill switch', () => {
  const { config } = resolveConfig({
    layers: [{ name: 'project', data: { enabled: true } }],
    env: { CMR_ENABLED: '0' },
  })
  assert.equal(config.enabled, false)
  assert.equal(routingEnabled(config), false)
})

test('plugin userConfig options are applied', () => {
  const { config, sources } = resolveConfig({
    env: { CLAUDE_PLUGIN_OPTION_WORKER_MODEL: 'gemini-3.1-pro-preview' },
  })
  assert.equal(config.worker.model, 'gemini-3.1-pro-preview')
  assert.equal(sources['worker.model'], 'pluginOption:CLAUDE_PLUGIN_OPTION_WORKER_MODEL')
})

test('deep merge preserves sibling keys from lower layers', () => {
  const { config } = resolveConfig({
    layers: [{ name: 'project', data: { worker: { model: 'custom-model' } } }],
  })
  assert.equal(config.worker.model, 'custom-model')
  // untouched siblings must survive the merge
  assert.equal(config.worker.provider, DEFAULTS.worker.provider)
  assert.equal(config.worker.timeoutMs, DEFAULTS.worker.timeoutMs)
})

test('arrays replace wholesale rather than merging by index', () => {
  const { config } = resolveConfig({
    layers: [{ name: 'project', data: { routing: { denyGlobs: ['**/only-this/**'] } } }],
  })
  assert.deepEqual(config.routing.denyGlobs, ['**/only-this/**'])
})

/* ------------------------------------------------------------- fail open */

test('a bad field value falls back to its default and warns', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { routing: { bulkRead: { minLines: 'three hundred' } } } }],
  })
  assert.equal(config.routing.bulkRead.minLines, DEFAULTS.routing.bulkRead.minLines)
  const w = warnings.find((x) => x.field === 'routing.bulkRead.minLines')
  assert.ok(w, 'expected a warning for the bad field')
  assert.match(w.reason, /using default/)
})

test('an out-of-range value falls back rather than being clamped', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { worker: { temperature: 99 } } }],
  })
  assert.equal(config.worker.temperature, DEFAULTS.worker.temperature)
  assert.match(warnings.find((w) => w.field === 'worker.temperature').reason, /above maximum/)
})

test('an illegal enum value falls back and names the legal set', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { routing: { bulkRead: { enforce: 'obliterate' } } } }],
  })
  assert.equal(config.routing.bulkRead.enforce, 'deny')
  assert.match(warnings.find((w) => w.field === 'routing.bulkRead.enforce').reason, /must be one of/)
})

test('one bad field does not poison its neighbours', () => {
  const { config } = resolveConfig({
    layers: [{
      name: 'project',
      data: { routing: { bulkRead: { minLines: null, maxFiles: 7, enforce: 'ask' } } },
    }],
  })
  assert.equal(config.routing.bulkRead.minLines, DEFAULTS.routing.bulkRead.minLines)
  assert.equal(config.routing.bulkRead.maxFiles, 7)
  assert.equal(config.routing.bulkRead.enforce, 'ask')
})

test('a non-object layer is rejected without throwing', () => {
  const { config, warnings } = resolveConfig({ layers: [{ name: 'project', data: ['nope'] }] })
  assert.equal(config.worker.provider, DEFAULTS.worker.provider)
  assert.ok(warnings.some((w) => w.reason === 'expected a JSON object'))
})

test('a bad env value warns and leaves the file layer in place', () => {
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { routing: { bulkRead: { minLines: 400 } } } }],
    env: { CMR_MIN_LINES: 'banana' },
  })
  assert.equal(config.routing.bulkRead.minLines, 400)
  assert.ok(warnings.some((w) => w.scope === 'env:CMR_MIN_LINES'))
})

test('unknown fields are reported, not silently swallowed', () => {
  const { warnings } = resolveConfig({
    layers: [{ name: 'project', data: { routing: { bulkRead: { minLine: 350 } }, wokrer: {} } }],
  })
  const unknown = warnings.filter((w) => w.reason === 'unknown field, ignored').map((w) => w.field)
  assert.ok(unknown.includes('routing.bulkRead.minLine'), `got ${JSON.stringify(unknown)}`)
  assert.ok(unknown.includes('wokrer'), `got ${JSON.stringify(unknown)}`)
})

/* -------------------------------------------------- savings-integrity guard */

test('residencyTurns > 0 without provenance is forced to 0', () => {
  // A non-zero residency with no stated source would inflate the cached savings
  // figure in a way nobody could audit. It must not survive resolution.
  const { config, warnings } = resolveConfig({
    layers: [{ name: 'project', data: { telemetry: { residencyTurns: 40 } } }],
  })
  assert.equal(config.telemetry.residencyTurns, 0)
  assert.match(warnings.find((w) => w.field === 'telemetry.residencyTurns').reason, /requires residencySource/)
})

test('residencyTurns > 0 is allowed once its source is stated', () => {
  const { config, warnings } = resolveConfig({
    layers: [{
      name: 'project',
      data: { telemetry: { residencyTurns: 12, residencySource: 'transcript_measured' } },
    }],
  })
  assert.equal(config.telemetry.residencyTurns, 12)
  assert.equal(config.telemetry.residencySource, 'transcript_measured')
  assert.equal(warnings.length, 0, JSON.stringify(warnings))
})

test('privacy and proven-file defaults are the conservative ones', () => {
  const { config } = resolveConfig()
  assert.equal(config.telemetry.privacyLevel, 'hashed')
  assert.equal(config.telemetry.saltScope, 'install')
  assert.equal(config.telemetry.storeQuestionText, false)
  assert.equal(config.telemetry.storeFilePaths, false)
  assert.equal(config.telemetry.countProvenFilesOnly, true)
  assert.equal(config.telemetry.counterfactualRender, 'raw')
  assert.equal(config.telemetry.avoidedMethod, 'chars_div_4')
  assert.equal(config.telemetry.primaryModel, null, 'primary model must be resolved, never guessed')
})

test('task intent is OFF out of the box, which is the data-egress default', () => {
  // The default that matters most in this file. `transcript` forwards the developer's own prompt
  // text to a worker model that may be a third party, so the shipped value must be `none` and
  // must stay `none` — a change here is a change to what leaves someone's machine.
  const { config } = resolveConfig()
  assert.equal(config.hooks.taskIntent.source, 'none')
  assert.equal(config.hooks.taskIntent.maxChars, 600, 'and what crosses is bounded')
})

test('an illegal task-intent source falls back to off rather than to on', () => {
  // Fail CLOSED on a typo. `resolveConfig` falls back to the default on a rejected value, and
  // because the default is `none` that is also the safe direction — but it is asserted rather
  // than assumed, since the same mechanism would fail open if the default ever moved.
  const { config, warnings } = resolveConfig({ layers: [{ name: 'p', data: { hooks: { taskIntent: { source: 'llm' } } } }] })
  assert.equal(config.hooks.taskIntent.source, 'none')
  assert.ok(warnings.some((w) => w.field === 'hooks.taskIntent.source'))
})

test('the task-intent source can be set by file, env and plugin option alike', () => {
  const byFile = resolveConfig({ layers: [{ name: 'p', data: { hooks: { taskIntent: { source: 'transcript' } } } }] })
  assert.equal(byFile.config.hooks.taskIntent.source, 'transcript')
  assert.deepEqual(byFile.warnings, [])

  const byEnv = resolveConfig({ env: { CMR_TASK_INTENT_SOURCE: 'transcript', CMR_TASK_INTENT_MAX_CHARS: '120' } })
  assert.equal(byEnv.config.hooks.taskIntent.source, 'transcript')
  assert.equal(byEnv.config.hooks.taskIntent.maxChars, 120)
  assert.deepEqual(byEnv.warnings, [])

  // The nested dotted leaf has to survive the plugin overlay's name mangling, which collapses
  // camelCase to a single uppercase token.
  const byOption = resolveConfig({ env: { CLAUDE_PLUGIN_OPTION_HOOKS_TASKINTENT_SOURCE: 'transcript' } })
  assert.equal(byOption.config.hooks.taskIntent.source, 'transcript')
})

test('secrets are on the deny list out of the box', () => {
  const { config } = resolveConfig()
  for (const pattern of ['**/.env*', '**/*secret*', '**/*.pem', '**/*.key', '**/auth/**']) {
    assert.ok(config.routing.denyGlobs.includes(pattern), `missing deny glob ${pattern}`)
  }
})

/* ----------------------------------------------------------- leaf coercion */

test('env booleans accept the usual spellings', () => {
  const spec = SPEC['enabled']
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(coerceLeaf(spec, v, { fromEnv: true }).value, true, v)
  }
  for (const v of ['0', 'false', 'no', 'off']) {
    assert.equal(coerceLeaf(spec, v, { fromEnv: true }).value, false, v)
  }
  assert.equal(coerceLeaf(spec, 'maybe', { fromEnv: true }).ok, false)
})

test('a boolean string is rejected outside the env layer', () => {
  // A JSON config file saying "true" is a mistake worth surfacing, not coercing.
  assert.equal(coerceLeaf(SPEC['enabled'], 'true').ok, false)
})

test('env string lists are comma separated', () => {
  const r = coerceLeaf(SPEC['routing.denyGlobs'], '**/a/**, **/b/** ,', { fromEnv: true })
  assert.deepEqual(r.value, ['**/a/**', '**/b/**'])
})

test('int rejects a non-integer number', () => {
  assert.equal(coerceLeaf(SPEC['routing.bulkRead.minLines'], 12.5).ok, false)
})

test('nullable fields accept null, non-nullable ones do not', () => {
  assert.equal(coerceLeaf(SPEC['telemetry.primaryModel'], null).ok, true)
  assert.equal(coerceLeaf(SPEC['worker.provider'], null).ok, false)
})

test('every spec entry has a matching default', () => {
  for (const field of Object.keys(SPEC)) {
    assert.notEqual(get(DEFAULTS, field), undefined, `DEFAULTS is missing ${field}`)
  }
})

test('every spec default satisfies its own spec', () => {
  for (const [field, spec] of Object.entries(SPEC)) {
    const r = coerceLeaf(spec, get(DEFAULTS, field))
    assert.ok(r.ok, `default for ${field} fails its spec: ${r.reason}`)
  }
})

test('env var names are unique across the spec', () => {
  const seen = new Map()
  for (const [field, spec] of Object.entries(SPEC)) {
    if (!spec.env) continue
    assert.equal(seen.has(spec.env), false, `${spec.env} is used by both ${seen.get(spec.env)} and ${field}`)
    seen.set(spec.env, field)
  }
})

/* --------------------------------------------------------------- utilities */

test('comments are stripped but // inside strings survives', () => {
  const src = `{
    // a line comment
    "baseUrl": "https://example.com/v1", /* block */
    "glob": "**/a//b/**"
  }`
  const parsed = JSON.parse(stripJsonComments(src))
  assert.equal(parsed.baseUrl, 'https://example.com/v1')
  assert.equal(parsed.glob, '**/a//b/**')
})

test('expandHome handles ~, ~/ and plain paths', () => {
  assert.equal(expandHome('~', '/home/x'), '/home/x')
  assert.equal(expandHome('~/t', '/home/x').replace(/\\/g, '/'), '/home/x/t')
  assert.equal(expandHome('/abs/path', '/home/x'), '/abs/path')
  assert.equal(expandHome('relative/path', '/home/x'), 'relative/path')
})

test('$schema is accepted without being flagged as a typo', () => {
  // Users are told to add $schema for editor autocomplete; warning about it
  // would train them to ignore our warnings.
  const { warnings } = resolveConfig({
    layers: [{
      name: 'project',
      data: { $schema: '../lib/config.schema.json', routing: { bulkRead: { minLines: 400 } } },
    }],
  })
  assert.equal(warnings.length, 0, JSON.stringify(warnings))
})

// The shipped examples used to be checked here, for the one file that existed. They now live in
// test/examples.test.mjs, which censuses the whole directory so a new example cannot ship
// unvalidated, and resolves paths from import.meta.url rather than the working directory.

test('every plugin userConfig default equals the shipped default it overrides', () => {
  // Found end to end on 2026-10-05: plugin.json still offered `gemini-2.5-flash` — a model Google
  // had retired — as worker_model's default, after DEFAULTS had moved on. Claude Code does not
  // export an unset option, so the hook was unaffected; but anyone opening /plugin configure was
  // shown, and could save, a model that 404s. A userConfig default is a second copy of a shipped
  // default, so it is held to the first.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '../plugins/model-router/.claude-plugin/plugin.json'), 'utf8'),
  )
  const byKey = new Map(Object.keys(SPEC).map((f) => [f.replace(/[.\-]/g, '_').toLowerCase(), f]))
  const options = Object.entries(manifest.userConfig ?? {})
  assert.ok(options.length > 0, 'the manifest must declare userConfig, or this test checks nothing')
  for (const [key, option] of options) {
    const field = byKey.get(key)
    assert.ok(field, `userConfig.${key} maps to no SPEC field, so the hook would never read it`)
    const shipped = field.split('.').reduce((o, k) => o?.[k], DEFAULTS)
    assert.deepEqual(option.default, shipped, `userConfig.${key} default must equal DEFAULTS.${field}`)
  }
})
