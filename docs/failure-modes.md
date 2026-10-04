# Failure modes

What happens when each part breaks, and why that is the right thing for that part.

Three different behaviours, and the whole point of this document is that they are **not
interchangeable**. A codebase that treats every error the same way has either a router that blocks
sessions or a router that loses data, depending on which default it picked.

| | meaning |
|---|---|
| **FAIL OPEN** | the permissive outcome. The session proceeds and the router degrades toward plain Claude Code. The developer's `Read` happens. |
| **FAIL CLOSED** | the restrictive outcome *for the operation*, while the session still proceeds. No delegation happens, or no row is written. Nothing is blocked. |
| **SAFE REFUSAL** | declines to produce a value it cannot compute, preserves the reason, and mutates nothing. Proceeding would mean inventing a number or writing a corrupt artifact. |

The organising rule is CLAUDE.md's second non-negotiable: **a broken router must degrade to plain
Claude Code, never to a blocked session.** Everything below follows from that, except where writing
something wrong would be worse than writing nothing — which is where SAFE REFUSAL appears.

---

## 1. The hook, at the process boundary

| Failure | Behaviour | Class | Test |
|---|---|---|---|
| hook disabled (`hooks.enabled: false`) | zero bytes on stdout, exit 0 | FAIL OPEN | `hook.failopen` |
| routing disabled (`enabled: false`) | zero bytes, exit 0 | FAIL OPEN | `hook.failopen` |
| config that never came from the resolver | zero bytes, exit 0 | FAIL OPEN | `hook.failopen` |
| malformed stdin, wrong event, wrong tool | zero bytes, exit 0 | FAIL OPEN | `hook.protocol` |
| `decide()` throws | `routing_threw`, zero bytes | FAIL OPEN | `hook.failopen` |
| `decide()` returns nonsense | not trusted, zero bytes | FAIL OPEN | `hook.failopen` |
| dispatcher throws | `hook_threw`, zero bytes | FAIL OPEN | `hook.failopen` |
| anything else throws | outer catch, `hook_threw` | FAIL OPEN | `hook.failopen` |
| a filesystem that throws on everything | zero bytes, exit 0 | FAIL OPEN | `hook.failopen` |
| the bare `catch {}` in the entry point | **not reachable from the process boundary** | FAIL OPEN (declared) | `hook.security` |

**Exit code 0, always.** `process.exit(2)` is statically forbidden, because exit 2 turns stderr
into Claude's feedback and blocks the tool call — the opposite of what a broken router should do. An
empty stdout with exit 0 is indistinguishable from the hook not being installed.

**The bare catch is unreachable, and is not faked.** Every call inside the `try` is specified never
to throw: `runReadHook` has its own catch returning `hook_threw`, and `loadConfig` swallows per
layer — `readJsonLayer` catches both the read and the parse and turns a non-`ENOENT` code into a
warning. What remains is an `EPIPE` against a reader that closed first, which is timing-dependent
and not drivable cross-platform. So the test asserts the property the catch exists to preserve: the
write and the config load inside the `try`, `exit 0` outside it.

## 2. Measurement (`hook/facts.mjs`)

| Failure | Behaviour | Class |
|---|---|---|
| file size unreadable | `fileBytes → null`; a null size never satisfies a threshold | FAIL CLOSED on delegation |
| transcript unreadable | `recentlyEdited → true`, the **pessimistic** reading, so it refuses | FAIL CLOSED on delegation |
| worker inspection throws | `workerAvailable: false`, and `provider`/`model`/`billing` all `null` | FAIL CLOSED on delegation |
| file content unreadable | `content_unreadable`, reservation released | FAIL OPEN |
| file content is binary | `content_binary`, falls open to the real `Read` | FAIL OPEN |

Every one of these fails *closed on the delegation* and *open on the session*: the developer gets
their `Read`, and nothing is sent to a worker on the strength of a measurement that did not work.
A null is never read as a favourable value.

## 3. Routing

Every refusal is `decision: 'allow', delegate: false` — **FAIL OPEN** by construction, 15 numbered
rules, first match wins. `decide()` is synchronous, makes no network call, imports no provider and
reads no clock, so the only way it can fail is to throw, which the hook wraps.

`budget_exceeded` is declared in `WORKER_UNAVAILABLE_REASONS` and **unreachable**. That is a
decision on the record, not an oversight: feeding a budget verdict into the gate would let a budget
rewrite a routing classification, and would leave a row saying the budget was spent without saying
whether the read was delegation-worthy at all.

## 4. Governance

All four error paths return `decision: 'allow'` with the reason in `warnings`. A storage problem
must not become a dead router.

| Failure | Warning | Class |
|---|---|---|
| no state directory | `budget_state_no_state_dir` | FAIL OPEN |
| unreadable or corrupt ledger | `budget_state_unreadable_ledger` | FAIL OPEN |
| reservation cannot be written | `budget_reserve_<errno>` | FAIL OPEN, accounting degraded |
| lock held by another process | `budget_reserve_lock_contended` | FAIL OPEN |
| no `tool_use_id` to key a reservation | `budget_reserve_no_id` | FAIL OPEN |
| anything throws | `budget_threw` | FAIL OPEN |
| `finalizeBudget` throws | `{ok: false, reason: 'finalize_threw'}` | **SAFE REFUSAL** |
| usage was never measured | the reservation is **released**, not settled | **SAFE REFUSAL** |

**A corrupt ledger is read as unreadable, never as zero spend.** Reading it as zero would silently
reset the budget, which is the one failure mode a budget must not have. `measurementStatus` becomes
`unavailable` and `remaining` becomes `null` — never `0`.

**`finalizeBudget` is the one place governance refuses rather than failing open**, and the reason is
the asymmetry: allowing an ungoverned call costs at most one call's overshoot, while charging a
number nobody measured corrupts every decision after it. So it declines to mutate and lets the
reservation expire. That is why `docs/governance.md` claims bounded overshoot and not exact
enforcement.

**`reservationStatus: 'none'` on a failed reservation is load-bearing.** It is what tells the
settle path there is nothing to convert; reporting `reserved` would make `finalizeBudget` charge
against a reservation that was never written.

## 5. Capability and the context budget

| Failure | Behaviour | Class |
|---|---|---|
| no capability known | `verdict: 'unknown'`, `fits: null`, `contextTokens: null` | proceeds under the byte ceiling, warns |
| discovery throws or times out | `discovered → null`, resolves to `unknown`, proceeds | FAIL OPEN |
| prompt exceeds a KNOWN window | `context_exceeded`, no request sent | **SAFE REFUSAL** |
| output would leave no room for a useful answer | refuse rather than return two tokens | **SAFE REFUSAL** |
| `requestedOutputTokens: 0` | `output_request_invalid` — a caller error, reported as one | SAFE REFUSAL |
| provider's prompt count missing | `truncated: null`, `prompt_count_missing` | SAFE REFUSAL |
| no estimate to compare against | `truncated: null`, `estimate_unknown` | SAFE REFUSAL |

**Unknown context is never infinite context.** `fits` is tri-state: `false` is a definite claim,
available only because the window is known; `null` means *cannot say*. An unknown window therefore
never reports that a request fits, however large.

**Input is never truncated; an oversized prompt is refused.** This exists because of a measured
failure: Ollama sizes its serving window from available memory and then silently drops the MIDDLE of
an over-long prompt — a 17,368-token prompt came back as `prompt_eval_count` 2060 with both end
markers intact. A middle-dropped prompt produces a confident wrong answer that nothing downstream
can detect, so refusing is the only safe response. Verified live: 157 ms to refuse.

## 6. Providers and dispatch

`dispatch()` never throws on any path; every outcome is a `status` and a classified reason.

| Failure | Code | Retried? | Class |
|---|---|---|---|
| 401 / 403 | `auth` | no — three attempts with a bad key is three failures | FAIL OPEN |
| 404 | `model_not_found` | no | FAIL OPEN |
| 413 | `payload_too_large` | no | FAIL OPEN |
| 429 | `rate_limit` | yes | FAIL OPEN |
| ≥500 | `http_5xx` | yes | FAIL OPEN |
| ≥400 otherwise | `http_4xx` | no | FAIL OPEN |
| our timeout fired | `timeout` | yes | FAIL OPEN |
| runtime header/body timeout | `timeout` | yes | FAIL OPEN |
| caller aborted (the hook deadline) | `aborted` / `transport`, **not retryable** | no | FAIL OPEN |
| connection refused | `transport` | no | FAIL OPEN |
| non-JSON body | `parse_error` | no | FAIL OPEN |
| retries exhausted | the last error, with `attempts` stamped | — | FAIL OPEN |

The runtime-timeout branch exists because of a measured bug: a 305-second request was reported as
`transport` with the default retryability, so a doomed call was retried three times at 180 seconds
each. Classifying it as `timeout` is what bounds that.

## 7. Telemetry

Wrapped end to end, synchronous, no network, no `await`, and it swallows every error — because a
telemetry failure must never become a hook failure.

| Failure | Reason | Class |
|---|---|---|
| telemetry disabled, or `CLAUDE_ROUTER_TELEMETRY=0` | `telemetry_disabled` | a request honoured, not a failure |
| anything throws in `emitEvent` | `err.code ?? err.message ?? 'emit_failed'` | FAIL OPEN |
| directory cannot be created | `open_failed`, then latched off | FAIL CLOSED for data |
| descriptor closed underneath us | one reopen, then retry | recovers |
| the reopen also fails | `reopen_failed`, sink latched off | FAIL CLOSED for data |
| short write | `ESHORTWRITE`, **never retried** | **SAFE REFUSAL** |
| record over the cap after shedding | `carcass_over_cap`, no bytes written | **SAFE REFUSAL** |
| a field throws while being read | `serialize_failed:<code>` | **SAFE REFUSAL** |
| pricing cannot be computed | `{costUsd: null, status: 'unavailable'}` | **SAFE REFUSAL** |
| unknown sink name | falls back to **jsonl**, with a warning | FAIL OPEN |
| sink cannot be constructed | falls back to a **null sink**, with a warning | FAIL CLOSED for data |

**A short write is refused, not retried.** One record is one `fs.writeSync` of one Buffer ending in
`\n`; that is what makes concurrent appends safe. `fs.writeSync` does not loop on a short write, and
neither does the sink: retrying would put half a record on disk and the rest after whatever another
writer appended in between, corrupting every reader of the file. Losing one row costs a counter.

**The null-sink construction fallback loses data while reporting `ok: true`, and that is worth
stating plainly.** `resolveSinkId` says in capitals *"FAIL OPEN TO `jsonl`, NEVER TO `null`"* —
and that rule is about sink *resolution*, which genuinely cannot choose null. Sink *construction*
is a different moment: when constructing the jsonl sink is what failed, there is no working sink to
fall back to, and returning a handle that throws is forbidden outright. The null sink's `append()`
returns `{ok: true, bytes: 0}` by design, so a caller reading `ok` sees success and the row is gone.

What makes that acceptable is a returned warning, which `npm run doctor` surfaces — and nothing
tested that warning until phase 12, so the one mitigation was unverified. It is now pinned as
load-bearing. **Reviewed and not changed**: the construction path is near-unreachable (`openSink`
performs no I/O at all, so only a module-load failure reaches it), the alternative breaks a stronger
rule, and `bytes` is the field that tells the truth. Recorded as a known limitation rather than
papered over.

**The try/catch starts after destructuring.** `emitEvent` and `priceWorkerUsage` destructure their
options in the parameter list, so a throwing getter on a top-level option — `{get config() { throw
}}` — is evaluated before the function body and escapes the catch. Unreachable in production: those
objects are built by `hook/run.mjs` and `analytics/index.mjs` from a `loadConfig()` result, never
from host or provider input. Asserted so that "wrapped end to end" stays an exact claim.

## 8. Reading: the store, analytics, the report

| Failure | Behaviour | Class |
|---|---|---|
| store directory missing | treated as an empty store | FAIL OPEN |
| segment unreadable | pushed to `report.errors`, reading continues | FAIL OPEN |
| unparseable line at the **tail** | `truncated_tail` — benign, a writer mid-flight | tolerated |
| unparseable line in the **middle** | `malformed` — **evidence that append atomicity failed here** | reported, not hidden |
| oversize line | counted, resynced to the next newline | tolerated |
| BOM, blank line, `#` comment | tolerated (PowerShell 5.1 writes BOMs) | tolerated |
| row with a newer `schema_version` | yielded by the reader, bucketed `schemaIncompatible` by the aggregator | reported |
| duplicate `event_id` | **counted twice; nothing deduplicates** | see below |
| prune cannot unlink a segment | recorded in `errors`, continues | advisory |
| the analytics CLI cannot be spawned | `spawn_failed` / `router_failed`, with instructions | FAIL OPEN |
| router script not found | `NO_ROUTER_MESSAGE` telling the reader what to install | FAIL OPEN |

**The middle/tail distinction is the point.** An unparseable line at the end of a file is a writer
caught mid-append, which is normal. An unparseable line in the *middle* is evidence that the
one-record-one-syscall guarantee failed on that machine — the thing this project's write path is
designed around — so it is reported rather than silently skipped.

**Nothing deduplicates `event_id`, and that is a decision.** `emitEvent` generates a fresh
`crypto.randomUUID()` per record, so the router cannot emit the same id twice; a duplicate in a
store means a segment was copied, restored or concatenated by hand. Counting a copied row twice is
the right answer, because silently dropping look-alike rows would hide a genuine double-write on a
filesystem where append atomicity failed — and the `malformed` report above is the other half of
that same signal.

## 9. Where a secret can travel

Three places, each because scrubbing there would be worse than not. The full matrix — one canary
against twelve output surfaces — is `test/secrets.leakage.test.mjs`, which asserts the three
exposures *as* exposures so that none can be silently removed or silently forgotten.

| Surface | Carries a secret? | Why |
|---|---|---|
| worker prompt — intent text | no, scrubbed | the developer's own prompt is the one free text that could carry a pasted key |
| worker prompt — **file content** | **YES** | the deny list is the only control; a scanner would be probabilistic |
| **worker answer → Claude** | **YES** | redacting would corrupt legitimate answers; it goes only to the caller that was about to read the file |
| dispatch error message and detail | no, scrubbed | an upstream body can echo a credential |
| telemetry row, and the JSONL line | no | the answer is counted, not stored; `question_text` is off by default |
| analytics response | no | the read model selects columns rather than copying rows |
| rendered HTML report | no | and no local path, no source content, no external resource |
| doctor output, CLI stdout | no | reported by shape, which is what makes the output pasteable |
| config warning text | no | **fixed in V1** — one branch used to echo the rejected value |
| committed files | no | length- and structure-anchored patterns, no allowlist needed |

## 10. What a safe refusal must never look like

The distinction this project most needs to preserve, because it is the one a reader gets wrong.

A refusal and a worker failure are both "no answer came back", and a dashboard that merges them
shows a healthy, correctly-cautious router as a broken one — which is how a team concludes the
plugin does not work and removes it. So:

- a gate refusal is `task_type: gate_block`, `status: skipped`, `error_code: null`, and every worker
  usage and money column `null`. It never enters the dispatch denominator.
- a governance denial keeps `routing_reason: threshold_met` and puts the refusal in the governance
  columns, so the row says the read *was* delegation-worthy **and** the budget stopped it.
- a `context_exceeded` is `status: error` with that code: the call was prepared and refused by the
  capability layer, so it belongs to an attempted delegation rather than to a gate refusal.
- a provider error is `status: error` with a provider code, and it is the only one of the four that
  belongs in a failure rate.
- success rate is computed over **dispatched** calls only, so a refusal is never in its denominator.

`test/e2e.refusal.test.mjs` drives all seven refusal paths through the real hook to the rendered
HTML and asserts exactly this: no false worker usage, the right reason, the right analytics class,
and no safe refusal labelled a failure.

---

## Every reason string in this document is asserted somewhere

`test/docs.contract.test.mjs` is not currently able to prove that automatically — it would need a
reason-string census this project does not have. What exists instead:

- `test/hook.failopen.test.mjs` — one test per row of §1 and §2
- `test/governance.failopen.test.mjs` — one test per row of §4
- `test/telemetry.failopen.test.mjs` and `test/telemetry.serialize.test.mjs` — §7
- `test/providers.conformance.test.mjs` — §6, every row, against three provider modules
- `test/capability.boundary.test.mjs` and `test/context-budget.test.mjs` — §5
- `test/telemetry.reader.test.mjs` and `test/analytics.*.test.mjs` — §8
- `test/e2e.refusal.test.mjs` — §9, end to end

Before phase 12, none of §4 and only part of §7 had a test: `budget_threw`, `budget_state_*`,
`budget_reserve_*`, `finalize_threw`, `emit_failed`, `reopen_failed`, `ESHORTWRITE`,
`serialize_failed` and `carcass_over_cap` appeared nowhere under `test/`. "It degrades gracefully"
was covered; "it says what went wrong" was not, and those are the same thing to a `try/catch` and
completely different things to an operator.
