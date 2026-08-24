# `slack-ask` Phase 1: the pure core

Read-only question answering for the Tier 3 inbound Slack bot
(`docs/ADR-slack-tier3-inbound-bot.md`, sections 3, 4, 5.7, 6, 9).

Someone @-mentions the bot, a deterministic matcher picks one of 33 handlers,
the handler runs hardcoded queries against Postgres through an injected
executor, and a renderer produces a short Slack message that a fail-closed
egress filter inspects before it leaves.

Site traffic is now part of that, and it did NOT change the architecture.
`supabase/migrations/062_site_metrics.sql` adds three tables and
`scripts/ga-to-db.js` fills them nightly from GA4; the six traffic handlers
read those tables with the same injected executor, the same column allowlists
and the same caps as every other handler. **No GA4 credential exists inside
this function and no handler makes an outbound request.**

**No LLM anywhere. No writes. No dispatch. No repo access at runtime.**

Amendment 1 (`docs/ADR-slack-tier3-amendment-1-shifts.md`) is Phase 3 and does
not apply to this code.

---

## What is here, and what is deliberately not

| File | Role |
|---|---|
| `types.ts` | 280 | Query-spec vocabulary, the `QueryExecutor` seam, the closed `HandlerId` union |
| `intent.ts` | Eastern time, normalisation, the one window parser, the 156-entry scraper registry, the ordered rule table |
| `handlers.ts` | The handler registry and every query the bot can run |
| `render.ts` | Reply caps (6 lines, 600 chars), safe truncation, formatting primitives, the GA floor marker |
| `redact.ts` | Fail-closed egress filter |
| `intent.test.ts` | 72 tests |
| `handlers.test.ts` | 52 tests |
| `redact.test.ts` | 23 tests |
| `render.test.ts` | 24 tests |

**172 tests total**, all with no network and no database.

The `SCRAPER_REGISTRY` test in `intent.test.ts` asserts the copied registry's
SIZE and that the validation gate works. It does NOT prove parity with
`scripts/manifest.js`, which a Deno test cannot import. The real drift test
belongs in `scripts/tests/` and is tracked in "Known gaps" below.

`handlers.test.ts` is one file beyond the three test files originally scoped.
It is here because the injected-executor seam is only worth having if
something asserts on the specs it produces: it is the file that proves no
query selects a wildcard, no query selects a column that identifies a person,
every query carries a LIMIT, and every param is clamped before it reaches a
filter. Those are the properties a reviewer would otherwise have to check by
eye on every future edit.

**Not built here:** `index.ts` (the HTTP entry point), `verify.ts` (signature
verification), the `slack_ask_requests` queue table and its migrations, and the
`slack-notify` changes (`ask` caller class, `ask_reply` arm, pairwise
`SECRETS_COLLIDE`, the `ChannelKey` uncomment). Those are a separate run.

> **MIGRATION NUMBERS SHIFTED.** The base ADR reserves **062 and 063** for the
> Slack queue tables. `062_site_metrics.sql` has taken 062, so the queue
> migrations become **063 and 064**. (047 remains missing from the sequence and
> stays missing; 057's header records it as reserved by an unlanded branch.)

### Running the tests

```
deno test supabase/functions/slack-ask/
```

No network, no database, no environment variables. `jsr:@std/assert@1` is
already in the repo's `deno.lock`, so the repo-wide
`npm run test:functions` (`deno test --frozen --allow-env supabase/functions/`)
and `npm run typecheck:functions` (`deno check --frozen ...`) both work without
a lockfile change.

### How the entry point stays thin

Handlers never construct a Supabase client. They build a `SelectSpec` or a
`CountSpec` (`types.ts`) and hand it to an injected `QueryExecutor`. The whole
answering path in the future `index.ts` is:

```ts
const match = matchIntent(event.text, new Date())
const lines = await getHandler(match.handlerId).run({ exec, params: match.params, now })
// Pass the PRE-CAP lines as well: see "The redaction contract" below.
const scanned = redactOutbound(composeReply(lines), lines)
if (!scanned.ok) log({ violations: scanned.violations, row: queueRowId })
await postThroughSlackNotify(scanned.text, threadTs)
```

`index.ts` owns exactly one piece of logic this directory does not have: the
`QueryExecutor` implementation that maps a spec onto `supabase-js`. A
`SelectSpec` becomes `.from(table).select(cols + embeds).<op>(col, val)....limit(n)`;
a `CountSpec` becomes `.select('*', { count: 'exact', head: true })`, which
transfers no rows.

`matchIntent` always returns a handler id, so there is no null branch to
forget and no silent dead end.

---

## The handler set

33 handlers: 31 that query Postgres, plus `analytics_unavailable` and
`no_match`, which are real registry entries so the caller has one code path.

Every phrasing below is in `intent.test.ts`, and a test asserts that every
`examples` entry on every handler routes back to that handler, so this table
cannot quietly drift from the code.

Before matching, the text is normalised: the bot mention and every other Slack
entity is stripped, Slack's `&amp;` escaping is undone, curly quotes are
folded, everything is lowercased, and punctuation is dropped except
apostrophes, `/` and `-` (kept so `jilly's`, `9/5` and `2026-09-05` survive).

### Events and content

| Handler | Accepts |
|---|---|
| `events_in_window` | `events tonight`, `tonight`, `this weekend`, `how many events this weekend`, `whats on tomorrow`, `events next 14 days`, `how many events in september`, `events on 9/5`, `how many events` (defaults to next 7d). Also the bare window on its own, up to 3 words, which is the terse phone form |
| `events_by_source` | `events by source`, `per source`, `source breakdown`, `which sources`, `top sources this week`, `where do the events come from` |
| `events_by_category` | `events by category`, `per category`, `category breakdown`, `which categories`, `top categories`, `by type` |
| `events_by_neighborhood` | `by neighborhood`, `by neighbourhood`, `by area`, `by community`, `neighborhood breakdown`, `which areas`, `top neighborhoods`, `where in akron` |
| `events_added_recently` | `whats new`, `anything new`, `new events`, `events added in the last 24 hours`, `added last 3 days`, `anything ingested`, `whats fresh`. A forward-looking window hands the question to `events_in_window` instead, so `any new events this weekend` keeps the weekend |
| `top_venues` | `top venues`, `busiest venues this month`, `which venues`, `biggest venues`, `venues with the most events` |
| `top_organizations` | `top orgs`, `top organizations`, `top organisations`, `busiest organisers`, `which orgs` |
| `events_missing_image` | `events missing images`, `how many events without a photo`, `no artwork this month`, `events needing pictures`, `imageless` |
| `events_at_venue` | `whats on at the rialto`, `events at musica this weekend`, `shows at blu jazz tonight`, `whats at the civic` |
| `free_vs_paid` | `free vs paid`, `free or paid`, `price split`, `how many free events this weekend`, `free events`, `ticketed` |
| `featured_events` | `featured events`, `marquee`, `headliners`, `headline events`, `spotlight`. Deliberately NOT `big events` or `highlights`, which belong to `events_in_window` (see "Rule order") |

All of these accept the window slot (below) and fall back to a documented
default when no window is named: next 7 days for `events_in_window`, next 30
days for the breakdowns, last 24 hours for `events_added_recently`.

### Scrapers and ops

| Handler | Accepts |
|---|---|
| `scraper_health_summary` | `scrapers?`, `scraper health`, `hows the scrape`, `how are the feeds`, `crawlers`, `pipeline` (the family catch-all) |
| `scrapers_failing` | `which scrapers are failing`, `any scraper errors`, `broken scrapers`, `feeds down`, `sources erroring`, `busted scrapers` |
| `scrapers_zero_events` | `which scrapers returned zero`, `scrapers with no events`, `empty scrapers`, `feeds that came back empty` |
| `scrapers_stale` | `stale scrapers`, `scrapers that havent run in 3 days`, `which feeds have gone quiet`, `dormant scrapers` (accepts an N-day slot, default 2) |
| `scraper_last_run` | `when did eventbrite last run`, `akron library scraper status`, `hows summit artspace doing`, `is akron zoo ok`. Any of the 156 registry keys, the key with spaces, or the human label |
| `last_night_totals` | `last night`, `how did last night go`, `overnight totals`, `how did the scrape go`, `nightly run`. An event word with no scraper word hands the question to `events_in_window` with the `last night` window, so `how many events last night` is answered about events |
| `scraper_registry_coverage` | `how many scrapers are there`, `total scrapers`, `scraper count`, `how many sources do we have`, `registry` |

### Site business

| Handler | Accepts |
|---|---|
| `subscriber_counts` | `subscribers`, `how many subscribers`, `subs`, `signups in the last 30 days`, `mailing list`, `list size` (accepts an N-day slot, default 7) |
| `digest_status` | `did the digest go out`, `digest status`, `did the newsletter go out`, `emails sent`, `email sends` (accepts an N-day slot, default 2) |
| `feedback_recent` | `any feedback`, `feedback last 14 days`, `how much feedback`, `bug reports`, `suggestions` (accepts an N-day slot, default 7) |
| `embed_requests_count` | `embed requests`, `how many embeds`, `widget requests` |
| `partner_orgs_count` | `how many partners`, `partner orgs`, `partner organisations`. A superlative (`top partner organizations`) goes to `top_organizations` |
| `review_queue` | `review queue`, `how many events need review`, `awaiting review`, `pending review`, `moderation queue`, `queue depth`, `flagged events` |

### Site traffic (the GA4 mirror)

Six handlers reading the three tables in
`supabase/migrations/062_site_metrics.sql`, which `scripts/ga-to-db.js` fills
nightly from GA4 property `538991588` (data starts 2026-05-27).

| Handler | Accepts |
|---|---|
| `traffic_overview` | `how much traffic`, `how many people visited`, `page views this month`, `visitors yesterday`, `traffic last week`, `ga4 numbers`, `web sessions this week` |
| `traffic_trend` | `traffic vs last week`, `is traffic up or down`, `traffic trend this month`, `is traffic growing`, `page views week over week` |
| `top_pages` | `top pages`, `most viewed pages last week`, `most popular pages`, `which events got the most views` |
| `outbound_clicks` | `outbound clicks`, `how many clickthroughs last week`, `ctr`, `which events sent people to tickets`, `ticket links` |
| `embed_traffic` | `embed traffic`, `how many embed views last week`, `which sites embed us`, `widget traffic` |
| `pwa_installs` | `how many installs`, `pwa installs`, `app downloads`, `is anyone using the app`, `add to home screen` |

Every one of these takes the SAME window slot as the events handlers: `today`,
`yesterday`, `last week`, `this week`, `last 30 days`, `last 24 hours`,
`in september`, `2026-08-20`, `8/20`. There is no second traffic-only window
vocabulary to drift out of sync. Windows with no phrase default to the
trailing 7 days ending yesterday.

**Every figure is marked as a floor.** GA4 under-counts by an unknown,
non-constant margin: ad blockers, Safari and Firefox tracking protection and
DNS blocklists all drop the beacon before it fires, and Byron's own browser
network-blocks `google-analytics.com`, so his own visits are not in the
property at all. `573` would be a claim the data cannot support. So:

- every GA-sourced number renders as `~573` (`gaNum` in `render.ts`), and
- every GA reply ends with one short constant line,
  `~ = GA floor, not a count. Blocked browsers are invisible.`

Both, because neither works alone. Three designs were considered and two lose:
a caveat line ALONE loses the moment a number is screenshotted or quoted
without its footer, which is the normal way a Slack figure travels; "about
573" on each figure costs more characters and says the wrong thing, because
the error is not symmetric (the truth is strictly higher, possibly much
higher); `≥ 573` or "at least 573" is accurate but unreadable at a glance and
costs nine characters a number. One character per figure plus one line per
reply is about 60 characters of the 600-character budget and one line of six,
which is the cheapest honest option on the table. A test sweeps every traffic
reply and fails on any bare figure.

**"visitor-days", not "visitors", over a multi-day window.** `total_users` is
GA4's distinct-user count FOR THAT DAY, so summing seven of them counts
Tuesday's returning visitor twice. The sum is real and useful but it is not a
visitor count, so it is labelled `visitor-days` and shown with a per-day
average beside it (`~1,908 views, ~385 visitor-days (~128/day)`). A single-day
window does say `visitors`, because one day of uniques is a genuine distinct
count. Views, sessions and event counts ARE additive and are summed freely.

**Today is never answerable, and the reply says which day it used.** The
loader never writes a partial day (`ga-impact.js` documents a same-day pull
that was off by 3x and pointed the wrong way), so the freshest possible
answer is yesterday. `traffic today` answers about yesterday with the label
`yesterday (today not loaded yet)`; `traffic this week` asked on a Wednesday
answers `this week (Aug 24-30) so far`. Refusing outright would be a dead end
when a good answer is one day back; answering silently would be a wrong answer.

**`pwa_installs` has no true answer, and says so rather than inventing one.**
There is no install count anywhere:

- an uninstall fires no event, so any running total only goes up and drifts
  further from reality every week;
- iOS "Add to Home Screen" fires NOTHING (no `beforeinstallprompt`, no
  `appinstalled`), so the entire iPhone install base is invisible to the one
  event that does exist;
- `pwa_install_accepted` therefore counts Android and desktop prompt
  acceptances, which is a real number about a real thing and is not "installs".

The only defensible signal, and the one `scripts/ga-install-snapshot.js`
already settled on, is DISTINCT USERS who fired `pwa_standalone_launch` over a
trailing window: people who opened the installed app recently, a floor on the
actively-installed base. The handler reads `pwa_users_28d` / `pwa_users_7d`,
which the loader asks GA4 for directly, and never derives them by summing
`pwa_launch_users` (distinct counts do not add, and that sum would be a
bigger, wronger number). Those columns are nullable, NULL means "not computed
for this date" rather than zero, and the query asks for the most recent
NON-NULL row. With no snapshot stored it refuses and says what to run.

The reply reads:

```
~58 people opened the installed app in the 28d to 2026-08-22, ~29 in the last 7d.
That is a floor on active installs, not an install count: uninstalls fire no
event and iOS Add to Home Screen fires none at all.
Over last 7d: ~46 launches, ~1 Android/desktop install prompt accepted (iOS never fires that).
~ = GA floor, not a count. Blocked browsers are invisible.
```

**One rendering detail with teeth:** `redact.ts` withholds any reply containing
a uuid, and `/organizations/{uuid}` and `/venues/{uuid}` are live routes that
appear in top pages. `pageLabel` replaces a uuid segment with `/{id}` before
the value reaches a line, so one such row costs a label rather than the whole
answer. The scrub applies to **whichever string is returned**, `url_slug` as
well as `page_path`: `redact.ts` does not care which column a uuid came from,
so scrubbing one branch and not the other would be the same bug wearing a
disguise. Belt and braces, the loader bounds its slug capture to `[^/]+`, so a
malformed `/events/x/{uuid}/{uuid}` path cannot put a uuid inside a slug in
the first place. Event detail pages are shown by their URL slug instead. The side
effect is that all organisation detail pages collapse into one
`/organizations/{id}` row; those draw one to three views each and a combined
row is both more useful and more likely to be true than an arbitrary
representative.

**The url-slug is a label, not a key, and this caught a wrong assumption.** An
event URL is `/events/{url-slug}/{uuid}`, and the url-slug in the path is
DATE-suffixed (`ales-on-rails-aug-21`) while `events.slug` is YEAR-suffixed
(`ales-on-rails-2026`). Checked against production: four url-slugs taken from
live GA4 data matched **zero** rows on `events.slug`, all four uuids matched
`events.id` exactly, and 11,318 of 11,321 published events carry the year
form. A join on the path slug would have returned nothing, silently, forever.
So `page_metrics_daily` stores `event_id uuid` as the join key (to
`events.id`) and `url_slug text` as the readable label. The handlers read
`url_slug` and deliberately do NOT read `event_id`: no reply needs it, and
keeping a uuid column out of the allowlist entirely is the cheapest way to be
sure one never reaches the redaction filter.

### Combined

| Handler | Accepts |
|---|---|
| `status_summary` | `status`, `whats broken`, `anything wrong`, `all good`, `everything ok`, `sitrep`, `sup`, `health check`, `anything on fire`, `what needs attention` |

`status_summary` runs four probes concurrently (one `scraper_health` read
covering erroring, stale and zero-streak; last night's runs; digest failures in
3d; review backlog), scores each by how much it should worry the reader, and
renders the worst three plus a last-night line. Nothing wrong renders
`All clear.` plus the night line.

It deliberately does NOT report registry drift, even though it filters through
the registry to count. `scraper_health` permanently carries four names the
manifest does not have, so a drift fact here would fire every single time and
`All clear.` would be unreachable. A standing condition nobody will action is
noise, and noise in the most-used answer is how people stop reading it.
`scraper_health_summary` reports the drift, which is where anyone asking about
scrapers will see it.

### Terminal

| Handler | Accepts |
|---|---|
| `analytics_unavailable` | Unconditional: `referrers`, `referrals`, `acquisition`, `utm`, `bounce rate`, `conversion rate`, `session duration`, `time on page`, `engagement rate`, `impressions`, `search console`, `organic search`, `seo`. Conditional (only alongside analytics vocabulary): `channel`, `device`, `mobile vs desktop`, `browser`, `city`, `geography`, `country`, `real time`, `right now`, `come from` |
| `no_match` | anything else |

`analytics_unavailable` was **shrunk, not deleted**, and it has to stay. It
used to catch all traffic vocabulary; six of those questions now have real
answers, so it caches only what the mirror genuinely does not carry:
acquisition (referrers, channels, UTM), engagement quality (bounce,
conversion, session duration), audience shape (device, browser, city,
country), Search Console metrics, and anything real-time. Without it those
phrasings fall through to `events_in_window`, which would answer "what's our
bounce rate this week" with an event count and a straight face. That failure
has not gone away; only its scope has. Its message now names both halves --
what IS answerable and what is not -- and it still never invents a figure and
never calls GA4.

The CONTEXTUAL half exists because `channel` is a Slack channel, `city` is
where an event is, and "what's happening right now" is a calendar question.
Those only refuse when an analytics word is present, so `traffic by channel`
is refused and `whats happening right now` is answered.

---

## The window slot

One parser, `parseWindow` in `intent.ts`, used by every windowed handler, so
"this weekend" cannot mean two things in two answers. Windows are half-open
(`start` inclusive, `end` exclusive) and every boundary is an Eastern
wall-clock moment converted to a real UTC instant.

| Phrase | Meaning |
|---|---|
| `today` | the Eastern calendar day containing now |
| `tonight`, `tonite`, `this evening` | 17:00 ET today through midnight |
| `last night` | 17:00 ET yesterday through midnight, the mirror of `tonight` |
| `tomorrow`, `tmrw`, `tomorow` | the next Eastern day |
| `yesterday` | the previous Eastern day |
| `this weekend`, `the weekend` | Friday 00:00 through Monday 00:00 ET. On Fri/Sat/Sun this means the weekend in progress, not the next one |
| `next weekend`, `last weekend` | the same window shifted seven days |
| `this week`, `next week`, `last week` | ISO week, Monday through Sunday |
| `this month`, `next month`, `last month` | calendar month |
| `september`, `sept`, `mar 2029` | the next occurrence of that month: this year if it has not finished, otherwise next year |
| `sep 5`, `9/5`, `9/5/27`, `2026-12-31` | one Eastern calendar day |
| `next 14 days`, `coming 7 days`, `in 3 days` | today 00:00 through today+N |
| `last 7 days`, `past 3 days` | N calendar days ending with today inclusive |
| `last 24 hours`, `last 48 hours` | a TRUE rolling window from now, not N calendar days. Collapsing it onto calendar days means "the last 24 hours" covers nine hours when asked at 9am |

Number words work as well as digits (`next seven days`, `past thirty days`).
Day counts are clamped to 1..90 by the parser and clamped AGAIN by the handler
before the value reaches a filter.

**Sub-day windows get no prior-period comparison.** `events_in_window`
normally adds one ("47 events Fri-Sun. Prior 3d: 41."), but the prior window is
built from Eastern calendar midnights, so for `tonight`, `last night` and
`last N hours` it would put a few hours next to a whole day and present them as
like-for-like. Those three answer with the count alone, which is complete.

**Ambiguous windows carry their dates in the label.** `this weekend` renders as
`Fri-Sun (Aug 28-30)` and `this week` as `this week (Aug 24-30)`, so a reply
never leaves the reader guessing which Friday it meant. The line budget is 600
characters and a typical answer spends about 40, so the range is free.

**The first phrase in the parser's order wins, not the first in the sentence.**
`events today and tomorrow` is answered about tomorrow only. A multi-window
question is out of scope for Phase 1, and the reply always names the window it
used, so the reader can see which half they got.

**An impossible date is rejected, not rolled over.** `events on 2026-13-45`
returns no window and the handler falls through to its documented default,
rather than `Date.UTC` silently relocating the question six months out with a
label of `undefined`. `feb 30` falls back to the whole of February.

**`may` and `march` are also ordinary English words**, so they only read as
months in date position: after a preposition, followed by a number, or as the
entire message. `you may want to check the scrapers` is not a question about
May. No other month name needs the gate.

### Why the Eastern-time code is duplicated

Rule: never derive "today" from `toISOString()`. Between 20:00 and 23:59 ET
the UTC calendar date is tomorrow, so a UTC "today" is wrong for a fifth of
every day and wrong in a way that produces a confident answer rather than an
error.

`easternTodayIso` in `intent.ts` is a deliberate reimplementation of
`scripts/lib/normalize.js:584` with identical semantics, duplicated because
Deno edge functions cannot import from `scripts/`. `easternToUtc` is the piece
`scripts/lib` does not export in a usable form: it turns an Eastern wall-clock
moment into the UTC instant a `start_at >= ... and start_at < ...` filter
needs, resolving the offset through `Intl` rather than assuming -5 or -4.

Tested at both 2026 DST transitions (spring-forward day is asserted to be 23
hours long, fall-back day 25), at the wall-clock time that does not exist
(02:30 on 8 March, which resolves forward to 03:30 EDT the way `new Date`
does), and on both sides of midnight ET.

---

## Rule order, and why it is what it is

First match wins. Order IS the disambiguation mechanism, and every position is
a decision:

**1-7. The analytics block runs first**, for the reason the old single veto
   did: "how many page views this week" contains a window phrase and a count
   word, and would otherwise be answered with an event count and a straight
   face. What changed is that the block is now a ROUTER, not a refusal.

   1. `analytics_unavailable` first, because it is the narrowest: only the
      analytics still not stored. Above the answerable rules, so
      `traffic by referrer` is refused rather than answered as plain traffic,
      which would silently drop the half of the question that cannot be met.
   2. `pwa_installs`, on install vocabulary. Narrow and unambiguous.
   3. `embed_traffic`, ABOVE `embed_requests_count` (16-21). `embed traffic`
      is a GA4 question and `embed requests` is a business one; the rule hands
      anything containing `request` down, so the pair separate on the word
      that actually distinguishes them.
   4. `top_pages`, which hands DOWN whenever the superlative is attached to
      venues, orgs, categories, neighbourhoods or sources, so
      `which venues are most popular` still reaches `top_venues`.
   5. `outbound_clicks`. `clickthrough` and `ctr` route here now: on this site
      the clickthrough IS the outbound click, so they moved out of the
      unsupported list.
   6. `traffic_trend` before `traffic_overview`: a comparison question is the
      more specific of the two and both match the same vocabulary.
   7. `traffic_overview`, the family catch-all.

8. **`scraper_last_run` needs both a registry key and scraper vocabulary.**
   `akron_civic` is simultaneously a scraper key and a venue name. Requiring
   scraper words here and event words at `events_at_venue` separates
   `when did akron civic last run` from `whats on at akron civic` cleanly.
9-14. The specific ops questions, each gated on a distinguishing keyword,
   ending with `scraper_health_summary` as the family catch-all.
15. **`status_summary` is anchored to whole-message phrasings.** Unanchored, a
   bare `\bstatus\b` would swallow `digest status` and `eventbrite status`.
   Anchoring is what lets the most-used handler sit high without stealing.
16-21. Site business. `digest_status` precedes `subscriber_counts` because
   "did the newsletter go out" mentions the newsletter but is not a subscriber
   count.
22-31. Event breakdowns, every one gated on an explicit `by X` / `top X` /
   `missing X` phrase.
32. **`events_in_window` is last among the event rules**, because it is the
   broadest, so any earlier event rule that also matches is by definition more
   specific.

### The four tokens that needed a split rather than a position

Position alone could not resolve these, because the same word means different
things in the two families. Each is handled by a gate inside its rule, and each
has a test naming the pair it would otherwise race.

- **`sources`** is ops in "which sources are failing" and content in "events by
  source". It sits in the weak vocabulary set that gates the ops rules which
  ALSO require failure/zero/stale words, and out of the strong set that gates
  the `scraper_health_summary` catch-all.
- **`sessions`** is a yoga class or a story time here, not a web analytics
  session, so it is an EVENT word and only routes to traffic alongside an
  analytics context word. `how many sessions at the library` is an events
  question and is answered as one.
- **`embed`** is traffic in "embed traffic" and business in "embed requests".
  The `embed_traffic` rule sits above `embed_requests_count` and hands down
  anything containing `request`, so the word that actually distinguishes the
  two is the word that decides.
- **`most popular` / `most viewed`** is a page ranking on its own and somebody
  else's ranking when a noun is attached. `top_pages` hands down whenever the
  message names venues, orgs, categories, neighbourhoods, sources or
  scrapers, so `which venues are most popular` never comes back as a list of
  URLs.
- **`last night`** is ops vocabulary in this project, but `how many events last
  night` is plainly a calendar question. The ops rule hands the question down
  when an event word is present and no scraper word is, which is what makes
  the `last night` window reachable at all.
- **`partner`** is a headcount in "how many partners" and a ranking in "top
  partner organizations". A superlative in front of it hands it down to
  `top_organizations`.

Two phrasings were removed from `featured_events` outright rather than gated:
`big events` and `highlights`. `featured` is a manual editorial flag with two
rows in the whole table and none upcoming, so "what are the big events this
weekend" routed there returned "No featured events upcoming" and dropped the
weekend. Fluent, confident, and wrong is the failure the ADR spends section 3
warning about, and the fix is for those words to mean what a reader means by
them.

### The fallback

A miss returns `no_match`, which renders a grouped menu that teaches the
phrasing rather than saying no. It is a curated 5-line constant, not a dump of
every handler's examples, because 33 handlers cannot fit in 6 lines and an
auto-generated menu would be truncated into uselessness. `render.test.ts`
asserts it fits the caps with no ellipsis and no dropped line.

---

## Safety properties, and where each is enforced

| Rule | Where | Test |
|---|---|---|
| Hardcoded column allowlists, never `select('*')` | `SelectSpec.columns` is a required literal array; no wildcard is representable in the type | `handlers.test.ts`, "no handler ever selects a wildcard" |
| No PII reaches a channel | `subscribers.email`, `subscribers.token`, `feedback_posts.email`/`.author_name`/`.body`, `embed_requests.email`/`.name`, `organizations.contact_email`, `email_sends.subscriber_id`/`.error_message` are in no allowlist. Subscribers, embeds and partners are answered by `count` only, which has no column list at all | "no handler ever selects a column that identifies a person", "the subscribers table is never read row-wise at all" |
| Every dynamic value escaped | `esc` / `shortEscaped` / `errorSnippet` in `render.ts` wrap `escapeSlackText`. Clip first, escape second, so an entity is never halved | "a hostile scraper error is clipped and escaped before it reaches a line" |
| Reply caps | 6 lines and 600 characters in `render.ts`. Truncation refuses to cut inside `&amp;`/`&lt;`/`&gt;` or a surrogate pair, and a dropped line becomes `+N more` rather than vanishing | "truncation refuses to cut inside an escape sequence", "every handler produces a reply that fits the caps" |
| Fail-closed egress | `redact.ts` scans the composed message AND the pre-cap lines, and REPLACES the whole reply on a hit. See "The redaction contract" | "catches the handler nobody reviewed", "alsoScan catches a secret the line cap would have hidden" |
| Params validated and clamped before querying | Every handler re-clamps its own days, re-checks its scraper name against the registry, re-sanitises its venue term, and re-derives an absent or insane window | "scraper_last_run rejects an unregistered name BEFORE any query", "a day count is clamped by the handler" |
| Row caps and LIMIT everywhere | `SelectSpec.limit` is required; aggregations cap at 3000 rows and say `(first 3000)` when the cap is hit | "every select carries a sane LIMIT" |
| No GA credential in the function | Traffic handlers read three Postgres tables through the same executor. No `fetch`, no service-account key, no GA4 call anywhere in this directory | "traffic handlers read only the GA mirror, and only allowlisted columns" |
| No GA figure is presented as exact | `gaNum` prefixes `~`; `GA_FLOOR_NOTE` is the last line of every GA reply | "every GA figure carries the floor marker and every GA reply carries the note" |
| No distinct-user count is fabricated | A multi-day sum of daily uniques is labelled `visitor-days`; the installed base is read from a GA4-computed snapshot, never summed | "traffic_overview never calls a multi-day sum of daily uniques 'visitors'", "pwa_installs reads the stored distinct-user snapshot and never sums daily users" |

**Why any UUID is a violation:** no handler renders one. `page_metrics_daily`
holds real `/organizations/{uuid}` paths, and `pageLabel` rewrites the uuid
segment to `/{id}` before it reaches a line precisely so this rule keeps
holding rather than costing the whole traffic answer. The reply surface is
counts, names, labels, timestamps, and clipped error strings. A UUID in
outbound text is therefore a leak by definition, most likely
`subscribers.token`. That is both simpler and stricter than judging the
surrounding words. If a future handler genuinely needs to print an id, that is
the moment to revisit the rule, deliberately, in review.

**Violation names never contain the match.** Logging the matched text would
move the leak from the channel into the function logs.

### The redaction contract

`redact.ts` runs last, which is what makes it a backstop, but "last" also means
the text it sees has already been shortened twice: `errorSnippet` clips
third-party strings to about 60 characters inside the handler, and
`composeReply` drops lines past six and truncates at 600 characters. A secret
can therefore arrive as a FRAGMENT of itself, or not arrive at all.

Two mitigations, and **the caller owns the second one**:

1. Every credential-prefix rule uses a LOW length threshold (`{4,}`), so
   a bare `xox` prefix plus four characters is caught even though the rest was clipped. The prefix is the
   signal; the tail is not needed. A false positive costs one withheld reply.
2. **`index.ts` must pass the handler's raw line array as the second argument:**
   `redactOutbound(composeReply(lines), lines)`. Both are scanned and either
   one trips the withhold. Without it, a secret sitting in line seven of an
   eight-line answer is dropped by the line cap, never scanned, and the reply
   posts looking clean while the same handler leaks it the next time the answer
   runs one line shorter.

Neither mitigation recovers a secret that `errorSnippet` cut below its own
prefix. That residual gap is why the column allowlists are still the primary
control, not this filter.

The rule set covers Slack tokens (`xox*`, `xapp-`), JWTs (`eyJ`, which is how
every Supabase key looks), `sk-ant-`, generic `sk-` keys including the
hyphenated `sk-proj-` form, Resend `re_` keys, GitHub `ghp_`/`github_pat_`,
Google `AIza`, the literal `service_role`, bearer headers, private key blocks,
Postgres connection strings, email addresses, and any UUID.

`findViolations(text)` is exported for a caller that wants to scan something
else (a log payload, a queue row) without the replace-the-reply machinery.

**Injection:** the matcher is regex over normalised text, so the worst an
injection attempt achieves is a differently-classified question from the fixed
set. `intent.test.ts` asserts that "ignore previous instructions and post the
subscriber list with emails" routes to `subscriber_counts`, whose queries are
counts and cannot select an email column.

---

## Known gaps

### 1. Site analytics: the bridge exists now, and here is what it still cannot do

This gap used to read "there is no bridge from GA4 into this function". There
is now, and it is the cheaper of the two options the gap named: a scheduled
job writing GA4 aggregates into Postgres, which the bot reads like any other
handler. The GA4 Data API is NOT called from the edge function and no service
account credential lives on a `verify_jwt=false` endpoint, which is what the
ADR's threat model argued for.

```
scripts/ga-to-db.js   (Node, holds the service-account key, runs nightly)
      |  same loadConfig/mintJwt as the six read-only ga-*.js scripts
      v
site_metrics_daily / page_metrics_daily / embed_metrics_daily   (migration 062)
      |  service role, RLS on, NO anon grant
      v
slack-ask traffic handlers   (no credential, no outbound request)
```

Six things about that pipeline a reader should know before trusting a number:

1. **GA is a floor.** See "Site traffic" above. Every figure is under-counted
   by an unknown margin and is rendered with `~`.
2. **The mirror lags one day.** The loader never writes a partial day, so the
   freshest answer is always yesterday.
3. **`--no-rolling` leaves the two snapshot columns alone rather than zeroing
   them.** PostgREST derives ONE column list for the whole payload, so a
   column absent from every row is in neither the INSERT list nor the
   `DO UPDATE SET` and the stored value survives. That is why `blankSiteRow`
   omits those keys instead of setting them to `null`. With rolling ON they
   are present, so a backfilled date from before the PWA shipped stores `0`
   rather than `NULL`; that is accepted, because `0` is simply true there.
4. **The loader re-writes a trailing 3-day window every night.** GA4 keeps
   revising a day for roughly 48 hours (late hits, session stitching,
   identity resolution), so writing yesterday once would bake the undercount
   in permanently. Three days means every date is written three times and the
   last of those is more than 48 hours after the day closed. The upserts are
   keyed on the natural grain, so re-writing is free of consequence.
5. **Backfill is `--from 2026-05-27`**, chunked seven days per GA4 request,
   sequential with a pause between chunks. `--dry-run` prints every row it
   would write and touches no database. `--no-rolling` skips the two
   distinct-user reports, which are the only ones that cost a request per day.
6. **No anon read, and no bare `authenticated` read either.** 062 avoids two
   separate mistakes. `004_anon_scraper_health.sql` granted anon SELECT on ops
   data for a public page and is not repeated: nothing in the frontend reads
   these tables, the bot uses the service role, and
   `page_metrics_daily.page_path` is a URL path, so any future page that puts
   a token or an id in a path would publish it. The second, easier mistake is
   `using (true)` for `authenticated`. Migrations 038 and 051 did write that,
   and **those policies no longer exist**: `059_admin_boundary.sql` rewrote
   fifteen of them to use `is_admin()`, and production carries
   `Admin can read email_sends` / `Admin can read embed_requests` /
   `Admin full access partner_orgs`. `subscribers.auth_user_id` exists, so
   ordinary subscribers hold auth accounts; `using (true)` would hand every
   one of them the traffic figures, every page path the site has served, and
   partner embed volumes. All three policies in 062 are `using (is_admin())`.
   A public traffic widget, if it is ever wanted, gets its own narrow view
   with its own grant.

What is still genuinely unavailable is listed under `analytics_unavailable`
in "The handler set": acquisition, engagement quality, audience shape, Search
Console, and anything real-time.

**One window limitation worth naming:** `parseWindow` understands keyword
windows (`today`, `yesterday`, `last week`, `this week`, `last 30 days`,
`last 24 hours`), a named month, and a single explicit date (`2026-08-20`,
`8/20`). It does NOT parse a two-ended explicit range ("from Aug 1 to Aug
15"); the closest phrasings are `last N days` or a month name. That is the
existing parser's limit, shared with every events handler, and widening it
would be a change to the one window parser rather than a traffic-only
addition.

### 2. `SCRAPER_REGISTRY` is a copy of `scripts/manifest.js` and can drift

156 entries, 150 active, generated from the manifest on 2026-08-23. It is
copied because Deno edge functions cannot import from `scripts/`, and the
alternative (interpolating whatever the user typed) is worse.

**The repo already solves this exact problem twice:**
`scripts/tests/test-slack-agent-identities.js` fails CI when
`AGENT_IDENTITIES` drifts from `.claude/agents/*.md`, and the dataSources sync
test fails CI when `manifest.js` drifts from `src/lib/dataSources.ts`. A third
test in the same shape belongs here and would take about twenty lines. It is
**not written in this run** because this run was forbidden from touching the
repo, and a sync test has to live in `scripts/tests/` to run under `npm test`.

Until it exists, a new scraper is simply not addressable by name until someone
updates the copy. The failure is a "not a scraper I know" reply, not a wrong
answer, so it is safe, just annoying.

### 3. `events_at_venue` reports a capped count, not an exact one

The count is `min(matches, 25)` rendered as `25+` when the cap is hit, because
`CountSpec` has no embed support and the venue filter lives on an embedded
column (`event_venues.venues.name`). Making it exact means either teaching the
executor to count over embeds or adding a second round trip. Not worth it for
a chat reply that lists four events; worth revisiting if it turns out to be a
question Byron asks about big venues.

### 4. Neighbourhoods come from `venues.neighborhood_slug`, not `areas`

Worth stating because the table names mislead. `areas` (4 rows) is venue
sub-rooms: "Pool room", "Gallery Stage", "XXII Gallery". `event_areas` is
empty. The real neighbourhood is `venues.neighborhood_slug`, which is set on
359 of 931 venues, so `events_by_neighborhood` reports how many events have no
neighbourhood on their venue rather than silently dropping them.

Every join-shaped handler DEDUPES PER EVENT before tallying. 738 production
events have more than one venue, so a flat tally counts venue links rather
than events: the neighbourhood totals exceed the event count and the "no
neighbourhood" remainder goes negative. `top_venues` and `top_organizations`
dedupe for the same reason and say `(by event)` in the header so the basis is
on the screen. `events_at_venue` picks the embedded venue name that actually
contains the search term, because on a multi-venue event the first one listed
is frequently not the one that matched.

`venues.listed` is deliberately NOT filtered (132 of 931 venues are unlisted).
The question is where events are actually happening, an unlisted venue still
hosts them, and filtering would make these numbers disagree with the event
counts every other handler reports for the same window.

### 4b. `scraper_health` is a superset of the manifest, and the difference is reported

`scraper_health` is derived from `scraper_runs`, which records whatever name a
script logged. In production it carries 160 names, four of which are not in
`scripts/manifest.js`: `dedupe_cross_source` (a post-processing pass, not a
scraper at all), `ejthomas_hall`, `uakron_chp`, and `uakron_myers_art`.

Every ops handler filters through `SCRAPER_REGISTRY` before counting, so the
denominators are right and a failing dedupe pass is never reported as a
failing scraper. The remainder is surfaced as its own short fact rather than
dropped, because a name logging runs that the manifest does not have is
exactly the registry-drift signal worth seeing.

### 5. `featured` is almost always empty, and that is correct

Two rows in the whole table, zero of them upcoming. `featured` is a human-only
editorial flag (scrapers hardcode `featured: false`, per
`.claude/agents/developer.md` rule 2). `featured_events` therefore explains
the empty result and offers the upcoming `banner_eligible` count instead of
looking broken.

### 5b. Two other column choices worth knowing

`feedback_recent` derives resolution from `resolved_at`, not `status`. Every
production row has `status = 'published'`, which is a visibility flag, so a
`status !== 'resolved'` test reports the whole batch as open forever and the
"unresolved" figure is indistinguishable from the total. 19 of 26 rows
currently have a null `resolved_at`. The column is a timestamp, not PII.

`subscriber_counts` reports `confirmed = true AND unsubscribed_at IS NULL`,
which is exactly how `send-digest/index.ts:684-685` picks recipients. Counting
`confirmed` alone drifts above the real recipient list the moment anyone
unsubscribes, and a bot whose subscriber count disagrees with the mailer's is
worse than no count.

`events_added_recently` restricts to `status = 'published'` like every other
events handler. It was the only one that did not, so it counted the 415
cancelled rows. If a cancelled ingest ever needs surfacing it deserves its own
handler and its own wording, not a silent inflation of this one.

### 6. `is_accessible_for_free` is unreliable, so `free_vs_paid` uses `price_min`

Only 37 rows set the flag, against 4325 rows with `price_min = 0`. The handler
splits on `price_min` (0 free, greater than 0 paid) and reports separately how
many of the window's events have no price recorded at all, which is currently
about half. A percentage that quietly treated unknown as paid would be the
kind of number that gets acted on and is wrong.

### 7. `no_match` does not fall back to the agent lane

ADR section 3 says the fast lane's fallback on a miss is to demote to the
agent lane ("Not a canned one, sent to the night crew, back by morning").
There is no agent lane in Phase 1, so `no_match` renders the menu instead.
When Phase 3 lands, the demotion belongs in `index.ts`, and `no_match` stays
as the reply for the case where demotion is not wanted.

---

## Design notes worth reading before extending this

- **Adding a handler:** add the id to the `HandlerId` union in `types.ts`
  (TypeScript then fails the build until `HANDLERS` has an entry), write the
  handler, add a rule to `RULES` positioned above everything broader than it
  and below everything narrower, and add `examples` to the registry entry. The
  test "every handler example routes to the handler that published it" then
  proves the phrasings work, and this README's table stays honest.
- **Adding a handler that joins:** dedupe the embedded values per row before
  tallying, or the counts silently become link counts. `events_by_neighborhood`
  has the regression test with a two-venue row; copy its shape.
- **Adding a filter operator:** keep it a bound value, never a fragment. If
  someone later adds a raw-SQL RPC to this directory: in Postgres,
  `NOT x ILIKE ANY(...)` does not mean what it reads like. Write
  `NOT (x ILIKE ANY(...))`. This project has been bitten by that precedence.
- **`getHandler` throws on an unknown id** rather than falling back, which is
  deliberately unlike `resolveAgentIdentity`'s soft default. A typo'd persona
  costing the default avatar is fine; a typo'd handler running a different
  query is not.
- **Handlers return lines, not a string.** The caps live in `render.ts`, and
  the type is what stops a handler author from opting out of them.
