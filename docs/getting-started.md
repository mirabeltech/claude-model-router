# Getting started

From nothing to a measured delegation. Fifteen minutes, and the keyless route costs no money.

Longer install detail — team setup, the dev loop, upgrading — is in [install.md](install.md). This
page is the shortest honest path.

## What you are setting up

Claude stays the reasoning agent. When you ask it to read something large, a `PreToolUse` hook
intercepts the read, sends the file to a cheap worker model with your task, and hands Claude the
answer instead of the whole file. Every delegation is recorded locally so you can see what it
avoided.

Two things are worth knowing before you start, because they change how you read everything below:

- **The gate fails open on every branch.** No worker, no key, spent budget, unreachable daemon,
  malformed config — every one of those lets the read through to Claude exactly as if the plugin
  were not installed. You cannot end up with a blocked session.
- **Installing changes nothing on its own.** No budget is enforced, no price is assumed, and until
  you configure a worker nothing is delegated at all.

## Step 1 — install

```bash
claude plugin marketplace add mirabeltech/claude-model-router
claude plugin install model-router@claude-model-router
claude plugin install router-dashboard@claude-model-router   # optional, read-only
```

Installing from a local clone instead? `claude plugin marketplace add ./path/to/claude-model-router`
takes a directory. See [install.md](install.md) for all three supported modes.

## Step 2 — choose a worker

Pick one. The keyless route is the better first run: nothing leaves your machine and there is no
account to create.

### Option A — local and keyless (Ollama)

```bash
ollama serve                      # skip if it already runs as a service
ollama pull qwen2.5-coder:7b
```

Then create `<your-project>/.claude/model-router.json`:

```json
{
  "worker": { "provider": "ollama", "model": "qwen2.5-coder:7b" }
}
```

**Set both fields.** Setting only `provider` leaves `model` at its default of `gemini-3.8-flash`,
which Ollama does not own, and doctor reports a provider/model mismatch. It is the most common way
to misconfigure this plugin.

### Option B — hosted and metered (Gemini)

Get a key from [Google AI Studio](https://aistudio.google.com/apikey), then put it in your
environment — never in a config file.

```powershell
setx GEMINI_API_KEY "your-key"
```

`setx` writes your user environment but **not** the shell you are standing in, so close that
terminal and restart Claude Code afterwards.

```bash
export GEMINI_API_KEY=your-key
```

Add that line to `~/.zshrc` or `~/.bashrc` to make it persist.

Gemini is the shipped default, so no config file is needed for this route.

## Step 3 — check it

```bash
npm run doctor        # from a clone
```

```
/model-router:doctor  # inside a Claude Code session, from a marketplace install
```

Read the result by level, because they mean genuinely different things:

| Level | What it means |
| --- | --- |
| **PASS** | Checked, and fine. |
| **WARN** | A *degraded* router, never a broken one. Every warning state still leaves Claude Code working normally. |
| **FAIL** | A misconfiguration with a definite fix. Only FAIL affects the exit code. |
| **INFO** | What is configured, not a verdict. |

Two readings people get wrong:

- **"GEMINI_API_KEY is not set" as a WARN is the shipped default, not a mistake you made.** It means
  you have not chosen a worker yet. If you configure Gemini explicitly and the key is still
  missing, that same finding becomes a FAIL — because then you did ask for it.
- **An unknown context window is not an unlimited one.** If capability status reads `unknown` or
  `assumed`, that number was not measured on your install. Gemini has no window probe at all, so
  that warning is expected and correct.

Doctor writes nothing and creates no directories. Add `--probe-writes` if you want writability
confirmed by actually writing, and `--offline` to skip the provider probe entirely.

## Step 4 — delegate something

From a clone, the fastest honest check runs the real shipped hook against a real worker:

```bash
npm run smoke:hook                            # Ollama, with the model from step 2
npm run smoke:hook -- --provider gemini --model gemini-3.8-flash
```

It prints the hook's decision, the worker's answer and the telemetry row that was written. Exit 0
means the hook denied the raw read, the worker answered, and the row landed.

From a marketplace install there is no `npm`, so do it the real way: open a session in a repository
and ask Claude to read a file longer than 350 lines.

```
Read src/some-long-file.ts and tell me what it exports.
```

If the gate fires, Claude answers from the worker's summary rather than the file. If nothing seems
to happen, that is the fail-open path working — [troubleshooting.md](troubleshooting.md) has the
checks, starting with `/hooks`.

## Step 5 — see what it did

```bash
npm run analytics              # the last 7 UTC days, in the terminal
npm run analytics -- --today
npm run report                 # one self-contained HTML file; prints its path
```

Three things in that output are routinely misread:

- **"Worker cost: unavailable" is not zero.** Every rate in the bundled pricing table ships `null`,
  so a default install produces no dollar figure at all. That is a refusal to price, not a missing
  feature — see [`examples/pricing-overrides.json`](../examples/pricing-overrides.json) to supply
  rates.
- **Savings are estimates, not invoice savings.** They count tokens the primary model avoided
  ingesting, over files a hook actually blocked, net of the answer that came back. There is no
  measured primary-model baseline. [savings-methodology.md](savings-methodology.md) is the full
  accounting.
- **A negative saving is for investigation, not a verdict.** A verbose worker on a small file can
  genuinely cost more than it saved. It is never clamped to zero.

## Step 6 — optional, and worth it

```jsonc
// <project>/.claude/model-router.json
{
  "budget": {
    "enabled": true,
    "run": { "maxTotalTokens": 200000 }
  }
}
```

A per-delegation token ceiling is the safest first limit: it needs no stored state and works
immediately on any provider that reports usage. A **dollar** limit needs rates, and there are none
until you configure them, so doctor will tell you a monetary budget cannot be enforced yet rather
than letting it look active.

Commit that file to share routing policy with your team. It holds no secrets and cannot:
see [configuration.md](configuration.md).

## Where to go next

| You want to | Read |
| --- | --- |
| Understand what is and is not delegated | [routing.md](routing.md), [what-we-do-not-delegate.md](what-we-do-not-delegate.md) |
| Change a setting | [configuration.md](configuration.md) |
| Set up a provider properly | [providers.md](providers.md) |
| Fix something that is not working | [troubleshooting.md](troubleshooting.md) |
| Trust the savings figures | [savings-methodology.md](savings-methodology.md) |
| Cap spending | [governance.md](governance.md) |
| Know what is recorded | [telemetry-schema.md](telemetry-schema.md) |
| See how it fits together | [architecture.md](architecture.md) |
