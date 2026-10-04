---
description: Diagnose the model router — configuration, worker, capability, hook, telemetry and governance
allowed-tools: Bash(node:*)
---

Run the router's own diagnostic and explain what it found.

Run this, and show the output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

Then help the user read it, keeping these distinctions straight — they are the
whole point of the four levels:

- **PASS** — checked, and fine.
- **WARN** — a *degraded* router, not a broken one. The routing gate fails open
  on every branch, so every WARN state still leaves Claude Code working exactly
  as it does without this plugin. Do not present a WARN as a failure.
- **FAIL** — a misconfiguration with a definite fix. Only FAIL affects the exit
  code (1); WARN and INFO never do.
- **INFO** — an echo of what is configured, not a verdict.

Two readings people get wrong:

- **"GEMINI_API_KEY is not set" as a WARN is the shipped default, not a mistake
  the user made.** The plugin installs pointing at Gemini and requires no key to
  install. Offer the two real options: set the key, or switch to a keyless local
  worker (see `docs/providers.md`).
- **An unknown context window is not an unlimited one.** If capability status is
  `unknown` or `assumed`, say so plainly rather than quoting a number as if it
  were measured.

Doctor writes nothing and creates no directories by default. If the user needs
the writability of the telemetry or budget directory confirmed by actually
writing, add `--probe-writes`. `--offline` skips the provider capability probe.
