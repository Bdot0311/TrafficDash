import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeSettings } from '../src/settings.js';
import { buildReport } from '../src/report.js';
import { classifyTouch, slotFor } from '../src/classify.js';
import { buildPeopleQuery } from '../src/posthog.js';

/**
 * These exercise the discovery + join logic against synthetic events. Nothing
 * here declares a source up front — every card below exists because a
 * synthetic person arrived that way, same as in production.
 */
const person = (over = {}) => ({
  personId: 'p' + Math.random(),
  distinctIds: [over.userId || 'u' + Math.random()],
  first: { url: 'https://example.com/', referringDomain: '', referrer: '', utmSource: '', utmMedium: '', utmCampaign: '', ...over.first },
  last: { url: '', referringDomain: '', utmSource: '', utmMedium: '', utmCampaign: '', ...over.last },
  sessions: 1,
  views: 1,
  activationRuns: 0,
  signedUp: false,
  email: '',
  ...over,
});

before(() => {
  // Never write over real saved credentials during a test run.
  process.env.TRAFFICDASH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trafficdash-test-'));
  writeSettings({
    siteHosts: ['example.com'],
    events: { activation: 'scan_run', signup: 'signup' },
    windowDays: 30,
  });
});

test('sources are discovered from the data, not declared', () => {
  const report = buildReport({
    people: [
      person({ first: { referringDomain: 'reddit.com' } }),
      person({ first: { referringDomain: 'reddit.com' } }),
      person({ first: { referringDomain: 'some-blog.example.net' } }),
      person({}), // no referrer, no utm
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  assert.deepEqual(
    report.sources.map((s) => s.key),
    ['reddit', 'some-blog.example.net', 'direct'],
  );
  // An unknown referrer still gets a card, named after itself.
  const blog = report.sources.find((s) => s.key === 'some-blog.example.net');
  assert.equal(blog.label, 'some-blog.example.net');
  assert.equal(blog.confidence, 'medium');
});

test('a source with no traffic never appears', () => {
  const report = buildReport({
    people: [person({ first: { referringDomain: 'reddit.com' } })],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources.find((s) => s.key === 'trustmrr'), undefined);
});

test('own-domain referrals are internal, never acquisition', () => {
  const touch = classifyTouch({
    url: 'https://example.com/pricing',
    referringDomain: 'example.com',
    referrer: 'https://example.com/playbooks',
  });
  assert.equal(touch.source.key, 'internal');
  assert.equal(touch.source.slot, 0); // neutral chip, no source color

  const report = buildReport({
    people: [
      person({ first: { referringDomain: 'example.com', referrer: 'https://example.com/playbooks' } }),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  // The card names the page doing the linking, not the domain.
  assert.equal(report.sources[0].via, 'playbooks');
});

test('confidence tracks how the source was identified', () => {
  assert.equal(classifyTouch({ utmSource: 'reddit' }).confidence, 'high');
  assert.equal(classifyTouch({ referringDomain: 'reddit.com' }).confidence, 'medium');
  assert.equal(classifyTouch({ url: 'https://example.com/?ref=microlaunch' }).confidence, 'low');
  assert.equal(classifyTouch({}).confidence, 'low');
});

test('color follows the source identity, never its rank', () => {
  assert.equal(slotFor('reddit'), slotFor('reddit')); // deterministic

  const domains = ['reddit.com', 'news.ycombinator.com', 'trustmrr.com'];
  const build = (counts) =>
    buildReport({
      people: domains.flatMap((d, i) =>
        Array.from({ length: counts[i] }, () => person({ first: { referringDomain: d } })),
      ),
      payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
    });

  // Same three sources, opposite ranking. Every hue must stay put.
  const a = build([10, 5, 1]);
  const b = build([1, 5, 10]);
  assert.notEqual(a.sources[0].key, b.sources[0].key, 'expected the ranking to flip');
  for (const source of a.sources) {
    assert.equal(source.slot, b.sources.find((s) => s.key === source.key).slot);
  }
});

test('no two sources share a color, and hues are never cycled past eight', () => {
  // Ten distinct referrers — two more than there are categorical slots.
  const report = buildReport({
    people: Array.from({ length: 10 }, (_, i) =>
      person({ first: { referringDomain: `site-${i}.example.net` } }),
    ),
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  const colored = report.sources.filter((s) => s.slot > 0).map((s) => s.slot);
  assert.equal(colored.length, 8, 'exactly eight sources should carry a hue');
  assert.equal(new Set(colored).size, 8, 'no hue may be reused');
  // The tail takes the neutral chip rather than a ninth generated color.
  assert.equal(report.sources.filter((s) => s.slot === 0).length, 2);
});

test('Stripe revenue joins to a traffic source through metadata.user_id', () => {
  const buyer = person({
    userId: 'user_42',
    distinctIds: ['user_42'],
    first: { utmSource: 'sequenzy', utmMedium: 'email', utmCampaign: 'lifecycle-d3' },
    last: { utmSource: 'sequenzy', utmMedium: 'email', utmCampaign: 'lifecycle-d3' },
  });

  const report = buildReport({
    people: [buyer, person({ first: { referringDomain: 'reddit.com' } })],
    payments: {
      orders: [
        { id: 'cs_1', userId: 'user_42', paid: true, amount: 9, currency: 'USD', status: 'complete' },
      ],
      noUserId: { orders: 0, revenue: 0, currency: 'USD' },
    },
  });

  const email = report.sources.find((s) => s.key === 'sequenzy');
  assert.equal(email.counts.checkout, 1);
  assert.equal(email.counts.paid, 1);
  assert.equal(email.revenue, 9);
  assert.equal(email.rates.paid, 100);
  assert.equal(email.utmState, 'seen');
  assert.equal(email.confidence, 'high');
  // Nobody else is credited for it.
  assert.equal(report.sources.find((s) => s.key === 'reddit').revenue, 0);
  assert.equal(report.revenue.attributed, 9);
  assert.equal(report.revenue.collected, 9);
});

test('rates are a share of that source’s own visitors', () => {
  const report = buildReport({
    people: [
      ...Array.from({ length: 4 }, () => person({ first: { referringDomain: 'reddit.com' }, activationRuns: 1 })),
      ...Array.from({ length: 14 }, () => person({ first: { referringDomain: 'reddit.com' } })),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  assert.equal(report.sources[0].counts.visitors, 18);
  assert.equal(report.sources[0].rates.scanners, 22); // 4 / 18
});

test('unjoinable revenue is counted, not dropped', () => {
  // Two orders worth $200 that carry no usable id at all, alongside one
  // attributed $9 order. An earlier shape kept only a count, so the $200
  // vanished from every total.
  const buyer = person({ userId: 'u_1', distinctIds: ['u_1'], first: { utmSource: 'reddit' } });
  const report = buildReport({
    people: [buyer],
    payments: {
      orders: [{ id: 'cs_1', userId: 'u_1', paid: true, amount: 9, currency: 'USD' }],
      noUserId: { orders: 2, revenue: 200, currency: 'USD' },
    },
  });

  assert.equal(report.revenue.attributed, 9);
  assert.equal(report.revenue.unattributed, 200);
  assert.equal(report.revenue.collected, 209, 'collected must match Stripe, not just the cards');
  assert.equal(report.revenue.noUserIdOrders, 2);

  // Reported with the money attached, and never as a broken join.
  const warning = report.warnings.find((w) => /neither a user_id/.test(w.text));
  assert.ok(warning);
  assert.equal(warning.level, 'warning');
  assert.match(warning.text, /\$200\.00/);
});

test('guest checkout attributes through the anonymous distinct_id', () => {
  // A guest who never signs up: PostHog knows them only by the browser's
  // anonymous distinct_id, which is also what checkout put in the metadata.
  const guest = person({
    distinctIds: ['anon_abc123'],
    first: { referringDomain: 'reddit.com' },
  });

  const report = buildReport({
    people: [guest],
    payments: {
      orders: [
        {
          id: 'cs_guest',
          userId: 'anon_abc123',
          joinedVia: 'distinct_id',
          paid: true,
          amount: 49,
          currency: 'USD',
        },
      ],
      noUserId: { orders: 0, revenue: 0, currency: 'USD' },
    },
  });

  const reddit = report.sources.find((s) => s.key === 'reddit');
  assert.equal(reddit.counts.paid, 1, 'guest revenue should reach the source card');
  assert.equal(reddit.revenue, 49);
  assert.equal(report.revenue.attributed, 49);
  assert.equal(report.revenue.unattributed, 0);
  // Recovered revenue is tracked separately so the fallback's value is visible.
  assert.equal(report.revenue.viaAnonymousId, 49);
  assert.equal(report.revenue.anonymousOrders, 1);
});

test('a guest who later signs up is one person, not two', () => {
  // identify() merges the anonymous id onto the person, so PostHog returns
  // both ids. An order keyed on either must land on the same card once.
  const buyer = person({
    distinctIds: ['anon_abc123', 'supabase-uuid-1'],
    first: { referringDomain: 'reddit.com' },
    signedUp: true,
  });

  const report = buildReport({
    people: [buyer],
    payments: {
      orders: [
        { id: 'cs_a', userId: 'anon_abc123', joinedVia: 'distinct_id', paid: true, amount: 10, currency: 'USD' },
        { id: 'cs_b', userId: 'supabase-uuid-1', joinedVia: 'user_id', paid: true, amount: 15, currency: 'USD' },
      ],
      noUserId: { orders: 0, revenue: 0, currency: 'USD' },
    },
  });

  const reddit = report.sources.find((s) => s.key === 'reddit');
  assert.equal(reddit.counts.paid, 1, 'one person, counted once');
  assert.equal(reddit.orders, 2, 'both orders still count');
  assert.equal(reddit.revenue, 25);
  assert.equal(report.revenue.viaAnonymousId, 10, 'only the anon-keyed order counts as recovered');
  assert.equal(report.revenue.collected, 25);
});

test('an order carrying neither id says how to fix it', () => {
  const report = buildReport({
    people: [person({})],
    payments: { orders: [], noUserId: { orders: 3, revenue: 75, currency: 'USD' } },
  });
  const warning = report.warnings.find((w) => /neither a user_id/.test(w.text));
  assert.ok(warning);
  assert.match(warning.text, /posthog_distinct_id/);
  assert.equal(report.revenue.unattributed, 75);
});

test('attributed + unattributed always reconciles to collected', () => {
  const buyer = person({ userId: 'u_1', distinctIds: ['u_1'], first: { utmSource: 'reddit' } });
  const report = buildReport({
    people: [buyer],
    payments: {
      orders: [
        { id: 'cs_1', userId: 'u_1', paid: true, amount: 9, currency: 'USD' },
        // carries an id, but no person matches it
        { id: 'cs_2', userId: 'ghost', paid: true, amount: 41, currency: 'USD' },
      ],
      noUserId: { orders: 1, revenue: 50, currency: 'USD' },
    },
  });

  const { attributed, unattributed, collected } = report.revenue;
  assert.equal(attributed, 9);
  assert.equal(unattributed, 91); // 41 orphaned + 50 guest
  assert.equal(collected, 100);
  assert.equal(attributed + unattributed, collected);
});

test('a paid order whose user_id matches no person is reported as a real fault', () => {
  const report = buildReport({
    people: [person({})],
    payments: {
      orders: [{ id: 'cs_x', userId: 'ghost', paid: true, amount: 20, currency: 'USD' }],
      noUserId: { orders: 0, revenue: 0, currency: 'USD' },
    },
  });
  // Unlike guest checkout, this one means identify() and checkout disagree.
  assert.equal(report.warnings.find((w) => /no PostHog person/.test(w.text))?.level, 'serious');
  // And its money still shows up in the collected total.
  assert.equal(report.revenue.unattributed, 20);
  assert.equal(report.revenue.collected, 20);
});

test('an unset activation event counts nobody rather than everybody', () => {
  writeSettings({ events: { activation: '', signup: '' } });
  const report = buildReport({
    people: [person({ activationRuns: 3 })],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  assert.ok(report.warnings.some((w) => /No activation event set/.test(w.text)));
  writeSettings({ events: { activation: 'scan_run', signup: 'signup' } });
});

test('the generated HogQL never references properties outside a table scope', () => {
  const sql = buildPeopleQuery({ days: 30, activation: 'scan_run', signup: 'signup' });

  // A WITH clause is bound before the FROM scope exists, so any properties.*
  // reference hoisted up there fails validation with "No scope or CTE
  // available" — which is exactly how this query broke in production.
  assert.ok(!/^\s*WITH\b/im.test(sql), 'query must not open with a WITH clause');

  // Every properties.* reference has to sit inside the SELECT/WHERE of the
  // query that owns the FROM.
  const fromIndex = sql.indexOf('FROM events');
  assert.ok(fromIndex > 0, 'expected a FROM events clause');
  assert.ok(sql.indexOf('SELECT') < fromIndex, 'SELECT must precede FROM');

  // No leftover aliases from the old WITH form.
  assert.ok(!/\bref_domain\b/.test(sql), 'ref_domain alias should be inlined');
  assert.ok(!/\bhas_ref\b/.test(sql), 'has_ref alias should be inlined');
});

test('an unset activation event never becomes a match-everything clause', () => {
  const sql = buildPeopleQuery({ days: 30, activation: '', signup: '' });
  assert.match(sql, /0\s+AS activation_runs/);
  assert.match(sql, /0\s+AS signup_events/);

  const withEvents = buildPeopleQuery({ days: 30, activation: "o'brien", signup: 'signup' });
  // Event names are quoted, so an apostrophe cannot break out of the literal.
  assert.match(withEvents, /countIf\(event = 'o\\'brien'\)/);
});

test('mobile app referrers fold into the source they belong to', () => {
  // Android reports the app package id instead of a hostname. Unmapped, these
  // become their own cards and split one source across two rows.
  assert.equal(classifyTouch({ referringDomain: 'com.linkedin.android' }).source.key, 'linkedin');
  assert.equal(classifyTouch({ referringDomain: 'com.twitter.android' }).source.key, 'x');
  assert.equal(classifyTouch({ referringDomain: 'com.reddit.frontpage' }).source.key, 'reddit');
  assert.equal(classifyTouch({ referringDomain: 'com.google.android.gm' }).source.key, 'email');

  // Web and app traffic land on one card, counted together.
  const report = buildReport({
    people: [
      ...Array.from({ length: 24 }, () => person({ first: { referringDomain: 'linkedin.com' } })),
      ...Array.from({ length: 9 }, () => person({ first: { referringDomain: 'com.linkedin.android' } })),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  assert.equal(report.sources.length, 1, 'app and web traffic must not split');
  assert.equal(report.sources[0].key, 'linkedin');
  assert.equal(report.sources[0].counts.visitors, 33);
});

test('an app id is matched exactly, never as a domain suffix', () => {
  // Suffix matching would let evil-com.linkedin.android impersonate LinkedIn.
  const spoof = classifyTouch({ referringDomain: 'evil-com.linkedin.android' });
  assert.notEqual(spoof.source.key, 'linkedin');
});

test('latest event timestamp is reported so liveness is separable from growth', () => {
  const recent = new Date(Date.now() - 20 * 1000).toISOString();
  const older = new Date(Date.now() - 3 * 86400 * 1000).toISOString();

  const report = buildReport({
    people: [
      person({ first: { referringDomain: 'reddit.com' }, lastSeen: older }),
      person({ first: { referringDomain: 'reddit.com' }, lastSeen: recent }),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  // The newest event across everyone, not the newest person.
  assert.equal(report.latestEventAt, recent);
  // Traffic from someone already counted moves nothing in the hero, which is
  // exactly why this second signal has to exist.
  assert.equal(report.totals.visitors, 2);
});

test('latest event is null when there is nothing to report', () => {
  const report = buildReport({
    people: [],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  assert.equal(report.latestEventAt, null);
});

test('every person gets a row, ordered by who to contact next', () => {
  const buyer = person({
    userId: 'b1',
    distinctIds: ['b1'],
    email: 'buyer@example.com',
    first: { utmSource: 'reddit' },
    last: { utmSource: 'reddit' },
    signedUp: true,
    lastSeen: new Date(Date.now() - 9e6).toISOString(),
  });
  const signup = person({
    email: 'signup@example.com',
    signedUp: true,
    lastSeen: new Date(Date.now() - 8e6).toISOString(),
  });
  const lurker = person({ lastSeen: new Date().toISOString() });

  const report = buildReport({
    people: [lurker, signup, buyer],
    payments: {
      orders: [{ id: 'cs_1', userId: 'b1', paid: true, amount: 49, currency: 'USD' }],
      noUserId: { orders: 0, revenue: 0, currency: 'USD' },
    },
  });

  assert.equal(report.people.length, 3);
  assert.equal(report.peopleTotal, 3);

  // Ordered by pipeline priority, not by revenue: the signup who never
  // activated is the one to contact, and the customer who already paid is not
  // — even though the customer is the larger number.
  assert.equal(report.people[0].email, 'signup@example.com');
  assert.equal(report.people[0].stage, 'stalled');
  assert.equal(report.people[1].stage, 'passive');
  assert.equal(report.people[2].email, 'buyer@example.com');
  assert.equal(report.people[2].stage, 'customer');
  // The buyer is still fully represented, just not at the front of the queue.
  assert.equal(report.people[2].revenue, 49);
});

test('pipeline stages report how many are actually reachable', () => {
  const report = buildReport({
    people: [
      person({ email: 'a@example.com', signedUp: true, activationRuns: 2 }),
      person({ signedUp: true, activationRuns: 1 }), // hot, but no email
      person({ activationRuns: 3 }), // used it, never signed up
      person({ sessions: 1 }),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  const hot = report.pipeline.find((s) => s.key === 'hot');
  assert.equal(hot.count, 2);
  // A stage you cannot contact is not a list, so the two are reported apart.
  assert.equal(hot.reachable, 1);

  const anon = report.pipeline.find((s) => s.key === 'anon_active');
  assert.equal(anon.count, 1);
  assert.equal(anon.reachable, 0);

  // Empty stages are omitted rather than shown as zeroes.
  assert.equal(report.pipeline.some((s) => s.count === 0), false);
});

test('a stale hot lead still outranks a fresh passive visit', () => {
  const report = buildReport({
    people: [
      person({ lastSeen: new Date().toISOString() }), // passive, just now
      person({
        email: 'hot@example.com',
        signedUp: true,
        activationRuns: 2,
        lastSeen: new Date(Date.now() - 6 * 86400000).toISOString(),
      }),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });
  // Recency breaks ties between comparable people; it never promotes someone
  // who has done nothing above someone who has.
  assert.equal(report.people[0].email, 'hot@example.com');
});

test('findings name the numbers they came from', () => {
  const report = buildReport({
    people: [
      ...Array.from({ length: 80 }, () => person({})), // untagged
      ...Array.from({ length: 20 }, (_, i) =>
        person({ first: { referringDomain: 'reddit.com' }, signedUp: i < 5 }),
      ),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  const untagged = report.findings.find((f) => /cannot be attributed/.test(f.title));
  assert.ok(untagged, 'expected an attribution-coverage finding');
  assert.match(untagged.title, /80%/);
  assert.match(untagged.detail, /80 of 100/);

  // A source that converts gets credited by name and rate.
  const best = report.findings.find((f) => /converts best/.test(f.title));
  assert.match(best.title, /Reddit/);
  assert.match(best.title, /25%/);
});

test('a source flagged as crawler traffic is never also praised', () => {
  const report = buildReport({
    people: [
      // 60 views each: not plausibly human, and it "converts" well.
      ...Array.from({ length: 10 }, (_, i) =>
        person({ first: { referringDomain: 'crawlerville.example' }, views: 60, signedUp: i < 5 }),
      ),
      ...Array.from({ length: 10 }, () => person({})),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  assert.ok(report.findings.some((f) => /pageviews per visitor/.test(f.title)));
  // Recommending more of the traffic the same panel calls crawlers would be
  // worse than saying nothing.
  assert.equal(
    report.findings.some((f) => /converts best/.test(f.title) && /crawlerville/.test(f.title)),
    false,
  );
});

test('a gated lead is never counted as a signup', () => {
  writeSettings({ events: { activation: 'scan_run', signup: 'signup', lead: 'lead_captured' } });

  const report = buildReport({
    people: [
      // Gave an email at the gate. Reachable, but has no account.
      person({
        email: 'lead@example.com',
        signedUp: false,
        leadCaptured: true,
        activationRuns: 1,
        first: { referringDomain: 'reddit.com' },
      }),
      // Real account.
      person({ email: 'real@example.com', signedUp: true, activationRuns: 1 }),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  // The whole point: one signup, not two.
  assert.equal(report.totals.signups, 1);

  const lead = report.people.find((r) => r.email === 'lead@example.com');
  assert.equal(lead.stage, 'lead');
  assert.match(lead.reason, /email via gate/);

  const real = report.people.find((r) => r.email === 'real@example.com');
  assert.equal(real.stage, 'hot');

  // Reachable, and ranked above an anonymous activator for exactly that reason.
  const stage = report.pipeline.find((s) => s.key === 'lead');
  assert.equal(stage.count, 1);
  assert.equal(stage.reachable, 1);
});

test('leads outrank anonymous activators because they can be contacted', () => {
  writeSettings({ events: { activation: 'scan_run', signup: 'signup', lead: 'lead_captured' } });

  const report = buildReport({
    people: [
      person({ activationRuns: 5, sessions: 4 }), // busier, but unreachable
      person({ email: 'lead@example.com', leadCaptured: true, activationRuns: 1 }),
    ],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  assert.equal(report.people[0].stage, 'lead');
  assert.equal(report.people[1].stage, 'anon_active');
});

test('a lead event without a signup event is called out as ambiguous', () => {
  writeSettings({ events: { activation: 'scan_run', signup: '', lead: 'lead_captured' } });

  const report = buildReport({
    people: [person({ email: 'lead@example.com', leadCaptured: true, activationRuns: 1 })],
    payments: { orders: [], noUserId: { orders: 0, revenue: 0, currency: 'USD' } },
  });

  // Without a signup event, email presence is the only signup signal — and a
  // gated lead has one too, so the two cannot be told apart.
  const warning = report.warnings.find((w) => /lead event is set but no signup event/.test(w.text));
  assert.ok(warning);
  assert.equal(warning.level, 'serious');

  writeSettings({ events: { activation: 'scan_run', signup: 'signup', lead: '' } });
});
