# router doctor

The diagnostic, and the primary onboarding command. It answers one question — *can this
installation actually route?* — and explains anything that would stop it.

```bash
npm run doctor                  # from a clone
```
```
/model-router:doctor            # from a marketplace install, inside a session
```

## It writes nothing

By default doctor creates no directories and writes no files. That matters more than it sounds:
it used to `mkdir` the telemetry and governance directories in order to probe them, so the first
command a new developer ran left state behind and then reported "store is empty" — having just
falsified the thing it was measuring.

Writability is now judged by asking the filesystem for permission on the nearest existing
ancestor, and the output says which of the two checks it made. That is a **weaker claim** than a
write, so it is labelled as one: `accessSync` does not reliably reflect ACLs, and on Windows it
does not reliably report a read-only directory at all. `--probe-writes` restores the real write
for those cases.

The only network request a default run makes is the worker capability probe, which for Ollama is a
localhost call to `/api/show`. `--offline` skips it entirely.

## Four levels

| Level | Meaning | Affects exit code |
| --- | --- | --- |
| **PASS** | Checked, and fine. | no |
| **WARN** | A *degraded* router, never a broken one. | **no** |
| **FAIL** | A misconfiguration with a definite fix. | **yes** |
| **INFO** | What is configured, not a verdict. | no |

**Only FAIL moves the exit code, and that is load-bearing.** A fresh install carries warnings by
design — no worker configured, nothing priced, no budget set — and a tool that exited non-zero on
its own shipped defaults would train everyone to ignore it. Every WARN state still leaves Claude
Code working exactly as it does without this plugin, because the routing gate fails open on every
branch.

`INFO` exists because doctor used to emit its echoes as raw dimmed text outside the counters, which
made an observation indistinguishable from a check that had been skipped — and made a
machine-readable report impossible.

## Severity depends on intent, once

A missing API key is the one finding whose level depends on your configuration rather than only on
the fact:

- **nobody named the provider** (it is the bundled default) and the key is absent → **WARN**. You
  have not set up a worker yet. Nothing is misconfigured.
- **somebody named it**, in a file or an environment variable, and the key is absent → **FAIL**.
  Someone asked for that provider and it cannot run.

The same distinction the rest of the codebase draws between a configured value and a measured one,
and between `null` and a deliberately configured `0`.

## Sections

| Section | Answers |
| --- | --- |
| **Project** | Which copy am I running — repo and plugin version, plugin root, install mode, node, platform. |
| **Configuration** | What resolved, from which layer, and any warning. |
| **Runtime** | Node version against the engines floor, and `fetch`. |
| **Routing** | Whether routing is on, the policy version, the thresholds, and the task-intent state. |
| **Worker provider** | Registered, contract satisfied, keys present, readiness. |
| **Worker modes** | Which worker each lane resolves to. The only place a typo in `workers.<lane>.provider` is caught. |
| **Worker capability** | Provider/model coherence, and whether the resolved worker can hold the prompts we intend to send. |
| **Claude Code hook** | Registration, that the script exists at the substituted path, and which deadline bounds a delegated read. |
| **Telemetry store** | Writability, filesystem suitability, and append integrity. |
| **Analytics** | Whether the reporting chain is usable and whether there is anything to report. |
| **Pricing** | Which table is served, and which models have no rates. |
| **Governance** | Whether configured budgets can actually be enforced, and spend so far. |
| **Live worker call** | `--live` only: one real call. |

`Project` reports **no verdicts** — it is identity. In particular Claude Code's own version is
reported as `null`: a script is not told which one launched it, and "a configured value is never a
measured capability" applies to a version string too.

## Flags

| Flag | Effect |
| --- | --- |
| `--live` | make one real worker call. Costs money on a metered provider. |
| `--provider <id>` | check this provider instead of the configured one |
| `--json` | the whole report as JSON on stdout |
| `--offline` | skip the capability probe — no network at all |
| `--probe-writes` | confirm writability by writing, not by asking permission |
| `--no-color` | no ANSI (also honours `NO_COLOR`; pipes are plain already) |
| `--version` | print the router version and exit |
| `--help` | usage, answered before any config load or I/O |

`--live` and `--offline` contradict each other and are refused.

## Exit codes

| Code | Meaning |
| --- | --- |
| **0** | no failures. Warnings and info never affect this. |
| **1** | at least one FAIL. |
| **2** | bad invocation — an unknown flag, or a missing value. |

`--json` uses the same codes: the machine path must not diverge from the human one.

## The JSON report

```json
{
  "schemaVersion": 1,
  "tool": "router-doctor",
  "version": "1.0.0",
  "generatedAt": "2026-10-04T12:00:00.000Z",
  "mode": { "live": false, "offline": true, "probeWrites": false },
  "project": {
    "plugin": { "name": "model-router", "version": "1.0.0" },
    "pluginRoot": "...",
    "node": "24.16.0",
    "platform": "win32",
    "osRelease": "10.0.26200",
    "claudeCodeVersion": null
  },
  "sections": [
    {
      "id": "worker-provider",
      "title": "Worker provider",
      "findings": [{ "level": "warn", "label": "GEMINI_API_KEY is not set", "detail": "..." }],
      "note": []
    }
  ],
  "counts": { "pass": 20, "warn": 5, "fail": 0, "info": 25 },
  "exitCode": 0
}
```

`level` is always one of `pass`, `warn`, `fail`, `info` — one vocabulary across both renderings.
`note` carries raw lines that are deliberately not findings, such as the pasteable pricing skeleton,
so the JSON is not a lossy view of the text.

## It is safe to paste

No secret is ever printed. For an API key doctor reports only presence, length and a four-character
prefix — enough to tell "set, looks like a Gemini key, 39 chars" from "set to an empty string" from
"set to a shell expansion that never expanded", which are the three failures people actually hit.

That guarantee is why the bug-report template asks for:

```bash
npm run doctor -- --json --offline
```

`--offline` makes it deterministic by skipping the provider probe.

## See also

- [getting-started.md](getting-started.md) — how to read your first doctor run
- [troubleshooting.md](troubleshooting.md) — what to do about each finding
- [configuration.md](configuration.md) — the settings doctor reports on
