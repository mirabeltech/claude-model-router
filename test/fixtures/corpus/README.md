# Corpus fixtures

Files sized relative to the shipped `routing.bulkRead` thresholds, so a test or a smoke run can
pick the side of the gate it means to exercise.

| file | bytes | lines | lands on |
|---|---|---|---|
| `small.ts` | 53 | 2 | below every threshold — stays with Claude |
| `medium.ts` | 13 014 | 401 | just over `minBytes` (12 000) — delegates |
| `large.ts` | 44 872 | 1 388 | comfortably over — delegates |

`small.ts` is also what `scripts/smoke-hook.mjs` uses with `--min-bytes`, because a local CPU-only
model needs a small prompt to answer inside an interactive budget. Most unit tests build their own
file with `makeWorkspace()` instead, so they can state the size they depend on inline.

Note that `minLines` is unreachable from the hook — it leaves `lineCount` null deliberately — so
only the byte column decides. See `docs/hook-integration.md`.

Line counts are content lines: a trailing newline terminates the last line rather than starting a
new one, which is what `countLines()` in [`test/evals/schema.mjs`](../../evals/schema.mjs)
implements and what [`test/fixtures/evals/`](../evals/README.md) declares. The three numbers above
were each one higher before that definition existed, having been counted as `split('
').length`,
which counts the empty position after the final newline as a line. Nothing asserted them, so
nothing broke — but two corpora using one word for two quantities is the drift the eval loader's
`lines_mismatch` check exists to prevent.
