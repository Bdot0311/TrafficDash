const STAGE_LABELS = {
  visitors: 'Visitors',
  scanners: 'Scanners',
  signups: 'Signups',
  checkout: 'Checkout',
  paid: 'Paid',
};

const STAGE_HELP = {
  visitors: 'Unique people, attributed to this source by first touch.',
  scanners: 'Ran the product at least once.',
  signups: 'Identified in PostHog — identify(userId, { email }).',
  checkout: 'Started a Stripe Checkout Session, attributed by last non-direct touch.',
  paid: 'Session reached payment_status = paid.',
};

const $ = (sel) => document.querySelector(sel);

const fmt = new Intl.NumberFormat('en-US');
const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(n);

const stageColor = (i) => `var(--stage-${i + 1})`;

// Slot 0 is the neutral chip used for Internal / Direct — they are residuals,
// not channels, so they never take a categorical hue.
const sourceColor = (slot) =>
  slot === 0 ? 'var(--surface-2)' : `var(--cat-${((slot - 1) % 8) + 1})`;

// A glyph set inside a colored fill picks white or ink by the fill's luminance,
// so it always clears contrast.
const CAT_HEX = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

function isDarkTheme() {
  const stamped = document.documentElement.dataset.theme;
  if (stamped) return stamped === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function glyphInk(slot) {
  if (slot === 0) return 'var(--text-secondary)';
  const hex = CAT_HEX[isDarkTheme() ? 'dark' : 'light'][(slot - 1) % 8];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Contrast against white vs against near-black ink.
  return (1.05 / (L + 0.05)) >= (L + 0.05) / 0.05 ? '#fff' : '#0b0b0b';
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

/* --- tooltip --------------------------------------------------------------- */
const tooltip = $('#tooltip');

function attachTooltip(node, render) {
  const show = (event) => {
    tooltip.innerHTML = '';
    tooltip.append(render());
    tooltip.dataset.open = 'true';
    tooltip.setAttribute('aria-hidden', 'false');
    place(event);
  };
  const place = (event) => {
    const rect = node.getBoundingClientRect();
    const x = event?.clientX ?? rect.left + rect.width / 2;
    const y = rect.top;
    const box = tooltip.getBoundingClientRect();
    const left = Math.min(Math.max(8, x - box.width / 2), window.innerWidth - box.width - 8);
    const top = y - box.height - 10;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top < 8 ? rect.bottom + 10 : top}px`;
  };
  const hide = () => {
    tooltip.dataset.open = 'false';
    tooltip.setAttribute('aria-hidden', 'true');
  };

  node.addEventListener('pointerenter', show);
  node.addEventListener('pointermove', place);
  node.addEventListener('pointerleave', hide);
  // Keyboard parity — the tooltip is the only place some numbers are explained.
  node.addEventListener('focus', show);
  node.addEventListener('blur', hide);
  node.tabIndex = 0;
}

/* --- pieces ---------------------------------------------------------------- */
function statTile(source, stage, index, report) {
  const count = source.counts[stage];
  const rate = source.rates[stage];
  const prevStage = report.stages[index - 1];
  const prevCount = prevStage ? source.counts[prevStage] : null;
  const stepRate =
    prevCount && prevCount > 0 ? Math.round((count / prevCount) * 100) : null;

  const tile = el('div', { class: 'stat', style: `--meter-color:${stageColor(index)}` }, [
    el('div', { class: 'stat-label', text: STAGE_LABELS[stage].toUpperCase() }),
    index === 0
      ? el('div', { class: 'stat-rate', text: ' ' })
      : el('div', { class: 'stat-rate', text: `${rate}%` }),
    el('div', { class: 'stat-value', text: fmt.format(count) }),
    el('div', { class: 'meter' }, [
      el('div', {
        class: 'meter-fill',
        style: `width:${index === 0 ? 100 : Math.max(rate, count > 0 ? 3 : 0)}%`,
      }),
    ]),
  ]);

  attachTooltip(tile, () =>
    el('div', {}, [
      el('b', { text: `${STAGE_LABELS[stage]} · ${source.label}` }),
      el('div', {
        text:
          index === 0
            ? `${fmt.format(count)} unique people`
            : `${fmt.format(count)} of ${fmt.format(source.counts.visitors)} visitors (${rate}%)`,
      }),
      stepRate !== null
        ? el('div', {
            class: 'tooltip-dim',
            text: `${stepRate}% of ${STAGE_LABELS[prevStage].toLowerCase()}`,
          })
        : null,
      el('div', { class: 'tooltip-dim', text: STAGE_HELP[stage] }),
    ]),
  );

  return tile;
}

function chip(text, kind) {
  return el('span', { class: 'chip', 'data-kind': kind || null, text });
}

function monoChip(prefix, mono) {
  return el('span', { class: 'chip' }, [
    prefix ? document.createTextNode(prefix + ' ') : null,
    el('code', { class: 'chip-mono', text: mono }),
  ]);
}

function utmTable(source) {
  if (!source.utms.length) {
    return el('p', {
      class: 'utm-empty',
      text:
        source.key === 'direct'
          ? 'No UTM parameters on any visit. Tag your links with ?utm_source= — mobile clients strip referrers, so untagged traffic lands here with no way to tell it apart.'
          : 'No UTM parameters on any visit. This source was matched by referrer, so the attribution is inferred rather than declared.',
    });
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'utm_source' }),
          el('th', { text: 'utm_medium' }),
          el('th', { text: 'utm_campaign' }),
          el('th', { class: 'num', text: 'People' }),
        ]),
      ]),
      el(
        'tbody',
        {},
        source.utms.map((u) =>
          el('tr', {}, [
            el('td', { text: u.source }),
            el('td', { text: u.medium }),
            el('td', { text: u.campaign }),
            el('td', { class: 'num', text: fmt.format(u.count) }),
          ]),
        ),
      ),
    ]),
  ]);
}

const UTM_BADGE = {
  seen: 'UTM Seen',
  needed: 'Needs UTM',
  none: 'No UTM Rows',
};

function sourceCard(source, report) {
  const panel = el('div', { class: 'utm-panel', hidden: 'hidden' }, [utmTable(source)]);

  const toggle = el('button', {
    type: 'button',
    class: 'disclosure',
    'aria-expanded': 'false',
    onclick: () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      panel.hidden = open;
    },
  });
  toggle.append(
    el('span', {
      text:
        'Show exact UTMs' +
        (source.taggedPeople
          ? ` · ${fmt.format(source.taggedPeople)} tagged ${source.taggedPeople === 1 ? 'person' : 'people'}`
          : ''),
    }),
    el('span', { class: 'disclosure-caret', text: '›' }),
  );

  const chips = [
    monoChip('Top page:', source.topPage),
    monoChip('via', source.via),
    chip(
      `${fmt.format(source.sessions)} sessions · ${fmt.format(source.views)} views · ${fmt.format(source.scanRuns)} scan runs`,
    ),
  ];
  if (source.orders > 0) {
    chips.push(chip(`${fmt.format(source.orders)} paid orders`, 'money'));
    chips.push(chip(`${money(source.revenue, source.currency)} Stripe`, 'money'));
  }

  return el('article', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('span', {
        class: 'card-avatar',
        'data-neutral': source.slot === 0 ? 'true' : null,
        style: `background:${sourceColor(source.slot)};color:${glyphInk(source.slot)}`,
        'aria-hidden': 'true',
        text: source.glyph,
      }),
      el('div', { class: 'card-id' }, [
        el('div', { class: 'card-name-row' }, [
          el('h3', { class: 'card-name', text: source.label }),
          el('span', {
            class: 'badge',
            'data-utm': source.utmState,
            text: UTM_BADGE[source.utmState],
          }),
        ]),
        el('span', {
          class: 'badge-confidence',
          'data-confidence': source.confidence,
          text: `${source.confidence} confidence`,
        }),
      ]),
      el('div', { class: 'card-count' }, [
        el('b', { text: fmt.format(source.counts.visitors) }),
        el('span', { text: 'unique visitors' }),
      ]),
    ]),

    el(
      'div',
      { class: 'stats' },
      report.stages.map((stage, i) => statTile(source, stage, i, report)),
    ),

    el('div', { class: 'chips' }, chips),

    el('div', { class: 'card-foot' }, [toggle, panel]),
  ]);
}

function overallFunnel(report) {
  const max = report.totals[report.stages[0]] || 1;

  return report.stages.map((stage, i) => {
    const count = report.totals[stage];
    const pct = Math.round((count / max) * 100);

    const row = el('div', { class: 'funnel-row' }, [
      el('div', { class: 'funnel-label', text: STAGE_LABELS[stage] }),
      el('div', { class: 'funnel-track' }, [
        el('div', {
          class: 'funnel-bar',
          style: `width:${Math.max(pct, count > 0 ? 1 : 0)}%;background:${stageColor(i)}`,
        }),
      ]),
      el('div', { class: 'funnel-value' }, [
        document.createTextNode(fmt.format(count)),
        el('span', { text: ` · ${pct}%` }),
      ]),
    ]);

    attachTooltip(row, () =>
      el('div', {}, [
        el('b', { text: STAGE_LABELS[stage] }),
        el('div', { text: `${fmt.format(count)} people · ${pct}% of visitors` }),
        el('div', { class: 'tooltip-dim', text: STAGE_HELP[stage] }),
      ]),
    );

    return row;
  });
}

function legend(report) {
  return report.stages.map((stage, i) =>
    el('span', { class: 'legend-item', role: 'listitem' }, [
      el('span', { class: 'legend-swatch', style: `background:${stageColor(i)}` }),
      document.createTextNode(STAGE_LABELS[stage]),
    ]),
  );
}

function fullTable(report) {
  const head = el('tr', {}, [
    el('th', { text: 'Source' }),
    ...report.stages.map((s) => el('th', { class: 'num', text: STAGE_LABELS[s] })),
    el('th', { class: 'num', text: 'Scan runs' }),
    el('th', { class: 'num', text: 'Orders' }),
    el('th', { class: 'num', text: 'Revenue' }),
    el('th', { text: 'Confidence' }),
  ]);

  const body = report.sources.map((s) =>
    el('tr', {}, [
      el('td', { text: s.label }),
      ...report.stages.map((stage) =>
        el('td', { class: 'num', text: fmt.format(s.counts[stage]) }),
      ),
      el('td', { class: 'num', text: fmt.format(s.scanRuns) }),
      el('td', { class: 'num', text: fmt.format(s.orders) }),
      el('td', { class: 'num', text: s.revenue ? money(s.revenue, s.currency) : '—' }),
      el('td', { text: s.confidence }),
    ]),
  );

  const rev = report.revenue;
  const dash = () => el('td', { class: 'num', text: '—' });

  // Unattributed money gets its own row rather than being left out, so the
  // revenue column reconciles with Stripe instead of quietly falling short.
  const unattributedRow =
    rev.unattributed > 0
      ? el('tr', { class: 'row-muted' }, [
          el('td', { text: 'Unattributed (no source)' }),
          ...report.stages.map(dash),
          dash(),
          el('td', {
            class: 'num',
            text: fmt.format(rev.noUserIdOrders + rev.orphanedOrders),
          }),
          el('td', { class: 'num', text: money(rev.unattributed, report.currency) }),
          el('td', { text: '—' }),
        ])
      : null;

  const foot = el('tr', {}, [
    // "Total", not "All sources" — the unattributed row above is not a source,
    // and not "Collected in Stripe" either, since this row also totals traffic.
    el('td', { text: 'Total' }),
    ...report.stages.map((stage) =>
      el('td', { class: 'num', text: fmt.format(report.totals[stage]) }),
    ),
    el('td', { class: 'num', text: fmt.format(report.sources.reduce((n, s) => n + s.scanRuns, 0)) }),
    el('td', {
      class: 'num',
      text: fmt.format(
        report.sources.reduce((n, s) => n + s.orders, 0) +
          rev.noUserIdOrders +
          rev.orphanedOrders,
      ),
    }),
    el('td', { class: 'num', text: money(rev.collected, report.currency) }),
    el('td', { text: '' }),
  ]);

  return el('table', {}, [
    el('thead', {}, [head]),
    el('tbody', {}, [...body, unattributedRow].filter(Boolean)),
    el('tfoot', {}, [foot]),
  ]);
}

/* --- render ---------------------------------------------------------------- */
let lastReport = null;

/**
 * Reconciliation line: attributed + unattributed = collected.
 *
 * Only rendered when something is unattributed. Its job is to let the number
 * be checked against the Stripe dashboard — a funnel that quietly reports less
 * revenue than was actually taken is worse than one that reports none.
 */
function renderReconciliation(report) {
  const { attributed, unattributed, collected, noUserIdOrders, orphanedOrders } = report.revenue;
  const node = $('#reconciliation');

  if (unattributed <= 0) {
    node.replaceChildren();
    node.hidden = true;
    return;
  }

  node.hidden = false;
  const reasons = [
    noUserIdOrders > 0 && `${fmt.format(noUserIdOrders)} without a user id`,
    orphanedOrders > 0 && `${fmt.format(orphanedOrders)} with an unmatched user id`,
  ].filter(Boolean);

  node.replaceChildren(
    el('div', { class: 'recon-row' }, [
      el('span', { class: 'recon-label', text: 'Attributed to a source' }),
      el('span', { class: 'recon-value', text: money(attributed, report.currency) }),
    ]),
    el('div', { class: 'recon-row' }, [
      el('span', { class: 'recon-label', text: `Unattributed (${reasons.join(', ')})` }),
      el('span', { class: 'recon-value', text: money(unattributed, report.currency) }),
    ]),
    el('div', { class: 'recon-row recon-total' }, [
      el('span', { class: 'recon-label', text: 'Collected in Stripe' }),
      el('span', { class: 'recon-value', text: money(collected, report.currency) }),
    ]),
  );
}

function renderWarnings(list) {
  $('#warnings').replaceChildren(
    ...list.map((w) =>
      el('div', { class: 'warning', 'data-level': w.level }, [
        el('span', { class: 'warning-icon', 'aria-hidden': 'true', text: '!' }),
        el('span', {}, [
          el('strong', { text: `${w.level === 'serious' ? 'Broken join' : 'Heads up'}: ` }),
          document.createTextNode(w.text),
        ]),
      ]),
    ),
  );
}

function render(report) {
  lastReport = report;

  // Not connected → the empty state carries the page. Never fake numbers.
  const unconfigured = report.state === 'unconfigured';
  $('#empty-state').hidden = !unconfigured;
  $('#dashboard').hidden = unconfigured;
  $('#generated').textContent = unconfigured
    ? ''
    : `Generated ${new Date(report.generatedAt).toLocaleString()}`;

  const pill = $('#mode-pill');
  pill.hidden = unconfigured;
  pill.textContent = report.connected?.stripe
    ? `PostHog + Stripe · ${report.windowDays}d`
    : `PostHog only · ${report.windowDays}d`;

  renderWarnings(report.warnings || []);
  if (unconfigured) return;

  // Connected but nothing came back — an empty window, not a broken setup.
  if (report.sources.length === 0) {
    renderWarnings([
      ...(report.warnings || []),
      {
        level: 'warning',
        text: `No events in the last ${report.windowDays} days. Widen the window in Settings, or check that PostHog is receiving pageviews.`,
      },
    ]);
  }

  $('#hero-figure').textContent = fmt.format(report.totals.visitors);

  const rev = report.revenue;
  // Say "attributed", not "collected", whenever they differ — the source cards
  // only ever sum to the attributed figure.
  $('#hero-caption').textContent =
    `unique visitors · last ${report.windowDays} days · ` +
    (rev.unattributed > 0
      ? `${money(rev.attributed, report.currency)} attributed`
      : `${money(rev.collected, report.currency)} collected`);

  renderReconciliation(report);

  $('#overall-funnel').replaceChildren(...overallFunnel(report));
  $('#legend').replaceChildren(...legend(report));
  $('#cards').replaceChildren(...report.sources.map((s) => sourceCard(s, report)));
  $('#table-wrap').replaceChildren(fullTable(report));

  $('#section-meta').textContent = [
    'Visitors = first-touch',
    'Paid = last non-direct touch',
    report.activationEvent ? `Scanners = ${report.activationEvent}` : null,
    'Open a card to see exact UTMs',
    'Internal / Direct kept separate',
  ]
    .filter(Boolean)
    .join(' · ');
}

async function load({ force = false } = {}) {
  let payload;
  try {
    payload = await (await fetch(`/api/report${force ? '?refresh=1' : ''}`)).json();
  } catch (err) {
    payload = { error: `Could not reach the TrafficDash server: ${err.message}` };
  }

  if (payload.error) {
    // A credential or query failure — say which API said no, and where to fix it.
    $('#dashboard').hidden = true;
    $('#empty-state').hidden = true;
    $('#mode-pill').hidden = true;
    $('#warnings').replaceChildren(
      el('div', { class: 'warning', 'data-level': 'critical' }, [
        el('span', { class: 'warning-icon', 'aria-hidden': 'true', text: '!' }),
        el('span', {}, [
          el('strong', { text: 'Could not load: ' }),
          document.createTextNode(payload.error + ' '),
          el('a', { href: '/settings', text: 'Check your settings' }),
          document.createTextNode('.'),
        ]),
      ]),
    );
    return;
  }

  render(payload);
}

/* --- controls -------------------------------------------------------------- */
$('#refresh').addEventListener('click', () => load({ force: true }));

$('#theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('trafficdash-theme', next);
  } catch {}
  // Glyph ink is computed from the fill's luminance, so it re-derives per theme.
  if (lastReport) render(lastReport);
});

const tableToggle = $('#table-toggle');
tableToggle.addEventListener('click', () => {
  const open = tableToggle.getAttribute('aria-expanded') === 'true';
  tableToggle.setAttribute('aria-expanded', String(!open));
  tableToggle.textContent = open ? 'Show' : 'Hide';
  $('#table-wrap').hidden = open;
});

load();
