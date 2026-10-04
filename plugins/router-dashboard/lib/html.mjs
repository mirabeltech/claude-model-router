/**
 * HTML primitives and the stylesheet, as pure string functions.
 *
 * EVERY INTERPOLATED VALUE GOES THROUGH `escapeHtml`. A telemetry store holds provider names,
 * model ids and error codes that came from a remote service, and a model id is a perfectly good
 * place to hide a `<script>` tag. The report is a local file the developer opens in a browser, so
 * an injected tag would execute with whatever the browser grants a file URL — and the fix costs
 * one function call per value.
 *
 * NO `node:` IMPORT, HERE OR ANYWHERE UNDER `lib/`. That is the strongest available statement
 * that the renderer cannot read a store, cannot spawn and cannot write: it is a string function
 * from a response to a document. `scripts/` owns every byte of I/O.
 *
 * THE STYLESHEET IS INLINE AND SO IS EVERYTHING ELSE. One self-contained file, no network
 * request, no CDN, no npm dependency — the report has to open on a machine with no internet and
 * stay readable in a year.
 */

/** The five characters that can change the meaning of a document. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** An attribute value. Same escaping, named separately so call sites read correctly. */
export const attr = escapeHtml

export const STYLE = `
:root {
  --bg: #0f1115;
  --panel: #171a21;
  --panel-2: #1d212a;
  --line: #2a2f3a;
  --text: #e6e8ee;
  --dim: #9aa3b2;
  --dimmer: #6b7383;
  --measured: #4ea1ff;
  --estimated: #c9a227;
  --unknown: #6b7383;
  --bad: #e5534b;
  --good: #3fb950;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
header h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
header .meta { color: var(--dim); font-size: 13px; }
header .meta code { color: var(--text); }
h2 {
  margin: 40px 0 12px;
  font-size: 15px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--dim);
  border-bottom: 1px solid var(--line);
  padding-bottom: 8px;
}
h3 { margin: 24px 0 8px; font-size: 13px; font-weight: 600; color: var(--dim); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
.card .label { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.card .value { font-size: 22px; font-weight: 600; margin: 6px 0 4px; word-break: break-word; }
.card .value.unknown { color: var(--unknown); font-size: 16px; font-weight: 500; }
.card .sub { color: var(--dim); font-size: 12px; }
.card .sub.warn { color: var(--estimated); }
.badge {
  display: inline-block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--line);
  color: var(--dim);
  vertical-align: 2px;
}
.badge.measured { color: var(--measured); border-color: var(--measured); }
.badge.estimated { color: var(--estimated); border-color: var(--estimated); }
.badge.unknown { color: var(--unknown); }
.badge.mixed { color: var(--estimated); border-color: var(--line); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.note { color: var(--dim); font-size: 12.5px; margin: 10px 0 0; }
.note strong { color: var(--text); }
.callout {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--estimated);
  border-radius: 6px;
  padding: 12px 14px;
  margin: 12px 0;
  color: var(--dim);
  font-size: 13px;
}
.callout.bad { border-left-color: var(--bad); }
.callout strong { color: var(--text); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left;
  color: var(--dim);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.null { color: var(--unknown); }
td.key { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.sentinel { color: var(--dim); font-style: italic; }
.chart { margin: 8px 0 0; }
.chart svg { display: block; max-width: 100%; height: auto; }
.chart .caption { color: var(--dim); font-size: 12px; margin-top: 6px; }
.chart .caption.small { color: var(--estimated); }
.bar-label { fill: var(--dim); font-size: 11px; }
.bar-value { fill: var(--text); font-size: 11px; font-variant-numeric: tabular-nums; }
.axis { stroke: var(--line); stroke-width: 1; }
.bar { fill: var(--measured); }
.bar.estimated { fill: var(--estimated); }
.zero-stub { fill: var(--dimmer); }
.gap-rule { stroke: var(--dimmer); stroke-width: 1; stroke-dasharray: 2 3; }
.line { fill: none; stroke: var(--measured); stroke-width: 2; }
.dot { fill: var(--measured); }
dl.kv { margin: 0; display: grid; grid-template-columns: minmax(180px, max-content) 1fr; gap: 6px 16px; }
dl.kv dt { color: var(--dim); }
dl.kv dd { margin: 0; }
dl.kv dd.null { color: var(--unknown); }
ul.reasons { margin: 8px 0 0; padding-left: 18px; color: var(--dim); font-size: 12.5px; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--dimmer); font-size: 12px; }
footer code { color: var(--dim); }
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #ffffff;
    --panel: #f7f8fa;
    --panel-2: #eef0f4;
    --line: #d9dde5;
    --text: #15181d;
    --dim: #5b6472;
    --dimmer: #8b93a1;
    --measured: #0b63c5;
    --estimated: #8a6d00;
    --unknown: #8b93a1;
    --bad: #c3352c;
    --good: #1a7f37;
  }
}
`

/** A section heading. */
export const h2 = (text) => `<h2>${escapeHtml(text)}</h2>`

/** A labelled card. `kind` drives the badge and the muted styling of an unknown. */
export function card({ label, value, sub = null, badge = null, unknown = false, warn = false }) {
  const badgeHtml = badge === null ? '' : ` <span class="badge ${attr(badge)}">${escapeHtml(badge)}</span>`
  const subHtml =
    sub === null ? '' : `<div class="sub${warn ? ' warn' : ''}">${escapeHtml(sub)}</div>`
  return [
    '<div class="card">',
    `<div class="label">${escapeHtml(label)}${badgeHtml}</div>`,
    `<div class="value${unknown ? ' unknown' : ''}">${escapeHtml(value)}</div>`,
    subHtml,
    '</div>',
  ].join('')
}

export const cards = (items) => `<div class="cards">${items.join('')}</div>`

/** A definition list, for a short set of labelled facts. */
export function kvList(rows) {
  const body = rows
    .map(
      ([k, v, isNull = false]) =>
        `<dt>${escapeHtml(k)}</dt><dd${isNull ? ' class="null"' : ''}>${escapeHtml(v)}</dd>`,
    )
    .join('')
  return `<dl class="kv">${body}</dl>`
}

/**
 * A table. Each cell is `{text, numeric, isNull, sentinel}` or a bare string.
 *
 * `isNull` styles the cell as an unknown rather than as a value, so a column of numbers with one
 * gap in it reads as a gap.
 */
export function table(headers, rows) {
  const head = headers
    .map((h) => {
      const label = typeof h === 'string' ? h : h.text
      const numeric = typeof h === 'object' && h.numeric
      return `<th${numeric ? ' class="num"' : ''}>${escapeHtml(label)}</th>`
    })
    .join('')
  const body = rows
    .map((cells) => {
      const tds = cells
        .map((cell) => {
          const c = typeof cell === 'object' && cell !== null ? cell : { text: cell }
          const classes = []
          if (c.numeric) classes.push('num')
          if (c.isNull) classes.push('null')
          if (c.key) classes.push('key')
          const cls = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
          const inner = c.sentinel
            ? `<span class="sentinel">${escapeHtml(c.text)}</span>`
            : escapeHtml(c.text)
          return `<td${cls}>${inner}</td>`
        })
        .join('')
      return `<tr>${tds}</tr>`
    })
    .join('')
  return `<div class="panel"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

export const note = (text) => `<p class="note">${escapeHtml(text)}</p>`

export const callout = (text, { bad = false } = {}) =>
  `<div class="callout${bad ? ' bad' : ''}">${escapeHtml(text)}</div>`

export const panel = (inner) => `<div class="panel">${inner}</div>`

/**
 * Wrap the body in a complete, self-contained document.
 *
 * `lang`, a viewport meta and an explicit background are all here so the file is legible on a
 * phone and in both colour schemes without anyone having to configure anything.
 */
export function doc({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`
}
