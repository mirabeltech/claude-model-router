# Savings methodology

Every number this plugin reports is deliberately conservative, and the methodology is the point.
A confident wrong dollar figure is worse than a refusal to price, so the system refuses a lot.

## The one rule

> **A missing measurement is `NULL`, never `0`.**

Everything below is a consequence. A zero where a measurement is missing understates worker cost,
which overstates savings — the one direction of error this project exists to avoid. So wherever a
number cannot be derived from measured operands, it is `null` and its `*_status` says
`unavailable`.

## The two nets

Conflating these is how a gross figure ends up with a net label. They are different, both
required, and neither is optional.

| | name | space | formula |
|---|---|---|---|
| 1 | **context net** | tokens | `estimated_tokens_avoided = estimated_input_tokens − returned_answer_tokens_estimated` |
| 2 | **cash net** | dollars | `estimated_net_savings = estimated_cost_avoided − worker_total_cost` |

Net 1 is "the worker's answer does enter Claude's context, so it is subtracted". It is computed in
token space, **before** pricing, and it **refuses to compute** when the returned-answer size is
unknown. There is no gross fallback.

Net 2 sits on top. It refuses to compute when the worker bill is unknown — reporting the avoided
figure as net savings would publish a gross number under a net label. With unpriced rates that is
also the *likely* case, which is exactly why the rule is absolute rather than pragmatic.

## The counterfactual difference is input-side only

This is the most important asymmetry in the model, and it is easy to get wrong.

In the counterfactual, Claude ingests the corpus. In reality, Claude ingests the worker's answer
instead. **The answer Claude produces is the same in both worlds** — the user gets the same
deliverable either way — so output is a wash and belongs in no term.

That is why `estimated_cost_avoided` prices the whole net delta at the primary model's **input**
rate alone, and why no savings formula contains a `primary_output_*` term.

## `chars/4` under-counts, on purpose

Source code really tokenizes nearer 3.0–3.6 chars per token, so `chars/4` produces fewer tokens
than reality and the reported saving is a **floor**. The division also **floors** rather than
rounds, keeping it a floor at the boundary too.

Every event carries `avoided_method`, so the figure is auditable. An **unknown** method never
falls back to `chars_div_4`: a number must match the method stamped beside it, so an unrecognised
method yields `null`.

`anthropic_count_tokens` is still `estimated`, never `actual`. The count is exact, but the prompt
it counts never existed. A counterfactual's precision does not make it a measurement.

## Only what the gate proved

A hook blocking one file proves Claude wanted *that* file. If the skill then sends six, five are
inference — and an inflated corpus is the single largest over-claim risk in the system.

`telemetry.countProvenFilesOnly` defaults to `true`, and the math **cross-checks** it: if
`files_count` exceeds `proven_files_count`, the caller evidently ignored the filter, and the
estimate is refused rather than published. Both counts are stored (`files_count`,
`files_inferred_count`) so the split is auditable.

## No `tokens × turns` multiplier. Ever.

Claude Code pays **cache** rates for resident context: roughly 2× input to land it once, then
~0.1× per later turn. The common "we saved X tokens across 40 turns" claim is therefore
**10–40× inflated**.

`residency_turns` is accepted, validated and stamped onto the event — and `calc_version 1`
**ignores it in the arithmetic entirely**. A test asserts that the result with `residencyTurns: 40`
equals the result with `0`, and another asserts the same at the aggregate level. Config refuses a
non-zero `residencyTurns` unless `residencySource` names a real provenance, and the math does not
trust its caller on that either.

If residency is ever justified by transcript measurement, it becomes an **additive cache-rate term
in dollar space**, not a multiplier in token space — and that is a new `calc_version`.

## Negative savings are stored, never clamped

A worker answer larger than the corpus it replaced produces a negative
`estimated_tokens_avoided` and a negative `estimated_net_savings`. Both are stored unchanged,
because they are the evidence that a threshold is set wrong. Clamping them to zero would hide
exactly the finding an operator needs.

`0` is likewise a real result: avoided 1 000 tokens, returned 1 000 tokens means this delegation
saved nothing. That must not render identically to "we do not know".

## What can be `actual`, and what never can

| field | `actual` possible? |
|---|---|
| `worker_*_cost` | Yes — measured usage against a known rate. |
| `primary_*_cost` | Only once a transcript reader exists. `unavailable` today. |
| `estimated_tokens_avoided` | **Never.** |
| `estimated_cost_avoided` | **Never.** |
| `estimated_net_savings` | **Never**, in any `calc_version`, forever. |

One operand of every savings figure is a counterfactual, so this project's headline number can
never be labelled `actual`. That is a feature, not a gap.

## Two structural zeros, and only two

The null rule has exactly two controlled exceptions, each gated on a provider **capability flag**
rather than on a guess, and each recorded on the event:

| situation | billable value | status |
|---|---|---|
| thinking tokens absent, `reportsThinkingTokens: false` | `output` | `actual` (`structural_zero`) |
| thinking tokens absent, `reportsThinkingTokens: true` | **`null`** | `unavailable` (`unknown`) |
| cached input absent, `supportsCachedInput: false` | `0` | `actual` |
| cached input absent, `supportsCachedInput: true` | **`null`** | `unavailable` |
| capabilities object missing or malformed | **`null`** | `unavailable` |

A provider that *cannot* produce thinking tokens has no billing line for them, so `0` is the true
value and using `output` is a measurement. A provider that *can* and simply did not report them
this time is genuinely unknown, and returning `output` would understate the bill.

**An unknown capability always resolves toward `null`.**

The practical consequence, accepted deliberately: Gemini omits `thoughtsTokenCount` whenever
thinking is off, so those events get a `null` output cost and therefore a `null`
`worker_total_cost` and a `null` `estimated_net_savings`. That is a lot of nulls. It is also safe,
because it suppresses a claim rather than inflating one.

## Pricing

Rates are per million tokens, and `unit: "per_mtok"` is a required literal in every table so a
hand-written per-token table is rejected at load rather than producing costs 10⁶× too low.

**The bundled table ships every rate as `null`**, with a `verify` URL and `verifiedAt: null`. The
accepted consequence is that out of the box, with default config, every monetary field on every
event is `NULL`. The honest out-of-box headline is `estimated_tokens_avoided`, which is
non-monetary and fully populated. `router doctor` prints the exact override snippet to paste.

A knock-on worth stating: `budget.daily.maxWorkerCostUsd` has no number to accumulate while rates
are unset, so a MONETARY budget cannot enforce anything. `doctor` warns about precisely that, and
it is why token budgets are the only dimension that binds on a default install — see
[governance.md](governance.md) §1. A local provider is a separate case: its cost is a structural
zero rather than an unknown, so a dollar ceiling simply does not apply to it.

Lookup is `provider:servedModel` → `provider:requestedModel` → `provider:*`, first hit wins.
There is **no prefix, normalisation or fuzzy matching**: matching `gemini-3.8-flash` onto a served
`gemini-3.8-flash-thinking-max` would price an unknown model at a known model's rate, which is a
guessed rate. An unmatched model is a refusal.

Tables are **never merged**, at row granularity. An override row for a model wins *entirely*; an
absent rate in that row is `null`, not inherited. A field-level merge would blend two vendors'
price lists into a number nobody published.

Unknown-model and null-rate both yield a `null` cost. `pricing_lookup` distinguishes them:
`model_unknown` means add a row, `exact` means fill in the rate from its `verify` URL.

## Auditability

Cost is computed **once, at write time**, and the row carries `pricing_version`, `calc_version`,
`avoided_method`, `counterfactual_render`, `count_proven_files_only`, `residency_turns` and
`residency_source`. Every money field is therefore reproducible from the row's own fields plus the
table its `pricing_version` names — a property a test exercises directly.

Readers sum stored money and never re-price. Re-pricing a historical row against today's table
would produce a number for a bill nobody was ever sent.

## Aggregating over missing data

Summing a column where some rows are `null` is the place where an honest row-level model can still
produce a dishonest total. Treating `null` as `0` presents partial coverage as complete.

So an aggregate is never a bare number. It carries `rowsCounted`, `rowsUnavailable`,
`rowsIncompatible`, `coverage`, `basis` (`actual` / `estimated` / `mixed`) and `bound`:

- **`value` is `null` when nothing contributed — never `0`.**
- **`bound: 'lower'`** for a same-signed column: a partial sum is a genuine floor, "at least $X".
- **`bound: 'none'`** for `estimated_net_savings`, which is signed by construction, so a partial
  sum bounds nothing and must not be presented as a floor.
- `formatAgg()` takes the whole aggregate, never `.value`, and renders an unavailable total as
  "unavailable" rather than "$0.00".
- Aggregates are **never added to each other** — two can cover different row sets. All combination
  happens per row, inside an extractor, with strict null propagation. A row missing any component
  of total worker tokens contributes **nothing**, and `rowsUnavailable` says so.
