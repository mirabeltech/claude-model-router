# governance

`lib/governance/` answers one question — **are we currently allowed to delegate?** — and it is a
different question from the two that surround it. Routing asks whether a task is *appropriate* for
a worker. Capability asks whether a worker *can* run it. Governance asks whether we may spend what
it would cost. Three questions, three modules, and the whole design is about not collapsing them.

> **A budget is never a routing input, and governance never rewrites a routing verdict.**
> `decide()` is a pure function of one tool call with no ledger behind it, and
> `test/governance.isolation.test.mjs` pins that statically — `routing.mjs` imports no governance
> module and names no `budget.` leaf. Governance runs after the gate has already ruled.

---

## 1. What this phase actually enforces, and what it cannot

Worth stating before anything else, because the honest answer is narrower than "budgets work now".

| dimension | enforceable on a default install? | why |
| --- | --- | --- |
| token budgets | **yes**, wherever the provider reports usage | `usage` comes back from the provider and is measured |
| cost budgets | **no** | every rate in `lib/telemetry/pricing-table.mjs` ships `null`, so worker cost is NULL |

That second row is not a defect of this phase; it is the project's standing position that a
confident wrong dollar figure is worse than a refusal to price. The consequence is that a dollar
budget configured out of the box has nothing to accumulate against, and `npm run doctor` says so
in those words rather than letting the operator believe a ceiling is being enforced.

Three numbers are therefore kept apart, and conflating any two of them is a bug:

```
a limit that was CONFIGURED        budget.daily.maxTotalTokens
spend that was MEASURED            provider-reported usage, settled into the ledger
spend we could NOT determine       null — and null is not zero
```

---

## 2. The three decisions, in order

```
PreToolUse
  ↓
routing      decide()          would this task be APPROPRIATE to delegate?
  ↓ delegate && enforce === deny
governance   checkBudget()     are we currently ALLOWED to delegate?
  ↓ allow
dispatch     ↓
capability   computeContextBudget()   CAN this worker safely execute this request?
  ↓
worker
  ↓
governance   finalizeBudget()  settle at measured usage, or release
```

The insertion point is `lib/hook/run.mjs`, immediately after the enforcement guard and **before
the file is read**. A budget refusal therefore costs no file read, no transcript read and no
worker call. Everything governance reasons over — `facts.inputBytes`, the worker's resolved
`billing` — was already measured for the gate.

### Why governance runs after the gate, not inside it

There is a tempting shortcut. Step 11 of the rule table already accepts
`workerAvailable: false` with `workerUnavailableReason: 'budget_exceeded'` from its caller, and
`budget_exceeded` has been declared in all three vocabularies since phase 3. Feeding a budget
verdict through that seam would have lit up budget enforcement with no new vocabulary at all.

**It is rejected, for three reasons.**

1. It would make governance change the routing classification. Routing would start reporting a
   budget verdict as its own answer.
2. **It destroys the diagnostic.** A row would record that the budget was spent and never record
   whether the read was delegate-worthy in the first place, so "why did this not delegate?" would
   have only half an answer. Running after the gate keeps both facts:
   `routing_reason: threshold_met` *and* `governance_reason: daily_budget_exceeded`.
   `test/governance.integration.test.mjs` asserts exactly that pair.
3. Routing stays a pure function of the tool call, which is what `test/routing.capability.test.mjs`
   and the isolation suite exist to protect.

`budget_exceeded` therefore remains what it was: declared, reachable only through the input seam,
and produced by nothing. `lib/hook/facts.mjs` says so at the point where someone would be tempted
to change it.

---

## 3. Budget dimensions

Three scopes, each nullable, checked narrowest first.

| scope | leaves | state |
| --- | --- | --- |
| `run` | `maxWorkerCostUsd`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens` | none — a run is one call |
| `daily` | `maxWorkerCostUsd`, `maxTotalTokens` | per UTC day |
| `monthly` | `maxWorkerCostUsd`, `maxTotalTokens` | per UTC month |

**Narrowest first** because a per-run breach is the one an operator can act on immediately ("send
fewer files"), while an exhausted month is a wait-or-raise-the-limit situation. Reporting the
actionable one is more useful than reporting the largest.

**Tokens before cost** within a scope, because tokens are measurable on a default install and cost
is not. Checking cost first would report `cost_unknown` on an install where a token budget was
cleanly and correctly refusing, which reads as a broken feature rather than an enforced one.

`run` is the only scope with no persisted state, which makes it the only limit that cannot drift
and the safest place to put a runaway guard.

### null, zero, negative

| value | meaning | behaviour |
| --- | --- | --- |
| `null` | no configured limit — **the shipped default** | never evaluated |
| `0` | a deliberately configured zero budget | refuses everything, including a one-token request |
| negative | invalid configuration | rejected by `coerceLeaf`; falls back to the default and warns |

These are three states, not two. `null` read as `0` turns an unconfigured install into a frozen
one; `0` read as "unset" turns a deliberate stop into a blank cheque; a negative read as `0`
disables all delegation on a typo. `test/governance.config.test.mjs` pins each one.

---

## 4. Unknown is not zero

The rule the rest of the project states as *a missing measurement is NULL, never 0*, applied to
budgets. It is why `evaluateBudget()` has three decisions rather than two: `allow`, `deny` and
`unknown`.

`unknown` means **a limit is configured and we could not measure the thing it limits**. The
operator resolves it, because it is a policy choice:

| setting | default | effect |
| --- | --- | --- |
| `budget.onUnknownCost` | `allow` | `allow` records the fact and proceeds; `deny` refuses while cost is unknown |
| `budget.onUnknownUsage` | `allow` | same shape, for a provider that reports no token counts |

Both default to `allow`, and that is deliberate rather than lax: defaulting to `deny` would
disable delegation on every install with an unpriced model, which — because every bundled rate is
null — is all of them out of the box. A governance layer that bricks the router is not a safety
feature. The fail-open rule in `CLAUDE.md` applies here as everywhere else.

### Three cost states, not two

| state | example | treated as |
| --- | --- | --- |
| **structurally zero** | `ollama`, declared `billing: 'local_free'` | exempt — a dollar budget cannot be consumed by it |
| **known** | a metered provider with rates configured | compared and decided |
| **unknown** | a metered provider with null rates — the shipped state | `cost_unknown`, resolved by `onUnknownCost` |

`billing` is a **declared provider capability**, not a derivation from `requiresEnv.length === 0`.
"Needs no API key" and "costs no money" are different claims, and a self-hosted metered gateway
satisfies the first while violating the second. `test/providers.conformance.test.mjs` uses the
`mock` provider as the live counter-example: it requires an env var *and* is metered, so the two
axes are demonstrably independent rather than coincidentally aligned.

### The asymmetry between tokens and cost

An unknown *request size* proceeds; an unknown *request cost* does not. That looks inconsistent
and is not:

- a token request is bounded by the reservation its estimate sized, so proceeding is bounded;
- an unpriceable call gets a `null` cost reservation, so nothing bounds what it may spend.

Different guarantees, different answers.

---

## 5. Accounting

What counts toward a budget, and what does not. Measured facts only — the pre-dispatch estimate
exists to size a *reservation* and is always either replaced by measured usage or released.

| event | token budget | cost budget | reservation |
| --- | --- | --- | --- |
| routing refused | nothing | nothing | never taken; governance not consulted |
| governance refused | nothing | nothing | never taken |
| file unreadable or binary | nothing | nothing | released |
| `context_exceeded` (refused before the call) | nothing | nothing | released |
| `provider_error` / `timeout` / `aborted`, no usage reported | nothing | nothing | released |
| failed call **with** reported usage | measured | measured if priced | settled |
| success | measured | measured if priced | settled |
| success, usage `missing` | nothing | nothing | released |

A request refused before dispatch never creates worker usage. A `context_exceeded` refusal never
creates worker usage. Both are pinned in `test/governance.integration.test.mjs`.

A failed call that *did* report usage **is** charged, because those tokens were really consumed —
a timeout after the model had already read the prompt cost real input tokens, and a ledger that
forgave them would under-report every decision after it.

### Two exposures, stated rather than hidden

1. **A provider that reports no usage can never exhaust a token budget.** Nothing is invented for
   it. `budget.onUnknownUsage: 'deny'` is the opt-in for operators who need strictness, and
   `npm run doctor` warns when a token budget is configured against a usage-silent worker.
2. **Measured usage can exceed its reservation**, so spend may overrun a limit by one call. The
   reservation is refused when the *estimate* would exceed the limit, but the estimate is not the
   measurement. `remaining` clamps at `0` and is never reported negative; the overrun itself is
   recorded as `reservation_status: 'overrun'` rather than clamped away.

### Cost totals can be a lower bound

Once any call in a period could not be priced, the running cost total understates. The ledger
tracks that and reports `costStatus: 'partial'`, and `npm run budget` prints
`at least $3.0000` rather than `$3.0000`. "You have spent $3" and "you have spent at least $3" are
different claims.

---

## 6. Concurrency

The race, as the brief states it:

```
daily budget = $1.00
two workers each observe current spend = $0.80
both independently decide $0.15 is available
$0.80 + $0.15 + $0.15 = $1.10
```

The fix is that a **reservation is written under a lock and counted toward spend while it is
open**, so the second reader sees `$0.95` committed-plus-reserved rather than `$0.80`.

The lock is `fs.writeFileSync(lock, stamp, { flag: 'wx' })` — exclusive create, atomic on POSIX
and Windows, no dependency. It is the same mechanism `lib/telemetry/identity.mjs` already uses to
create the salt, where the loser of the race re-reads what the winner wrote.

### What is guaranteed, and what is not

| | |
| --- | --- |
| **Guaranteed** | The ledger mutation is serialised. A reservation is never lost and a settle is never doubled. `test/governance.concurrency.test.mjs` proves this with four real child processes against one ledger. |
| **NOT guaranteed** | The *decision* is not inside the lock. A hook reads state, decides, then reserves; between the read and the reserve another process can claim headroom it counted as free. The reservation bounds the damage — a small multiple of the limit rather than the whole attempt count — but a bounded overshoot is the documented residual, not a solved problem. |
| **NOT guaranteed** | On a network share (SMB, NFS, OneDrive) `O_EXCL` creation is not reliably atomic, so cross-machine enforcement over a shared `budget.stateDir` does not hold. Keep the state directory local. Doctor cannot detect this and does not claim to. |
| **Advisory** | A process that writes `ledger.json` without taking the lock can corrupt accounting. Nothing in this codebase does. |

The concurrency tests use real child processes rather than `Promise.all`, because the contention
being modelled is between two operating-system processes for one lock file. An in-process loop
shares the module and the event loop, so it would pass whether or not the lock worked — which
makes it worse than no test.

### Three bugs this found

All three were in the implementation, not the tests, and all three only appeared under load.

1. **A tight retry spin refused reservations that should have been granted.** 50 attempts with no
   delay complete in microseconds, long before the holder finishes its read-modify-write, so every
   loser reported `lock_contended` and failed open. Fixed with an escalating backoff
   (`Atomics.wait`, the only true synchronous sleep in Node) and a retry budget sized against the
   hook's 20-second deadline rather than against nothing.
2. **The staleness check mixed two clocks.** `now` is injected while an mtime comes from the real
   system clock, so comparing them made staleness depend on clock skew: one way every *live* lock
   looked stale and got broken, which let two processes write at once and lost a reservation
   (measured: 99 of 100 surviving a four-process race); the other way nothing was ever reclaimed.
   The holder now stamps its own clock into the lock, so both sides of the subtraction share one.
3. **`EPERM` is part of the contention class on Windows.** A lock another process has just
   unlinked sits in a pending-delete state until its last handle closes, and an exclusive create
   against it fails with `EPERM`, not `EEXIST`. Treating that as fatal made a four-process race
   fail open about one run in three. An attempt to distinguish it by checking whether the lock
   still existed was itself racy; retrying the whole class and deciding only once the budget is
   exhausted has no such window.

---

## 7. UTC periods

```
day    = new Date(now).toISOString().slice(0, 10)    // 2026-10-04
month  = new Date(now).toISOString().slice(0, 7)     // 2026-10
```

UTC, never the machine's local timezone. A team sharing a budget across timezones has to agree on
when "today" ends, and the only answer that does not depend on who is asking is UTC. It is also
what the telemetry segment names already use, so a budget period and a telemetry partition line up
instead of being a few hours apart.

**A period is a key, not a job.** Rollover is a key mismatch: if the stored `day` is not today's
key, the daily bucket is zeroed on read. Nothing is scheduled at midnight, so nothing can fail to
run at midnight. Month length and leap years need no special case at all, because the keys are
substrings of an ISO string and no arithmetic is ever done on dates.

Boundaries tested: `23:59:59.999Z` → `00:00:00.000Z`, Jan 31 → Feb 1, Dec 31 → Jan 1, and
2028-02-29 against 2026-02-28. A bad clock yields `null` keys rather than a wrong period.

---

## 8. Primary fallback

When governance refuses, the developer still gets their file.

```
governance denies
  ↓
response: null
  ↓
Claude Code runs the original Read
```

`response: null` is already this hook's way of saying "write nothing". Budget exhaustion means
**worker acceleration unavailable**, never **task failed**. `budget.onExceed` chooses between
refusing (`disable`) and recording the breach and delegating anyway (`warn`); neither fails the
request.

---

## 9. Telemetry

Eight additive, nullable columns. `SCHEMA_VERSION` stays `1` and `CALC_VERSION` stays `1` — no
formula and no null rule changed.

| column | type | notes |
| --- | --- | --- |
| `governance_decision` | enum \| null | `allow`, `deny`, `unknown`; open on read |
| `governance_reason` | enum \| null | separate from the decision, per the brief |
| `budget_scope` | enum \| null | `run`, `daily`, `monthly` |
| `budget_limit` | number \| null | the configured limit, never a guess |
| `budget_remaining` | number \| null | `null` ⟺ `budget_measurement_status === 'unavailable'` |
| `budget_measurement_status` | enum \| null | `measured`, `estimated`, `unavailable` — closed, no `other` |
| `reservation_tokens` | int \| null | the estimate that sized the reservation |
| `reservation_status` | enum \| null | `none`, `reserved`, `settled`, `released`, `overrun` |

Three rules these respect:

- **`limit - unknown` is never computed as though unknown were zero.** Unknown spend yields
  `remaining: null`, not `limit`.
- **All eight are null when governance was never consulted** — every row where routing refused
  first. That is a distinct state from "governance allowed this", and the columns keep them apart.
- **No existing cost or token column is duplicated.** The budget columns describe policy and
  headroom; the `worker_*` columns describe what one call used.

A budget refusal is never reported as `provider_error`. It writes `status: 'skipped'` with
`error_code: null`, so a reader can tell a budget refusal from a failed call.

One implementation note worth keeping: the governance fields are coerced **before** the record
literal. An object literal evaluates in source order, so a field placed after
`validation_warnings` is coerced after the counter has already been read and its complaints are
silently lost — measured as an unrecognised `governance_decision` producing
`validation_warnings: 0`. The serialised key order comes from `FIELD_ORDER`, not from the literal.

---

## 10. Configuration

```json
{
  "budget": {
    "enabled": true,
    "run":     { "maxWorkerCostUsd": null, "maxInputTokens": null,
                 "maxOutputTokens": null, "maxTotalTokens": null },
    "daily":   { "maxWorkerCostUsd": null, "maxTotalTokens": null },
    "monthly": { "maxWorkerCostUsd": null, "maxTotalTokens": null },
    "onExceed": "disable",
    "onUnknownCost": "allow",
    "onUnknownUsage": "allow",
    "stateDir": "~/.claude/model-router/governance"
  }
}
```

Every limit ships `null`, so **governance is inert until an operator configures one**. The flat
`budget.dailyWorkerCostUsdLimit` leaf that existed through phase 8 — and was read by nothing but
two display lines — has been replaced by `budget.daily.maxWorkerCostUsd`, which keeps the same
`CMR_DAILY_BUDGET_USD` environment variable so operator muscle memory survives the move.

`stateDir` is separate from the telemetry store on purpose: telemetry is an append-only record of
what happened, this is small mutable state about what is allowed next. Mixing them would mean
reading a growing JSONL file on the hot path to answer a question that fits in 400 bytes.

---

## 11. Performance

Measured on the development machine with `process.hrtime.bigint()`, 2000 iterations after warmup.

| operation | median | p95 |
| --- | --- | --- |
| `hasConfiguredLimit` (all null — the shipped state) | 0.0005 ms | 0.0013 ms |
| `evaluateBudget` (nothing configured) | 0.0015 ms | 0.0021 ms |
| `evaluateBudget` (a daily token limit) | 0.0021 ms | 0.0034 ms |
| **`checkBudget` — default install, short-circuit, no I/O** | **0.0008 ms** | **0.0019 ms** |
| `checkBudget` + `finalizeBudget` — configured, full ledger round trip | 4.05 ms | 6.79 ms |

**The short-circuit is the load-bearing line.** With every limit `null`, `checkBudget()` returns on
a pure object walk before the ledger is ever opened: no directory created, no file written, no lock
taken. A default install pays under a microsecond for a feature it is not using, and
`test/governance.integration.test.mjs` asserts the state directory does not exist afterwards.

4 ms for a configured budget is two lock cycles and two read-modify-writes, against the hook's
20-second deadline — about 0.02% of it, and it only happens on a call that was about to spend
seconds in a model anyway. `test/hook.latency.test.mjs` measures a non-delegating decision at
0.08 ms, unchanged from phase 8, because a refusal never reaches governance at all.

---

## 12. Security

Governance operates on already-derived facts and configuration, and nothing else. It never reads:

- API keys or any environment secret — it reads no `process.env` at all, and
  `test/governance.isolation.test.mjs` pins that
- prompts, conversation history or system prompts
- source file contents

It imports no provider, makes no network call, spawns nothing and evaluates nothing. The one fact
it needs about a provider — whether a monetary budget can be consumed by it — arrives as the string
`billing`, obtained from a static registry table that costs no dynamic import.

The ledger holds token counts, dollar amounts, call counts, UTC period keys and reservation ids.
A reservation id is Claude Code's own `tool_use_id`, which is unique per call and carries no file
or prompt content — which is what makes it the one identifier a budget ledger may safely keep.

No redaction logic was added here. The redaction boundary stays where it is, in
`lib/dispatch/task.mjs`.

---

## 13. Known limitations

1. **A dollar budget cannot be enforced out of the box**, because every bundled rate is `null`.
   Token budgets can. Doctor says so; this is not fixable without inventing prices.
2. **A cost total assembled from partially-unpriced calls is a lower bound.** It can prove a budget
   is exceeded; it cannot prove one is not.
3. **Cross-process enforcement is bounded, not exact.** The decision is outside the lock, so a
   small overshoot is possible under concurrency. See §6.
4. **Cross-machine enforcement over a network share does not hold**, because `O_EXCL` creation is
   not reliably atomic there.
5. **A provider that reports no usage cannot exhaust a token budget** under the default
   `onUnknownUsage: 'allow'`.
6. **A killed hook leaks its reservation until the TTL expires** (5 minutes, against a hook
   deadline capped at 120 seconds). During that window the budget is understated by that
   reservation. A shorter TTL would risk reclaiming a reservation whose worker call was still
   running, which would let the same headroom be spent twice.
7. **Replay protection depends on the reservation id.** `settle` and `release` are idempotent by
   id, so a replayed hook cannot double-charge. The JSONL sink itself has no write-path dedup —
   that is deferred to ingest, as `docs/telemetry-schema.md` states.
8. **A payload with no `tool_use_id` is never reserved.** It still delegates; it is simply not
   accounted for, because a reservation that cannot be settled idempotently is worse than none.

---

## See also

- [`routing.md`](routing.md) — the gate, and why a budget is not one of its inputs
- [`worker-capability.md`](worker-capability.md) — the third decision, and the three "context limits"
- [`telemetry-schema.md`](telemetry-schema.md) — the cross-plugin contract the eight columns join
- [`savings-methodology.md`](savings-methodology.md) — why every number here is conservative
