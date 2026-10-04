# Verification fixtures

## `gemini-medium-answer.txt`

A **real worker answer**, captured verbatim on 2026-10-04 from Gemini `gemini-3.8-flash`
summarising `test/fixtures/corpus/medium.ts` through the shipped prompt (`PROMPT_VERSION` 5, the
line-numbered one).

It is here because it is the answer that **proved the first verifier wrong**. It makes 36 line
claims and gets 35 right, and the original rules — one wrong line claim or one absent literal is
fatal — discarded it. Worse, they discarded it partly for this sentence:

> **No `Record18` implementation**: Although line 401 contains
> `/** Domain record number 18, with the audit fields every table in this schema carries. */`, no
> `Record18` interface or `normalizeRecord18` function is declared.

That is correct: `medium.ts` really does carry a dangling doc comment for a record it never
declares. The verifier was punishing the worker for obeying the part of the task that says "state
what the file does not do", which is the most valuable sentence in the summary.

It also writes `RecordN` and `"RecordN requires an id"` as generalisations standing for `Record1`
through `Record17` — good summarising, and legitimately absent from the file.

**Do not regenerate it.** Its value is that it is real and that its failure modes are understood.
A fresh capture would be a different answer and would silently stop testing the three cases this
one pins: negated absence claims, placeholder generalisation, and a filename cited with a line
number. It is paired with `medium.ts`, which `.gitattributes` byte-pins, so neither can drift.
