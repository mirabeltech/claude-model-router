# Security

This plugin sends file contents from your machine to a third-party model. That is its entire
purpose, so what exactly leaves, and what never does, is worth stating precisely.

## What leaves your machine

When — and only when — the routing gate approves a delegation, the worker provider receives:

1. **The selected file content.** The files the intercepted `Read` named.
2. **The task.** By default a fixed, generic instruction. With `hooks.taskIntent.source` set to
   `transcript`, your newest prompt instead, clamped to `hooks.taskIntent.maxChars`.
3. **The mode's instructions.** A static system prompt.

**That is the whole payload.** Not environment variables, not credentials, not unrelated
conversation, not your transcript, not an arbitrary session file, not your file tree.

If the worker is `ollama` on loopback, nothing leaves the machine at all.

## What never leaves

- **API keys.** Read from the environment at call time, sent only in the provider's own auth header.
  Never stored in config — there is no field for one — never written to a telemetry row, never
  printed. Doctor reports only presence, length and a four-character prefix.
- **Your prompt text, by default.** `hooks.taskIntent.source` defaults to `none`. Forwarding your
  prompt is a decision you make, not a default you discover afterwards.
- **Telemetry.** Local only. No remote sink, no account, no network call anywhere in the write path.

## What is never delegated

Enforced in code, not documented as guidance. The gate declines, and the read proceeds on Claude:

- anything matching `routing.denyGlobs` — by default `.env*`, `*secret*`, `*credential*`, `*.pem`,
  `*.key`, `id_rsa*`, `.git/**`, `auth/**`, `security/**`
- targeted reads (an explicit `offset`/`limit`), recently-edited files, and sub-threshold files
- security-critical reasoning, debugging, architecture and precise editing

Changing a threshold or a glob default requires a negative eval proving these refusals still hold.
[docs/what-we-do-not-delegate.md](docs/what-we-do-not-delegate.md) has the rule order and the known
discrepancies.

## One asymmetry, stated plainly

**Intent text crosses a redaction boundary. File content does not.**

Your prompt, if you enable `transcript`, goes through `redactSecrets()` before it is sent. The
selected file content does **not** — it is sent as read.

This is deliberate: redacting file content would mean sending the worker a corrupted file and
getting back a confident answer about something that was never there. The deny list is the control
for file content, and it operates by *refusing to send the file at all* rather than by mutating it.

`test/task.security.test.mjs` pins that exposure in both directions, so it cannot drift quietly.

## What a telemetry row can contain

Local, but still a record of your work — worth knowing before you share a report.

**By default:** salted hashes of file paths, token counts, latency, the provider and model, the
routing decision and reason, and a hashed session id. **Not** file contents, **not** prompt text,
**not** readable paths.

**Only if you turn it on:** readable file paths (`storeFilePaths`), the project label
(`storeProjectLabel`), the git branch (`storeGitBranch`), question text
(`storeQuestionText`), provider error bodies (`storeErrorDetail`), or a content hash
(`storeContentHash`). Each is off by default and each is a separate decision.

A generated HTML report embeds no file contents and no secrets, and a test asserts that over a real
run. But it does summarise what you read and when. **If the telemetry is safe to share, the report
is too — judge the store, not the report.**
[docs/telemetry-schema.md](docs/telemetry-schema.md) is the full field list.

## Keeping state local

Keep `telemetry.dir` and `budget.stateDir` on a local disk. On SMB, NFS or a cloud-sync client,
`O_EXCL` creation is not reliably atomic and single-syscall append atomicity has no guarantee, so
budget enforcement across machines over a shared state directory **does not hold**. Doctor warns
when it detects such a path and cannot detect every case.

## Failure is always open

Every failure path allows the read rather than blocking it: no key, no worker, unreachable daemon,
spent budget, malformed config, a context that does not fit, a telemetry error. A broken router
degrades to plain Claude Code.

This is a deliberate trade and worth naming as such: it means a misconfigured router is **silent**
rather than loud. `npm run doctor` is how you tell "not delegating" from "not installed".

## Reporting a vulnerability

Email **mobeid@mirabeltechnologies.com** with a description and, if you can, a reproduction.
Please do not open a public issue for anything that exposes data.

Useful to include, and safe to paste — no secret is ever printed:

```bash
npm run doctor -- --json --offline
```

## Scope

In scope: anything that sends data to a worker that the rules above say should not be sent; anything
that writes a secret to a telemetry row, a report or CLI output; anything that makes the gate
fail *closed* and block a session; a bypass of the deny list.

Out of scope: the worker model's own behaviour and data handling — that is the provider's policy,
and choosing a provider is choosing their terms.
