# Installing

Three supported modes, team setup, upgrading and removal. For the shortest path to a working
delegation, start with [getting-started.md](getting-started.md) instead.

## Requirements

- **Node 22.5 or newer.** CI gates Node 24 on Linux, Windows and macOS, plus Node 22.5.0 on Linux
  to prove the declared floor. Anything else is untested rather than unsupported.
- **No npm dependencies.** Hooks run as `node <script>.mjs`, so there is no `jq` and no Git Bash
  requirement. Nothing is installed.
- **A worker, eventually.** A local [Ollama](https://ollama.com) for a keyless setup, or an API key
  for a hosted provider. **Not needed to install**, and a keyless install is a working Claude Code
  install.

Platform note, stated honestly: the hook contract and the latency figures in these docs were
measured on **Windows 11 with Node 24.16.0**. CI runs the full suite on all three platforms, so
behaviour is *tested* everywhere; the measurements are from one machine.

## Mode A — marketplace (the normal way)

```bash
claude plugin marketplace add mirabeltech/claude-model-router
claude plugin install model-router@claude-model-router
claude plugin install router-dashboard@claude-model-router   # optional, read-only
```

`marketplace add` accepts a GitHub repo, a URL, **or a local directory** — so a clone works without
publishing anything:

```bash
claude plugin marketplace add ./claude-model-router
```

Useful flags:

| Flag | Effect |
| --- | --- |
| `--scope project` | declare it in the project's `.claude/settings.json` instead of your user settings, so the repo carries it |
| `--sparse .claude-plugin plugins` | check out only what is needed, for a consumer who does not want the tests |
| `--config KEY=VALUE` on `install` | set a plugin option without opening a session |

Nothing is copied into your project. Restart Claude Code afterwards — plugins are read at session
start.

Then confirm, from inside a session:

```
/model-router:doctor
```

That slash command exists precisely because a marketplace install has no `npm run doctor`: the
plugin lives under `~/.claude/plugins/` at a path that includes a version directory and is **not a
documented contract**. Do not script against it; use the command.

## Mode B — the dev loop

For working on the plugin. No install, no marketplace, nothing written to your settings:

```bash
claude --plugin-dir ./plugins/model-router -p "read src/big-file.ts and list its exports"
```

`--plugin-dir` takes one directory and is repeatable, so the dashboard needs its own flag — or just
use `npm run report`, which does not need the plugin loaded at all.

## Mode C — repo checkout

For contributors, and for anyone who wants the CLI commands. These need a clone; they are npm
scripts, not plugin components.

```bash
git clone https://github.com/mirabeltech/claude-model-router
cd claude-model-router
npm test          # no network, no API key
npm run doctor
```

There is nothing to build and nothing to install.

## Not supported

Stated so nobody spends an afternoon on it:

- Hand-copying the tree into `~/.claude/plugins/`. Use `marketplace add` with a path.
- `npm install -g`. The package is `private` and publishes nothing.
- Depending on the installed cache path. It contains a version directory and will change.

## Team setup

Two committed files give a teammate a working setup from a clone.

**1. Shared routing policy** — `<project>/.claude/model-router.json`. Holds no secrets and cannot;
see [configuration.md](configuration.md). Start from
[`examples/model-router.json`](../examples/model-router.json).

**2. Pre-advertise the marketplace** — `<project>/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-model-router": {
      "source": { "source": "github", "repo": "mirabeltech/claude-model-router" }
    }
  },
  "enabledPlugins": {
    "model-router@claude-model-router": true
  }
}
```

Rather than hand-writing that, let the CLI produce it:

```bash
claude plugin marketplace add mirabeltech/claude-model-router --scope project
claude plugin install model-router@claude-model-router --scope project
```

Then commit the result. Verified: those are the exact keys the CLI writes, and for a local directory
the source is `{ "source": "directory", "path": "..." }` instead.

**Not verified:** whether a teammate opening the repo is *prompted* to fetch and install, or whether
they must still run `claude plugin install` once themselves. Treat the committed settings as making
the marketplace **known**, and tell your team to run the install line. Trusting and installing
third-party code is a decision a developer should make deliberately in any case.

## Secrets, for a team

Keys go in each developer's **environment**, never in a committed file. There is no config field
that holds one — see [configuration.md](configuration.md#configuration-versus-secrets).

For CI, set `CMR_*` variables: they override both config files, which is how a pipeline pins
behaviour regardless of what a developer committed. Every variable is listed in
[environment.md](environment.md).

## Upgrading

```bash
claude plugin marketplace update claude-model-router
claude plugin update model-router@claude-model-router
```

Restart Claude Code to apply. Releases are tagged `model-router--v<version>`; the version is a
single number shared by both plugins and stamped on every telemetry row, so a report always says
which build produced it.

Telemetry rows carry their own `schema_version`, and a reader accepts a row written by any router
version — so upgrading never invalidates the store you already have.

## Removing it

```bash
claude plugin uninstall model-router@claude-model-router
claude plugin marketplace remove claude-model-router
```

To disable without uninstalling:

| How | Effect |
| --- | --- |
| `claude plugin disable model-router@claude-model-router` | the plugin does not load |
| `CMR_ENABLED=0` | loaded, but the gate allows every read |
| `CMR_HOOKS_ENABLED=0` | nothing is intercepted |
| `CLAUDE_ROUTER_TELEMETRY=0` | routing continues; nothing is recorded |

Uninstalling leaves your telemetry and governance directories under `~/.claude/model-router/`.
Delete them by hand if you want them gone.

## See also

- [getting-started.md](getting-started.md) — the shortest path to a working delegation
- [providers.md](providers.md) — Ollama and Gemini setup
- [doctor.md](doctor.md) — what the diagnostic checks, and its exit codes
- [troubleshooting.md](troubleshooting.md) — when the plugin does not load
