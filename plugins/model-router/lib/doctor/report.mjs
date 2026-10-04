/**
 * The doctor's severity model, and nothing else.
 *
 * THE HOUSE PATTERN, APPLIED: policy decides, the renderer renders. `governance/policy.mjs`
 * already works this way — `describeGovernance()` returns findings and prints nothing, which is
 * what makes its severity matrix unit-testable instead of only observable through stdout. This
 * module does the same for the decisions doctor makes itself, so the interesting judgements can
 * be driven from hand-built inputs rather than by spawning a process and grepping its output.
 *
 * Pure: no node builtin, no I/O, no clock it was not handed.
 */

/**
 * FOUR levels, not three. `info` is the one that was missing: doctor previously emitted its
 * echoes — the resolved worker line, the configured thresholds, current spend — as raw dimmed
 * `console.log`, outside the counters entirely. That made an observation indistinguishable from a
 * check that had been skipped, and there was no way to ask the tool for its findings as data.
 *
 * Only `fail` affects the exit code. That is load-bearing, not cosmetic: the shipped state of a
 * fresh install carries warnings by design (no key configured, nothing priced, no budget set),
 * and a tool that exited non-zero on its own defaults would train everyone to ignore it.
 */
export const FINDING_LEVELS = Object.freeze(['pass', 'warn', 'fail', 'info'])

/**
 * The ONE place a governance level becomes a doctor level.
 *
 * `describeGovernance()` keeps its own three-level vocabulary deliberately: it has no
 * genuinely INFO-class finding, because the only information-shaped governance line is current
 * spend, and that is a ledger READ rather than a pure policy verdict — so it belongs to the
 * caller that did the reading, not to the policy. Mirrors `statusForSource()`: one mapping,
 * stated once.
 */
export const LEVEL_FROM_GOVERNANCE = Object.freeze({ ok: 'pass', warn: 'warn', fail: 'fail' })

/** A finding. `detail` is always a string so a renderer never has to test for undefined. */
export function finding(level, label, detail = '') {
  if (!FINDING_LEVELS.includes(level)) throw new Error(`unknown finding level ${level}`)
  return Object.freeze({ level, label, detail: detail ?? '' })
}

export const pass = (label, detail) => finding('pass', label, detail)
export const warn = (label, detail) => finding('warn', label, detail)
export const fail = (label, detail) => finding('fail', label, detail)
export const info = (label, detail) => finding('info', label, detail)

/**
 * Describe a secret without revealing it.
 *
 * Enough to tell "set, looks like a Gemini key, 39 chars" from "set to an empty string" from
 * "set to a shell expansion that never expanded" — the three failures people actually hit. The
 * output is safe to paste into an issue, which is what lets the bug-report template ask for it.
 */
export function describeSecret(value) {
  if (value === undefined) return { state: 'absent' }
  if (value === '') return { state: 'empty' }
  const v = String(value)
  if (/^\$|^%.*%$|^\$\{/.test(v)) {
    return {
      state: 'unexpanded',
      detail: 'looks like a literal shell expansion — config values are never interpolated, so set the variable itself',
    }
  }
  return { state: 'present', detail: `${v.length} chars, starts "${v.slice(0, 4)}…"` }
}

/** The platform-correct way to set an environment variable so Claude Code will see it. */
export function setKeyRemedy(keyEnv, platform) {
  return platform === 'win32'
    ? `setx ${keyEnv} "your-key" then restart Claude Code (setx does not affect the current shell)`
    : `export ${keyEnv}=your-key, and add it to your shell profile to persist`
}

/**
 * The finding for one API key a lane actually wants.
 *
 * THE DECISION THIS MODULE EXISTS FOR. A missing key used to be an unconditional FAIL with exit
 * 1, which meant a brand-new install — `worker.provider` defaults to `gemini`, and installing
 * requires no key — reported itself broken. It is not broken: the gate fails open on every
 * branch, so every read goes to Claude exactly as it would without the plugin.
 *
 * So the severity turns on whether ANYONE EXPRESSED AN INTENT, which `loadConfig()` already
 * answers through its `sources` map:
 *
 *   - nobody named this provider (bundled default) + no key  ->  WARN. Nothing is misconfigured;
 *     the router is simply not set up yet, and both ways forward get named.
 *   - somebody named it, in a file or an env var, + no key    ->  FAIL. Someone asked for gemini
 *     and gemini cannot run. That is a misconfiguration with a definite fix.
 *
 * This is the same distinction the codebase already draws three times: a configured value is
 * never a measured capability; `null` (no limit) is never `0` (a chosen limit); and "no budget
 * configured" is PASS while "budget configured but unenforceable" is WARN. Flattening "not set
 * up" into "broken" is what produced a frightening exit 1 on a clean install.
 *
 * @param {object}  opts
 * @param {string}  opts.keyEnv      the variable name, e.g. GEMINI_API_KEY
 * @param {string[]} opts.modes      which lanes want it, for the detail line
 * @param {object}  opts.secret      the result of describeSecret()
 * @param {boolean} opts.configured  did any layer name this provider?
 * @param {string}  opts.platform    process.platform
 */
export function apiKeyFinding({ keyEnv, modes, secret, configured, platform }) {
  const who = `needed by ${modes.join(', ')}`

  if (secret.state === 'present') return pass(`${keyEnv} is set`, `${secret.detail}, ${who}`)
  if (secret.state === 'empty') return fail(`${keyEnv} is set but empty`, who)
  if (secret.state === 'unexpanded') return fail(`${keyEnv} looks wrong`, `${secret.detail}, ${who}`)

  if (!configured) {
    return warn(
      `${keyEnv} is not set, so nothing will be delegated yet`,
      `${keyEnv} is the SHIPPED DEFAULT, not a choice you made — routing stays off and every read ` +
        `goes to Claude as normal. Either ${setKeyRemedy(keyEnv, platform)}, or switch to a ` +
        `keyless local worker (see docs/providers.md).`,
    )
  }
  return fail(`${keyEnv} is not set`, `${who}; ${setKeyRemedy(keyEnv, platform)}`)
}

/**
 * The node version finding.
 *
 * Cites `package.json` engines rather than `node:sqlite`, which the old message named. Nothing
 * shipping imports `node:sqlite` — it was reserved for an ingest step that does not exist — so
 * the failure told a Node 22.0 user their install was broken for a reason that was not true.
 */
export function nodeFinding({ version, floor = [22, 5] }) {
  const [major, minor] = String(version).split('.').map(Number)
  const ok = major > floor[0] || (major === floor[0] && minor >= floor[1])
  const want = `${floor[0]}.${floor[1]}`
  return ok
    ? pass(`node ${version}`, `package.json engines requires >=${want}`)
    : fail(`node ${version}`, `package.json engines requires >=${want}`)
}

/**
 * Collapse sections into counts and an exit code.
 *
 * WARN and INFO never move the exit code. Pinned by a test, because this is the property the
 * whole four-level scheme rests on.
 */
export function summarize(sections) {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const section of sections) {
    for (const f of section.findings ?? []) {
      if (counts[f.level] === undefined) continue
      counts[f.level]++
    }
  }
  return Object.freeze({ counts: Object.freeze(counts), exitCode: counts.fail > 0 ? 1 : 0 })
}

/** The machine-readable report. One vocabulary across text and JSON, by construction. */
export function toJson({ sections, project, mode, generatedAt, version }) {
  const { counts, exitCode } = summarize(sections)
  return {
    schemaVersion: 1,
    tool: 'router-doctor',
    version,
    generatedAt,
    mode,
    project,
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      findings: (s.findings ?? []).map((f) => ({ level: f.level, label: f.label, detail: f.detail })),
      // Raw lines that are deliberately not findings: a pasteable pricing table, the worker's
      // reply under --live. Carried so the JSON is not a lossy view of the text.
      note: [...(s.note ?? [])],
    })),
    counts,
    exitCode,
  }
}
