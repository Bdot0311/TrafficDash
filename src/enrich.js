import crypto from 'node:crypto';
import { readSettings } from './settings.js';
import { readContacts, saveContacts } from './contacts.js';

/**
 * Identity enrichment against RB2B / Retention.com Core Identity.
 *
 * Written against the published OpenAPI spec, not guessed from the marketing
 * page. The specifics that matter:
 *
 *   - auth is `X-Api-Key` (Bearer is also accepted)
 *   - single lookups answer `{ result: {...} }`, and a miss is HTTP 404 with
 *     `{ result: {} }` — a 404 here is a normal outcome, not a failure
 *   - batch takes `md5s` (max 1,000) and always answers 200 with `results`,
 *     `match_count`, `credits_charged` and `credits_exhausted`; unmatched
 *     hashes are simply absent from `results`
 *   - billing is per record: the full configured cost when both the business
 *     profile and MAID data resolve, 1 credit when only one does, 0 for a miss
 *
 * Batch is what this uses. One request for a whole selection instead of one
 * per person, `credits_charged` reported by the API rather than inferred, and
 * `credits_exhausted` as an explicit stop signal instead of a guess at what a
 * 402 meant.
 */

const ROUTES = {
  business: '/api/v1/identity/business',
  person: '/api/v1/identity/person',
  consumer: '/api/v1/identity/consumer',
};

const DEFAULT_BASE = 'https://api.rb2b.com';
const BATCH_LIMIT = 1000;

function apiConfig() {
  const { rb2b = {} } = readSettings();
  return {
    apiKey: rb2b.apiKey || '',
    baseUrl: (rb2b.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    route: ROUTES[rb2b.route] ? rb2b.route : 'business',
    maxPerRun: Math.max(1, Number(rb2b.maxPerRun) || 25),
  };
}

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

async function callRoute(path, body) {
  const { apiKey, baseUrl } = apiConfig();

  const res = await fetch(baseUrl + path, {
    method: 'POST',
    // The documented header. Bearer also works, but this is the canonical one.
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}

  return { status: res.status, ok: res.ok, payload, raw: text };
}

/** Turn one `result` object into the contact shape the rest of the app stores. */
function toContact(result) {
  if (!result || typeof result !== 'object') return null;

  const first = result.first_name || '';
  const last = result.last_name || '';

  const contact = {
    // work_email_confirmed is the only address these routes return, and it is
    // always plaintext.
    email: normalizeEmail(result.work_email_confirmed),
    firstName: first,
    lastName: last,
    name: [first, last].filter(Boolean).join(' '),
    title: result.title || '',
    seniority: result.seniority || '',
    functionalArea: result.functional_area || '',
    company: result.current_company || '',
    industry: result.current_industry || '',
    linkedin: result.linkedinurl || '',
    companyLinkedin: result.current_company_linkedinurl || '',
    website: result.current_company_url || '',
    employees: String(result.company_employee_count || result.company_employee_range || ''),
    revenue: result.company_revenue_range || '',
    region: result.country || '',
    emailConfirmedOn: result.work_email_confirmed_status || '',
    // The spec returns the full profile shape with null values when only MAID
    // data matched, so presence of the key proves nothing — check for content.
    maidCount: Array.isArray(result.maid) ? result.maid.length : 0,
    via: 'core-identity',
  };

  const hasProfile = contact.name || contact.company || contact.title || contact.linkedin;
  return hasProfile || contact.maidCount > 0 ? contact : null;
}

/** Map a documented error body onto something worth showing a person. */
function describeError({ status, payload }) {
  const code = payload?.error || '';
  if (status === 401) return `Key rejected (${code || 'unauthorised'}).`;
  if (status === 403) {
    return 'This API key is not enabled for that route. Core Identity and Identity Resolution are granted separately.';
  }
  if (status === 402) {
    const need = payload?.required;
    const have = payload?.remaining;
    return `Out of credits${need ? ` — needs ${need}, ${have} remaining` : ''}.`;
  }
  if (status === 400) {
    if (code === 'too_many_md5s') return `Batch too large (max ${payload?.max ?? BATCH_LIMIT}).`;
    if (code === 'invalid md5') return `Malformed hash at position ${payload?.index}.`;
    return `Rejected: ${code || 'bad request'}.`;
  }
  return `${status}: ${code || 'unexpected error'}`;
}

/**
 * Enrich a selection of people who already have an email.
 *
 * Rows without one are skipped rather than attempted — Core Identity is email
 * in, and there is nothing to send for an anonymous visitor.
 */
export async function enrichPeople(rows, { limit } = {}) {
  const { apiKey, route, maxPerRun } = apiConfig();
  if (!apiKey) return { ok: false, error: 'No RB2B API key saved. Add one in Settings.' };

  const cap = Math.min(Number(limit) || maxPerRun, maxPerRun);
  const alreadyTried = new Set(readContacts().map((c) => c.sourceKey).filter(Boolean));

  const candidates = rows.filter((r) => r.email && !r.contact && !alreadyTried.has(r.id));
  const selected = candidates.slice(0, cap);
  if (!selected.length) {
    return { ok: true, attempted: 0, matched: 0, misses: 0, creditsCharged: 0, remaining: 0 };
  }

  // Several people can share an address, and the API de-duplicates hashes, so
  // one result may belong to more than one row.
  const rowsByHash = new Map();
  for (const row of selected) {
    const hash = md5(normalizeEmail(row.email));
    if (!rowsByHash.has(hash)) rowsByHash.set(hash, []);
    rowsByHash.get(hash).push(row);
  }

  const hashes = [...rowsByHash.keys()];
  const stored = [];
  let matchedHashes = new Set();
  let creditsCharged = 0;
  let exhausted = false;
  let stoppedBecause = null;

  for (let i = 0; i < hashes.length; i += BATCH_LIMIT) {
    const chunk = hashes.slice(i, i + BATCH_LIMIT);
    const response = await callRoute(ROUTES[route], { md5s: chunk });

    if (!response.ok) {
      stoppedBecause = describeError(response);
      break;
    }

    const { results = [], credits_charged: charged = 0, credits_exhausted: out = false } =
      response.payload || {};
    creditsCharged += Number(charged) || 0;
    exhausted = Boolean(out);

    for (const result of results) {
      const contact = toContact(result);
      if (!contact) continue;
      matchedHashes.add(result.md5);
      for (const row of rowsByHash.get(result.md5) || []) {
        // Keep the address we already knew when the API returns none: a person
        // we can already email must not lose that by being enriched.
        stored.push({ ...contact, email: contact.email || normalizeEmail(row.email), sourceKey: row.id });
      }
    }

    if (exhausted) {
      stoppedBecause = 'Stopped: account credits exhausted. Remaining people were not processed.';
      break;
    }
  }

  // Record misses ONLY when the whole selection was processed. If the run
  // stopped early, we cannot tell which hashes were looked up and which were
  // never reached — marking the latter as tried would permanently skip people
  // nobody ever paid to check.
  const completed = !stoppedBecause;
  let misses = 0;
  if (completed) {
    for (const [hash, hashRows] of rowsByHash) {
      if (matchedHashes.has(hash)) continue;
      misses += hashRows.length;
      for (const row of hashRows) {
        stored.push({
          sourceKey: row.id,
          email: normalizeEmail(row.email),
          miss: true,
          via: 'core-identity',
        });
      }
    }
  }

  if (stored.length) saveContacts(stored);

  return {
    ok: true,
    attempted: selected.length,
    matched: matchedHashes.size,
    misses,
    // Reported by the API rather than inferred: a record can cost more than
    // one credit when both the profile and MAID data resolve.
    creditsCharged,
    remaining: Math.max(0, candidates.length - selected.length),
    stoppedBecause,
  };
}

/** What a run would attempt, spending nothing to find out. */
export function enrichPreview(rows, { limit } = {}) {
  const { maxPerRun } = apiConfig();
  const cap = Math.min(Number(limit) || maxPerRun, maxPerRun);
  const alreadyTried = new Set(readContacts().map((c) => c.sourceKey).filter(Boolean));

  const candidates = rows.filter((r) => r.email && !r.contact && !alreadyTried.has(r.id));
  const willAttempt = Math.min(candidates.length, cap);

  return {
    eligible: candidates.length,
    willAttempt,
    cap,
    skippedNoEmail: rows.filter((r) => !r.email && !r.contact).length,
    // Distinct hashes are what actually get billed, and shared addresses
    // collapse — so this is never more than willAttempt and often less.
    billableRecords: new Set(
      candidates.slice(0, cap).map((r) => md5(normalizeEmail(r.email))),
    ).size,
    requests: Math.max(1, Math.ceil(willAttempt / BATCH_LIMIT)),
  };
}

/**
 * Probe for the Settings page.
 *
 * Uses a `.invalid` address, which by RFC 2606 can belong to nobody, so it
 * exercises auth and entitlement and returns a documented miss rather than a
 * match — and a miss is explicitly not billed.
 */
export async function testRb2b() {
  const { apiKey, route } = apiConfig();
  if (!apiKey) return { ok: false, error: 'A RB2B API key is required.' };

  const response = await callRoute(ROUTES[route], {
    md5: md5(`trafficdash-probe-${Date.now()}@example.invalid`),
  });

  // 404 is the documented "no data found" answer, so reaching it proves the
  // key works and the route is enabled — which is exactly what a test is for.
  if (response.ok || response.status === 404) {
    return {
      ok: true,
      detail: `Key accepted and ${ROUTES[route]} is enabled. The probe matched nobody, as intended, so nothing was billed.`,
    };
  }
  return { ok: false, error: describeError(response) };
}

export { ROUTES, BATCH_LIMIT };
