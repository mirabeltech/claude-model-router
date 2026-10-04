# The Claude Code hook contract, as verified

Everything in this document was **read out of the installed Claude Code binary or observed in a
live session**, not taken from the published documentation. Three points below contradict the
public reference, and two of them are the difference between a hook that works and a hook that is
loaded, reported as registered, and never executed.

| | |
|---|---|
| Verified against | **Claude Code 2.1.177** (`claude --version`) |
| First verified | 2026-10-04 |
| Re-verified | 2026-10-04 — same version installed, so nothing to reconcile |
| Binary | `@anthropic-ai/claude-code/bin/claude.exe`, a native build |
| Platform | Windows 11, Node 24.16.0 |
| Method | string extraction from the binary's own zod schemas and runner, plus live `claude -p` sessions with `--debug-file` |

> **Re-verify this on a version bump.** None of it is a stable public API. The hook-level tests
> encode the parts that would fail silently, which is the only defence that survives an upgrade.

The version above is declared once, in `test/helpers/versions.mjs` as
`TESTED_CLAUDE_CODE_VERSION`, and `test/docs.contract.test.mjs` asserts that every file naming a
Claude Code version names that one. It is named in six places; before that assertion existed,
bumping five of them and missing the sixth would have failed nothing, leaving a document claiming
verification the tests disagreed with. The constant is deliberately not read from `claude --version`
at test time: the CLI is not guaranteed to be installed, and the question is not what is installed
here but what this contract was actually checked against — a fact about a past verification, which
only a human re-verifying should change.

## How to re-derive it

The binary embeds its own validation schemas as readable strings:

```bash
EXE="$(npm root -g)/@anthropic-ai/claude-code/bin/claude.exe"

# the PreToolUse output schema
grep -a -o -E '.{0,220}"PreToolUse".{0,260}' "$EXE" | tr -d '\000' | grep hookEventName

# how a deny is applied, and whether additionalContext survives it
grep -a -o -E '.{0,700}additionalContexts&&w\.additionalContexts\.length>0.{0,200}' "$EXE" | tr -d '\000'

# the command-hook schema, including exec form
grep -a -o -E '.{0,60}k\.literal\("command"\).{0,420}' "$EXE" | tr -d '\000'
```

## 1. The event

`PreToolUse` fires **before** a tool executes. The sibling events are `PostToolUse`,
`PostToolUseFailure` and `PostToolBatch`.

This plugin uses `PreToolUse` because it is the only event at which a file's bytes can be kept out
of the context window. By `PostToolUse` the Read has already happened.

## 2. The stdin payload

Captured verbatim from a live session (`tool_use_id` shortened):

```json
{
  "session_id": "45370d64-4fe5-433e-8d07-2c67f1188e06",
  "transcript_path": "C:\\Users\\me\\.claude\\projects\\D--Dev-Projects-Model-Routing\\45370d64-….jsonl",
  "cwd": "D:\\Dev Projects\\Model Routing",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PreToolUse",
  "tool_name": "Read",
  "tool_input": { "file_path": "D:\\Dev Projects\\Model Routing\\test\\fixtures\\corpus\\small.ts" },
  "tool_use_id": "toolu_013yNA1GFpdWjKt9HXYEfTwL"
}
```

Observations that matter to the adapter:

- **`file_path` is absolute**, and on Windows uses backslashes. `lib/globs.mjs` already normalizes
  separators and case, so the deny list is not evadable by spelling.
- **`effort` is present and is an object.** It is not in the published field list.
- **`prompt_id` and `scratchpad_dir` were NOT present** in this build's PreToolUse payload,
  although the docs list them. The adapter must not require any field it does not need.
- **Nothing in the payload says why Claude wanted the file.** There is no prompt, no question and
  no task. That is why the worker gets a fixed task string by default — see
  [hook-integration.md](hook-integration.md). It is available INDIRECTLY, from `transcript_path`;
  see §2a.
- **No size, line count or content.** Every quantity the gate needs has to be measured.

`tool_input` for `Read`: `file_path` (required), and the optional narrowing arguments `offset`,
`limit` and `pages` (PDF page ranges).

## 2a. The transcript, and the intent that is in it

Re-verified at the same version. The payload has no intent field, but `transcript_path` points at
the session's JSONL and that file carries the prompt in STRUCTURED records — not as prose to be
scraped. Record types observed in a live transcript of this project:

| record | identified by | holds |
|---|---|---|
| `{type: 'last-prompt', lastPrompt, leafUuid, sessionId}` | `type` | the newest prompt, verbatim |
| `{type: 'user', promptId, promptSource, origin, turnOrigin, turnPosition, permissionMode, message}` | `promptSource` present | a genuine human turn |
| `{type: 'user', toolUseResult, sourceToolAssistantUUID, message}` | `toolUseResult` present | a TOOL RESULT |
| any of the above plus `isSidechain: true` | `isSidechain` | a subagent's turn |

Also present: `attachment`, `assistant`, `file-history-delta`, `file-history-snapshot`,
`ai-title`, `atis-latch`, `queue-operation`.

Observations that matter to the adapter:

- **A tool result is also `type: 'user'` with `role: 'user'`.** A reader keying on either would
  feed a file's own contents back as the question about it. `promptSource` is the discriminator,
  and `toolUseResult` / `sourceToolAssistantUUID` are the counter-indicators.
- **`message.content` is a string OR an array of content blocks.** Both shapes occur; only `text`
  blocks carry prompt text.
- **`isSidechain` marks a subagent turn**, whose prompt is not the developer's.
- **These are runtime internals and will change.** The adapter therefore treats every shape it
  does not recognise as "no intent" rather than "some intent": a future format half-understood
  would forward a fragment, and a fragment is worse than nothing.

`transcript_path` is read on every invocation regardless, bounded to a 256 KiB tail, to measure
`recentlyEdited`. Reading one prompt field from it is gated behind `hooks.taskIntent.source`,
which defaults to `none`. See [worker-task-construction.md](worker-task-construction.md).

## 3. The stdout protocol

The PreToolUse branch of `hookSpecificOutput`, verbatim from the binary's schema:

```js
k.object({
  hookEventName: k.literal("PreToolUse"),
  permissionDecision: <enum>.optional(),          // "allow" | "deny" | "ask" | "defer"
  permissionDecisionReason: k.string().optional(),
  updatedInput: k.record(k.string(), k.unknown()).optional(),
  additionalContext: k.string().optional(),
})
```

`defer` is print-mode only. The runner **throws** if `hookEventName` disagrees with the event being
handled, so the literal has to be echoed back.

### `deny` feeds its reason to Claude

```js
case "deny":
  M.permissionBehavior = "deny",
  M.blockingError = { blockingError: H.hookSpecificOutput.permissionDecisionReason || H.reason || "Blocked by hook", command: q }
```

So `permissionDecisionReason` reaches Claude as the tool's **error**.

### `additionalContext` is valid on PreToolUse, and survives a deny

This is the point the public reference gets wrong — it presents `additionalContext` as belonging
to `UserPromptSubmit` and `SessionStart`. It is in the PreToolUse schema above, and the runner
emits it:

```js
if (w.additionalContexts && w.additionalContexts.length > 0)
  yield { type: "additionalContext", message: { message: M7({
    type: "hook_additional_context", content: w.additionalContexts,
    hookName: `PreToolUse:${q.name}`, toolUseID: $, hookEvent: "PreToolUse" }) } }
```

Critically, the permission decision is emitted as a chain of `yield`s and **this check follows it
unconditionally** — it is not in an `else`. A single hook response can therefore both deny the tool
call and inject context, which is exactly what a delegated read needs: the reason explains the
block, and the answer arrives as a system reminder rather than as an error.

Confirmed live. With the hook active, Claude reported:

> "I didn't actually obtain its contents — my `Read` was intercepted by the model-router hook,
> which delegated the file to `ollama/llama3:latest` and gave me only a summary …, not the file's
> bytes."

### `updatedInput` cannot be combined with a decision

```js
if (w.updatedInput && w.permissionBehavior === void 0) yield { type: "hookUpdatedInput", ... }
```

`updatedInput` is applied **only when no `permissionDecision` was returned**. "Deny and rewrite"
is not an available combination, which rules out redirecting a blocked Read at a cached summary.

### There is no synthetic tool result

No `result`, `toolResult` or equivalent field exists for PreToolUse. A hook cannot fabricate what
the tool would have returned. The two ways to put text in front of Claude are the deny reason and
`additionalContext`.

`PostToolUse` *can* replace a result:

```js
updatedToolOutput: k.unknown().optional().describe("Replaces the tool output before it is sent to the model")
```

**Considered and rejected.** It would work — the Read's disk I/O is not what costs tokens, so
replacing its output would save the same context — but it rewrites a Read silently: Claude asks for
a file and receives a summary with nothing saying so. A `PreToolUse` deny is explicit, and
explicitness is worth more here than elegance.

## 4. Exit codes

| Code | Meaning for PreToolUse |
|---|---|
| **0** | Success. stdout is parsed as JSON when it starts with `{` and ends with `}` and validates; otherwise it is treated as plain text for the debug log. |
| **2** | **Blocks the tool call**, with stderr fed to Claude as the reason. |
| other | Non-blocking error; the tool proceeds. |

This plugin **always exits 0** and never writes to stderr. `exit 2` is a blocking channel whose
failure mode is a broken tool call, which is the opposite of what a router should degrade to.

## 5. Registration, and the two traps

A plugin's `hooks/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read", "hooks": [ { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"] } ] }
    ]
  }
}
```

`matcher` is `k.string().optional()` — a tool name, or a regex when it contains regex characters;
omitted matches every tool.

Exec form is real and is what this plugin uses:

> `args`: *"Argument list for exec form. When present, `command` is resolved as an executable and
> spawned directly with these arguments — no shell. Path placeholders like `${CLAUDE_PLUGIN_ROOT}`
> are substituted per-element as plain strings, so paths with quotes, `$`, or backticks never"* …

That matters on this repo's own checkout, whose path contains a space.

### Trap 1 — `args` and `timeout` together are silently ignored

**Verified by elimination across four live sessions.** A `PreToolUse` entry carrying **both**
`args` and `timeout` is loaded, logged as registered, and **never executed**:

```
[DEBUG] Read hooks.json for plugin model-router (enabled=true): …\hooks\hooks.json
[DEBUG] Loading hooks from plugin: model-router
[DEBUG] Registered 7 hooks from 4 plugins
```

…and then nothing. No error, no warning, and the tool runs normally.

| form | `timeout` | executed |
|---|---|---|
| `command` + `args` | `30` | **no** |
| `command` + `args` | absent | **yes** |
| `command` as one shell string | `30` | yes |

So the choice is exec form **or** an explicit timeout, not both. This plugin keeps exec form,
because invoking `node` directly is a project non-negotiable, and bounds itself with
`hooks.timeoutMs` instead — which is the better bound anyway, since it is configurable and it
aborts the worker call rather than killing the process. `test/hook.security.test.mjs` asserts the
`timeout` field is absent, because re-adding it stops the hook running and nothing says so.

### Trap 2 — never redeclare `hooks/hooks.json` in `plugin.json`

`hooks/hooks.json` is loaded **automatically**. Naming it again in the manifest's `hooks` key is
fatal to the whole plugin's hooks:

```
[ERROR] Duplicate hooks file detected: ./hooks/hooks.json resolves to already-loaded file …
        The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only
        reference additional hook files.
[DEBUG] Plugin not available for MCP: model-router@inline - error type: hook-load-failed
```

This repo shipped that key from Phase 0 and it was harmless only because `hooks.json` was empty.
`manifest.hooks` is for **additional** hook files. A test pins its absence.

## 6. Timeouts, async and environment

- **Units are seconds** for a command hook (`"Timeout in seconds for this specific command"`).
  Other hook types use milliseconds, which is a trap of its own.
- On timeout the hook is **skipped and the tool runs** — fail-open by construction.
- Hooks may be async: stdin is fully provided and the process is awaited to completion. Background
  work is not awaited.
- Available to the process: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`,
  `CLAUDE_EFFORT`, `CLAUDE_PLUGIN_OPTION_<KEY>`. Credentials are **not** exposed by design.

## 7. Validating and debugging

`claude plugin validate --strict` **does** schema-validate `hooks/hooks.json`, including handler
internals. It is quiet on success and precise on failure:

```
$ claude plugin validate ./plugins/model-router --strict
  ❯ hooks.NotAnEvent: Invalid key in record
  ❯ hooks.PreToolUse.0.hooks.0.type: Invalid input
```

It does **not** catch either trap above. Both are load-time behaviours, not schema errors, so only
a live session reveals them.

For a live session: `claude --debug-file ./hook.log -p "…"`, then look for
`Read hooks.json for plugin`, `Registered N hooks`, `Hook PreToolUse:Read`, `Slow PreToolUse
hooks` and `tool_dispatch_start … permissionDecisionMs`. In an interactive session `/hooks` lists
what is registered and where it came from.

Note that `Slow PreToolUse hooks: …ms for Read (2 hooks)` counts **every** plugin's hooks, so a
slow unrelated hook is easily mistaken for your own. The way to be sure a specific hook ran is to
have it leave a trace — a telemetry row serves here.

## 8. A deprecated response format to recognise

A hook returning the old top-level shape is rejected by this build:

```
[DEBUG] Hook PreToolUse:Read (PreToolUse) error:
{"decision": "allow"}
```

Seen in testing from an unrelated installed plugin. `decision`/`reason` at the top level are
superseded by `hookSpecificOutput.permissionDecision` / `permissionDecisionReason`.
