# Contributing

## Read this first

**[CLAUDE.md](CLAUDE.md) is the source of truth for the non-negotiables.** It is not duplicated
here, because two copies of a rule drift and the drift is invisible. Read it before changing
anything under `plugins/`.

[docs/architecture.md](docs/architecture.md) explains the shape and lists the test that pins each
structural claim.

## Getting set up

```bash
git clone https://github.com/mirabeltech/claude-model-router
cd claude-model-router
npm test        # no install step, no network, no API key
```

There is nothing to build. Node 22.5+; CI gates 24 on three platforms and 22.5.0 on Linux.

Work on the plugin without installing it:

```bash
claude --plugin-dir ./plugins/model-router -p "read src/big-file.ts and list its exports"
```

## The hard gate

**No npm dependency, ever.** Node's standard library only. This is not a style preference: a hook
runs on every `Read` in someone's editor, and a dependency tree is both a startup cost and a supply
chain. If you need a thing, write the thing — this is why there is a hand-rolled SVG chart and a
60-line JSON Schema validator in `test/helpers/`.

## Generated files

Four are generated and gated in CI by `git diff --exit-code`. A stale one fails the build.

| After changing | Run |
| --- | --- |
| `SPEC` in `config.mjs` | `npm run gen:schema` **and** `npm run docs:config` **and** `npm run docs:env` |
| `lib/env-registry.mjs` | `npm run docs:env` |
| the version in `package.json` | `npm run sync:version` |
| `test/evals/` corpus manifest | `npm run evals:build` |

Never edit `lib/config.schema.json`, either `lib/version.mjs`, `docs/environment.md`, or anything
below the sentinel in `docs/configuration.md`.

`npm run docs:config` **fails** if a setting has no description. That is deliberate: a new setting
must be documented in `lib/config-descriptions.mjs` before it can ship.

## What a change has to come with

**A new branch in `decide()` needs a fail-open test.** The gate must return `allow` on every error
path. A branch that can throw, or that declines for a reason not in the vocabulary, is a bug even
if every test passes.

**A changed threshold or glob default needs a negative eval.** `test/evals.protected.test.mjs` is
the cross-product proof that reasoning work is still refused for every corpus input. A benchmark
result is *evidence* and never changes policy by itself — see
[docs/benchmark-methodology.md](docs/benchmark-methodology.md).

**A new environment variable needs a declaration.** Either a `SPEC` entry (if it is a setting) or an
entry in `lib/env-registry.mjs`. `test/env.inventory.test.mjs` fails on an undeclared read, and on
a declaration nothing uses.

**A new provider needs the conformance test to pass.** See
[docs/adding-a-provider.md](docs/adding-a-provider.md). `billing` is *declared*, never inferred
from whether a key is needed: assuming an unidentified provider is free is the expensive mistake.

**A new npm script or public command needs documenting.** `test/docs.contract.test.mjs` fails if a
script is neither mentioned in a doc nor declared internal — and if a doc references a script or a
path that does not exist.

**A new setting needs a description**, as above.

## Things that will get a change rejected

- An npm dependency.
- A `process.env` read for something that has a `SPEC` entry. Go through `loadConfig()`.
- Filesystem or network I/O in a module documented as pure. The purity map is in
  [docs/architecture.md](docs/architecture.md) and each entry is statically pinned.
- An import of `model-router` from `router-dashboard`, or of `hook/` from `lib/`.
- A `hooks` key in `plugin.json`, or a `timeout` beside `args` in `hooks.json`. Both silently break
  the hook load and `plugin validate --strict` catches neither.
- A guessed number where `null` is the truth. An unpriced model, an unmeasured context window and
  an unreported usage figure are all `null`, never `0` and never an estimate presented as a
  measurement.
- A savings claim the measurement does not support. See the rules in
  [docs/savings-methodology.md](docs/savings-methodology.md); a `tokens × turns` multiplier in
  particular is rejected on the record.

## Tests

```bash
npm test                 # unit + integration
npm run evals            # deterministic benchmark: offline, keyless, reproducible
npm run evals:sweep      # the same, plus the threshold sweep
npm run validate         # claude plugin validate --strict on all three manifests
npm run smoke:hook       # drives the REAL hook against a REAL worker. Needs one running.
```

`npm test` must stay offline and keyless. If a test needs a provider, use the `mock` provider
behind an injected `fetchImpl`, or `test/helpers/provider-server.mjs` on loopback.

Structural claims go in an `*.isolation.test.mjs` suite and are enforced by inspecting source, not
by convention. When you write one, make sure the **file census** is asserted too: a scan over a
stale file list passes by scanning nothing, which is the one way these tests fail silently.

## Style

- ESM `.mjs`, no transpile, no build step.
- Enums are **open on read**: an unknown value is preserved and bucketed as `other`, never rejected.
  The one exception is an eval case's `expected` block, which is closed — an open enum on an
  expectation makes it unfalsifiable.
- Comments explain **why**, especially where the obvious thing was tried and rejected. Several
  decisions here are counter-intuitive and the reasoning is the only thing stopping someone
  "fixing" them.

## Commits and pull requests

Explain the problem before the change. Many of these decisions look wrong without the measurement
that forced them, so if a change is driven by something you observed, put the observation in the
message.

Both platforms must be green. CI runs the full suite on Linux, Windows and macOS, and a
reproducibility check that two runs produce byte-identical output.
