import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeSettings } from '../src/settings.js';
import { buildReport } from '../src/report.js';
import { classifyTouch, slotFor } from '../src/classify.js';

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
    payments: { orders: [], unjoinable: 0 },
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
    payments: { orders: [], unjoinable: 0 },
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
    payments: { orders: [], unjoinable: 0 },
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
      payments: { orders: [], unjoinable: 0 },
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
    payments: { orders: [], unjoinable: 0 },
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
      unjoinable: 0,
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
  assert.equal(report.totalRevenue, 9);
});

test('rates are a share of that source’s own visitors', () => {
  const report = buildReport({
    people: [
      ...Array.from({ length: 4 }, () => person({ first: { referringDomain: 'reddit.com' }, activationRuns: 1 })),
      ...Array.from({ length: 14 }, () => person({ first: { referringDomain: 'reddit.com' } })),
    ],
    payments: { orders: [], unjoinable: 0 },
  });
  assert.equal(report.sources[0].counts.visitors, 18);
  assert.equal(report.sources[0].rates.scanners, 22); // 4 / 18
});

test('a paid order with no user_id is reported, not silently dropped', () => {
  const report = buildReport({
    people: [person({})],
    payments: { orders: [], unjoinable: 2 },
  });
  const warning = report.warnings.find((w) => w.level === 'serious');
  assert.ok(warning, 'expected a serious warning for unjoinable orders');
  assert.match(warning.text, /2 paid checkout sessions/);
});

test('a paid order whose user_id matches no person is reported too', () => {
  const report = buildReport({
    people: [person({})],
    payments: {
      orders: [{ id: 'cs_x', userId: 'ghost', paid: true, amount: 20, currency: 'USD' }],
      unjoinable: 0,
    },
  });
  assert.ok(report.warnings.some((w) => /no matching PostHog person/.test(w.text)));
});

test('an unset activation event counts nobody rather than everybody', () => {
  writeSettings({ events: { activation: '', signup: '' } });
  const report = buildReport({
    people: [person({ activationRuns: 3 })],
    payments: { orders: [], unjoinable: 0 },
  });
  assert.ok(report.warnings.some((w) => /No activation event set/.test(w.text)));
  writeSettings({ events: { activation: 'scan_run', signup: 'signup' } });
});
