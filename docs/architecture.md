# Architecture

How the pieces fit, and which properties are enforced by a test rather than by intention.

This is assembly, not new claims: every rule here is stated in a module header and pinned
somewhere in `test/`. The table at the end maps each claim to the test that holds it.

## The shape

```
  Claude Code
      |
      |  PreToolUse(Read)
      v
  L1  hooks/pre-tool-use.mjs            the adapter. Impure, on the hot path.
      lib/hook/                          Reads stdin, writes at most one JSON object, ALWAYS exits 0.
      |
      v
  L2  lib/routing.mjs  decide()         "would this be APPROPRIATE to delegate?"
      lib/routing-policy.mjs             Pure, synchronous, no network, no provider import.
      |
      v
  L3  lib/governance/                   "are we currently ALLOWED to?"
      lib/context-budget.mjs            "CAN this worker physically run it?"
      |
      v
  L4  lib/dispatch/  +  lib/providers/  the worker call itself.
      lib/telemetry/                     One row written per delegation, synchronously.
      |
      v
  lib/analytics/  ->  router-dashboard   "what did delegation DO over this window?"
```

## Four decisions, never collapsed

The central design commitment. Four separate questions, four separate modules, asked in order, and
none may reach back into an earlier one.

| Question | Module | Pure? |
| --- | --- | --- |
| Would this be **appropriate** to delegate? | `lib/routing.mjs` | yes |
| Are we currently **allowed** to? | `lib/governance/` | `policy.mjs` yes, `ledger.mjs` no |
| **Can** this worker run it? | `lib/context-budget.mjs`, `lib/providers/capability.mjs` | yes |
| What did delegation **do**? | `lib/analytics/` | yes, entirely |

Why it matters, concretely. There is an obvious shortcut: feed `budget_exceeded` into the routing
gate as one more reason to decline. It is rejected on the record, because it would let a budget
rewrite a routing *classification* — and it would leave a telemetry row saying the budget was spent
without saying whether the read was worth delegating at all. So `budget_exceeded` stays declared and
unreachable in the routing vocabulary. That is a decision, not an oversight.

The same reasoning keeps a **context window out of the routing inputs**. Whether a worker can hold a
prompt is a capability question, not a judgement about the work, and conflating them would mean a
bigger model silently changed what the router considered reasonable to delegate.

## What is pure, and why that is the interesting part

Pure here means: imports no node builtin, performs no I/O, and makes no network call.

| Module | Why it must be pure |
| --- | --- |
| `lib/routing.mjs` | On the hook's hot path. Synchronous and side-effect-free so the gate cannot hang or throw. |
| `lib/context-budget.mjs`, `lib/providers/capability.mjs` | Import **nothing**, which is what lets `config.mjs` read the coherence rules without pulling a provider onto the hot path. |
| `lib/governance/policy.mjs` | Imports nothing. The severity matrix is unit-testable without a ledger. |
| `lib/doctor/report.mjs` | Same reason: the severity matrix is driven from hand-built inputs rather than by spawning a process. |
| `lib/dispatch/task.mjs` | The redaction boundary. A boundary that did I/O could not be reasoned about. |
| all of `lib/analytics/` | No `node:` import anywhere in the layer, so the whole read model is testable from an in-memory array of rows. |
| all of `plugins/router-dashboard/lib/` | Imports **not even a node builtin**. This is what makes "the dashboard cannot read a store" structural rather than a policy — it has no way to, rather than merely a rule against it. |

The impure parts are deliberately few: `lib/hook/` and `hooks/` (the adapter), `lib/telemetry/` and
`lib/governance/ledger.mjs` (the writers), `lib/providers/` (the network), and `scripts/`.

## Three rules the hot path lives by

**The gate fails open on every branch.** Unconfigured worker, spent budget, sensitive path,
malformed config, unreachable daemon — every one returns `allow`. A broken router must degrade to
plain Claude Code, never to a blocked session. Every new branch in `decide()` needs a fail-open
test.

**Telemetry can never break a hook.** The sink is wrapped in `try/catch` end to end, is synchronous,
performs no network I/O and no `await`, and swallows every error.

**One record is one `fs.writeSync` of one Buffer ending in `\n`.** Never two syscalls per record;
that single-syscall property is what makes concurrent appends safe on a local filesystem.

And the hook itself writes at most one JSON object to stdout and **always exits 0** — `exit 2` would
turn stderr into Claude's feedback channel and block the read.

## Two boundaries that cannot be crossed

**`lib/` may not import `hook/`.** The engine must be usable without the adapter. This is why
`dispatch/task.mjs` takes the base task as a *parameter* rather than building it from a hook
payload.

**`router-dashboard` may not import `model-router`.** The dashboard renders an analytics response it
is handed. It never reads a store and never recomputes money — cost is computed once at write time
and stamped with its pricing and calc version. `scripts/collect.mjs` is the single file permitted to
*spawn* the router's read-only CLI, because a spawn is not an import.

## The honesty rules

These shape more of the code than the routing logic does.

**A configured value is never a measured capability.** Three numbers get called "the context limit":
what the operator set, what the provider advertises, and what the runtime served.
`statusForSource()` is the only place a source maps to a status, and `contextTokens === null` iff
`status === 'unknown'`. **Unknown context is never infinite context.**

**Never overstate savings.** Net of the returned answer, over hook-proven files only, `chars/4`
(which under-counts code), residency 0 unless measured. Missing usage is `NULL`, never `0`. An
unpriced model is `NULL`, never a guessed rate. There is deliberately no `tokens × turns`
multiplier: Claude Code pays cache rates, so that claim would be inflated tenfold or more.

**Never send more than was asked for.** The worker gets the task, the selected file content and the
mode's instructions. Not an env var, not a credential, not unrelated conversation.
`hooks.taskIntent.source` defaults to `none` because forwarding the developer's prompt is their
decision, not a default they discover afterwards. Intent text crosses `redactSecrets()`; **file
content does not**, and that asymmetry is pinned in both directions so it cannot drift quietly.

**Never delegate reasoning.** Debugging, architecture, security, precise edits and small files stay
with Claude. Changing a threshold or a glob default requires a negative eval proving the system
still refuses to delegate those.

**Task intent may shape the worker's request and may never reach the router.** `taskType` stays a
literal in the adapter, `decide()`'s input gains no intent field, and extraction happens *after* the
gate has ruled. That ordering is the enforcement.

## Every claim, and the test that holds it

| Claim | Pinned by |
| --- | --- |
| Routing imports no governance module and names no `budget.` leaf | `test/governance.isolation.test.mjs` |
| A context window is not a routing input | `test/routing.capability.test.mjs` |
| The gate fails open on every branch | `test/hook.failopen.test.mjs`, `test/routing.decide.test.mjs` |
| Nothing under `router-dashboard/lib/` imports a node builtin | `test/dashboard.isolation.test.mjs` |
| No `node:` import anywhere in the analytics layer | `test/analytics.isolation.test.mjs` |
| The telemetry math layer is pure | `test/telemetry.isolation.test.mjs` |
| Intent is redacted; file content is not | `test/task.security.test.mjs` |
| Intent never reaches routing | `test/evals.protected.test.mjs`, `test/intent.contract.test.mjs` |
| Reasoning work is never delegated, over the whole corpus | `test/evals.protected.test.mjs` |
| `hooks.json` has no `timeout`, and `plugin.json` no `hooks` key | `test/hook.security.test.mjs` |
| One record is one syscall, and concurrent appends survive | `test/telemetry.concurrency.test.mjs` |
| The ledger lock serialises across real processes | `test/governance.concurrency.test.mjs` |
| The evals framework measures and never mutates | `test/evals.isolation.test.mjs` |
| Every version agrees, and no hook is registered twice | `test/packaging.test.mjs` |
| Every environment variable is declared | `test/env.inventory.test.mjs` |
| A clean install calls no worker and writes nothing | `test/team.safety.test.mjs` |

## Two silent traps, recorded

Both verified live, both silent, and neither caught by `plugin validate --strict`:

1. A hook entry with **both `args` and `timeout`** is never executed.
2. Naming `./hooks/hooks.json` in `plugin.json` fails the **whole plugin's** hook load.

`hooks/hooks.json` is auto-discovered, so the manifest must stay silent about it. Both are asserted,
because the symptom of either is that nothing happens at all.

## See also

- [routing.md](routing.md) — `decide()`'s full contract
- [hook-integration.md](hook-integration.md) — the adapter, and verifying an installation
- [claude-code-hook-contract.md](claude-code-hook-contract.md) — the host's behaviour, as verified
- [worker-dispatch.md](worker-dispatch.md) — provider resolution and the error vocabulary
- [worker-capability.md](worker-capability.md) — the context model
- [governance.md](governance.md) — the budget layer
- [telemetry-schema.md](telemetry-schema.md) — the contract between the two plugins
- [analytics.md](analytics.md) — the read model
