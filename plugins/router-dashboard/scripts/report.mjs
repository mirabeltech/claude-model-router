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
import { DASHBOARD_VERSION } from '../lib/version.mjs'
import { renderReport } from '../lib/render/index.mjs'
import { NO_ROUTER_MESSAGE, collectFromStore } from './collect.mjs'

/**
 * Colour, which only ever reaches stderr here. Honours `--no-color`, the de-facto `NO_COLOR`
 * convention and a non-TTY stderr, so a redirected log is plain by default.
 *
 * Deliberately NOT imported from `model-router/lib/cli.mjs`, even though that module exists and
 * does exactly this. A static test pins that nothing in this plugin imports router code, which is
 * what makes "the dashboard is installable standalone and cannot read a telemetry store"
 * structural rather than a policy. Twenty duplicated lines is the correct price for that; the
 * shared CLI contract is enforced across the boundary by `test/cli.contract.test.mjs` instead.
 */
const COLOR_CAPABLE = process.stderr.isTTY === true && !process.env.NO_COLOR
let RED = COLOR_CAPABLE ? '\x1b[31m' : ''
let DIM = COLOR_CAPABLE ? '\x1b[2m' : ''
let OFF = COLOR_CAPABLE ? '\x1b[0m' : ''

function disableColor() {
  RED = ''
  DIM = ''
  OFF = ''
}

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
    'no-color',
    'version',
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
    version: flag('version'),
    noColor: flag('no-color'),
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
  --no-color           plain diagnostics on stderr (also honours NO_COLOR)
  --version            print the dashboard version and exit
  --help               print this and exit

Exit codes:
  0  the report was written. Its path is the last line of stdout, alone, so
     "npm run --silent report" is usable in a command substitution.
  2  bad invocation, or an input that cannot be used.
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
  if (args.noColor) disableColor()
  if (args.help) {
    log(USAGE.trim())
    return 0
  }
  // Answered BEFORE stdin is read. `report --version` in a pipeline would otherwise block
  // forever waiting for an analytics response that is never coming.
  if (args.version) {
    log(DASHBOARD_VERSION)
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

/**
 * stdin, or null when there is no input on it.
 *
 * "Not a TTY" is NOT the same question as "has input", and treating them as equivalent made
 * `npm run report` hang forever in every non-interactive context — CI, a hook, a scripted clean
 * install — because stdin was an inherited handle nobody was ever going to write to, so the read
 * blocked instead of falling through to the spawn. MEASURED: a bare `npm run report` from a
 * non-interactive shell never returned.
 *
 * So ask what the handle actually is. A pipe or a redirected file will reach EOF and is real
 * input; a TTY or a character device (an inherited console, /dev/null) is not, and must not be
 * read. The documented precedence is unchanged for every case that genuinely has input.
 */
function defaultReadStdin() {
  try {
    if (process.stdin.isTTY) return null
    const stat = fs.fstatSync(0)
    if (!stat.isFIFO() && !stat.isFile()) return null
    return fs.readFileSync(0, 'utf8')
  } catch {
    return null
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('report.mjs')) {
  try {
    // `process.exitCode`, never `process.exit()`: on POSIX a write to a pipe is asynchronous, so
    // exiting discards whatever is still buffered. This command's stdout is only a path, but the
    // same call in analytics.mjs was truncating a 200 KB JSON response on Linux and macOS while
    // looking perfect on Windows — so the pattern is wrong regardless of today's payload size.
    process.exitCode = runReport()
  } catch (err) {
    process.stderr.write(`${RED}report failed: ${err?.message ?? err}${OFF}\n`)
    process.exitCode = 2
  }
}
