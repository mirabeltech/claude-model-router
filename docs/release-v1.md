# V1 release

> **Worker delegation is policy/routing infrastructure; worker quality remains task- and
> model-dependent.**
>
> Nothing in this project measures whether a worker's answer is as good as Claude's. What it
> measures is whether the right thing was delegated, whether it was allowed, whether it fitted,
> what it cost, and what happened when any of that failed. Read §7 before drawing a conclusion
> about quality in either direction.

## 1. What is being released

| | |
|---|---|
| Version | `1.0.0` — one number, shared by both plugins, stamped on every telemetry row |
| Repository | `github.com/mirabeltech/claude-model-router` |
| Install method | Claude Code plugin marketplace, consumed straight from the repository |
| Plugins | `model-router` (the writer), `router-dashboard` (the reader) |
| Licence | Apache-2.0 |
| Dependencies | **none.** No `dependencies`, no `devDependencies`, no build step, no transpile |
| Telemetry `schema_version` | `1` — unchanged |
| Analytics `calc_version` | `1` — unchanged |
| `config_version` / `policy_version` | `1` / `1` — unchanged |

**No version was bumped to mark the phase.** `schema_version` and `calc_version` stay at `1`
because nothing backward-incompatible happened to either. The release version moved `0.1.0` →
`1.0.0`; no tag has been created, which is deliberately left as the maintainer's call.

### Supported platforms

| | Tested how |
|---|---|
| Windows 11 | the full suite locally, plus CI on `windows-latest`; the install flow hand-walked once |
| Ubuntu | CI on `ubuntu-latest`, Node 24 and Node 22.5.0 (the declared floor, pinned exactly) |
| macOS | CI on `macos-latest`, Node 24 |

Node **22.5+**. The floor is tested as an exact version rather than as `'22'`, so a patch release
cannot quietly move it.

### Providers

| Provider | Key | Context discovery | Live-tested at V1 |
|---|---|---|---|
| `ollama` | none | **yes**, from the daemon's `/api/show` | **yes** — three scenarios, see §6 |
| `gemini` | `GEMINI_API_KEY` | **no** — see §5 | **no** — no key available, reported as unavailable |
| `mock` | `MOCK_WORKER_URL` | no | yes, throughout the suite |

Worker modes: `bulk-reader` is the only one reachable. `code-writer` exists as a mode identifier and
is **unreachable** — nothing steers Claude to it, so `routing.codeWrite.enforce` is advisory and
intercepts nothing.

### Governance defaults

**Every budget limit ships `null`.** Governance is wired and enforces nothing until an operator
configures a limit. On a default install `checkBudget()` returns on a pure object walk, measured at
0.0015 ms, and — asserted by counting syscalls rather than by watching a clock — **opens no file,
creates no directory and takes no lock.**

**Every bundled price ships `null`.** A default install reports no dollar figure at all, and a CI
step fails the build if one appears.

What governance guarantees is **bounded overshoot**, not exact global enforcement. The ledger
mutation is serialised under an `O_EXCL` lock; the *decision* is not inside that lock, and on a
network share (SMB, NFS, OneDrive) `O_EXCL` is not reliable. `docs/governance.md` §"What is
guaranteed, and what is not" states both.

## 2. Security status

| Claim | How it is held |
|---|---|
| The gate imports no provider, makes no network call, reads no clock | statically, per file, plus a whole-repo import graph |
| No `node:` builtin outside a declared allowlist | an exact per-file table, **empty by default** |
| `node:child_process` in exactly two files | falls out of that table; both are opt-in scripts |
| Nothing under `router-dashboard/lib/` imports a node builtin | so "it cannot read a store" is structural |
| No edge crosses the plugin boundary | asserted on the graph's connected components |
| The import graph is acyclic | three-colour DFS over 199 edges |
| No committed file contains a credential | length- and structure-anchored patterns, no allowlist needed |
| No command prints a credential, even with a real-shaped one set | spawned, with one planted |
| A report embeds no credential, no source content, no local path | asserted on generated HTML |
| A telemetry row never carries a credential | asserted on a written row |
| No setting *can* hold a credential | there is no field for one; `apiKeyEnv` holds a NAME |
| A rejected config value is never echoed into a warning | **fixed in this phase** — it was |
| Config cannot reach `Object.prototype` | asserted with a `__proto__` payload |
| No malformed config makes the gate delegate a protected path | 400 seeded mutations × 6 probes |

### Three declared exposures

Listed as exposures and asserted as exposures, because a security summary that names only the cases
that pass is marketing. `test/secrets.leakage.test.mjs` is the matrix — one canary, twelve output
surfaces, with the three that carry it proved to carry it so none can be quietly "fixed" without a
test turning red, or quietly forgotten.

1. **Outbound file content is not redacted.** The filename deny list is the only control on what
   reaches a worker. Intent text *does* cross `redactSecrets()`.
   `test/task.security.test.mjs` asserts both halves, including two tests that assert a secret in
   file content *is* forwarded. Scrubbing content would be probabilistic, and a probabilistic
   control presented as a guarantee is worse than a documented absence. Backlog item 5.
2. **The worker's answer is not redacted.** A worker asked to summarise a file containing a key may
   echo it back, and that answer travels in `additionalContext` to Claude — the caller that was
   about to read the whole file anyway, so nothing is disclosed that was not already being
   disclosed. Scrubbing it would corrupt legitimate answers: a summary quoting an example value is
   a correct answer, and a redacted one is a wrong answer the developer cannot tell apart from a
   right one. **The bound is that the answer is never written to the store** — `returned_answer_chars`
   is a count — which is asserted rather than assumed, and is what keeps a telemetry directory safe
   to archive. This exposure was implicit until V1; it is now named and pinned.
3. **A key in the environment is readable by the provider that needs it.** Unavoidable, and bounded
   by `apiKeyEnv` naming a *variable* rather than holding a value — so a key cannot be committed in
   a config file at all — and by no command, row or report printing it.

## 3. CI status

Green on every leg. Four matrix legs (`ubuntu`/24, `windows`/24, `macos`/24, `ubuntu`/22.5.0), plus
a separate `validate` job running `claude plugin validate --strict` on the marketplace and both
plugins.

Five generated-file gates (`gen:schema`, `docs:config`, `docs:env`, `sync:version`, `evals:build`),
each `git diff --exit-code`, so a stale artifact fails the build. Three byte-diff reproducibility
gates (eval `stable.jsonl`, analytics `--json`, report HTML). Two shipped-state gates: a default
install reports no dollar figure, and a fresh keyless install is healthy and **writes nothing**.

## 4. Test and validation evidence

| Command | Result |
|---|---|
| `npm test` | **2376 tests, 2375 pass, 0 fail, 1 skipped** |
| `npm run validate` | `--strict` clean on all three manifests |
| `npm run doctor -- --json --offline` | exit 0 · 20 pass · 5 warn · 0 fail · 25 info |
| `npm run evals -- --quiet --no-color` | pass |
| `npm run evals:sweep` | corpus agreed, gates clean · 26 cases · 107 gates · 0 advisory flags |
| `npm run budget` | ungoverned; every limit `null`; zero filesystem I/O |
| `npm run analytics --json` ×2 | byte-identical (32 fixture events) |
| `npm run report` ×2 | byte-identical; 833 open / 833 close tags; no local path, no external resource, no CRLF |
| `npm run smoke:hook` ×3 scenarios | all PASS against live Ollama — see §6 |

**The one skipped test** is `test/analytics.performance.test.mjs`'s 100,000-row case, gated behind
`ROUTER_PERF_FULL=1` because it generates ~300 MB of scratch. It is not skipped for being broken.

### Performance, re-measured at V1

| | phase 8–11 | V1 | notes |
|---|---|---|---|
| non-delegating hook decision | 0.06 ms | **0.07 ms** | median of 30, in process |
| 4 MB file, not delegated | 0.05 ms | **0.04 ms** | cost does not grow with file size |
| 16 MiB transcript | 0.88 ms | **0.80 ms** | cost barely grows with session length |
| `checkBudget`, default install | 0.0008 ms | **0.0015 ms** | now has a committed harness |
| governed round trip | 4.05 ms | **3.17 ms** | two lock cycles + two read-modify-writes |
| analytics, 10k rows | 150 ms aggregate | unchanged | |

No regression. The governance numbers moved within normal desktop variance for sub-microsecond
timings, in both directions, with no change to `governance/`.

## 5. Known limitations

Each of these is disclosed in the documentation, fails safe, and does not invalidate the product
promise. Ranked work for each is in [post-v1-backlog.md](post-v1-backlog.md).

1. **No measured primary-model baseline.** Every avoided-token and avoided-cost figure is a
   counterfactual estimate from `chars/4` over hook-proven files. Labelled as estimated everywhere;
   missing usage is `NULL`, never `0`; unpriced models are `NULL`, never a guessed rate.
2. **The live generic-vs-intent A/B was never performed.** Five attempts in phase 8 produced no
   gradeable pair. `hooks.taskIntent.source` ships `none`. **Nothing is claimed in either
   direction.**
3. **Gemini context windows are not discovered.** Capability resolves `assumed` or `unknown`,
   dispatch falls back to the 2 MB transport ceiling, and `doctor` warns. An unknown window is
   never treated as unlimited. No setting can force one.
4. **`approvedNotDispatched` is ambiguous.** A row approved and then never dispatched carries no
   recoverable cause. Reported as ambiguous rather than guessed at.
5. **Outbound file content is not redacted.** See §2.
6. **Governance guarantees bounded overshoot, not exact enforcement.** See §1.
7. **A telemetry sink that fails to *construct* degrades to a null sink**, whose `append()` reports
   `{ok: true, bytes: 0}`. The row is lost; the only signal is a warning `doctor` surfaces, now
   pinned as load-bearing. Reviewed this phase and deliberately not changed — reasoning in
   [failure-modes.md](failure-modes.md) §7. It costs observability, never correctness, and never
   blocks a session.
8. **The install flow was hand-walked on Windows only.** Linux and macOS are CI-gated for the test
   suite; nobody has followed the install instructions by hand on either.
9. **`code-writer` is unreachable** and `routing.codeWrite.enforce` intercepts nothing.
10. **Hook, governance and capability latency are not instrumented** and report `null` in a row,
    even though all three are now measured by harnesses.

## 6. Live worker smoke-test status

Run at V1 against **Ollama with `mistral:latest`** (32,768-token window) on Windows 11.

| Scenario | Result | Elapsed |
|---|---|---|
| `delegate` | PASS — real summary, usage `in=674 out=80` provider-reported, 187 tokens avoided, cost `NULL` | 80.1 s |
| `context-exceeded` | PASS — refused with `context_exceeded`, **no request sent** | 157 ms |
| `unavailable` | PASS — `transport` error, hook fell open | 272 ms |

The two refusals are the ones worth having. 157 ms to refuse an oversized prompt is the Ollama
middle-drop defence working on a real daemon: the model would otherwise have been handed a
truncated prompt and answered it confidently.

**Three caveats, stated rather than buried.** The passing delegation used a 900-byte file with the
gate threshold lowered to 512 bytes, because this machine runs the model at **10.6 tok/s prompt
evaluation and 3.8 tok/s generation** — measured directly, roughly half what phase 8 recorded — so
13 KB does not complete inside the 120-second maximum hook deadline. That is the hardware, not the
router, and the smoke script prints the lowered threshold on every run. The project's documented
default model (`qwen2.5-coder:7b`) was not pulled; `mistral:latest` was used and is recorded here.

**Gemini live: UNAVAILABLE.** No `GEMINI_API_KEY` on this machine. Reported as unavailable rather
than substituted with a fixture.

## 7. The quality-evidence boundary

This section exists so that nobody has to infer it.

**Established.** That the right things are delegated and the wrong things refused, over a fixed
corpus crossed with every protected task type. That an oversized prompt is refused rather than
silently truncated. That a budget, once configured, binds within bounded overshoot. That every
failure path leaves the developer's `Read` working. That the numbers reported are measured or
`NULL`, never guessed.

**Not established, and not claimed.**

- that a worker's answer is as good as Claude's, on any task
- that intent-aware task construction improves quality — **or that it does not**
- that workers preserve correctness
- that the avoided-token figures match what Claude would actually have ingested

The corpus measures accuracy on planted facts and vocabulary. No deterministic evaluator establishes
that a summary is *true*, and two of the corpus gates are advisory with a structural false negative:
neither catches recombination of real tokens into a false claim.

## 8. Acceptance matrix

`PASS` · `PASS WITH LIMITATION` · `NOT TESTED` · `FAIL`

| Area | Status | Evidence | Known limitation |
|---|---|---|---|
| Installation | PASS WITH LIMITATION | `clean-install` (13), `team.safety` (20), CI's fresh-keyless-install gate | hand-walked on Windows only |
| Plugin loading | PASS | `packaging` (25), `claude plugin validate --strict` on three manifests | — |
| Routing | PASS | 9 files incl. a 200-case seeded fuzz and the cross-product protected eval | `minLines` unreachable from the hook |
| Hook | PASS | `hook.*` (11 files) incl. a real child process and 24 fail-open rows | — |
| Task intent | PASS WITH LIMITATION | `intent.*`, `task.*`; ordering after `decide()` is pinned | ships `none`; its value is unmeasured (§5.2) |
| Dispatch | PASS | 10 files, every failure driven through the real transport | — |
| Providers | PASS WITH LIMITATION | conformance table × 3 modules × ~20 scenarios | Gemini not live-tested at V1 |
| Capability | PASS WITH LIMITATION | `capability`, `capability.boundary`, `providers.capability` | Gemini discovery absent (§5.3) |
| Context safety | PASS | boundary ±1 both window models; middle-drop refusal, live in 157 ms | — |
| Governance | PASS WITH LIMITATION | `governance.*` (8 files) incl. 4-process concurrency and 13 fail-open rows | bounded overshoot only (§5.6) |
| Telemetry | PASS WITH LIMITATION | `telemetry.*` (15 files) incl. multi-process append and 13 fail-open rows | null-sink construction fallback (§5.7) |
| Analytics | PASS WITH LIMITATION | `analytics.*` (12 files); null/zero/unknown kept distinct throughout | `approvedNotDispatched` ambiguous (§5.4) |
| Dashboard | PASS | `dashboard.*` (4); byte-identical twice; 833/833 tags; no secret, path or external resource | — |
| Doctor | PASS | `doctor` (32, spawned), `doctor.report` severity matrix | — |
| CLI | PASS | `cli.contract` over 4 commands × 6 contracts, spawned | — |
| Documentation | PASS | `docs.contract` (19) incl. link resolution, orphans, command existence, version agreement | — |
| Security | PASS WITH LIMITATION | §2, `secrets.leakage` (one canary × 12 surfaces) | three declared exposures (§2) |
| Windows | PASS | full suite locally + `windows.compat` + CI | — |
| Linux | PASS | CI, Node 24 and 22.5.0 | not hand-walked |
| macOS | PASS | CI, Node 24 | not hand-walked |
| Concurrency | PASS WITH LIMITATION | 4 real processes appending to one JSONL; 4 competing for one ledger | append atomicity is MEDIUM confidence on NTFS; unsafe on NFS/SMB, where `shardByPid` removes the requirement |
| Performance | PASS | §4; every published number now has a committed harness | — |
| Deterministic behaviour | PASS | 5 generated-file gates + 3 byte-diff gates + cross-process row equality | — |
| Live worker integration | PASS WITH LIMITATION | §6 — three Ollama scenarios | Gemini NOT TESTED; delegation needed a reduced file (§6) |
| Quality evidence | **NOT TESTED** | §7 | **deliberate.** No baseline, no A/B. Not promoted. |
| Architecture freeze | PASS | 199 edges, 0 cycles, every file ranked, every builtin declared | — |
| Fail-open behaviour | PASS | `failure-modes.md`, every row with a test; previously-unreachable branches now driven | 2 branches unreachable and declared |
| Configuration | PASS | `config.fuzz`: 77 leaves × every invalid kind, + 400 safety mutations | — |
| Packaging | PASS | `packaging`, `examples`, `secrets.hygiene`, `cli.contract` | — |
| Resource cleanup | PASS | `resources`; the 16-directory and per-event-descriptor leaks both fixed | — |

**One `NOT TESTED` and it is not promoted.** Quality evidence is absent by decision, disclosed in
§7, and first in the backlog.

## 9. Release decision

### **B — RELEASE WITH DOCUMENTED LIMITATIONS**

Not A, because ten limitations are real and one acceptance area is honestly `NOT TESTED`. Calling
that a clean release would misrepresent what was established — in particular, this project cannot
tell a team whether a delegated answer is as good as Claude's.

Not C, because every limitation meets the bar for being acceptable:

- **it is documented** — each one in the body of a document, not only in this list
- **it does not create unsafe behaviour** — every one fails open to plain Claude Code, fails closed
  on the delegation, or safely refuses; none can block a session or silently corrupt a number
- **fallback behaviour is correct** — and is now tested on every branch, including the thirteen
  governance and telemetry error paths that had no test at all before this phase
- **the core promise survives** — "intercept a large read, delegate it to a cheap worker, and
  measure what that saved, without ever breaking the session" is intact, measured, and
  conservatively reported

The decision rests on the matrix in §8, not on the absence of objections.

**What a team gets.** A plugin that installs without a key, creates nothing until it records
something, enforces no budget until asked, reports no dollar figure it cannot substantiate, and
degrades to plain Claude Code on every failure path that has been found — including the ones nobody
had previously tried.

**What a team does not get.** Any assurance about answer quality. That is item 1 and item 2 of the
backlog, and it is the honest headline of this release.

---

Phase 12's full working record, including what broke and what it corrected, is in
[phase-12-hardening.md](phase-12-hardening.md).
