# claude-model-router

A Claude Code plugin marketplace for **model routing**. Claude stays the primary reasoning agent;
repetitive, I/O-heavy work is shunted to a cheap worker model, and every delegation is measured so
you can see what it actually saved.

Inspired by Spotify's [`shunt`](https://github.com/spotify/portal-ai-plugins) plugin, which
established the hooks + scripts + skills shape this builds on. What's added here: a provider
abstraction, a telemetry and cost model, a reporting dashboard, a zero-dependency cross-platform
runtime, and fail-open behaviour.

> **Status: the gate is wired.** Scaffold, layered configuration, provider abstraction, telemetry
> write path, routing engine, worker dispatch, the Claude Code hook integration and budget
> governance are done: a large `Read` is now intercepted, delegated to the worker, measured and
> accounted for against any configured budget. Skills, ingest and the dashboard are not. Note
> that every budget limit ships `null`, so governance is wired but enforces nothing until you
> configure one. See [the implementation plan](#implementation-status).

## What gets delegated

| Delegated | Never delegated |
| --- | --- |
| Bulk file reading and summarisation (files over ~350 lines, questions across 3+ files) | Debugging |
| Predictable boilerplate generation (tests, config, type stubs, docstrings) | Architecture decisions |
| | Security-critical reasoning |
| | Complex reasoning |
| | Precise code editing |
| | Small files, where delegation overhead exceeds the benefit |

The right-hand column is **enforced, not just documented**: the gate allows targeted
(`offset`/`limit`) reads, sub-threshold files, recently-edited files and anything matching
`routing.denyGlobs` straight through to Claude. Secrets, keys and `auth/` paths are on that deny list
by default, so security-critical content never leaves for a third-party worker.

## Install

```bash
claude plugin marketplace add mirabeltech/claude-model-router
claude plugin install model-router@claude-model-router
claude plugin install router-dashboard@claude-model-router   # optional, read-only
```

Then set your worker key and check the setup:

```bash
export GEMINI_API_KEY=...
node ~/.claude/plugins/.../scripts/doctor.mjs     # or: /model-router:router-doctor
```

Nothing needs to be copied into your project. To share routing policy with your team, commit
`.claude/model-router.json` — see [`examples/model-router.project.json`](examples/model-router.project.json).

## How it works

Four layers. Only the first two run on the hot path.

```
L1  ROUTING GATE    PreToolUse(Read) -> decide() -> allow | deny | ask | suggest
L2  INSTRUCTION     skills tell Claude which script to call, and when not to
L3  DELEGATION      scripts build the payload, call the worker, emit one telemetry event
L4  ABSTRACTIONS    providers/* (one interface)   telemetry/* (one sink interface)
```

**The gate is pure and fails open.** `decide()` is synchronous, makes no network call and imports no
provider. If the worker is unconfigured, the path is sensitive or the config is malformed, it
returns `allow` and Claude proceeds normally. A broken router degrades to plain Claude Code, never
to a blocked session. Full contract: [`docs/routing.md`](docs/routing.md); the refusal list is in
[`docs/what-we-do-not-delegate.md`](docs/what-we-do-not-delegate.md).

**A spent budget is a separate decision, deliberately.** The gate asks whether a task is
*appropriate* to delegate and reads no ledger; `lib/governance/` then asks whether we are
currently *allowed* to, and a refusal there falls back to plain Claude Code in exactly the same
way. Keeping them apart is what lets one row record both that a read was delegation-worthy and
that the budget would not pay for it. See [`docs/governance.md`](docs/governance.md).
What happens to a decision once it is approved — prompt construction, provider resolution,
timeout, abort and error classification — is in [`docs/worker-dispatch.md`](docs/worker-dispatch.md).

**The worker is told what to do, separately from being told whether to do it.** The router answers
"should this be delegated"; a pure task builder answers "what exactly should the worker do". By
default the worker gets a fixed generic task, because a `PreToolUse` payload names the file and
never the reason. Setting `hooks.taskIntent.source: "transcript"` lets the hook recover your newest
prompt from the session transcript and ask the worker *that* instead — which also means your prompt
text is sent to the worker model, so it is off by default. See
[`docs/worker-task-construction.md`](docs/worker-task-construction.md).

## Requirements

- **Node 22.5+** (24 recommended) — ships with `node:sqlite`, which the unscheduled `ingest` step
  will use. The dashboard itself needs nothing beyond the standard library.
- **No npm dependencies.** Hooks are invoked as `node <script>.mjs`, so there is no `jq` or Git Bash
  requirement and behaviour is identical on Windows, macOS and Linux.
- A worker API key (`GEMINI_API_KEY` by default), or a local [Ollama](https://ollama.com) for a
  keyless setup.

## Providers

Gemini ships first. Adding another is one file plus one registry line — routing, hooks, skills and
telemetry are untouched, because they resolve `worker.provider` through the registry rather than
importing a provider directly.

```js
export const id = 'gemini'
export const capabilities = { maxInputBytes, supportsSystemPrompt, reportsUsage, requiresEnv,
                              contextWindowModel, silentInputTruncation }
export async function describeModel(opts)   // OPTIONAL: discover the model's context window
export function readiness(env)        // sync, no network -> { ready, reason }
export async function complete(req)   // -> { text, usage, model, providerLatencyMs }
```

`mock` (a local HTTP stub) and `ollama` (keyless) let the whole system be tested in CI with no
credentials.

## Measuring savings

Every delegation writes one flat event to an append-only JSONL log. `npm run analytics` reads that
log directly and `npm run report` renders it as one self-contained HTML file; an unscheduled
`ingest` step will materialise SQLite for larger stores, so moving to Postgres or ClickHouse later
swaps only the ingest target.

The numbers are deliberately conservative, and the methodology is the point:

- **Net, not gross.** The worker's answer does enter Claude's context, so it is subtracted. A
  delegation that returns a wall of text correctly reports near-zero savings. Negative savings are
  stored, never clamped — they tell you a threshold is wrong.
- **Only what the gate proved.** A hook blocking one file proves Claude wanted *that* file. If the
  skill then sends six, five are inference. The headline figure counts hook-proven files only
  (`telemetry.countProvenFilesOnly`), with inferred corpus as an explicit toggle.
- **`chars/4` under-counts code.** Source really tokenizes nearer 3.0–3.6 chars/token, so the
  reported saving is a floor. Every event carries `avoided_method` so the figure is auditable.
- **No `tokens x turns` multiplier.** Claude Code pays *cache* rates for resident context — roughly
  2x input to land it once, then ~0.1x per later turn. The common "we saved X tokens across 40 turns"
  claim is 10–40x inflated; the dashboard is forbidden from computing it. Residency defaults to 0 and
  is only non-zero when actually measured from the transcript.
- **Missing provider usage yields `NULL`, never `$0`** — and worker rates ship as `null` with a
  `verify` URL rather than plausible-looking numbers, because a confident wrong dollar figure is
  worse than a refusal to price.

Because the cost functions are pure over `(inputs, calc, pricing)` and both parameter sets are
stamped into the event at write time, `router verify` can recompute any stored row and prove its
numbers.

Out of the box no rate in the bundled pricing table is populated, so **no report produced by a
default install contains a dollar figure of any kind** — a refusal to price, not a missing feature.
Tokens avoided is the one populated headline until `pricing.overrides` is configured, and every
cost aggregate ships its measurement coverage beside it.

```bash
npm run analytics            # what delegation did, last 7 UTC days
npm run report               # the same as one self-contained HTML file
```

See [`docs/savings-methodology.md`](docs/savings-methodology.md),
[`docs/telemetry-schema.md`](docs/telemetry-schema.md) and
[`docs/analytics.md`](docs/analytics.md).

## Privacy

Default `privacyLevel: hashed` stores **no** file contents, prompts, answers, generated code, paths,
file names or error text — only sizes, counts, extensions and salted hashes. The salt is machine-local
by default and never transmitted. Storing paths, project labels or question text are separate opt-in
flags, and secret scrubbing runs even when they are on.

**Your prompt text is not sent to the worker unless you ask for it to be.**
`hooks.taskIntent.source` defaults to `none`, under which the worker receives a fixed task string
and nothing from your session. With `transcript` it receives your newest prompt as the question —
clamped to `hooks.taskIntent.maxChars` (600) and passed through secret redaction first. Either way,
**file content is sent unredacted**: the filename deny list is the only control over that, which is
the exposure [`docs/worker-task-construction.md`](docs/worker-task-construction.md) documents
rather than softens.

`CLAUDE_ROUTER_TELEMETRY=0` disables telemetry for one session; `CMR_ENABLED=0` disables routing
entirely. Both override every config file.

## Configuration

Layered, later wins:

```
bundled defaults
  -> ~/.claude/model-router/config.json           per developer
  -> <project>/.claude/model-router.json          per project, committed = team-shareable
  -> CMR_* environment variables                  CI and kill switches always win
  -> CLAUDE_PLUGIN_OPTION_*                       plugin userConfig prompts
```

An invalid field **falls back to its default with a warning** rather than failing a hook. Full
reference: [`docs/configuration.md`](docs/configuration.md). The JSON Schema at
`plugins/model-router/lib/config.schema.json` is generated from the same table that enforces
validation at runtime, so the two cannot drift.

## Development

```bash
npm test                                      # unit + integration, no network, no key
npm run validate                              # claude plugin validate --strict, all three manifests
npm run evals                                 # deterministic benchmark: offline, keyless, reproducible
npm run evals:sweep                           # the same, plus the threshold sweep

# load the plugin from the repo with no install step
claude --plugin-dir ./plugins/model-router -p "summarise test/fixtures/corpus/large.ts"
```

Two scripts in `package.json` still point at files that do not exist, and name the phase that will
write them: `test:behavioural` (phase 8) and `ingest` (phase 7). They are advertised rather than
removed because the entry points are part of those phases' contracts. `report` was the third and
now resolves: see [`docs/analytics.md`](docs/analytics.md).

The benchmark is evidence, not policy. See
[`docs/benchmark-methodology.md`](docs/benchmark-methodology.md) for what its numbers are worth, and
[`docs/evaluation.md`](docs/evaluation.md) for the corpus and the gates.

Changed `SPEC` in `config.mjs`? Regenerate the schema, or CI will fail:

```bash
node plugins/model-router/scripts/gen-config-schema.mjs
```

### Implementation status

| Phase | | |
| --- | --- | --- |
| 0 | Scaffold, manifests, layered config | **done** |
| 1 | Provider abstraction (`mock`, `gemini`, `ollama`) | **done** |
| 2 | Telemetry write path (pure compute + JSONL sink) | **done** |
| 3 | Routing decision engine (`decide()`, pure) | **done** |
| 4 | Worker execution and dispatch (`dispatch()`) | **done** |
| 5 | Claude Code hook integration (`PreToolUse` on `Read`) | **done** |
| 6 | Evaluation and benchmarking (deterministic corpus, gates, sweep) | **done** |
| 7 | Intent-aware worker task construction (task builder, A/B eval) | **done** |
| 8 | Worker capability and context budgeting | **done** |
| 9 | Budget governance, quotas and safety controls | **done** |
| 10 | Analytics, savings dashboard and router observability | **done** |
| 11 | Packaging and marketplace | |
| 12 | Hardening and release | |

Unscheduled, and tracked here so they are not mistaken for done: ingest and SQLite
materialisation (`npm run ingest`), skills and behavioural evals (`npm run test:behavioural`), and
the quality loop. The first two have npm scripts pointing at files that do not exist yet.

## License

Apache-2.0. Copyright 2026 Mirabel Technologies.
