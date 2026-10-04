# Troubleshooting

Start with `npm run doctor`, or `/model-router:doctor` from a marketplace install. It checks almost
everything on this page and writes nothing.

**Nothing here tells you to disable a safety check to make the system work.** A deny glob, a context
refusal or a budget denial that fires is the system working. If one fires when it should not, the
fix is to change the configuration deliberately, not to turn the check off.

**One thing worth internalising before you debug anything:** the routing gate fails open on every
branch. Almost every failure below ends with "the read goes to Claude as normal" — so the usual
symptom of a broken router is not an error, it is *silence*. That is by design, and it is also why
the only reliable way to tell "not delegating" from "not installed" is doctor.

---

## The plugin is not loading

**Symptom.** `/model-router:doctor` is not offered, the plugin is absent from `/plugin`, and no read
is ever intercepted.

**Cause.** Not installed, installed but disabled, or a manifest the loader rejected.

**Check.**
```bash
claude plugin list
claude plugin validate ./plugins/model-router --strict    # from a clone
```

**Resolution.** Install it, or enable it with `claude plugin enable model-router@claude-model-router`.
If `validate` reports a path that does not exist, a declared `skills`/`commands` directory is
missing — the loader treats that as a load failure for the whole plugin. Restart Claude Code after
installing: plugins are read at session start.

**Fallback behaviour.** Claude Code is completely unaffected. Nothing is intercepted and nothing is
recorded.

---

## The hook is not firing

**Symptom.** The plugin is installed, doctor passes, but a large read is never delegated.

**Cause.** Most often the read did not meet the gate's thresholds. Less often `hooks.enabled` is
false, or the hook script cannot be found.

**Check.**
```
/hooks
```
```bash
npm run doctor      # the "Claude Code hook" and "Routing" sections
```
Doctor prints the registered matcher, confirms the script exists at the substituted
`${CLAUDE_PLUGIN_ROOT}` path, and shows the thresholds the gate will actually apply.

**Resolution.** Confirm the file is genuinely large enough — the default needs **350+ lines or
12,000+ bytes**. A targeted read (`Read` with a line range) and a recently-edited file are never
delegated, on purpose. If the script is reported missing, reinstall; a hook script Claude Code
cannot find is the failure mode with no symptom, because the hook simply never runs.

**Fallback behaviour.** Every read proceeds normally.

---

## The worker is unavailable

**Symptom.** Reads are not delegated. Doctor says `provider readiness: NOT ready`.

**Cause.** No key for a provider that wants one, an unreachable daemon, or an unregistered provider
name. Note that `workers.<lane>.provider` accepts any non-empty string, so `"gemnii"` loads without
a single config warning and then fails at the first delegation — doctor's "Worker modes" section is
the only place that is caught.

**Check.** `npm run doctor` — "Worker provider" and "Worker modes".

**Resolution.** Follow the remedy doctor prints; it names the exact variable or setting.

**Fallback behaviour.** The gate declines to delegate and the read goes to Claude as normal. No
session is ever blocked by an unavailable worker.

---

## Ollama is not running

**Symptom.** Doctor warns that the context capability is unknown and mentions `/api/show`. Nothing
is delegated.

**Cause.** The daemon is not listening on `providers.ollama.baseUrl`.

**Check.**
```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```

**Resolution.** `ollama serve`. If it listens elsewhere, set `providers.ollama.baseUrl` — this
plugin does not read Ollama's own `OLLAMA_HOST`.

**Fallback behaviour.** WARN, not FAIL. Capability falls back to the bundled table or `unknown`, and
reads fall open.

---

## The Ollama model is missing

**Symptom.** Doctor resolves the worker but a delegation fails, or capability stays unknown for a
model you expected to be known.

**Cause.** The model has not been pulled. The bundled capability table uses **exact** tag-stripped
lookup, so `qwen2.5-coder:7b` is known while a model you renamed is not.

**Check.** `ollama list`, and compare against `worker.model`.

**Resolution.** `ollama pull qwen2.5-coder:7b`, or point `worker.model` at something you have.

**Fallback behaviour.** The dispatch fails and the read falls open.

---

## GEMINI_API_KEY is missing

**Symptom.** Doctor reports `GEMINI_API_KEY is not set`.

**Cause.** Either you have not chosen a worker yet, or you chose Gemini and the variable is not set
where Claude Code can see it.

**Check.** The *level* tells you which:

- **WARN**, saying "SHIPPED DEFAULT, not a choice you made" — nothing is misconfigured. Gemini is
  simply the default and you have not set up a worker. Exit code 0.
- **FAIL** — you configured Gemini explicitly, so a missing key is a real misconfiguration. Exit 1.

**Resolution.** Either set the key, or switch to a keyless local worker — see
[providers.md](providers.md). On Windows use `setx`, then **restart Claude Code**: `setx` writes the
user environment but not the shell you are standing in, which is why it so often looks like it did
nothing.

If doctor says the key "looks wrong" and mentions a shell expansion, you have set it to the literal
text `$GEMINI_API_KEY`, `%GEMINI_API_KEY%` or `${GEMINI_API_KEY}`. **No config value is ever
interpolated.** Set the variable itself.

**Fallback behaviour.** Reads go to Claude as normal.

---

## Gemini pricing is unavailable

**Symptom.** Token figures appear, but every cost and dollar saving reads "unavailable". A
configured dollar budget never seems to bind.

**Cause.** Not a bug. **Every rate in the bundled pricing table ships `null`**, because published
rates change without notice and a confident wrong dollar figure is worse than a refusal to price.
`NULL` is not `0`.

**Check.** `npm run doctor` — the "Pricing" section lists the unpriced models and prints a
pasteable table skeleton.

**Resolution.** Supply rates from the provider's own page:
```jsonc
{ "pricing": { "source": "file", "overrides": "./.claude/model-router-pricing.json" } }
```
Start from [`examples/pricing-overrides.json`](../examples/pricing-overrides.json).

**Fallback behaviour.** Token savings are still reported and are unaffected. Only monetary figures
are null — and a monetary budget cannot be enforced, which doctor states rather than letting it look
active.

---

## `context_exceeded`

**Symptom.** A delegation is refused with `context_exceeded` and the read falls open.

**Cause.** The prompt provably does not fit the worker's context window. **This is the system
working.** Ollama would otherwise silently drop the middle of the prompt — measured: a 17,368-token
prompt evaluated as 2060 tokens with both end markers intact — and an answer confidently summarising
a file whose middle was discarded is worse than no answer.

**Check.** Doctor's "Worker capability" section shows the window, its provenance, and the effective
input capacity.

**Resolution.** Use a model with a larger window, lower `worker.maxOutputTokens` to leave more room
for input, or let it fall open — a file too big for the worker is a file Claude should read. Do
**not** try to disable the check; there is no setting for it, deliberately.

**Fallback behaviour.** The read proceeds on Claude.

---

## A governance denial

**Symptom.** Delegation stops partway through a session. Analytics shows governance denials.

**Cause.** A configured budget reached its limit. Remember that `null` means no limit and `0` means
a deliberately configured zero budget — if everything stopped immediately, check for a `0`.

**Check.**
```bash
npm run budget      # the limits, the UTC period, and spend so far
```

**Resolution.** Raise or remove the limit, or wait for the UTC period to roll over. Set
`budget.onExceed` to `warn` to record breaches without declining.

**Fallback behaviour.** A denial is a *successful* budget decision, not a router failure. The read
continues on Claude. Never add a denial count to a worker-failure count: they are different events
with different responses.

---

## Telemetry is unavailable

**Symptom.** Delegations happen but analytics reports nothing.

**Cause.** Telemetry disabled, the kill switch set, or an unwritable directory.

**Check.** Doctor's "Telemetry store" and "Analytics" sections. Confirm `CLAUDE_ROUTER_TELEMETRY` is
not set to `0`/`false`/`off`.

**Resolution.** Set `telemetry.enabled` true and point `telemetry.dir` somewhere writable. If doctor
reports **malformed lines** in the store, append atomicity is not holding on that filesystem — which
is a real finding on a network or cloud-synced volume. Set `telemetry.shardByPid: true`, or move the
store to a local disk.

**Fallback behaviour.** Telemetry can never break a hook: the sink swallows every error. Routing is
entirely unaffected, you simply have no record.

---

## The dashboard or report is empty

**Symptom.** `npm run report` produces a complete page with no numbers in it.

**Cause.** Usually that nothing has been delegated yet — an empty store renders a full report by
design, because a fresh install is the most common case and a renderer that special-cased it would
be untested on the path every new user takes first. Otherwise the window excludes your rows, or the
report is reading a different store.

**Check.**
```bash
npm run analytics -- --all        # ignore the window entirely
npm run doctor                    # "Analytics" says how many events exist
```

**Resolution.** Widen the window, or point `CMR_TELEMETRY_DIR` at the right store. Confirm a
delegation has actually happened: `npm run smoke:hook` does one end to end.

**Fallback behaviour.** Read-only throughout. The report never writes to the store.

---

## A Windows file-lock error

**Symptom.** Intermittent `EPERM`, `EACCES` or `EBUSY` around the budget ledger or the telemetry
store, usually under concurrency.

**Cause.** Windows lock contention. The ledger takes an exclusive-create lock, and on Windows the
contention class includes `EPERM` and `EACCES` as well as `EEXIST`. Antivirus and sync clients make
it more likely.

**Check.** Is `telemetry.dir` or `budget.stateDir` on OneDrive, Dropbox, a mapped drive or a UNC
path? Doctor warns when it detects one.

**Resolution.** **Keep both directories on a local disk.** `O_EXCL` creation is not reliably atomic
on SMB, NFS or a sync client, so cross-machine enforcement over a shared `stateDir` does not hold —
doctor cannot detect that and does not claim to. If you must use a synced volume for telemetry, set
`telemetry.shardByPid: true` so each process appends to its own segment.

**Fallback behaviour.** Contention is retried and then surrendered. A lost ledger update means a
bounded budget overshoot, which is the documented residual. Telemetry errors are swallowed entirely.

---

## A worker timeout

**Symptom.** Delegations take a while and then fall open. Analytics shows timeouts.

**Cause.** The model is slower than the deadline. The **hook** deadline is deliberately the tighter
of the two — `worker.timeoutMs` defaults to three minutes, which is a sane ceiling for a script and
an unacceptable one for a tool call someone is waiting on.

**Check.** Doctor prints the effective bound and says which setting produced it.

**Resolution.** Raise `hooks.timeoutMs`, use a faster or smaller model, or lower the gate's
thresholds so less goes to the worker at once. Note that a `worker.timeoutMs` above the HTTP
client's own ceiling cannot be honoured — doctor warns, because the call would be abandoned there
instead.

**Fallback behaviour.** The read falls open after the wait. You lose the time, never the read.

---

## A setting appears to be ignored

**Symptom.** You edited a config file and nothing changed.

**Cause.** Usually the file is not one the loader reads. There are exactly two paths, there is **no
upward directory walk**, and no other filename is recognised — so a file in your project root, or
one named `model-router.project.json`, is silently ignored because nothing looked for it.

**Check.** `npm run doctor` lists every setting that came from somewhere other than the bundled
defaults. **If your change is not in that list, the loader never read it.**

**Resolution.** Move it to `<project>/.claude/model-router.json` or
`~/.claude/model-router/config.json`. Remember that a higher layer may be overriding you: a `CMR_*`
variable beats both files, and a plugin option beats everything. And **arrays replace, they do not
merge** — a partial `denyGlobs` list silently becomes the whole list.

**Fallback behaviour.** The previous value stays in effect.

---

## Reporting a problem

Include the output of:

```bash
npm run doctor -- --json --offline
```

It is safe to paste: no secret is ever printed, only presence, length and a four-character prefix.
`--offline` makes it deterministic by skipping the provider probe.
