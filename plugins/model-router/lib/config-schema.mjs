/**
 * Builds the published JSON Schema from the same SPEC table that drives runtime
 * validation, so the schema an editor autocompletes against and the rules the
 * loader enforces cannot drift apart. `scripts/gen-config-schema.mjs` writes the
 * result to config.schema.json and a test asserts the committed file matches.
 */

import { SPEC, DEFAULTS, CONFIG_VERSION } from './config.mjs'

const TYPE_MAP = {
  bool: { type: 'boolean' },
  int: { type: 'integer' },
  number: { type: 'number' },
  string: { type: 'string' },
  enum: { type: 'string' },
  'string[]': { type: 'array', items: { type: 'string' } },
}

const DESCRIPTIONS = {
  'enabled': 'Master switch for routing. Disable to make the gate allow every read.',
  'worker.provider': 'Worker provider id, resolved through lib/providers/index.mjs.',
  'worker.model': 'Worker model id as the provider names it.',
  'worker.apiKeyEnv': 'Name of the environment variable holding the worker API key. The key itself is never stored in config.',
  'providers.ollama.contextTokens': 'Context window of the Ollama model, in tokens. null means unknown, and unknown is never treated as infinite: the window is discovered from the daemon, then looked up in the bundled table, and a request that still cannot be shown to fit is refused rather than silently truncated. Set this to override both.',
  'providers.ollama.discoverContext': 'Ask the Ollama daemon for the model context window via /api/show. One cached localhost call per model per process, made after the routing gate has already approved delegation. Disable to rely on providers.ollama.contextTokens and the bundled table alone.',
  'workers.bulkRead.provider': 'Provider for the bulk-reader mode. null inherits worker.provider. Setting it also stops model and apiKeyEnv being inherited, because neither means anything across a provider change.',
  'workers.bulkRead.model': 'Model for the bulk-reader mode. null inherits worker.model when the provider is also inherited, otherwise providers.<id>.model.',
  'workers.bulkRead.apiKeyEnv': 'API key variable for the bulk-reader mode. null inherits worker.apiKeyEnv only when the provider is also inherited.',
  'workers.bulkRead.timeoutMs': 'Timeout for the bulk-reader mode. null inherits worker.timeoutMs; a millisecond budget carries no provider identity, so it always inherits.',
  'workers.codeWrite.provider': 'Provider for the code-writer mode. null inherits worker.provider. Setting it also stops model and apiKeyEnv being inherited, because neither means anything across a provider change.',
  'workers.codeWrite.model': 'Model for the code-writer mode. null inherits worker.model when the provider is also inherited, otherwise providers.<id>.model.',
  'workers.codeWrite.apiKeyEnv': 'API key variable for the code-writer mode. null inherits worker.apiKeyEnv only when the provider is also inherited.',
  'workers.codeWrite.timeoutMs': 'Timeout for the code-writer mode. null inherits worker.timeoutMs; a millisecond budget carries no provider identity, so it always inherits.',
  'routing.bulkRead.enforce': 'deny blocks the read and steers to the skill; ask prompts; suggest only advises; off disables the gate.',
  'routing.bulkRead.minLines': 'Line count above which a full-file read is gated.',
  'routing.bulkRead.minBytes': 'Byte size gate, checked before line counting so the hook stays fast.',
  'routing.bulkRead.minEstimatedTokens': "Third size proxy, OR'd with minLines and minBytes. null disables it; it never satisfies while unset.",
  'routing.bulkRead.minFiles': 'Minimum file count for a bulk-read question. 1 is a no-op; raising it only narrows delegation.',
  'routing.codeWrite.enforce': 'Advisory by design: a hook cannot know a Write is boilerplate before it exists.',
  'hooks.enabled': 'Whether the PreToolUse hook intercepts Read at all. false leaves routing, telemetry and the scripts intact and stops only the interception.',
  'hooks.taskIntent.source':
    "Where the worker's task comes from. 'none' sends a fixed generic task and is the default. "
    + "'transcript' recovers the newest prompt from the session transcript the hook is already "
    + 'given, so the worker is told what is actually being looked for — which also means your '
    + 'prompt text is sent to the worker model. Opt in deliberately.',
  'hooks.taskIntent.maxChars':
    'Ceiling on how much recovered prompt text may be sent to the worker. Longer intent is '
    + 'truncated, never dropped.',
  'hooks.timeoutMs': "The hook's own deadline for a delegated read, which is not the worker's. Past it the hook abandons the worker call and falls open to the original Read, so an interactive read is never blocked for longer than this.",
  'telemetry.recordGateDecisions': 'Whether a refusal writes a gate_block row as well as a delegation writing its own. Off, the store holds delegations only and the refusal denominator is lost.',
  'routing.denyGlobs': 'Paths that are never delegated. Security-critical content must not leave for a third-party worker.',
  'routing.neverDelegate.onTargetedRead': 'Treat an offset/limit read as intentional and never delegate it.',
  'routing.neverDelegate.onRecentlyEdited': 'Never delegate a file edited this session; Claude needs exact bytes.',
  'budget.enabled': 'Master switch for budget governance. Off, no limit is evaluated and no accounting state is read or written.',
  'budget.run.maxWorkerCostUsd': 'Ceiling on the worker cost of one delegation. null means no configured limit; 0 means a configured zero budget. Unenforceable while the model is unpriced, because an unknown cost is not a zero cost.',
  'budget.run.maxInputTokens': 'Ceiling on worker INPUT tokens for one delegation. Governance asks whether this is allowed; the context model separately asks whether it fits.',
  'budget.run.maxOutputTokens': 'Ceiling on worker OUTPUT tokens for one delegation.',
  'budget.run.maxTotalTokens': 'Ceiling on total worker tokens for one delegation. The narrowest runaway guard, since a per-run limit needs no persisted state.',
  'budget.daily.maxWorkerCostUsd': 'Ceiling on worker cost per UTC day. null means no configured limit.',
  'budget.daily.maxTotalTokens': 'Ceiling on total worker tokens per UTC day.',
  'budget.monthly.maxWorkerCostUsd': 'Ceiling on worker cost per UTC month. null means no configured limit.',
  'budget.monthly.maxTotalTokens': 'Ceiling on total worker tokens per UTC month.',
  'budget.onExceed': 'What a reached limit does. disable denies delegation and the request continues on plain Claude Code; warn records the breach and delegates anyway. Neither fails the request.',
  'budget.onUnknownCost': 'What to do when a monetary budget is configured but the worker cost is unknown. allow records the fact and proceeds, keeping an unpriced provider usable; deny is the opt-in for an exactly enforced ceiling. A structurally free local provider is not "unknown" and is unaffected.',
  'budget.onUnknownUsage': 'What to do when a provider reports no token usage. Under allow such a provider can never exhaust a token budget, which is a documented exposure rather than an oversight; deny is the strict setting.',
  'budget.stateDir': 'Where the budget accounting ledger lives. Separate from the telemetry store: telemetry records what happened, this is small mutable state about what is allowed.',
  'telemetry.dir': 'Durable JSONL store. Defaults outside the plugin data dir so it survives uninstall.',
  'telemetry.shardByPid': 'Write one file per process. Enable on OneDrive, SMB or mapped drives where append atomicity is not guaranteed.',
  'telemetry.primaryModel': 'Counterfactual model. null means resolve it from the session transcript; it is never guessed.',
  'telemetry.avoidedMethod': 'How primary-model tokens are counted. chars_div_4 under-counts source code, so savings err low.',
  'telemetry.counterfactualRender': 'raw ignores Read line-number overhead (conservative); read_tool includes it.',
  'telemetry.countProvenFilesOnly': 'Count only files a hook actually blocked. Inferred corpus files are the largest over-claim risk.',
  'telemetry.residencyTurns': 'Subsequent turns a landed corpus would have been re-sent for. Requires residencySource.',
  'telemetry.residencySource': 'Provenance for residencyTurns. A non-zero value with default_zero is refused at load time.',
  'telemetry.privacyLevel': 'hashed stores no content, paths or prompts. labeled and verbose are set by the store* flags.',
  'telemetry.saltScope': 'install keeps hashes machine-local; team shares a salt so hashes align across developers.',
  'telemetry.storeQuestionText': 'Opt in to storing a truncated, secret-scrubbed question. Sets privacyLevel to verbose.',
  'pricing.overrides': 'Path to a replacement pricing table. First match wins; tables are never merged.',
}

function leafSchema(field, spec) {
  const base = { ...TYPE_MAP[spec.type] }
  if (spec.type === 'enum') base.enum = spec.values
  if (spec.min !== undefined) base.minimum = spec.min
  if (spec.max !== undefined) base.maximum = spec.max
  if (spec.nonEmpty) base.minLength = 1

  if (spec.nullable) {
    // JSON Schema draft 2020-12: express nullability as a type union.
    base.type = [base.type, 'null']
  }

  const dflt = field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS)
  if (dflt !== undefined) base.default = dflt
  if (DESCRIPTIONS[field]) base.description = DESCRIPTIONS[field]
  if (spec.env) {
    base.description = `${base.description ? `${base.description} ` : ''}Env override: ${spec.env}.`
  }
  return base
}

export function buildJsonSchema() {
  const root = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/mirabeltech/claude-model-router/main/plugins/model-router/lib/config.schema.json',
    title: 'claude-model-router configuration',
    description:
      'Layered configuration for the model-router plugin. Resolution order, later wins: bundled defaults, ~/.claude/model-router/config.json, <project>/.claude/model-router.json, CMR_* environment variables, CLAUDE_PLUGIN_OPTION_*. An invalid field falls back to its default with a warning rather than failing a hook.',
    type: 'object',
    additionalProperties: false,
    'x-configVersion': CONFIG_VERSION,
    properties: {
      // Allowed explicitly: the root uses additionalProperties:false, and users
      // are told to add $schema so their editor can autocomplete this file.
      $schema: { type: 'string', description: 'Path or URL to this schema, for editor autocomplete.' },
    },
  }

  for (const [field, spec] of Object.entries(SPEC)) {
    const keys = field.split('.')
    let node = root
    for (const key of keys.slice(0, -1)) {
      node.properties[key] ??= { type: 'object', additionalProperties: false, properties: {} }
      node = node.properties[key]
    }
    node.properties[keys.at(-1)] = leafSchema(field, spec)
  }

  return root
}

export function serializeJsonSchema() {
  return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`
}
