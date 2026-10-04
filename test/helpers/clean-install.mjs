/**
 * A fresh install, in a temporary directory, isolated from the developer running the tests.
 *
 * Shared by the clean-install, team-safety and Windows-compatibility suites, because all three
 * need the same thing and getting the isolation subtly wrong in three places is how a suite ends
 * up quietly reading the developer's real `~/.claude`.
 *
 * Three decisions worth knowing:
 *
 * THE ROOT IS UNDER os.tmpdir(), NOT test/.tmp/. "No assumption about the working directory" means
 * a path inside the repository is itself a developer-specific path, and a suite that wrote into the
 * checkout could not prove it had not read from it either.
 *
 * ONE PATH COMPONENT CONTAINS A SPACE, always. That makes every clean-install test a
 * spaces-in-path test at no cost, which is the single most common Windows packaging bug and was
 * otherwise tested nowhere.
 *
 * THE ENVIRONMENT IS CONSTRUCTED, NEVER SPREAD. `{...process.env, HOME: fake}` would inherit the
 * developer's GEMINI_API_KEY, their CMR_* overrides and their telemetry directory, and the suite
 * would pass for the wrong reason — or fail only on someone else's machine. So the map is built
 * from nothing, carrying only what Node needs to start.
 *
 * Both HOME and USERPROFILE are set. `os.homedir()` reads USERPROFILE on Windows and HOME on
 * POSIX, so setting one leaves the other platform reading the real home directory.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Variables without which a Node child process will not start. Nothing else is inherited. */
function baseEnv() {
  const env = { PATH: process.env.PATH ?? '' }
  // Required for a Node child to launch on Windows.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT
  // Node reads these when it cannot find a home directory; left OUT on purpose so
  // helpers/homedir-probe.mjs can prove os.homedir() resolves to the fake home.
  return env
}

/**
 * @param {object} [opts]
 * @param {string} [opts.label]      a short name, to make a leftover directory identifiable
 * @param {object} [opts.env]        extra variables to add to the constructed environment
 * @param {boolean} [opts.withSpace] include a space in a path component (default true)
 */
export function makeCleanInstall({ label = 'clean', env: extra = {}, withSpace = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cmr-${label}-`))
  // The space lives in a nested component rather than the mkdtemp name, so the prefix stays
  // greppable if one ever survives a crash.
  const inner = withSpace ? 'install root' : 'install-root'
  const base = path.join(root, inner)
  const home = path.join(base, 'home')
  const projectDir = path.join(base, 'project')
  const storeDir = path.join(base, 'store')
  const govDir = path.join(base, 'governance')

  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  // storeDir and govDir are deliberately NOT created: whether something creates them is the claim
  // several of these tests make.

  const env = {
    ...baseEnv(),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_PROJECT_DIR: projectDir,
    CMR_TELEMETRY_DIR: storeDir,
    CMR_BUDGET_STATE_DIR: govDir,
    ...extra,
  }

  return {
    root,
    base,
    home,
    projectDir,
    storeDir,
    govDir,
    env,

    /** Write a project config, as a developer would. */
    writeProjectConfig(data) {
      const dir = path.join(projectDir, '.claude')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'model-router.json')
      fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      return file
    },

    /** Write a per-developer config, as a developer would. */
    writeUserConfig(data) {
      const dir = path.join(home, '.claude', 'model-router')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'config.json')
      fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
      return file
    },

    /**
     * A sorted `relpath:size` listing of everything under `root`.
     *
     * Sizes, not mtimes: an mtime comparison is flaky and an mtime change is not the thing being
     * claimed. Bytes are.
     */
    snapshot(at = root) {
      const out = []
      const walk = (dir, prefix) => {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : 1,
        )) {
          const full = path.join(dir, entry.name)
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) {
            out.push(`${rel}/`)
            walk(full, rel)
          } else {
            out.push(`${rel}:${fs.statSync(full).size}`)
          }
        }
      }
      walk(at, '')
      return out
    },

    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        // A locked file on Windows must not fail the test that already passed.
      }
    },
  }
}

/** Absolute path to a shipped script, for spawning. */
export function scriptPath(rel) {
  return path.join(REPO_ROOT, rel)
}
