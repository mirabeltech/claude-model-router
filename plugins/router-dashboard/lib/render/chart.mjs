/**
 * Hand-rolled SVG. No chart library, no npm dependency, no network request.
 *
 * THIS IS THE ONLY MODULE IN THE PLUGIN ALLOWED TO READ A NUMERIC VALUE, because drawing requires
 * arithmetic and a `display` string cannot be scaled into a bar width. The exemption is paid for
 * by the three rules below, each of which exists because the obvious implementation of a chart
 * tells a lie about missing data.
 *
 *   1. A NULL POINT IS A GAP, NEVER A ZERO-WIDTH BAR. A bar of width zero is pixel-identical to a
 *      measured zero, so an unpriced call would render exactly like a free one. A null gets no
 *      rect at all, a dashed tick where it would have been, and its name in a list under the
 *      chart.
 *   2. A NULL DAY SPLITS A LINE INTO TWO LINES. A polyline drawn through a gap asserts a
 *      measurement that was never taken — it interpolates a value for a day nobody measured, and
 *      it does so in the most persuasive form available.
 *   3. A MEASURED ZERO GETS A VISIBLE STUB. Ollama at a configured rate of $0.0000 has genuinely
 *      cost nothing, and that is a finding; it must not look like the absence of a finding.
 *
 * And a fourth rule about what is NOT drawn: below `MIN_TREND_POINTS` the chart renders its points
 * and states that the sample is too small, with no slope, no arrow and no direction word anywhere.
 */

import { escapeHtml } from '../html.mjs'
import { count, fmt } from '../format.mjs'

/** Below this many points, no direction is ever stated. Mirrors the engine's own threshold. */
export const MIN_TREND_POINTS = 7

const PLOT_W = 1040
const ROW_H = 22
const PAD_LEFT = 196
const PAD_RIGHT = 108

/**
 * A horizontal bar chart.
 *
 * @param {object} opts
 * @param {Array<{label: string, value: number|null, display: string, measured?: boolean}>} opts.points
 * @param {string} [opts.caption]
 */
export function barChart({ points, caption = null, title = 'chart' }) {
  const rows = Array.isArray(points) ? points : []
  if (rows.length === 0) {
    return `<div class="chart"><p class="caption">no measured data in this window</p></div>`
  }

  const plottable = rows.filter((p) => typeof p.value === 'number' && Number.isFinite(p.value))
  const unmeasured = rows.filter((p) => !(typeof p.value === 'number' && Number.isFinite(p.value)))
  const max = plottable.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0)

  // Nothing plottable: do NOT draw an empty axis. An axis with no marks on it reads as a
  // measurement whose answer was zero.
  if (plottable.length === 0) {
    return [
      '<div class="chart">',
      `<p class="caption">no measured data in this window (${rows.length} ${rows.length === 1 ? 'series' : 'series'} unmeasured)</p>`,
      '</div>',
    ].join('')
  }

  const barW = PLOT_W - PAD_LEFT - PAD_RIGHT
  const height = rows.length * ROW_H + 8
  const parts = []

  rows.forEach((p, i) => {
    const y = i * ROW_H + 4
    const label = String(p.label).slice(0, 34)
    parts.push(
      `<text class="bar-label" x="0" y="${y + 14}">${escapeHtml(label)}</text>`,
    )

    const value = typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : null
    if (value === null) {
      // Rule 1: a dashed tick, not a bar. A zero-width rect would be indistinguishable from a
      // measured zero at every zoom level.
      parts.push(`<line class="gap-rule" x1="${PAD_LEFT}" y1="${y + 3}" x2="${PAD_LEFT}" y2="${y + 17}" />`)
      parts.push(`<text class="bar-value" x="${PAD_LEFT + 8}" y="${y + 14}">NULL</text>`)
      return
    }

    if (value === 0) {
      // Rule 3: a measured zero is a finding and gets a visible mark of its own.
      parts.push(`<rect class="zero-stub" x="${PAD_LEFT}" y="${y + 5}" width="2" height="12" />`)
    } else {
      const w = max === 0 ? 0 : Math.max(2, Math.round((Math.abs(value) / max) * barW))
      const cls = p.measured === false ? 'bar estimated' : 'bar'
      parts.push(`<rect class="${cls}" x="${PAD_LEFT}" y="${y + 5}" width="${w}" height="12" />`)
    }
    parts.push(
      `<text class="bar-value" x="${PAD_LEFT + barW + 8}" y="${y + 14}">${escapeHtml(p.display ?? fmt(value))}</text>`,
    )
  })

  const captionParts = []
  if (caption !== null) captionParts.push(caption)
  if (unmeasured.length > 0) {
    // Named, not merely counted: "which of these is unmeasured" is the question an operator asks
    // next, and the answer is already here.
    const names = unmeasured.map((p) => p.label).slice(0, 6).join(', ')
    const more = unmeasured.length > 6 ? ` and ${unmeasured.length - 6} more` : ''
    captionParts.push(`unmeasured: ${names}${more} (${unmeasured.length} of ${rows.length})`)
  }

  return [
    '<div class="chart">',
    `<svg viewBox="0 0 ${PLOT_W} ${height}" role="img" aria-label="${escapeHtml(title)}">`,
    `<title>${escapeHtml(title)}</title>`,
    parts.join(''),
    '</svg>',
    captionParts.length > 0 ? `<p class="caption">${escapeHtml(captionParts.join(' · '))}</p>` : '',
    '</div>',
  ].join('')
}

/**
 * A daily line chart.
 *
 * @param {object} opts
 * @param {Array<{label: string, value: number|null}>} opts.points  one per axis day, in order
 */
export function lineChart({ points, caption = null, title = 'trend', unit = '' }) {
  const rows = Array.isArray(points) ? points : []
  if (rows.length === 0) {
    return '<div class="chart"><p class="caption">no measured data in this window</p></div>'
  }

  const values = rows.map((p) => (typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : null))
  const present = values.filter((v) => v !== null)
  if (present.length === 0) {
    return '<div class="chart"><p class="caption">no measured data in this window</p></div>'
  }

  const W = 1040
  const H = 160
  const left = 56
  const bottom = 28
  const top = 10
  const max = Math.max(...present, 0)
  const min = Math.min(...present, 0)
  const span = max - min === 0 ? 1 : max - min
  const stepX = rows.length === 1 ? 0 : (W - left - 16) / (rows.length - 1)
  const x = (i) => left + i * stepX
  const y = (v) => top + (1 - (v - min) / span) * (H - top - bottom)

  // Rule 2: each RUN of consecutive measured points is its own polyline. A single polyline
  // through a gap would draw a straight line across a day nobody measured.
  const runs = []
  let current = []
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 0) runs.push(current)
      current = []
      return
    }
    current.push([x(i), y(v)])
  })
  if (current.length > 0) runs.push(current)

  const parts = []
  parts.push(`<line class="axis" x1="${left}" y1="${H - bottom}" x2="${W - 8}" y2="${H - bottom}" />`)

  for (const run of runs) {
    if (run.length === 1) {
      parts.push(`<circle class="dot" cx="${run[0][0].toFixed(1)}" cy="${run[0][1].toFixed(1)}" r="3" />`)
      continue
    }
    const d = run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
    parts.push(`<polyline class="line" points="${d}" />`)
  }
  // A dashed vertical rule marks each gap, so the break in the line is legible as a gap rather
  // than as a rendering artefact.
  values.forEach((v, i) => {
    if (v !== null) return
    parts.push(`<line class="gap-rule" x1="${x(i).toFixed(1)}" y1="${top}" x2="${x(i).toFixed(1)}" y2="${H - bottom}" />`)
  })

  parts.push(`<text class="bar-label" x="0" y="${y(max) + 4}">${escapeHtml(count(max))}</text>`)
  parts.push(`<text class="bar-label" x="0" y="${H - bottom}">${escapeHtml(count(min))}</text>`)
  const first = rows[0]?.label ?? ''
  const last = rows[rows.length - 1]?.label ?? ''
  parts.push(`<text class="bar-label" x="${left}" y="${H - 8}">${escapeHtml(first)}</text>`)
  parts.push(`<text class="bar-label" x="${W - 8}" y="${H - 8}" text-anchor="end">${escapeHtml(last)}</text>`)

  const captionParts = []
  if (caption !== null) captionParts.push(caption)
  const gaps = values.filter((v) => v === null).length
  if (gaps > 0) captionParts.push(`${gaps} day${gaps === 1 ? '' : 's'} unmeasured — the line is broken, never interpolated`)
  if (unit !== '') captionParts.push(unit)

  const small = trendNote(present.length)
  return [
    '<div class="chart">',
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)}">`,
    `<title>${escapeHtml(title)}</title>`,
    parts.join(''),
    '</svg>',
    small === null ? '' : `<p class="caption small">${escapeHtml(small)}</p>`,
    captionParts.length > 0 ? `<p class="caption">${escapeHtml(captionParts.join(' · '))}</p>` : '',
    '</div>',
  ].join('')
}

/**
 * The sentence to print when a series is too short to carry a trend, or null when it is not.
 *
 * A caller emits a direction indicator ONLY when this returns null. That is the whole mechanism:
 * there is no separate "should I draw an arrow" flag that could drift out of step with the note.
 */
export function trendNote(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'sample size too small to imply a trend (n = 0)'
  if (n >= MIN_TREND_POINTS) return null
  return `sample size too small to imply a trend (n = ${n})`
}
