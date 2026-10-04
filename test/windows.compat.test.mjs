/**
 * Windows compatibility, tested on both platforms.
 *
 * The project is validated on Windows and CI gates Linux, Windows and macOS, so the job here is to
 * PIN the path and process behaviour rather than to change it — the brief is explicit that working
 * path logic must not be rewritten for style.
 *
 * EVERY TEST RUNS ON EVERY PLATFORM. Where the operating systems genuinely differ, the assertion is
 * gated and the POSIX side asserts the POSIX analogue instead of skipping. Six `test.skip`s on
 * Linux would make the fast leg green while hiding a regression until the Windows leg ran, and the
 * Windows leg is the slow one — so the failure would arrive last and look unrelated.
 *
 * Nothing here is timing-based. A Windows runner under load is the least reliable clock available.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { makeCleanInstall, REPO_ROOT, scriptPath } from './helpers/clean-install.mjs'
import { expandHome, loadConfig, resolveConfig } from '../plugins/model-router/lib/config.mjs'
import { matchesAny } from '../plugins/model-router/lib/globs.mjs'

const IS_WINDOWS = process.platform === 'win32'

/* ------------------------------------------------------- spaces in paths */

test('a project path containing a space resolves and is reported', () => {
  // The single most common Windows packaging bug, and it was tested nowhere. The clean-install
  // fixture puts a space in a path component on every platform, so this is not Windows-only.
  const ci = makeCleanInstall({ label: 'win-space' })
  try {
    assert.ok(ci.projectDir.includes(' '))
    const { config } = loadConfig({ env: ci.env, home: ci.home, projectDir: ci.projectDir })
    assert.equal(config.projectDir, ci.projectDir)
    assert.ok(config.telemetry.dirResolved.includes(' '))
  } finally {
    ci.cleanup()
  }
})

test('a telemetry path containing a space is written to and read back', () => {
  const ci = makeCleanInstall({ label: 'win-store-space' })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    const segment = path.join(ci.storeDir, 'events-2026-03-02.jsonl')
    fs.copyFileSync(
      path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', 'events-2026-03-02.jsonl'),
      segment,
    )
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/analytics.mjs'), '--all', '--json'],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, r.stderr)
    const response = JSON.parse(r.stdout)
    assert.ok(response.summary.events.value > 0, 'a store behind a space must still be readable')
  } finally {
    ci.cleanup()
  }
})

test('every path-taking flag accepts a path with a space', () => {
  const ci = makeCleanInstall({ label: 'win-flag-space' })
  try {
    const out = path.join(ci.base, 'a report with spaces.html')
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/router-dashboard/scripts/report.mjs'), '--out', out, '--no-color'],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.ok(fs.existsSync(out))
    // The last line of stdout is the path alone, so `$(npm run --silent report)` works.
    const last = r.stdout.trim().split('\n').pop()
    assert.equal(last, out)
    assert.ok(path.isAbsolute(last), 'use path.isAbsolute, not a /^\\// regex')
  } finally {
    ci.cleanup()
  }
})

/* ----------------------------------------------------------- separators */

test('both path separators are matched by the deny list, on both platforms', () => {
  // A hook receives an ABSOLUTE path, and on Windows it uses backslashes. The glob matcher has to
  // normalise, and asserting BOTH forms on BOTH platforms is what stops a normalisation being
  // removed as redundant on whichever platform the author happened to be using.
  // `matchesAny(patterns, path)` returns the PATTERN that matched, or null — not a boolean, so the
  // deny-reason can name the glob that fired.
  const globs = ['**/.env*', '**/auth/**']
  assert.equal(matchesAny(globs, 'C:/project/src/auth/token.ts'), '**/auth/**')
  assert.equal(matchesAny(globs, 'C:\\project\\src\\auth\\token.ts'), '**/auth/**')
  assert.equal(matchesAny(globs, '/home/dev/project/src/auth/token.ts'), '**/auth/**')
  assert.equal(matchesAny(globs, 'C:\\project\\.env.local'), '**/.env*')
  assert.equal(matchesAny(globs, '/home/dev/project/.env.local'), '**/.env*')
  // And a path that should NOT match, so the matcher is not simply saying yes to everything.
  assert.equal(matchesAny(globs, 'C:\\project\\src\\author.ts'), null)
})

test('expandHome handles both separator forms after the tilde', () => {
  // `~/x` is covered elsewhere; the `~\x` branch is the Windows one and was untested.
  const home = os.homedir()
  assert.equal(expandHome('~'), home)
  assert.equal(expandHome('~/telemetry'), path.join(home, 'telemetry'))
  assert.equal(expandHome('~\\telemetry'), path.join(home, 'telemetry'))
  // A tilde that is not a home reference must be left alone.
  assert.equal(expandHome('~user/telemetry'), '~user/telemetry')
  assert.equal(expandHome('/absolute/path'), '/absolute/path')
})

/* ------------------------------------------------------ child processes */

test('a child process launches from a path containing a space and awkward characters', () => {
  // `collect.mjs` spawns with `shell: false` and an argv array precisely so a path with a space or
  // an ampersand survives. Ungated: an ampersand in a path is harmless on POSIX, so asserting it
  // everywhere costs nothing and documents the intent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-argv-'))
  try {
    const dir = path.join(root, 'dir with space & ampersand')
    fs.mkdirSync(dir, { recursive: true })
    const script = path.join(dir, 'probe.mjs')
    fs.writeFileSync(script, 'process.stdout.write(process.argv[2] ?? "")\n')
    const weird = 'value with space & ^ caret'
    const r = spawnSync(process.execPath, [script, weird], {
      encoding: 'utf8',
      shell: false,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, weird, 'an argv array must pass the argument through untouched')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the report spawn finds the router through a path with a space', () => {
  // The real spawn path, end to end: report.mjs -> collect.mjs -> analytics.mjs, with the store
  // behind a space. This is the one place a quoting bug would actually bite a user.
  const ci = makeCleanInstall({ label: 'win-spawn' })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    fs.copyFileSync(
      path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', 'events-2026-03-02.jsonl'),
      path.join(ci.storeDir, 'events-2026-03-02.jsonl'),
    )
    const out = path.join(ci.base, 'spawned.html')
    const r = spawnSync(
      process.execPath,
      [
        scriptPath('plugins/router-dashboard/scripts/report.mjs'),
        '--out', out,
        '--now', '2026-03-04T12:00:00.000Z',
        '--no-color',
      ],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.ok(fs.readFileSync(out, 'utf8').length > 1000)
  } finally {
    ci.cleanup()
  }
})

test('the hook launches when CLAUDE_PLUGIN_ROOT is substituted into a spaced path', () => {
  // What Claude Code actually does: substitute the plugin directory into the hooks.json command.
  // The REAL risk on Windows, and nothing tested it — hook.security.test.mjs only asserts that the
  // target file exists. Here the plugin tree is copied behind a space and the hook is run.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-pluginroot-'))
  try {
    const pluginRoot = path.join(root, 'plugin root with space', 'model-router')
    fs.cpSync(path.join(REPO_ROOT, 'plugins', 'model-router'), pluginRoot, { recursive: true })

    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'))
    const template = manifest.hooks.PreToolUse[0].hooks[0].args[0]
    const script = template.replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    assert.ok(script.includes(' '), 'the fixture must exercise a space')
    assert.ok(fs.existsSync(script), 'the substituted path must resolve')

    // The hook reads one JSON object on stdin, writes at most one on stdout, and ALWAYS exits 0.
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root },
    })
    assert.equal(r.status, 0, 'the hook must always exit 0')
    assert.equal(r.stderr, '', 'the hook must write nothing to stderr')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ file locks */

test('the lock error classifier still names the Windows contention codes', () => {
  // Static, deliberately. `governance.concurrency.test.mjs` exercises real contention with four
  // child processes; what THAT cannot show is which error codes are treated as contention, and on
  // Windows the class includes EPERM and EACCES as well as EEXIST. Those were added because
  // contention was MEASURED at roughly one run in three, and they are exactly the kind of detail a
  // refactor drops as "unreachable".
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'plugins', 'model-router', 'lib', 'governance', 'ledger.mjs'),
    'utf8',
  )
  for (const code of ['EEXIST', 'EPERM', 'EACCES']) {
    assert.ok(src.includes(code), `the lock classifier no longer mentions ${code}`)
  }
})

test('an exclusive-create lock is observed to fail on the second attempt', () => {
  // The platform-independent half of the claim, without any timing: `wx` must refuse an existing
  // file, and the code it refuses with must be in the contention class.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-lock-'))
  try {
    const lock = path.join(root, 'dir with space', 'ledger.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    const fd = fs.openSync(lock, 'wx')
    try {
      assert.throws(
        () => fs.openSync(lock, 'wx'),
        (err) => {
          const CONTENTION = IS_WINDOWS ? ['EEXIST', 'EPERM', 'EACCES'] : ['EEXIST']
          assert.ok(
            CONTENTION.includes(err.code),
            `${err.code} is not in this platform's contention class`,
          )
          return true
        },
      )
    } finally {
      fs.closeSync(fd)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------- environment variables */

test('environment variable case sensitivity, asserted in both directions', () => {
  // Gated, and BOTH directions are real claims. On Windows `process.env` is case-insensitive, so a
  // lowercase name works; on POSIX it does not. Asserting the POSIX direction is what stops anyone
  // documenting the lowercase spelling as supported.
  const r = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.env.CMR_ENABLED))'],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, cmr_enabled: '0' },
    },
  )
  if (IS_WINDOWS) {
    assert.equal(r.stdout, '0', 'Windows environment variables are case-insensitive')
  } else {
    assert.equal(r.stdout, 'undefined', 'POSIX environment variables are case-sensitive')
  }
})

test('a CMR_ variable set in a constructed child environment is honoured', () => {
  const ci = makeCleanInstall({ label: 'win-env', env: { CMR_MIN_LINES: '999' } })
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/doctor.mjs'), '--offline', '--json'],
      { encoding: 'utf8', env: ci.env },
    )
    const report = JSON.parse(r.stdout)
    const routing = report.sections.find((s) => s.id === 'routing')
    assert.ok(
      routing.findings.some((f) => `${f.label} ${f.detail}`.includes('999')),
      'the override should be visible in the routing section',
    )
  } finally {
    ci.cleanup()
  }
})

/* ----------------------------------------------------- generated output */

test('generated HTML contains no CRLF, on either platform', () => {
  // Ungated and load-bearing. CI diffs two report runs byte for byte; a `\r\n` sneaking in on one
  // platform would make that step platform-dependent rather than a real regression signal.
  const ci = makeCleanInstall({ label: 'win-crlf' })
  try {
    const out = path.join(ci.base, 'crlf.html')
    const r = spawnSync(
      process.execPath,
      [
        scriptPath('plugins/router-dashboard/scripts/report.mjs'),
        '--out', out,
        '--now', '2026-03-04T12:00:00.000Z',
        '--no-color',
      ],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, r.stderr)
    const html = fs.readFileSync(out, 'utf8')
    assert.equal(html.includes('\r\n'), false, 'the report must be LF-only everywhere')
  } finally {
    ci.cleanup()
  }
})

test('a non-ASCII model id survives the spawn into the HTML', () => {
  // Honest about what this does and does not prove. `spawnSync` with an argv array never involves
  // a shell, so this passes on Windows and shows the PROGRAM is encoding-safe.
  //
  // It does NOT exercise the real hazard, which is PowerShell 5.1 defaulting `$OutputEncoding` to
  // ASCII and mangling a native-to-native pipe — the documented
  // `analytics --json | report` form. `node --test` cannot reach that, which is precisely why
  // collect.mjs spawns instead of requiring a pipe, and why the docs tell PowerShell users to set
  // `$OutputEncoding` before piping.
  const ci = makeCleanInstall({ label: 'win-utf8' })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    const source = path.join(REPO_ROOT, 'test', 'fixtures', 'telemetry', 'events-2026-03-02.jsonl')
    const rows = fs
      .readFileSync(source, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const row = JSON.parse(l)
        // The stored field is `model` (with `model_requested` beside it). Rewriting a field name
        // that does not exist would make this test a silent no-op.
        if (row.model) row.model = 'modèle-ü→v2'
        if (row.model_requested) row.model_requested = 'modèle-ü→v2'
        return JSON.stringify(row)
      })
    fs.writeFileSync(path.join(ci.storeDir, 'events-2026-03-02.jsonl'), `${rows.join('\n')}\n`)

    const out = path.join(ci.base, 'utf8.html')
    const r = spawnSync(
      process.execPath,
      [
        scriptPath('plugins/router-dashboard/scripts/report.mjs'),
        '--out', out,
        '--now', '2026-03-04T12:00:00.000Z',
        '--no-color',
      ],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const html = fs.readFileSync(out, 'utf8')
    assert.ok(html.includes('modèle-ü'), 'the non-ASCII model id was mangled or dropped')
  } finally {
    ci.cleanup()
  }
})

/* --------------------------------------------------------- plugin loading */

test('the hook script is reachable from the manifest on this platform', () => {
  // path.join, not string concatenation: the substituted command has to resolve with native
  // separators, and a mixed-separator path is the shape that works until it does not.
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'plugins', 'model-router', 'hooks', 'hooks.json'),
      'utf8',
    ),
  )
  const pluginRoot = path.join(REPO_ROOT, 'plugins', 'model-router')
  for (const matcher of manifest.hooks.PreToolUse) {
    for (const handler of matcher.hooks) {
      const relative = handler.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', '')
      const resolved = path.join(pluginRoot, ...relative.split('/'))
      assert.ok(fs.existsSync(resolved), `${resolved} does not exist on ${process.platform}`)
    }
  }
})

test('a config path is reported with native separators', () => {
  // `budget.mjs` printed `D:\Dev Projects\x/.claude/model-router.json` — a mixed-separator path a
  // reader was being told to create. Cosmetic, and exactly the kind of thing that erodes trust in
  // the rest of the output.
  const ci = makeCleanInstall({ label: 'win-sep' })
  try {
    const r = spawnSync(
      process.execPath,
      [scriptPath('plugins/model-router/scripts/budget.mjs'), '--no-color'],
      { encoding: 'utf8', env: ci.env },
    )
    assert.equal(r.status, 0)
    const line = r.stdout.split('\n').find((l) => l.includes('model-router.json'))
    assert.ok(line, 'budget should suggest where to put a config')
    if (IS_WINDOWS) {
      const suggested = line.slice(line.indexOf(ci.projectDir))
      assert.equal(suggested.includes('/'), false, `mixed separators: ${suggested}`)
    } else {
      assert.equal(line.includes('\\'), false, 'a POSIX path must not contain a backslash')
    }
  } finally {
    ci.cleanup()
  }
})

/* -------------------------------------------------------------- the sink */

test('an event written behind a spaced path round-trips byte for byte', () => {
  // One record is one writeSync of one buffer ending in \n. Append atomicity has no specification
  // guarantee on Windows, which is why doctor reports malformed lines — but the single-record
  // round trip must hold regardless of where the store lives.
  const ci = makeCleanInstall({ label: 'win-sink' })
  try {
    fs.mkdirSync(ci.storeDir, { recursive: true })
    const file = path.join(ci.storeDir, 'events-2026-03-02.jsonl')
    const row = { event_id: 'e1', note: 'a value with a space and ü' }
    const line = `${JSON.stringify(row)}\n`
    fs.writeFileSync(file, Buffer.from(line, 'utf8'))
    const back = fs.readFileSync(file, 'utf8')
    assert.equal(back, line, 'the bytes changed on the way through the filesystem')
    assert.equal(back.endsWith('\n'), true)
    assert.equal(back.includes('\r'), false, 'a CR would split the record for a line reader')
    assert.deepEqual(JSON.parse(back), row)
  } finally {
    ci.cleanup()
  }
})
