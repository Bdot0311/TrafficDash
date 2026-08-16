import { readSettings } from './settings.js';

/**
 * PostHog query API (HogQL).
 *
 * Auth is a personal API key with access to the project. Read-only: one
 * aggregated query, so raw event rows never cross the wire.
 */
async function hogql(query) {
  const { host, projectId, apiKey } = readSettings().posthog;
  const url = `${host}/api/projects/${encodeURIComponent(projectId)}/query/`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });

  if (!res.ok) {
    const body = await res.text();
    // PostHog returns a JSON envelope; surface the human-readable `detail`
    // rather than dumping the whole blob (hogql_metadata included) on screen.
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (parsed.detail) message = String(parsed.detail).split('\n')[0];
    } catch {}
    throw new Error(`PostHog ${res.status}: ${message}`);
  }

  const json = await res.json();
  const columns = json.columns || [];
  return (json.results || []).map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

const sq = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Round-trip used by the settings page's Test button.
 *
 * Deliberately runs the REAL people query (one day, one row) rather than a
 * trivial probe, so "Connected" means the dashboard's own query is valid —
 * not merely that the host answered.
 */
export async function testPostHog() {
  const settings = readSettings();
  const { host, projectId, apiKey } = settings.posthog;
  if (!host || !projectId || !apiKey) {
    return { ok: false, error: 'Host, Project ID and API key are all required.' };
  }
  try {
    const [{ events = 0 } = {}] = await hogql(
      'SELECT count() AS events FROM events WHERE timestamp >= now() - INTERVAL 30 DAY',
    );

    // Validates the query shape the dashboard depends on.
    await hogql(
      buildPeopleQuery({
        days: 1,
        activation: settings.events.activation,
        signup: settings.events.signup,
        limit: 1,
      }),
    );

    const n = Number(events);
    return {
      ok: true,
      detail: `${n.toLocaleString('en-US')} events in the last 30 days. Funnel query valid.`,
      empty: n === 0,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Distinct event names, split into your own events and PostHog's built-ins.
 *
 * The split is what makes the activation-event question answerable: `$pageview`
 * and friends are autocaptured by the SDK and can never mean "they used the
 * product". If `custom` comes back empty, nothing in the app is instrumented
 * yet — no event name would work, and the settings page says so instead of
 * offering a menu of built-ins.
 */
export async function listEventNames() {
  try {
    const rows = await hogql(`
      SELECT event, count() AS n, uniq(person_id) AS people
      FROM events
      WHERE timestamp >= now() - INTERVAL 90 DAY
      GROUP BY event
      ORDER BY n DESC
      LIMIT 200
    `);

    const events = rows.map((r) => ({
      event: r.event,
      count: Number(r.n || 0),
      people: Number(r.people || 0),
      builtin: String(r.event || '').startsWith('$'),
    }));

    return {
      events,
      custom: events.filter((e) => !e.builtin),
      builtin: events.filter((e) => e.builtin),
    };
  } catch {
    return { events: [], custom: [], builtin: [] };
  }
}

/**
 * The people query, built once and shared.
 *
 * The connection test runs this exact shape rather than a simpler probe: a
 * `SELECT count()` proves the host and key work while saying nothing about
 * whether the query the dashboard depends on is even valid. That gap is how a
 * green "Connected" chip coexisted with a dashboard that could not load.
 */
export function buildPeopleQuery({ days, activation, signup, limit = 50000 }) {
  // Only count an activation/signup event if one is actually configured —
  // an unset name must never silently match everything.
  const activationExpr = activation ? `countIf(event = ${sq(activation)})` : '0';
  const signupExpr = signup ? `countIf(event = ${sq(signup)})` : '0';

  // Inlined rather than hoisted into a WITH clause: HogQL binds WITH aliases
  // before the FROM scope exists, so referencing properties.* up there fails
  // with "No scope or CTE available".
  // PostHog writes '$direct' (or an empty string) when there is no referrer.
  const REF_DOMAIN = `if(empty(properties.$referring_domain) OR properties.$referring_domain = '$direct', '', properties.$referring_domain)`;
  // Same test, stated directly — nesting REF_DOMAIN inside notEmpty() would
  // repeat the whole expression three times per column for no benefit.
  const HAS_REF = `(notEmpty(properties.$referring_domain) AND properties.$referring_domain != '$direct')`;

  return `
    SELECT
      toString(person_id)                                   AS person_id,
      arrayDistinct(groupArray(distinct_id))                AS distinct_ids,
      min(timestamp)                                        AS first_seen,
      max(timestamp)                                        AS last_seen,

      argMin(properties.$current_url, timestamp)            AS first_url,
      argMin(${REF_DOMAIN}, timestamp) AS first_referring_domain,
      argMin(properties.$referrer, timestamp)               AS first_referrer,
      argMin(properties.utm_source, timestamp)              AS first_utm_source,
      argMin(properties.utm_medium, timestamp)              AS first_utm_medium,
      argMin(properties.utm_campaign, timestamp)            AS first_utm_campaign,

      argMaxIf(${REF_DOMAIN}, timestamp, ${HAS_REF}) AS last_referring_domain,
      argMaxIf(properties.$current_url, timestamp, ${HAS_REF}) AS last_url,
      argMaxIf(properties.utm_source, timestamp, ${HAS_REF}) AS last_utm_source,
      argMaxIf(properties.utm_medium, timestamp, ${HAS_REF}) AS last_utm_medium,
      argMaxIf(properties.utm_campaign, timestamp, ${HAS_REF}) AS last_utm_campaign,

      uniq(properties.$session_id)                          AS sessions,
      countIf(event = '$pageview')                          AS views,
      ${activationExpr} AS activation_runs,
      ${signupExpr} AS signup_events,
      max(person.properties.email)                          AS email
    FROM events
    WHERE timestamp >= now() - INTERVAL ${Number(days)} DAY
    GROUP BY person_id
    ORDER BY first_seen ASC
    LIMIT ${Number(limit)}
  `;
}

/**
 * One row per person:
 *   - first-touch attribution inputs (earliest referrer / UTM / landing URL)
 *   - last non-direct touch inputs (what payment attribution uses)
 *   - funnel counters
 *   - every distinct_id, so Stripe's metadata.user_id can be joined back
 */
export async function fetchPeople() {
  const settings = readSettings();
  const query = buildPeopleQuery({
    days: Number(settings.windowDays) || 30,
    activation: settings.events.activation,
    signup: settings.events.signup,
  });

  return (await hogql(query)).map((r) => ({
    personId: r.person_id,
    distinctIds: (r.distinct_ids || []).filter(Boolean),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    first: {
      url: r.first_url || '',
      referringDomain: r.first_referring_domain || '',
      referrer: r.first_referrer || '',
      utmSource: r.first_utm_source || '',
      utmMedium: r.first_utm_medium || '',
      utmCampaign: r.first_utm_campaign || '',
    },
    last: {
      url: r.last_url || '',
      referringDomain: r.last_referring_domain || '',
      utmSource: r.last_utm_source || '',
      utmMedium: r.last_utm_medium || '',
      utmCampaign: r.last_utm_campaign || '',
    },
    sessions: Number(r.sessions || 0),
    views: Number(r.views || 0),
    activationRuns: Number(r.activation_runs || 0),
    // identify(userId, { email }) is what makes someone a signup: an explicit
    // signup event, or an email landing on the person.
    signedUp: Number(r.signup_events || 0) > 0 || Boolean(r.email),
    email: r.email || '',
  }));
}
