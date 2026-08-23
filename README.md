# TrafficDash

Where traffic comes from — and whether it acts.

One page that follows a person all the way through: **where they came from →
signed up → paid**. It reads your PostHog and Stripe accounts directly and joins
them on `user_id`. No warehouse, no ETL, no analytics vendor in the middle.

Every source card is **discovered from your own traffic**. There is no list of
expected sources to keep up to date, and nothing appears with zero visitors — if
a card says Reddit, someone actually arrived from Reddit.

![The dashboard: an overall funnel, then one card per discovered traffic source](docs/dashboard.png)

<sub>Screenshot rendered against synthetic events — your instance shows your own sources.</sub>

## Run it

```bash
npm start          # http://localhost:4317
```

It starts empty and asks you to connect PostHog and Stripe. Open
**http://localhost:4317/settings**, paste your keys, and the dashboard fills in.

![The settings page, with connection tests for PostHog and Stripe](docs/settings.png)

```bash
npm run report     # the same numbers, in the terminal
npm test
```

Node 18+. No runtime dependencies.

## Connecting it

### 1. PostHog

Profile → **Personal API keys** → Create, with access to your project. The
Project ID is in project settings. Paste both into Settings and hit **Test
connection** — it reports how many events it can see.

Then, on the site right after signup:

```js
posthog.identify(userId, { email });
```

This is the load-bearing line. `userId` is the join key — whatever it is, it has
to be the same string you hand Stripe in step 4.

### 2. Instrument the action that means "they used it"

The **Scanners** column counts people who did the thing your product exists to
do. PostHog autocaptures pageviews and clicks on its own, but no autocaptured
event can tell you that — you have to fire one:

```js
posthog.capture('scan_run');
```

Put it where the action **completes**, not where the button is clicked.
Capturing on click counts intent, and intent is not activation — a scan that
errors out halfway would still score as a success.

The name is yours; `scan_run` is just an example. Whatever you pick, select it
under **Events → Activation event** in Settings. That field lists your real
event names, ranked by how many distinct people fired each, so you don't have to
remember the exact string. If the list comes back empty, nothing in the app is
instrumented yet and this step is the fix.

> **On Lovable:** the default PostHog wiring only autocaptures. Expect an empty
> list until you add a `capture()` call of your own.

### 3. Stripe

Developers → API keys → **Create restricted key**:

| Scope | Access |
| --- | --- |
| Checkout Sessions | Read |
| Events | Read |
| Charges | Read |
| everything else | None |

Use `rk_live`, not `sk_live`. A secret key can write; this dashboard only ever
reads, so don't hand it the ability to do more. If you paste an `sk_` key the
settings page will say so.

### 4. Set the join key when you create Checkout

```js
await stripe.checkout.sessions.create({
  // ...
  metadata: { user_id: userId },   // same id you passed to posthog.identify()
});
```

For **guest checkout** there is no authenticated user, so send the browser's
PostHog id instead:

```js
metadata: {
  user_id: user?.id,                              // authenticated buyers
  posthog_distinct_id: posthog.get_distinct_id(),  // everyone, guests included
}
```

Send both when you have both. TrafficDash tries `user_id` first and falls back
to the distinct id, and `identify()` merges the anonymous id onto the person —
so a guest who signs up later is still one person, not two, and their orders
land on one card. Without the fallback, guest revenue can never reach a source
card at all: there is nothing to join on.

Without either, a payment cannot be traced back to a traffic source — you know
money arrived and nothing about where it came from.

Those orders are **not dropped**. Guest checkout has no authenticated user and
so genuinely has no id to send, which is expected rather than broken; the
dashboard keeps the money and shows it as a separate *Unattributed* line so
that:

```
attributed + unattributed = collected in Stripe
```

always holds. A funnel that quietly reports less revenue than the account
actually took is worse than one that reports none, so the total is always
reconcilable against the Stripe dashboard.

Two failure modes are distinguished, because they need different responses:

| What the dashboard sees | Reading |
| --- | --- |
| Paid order, neither id | Fixable — checkout isn't sending `posthog_distinct_id`. |
| Paid order, id matches no person | A real fault — `identify()` and checkout are using different ids. |

Revenue that only joined because of the anonymous id is reported on its own
line, so you can see what the fallback is actually recovering rather than
assuming it works.

### 5. Tell it about your own domain

Add your hostnames under **Your site**. Referrals from them become *Internal
(Site Links)* instead of counting as acquisition — which is what stops your own
navigation from inflating Direct.

### 6. Tag your links

When you post a link anywhere, add `?utm_source=…` if you can. Mobile clients
strip referrers, so untagged traffic lands in **Direct (Untagged)** with no way
to tell it apart from someone typing the URL. That's what the "Needs UTM" badge
is telling you.

## Reading it

Two layers sit above the numbers, because a page of aggregates does not tell
you what to do.

**What this means** turns the aggregates into statements, each naming the
figures it came from so it can be checked rather than believed: where the funnel
actually breaks, which source converts best, which traffic is not plausibly
human, how much revenue has no source. A source flagged as crawler traffic is
excluded from the praise — recommending more of the traffic the same panel calls
bots would be worse than saying nothing.

**Pipeline** stages everyone by what they did. A gated lead — someone who
traded an email for a result without registering — gets its own stage rather
than being folded into signups: they are reachable, they have no account, and
counting them as signups would overstate the funnel while hiding that they are
the easiest people here to contact. Set the lead event under
**Events → Lead capture event**; leave it blank if you have no gate.

**People** is one row per person: email if known, the source that found them,
what they landed on, sessions, views, activations, whether they signed up, and
what they paid. Buyers first, then signups, then whoever was here most recently.
Filter by source, search by email or landing page, or narrow to signups and
buyers only. This is where a number gets checked — an aggregate that looks wrong
usually has three rows behind it that explain why.

## Importing contacts

**Import contacts** in the People panel takes a CSV or JSON export — RB2B's
column names are recognised, as are the obvious variants — and joins it to
people **by exact email only**.

That restriction is deliberate. RB2B's payload carries LinkedIn URL, name,
title, company, business email, location, "Seen At", referrer and captured URL.
It carries no IP, no session id and no PostHog distinct id, so nothing in it is
a key shared with the events this reads. The tempting substitute is matching on
captured URL plus a timestamp window — but two people landing on `/` from
LinkedIn ten minutes apart would swap identities, and a wrong match looks
exactly like a right one. A name attached to someone else's behaviour is worse
than a blank, so unmatched contacts stay unmatched and are counted as such:

```
147 contacts imported · 31 matched to a person by email ·
44 have no email address · 72 have an email but never signed up here
```

Those three numbers are the honest measure of what an identity tool is worth on
your traffic. The last group has no counterpart here by definition — they never
identified themselves — so work them from the vendor's own export instead.

## Enriching contacts (RB2B / Retention.com)

Optional, and off unless a key is saved. **Core Identity is email in, profile
out** — it enriches people you already have an address for. It cannot identify
anonymous visitors; that is the separate Identity Resolution product, granted
separately, and the two are easy to confuse because they share an account.

Press **Enrich** in the People panel and it acts on the current filtered view,
after telling you what it will cost:

```
Look up 12 people?
Costs up to 12 credits — one per successful match.
31 are eligible; the rest need another run.
147 skipped: no email to look up.
```

Credits are bought and finite, so the rules are strict:

- nothing runs on its own — only an explicit press, never a refresh
- `maxPerRun` is a hard ceiling, capped at 500 no matter what is typed
- **nobody is looked up twice, misses included** — a lookup that found nothing
  is recorded precisely so the next run does not pay to learn the same nothing
- the run stops mid-way the moment the API reports the budget is gone, leaving
  the untried rows untouched for next time
- emails are **MD5-hashed before sending**; the plaintext never leaves the machine

## How attribution works

Two attributions run at once, which is why the dashboard says so out loud:

- **Visitors / Scanners / Signups → first touch.** What found them.
- **Checkout / Paid / Revenue → last non-direct touch.** What closed them.

The same person can appear on two different cards. That's deliberate — "what
found them" and "what closed them" are different questions, and averaging them
into one number is how attribution dashboards start lying.

Each card carries a **confidence** badge, which is about how much the
attribution can be trusted, not how much traffic there is:

| Confidence | Means |
| --- | --- |
| high | A UTM parameter declared the source. |
| medium | The browser reported a referring domain. |
| low | A `?ref=` convention, an own-domain referrer, or nothing at all. |

**Internal (Site Links)** and **Direct (Untagged)** are kept as residuals, not
channels, and get a neutral chip instead of a source color.

## How sources are discovered

For each person's first touch, in order:

1. **UTM parameters** → that source, high confidence.
2. **Own-domain referrer** → Internal (Site Links).
3. **Any other referring domain** → that domain becomes the source, medium
   confidence.
4. **`?ref=` in the landing URL** → that value, low confidence.
5. **Nothing** → Direct (Untagged).

A small registry in `src/classify.js` maps well-known places (Reddit, Hacker
News, Product Hunt, …) to a nicer label and glyph. It is display polish only —
an unrecognised referrer still gets its own card, named after itself. To rename
one, add an entry to `sourceLabels` in `data/settings.json`:

```json
{ "sourceLabels": { "somesite.dev": { "label": "Some Site", "glyph": "S" } } }
```

Colors are assigned from the source key, not the ranking, so a source keeps its
hue when the leaderboard shuffles. Past eight sources the tail takes the neutral
chip rather than cycling a hue nobody could tell apart.

## Where your keys live

`data/settings.json`, on this machine, `chmod 600`, gitignored. Keys are never
sent back to the browser — the settings page only ever sees a masked stub like
`rk_live_…abcd`, and submitting a blank key field leaves the stored one alone.

There is no auth on the server itself, so run it locally. Don't expose it to the
internet as-is.

## Layout

```
server.js            zero-dependency HTTP server + settings API + static host
src/settings.js      settings file, masking, connection state
src/posthog.js       one HogQL query, aggregated per person
src/stripe.js        Checkout Sessions, paginated
src/classify.js      source discovery + confidence
src/report.js        the join, the two attribution models, color assignment
public/              dashboard + settings page
```

## Notes on the numbers

- **Scanners** is whoever fired your activation event at least once. Set it in
  Settings — until you do, it reads 0 and says so.
- **Signups** is anyone identified in PostHog: an explicit signup event, or an
  email landing on the person via `identify()`.
- Percentages on a card are a share of **that card's own visitors**, not of the
  site total.
- Stripe is optional. Without it, traffic and signups still work; the money
  columns stay empty and the dashboard says why.
- Revenue on a source card is only what could be attributed. The summary and
  the table both carry an *Unattributed* line whenever the two differ, so the
  collected total always matches Stripe.
- The hero counts **unique visitors over the window**, so a returning visitor is
  real traffic that moves nothing. The header's *Latest event* indicator is the
  separate signal for "data is flowing" — the two can disagree, and when they do
  the dashboard is right both times.
- The header shows the age of the data, not of the last fetch — a cache hit
  returns the same timestamp, so it keeps counting up rather than resetting and
  implying the numbers are newer than they are.
- The page re-reads every 30s (toggle with **Auto**), but the cache window in
  Settings is what actually sets freshness — polling harder only re-serves the
  same cached report. **Refresh** bypasses the cache and re-hits both APIs.
