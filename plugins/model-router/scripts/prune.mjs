#!/usr/bin/env node
/**
 * Retention sweep over the telemetry store.
 *
 * NEVER CALLED FROM THE WRITE PATH. A readdir-plus-stat sweep per hook is unacceptable on the hot
 * path, and unlinking files from a hook while another process is reading them is a surprise
 * nobody asked for. So retention is a separate, deliberate, long-lived operation.
 *
 *   node plugins/model-router/scripts/prune.mjs            # report only
 *   node plugins/model-router/scripts/prune.mjs --apply    # actually delete
 *
 * Selection is by FILENAME DATE, never by mtime: a cloud-sync rehydrate, a restore, a git
 * checkout or an antivirus touch rewrites mtime. The pruner and the reader share one definition
 * of a segment, which is the guarantee retention cannot delete a file the reader would have read.
 */

import { loadConfig } from '../lib/config.mjs'
import { pruneSegments } from '../lib/telemetry/jsonl.mjs'

const DIM = '\u001b[2m'
const OFF = '\u001b[0m'

export function runPrune({ argv = process.argv.slice(2), log = console.log } = {}) {
  const apply = argv.includes('--apply')
  const { config } = loadConfig()
  const dir = config.telemetry.dirResolved

  const result = pruneSegments({
    dir,
    retentionDays: config.telemetry.retentionDays,
    now: Date.now(),
    dryRun: !apply,
  })

  log(`telemetry store: ${dir}`)
  log(`retention: ${config.telemetry.retentionDays} days — keeping segments dated ${result.cutoff} or later`)
  log(`${DIM}examined ${result.examined} segment(s)${OFF}`)

  if (config.telemetry.rotation === 'none') {
    // The honest consequence of rotation=none, worth saying out loud rather than leaving the
    // operator to discover that their retention setting does nothing.
    log('')
    log('WARNING: rotation is "none", so every event lands in one undated segment and retention')
    log('         can never prune it. Set telemetry.rotation to "daily" for retention to apply.')
  }

  if (result.eligible.length === 0) {
    log('')
    log('nothing to prune')
  } else {
    log('')
    log(apply ? `deleted ${result.deleted.length} segment(s):` : `would delete ${result.eligible.length} segment(s):`)
    for (const name of apply ? result.deleted : result.eligible) log(`  ${name}`)
    if (apply) log(`${DIM}freed ${result.bytesFreed} bytes${OFF}`)
    if (!apply) log('')
    if (!apply) log('re-run with --apply to delete them')
  }

  for (const err of result.errors) {
    // Pruning is advisory. A locked file is reported and never fails the run.
    log(`  could not delete ${err.name}: ${err.code}`)
  }

  return result
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('prune.mjs')) {
  runPrune()
}
