/**
 * The ONLY file in this plugin that touches `child_process`, and the only reason it exists.
 *
 * `router-dashboard` may not import `model-router` — the dashboard reads a telemetry store it must
 * not be able to recompute, and a static test pins that ban by inspecting import specifiers. But
 * `npm run report` has to be one command, so the convenience path shells out to the router's own
 * read-only analytics CLI and renders what it prints. A SPAWN IS NOT AN IMPORT: no router code is
 * loaded into this process, and the ban holds unchanged.
 *
 * WHY NOT JUST MANDATE THE PIPE. `analytics --json | report` is the obvious alternative and it is
 * supported, but it cannot be the only path. On Windows PowerShell 5.1 a pipe between two native
 * commands goes through PowerShell's own string conversion, governed by `$OutputEncoding`, which
 * defaults to ASCII — so a non-ASCII character in a model id or a provider label can be mangled in
 * transit. This repo gates CI on `windows-latest` precisely because it does not hand-wave platform
 * claims. A mangled model name on the most common invocation is worse than a clear error on the
 * rare standalone one.
 *
 * `shell: false` AND AN ARGV ARRAY ARE LOAD-BEARING. A shell string would make a plugin path
 * containing a space into two arguments, and one containing an ampersand into two commands.
 *
 * AND THERE IS NO ENVIRONMENT VARIABLE. A `CMR_*` name here would be an undeclared setting sitting
 * beside a config SPEC that declares every other one; the router path is a flag.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the router's analytics CLI might be, in the order worth trying.
 *
 * Both layouts are real: plugins installed side by side, and this repository's own
 * `plugins/<name>/` tree. Nothing else is guessed at — a wrong guess that happened to find
 * something executable would be worse than not finding anything.
 */
export function candidatePaths(root = PLUGIN_ROOT) {
  return [
    path.join(root, '..', 'model-router', 'scripts', 'analytics.mjs'),
    path.join(root, '..', '..', 'plugins', 'model-router', 'scripts', 'analytics.mjs'),
  ]
}

/** The first candidate that exists, or null. */
export function findRouterScript({ root = PLUGIN_ROOT, explicit = null, fsImpl = fs } = {}) {
  if (explicit !== null) {
    // An explicit --router may name the script or the plugin directory. Both are obvious things
    // for a person to type, so both work.
    const direct = explicit.endsWith('.mjs')
      ? explicit
      : path.join(explicit, 'scripts', 'analytics.mjs')
    return fsImpl.existsSync(direct) ? direct : null
  }
  for (const candidate of candidatePaths(root)) {
    if (fsImpl.existsSync(candidate)) return candidate
  }
  return null
}

export const NO_ROUTER_MESSAGE = `router-dashboard is installed without model-router, so there is no store to read.

It still renders a report from an analytics response produced elsewhere:

  node <path-to>/model-router/scripts/analytics.mjs --json > analytics.json
  npm run report -- --input analytics.json

or point this run at the router:

  npm run report -- --router <path-to>/model-router`

/**
 * Run the router's analytics CLI and return its stdout.
 *
 * @returns {{ok: true, json: string, script: string} | {ok: false, reason: string, detail: string}}
 */
export function collectFromStore({
  root = PLUGIN_ROOT,
  explicit = null,
  passthrough = [],
  fsImpl = fs,
  spawn = spawnSync,
  execPath = process.execPath,
  env = process.env,
} = {}) {
  const script = findRouterScript({ root, explicit, fsImpl })
  if (script === null) {
    return { ok: false, reason: 'router_not_found', detail: NO_ROUTER_MESSAGE }
  }

  const res = spawn(execPath, [script, '--json', ...passthrough], {
    encoding: 'utf8',
    shell: false,
    // An analytics response over a large store is comfortably bigger than the 1 MB default, and
    // a truncated JSON document would surface as a parse error a long way from its cause.
    maxBuffer: 64 * 1024 * 1024,
    env,
  })

  if (res.error) {
    return { ok: false, reason: 'spawn_failed', detail: `Could not run ${script}: ${res.error.message}` }
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? '').trim()
    return {
      ok: false,
      reason: 'router_failed',
      detail: `${script} exited ${res.status}${stderr === '' ? '' : `:\n${stderr}`}`,
    }
  }
  return { ok: true, json: res.stdout ?? '', script }
}
