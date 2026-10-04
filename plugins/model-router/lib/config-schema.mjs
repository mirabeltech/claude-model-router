/**
 * Builds the published JSON Schema from the same SPEC table that drives runtime
 * validation, so the schema an editor autocompletes against and the rules the
 * loader enforces cannot drift apart. `scripts/gen-config-schema.mjs` writes the
 * result to config.schema.json and a test asserts the committed file matches.
 */

import { SPEC, DEFAULTS, CONFIG_VERSION } from './config.mjs'

const TYPE_MAP = {
  bool: { type: 'boolean' },
  int: { type: 'integer' },
  number: { type: 'number' },
  string: { type: 'string' },
  enum: { type: 'string' },
  'string[]': { type: 'array', items: { type: 'string' } },
}

import { DESCRIPTIONS } from './config-descriptions.mjs'


function leafSchema(field, spec) {
  const base = { ...TYPE_MAP[spec.type] }
  if (spec.type === 'enum') base.enum = spec.values
  if (spec.min !== undefined) base.minimum = spec.min
  if (spec.max !== undefined) base.maximum = spec.max
  if (spec.nonEmpty) base.minLength = 1

  if (spec.nullable) {
    // JSON Schema draft 2020-12: express nullability as a type union.
    base.type = [base.type, 'null']
  }

  const dflt = field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS)
  if (dflt !== undefined) base.default = dflt
  if (DESCRIPTIONS[field]) base.description = DESCRIPTIONS[field]
  if (spec.env) {
    base.description = `${base.description ? `${base.description} ` : ''}Env override: ${spec.env}.`
  }
  return base
}

export function buildJsonSchema() {
  const root = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/mirabeltech/claude-model-router/main/plugins/model-router/lib/config.schema.json',
    title: 'claude-model-router configuration',
    description:
      'Layered configuration for the model-router plugin. Resolution order, later wins: bundled defaults, ~/.claude/model-router/config.json, <project>/.claude/model-router.json, CMR_* environment variables, CLAUDE_PLUGIN_OPTION_*. An invalid field falls back to its default with a warning rather than failing a hook.',
    type: 'object',
    additionalProperties: false,
    'x-configVersion': CONFIG_VERSION,
    properties: {
      // Allowed explicitly: the root uses additionalProperties:false, and users
      // are told to add $schema so their editor can autocomplete this file.
      $schema: { type: 'string', description: 'Path or URL to this schema, for editor autocomplete.' },
    },
  }

  for (const [field, spec] of Object.entries(SPEC)) {
    const keys = field.split('.')
    let node = root
    for (const key of keys.slice(0, -1)) {
      node.properties[key] ??= { type: 'object', additionalProperties: false, properties: {} }
      node = node.properties[key]
    }
    node.properties[keys.at(-1)] = leafSchema(field, spec)
  }

  return root
}

export function serializeJsonSchema() {
  return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`
}
