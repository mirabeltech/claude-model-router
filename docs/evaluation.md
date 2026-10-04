# Evaluation

`test/evals/` answers one question — did the router do what it was supposed to, and what did that
cost — over a fixed corpus of synthetic cases. It changes no routing rule, no worker prompt, no
provider and no hook. It selects no threshold. It is the evidence layer, and nothing else.

> **A benchmark result never changes production policy.** Measuring and deciding are separate acts.
> This framework performs the first and deliberately exports no notion of "better", because a
> number that arrives with a recommendation attached is a number nobody re-examines.

For how the figures are computed and what they are worth, see
[`benchmark-methodology.md`](benchmark-methodology.md). For the savings math itself, which this
framework reuses rather than reimplements, see [`savings-methodology.md`](savings-methodology.md).

## Running it

```bash
npm run evals              # deterministic: offline, keyless, reproducible. This one gates.
npm run evals:sweep        # the same run, plus the threshold sweep
npm run evals:build        # regenerate the corpus after editing the manifest
npm test                   # the framework's own tests, including the negative eval
```

The default arm is the `mock` provider behind an injected `fetchImpl` — no socket, no port, no API
key, no network egress. `--arm ollama` runs a real local model instead and the report labels every
number model-dependent. `--priced` substitutes an obviously-synthetic rate table, because the
shipped one prices nothing.

| flag | effect |
| --- | --- |
| `--arm mock\|ollama` | which worker. `mock` is deterministic; `ollama` is not |
| `--sweep` | add the threshold sweep |
| `--priced` | use the `eval-fixture.1` rate table so the money path computes |
| `--case <id>` | run one case |
| `--json <dir>` | write `rows.jsonl`, `stable.jsonl`, `report.json`, `timings.json` |
| `--seed <text>` | the run seed, which event ids derive from |
| `--quiet`, `--no-color` | for CI logs |

Exit code is 1 if any case disagreed with its expectation or any non-advisory gate failed.
Advisories never affect it.

## The case format

One directory per case under [`test/fixtures/evals/`](../test/fixtures/evals/README.md), holding a
`case.json`, any committed fixtures under `files/`, and a canned `answers/default.md` for a dispatch
case. `schemaVersion` is `1`; a mismatch rejects rather than warns, because every rule below is
version 1's rule.

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | lowercase kebab-case, 3–64 chars, and **equal to the directory name** |
| `caseVersion` | yes | bumped when the fixtures or criteria change |
| `category` | yes | descriptive. OPEN enum: an unknown value is preserved and bucketed `other` |
| `shapes` | yes | which content shapes this case covers. OPEN enum, and the coverage check reads it |
| `title` | yes | one sentence, which becomes the report row |
| `rationale` | yes | **why the expectation holds, naming the rule in the refusal order that owns it** |
| `harness` | yes | `decide` \| `hook` \| `dispatch`. CLOSED |
| `task` | dispatch only | the question. **Rejected on a hook case** — see below |
| `files` | yes | the fixtures. May be empty only for a `decide` case |
| `routingInput` | no | overrides merged over the derived input. Keys CLOSED against the sixteen `decide()` fields |
| `config` | no | a config layer for this case, e.g. a tightened cap |
| `expected` | yes | the outcome. Every field CLOSED |
| `qualityCriteria` | dispatch only | **rejected when `expected.class` is `primary`** |
| `safety` | no | `plantedSecret`, `allowedEntities`, `denyGlobIntent`, `knownExposure` |
| `metadata` | no | free-form, and no assertion reads it |

A `files[]` entry declares `path`, `source`, `bytes`, `lines`, optionally `sha256`, `role`, and —
for a generated file — `generator: {unit, repeat}`.

### Enum openness is asymmetric, and that is the point

`category`, `shapes` and `files[].role` are **open**: an unknown value is preserved verbatim and
bucketed as `other`, per the house rule. Every field inside `expected` is **closed and rejects**.

> **An open enum on an expectation makes the expectation unfalsifiable.** `reason: 'thresold_met'`
> bucketing quietly to `other` turns a typo into a case that can never fail, and a corpus of cases
> that cannot fail is worse than no corpus.

[`routing-policy.mjs`](../plugins/model-router/lib/routing-policy.mjs) makes the same call for the
same reason. Every closed list is imported from the engine, never re-typed, so a reason added to
`DECIDE_REASONS` is accepted by the loader in the same commit.

### `class` and `reason` must agree

`expected.class` is redundant with `expected.reason` on purpose: `class` is the half a reviewer
reads. `threshold_met` is the only delegating reason the engine has — `routing.mjs` contains exactly
one `delegate: true` — so a case whose two halves disagree is **unloadable** rather than merely
wrong. That cross-check is what stops a skim from landing on the wrong side of the gate.

### What a hook case may not claim

[`hook/run.mjs`](../plugins/model-router/lib/hook/run.mjs) sends exactly one file and the frozen
`BULK_READ_TASK` literal: a `PreToolUse` payload says *which* file, never *why*. So a per-case
`task` is rejected on a hook case, and a multi-file case is reachable only at the dispatch layer.
Pinned by [`evals.protected.test.mjs`](../test/evals.protected.test.mjs).

### Why `generated` is the default fixture source

`core.autocrlf` is effectively true on Windows and this repo ships no `.gitattributes`, so **the
byte length of a committed text file is not a checkout-invariant property.** A generated fixture is
materialised at load time from a `{unit, repeat}` pair with an explicit LF join, so git never sees
the bytes and git cannot rewrite them. The four fixtures whose structure cannot be expressed as a
repeated unit — a planted fact among decoys, bundled noise, a planted secret — are committed, and
the loader LF-normalises them **before** measuring. That is a mitigation, not a cure.

## The corpus

26 cases. The table and the fingerprint in
[`test/fixtures/evals/README.md`](../test/fixtures/evals/README.md) are generated by
`npm run evals:build` and asserted against the disk, so neither can drift.

| group | what it covers |
| --- | --- |
| size boundary | 11999 / 12000 / 12001 bytes around `minBytes`, a 53-byte file, and the `lines-350` pair |
| live refusal rules | `targeted_read`, `recently_edited`, a missing transcript, `worker_not_ready`, `over_max_files`, `over_max_input_bytes`, `unknown_input`, `precise_output_requested`, a misspelled task type |
| content shapes | three modules, 300 near-identical handlers with one deprecated, bundled noise, a fact buried at line 700 of 900, a 50 KB file |
| security | a planted non-credential behind an innocuous filename |

Sizes are chosen around the one live size rule. The brief's 1/4/8 KB sweep points are dropped
because **no rule sits between them** — they would produce identical rows and imply a resolution the
measurement does not have. 11999, 12000 and 12001 are where the gate is actually sensitive, because
`minBytes` is compared with `>=`.

### The most valuable case is a pair

`lines-350-decide-delegates` and `lines-350-hook-refuses` share one 10 500-byte, 350-line file. The
decide layer delegates it, satisfying the size floor on `minLines`. The hook refuses it, because
`adapter.mjs` leaves `lineCount` null by design and so only `minBytes` decides.
[`what-we-do-not-delegate.md`](what-we-do-not-delegate.md) states that discrepancy in prose; this
pair is the only thing that **measures** it.

### Two shapes the brief asks for, and why they are absent

`debugging_request` and `architecture_request` are deliberately not content shapes. A content shape
is a property of bytes on disk, and "debugging" is not one — it is a `taskType`, and **no shipped
code path emits it**: `hook/adapter.mjs` hardcodes `taskType: 'bulk_read'`. A case asserting "a
debugging request stays primary" would assert that a string is absent from a two-element array,
reached before any path, byte or glob is read, with its own `files/` never opened — which
[`routing.exclusions.test.mjs`](../test/routing.exclusions.test.mjs) already does, better.

That ground is covered by the cross-product instead. See the negative eval below.

### A case must not pass on its own layout

`**/security/**` and `**/auth/**` match **any** path segment, case-insensitively, including a case
directory's own name. A case directory called `security/` would make every file inside it
deny-globbed on the *directory*, so the case would refuse for a reason unrelated to what it claims
to test. The loader's `accidental_deny_glob` check refuses that unless `expected.reason` is
`deny_glob` and `safety.denyGlobIntent` names the pattern. It is the highest-value rule in the
loader.

## Quality criteria

Seven deterministic kinds. `pass` is the only field a gate reads; `score` is reported and **never
thresholded**, because a tunable cutoff is a routing decision wearing a measurement's hat.

| kind | mechanism | honest limit |
| --- | --- | --- |
| `requiredTerms` | case-insensitive substring | tests vocabulary, not understanding |
| `forbiddenTerms` | the same, negated | must be phrases; under four characters needs `allowShort` |
| `requiredEntities` | present in the answer **and** verifiable in the corpus | identifier-shaped strings only |
| `fileReferences` | each declared basename appears | an answer citing everything passes; pair with `counts` |
| `counts` | `{term, min, max}` | always a range — an exact count is brittle to phrasing |
| `exactFacts` | `{literal, mustAppearInFiles}` | catches a fabricated **value**, never a relation |
| `lineCitations` | the right line cited, no declared decoy cited | the single most common worker failure |

`structuredOutput` is **dropped**: `BULK_READER_SYSTEM` asks for prose, so no shipped prompt
produces JSON, and an evaluator with no case is dead code that reads as coverage. `lineCitations` is
**added**, because `BULK_READ_TASK` asks for "every significant declaration with the line it is on".
The brief's `no_missing_required_information` is **merged away**: its only deterministic form is
"these facts I planted are present", which is `requiredEntities` plus `exactFacts` under a name that
promises more than it delivers.

### Null is not false

This is CLAUDE.md #5 applied to quality.

| verdict | means |
| --- | --- |
| `null`, `no_criteria` | the case declared nothing to measure |
| `null`, `no_output` | no answer existed — the case refused, or the worker failed |
| `false`, `empty_output` | the worker returned `''`, which is a **measured** empty answer |
| `false`, `evaluated` | asked, and answered wrongly |

A worker crash is an **availability** fact, not a quality fact, and grading it as a failure
conflates two problems with two different fixes. The pass rate's denominator is therefore **graded**,
not total, and the total travels beside it: `6/6 passed (100%), 15 of 21 ungraded`. A single rate
that silently dropped the nulls is how a 21-case corpus with five answers reports "100% quality".

### What the criteria actually measure

> **The corpus measures accuracy on planted facts, and vocabulary everywhere else.**

A planted fact with four decoys is a question whose right answer is known in advance, and that is
the only accuracy a deterministic evaluator can establish. Everywhere else these kinds check whether
the answer uses the corpus's own names. Nothing here reads a summary for truth.

### No LLM judge

There is none, and the omission is deliberate. Semantic accuracy — "is this summary correct", "did
it miss something that matters" — is what a judge would be for, and it is exactly what the gates
below cannot establish either. If one is ever introduced it must be marked **nondeterministic**,
**supplementary**, **never a source of truth**, and it must **never gate CI or change a routing
rule**. A judge whose verdict could move a threshold would make the router's policy a function of a
model's mood.

## Safety gates

Nine, of which two are advisory. A failure always names its case; there is no aggregate that could
hide one. `not_applicable` is a real third status, because a gate with nothing to measure on a
refusing case must say so rather than inflating the pass count.

| gate | what it measures |
| --- | --- |
| `no_secret_leakage_stored` | the planted literal reaches no row, no stdout, no answer, no verdict |
| `no_secret_leakage_outbound` | the exposure is **accounted for**: a deny glob matched, or the case declares it |
| `no_routing_of_protected_categories` | the cross-product below |
| `no_fabricated_file_content` | every quoted span of 24+ chars appears verbatim in the corpus |
| `corpus_unmodified_by_the_run` | the fixtures are byte-identical before and after |
| `no_shell_on_the_delegation_path` | no module imports `child_process`, `vm` or `worker_threads` |
| `no_write_capability_on_the_delegation_path` | filesystem access is confined to `hook/facts.mjs`, `hook/intent.mjs` and `hook/run.mjs` |
| `no_invented_entities` | **advisory** |
| `no_claimed_side_effects` | **advisory** |

Every `evidence` string passes through the shipped `redactSecrets()`, because a gate reporting a
leak must not become the leak.

### Two of the brief's gates are replaced, not performed

`no_file_modification` and `no_shell_execution`, as literally stated, cannot fail. The worker is an
HTTP completion endpoint: it receives `{system, prompt}` and returns text, with no tools, no
filesystem handle and no shell. Asking whether a returned string mutated the disk is a check with no
failure mode, and a green check that cannot go red is worse than none.

What is checkable is a **static capability assertion** on the delegation path — the mechanism
[`telemetry.isolation.test.mjs`](../test/telemetry.isolation.test.mjs) already establishes, and one
that fails the day someone adds `execFile` to a provider — and a **scratch-directory mutation
witness**. The witness does not constrain the worker, which cannot write anywhere. It catches the
*harness or the hook* mutating a fixture, which is a real risk since `hook/facts.mjs` opens
descriptors on these files. Hence the name `corpus_unmodified_by_the_run`: the name is the whole
difference between a check and a claim.

### The outbound secret gate pins a real exposure

**Nothing in the plugin redacts outbound file CONTENT.** `redactSecrets()` is applied to error
strings, telemetry columns and — since Phase 7 — task-intent text; `hook/run.mjs` hands raw
content to `dispatch()` and `modes.mjs` concatenates it into the prompt unmodified, and the
worker's answer re-enters Claude's context through `additionalContext` equally unredacted. **For
file content, the filename deny list is the only control that exists.**

Phase 7 added a redaction BOUNDARY — `lib/dispatch/task.mjs`, the one seam everything crossing
into a worker request passes through — and applied it to intent text alone. That makes widening it
to content a local change rather than an audit; it does not widen it.
`test/task.security.test.mjs` asserts both halves as a pair: a planted literal in
`taskIntent.objective` is absent from the built prompt, and the same literal in `files[].content`
is **present**.

So `secret-in-plain-filename` plants a non-credential behind an innocuous name, expects it to
**delegate**, and declares `safety.knownExposure`. The gate then goes red in two useful directions:
if someone adds a secret-bearing fixture without thinking about it, and if the filename deny list is
ever weakened. Fixing the exposure would mean changing the dispatch path, which this phase does not
do.

### `no_invented_entities` is advisory and can never be promoted

The mechanism is a corpus lexicon, then code-position tokens from the answer only, minus a common
lexicon and the case's `allowedEntities`.

**False positives are common**: legitimate composition (`resolveWorkerConfig` describing
`resolveWorker` plus `deriveConfig`), prose casing drift, pluralisation, a type name stemmed
differently. **The false negative is structural and matters more**: it cannot catch recombination of
real tokens into a false claim. "`decide()` calls `resolveWorker()`" has every token in the lexicon
and is false. So is a wrong line number, a wrong argument order, or a confident "this file does not
handle X" when it does. [`evals.gates.test.mjs`](../test/evals.gates.test.mjs) asserts that
limitation rather than leaving it implied.

`no_fabricated_file_content` is gated instead, because it is high-precision and low-recall — a
quoted literal either is in the corpus or is not — which is the right trade for something that can
fail a build. Two normalisations are documented, because an undocumented normalisation is a silent
weakening: whitespace runs collapse on both sides, and a span is split at an elision with each
24-character fragment checked separately.

## The negative eval

CLAUDE.md #6 requires that changing a threshold or a glob default be accompanied by proof the system
still refuses to delegate reasoning work.
[`routing.exclusions.test.mjs`](../test/routing.exclusions.test.mjs) discharges that for one
baseline input. [`evals.protected.test.mjs`](../test/evals.protected.test.mjs) discharges it for
**every input in the corpus** — every size, shape, path set and config override, including the nine
that do delegate — crossed with every task type outside the allowlist. 26 × 6 = 156 assertions.

Starting from inputs that delegate is what makes it falsifiable: a case that already refuses on size
would pass trivially. The claim is that **no content shape, payload size or path set can rescue a
protected task type.**

### The part that changed in Phase 7

This section used to read:

> **The protected-category guarantee is currently vacuous, and safe because it is vacuous.**

— because nothing could be *mis*classified when nothing was classified at all. It also said that
the moment anyone added a transcript heuristic, the guarantee would stop being vacuous and stop
being automatically safe in the same commit.

**Phase 7 is that commit.** The hook now reads the developer's newest prompt out of the session
transcript — when, and only when, `hooks.taskIntent.source` says to — and forwards it to the
worker as the question. Prompt text exists inside the hook, so "could that text change a routing
decision" is a real question for the first time.

> **The guarantee is narrower now, and it is no longer vacuous.**

Four things hold it, and all four are asserted:

1. `hook/adapter.mjs` still assigns `taskType` as a **literal**. The recovered prompt is never
   consulted to decide what kind of work this is. There is still no classifier, and no shipped path
   emits `debugging`, `architecture`, `security` or `precise_edit`.
2. `decide()`'s input has **no field intent could occupy** — `toRoutingInput` builds a fresh
   16-key object and never spreads its argument, so a hostile payload cannot smuggle one in.
3. Intent is extracted strictly **after** the gate has ruled. The ordering is the enforcement, not
   a convention, and it is pinned twice: as a source-order check on `run.mjs`, and behaviourally by
   proving a refusing read performs no second transcript read.
4. The hook still intercepts **only `Read`**.

So a developer who asks Claude to debug something may now have that sentence forwarded to a worker
as the question about a file — that is the feature — but it cannot make the router treat
debugging as delegatable work. In production exactly four refusal rules remain reachable:
`deny_glob`, `targeted_read`, `recently_edited` and `below_threshold`.

### The A/B dimension, and what it may not say

`--ab` runs the corpus once per worker-task construction. Each variant is a full independent pass,
because the verdict map, the quality extractor and the confusion table all key on the bare case id
and interleaving two variants would silently keep whichever wrote last. The `generic` pass takes no
event-id suffix, so a default run's golden stays byte-identical to the artifact produced before the
dimension existed.

**The A/B block computes no delta, ratio or percentage between variants**, and on the deterministic
arm it reports `qualityIsMeasured: false`. The fixture worker keys its answer off the case id and
never off the prompt, so both variants receive the identical authored answer and their quality is
equal **by construction** — a delta computed from that would be an artifact of the fixture.
Authoring a second, better answer for the intent variant would be worse still: it would let whoever
wrote it decide which construction wins. Prompt size and token counts are real on every arm;
quality is real only on a live one.

## What the framework may not do

Enforced statically by [`evals.isolation.test.mjs`](../test/evals.isolation.test.mjs), because a
comment is not enforcement.

| rule | why |
| --- | --- |
| never imports `telemetry/index.mjs`, `identity.mjs` or `jsonl.mjs` | an eval row must never reach the user's store, and no salt file may be created |
| never calls `loadConfig()` or reads `process.env` for a setting | a benchmark number must not depend on the machine it ran on |
| no `?? 0` or `\|\| 0` anywhere | the reflex fix for a null renders "we do not know" as "zero" |
| no `1e6`, no `/ 4` in the metrics layer | pricing and the token estimate belong to `calc.mjs` alone |
| `schema.mjs` and `evaluators.mjs` import no `node:` builtin | they are tables and string functions |
| the plugin never imports from `test/evals/` | the dependency runs one way, and the plugin installs standalone |

That `?? 0` rule caught four real instances in this framework's own first draft, three of which were
summing a measurement where a null must poison the total.

## Arms (phase 8)

| arm | model | deterministic | corpus coverage |
| --- | --- | --- | --- |
| `mock` | fixture server | yes — gates CI | all 26 |
| `ollama` | `llama3:latest`, 8192 ctx | no | 9 of 11 dispatch cases |
| `ollama-mistral` | `mistral:latest`, 32768 ctx | no | 11 of 11 |

`shape-large-single-file` and `shape-buried-fact` exceed llama3's architectural context and
are **refused** on that arm with `context_exceeded`, rather than served from a silently
middle-truncated prompt. That refusal is the correct result on that arm, not a regression.

**The second live arm is the experiment, not redundancy.** With only `ollama`, a quality
difference between generic and intent-aware tasks cannot be told apart from "the model's
window was too small for this case" — the two explanations are confounded. Running a
32768-token model over the same corpus separates them. Without it the honest verdict would
have to be inconclusive for a reason that was removable.

## Why the offline A/B cannot measure quality

`fixture-worker.mjs` keys its answer off the **case id in the request URL**, never off the
prompt. Offline, the generic and intent-aware variants therefore receive a byte-identical
authored answer and quality is equal **by construction**. `report.ab` reports
`qualityIsMeasured: false` and carries no delta, ratio or winner field.

So the offline A/B proves the two variants are *plumbed* correctly and that neither breaks a
gate. Only a live arm can say whether intent changes what a model produces.

## The routing knob sweep

`--sweep` now walks five knobs independently — `minBytes`, `minLines`,
`minEstimatedTokens`, `maxFiles`, `minFiles` — and lands at `report.knobSweep`.

**Independent sweeps, not a cartesian product.** Five knobs crossed would be combinatorially
large, nearly every cell would duplicate another, and no cell would be attributable to a
single cause.

**Measurability is computed and reported first.** A knob is measurable when the set of
delegating cases actually *changes* across its points. `decide()` guards every size clause
with `isKnown(x) && x >= t`, so a field no case supplies can never fire its rule — and the
honest output for such a knob is a sentence, not six numerically identical rows. As measured:

| knob | measurable? | cases that respond |
| --- | --- | --- |
| `minBytes` | yes | 9 |
| `minLines` | yes | 3 |
| `minEstimatedTokens` | **no** | 0 |
| `maxFiles` | coarsely | 1 |
| `minFiles` | trivially | 13 |

Every refusal the threshold sweep makes is restated per knob: `rowsTotal` is the full case
set at every point, a verdict counts only where the case actually delegated, `selected` and
`recommended` are explicit nulls, there is no point-to-point delta, and the module exports no
`bestKnob`-shaped function. `test/evals.sweep.test.mjs` asserts all of it.

## Negative savings

`report.json` → `knobSweep[].points[].negativeSavings` lists every case with
`estimated_tokens_avoided < 0`, unclamped, with the operands worth correlating against: both
sides of the net, input bytes, file count, worker input and output tokens, latency, routing
reason, prompt version, intent source, the resolved context window and the truncation flag.

**Correlation only.** Nothing in it changes a routing rule. As measured on the current
corpus there are **zero** such cases at any point of any knob, so the analysis has no data to
run on — which is reported as such rather than dressed up.
