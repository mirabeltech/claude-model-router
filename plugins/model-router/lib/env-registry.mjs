/**
 * Every environment variable this project reads that `SPEC` does not already own.
 *
 * WHY A SECOND TABLE. `SPEC` in config.mjs declares a `CMR_*` variable for 76 of its 77 settings,
 * and that is the right home for anything that IS a setting. The names below are deliberately not
 * settings: a secret whose variable NAME is itself configurable, a path Claude Code hands us, a
 * kill switch, a test fixture's channel. Adding them to SPEC would make `resolveConfig` claim to
 * own values it does not.
 *
 * WHY A MODULE RATHER THAN A MARKDOWN TABLE. A test that compares behaviour against prose has to
 * parse prose, and the first reflow breaks it for a reason that has nothing to do with
 * correctness. This is machine-truth; `docs/environment.md` is generated FROM it.
 *
 * The contract `test/env.inventory.test.mjs` enforces, in both directions: every name read under
 * `plugins/` is either a SPEC variable or declared here, and every name declared here is actually
 * read by the files it claims. An undocumented read fails; so does a stale entry.
 *
 * Pure: no node builtin, no I/O.
 */

/** What kind of thing a variable is, which decides how it is documented and who may read it. */
export const ENV_CLASSES = Object.freeze([
  'claude-code', // set by Claude Code for a hook or a command
  'provider-secret', // a credential; the name may itself be configurable
  'side-channel', // a switch with no SPEC entry, on purpose
  'convention', // a cross-tool convention we honour rather than define
  'os', // supplied by the operating system or Node itself
  'test-only', // read only by the test harness; never by a shipped code path
])

export const ENV_REGISTRY = Object.freeze({
  /* ----------------------------------------------------------- credentials */

  GEMINI_API_KEY: Object.freeze({
    purpose:
      'The Gemini API key. Read at call time and never stored in config; doctor reports only its presence, length and first four characters.',
    class: 'provider-secret',
    required: 'only when a lane resolves to the gemini provider',
    secret: true,
    default: null,
    precedence: 'read directly from the environment; no config layer can supply it',
    subsystem: 'providers',
    readers: ['plugins/model-router/lib/providers/gemini.mjs'],
    note:
      'THE NAME IS NOT FIXED. `worker.apiKeyEnv` and `workers.<lane>.apiKeyEnv` make it a config value, so the set of credential variables this project may read is open-ended by design. This entry documents the default, and the test pins the MECHANISM rather than the name.',
  }),

  MOCK_WORKER_URL: Object.freeze({
    purpose:
      'Base URL for the mock provider, which is how the evals and several tests run a full dispatch offline and keyless against a loopback server.',
    class: 'test-only',
    required: 'only when the mock provider is selected',
    secret: false,
    default: null,
    precedence: 'read directly; `providers.mock.baseUrl` takes priority when set',
    subsystem: 'providers',
    readers: ['plugins/model-router/lib/providers/mock.mjs'],
    note:
      'Ships inside the plugin rather than in test code, because the mock is a real registered provider: that is what lets the offline benchmark exercise the same dispatch path as a hosted one.',
  }),

  MOCK_SCENARIO: Object.freeze({
    purpose:
      'Selects a canned mock-provider behaviour (a refusal, a timeout, a malformed usage block) so failure paths can be driven without a live provider.',
    class: 'test-only',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'read directly',
    subsystem: 'providers',
    readers: ['plugins/model-router/lib/providers/mock.mjs'],
  }),

  /* --------------------------------------------------- supplied by the host */

  CLAUDE_PROJECT_DIR: Object.freeze({
    purpose:
      'The project root, used to locate <project>/.claude/model-router.json and to resolve a read path against the project rather than the process working directory.',
    class: 'claude-code',
    required: 'no',
    secret: false,
    default: 'process.cwd()',
    precedence: 'consulted before falling back to the working directory',
    subsystem: 'config, hook',
    readers: [
      'plugins/model-router/lib/config.mjs',
      'plugins/model-router/lib/hook/adapter.mjs',
    ],
  }),

  CLAUDE_PLUGIN_ROOT: Object.freeze({
    purpose:
      'The installed plugin directory. Substituted by Claude Code into the hook command in hooks.json, which is the only supported way to name the hook script.',
    class: 'claude-code',
    required: 'yes, for the hook to run at all',
    secret: false,
    default: null,
    precedence: 'substituted by Claude Code before the hook process starts',
    subsystem: 'hook',
    readers: ['plugins/model-router/hooks/hooks.json'],
    note:
      'Never read through `process.env` by us. Doctor reconstructs the same path from its own location and checks that the substitution would resolve to a file that exists, because a hook script Claude Code cannot find is the failure mode with no symptom.',
  }),

  CLAUDE_SESSION_ID: Object.freeze({
    purpose:
      'Identifies the session a telemetry row belongs to, so delegations can be grouped by session without storing anything about its content.',
    class: 'claude-code',
    required: 'no',
    secret: false,
    default: 'a per-process fallback id',
    precedence: 'read directly; hashed before it reaches a row',
    subsystem: 'telemetry',
    readers: ['plugins/model-router/lib/telemetry/index.mjs'],
    note:
      'Whether Claude Code sets this for a hook process is not something this project can assert, so the code treats absence as normal and falls back rather than failing.',
  }),

  /* -------------------------------------------------------- side channels */

  CLAUDE_ROUTER_TELEMETRY: Object.freeze({
    purpose:
      'Kill switch for the telemetry write path. Set it to 0/false/off to stop rows being written without touching configuration.',
    class: 'side-channel',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'overrides telemetry.enabled',
    subsystem: 'telemetry',
    readers: ['plugins/model-router/lib/telemetry/index.mjs'],
    note:
      'Deliberately has no SPEC entry: it is an emergency stop, and a setting that can only be reached by editing a file is not an emergency stop. A test pins that exactly one module reads it.',
  }),

  NO_COLOR: Object.freeze({
    purpose: 'Suppresses ANSI escapes in every command, honouring the cross-tool convention.',
    class: 'convention',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'any non-empty value disables colour, as does --no-color or a non-TTY stream',
    subsystem: 'cli',
    readers: [
      'plugins/model-router/lib/cli.mjs',
      'plugins/router-dashboard/scripts/report.mjs',
    ],
  }),

  /* ------------------------------------------------- operating system / node */

  HOME: Object.freeze({
    purpose:
      'The home directory, which is where the per-developer config and the default telemetry and governance directories live.',
    class: 'os',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'read by Node through os.homedir(), not by name on POSIX',
    subsystem: 'config',
    readers: ['test/helpers/hook-payload.mjs'],
    note:
      'Named here because the test harness sets it to redirect a child away from the developer’s real ~/.claude. On Windows os.homedir() reads USERPROFILE instead, so both must be set to isolate a child on either platform.',
  }),

  USERPROFILE: Object.freeze({
    purpose: 'The Windows home directory. The counterpart to HOME.',
    class: 'os',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'read by Node through os.homedir() on Windows',
    subsystem: 'config',
    readers: ['test/helpers/hook-payload.mjs', 'test/task.security.test.mjs'],
  }),

  PATH: Object.freeze({
    purpose: 'Passed through to spawned child processes so the Node executable can be found.',
    class: 'os',
    required: 'yes, for any spawned child',
    secret: false,
    default: null,
    precedence: 'inherited',
    subsystem: 'test harness',
    readers: [
      'test/analytics.cli.test.mjs',
      'test/dashboard.cli.test.mjs',
      'test/doctor.test.mjs',
      'test/helpers/hook-payload.mjs',
    ],
  }),

  SystemRoot: Object.freeze({
    purpose: 'Required for a Node child process to start on Windows, so it is forwarded explicitly.',
    class: 'os',
    required: 'yes on Windows, for any spawned child',
    secret: false,
    default: null,
    precedence: 'inherited',
    subsystem: 'test harness',
    readers: [
      'test/analytics.cli.test.mjs',
      'test/dashboard.cli.test.mjs',
      'test/doctor.test.mjs',
      'test/helpers/hook-payload.mjs',
    ],
    note:
      'The reason the test helpers CONSTRUCT a child environment rather than spreading process.env: a constructed environment proves the child inherited nothing from the developer, but it has to carry the handful of variables without which Node will not launch.',
  }),

  TEMP: Object.freeze({
    purpose: 'Scratch directory for corpus generation.',
    class: 'os',
    required: 'no',
    secret: false,
    default: 'os.tmpdir()',
    precedence: 'read directly',
    subsystem: 'evals',
    readers: ['test/evals/bin/build-corpus.mjs'],
  }),

  /* ------------------------------------------------------------- test-only */

  CMR_TEST_WRITER: Object.freeze({
    purpose:
      'Payload for the JSONL writer child, which proves concurrent appends stay intact under real contention from separate processes.',
    class: 'test-only',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'read directly by the child',
    subsystem: 'test harness',
    readers: ['test/helpers/jsonl-writer-child.mjs'],
    note:
      'CMR_-prefixed but NOT a setting: it carries a test payload, not configuration, and has no SPEC entry.',
  }),

  CMR_TEST_BUDGET_WRITER: Object.freeze({
    purpose:
      'Payload for the budget ledger child, which proves the exclusive-create lock serialises mutations across processes.',
    class: 'test-only',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'read directly by the child',
    subsystem: 'test harness',
    readers: ['test/helpers/budget-writer-child.mjs'],
  }),

  ROUTER_PERF_FULL: Object.freeze({
    purpose:
      'Enables the 100k-row analytics performance case, which is skipped by default because it is slow enough to be a nuisance on every run.',
    class: 'test-only',
    required: 'no',
    secret: false,
    default: null,
    precedence: 'read directly',
    subsystem: 'test harness',
    readers: ['test/analytics.performance.test.mjs'],
    note: 'This is the one deliberately skipped test in the suite.',
  }),
})

/**
 * Read sites where the variable NAME is computed, so no static scan can name it.
 *
 * Declared rather than discovered: a computed read is exactly where an undocumented variable
 * would hide, so each site is listed with the reason it has to be dynamic. The test asserts the
 * set of such sites matches this table, which turns "somebody added a dynamic read" into a
 * failing build.
 */
export const DYNAMIC_READ_SITES = Object.freeze([
  Object.freeze({
    file: 'plugins/model-router/lib/config.mjs',
    reason:
      'Walks SPEC and reads `env[spec.env]` for each setting, plus the derived CLAUDE_PLUGIN_OPTION_<FIELD> name. Both names come from SPEC, so they are documented by the generated reference rather than here.',
  }),
  Object.freeze({
    file: 'plugins/model-router/lib/providers/contract.mjs',
    reason:
      'Checks each name in a provider’s `requiresEnv` list to decide readiness. The list belongs to the provider module.',
  }),
  Object.freeze({
    file: 'plugins/model-router/lib/providers/gemini.mjs',
    reason: 'Reads the key from whichever variable `apiKeyEnv` names, which is a config value.',
  }),
  Object.freeze({
    file: 'plugins/model-router/lib/providers/index.mjs',
    reason: 'Resolves readiness for a provider by the same configurable key name.',
  }),
  Object.freeze({
    file: 'plugins/model-router/scripts/doctor.mjs',
    reason:
      'Reports presence of whichever key variable each lane actually wants, which is why it can catch a key that is set but empty or unexpanded.',
  }),
])

/**
 * Literal reads of a SPEC variable outside config.mjs.
 *
 * The convention is that a `CMR_*` name appears in exactly one place, so the layering stays
 * testable. This is the declared exception, listed so it cannot grow silently.
 */
export const SPEC_ENV_EXCEPTIONS = Object.freeze({
  'plugins/model-router/scripts/smoke-hook.mjs': Object.freeze(['CMR_TASK_INTENT_SOURCE']),
})

/** Every non-SPEC variable name this project may read. */
export function declaredEnvNames() {
  return Object.keys(ENV_REGISTRY).sort()
}
