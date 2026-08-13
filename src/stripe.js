import { readSettings } from './settings.js';

const API = 'https://api.stripe.com/v1';

async function stripeGet(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${readSettings().stripe.apiKey}`,
      'Stripe-Version': '2024-06-20',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      message = JSON.parse(body).error?.message || message;
    } catch {}
    throw new Error(`Stripe ${pathname}: ${message}`);
  }
  return res.json();
}

async function paginate(pathname, params = {}, { max = 5000 } = {}) {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await stripeGet(pathname, { ...params, limit: 100, starting_after: startingAfter });
    out.push(...page.data);
    if (!page.has_more || out.length >= max) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

/** Cheap round-trip used by the settings page's Test button. */
export async function testStripe() {
  const key = readSettings().stripe.apiKey;
  if (!key) return { ok: false, error: 'A restricted key (rk_live_…) is required.' };
  try {
    const page = await stripeGet('/checkout/sessions', { limit: 1 });
    const withMeta = page.data.filter((s) => s.metadata?.user_id).length;
    return {
      ok: true,
      detail: page.data.length
        ? `Reached Checkout Sessions. Most recent session ${withMeta ? 'carries' : 'is missing'} metadata.user_id.`
        : 'Reached Checkout Sessions. No sessions yet.',
      warn: page.data.length > 0 && withMeta === 0,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Checkout Sessions in the window, reduced to what the join needs.
 *
 * Two join keys, tried in order:
 *
 *   1. `metadata.user_id` — the authenticated user, set at session creation to
 *      the same id passed to posthog.identify().
 *   2. `metadata.posthog_distinct_id` — the browser's PostHog distinct_id.
 *      Guest checkout has no authenticated user, so this is the only thing
 *      tying the payment to the visit that produced it.
 *
 * Both resolve against the person's distinct_ids, because identify() merges
 * the anonymous id onto the person — so a guest who later signs up still
 * lands on one person rather than two.
 *
 * Orders carrying neither keep their AMOUNT, not just a count: dropping the
 * money would understate revenue against Stripe with nothing to reconcile.
 */
const ANON_KEYS = ['posthog_distinct_id', 'distinct_id', 'ph_distinct_id'];

export async function fetchPayments() {
  const days = Number(readSettings().windowDays) || 30;
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const sessions = await paginate('/checkout/sessions', { 'created[gte]': since });

  const orders = [];
  const noUserId = { orders: 0, revenue: 0, currency: 'USD' };

  for (const s of sessions) {
    const userId = s.metadata?.user_id || s.client_reference_id || '';
    const anonId = ANON_KEYS.map((k) => s.metadata?.[k]).find(Boolean) || '';
    const joinId = userId || anonId;
    const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';

    if (!joinId) {
      if (paid) {
        noUserId.orders += 1;
        noUserId.revenue += (s.amount_total || 0) / 100;
        noUserId.currency = (s.currency || 'usd').toUpperCase();
      }
      continue;
    }

    orders.push({
      id: s.id,
      userId: joinId,
      // Which key carried it — an authenticated match and a browser-scoped one
      // are both real joins, but they are not equally strong evidence.
      joinedVia: userId ? 'user_id' : 'distinct_id',
      email: s.customer_details?.email || s.customer_email || '',
      status: s.status,
      paid,
      amount: (s.amount_total || 0) / 100,
      currency: (s.currency || 'usd').toUpperCase(),
      created: new Date((s.created || 0) * 1000).toISOString(),
    });
  }

  noUserId.revenue = Math.round(noUserId.revenue * 100) / 100;
  return { orders, noUserId };
}
