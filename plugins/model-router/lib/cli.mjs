/**
 * The shared CLI surface for this plugin's commands: flag parsing, colour policy and exit codes.
 *
 * WHY THIS EXISTS, given the repo calls the hand-rolled `flag`/`opt` duplication "the house
 * pattern". That pattern was fine while it was six lines copied twice. It stopped being fine when
 * a UNIFORM CONTRACT across four commands became a tested property, because then the duplication
 * is not argument parsing — it is four copies of the contract, and three of them were wrong in
 * different ways: doctor accepted unknown flags silently, budget parsed no arguments at all,
 * report had no colour control, and analytics had to special-case `--json` locally because the
 * house `opt()` swallows the token after a boolean flag. Four copies of a bug is how you get a
 * fifth.
 *
 * `plugins/router-dashboard/scripts/report.mjs` DELIBERATELY DOES NOT IMPORT THIS. A static test
 * pins that nothing in that plugin imports router code, which is what makes "the dashboard is
 * installable standalone and cannot read a store" structural rather than a policy. Vendoring a
 * copy there would be a worse lie than twenty duplicated lines, so the shared contract across
 * that boundary is enforced by `test/cli.contract.test.mjs` instead of by an import. Do not
 * "clean this up" by importing it there.
 *
 * Pure: no node builtin, no I/O. The caller decides what to do with the result.
 */

/**
 * The exit-code table, which is the whole contract and is deliberately only three wide.
 *
 *   0  ran and reported. Includes "nothing to report", "no budget configured", "store empty"
 *      and "unpriced" — every one of those is the SHIPPED state, not an error.
 *   1  ran, and the thing it inspected is broken. Reserved for diagnostic verdicts, which in
 *      practice means doctor alone. `analytics` makes this unreachable on purpose: a reporting
 *      command that exited non-zero on an empty store would break every pipeline that ran it,
 *      including this repo's own CI steps.
 *   2  bad invocation, or input that cannot be used. Unknown flag, missing value, bad date.
 */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2 })

const ANSI = Object.freeze({
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  off: '\x1b[0m',
})

const PLAIN = Object.freeze({ green: '', red: '', yellow: '', dim: '', off: '' })

/**
 * The colour decision, in one place.
 *
 * Honours `--no-color`, the de-facto `NO_COLOR` convention, and a non-TTY stdout. The last one
 * matters most: every one of these commands emits ANSI into a pipe today, which is why the
 * analytics tests carry a `strip()` helper and why every CI step passes `--no-color` by hand.
 */
export function colors({ noColor = false, env = {}, isTTY = false } = {}) {
  const on = !noColor && !env.NO_COLOR && isTTY === true
  return on ? ANSI : PLAIN
}

/**
 * Parse argv against a declared set of flags.
 *
 * Booleans are DECLARED, which is the fix for the house pattern's one real bug: `opt()` would
 * return the token after `--json` as its value, so `--json --today` silently consumed `--today`.
 * Here a boolean never takes a value and a value flag always requires one.
 *
 * @param {string[]} argv
 * @param {object}   spec
 * @param {string[]} [spec.booleans]  flags that take no value
 * @param {string[]} [spec.values]    flags that require a value
 * @returns {{flags: object, values: object, rest: string[], errors: string[]}}
 */
export function parseFlags(argv, { booleans = [], values = [] } = {}) {
  const flags = Object.create(null)
  const parsed = Object.create(null)
  const rest = []
  const errors = []

  for (const name of booleans) flags[name] = false
  for (const name of values) parsed[name] = null

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      rest.push(token)
      continue
    }
    const name = token.slice(2)
    if (booleans.includes(name)) {
      flags[name] = true
      continue
    }
    if (values.includes(name)) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        errors.push(`--${name} needs a value`)
        continue
      }
      parsed[name] = next
      i++
      continue
    }
    errors.push(`unknown option ${token}`)
  }

  return { flags, values: parsed, rest, errors }
}
