# Routing

`lib/routing.mjs` answers one question — should this task stay on the primary model, or be
delegated to a worker mode — and returns a structured decision. It is a pure function. It does not
execute the worker, call a provider, register a hook or write telemetry.

> **The gate fails open.** Every unknown, every refusal and every malformed input returns
> `decision: 'allow'`. A broken router degrades to plain Claude Code, never to a blocked session.

## Two axes, one object

A routing result answers two different questions, and conflating them is how a gate ends up
unable to explain itself:

| field | question | values |
| --- | --- | --- |
| `delegate` | the **policy** answer: should a worker do this work? | `true` \| `false` |
| `decision` | the **enforcement** answer: what does the hook do to *this* tool call? | `allow` \| `deny` \| `ask` \| `suggest` |

`decision` owns the repo's existing gate vocabulary, so it assigns straight to the telemetry
`routing_decision` column with no translation step — and a translation step is a place for two
vocabularies to drift apart. `delegate` is what Phase 4 needs in order to know there is work to
hand over at all.

The two are not redundant. `enforce: 'suggest'` means *delegate-worthy, but do not block*: a hook
that saw only `decision: 'suggest'` could not tell that from "nothing to say", and a hook that saw
only `delegate: true` would not know whether to stop the tool call.

## The decision result

```js
{
  decision: 'allow',                // allow | deny | ask | suggest
  delegate: false,                  // the policy answer
  mode: null,                       // 'bulk-reader' | 'code-writer' | null — null iff delegate is false
  lane: null,                       // 'bulkRead' | 'codeWrite' | null — which config block ruled
  reason: 'below_threshold',        // a reason CODE, never prose
  taskType: 'bulk_read',            // the normalized input task type
  estimatedInputTokens: null,       // number | null — never 0 for unknown
  policyVersion: 1,
  inputWarnings: [],                // sorted, deduplicated codes
}
```

The object and its `inputWarnings` array are frozen, the key order is fixed, and no field is ever
`undefined`. `policyVersion` is stamped so a stored decision can be read against the policy that
produced it.

`decide()` never returns `off`, `delegated` or `not_applicable`, even though those are in the
telemetry `ROUTING_DECISIONS` enum. They describe rows the delegation script writes, not actions a
hook can take; a lane configured `enforce: 'off'` returns `allow` with reason `disabled`, and the
nuance lives in the reason code.

## The input contract

`decide(input, config)` receives facts. It does not gather them — it reads no file, calls no
provider and probes nothing — because a gate runs while the developer waits on a tool call.

**Unknown is spelled `null`, and only `null`**, because `0` is a measured zero. Numeric strings are
not parsed: `'350'` becomes `null` plus a warning. Every comparison in the engine is written
`isKnown(x) && x >= t` rather than `x >= t`, because `null >= 0` is `true` in JavaScript — that one
coercion would let an unmeasured file count satisfy a breadth floor.

| field | type | unknown reads as | why |
| --- | --- | --- | --- |
| `taskType` | enum | `unknown` | never `general`; an unrecognized value is refused, not relabelled |
| `toolName` | `string\|null` | `null` | **advisory only**, never decisive |
| `fileCount` | `int≥0\|null` | `null` | fails the floor *and* the cap |
| `lineCount` | `int≥0\|null` | `null` | fails `minLines` |
| `inputBytes` | `int≥0\|null` | `null` | fails `minBytes` and the worker ceiling check |
| `estimatedInputTokens` | `int≥0\|null` | `null` | fails `minEstimatedTokens`; echoed to the result verbatim |
| `targetedRead` | `bool\|null` | **`true`** | an offset/limit read is intentional; assume it was |
| `fullRead` | `bool\|null` | **`false`** | carried for explainability; **not decisive** today |
| `recentlyEdited` | `bool\|null` | **`true`** | assume Claude needs the exact current bytes |
| `latencySensitive` | `bool\|null` | **`true`** | assume someone is waiting |
| `interactive` | `bool\|null` | **`true`** | same |
| `requestedOutput` | `string\|null` | `null` | lower-cased and trimmed; used only to *exclude* |
| `paths` | `string[]` | `[]` | the corpus the gate can actually prove |
| `projectPath` | `string\|null` | `null` | derives the relative form for glob matching; **never a signal** |
| `workerAvailable` | `bool\|null` | **`false`** | never assume a worker exists |
| `workerUnavailableReason` | `'worker_not_ready'\|'budget_exceeded'\|null` | `worker_not_ready` | the caller knows why; the engine reads no ledger |

Two of these do not appear in the spec's suggested contract and had to be added: `lineCount`,
without which the shipped `minLines` threshold is unenforceable, and `recentlyEdited`, without
which `neverDelegate.onRecentlyEdited` is. `paths` is the third — see
[the deny list](#the-deny-list-is-matched-not-merely-listed).

### Routing input enums are closed, deliberately

`CLAUDE.md` says enums are open on read, and that applies to the telemetry record layer, where
dropping a row over a vocabulary disagreement would lose data. It does **not** apply here. An open
enum on a security input would let a typo'd `architecure` fall straight past the exclusion list, so
an unrecognized `taskType` becomes `unknown` — which the rule table then refuses.

### Warnings, not failures

A malformed field produces a code in `inputWarnings` and the pessimistic value, never an
exception. A hook that throws is a hook that breaks the session. Absence is *not* warned about:
absence is a legitimate "I do not know", and the pessimistic reading is the documented contract.
The codes are `type:<field>`, `unknown_enum:<field>`, `clamped:paths`, `incoherent:read_shape`,
`incoherent:tool_for_task`, `unsupported_glob_syntax` and `invalid_config:<dotted.path>`.

## Task types

Eight categories, of which exactly two can be delegated:

```
bulk_read  code_write  |  debugging  architecture  security  precise_edit  general  unknown
delegatable               never delegated
```

The gate is an **allowlist**, not a denylist: a category added later is refused until someone
deliberately permits it, so the failure mode of forgetting is a refusal rather than a leak.
`general` is absent on purpose — if unclassified work were delegatable, every task the caller could
not label would land in the delegating bucket.

This is **not** the telemetry `task_type` enum. That one is an *event* taxonomy answering "what
kind of row is this", and its value for a gate decision is `gate_block`. The two overlap on the two
delegatable lanes, and a test pins that those spellings still agree.

No classifier runs here. Classification is the caller's job, and an unlabelled task is `unknown`.

## Rule order

First match wins, and each rule is terminal. Every rule but the last returns
`decision: 'allow', delegate: false, mode: null`.

| # | rule | condition | reason |
| --- | --- | --- | --- |
| 1 | policy disabled | `enabled !== true`, or the config is unusable | `disabled` |
| 2a | unknown task | `taskType` is `unknown` | `unknown_input` |
| 2b | excluded task | `taskType` is not in the allowlist | `task_type_excluded` |
| 3 | lane disabled | the lane's `enabled` is false, or `enforce` is `off` | `disabled` |
| 4 | interactive | `interactive` | `interactive` |
| 5 | latency | `latencySensitive` | `latency_sensitive` |
| 6 | precise output | `requestedOutput` is one of the exact-byte shapes | `precise_output_requested` |
| 7 | targeted read | `neverDelegate.onTargetedRead` and `targetedRead` | `targeted_read` |
| 8 | recently edited | `neverDelegate.onRecentlyEdited` and `recentlyEdited` | `recently_edited` |
| 9 | deny glob | a path matches `denyGlobs` and no `allowGlobs` entry rescues it | `deny_glob` |
| 10 | paths unproven | files are claimed but none are named | `unknown_input` |
| 11 | worker unavailable | `workerAvailable !== true` | `worker_not_ready` or `budget_exceeded` |
| 12 | over max files | `fileCount > maxFiles` | `over_max_files` |
| 13 | over max bytes | `inputBytes > worker.maxInputBytes` | `over_max_input_bytes` |
| 14 | below threshold | the thresholds are not met | `below_threshold` |
| 15 | **delegate** | everything above passed | `threshold_met` |

Three principles decide the order, and they are applied in this sequence:

1. **The developer's own off-switch outranks any policy opinion.** Rules 1 and 3 come first, so a
   disabled gate reports `disabled` rather than offering a critique nobody asked for — and so no
   later rule can read a threshold off an object that is not a config.
2. **The reason code names the most fundamental objection.** The safety rules (2–9) precede the
   capability and sizing rules (11–14), so a secret inside a tiny file reports `deny_glob` rather
   than `below_threshold`. This is the whole reason "is the deny list actually doing anything?" is
   an answerable question.
3. **Global unavailability outranks per-request sizing.** Rule 11 precedes 12–14, so a keyless
   install reports `worker_not_ready` on every read — which is `scripts/doctor.mjs`'s most common
   diagnosis — instead of a misleading `below_threshold`.

Rule 10 sits with rule 9 because it is that rule's "I could not run" case: if the paths are not
known, the corpus cannot be proven free of secrets, and unknown is never favorable.

## Thresholds

```
sizeSatisfied    = lineCount  >= minLines            (when known)
                OR inputBytes >= minBytes            (when known)
                OR estimatedInputTokens >= minEstimatedTokens   (when both known)

breadthSatisfied = fileCount >= minFiles             (when known)
capRespected     = fileCount <= maxFiles             (when known)

thresholdMet     = sizeSatisfied AND breadthSatisfied AND capRespected
```

**OR across the proxies, AND across the categories.** `minLines`, `minBytes` and
`minEstimatedTokens` are three proxies for one quantity — *is this payload big enough that a worker
hop pays for itself* — so any one of them answering yes is enough. AND would be more conservative
in isolation, but combined with "unknown never satisfies" it would hand control to whichever proxy
is least often measured: a `Grep` across ten files has no line count, and AND would turn that into
a permanent refusal. OR is the only semantics under which adding a proxy widens coverage instead of
silently narrowing it.

`minFiles` (is this a multi-file question), `maxFiles` (a safety cap) and the size question are
different quantities rather than proxies for one, so they AND. An unknown `fileCount` fails the
floor **and** the cap — unknown is not favorable in either direction.

| key | default | notes |
| --- | --- | --- |
| `routing.bulkRead.minLines` | `350` | `CMR_MIN_LINES` |
| `routing.bulkRead.minBytes` | `12000` | `CMR_MIN_BYTES` |
| `routing.bulkRead.minEstimatedTokens` | `null` | `CMR_MIN_ESTIMATED_TOKENS`. `null` means the proxy is off |
| `routing.bulkRead.minFiles` | `1` | `CMR_MIN_FILES`. A no-op at 1; raising it only narrows |
| `routing.bulkRead.maxFiles` | `25` | `CMR_MAX_FILES` |
| `worker.maxInputBytes` | `2000000` | the ceiling rule 13 enforces |

`minEstimatedTokens` defaults to `null`, **not `0`**. As an OR member, `0` would satisfy for any
known token count at all — a loosening of a shipped threshold, which the sixth non-negotiable in
`CLAUDE.md` requires a negative eval for. The SPEC minimum of `1` means nobody can configure that
loosening either.

The `codeWrite` lane has **no** size thresholds, because a hook cannot measure code that has not
been written yet. Its advisory `enforce: 'suggest'` default is what makes having no size check
safe; a lane that blocked would need thresholds first.

## The deny list is matched, not merely listed

`routing.denyGlobs` is a security control, so `lib/globs.mjs` matches it rather than documenting it.
The matcher supports `**` (zero or more whole segments), `*` and `?` (neither crosses a separator),
and nothing else.

- **Matching is case-insensitive**, because NTFS and APFS are. A case-sensitive matcher would let
  `.ENV` through on the platform where it is literally the same file.
- A leading `**` matches **zero or more** segments, so the dotenv pattern catches a root-level
  `.env` as well as `a/b/.env`. The one-or-more reading would leave the most obvious secret in the
  repo unprotected by the most obvious pattern for it.
- Paths are normalized to one spelling — forward slashes, lower case, no trailing separator — so a
  Windows separator cannot evade a forward-slash pattern.
- Each path is offered in two spellings, as given and relative to `projectPath`, so `src/**` works
  without a leading `**` segment.
- **Braces, character classes and negation are not supported, loudly.** A pattern like
  `**/*.{pem,key}` is one a reasonable person writes; silently matching nothing would be a safety
  hole with no symptom. Such a pattern is matched literally *and* reported as
  `unsupported_glob_syntax`.

Matching is all-or-nothing: one sensitive path refuses the whole corpus. `decide()` answers one
question about one tool call, and per-file filtering of a corpus belongs to the payload builder.

## Fail-safe behaviour

| situation | outcome |
| --- | --- |
| unknown task type | `allow` / `unknown_input` |
| unknown payload size | `allow` / `below_threshold` |
| worker unavailable or unconfigured | `allow` / `worker_not_ready` |
| budget spent (as labelled by the caller) | `allow` / `budget_exceeded` |
| sensitive path | `allow` / `deny_glob` |
| invalid or malformed configuration | `allow` / `disabled` + `invalid_config:<leaf>` |
| missing required input | `allow`, by whichever rule the missing fact fails first |
| ambiguous classification | `allow` / `unknown_input` |

`readPolicy()` deliberately supplies no missing default. Everything that reaches the rule table has
already been through `resolveConfig()`, so a leaf that is absent or wrong-typed means the caller
handed the engine something that never was a config. Guessing a threshold there would be worse than
refusing: the snapshot is marked unusable and the gate stops at `disabled`, naming the offending
leaf.

## Determinism

The same facts and the same configuration always produce the same decision. There is no clock, no
randomness, no network, no filesystem and no provider in the routing layer, and a test in
[`test/telemetry.isolation.test.mjs`](../test/telemetry.isolation.test.mjs) asserts all of that
statically against the source — `routing.mjs`, `routing-policy.mjs` and `globs.mjs` may import no
`node:` builtin and may not reference `Date`, `Math.random`, `process`, `fetch` or `performance`.
Worker availability is an explicit input precisely so that readiness probing stays outside.

Key insertion order does not affect a decision, and the result key order is fixed, so a serialized
decision is byte-stable.

## Examples

```js
import { decide } from './lib/routing.mjs'
import { loadConfig } from './lib/config.mjs'

const { config } = loadConfig()

const bulk = {
  taskType: 'bulk_read', toolName: 'Read', fileCount: 4, lineCount: 900, inputBytes: 40000,
  estimatedInputTokens: 10000, targetedRead: false, fullRead: true, recentlyEdited: false,
  latencySensitive: false, interactive: false, requestedOutput: 'summary',
  paths: ['/proj/src/a.ts', '/proj/src/b.ts', '/proj/src/c.ts', '/proj/src/d.ts'],
  projectPath: '/proj', workerAvailable: true, workerUnavailableReason: null,
}

// Four large files, worker ready -> block the read and steer to the bulk-reader.
decide(bulk, config)
// -> { decision: 'deny', delegate: true, mode: 'bulk-reader', lane: 'bulkRead',
//      reason: 'threshold_met', estimatedInputTokens: 10000, policyVersion: 1, ... }

// One small file -> nothing to gain.
decide({ ...bulk, fileCount: 1, lineCount: 40, inputBytes: 900, estimatedInputTokens: 200,
         paths: ['/proj/src/a.ts'] }, config)
// -> { decision: 'allow', delegate: false, reason: 'below_threshold', ... }

// A secret in the corpus -> refused, whatever its size.
decide({ ...bulk, fileCount: 1, paths: ['/proj/.env'] }, config)
// -> { decision: 'allow', delegate: false, reason: 'deny_glob', ... }

// Nothing was said about the worker -> silence is not readiness.
decide({ ...bulk, workerAvailable: undefined }, config)
// -> { decision: 'allow', delegate: false, reason: 'worker_not_ready', ... }
```

## Telemetry

The routing engine emits nothing. It is not coupled to the sink, and the telemetry layer is
forbidden from importing it. The result maps onto the event fields by assignment:

| result field | event field |
| --- | --- |
| `decision` | `routing_decision` |
| `reason` | `routing_reason` |
| `estimatedInputTokens` | `estimated_input_tokens` |
| `inputWarnings` | fold into `validation_codes` |
| `policyVersion` | no field yet — see below |

Phase 3 added six values to `ROUTING_REASONS` in `lib/telemetry/record.mjs`
(`task_type_excluded`, `interactive`, `latency_sensitive`, `unknown_input`,
`precise_output_requested`, `over_max_input_bytes`). The addition is additive: readers bucket an
unknown value as `other`, so an older dashboard still ingests the rows, and `SCHEMA_VERSION` does
not change. A routing-local reason vocabulary was the alternative, and it would have stamped
`unknown_enum:routing_reason` on *every* gate row, poisoning the one signal the store has for
"something is actually wrong".

`routing_policy_version` **is** a column as of the hook integration, exactly as anticipated here:
additive and nullable, so `SCHEMA_VERSION` did not change. `prompt_version` landed alongside it for
the same reason. The hook also folds `inputWarnings` into `validation_codes` through
`buildEvent`'s `extraValidationCodes`.

## Note on `CLAUDE_ROUTER_TELEMETRY`

`CLAUDE_ROUTER_TELEMETRY=0` silences telemetry for one session; `CMR_ENABLED=0` stops routing. It is
documented in the [README](../README.md#privacy) and is deliberately **not** a `SPEC` entry: adding
it would make the single read in `lib/telemetry/index.mjs` violate the rule that a setting with a
`SPEC` entry is never read from `process.env` directly. It is a sanctioned session kill switch with
exactly one reader, and a test in `test/telemetry.isolation.test.mjs` pins that there is only one.
The routing layer does not read it, or any environment variable at all.

## Context capability is not a routing input

A model's context window is knowable three ways and the gate can use none of them:

- **measured** needs a network call, which `decide()` never makes;
- **a bundled table** needs the resolved model, i.e. importing `lib/dispatch` -> `lib/providers`
  into the gate, which would put a provider module behind every tool call;
- **configured** the gate already reads, in the only unit it has: `policy.workerMaxInputBytes`
  compared against raw `inputBytes`, under reason `over_max_input_bytes`.

So: **the gate enforces what config can express in bytes; `dispatch()` enforces what
capability can express in tokens.** `decide()`'s sixteen-field input, `DECIDE_REASONS`,
`readPolicy()`'s output and `WORKER_UNAVAILABLE_REASONS` gained nothing in phase 8.

The tempting seam — reporting `worker_not_ready` for a file too big for the model — is
rejected deliberately: it would report a GLOBAL condition for a PER-FILE fact, and make every
small read in the session look like a broken worker.

`test/routing.capability.test.mjs` asserts this absence. It exists because nothing in the code
says so on its own, and a future reader with a plausible optimisation would otherwise find no
obstacle.
