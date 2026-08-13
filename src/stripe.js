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
 * The join key is `metadata.user_id`, set at session creation to the same id
 * passed to posthog.identify(). Without it a payment cannot be traced to a
 * source — those are surfaced as `unjoinable` rather than dropped, so the day
 * the checkout code stops setting it, the number moves.
 */
export async function fetchPayments() {
  const days = Number(readSettings().windowDays) || 30;
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const sessions = await paginate('/checkout/sessions', { 'created[gte]': since });

  const orders = [];
  let unjoinable = 0;

  for (const s of sessions) {
    const userId = s.metadata?.user_id || s.client_reference_id || '';
    const paid = s.payment_status === 'paid' || s.payment_status === 'no_payment_required';

    if (!userId) {
      if (paid) unjoinable += 1;
      continue;
    }

    orders.push({
      id: s.id,
      userId,
      email: s.customer_details?.email || s.customer_email || '',
      status: s.status,
      paid,
      amount: (s.amount_total || 0) / 100,
      currency: (s.currency || 'usd').toUpperCase(),
      created: new Date((s.created || 0) * 1000).toISOString(),
    });
  }

  return { orders, unjoinable };
}
