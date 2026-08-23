import crypto from 'node:crypto';
import { readSettings } from './settings.js';
import { readContacts, saveContacts } from './contacts.js';

/**
 * Identity enrichment against RB2B / Retention.com Core Identity.
 *
 * Core Identity is EMAIL IN, PROFILE OUT — three routes sharing one input,
 * differing only in the slice they return. It cannot turn an anonymous visitor
 * into a person; that is the separate Identity Resolution product. So this
 * enriches people TrafficDash already has an address for, which is exactly the
 * set the pipeline can already act on.
 *
 * Credits are bought, finite and spent per successful lookup, so this is built
 * to be stingy rather than convenient:
 *
 *   - never runs on its own, only when asked
 *   - never exceeds the per-run cap, checked before the first call
 *   - never spends twice on the same person — misses are recorded too, so a
 *     second run does not pay to learn the same nothing again
 *   - stops the moment the API says the budget is gone, mid-run
 */

const ROUTES = {
  business: '/api/v1/identity/business', // employer, title, seniority, firmographics
  person: '/api/v1/identity/person', // everything: work + personal
  consumer: '/api/v1/identity/consumer', // B2C slice
};

const DEFAULT_BASE = 'https://api.rb2b.com';

function apiConfig() {
  const { rb2b = {} } = readSettings();
  return {
    apiKey: rb2b.apiKey || '',
    baseUrl: (rb2b.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    route: ROUTES[rb2b.route] ? rb2b.route : 'business',
    maxPerRun: Math.max(1, Number(rb2b.maxPerRun) || 25),
    // Sending MD5 instead of the address is supported by the same routes and
    // means the plaintext never leaves this machine.
    hashEmails: rb2b.hashEmails !== false,
  };
}

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

async function callRoute(path, body) {
  const { apiKey, baseUrl } = apiConfig();

  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    const message = payload?.message || payload?.error || text.slice(0, 200);
    return { ok: false, status: res.status, error: `${res.status}: ${message}` };
  }
  return { ok: true, payload };
}

/**
 * Flatten a profile response.
 *
 * Field names differ between the three routes, so match the obvious
 * candidates. A missing field must read as absent rather than becoming the
 * string "undefined" in a CSV that then gets emailed.
 */
function toContact(payload, email) {
  const p = payload?.profile || payload?.data || payload?.person || payload || {};
  const first = p.first_name || p.firstName || '';
  const last = p.last_name || p.lastName || '';

  const contact = {
    email: (p.business_email || p.work_email || p.email || email || '').toLowerCase(),
    firstName: first,
    lastName: last,
    name: [first, last].filter(Boolean).join(' ') || p.full_name || p.name || '',
    title: p.title || p.job_title || '',
    seniority: p.seniority || '',
    company: p.company_name || p.company || p.employer || '',
    linkedin: p.linkedin_url || p.linkedin || '',
    website: p.website || p.company_domain || p.domain || '',
    industry: p.industry || '',
    employees: String(p.employee_count || p.employees || p.company_size || ''),
    city: p.city || '',
    region: p.state || p.region || '',
    via: 'core-identity',
  };

  const hasSomething = contact.name || contact.company || contact.title || contact.linkedin;
  return hasSomething ? contact : null;
}

/** True when the API is saying the money ran out — stop, do not keep trying. */
const isBudgetError = (error = '') =>
  /credit|quota|insufficient|payment required|402|429/i.test(error);

/**
 * Enrich a selection of people who already have an email.
 *
 * Rows without one are skipped rather than attempted: Core Identity has no
 * input for them, and calling anyway would burn credits on certain failure.
 */
export async function enrichPeople(rows, { limit } = {}) {
  const { apiKey, route, maxPerRun, hashEmails } = apiConfig();
  if (!apiKey) return { ok: false, error: 'No RB2B API key saved. Add one in Settings.' };

  const cap = Math.min(Number(limit) || maxPerRun, maxPerRun);

  // Everyone already looked up, hit or miss. Skipping misses is the point:
  // paying twice to learn the same nothing is the easiest way to waste a
  // hundred credits.
  const alreadyTried = new Set(readContacts().map((c) => c.sourceKey).filter(Boolean));

  const candidates = rows.filter(
    (r) => r.email && !r.contact && !alreadyTried.has(r.id),
  );
  const selected = candidates.slice(0, cap);

  const results = [];
  let matched = 0;
  let misses = 0;
  let stoppedBecause = null;

  for (const row of selected) {
    const address = row.email.trim().toLowerCase();
    const body = hashEmails ? { email: md5(address) } : { email: address };

    const result = await callRoute(ROUTES[route], body);

    if (!result.ok) {
      if (isBudgetError(result.error)) {
        stoppedBecause = `Stopped after ${matched + misses}: ${result.error}`;
        break;
      }
      misses += 1;
      results.push({ sourceKey: row.id, email: address, miss: true, via: 'core-identity' });
      continue;
    }

    const contact = toContact(result.payload, address);
    if (contact) {
      matched += 1;
      results.push({ ...contact, sourceKey: row.id });
    } else {
      misses += 1;
      results.push({ sourceKey: row.id, email: address, miss: true, via: 'core-identity' });
    }
  }

  if (results.length) saveContacts(results);

  return {
    ok: true,
    attempted: selected.length,
    matched,
    misses,
    skippedNoEmail: rows.filter((r) => !r.email && !r.contact).length,
    remaining: Math.max(0, candidates.length - selected.length),
    stoppedBecause,
  };
}

/** How many credits a run would spend at most, without spending any. */
export function enrichPreview(rows, { limit } = {}) {
  const { maxPerRun } = apiConfig();
  const cap = Math.min(Number(limit) || maxPerRun, maxPerRun);
  const alreadyTried = new Set(readContacts().map((c) => c.sourceKey).filter(Boolean));

  const candidates = rows.filter((r) => r.email && !r.contact && !alreadyTried.has(r.id));
  return {
    eligible: candidates.length,
    willAttempt: Math.min(candidates.length, cap),
    cap,
    skippedNoEmail: rows.filter((r) => !r.email && !r.contact).length,
  };
}

/**
 * Probe for the Settings page.
 *
 * Uses a `.invalid` address, which by RFC 2606 can never belong to anyone — so
 * it exercises auth and entitlement without matching a person, and should not
 * consume a credit. Reports "no access" separately from "bad key", because
 * Core Identity and Identity Resolution are granted separately and a working
 * key with no entitlement is the likely first state.
 */
export async function testRb2b() {
  const { apiKey, route } = apiConfig();
  if (!apiKey) return { ok: false, error: 'A RB2B API key is required.' };

  const result = await callRoute(ROUTES[route], {
    email: md5(`trafficdash-probe-${Date.now()}@example.invalid`),
  });

  if (result.ok) {
    return { ok: true, detail: `Key accepted; ${ROUTES[route]} is enabled.` };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      error: `${result.error} — key rejected for this route. Core Identity and Identity Resolution are granted separately; check which one this key covers.`,
    };
  }
  if (result.status === 404) {
    return { ok: false, error: `${result.error} — check the base URL in Settings.` };
  }
  return { ok: false, error: result.error };
}

export { ROUTES };
