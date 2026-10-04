# Hook integration

`hooks/pre-tool-use.mjs` plus `lib/hook/` is the adapter that finally connects Claude Code to the
engine. It intercepts one tool, asks the existing gate, and — only when the gate says so — hands
the file to the worker and gives Claude the worker's summary instead of the file's bytes.

It adds no routing rule, no provider, no execution mode and no money math. The verified Claude
Code side of the contract is in [claude-code-hook-contract.md](claude-code-hook-contract.md).

> **A failed optimisation is never a failed operation.** Every error path ends with the original
> Read proceeding, and the hook signals that by writing *no bytes at all* — which is
> indistinguishable from the plugin not being installed.

```
Claude Code  --PreToolUse(Read)-->  pre-tool-use.mjs
                                      |
                        facts: statSync + transcript tail + readiness   (no content, no socket)
                                      |
                                  decide()        <- once, synchronously
                                      |
                 delegate && deny ? --+-- otherwise: write nothing, Claude reads the file
                                      |
                           read the file ONCE
                                      |
                    dispatch(bulk-reader)  under hooks.timeoutMs
                                      |
                 ok ? deny + additionalContext  :  write nothing
                                      |
                              emitEvent()        <- last, and never load-bearing
```

## What is intercepted

**`Read`, and nothing else.**

`Bash` is deliberately not intercepted. Recognising a read-only bulk-read inside a shell command
means parsing a command line, and a path extracted from a parsed shell string is exactly the input
that must never become a command again. `Write`/`Edit` are not intercepted either: the `codeWrite`
lane is advisory (`enforce: 'suggest'`) and has no size thresholds, because a hook cannot know a
`Write` is boilerplate before the code exists.

**Code-writing interception is not active.** Nothing in this phase writes, modifies or generates a
file.

## Normalization

`lib/hook/adapter.mjs` is pure and imports nothing. It maps the payload onto `decide()`'s
16-field contract, declaring every field explicitly — including the `null` ones, so the table can
be checked against [routing.md](routing.md) line by line.

| routing field | source |
|---|---|
| `taskType` | `'bulk_read'` — the one lane this hook serves |
| `toolName` | `payload.tool_name` (advisory only) |
| `fileCount` | `1` |
| `paths` | `[tool_input.file_path]` |
| `projectPath` | `payload.cwd`, else `CLAUDE_PROJECT_DIR`, else `null` |
| `inputBytes` | `fs.statSync().size` — **metadata only**; `null` on any failure |
| `lineCount` | **`null`** — see below |
| `estimatedInputTokens` | **`null`** — see below |
| `targetedRead` | `offset`, `limit` or `pages` present |
| `fullRead` | the negation |
| `recentlyEdited` | measured from the transcript; `true` when unmeasurable |
| `interactive` | **`false`** — asserted, see below |
| `latencySensitive` | **`false`** — asserted, see below |
| `requestedOutput` | `null` — a Read says nothing about the answer's shape |
| `workerAvailable` | `readinessFor()`, synchronous, no socket |
| `workerUnavailableReason` | `'worker_not_ready'` (budget enforcement is not in this phase) |

### Two asserted values, and why

`interactive` and `latencySensitive` are the only facts in the whole plugin that are **asserted
rather than measured**. A PreToolUse payload carries no session posture, and both fields read as
`true` when unknown, and both are terminal refusals (rules 4 and 5). An "honest unknown" hook
would therefore refuse every read forever, and the shipped `routing.bulkRead.enforce: 'deny'`
default would be unreachable.

So the hook asserts `false` for both and says so here. The off-switches are `hooks.enabled`,
`routing.bulkRead.enforce: 'off'` and `CMR_ENABLED=0` — not these two fields.

### `recentlyEdited` is measured, because it is a safety rule

A file Claude just edited is one where it needs the exact current bytes, not a summary of them.
`neverDelegate.onRecentlyEdited` is advertised as enforced in
[what-we-do-not-delegate.md](what-we-do-not-delegate.md), so the hook measures it rather than
asserting it:

1. read at most the last **256 KiB** of `transcript_path`;
2. search that buffer for the file's basename as a plain substring — if absent, no line is parsed
   at all, which is the common case;
3. otherwise drop the leading partial line and look for a `tool_use` of
   `Edit`/`Write`/`MultiEdit`/`NotebookEdit` naming the same path;
4. anything unmeasurable — no transcript path, unreadable file, parse failure — yields **`true`**,
   which refuses.

Two consequences worth stating. The scan is bounded by **bytes, not turns**, so an edit far enough
back is not seen; that is a deliberate trade for a cost that does not grow with session length.
And because the gate reads unknown as `true`, an unmeasurable transcript is reported as
`recently_edited` — the rule that fired, not the reason the fact was missing.

### Why no line count

`routing.bulkRead.minLines` (350) **never fires from the hook**, and `minBytes` (12000) answers the
size question alone.

Counting lines requires the file's bytes, and reading a file to decide whether reading it is worth
avoiding defeats the purpose. The file is read exactly once, after the gate has already approved
it — a test asserts the count.

The accepted consequence: a 400-line file under 12 000 bytes stays with Claude. That is a refusal,
which is the safe direction. Lower `routing.bulkRead.minBytes` if you want narrower files
delegated.

## The delegated read

Only `decision === 'deny'` is acted on. `suggest` and `ask` are recorded and let the Read through:
`suggest` means "delegate-worthy, but do not block", and steering Claude to a skill is a later
phase; `ask` would prompt the developer to approve a read rather than delegate it.

The worker receives exactly `{files: [{path, content}], task}` — one file, the one the gate proved,
and a task — plus, when the developer has opted in, `instructions` and `outputRequirements`.
Nothing else: no transcript content beyond the one prompt string described below, no environment,
no conversation history.

**By default the task is a fixed, versioned literal.** The payload never says *why* Claude wanted
the file, so with the shipped configuration there is no question to forward and the summary answers
a generic one. Claude may then follow up with a targeted `offset`/`limit` read — which the gate
lets straight through, and which the deny reason explicitly suggests.

**`hooks.taskIntent.source: 'transcript'` changes that, and is off by default.** The transcript the
hook already opens carries the newest prompt in structured records, so the worker can be told what
is actually being looked for. Turning it on means the developer's own prompt text is sent to the
worker model. The default is `none`, under which the built prompt is byte-identical to the one this
plugin has always sent. The contract, the record shapes, the boundary and the exposure are in
[worker-task-construction.md](worker-task-construction.md).

Intent is extracted **after** the gate has ruled, so no prompt text is in scope while the routing
decision is being made, and a refused read never pays for the second transcript read at all.

The response is a deny plus the answer as context:

```json
{"hookSpecificOutput": {
  "hookEventName": "PreToolUse",
  "permissionDecision": "deny",
  "permissionDecisionReason": "This file was not read directly: model-router delegated it to …",
  "additionalContext": "<the worker's summary>"
}}
```

The deny is what keeps the bytes out of the context window — that *is* the saving. The reason
becomes Claude Code's `blockingError`, so it explains the block and nothing else; the summary
travels in `additionalContext`, because delivering it in the reason would label it as the tool's
error and invite a retry.

## Fail-open behaviour

Every row below writes **nothing** to stdout and exits 0.

| situation | outcome code |
|---|---|
| `hooks.enabled: false` | `hooks_disabled` |
| `CMR_ENABLED=0` or an unusable config | `routing_disabled` |
| stdin empty, unparseable, or not an object | `empty_stdin` / `unparseable_stdin` / `not_an_object` |
| another event or another tool | `wrong_event` / `wrong_tool` |
| no `tool_input`, or no usable `file_path` | `no_tool_input` / `no_file_path` |
| `statSync` fails — missing file, a directory, permissions | gate says `below_threshold` |
| transcript unreadable | gate says `recently_edited` |
| worker unconfigured or not ready | gate says `worker_not_ready` |
| sensitive path | gate says `deny_glob`, and the bytes are never loaded |
| the gate throws (it is specified not to) | `routing_threw` |
| the file is unreadable, or is binary | `content_unreadable` / `content_binary` |
| any dispatch error or skip | `worker_failed` |
| the worker's answer is blank | `empty_answer` |
| the hook's own deadline expires | `worker_failed` (dispatch reports `aborted`) |
| **telemetry throws or cannot write** | response unchanged |
| anything else at all | `hook_threw` |

The response is decided **before** the row is written, and writing the row cannot change it.
`test/hook.failopen.test.mjs` has one test per row.

## Telemetry

One row per invocation that reached the gate, through the existing never-throws sink. Delegations
always write a row; refusals write a `gate_block` row unless
`telemetry.recordGateDecisions: false`.

| field | value |
|---|---|
| `task_type` | `bulk_read` when dispatched, `gate_block` when refused |
| `routing_decision` / `routing_reason` | the gate's own answer — **never** the dispatch reason |
| `routing_policy_version` / `prompt_version` | stamped, so a stored row names what produced it |
| `files_count` / `files_inferred_count` | `1` / `0` — the hook never infers a sibling |
| `latency_ms` | the dispatcher's end-to-end measurement; `null` on a gate row |
| `primary_*` | **all `null`**, `primary_usage_method: 'none'` |

A dispatch `reason` is **translated**, never passed through: `completed` and `routing_declined`
echo the decision's reason, everything else becomes `provider_error`. Passing one straight through
would stamp `unknown_enum:routing_reason` on essentially every delegated row and poison the one
signal the store has for "something is actually wrong". A test asserts no row ever carries it.

`primary_*` stays unavailable because there is no transcript reader. Estimating primary usage from
the file's size and storing it in the un-prefixed columns would put a counterfactual where the
schema promises a measurement.

The routing engine's `inputWarnings` fold into `validation_codes`, so one row answers "did anything
look wrong here" once rather than in two places.

## Security boundary

| claim | how it is enforced |
|---|---|
| no shell, no child process, no socket | `lib/hook/**` and the entry point may import only `node:fs` and `node:path` — a static test, not a convention |
| a file path cannot become a command | follows from the above; `Bash` is not intercepted at all |
| exactly two paths are opened | the `file_path` the payload named, and `transcript_path`. A test watches every `fs` call |
| a secret file's bytes are never loaded | the deny globs are enforced by the gate *before* the content read; a test asserts `readFileSync` is never called for a denied path |
| nothing is logged | no `console.`, no `process.stderr`; one `fs.writeSync(1, …)` on one path |
| no environment pass-through | the worker request is built explicitly from the file and the fixed task |
| secrets do not survive into a row | `redactSecrets` already scrubs the dispatcher's error fields; a test plants a key and greps the row |

## Performance

Measured by `test/hook.latency.test.mjs`, which prints the numbers it asserts. On the development
machine (Windows 11, Node 24):

| path | cost |
|---|---|
| decision, in process | **0.06 ms** (median of 30) |
| the same for a 4 MB file | **0.05 ms** — flat, because only `statSync` is consulted |
| transcript scan, 64 KiB vs 16 MiB | 0.52 ms vs 0.88 ms — bounded by bytes, not session length |
| **whole process, refusing** | **≈73 ms** (median of 5, includes Node startup) |

Node startup dominates by three orders of magnitude, which is the argument for the hook doing as
little as possible: the decision itself is free, and the process is the cost. That ≈73 ms is paid
on **every** `Read` in a session where the plugin is enabled.

A delegated read costs whatever the worker costs. That is bounded by `hooks.timeoutMs` (default
20 s), **not** by `worker.timeoutMs` (default 180 s with 2 retries), because minutes is not an
interactive budget. `withRetry` is signal-blind during backoff, so an abort landing inside a sleep
is honoured up to ~1.6 s late at default retry settings.

## Configuration

| key | default | env |
|---|---|---|
| `hooks.enabled` | `true` | `CMR_HOOKS_ENABLED` |
| `hooks.timeoutMs` | `20000` (min 1000, max 120000) | `CMR_HOOK_TIMEOUT_MS` |
| `telemetry.recordGateDecisions` | `true` | `CMR_RECORD_GATE_DECISIONS` |

## How to turn it off

| what you want | how |
|---|---|
| stop intercepting, keep everything else | `hooks.enabled: false`, or `CMR_HOOKS_ENABLED=0` |
| stop routing entirely | `CMR_ENABLED=0` |
| keep the gate's opinion, stop it blocking | `routing.bulkRead.enforce: 'suggest'` |
| disable the bulk-read lane | `routing.bulkRead.enforce: 'off'` |
| stop telemetry for one session | `CLAUDE_ROUTER_TELEMETRY=0` |
| keep delegation rows, drop refusal rows | `telemetry.recordGateDecisions: false` |

Out of the box with no worker key, every read reports `worker_not_ready` and nothing is delegated.

## Verifying an installation

```bash
npm run doctor                                        # a "Claude Code hook" section
node plugins/model-router/scripts/smoke-hook.mjs      # the real pipeline against local Ollama
```

The smoke script is opt-in and not part of `npm test`, which stays keyless and offline. In a live
session, `/hooks` shows what is registered, and `claude --debug-file ./hook.log -p "…"` records
whether it ran.

## What remains intentionally unsupported

- **`Bash` interception** — would require shell parsing.
- **Code-writing interception** — the `codeWrite` lane is advisory and unwired.
- **Skills** — nothing steers Claude to a delegation script; `suggest` therefore does nothing.
- **Budget enforcement inside the gate** — `decide()` still consults no budget and
  `budget_exceeded` is still unreachable, deliberately. Budget governance exists as of phase 9
  but runs AFTER the gate has ruled, in `lib/governance/`; see
  [governance.md](governance.md) §2 for why it is not folded into the rule table.
- **Measured primary-model usage** — no transcript reader, so `primary_*` is `null`.
- **Intent beyond one prompt string** — `requestedInformation`, `constraints` and `outputFormat`
  are in the contract but have no honest source from a transcript, so they stay `null` in
  production. Only a caller that genuinely knows them can supply them.
- **Outbound content redaction** — intent text crosses a redaction boundary; file content does
  not. The filename deny list is still the only control.
- **Multi-file corpora** — one Read is one file; the gate proves nothing more.
- **`minLines`** — unreachable from a hook, as explained above.
- **PDF and binary files** — a binary read falls open; a `pages` read is a targeted read.
