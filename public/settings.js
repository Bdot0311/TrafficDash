const $ = (sel) => document.querySelector(sel);
const form = $('#settings-form');

const setValue = (name, value) => {
  const input = form.elements[name];
  if (input) input.value = value ?? '';
};

/**
 * The chip reports what is actually known, which is not the same as whether a
 * key is present.
 *
 *   off    — nothing stored
 *   saved  — a key is stored, but nothing has proved it works
 *   on     — a test round-tripped successfully
 *   error  — a test came back refused
 *
 * Saying "Connected" merely because a string is on disk is how a dashboard
 * ends up showing green next to a 403.
 */
// Last test verdict per target. Held as state rather than left in the DOM,
// because loadSettings() repaints both chips — so a verdict written straight
// to the element is wiped the next time the other panel reloads.
const lastTest = { posthog: null, stripe: null, rb2b: null };

function setStatus(id, state, label) {
  const chip = $(id);
  chip.dataset.state = state;
  chip.textContent = label;
}

function paintStatus(target, keyPresent) {
  const verdict = lastTest[target];
  if (verdict !== null) {
    setStatus(`#status-${target}`, verdict ? 'on' : 'error', verdict ? 'Connected' : 'Not reachable');
    return;
  }
  setStatus(
    `#status-${target}`,
    keyPresent ? 'saved' : 'off',
    keyPresent ? 'Key saved' : 'Not configured',
  );
}

function showResult(target, { ok, error, detail, warn }) {
  const node = $(`#result-${target}`);
  node.dataset.state = ok ? (warn ? 'warn' : 'ok') : 'error';
  node.textContent = ok ? `✓ ${detail}` : `✗ ${error}`;

  // A test result is the only real evidence either way — let it drive the chip.
  lastTest[target] = Boolean(ok);
  paintStatus(target, true);
}

async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();

  setValue('posthog.host', s.posthog.host);
  setValue('posthog.projectId', s.posthog.projectId);
  setValue('siteHosts', (s.siteHosts || []).join(', '));
  setValue('events.activation', s.events.activation);
  setValue('events.signup', s.events.signup);
  setValue('events.lead', s.events.lead);
  setValue('rb2b.baseUrl', s.rb2b.baseUrl);
  setValue('rb2b.maxPerRun', s.rb2b.maxPerRun);
  setValue('rb2b.route', s.rb2b.route);
  setValue('windowDays', s.windowDays);
  setValue('cacheSeconds', s.cacheSeconds);

  // Stored keys are never sent to the browser — only enough to identify them.
  $('#hint-posthog-key').textContent = s.posthog.apiKeySet
    ? `Stored: ${s.posthog.apiKeyMasked}. Leave blank to keep it.`
    : 'Stored only on this machine, in data/settings.json.';

  const stripeHint = $('#hint-stripe-key');
  if (s.stripe.usingSecretKey) {
    stripeHint.innerHTML =
      '<b>That is a secret key.</b> It can write to your Stripe account. Replace it with a restricted <code>rk_live</code> key.';
    stripeHint.dataset.state = 'error';
  } else if (s.stripe.apiKeySet) {
    stripeHint.textContent = `Stored: ${s.stripe.apiKeyMasked}. Leave blank to keep it.`;
    stripeHint.dataset.state = '';
  }

  $('#hint-rb2b-key').textContent = s.rb2b.apiKeySet
    ? `Stored: ${s.rb2b.apiKeyMasked}. Leave blank to keep it.`
    : 'Leave blank to skip enrichment entirely.';

  // Absent a test verdict, a stored key is all we know — claim no more.
  paintStatus('posthog', s.connected.posthog);
  paintStatus('stripe', s.connected.stripe);
  paintStatus('rb2b', s.rb2b.apiKeySet);

  if (s.connected.posthog) loadEventNames();
  return s;
}

async function loadEventNames() {
  const { events, custom } = await (await fetch('/api/events')).json();

  $('#event-names').replaceChildren(
    ...events.map((e) => {
      const opt = document.createElement('option');
      opt.value = e.event;
      opt.label = `${e.count.toLocaleString('en-US')} in 90d`;
      return opt;
    }),
  );

  const picker = $('#event-picker');
  picker.replaceChildren();

  // Nothing custom means nothing to pick. Say that, rather than offering a
  // menu of autocaptured built-ins that can't mean "they used it".
  if (custom.length === 0) {
    picker.append(
      Object.assign(document.createElement('div'), {
        className: 'callout',
        innerHTML:
          '<b>No product events found.</b> Your project only has PostHog’s autocaptured ' +
          'events (<code>$pageview</code> and friends), which can’t tell you whether ' +
          'someone used the product. Fire one from your app where the core action ' +
          'completes — <code>posthog.capture(\'scan_run\')</code> — then come back and ' +
          'pick it here.',
      }),
    );
    return;
  }

  picker.append(
    Object.assign(document.createElement('p'), {
      className: 'help',
      textContent: 'Your events, most frequent first — click one to use it:',
    }),
  );

  const list = document.createElement('div');
  list.className = 'event-chips';
  for (const e of custom.slice(0, 14)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'event-chip';
    chip.innerHTML = `<code>${e.event}</code> <span>${e.people.toLocaleString('en-US')} people</span>`;
    chip.addEventListener('click', () => {
      form.elements['events.activation'].value = e.event;
      form.elements['events.activation'].focus();
    });
    list.append(chip);
  }
  picker.append(list);
}

function collect() {
  const get = (name) => form.elements[name]?.value.trim() ?? '';
  return {
    posthog: {
      host: get('posthog.host') || 'https://us.posthog.com',
      projectId: get('posthog.projectId'),
      apiKey: get('posthog.apiKey'), // blank = keep the stored one
    },
    stripe: {
      apiKey: get('stripe.apiKey'),
    },
    siteHosts: get('siteHosts')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    rb2b: {
      apiKey: get('rb2b.apiKey'),
      baseUrl: get('rb2b.baseUrl') || 'https://api.rb2b.com',
      route: get('rb2b.route') || 'business',
      maxPerRun: Number(get('rb2b.maxPerRun')) || 25,
    },
    events: {
      activation: get('events.activation'),
      signup: get('events.signup'),
      lead: get('events.lead'),
    },
    windowDays: Number(get('windowDays')) || 30,
    cacheSeconds: Number(get('cacheSeconds')) || 0,
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = $('#save-result');
  result.dataset.state = '';
  result.textContent = 'Saving…';

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collect()),
  });

  if (!res.ok) {
    result.dataset.state = 'error';
    result.textContent = '✗ Could not save.';
    return;
  }

  // Clear the key fields so a stored secret never sits in the DOM.
  form.elements['posthog.apiKey'].value = '';
  form.elements['stripe.apiKey'].value = '';
  form.elements['rb2b.apiKey'].value = '';

  // Saving may have changed a key, so any earlier verdict no longer applies.
  lastTest.posthog = null;
  lastTest.stripe = null;
  lastTest.rb2b = null;

  await loadSettings();
  result.dataset.state = 'ok';
  result.textContent = '✓ Saved. The dashboard will re-read on next load.';
});

// Test buttons save first, so they test what you just typed.
for (const button of document.querySelectorAll('[data-test]')) {
  button.addEventListener('click', async () => {
    const target = button.dataset.test;
    const node = $(`#result-${target}`);
    node.dataset.state = '';
    node.textContent = 'Testing…';

    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect()),
    });

    const result = await (
      await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      })
    ).json();

    form.elements['posthog.apiKey'].value = '';
    form.elements['stripe.apiKey'].value = '';
    form.elements['rb2b.apiKey'].value = '';
    // Reload first — it resets the chips to "Key saved", so the test result
    // has to be applied after it or the outcome is immediately overwritten.
    await loadSettings();
    showResult(target, result);
  });
}

$('#theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('trafficdash-theme', next);
  } catch {}
});

loadSettings();
