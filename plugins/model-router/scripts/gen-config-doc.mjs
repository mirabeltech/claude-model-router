#!/usr/bin/env node
/**
 * Regenerates the settings reference in docs/configuration.md from the SPEC table.
 *
 * Replaces ONLY the region below the sentinel. Everything above it is hand-written prose and is
 * preserved byte for byte: the table is the reference, the prose is the explanation, and
 * generating the second would produce a document that describes every setting and teaches none.
 *
 * Run after changing SPEC. CI runs this then `git diff --exit-code`, exactly as it does for
 * config.schema.json, so a stale reference fails the build rather than quietly misleading a reader.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOC_SENTINEL, serializeConfigMarkdown } from '../lib/config-doc.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const out = path.join(REPO_ROOT, 'docs', 'configuration.md')

if (!fs.existsSync(out)) {
  console.error(`${out} does not exist. The hand-written prose and the sentinel line must exist first.`)
  process.exit(1)
}

const current = fs.readFileSync(out, 'utf8')
const at = current.indexOf(DOC_SENTINEL)
if (at === -1) {
  console.error(`${out} has no generator sentinel. Add this line where the table should begin:\n${DOC_SENTINEL}`)
  process.exit(1)
}

let table
try {
  table = serializeConfigMarkdown()
} catch (err) {
  // An undocumented SPEC leaf stops the build here rather than shipping a reference with a hole
  // in it. The fix is a sentence in lib/config-descriptions.mjs.
  console.error(String(err?.message ?? err))
  process.exit(1)
}

const next = `${current.slice(0, at)}${table}`
if (current === next) {
  console.log(`docs/configuration.md already up to date (${out})`)
} else {
  fs.writeFileSync(out, next)
  console.log(`updated ${out}`)
}
