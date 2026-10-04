# The escalation ladder

Ollama → Gemini → Claude. One `Read`, up to three tiers, and the last one needs no code.

## The shape

```jsonc
// <your-project>/.claude/model-router.json
{
  "worker":  { "provider": "ollama", "model": "qwen2.5-coder:7b" },
  "workers": { "bulkRead": { "ladder": ["ollama", "gemini"] } }
}
```

That is **three tiers from two entries**: Ollama, then Gemini, then — when the ladder is exhausted
— the hook falls open and **Claude reads the file itself**. The last tier is the behaviour this
plugin has always had on every failure path, so it costs nothing to implement and cannot itself
fail.

Each entry is a **provider id**; its model comes from `providers.<id>.model`.

## It ships empty, and that is a decision

`workers.bulkRead.ladder` defaults to `[]`, which is exactly the single-worker behaviour: one
attempt, and a failure falls open. A default that escalated would **spend money and send a file to
a third party without being asked** — the thing CLAUDE.md's eighth non-negotiable forbids. So
escalation is something an operator turns on, in a file they can read.

## What makes a tier escalate

| Trigger | Escalates? |
|---|---|
| verification says `suspect` — the answer contradicts the file | **yes** |
| the provider errored, timed out, or was unreachable | **yes** |
| `context_exceeded` — the prompt does not fit this worker | **yes** |
| the answer verified | no, the ladder stops |
| the answer made no checkable claim (`not_checkable`) | no — there is no evidence against it |
| `verify.enabled: false` | only on an error; there is no other signal |

The verifier is what makes this better than a guess: it escalates on a **demonstrated** failure —
an invented line number, a symbol absent from the file, a quoted literal that is not there. See
[summary-verification.md](summary-verification.md).

**It will not escalate a vague-but-true answer.** An answer that omits the function you needed
passes every check. The ladder raises the floor; it does not guarantee a good summary.

## The time budget is the load-bearing part

Not the loop. **Measured on the development machine: a 7B local model takes 80 to 113 seconds on a
900-byte file, against a hook deadline whose maximum is 120 seconds.**

Without a budget check the ladder would spend the whole deadline on tier one, start tier two, be
aborted, and fall open anyway — leaving the developer waiting two minutes for the `Read` they would
have had immediately. **That is strictly worse than not installing the plugin.**

So a tier is only attempted when at least a quarter of the original deadline remains. A fraction
rather than a fixed number, because the tiers differ by orders of magnitude — a hosted model
answers in seconds, a local one in minutes — and this code cannot predict a latency it has never
measured. When the budget runs out the row records `out_of_time` in its escalation path.

### Which means the order is a real trade, not an obvious one

| | latency on a CPU box | cost per 12 KB read | privacy |
|---|---|---|---|
| Ollama 7B | 80–113 s (measured) | free | nothing leaves the machine |
| Gemini flash | seconds | fractions of a cent | the file goes to Google |
| Claude (fall open) | immediate | ~3k context tokens | — |

**`["ollama", "gemini"]` buys privacy and costs latency.** On a CPU-only machine tier one will
often consume the budget on its own, so in practice you get Ollama-or-Claude and Gemini rarely
runs. On a GPU box, where the local model answers in seconds, the full ladder works as intended.

**`["gemini"]` buys latency and costs privacy**, and is the better ladder on hardware without a
GPU.

Pick deliberately. The plugin will not pick for you.

## What is recorded

**One row per `Read`, however many workers it took.** That is load-bearing rather than tidy: the
delegation rate, refusal rate and success rate all have the routing-event population as their
denominator, and one `Read` is one routing event whatever the ladder did. A row per attempt would
double-count all three.

So the row describes the attempt whose answer was **returned**, plus four additive columns —
`schema_version` stays `1`:

| Column | Meaning |
|---|---|
| `escalation_attempts` | how many workers were called |
| `escalation_path` | e.g. `ollama>gemini`, or `ollama>out_of_time` |
| `escalation_wasted_input_tokens` | input tokens spent on answers that were abandoned |
| `escalation_wasted_output_tokens` | output tokens spent on answers that were abandoned |

The wasted columns are what keep the cost honest. Those tokens were really consumed whether or not
the answer was kept, and a ladder that hid its own waste would understate what delegation costs.
**Null, not `0`**, when nothing was wasted.

### The known limitation

Per-tier usage is **summed, not itemised**. A row tells you two workers ran and how many tokens
were thrown away; it does not tell you which tier spent which tokens. With a free local tier first
that distinction does not matter. With two metered tiers it would, and the fix is a row per
attempt correlated by `task_id` — which is a real change to every existing metric's denominator,
so it is a backlog item rather than something done quietly.

## Governance

Each attempt is a separate worker call, so a two-tier escalation takes two budget reservations and
two settlements against the same `tool_use_id`. That works — the ledger is keyed per call — but it
doubles ledger traffic on an escalating read. With every limit `null` (the shipped state) it costs
nothing at all, because `checkBudget` short-circuits before opening the ledger.

## Turning it on

```bash
# 1. the key, as an environment variable — never in a config file
setx GEMINI_API_KEY "your-key"        # Windows, then restart Claude Code
export GEMINI_API_KEY=your-key        # macOS / Linux

# 2. confirm the plugin can see it — reported by SHAPE, never the value
/model-router:doctor                  # expect: present — 39 chars, starts "AIza…"
```

```jsonc
// 3. the ladder
{ "workers": { "bulkRead": { "ladder": ["ollama", "gemini"] } } }
```

Then watch `npm run analytics`: the **Answer quality** section shows how often claims fail, which
is the number that tells you whether tier one is pulling its weight.
