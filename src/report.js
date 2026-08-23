import { readSettings } from './settings.js';
import { classifyTouch, pathOf, slotFor } from './classify.js';

const STAGES = ['visitors', 'scanners', 'signups', 'checkout', 'paid'];

function emptyCard(source) {
  return {
    key: source.key,
    label: source.label,
    glyph: source.glyph,
    slot: source.slot,
    via: new Map(),
    confidence: 'low',
    hasUtmRows: false,
    counts: { visitors: 0, scanners: 0, signups: 0, checkout: 0, paid: 0 },
    sessions: 0,
    views: 0,
    scanRuns: 0,
    orders: 0,
    revenue: 0,
    currency: 'USD',
    pages: new Map(),
    referrerPaths: new Map(),
    utms: new Map(),
    taggedPeople: 0,
  };
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const fmtMoney = (amount, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);

function bump(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

/**
 * Give every source a distinct color slot.
 *
 * Each key prefers its own hashed slot, and collisions walk to the next free
 * one. Resolution runs over the keys sorted ALPHABETICALLY, never by rank, so
 * re-ranking the dashboard can't repaint anything — a reader who learned
 * "Reddit is the orange one" stays right.
 *
 * Past eight sources the extras take the neutral chip rather than cycling a
 * hue: a ninth generated color is indistinguishable from one already in use.
 */
function assignSlots(cards) {
  const keys = [...cards.keys()].filter((k) => cards.get(k).slot !== 0).sort();
  const taken = new Set();

  for (const key of keys) {
    const card = cards.get(key);
    const start = slotFor(key);
    let assigned = 0;
    for (let step = 0; step < 8; step += 1) {
      const candidate = ((start - 1 + step) % 8) + 1;
      if (!taken.has(candidate)) {
        assigned = candidate;
        taken.add(candidate);
        break;
      }
    }
    card.slot = assigned; // 0 once all eight are spoken for
  }
}

const topKeys = (map, n = 1) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);

/**
 * Pipeline stages, ordered by how much attention each deserves.
 *
 * The ordering is the argument: someone who used the product and did not buy
 * knows exactly what they are declining, which makes them worth more than a
 * larger pile of people who never got that far. Volume is not priority.
 */
const PIPELINE_STAGES = [
  {
    key: 'hot',
    label: 'Activated · no purchase',
    description:
      'Signed up and used the product, then stopped. They know what it does and chose not to pay — the shortest path to revenue, and the only group that can tell you why.',
    weight: 5,
  },
  {
    key: 'anon_active',
    label: 'Activated · no account',
    description:
      'Used the product without signing up. Real intent, no way to reach them — every one of these is a missed capture.',
    weight: 4,
  },
  {
    key: 'stalled',
    label: 'Signed up · never used',
    description:
      'Made an account and never ran anything. They wanted it enough to register, so this is an onboarding failure rather than a demand problem.',
    weight: 3,
  },
  {
    key: 'returning',
    label: 'Came back · no action',
    description:
      'More than one session, nothing done. Interested, unconvinced — worth a reason to act.',
    weight: 2,
  },
  {
    key: 'passive',
    label: 'Single visit',
    description: 'One session, nothing since. Volume, not pipeline.',
    weight: 1,
  },
  {
    key: 'customer',
    label: 'Customers',
    description: 'Already paid. Kept visible for expansion and to see which sources produce buyers.',
    weight: 0,
  },
];

/**
 * Which bucket a person belongs in, and how urgently.
 *
 * Score is stage first, then engagement, then recency — so a hot lead from
 * last week still outranks a passive visitor from this morning. Recency only
 * orders people who are otherwise comparable.
 */
function classifyForPipeline(row, now = Date.now()) {
  let key;
  if (row.paid) key = 'customer';
  else if (row.signedUp && row.scanRuns > 0) key = 'hot';
  else if (!row.signedUp && row.scanRuns > 0) key = 'anon_active';
  else if (row.signedUp) key = 'stalled';
  else if (row.sessions > 1) key = 'returning';
  else key = 'passive';

  const stage = PIPELINE_STAGES.find((s) => s.key === key);
  const engagement = Math.min(row.scanRuns * 10 + row.sessions * 3 + row.views, 60);
  const days = row.lastSeen ? (now - new Date(row.lastSeen).getTime()) / 86400000 : 999;
  const recency = Math.max(0, 40 - days * 2);

  const reasons = [];
  if (row.scanRuns > 0) reasons.push(`${row.scanRuns} run${row.scanRuns === 1 ? '' : 's'}`);
  if (row.sessions > 1) reasons.push(`${row.sessions} sessions`);
  if (row.signedUp) reasons.push('signed up');
  if (!row.email && key !== 'passive') reasons.push('no email on file');

  return {
    stage: key,
    stageLabel: stage.label,
    score: Math.round(stage.weight * 1000 + engagement + recency),
    reason: reasons.join(' · ') || 'one visit',
  };
}

/**
 * Turn the aggregates into statements.
 *
 * Every finding names the number it came from, so it can be checked rather
 * than believed — a dashboard that asserts "traffic quality is poor" without
 * showing its arithmetic is just an opinion with a chart behind it. Findings
 * are ordered by how much they should change what you do next, not by how
 * alarming they sound.
 *
 * Each also carries an `action`: the list it is about, or the place it gets
 * fixed. A finding you cannot act on from where you are reading it is a
 * complaint, not a finding.
 */
// Who "stopped here" means, per stage. Each names the people who reached the
// previous stage and went no further.
const DROP_FILTERS = {
  scanners: { activated: 'no' },
  signups: { activated: 'yes', signed: 'no' },
  checkout: { signed: 'yes', paid: 'no' },
  paid: { signed: 'yes', paid: 'no' },
};

function deriveFindings({ sources, totals, revenue, settings }) {
  const out = [];
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const visitors = totals.visitors;
  if (visitors === 0) return out;

  // --- attribution coverage -------------------------------------------------
  const direct = sources.find((s) => s.key === 'direct');
  if (direct && pct(direct.counts.visitors, visitors) >= 25) {
    const share = pct(direct.counts.visitors, visitors);
    out.push({
      level: share >= 50 ? 'critical' : 'warning',
      title: `${share}% of visitors cannot be attributed`,
      detail: `${direct.counts.visitors} of ${visitors} arrived with no UTM and no referrer, so they are indistinguishable from someone typing the URL. Mobile clients strip referrers — tagging links with ?utm_source= is the only thing that recovers this, and only for links posted from now on.`,
      // Nothing to filter here: the fix is every link you post from now on.
      action: { kind: 'utm', label: 'Build a tagged link' },
    });
  }

  // --- where the funnel actually breaks ------------------------------------
  const stages = STAGES.map((stage) => ({ stage, count: totals[stage] }));
  let worst = null;
  for (let i = 1; i < stages.length; i += 1) {
    const from = stages[i - 1];
    const to = stages[i];
    if (from.count === 0) continue;
    const lost = from.count - to.count;
    if (lost <= 0) continue;
    const lostPct = pct(lost, from.count);
    if (!worst || lostPct > worst.lostPct) {
      worst = { from: from.stage, to: to.stage, lost, lostPct, fromCount: from.count };
    }
  }
  if (worst) {
    out.push({
      level: worst.to === 'paid' || worst.to === 'checkout' ? 'critical' : 'warning',
      title: `Biggest drop: ${worst.from} → ${worst.to}`,
      detail: `${worst.lost} of ${worst.fromCount} (${worst.lostPct}%) do not make it from ${worst.from} to ${worst.to}. No amount of extra traffic changes this ratio — it is the cheapest place to gain.`,
      action: {
        kind: 'filter',
        label: `See the ${worst.lost} who stopped here`,
        filter: DROP_FILTERS[worst.to] || {},
      },
    });
  }

  // Sources whose browsing pattern is not plausibly human. Identified first so
  // they can be excluded from the praise below — recommending more of a source
  // that the same panel calls crawler traffic is worse than saying nothing.
  const botKeys = new Set(
    sources
      .filter((s) => s.counts.visitors >= 3 && s.views / s.counts.visitors >= 20)
      .map((s) => s.key),
  );

  // --- best and worst performing sources ------------------------------------
  const real = sources.filter(
    (s) => s.slot !== 0 && s.counts.visitors >= 5 && !botKeys.has(s.key),
  );
  const bySignup = [...real].sort((a, b) => b.rates.signups - a.rates.signups);
  const best = bySignup[0];
  if (best && best.rates.signups > 0) {
    out.push({
      level: 'good',
      title: `${best.label} converts best: ${best.rates.signups}% sign up`,
      detail: `${best.counts.signups} of ${best.counts.visitors} visitors. Site-wide the rate is ${pct(totals.signups, visitors)}%. If you can get more of this traffic, it is worth more per visitor than anything else here.`,
      action: {
        kind: 'filter',
        label: `See the ${best.counts.signups} who converted`,
        filter: { source: best.key, signed: 'yes' },
      },
    });
  }

  const dead = real.filter((s) => s.counts.signups === 0 && s.counts.visitors >= 10);
  for (const s of dead.slice(0, 2)) {
    out.push({
      level: 'warning',
      title: `${s.label} sent ${s.counts.visitors} visitors and zero signups`,
      detail: `${s.sessions} sessions, ${s.views} views, nobody converted. Either the audience is wrong or the landing page (${s.topPage}) does not speak to them.`,
      action: {
        kind: 'filter',
        label: `See these ${s.counts.visitors}`,
        filter: { source: s.key },
      },
    });
  }

  // --- traffic that probably is not human -----------------------------------
  for (const s of sources.filter((x) => botKeys.has(x.key))) {
    const perVisitor = s.views / s.counts.visitors;
    out.push({
      level: 'warning',
      title: `${s.label} averages ${Math.round(perVisitor)} pageviews per visitor`,
      detail: `${s.views} views across ${s.counts.visitors} people. Humans do not browse like that — this is likely crawlers, and counting it as traffic will flatter every rate it touches.`,
      action: {
        kind: 'filter',
        label: `Inspect these ${s.counts.visitors}`,
        filter: { source: s.key },
      },
    });
  }

  // --- money that cannot be traced ------------------------------------------
  if (revenue.unattributed > 0) {
    out.push({
      level: 'warning',
      title: `${fmtMoney(revenue.unattributed, 'USD')} of revenue has no source`,
      detail: `Out of ${fmtMoney(revenue.collected, 'USD')} collected. Until checkout sends both metadata.user_id and metadata.posthog_distinct_id, this money cannot be credited to whatever produced it.`,
      action: { kind: 'link', label: 'How to fix the join', href: '/settings' },
    });
  }

  // --- instrumentation gaps -------------------------------------------------
  if (settings.events.activation && totals.scanners === 0 && visitors > 20) {
    out.push({
      level: 'critical',
      title: `Nobody fired ${settings.events.activation}`,
      detail: `${visitors} visitors, zero activations. Either the event is not being sent, or the name here does not match what the app captures.`,
      action: { kind: 'link', label: 'Check the event name', href: '/settings' },
    });
  }

  const order = { critical: 0, warning: 1, good: 2, info: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * Build the joined report from discovered sources.
 *
 * Two attributions run at once, which is why the dashboard says so out loud:
 *   - visitors / scanners / signups → FIRST touch (what found them)
 *   - checkout / paid / revenue     → LAST NON-DIRECT touch (what closed them)
 *
 * The same person can land on two different cards. That is deliberate: those
 * are different questions, and collapsing them into one number is how
 * attribution dashboards start lying.
 */
export function buildReport({ people, payments }) {
  const settings = readSettings();
  const cards = new Map();
  const cardFor = (source) => {
    if (!cards.has(source.key)) cards.set(source.key, emptyCard(source));
    return cards.get(source.key);
  };

  const ordersByUser = new Map();
  for (const order of payments.orders) {
    if (!ordersByUser.has(order.userId)) ordersByUser.set(order.userId, []);
    ordersByUser.get(order.userId).push(order);
  }

  const matchedOrderIds = new Set();
  const viaAnonymous = { orders: 0, revenue: 0 };

  // One row per person. Aggregates say how many; this says who — which is the
  // only way to check whether a number means what it looks like it means.
  const rows = [];

  // Newest event PostHog has. The hero counts UNIQUE visitors over the window,
  // so it correctly does not move when the person visiting is already counted —
  // which looks identical to a dashboard that has stopped updating. This is the
  // signal that separates "no new people" from "no new data".
  let latestEventAt = null;

  for (const person of people) {
    if (person.lastSeen) {
      const seen = new Date(person.lastSeen).getTime();
      if (!Number.isNaN(seen) && (latestEventAt === null || seen > latestEventAt)) {
        latestEventAt = seen;
      }
    }

    // ---- first touch --------------------------------------------------------
    const firstTouch = classifyTouch(person.first);
    const card = cardFor(firstTouch.source);
    if (CONFIDENCE_RANK[firstTouch.confidence] > CONFIDENCE_RANK[card.confidence]) {
      card.confidence = firstTouch.confidence;
    }
    bump(card.via, firstTouch.via);

    if (firstTouch.hasUtm) {
      card.hasUtmRows = true;
      card.taggedPeople += 1;
      bump(
        card.utms,
        [
          person.first.utmSource || '(none)',
          person.first.utmMedium || '(none)',
          person.first.utmCampaign || '(none)',
        ].join(' '),
      );
    }

    card.counts.visitors += 1;
    card.sessions += person.sessions;
    card.views += person.views;
    card.scanRuns += person.activationRuns;
    if (person.activationRuns > 0) card.counts.scanners += 1;
    if (person.signedUp) card.counts.signups += 1;
    bump(card.pages, pathOf(person.first.url));

    // Internal traffic has no "source" worth naming — what's useful is which of
    // our own pages is doing the linking.
    if (firstTouch.matchedOn === 'internal' && person.first.referrer) {
      const from = pathOf(person.first.referrer).replace(/^\/+/, '');
      if (from) bump(card.referrerPaths, from);
    }

    // ---- last non-direct touch ---------------------------------------------
    const personOrders = person.distinctIds
      .flatMap((id) => ordersByUser.get(id) || [])
      .filter((o, i, arr) => arr.findIndex((x) => x.id === o.id) === i);

    const personPaid = personOrders.filter((o) => o.paid);

    rows.push({
      id: person.personId,
      email: person.email || '',
      source: firstTouch.source.label,
      sourceKey: firstTouch.source.key,
      confidence: firstTouch.confidence,
      firstSeen: person.firstSeen,
      lastSeen: person.lastSeen,
      landing: pathOf(person.first.url),
      utm: [person.first.utmSource, person.first.utmMedium, person.first.utmCampaign]
        .filter(Boolean)
        .join(' / '),
      sessions: person.sessions,
      views: person.views,
      scanRuns: person.activationRuns,
      signedUp: person.signedUp,
      paid: personPaid.length > 0,
      orders: personPaid.length,
      revenue: Math.round(personPaid.reduce((sum, o) => sum + o.amount, 0) * 100) / 100,
    });

    if (personOrders.length === 0) continue;

    const hasLastTouch = Boolean(
      person.last.referringDomain || person.last.utmSource || person.last.utmMedium,
    );
    const payTouch = hasLastTouch ? classifyTouch(person.last) : firstTouch;
    const payCard = cardFor(payTouch.source);
    if (CONFIDENCE_RANK[payTouch.confidence] > CONFIDENCE_RANK[payCard.confidence]) {
      payCard.confidence = payTouch.confidence;
    }
    if (payTouch.hasUtm) payCard.hasUtmRows = true;

    payCard.counts.checkout += 1;
    const paidOrders = personPaid;
    if (paidOrders.length > 0) {
      payCard.counts.paid += 1;
      payCard.orders += paidOrders.length;
      payCard.revenue += paidOrders.reduce((sum, o) => sum + o.amount, 0);
      payCard.currency = paidOrders[0].currency;

      // Revenue recovered through the anonymous-id fallback, tracked so the
      // fallback's value is measurable rather than assumed.
      for (const o of paidOrders.filter((x) => x.joinedVia === 'distinct_id')) {
        viaAnonymous.orders += 1;
        viaAnonymous.revenue += o.amount;
      }
    }
    for (const o of personOrders) matchedOrderIds.add(o.id);
  }

  const orphanedOrders = payments.orders.filter((o) => o.paid && !matchedOrderIds.has(o.id));

  assignSlots(cards);

  // Every paid order lands in exactly one of three buckets:
  //   attributed   — joined to a person, counted on a source card
  //   no user id   — guest checkout, or checkout that stopped setting metadata
  //   orphaned     — carried a user id that matches no PostHog person
  // Reporting only the first would understate revenue against Stripe with no
  // way to notice, so all three are surfaced and the three must sum to the
  // total collected.
  const noUserId = payments.noUserId || { orders: 0, revenue: 0, currency: 'USD' };
  const orphanedRevenue = orphanedOrders.reduce((sum, o) => sum + o.amount, 0);

  const sources = [...cards.values()]
    .map((card) => {
      const visitors = card.counts.visitors;
      const pct = (n) => (visitors > 0 ? Math.round((n / visitors) * 100) : 0);
      const internalPaths = topKeys(card.referrerPaths, 2);

      return {
        key: card.key,
        label: card.label,
        glyph: card.glyph,
        slot: card.slot,
        via: internalPaths.length ? internalPaths.join(' / ') : topKeys(card.via)[0] || '—',
        confidence: card.confidence,
        utmState: card.hasUtmRows ? 'seen' : card.key === 'direct' ? 'needed' : 'none',
        counts: card.counts,
        rates: Object.fromEntries(STAGES.map((s) => [s, pct(card.counts[s])])),
        sessions: card.sessions,
        views: card.views,
        scanRuns: card.scanRuns,
        orders: card.orders,
        revenue: Math.round(card.revenue * 100) / 100,
        currency: card.currency,
        topPage: topKeys(card.pages)[0] || '/',
        taggedPeople: card.taggedPeople,
        utms: [...card.utms.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([combo, count]) => {
            const [source, medium, campaign] = combo.split(' ');
            return { source, medium, campaign, count };
          }),
      };
    })
    // Reach first, then money. Colors key off `slot` (hashed from the source
    // key), never off this order, so nothing gets repainted by a re-rank.
    .sort((a, b) => b.counts.visitors - a.counts.visitors || b.revenue - a.revenue);

  const totals = STAGES.reduce((acc, stage) => {
    acc[stage] = sources.reduce((sum, s) => sum + s.counts[stage], 0);
    return acc;
  }, {});

  const direct = sources.find((s) => s.key === 'direct');

  // Stage every person, then order by priority rather than by revenue alone —
  // the point of a pipeline is who to contact next, and the biggest number is
  // usually someone who has already paid.
  const now = Date.now();
  const pipelineRows = rows
    .map((row) => ({ ...row, ...classifyForPipeline(row, now) }))
    .sort((a, b) => b.score - a.score);

  const round = (n) => Math.round(n * 100) / 100;
  const attributed = round(sources.reduce((sum, s) => sum + s.revenue, 0));
  const unattributed = round(noUserId.revenue + orphanedRevenue);

  return {
    generatedAt: new Date().toISOString(),
    latestEventAt: latestEventAt === null ? null : new Date(latestEventAt).toISOString(),
    windowDays: settings.windowDays,
    activationEvent: settings.events.activation,
    signupEvent: settings.events.signup,
    stages: STAGES,
    totals,
    revenue: {
      attributed,
      unattributed,
      collected: round(attributed + unattributed),
      noUserIdOrders: noUserId.orders,
      orphanedOrders: orphanedOrders.length,
      // Subset of `attributed` that only joined because of the anonymous id.
      viaAnonymousId: round(viaAnonymous.revenue),
      anonymousOrders: viaAnonymous.orders,
    },
    currency:
      sources.find((s) => s.revenue > 0)?.currency ||
      (noUserId.orders > 0 ? noUserId.currency : 'USD'),
    sources,
    // Most consequential people first: buyers, then signups, then whoever was
    // here most recently. Capped so a large window cannot blow up the payload.
    people: pipelineRows.slice(0, 1000),
    peopleTotal: pipelineRows.length,
    pipeline: PIPELINE_STAGES.map((stage) => {
      const inStage = pipelineRows.filter((r) => r.stage === stage.key);
      return {
        key: stage.key,
        label: stage.label,
        description: stage.description,
        count: inStage.length,
        // Reachability is the difference between a lead and a statistic.
        reachable: inStage.filter((r) => r.email).length,
        revenue: Math.round(inStage.reduce((sum, r) => sum + r.revenue, 0) * 100) / 100,
      };
    }).filter((stage) => stage.count > 0),
    findings: deriveFindings({
      sources,
      totals,
      revenue: { attributed, unattributed, collected: round(attributed + unattributed) },
      settings,
    }),
    warnings: [
      !settings.events.activation && {
        level: 'warning',
        text: 'No activation event set, so Scanners reads 0 everywhere. Pick one in Settings.',
      },
      settings.siteHosts.length === 0 && {
        level: 'warning',
        text: 'No site hosts set, so your own internal links are being counted as referral traffic. Add them in Settings.',
      },
      // Now that the anonymous id is a valid join key, an order reaching this
      // bucket carried NEITHER — which is fixable, so the message says how.
      noUserId.orders > 0 && {
        level: 'warning',
        text: `${noUserId.orders} paid order${noUserId.orders === 1 ? '' : 's'} (${fmtMoney(noUserId.revenue, noUserId.currency)}) carried neither a user_id nor a PostHog distinct_id, so ${noUserId.orders === 1 ? 'it is' : 'they are'} not attributed to any source. For guest checkout, pass posthog.get_distinct_id() as metadata.posthog_distinct_id.`,
      },
      orphanedOrders.length > 0 && {
        level: 'serious',
        text: `${orphanedOrders.length} paid order${orphanedOrders.length === 1 ? '' : 's'} (${fmtMoney(orphanedRevenue, noUserId.currency)}) carried a user_id matching no PostHog person — identify() and checkout are using different ids.`,
      },
      direct &&
        direct.counts.visitors > 0 && {
          level: 'warning',
          text: `${direct.counts.visitors} visitors arrived untagged. Add ?utm_source= to links you post — mobile clients strip referrers.`,
        },
    ].filter(Boolean),
  };
}

export { STAGES };
