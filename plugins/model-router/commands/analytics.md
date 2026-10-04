---
description: Report what delegation actually did over a window, from local telemetry
allowed-tools: Bash(node:*)
---

Report what delegation did over a window the user chooses, from telemetry that
already exists. This reads only; it computes no cost, prices no model, calls no
worker and changes no configuration.

Run this (default window is the last 7 UTC days; `--today`, `--24h`, `--30d`,
`--all` and `--start`/`--end` also work):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/analytics.mjs"
```

Then read the result honestly. Four things are routinely misread:

- **"Worker cost: unavailable" is not zero.** Every rate in the bundled pricing
  table ships `null`, so a default install produces no dollar figure at all.
  That is a refusal to price, not a missing feature.
- **`$0.0000` with coverage is a real measurement** — an operator configured a
  rate of literal zero, usually for a local model. Not the same fact as unpriced.
- **Never add the refusal counts together.** A worker failure, a governance
  denial, a context refusal and an unpriced call are four different events. A
  governance denial is a *successful* budget decision, not a router failure.
- **A negative saving is for investigation, not a verdict.** It is never clamped.

Savings are *estimates* over files a hook actually blocked, never measured
invoice savings. If the user wants the HTML report instead, that is
`npm run report` from a repo checkout.
