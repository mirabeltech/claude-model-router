/**
 * What each setting MEANS, in one table.
 *
 * Extracted so the published JSON Schema and the generated reference in
 * docs/configuration.md read the SAME source. Two copies of this would drift, and the drift would
 * be invisible: a schema and a document can disagree for a long time before anyone notices, which
 * is the exact failure `gen-config-schema.mjs` exists to prevent for the rules.
 *
 * Keys are SPEC field paths. A leaf with no entry here fails the documentation generator rather
 * than silently shipping an undocumented setting.
 */
export const DESCRIPTIONS = Object.freeze({
  'version': 'Config schema version of this file. Bumped only when a setting changes meaning; a mismatch is reported, never silently migrated.',
  'worker.timeoutMs': 'How long one worker call may take. A ceiling for a script, deliberately generous: the HOOK deadline is the tighter of the two and is what actually bounds a delegated read. A value above the HTTP client ceiling is reported, because the call would be abandoned there instead.',
  'worker.maxRetries': 'Retries after a failed worker call. A retry is only attempted for a failure that could plausibly succeed again; a refusal is never retried.',
  'worker.maxInputBytes': 'TRANSPORT ceiling in BYTES for one request body. This is not a context window and no context arithmetic may read it: a provider can accept two megabytes of body and still refuse a prompt that does not fit its window.',
  'worker.temperature': 'Sampling temperature for the worker. Low by default: these are extraction and boilerplate tasks, where a confident consistent answer beats a creative one.',
  'worker.maxOutputTokens': 'Upper bound on the worker answer. Capped automatically when the context window is known and the full request would not fit, because making room for the answer is preferable to refusing the call.',
  'providers.gemini.baseUrl': 'Gemini API base URL. Override to reach a proxy or a regional endpoint.',
  'providers.ollama.baseUrl': 'Ollama daemon URL. The default is loopback, so nothing leaves the machine.',
  'providers.ollama.model': 'Default Ollama model, used when a lane names the provider but no model of its own.',
  'routing.bulkRead.enabled': 'Whether the bulk-read gate is consulted at all. Disabling it is narrower than disabling routing entirely.',
  'routing.bulkRead.maxFiles': 'Above this many files in one read, the gate declines to delegate: a request that broad is usually exploration, where Claude reading directly is the better answer.',
  'routing.codeWrite.enabled': 'Whether the code-write lane is consulted. Advisory today — no interception ships for it.',
  'routing.allowGlobs': 'Paths that may be delegated even when another rule would decline. Narrow this deliberately: it is the only setting that can override a refusal, and it cannot override the deny list.',
  'telemetry.enabled': 'Whether a row is written per delegation. Disabling it leaves routing untouched and makes analytics and the report empty.',
  'telemetry.sink': 'Where rows go. jsonl is the shipped store; null discards them. A sink that is not implemented falls back and reports the fallback rather than failing a hook.',
  'telemetry.rotation': 'daily writes one dated segment per UTC day. none writes a single undated file and makes retention a COMPLETE NO-OP, because pruning selects by the date in the filename.',
  'telemetry.retentionDays': 'How long a segment is kept by npm run prune. It has no effect at all when rotation is none, since an undated segment can never be selected.',
  'telemetry.storeProjectLabel': 'Store a readable project label beside the hashed id. Off by default: a hashed id is enough to group by.',
  'telemetry.storeFilePaths': 'Store file paths as they were read, instead of salted hashes. Off by default. This is the single largest increase in what a shared report reveals.',
  'telemetry.storeGitBranch': 'Store the git branch on each row. Off by default: a branch name often carries a ticket id or a customer name.',
  'telemetry.questionTextMaxChars': 'Clamp on stored question text. Only consulted when storeQuestionText is on.',
  'telemetry.storeErrorDetail': 'Store provider error bodies verbatim. Off by default, because an error body can echo the request.',
  'telemetry.storeContentHash': 'Store a hash of the delegated content, so repeat reads of the same bytes can be recognised. A hash, never the content.',
  'pricing.source': 'Which pricing table to use. bundled ships every rate as null, so cost is reported as NULL rather than guessed; file reads the table named by pricing.overrides.',
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
  'routing.bulkRead.enforce': 'deny blocks the read and returns the worker answer in its place; ask prompts; suggest only advises; off disables the gate.',
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
})
