# Configuration

Every setting, where to put it, and the three rules that explain most surprises.

New here? [getting-started.md](getting-started.md) gets you running first; come back when you want
to change something. Worked examples live in [`examples/`](../examples/), and
[`examples/README.md`](../examples/README.md) says which file goes where.

## The two files

Exactly two, and no others:

```
~/.claude/model-router/config.json      per developer, never committed
<project>/.claude/model-router.json     per project, commit this
```

There is **no upward directory walk**, no `CMR_CONFIG_FILE` escape hatch, and no other recognised
filename. A file in your project root rather than under `.claude/`, or named anything else, is
silently ignored — nothing warns, because nothing looked for it. If a change of yours seems to have
no effect, that is the first thing to check, and `npm run doctor` will tell you: it lists every
setting that came from somewhere other than the bundled defaults, so a setting you edited that is
missing from that list was never read.

Both files accept `//` and `/* */` comments, and a `$schema` key for editor autocompletion. Neither
is required.

## Precedence, lowest to highest

```
bundled defaults
  -> ~/.claude/model-router/config.json      (per developer)
  -> <project>/.claude/model-router.json     (per project, committed)
  -> CMR_* environment variables             (so CI can always win)
  -> plugin options                          (/plugin configure, or --config KEY=VALUE)
```

Each layer overrides the one above it, leaf by leaf. Setting `worker.model` in a project file leaves
`worker.provider` at whatever the layer above resolved.

Every setting has a `CMR_*` environment variable except `version`, so anything can be overridden
without touching a file — which is how CI pins behaviour and how the kill switches work. The full
list is in [environment.md](environment.md).

A handful of settings are also exposed as **plugin options**, editable with
`/plugin configure model-router@claude-model-router` or at install time with
`--config worker_provider=ollama`. That layer wins over everything, including environment
variables.

## Three rules that explain most surprises

**1. Arrays replace, they do not merge.** Setting `routing.denyGlobs` discards the built-in list
entirely rather than adding to it. This is why [`examples/model-router.json`](../examples/model-router.json)
repeats all nine shipped defaults before adding its own — deleting a line from that list turns a
protection off for everybody who uses the file.

**2. An invalid value never throws.** A leaf that fails validation falls back to its default and
records a warning; an unrecognised leaf is kept and reported as a probable typo. Nothing here can
block a session, because this module is loaded by a `PreToolUse` hook and an exception in it would
break the developer's editor. `npm run doctor` is where those warnings surface: a rejected value is
a FAIL, a typo is a WARN.

**3. No value is ever interpolated.** `"${GEMINI_API_KEY}"` is read as that literal
19-character string, not as the variable's value. The same goes for `$KEY` and `%KEY%`. This is the
most common way to get an authentication error that looks like a bad key, so `npm run doctor`
detects all three shapes by name and says what to do instead.

## Configuration versus secrets

**No config file can hold a secret.** There is no field that takes an API key. A key is named by
the environment variable that holds it, and the value is read from the environment at call time:

```jsonc
"worker": { "apiKeyEnv": "GEMINI_API_KEY" }   // the NAME, never the key
```

So a committed `model-router.json` is safe in a public repository. Set the variable where Claude
Code will see it:

```powershell
setx GEMINI_API_KEY "your-key"     # Windows: writes the user environment, NOT the
                                   # current shell. Restart Claude Code afterwards.
```

```bash
export GEMINI_API_KEY=your-key     # macOS/Linux: add it to your shell profile to persist
```

A **telemetry store** is a separate question from a config file. It is local-only and hashes paths
by default, but it is still a record of your work — see [telemetry-schema.md](telemetry-schema.md)
for exactly what a row can contain before you share a report.

## Two asymmetries worth knowing

**Lane inheritance.** A lane that names a provider does **not** inherit the global model, so
setting `workers.bulkRead.provider` without a model leaves that lane with no model resolved.
`worker.apiKeyEnv`, by contrast, *is* inherited whenever the provider is — so a lane running Ollama
still shows `GEMINI_API_KEY` as its key name. That is harmless: a provider that wants no key is
never asked for one, and doctor reports `none required`.

**Budget scopes.** `budget.run` takes four ceilings; `budget.daily` and `budget.monthly` take a
total-token ceiling and a cost ceiling **only**. A per-direction ceiling across a whole day has no
actionable remedy when you hit it, so it does not exist. `budget.daily.maxInputTokens` is therefore
an unknown field: it is dropped with a warning rather than silently enforced.

## The context window is three different numbers

What an operator configured, what the provider advertises, and what the runtime actually served are
three distinct facts and the code never conflates them. `providers.ollama.contextTokens` is the
first; `discoverContext` asks for the second; only a provider answer is ever labelled `measured`.

A configured value clamped by a discovered one stays labelled **configured**, because an operator's
assertion clamped by a measurement is still an assertion. And **unknown is never infinite**: a
request that cannot be shown to fit is refused rather than truncated. See
[worker-capability.md](worker-capability.md).

`worker.maxInputBytes` is a **transport** ceiling in bytes and takes no part in context arithmetic.
A provider can accept a two-megabyte body and still refuse a prompt that does not fit its window.

## Checking what resolved

```bash
npm run doctor               # what resolved, from which layer, and what is missing
npm run doctor -- --json     # the same, machine-readable
npm run budget               # the limits and the current UTC period's spend
```

## See also

- [environment.md](environment.md) — every environment variable, including the ones with no setting
- [governance.md](governance.md) — what a budget can and cannot enforce
- [providers.md](providers.md) — Ollama and Gemini setup
- [routing.md](routing.md) — what each routing threshold actually does
- [troubleshooting.md](troubleshooting.md) — when a setting appears to be ignored

## Every setting

<!-- generated: everything below this line comes from SPEC. Do not edit by hand. -->

Generated from `SPEC` in `plugins/model-router/lib/config.mjs`. 83 settings,
config version 1. Regenerate with `npm run docs:config`; CI fails on a stale file.

### Master switch

One setting, and the only one that turns the whole gate off.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `enabled` | bool | `true` | — | `CMR_ENABLED` | Master switch for routing. Disable to make the gate allow every read. |

### Worker

The default worker every lane inherits unless it names its own.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `worker.provider` | string | `"gemini"` | non-empty | `CMR_WORKER_PROVIDER` | Worker provider id, resolved through lib/providers/index.mjs. |
| `worker.model` | string | `"gemini-3.8-flash"` | non-empty | `CMR_WORKER_MODEL` | Worker model id as the provider names it. |
| `worker.apiKeyEnv` | string | `"GEMINI_API_KEY"` | non-empty | `CMR_WORKER_API_KEY_ENV` | Name of the environment variable holding the worker API key. The key itself is never stored in config. |
| `worker.timeoutMs` | int | `180000` | min 1000, max 1800000 | `CMR_WORKER_TIMEOUT_MS` | How long one worker call may take. A ceiling for a script, deliberately generous: the HOOK deadline is the tighter of the two and is what actually bounds a delegated read. A value above the HTTP client ceiling is reported, because the call would be abandoned there instead. |
| `worker.maxRetries` | int | `2` | min 0, max 10 | `CMR_WORKER_MAX_RETRIES` | Retries after a failed worker call. A retry is only attempted for a failure that could plausibly succeed again; a refusal is never retried. |
| `worker.maxInputBytes` | int | `2000000` | min 1024, max 50000000 | `CMR_WORKER_MAX_INPUT_BYTES` | TRANSPORT ceiling in BYTES for one request body. This is not a context window and no context arithmetic may read it: a provider can accept two megabytes of body and still refuse a prompt that does not fit its window. |
| `worker.temperature` | number | `0.2` | min 0, max 2 | `CMR_WORKER_TEMPERATURE` | Sampling temperature for the worker. Low by default: these are extraction and boilerplate tasks, where a confident consistent answer beats a creative one. |
| `worker.maxOutputTokens` | int | `8192` | min 1, max 1000000 | `CMR_WORKER_MAX_OUTPUT_TOKENS` | Upper bound on the worker answer. Capped automatically when the context window is known and the full request would not fit, because making room for the answer is preferable to refusing the call. |

### Per-lane workers

Each lane may name its own worker. A lane that names a provider does NOT inherit the global model, and `apiKeyEnv` is inherited whenever the provider is — harmless, because a provider that wants no key is never asked for one.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `workers.bulkRead.provider` | string | `null` | non-empty, nullable | `CMR_BULK_READ_WORKER_PROVIDER` | Provider for the bulk-reader mode. null inherits worker.provider. Setting it also stops model and apiKeyEnv being inherited, because neither means anything across a provider change. |
| `workers.bulkRead.model` | string | `null` | non-empty, nullable | `CMR_BULK_READ_WORKER_MODEL` | Model for the bulk-reader mode. null inherits worker.model when the provider is also inherited, otherwise providers.<id>.model. |
| `workers.bulkRead.apiKeyEnv` | string | `null` | non-empty, nullable | `CMR_BULK_READ_WORKER_API_KEY_ENV` | API key variable for the bulk-reader mode. null inherits worker.apiKeyEnv only when the provider is also inherited. |
| `workers.bulkRead.timeoutMs` | int | `null` | min 1000, max 1800000, nullable | `CMR_BULK_READ_WORKER_TIMEOUT_MS` | Timeout for the bulk-reader mode. null inherits worker.timeoutMs; a millisecond budget carries no provider identity, so it always inherits. |
| `workers.codeWrite.provider` | string | `null` | non-empty, nullable | `CMR_CODE_WRITE_WORKER_PROVIDER` | Provider for the code-writer mode. null inherits worker.provider. Setting it also stops model and apiKeyEnv being inherited, because neither means anything across a provider change. |
| `workers.codeWrite.model` | string | `null` | non-empty, nullable | `CMR_CODE_WRITE_WORKER_MODEL` | Model for the code-writer mode. null inherits worker.model when the provider is also inherited, otherwise providers.<id>.model. |
| `workers.codeWrite.apiKeyEnv` | string | `null` | non-empty, nullable | `CMR_CODE_WRITE_WORKER_API_KEY_ENV` | API key variable for the code-writer mode. null inherits worker.apiKeyEnv only when the provider is also inherited. |
| `workers.codeWrite.timeoutMs` | int | `null` | min 1000, max 1800000, nullable | `CMR_CODE_WRITE_WORKER_TIMEOUT_MS` | Timeout for the code-writer mode. null inherits worker.timeoutMs; a millisecond budget carries no provider identity, so it always inherits. |
| `workers.bulkRead.ladder` | string[] | `[]` | — | `CMR_BULK_READ_LADDER` | Escalation order for bulk reads: provider ids tried in turn when the previous answer fails verification. Empty means no escalation, which is the shipped behaviour. Claude itself is always the implicit last tier, because an exhausted ladder falls open to the developer own Read. |
| `workers.codeWrite.ladder` | string[] | `[]` | — | `CMR_CODE_WRITE_LADDER` | Escalation order for the code-write lane. That lane is unreachable today, so this is declared and inert. |

### Providers

Per-provider endpoints and capabilities.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `providers.gemini.baseUrl` | string | `"https://generativelanguage.googleapis.com/v1beta"` | non-empty | `CMR_GEMINI_BASE_URL` | Gemini API base URL. Override to reach a proxy or a regional endpoint. |
| `providers.gemini.model` | string | `"gemini-3.8-flash"` | non-empty | `CMR_GEMINI_MODEL` | Model used when a lane names the gemini provider without inheriting worker.model. gemini-3.8-flash: measured to keep more verified answers than gemini-3.1-flash-lite, which is about a third of the price but had about half its answers discarded by the verifier on the same file. |
| `providers.ollama.baseUrl` | string | `"http://127.0.0.1:11434"` | non-empty | `CMR_OLLAMA_BASE_URL` | Ollama daemon URL. The default is loopback, so nothing leaves the machine. |
| `providers.ollama.model` | string | `"qwen2.5-coder:7b"` | non-empty | `CMR_OLLAMA_MODEL` | Default Ollama model, used when a lane names the provider but no model of its own. |
| `providers.ollama.contextTokens` | int | `null` | min 256, max 10000000, nullable | `CMR_OLLAMA_CONTEXT_TOKENS` | Context window of the Ollama model, in tokens. null means unknown, and unknown is never treated as infinite: the window is discovered from the daemon, then looked up in the bundled table, and a request that still cannot be shown to fit is refused rather than silently truncated. Set this to override both. |
| `providers.ollama.discoverContext` | bool | `true` | — | `CMR_OLLAMA_DISCOVER_CONTEXT` | Ask the Ollama daemon for the model context window via /api/show. One cached localhost call per model per process, made after the routing gate has already approved delegation. Disable to rely on providers.ollama.contextTokens and the bundled table alone. |

### Routing

What the gate considers delegation-worthy. Changing a threshold requires a negative eval proving the system still refuses to delegate reasoning work.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `routing.bulkRead.enabled` | bool | `true` | — | `CMR_BULK_READ_ENABLED` | Whether the bulk-read gate is consulted at all. Disabling it is narrower than disabling routing entirely. |
| `routing.bulkRead.enforce` | enum | `"deny"` | `deny`, `ask`, `suggest`, `off` | `CMR_BULK_READ_ENFORCE` | deny blocks the read and returns the worker answer in its place; ask prompts; suggest only advises; off disables the gate. |
| `routing.bulkRead.minLines` | int | `350` | min 1, max 1000000 | `CMR_MIN_LINES` | Line count above which a full-file read is gated. |
| `routing.bulkRead.minBytes` | int | `12000` | min 1, max 100000000 | `CMR_MIN_BYTES` | Byte size gate, checked before line counting so the hook stays fast. |
| `routing.bulkRead.minEstimatedTokens` | int | `null` | min 1, max 100000000, nullable | `CMR_MIN_ESTIMATED_TOKENS` | Third size proxy, OR'd with minLines and minBytes. null disables it; it never satisfies while unset. |
| `routing.bulkRead.minFiles` | int | `1` | min 1, max 1000 | `CMR_MIN_FILES` | Minimum file count for a bulk-read question. 1 is a no-op; raising it only narrows delegation. |
| `routing.bulkRead.maxFiles` | int | `25` | min 1, max 1000 | `CMR_MAX_FILES` | Above this many files in one read, the gate declines to delegate: a request that broad is usually exploration, where Claude reading directly is the better answer. |
| `routing.codeWrite.enabled` | bool | `true` | — | `CMR_CODE_WRITE_ENABLED` | Whether the code-write lane is consulted. Advisory today — no interception ships for it. |
| `routing.codeWrite.enforce` | enum | `"suggest"` | `deny`, `ask`, `suggest`, `off` | `CMR_CODE_WRITE_ENFORCE` | Advisory by design: a hook cannot know a Write is boilerplate before it exists. |
| `routing.denyGlobs` | string[] | 9 entries | — | `CMR_DENY_GLOBS` | Paths that are never delegated. Security-critical content must not leave for a third-party worker. |
| `routing.allowGlobs` | string[] | `[]` | — | `CMR_ALLOW_GLOBS` | Paths that may be delegated even when another rule would decline. Narrow this deliberately: it is the only setting that can override a refusal, and it cannot override the deny list. |
| `routing.neverDelegate.onTargetedRead` | bool | `true` | — | `CMR_NEVER_ON_TARGETED_READ` | Treat an offset/limit read as intentional and never delegate it. |
| `routing.neverDelegate.onRecentlyEdited` | bool | `true` | — | `CMR_NEVER_ON_RECENTLY_EDITED` | Never delegate a file edited this session; Claude needs exact bytes. |

### Hook

The Claude Code adapter, and what it is allowed to send.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `hooks.enabled` | bool | `true` | — | `CMR_HOOKS_ENABLED` | Whether the PreToolUse hook intercepts Read at all. false leaves routing, telemetry and the scripts intact and stops only the interception. |
| `hooks.timeoutMs` | int | `20000` | min 1000, max 120000 | `CMR_HOOK_TIMEOUT_MS` | The hook's own deadline for a delegated read, which is not the worker's. Past it the hook abandons the worker call and falls open to the original Read, so an interactive read is never blocked for longer than this. |
| `hooks.taskIntent.source` | enum | `"none"` | `none`, `transcript` | `CMR_TASK_INTENT_SOURCE` | Where the worker's task comes from. 'none' sends a fixed generic task and is the default. 'transcript' recovers the newest prompt from the session transcript the hook is already given, so the worker is told what is actually being looked for — which also means your prompt text is sent to the worker model. Opt in deliberately. |
| `hooks.taskIntent.maxChars` | int | `600` | min 0, max 4000 | `CMR_TASK_INTENT_MAX_CHARS` | Ceiling on how much recovered prompt text may be sent to the worker. Longer intent is truncated, never dropped. |

### Answer verification

Checking the worker answer against the file it summarised, before that answer replaces the file in Claude context. Deterministic and on by default: a wrong summary is the one failure a developer cannot see, and the file is still in hand. A false positive costs one wasted worker call; a false negative poisons the context.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `verify.enabled` | bool | `true` | — | `CMR_VERIFY_ENABLED` | Check the worker answer against the file it summarised before that answer replaces the file in Claude context. Deterministic: line references, quoted literals and backticked identifiers are verified against the bytes. |
| `verify.onSuspect` | enum | `"discard"` | `discard`, `warn`, `off` | `CMR_VERIFY_ON_SUSPECT` | discard falls open to the real Read when a claim cannot be confirmed; warn substitutes the summary and appends a caveat naming what failed; off records the verdict and acts on nothing. |
| `verify.maxUngroundedIdentifierRatio` | number | `0.25` | min 0, max 1 | `CMR_VERIFY_MAX_UNGROUNDED_RATIO` | Share of backticked identifiers that may be absent from the file before the answer is suspect. A wrong line reference or an invented string literal is enough on its own. |

### Governance

Every limit ships `null`, meaning no configured limit — which is NOT `0`, a deliberately configured zero budget. Governance runs AFTER routing has ruled and can never rewrite its answer.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `budget.enabled` | bool | `true` | — | `CMR_BUDGET_ENABLED` | Master switch for budget governance. Off, no limit is evaluated and no accounting state is read or written. |
| `budget.run.maxWorkerCostUsd` | number | `null` | min 0, max 1000000, nullable | `CMR_RUN_BUDGET_USD` | Ceiling on the worker cost of one delegation. null means no configured limit; 0 means a configured zero budget. Unenforceable while the model is unpriced, because an unknown cost is not a zero cost. |
| `budget.run.maxInputTokens` | int | `null` | min 0, max 1000000000, nullable | `CMR_RUN_MAX_INPUT_TOKENS` | Ceiling on worker INPUT tokens for one delegation. Governance asks whether this is allowed; the context model separately asks whether it fits. |
| `budget.run.maxOutputTokens` | int | `null` | min 0, max 1000000000, nullable | `CMR_RUN_MAX_OUTPUT_TOKENS` | Ceiling on worker OUTPUT tokens for one delegation. |
| `budget.run.maxTotalTokens` | int | `null` | min 0, max 1000000000, nullable | `CMR_RUN_MAX_TOTAL_TOKENS` | Ceiling on total worker tokens for one delegation. The narrowest runaway guard, since a per-run limit needs no persisted state. |
| `budget.daily.maxWorkerCostUsd` | number | `null` | min 0, max 1000000, nullable | `CMR_DAILY_BUDGET_USD` | Ceiling on worker cost per UTC day. null means no configured limit. |
| `budget.daily.maxTotalTokens` | int | `null` | min 0, max 1000000000000, nullable | `CMR_DAILY_MAX_TOTAL_TOKENS` | Ceiling on total worker tokens per UTC day. |
| `budget.monthly.maxWorkerCostUsd` | number | `null` | min 0, max 1000000, nullable | `CMR_MONTHLY_BUDGET_USD` | Ceiling on worker cost per UTC month. null means no configured limit. |
| `budget.monthly.maxTotalTokens` | int | `null` | min 0, max 1000000000000, nullable | `CMR_MONTHLY_MAX_TOTAL_TOKENS` | Ceiling on total worker tokens per UTC month. |
| `budget.onExceed` | enum | `"disable"` | `disable`, `warn` | `CMR_BUDGET_ON_EXCEED` | What a reached limit does. disable denies delegation and the request continues on plain Claude Code; warn records the breach and delegates anyway. Neither fails the request. |
| `budget.onUnknownCost` | enum | `"allow"` | `allow`, `deny` | `CMR_BUDGET_ON_UNKNOWN_COST` | What to do when a monetary budget is configured but the worker cost is unknown. allow records the fact and proceeds, keeping an unpriced provider usable; deny is the opt-in for an exactly enforced ceiling. A structurally free local provider is not "unknown" and is unaffected. |
| `budget.onUnknownUsage` | enum | `"allow"` | `allow`, `deny` | `CMR_BUDGET_ON_UNKNOWN_USAGE` | What to do when a provider reports no token usage. Under allow such a provider can never exhaust a token budget, which is a documented exposure rather than an oversight; deny is the strict setting. |
| `budget.stateDir` | string | `"~/.claude/model-router/governance"` | non-empty | `CMR_BUDGET_STATE_DIR` | Where the budget accounting ledger lives. Separate from the telemetry store: telemetry records what happened, this is small mutable state about what is allowed. |

### Telemetry

What is recorded locally. There is no remote sink.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `telemetry.enabled` | bool | `true` | — | `CMR_TELEMETRY_ENABLED` | Whether a row is written per delegation. Disabling it leaves routing untouched and makes analytics and the report empty. |
| `telemetry.sink` | enum | `"jsonl"` | `jsonl`, `sqlite`, `null` | `CMR_TELEMETRY_SINK` | Where rows go. jsonl is the shipped store; null discards them. A sink that is not implemented falls back and reports the fallback rather than failing a hook. |
| `telemetry.dir` | string | `"~/.claude/model-router/telemetry"` | non-empty | `CMR_TELEMETRY_DIR` | Durable JSONL store. Defaults outside the plugin data dir so it survives uninstall. |
| `telemetry.rotation` | enum | `"daily"` | `daily`, `none` | `CMR_TELEMETRY_ROTATION` | daily writes one dated segment per UTC day. none writes a single undated file and makes retention a COMPLETE NO-OP, because pruning selects by the date in the filename. |
| `telemetry.shardByPid` | bool | `false` | — | `CMR_TELEMETRY_SHARD_BY_PID` | Write one file per process. Enable on OneDrive, SMB or mapped drives where append atomicity is not guaranteed. |
| `telemetry.retentionDays` | int | `90` | min 1, max 36500 | `CMR_TELEMETRY_RETENTION_DAYS` | How long a segment is kept by npm run prune. It has no effect at all when rotation is none, since an undated segment can never be selected. |
| `telemetry.primaryModel` | string | `null` | nullable | `CMR_PRIMARY_MODEL` | Counterfactual model. null means resolve it from the session transcript; it is never guessed. |
| `telemetry.avoidedMethod` | enum | `"chars_div_4"` | `chars_div_4`, `calibrated_cpt`, `worker_prompt_tokens`, `anthropic_count_tokens` | `CMR_AVOIDED_METHOD` | How primary-model tokens are counted. chars_div_4 under-counts source code, so savings err low. |
| `telemetry.counterfactualRender` | enum | `"raw"` | `raw`, `read_tool` | `CMR_COUNTERFACTUAL_RENDER` | raw ignores Read line-number overhead (conservative); read_tool includes it. |
| `telemetry.countProvenFilesOnly` | bool | `true` | — | `CMR_COUNT_PROVEN_ONLY` | Count only files a hook actually blocked. Inferred corpus files are the largest over-claim risk. |
| `telemetry.residencyTurns` | int | `0` | min 0, max 10000 | `CMR_RESIDENCY_TURNS` | Subsequent turns a landed corpus would have been re-sent for. Requires residencySource. |
| `telemetry.residencySource` | enum | `"default_zero"` | `default_zero`, `config`, `transcript_measured` | `CMR_RESIDENCY_SOURCE` | Provenance for residencyTurns. A non-zero value with default_zero is refused at load time. |
| `telemetry.privacyLevel` | enum | `"hashed"` | `hashed`, `labeled`, `verbose` | `CMR_PRIVACY_LEVEL` | hashed stores no content, paths or prompts. labeled and verbose are set by the store* flags. |
| `telemetry.saltScope` | enum | `"install"` | `install`, `team` | `CMR_SALT_SCOPE` | install keeps hashes machine-local; team shares a salt so hashes align across developers. |
| `telemetry.storeProjectLabel` | bool | `false` | — | `CMR_STORE_PROJECT_LABEL` | Store a readable project label beside the hashed id. Off by default: a hashed id is enough to group by. |
| `telemetry.storeFilePaths` | bool | `false` | — | `CMR_STORE_FILE_PATHS` | Store file paths as they were read, instead of salted hashes. Off by default. This is the single largest increase in what a shared report reveals. |
| `telemetry.storeGitBranch` | bool | `false` | — | `CMR_STORE_GIT_BRANCH` | Store the git branch on each row. Off by default: a branch name often carries a ticket id or a customer name. |
| `telemetry.storeQuestionText` | bool | `false` | — | `CMR_STORE_QUESTION_TEXT` | Opt in to storing a truncated, secret-scrubbed question. Sets privacyLevel to verbose. |
| `telemetry.questionTextMaxChars` | int | `200` | min 0, max 10000 | `CMR_QUESTION_TEXT_MAX_CHARS` | Clamp on stored question text. Only consulted when storeQuestionText is on. |
| `telemetry.storeErrorDetail` | bool | `false` | — | `CMR_STORE_ERROR_DETAIL` | Store provider error bodies verbatim. Off by default, because an error body can echo the request. |
| `telemetry.storeContentHash` | bool | `false` | — | `CMR_STORE_CONTENT_HASH` | Store a hash of the delegated content, so repeat reads of the same bytes can be recognised. A hash, never the content. |
| `telemetry.recordGateDecisions` | bool | `true` | — | `CMR_RECORD_GATE_DECISIONS` | Whether a refusal writes a gate_block row as well as a delegation writing its own. Off, the store holds delegations only and the refusal denominator is lost. |

### Pricing

Every bundled rate is `null`, so worker cost is reported as NULL rather than guessed.

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `pricing.source` | enum | `"bundled"` | `bundled`, `file` | `CMR_PRICING_SOURCE` | Which pricing table to use. bundled ships every rate as null, so cost is reported as NULL rather than guessed; file reads the table named by pricing.overrides. |
| `pricing.overrides` | string | `null` | nullable | `CMR_PRICING_OVERRIDES` | Path to a replacement pricing table. First match wins; tables are never merged. |

### File version

| Setting | Type | Default | Range | Env var | Meaning |
| --- | --- | --- | --- | --- | --- |
| `version` | int | `1` | min 1 | — | Config schema version of this file. Bumped only when a setting changes meaning; a mismatch is reported, never silently migrated. |
