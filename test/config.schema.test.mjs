import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { serializeJsonSchema, buildJsonSchema } from '../plugins/model-router/lib/config-schema.mjs'
import { SPEC, DEFAULTS } from '../plugins/model-router/lib/config.mjs'

const SCHEMA_PATH = path.join('plugins', 'model-router', 'lib', 'config.schema.json')

test('committed config.schema.json matches the SPEC table', () => {
  const onDisk = fs.readFileSync(SCHEMA_PATH, 'utf8')
  assert.equal(
    onDisk,
    serializeJsonSchema(),
    'config.schema.json is stale — run: node plugins/model-router/scripts/gen-config-schema.mjs',
  )
})

test('every SPEC leaf appears in the generated schema', () => {
  const schema = buildJsonSchema()
  for (const field of Object.keys(SPEC)) {
    const node = field.split('.').reduce((n, k) => {
      assert.ok(n?.properties?.[k], `schema is missing ${field}`)
      return n.properties[k]
    }, schema)
    assert.ok(node.type, `schema node for ${field} has no type`)
  }
})

test('enum fields carry their legal values into the schema', () => {
  const schema = buildJsonSchema()
  assert.deepEqual(
    schema.properties.routing.properties.bulkRead.properties.enforce.enum,
    ['deny', 'ask', 'suggest', 'off'],
  )
})

test('schema defaults equal the runtime defaults', () => {
  const schema = buildJsonSchema()
  const walk = (node, prefix = '') => {
    for (const [k, v] of Object.entries(node.properties ?? {})) {
      const dotted = prefix ? `${prefix}.${k}` : k
      if (v.properties) { walk(v, dotted); continue }
      const runtime = dotted.split('.').reduce((o, key) => o?.[key], DEFAULTS)
      assert.deepEqual(v.default, runtime, `default mismatch at ${dotted}`)
    }
  }
  walk(schema)
})

test('schema rejects unknown properties at every level', () => {
  const schema = buildJsonSchema()
  const walk = (node, prefix = '<root>') => {
    if (!node.properties) return
    assert.equal(node.additionalProperties, false, `${prefix} allows unknown properties`)
    for (const [k, v] of Object.entries(node.properties)) walk(v, `${prefix}.${k}`)
  }
  walk(schema)
})
