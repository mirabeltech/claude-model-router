/**
 * Identity fields under the privacy settings.
 *
 * `telemetry.privacyLevel` defaults to `hashed`, which means the store holds no raw paths, no
 * prompts and no content. Writing a raw project path by default would break that promise, so
 * identity is salted-hashed here and the raw value only appears when a store* flag opts in.
 *
 * THE FAILURE RULE: if a salt cannot be obtained, the id is NULL — never the raw value, and never
 * an unsalted hash. A hash that silently loses its salt is reversible for any path an attacker can
 * guess, which is most of them. Failing closed on the id while the event still writes keeps the
 * privacy promise without costing the measurement.
 *
 * The salt is not a secret in the cryptographic sense; it exists so that a project path cannot be
 * recovered from a hash by trying candidates. It is created with 0600 where the platform honours
 * it, and that is all the protection it needs.
 */

import crypto from 'node:crypto'
import fsDefault from 'node:fs'
import path from 'node:path'

export const SALT_FILENAME = '.salt'
export const TEAM_SALT_RELATIVE = path.join('.claude', 'model-router.salt')
const SALT_BYTES = 32
const ID_HEX_CHARS = 32

/** Cached per process and per path: a hook must not re-read the salt for every event. */
const saltCache = new Map()

/**
 * Where the salt lives.
 *
 * `install` keeps hashes machine-local. `team` points at a path inside the project so a team can
 * commit one salt and have their hashes align across developers — which only works if they
 * actually commit it, and that is documented rather than enforced.
 */
export function saltPath({ scope = 'install', telemetryDir, projectDir }) {
  if (scope === 'team' && projectDir) return path.join(projectDir, TEAM_SALT_RELATIVE)
  return path.join(telemetryDir, SALT_FILENAME)
}

/**
 * Read the salt, creating it if absent. Synchronous and never throws; returns null on any failure.
 *
 * The create path uses flag 'wx' so two processes racing to create the salt cannot clobber each
 * other — the loser gets EEXIST and re-reads what the winner wrote, which is what keeps hashes
 * stable across concurrent hooks.
 */
export function readOrCreateSalt({ file, fs = fsDefault, randomBytes = crypto.randomBytes }) {
  if (saltCache.has(file)) return saltCache.get(file)

  const remember = (value) => {
    saltCache.set(file, value)
    return value
  }

  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing.length >= 16) return remember(existing)
  } catch {
    // Absent or unreadable; fall through to the create attempt.
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const salt = randomBytes(SALT_BYTES).toString('hex')
    fs.writeFileSync(file, `${salt}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return remember(salt)
  } catch {
    // Lost the create race, or the directory is read-only. One re-read covers the race.
    try {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return remember(existing)
    } catch {
      /* genuinely unavailable */
    }
    return remember(null)
  }
}

/** HMAC-SHA256, hex, truncated. Null salt or empty value yields null — never a raw passthrough. */
export function hashId(value, salt) {
  if (salt === null || salt === undefined || salt === '') return null
  if (typeof value !== 'string' || value === '') return null
  return crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, ID_HEX_CHARS)
}

export function __resetSaltCacheForTests() {
  saltCache.clear()
}

/**
 * Build the three identity fields for one event.
 *
 * `project_path` is the only field that can carry a raw string, and only on an explicit opt-in:
 *   storeFilePaths   -> the full resolved project directory
 *   storeProjectLabel -> the directory's basename only (a label, not a path)
 *   neither           -> null
 *
 * `privacy_level` is stamped onto the event separately so a reader can tell "null because the
 * operator chose privacy" from "null because we failed to measure it". Those are very different
 * facts and a bare null cannot distinguish them.
 *
 * @returns {{session_id: string|null, project_id: string|null, project_path: string|null,
 *            salt_available: boolean}}
 */
export function buildIdentity({
  config,
  sessionId = null,
  projectDir = null,
  fs = fsDefault,
  randomBytes = crypto.randomBytes,
}) {
  const t = config?.telemetry ?? {}
  const telemetryDir = t.dirResolved ?? t.dir ?? '.'
  const dir = projectDir ?? config?.projectDir ?? null

  const salt = readOrCreateSalt({
    file: saltPath({ scope: t.saltScope ?? 'install', telemetryDir, projectDir: dir }),
    fs,
    randomBytes,
  })

  let projectPath = null
  if (dir) {
    if (t.storeFilePaths === true) projectPath = dir
    else if (t.storeProjectLabel === true) projectPath = path.basename(dir)
  }

  return {
    session_id: hashId(sessionId, salt),
    project_id: hashId(dir, salt),
    project_path: projectPath,
    salt_available: salt !== null,
  }
}
