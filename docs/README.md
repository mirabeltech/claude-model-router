# Documentation

Grouped by the question you have, not by the order things were built.

New here? [getting-started.md](getting-started.md), then come back.

## Getting it working

| Document | Answers |
| --- | --- |
| [getting-started.md](getting-started.md) | From nothing to a measured delegation, in fifteen minutes. |
| [install.md](install.md) | The three install modes, team setup, upgrading, removal. |
| [providers.md](providers.md) | Ollama and Gemini setup, and what each can and cannot do. |
| [configuration.md](configuration.md) | All 77 settings, the precedence order, and secrets. |
| [environment.md](environment.md) | Every environment variable, generated and conformance-tested. |
| [doctor.md](doctor.md) | The diagnostic: four levels, exit codes, the JSON report. |
| [troubleshooting.md](troubleshooting.md) | Thirteen named failures, each with its fallback behaviour. |

## What it does

| Document | Answers |
| --- | --- |
| [routing.md](routing.md) | `decide()`'s full contract: the two axes, the rule order, the thresholds. |
| [what-we-do-not-delegate.md](what-we-do-not-delegate.md) | The refusal list, as code rather than prose. |
| [worker-dispatch.md](worker-dispatch.md) | Provider resolution, timeouts, and the error vocabulary. |
| [worker-task-construction.md](worker-task-construction.md) | What the worker is actually sent, and the redaction boundary. |
| [worker-capability.md](worker-capability.md) | The three numbers called "the context limit". |

## What it costs, and what it saved

| Document | Answers |
| --- | --- |
| [savings-methodology.md](savings-methodology.md) | How a saving is counted, and every way it is kept conservative. |
| [telemetry-schema.md](telemetry-schema.md) | Every field of a row. The contract between the two plugins. |
| [analytics.md](analytics.md) | The read model, and what a report can and cannot tell you. |
| [governance.md](governance.md) | Budgets: what is enforced, and what is explicitly not guaranteed. |

## How it is wired

| Document | Answers |
| --- | --- |
| [architecture.md](architecture.md) | **Start here for the shape.** Four decisions, the purity map, and the test that pins each claim. |
| [hook-integration.md](hook-integration.md) | The `PreToolUse` adapter, and verifying an installation. |
| [claude-code-hook-contract.md](claude-code-hook-contract.md) | The host's behaviour as verified, including two silent traps. |
| [failure-modes.md](failure-modes.md) | What happens when each part breaks, and why fail-open, fail-closed and safe refusal are not interchangeable. |

## Extending it

| Document | Answers |
| --- | --- |
| [adding-a-provider.md](adding-a-provider.md) | The five-export contract a new provider must satisfy. |

## Evidence

Measurements and method, kept separate from the reference docs because a benchmark result is
evidence and never changes policy by itself.

| Document | Answers |
| --- | --- |
| [evaluation.md](evaluation.md) | The eval framework, the corpus, and what it may not do. |
| [benchmark-methodology.md](benchmark-methodology.md) | What the benchmark's numbers are worth. |
| [phase-8-findings.md](phase-8-findings.md) | A dated lab notebook: what was measured, and what it changed. |
| [phase-12-hardening.md](phase-12-hardening.md) | The final hardening pass: what broke, what it corrected, and what is still unmeasured. |

## Releasing it

| Document | Answers |
| --- | --- |
| [release-v1.md](release-v1.md) | **What V1 is.** The acceptance matrix, the known limitations, and the release decision. |
| [post-v1-backlog.md](post-v1-backlog.md) | What is deliberately not built yet, ranked, with the reason each item sits where it does. |

## Elsewhere in the repo

- [`examples/README.md`](../examples/README.md) — which example config goes where
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — the rules a change has to respect
- [`../SECURITY.md`](../SECURITY.md) — what leaves your machine, and what never does
- [`../CLAUDE.md`](../CLAUDE.md) — the working notes, and the source of truth for the
  non-negotiables
