# What we do not delegate

A cheap worker model is good at moving bytes and bad at deciding what they mean. This document is
the list of things that therefore never leave the primary model, and the list is enforced rather
than merely published.

> **Never delegate reasoning.** Debugging, architecture, security, precise edits and small files
> stay with Claude.

## The refusal list is code, not prose

Each row below is a branch of `decide()` in [`lib/routing.mjs`](../plugins/model-router/lib/routing.mjs)
with a test named after it. A refusal always returns `decision: 'allow'` — the tool call proceeds
untouched and Claude does the work itself.

| what | how it is recognized | reason code | pinned by |
| --- | --- | --- | --- |
| Debugging | `taskType: 'debugging'` | `task_type_excluded` | `routing.exclusions.test.mjs` |
| Architecture decisions | `taskType: 'architecture'` | `task_type_excluded` | `routing.exclusions.test.mjs` |
| Security-sensitive work | `taskType: 'security'` | `task_type_excluded` | `routing.exclusions.test.mjs` |
| Precise or targeted edits | `taskType: 'precise_edit'` | `task_type_excluded` | `routing.exclusions.test.mjs` |
| Unclassified work | `taskType: 'general'` | `task_type_excluded` | `routing.exclusions.test.mjs` |
| Ambiguous work | `taskType` absent or unrecognized | `unknown_input` | `routing.exclusions.test.mjs` |
| An exact-bytes request | `requestedOutput` is `edit`, `patch`, `diff`, `inline_edit` or `exact` | `precise_output_requested` | `routing.exclusions.test.mjs` |
| A targeted read | `targetedRead` and `neverDelegate.onTargetedRead` | `targeted_read` | `routing.exclusions.test.mjs` |
| A file edited this session | `recentlyEdited` and `neverDelegate.onRecentlyEdited` | `recently_edited` | `routing.exclusions.test.mjs` |
| An interactive turn | `interactive` | `interactive` | `routing.exclusions.test.mjs` |
| A latency-sensitive turn | `latencySensitive` | `latency_sensitive` | `routing.exclusions.test.mjs` |
| A small payload | no size proxy meets its threshold | `below_threshold` | `routing.thresholds.test.mjs` |
| A corpus with a secret in it | a path matches `routing.denyGlobs` | `deny_glob` | `routing.exclusions.test.mjs` |
| A corpus nobody named | `fileCount >= 1` with an empty `paths` | `unknown_input` | `routing.exclusions.test.mjs` |
| A payload too big for the worker | `inputBytes > worker.maxInputBytes` | `over_max_input_bytes` | `routing.thresholds.test.mjs` |
| Too many files to be one question | `fileCount > routing.bulkRead.maxFiles` | `over_max_files` | `routing.thresholds.test.mjs` |

Exactly two kinds of work are delegatable — a bulk read and a code write — and the check is an
**allowlist**. A category added to the taxonomy later is refused until someone deliberately permits
it, so the failure mode of forgetting is a refusal rather than a leak.

## Unknown is never a reason to delegate

Missing information is not permission. Every field has a reading for "we were not told", and in
every case it is the reading that cannot cause harm.

| field | unknown reads as | consequence |
| --- | --- | --- |
| `taskType` | `unknown` | refused outright, never relabelled as `general` |
| `fileCount` | `null` | fails the `minFiles` floor **and** the `maxFiles` cap |
| `lineCount` / `inputBytes` / `estimatedInputTokens` | `null` | the proxy does not satisfy |
| `targetedRead` | `true` | assume the read was intentional |
| `recentlyEdited` | `true` | assume Claude needs the exact current bytes |
| `latencySensitive` | `true` | assume someone is waiting |
| `interactive` | `true` | assume someone is waiting |
| `workerAvailable` | `false` | silence is not readiness |
| `paths` | `[]` | an unnamed corpus cannot be proven clean |
| configuration | unusable | the gate stops at `disabled` rather than guessing a threshold |

The sharpest trap here is a language one: **`null >= 0` is `true` in JavaScript**, because `null`
coerces to `0` in a relational comparison. Every threshold comparison in the engine is therefore
written `isKnown(x) && x >= t`. A test asserts it, and it fails if an `isKnown()` guard is ever
dropped.

A measured `0` and an unmeasured quantity are never the same thing. `estimatedInputTokens` comes
back as `null` when it was not measured and `0` when it was.

## The deny list is matched, not merely listed

Nine patterns ship on by default, and `lib/globs.mjs` matches them on every delegatable read:

```
**/.env*        **/*secret*     **/*credential*
**/*.pem        **/*.key        **/id_rsa*
**/.git/**      **/auth/**      **/security/**
```

Matching is **case-insensitive** (NTFS and APFS are, so a case-sensitive matcher would let `.ENV`
through on the platform where it is the same file), a leading `**` matches **zero or more**
segments (so the dotenv pattern catches a root-level `.env`), and separators are normalized (so a
Windows path cannot evade a forward-slash pattern).

One sensitive path refuses the **whole corpus**. Partial delegation would mean a partial answer
with no warning attached to it.

Braces, character classes and negation are not supported, and a pattern using them is reported as
`unsupported_glob_syntax` rather than silently matching nothing — someone writing
`**/*.{pem,key}` would otherwise get no protection and no signal. Write the patterns out
separately instead.

`routing.allowGlobs` rescues a specific path the category patterns caught. It is empty by default;
nothing is pre-rescued.

## The rule order, and why the reason code is what it is

The reason is a **code, never prose**, because prose cannot be grouped and the question the
dashboard has to answer is "why did routing decline 400 times". Codes only help if the same
situation always produces the same one, so the rule order is fixed and the first matching rule owns
the reason. The full ordered table is in [`docs/routing.md`](routing.md#rule-order); the principles
are:

1. **The developer's own off-switch outranks any policy opinion.** A disabled gate reports
   `disabled`, not a critique of the task.
2. **The reason names the most fundamental objection.** Safety rules precede sizing rules, so a
   secret inside a tiny file reports `deny_glob` rather than `below_threshold`. Otherwise nobody
   can tell whether the deny list is doing anything.
3. **Global unavailability outranks per-request sizing.** A keyless install reports
   `worker_not_ready` on every read instead of a misleading `below_threshold`.

A precedence matrix in `routing.contract.test.mjs` asserts this pairwise.

## Code writes are advised, never forced

`routing.codeWrite` is enabled by default but enforces only `suggest`. The lane never blocks a tool
call and nothing leaves the machine on its own: a suggestion is printed, and content moves only if
Claude then chooses to invoke the skill — which is a reasoning step by the primary model, not a
gate decision.

That advisory default is also what makes the lane's *absence* of size thresholds safe. A hook
cannot know a `Write` is boilerplate before the code exists, so there is nothing to measure; a lane
that blocked would need thresholds first.

A sharp edge worth stating: `routing.codeWrite.enforce: 'deny'` is a legal configuration and will
block every `Write` in the project. The schema permits it and the engine respects it. If you set
it, you meant it.

## Changing any of this requires a negative eval

> Changing a threshold or glob default requires a negative eval proving the system still refuses to
> delegate those.

[`test/routing.exclusions.test.mjs`](../test/routing.exclusions.test.mjs) **is** that eval. Every
test in it starts from a baseline that does delegate and flips exactly one field, so a failure
names the rule that stopped working. If a change to `config.mjs` makes one of those tests delegate,
or pass for a different reason, the change is wrong — not the test.

Two companions guard the same ground: `routing.policy.test.mjs` pins the five shipped bulk-read
defaults and the nine shipped deny globs byte for byte, and `routing.thresholds.test.mjs` asserts
that raising a threshold can only narrow delegation.

## Known discrepancies

**`minFiles` defaults to `1`, which is not the "3+ files" an earlier draft of this document
described.** No delegation-steering skill ships, so there is no second layer advertising a
different trigger — there is only the gate's floor, and a single large file is worth delegating on
its own. Set `routing.bulkRead.minFiles: 3` if you want more than one file required.

**`minLines` is unreachable from the hook.** Counting lines needs the file's bytes, and reading a
file to decide whether reading it is worth avoiding defeats the purpose, so the hook leaves
`lineCount` as `null` and the size question is answered by `minBytes` alone. A 400-line file under
12 000 bytes therefore stays with Claude. That is a refusal, so the failure mode is a missed
saving rather than an unwanted delegation. See
[hook-integration.md](hook-integration.md#why-no-line-count).

**Two facts are asserted rather than measured.** The hook supplies `interactive: false` and
`latencySensitive: false`, because a PreToolUse payload carries no session posture and both fields
refuse when unknown — so an "honest unknown" hook could never delegate at all. Those are the only
asserted inputs in the plugin, and the off-switches live elsewhere (`hooks.enabled`,
`routing.bulkRead.enforce`, `CMR_ENABLED`). `recentlyEdited` is genuinely measured, from the
session transcript, because it guards content rather than describing posture.

## Task intent does not change what we refuse

The hook can now forward the developer's newest prompt to the worker as the question, when
`hooks.taskIntent.source` is set to `transcript`. It is `none` by default.

**This changes what the worker is asked and never what the router decides.** `decide()`'s 16-field
input gained nothing; `hook/adapter.mjs` still assigns `taskType: 'bulk_read'` as a literal; no
threshold, reason, glob or enforcement moved. There is no classifier, and the recovered prompt is
never consulted to decide what kind of work a request is.

The enforcement is **call order**: intent is extracted strictly after the gate has ruled, so no
prompt text is in scope while the decision is being made, and a refused read never assembles any.
That is pinned as a source-order check and behaviourally, in
[`evals.protected.test.mjs`](../test/evals.protected.test.mjs), whose header records why the
protected-category guarantee is narrower than it was and why it is no longer vacuous.

So a developer who asks Claude to debug something may have that sentence forwarded as the question
about a file — that is the feature — but it cannot make the router treat debugging as delegatable
work. The refusal table above is unchanged.

**What did change is exposure, and only in one way.** With the flag on, one clamped,
secret-redacted prompt string leaves the machine per delegated read. File content is still not
redacted outbound; the filename deny list remains the only control over that. See
[worker-task-construction.md](worker-task-construction.md).
