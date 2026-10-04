#!/usr/bin/env node
/**
 * `npm run analytics` — what delegation actually did, over a window you choose.
 *
 * READ-ONLY, in the strongest sense available. It opens no socket, calls no worker and writes
 * nothing: not a segment, not a lock, not even the telemetry directory. A reporting tool that
 * created the store directory in order to tell you it was empty would quietly falsify the thing
 * it was reporting on, so a missing store is read as an empty store and nothing is created.
 *
 * EXIT CODES: 0 for any successful read, 2 for a bad invocation. EXIT 1 IS UNREACHABLE BY DESIGN
 * and a test says so. This deliberately differs from `doctor`, which exits 1 when a check fails:
 * an unpriced install is the normal state of this project, and a reporting command that failed
 * on it would break every CI pipeline that ran it.
 *
 * `--json` WRITES TO STDOUT, which diverges from the one existing precedent (`npm run evals
 * --json <dir>`, which writes four artifacts into a directory). The divergence is the point: this
 * output exists to be piped into the dashboard, and a directory of artifacts would need a writer,
 * which this tool is not allowed to be.
 *
 * `--now` exists for reproducibility. A fixture-dated store cannot be analyzed at all without it,
 * and the CI diff of two runs would be meaningless. It fabricates nothing: it only says which
 * instant counts as "now" when resolving a relative window.
 */

import { loadConfig } from '../lib/config.mjs'
import { ROUTER_VERSION } from '../lib/version.mjs'
import { analyze, stringifyResponse } from '../lib/analytics/index.mjs'
import { renderText } from '../lib/analytics/text.mjs'

const RED = '\x1b[31m'
const OFF = '\x1b[0m'

/** The house pattern: the hand-rolled flag/opt pair from doctor.mjs, no dependency. */
function parseArgs(argv) {
  const flag = (name) => argv.includes(`--${name}`)
  const opt = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 || !argv[i + 1] || argv[i + 1].startsWith('--') ? dflt : argv[i + 1]
  }

  const unknown = argv.filter(
    (a) =>
      a.startsWith('--') &&
      ![
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
        'json',
        'no-color',
        'verbose',
        'now',
        'help',
        'version',
      ].includes(a.slice(2)),
  )
  if (unknown.length > 0) return { usage: `unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}` }

  // `--json` IS A BOOLEAN. The house `opt()` would silently swallow a following token, so a path
  // after it is a usage error rather than an argument that is quietly ignored.
  const jsonAt = argv.indexOf('--json')
  if (jsonAt !== -1) {
    const next = argv[jsonAt + 1]
    if (next !== undefined && !next.startsWith('--')) {
      return { usage: '--json writes to stdout; redirect it (> report.json) or pipe it' }
    }
  }

  const start = opt('start')
  const end = opt('end')
  const kinds = ['today', '24h', '7d', '30d', 'all'].filter(flag)
  if (kinds.length > 1) return { usage: `pick one window: ${kinds.map((k) => `--${k}`).join(' ')}` }
  if (kinds.length === 1 && (start !== null || end !== null)) {
    return { usage: `--${kinds[0]} cannot be combined with --start or --end` }
  }

  const kind = start !== null || end !== null ? 'custom' : (kinds[0] ?? '7d')

  return {
    help: flag('help'),
    version: flag('version'),
    json: flag('json'),
    color: !flag('no-color'),
    verbose: flag('verbose'),
    now: opt('now'),
    window: { kind, start, end },
    scope: {
      provider: opt('provider'),
      model: opt('model'),
      mode: opt('mode'),
      projectId: opt('project'),
      sessionId: opt('session'),
    },
  }
}

const USAGE = `
Usage: npm run analytics -- [options]

Read-only. Reports what delegation did over a window. Writes nothing.

Window (pick one; default --7d)
  --today              from UTC midnight to now
  --24h                a rolling 24 hours
  --7d                 seven whole UTC days, ending today
  --30d                thirty whole UTC days, ending today
  --all                everything in the store
  --start <date>       a custom range. ISO only: YYYY-MM-DD, or an instant
  --end <date>         with an explicit zone (Z or +HH:MM)

Filters
  --provider <name>    exact match on the stored provider
  --model <name>       exact match on the stored model
  --mode <name>        bulk-reader | code-writer (resolved onto task_type)
  --project <id>       exact match on the hashed project id
  --session <id>       exact match on the hashed session id

Output
  --json               the analytics response to stdout; takes no argument
  --no-color           plain text
  --verbose            include classes and buckets that are empty
  --now <instant>      treat this instant as now, for reproducible windows
  --version            print the router version and exit
  --help               print this and exit

Exit codes:
  0  on any successful read. There is deliberately NO failure exit: an empty or
     unpriced store is the shipped state and a result, not an error, so a
     pipeline that runs this does not break on a fresh install.
  2  bad invocation.
`

/**
 * @param {object} opts
 * @param {string[]} [opts.argv]
 * @param {(s: string) => void} [opts.log]    stdout
 * @param {(s: string) => void} [opts.warn]   stderr, so `--json` stays a clean pipe
 */
export async function runAnalytics({
  argv = process.argv.slice(2),
  log = console.log,
  warn = (s) => process.stderr.write(`${s}\n`),
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
  // Answered before the store is touched: the version of a marketplace install is otherwise
  // unaskable, and it is the first thing a bug report needs.
  if (args.version) {
    log(ROUTER_VERSION)
    return 0
  }

  // An explicit --now must be a real instant. Falling back to the wall clock would make a run
  // that was meant to be reproducible silently irreproducible.
  let nowMs = Date.now()
  if (args.now !== null) {
    const parsed = Date.parse(args.now)
    if (!Number.isFinite(parsed)) {
      warn(`${RED}--now is not an instant: ${args.now}${OFF}`)
      return 2
    }
    nowMs = parsed
  }

  const { config, warnings } = loadConfig()
  for (const w of warnings ?? []) warn(`config: ${w.scope} ${w.field}: ${w.reason}`)

  const response = await analyze({
    config,
    now: nowMs,
    window: args.window,
    scope: args.scope,
  })

  // An invalid window is a usage error, reported after the response is built so the message can
  // name the reason the resolver produced rather than guessing at it.
  if (!response.timeRange.valid) {
    warn(`${RED}invalid window: ${response.timeRange.reason}${OFF}`)
    warn(USAGE)
    return 2
  }

  if (args.json) log(stringifyResponse(response).trimEnd())
  else log(renderText(response, { color: args.color, verbose: args.verbose }))

  // Deliberately always 0 past this point. See the header: an unpriced store is the normal
  // state, and a reporting command must not fail a pipeline for reporting it honestly.
  return 0
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('analytics.mjs')) {
  runAnalytics().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${RED}analytics failed: ${err?.message ?? err}${OFF}\n`)
      process.exit(2)
    },
  )
}
