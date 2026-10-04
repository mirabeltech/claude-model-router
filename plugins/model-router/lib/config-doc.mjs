/**
 * The settings reference in docs/configuration.md, generated from the same `SPEC` table that
 * enforces validation at runtime.
 *
 * WHY GENERATE IT. The hand-written version documented 16 of 77 settings and said "Not written
 * yet" at the top. A reference that covers a fifth of the surface is worse than none, because a
 * reader cannot tell which fifth — and the only way a 77-row table stays true after a SPEC change
 * is if nobody has to remember to update it. `gen-config-schema.mjs` already established the
 * pattern: generate, then gate on `git diff --exit-code`.
 *
 * WHAT IS NOT GENERATED. Only the table. The prose above the sentinel — precedence, the two file
 * paths, the no-interpolation rule, secrets — is hand-written, because a generated table is a
 * reference and a reference teaches nothing on its own. Completeness and explanation are
 * different jobs and splitting them is what keeps both honest.
 *
 * Pure: no node builtin, no I/O.
 */

import { SPEC, DEFAULTS, CONFIG_VERSION } from './config.mjs'
import { DESCRIPTIONS } from './config-descriptions.mjs'

export const DOC_SENTINEL = '<!-- generated: everything below this line comes from SPEC. Do not edit by hand. -->'

/** Section order, and the heading each group gets. A leaf outside these is a generator error. */
const GROUPS = Object.freeze([
  ['enabled', 'Master switch', 'One setting, and the only one that turns the whole gate off.'],
  ['worker', 'Worker', 'The default worker every lane inherits unless it names its own.'],
  [
    'workers',
    'Per-lane workers',
    'Each lane may name its own worker. A lane that names a provider does NOT inherit the global model, and `apiKeyEnv` is inherited whenever the provider is — harmless, because a provider that wants no key is never asked for one.',
  ],
  ['providers', 'Providers', 'Per-provider endpoints and capabilities.'],
  [
    'routing',
    'Routing',
    'What the gate considers delegation-worthy. Changing a threshold requires a negative eval proving the system still refuses to delegate reasoning work.',
  ],
  ['hooks', 'Hook', 'The Claude Code adapter, and what it is allowed to send.'],
  [
    'verify',
    'Answer verification',
    'Checking the worker answer against the file it summarised, before that answer replaces the file in Claude context. Deterministic and on by default: a wrong summary is the one failure a developer cannot see, and the file is still in hand. A false positive costs one wasted worker call; a false negative poisons the context.',
  ],
  [
    'budget',
    'Governance',
    'Every limit ships `null`, meaning no configured limit — which is NOT `0`, a deliberately configured zero budget. Governance runs AFTER routing has ruled and can never rewrite its answer.',
  ],
  ['telemetry', 'Telemetry', 'What is recorded locally. There is no remote sink.'],
  [
    'pricing',
    'Pricing',
    'Every bundled rate is `null`, so worker cost is reported as NULL rather than guessed.',
  ],
  ['version', 'File version', ''],
])

function groupOf(field) {
  const head = field.split('.')[0]
  return GROUPS.findIndex(([prefix]) => prefix === head)
}

function defaultOf(field) {
  return field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS)
}

/** A default rendered so `null` and `0` can never be confused with each other or with absence. */
export function renderDefault(value) {
  if (value === undefined) return '—'
  if (value === null) return '`null`'
  if (Array.isArray(value)) return value.length === 0 ? '`[]`' : `${value.length} entries`
  return `\`${JSON.stringify(value)}\``
}

/** The legal range or value set, in the shortest form that is still exact. */
export function renderConstraint(spec) {
  if (spec.type === 'enum') return (spec.values ?? []).map((v) => `\`${v}\``).join(', ')
  const bits = []
  if (spec.min !== undefined) bits.push(`min ${spec.min}`)
  if (spec.max !== undefined) bits.push(`max ${spec.max}`)
  if (spec.nonEmpty) bits.push('non-empty')
  if (spec.nullable) bits.push('nullable')
  return bits.join(', ') || '—'
}

const ESCAPE = /\|/g

/**
 * The generated region, as exact bytes.
 *
 * Throws on a SPEC leaf with no description. That turns an undocumented setting from a silent gap
 * into a build error, which is the only reason this table can be trusted to be complete.
 */
export function serializeConfigMarkdown() {
  const fields = Object.keys(SPEC)
  const undocumented = fields.filter((f) => !DESCRIPTIONS[f])
  if (undocumented.length > 0) {
    throw new Error(
      `these settings have no description in lib/config-descriptions.mjs, so the reference would ` +
        `ship an undocumented setting: ${undocumented.join(', ')}`,
    )
  }
  const ungrouped = fields.filter((f) => groupOf(f) === -1)
  if (ungrouped.length > 0) {
    throw new Error(`these settings belong to no documented group: ${ungrouped.join(', ')}`)
  }

  const out = [DOC_SENTINEL, '']
  out.push(
    `Generated from \`SPEC\` in \`plugins/model-router/lib/config.mjs\`. ${fields.length} settings,`,
    `config version ${CONFIG_VERSION}. Regenerate with \`npm run docs:config\`; CI fails on a stale file.`,
    '',
  )

  GROUPS.forEach(([prefix, title, blurb], index) => {
    const rows = fields.filter((f) => groupOf(f) === index)
    if (rows.length === 0) return
    out.push(`### ${title}`, '')
    if (blurb) out.push(blurb, '')
    out.push('| Setting | Type | Default | Range | Env var | Meaning |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const field of rows) {
      const spec = SPEC[field]
      const env = spec.env ? `\`${spec.env}\`` : '—'
      const meaning = String(DESCRIPTIONS[field]).replace(ESCAPE, '\\|')
      out.push(
        `| \`${field}\` | ${spec.type} | ${renderDefault(defaultOf(field))} | ` +
          `${renderConstraint(spec)} | ${env} | ${meaning} |`,
      )
    }
    out.push('')
  })

  return out.join('\n')
}
