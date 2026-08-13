const $ = (sel) => document.querySelector(sel);
const form = $('#settings-form');

const setValue = (name, value) => {
  const input = form.elements[name];
  if (input) input.value = value ?? '';
};

function setStatus(id, ok, label) {
  const chip = $(id);
  chip.dataset.state = ok ? 'on' : 'off';
  chip.textContent = label;
}

function showResult(id, { ok, error, detail, warn }) {
  const node = $(id);
  node.dataset.state = ok ? (warn ? 'warn' : 'ok') : 'error';
  node.textContent = ok ? `✓ ${detail}` : `✗ ${error}`;
}

async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();

  setValue('posthog.host', s.posthog.host);
  setValue('posthog.projectId', s.posthog.projectId);
  setValue('siteHosts', (s.siteHosts || []).join(', '));
  setValue('events.activation', s.events.activation);
  setValue('events.signup', s.events.signup);
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

  setStatus('#status-posthog', s.connected.posthog, s.connected.posthog ? 'Connected' : 'Not connected');
  setStatus('#status-stripe', s.connected.stripe, s.connected.stripe ? 'Connected' : 'Not connected');

  if (s.connected.posthog) loadEventNames();
  return s;
}

async function loadEventNames() {
  const { events } = await (await fetch('/api/events')).json();
  $('#event-names').replaceChildren(
    ...events.map((e) => {
      const opt = document.createElement('option');
      opt.value = e.event;
      opt.label = `${e.count.toLocaleString('en-US')} in 90d`;
      return opt;
    }),
  );
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
    events: {
      activation: get('events.activation'),
      signup: get('events.signup'),
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

    showResult(`#result-${target}`, result);
    form.elements['posthog.apiKey'].value = '';
    form.elements['stripe.apiKey'].value = '';
    await loadSettings();
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
