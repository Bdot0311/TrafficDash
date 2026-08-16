import { readSettings } from './settings.js';

/**
 * Sources are DISCOVERED from the data, never declared up front.
 *
 * A card exists because someone actually arrived that way. There is no list of
 * expected sources to fall out of date, and nothing shows up with zero traffic.
 *
 * The registry below is display polish only — a nicer label, a glyph, and
 * domain aliasing for places people commonly post links. An unknown source
 * still gets a card; it just gets a derived name.
 */
const REGISTRY = [
  { key: 'reddit', label: 'Reddit', glyph: '◈', domains: ['reddit.com', 'redd.it'], apps: ['com.reddit.frontpage'], utm: ['reddit'] },
  { key: 'x', label: 'X / Twitter', glyph: '✕', domains: ['x.com', 'twitter.com', 't.co'], apps: ['com.twitter.android'], utm: ['x', 'twitter'] },
  { key: 'hackernews', label: 'Hacker News', glyph: 'Y', domains: ['news.ycombinator.com'], utm: ['hn', 'hackernews'] },
  { key: 'linkedin', label: 'LinkedIn', glyph: 'in', domains: ['linkedin.com', 'lnkd.in'], apps: ['com.linkedin.android'], utm: ['linkedin'] },
  { key: 'producthunt', label: 'Product Hunt', glyph: 'P', domains: ['producthunt.com'], utm: ['producthunt'] },
  { key: 'microlaunch', label: 'Microlaunch', glyph: '▲', domains: ['microlaunch.net'], utm: ['microlaunch'] },
  { key: 'trustmrr', label: 'TrustMRR', glyph: '★', domains: ['trustmrr.com'], utm: ['trustmrr'] },
  { key: 'google', label: 'Google', glyph: 'G', domains: ['google.com', 'google.co.uk', 'news.google.com'], utm: ['google', 'adwords'] },
  { key: 'bing', label: 'Bing', glyph: 'b', domains: ['bing.com'], utm: ['bing'] },
  { key: 'duckduckgo', label: 'DuckDuckGo', glyph: 'D', domains: ['duckduckgo.com'], utm: ['duckduckgo'] },
  { key: 'github', label: 'GitHub', glyph: '⑂', domains: ['github.com'], utm: ['github'] },
  { key: 'youtube', label: 'YouTube', glyph: '▶', domains: ['youtube.com', 'youtu.be'], utm: ['youtube'] },
  { key: 'discord', label: 'Discord', glyph: '◉', domains: ['discord.com', 'discord.gg'], apps: ['com.discord'], utm: ['discord'] },
  { key: 'slack', label: 'Slack', glyph: '#', domains: ['slack.com'], apps: ['com.tinyspeck.chatlyio', 'com.slack'], utm: ['slack'] },
  { key: 'facebook', label: 'Facebook', glyph: 'f', domains: ['facebook.com', 'l.facebook.com'], apps: ['com.facebook.katana', 'com.facebook.orca'], utm: ['facebook', 'meta'] },
  { key: 'instagram', label: 'Instagram', glyph: '◐', domains: ['instagram.com'], apps: ['com.instagram.android'], utm: ['instagram'] },
  { key: 'resend', label: 'Email (Resend)', glyph: '✉', domains: ['resend.com'], utm: ['resend'] },
  { key: 'sequenzy', label: 'Email (Sequenzy)', glyph: '✉', domains: ['sequenzy.com'], utm: ['sequenzy'] },
  { key: 'email', label: 'Email', glyph: '✉', domains: [], apps: ['com.google.android.gm', 'com.apple.mobilemail', 'com.microsoft.office.outlook'], utm: ['email', 'newsletter', 'lifecycle'] },
];

// Residuals, not acquisition channels. Slot 0 = neutral chip, no source color.
export const INTERNAL = { key: 'internal', label: 'Internal (Site Links)', glyph: '⧉', slot: 0 };
export const DIRECT = { key: 'direct', label: 'Direct (Untagged)', glyph: '⌂', slot: 0 };

const lower = (s) => String(s || '').toLowerCase().trim();

function bareDomain(domain) {
  return lower(domain).replace(/^www\./, '');
}

export function pathOf(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url && url.startsWith('/') ? url.split('?')[0] : '/';
  }
}

function paramsOf(url) {
  try {
    return new URL(url).searchParams;
  } catch {
    const i = String(url || '').indexOf('?');
    return new URLSearchParams(i === -1 ? '' : String(url).slice(i + 1));
  }
}

function isOwnHost(domain) {
  const d = bareDomain(domain);
  if (!d) return false;
  return readSettings().siteHosts.some((h) => {
    const host = bareDomain(h);
    return d === host || d.endsWith('.' + host);
  });
}

/**
 * Match a referring domain, including the app package ids that mobile apps
 * report instead of a hostname.
 *
 * Android sends `com.linkedin.android` when someone taps a link inside the
 * LinkedIn app. Left unmapped it becomes its own card, splitting one source
 * across two rows and understating both — which is exactly the traffic most
 * likely to be undercounted already, since apps also strip referrers.
 *
 * App ids are matched exactly: `com.linkedin.android` is a package name, not a
 * domain, so suffix matching would be wrong.
 */
function lookupByDomain(domain) {
  const d = bareDomain(domain);
  return REGISTRY.find(
    (r) =>
      r.domains.some((x) => d === x || d.endsWith('.' + x)) ||
      (r.apps || []).some((x) => d === x),
  );
}

function lookupByUtm(utmSource, utmMedium, utmCampaign) {
  const tokens = [utmSource, utmMedium, utmCampaign].map(lower).filter(Boolean);
  return REGISTRY.find((r) => r.utm.some((needle) => tokens.some((t) => t.includes(needle))));
}

/**
 * Stable color slot, derived from the source key itself.
 *
 * Deliberately not the row index: a source keeps its color when the ranking
 * changes or a filter drops its neighbours, so "Reddit is the orange one" stays
 * true across refreshes.
 */
export function slotFor(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return (hash % 8) + 1;
}

function titleCase(s) {
  return String(s)
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function decorate(key, label, glyph) {
  const override = readSettings().sourceLabels?.[key];
  return {
    key,
    label: override?.label || label,
    glyph: override?.glyph || glyph,
    slot: slotFor(key),
  };
}

/**
 * Classify one touch — either the first, or the last non-direct one.
 *
 * Confidence describes how the source was identified, not how much traffic it
 * sent:
 *   high   — a UTM parameter declared it
 *   medium — the browser reported a referring domain
 *   low    — a ?ref= convention, an own-domain referrer, or nothing at all
 *
 * Mobile clients strip referrers, which is why untagged traffic lands in Direct
 * flagged "needs UTM" instead of being guessed at.
 */
export function classifyTouch(touch) {
  const utmSource = lower(touch.utmSource);
  const utmMedium = lower(touch.utmMedium);
  const utmCampaign = lower(touch.utmCampaign);
  const hasUtm = Boolean(utmSource || utmMedium || utmCampaign);
  const domain = bareDomain(touch.referringDomain);

  // 1. A UTM said so outright.
  if (hasUtm) {
    const known = lookupByUtm(utmSource, utmMedium, utmCampaign);
    const key = known?.key || utmSource || utmMedium;
    const source = decorate(key, known?.label || titleCase(key), known?.glyph || '#');
    return {
      source,
      confidence: 'high',
      matchedOn: 'utm',
      hasUtm: true,
      via: utmSource ? `utm_source=${utmSource}` : `utm_medium=${utmMedium}`,
    };
  }

  // 2. Our own pages linking to our own pages is not acquisition.
  if (domain && isOwnHost(domain)) {
    return {
      source: { ...INTERNAL },
      confidence: 'low',
      matchedOn: 'internal',
      hasUtm: false,
      via: 'own-domain links',
    };
  }

  // 3. A referring domain the browser actually reported.
  if (domain) {
    const known = lookupByDomain(domain);
    const key = known?.key || domain;
    const source = decorate(key, known?.label || domain, known?.glyph || '↗');
    return { source, confidence: 'medium', matchedOn: 'referrer', hasUtm: false, via: domain };
  }

  // 4. A bare ?ref= convention — weaker than a UTM, but better than nothing.
  const ref = lower(paramsOf(touch.url).get('ref') || '');
  if (ref) {
    const known = REGISTRY.find((r) => r.key === ref || r.utm.includes(ref));
    const key = known?.key || ref;
    const source = decorate(key, known?.label || titleCase(key), known?.glyph || '↗');
    return { source, confidence: 'low', matchedOn: 'ref', hasUtm: false, via: `ref=${ref}` };
  }

  return {
    source: { ...DIRECT },
    confidence: 'low',
    matchedOn: 'none',
    hasUtm: false,
    via: 'direct',
  };
}
