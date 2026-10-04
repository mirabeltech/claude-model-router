/**
 * The whole report, as one pure function from an analytics response to an HTML document.
 *
 * It takes the response and nothing else — no store, no filesystem, no clock it did not receive.
 * Together with the rule that no module under `lib/` imports a node builtin, that is the strongest
 * available statement of what this plugin is: a renderer. It cannot read a telemetry store, it
 * cannot write a file, and it cannot change a configuration, because it has no way to do any of
 * those things rather than merely a policy against it.
 *
 * AN EMPTY STORE STILL PRODUCES A COMPLETE REPORT. A fresh install is the most common case there
 * is, and a renderer that special-cased it would be untested on the path every new user takes
 * first. Every section renders; the figures say "no events".
 */

import { doc } from '../html.mjs'
import { SECTION_RENDERERS, footerSection, headerSection } from './sections.mjs'

/** Analytics contract versions this renderer understands. */
export const DASHBOARD_CONTRACT_VERSIONS = Object.freeze([1])

/**
 * Generated from package.json by scripts/sync-version.mjs and re-exported, so `renderReport`'s
 * default parameter and every existing import keep working. It has to be a generated module: no
 * file under this plugin's `lib/` may import a node builtin, so the renderer cannot read its own
 * manifest.
 */
export { DASHBOARD_VERSION } from '../version.mjs'
import { DASHBOARD_VERSION } from '../version.mjs'

/**
 * Render a validated analytics response.
 *
 * @param {object} response            a response that has already passed `acceptResponse()`
 * @param {object} [opts]
 * @param {string} [opts.generatedAt]  the instant to stamp on the page
 * @param {string} [opts.title]
 */
export function renderReport(response, { generatedAt = null, title = null, dashboardVersion = DASHBOARD_VERSION } = {}) {
  const stamp = generatedAt ?? response.request?.generatedAt ?? response.timeRange?.end ?? 'unknown'
  const body = [
    headerSection(response, { generatedAt: stamp }),
    ...SECTION_RENDERERS.map((render) => render(response)),
    footerSection(response, { dashboardVersion }),
  ].join('\n')

  return doc({
    title: title ?? `model-router report — ${response.timeRange?.kind ?? 'window'}`,
    body,
  })
}
