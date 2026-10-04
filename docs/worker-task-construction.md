# Worker task construction

How the request a worker receives is assembled, where the developer's own words may enter it, and
what is still exposed when they do.

Phase 7 split one question into two. `decide()` answers **"should this work be delegated?"** and
`buildWorkerTask()` answers **"what exactly should the worker do?"** They are separate modules
with no edge between them, and the separation is the point: the shape of a request must never
influence whether the request is allowed.

```
PreToolUse payload ─► decide()  ············ UNCHANGED. 16 fields, no intent, taskType literal.
                         │ delegate && deny
                         ▼
                   readTextContent()  ······ content selection
                         │
                   extractTaskIntent()  ···· lib/hook/intent.mjs   (gated, default off)
                         │
                   normalizeTaskIntent()  ·· lib/hook/adapter.mjs  (pure)
                         │
                   buildWorkerTask()  ······ lib/dispatch/task.mjs (pure, REDACTION BOUNDARY)
                         │ mode input
                   MODES[mode].build()  ···· lib/dispatch/modes.mjs
                         │ {system, prompt, promptVersion}
                         ▼
                      provider
```

## 1. Why this exists

A live `ollama/llama3` run on the `shape-repetitive-content` corpus case failed. It was given a
table of near-identical handler registrations and asked which one was deprecated. It spent 2060
input and 369 output tokens, avoided 2691 net tokens, and answered wrongly — it identified neither
the deprecation nor the entity.

The cause was not the threshold and not the model's size. It was the request. Before this phase the
bulk-reader worker always received `BULK_READ_TASK`:

> Summarise this file for an engineer who has not seen it. Cover its purpose, its structure, and
> every significant declaration with the line it is on. …

That is a fair request for a generic question and a poor one for "find every deprecated call and
give me the line", which is what a bulk read usually serves. A worker asked to summarise a table
summarises the table.

## 2. What Claude Code actually provides

Verified against the installed binary at **2.1.177**, not inferred from the published field list.
The extraction and the exact version are in [claude-code-hook-contract.md](claude-code-hook-contract.md).

**The PreToolUse payload carries no intent.** Its fields are `session_id`, `transcript_path`,
`cwd`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input` and `tool_use_id`.
There is no `prompt`, and `prompt_id`/`scratchpad_dir` are absent in this build although the public
docs list them. Nothing in it says why Claude wanted the file.

**Intent is available indirectly, in structured form, from the transcript.** `transcript_path`
points at the session's JSONL, which this hook already opens on every invocation to measure
`recentlyEdited`. Three record shapes matter:

| record | identified by | holds |
|---|---|---|
| `{type: 'last-prompt', lastPrompt, leafUuid, sessionId}` | `type` | the newest prompt, verbatim |
| `{type: 'user', promptId, promptSource, message, …}` | `promptSource` present | a human turn |
| `{type: 'user', toolUseResult, sourceToolAssistantUUID, message, …}` | `toolUseResult` present | a TOOL RESULT, not a question |
| any of the above with `isSidechain: true` | `isSidechain` | a subagent's turn, not the developer's |

So this is a field read, not a heuristic scrape of prose. The third row is the sharpest trap: a
tool result is also `type: 'user'` with `role: 'user'`, so a reader keying on either would feed a
file's own contents back as the question about it, and the answer would be a summary of a summary
with nobody the wiser. `lib/hook/intent.mjs` requires `promptSource` and refuses any record
carrying `toolUseResult` or `sourceToolAssistantUUID`.

These are runtime details of a tool that changes. That is precisely why every shape the module does
not recognise means **no intent** rather than **some intent**: a future format half-understood
would send a fragment of something to a worker, and a fragment is worse than nothing.

## 3. It is off by default, and that is a decision not an oversight

```jsonc
{
  "hooks": {
    "taskIntent": {
      "source": "none",   // "none" | "transcript"
      "maxChars": 600
    }
  }
}
```

Env: `CMR_TASK_INTENT_SOURCE`, `CMR_TASK_INTENT_MAX_CHARS`.

With `none` — the shipped value — `extractTaskIntent` returns before touching a disk, the builder
is an identity, and **the rendered prompt is byte-identical to the one this plugin sent before this
phase existed**. That is asserted against a captured snapshot in `test/task.builder.test.mjs` and
again in `test/evals.protected.test.mjs`, so the default is a genuine no-op rather than a quiet
change.

`transcript` means the developer's own prompt text leaves the machine and reaches a worker model
that may be a third party. Only the developer can make that trade, so it is opt-in. The previous
release's `adapter.mjs` said the alternative "would send the developer's prompt text to a
third-party worker, which no config flag currently sanctions" — this is that flag, and it is off.

**One benchmark did not promote it.** The intent construction is not the default even though the
deterministic A/B shows it sends more and the live A/B measures its quality, because a benchmark
result is evidence and never changes policy by itself. See [benchmark-methodology.md](benchmark-methodology.md).

## 4. The task-intent contract

```js
{ task, objective, requestedInformation, constraints, outputFormat, source }
```

Every field nullable. `source` is `'none' | 'transcript' | 'other'`.

**Unknown stays null.** `normalizeTaskIntent()` narrows and discards; it has no branch that fills a
field in. In this release only `task` is ever populated in production, because the one thing
available is a prompt string. `objective`, `requestedInformation`, `constraints` and `outputFormat`
have **no honest source** from a transcript — deriving them would mean guessing at structure the
developer did not write, and inventing intent is exactly what this phase is forbidden to do. They
are in the contract so that a caller which genuinely knows them (an eval case, a test, a future
skill) can say so, and so the templates have something stable to render.

**"No intent" has exactly one representation: `null`.** An all-null object and `null` must not be
two spellings of the same thing, because the builder keys on that distinction to decide whether to
emit a section at all — and two spellings would let the default path and the opted-out path differ
by an empty heading.

## 5. The builder

```js
buildWorkerTask({ toolContext: { baseTask, lane }, taskIntent, files })
  -> { task, files, instructions, outputRequirements }   // a MODE INPUT, not a prompt
```

It returns a mode input and never a prompt; rendering stays `modes.mjs`'s job. Keeping them apart
is what lets the same built task be asserted field by field in a test and rendered byte-exactly in
a benchmark.

`baseTask` arrives as a **parameter** rather than an import. `adapter.mjs` owns the frozen generic
task, and no `lib/` module may import the hook layer — the dependency runs one way only and
`test/hook.security.test.mjs` enforces it. So the caller hands it down.

Deterministic: same input, same output, byte for byte. No clock, no randomness, no model call. Every
string is built with `join('\n')`, never a multi-line template literal, because `core.autocrlf` is
on and CI gates both platforms. `.gitattributes` normalises the repository as well, but an explicit
join holds regardless of whether that setting is in force.

### The bulk-reader request, with intent

```
# Task

<the developer's question>

# Requirements

- Answer the stated task directly and first. A summary is not an answer.
- Find EVERY occurrence that matches, not the first one and not a representative sample.
- Give the file path and the line number for each occurrence.
- Quote the matching text exactly as written; never paraphrase an identifier or a literal.
- Distinguish a real match from something that merely resembles one, and say which is which.
- If the material does not contain the answer, say so plainly. Never invent a match or a line number.
- Report: <requestedInformation>
- Constraints: <constraints>
- Present the answer as: <outputFormat>

# Files (N)

<<<<<<<<<< FILE …
```

**One section, not two.** The lane's standing instructions and the request's own requirements
differ in origin but are identical in kind — both are things the worker must do — and two headings
would invite a model to treat the second as optional.

**These are content requirements and never a serialization schema.** `docs/worker-dispatch.md` used
to say the bulk reader is "not told to produce a particular answer shape"; that claim is now
narrower and more precise: no serialization format is imposed, and content requirements are. The
existing assertion that the system string does not match `/json|yaml|schema/i` covered only the
system string and was blind to a requirements section, so `test/task.builder.test.mjs` asserts it
over the built **prompt**.

### The code-writer request

The code-writer accepts the same intent and lets it shape the requested output, while its safety
clauses stay verbatim:

- no filesystem, no shell, no network;
- cannot read a file, run a command, execute a test or touch version control;
- its output is a proposal, and something else decides whether it is applied.

Intent is attacker-adjacent input — it is whatever text was in the transcript — so
`test/task.builder.test.mjs` feeds it an objective demanding shell access and a commit, and asserts
that the request changes while the contract does not. No production path dispatches `code_write`
yet; it is built and tested now so that Phase 8+ cannot ship it unexamined.

## 6. Versioning

| constant | value | meaning |
|---|---|---|
| `PROMPT_VERSION` | 3 | the generic request. Its USER prompt bytes are still unchanged; the counter moved in phase 8 because the shared SYSTEM prompt changed. |
| `INTENT_PROMPT_VERSION` | 4 | the intent-aware request. More sections, more tokens. |

Both counters moved together in phase 8 (`1`->`3`, `2`->`4`). The change was to
`BULK_READER_SYSTEM`, which both variants share: its final rule used to say *"Be concise ...
include the facts it needs and nothing else"*, which set no precedence against the lane
requirement *"Find EVERY occurrence that matches"*. Not a contradiction, but it left a small
model free to resolve the tension toward brevity. It now subordinates concision to coverage
explicitly. The generic counter could not simply become `2`, because `2` already belonged to
the intent request and a stamp two different prompts can carry is a stamp nobody can read a
stored row against.
| `TASK_BUILDER_VERSION` | 1 | the intent → mode-input mapping. |

`mode.build()` now returns `promptVersion`, and `dispatch()` stamps the version of the prompt that
was **actually built** rather than the layer's current one. The eight exits before the build keep
the plain stamp; hoisting the build above them would mean assembling a payload for a provider that
is not ready.

This matters for one reason: a row stamped `2` carries extra input tokens, so **it is not
cost-comparable with a stored generic row**. Keeping the generic path at `1` means every row
written before this phase stays comparable with every generic row written after it.

There is deliberately **no second version column in telemetry**. `prompt_version` already
distinguishes the two constructions, and `modes.mjs` argues against a counter that always moves
with another: "two counters is two things to forget to bump."

## 7. The context boundary

| allowed into a worker request | disallowed |
|---|---|
| the built task | API keys, any environment variable |
| the lane's instructions and the request's requirements | unrelated conversation history |
| normalized task intent — redacted and clamped | arbitrary session files |
| explicitly selected file content | hidden system prompts |
| the file path, the file count | credentials of any kind |

The hook opens exactly two paths and no more: the Read target, and `transcript_path` — for
`recentlyEdited` always, and for one newest-prompt field when the flag is on. The builder has no
`node:` import at all, so an intent naming `$GEMINI_API_KEY` is forwarded as the literal text and
cannot expand. `test/task.security.test.mjs` asserts the absence of each category above from a
built prompt.

## 8. The redaction boundary, and what it does not cover

```
task -> content selection -> [ redaction boundary ] -> worker request
```

`lib/dispatch/task.mjs` is that boundary: everything crossing into a worker request crosses there.
Today it applies `redactSecrets()` to **intent text only**, in the order trim → redact → clamp —
redaction before clamping, because clamping first could cut a credential in half and leave a prefix
the redactor no longer recognises, which is still a credential someone has to rotate.

**Outbound file content is still not redacted.** The filename deny list remains the plugin's only
control over what a worker sees. That is unchanged by this phase, it is pinned by the corpus case
`secret-in-plain-filename`, and `test/task.security.test.mjs` asserts it **in both directions**:

- a planted `sk-ant-…` in `taskIntent.objective` is absent from the built prompt;
- the same literal in `files[].content` is **present**.

The second assertion is a disclosure, not a bug report. It exists so that widening the boundary to
content — a later phase, with its own evidence — means coming here and changing a claim
deliberately, and so that narrowing it means a test going red. Neither can happen quietly.

With the flag on, the exposure grows by exactly one item: **one clamped, secret-redacted prompt
string leaves the machine per delegated read.**

## 9. Telemetry

One new field, `task_intent_source` (`none | transcript | other`), nullable and additive, so no
`SCHEMA_VERSION` bump. It sits beside `prompt_version` because the two answer one question
together: which request was made.

**It records the source and never the text.** The task itself travels only through the existing
`question_text`, which is `storeQuestionText: false` by default, clamped to 200 characters and
redacted. So opting in to *using* a prompt is not opting in to *storing* it.

A gate-refusal row reports `null` rather than `none`, because `none` would claim a generic task was
sent and nothing was sent at all.

Phase 2 savings arithmetic, the null semantics and `CALC_VERSION` are untouched.

## 10. Why intent cannot reach routing

This is the part worth being careful about, because `evals.protected.test.mjs` used to record that
the protected-category guarantee was "vacuous, and safe because it is vacuous" — nothing could be
misclassified because nothing was classified — and that it would stop being automatically safe the
moment a transcript heuristic was added. This phase is that commit.

The guarantee is now narrower and no longer vacuous. Four things hold it:

1. **`taskType` is still a literal** in `adapter.mjs`. The recovered prompt is never consulted to
   decide what kind of work this is. There is no classifier.
2. **`decide()`'s input has no field intent could occupy.** `toRoutingInput` builds a fresh 16-key
   object and never spreads its argument, so a hostile payload cannot smuggle one in.
3. **Intent is extracted strictly after the gate has ruled.** The ordering is the enforcement, not
   a convention — pinned as a source-order check and behaviourally, by proving a refusing read
   performs no second transcript read.
4. **Only `Read` is intercepted.**

So a developer who asks Claude to debug something may now have that sentence forwarded to a worker
as the question about a file — that is the feature — but it cannot make the router treat debugging
as delegatable work.

## 11. Measuring it

`npm run evals -- --ab` runs the corpus twice, once per construction, and reports the two side by
side. One variable moves: both passes use the same corpus, routing decision, files, provider, model
and config, and the task sentence itself is identical because a case without a declared
`taskIntent` falls back to its own `task`. Only the requirements block differs.

Each variant is a full independent pass — its own rows, verdicts, metrics and gates — because all
of those key on the bare case id and interleaving two variants would silently keep whichever wrote
last. The `generic` pass takes no event-id suffix, so a default run's `stable.jsonl` stays
byte-identical to the artifact produced before the dimension existed.

**The A/B block computes no delta, ratio or percentage**, and on the deterministic arm it reports
`qualityIsMeasured: false`. The fixture worker keys its canned answer off the case id and not off
the prompt, so both variants receive the identical authored answer and their quality is equal **by
construction**. Authoring a second, better answer for the intent variant would let whoever wrote it
decide which construction wins, which is the one thing a benchmark must not permit. Prompt size and
token counts are real on every arm; quality is only real on a live one:

```bash
npm run evals -- --ab                      # prompt size and plumbing. Offline, keyless.
npm run evals -- --ab --arm ollama         # quality. Model-dependent, not reproducible.
```

Five corpus cases were added for the failure modes the old corpus could not express: a buried fact
in repetitive content, multiple occurrences, a line citation checked against its own neighbours, a
fact among same-shaped distractors, and an entity-extraction case whose near-miss row mentions the
flag in a comment without being a match. Their `expected` blocks are identical to every other
delegating dispatch case — this phase changed what the worker is asked, never what the router
decides, and a new case with a novel expected class would be the first sign that it had.
