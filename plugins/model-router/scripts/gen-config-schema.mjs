#!/usr/bin/env node
/**
 * Regenerates plugins/model-router/lib/config.schema.json from the SPEC table.
 * Run after changing SPEC. `node --test` fails if the committed file is stale.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeJsonSchema } from '../lib/config-schema.mjs'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'config.schema.json')
const next = serializeJsonSchema()
const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null

if (prev === next) {
  console.log(`config.schema.json already up to date (${out})`)
} else {
  fs.writeFileSync(out, next)
  console.log(`${prev === null ? 'wrote' : 'updated'} ${out}`)
}
