/**
 * One pure function per section of the report.
 *
 * Each takes the analytics response and returns an HTML string. None reads `.value` on an
 * aggregate — that is `chart.mjs`'s single exemption — so every figure here is the `display`
 * string the engine produced through `formatAgg()`.
 *
 * THE FAILURES SECTION RENDERS THREE TABLES AND NO GRAND TOTAL, and that is the one piece of
 * layout in this file that is a correctness requirement rather than a design choice. A budget
 * refusal, a context refusal and an unpriced call are three different events with three different
 * responses, and a single "failures: 9" would be quoted in a standup by the end of the week.
 */

import {
  attr,
  callout,
  card,
  cards,
  escapeHtml,
  h2,
  kvList,
  note,
  panel,
  table,
} from '../html.mjs'
import {
  basisWord,
  count,
  coverageText,
  fmt,
  isLowerBound,
  keyLabel,
  metricText,
  ms,
  percent,
  plural,
  unavailableReason,
} from '../format.mjs'
import { barChart, lineChart, trendNote } from './chart.mjs'

/** A metric as a card, with the badge and the unknown styling chosen from the metric itself. */
function metricCard(label, node, { sub = null } = {}) {
  const badge = basisWord(node)
  const unknown = badge === 'unknown' || badge === 'none'
  const bits = []
  if (sub !== null) bits.push(sub)
  if (isLowerBound(node)) bits.push('a floor, not a total')
  const reason = unavailableReason(node)
  if (reason !== null) bits.push(reason)
  return card({
    label,
    value: metricText(node),
    sub: bits.length > 0 ? bits.join(' · ') : null,
    badge,
    unknown,
    warn: unknown,
  })
}

/* ------------------------------------------------------------------- header */

export function headerSection(response, { generatedAt }) {
  const t = response.timeRange
  return [
    '<header>',
    '<h1>model-router — delegation report</h1>',
    '<p class="meta">',
    `window <code>${escapeHtml(t.kind)}</code> · `,
    `<code>${escapeHtml(t.start ?? 'n/a')}</code> to <code>${escapeHtml(t.end ?? 'n/a')}</code> · `,
    `${escapeHtml(t.timeZone)}, half-open [start, end) · `,
    `${count(t.segmentsExamined)} ${plural(t.segmentsExamined, 'segment')} examined · `,
    `generated <code>${escapeHtml(generatedAt)}</code>`,
    '</p>',
    '</header>',
  ].join('')
}

/* ----------------------------------------------------------------- overview */

export function overviewSection(response) {
  const s = response.summary
  const out = [h2('Overview')]

  out.push(
    cards([
      metricCard('Delegation rate', s.delegationRate, {
        sub: s.delegationRate.caveat === null ? null : s.delegationRate.caveat.replace(/_/g, ' '),
      }),
      metricCard('Worker calls', s.delegations),
      metricCard('Tokens avoided', s.tokensAvoided, { sub: 'net of the answer returned' }),
      metricCard('Worker tokens', s.workerTokens, { sub: 'consumption, not a saving' }),
      metricCard('Estimated net savings', s.netSavings),
      metricCard('Worker cost', s.workerCost),
      card({
        label: 'Cost coverage',
        value: coverageText(s.costCoverage) ?? 'no events',
        sub: 'how much of this window has a known price',
        badge: s.costCoverage.ratio === null || s.costCoverage.ratio === 0 ? 'unknown' : 'measured',
        unknown: s.costCoverage.ratio === null || s.costCoverage.ratio === 0,
      }),
      card({
        label: 'Median worker latency',
        value: ms(response.latency.total.median),
        sub: `p95 ${ms(response.latency.total.p95)} · ${count(response.latency.total.n)} ${plural(response.latency.total.n, 'sample')}`,
        badge: response.latency.total.n === 0 ? 'none' : 'measured',
        unknown: response.latency.total.n === 0,
      }),
    ]),
  )

  // The out-of-the-box state, said plainly. Everything on a default install is unpriced, and a
  // reader who does not know that reads a page of "unavailable" as a broken tool.
  if (s.headlineAvailable === 'tokens_only' && s.events.value > 0) {
    out.push(
      callout(
        'Worker cost is UNKNOWN for this window — and unknown is not zero. No rate in the bundled pricing table is populated, so a default install reports no dollar figure at all. That is a refusal to price, not a missing measurement. Configure pricing.overrides to price these calls; until then the token figures are the measurable ones.',
      ),
    )
  }
  if (s.delegationRate.value === null && s.events.value > 0) {
    out.push(
      callout(
        'No delegation rate can be computed for this window. The denominator is the whole routing-event population, and gate decisions are not present in this store — against delegated calls alone the rate would always be 100%.',
        { bad: true },
      ),
    )
  }
  return out.join('')
}

/* ------------------------------------------------------------------ routing */

export function routingSection(response) {
  const r = response.routing
  const out = [h2('Routing')]

  out.push(
    cards([
      metricCard('Delegated', r.counts.dispatchAttempted),
      metricCard('Gate refused', r.counts.gateRefused),
      metricCard('Governance denied', r.counts.governanceDenied, { sub: 'a decision, not a failure' }),
      metricCard('Success rate', r.successRate, { sub: 'of dispatched calls' }),
    ]),
  )

  out.push('<h3>Delegated versus retained</h3>')
  out.push(
    barChart({
      title: 'routing outcomes',
      points: Object.entries(r.byClass)
        .filter(([, n]) => n > 0)
        .map(([klass, n]) => ({ label: klass, value: n, display: count(n) })),
      caption: 'every row in the window, classified exactly once',
    }),
  )

  out.push('<h3>Top routing reasons</h3>')
  out.push(
    barChart({
      title: 'routing reasons',
      points: r.byReason.buckets.slice(0, 12).map((b) => ({
        label: keyLabel({ key: b.key, label: b.key === '__null__' ? 'unknown' : b.key }),
        value: b.count,
        display: count(b.count),
      })),
    }),
  )

  if (r.counts.approvedNotDispatched.value > 0) {
    out.push(
      callout(
        `${r.counts.approvedNotDispatched.value} ${plural(r.counts.approvedNotDispatched.value, 'call')} was approved by the gate and by governance and then never dispatched. The cause is not recoverable: error_code is null on those rows and no routing reason names them. This is a telemetry gap, reported rather than guessed at.`,
      ),
    )
  }
  return out.join('')
}

/* -------------------------------------------------------- worker performance */

export function workerSection(response) {
  const profiles = response.segments.workerProfile.buckets.filter((b) => b.dispatchAttempted > 0)
  const out = [h2('Worker performance')]

  if (profiles.length === 0) {
    out.push(panel('<p class="note">No worker call was dispatched in this window.</p>'))
    return out.join('')
  }

  const rows = profiles.map((b) => {
    const [provider, model, mode] = b.keyKind === 'value' ? b.key.split(' / ') : [b.label, '—', '—']
    const tokens = b.metrics.workerTokens
    return [
      { text: provider, key: true },
      { text: model, key: true },
      { text: mode, key: true },
      { text: count(b.dispatchAttempted), numeric: true },
      { text: tokens.display, numeric: true, isNull: tokens.value === null },
      { text: count(b.workerFailures), numeric: true },
      { text: count(b.governanceDenials + b.capabilityRefusals), numeric: true },
      {
        text: b.costCoverage === null ? 'NULL' : `${b.knownCostEvents}/${b.dispatchAttempted}`,
        numeric: true,
        isNull: b.costCoverage === null,
      },
    ]
  })

  out.push(
    table(
      [
        'provider',
        'model',
        'mode',
        { text: 'calls', numeric: true },
        { text: 'worker tokens', numeric: true },
        { text: 'failures', numeric: true },
        { text: 'refused', numeric: true },
        { text: 'cost known', numeric: true },
      ],
      rows,
    ),
  )
  out.push(
    note(
      'Every dimension is shown separately. There is deliberately no single value score: a combination can look poor for six unrelated reasons, and a composite number would hide which one applies.',
    ),
  )
  out.push(
    note(
      'Latency is reported for the window rather than per profile: keeping a percentile buffer per combination would be unbounded in the one dimension that is unbounded.',
    ),
  )
  return out.join('')
}

/* ------------------------------------------------------------------ savings */

export function savingsSection(response) {
  const s = response.savings
  const n = response.negativeSavings
  const out = [h2('Savings')]

  out.push(
    cards([
      metricCard('Corpus tokens', s.estimatedInputTokens, { sub: 'what Claude would have read' }),
      metricCard('Answer tokens', s.returnedAnswerTokens, { sub: 'what Claude read instead' }),
      metricCard('Tokens avoided (net)', s.tokensAvoided, { sub: 'corpus minus answer' }),
      metricCard('Worker consumption', s.workerTokensConsumed, { sub: 'not a saving' }),
      metricCard('Estimated cost avoided', s.costAvoided, { sub: 'at the primary input rate only' }),
      metricCard('Estimated net savings', s.netSavings, { sub: 'avoided minus worker cost' }),
    ]),
  )

  out.push(
    callout(
      'Estimated savings are not necessarily actual invoice savings. The avoided figure prices a counterfactual that never ran, at the primary model input rate only, and when pricing is unavailable these metrics are null rather than zero.',
    ),
  )
  out.push(note(s.populationNote))

  const negTokens = n.tokens.events.value
  const negDollars = n.dollars.events.value
  if (negTokens > 0 || negDollars > 0) {
    out.push('<h3>Negative outcomes</h3>')
    out.push(
      table(
        ['measure', { text: 'events', numeric: true }, { text: 'rate', numeric: true }, { text: 'total', numeric: true }],
        [
          [
            'tokens',
            { text: count(negTokens), numeric: true },
            { text: metricText(n.tokens.rate), numeric: true },
            { text: n.tokens.total.display, numeric: true, isNull: n.tokens.total.value === null },
          ],
          [
            'dollars',
            { text: count(negDollars), numeric: true },
            { text: metricText(n.dollars.rate), numeric: true },
            { text: n.dollars.total.display, numeric: true, isNull: n.dollars.total.value === null },
          ],
        ],
      ),
    )
    out.push(
      note(
        'These are two different populations: a delegation can save context and still cost more than it saved. Nothing here is clamped to zero.',
      ),
    )
    out.push(
      note(
        'A negative event does not by itself mean the routing policy is wrong. It can indicate a small corpus, a verbose worker, a slow model, an unnecessary delegation, a task mismatch or a missing baseline. It is surfaced for investigation.',
      ),
    )

    if (n.examples.items.length > 0) {
      out.push('<h3>Worst cases</h3>')
      out.push(
        table(
          [
            'event',
            'model',
            { text: 'corpus', numeric: true },
            { text: 'answer', numeric: true },
            { text: 'tokens avoided', numeric: true },
            { text: 'worker cost', numeric: true },
            { text: 'net savings', numeric: true },
          ],
          n.examples.items.slice(0, 20).map((e) => [
            { text: e.event_id ?? 'unknown', key: true },
            { text: e.model ?? 'unknown', key: true, sentinel: e.model === null },
            { text: fmt(e.estimated_input_tokens), numeric: true, isNull: e.estimated_input_tokens === null },
            { text: fmt(e.returned_answer_tokens_estimated), numeric: true, isNull: e.returned_answer_tokens_estimated === null },
            { text: fmt(e.estimated_tokens_avoided), numeric: true, isNull: e.estimated_tokens_avoided === null },
            { text: fmt(e.worker_total_cost), numeric: true, isNull: e.worker_total_cost === null },
            { text: fmt(e.estimated_net_savings), numeric: true, isNull: e.estimated_net_savings === null },
          ]),
        ),
      )
      if (n.examples.truncated) {
        out.push(note(`${count(n.examples.seen)} negative events in total; the worst ${n.examples.kept} are shown.`))
      }
    }
  }
  return out.join('')
}

/* --------------------------------------------------------------------- cost */

export function costSection(response) {
  const c = response.cost
  const out = [h2('Cost')]

  out.push(
    cards([
      metricCard('Worker input', c.workerInput),
      metricCard('Worker output', c.workerOutput),
      metricCard('Worker total', c.workerTotal),
      card({
        label: 'Coverage',
        value: coverageText(c.coverage) ?? 'no events',
        sub: 'events with a known price',
        badge: c.coverage.ratio === null || c.coverage.ratio === 0 ? 'unknown' : 'measured',
        unknown: c.coverage.ratio === null || c.coverage.ratio === 0,
      }),
    ]),
  )

  out.push(
    table(
      ['measurement state', { text: 'events', numeric: true }, 'meaning'],
      [
        [
          'known cost',
          { text: count(c.knownCostEvents.value), numeric: true },
          'a price could be stated',
        ],
        [
          'structurally zero',
          { text: count(c.structurallyZeroEvents.value), numeric: true },
          'an operator configured a rate of 0 — a real measurement whose value is zero',
        ],
        [
          'unknown cost',
          { text: count(c.unknownCostEvents.value), numeric: true },
          'the call succeeded and its price cannot be stated. Not zero, and not a failure',
        ],
      ],
    ),
  )

  out.push('<h3>Why a price is missing</h3>')
  const e = c.nullExplanation
  out.push(
    kvList([
      ['no pricing table', count(e.noPricingTable)],
      ['model not in table', count(e.modelNotInTable)],
      ['matched by wildcard', count(e.matchedByWildcard)],
      ['matched exactly', count(e.matchedExactly)],
      ['bundled table (all rates null)', count(e.bundledTableAllNull)],
      ['no table configured', count(e.noTableConfigured)],
      ['usage missing', count(e.usageMissing)],
    ]),
  )
  out.push(note(e.note))
  out.push(note(c.note))
  out.push(
    note(
      `Primary-model baseline: ${unavailableReason(c.primaryBaseline) ?? 'unavailable'}`,
    ),
  )
  return out.join('')
}

/* ------------------------------------------------------------------ latency */

export function latencySection(response) {
  const l = response.latency
  const out = [h2('Latency')]

  const seriesRow = (label, s, extra = '') => [
    label,
    { text: ms(s.median), numeric: true, isNull: s.median === null },
    { text: ms(s.p95), numeric: true, isNull: s.p95 === null },
    { text: ms(s.max), numeric: true, isNull: s.max === null },
    { text: count(s.n), numeric: true },
    extra,
  ]

  out.push(
    table(
      [
        'component',
        { text: 'median', numeric: true },
        { text: 'p95', numeric: true },
        { text: 'max', numeric: true },
        { text: 'samples', numeric: true },
        'notes',
      ],
      [
        seriesRow('total (end to end)', l.total, 'payload assembly, every attempt, the parse'),
        seriesRow('provider round trip', l.provider, 'the final attempt only'),
        seriesRow(
          'dispatch overhead',
          l.dispatchOverhead,
          `derived; ${l.dispatchOverhead.excludedForRetry} retried and ${l.dispatchOverhead.excludedForUnknownRetry} unknown-retry rows excluded`,
        ),
      ],
    ),
  )

  out.push(
    note(
      `Median, p95 and max by nearest rank with no interpolation, so every reported percentile is a value an event actually produced. The mean is deliberately not reported. ${count(l.gateRowsExcluded)} gate ${plural(l.gateRowsExcluded, 'row')} excluded: both latency columns are null on a gate row by design.`,
    ),
  )
  if (l.dispatchOverhead.excludedForRetry > 0) {
    out.push(
      note(
        'Retried calls are excluded from dispatch overhead. The provider column measures the final attempt, so with a retry the difference would silently include an unknown amount of earlier network time.',
      ),
    )
  }
  if (l.total.truncated) {
    out.push(
      callout(
        `Latency percentiles cover a prefix of ${count(l.total.samplesKept)} of ${count(l.total.samplesSeen)} samples. Past the cap, collection stops rather than switching to a sampled estimate, so the figures above are exact for the prefix and not for the window.`,
      ),
    )
  }

  out.push('<h3>Not instrumented</h3>')
  out.push(
    table(
      ['component', 'why'],
      Object.entries(l.components).map(([key, node]) => [
        { text: key, key: true },
        unavailableReason(node) ?? node.reason,
      ]),
    ),
  )
  return out.join('')
}

/* --------------------------------------------------------------- governance */

export function governanceSection(response) {
  const g = response.governance
  const out = [h2('Governance')]

  out.push(
    cards([
      metricCard('Allowed', g.allowed),
      metricCard('Denied', g.denied, { sub: 'a successful decision' }),
      metricCard('Never consulted', g.notConsulted, { sub: 'refused before the budget layer ran' }),
      metricCard('Reservation tokens', g.reservationTokens),
    ]),
  )

  if (g.byReason.buckets.length > 0) {
    out.push('<h3>Decision reasons</h3>')
    out.push(
      table(
        ['reason', { text: 'events', numeric: true }],
        g.byReason.buckets.map((b) => [
          { text: b.key === '__null__' ? 'not consulted' : b.key, key: b.key !== '__null__', sentinel: b.key === '__null__' },
          { text: count(b.count), numeric: true },
        ]),
      ),
    )
  }

  if (g.budgetSnapshots.snapshots.length > 0) {
    out.push('<h3>Budget utilisation</h3>')
    out.push(
      table(
        [
          'scope',
          { text: 'limit', numeric: true },
          { text: 'remaining', numeric: true },
          { text: 'used', numeric: true },
          'measurement',
        ],
        g.budgetSnapshots.snapshots.map((s) => [
          { text: s.scope, key: true },
          { text: fmt(s.limit), numeric: true, isNull: s.limit === null },
          { text: fmt(s.remaining), numeric: true, isNull: s.remaining === null },
          { text: s.utilization === null ? 'NULL' : percent(s.utilization), numeric: true, isNull: s.utilization === null },
          s.measurementStatus ?? 'unknown',
        ]),
      ),
    )
    out.push(note(g.budgetSnapshots.note))
  } else {
    out.push(note('No budget was configured or consulted in this window.'))
  }

  out.push(note(g.note))
  return out.join('')
}

/* -------------------------------------------------------------- reliability */

export function reliabilitySection(response) {
  const f = response.failures
  const out = [h2('Reliability')]

  // THREE TABLES, THREE TOTALS, NO GRAND TOTAL. This is a correctness requirement: a single
  // combined number would be quoted, and every use of it would be wrong.
  out.push('<h3>Worker call failures</h3>')
  out.push(
    table(
      ['condition', { text: 'events', numeric: true }, 'meaning'],
      [
        [
          'worker failures',
          { text: count(f.workerFailures.value), numeric: true },
          'the provider was called and something went wrong',
        ],
        ['retried calls', { text: count(f.retried.value), numeric: true }, 'at least one attempt was repeated'],
        [
          'truncated answers',
          { text: count(f.truncatedAnswers.value), numeric: true },
          'the answer hit an output cap',
        ],
      ],
    ),
  )
  if (f.byErrorCode.buckets.length > 0) {
    out.push(
      table(
        ['error code', { text: 'events', numeric: true }],
        f.byErrorCode.buckets.map((b) => [
          { text: b.key === '__null__' ? 'none' : b.key, key: b.key !== '__null__', sentinel: b.key === '__null__' },
          { text: count(b.count), numeric: true },
        ]),
      ),
    )
  }

  out.push('<h3>Refusals — the worker was never called</h3>')
  out.push(
    table(
      ['condition', { text: 'events', numeric: true }, 'meaning'],
      [
        [
          'governance denials',
          { text: count(f.governanceDenials.value), numeric: true },
          'the budget layer said no. A successful decision, not a failure',
        ],
        [
          'context refusals (pre-flight)',
          { text: count(f.capabilityRefusals.preflight.value), numeric: true },
          'the prompt did not fit the window. The provider was never called and nothing was spent',
        ],
        [
          'context refusals (truncation discard)',
          { text: count(f.capabilityRefusals.truncationDiscarded.value), numeric: true },
          'the call ran, tokens were consumed, and the answer was discarded because the provider read less of the prompt than was sent',
        ],
      ],
    ),
  )

  out.push('<h3>Things we could not measure</h3>')
  out.push(
    table(
      ['condition', { text: 'events', numeric: true }, 'meaning'],
      [
        [
          'unknown cost',
          { text: count(f.unknownCost.value), numeric: true },
          'the call succeeded and its price cannot be stated. Not a failed request',
        ],
        [
          'unknown usage',
          { text: count(f.unknownUsage.value), numeric: true },
          'the provider reported no token counts',
        ],
        [
          'capability unknown',
          { text: count(f.capabilityUnknown.value), numeric: true },
          'the worker context window could not be resolved. Unknown is never infinite',
        ],
        [
          'retryable classification',
          { text: 'NULL', numeric: true },
          unavailableReason(f.retryable) ?? 'not available to this layer',
        ],
      ],
    ),
  )

  out.push(
    callout(
      'A budget refusal, a context refusal and an unpriced call are three different events. None of them is a failed request, and this report never adds them up.',
    ),
  )

  const overhead = response.value.workerOverhead
  out.push('<h3>Worker overhead</h3>')
  out.push(
    cards([
      metricCard('Calls with no usable answer', overhead.events),
      metricCard('Cost spent for nothing', overhead.cost),
      metricCard('Tokens spent for nothing', overhead.tokens),
    ]),
  )
  out.push(note(overhead.note))
  return out.join('')
}

/* ------------------------------------------------------------------- trends */

export function trendsSection(response) {
  const dim = response.segments.date
  const byKey = new Map(dim.buckets.map((b) => [b.key, b]))
  const axis = dim.axis ?? []
  const out = [h2('Trends')]

  if (axis.length === 0) {
    out.push(panel('<p class="note">No days in this window.</p>'))
    return out.join('')
  }

  const small = trendNote(axis.length)
  if (small !== null) {
    out.push(callout(`${small}. The points below are shown without any direction indicator.`))
  }

  const series = (pick) =>
    axis.map((day) => {
      const b = byKey.get(day)
      // A day the window covered with no rows is a real zero for a COUNT and a genuine gap for a
      // MEASUREMENT. The two are passed through differently on purpose.
      return { label: day.slice(5), value: b === undefined ? pick.emptyDay : pick.get(b) }
    })

  out.push('<h3>Routing decisions over time</h3>')
  out.push(
    lineChart({
      title: 'events per day',
      points: series({ emptyDay: 0, get: (b) => b.events }),
      caption: 'routing events per day',
    }),
  )
  out.push(
    lineChart({
      title: 'delegations per day',
      points: series({ emptyDay: 0, get: (b) => b.dispatchAttempted }),
      caption: 'delegated calls per day',
    }),
  )

  out.push('<h3>Tokens over time</h3>')
  out.push(
    lineChart({
      title: 'tokens avoided per day',
      points: series({ emptyDay: null, get: (b) => b.metrics.tokensAvoided.value }),
      caption: 'tokens avoided per day',
    }),
  )
  out.push(
    lineChart({
      title: 'worker tokens per day',
      points: series({ emptyDay: null, get: (b) => b.metrics.workerTokens.value }),
      caption: 'worker tokens consumed per day',
    }),
  )

  out.push('<h3>Known worker cost over time</h3>')
  out.push(
    lineChart({
      title: 'worker cost per day',
      points: series({ emptyDay: null, get: (b) => b.metrics.workerCost.value }),
      caption: 'known worker cost per day — a broken line is an unpriced day, not a free one',
    }),
  )

  out.push(
    table(
      [
        'day',
        { text: 'events', numeric: true },
        { text: 'delegated', numeric: true },
        { text: 'tokens avoided', numeric: true },
        { text: 'worker tokens', numeric: true },
        { text: 'worker cost', numeric: true },
      ],
      axis.map((day) => {
        const b = byKey.get(day)
        if (b === undefined) {
          return [
            { text: day, key: true },
            { text: '0', numeric: true },
            { text: '0', numeric: true },
            { text: 'no events', numeric: true, isNull: true },
            { text: 'no events', numeric: true, isNull: true },
            { text: 'no events', numeric: true, isNull: true },
          ]
        }
        return [
          { text: day, key: true },
          { text: count(b.events), numeric: true },
          { text: count(b.dispatchAttempted), numeric: true },
          { text: b.metrics.tokensAvoided.display, numeric: true, isNull: b.metrics.tokensAvoided.value === null },
          { text: b.metrics.workerTokens.display, numeric: true, isNull: b.metrics.workerTokens.value === null },
          { text: b.metrics.workerCost.display, numeric: true, isNull: b.metrics.workerCost.value === null },
        ]
      }),
    ),
  )
  if (response.timeRange.incompletePeriod) {
    out.push(
      note(
        'The newest day is still accruing events, so its point covers a shorter span than the others and should not be compared with them directly.',
      ),
    )
  }
  return out.join('')
}

/* ----------------------------------------------------------- answer quality */

/**
 * The one section whose job is to be impossible to misread as a pass.
 *
 * WHY IT EXISTS. Every other section on this page reports a figure that goes UP when delegation
 * works — delegation rate, tokens avoided, success rate, cost avoided. A reader who scans the
 * overview and stops concludes the router is doing well, and before this section nothing on the
 * page contradicted that reading. Whether the ANSWERS were any good is not established anywhere
 * in this project, and a dashboard that can be read as claiming otherwise is worse than one
 * aggregate short.
 *
 * It renders SECOND, directly after the overview, for the same reason.
 *
 * EVERY FIGURE HERE IS A COUNT OF A MEASURED CONDITION. None of them grades an answer, and the
 * section says so in a callout rather than a footnote, because a footnote is where a caveat goes
 * to be ignored.
 */
export function answerQualitySection(response) {
  const a = response.answerQuality
  const out = [h2('Answer quality')]

  out.push(
    callout(
      'NOT MEASURED. Nothing in this report grades an answer. There is no baseline comparison ' +
        'against the primary model and no grader, so none of these figures distinguishes a good ' +
        'answer from a confident wrong one. What follows is the set of measured conditions that ' +
        'bound confidence in a delivered answer.',
      { bad: true },
    ),
  )

  out.push(
    table(
      ['measure', { text: 'count', numeric: true }, 'what it means'],
      [
        [
          'answers delivered',
          { text: count(a.delivered.value), numeric: true },
          'returned to Claude. Correctness unknown',
        ],
        [
          'on an unverified window',
          { text: count(a.onUnverifiedWindow.value), numeric: true },
          'the context window could not be determined, so silent truncation could not have been detected either. THE RESIDUAL RISK',
        ],
        [
          'cut off mid-answer',
          { text: count(a.cutOffMidAnswer.value), numeric: true },
          'the worker ran out of output budget. The answer is incomplete',
        ],
        [
          'discarded for truncation',
          { text: count(a.discardedForTruncation.value), numeric: true },
          'truncation WAS detected and the answer was thrown away rather than returned. The defence working',
        ],
        [
          'usage inconsistent',
          { text: count(a.usageInconsistent.value), numeric: true },
          "the provider's own token arithmetic did not add up",
        ],
      ],
    ),
  )

  out.push(note(`Established: ${escapeHtml(a.established)}`))
  out.push(note(`NOT established: ${escapeHtml(a.notEstablished)}`))

  if (a.onUnverifiedWindow.value > 0) {
    out.push(
      callout(
        `${count(a.onUnverifiedWindow.value)} delivered answer(s) came from a worker whose context ` +
          'window could not be determined. An unknown window is never treated as unlimited — the request ' +
          'still ran under the transport byte ceiling — but truncation detection needs a window, so for ' +
          'these calls a silently middle-dropped prompt would not have been caught. Set a provider ' +
          'contextTokens value, or use a provider that reports its own window, to remove this gap.',
      ),
    )
  }

  return out.join('')
}

/* ------------------------------------------------------------- data quality */

export function dataQualitySection(response) {
  const q = response.dataQuality
  const c = response.coverage
  const out = [h2('Data quality')]

  out.push(
    table(
      ['measure', { text: 'count', numeric: true }],
      [
        ['segments read', { text: count(q.read.segmentsRead), numeric: true }],
        ['lines scanned', { text: count(q.read.linesScanned), numeric: true }],
        ['records accepted', { text: count(q.read.recordsAccepted), numeric: true }],
        ['records rejected', { text: count(q.read.recordsRejected), numeric: true }],
        ['rows in window', { text: count(c.rowsInWindow), numeric: true }],
        ['rows out of window', { text: count(c.rowsOutOfWindow), numeric: true }],
        ['rows out of scope', { text: count(c.rowsOutOfScope), numeric: true }],
        ['rows with no usable timestamp', { text: count(c.rowsUndatable), numeric: true }],
        ['rows this build cannot read', { text: count(c.rowsIncompatible), numeric: true }],
      ],
    ),
  )

  if (q.read.recordsRejected > 0) {
    out.push('<h3>Why records were rejected</h3>')
    out.push(
      table(
        ['reason', { text: 'count', numeric: true }, 'meaning'],
        [
          ['blank', { text: count(q.read.rejectionReasons.blank), numeric: true }, 'a trailing newline always produces one'],
          ['comment', { text: count(q.read.rejectionReasons.comment), numeric: true }, 'a line beginning with #'],
          [
            'malformed (mid-file)',
            { text: count(q.read.rejectionReasons.malformed), numeric: true },
            'evidence that append atomicity failed on this filesystem',
          ],
          [
            'truncated tail',
            { text: count(q.read.rejectionReasons.truncatedTail), numeric: true },
            'a writer caught mid-flight. Benign',
          ],
          [
            'unrecognised',
            { text: count(q.read.rejectionReasons.unrecognized), numeric: true },
            'no readable schema version',
          ],
          ['oversize line', { text: count(q.read.rejectionReasons.oversizeLine), numeric: true }, 'beyond the read cap'],
        ],
      ),
    )
  }

  out.push('<h3>Missing measurements</h3>')
  out.push(
    kvList([
      ['rows missing cost', count(q.rows.missingCost)],
      ['rows with known cost', count(q.rows.knownCost)],
      ['rows with a configured zero cost', count(q.rows.zeroCost)],
      ['rows missing usage', count(q.rows.missingUsage)],
      ['rows with partial usage', count(q.rows.partialUsage)],
      ['rows missing latency', count(q.rows.missingLatency)],
      ['rows missing a savings figure', count(q.rows.missingSavings)],
      ['rows with an unknown enum value', count(q.rows.unknownEnums)],
      ['records the sink shed to fit', count(q.rows.shedRecords)],
      ['schema versions seen', Object.entries(q.schemaVersions).map(([v, n]) => `${v} (${n})`).join(', ') || 'none'],
      ['gate decisions recorded', q.gateDecisionsRecorded ? 'yes' : 'NO — the delegation-rate denominator is incomplete'],
    ]),
  )

  if (q.conditions.length > 0) {
    out.push('<h3>Conditions</h3>')
    out.push(
      table(
        ['severity', 'condition', 'detail'],
        q.conditions.map((cond) => [
          cond.severity,
          { text: cond.id, key: true },
          cond.detail,
        ]),
      ),
    )
  }

  out.push(callout(q.note))
  out.push(
    note(
      `Reader samples are counted and withheld: ${count(q.read.samplesWithheld)} withheld. ${q.read.samplesWithheldReason}.`,
    ),
  )
  return out.join('')
}

/* ------------------------------------------------------------------- footer */

export function footerSection(response, { dashboardVersion }) {
  const e = response.engine
  return [
    '<footer>',
    `router-dashboard <code>${escapeHtml(dashboardVersion)}</code> · `,
    `analytics contract <code>${escapeHtml(String(e.contractVersion))}</code> · `,
    `model-router <code>${escapeHtml(e.routerVersion)}</code> · `,
    `telemetry schema <code>${escapeHtml(String(e.buildSchemaVersion))}</code> · `,
    `calc <code>${escapeHtml(String(e.buildCalcVersion))}</code>`,
    '<br>',
    'This report renders an analytics response it was handed. It reads no telemetry store, computes no cost, prices no model and changes no configuration.',
    '</footer>',
  ].join('')
}

/** Every section, in the order the report presents them. */
export const SECTION_RENDERERS = Object.freeze([
  overviewSection,
  // SECOND, deliberately. See answerQualitySection's header: a reader who scans the overview and
  // stops must meet the evidence boundary before the favourable numbers, not after them.
  answerQualitySection,
  routingSection,
  workerSection,
  savingsSection,
  costSection,
  latencySection,
  governanceSection,
  reliabilitySection,
  trendsSection,
  dataQualitySection,
])
