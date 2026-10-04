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
