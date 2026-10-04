# Telemetry fixture corpus

The wire-format contract between the two plugins, made literal. `docs/telemetry-schema.md` is the
prose; these files are the bytes. `model-router` writes this format and `router-dashboard` is
forbidden from importing the code that produced it, so a committed corpus is the only thing the two
can actually agree on.

> **These files are authored by hand and measured by a test, never generated.**
> `test/telemetry.fixtures.test.mjs` parses them with the shipped reader
> (`lib/telemetry/jsonl.mjs`) and asserts the table below against what it measured. A declared
> count that drifts from the bytes fails the suite.

There is deliberately **no generator**. `test/evals/bin/build-corpus.mjs` is pinned as the only
module that writes into this repository, and a second writer would weaken a real guarantee for no
gain. More to the point, the value of this corpus is that it contains things a generator would
normalise away: a UTF-8 BOM, a `#` comment, a blank line, and an unparseable line in the *middle*
of a file.

## The segments

| file | lines | yielded | skipped | money rows | what it is for |
| --- | --- | --- | --- | --- | --- |
| `events-2026-03-02.jsonl` | 6 | 6 | — | 3 | the **priced** window: `pricing.overrides` configured, so cost is non-null and the basis is `actual` |
| `events-2026-03-03.jsonl` | 7 | 7 | — | **0** | the **default install**: every bundled rate is `null`, so every money column is `null` |
| `events-2026-03-04.jsonl` | 23 | 20 | 1 blank, 1 comment, 1 malformed | 2 | the **awkward day**: one row per hazard |
| `empty/` | — | — | — | — | an empty store directory, for the empty-window case |
| **total** | **36** | **33** | **3** | **5** | |

`events-2026-03-03.jsonl` is the one that matters most. It is the shipped state of every new
install, and **a report rendered over it must contain no dollar figure of any kind** — a CI step
asserts exactly that. `estimated_tokens_avoided` is the only populated headline.

## What `2026-03-04` holds, and why each row is separate

Each of these is a distinct fact that an analytics layer is tempted to fold into its neighbour.
Folding any two of them is the failure this corpus exists to catch.

| row | the distinction it pins |
| --- | --- |
| governance denial, `daily_budget_exceeded` | `routing_reason` is **`threshold_met`** — the gate *approved*. Only `governance_decision: 'deny'` says it was refused, and `status` is `skipped` with `error_code: null`, so it is not a worker failure either. |
| governance denial, `cost_unknown` | a *successful* refusal on an unmeasurable cost, not a failed request |
| governance denial, `usage_unknown` | with `reservation_status: 'overrun'` |
| `context_exceeded`, pre-flight | the provider was **never called**: no usage, no cost, nothing wasted |
| `context_exceeded`, truncation discard | `worker_input_truncation_detected: true` — the call **ran, cost money, and the answer was thrown away**. The purest waste figure in the store, and it must never average into the row above. |
| provider error, `timeout` | the worker *was* called and something went wrong. `retry_count: 2`, so `provider_latency_ms` is null and no overhead figure is derivable. |
| provider error, `aborted` | a second error code, so failures never collapse to one bucket |
| negative in **both** spaces | `estimated_tokens_avoided: -1000` and `estimated_net_savings: -0.01533`. Never clamped. |
| **positive** tokens, **negative** cash | `+500` tokens avoided, `-$0.013` net. This row is why the two negative-savings counts are separate populations — reporting either alone hides one of these two rows. |
| unknown cost, `model_unknown` | a perfectly successful call whose price we cannot state. Not a failure, **not zero**. |
| `provider: null`, `model: null` | the null segment bucket, which keeps its own key rather than being dropped |
| unknown enum, `routing_reason: 'quantum_tunnelling'` | preserved verbatim with `unknown_enum:routing_reason` in `validation_codes`; buckets to `other` on read |
| deliberate `routing_reason: 'other'` | **no** validation code, so after bucketing it is indistinguishable from the row above. That is irreducible, which is why the response reports an `indeterminate` count instead of pretending otherwise. |
| `worker_token_sum_check: 'mismatch'` | the provider's own total disagrees with the sum of its components |
| approved, never dispatched | gate approved, governance approved, no dispatch, and **nothing on the row says why** (`content_unreadable` / `content_binary`). A known telemetry gap, surfaced as ambiguous rather than filed under gate refusals. |
| capability unknown | `worker_context_tokens: null` with `source`/`status` both `unknown`. Unknown context is never infinite context. |
| content fields populated | `project_path`, `question_text` and `error_message_safe` carry `FIXTURE-MUST-NOT-APPEAR-*` markers that exist nowhere else in the repository, so a leak test can assert absence of a string rather than absence of a field name. |
| `schema_version: 2` | the reader **yields** it; the aggregation layer counts it as incompatible and it contributes to nothing |
| extra undeclared key | tolerated, never rejected — the row is open on read, like the enums |

## The literal wire-format hazards

These are the reason the corpus is bytes rather than objects.

| hazard | where | why it is here |
| --- | --- | --- |
| UTF-8 BOM | first three bytes of `events-2026-03-04.jsonl` | PowerShell 5.1's `>` and `Out-File` both write one. The reader strips it only as the first three bytes. |
| blank line | `2026-03-04` | a trailing newline always produces one; it must be counted, not treated as an error |
| `#` comment | `2026-03-04` | skipped and counted separately |
| malformed line **mid-file** | `2026-03-04` | mid-file is the load-bearing part. An unparseable *tail* is `truncated_tail` and benign — a writer caught mid-flight. An unparseable line in the *middle* is `malformed`, and that is evidence append atomicity failed on the filesystem. The corpus asserts `malformed: 1` on purpose, so the distinction stays tested. |

`.gitattributes` pins `test/fixtures/telemetry/*.jsonl text eol=lf`. Without it `core.autocrlf` on a
Windows clone rewrites every line ending; parsing would survive (the reader strips exactly one
trailing `\r`) but byte and size assertions would not, and the BOM case would become ambiguous. The
**CRLF-specific** case is therefore *not* committed — it is written into `test/.tmp` at test time,
because git must not be able to rewrite the thing under test.

## Not for performance

These files are small on purpose. The 10,000- and 100,000-event stores are generated into
`test/.tmp` from a seed by `test/helpers/telemetry-corpus.mjs`; committing 40–80 MB to assert a
ceiling would dominate every clone on both CI platforms.

Terms: [`docs/telemetry-schema.md`](../../../docs/telemetry-schema.md) defines every field,
[`docs/savings-methodology.md`](../../../docs/savings-methodology.md) defines the two nets, and
[`docs/analytics.md`](../../../docs/analytics.md) defines what is computed from them.
