# Phase 12 findings

> A dated working record of the final hardening pass, in the form of
> [phase-8-findings.md](phase-8-findings.md). The release decision it leads to is in
> [release-v1.md](release-v1.md); the fail-open matrix it produced is
> [failure-modes.md](failure-modes.md).
>
> **Run on:** Windows 11 Pro 10.0.26200, Node 24.16.0, Claude Code 2.1.177 — 2026-10-04
> **Baseline commit:** `bba7981` · **Final commit:** this one

## 1. What this phase was for

Not feature development. One question: *can a team safely install and use this as a V1
model-routing plugin, and do its architectural contracts hold under realistic failure?* The method
was to try to break it, close what broke, and write down the result — including what remains
unmeasured.

## 2. Counts

| | Baseline | Final | Delta |
|---|---|---|---|
| Tests | 2250 | **2389** | +139 |
| Passing | 2249 | 2388 | +139 |
| Failing | 0 | **0** | — |
| Skipped | 1 | 1 | — |
| Test files | 98 | 109 | +11 |
| Files changed | — | 28 | +4,204 / −68 lines |

The skip is unchanged: `test/analytics.performance.test.mjs`'s 100,000-row case, gated behind
`ROUTER_PERF_FULL=1` because it writes ~300 MB of scratch. It was run once during this phase.

**Test count was not the objective.** +139 tests closed 13 previously-unreachable error branches,
added a whole-repository import graph, and walked a boundary nobody had walked. Several of the most
useful additions are three assertions inside an existing test.

## 3. The baseline was green

Recorded before anything was touched, because hardening on top of a red baseline proves nothing:
2250 tests with one skip, `validate` clean on three manifests, `doctor` at 19 pass / 5 warn / 0 fail,
evals and the sweep clean over 26 cases and 107 gates, analytics reproducible byte for byte, `git
status` clean. One pre-existing hygiene problem: 16 uncleaned scratch directories under `test/.tmp`.

## 4. What was actually wrong

Eleven findings. Four were defects and are fixed; the rest were gaps in evidence.

### 4.1 CLAUDE.md's second non-negotiable was held by the wrong test

Layering was enforced by seven per-directory regex allowlists plus a security gate — **eight call
sites, four distinct regex bodies**. Two of those bodies could not match a multi-line
`import {\n … \n} from`, and that blind spot covered **23 of the 199 edges** in `plugins/**`.

Proved by planting one. A multi-line `import {\n readFileSync,\n} from 'node:fs'` added to
`routing.mjs` was caught by **exactly one assertion in the entire suite** — a raw-source `/node:/`
scan in `routing.capability.test.mjs`. The test whose stated job is routing purity,
`telemetry.isolation.test.mjs:100`, did not see it at all. The same blind spot meant the dispatch
allowlist had never actually read `dispatch/index.mjs -> ./contract.mjs` or
`-> ../context-budget.mjs`: both are permitted, so it was passing **by luck**.

Three areas had no census at all: `lib/providers/`, `lib/doctor/`, and the top-level `lib/*.mjs`
files. Nothing built a whole-repository edge list; nothing detected a cycle.

**Fixed** by one shared scanner and `test/architecture.graph.test.mjs`: 75 files, 199 edges, 0
cycles, every file ranked, and an **exact per-file node-builtin table that is empty by default** —
which closes the multi-line hole in whatever shape the import is written. Six of the eight local
copies now use the shared scanner; the two retained ones carry their reasons in code.

The scanner had to be a **lexer, not a better regex**. A strip-comments-then-regex first draft
produced three false positives, all inside string literals in *code*: a keyword stoplist in
`evals/evaluators.mjs` containing `'import'` and `'from'`, a `from '…'` inside a string in
`evals.determinism.test.mjs`, and planted source in `evals.gates.test.mjs`. String bodies are now
replaced with opaque placeholders before any pattern runs.

### 4.2 The entire governance error surface had no test

CLAUDE.md rule 9 says governance "fails open on every branch". Grepping `budget_threw`,
`budget_state_`, `budget_reserve_` and `finalize_threw` across `test/` returned **nothing**. The
layer that is allowed to stop a delegation had no test for any of its failure paths.

The same was true of much of telemetry: `emit_failed`, `reopen_failed`, `ESHORTWRITE`,
`serialize_failed` and `carcass_over_cap` appeared nowhere. "It degrades gracefully" was covered;
"it says what went wrong" was not — and those are the same thing to a `try/catch` and completely
different things to an operator.

**Closed.** 13 new fail-open rows plus 5 serialization rows, all driven from the public parameter
surface with a stub `fs` or a hostile getter — no monkeypatching, no real filesystem. Each proved
load-bearing: making the unreadable-ledger branch fail closed trips 7 assertions, un-naming
`budget_threw` trips 3, claiming a reservation that was never written trips 7.

A related discovery: `hook.failopen.test.mjs`'s existing lying-`fs` row **does not reach governance
at all**. With every limit `null`, `checkBudget` short-circuits on a pure object walk and never
opens the ledger — which is the design working, and also why a hostile `fs` proves nothing about
governance unless a limit is configured.

### 4.3 A rejected configuration value was echoed into a warning — FIXED

`coerceLeaf` had one branch that quoted the offending value back: `expected int, got "AIza…"`.
Warnings are printed by `doctor` and land in whatever a developer pastes into a bug report, and
since **no setting holds a credential**, a key in a config file is always a mistake — so it was
precisely the value most likely to be mistyped into a numeric field.

Every other branch in that function already reported a type or a constraint. Now this one does too,
which is both safer and more consistent; the field name on the warning is what keeps it actionable.
Nothing pinned the old text.

### 4.4 The documented release tag could never have worked — FIXED

`docs/install.md` said releases are tagged `model-router--v<version>`. `.github/workflows/release.yml`
triggers on `tags: ['v*']` and strips a leading `v` to check against the manifests. A tag in the
documented form would never have fired the workflow. The document now matches the automation.

### 4.5 Sixteen leaked scratch directories, and one descriptor per event — FIXED

A full run left 16 directories under `test/.tmp`, each with a ledger and a lock file. `fs.rmSync`
has no retries by default, and on Windows a directory cannot be removed while a child process holds
a handle into it; the suites that spawn writers call `cleanup()` as soon as the last child reports,
before the OS has torn those processes down. `force: true` only suppresses `ENOENT`. Sixteen leaks
to zero.

The more serious leak was already fixed but untested: the telemetry sink cache is keyed on config
**identity**, so a caller building a fresh config object per call used to get a fresh sink per call
and never closed the previous one — one leaked descriptor per event, `EMFILE` a few hours into a
long delegation loop. Now pinned as open/close arithmetic; removing the guard fails the file.

### 4.6 Stale documentation that asserted the opposite of the code

Most seriously, `docs/benchmark-methodology.md` stated *"the three `skills/` directories are
empty… the protected-category guarantee is vacuous, and safe because it is vacuous."* Those
directories were removed phases ago and the guarantee now rests on a cross-product eval. The
passage contradicted CLAUDE.md rule 7, `docs/evaluation.md` and
`test/evals.protected.test.mjs`.

Also corrected: `docs/worker-dispatch.md` claiming "nothing in Claude Code calls it yet" and "there
are still no skills"; a "bulk-reader skill" named in `what-we-do-not-delegate.md` that does not
ship; "steers to the skill" in the user-facing description of `routing.bulkRead.enforce` (which
regenerates the settings table and the schema); "steering Claude to a skill is Phase 6" in
`hook/run.mjs`; "Values must equal the shipped skill names" in `routing-policy.mjs`;
`CLAUDE.md`'s reference to a `test/behavioural/` that held no cases — the empty tree is removed.

### 4.7 The one published number with no harness — FIXED

`docs/governance.md` published five timings, headlined by `checkBudget` at 0.0008 ms, attributed to
"2000 iterations after warmup". Grepping `warmup` or `iterations` found the prose line and nothing
else. Every other quoted number in the repository traced to a committed harness.

`test/governance.latency.test.mjs` now reproduces all five. The claim that matters is asserted by
**counting syscalls rather than watching a clock**: on a default install `checkBudget` is driven
with an `fs` whose every method throws and must still return `budget_not_configured`.

### 4.8 The tested host version could drift silently — FIXED

`2.1.177` appeared in six files with nothing keeping them in step; bumping five and missing one
would have failed nothing. Declared once now, asserted both ways. Re-verified against the installed
CLI: still 2.1.177, so there was no drift to reconcile, and the contract document has the dates it
previously lacked.

### 4.9 Two branches are unreachable, and are stated rather than faked

Following the `budget_exceeded` precedent. `jsonl.mjs`'s literal `'serialize_failed'` fallback is
dead code: both of `serializeRecord`'s null-returns push a problem first, so `problems.length === 0`
with `line === null` cannot occur. And the bare `catch {}` in `pre-tool-use.mjs` cannot be reached
from the process boundary — every call inside its `try` is specified never to throw. For the latter
the test asserts the property the catch exists to preserve: the write and the config load inside
the `try`, `exit 0` outside it.

### 4.10 The null-sink fallback — examined, documented, not changed

`resolveSinkId` states in capitals *"FAIL OPEN TO `jsonl`, NEVER TO `null`. Losing data is the one
outcome that is never acceptable"* — and `openSinkFromConfig`'s catch returns a null sink, whose
`append()` reports `{ok: true, bytes: 0}`. A caller reading `ok` sees success; the row is gone.

Those are not in conflict as code — resolution cannot choose null, construction can — but the
module's own rule does not distinguish them. Reviewed and **deliberately not changed**: `openSink`
performs no I/O, so only a module-load failure reaches the catch; returning a handle that throws
breaks a stronger rule; `bytes` is the field that tells the truth. What was genuinely missing is
that the one mitigation — a returned warning `doctor` surfaces — had no test. It is now pinned as
load-bearing, and the limitation is disclosed in [failure-modes.md](failure-modes.md) §7.

### 4.11 Four assumptions about the code that were wrong

Written down because each was a misreading of a good design, and the design deserves the record:

1. **`routing_decision` is `deny` on a successful delegation.** Deny the direct `Read`, return the
   worker's answer instead. `task_type` is `bulk_read`. Two taxonomies, and a reader that conflated
   them would report every delegation as a refusal.
2. **A budget denial keeps `routing_reason: threshold_met`** and puts the refusal in the governance
   columns. That is rule 9 visible in one row: the read *was* delegation-worthy **and** the budget
   stopped it. Collapsing them loses which.
3. **`fits` is tri-state.** `false` is a definite claim, available only because the window is
   known; `null` means *cannot say*. A boolean would force an unknown window to invent an answer.
4. **A hook-deadline abort is `aborted`, not `timeout`** — the hook cancelled the request, which is
   a different event from the provider's own timeout classification.

A fifth, about the resolver: the first configuration fuzz used one hostile list for every leaf and
failed on values that are perfectly valid. `'() => true'` is a non-empty string; so is
`'__proto__'`; so is a ten-thousand-character string. The resolver has no business rejecting an
arbitrary `worker.provider` — an unknown provider is caught later and reported as
`worker_not_ready`. The draft was asserting a stricter contract than the product promises **or
should**.

## 5. End-to-end evidence

`clean-install.test.mjs` already walked install → delegate → analytics → report and asserted its
**endpoints**. Two new files assert the **pipeline**: named evidence at each of nine layers for one
delegation, and all seven refusal paths through to the rendered HTML.

The telemetry row is what makes that possible — every layer's verdict lands in a column of one
JSONL line, so reading one row off disk observes nine layers without reaching into any of them. If
that ever becomes hard to write, the schema has stopped being a complete account of what happened.

The refusal file's last test is the one it exists for: a safe refusal and a worker failure land in
different analytics classes, and success rate is computed over dispatched calls only. Merged, they
would show a correctly-cautious router as a broken one — which is how a team concludes the plugin
does not work and removes it.

## 6. Live worker results

Three scenarios against Ollama with `mistral:latest`. `smoke:hook` gained `--scenario`, because a
smoke test that only ever exercises the happy path proves the thinnest half of the contract. The
exit code is scenario-aware: for two of the three, a fall-open **is** the pass condition.

| Scenario | Result | Elapsed |
|---|---|---|
| `delegate` | PASS — real summary, `in=674 out=80` provider-reported, 187 tokens avoided, cost `NULL` | 80.1 s |
| `context-exceeded` | PASS — `context_exceeded`, no request sent | 157 ms |
| `unavailable` | PASS — `transport`, fell open | 272 ms |

Getting the delegation to pass took three attempts, and the reasons are evidence rather than noise:

1. `--timeout 600000` **silently became 20000** — the SPEC maximum is 120000 and the resolver falls
   back to the default rather than clamping. Exactly the behaviour `config.fuzz` asserts, observed
   by accident on a real run.
2. 120 s was not enough for 13 KB. So the raw provider was measured directly: **10.6 tok/s prompt
   evaluation, 3.8 tok/s generation** — roughly half the 22.3 tok/s phase 8 recorded. Hardware, not
   router.
3. The passing run therefore uses a 900-byte file with the threshold lowered to 512, which the
   script prints on every run, because a smoke test that quietly moved a shipped threshold proves
   less than it claims.

**Gemini live: UNAVAILABLE** — no key on this machine, reported rather than substituted.

## 7. Determinism

Five generated-file gates clean (`gen:schema`, `docs:config`, `docs:env`, `sync:version`,
`evals:build`). `analytics --json` twice: byte-identical. `report` twice with `--now` pinned:
byte-identical. Two identical delegations in separate processes agree on every column except the
eight that are genuinely per-run, and those eight are asserted to *differ* — an exclusion list that
hides a bug is worse than no list.

One self-inflicted lesson: a first attempt showed the report differing between runs. The cause was
running `analytics` without `--silent`, so npm's banner made the JSON unparseable and `--input`
silently fell back to the collector. The product was correct; the measurement was not.

## 8. What was deliberately not done

No Phase 13. No backlog items implemented. No new provider or worker mode. No routing-policy,
governance-default or provider-default change. **No `schema_version` or `calc_version` bump** —
nothing backward-incompatible happened, and bumping to mark a phase would make every reader's
compatibility check a lie. No token-savings optimisation. No git tag. No claim about worker quality.

## 9. Remaining risks

1. **Quality is unmeasured.** The honest headline. A team could adopt this, see a healthy dashboard,
   and be getting worse answers — the router cannot tell them. Disclosed; first in the backlog.
2. **The savings figure is a counterfactual.** Conservative in every direction and labelled, but
   "estimated" is doing real work.
3. **Append atomicity on Windows NTFS is empirical, not contractual.** HIGH confidence on POSIX
   local, MEDIUM on NTFS, UNSAFE on NFS/SMB/cloud-sync — where `telemetry.shardByPid` removes the
   requirement by construction. `windows-latest` gates CI for this reason.
4. **Gemini users get less context protection than Ollama users**, and no setting fixes it.
5. **The install flow is hand-verified on one platform.**
6. **Two import scanners remain un-shared**, each with a recorded reason, and one of them —
   `scanForCapability` — has no `export … from` pattern at all. The whole-repo graph now covers that
   hole, which is why it is P2.

## 10. Exact commands, and their results

```
npm test                                    2366 tests, 2365 pass, 0 fail, 1 skipped
npm run validate                            --strict clean on three manifests
npm run doctor -- --json --offline          exit 0 · 20 pass · 5 warn · 0 fail · 25 info
npm run budget                              ungoverned; every limit null; zero filesystem I/O
npm run evals -- --quiet --no-color         pass
npm run evals:sweep                         corpus agreed, gates clean · 26 cases · 107 gates
npm run analytics --json (x2, --now pinned) byte-identical · 32 fixture events
npm run report (x2, --input, --now pinned)  byte-identical · 833/833 tags · no path, no CDN, no CRLF
npm run report (empty store)                no dollar figure
npm run gen:schema  + git diff --exit-code  clean
npm run docs:config + git diff --exit-code  clean
npm run docs:env    + git diff --exit-code  clean
npm run sync:version+ git diff --exit-code  clean
npm run evals:build + git diff --exit-code  clean
ROUTER_PERF_FULL=1 node --test test/analytics.performance.test.mjs   100k case run once
npm run smoke:hook --scenario {delegate,context-exceeded,unavailable}   3 PASS, live Ollama
node --test test/architecture.graph.test.mjs   199 edges · 0 cycles · every file ranked
```

## 11. Decision

**B — RELEASE WITH DOCUMENTED LIMITATIONS.** Derived from the acceptance matrix in
[release-v1.md](release-v1.md) §8, which carries one `NOT TESTED` — quality evidence — that is not
promoted to anything else.
