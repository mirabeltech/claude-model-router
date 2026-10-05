# Summary verification

What stops a wrong summary from reaching Claude, what it can catch, and what it cannot.

## The failure this exists for

A worker's answer **replaces the file** in Claude's context. Claude never sees the bytes. So if the
answer is wrong, Claude's context is wrong, everything built on it inherits the error — and the
developer cannot see any of it, because the thing that was substituted is the thing they never got.

A delegation that returns a confident fabrication is worse than no delegation at all.

## Why it is checkable without a judge model

**We still have the file.** The answer makes specific, mechanical claims about it, and every one of
them can be checked exactly, against the bytes, with no model, no network and no measurable time:

| Claim | How it is checked |
|---|---|
| ``` `Record1` on line 11 ``` | does `Record1` appear on line 11 of the file, within two lines? |
| ``` `"Record1 requires an id"` ``` | does that literal appear in the file, verbatim or by word overlap? |
| ``` `getUserById` ``` | does that identifier appear anywhere in the file, or in its path? |

**A claim that asserts an ABSENCE is skipped, not inverted.** "No `Record18` interface is
declared" does not assert that `Record18` exists, so its absence is not evidence of invention —
and a negation only negates what follows it, so "throws `"..."` when the input has no id" is
still an ordinary positive claim. Both rules exist because a real answer broke the version without
them.

`lib/verify/summary.mjs` does this. It is pure and imports nothing: it is handed two strings and
returns a verdict, which is what lets it sit on the hook's hot path and be tested against a real
worker's answer with no filesystem and no clock.

It verifies **claims**. It does not grade prose, judge usefulness, or score quality — and it must
never be made to. The moment it returns something that looks like a quality score, CLAUDE.md's
sixth non-negotiable is broken.

## The asymmetry, which is the whole design

A **false positive** discards a good summary. The developer gets the ordinary `Read` they would
have had anyway: the cost is one wasted worker call.

A **false negative** puts an invented line number, symbol or literal into Claude's context, and
everything after it inherits the error.

Those costs are not comparable, so the check is tuned to favour the cheap mistake. This is the
opposite of a dashboard metric, where a false positive is noise somebody has to chase; it is why
the advisory grounding check in the eval framework stays advisory and this one acts.

**But "favour the cheap mistake" is not the same as "trigger on anything", and the first version
got that wrong.** It made a single wrong line reference or one absent literal fatal — rules tuned
against a worker that made THREE claims. Tested against a real Gemini answer that made
**thirty-six and got thirty-four right**, it discarded the whole summary. A detector that cannot
tell one miss in thirty-six from three in three makes a good worker unusable, which is the
opposite of its purpose. Every threshold is now a ratio, and the two populations measured nowhere
near each other: **5.6% of claims wrong for a good answer, 100% for a fabrication.**

## The prompt had to change first

The task has always asked for "every significant declaration with the line it is on". The prompt
sent the file as **raw bytes with no line numbers in it**.

Measured against Ollama / `mistral:latest` at temperature 0: the worker **silently dropped that
half of the task** and produced no line references at all. We were asking for something the input
made impossible, and had been for every release.

With `NNNN | ` prefixes the same model produced three line references and all three were exact —
`Entity` 8, `Record1` 11, `normalizeRecord1` 19. That is worth two things beyond compliance: Claude
can act on a correct line number with a targeted re-read, and a line reference is exactly checkable
afterwards.

`PROMPT_VERSION` moved `3 → 5`. The cost is about 7 bytes a line, so a 12 KB 350-line file grows
roughly 2.5 KB — around 600 extra prompt tokens, measured at 674 → 807 on a small file. A row
stamped `5` is therefore **not token-comparable** with a row stamped `3`, which is exactly what
that integer exists to tell a reader.

## What happens when a claim fails

`verify.onSuspect`, default **`discard`**:

| Mode | Behaviour |
|---|---|
| `discard` | the summary is thrown away and the hook falls open. The developer's `Read` happens normally — the same zero-bytes outcome as every other failure path. Outcome `summary_unverified`. |
| `warn` | the summary is substituted **and** the deny message carries a caveat naming what failed, so Claude can re-read. Useful when a worker is weak at line numbers but still worth reading. |
| `off` | the verdict is recorded and nothing acts on it. |

The caveat names the failed claims rather than saying "this may be unreliable", because Claude is
the one consumer that can act on it:

> This summary was checked against the file and parts of it could not be confirmed: 3 of 3 line
> references could not be confirmed; 1 quoted literal(s) do not appear in the file. Treat the
> specifics as unverified and re-read the file with offset and limit if you need them.

The caveat goes in `permissionDecisionReason`, never into `additionalContext`. `additionalContext`
is the worker's answer and nothing else is mixed into it, or a later reader cannot tell which words
came from the worker.

**Verification runs after accounting, deliberately.** The worker call happened and its tokens were
really consumed, so it is charged whether or not the answer is kept. Discarding an answer does not
un-spend it, and a row that hid the spend would understate what delegation costs.

**And a discarded answer saves nothing, so its row claims nothing.** It is written with `status:
skipped`, `estimated_tokens_avoided: null` and `returned_answer_chars: null` — the same shape as a
truncation discard — while the worker usage columns keep the tokens that were spent. Analytics
therefore files it under worker overhead, never under successes or savings. Until 2026-10-05 it was
written as `status: ok` with the full saving, which a real discarded Gemini answer exposed.

## What it catches

Measured against a real fabrication:

```
verdict  : suspect | line_claims_wrong:3,literals_absent:1,identifiers_absent:6/7
lines    : Entity claimed on line 142; actually on 8, 11
           getUserById claimed on line 203; absent from the file
           UserRepository claimed on line 310; absent from the file
literals : "user not found in registry"  — absent
```

A wrong line number reports **where the symbol actually is**, because "wrong" without that is not
actionable. A symbol absent from the file entirely is reported as absent rather than as misplaced:
a counting mistake and an invention are different failures, and conflating them hides the worse one.

## What it cannot catch

Stated plainly, because a verifier whose limits are unstated is worse than one with none.

1. **Recombination of real tokens into a false claim.** "`decide()` calls `resolveWorker()`" has
   every token in the file and may be false. Structural, and no amount of tuning fixes it — that is
   what a judge model would be for, and this project does not have one.
2. **Declaration versus appearance.** The check confirms a symbol appears *at or near* the claimed
   line, not that it is *declared* there. `Record1` occurs on lines 11, 19 and 20 — its
   declaration, a signature and a string literal — so a claim of 19 verifies. Telling those apart
   needs a TypeScript parser, which this deliberately is not.
3. **Omission.** An answer can have every claim check out and still leave out the thing that
   mattered. This is a floor on accuracy, not a measure of quality.
4. **Wrong argument order, wrong types, a wrong "this file does not handle X".** All semantic.
5. **Prose.** Only backticked identifiers are checked. The eval framework's advisory check scans
   prose too and documents its own false-positive rate as roughly one per five cases, from casing
   drift and legitimate composition. Backticks are explicit: the worker put them there to mark a
   name it is quoting.

## What is recorded

Four columns, additive, so `schema_version` stays `1`:

| Column | Meaning |
|---|---|
| `summary_verify_verdict` | `verified`, `suspect`, `not_checkable`, or **null** |
| `summary_verify_reason` | which checks failed, as codes |
| `summary_line_claims` | how many line references the answer made |
| `summary_line_claims_wrong` | how many of them did not check out |

**Null means "not checked"**, which is weaker than a `not_checkable` verdict — that means "checked,
and the answer made no claim that could be checked". Collapsing the two would hide an operator who
turned verification off. A row written before these columns existed has the keys absent, which the
read layer treats as not-checked for the same reason.

`npm run analytics` and the HTML report both break the population down under **Answer quality**:
claims check out / claims do NOT check out / no checkable claim / not checked.

## What this does and does not change about the evidence boundary

`answerQuality.measured` stays **`false`**, and that is not timidity. Claim verification establishes
that an answer did not say anything *untrue* about the file. It establishes nothing about whether
the answer was *useful*, and a summary that omits the one relevant function passes every check here.

So: a floor, not a grade. The claim this project can now make is narrower than "quality is
measured" and much stronger than what it could say before — **an answer that contradicts the file
does not reach Claude.**
