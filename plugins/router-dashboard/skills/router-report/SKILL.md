---
name: router-report
description: Render or explain a model-router delegation report. Use when the user asks what delegation saved, how often tasks were delegated, what the worker cost, why a cost or saving is unavailable, or asks for an analytics report or dashboard over the telemetry store.
---

# Router report

Answers one question — **what did delegation actually do, over a window you choose?** — and
answers it from telemetry that already exists. It computes no cost, prices no model, calls no
worker and changes no configuration.

## Generating a report

```bash
npm run analytics                         # read it in the terminal, last 7 UTC days
npm run analytics -- --today
npm run analytics -- --30d --provider ollama
npm run report                            # one self-contained HTML file, path printed
npm run report -- --7d --out report.html
npm run analytics -- --json | npm run --silent report
```

Both commands are read-only. They write nothing except the HTML file `report` is asked for — not
the telemetry directory, not a lock, not a salt.

## Reading the result honestly

Four things in a report are routinely misread. If the user asks about any of them, say this rather
than guessing.

**"Worker cost: unavailable" does not mean zero.** Every rate in the bundled pricing table ships
`null`, so a default install produces no dollar figure at all. That is a refusal to price, not a
missing feature. `pricing.overrides` is what populates it.

**A cost of `$0.0000` with coverage is a real measurement.** It means an operator configured a
rate of literal zero, usually for a local model they do not pay for. It is not the same fact as an
unpriced call, and the report renders the two differently on purpose.

**Four refusal counts are never added together.** A worker failure, a governance denial, a context
refusal and an unpriced call are four different events with four different responses. A governance
denial in particular is a *successful* budget decision, not a router failure — and it is recorded
on a row whose routing reason says the gate approved.

**A negative saving is for investigation, not a verdict.** It can mean a small corpus, a verbose
worker, a slow model, an unnecessary delegation, a task mismatch or a missing baseline. It is never
clamped to zero.

## What a report cannot tell you

Say so plainly rather than estimating:

- **Hook, governance and capability latency.** No column records them. Deriving one from
  wall-clock deltas would measure the harness.
- **A measured primary-model baseline.** `primary_usage_method` is `none`, so the avoided figures
  remain counterfactual estimates. Estimated savings are not necessarily actual invoice savings.
- **Answer quality.** Nothing in the schema grades an answer. `npm run evals` is where quality
  lives, over a fixed corpus — and a benchmark result is evidence, never policy.
- **Why a particular cost is null, exactly.** The pricing layer discards its reason codes before
  writing, so the report re-derives an explanation from the columns that survive and labels it
  derived.

## Scope

This report is observational. It never changes a routing threshold, a budget, a provider default
or any other configuration, and it must not be used to do so: see
[`docs/analytics.md`](../../../../docs/analytics.md) for the metric definitions and
[`docs/savings-methodology.md`](../../../../docs/savings-methodology.md) for the two nets.
