# claude-model-router — working notes

A Claude Code plugin marketplace that routes bulk I/O work to a cheap worker model and measures
what it saved. Two plugins: `model-router` (writer) and `router-dashboard` (reader).

## Non-negotiables

1. **Zero npm dependencies.** Node 22.5+ stdlib only. Hooks are `node <script>.mjs` via exec-form,
   never bash, never `jq` — `jq` is not installed on many Windows dev machines and a hook that
   depends on it fails silently.
   Two registration traps, both verified live and both silent (see
   `docs/claude-code-hook-contract.md`): a hook entry with **both `args` and `timeout`** is never
   executed, and naming `./hooks/hooks.json` in `plugin.json` fails the whole plugin's hook load.
   `plugin validate --strict` catches neither.
2. **The gate fails open.** `lib/routing.mjs decide()` is synchronous, makes no network call and
   imports no provider. Unconfigured worker, spent budget, sensitive path, malformed config — all
   return `decision: 'allow'`. A broken router must degrade to plain Claude Code, never to a
   blocked session.
   Every new branch in `decide()` needs a fail-open test.
3. **Telemetry can never break a hook.** The sink is wrapped in `try/catch` end to end, is
   synchronous, performs no network I/O and no `await`, and swallows every error.
4. **One record = one `fs.writeSync` of one Buffer ending in `\n`.** Never two syscalls per record;
   that is what makes concurrent appends safe.
5. **A configured value is never a measured capability.** Three numbers get called "the
   context limit" — what the operator set, what the provider advertises, and what the runtime
   actually served — and `statusForSource()` is the only place `source` maps to `status`.
   `contextTokens === null` iff `status === 'unknown'`; unknown context is never infinite
   context. `maxInputBytes` is a TRANSPORT ceiling in bytes and no context math may read it.
   Measured, and the reason this exists: Ollama sizes its serving window from available memory
   and then silently drops the MIDDLE of an over-long prompt — a 17,368-token prompt came back
   as `prompt_eval_count` 2060 with both end markers intact. So `num_ctx` is always sent when
   the window is known, output may be capped to make room, and **input is never truncated**: an
   oversized prompt is refused with `context_exceeded`. A capability we cannot determine
   proceeds and warns, because unknown must degrade to plain Claude Code, not to a blocked
   session.

6. **Never overstate savings.** Net of the returned answer, hook-proven files only, `chars/4` (which
   under-counts code), residency 0 unless measured. Missing usage is `NULL`, never `0`. Unpriced
   models are `NULL`, never a guessed rate. Do not add a `tokens x turns` multiplier — Claude Code
   pays cache rates, so that claim is 10-40x inflated.
7. **Never delegate reasoning.** Debugging, architecture, security, precise edits and small files
   stay with Claude. Changing a threshold or glob default requires a negative eval proving the
   system still refuses to delegate those.
   `test/routing.exclusions.test.mjs` is that eval for one baseline input;
   `test/evals.protected.test.mjs` is it for every corpus input crossed with every protected
   task type. A benchmark result is evidence and never changes policy by itself — see
   `docs/benchmark-methodology.md`.
   **Task intent may shape the worker's request and may never reach the router.** `taskType` stays
   a literal in `hook/adapter.mjs`, `decide()`'s 16-field input gains no intent field, and
   extraction happens after the gate has ruled. `evals.protected.test.mjs`'s header records why
   that guarantee is narrower than it was and no longer vacuous; read it before touching
   `hook/intent.mjs`.

8. **Never send more than was asked for.** The worker gets the task, the selected file content
   and the mode's instructions. Not an env var, not a credential, not unrelated conversation, not
   an arbitrary session file. `hooks.taskIntent.source` defaults to `none` because forwarding the
   developer's prompt is their decision, not a default they discover afterwards. Intent text
   crosses `redactSecrets()`; **file content still does not**, and `test/task.security.test.mjs`
   pins that exposure in both directions so it cannot drift quietly.

9. **Three decisions, never collapsed.** `routing.mjs` answers "would this be APPROPRIATE to
   delegate", `governance/` answers "are we currently ALLOWED to", `context-budget.mjs` answers
   "CAN this worker run it". Governance runs AFTER `decide()` has ruled and never reaches back
   into it: routing imports no governance module and names no `budget.` leaf, and
   `test/governance.isolation.test.mjs` pins both statically. The tempting shortcut — feeding
   `workerUnavailableReason: 'budget_exceeded'` into the gate's step 11 — is rejected on the
   record, because it would let a budget rewrite a routing classification and would leave a row
   saying the budget was spent without saying whether the read was delegation-worthy at all.
   `budget_exceeded` stays declared and unreachable; that is a decision, not an oversight.
   Governance fails open on every branch, like the gate, and **every budget limit ships `null`**
   — it is wired and enforces nothing until an operator configures one. See `docs/governance.md`.

## Layout

- `plugins/model-router/lib/` — the engine. `config.mjs`, `routing.mjs`, `context-budget.mjs`
  and `providers/capability.mjs` are pure and heavily tested; `providers/` and `telemetry/` are
  the two swap points.
- `plugins/model-router/lib/context-budget.mjs` + `lib/providers/capability.mjs` — the context
  model. Both import NOTHING, which is what lets `config.mjs` read the coherence rules without
  pulling a provider onto the hot path. They answer "does this request fit this model" and "how
  sure are we"; they never answer "should this be delegated". A context window is deliberately
  NOT a routing input — `docs/worker-capability.md` §6 argues why, and
  `test/routing.capability.test.mjs` pins the absence.
- `plugins/model-router/lib/governance/` — the budget layer. `policy.mjs` is pure and imports
  NOTHING (the decision, plus `describeGovernance()` for doctor); `ledger.mjs` is the only impure
  file, holding spend and in-flight reservations behind an `openSync('wx')` lock with `fs` and
  `now` injected, exactly as `hook/facts.mjs` does; `index.mjs` composes them and owns nothing
  else. The short-circuit in `checkBudget()` is load-bearing: with every limit `null` it returns
  on a pure object walk and never opens the ledger, which is what keeps a default install at
  0.0008 ms and zero filesystem I/O. Measured cost comes from `telemetry/index.mjs`'s
  `priceWorkerUsage()` — the one pricing implementation, exposed rather than duplicated.
- `plugins/model-router/lib/dispatch/task.mjs` — the task builder, and the REDACTION BOUNDARY.
  Pure. It answers "what should the worker do"; `routing.mjs` answers "should this be delegated".
  Do not merge them. It takes the base task as a parameter because `lib/` may not import `hook/`.
- `plugins/model-router/lib/hook/intent.mjs` — recovers the newest prompt from the session
  transcript, gated by `hooks.taskIntent.source` (default `none`). Called AFTER `decide()`; that
  ordering is the enforcement that keeps prompt text out of routing, and it is pinned.
- `plugins/model-router/lib/hook/` + `hooks/` — the Claude Code adapter, and the only impure
  layer on the hot path. It may import `node:fs` and `node:path` and nothing else; the engine must
  never import it. A hook writes one JSON object to stdout at most and always exits 0.
- `plugins/model-router/lib/analytics/` — the READ model, and the fourth separate decision layer.
  It answers "what did delegation do over this window" and answers none of the other three
  questions: it imports no pricing module, names no per-million divisor, and sums stored money
  through the one shipped aggregator. Every file is pure — no `node:` import anywhere in the layer,
  because `openStoreFromConfig()` defaults its own `fs` — so the whole engine is testable from an
  in-memory row array. The fold behind `aggregate()` (`aggInit`/`aggPush`/`aggMerge`/
  `aggFinalize`) was extracted into `telemetry/aggregate.mjs` so there is exactly ONE
  implementation of the coverage model; a mirrored copy would pass its own tests and drift.
  Every aggregate names the POPULATION it covers, because savings columns are null on every
  `gate_block` row by construction and a coverage figure without its denominator is not
  information. See `docs/analytics.md`.
- `plugins/router-dashboard/` — renders an analytics response it is handed. It must never import
  router code or recompute money; cost is computed once at write time and stamped with its
  pricing/calc version. Nothing under its `lib/` imports even a node builtin, which is what makes
  "it cannot read a store" structural rather than a policy; `scripts/collect.mjs` is the single
  file permitted to spawn, because `npm run report` has to be one command and a spawn is not an
  import.
- `test/` — `node --test`. `test/behavioural/` drives real `claude -p` sessions.
- `test/evals/` — the evaluation framework, and `test/fixtures/evals/` its corpus. It measures the
  router and never changes it: it calls `buildEvent()` but never `emitEvent()`, never reads the user's
  config, and exports no notion of a better threshold. `evals.isolation.test.mjs` enforces all three
  statically. `evals.protected.test.mjs` is the cross-product negative eval demanded by rule 7 below.

## Conventions

- ESM `.mjs` throughout, no transpile, no build step.
- Config access goes through `loadConfig()`. Never read `process.env` for a setting that has a
  `SPEC` entry — the env var is declared there and the layering is tested.
- After changing `SPEC` in `config.mjs`, run
  `node plugins/model-router/scripts/gen-config-schema.mjs`. CI fails on a stale schema.
- Enums are open on read: an unknown value is preserved and bucketed as `other`, never rejected.
  The one documented exception is an EXPECTATION: every field in an eval case's `expected` block is
  closed and rejects, because an open enum on an expectation makes it unfalsifiable — a typo'd
  reason bucketing to `other` yields a case that can never fail. See `docs/evaluation.md`.
- Dev loop: `claude --plugin-dir ./plugins/model-router -p "..."` — no install needed.

## Commands

```bash
npm test                 # unit + integration, no network, no API key
npm run doctor           # diagnose config, provider, capability, hook, telemetry, governance
npm run budget           # read-only: current limits, UTC period and spend
npm run analytics        # read-only: what delegation did over a window. --json pipes to report
npm run report           # one self-contained HTML report; prints its path
npm run validate         # claude plugin validate --strict on all three manifests
npm run test:behavioural # real sessions graded over stream-json (phase 8, not yet written)
npm run evals            # deterministic benchmark: offline, keyless, reproducible
npm run evals:sweep      # the same, plus the threshold sweep
npm run evals:build      # regenerate the corpus after editing the manifest
```
