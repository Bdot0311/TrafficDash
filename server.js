import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readSettings,
  writeSettings,
  redactedSettings,
  connectionState,
} from './src/settings.js';
import { fetchPeople, testPostHog, listEventNames } from './src/posthog.js';
import { fetchPayments, testStripe } from './src/stripe.js';
import { buildReport } from './src/report.js';
import { saveContacts, clearContacts, parseCsv, readContacts } from './src/contacts.js';
import { enrichPeople, enrichPreview, testRb2b } from './src/enrich.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

let cache = { at: 0, payload: null };
export const invalidateCache = () => {
  cache = { at: 0, payload: null };
};

export async function getReport({ force = false } = {}) {
  const settings = readSettings();
  const fresh = Date.now() - cache.at < settings.cacheSeconds * 1000;
  if (!force && fresh && cache.payload) return cache.payload;

  const connected = connectionState();

  // Nothing is connected yet — say so rather than inventing numbers.
  if (!connected.posthog) {
    return {
      state: 'unconfigured',
      connected,
      generatedAt: new Date().toISOString(),
      stages: ['visitors', 'scanners', 'signups', 'checkout', 'paid'],
      sources: [],
      totals: { visitors: 0, scanners: 0, signups: 0, checkout: 0, paid: 0 },
      totalRevenue: 0,
      currency: 'USD',
      windowDays: settings.windowDays,
      warnings: [],
    };
  }

  const people = await fetchPeople();
  // Stripe is optional: traffic and signups still work without it, the money
  // columns just stay empty.
  const payments = connected.stripe
    ? await fetchPayments()
    : { orders: [], unjoinable: 0 };

  const payload = buildReport({ people, payments });
  payload.state = 'live';
  payload.connected = connected;
  if (!connected.stripe) {
    payload.warnings.unshift({
      level: 'warning',
      text: 'Stripe is not connected, so Checkout and Paid read 0. Add a restricted key in Settings.',
    });
  }

  cache = { at: Date.now(), payload };
  return payload;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Without this the browser may serve a repeated ?refresh=1 from its own
    // HTTP cache, so the second click onward never reaches the server.
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel === 'settings') rel = 'settings.html';

  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/api/report') {
      return json(res, 200, await getReport({ force: url.searchParams.get('refresh') === '1' }));
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, redactedSettings());
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const patch = await readBody(req);
      // An empty string means "leave the stored key alone" — the browser is
      // never sent the real value, so it cannot echo it back.
      if (patch.posthog && !patch.posthog.apiKey) delete patch.posthog.apiKey;
      if (patch.stripe && !patch.stripe.apiKey) delete patch.stripe.apiKey;
      if (patch.rb2b && !patch.rb2b.apiKey) delete patch.rb2b.apiKey;
      writeSettings(patch);
      invalidateCache();
      return json(res, 200, redactedSettings());
    }

    if (url.pathname === '/api/settings/test' && req.method === 'POST') {
      const { target } = await readBody(req);
      if (target === 'posthog') return json(res, 200, await testPostHog());
      if (target === 'stripe') return json(res, 200, await testStripe());
      if (target === 'rb2b') return json(res, 200, await testRb2b());
      return json(res, 400, { ok: false, error: 'Unknown target' });
    }

    // Accepts a pasted RB2B export: CSV text, a JSON array, or a single
    // webhook-shaped object. Same endpoint either way, so a future webhook can
    // POST here directly if this ever runs somewhere public.
    if (url.pathname === '/api/contacts' && req.method === 'POST') {
      const body = await readBody(req);
      const rows = Array.isArray(body)
        ? body
        : typeof body?.csv === 'string'
          ? parseCsv(body.csv)
          : body && typeof body === 'object'
            ? [body]
            : [];
      if (!rows.length) return json(res, 400, { error: 'No rows found in that import.' });
      const result = saveContacts(rows);
      invalidateCache();
      return json(res, 200, result);
    }

    if (url.pathname === '/api/contacts' && req.method === 'DELETE') {
      clearContacts();
      invalidateCache();
      return json(res, 200, { stored: 0 });
    }

    if (url.pathname === '/api/contacts') {
      const contacts = readContacts();
      return json(res, 200, {
        stored: contacts.length,
        withEmail: contacts.filter((c) => c.email).length,
      });
    }

    // Enrichment spends real credits, so the preview is a separate call that
    // spends none — the UI states the cost before anything is charged.
    if (url.pathname === '/api/enrich/preview' && req.method === 'POST') {
      const { ids = [] } = await readBody(req);
      const report = await getReport();
      const rows = (report.people || []).filter((r) => ids.includes(r.id));
      return json(res, 200, enrichPreview(rows));
    }

    if (url.pathname === '/api/enrich' && req.method === 'POST') {
      const { ids = [], limit } = await readBody(req);
      const report = await getReport();
      const rows = (report.people || []).filter((r) => ids.includes(r.id));
      const result = await enrichPeople(rows, { limit });
      invalidateCache();
      return json(res, result.ok ? 200 : 400, result);
    }

    if (url.pathname === '/api/events') {
      return json(res, 200, await listEventNames());
    }

    return serveStatic(req, res);
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 4317);
  server.listen(port, () => {
    const c = connectionState();
    console.log(`TrafficDash → http://localhost:${port}`);
    console.log(`  PostHog: ${c.posthog ? 'connected' : 'not connected'}`);
    console.log(`  Stripe:  ${c.stripe ? 'connected' : 'not connected'}`);
    if (!c.posthog || !c.stripe) {
      console.log(`  Connect them at http://localhost:${port}/settings`);
    }
  });
}

export { server };
