/**
 * The router version stamped on the COMMITTED telemetry fixtures.
 *
 * Deliberately frozen, and deliberately not imported from the engine. A row's `router_version` is
 * DATA ABOUT THE PAST — the version of the router that wrote that event — not a statement about
 * this build. The segments under `test/fixtures/telemetry/` all carry `0.1.0`, and two CI steps
 * compare analytics and report output byte for byte across runs. Importing `ROUTER_VERSION` here
 * would make every synthetic row follow the next release bump while the committed fixtures stayed
 * behind, so the helpers and the fixtures would silently disagree.
 *
 * If this ever needs to change, the committed fixtures change with it, on purpose, in the same
 * commit. The property that actually matters — that a row whose version differs from the running
 * build is still read and aggregated normally — is asserted separately rather than assumed.
 */
export const FIXTURE_ROUTER_VERSION = '0.1.0'

/**
 * The Claude Code version this project's HOST CONTRACT was verified against.
 *
 * `docs/claude-code-hook-contract.md` is read out of the installed binary and observed in live
 * sessions rather than taken from published documentation, so it is only true of a version. That
 * version is named in six places — the contract document, `docs/install.md`'s dated verification,
 * `docs/worker-task-construction.md`, two comments in `hook.security.test.mjs` and one in
 * `intent.extraction.test.mjs` — and before phase 12 nothing kept them in step. Bumping five of
 * six and missing one would have failed nothing, leaving a document that claimed verification
 * against a version the tests did not agree with.
 *
 * This is deliberately NOT read from `claude --version` at test time. The CLI is not guaranteed to
 * be installed (`packaging.test.mjs` says so), and more importantly the question is not "what is
 * installed here" but "what was this contract actually checked against" — a fact about a past
 * verification, like `FIXTURE_ROUTER_VERSION` above. Re-verifying is a human act that updates this
 * constant and the documents together.
 *
 * Re-verified 2026-10-04 (phase 12): the installed CLI still reports 2.1.177, so there was no host
 * drift to reconcile.
 */
export const TESTED_CLAUDE_CODE_VERSION = '2.1.177'
