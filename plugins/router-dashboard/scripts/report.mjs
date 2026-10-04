#!/usr/bin/env node
/**
 * `npm run report` — a self-contained HTML report of what delegation did.
 *
 * ONE FILE, NO SERVER. `router-report-<date>.html` carries its own CSS and its own hand-rolled
 * SVG, so it opens on a machine with no network and keeps working in a year. A localhost server
 * would mean a port, a lifecycle and a question about who can reach it, for a document one person
 * reads once.
 *
 * IT RENDERS AN ANALYTICS RESPONSE AND NEVER READS A STORE. This plugin may not import
 * `model-router`, so the response arrives one of three ways, in this order: `--input <file>`,
 * stdin when it is not a terminal, or — as a convenience — by spawning the router's own read-only
 * analytics CLI. Installed on its own, the first two still work exactly as well; the third prints
 * instructions rather than failing silently.
 *
 * THE LAST LINE OF STDOUT IS THE PATH AND NOTHING ELSE, so `npm run --silent report` is usable
 * inside a `$(...)`.
 */

import fs from 'node:fs'
import path from 'node:path'

import { parseResponse } from '../lib/contract.mjs'
import { renderReport } from '../lib/render/index.mjs'
import { NO_ROUTER_MESSAGE, collectFromStore } from './collect.mjs'

const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

/** The house pattern: the hand-rolled flag/opt pair from doctor.mjs, no dependency. */
function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`)
  const opt = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--') ? dflt : argv[i + 1]
  }

  const known = [
    'input',
    'out',
    'router',
    'now',
    'help',
    // Window and scope flags are passed straight through to the router CLI, so a reader does not
    // have to learn two different vocabularies for the same question.
    'today',
    '24h',
    '7d',
    '30d',
    'all',
    'start',
    'end',
    'provider',
    'model',
    'mode',
    'project',
    'session',
  ]
  const unknown = argv.filter((a) => a.startsWith('--') && !known.includes(a.slice(2)))
  if (unknown.length > 0) return { usage: `unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}` }

  const passthrough = []
  for (const name of ['today', '24h', '7d', '30d', 'all']) if (flag(name)) passthrough.push(`--${name}`)
  for (const name of ['start', 'end', 'provider', 'model', 'mode', 'project', 'session', 'now']) {
    const value = opt(name)
    if (value !== null) passthrough.push(`--${name}`, value)
  }

  return {
    help: flag('help'),
    input: opt('input'),
    out: opt('out'),
    router: opt('router'),
    now: opt('now'),
    passthrough,
  }
}

const USAGE = `
Usage: npm run report -- [options]

Writes one self-contained HTML report and prints its path.

Input (in this order of precedence)
  --input <file>       an analytics response produced by \`analytics --json\`
  (stdin)              the same, piped
  (otherwise)          run the router's analytics CLI, if it is installed alongside

Output
  --out <file>         where to write. Default: ./router-report-<UTC date>.html

Passed through to the analytics CLI
  --today --24h --7d --30d --all
  --start <date> --end <date>
  --provider <name> --model <name> --mode <name>
  --project <id> --session <id>
  --now <instant>      treat this instant as now, for reproducible output

Other
  --router <path>      the model-router plugin directory, or its analytics.mjs

Exit codes: 0 on success, 2 on a bad invocation or an unusable input.
`

/** The UTC date, for the default filename. Same convention as a telemetry segment. */
function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * @param {object} opts
 * @param {string[]} [opts.argv]
 * @param {(s: string) => void} [opts.log]
 * @param {(s: string) => void} [opts.warn]
 * @param {() => string} [opts.readStdin]
 * @param {Function} [opts.collect]
 */
export function runReport({
  argv = process.argv.slice(2),
  log = console.log,
  warn = (s) => process.stderr.write(`${s}\n`),
  readStdin = defaultReadStdin,
  collect = collectFromStore,
  fsImpl = fs,
  cwd = process.cwd(),
} = {}) {
  const args = parseArgs(argv)

  if (args.usage) {
    warn(`${RED}${args.usage}${OFF}`)
    warn(USAGE)
    return 2
  }
  if (args.help) {
    log(USAGE.trim())
    return 0
  }

  let nowMs = Date.now()
  if (args.now !== null) {
    const parsed = Date.parse(args.now)
    if (!Number.isFinite(parsed)) {
      warn(`${RED}--now is not an instant: ${args.now}${OFF}`)
      return 2
    }
    nowMs = parsed
  }

  /* ---- get the response ---- */
  let text = null
  let origin = null

  if (args.input !== null) {
    try {
      text = fsImpl.readFileSync(args.input, 'utf8')
      origin = args.input
    } catch (err) {
      warn(`${RED}cannot read ${args.input}: ${err.message}${OFF}`)
      return 2
    }
  } else {
    const piped = readStdin()
    if (piped !== null && piped.trim() !== '') {
      text = piped
      origin = 'stdin'
    } else {
      const collected = collect({ explicit: args.router, passthrough: args.passthrough })
      if (!collected.ok) {
        warn(`${RED}${collected.reason === 'router_not_found' ? '' : `${collected.reason}: `}${OFF}${collected.detail}`)
        if (collected.reason !== 'router_not_found') warn(`\n${DIM}${NO_ROUTER_MESSAGE}${OFF}`)
        return 2
      }
      text = collected.json
      origin = collected.script
    }
  }

  const parsed = parseResponse(text)
  if (!parsed.ok) {
    warn(`${RED}${parsed.reason}${OFF}: ${parsed.detail}`)
    return 2
  }

  /* ---- render ---- */
  const html = renderReport(parsed.response, { generatedAt: new Date(nowMs).toISOString() })

  const out = args.out ?? path.join(cwd, `router-report-${utcDate(nowMs)}.html`)
  try {
    fsImpl.writeFileSync(out, html, 'utf8')
  } catch (err) {
    warn(`${RED}cannot write ${out}: ${err.message}${OFF}`)
    return 2
  }

  // Everything informational goes to stderr, so the last line of stdout is the path alone.
  warn(`${DIM}read ${origin}${OFF}`)
  const q = parsed.response.dataQuality
  const loud = q.conditions.filter((c) => c.severity !== 'info')
  for (const c of loud) warn(`${DIM}${c.severity}: ${c.id}${OFF}`)
  log(path.resolve(out))
  return 0
}

/** stdin, or null when it is a terminal and therefore not an input. */
function defaultReadStdin() {
  try {
    if (process.stdin.isTTY) return null
    return fs.readFileSync(0, 'utf8')
  } catch {
    return null
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('report.mjs')) {
  try {
    process.exit(runReport())
  } catch (err) {
    process.stderr.write(`${RED}report failed: ${err?.message ?? err}${OFF}\n`)
    process.exit(2)
  }
}
