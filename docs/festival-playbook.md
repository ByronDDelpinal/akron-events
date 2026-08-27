# Festival Playbook

How to give a festival the registry-driven hub treatment (PorchRokr 2026 was the first,
single-day; Akron Pride 2026 is scaffolded; Rubber City Jazz 2026 is the first multi-day
festival), and the invariants that keep the hub honest. This file is the system of record
for festival work. It is one of the few committed files in docs/ (the rest of the directory
stays local by design); agent roles read it here.

Written 2026-08-10, the day the Pride 5K hijacked the Akron Pride hub header (see
Invariant 1). Every claim below is verified against the code cited next to it.

## Why festivals get this treatment

- Day Plan planning: the hub's whole point is building a personal day. Every set card
  carries EventCard's AddToPlanButton (planSurface 'festival_hub'), the map shows an amber
  ring on planned venues, and a floating "Your plan (N)" pill follows the visitor
  (src/pages/FestivalPage.tsx).
- Discovery: a festival is the one moment a casual visitor arrives with intent. The hub,
  the homepage banner, the search shortcut, and the umbrella page's hub button all activate
  from a single registry entry, no per-festival code.
- One-day traffic spikes: festival day concentrates a month of traffic into hours. The hub
  is one PostgREST query, the map is lazy and tap-gated on mobile (no maplibre chunk, no
  tiles until asked), and per-set cards render imageless on the shared compact view, so the
  spike stays cheap (src/pages/FestivalPage.tsx).

## Step order for a new festival

### 1. Registry entry (src/lib/festivals.ts)

Add one object to `FESTIVALS`:

- `slug`: `<festival>-<year>`, e.g. `akron-pride-2026`. Unknown slugs render not-found.
- `name`: SHORT display name. The hub title and the homepage banner both interpolate it:
  the banner reads "{name} is {festivalBannerPhrase(f)}.", which is "is Saturday" / "is
  today" for a single-day entry and "is Thursday through Saturday" / "is on now through
  Saturday" / "is on its final day" once `endDateKey` is set. So "Akron Pride Festival",
  not the umbrella event's full official title ("Akron Pride Festival and Equity March
  2026" stays on the event row).
- `dateKey`: the festival's FIRST (or only) day as an Eastern `yyyy-MM-dd`. Compared only
  via dayPlanDate.ts helpers (easternTodayIso, easternDateKeyDiffDays); never a UTC-derived
  today, never a Date-vs-string compare.
- `endDateKey`: OPTIONAL, the festival's LAST Eastern day, `yyyy-MM-dd`, >= dateKey. Omit
  for a single-day festival, and every range question then collapses to the old dateKey-only
  behavior byte for byte. Set it for a multi-day run (Rubber City Jazz 2026: dateKey
  '2026-09-10', endDateKey '2026-09-12'). Never do the range math yourself at a call site:
  route through festivals.ts's `festivalEndDateKey` / `isFestivalDateKey` / `festivalDateKeys`
  / `festivalDayCount` / `festivalDateRangeLabel` / `festivalBannerPhrase`.
- `schedule`: OPTIONAL, `'slot'` (default when omitted) or `'day'`. Chooses how the hub lays
  out the schedule body and what the sticky jump bar's chips address. Read it through
  festivals.ts's `festivalScheduleMode()`, never the raw field, so the default lives in one
  place. Both modes render the SAME `EventCard` in the SAME `.cards-grid--efficient`; they
  differ only in what gets a heading:
  - `'slot'`: one heading per distinct start time, holding the cards that share that instant,
    and one chip per start time. Use it when MANY sets share FEW start times, which is what
    makes the time the useful grouping (PorchRokr: 161 sets across 6 slots, so each heading
    introduces a full row of porches).
  - `'day'`: one heading per Eastern day, holding that day's cards as a single grid in start
    order, and one chip per day. Use it when starts are mostly UNIQUE, where per-slot headings
    degenerate into one heading per card and a very long scroll (Rubber City Jazz: 18 sets
    across 17 distinct starts). Nothing is lost: the card already shows its own date, time and
    venue. "Happening now" and "Up next" survive as card outlines, since there is no per-slot
    heading left to carry the badge.
  Rule of thumb: divide sets by distinct start times. Around 3 or more sets per start, use
  `'slot'`; close to 1, use `'day'`. A single-day festival has no day breaks to group by, so
  leave it on `'slot'`.
- `tag`: equal to the slug by convention. This is the discovery key: every row belonging
  to the festival (per-set rows AND the umbrella) carries it in events.tags (GIN-indexed).
- `mapBounds`: `[west, south, east, north]` BBox, camera SEED only (pins drive fitBounds
  once the lineup lands). Mirror the importer's hard-gate bbox where one exists
  (PorchRokr's entry mirrors HS_BBOX in scripts/import-porchrokr.js).
- `landmarks`: empty until coordinates are geocoded and eyeballed. Never invent
  coordinates to fill it.
- `website`: organizer site, rendered on the hub header.
- `venueNamePrefix`: ONLY when the importer mints prefixed venues (PorchRokr mints
  "PorchRokr Porch 7 - ..."); festivalSchedule.ts's stripVenuePrefix strips it for display
  in both the list and the map pins. Omit it when the festival's venues carry clean names
  (Akron Pride omits it).

The registry hygiene test (scripts/tests/test-festivals.js) fails if an entry derives no
search candidates. Candidates that collide with a neighborhood/city/region hub label are
dropped automatically, so a festival shortcut can never shadow a hub jump.

### 2. Umbrella selection and tagging

The umbrella is THE FESTIVAL EVENT ITSELF: the row the owning scraper already maintains
(PorchRokr: the highland_square scraper's `porchrokr-2026` row). Never a side event, never
a minted row. An AGGREGATOR-owned umbrella is acceptable when no first-party scraper exists
for the festival (Rubber City Jazz 2026: the `ohio_festivals` aggregator's own row):
pin `image_url` in addition to tags and description, since an aggregator scraper typically
has no image of its own and nulls it out on every run; the poster is what makes the hub
header complete and the festival digest-eligible.

- Tag it: `tags += [<tag>, 'festival-umbrella']`. The hub surfaces the umbrella
  separately for the header card (poster image, logistics description, "Festival
  details" link); it never enters the schedule grid
  (src/lib/festivalSchedule.ts buildFestivalSchedule).
- PIN the tags: write `manual_overrides.tags = { at: <now>, by: '<slug>-import' }` in the
  same statement as the tag change. Unpinned, the owning scraper rewrites tags on its next
  run and the umbrella silently vanishes from the hub.
- Re-stamp semantics: the live pin trigger reverts any pinned key whose value changes
  without a re-stamp, and the re-stamp must carry a DIFFERENT value than the stored stamp
  (fresh `at`). import-porchrokr.js's computeUmbrellaEnrichment does this correctly:
  existing pins preserved, fresh `{at, by}` for exactly the keys being changed. Only stamp
  keys you mean to freeze.
- Ownership: the scraper that produced the umbrella KEEPS owning every unpinned field
  (title, times, image, price...). The importer pins only what it changes: tags,
  description (logistics block behind an idempotent marker), and the category pair.

### 3. Lineup data file and importer

- Data file: `scripts/data/<slug>.json` (checked in; the file IS the source, the importer
  is the reproducible "re-scrape"). Validate structurally before planning
  (validateDataFile in import-porchrokr.js: unique slot grid, confidence enums, bbox
  membership, routing keys, link allowlist).
- Importer: `scripts/import-festival.js` is the importer for a festival with a PUBLISHED
  LINEUP AT REAL VENUES: venues resolved by id and verified by name, never minted, no
  geocoding. `scripts/import-porchrokr.js` stays FROZEN for its minted-venue,
  brochure-schedule shape (it is also `test-festival-schedule.js`'s live fixture) until
  PorchRokr 2027 forces the two to consolidate; do not edit it and do not copy-paste a
  third importer. Both are dry-run by default, take `--write` to upsert and
  `--prune-missing` to cancel rows the file no longer accounts for, and differ on how they
  find their data: `import-festival.js` takes `--festival <slug>` (reading
  `scripts/data/<slug>.json`) or `--data <path>`, while `import-porchrokr.js` has a fixed
  hardcoded data path and additionally takes `--geocode`.
- Sub-source: per-set rows live under a dedicated source key (`porchrokr`, `rubber_city_jazz`,
  ..., subOf the umbrella's own source in src/lib/dataSources.ts, NO scripts/manifest.js
  entry) that NO scraper writes. That is what makes the rows durable: nothing overwrites
  them nightly, so they need no tag pins.
- Slot-keyed source_ids: `2026-p07-1300`, `2026-stage-main-1930`. An act swap updates the
  title in place instead of churning source_ids into duplicates. Dry run first, always;
  the write path aborts loudly per venue on any gate failure.
- Category locks: per-set rows upsert with an explicit ordered category list
  (['music','festival'], primary first), then pin BOTH `manual_overrides.categories` AND
  `manual_overrides.category_slugs` (the pair travels together; pinning one leaves the
  other revertable). The umbrella's junction is verified festival-primary BEFORE its own
  pin, never piggybacked on the enrichment write.
- Per-set rows are never tag-pinned and never stamped beyond that category pair: no
  status key, no featured key, no tags pin. Their sub-source already owns them outright.
- Post-event pruning: `--prune-missing` sets rows the file no longer accounts for to
  status 'cancelled'. Never delete; FLAG-excluded acts are never pruned (human call).

### 4. Venues

- Mint synthetic venues (porches, stages) through ensureVenue with `listed: false`, then
  stamp `manual_overrides` (lat/lng/listed/name, by '<slug>-import') as an advisory
  provenance marker for sweeps and the post-festival tombstone runbook.
- Stamp ONLY when the resolved venue's name equals the exact minted name. ensureVenue may
  legitimately resolve the address onto a pre-existing real venue (867 W Market St is
  Mustard Seed's building); stamping or unlisting a real venue is vandalism
  (stampMintedVenue in import-porchrokr.js).
- Hard gates, no exceptions: classifySummitLocation(coords) === 'in' AND the Summit bbox
  AND the tight festival bbox. Missing coordinates are a loud per-venue abort, never a
  quiet skip. A geocoder answer in Barberton is wrong even though it is in-county.
- Reuse real venues where the festival occupies one (PorchRokr porches 38/39 are House
  Three Thirty: venueOverride, never minted, never stamped).
- Geocoding: `--geocode` fills HIGH-confidence coordinates via Nominatim (house-number
  match plus precision gate plus both bboxes), writes back into the JSON only with
  `--write`, and Byron eyeballs the diff before any DB write.

### 5. Discovery surfaces that activate automatically

All of these key off the registry entry alone; nothing festival-specific is hardcoded:

- Hub page `/festival/:slug` (src/pages/FestivalPage.tsx): umbrella header, venue map,
  jump bar, day-of live states and auto-scroll, plan pill.
- Search shortcut: the homepage search box jumps straight to the hub when the query names
  the festival (resolveFestivalSlug; candidates derived from slug and name, hub-collision
  and 4-char guards applied).
- Homepage banner: dateKey within [0, 7] days of Eastern today, inclusive both ends
  (upcomingFestival); headline uses festivalDayLabel ("today" / "tomorrow" / weekday).
- Featured-first-in-day: if the maintainer features the umbrella, it orders ahead of its
  day group on the homepage (src/lib/eventGrouping.ts). Featuring is his call, never ours.
- Umbrella page hub button: EventPage cross-links to the hub when the event carries
  'festival-umbrella' AND a registry tag (src/pages/EventPage.tsx). Omitted in embeds.

### 6. Maintainer decision checklist

Ask Byron, per festival; none of these are agent defaults:

- Granularity: per-set rows (PorchRokr, 161 sets) or umbrella-only (a festival without a
  published lineup)?
- Categories: which pair, and which is primary? (PorchRokr sets: music primary; umbrella:
  festival primary.)
- Feed flood: are N per-set rows on one day acceptable in the main feed, or do they need
  handling before import?
- Digest: per-set rows carry image_url null, so the digest image gate keeps them out of
  rich cards by construction. Does the umbrella need a digest decision?
- Featured: the umbrella is a strong candidate, but featured is human-only. Never set it.
- Post-festival: when does the tombstone runbook run (cancel stale sets, unlist or
  tombstone minted venues)? PorchRokr's is pending after 2026-08-15.

## INVARIANTS

The hard rules. check:festivals enforces 1 through 4 mechanically; 5 through 7 are
conventions every writer must hold.

1. Exactly ONE published row per festival tag carries 'festival-umbrella', and it must be
   the festival event itself. The hub treats the EARLIEST-STARTING match as the umbrella
   (buildFestivalSchedule takes the first umbrella in FestivalPage's start_at-ascending
   query), so any earlier row wearing both tags hijacks the header. That is exactly what
   happened on 2026-08-10: the Pride 5K was tagged with 'festival-umbrella' plus the hub
   tag, started before the festival, and the hub rendered 5K copy and imagery as the
   Akron Pride header.
2. The umbrella's Eastern calendar date equals the registry dateKey. Eastern helpers only
   (easternDateKey); toISOString-derived dates are the classic off-by-one trap.
3. Umbrella hub tags must be PINNED via manual_overrides.tags, or the owning scraper
   strips them on its next run and the hub loses its header.
4. No published row may carry 'festival-umbrella' without matching a registry festival
   tag (orphan umbrellas from retired entries).
5. Per-set rows belong to a dedicated sub-source that no scraper writes. Scrapers never
   touch them; the importer is their only writer. Documented exception: a set already owned
   by a scraper (a ticketed show whose scraper owns the ticketing truth, e.g. Rubber City
   Jazz 2026's Ticketmaster Lock 3 headliner) may stay a child WITHOUT moving to the
   importer's sub-source, provided its hub tags are PINNED via manual_overrides.tags exactly
   as an umbrella's tags are (rule 3 above); the importer only adds tags to that row, never
   title, times, price, image, or ticket_url. `check:festivals` does not enforce dateKey
   membership or umbrella-pin semantics on children, so this pin's health is visible only in
   the importer's re-run output. Record the exception in the festival's own data file (the
   set's `existing` key names the owning source and source_id, which is the durable note)
   and re-run the importer after any change to that row.
6. featured is human-only. No importer, scraper, or agent ever sets featured true.
7. Copy rules apply to every user-facing string the festival work produces: no em dashes,
   viewer-local time display, Eastern date keys for day identity.

## QA gates for any festival change

Run all of these before calling festival work done:

1. `npm run check:festivals` (scripts/check-festivals.js, read-only): one pinned umbrella
   per registry tag, umbrella on its dateKey, no orphan umbrellas, WARN when a festival
   inside its banner window has no lineup rows. Exits 1 on any FAIL.
2. Unit suites: `npm test` covers the registry hygiene and hub derivation suites
   (test-festivals.js, test-festival-schedule.js, test-check-festivals.js) plus the
   importer's pure logic.
3. Behavioral: load `/festival/<slug>` and confirm the header shows the FESTIVAL (title,
   poster, logistics), not another event; confirm the sets grid is populated post-import
   and slot times are Eastern-correct in a viewer-local render.
4. Anon API spot-check (the frontend's real path; service-role SQL can hide RLS and cache
   issues): confirm the hub query returns rows for an anonymous key, e.g.
   `curl "$VITE_SUPABASE_URL/rest/v1/events?select=id,title,tags&tags=cs.{<tag>}&status=eq.published&limit=5" -H "apikey: $VITE_SUPABASE_ANON_KEY"`.
5. docs/qa-sanity-tests.md Test 21 (festival hub pages) for the manual sweep.
6. Multi-day only (any festival carrying `endDateKey`). Common to BOTH schedule modes: the hub
   renders one `<section class="festival-day">` per Eastern day, ascending, each with its own
   day heading, and that heading is visibly louder than a slot heading (bigger label, more
   room above it, a 2px rule); the header date line reads a RANGE ("Thursday, September 10 to
   Saturday, September 12, 2026"), not a single day. Then check the mode the festival actually
   uses (step 1's `schedule` bullet):
   - `'slot'`: the sticky jump bar carries one non-interactive day label ahead of each day's
     time chips, and each day holds one heading per start time. "Happening now" and "Up next"
     appear as badges in those slot headings.
   - `'day'`: the sticky jump bar carries one INTERACTIVE chip per day and no time chips at
     all, each day holds a single card grid with no per-slot headings, and "Happening now" and
     "Up next" appear as badge text ON the card (with the amber/green outline as
     reinforcement, never as the only signal). Clicking a day chip scrolls to that day's
     section.

   Regression check, either mode: a single-day festival must render byte-identical to before
   any of this existed (no day wrapper, no jump-bar day labels, no card-state badges); load
   `/festival/porchrokr-2026` alongside the multi-day festival. Note that the only multi-day
   entry today, `rubber-city-jazz-2026`, is in `'day'` mode, so the `'slot'` half of this gate
   has no page to run against until a multi-day slot-mode festival exists.
