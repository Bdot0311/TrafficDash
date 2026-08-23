import fs from 'node:fs';
import path from 'node:path';

/**
 * Imported contacts — RB2B exports, or any list with an email column.
 *
 * These are joined to people by EMAIL ONLY, exactly.
 *
 * RB2B's payload carries LinkedIn URL, name, title, company, business email,
 * location, "Seen At", referrer and captured URL. It carries no IP, no session
 * id, and no PostHog distinct_id — so there is no key shared with the events
 * TrafficDash reads.
 *
 * The tempting substitute is matching on captured URL plus a timestamp window.
 * That is guessing: two people landing on `/` from LinkedIn ten minutes apart
 * would swap identities, and the result looks exactly like a correct match.
 * A wrong name attached to real behaviour is worse than an honest blank —
 * you would email the wrong person about something they never did. So a
 * contact with no email match stays unmatched and is reported as such.
 */

const dataDir = () => process.env.TRAFFICDASH_DATA_DIR || path.join(process.cwd(), 'data');
const contactsFile = () => path.join(dataDir(), 'contacts.json');

// RB2B's column names, plus the obvious variants other exports use.
const FIELD_ALIASES = {
  email: ['business email', 'email', 'work email', 'email address'],
  firstName: ['first name', 'firstname', 'first'],
  lastName: ['last name', 'lastname', 'last'],
  title: ['title', 'job title', 'position'],
  company: ['company name', 'company', 'organization', 'account'],
  linkedin: ['linkedin url', 'linkedin', 'linkedin profile'],
  website: ['website', 'company website', 'domain'],
  industry: ['industry'],
  employees: ['employee count', 'employees', 'company size'],
  revenue: ['estimate revenue', 'estimated revenue', 'revenue'],
  city: ['city'],
  region: ['state', 'region', 'province'],
  seenAt: ['seen at', 'seen_at', 'timestamp', 'date'],
  capturedUrl: ['captured url', 'page', 'url', 'page url'],
  referrer: ['referrer', 'referer', 'source'],
};

const normalizeKey = (key) => String(key || '').trim().toLowerCase().replace(/[_-]+/g, ' ');

/** Map one raw row onto the fields we keep, whatever the export called them. */
export function normalizeContact(raw) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(raw || {})) {
    lookup.set(normalizeKey(key), value);
  }

  const pick = (field) => {
    for (const alias of FIELD_ALIASES[field]) {
      const value = lookup.get(alias);
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
    return '';
  };

  const contact = {};
  for (const field of Object.keys(FIELD_ALIASES)) contact[field] = pick(field);

  contact.email = contact.email.toLowerCase();
  contact.name = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  return contact;
}

/** Minimal CSV reader: quoted fields, embedded commas, doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];

  return body.map((cells) =>
    Object.fromEntries(header.map((name, i) => [name.trim(), cells[i] ?? ''])),
  );
}

export function readContacts() {
  const file = contactsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Merge new rows into the stored set, keyed by email.
 *
 * Contacts without an email are kept too: they are the ones RB2B could name
 * but not address, and dropping them would hide how much of the tool's output
 * is unusable.
 */
export function saveContacts(rows) {
  const incoming = rows.map(normalizeContact).filter((c) => c.email || c.linkedin || c.name);
  const byKey = new Map();

  for (const contact of [...readContacts(), ...incoming]) {
    const key = contact.email || contact.linkedin || `${contact.name}|${contact.company}`;
    byKey.set(key, { ...(byKey.get(key) || {}), ...contact });
  }

  const merged = [...byKey.values()];
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(contactsFile(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return { stored: merged.length, added: incoming.length };
}

export function clearContacts() {
  const file = contactsFile();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Email → contact, for the exact join. */
export function contactsByEmail(contacts = readContacts()) {
  const map = new Map();
  for (const contact of contacts) {
    if (contact.email) map.set(contact.email.toLowerCase(), contact);
  }
  return map;
}
