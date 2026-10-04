# Example configuration

Every file here is a template. Nothing in this directory is read by the router — copy the one you
want to a path the loader actually looks at.

## Which file, and where it goes

| File | Copy to | What it shows |
| --- | --- | --- |
| [`model-router.json`](model-router.json) | `<project>/.claude/model-router.json` | **Start here.** The team-shared defaults: worker, gate threshold, deny list, intent off, conservative telemetry. |
| [`ollama-keyless.json`](ollama-keyless.json) | either config path | A fully local worker. No API key anywhere, nothing leaves the machine. |
| [`gemini.json`](gemini.json) | either config path | A metered hosted worker, with the key referenced by variable name only. |
| [`mixed-lanes.json`](mixed-lanes.json) | either config path | Bulk reading locally for free, boilerplate on a hosted model. |
| [`governance.json`](governance.json) | either config path | Budgets, and what each scope can actually enforce. |
| [`telemetry-privacy.json`](telemetry-privacy.json) | either config path | Exactly what is recorded, and the privacy ladder. |
| [`pricing-overrides.json`](pricing-overrides.json) | `<project>/.claude/model-router-pricing.json` | A pricing table — **not** a router config. The target of `pricing.overrides`. |

The examples are not meant to be combined wholesale. Take the blocks you need from several into one
`model-router.json`; the loader reads one file per layer, not a directory.

## The two paths the loader reads

Exactly two, and no others:

```
~/.claude/model-router/config.json      per developer, never committed
<project>/.claude/model-router.json     per project, commit this
```

There is **no upward directory walk**, no `CMR_CONFIG_FILE` escape hatch, and no other filename.
A file named `model-router.project.json`, or one sitting in your project root rather than under
`.claude/`, is silently ignored — nothing warns, because nothing looked for it.

## Precedence, lowest to highest

```
bundled defaults
  -> ~/.claude/model-router/config.json      (per developer)
  -> <project>/.claude/model-router.json     (per project, committed)
  -> CMR_* environment variables             (so CI can always win)
  -> plugin options                          (/plugin configure, or --config KEY=VALUE)
```

Arrays **replace, they do not merge**. Setting `routing.denyGlobs` in a project file discards the
built-in list entirely rather than adding to it, which is why `model-router.json` repeats all nine
shipped defaults before adding its own. Deleting a line from that list turns a protection off for
everybody who uses the file.

An invalid value never throws and never blocks a session: the leaf falls back to its default and
`npm run doctor` reports it. An unknown field is kept and reported as a probable typo.

## Configuration versus secrets

**No example here contains a secret, and none can.** There is no config field that holds an API
key. A key is named by the variable that holds it, and the value is read from the environment at
call time:

```jsonc
"worker": { "apiKeyEnv": "GEMINI_API_KEY" }   // the NAME, never the key
```

Two rules follow, and both have caught people out:

1. **Config values are never interpolated.** `"${GEMINI_API_KEY}"` is read as that literal
   19-character string, not as the variable's value. The same goes for `$KEY` and `%KEY%`.
   `npm run doctor` detects all three shapes by name and says so, because the failure otherwise
   looks like an authentication error.

2. **Set the variable where Claude Code will see it.**

   ```powershell
   setx GEMINI_API_KEY "your-key"     # Windows: writes the user environment,
                                      # NOT the current shell. Restart Claude Code.
   ```

   ```bash
   export GEMINI_API_KEY=your-key     # macOS/Linux: add it to your shell profile to persist
   ```

A committed `model-router.json` is therefore safe to put in a public repository. A telemetry store
is a different question — see [`docs/telemetry-schema.md`](../docs/telemetry-schema.md) for what a
row can contain before you share a report.

## Checking your work

```bash
npm run doctor        # what resolved, from which layer, and what is missing
```

Doctor prints the resolved worker and lists every setting that came from somewhere other than the
bundled defaults, which is the fastest way to find a file that is being ignored: if your change is
not in that list, the loader never read it.

Every file in this directory is parsed and resolved by `test/examples.test.mjs`, which fails on a
single configuration warning — so an example cannot drift out of step with the schema.
