# claude-model-router

A Claude Code plugin marketplace for **model routing**. Claude stays the primary reasoning agent;
repetitive, I/O-heavy work is shunted to a cheap worker model, and every delegation is recorded so
you can see what it avoided.

Independently implemented, inspired by the hooks-plus-scripts plugin shape that Spotify's
[`shunt`](https://github.com/spotify/portal-ai-plugins) described publicly. **Not affiliated with,
endorsed by, or derived from the code of Spotify or Anthropic.** What this project adds: a provider
abstraction, a context-capability model, a telemetry and cost model, a budget layer, an analytics
engine, a reporting dashboard, and fail-open behaviour throughout.

> **Status: V1. Phases 0–12 are done** — layered configuration, provider abstraction, telemetry
> write path, routing engine, worker dispatch, the Claude Code hook, context budgeting, budget
> governance, the analytics engine with its HTML report, packaging, and a final hardening pass. A
> large `Read` is intercepted, delegated, measured and accounted for. Still unscheduled:
> ingest/SQLite materialisation, delegation-steering skills, and behavioural evals — see
> [docs/post-v1-backlog.md](docs/post-v1-backlog.md). Note that **every budget limit and every
> bundled price ships `null`**, so a default install enforces nothing and reports no dollar figure.
>
> **Worker delegation is policy/routing infrastructure; worker quality remains task- and
> model-dependent.** Nothing here measures whether a worker's answer is as good as Claude's — see
> [docs/release-v1.md](docs/release-v1.md) for what was and was not established.

**Two things to know before anything else.** The routing gate **fails open on every branch** — no
worker, no key, spent budget, unreachable daemon, malformed config all let the read through exactly
as if the plugin were not installed, so you cannot end up with a blocked session. And **installing
changes nothing on its own**: no API key is required to install, nothing is delegated until you
configure a worker, and no directory is created until something is actually recorded.

## Quickstart

The keyless route, which costs nothing and sends nothing off your machine:

```bash
claude plugin marketplace add mirabeltech/claude-model-router
claude plugin install model-router@claude-model-router

ollama serve                     # skip if it already runs as a service
ollama pull qwen2.5-coder:7b
```

```jsonc
// <your-project>/.claude/model-router.json  — commit this to share it
{ "worker": { "provider": "ollama", "model": "qwen2.5-coder:7b" } }
```

Set **both** fields: setting only `provider` leaves the model at its Gemini default, which Ollama
does not own.

Then, inside a Claude Code session:

```
/model-router:doctor
```

Hosted instead? Gemini is the shipped default, so you only need a key in your environment —
`setx GEMINI_API_KEY "your-key"` on Windows (then restart Claude Code; `setx` does not affect the
current shell), or `export GEMINI_API_KEY=your-key` on macOS and Linux. **A key never goes in a
config file**; there is no field for one.

Full walkthrough, including how to run a test delegation and read the result:
**[docs/getting-started.md](docs/getting-started.md)**.

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
`routing.denyGlobs` straight through to Claude. Secrets, keys and `auth/` paths are on that deny
list by default, so security-critical content never leaves for a third-party worker. Changing a
threshold requires a negative eval proving the refusals still hold —
[what-we-do-not-delegate.md](docs/what-we-do-not-delegate.md).

## How it works

```
  Claude Code
      |  PreToolUse(Read)
      v
  L1  the adapter          impure, on the hot path. Writes one JSON object, ALWAYS exits 0.
      v
  L2  decide()             "would this be APPROPRIATE to delegate?"   pure, sync, no network
      v
  L3  governance           "are we currently ALLOWED to?"
      context budget       "CAN this worker physically run it?"
      v
  L4  dispatch + provider  the worker call. One telemetry row, written synchronously.
      v
  analytics -> dashboard   "what did delegation DO over this window?"
```

Those four questions are **four separate decisions and are never collapsed into one**. Governance
runs after routing has ruled and can never rewrite its answer; a context window is deliberately not
a routing input. [docs/architecture.md](docs/architecture.md) explains why, and lists the test that
pins each claim.

## Requirements

- **Node 22.5+.** CI gates Node 24 on Linux, Windows and macOS, plus Node 22.5.0 on Linux to prove
  the declared floor.
- **No npm dependencies.** Hooks run as `node <script>.mjs`, so there is no `jq` and no Git Bash
  requirement.
- **A worker, eventually** — a local [Ollama](https://ollama.com) for a keyless setup, or an API key
  for a hosted provider. Not needed to install.

## Providers

`ollama` (local, keyless), `gemini` (hosted, metered) and `mock` (tests and the offline benchmark).
Adding another is one file plus one registry line; routing, hooks and telemetry are untouched,
because they resolve `worker.provider` through the registry rather than importing a provider.

```js
export const id = 'gemini'
export const capabilities = { maxInputBytes, supportsSystemPrompt, reportsUsage, requiresEnv,
                              contextWindowModel, silentInputTruncation }
export async function describeModel(opts)   // OPTIONAL: discover the model's context window
export function readiness(env)        // sync, no network -> { ready, reason }
export async function complete(req)   // -> { text, usage, model, providerLatencyMs }
```

**Capability discovery is not uniform, and the docs say so rather than implying it is.** Ollama
answers `/api/show`, so its window can be *measured*. **Gemini exposes no such probe, so a Gemini
context window is `assumed` or `unknown`** — doctor warns, and that warning is correct.
[docs/providers.md](docs/providers.md).

## Measuring savings

What the numbers are, stated as narrowly as they deserve:

- **Estimated, not invoiced.** There is no measured primary-model baseline, so avoided tokens are a
  counterfactual estimate of what Claude would have ingested.
- **Reported only where the measurement exists.** Missing usage is `NULL`, never `0`. An unpriced
  model is `NULL`, never a guessed rate. **Every rate in the bundled table ships `null`, so a
  default install reports no dollar figure at all** — enforced by a CI step that fails if a price
  appears.
- **Net, and over proven files only.** The worker's returned answer is subtracted, and only files a
  hook actually blocked are counted.
- **Conservative by construction.** `chars/4` under-counts code, which tokenizes nearer
  3.0–3.6 chars/token. Residency is 0 unless measured. There is deliberately **no `tokens × turns`
  multiplier**: Claude Code pays cache rates, so that claim would be inflated tenfold or more.
- **Negative savings are reported, not clamped.** A verbose worker on a small file can genuinely
  cost more than it saved.

```bash
npm run analytics        # what delegation did, over a window
npm run report           # one self-contained HTML file; prints its path
```

[docs/savings-methodology.md](docs/savings-methodology.md) is the full accounting.

## Privacy

Telemetry is **local only** — no remote sink, no account, no network call in the write path. File
paths are salted hashes by default, prompt text is not stored, and the worker is sent the task plus
the selected file content and nothing else: no environment variables, no credentials, no unrelated
conversation.

`hooks.taskIntent.source` defaults to `none`, so your prompt text does **not** reach the worker
unless you turn it on — forwarding it is your decision, not a default you discover afterwards.
[SECURITY.md](SECURITY.md) states exactly what leaves the machine.

## Configuration

```
bundled defaults
  -> ~/.claude/model-router/config.json      (per developer)
  -> <project>/.claude/model-router.json     (per project, committed = team-shareable)
  -> CMR_* environment variables             (so CI can always win)
  -> plugin options                          (/plugin configure)
```

Those are the **only two files read** — no upward directory walk, no other filename. An invalid
value falls back to its default with a warning and can never block a session. Arrays replace rather
than merge.

All 77 settings: [docs/configuration.md](docs/configuration.md), generated from the same table that
enforces validation. Worked examples: [`examples/`](examples/).

## Documentation

**[docs/README.md](docs/README.md)** is the index. The short version:

| You want to | Read |
| --- | --- |
| Get it working | [getting-started.md](docs/getting-started.md) |
| Install it properly, or for a team | [install.md](docs/install.md) |
| Set up a provider | [providers.md](docs/providers.md) |
| Change a setting | [configuration.md](docs/configuration.md) |
| Fix something | [troubleshooting.md](docs/troubleshooting.md) |
| Understand the shape | [architecture.md](docs/architecture.md) |
| Trust the savings | [savings-methodology.md](docs/savings-methodology.md) |
| Cap spending | [governance.md](docs/governance.md) |

## Development

```bash
npm test                 # unit + integration. No network, no API key.
npm run doctor           # diagnose config, provider, capability, hook, telemetry, governance
npm run budget           # read-only: limits, UTC period, spend
npm run analytics        # read-only: what delegation did. --json pipes to report
npm run report           # one self-contained HTML report
npm run validate         # claude plugin validate --strict on all three manifests
npm run evals            # deterministic benchmark: offline, keyless, reproducible
npm run evals:sweep      # the same, plus the threshold sweep
```

Load the plugin from a checkout with no install step:

```bash
claude --plugin-dir ./plugins/model-router -p "..."
```

Generated files are gated in CI — change `SPEC` and you must run `npm run gen:schema`,
`npm run docs:config` and `npm run docs:env`; bump the version and you must run
`npm run sync:version`. [CONTRIBUTING.md](CONTRIBUTING.md) has the rules a change has to respect.

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
| 11 | Packaging, distribution and developer experience | **done** |
| 12 | Hardening, end-to-end validation and the V1 release | **done** |

Unscheduled, and tracked here so they are not mistaken for done: ingest and SQLite
materialisation, delegation-steering skills (so `routing.codeWrite.enforce` is advisory and
intercepts nothing today), behavioural evals, and the quality loop. No npm script points at a file
that does not exist — a packaging test enforces that.

## License

Apache-2.0. Copyright 2026 Mirabel Technologies.
