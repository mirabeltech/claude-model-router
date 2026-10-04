/**
 * The glob matcher.
 *
 * `routing.denyGlobs` is a security control, so its matcher gets tested as one: the positive cases
 * prove it fires, and the negative cases prove it is not just matching everything. The semantics
 * that look arbitrary — zero-or-more `**`, case-insensitivity, unsupported syntax reported rather
 * than ignored — each get a named test, because each exists to close a specific hole.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  globToRegExp,
  matchesAny,
  matchesGlob,
  normalizeSlashes,
  relativeTo,
  unsupportedSyntax,
} from '../plugins/model-router/lib/globs.mjs'

/* ------------------------------------------------------------- normalization */

test('a path has exactly one spelling: forward slashes, lower case, no trailing separator', () => {
  assert.equal(normalizeSlashes('C:\\Proj\\Src\\A.TS'), 'c:/proj/src/a.ts')
  assert.equal(normalizeSlashes('a//b///c'), 'a/b/c')
  assert.equal(normalizeSlashes('a/b/'), 'a/b')
  assert.equal(normalizeSlashes('/'), '/')
})

test('normalizing a non-string yields the empty string rather than throwing', () => {
  for (const v of [null, undefined, 7, {}, []]) assert.equal(normalizeSlashes(v), '')
})

/* --------------------------------------------------------------------- `**` */

test('a leading ** matches zero segments, so **/.env catches a root-level .env', () => {
  // The one-or-more reading would leave the most obvious secret in the repo unprotected by the
  // most obvious pattern for it.
  assert.equal(matchesGlob('**/.env', '.env'), true)
  assert.equal(matchesGlob('**/.env', 'a/.env'), true)
  assert.equal(matchesGlob('**/.env', 'a/b/c/.env'), true)
  assert.equal(matchesGlob('**/.env', '/abs/path/.env'), true)
})

test('** in the middle of a pattern spans zero or more segments', () => {
  assert.equal(matchesGlob('src/**/x.ts', 'src/x.ts'), true)
  assert.equal(matchesGlob('src/**/x.ts', 'src/a/b/x.ts'), true)
  assert.equal(matchesGlob('src/**/x.ts', 'lib/a/x.ts'), false)
})

test('a trailing ** spans the rest of the path, separators included', () => {
  assert.equal(matchesGlob('src/**', 'src/a/b/c.ts'), true)
  assert.equal(matchesGlob('src/**', 'src/a.ts'), true)
  assert.equal(matchesGlob('src/**', 'lib/a.ts'), false)
})

test('a ** segment requires something after it when a separator follows', () => {
  assert.equal(matchesGlob('**/.git/**', 'repo/.git/config'), true)
  assert.equal(matchesGlob('**/.git/**', 'repo/.git'), false)
})

/* ----------------------------------------------------------------- `*` and `?` */

test('a single star never crosses a separator', () => {
  assert.equal(matchesGlob('src/*', 'src/a.ts'), true)
  assert.equal(matchesGlob('src/*', 'src/a/b.ts'), false)
  assert.equal(matchesGlob('*.ts', 'a.ts'), true)
  assert.equal(matchesGlob('*.ts', 'dir/a.ts'), false)
})

test('a question mark matches exactly one character and never a separator', () => {
  assert.equal(matchesGlob('a?c', 'abc'), true)
  assert.equal(matchesGlob('a?c', 'ac'), false)
  assert.equal(matchesGlob('a?c', 'abbc'), false)
  assert.equal(matchesGlob('a?c', 'a/c'), false)
})

test('a star matches an empty run', () => {
  assert.equal(matchesGlob('**/.env*', 'x/.env'), true)
  assert.equal(matchesGlob('**/.env*', 'x/.env.local'), true)
})

/* -------------------------------------------------------- case insensitivity */

test('matching is case-insensitive, because NTFS and APFS are', () => {
  // A case-sensitive matcher lets `.ENV` through on the platform where it is the same file.
  assert.equal(matchesGlob('**/.env', 'A/B/.ENV'), true)
  assert.equal(matchesGlob('**/*.PEM', 'certs/server.pem'), true)
  assert.equal(matchesGlob('**/SECURITY/**', 'src/security/csp.ts'), true)
})

/* ----------------------------------------------------- separator independence */

test('a Windows path cannot evade a forward-slash pattern', () => {
  assert.equal(matchesGlob('**/.git/**', 'C:\\repo\\.git\\config'), true)
})

test('a pattern written with backslashes still matches a forward-slash path', () => {
  assert.equal(matchesGlob('**\\auth\\**', 'app/auth/login.ts'), true)
})

/* -------------------------------------------------------------- literal safety */

test('a dot in a pattern is a literal dot, not a wildcard', () => {
  assert.equal(matchesGlob('**/*.key', 'certs/server.key'), true)
  assert.equal(matchesGlob('**/*.key', 'certs/serverXkey'), false)
})

test('regex metacharacters in a path cannot change the meaning of a pattern', () => {
  assert.equal(matchesGlob('**/a+b.ts', 'x/a+b.ts'), true)
  assert.equal(matchesGlob('**/a+b.ts', 'x/aab.ts'), false)
})

/* -------------------------------------------------------- unsupported syntax */

test('brace expansion, character classes and negation are reported as unsupported', () => {
  // Silence here is a safety hole with no symptom: someone writing `**/*.{pem,key}` would get no
  // protection and no signal.
  for (const p of ['**/*.{pem,key}', '**/[abc].ts', '!**/*.ts', '**/(a|b).ts']) {
    assert.equal(unsupportedSyntax(p), true, `${p} should be reported`)
  }
})

test('an ordinary pattern is not reported as unsupported', () => {
  for (const p of ['**/.env*', '**/*secret*', 'src/**', 'a?c.ts', '**/id_rsa*']) {
    assert.equal(unsupportedSyntax(p), false, `${p} should be supported`)
  }
})

test('an unsupported pattern matches literally rather than matching everything', () => {
  // Degrading to "matches nothing useful" is safe; degrading to "matches all" would block every
  // read in the project.
  assert.equal(matchesGlob('**/*.{pem,key}', 'certs/server.pem'), false)
  assert.equal(matchesGlob('**/*.{pem,key}', 'certs/server.{pem,key}'), true)
})

/* ---------------------------------------------------------------- robustness */

test('an unusable pattern compiles to null and therefore matches nothing', () => {
  assert.equal(globToRegExp(''), null)
  assert.equal(globToRegExp(null), null)
  assert.equal(globToRegExp('a'.repeat(2000)), null, 'an absurd pattern is refused, not compiled')
  assert.equal(matchesGlob('', 'anything'), false)
})

test('an empty path matches nothing, so an unnamed file is never deny-glob clean by accident', () => {
  assert.equal(matchesGlob('**/.env', ''), false)
  assert.equal(matchesGlob('**', ''), false)
})

test('an adversarial path terminates promptly — the matcher cannot backtrack catastrophically', () => {
  const path = `${'a/'.repeat(500)}b.ts`
  const started = Number(process.hrtime.bigint() / 1000000n)
  assert.equal(matchesGlob('**/*.ts', path), true)
  assert.equal(matchesGlob('**/x/**/y/**/z.ts', path), false)
  const elapsed = Number(process.hrtime.bigint() / 1000000n) - started
  assert.ok(elapsed < 1000, `matching took ${elapsed}ms`)
})

test('compiling the same pattern twice returns the identical RegExp, so the cache is in use', () => {
  assert.equal(globToRegExp('**/cache-probe.ts'), globToRegExp('**/cache-probe.ts'))
})

/* ------------------------------------------------------------------ matchesAny */

test('matchesAny returns the first matching pattern, not a boolean', () => {
  // Returning the pattern is what lets a decision name which deny rule fired.
  assert.equal(matchesAny(['**/*.ts', '**/.env'], '/x/.env'), '**/.env')
  assert.equal(matchesAny(['**/.env', '**/.env*'], '/x/.env'), '**/.env', 'first match wins')
})

test('matchesAny returns null for no match and for a non-list', () => {
  assert.equal(matchesAny(['**/*.ts'], '/x/.env'), null)
  assert.equal(matchesAny(null, '/x/.env'), null)
  assert.equal(matchesAny('**/*.ts', '/x/a.ts'), null)
})

/* ------------------------------------------------------------------ relativeTo */

test('relativeTo strips the project root so a project-relative pattern works', () => {
  assert.equal(relativeTo('/proj', '/proj/src/a.ts'), 'src/a.ts')
  assert.equal(relativeTo('C:\\proj', 'C:/Proj/Src/A.ts'), 'src/a.ts')
})

test('relativeTo returns null when the path is not under the root', () => {
  assert.equal(relativeTo('/proj', '/other/a.ts'), null)
  assert.equal(relativeTo('/proj', '/projection/a.ts'), null, 'a prefix is not a parent directory')
  assert.equal(relativeTo(null, '/proj/a.ts'), null)
  assert.equal(relativeTo('/proj', '/proj'), null)
})

/* -------------------------------------------- the shipped list, pattern by pattern */

const SHIPPED = Object.freeze([
  ['**/.env*', ['.env', 'a/.env.local', 'deep/path/.environment'], ['src/env.ts', 'a/denv']],
  ['**/*secret*', ['secrets.ts', 'a/my-secret-file.js'], ['a/sekret.ts', 'a/secrt.ts']],
  ['**/*credential*', ['credentials.json', 'a/aws-credentials'], ['a/creds.json']],
  ['**/*.pem', ['server.pem', 'certs/a.pem'], ['server.pem.bak', 'pem']],
  ['**/*.key', ['server.key', 'certs/a.key'], ['server.keys', 'key']],
  ['**/id_rsa*', ['id_rsa', '.ssh/id_rsa.pub'], ['.ssh/known_hosts', 'rsa_id']],
  ['**/.git/**', ['.git/config', 'repo/.git/refs/heads/main'], ['.git', 'repo/gitignore']],
  ['**/auth/**', ['auth/login.ts', 'app/auth/x/y.ts'], ['author.ts', 'app/authentication.ts']],
  ['**/security/**', ['security/csp.ts', 'src/security/x.ts'], ['secure.ts', 'src/securities.ts']],
])

for (const [pattern, hits, misses] of SHIPPED) {
  test(`${pattern} matches what it must and nothing it must not`, () => {
    for (const p of hits) assert.equal(matchesGlob(pattern, p), true, `${pattern} missed ${p}`)
    for (const p of misses) assert.equal(matchesGlob(pattern, p), false, `${pattern} over-matched ${p}`)
  })
}
