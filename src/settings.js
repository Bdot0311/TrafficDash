import fs from 'node:fs';
import path from 'node:path';

// Resolved lazily, and overridable, so a test run never touches real saved keys.
const dataDir = () => process.env.TRAFFICDASH_DATA_DIR || path.join(process.cwd(), 'data');
const settingsFile = () => path.join(dataDir(), 'settings.json');

/** Minimal .env loader — env vars seed the defaults, the settings page wins. */
function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const DEFAULTS = {
  posthog: {
    host: process.env.POSTHOG_HOST || 'https://us.posthog.com',
    projectId: process.env.POSTHOG_PROJECT_ID || '',
    apiKey: process.env.POSTHOG_API_KEY || '',
  },
  stripe: {
    apiKey: process.env.STRIPE_API_KEY || '',
  },
  // Your own hostnames. Referrals from these are Internal (Site Links) —
  // not acquisition — and get pulled out of Direct.
  siteHosts: (process.env.SITE_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  events: {
    activation: process.env.POSTHOG_ACTIVATION_EVENT || '',
    signup: process.env.POSTHOG_SIGNUP_EVENT || '',
  },
  windowDays: Number(process.env.WINDOW_DAYS || 30),
  // Caps how stale the numbers can be. Five minutes made a live dashboard feel
  // broken; one minute is the shortest interval that still keeps API traffic
  // to roughly one read per minute per source.
  cacheSeconds: Number(process.env.CACHE_SECONDS || 60),
  // Off by default: the dashboard shows your data or nothing at all.
  sampleData: false,
  // Optional display overrides, keyed by discovered source key.
  // e.g. { "reddit.com": { "label": "Reddit", "glyph": "R" } }
  sourceLabels: {},
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base[key] || {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

let cached = null;

export function readSettings() {
  if (cached) return cached;
  let stored = {};
  const file = settingsFile();
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      stored = {};
    }
  }
  cached = deepMerge(DEFAULTS, stored);
  return cached;
}

export function writeSettings(patch) {
  const current = readSettings();
  const next = deepMerge(current, patch);

  // Normalize the bits that are easy to paste wrong.
  next.posthog.host = String(next.posthog.host || '').trim().replace(/\/+$/, '');
  next.posthog.projectId = String(next.posthog.projectId || '').trim();
  next.posthog.apiKey = String(next.posthog.apiKey || '').trim();
  next.stripe.apiKey = String(next.stripe.apiKey || '').trim();
  next.siteHosts = (Array.isArray(next.siteHosts) ? next.siteHosts : [])
    .map((h) =>
      String(h)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
    )
    .filter(Boolean);
  next.windowDays = Math.min(Math.max(Number(next.windowDays) || 30, 1), 365);
  next.cacheSeconds = Math.max(Number(next.cacheSeconds) || 0, 0);

  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  cached = next;
  return next;
}

/** Keys never travel back to the browser — only enough to confirm which one is stored. */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  const prefix = s.match(/^(phx_|rk_live_|rk_test_|sk_live_|sk_test_)/)?.[1] || '';
  return `${prefix}…${s.slice(-4)}`;
}

export function redactedSettings() {
  const s = readSettings();
  return {
    posthog: {
      host: s.posthog.host,
      projectId: s.posthog.projectId,
      apiKeySet: Boolean(s.posthog.apiKey),
      apiKeyMasked: maskKey(s.posthog.apiKey),
    },
    stripe: {
      apiKeySet: Boolean(s.stripe.apiKey),
      apiKeyMasked: maskKey(s.stripe.apiKey),
      // A writable secret key here is a real problem, not a style preference.
      usingSecretKey: /^sk_/.test(s.stripe.apiKey || ''),
    },
    siteHosts: s.siteHosts,
    events: s.events,
    windowDays: s.windowDays,
    cacheSeconds: s.cacheSeconds,
    sampleData: s.sampleData,
    sourceLabels: s.sourceLabels,
    connected: connectionState(),
  };
}

export function connectionState() {
  const s = readSettings();
  return {
    posthog: Boolean(s.posthog.apiKey && s.posthog.projectId),
    stripe: Boolean(s.stripe.apiKey),
  };
}

export { settingsFile };
