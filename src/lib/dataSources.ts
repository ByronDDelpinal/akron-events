/**
 * dataSources.ts — public-page registry of every ingestion source.
 *
 * SINGLE SOURCE OF TRUTH WIRING:
 *   scripts/manifest.js owns which scrapers exist, their keys (= the DB
 *   `source` column), and their display labels. This module imports it
 *   directly, so adding a scraper to the manifest automatically labels it
 *   here — no hand-synced registries (the old DATA_SOURCES / SCRAPER_LABELS /
 *   SOURCE_GROUP_BY_KEY triple-update chore is gone).
 *
 * What stays editorial in this file:
 *   • DATA_SOURCES   — per-source prose (method, venue, notes, status) and
 *     aggregator sub-sources (subOf) that have no scraper of their own.
 *     Labels for manifest-backed keys are DERIVED; do not add them inline.
 *   • SOURCE_GROUPS / SOURCE_GROUP_BY_KEY — the page's platform grouping,
 *     an editorial taxonomy distinct from the manifest's `group` field.
 *
 * scripts/tests/test-manifest-sync.js fails CI when a manifest key is missing
 * from DATA_SOURCES or SOURCE_GROUP_BY_KEY, or when an inline label sneaks
 * back in for a manifest-backed key.
 */
import { SCRAPER_LABEL } from '../../scripts/manifest.js'

export interface DataSource {
  key: string
  label: string
  method: string
  methodDetail: string
  venue: string
  notes?: string
  status: string
  /** present when this source rides on an aggregator (rolled up to the parent) */
  subOf?: string
}

export interface SourceGroup {
  id: string
  title: string
  description: string
}

/**
 * Labels for aggregator sub-sources that ride on a parent scraper (subOf) and
 * therefore have no manifest entry of their own.
 */
const SUB_SOURCE_LABELS: Record<string, string> = {
  ejthomas_hall: 'E.J. Thomas Hall',
  uakron_myers_art: 'Myers School of Art',
  uakron_chp: 'Cummings Center',
}

/** key → display label for every known source (manifest first, then subs). */
export const SCRAPER_LABELS: Record<string, string> = {
  ...SCRAPER_LABEL,
  ...SUB_SOURCE_LABELS,
}

/** Human label for a source key, with a readable fallback for unknown keys. */
export function labelFor(key: string): string {
  return SCRAPER_LABELS[key] ?? key.replace(/_/g, ' ')
}

const RAW_DATA_SOURCES: (Omit<DataSource, 'label'> & { label?: string })[] = [
  // ── Public REST APIs ────────────────────────────────────────────────────
  {
    key:         'ticketmaster',
    method:      'REST API',
    methodDetail:'Ticketmaster Discovery API v2 — 25-mile radius from Akron center',
    venue:       'Regional events (Akron / Summit County)',
    notes:       'Queries by lat/lng within 25 miles of downtown Akron over a 90-day window. The radius covers Blossom Music Center (~8 mi), Akron Civic Theatre, E.J. Thomas Hall, and most Cleveland-adjacent ticketed shows that travel through the area. Because the search is geographic rather than per-venue, new Ticketmaster-hosted venues inside the radius are picked up automatically.',
    status:      'active',
  },
  {
    key:         'rubberducks',
    method:      'REST API',
    methodDetail:'MLB Stats API (statsapi.mlb.com) — teamId 402',
    venue:       '7 17 Credit Union Park — 300 S Main St',
    notes:       'Fetches the full season home-game schedule. Home games only (teamId=402). Promotion data (Fireworks Night, etc.) surfaced in descriptions.',
    status:      'active',
  },
  {
    key:         'akron_zips',
    method:      'iCalendar Feed',
    methodDetail:'Sidearm Sports composite calendar (gozips.com/calendar.ashx/calendar.ics)',
    venue:       'On-campus venues — InfoCision Stadium, Skeeles Field, Firestone Stadium, James A. Rhodes Arena',
    notes:       'Parses the gozips.com composite .ics feed (all sports, sport_id=0). Home games only — filtered to "vs" matchups at Akron venues; away games and BYE weeks are skipped. Titles normalized to "Akron Zips <Sport> vs <Opponent>". Covers football, basketball, baseball, softball, soccer, volleyball, and more.',
    status:      'active',
  },
  {
    key:         'uakron_calendar',
    method:      'REST API',
    methodDetail:'LiveWhale calendar JSON API',
    venue:       'University of Akron campus — multiple locations',
    notes:       'Single endpoint returns 90 days of all campus events. Acts as the default bucket for events that do not match a more specific sub-calendar (EJ Thomas, Myers School of Art, Cummings Center). Includes lectures, athletics, and general community programs.',
    status:      'active',
  },
  {
    key:         'ejthomas_hall',
    subOf:       'uakron_calendar',
    label:       'E.J. Thomas Performing Arts Hall',
    method:      'REST API',
    methodDetail:'LiveWhale calendar JSON API — group_title substring match',
    venue:       'E.J. Thomas Hall — 198 Hill St',
    notes:       'Sub-source of the UAkron LiveWhale feed. Events are routed here when their group_title matches "EJ Thomas" / "E.J. Thomas" / "performing arts hall". Captures Akron Symphony, touring Broadway, and other major performances.',
    status:      'active',
  },
  {
    key:         'uakron_myers_art',
    subOf:       'uakron_calendar',
    label:       'Myers School of Art',
    method:      'REST API',
    methodDetail:'LiveWhale calendar JSON API — group_title substring match',
    venue:       'Myers School of Art — Folk Hall, 150 E Exchange St',
    notes:       'Sub-source of the UAkron LiveWhale feed. Events are routed here when their group_title matches "Myers School of Art" / "School of Art" / "Myers". Captures BFA thesis exhibitions, gallery openings, and visiting-artist lectures.',
    status:      'active',
  },
  {
    key:         'uakron_chp',
    subOf:       'uakron_calendar',
    label:       'Cummings Center for the History of Psychology',
    method:      'REST API',
    methodDetail:'LiveWhale calendar JSON API — group_title substring match',
    venue:       'Cummings Center — 73 S College St',
    notes:       'Sub-source of the UAkron LiveWhale feed. Events are routed here when their group_title matches "Cummings Center" / "History of Psychology" / "CHP". Museum and archive programming from a Smithsonian-affiliated research center.',
    status:      'active',
  },

  // ── Simpleview CVB REST API ────────────────────────────────────────────
  {
    key:         'visit_akron_cvb',
    method:      'REST API',
    methodDetail:'Simpleview rest_v2 — plugins_events_events_by_date.find (MongoDB-style query DSL)',
    venue:       'Regional events (Akron + Summit County)',
    notes:       "Official convention-and-visitors-bureau events feed for Greater Akron. Auth via a public session token from /plugins/core/get_simple_token/, then queries against /includes/rest_v2/plugins_events_events_by_date/find/ with a MongoDB-style filter (supports $and / $in / $date / $gte / $lte). API quirk: date_range start/end must be at 00:00 in the client's timezone (e.g. 04:00 UTC during EDT). Response shape is { docs: { count, docs: [...] } }. Typical window: ~60 active events per 90 days, ~70% in Akron proper, the rest across Cuyahoga Falls, Bath, Green, Fairlawn, Barberton. Same Simpleview install also fronts the John S. Knight Center page, so JSK events surface here without a separate scraper. Pagination via skip/limit at 200/page; 180-day horizon.",
    status:      'active',
  },

  // ── The Events Calendar (Tribe) REST API ───────────────────────────────
  {
    key:         'summit_artspace',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Summit Artspace — 140 E Market St',
    notes:       'Paginated /wp-json/tribe/events/v1/events endpoint. Includes exhibitions, workshops, and openings.',
    status:      'active',
  },
  {
    key:         'summit_metro_parks',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       '18+ park locations across Summit County',
    notes:       'Tribe Events API returns 180 days, 264+ events. Per-event venue caching creates individual park records (Gorge Metro Park, Cascade Valley, etc.).',
    status:      'active',
  },
  {
    key:         'cvnp_conservancy',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Cuyahoga Valley National Park — multiple trailheads',
    notes:       'Conservancy for CVNP Tribe Events API. Per-event venue caching across park locations. 180-day window.',
    status:      'active',
  },
  {
    key:         'players_guild',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Players Guild Theatre — 1001 Market Ave N, Canton',
    notes:       'Canton-based community theatre. 365-day window since theatre seasons are planned well in advance.',
    status:      'active',
  },
  {
    key:         'missing_falls',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Missing Falls Brewery — 1250 Triplett Blvd',
    notes:       'Same Tribe Events platform as Summit Artspace. This venue hosts fewer events — zero-event runs are normal between active periods.',
    status:      'active',
  },

  {
    key:         'torchbearers',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Various venues across Akron',
    notes:       'Young professionals leadership org. PAUSED: the public feed lists too many members-only internal events (committee meetings, board meetings, general membership meetings) as public, which crowd the calendar with items that are not open to the general public. Disabled in scrape:all until the feed can be filtered down to genuinely public-facing events (socials, volunteer projects, open community events).',
    status:      'paused',
  },
  {
    key:         'indivisible_akron',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Various venues across Akron (Mustard Seed Market, Akron-Summit Library, etc.)',
    notes:       'Local pro-democracy / activism org. Public civic programming — workshops, book and movie clubs, and community meetups (including recurring series). Categorized civic by default; recurring occurrences get a per-date source_id so each instance is its own row.',
    status:      'active',
  },
  {
    key:         'house_three_thirty',
    method:      'REST API',
    methodDetail:"Venue's own VTL calendar API (GET /api/vtl/events)",
    venue:       'House Three Thirty — 532 W Market St',
    notes:       "The LeBron James Family Foundation's community arts/music/event space. Its Vue front end (LeBron's LRMR platform) renders an LrmrEvents component off an unauthenticated JSON feed. This direct scraper is the primary source for HTH's own calendar — it catches the free/community programming (e.g. the recurring \"Akron Knits\" needle-arts meetups) that never goes through Eventbrite. Ticketed shows still arrive in parallel via the citywide Eventbrite geo-feed (eb_house_three_thirty); cross-source dedup reconciles the overlap. The feed exposes only display date/time strings, so we parse them back to Eastern ISO and give recurring occurrences a per-date source_id.",
    status:      'active',
  },

  // ── WordPress APIs ─────────────────────────────────────────────────────
  {
    key:         'jillys_music_room',
    method:      'Hybrid API',
    methodDetail:'EventON AJAX + WP REST API',
    venue:       "Jilly's Music Room — 111 N Main St",
    notes:       "EventON's AJAX endpoint returns 6 months of events with UTC timestamps. WP REST API fills in images and descriptions.",
    status:      'active',
  },
  {
    key:         'akronym_brewing',
    method:      'REST API',
    methodDetail:'WordPress REST API (posts by category)',
    venue:       'Akronym Brewing — 58 E Mill St',
    notes:       'Events are WordPress posts filtered by category. Dates parsed from registered meta fields; falls back to post-published date.',
    status:      'active',
  },
  {
    key:         'akron_library',
    method:      'REST API',
    methodDetail:'Communico / Libnet calendar API',
    venue:       '27+ branch locations across Summit County',
    notes:       'Fetches 180 days of events in one call. ~400+ events per window: programs, classes, story times.',
    status:      'active',
  },
  {
    key:         'cuyahoga_falls_library',
    method:      'Rendered Communico listing',
    methodDetail:'Puppeteer render of the Communico "Anywhere" calendar (events.fallslibrary.org) + DOM parse',
    venue:       'Cuyahoga Falls Library (Taylor Memorial) — 2015 Third St, Cuyahoga Falls',
    notes:       "The Cuyahoga Falls library is a SEPARATE system from the Akron-Summit County Public Library. It runs the same Communico vendor, but this hosted tenant renders events client-side via the `amEvents` widget and exposes no clean public JSON/ICS feed (its internal api.communico.co/v1/fallslibrary/events endpoint is undocumented and param-fragile — returns empty or SQL errors). So we render the listing with Puppeteer across the widget's named ranges (this month + next month) and parse each `.eelist*` event card: title, date/time (year inferred — it isn't shown), location, age group, event type, description, and the /event/{id} detail link. Category comes from the EVENT TYPE controlled vocabulary; is_family from AGE GROUP; price 0. Main-library rooms (Graefe/Chambers/Sutliff) collapse to one venue; external locations (e.g. Silver Lake Village Hall, Lions Park) become their own.",
    status:      'active',
  },

  // ── Squarespace Events Collection ───────────────────────────────────
  {
    key:         'leadership_akron',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'The Duck Club by Firestone at 7 17 Credit Union Park — 300 S Main St',
    notes:       'Uses the shared Squarespace Events Collection module. Monthly "Leadership on Main" speaker series plus other community leadership events. Free admission with complimentary food.',
    status:      'active',
  },
  {
    key:         'artisan_coffee',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'Artisan Coffee — 662 Canton Rd, Akron',
    notes:       'Uses the shared Squarespace Events Collection module. Live music, open mic nights, and author talks at the Ellet-neighborhood coffee shop. Squarespace stores absolute (epoch-ms) timestamps.',
    status:      'active',
  },
  {
    key:         'musica',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'Musica — 51 E Market St, Akron',
    notes:       'Downtown Akron live-music venue that sells through DICE and embeds its widget rather than a native calendar. We pull straight from the DICE partner API (partners-endpoint.dice.fm/api/v2/events, filter[venues][]=Musica) for authoritative show times, prices, and ticket links. Requires DICE_API_KEY.',
    status:      'active',
  },
  {
    key:         'rialto',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'The Rialto Theatre — 1000 Kenmore Blvd',
    notes:       "Kenmore-neighborhood live-music venue run by musicians for musicians. Pulls the /calendar Squarespace collection, strips the trailing date stamp Rialto appends to every title (\"Band Name - 05/27/2026\" → \"Band Name\"), and tags recurring series — Living Room (acoustic), Emerging Sounds (local artists), Irish session, and the spoken-word Angry Cow Poetry night.",
    status:      'active',
  },
  {
    key:         'crown_point_ecology',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'Crown Point Ecology Center — 3220 Ira Rd, Bath Twp.',
    notes:       'Nonprofit 115-acre regenerative farm and nature center. Squarespace events collection covers the Meadow Music summer concert series, Rooted Conversations speaker series, monthly Seasons on the Land nature walks, Rise and Shine youth programs, the Taste of Earth fundraiser, and seasonal fundraisers (e.g. the Dead at Harvest immersive murder mystery in the historic Century Barn). Default venue is the main farm campus; per-event venues only created when Squarespace returns a distinct off-site location.',
    status:      'active',
  },

  // ── iCalendar (ICS) feeds ──────────────────────────────────────────────
  // These sources publish a machine-readable .ics file (RFC 5545). The shared
  // scripts/lib/ics.js parser handles line folding, TZID conversion, and
  // RFC 5545 TEXT escapes. Each per-source scraper is a thin wrapper that
  // supplies the feed URL, default venue, category/tag mapping, and
  // organization metadata.
  {
    key:         'akron_symphony',
    method:      'ICS feed',
    methodDetail:'Native iCalendar subscription (RFC 5545) — auto-discovered from /event/ page',
    venue:       'E.J. Thomas Hall — 198 Hill St (default)',
    notes:       'The Symphony advertises Google / Outlook / iCal subscription on their calendar page. Scraper auto-discovers the feed URL via the page\'s <link rel="alternate" type="text/calendar"> tag; the env var AKRON_SYMPHONY_ICS_URL can override. Handles EST↔EDT boundary correctly via Intl.DateTimeFormat.',
    status:      'active',
  },
  {
    key:         'north_hill_cdc',
    method:      'ICS feed',
    methodDetail:'Native iCalendar subscription — /events page',
    venue:       'North Hill neighborhood — multiple venues',
    notes:       'NHCDC exposes a public ICS export. Covers Maker Mondays, community markets, and neighborhood meetings. Venue is per-event from the VEVENT LOCATION field.',
    status:      'active',
  },
  {
    key:         'akron_public_schools',
    method:      'ICS feed',
    methodDetail:'District calendar iCal export — filtered for public-facing events',
    venue:       'APS buildings across the district',
    notes:       'The district calendar mixes public events (concerts, games, graduation, open houses) with internal dates (PTO meetings, PD days, closures). An inclusion/exclusion keyword filter surfaces only public-facing items before upsert. Filter lists live in scrape-akron-public-schools.js and are tunable as data accumulates.',
    status:      'active',
  },
  {
    key:         'akron_life',
    method:      'REST API',
    methodDetail:"Evvnt Discovery API — direct GET /api/publisher/11072/widget_events (their on-page widget is broken)",
    venue:       'Summit County, Ohio — TIGER/Line polygon point-in-polygon gate',
    notes:       "Akron Life's /events page embeds Evvnt's Discovery widget, but the widget's bootstrap calls a global the current plugin no longer exposes — the calendar div stays empty even in a real browser. Workaround: hit Evvnt's underlying unauthenticated REST endpoint directly and skip the DOM entirely. High-volume / low-fidelity source — Evvnt categories are frequently wrong (artist bios get tagged community/lifestyle) so we run our own inferCategory fallback. The `sources` field is uniformly \"evvnt\" and provides no upstream signal, so cross-source dedup runs against `original_links` URL hostnames + `organiser_name` against a maintained list of every other scraper we own. Geographic gate (2026-06): an event passes if and only if its venue lat/lng falls inside the Summit County, Ohio boundary — point-in-polygon against the US Census TIGER/Line 2025 county polygon (GEOID 39153). Polygon GeoJSON lives at public/summit-county-boundary.geojson, regenerated via `npm run gis:convert-summit`. For coord-less venues we fall back to a town blocklist (Strongsville, Cleveland, Kent, Canton, etc.); with neither coords nor a recognised town we default in (Byron's stated preference for keeping data over dropping unverifiable Summit events). Direct per-venue scrapers (Kent Stage in Portage County, etc.) bypass this gate. Kept active as the canary for discovering new Summit County organisers that start ticketing through Evvnt — slip-through log lines are the discovery queue for the next direct scraper.",
    status:      'active',
  },
  {
    key:         'life_gurukula',
    method:      'ICS feed',
    methodDetail:'The Events Calendar (Tribe) iCalendar export — ?post_type=tribe_events&ical=1&eventDisplay=list',
    venue:       'Life Gurukula — 1230 W Market St',
    notes:       'Vedanta retreat center and residential ashrama on West Market. Routed through the shared runIcsScraper pipeline. The list-view ICS endpoint returns all upcoming events instead of just the current month, so multi-day retreats (Stepping Stones, the youth/adult CHYK retreats) and one-off classes both flow in. Yoga and meditation map to fitness, classes/workshops to education, retreats and pujas to community.',
    status:      'active',
  },

  // ── HTML scrapers ──────────────────────────────────────────────────────
  {
    key:         'akron_art_museum',
    method:      'HTML scrape',
    methodDetail:'Museum Events plugin — /calendar/ page',
    venue:       'Akron Art Museum — 1 S High St',
    notes:       'Custom WordPress plugin with no REST API. Scraper fetches 6 monthly calendar pages and parses .me-event-list-item elements. Detail pages fetched for pricing.',
    status:      'active',
  },
  {
    key:         'akron_civic',
    method:      'HTML scrape',
    methodDetail:'Official akroncivic.com (Bolt CMS) — /view-all-shows listing, then per-show detail pages',
    venue:       'Akron Civic Theatre, PNC Plaza at The Civic, The Knight Stage, Wild Oscar\'s — 182 S Main St',
    notes:       "Reads the Civic's OFFICIAL site, akroncivic.com. We list every show from /view-all-shows (each detail link is a slug ending in -YYYY-MM-DD) and parse each detail page for title, date/time + venue (two <h6> lines), the poster image (an upsized /thumbs/{dims}/shows/… rendition), and the formatted description (kept as text with paragraph + line breaks). Each Civic stage is its own venue record — the main theatre, the outdoor PNC Plaza at The Civic (home of the free \"Party on the Plaza\" concerts), The Knight Stage, and Wild Oscar's. 2026-06 rewrite: previously read theatreakron.com, which turned out to be a third-party ticket RESALE aggregator (TicketSqueeze) — it only listed big ticketed shows (so free community events never ingested) and linked patrons to resale tickets. The official site fixes coverage, images, formatting, and ticket links. Price is left null unless the page states free admission.",
    status:      'active',
  },
  {
    key:         'akron_zoo',
    method:      'HTML scrape',
    methodDetail:'Drupal (Views + Slick carousel) — /events page',
    venue:       'Akron Zoo — 500 Edgewood Ave',
    notes:       'Drupal Views renders event cards in a Slick carousel. Scraper tries 4 CSS selector patterns before falling back to text-line parsing. Zero-event runs produce a diagnostic warning.',
    status:      'active',
  },
  {
    key:         'downtown_akron',
    method:      'HTML scrape',
    methodDetail:'CityInsight CMS (ctycms.com) — /calendar',
    venue:       'Downtown Akron district — 49 blocks, multiple venues',
    notes:       'Fetches current month + 2 ahead via ?month=YYYY-MM params. Extracts venue name from the "time / venue" line in each card. Surfaces events not listed elsewhere (The Nightlight Cinema, The Green Dragon Inn).',
    status:      'active',
  },
  {
    key:         'weathervane',
    method:      'HTML scrape',
    methodDetail:'Drupal 11 — /upcoming-shows season listing',
    venue:       'Weathervane Playhouse — 1301 Weathervane Lane',
    notes:       'Static season lineup page. Handles 5 date formats (ranges, single dates, cross-month ranges, named-day dates). Skips past shows and season header rows.',
    status:      'active',
  },
  {
    key:         'ohio_shakespeare',
    method:      'HTML scrape',
    methodDetail:'Squarespace — homepage + individual show pages',
    venue:       'Greystone Hall / Stan Hywet Hall & Gardens',
    notes:       'Fetches homepage to discover show slugs, then each production page with 1s rate-limiting. Uses og:image/og:title meta. Venue detected from page content (Greystone Hall vs. Stan Hywet).',
    status:      'active',
  },
  {
    key:         'painting_twist',
    method:      'HTML scrape',
    methodDetail:'Custom ASP.NET MVC — /studio/akron-fairlawn/calendar/',
    venue:       'Painting with a Twist Fairlawn — 2955 W Market St',
    notes:       'Finds /event/{id}/ links and extracts date/price/title from surrounding container HTML. Parses "Sun, Mar 22, 6:30 pm" format dates and "$34–$44" price ranges.',
    status:      'active',
  },
  {
    key:         'blu_jazz',
    method:      'HTML scrape',
    methodDetail:'TurnTable Tickets show-list page',
    venue:       'BLU Jazz+ — 47 E Market St',
    notes:       'Server-rendered page lists ~4–6 weeks of upcoming shows. Dates parsed from card id attributes; times/prices from description text.',
    status:      'active',
  },
  {
    key:         'akron_childrens_museum',
    method:      'HTML scrape',
    methodDetail:'Drupal 8 Views — /calendar listing pages',
    venue:       "Akron Children's Museum — 216 S Main St",
    notes:       'Scrapes three Drupal Views listing pages (/calendar, /calendar/special-events, /calendar/programs). Parses .views-field elements for title, dates, times, cost, and description. Handles recurring events ("Every Thursday") by computing next occurrence.',
    status:      'active',
  },
  {
    key:         'nightlight_cinema',
    method:      'HTML scrape',
    methodDetail:'INDY Cinema Vue/Quasar SPA — degraded until a browser renderer is added',
    venue:       'The Nightlight — 30 N High St',
    notes:       'The Nightlight runs on INDY Cinema Group\'s Vue SPA. Raw HTTP fetches return only an empty shell — showtimes are injected client-side after Apollo GraphQL calls. The scraper\'s parser is ready for hydrated DOM but needs either Playwright rendering, INDY partner API access, or a reverse-engineered session token on the /graphql endpoint. Monitoring active.',
    status:      'degraded',
  },
  {
    key:         'akron_urban_league',
    method:      'HTML scrape',
    methodDetail:'WordPress (custom AUL theme) — /home/events/ listing + detail pages',
    venue:       'Akron Urban League — multiple program sites',
    notes:       'Server-rendered WordPress site with no REST or Tribe Events feed exposed. Scraper enumerates event URLs from the /home/events/ listing (and the /events-archive/ pattern), then fetches each detail page and parses og:* meta tags plus body copy for date ("January 19, 2026"), time, venue, description, and registration link. article:published_time is the WP post date, not the event date, so it is explicitly ignored. Typical run yields ~5–15 active community-impact events at a time.',
    status:      'active',
  },
  {
    key:         'stan_hywet',
    method:      'HTML scrape',
    methodDetail:'Drupal — /public-events listing',
    venue:       'Stan Hywet Hall & Gardens — 714 N Portage Path',
    notes:       "Historic estate with a heavy public-events calendar in season (April–December): Ohio Mart, Father's Day Car Show, Murder Mystery weekends, Mother's Day brunches, Forest Therapy walks, Coffee with the Curator. Own ticketing through stanhywet.ticketapp.org rather than Eventbrite or Ticketmaster, so the geo-aggregators miss it entirely. Parses .event-item cards (h2.a + p.date + thumbnail) with a tolerant date parser that handles full dates, ranges, and 'Sundays through MM/DD/YY' recurring strings; events with unparseable dates are skipped rather than guessed. Drupal image-style prefixes are stripped so we store the full-resolution image.",
    status:      'active',
  },

  {
    key:         'akron_rec_parks',
    method:      'HTML scrape',
    methodDetail:'RecDesk — Puppeteer-rendered POST /Community/Program/FilterPrograms',
    venue:       'Akron Recreation & Parks community centers citywide',
    notes:       'City of Akron Recreation & Parks manages programs through RecDesk SaaS. The /Community/Program listing is an AJAX table rendered by a POST to FilterPrograms; Puppeteer loads the page, sets ResultsPerPage=100, paginates as needed, and extracts title, programId, date range, days of week, and age requirements. Each program becomes one event row (start_at = program start at 9 AM ET, end_at = program end date at 5 PM ET). Covers summer camps, art classes, gymnastics, dance, STEM, adult programming, and aquatics across all city community centers. Programs already ended or more than 365 days out are skipped. Description fetch from individual detail pages is deferred to a future pass.',
    status:      'active',
  },

  {
    key:         'city_of_akron_lock3',
    method:      'REST API',
    methodDetail:'Revize Calendar JSON feed — calendar_data_handler.php',
    venue:       'Lock 3, downtown Akron parks, and Recreation & Parks venues',
    notes:       "The City of Akron runs on Revize CMS and exposes its public-facing events as a JSON feed at /_assets_/plugins/revizeCalendar/calendar_data_handler.php (the same endpoint the on-page FullCalendar widget consumes). The feed covers seven city-managed calendars; we ingest the four that publish event-shaped content: Events (1), Parks & Rec (5), Lock 3 (6), and Great Streets Akron (13), explicitly skipping Meetings (2), Police Oversight (7), and HR (9). Each record carries title, start/end (Eastern-local ISO without zone — converted via lib/normalize.js#easternToIso), URL, location, an HTML image tag, and an iCal-style rrule for recurring series. Placeholder thumbnails and noimage assets are dropped at parse time. Captures the Summer Concert Series, Lock 4 Blues, Gospel Sundays, and city-promoted partner festivals (Pizza Fest, Italian-American Fest, African Culture Fest, Rubber City Remix) that don't reliably surface on Eventbrite or Ticketmaster. History note: this feed went dormant July 2024 → May 2026 and the scraper temporarily ran on Claude-extracted editorial pages; when the feed came back online we retired the LLM path. The recovery branch is preserved in git history if it's ever needed again.",
    status:      'active',
  },
  {
    key:         'killbox_comedy',
    method:      'HTML scrape',
    methodDetail:'Seat Engine — Puppeteer-rendered /events listing + per-show detail pages',
    venue:       'The KillBox Comedy Club — 1305 E Tallmadge Ave',
    notes:       "Akron's dedicated stand-up venue. thekillboxcomedyclub.com runs on Seat Engine, which client-hydrates the /events listing as React components — direct fetch returns an empty shell, so we render with Puppeteer, harvest /events/<slug> anchors, then render each detail page to extract title, full description, banner image, price (or range), and one or more showtimes broken out as \"Weekday • Mon DD H:MM AM/PM\" blocks. Each showtime becomes its own DB row (Friday/Saturday weekend headliner runs fan out into 2–5 events). Year is inferred — Seat Engine omits the year on detail pages, so we anchor to today and roll forward if the candidate date is more than a week past. Default age_restriction is 21+ to match the venue policy.",
    status:      'active',
  },
  {
    key:         'hale_farm',
    method:      'HTML scrape',
    methodDetail:'WRHS Lucy CMS — /do-see/events/{YYYY}/{MM} calendar pages + per-event detail pages',
    venue:       'Hale Farm & Village — 2686 Oak Hill Rd, Bath Township',
    notes:       "90-acre living-history museum operated by the Western Reserve Historical Society. Migrated off Akron Life in 2026-06 — Hale Farm was the single highest-volume organiser in the Evvnt feed (~32 events / 30 days) and direct ingestion lets us drop those rows via COVERED_BY_DIRECT_SCRAPER. WRHS runs a server-rendered Lucy CMS calendar at /do-see/events/YYYY/MM that emits an HTML table of <td> event cells; we walk 6 months forward, filter on the `.location` text to keep only \"Hale Farm & Village\" (skipping Cleveland History Center and Crawford Auto Aviation Museum — both 30+ mi outside our 25-mi Akron radius), then fetch each detail page. og:title carries title + day + time-range in a tidy three-segment string, the date is parseable from the URL slug, og:image is the banner, and the body content yields the bio paragraphs + price.",
    status:      'active',
  },
  {
    key:         'kent_stage',
    method:      'HTML scrape',
    methodDetail:'Schema.org Event JSON-LD on each /event/<slug>/ detail page',
    venue:       'The Kent Stage — 175 E Main St, Kent (~13 mi NE of Akron)',
    notes:       "Independent 600-seat concert venue in Kent, ~13 mi inside our 25-mile Akron radius. Books touring folk, country, blues, Americana, indie, and comedy. Migrated off Akron Life in 2026-06 as priority #2 in the dwindle plan — Evvnt only surfaced ~4 of their shows but the venue books many more per quarter. kentstage.org is WordPress + Elementor with no Tribe REST API or ICS export, but every /event/<slug>/the-kent-stage/kent-ohio/ detail page emits a clean Schema.org Event JSON-LD block carrying name (HTML-entity-encoded), startDate with TZ offset, location, offers (price + etix.com ticket URL), image, and description. The scraper fetches /events/, harvests all event permalinks (skipping the perpetual gift-card permalink), then parses the JSON-LD on each detail. Kent Stage emits price:0 on paid shows; when the offer URL points at a real ticketing host (etix, ticketweb, seatengine) we treat 0 as \"unknown\" and fall back to a body \"$N\" sniff so paid concerts don't land as free.",
    status:      'active',
  },
  {
    key:         'cvart',
    method:      'HTML scrape',
    methodDetail:'WordPress (AIOSEO) — /events/ index + per-event detail pages, regex over body text',
    venue:       'Cuyahoga Valley Art Center — 2131 Front St, Cuyahoga Falls',
    notes:       'Community art center and gallery in downtown Cuyahoga Falls (~7 mi N of Akron). Migrated off Akron Life in 2026-06 as priority #3 in the dwindle plan. cvart.org runs WordPress with the AIOSEO plugin but no Tribe Events plugin and no Schema.org Event JSON-LD — the scraper walks /events/, drops the `call-` slug family (those are artist submission deadlines, not consumer events), and on each Artist Reception page parses two structured "Day, Month DD, YYYY @ H:MM am/pm" lines for start/end. The "ON DISPLAY:" / "ON VIEW:" exhibit window is captured separately and prepended to the description so attendees see the full run, not just reception night. Detail pages reuse the org logo as og:image so we leave image_url null.',
    status:      'active',
  },
  {
    key:         'cascade_locks',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'Cascade Locks Park Association — 57 W North St (HQ); programming along the canal corridor',
    notes:       "Nonprofit stewarding the historic Ohio & Erie Canal locks and Cascade Valley greenway just north of downtown Akron. Programs the Beech Street Trailhead (Lock 10), Ferndale Street trailhead, and seasonal canal-corridor events. Migrated off Akron Life in 2026-06. Uses the same Squarespace events-collection JSON pattern as Leadership Akron, Rialto, and Crown Point Ecology via lib/squarespace.js. Per-event venue routing falls back to HQ when Squarespace's location field is empty (typical for Free Lunch Friday and towpath walks where the address is given in body text rather than the structured location object).",
    status:      'active',
  },
  {
    key:         'akron_marathon',
    method:      'HTML scrape',
    methodDetail:'/future-race-dates/ on akronmarathon.org — text-date scrape, paired with hard-coded race-series metadata',
    venue:       'Downtown Akron course — Akron Marathon Charitable Corporation HQ at 155 E Voris St',
    notes:       "Three race weekends per year — Akron 8K & 1M (June), Half Marathon & 10K (August), full Marathon with relay (September). akronmarathon.org is WordPress + Divi with no Tribe API, no JSON-LD, and no event detail pages — the canonical schedule is the static /future-race-dates/ page. The scraper extracts every Month DD, YYYY string in document order, buckets them by year (always exactly three per year), and pairs each year's [first, second, third] dates with the [8K, Half, Marathon] race-series metadata (title, description, tags, /race-series/ ticket URL). Migrated off Akron Life in 2026-06 — Evvnt was tagging races as community rather than fitness. Default 7:00 AM Eastern start; categorised fitness.",
    status:      'active',
  },
  {
    key:         'akron_promise',
    method:      'HTML scrape',
    methodDetail:'City Series page on akronpromise.org/cityseries (Drupal 10) — parses each div.item race card',
    venue:       'Various Akron neighborhoods (no per-race venue listed)',
    notes:       "Akron Promise is an education nonprofit (scholarships + student support); its public events are the City Series — a season of neighborhood 5K/run-walk races that support community organizations. The /events page is just a Google Form, so we scrape the City Series landing page (/cityseries, Drupal 10, server-rendered). Each \"Upcoming Races\" card carries a logo image, an <h3> title, a div.date (M/D/YY H:MM), free-text detail lines (Dog Friendly / Finisher Medal / Kids Run), and a RunSignup \"Register Now\" link. Each RunSignup race is then enriched via RunSignup's public REST API (page → race_id → /rest/race/{id}): we pull the full race description, the start address, and the logo. RunSignup's address.street is freeform — a real place name (e.g. \"Kohl Family YMCA\") becomes a named venue, while a bare street address is handed to ensureVenue's guard (links to an existing venue at that address or skips, so no junk address-named venues). Price left null (races are ticketed; APS students free, public pays). Categorised fitness.",
    status:      'active',
  },
  {
    key:         'get_away_with_murder',
    method:      'HTML scrape',
    methodDetail:'Schema.org Event JSON-LD on the 330tix.com/organizations/get-away-with-murder-killer-parties listing',
    venue:       'Get Away With Murder Theatre — 1653 Merriman Rd, Akron',
    notes:       "Akron immersive-theatre company (murder-mystery parties, acting/audition workshops). Final scraper in the 2026-06 Akron Life dwindle plan. Their marketing site is a Weebly page, but every ticketed event lives on a 330tix.com organisation listing — that page emits clean Schema.org Event JSON-LD with name, description, location, start/end with TZ offset, offers, and ticket URL. We hit the org page directly rather than scraping 330tix at large (which would mostly duplicate Hale Farm). About 5–6 events per month: a mix of immersive theatre runs and acting/audition workshops, categorised art vs. education based on title keywords.",
    status:      'active',
  },
  {
    key:         'city_of_green',
    method:      'ICS feed',
    methodDetail:'CivicPlus iCalendar — /common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar',
    venue:       'Boettler Park (default) + Central Park / other Green Parks & Rec venues — Green, OH',
    notes:       "Summit County's City of Green runs an active year-round Parks & Recreation programming calendar — FreedomFest (Boettler Park, July), the Summer Concert Series, Movie in the Park, art-A-palooza, Trick-or-Treat Trail, Christmas at Central Park, Twisted WilderFest, Memorial Day and Veterans Day ceremonies, Senior Expo, plus seasonal community events. cityofgreen.org runs on CivicPlus (CivicEngage), which exposes the master calendar as a standards-compliant RFC 5545 iCalendar feed (catID=14 == \"City of Green Main Calendar\"). The 213-entry feed mixes public events with City Council and Committee meetings plus federal holiday observances; an EXCLUDE filter drops the administrative summaries (\"Committee Meeting\", \"City Council Meeting\", \"Christmas Day\", \"Veterans Day\" the holiday vs \"Veterans Day Ceremony\" the public event) and \"...Canceled for Summer Recess\" markers, leaving the public-facing events to flow through. The filter is exclude-based rather than allowlist so new specials added by the city next year flow in without a code change.",
    status:      'active',
  },

  // ── CivicPlus Summit County cities ─────────────────────────────────────
  {
    key:         'city_of_stow',
    method:      'ICS feed',
    methodDetail:'CivicPlus iCalendar — Main Calendar (catID=14)',
    venue:       'Stow City Hall (default) + The AMP, Silver Springs Park, citywide — Stow, OH',
    notes:       'Stow keeps its public programming on the Main Calendar alongside board and commission meetings, so we ingest catID=14 and let the shared CivicPlus admin/meeting filter drop the governance rows. Surfaces the Fourth of July Parade, Firecracker Run, Joshua Stow Festival, The AMP pop-up series, City-Wide Trick-or-Treat, and seasonal Parks & Rec events. Per-event venue from the VEVENT LOCATION field.',
    status:      'active',
  },
  {
    key:         'city_of_hudson',
    method:      'ICS feed',
    methodDetail:'CivicPlus iCalendar — Community Events Calendar (catID=14)',
    venue:       'Hudson Green (default) + First & Main, Barlow Center — Hudson, OH',
    notes:       "Hudson's Community Events Calendar is rich and public-facing: the Hudson Farmers Market, Hudson Bandstand and Summer Music Nights concert series, Screen on the Green movie nights, Art on the Green, the Landsberg Biergarten, and seasonal festivals. A few city meetings on the same calendar are dropped by the shared CivicPlus filter.",
    status:      'active',
  },
  {
    key:         'city_of_tallmadge',
    method:      'ICS feed',
    methodDetail:'CivicPlus iCalendar — Recreation Department Programs (23) + Recreation Events (25) + Main Calendar (14)',
    venue:       'Tallmadge Circle Park (default) + Recreation Center — Tallmadge, OH',
    notes:       'Tallmadge splits content across many category calendars; the public events live on Recreation Department Programs (catID=23) and Recreation Events (catID=25), with the Main Calendar (catID=14) carrying the occasional citywide special. We ingest all three and dedupe by UID. Surfaces the Music on the Circle concert series at Tallmadge Circle Park, Touch a Truck, the Bocce Ball Tournament, and Recreation camps/lessons. The catID map is documented in /iCalendar.aspx; board and commission meetings are dropped by the shared filter.',
    status:      'active',
  },
  {
    key:         'city_of_new_franklin',
    method:      'ICS feed',
    methodDetail:'CivicPlus iCalendar — Community Events/Sports (23) + Main Calendar (14)',
    venue:       'Tudor House Civic Center — New Franklin, OH',
    notes:       'New Franklin clusters its public programming around the Tudor House Civic Center on Nimisila Reservoir: the Music by the Lake summer concert series, Movies by the Lake, the Old Fashioned 4th of July, Lakeside Oktoberfest, and the Tudor House Christmas Open House. We ingest catID 23 (Community Events/Sports) and 14 (Main Calendar) and dedupe by UID; City Council and board meetings are dropped by the shared filter.',
    status:      'active',
  },
  {
    key:         'city_of_fairlawn',
    method:      'ICS feed',
    methodDetail:'CivicPlus iCalendar — Parks and Recreation Calendar (15) + Main Calendar (14)',
    venue:       'Fairlawn Kiwanis Community Center — Fairlawn, OH',
    notes:       "Fairlawn's Main Calendar (catID=14) is almost entirely Council and Civil Service meetings, so the public programming comes from the Parks and Recreation Calendar (catID=15) — the Fairlawn Fest, community bingo at the Kiwanis Community Center, and seasonal Parks & Rec events. We ingest both and the shared filter drops the governance rows. This is a thinner source than the other Summit County cities; zero-event runs between active programming windows are normal.",
    status:      'active',
  },
  {
    key:         'city_of_cuyahoga_falls',
    method:      'HTML scrape',
    methodDetail:'Drupal 10 calendar grid (/calendar/YYYYMM) + per-event detail pages',
    venue:       'Downtown Cuyahoga Falls (default) + Falls River Square, Quirk Center — Cuyahoga Falls, OH',
    notes:       'Cuyahoga Falls (Summit County\'s second-largest city) runs Drupal 10 with no iCalendar feed. The monthly calendar grid is the reliable date source because Drupal materialises each occurrence of a recurring series into its own dated day cell. We walk the grid for the current month + 2 ahead, attach every /events/{slug} link to its day, restrict to the page\'s own month to avoid adjacent-month double-counting, drop "Government Event" rows (City Council, Planning Commission, Board of Zoning Appeal, …) with a meeting filter, then fetch each unique event node once for its title, og:description, og:image, and a best-effort start time parsed from the detail prose. Surfaces Falls Downtown Fridays, Front Street Live, the Riverfront Cruise In, Picnic In The Park, the Community Band and Keyser concert series, and Flix on the Falls.',
    status:      'active',
  },
  {
    key:         'akron_community_foundation',
    method:      'HTML scrape',
    methodDetail:'Custom WordPress (acf-custom-theme) — /news-and-events/acf-events/ event blocks',
    venue:       'Various — House Three Thirty, Crown Point Ecology Center, ACF (345 W Cedar St), etc.',
    notes:       "Greater Akron's community foundation. The events page is a custom WordPress theme that renders each event as a server-side HTML block (h2.event-title + .event-start-date / .event-start-time / .event-location / .event-fund-affiliation / .event-website / .event-description) — no Tribe REST API and no ICS feed, so we parse the markup directly off those stable class names. Events: the ACF Annual Meeting, the Polsky Award, fund-anniversary celebrations, and affiliate-fund annual meetings (Bath Community Fund, Black Giving Collective, Gay Community Endowment Fund, Women's Endowment Fund, …). Most carry an Eventbrite registration link, used as the stable source id; organizer is attributed to Akron Community Foundation with the specific fund carried as a tag.",
    status:      'active',
  },

  // ── Neighborhood CDCs / associations ───────────────────────────────────
  {
    key:         'the_well_cdc',
    method:      'HTML scrape',
    methodDetail:'Divi page builder (WordPress) — /events/ blurb modules',
    venue:       'The East End, Mason Park CLC, 647 E Market St — Middlebury, Akron',
    notes:       "Akron's place-based community development corporation for the Middlebury neighborhood. The events page is built with Divi; each event is an et_pb_blurb module with an h4 title and a description block whose first two <strong> runs are the date/time line (\"JUNE 4, 2026 | 5:30PM\") and the venue/address (\"THE EAST END – 1200 E MARKET ST\"). We parse those off the stable Divi classes and infer category from the title. Surfaces the Taste of Middlebury fundraiser, Akron Hope's Juneteenth celebration and Wrapping Night, Middlebury Fall Fest, and Coffee & Career Development sessions. Venues sit in Middlebury, so the neighborhood resolver tags them automatically.",
    status:      'active',
  },
  {
    key:         'better_kenmore',
    method:      'HTML scrape',
    methodDetail:'WordPress Events Manager — /upcoming-events/ list for permalinks + dates, then per-event detail-page Open Graph tags',
    venue:       'Kenmore Boulevard district + Kenmore Senior Community Center — Kenmore, Akron',
    notes:       "Community development corporation for Akron's Kenmore neighborhood and the historic Kenmore Boulevard business district. The site runs the Events Manager plugin. Its /upcoming-events/ list carries each event's .em-event-date, .em-event-time, .em-event-location, and a /events/{slug} permalink — but the only per-item link text it exposes is a \"More Info\" button, and the list has no description. So we use the list purely to harvest the permalink + date/time, then fetch each event's detail page and read its og:title / og:description / og:image for the real title, full copy, and hero image. source_id is the permalink's final path segment (stable + unique; recurring occurrences carry the date in the slug). Surfaces the BLVD Block Party, Kenmore First Friday Festival, the Rialto Living Room concert series, and recurring Kenmore Senior Community Center programming (Chair Yoga, Popcorn & Movie Fridays).",
    status:      'active',
  },
  {
    key:         'hiho_brewing',
    method:      'JSON endpoint',
    methodDetail:'Squarespace Events collection (taproom-events?format=json&view=upcoming) via lib/squarespace.js',
    venue:       'HiHO Brewing Co. — 1707 Front St, Cuyahoga Falls',
    notes:       'Small craft brewery and taproom in downtown Cuyahoga Falls. Hosts trivia, live music, and all-day music days ("Shakedown Street"). Squarespace native Events collection, so it reuses the same parser as Artisan Coffee and Rialto. Price left null (never assume free).',
    status:      'active',
  },
  {
    key:         'akron_makerspace',
    method:      'HTML scrape',
    methodDetail:'WordPress "Simple Calendar" list on the homepage — parses li.simcal-event (data-start epoch + title/end-time/address/description)',
    venue:       'Akron Makerspace — 540 S Main St, downtown Akron',
    notes:       'Volunteer-run 501(c)(3) makerspace in downtown Akron (Canal Place). Hosts classes and maker/community events. The Simple Calendar plugin (Google-Calendar backed) has no REST API, so we parse the server-rendered event list using each event\'s data-start epoch. We keep public programming and drop members-only/internal items (Weekly Open Workshop Hours, board meetings, Make-Your-Makerspace work nights) and any "around town" events the shared calendar lists at other venues. Price left null (never assume free).',
    status:      'active',
  },
  {
    key:         'akron_soul_train',
    method:      'HTML scrape',
    methodDetail:'Wix Events — parses the #wix-warmup-data JSON blob on /events (scheduling.config start/end, location, slug)',
    venue:       'Akron Soul Train gallery (191 S Main, downtown Akron) + per-event locations',
    notes:       'Small downtown Akron artist-residency gallery running free/donation-based art programs: live demos, exhibitions, performances. Wix Events with no JSON-LD, so we parse the server-rendered #wix-warmup-data blob (robust vs Wix\'s hashed CSS classes). Each event carries its own location, which may be the gallery or a partner venue (e.g. the Myers School of Art). Price left null (never assume free — even "free or donation-based" isn\'t a guarantee per program).',
    status:      'active',
  },
  {
    key:         'southgate_farm',
    method:      'HTML scrape',
    methodDetail:'Wix Events — parses the #wix-warmup-data JSON blob on /events (scheduling.config start/end, location, slug), shared lib/wix-events.js',
    venue:       'Southgate Farm — 6521 Mt Pleasant St NW, North Canton (Stark County)',
    notes:       'Organic farm/CSA in North Canton hosting public classes in its historic barn: weekly summer farm yoga, full-moon yoga + bonfires, farm/garden tours, and craft make-and-takes. Wix Events with no JSON-LD, so we parse the server-rendered #wix-warmup-data blob (robust vs Wix\'s hashed CSS classes). All events are at the one farm address; Wix lists some as "Southgate Farm" and some as "Southgate Farm Barn", so we pin everything to a single canonical venue to avoid a duplicate record. Just outside the Summit County core (like our Players Guild / Centennial Plaza Canton sources) but a direct first-party venue scraper, so it isn\'t Summit-gated. Price left null (never assume free — classes are ticketed/RSVP).',
    status:      'active',
  },
  {
    key:         'meetup',
    method:      'iCal feed',
    methodDetail:'Per-group Meetup iCal feeds (meetup.com/<group>/events/ical/) parsed via lib/ics.js — no API/Pro, no HTML scraping',
    venue:       'Curated Akron/Summit-area Meetup groups',
    notes:       "Meetup's open REST API was retired and the current GraphQL API requires a paid Pro account; the site itself is a client-rendered SPA behind bot protection, so we never scrape its HTML. Instead we consume the sanctioned per-group iCal feed Meetup publishes for calendar apps — free, no auth, and in a format lib/ics.js already parses. Coverage is a curated KNOWN_GROUPS list (no global Akron feed exists); add a group by appending its slug. Every event is routed through the shared Summit County locality gate (lib/summit-county.js): Meetup events are routinely 'Location TBD' or online, which have no resolvable in-county location and are therefore NOT posted — they're picked up automatically once the organizer announces an in-person Summit County location. Price is left null (never assume free); events link back to the Meetup page.",
    status:      'active',
  },
  {
    key:         'first_glance',
    method:      'HTML scrape',
    methodDetail:'WordPress — /programs/ index for program permalinks, then each /program/ page\'s og tags + weekly schedule line',
    venue:       'First Glance Student Center — 943 Kenmore Blvd, Kenmore, Akron',
    notes:       "Youth/student center in Akron's Kenmore neighborhood. There is no events-calendar plugin; instead each recurring program (Rec Night, The Connect, Soul Sisters, Hip Hop Night, etc.) is a /program/{slug} page carrying a fixed weekly schedule line (\"Thursdays 7:00-9:00pm\"), an og:description, and an og:image. We harvest the program links from /programs/, parse the day-of-week + time range from each page, and expand it into individual dated occurrences for a rolling 8-week horizon — reflecting First Glance's own published schedule and linking back to their page. Programs with no parseable schedule line are skipped. Price is left null (the pages state none). Replaces the indirect path through the Better Kenmore aggregator for this venue.",
    status:      'active',
  },
  {
    key:         'full_grip_games',
    method:      'iCal feed',
    methodDetail:'Public Google Calendar iCal feed, with RRULE recurrence expansion',
    venue:       'Full Grip Games — 121 E Market St, downtown Akron',
    notes:       "A small downtown Akron tabletop and trading-card game store. Its programming is exactly the grassroots local calendar Akron Pulse exists to surface: weekly Magic: The Gathering and Pokémon nights, Commander, Friday Night Magic, drafts, and league play. The store publishes a public Google Calendar, which exposes a standard iCal feed. Google encodes the regular weekly/monthly schedule as recurring masters (RRULE) rather than one event per night, so we ingest it through the shared ICS pipeline with recurrence expansion turned on, materialising each occurrence into a concrete dated event over a rolling 120-day window. The feed also carries the store's full event history, so past events are dropped. Category is forced to 'games'; price is left null (entry fees vary and aren't in the feed).",
    status:      'active',
  },
  {
    key:         'mustard_seed',
    method:      'Rendered calendar + WP REST',
    methodDetail:'EventON (WordPress) — Puppeteer renders the calendar for dates, WP REST ajde_events?include= for metadata',
    venue:       'Mustard Seed Market & Café — Highland Square (867 W Market St) & Montrose (3885 W Market St)',
    notes:       "A beloved Akron natural-foods grocer and café whose Highland Square location has a stage hosting regular live music, plus in-store tastings, classes, and lectures. The site runs EventON 5, which renders its calendar client-side via Handlebars: the event dates are not in the server HTML and the EventON REST action needs the calendar's internal config, so a plain fetch can't see them. We render the calendar with Puppeteer to read each event's start/end (the .eventon_list_event blocks carry data-time=\"<startUnix>-<endUnix>\"), paging forward a few months, then enrich every event with its title, permalink, category, venue, and image from the clean WP REST endpoint (/wp-json/wp/v2/ajde_events?include=<ids>), joined on event id. EventON's event_location- class disambiguates the Highland Square café from the Montrose store; event_type- supplies a category hint where it maps cleanly, otherwise title inference decides. Price is left null (the feed carries none).",
    status:      'active',
  },
  {
    key:         'release_yoga',
    method:      'MINDBODY enrollments (HTML)',
    methodDetail:'Shopify app-proxy server-rendered MINDBODY widget — /apps/mindbody/enrollments',
    venue:       'Release Yoga — 880 E Turkeyfoot Lake Rd, Green',
    notes:       "A yoga & wellness studio in Green (southern Summit County). We ingest only its MINDBODY enrollments page — workshops, retreats, teacher trainings, sound baths, special events — and deliberately skip the daily drop-in class grid, which would flood the calendar with recurring classes. MINDBODY is surfaced via a Shopify app proxy that server-renders the list as HTML, so we fetch and parse it directly: each .enrollment_box yields title + price (.not_entire), instructor (.mb_le_staff_*), a date/time line (.bold_date), description, and image. The page exposes no per-event location, so events pin to the single studio venue. Category is left to text inference (yoga → fitness, workshops → learning) with a 'fitness' default; price comes from the '$NN' in the title, null when absent.",
    status:      'active',
  },
  {
    key:         'royal_palace',
    method:      'Tribe REST API',
    methodDetail:'WordPress + The Events Calendar — /wp-json/tribe/events/v1/events',
    venue:       'Royal Palace Akron — 134 E Tallmadge Ave, North Hill',
    notes:       "A North Hill banquet hall, bar, and lounge that hosts a steady run of public live shows — Latin bailazos and banda concerts, Nepali music nights, and cultural celebrations (its private wedding/party rentals never reach the public calendar). The site runs The Events Calendar, so we read the standard Tribe REST feed, the same shape as the Indivisible Akron and Summit Artspace scrapers. Single venue, pinned to the canonical North Hill record; price from the Tribe cost field, null when unstated. The venue also promotes shows on Eventbrite (which we already ingest), so overlaps are left to the shared cross-source dedupe rather than suppressing either source — unlike First Glance, the venue's own calendar isn't reliably ahead of the aggregator.",
    status:      'active',
  },
  {
    key:         'highland_square_theatre',
    method:      'HTML scrape',
    methodDetail:'WordPress (server-rendered) — homepage showtime listing',
    venue:       'Highland Square Theatre — 826 W. Market St',
    notes:       "Independent neighborhood cinema dating to 1938. The homepage is a plain WordPress HTML page listing currently-playing films as quoted-title blocks (title, MPAA rating, runtime, showtime schedule). All times are PM per the site footer. The scraper fetches the homepage, decodes &ldquo;/&rdquo; entities, and parses each film's showtime schedule: single-day entries (\"Monday June 8: 4:15, 7:00\"), packed multi-day lines (multiple day-segments separated by whitespace), and date ranges (\"Mon thru Wed, June 15-17: 7:00\"). Each showtime becomes its own event row at $5 admission. source_id is keyed on film title slug + ISO start timestamp.",
    status:      'active',
  },
  {
    key:         'highland_square',
    method:      'HTML scrape',
    methodDetail:'Wix (server-rendered date/meta) — homepage festival promo',
    venue:       'Highland Square neighborhood district — West Akron',
    notes:       "The Highland Square Neighborhood Association runs essentially one marquee public event a year: PorchROKR, the porch-music-and-arts festival on the third Saturday of August. The site is Wix, which is normally client-rendered, but it server-side renders the festival date heading (\"AUGUST 15, 2026\") plus og:description and og:image into the initial HTML, so a plain fetch sees them. We extract that single dated festival (porch sets ~11 a.m.–7 p.m., headliner to ~9 p.m.) rather than a recurring list, so we hold the canonical PorchROKR date from HSNA rather than depending on Eventbrite. The Highland Square Film Festival lives on a separate page when active and isn't yet ingested.",
    status:      'active',
  },

  // ── Aggregators ────────────────────────────────────────────────────────
  {
    key:         'eventbrite',
    method:      'HTML scrape',
    methodDetail:'window.__SERVER_DATA__ + internal POST API — Akron geo-feed',
    venue:       'Regional events (Akron / Summit County)',
    notes:       'Public API deprecated in 2020. Scraper fetches the Akron search page, extracts event buckets from window.__SERVER_DATA__, and paginates via the internal /api/v3/destination/search/ POST endpoint using session cookies for auth. Catches the long tail of community events through one citywide geo-feed rather than per-organizer scrapes. Since 2026-06 every event also passes a local Summit County gate (TIGER/Line point-in-polygon when the venue has coordinates, county city allow-list otherwise) plus a run-volume anomaly guard, after an Eventbrite search redesign briefly flooded the feed with region-wide events.',
    status:      'active',
  },

  // ── Aggregator-routed organizations ────────────────────────────────────
  // These orgs/venues don't have a dedicated scraper — they ride on an
  // aggregator's ingestion (Eventbrite geo-feed, Ticketmaster 25-mile
  // radius, Simpleview CVB install). They appear as their own rows so the
  // page accurately reflects every event source we cover. `subOf` tells the
  // render to roll event counts and last-run up to the parent scraper.
  {
    key:    'tm_blossom_music_center',
    subOf:  'ticketmaster',
    label:  'Blossom Music Center',
    method: 'REST API',
    methodDetail:'Routed through the Ticketmaster geo-radius (no dedicated scraper)',
    venue:  'Blossom Music Center — 1145 W Steels Corners Rd, Cuyahoga Falls',
    notes:  'Cleveland Orchestra summer pavilion and a major touring-concert venue. Sits ~8 miles from downtown Akron, well inside the 25-mile Ticketmaster radius, so the full season schedule arrives without a separate ingest.',
    status: 'active',
  },
  {
    key:    'sv_jsk_center',
    subOf:  'visit_akron_cvb',
    label:  'John S. Knight Center',
    method: 'REST API',
    methodDetail:'Routed through the Visit Akron Simpleview install (no dedicated scraper)',
    venue:  'John S. Knight Center — 77 E Mill St',
    notes:  "Downtown Akron's primary convention center sits on the same Simpleview platform as Visit Akron CVB, so its events flow through the citywide CVB API automatically. A dedicated scraper would just be a category filter on the same source.",
    status: 'active',
  },
  {
    key:    'eb_house_three_thirty',
    subOf:  'eventbrite',
    label:  'House Three Thirty',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed (organizer 61445316323)',
    venue:  '532 W Market St — community arts, music & event space',
    notes:  'Ticketed House Three Thirty events publish through Eventbrite and are geotagged 532 W Market St, so they flow into the citywide Eventbrite scraper. The free/community programming that never hits Eventbrite is covered by the dedicated `house_three_thirty` scraper (the venue\'s own VTL calendar API); cross-source dedup reconciles the overlap.',
    status: 'active',
  },
  {
    key:    'eb_the_matinee',
    subOf:  'eventbrite',
    label:  'The Matinee',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'The Matinee — downtown Akron music & event space',
    notes:  'The Matinee publishes its public-facing programming exclusively through Eventbrite, so events arrive via the citywide geo-feed.',
    status: 'active',
  },
  {
    key:    'eb_green_dragon_inn',
    subOf:  'eventbrite',
    label:  'The Green Dragon Inn',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'The Green Dragon Inn — downtown Akron music venue',
    notes:  'Ticketed shows post to Eventbrite and are picked up by the geo-feed; the Downtown Akron Partnership scraper also catches them in its monthly listings, so we have dual coverage for redundancy.',
    status: 'active',
  },
  {
    key:    'eb_summit_historical',
    subOf:  'eventbrite',
    label:  'Summit County Historical Society',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'Summit County Historical Society — Perkins Stone Mansion / John Brown House',
    notes:  'Lecture series, mansion tours, and historic-site programming. Tickets sold via Eventbrite.',
    status: 'active',
  },
  {
    key:    'eb_bounce_innovation_hub',
    subOf:  'eventbrite',
    label:  'Bounce Innovation Hub',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'Bounce Innovation Hub — 526 S Main St',
    notes:  "Akron's largest startup and entrepreneurship hub. Pitch nights, workshops, and demo days all run through Eventbrite.",
    status: 'active',
  },
  {
    key:    'eb_black_chamber',
    subOf:  'eventbrite',
    label:  'Akron Black Chamber of Commerce',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'Akron Black Chamber of Commerce — citywide programming',
    notes:  'Networking events, business workshops, and community programming for Black-owned businesses in Akron. Eventbrite is the canonical channel.',
    status: 'active',
  },
  {
    key:    'eb_black_artist_guild',
    subOf:  'eventbrite',
    label:  'Akron Black Artist Guild',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'Akron Black Artist Guild — multiple venues',
    notes:  'Artist showcases, exhibitions, and community arts events. Programming is published through Eventbrite.',
    status: 'active',
  },
  {
    key:    'eb_interbelt',
    subOf:  'eventbrite',
    label:  'Interbelt Nite Club',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'Interbelt Nite Club — 70 N Howard St',
    notes:  "Long-running LGBTQ+ nightclub. Themed nights and drag shows are ticketed via Eventbrite.",
    status: 'active',
  },
  {
    key:    'eb_akron_canton_foodbank',
    subOf:  'eventbrite',
    label:  'Akron-Canton Regional Foodbank',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'Akron-Canton Regional Foodbank — 350 Opportunity Pkwy',
    notes:  'Volunteer shifts, donor events, and food-distribution programming. Sign-ups and ticketing run through Eventbrite.',
    status: 'active',
  },
  {
    key:    'eb_blu_tique',
    subOf:  'eventbrite',
    label:  'BLU-Tique',
    method: 'HTML scrape',
    methodDetail:'Routed through the Eventbrite citywide geo-feed',
    venue:  'BLU-Tique — 47 E Market St (BLU Jazz+ second-floor lounge)',
    notes:  "Smaller-format jazz, comedy, and private-event lounge upstairs from BLU Jazz+. Its calendar runs through Eventbrite, separate from the BLU Jazz+ TurnTable Tickets listing.",
    status: 'active',
  },
]

/** DATA_SOURCES with labels resolved from the manifest (single source of truth). */
export const DATA_SOURCES: DataSource[] = RAW_DATA_SOURCES.map((s) => ({
  ...s,
  label: s.label ?? labelFor(s.key),
}))

export const SOURCE_GROUPS: SourceGroup[] = [
  {
    id:    'eventbrite',
    title: 'Eventbrite',
    description: "Eventbrite's public API was deprecated in 2020, so we scrape the citywide Akron search results — extracting events from window.__SERVER_DATA__ and paginating the internal /api/v3/destination/search/ POST endpoint with session cookies. One geo-scoped feed catches the long tail of community organizers who publish only to Eventbrite (House Three Thirty, The Matinee, Akron Black Artist Guild, Bounce Innovation Hub, etc.) without per-organizer scrapers.",
  },
  {
    id:    'ticketmaster',
    title: 'Ticketmaster',
    description: 'Ticketmaster Discovery API v2 with a 25-mile geo-radius from downtown Akron over a 90-day window. Covers Blossom Music Center, Akron Civic Theatre, EJ Thomas Hall, and the Cleveland-adjacent shows that travel through the area. New Ticketmaster-hosted venues inside the radius are picked up automatically.',
  },
  {
    id:    'tribe',
    title: 'The Events Calendar (Tribe / WordPress)',
    description: 'Sites running the WordPress "Events Calendar" plugin (a.k.a. Tribe Events) expose a documented REST API at /wp-json/tribe/events/v1/events. We paginate it directly — categories, venues, and cost data come through structured. The most common CMS in the Akron civic-org ecosystem.',
  },
  {
    id:    'ics',
    title: 'iCalendar (ICS) Feeds',
    description: "When a venue publishes an .ics calendar subscription (RFC 5545), we fetch and parse it directly via the shared scripts/lib/ics.js module — line unfolding, TZID conversion, and TEXT escape handling included. Each per-source scraper is a thin config wrapper around runIcsScraper.",
  },
  {
    id:    'civicplus',
    title: 'CivicPlus iCalendar (Summit County cities)',
    description: "Most Summit County municipalities run their official websites on CivicPlus (CivicEngage), which exposes every public calendar as an RFC 5545 iCalendar feed at /common/modules/iCalendar/iCalendar.aspx?catID={id}&feed=calendar. Unlike a single master feed, CivicPlus splits content across category calendars (Main Calendar, Recreation Events, City Council, Board of Zoning Appeals, …), each with its own catID and no working aggregate (catID=0 is empty). The shared scripts/lib/civicplus.js fetches the public-event categories per city, merges and dedupes by UID, and runs an admin/meeting filter so council and board entries drop while festivals, concert series, markets, and Parks & Rec programming flow through. Each city scraper is a thin config wrapper supplying its origin, catIDs, and default venue.",
  },
  {
    id:    'squarespace',
    title: 'Squarespace Events Collection',
    description: 'Squarespace sites with a native Events collection expose structured JSON at ?format=json&view=upcoming. The shared lib/squarespace.js fetches it and normalises the response (epoch-ms timestamps, location object, body HTML) into our common event shape.',
  },
  {
    id:    'livewhale',
    title: 'LiveWhale (University of Akron)',
    description: "UAkron's campus calendar runs on LiveWhale, which exposes a JSON endpoint returning 90 days of all campus events. One fetch produces four ingestion sources: the default UAkron bucket plus three sub-routed by group_title (EJ Thomas Hall, Myers School of Art, Cummings Center for the History of Psychology).",
  },
  {
    id:    'simpleview',
    title: 'Simpleview (Visit Akron / Summit CVB)',
    description: "Simpleview runs the official convention-and-visitors-bureau site. Auth via a public session token, then queries against /includes/rest_v2/plugins_events_events_by_date/find/ with a MongoDB-style filter ($and / $in / $date / $gte / $lte). The John S. Knight Center sits on the same install, so its events surface here without a separate scraper.",
  },
  {
    id:    'communico',
    title: 'Communico (Akron-Summit Library)',
    description: 'Communico (also branded Libnet) is the calendar/programs platform behind the Akron-Summit County Public Library. A single API call returns ~400+ programs across all 27+ branches over a 180-day window.',
  },
  {
    id:    'mlb',
    title: 'MLB Stats API (RubberDucks)',
    description: 'The MLB official stats endpoint (statsapi.mlb.com), filtered by teamId 402 for the RubberDucks. Returns the full home-game schedule with promotion details (Fireworks Night, Bark in the Park, etc.) carried through into event descriptions.',
  },
  {
    id:    'sidearm',
    title: 'Sidearm Sports (University of Akron Athletics)',
    description: "gozips.com runs on Sidearm Sports, which publishes a composite RFC 5545 iCalendar feed (calendar.ashx/calendar.ics?sport_id=0) covering every Zips sport. We parse it via scripts/lib/ics.js, then filter to upcoming home games at Akron venues — away games and BYE weeks drop out — and normalize titles to \"Akron Zips <Sport> vs <Opponent>\".",
  },
  {
    id:    'dice',
    title: 'DICE (Musica)',
    description: "Some venues (e.g. Musica) sell exclusively through DICE and embed its event-list widget instead of running a native calendar — so aggregators that crawl them often drop the show time. We pull straight from the same DICE partner API the widget uses (partners-endpoint.dice.fm/api/v2/events, filtered by venue) for authoritative start times, prices, and ticket links. Requires a DICE_API_KEY (the widget's public client key).",
  },
  {
    id:    'revize',
    title: 'Revize (City of Akron)',
    description: 'The City of Akron runs on Revize CMS. Its events feed is the same JSON endpoint the on-page FullCalendar widget consumes (/_assets_/plugins/revizeCalendar/calendar_data_handler.php). We ingest four city-managed calendars — Events, Parks & Rec, Lock 3, and Great Streets Akron — and explicitly skip the meetings/HR/oversight calendars.',
  },
  {
    id:    'seatengine',
    title: 'Seat Engine',
    description: 'Seat Engine powers ticketing and the public-facing website for several independent live-entertainment venues. The frontend client-hydrates listings via React, so we render with Puppeteer to harvest event slugs, then render each detail page and extract title, image, price, and one row per individual showtime.',
  },
  {
    id:    'evvnt',
    title: 'Evvnt (Akron Life)',
    description: "Evvnt is the syndication platform behind Akron Life Magazine's events calendar. The on-page Discovery widget calls a global the current plugin no longer exposes, so we skip the DOM and hit the unauthenticated REST endpoint (/api/publisher/11072/widget_events) directly. Evvnt is high-volume but low-fidelity — categories are frequently wrong and many events are backfilled from venues we already scrape — so we run our own category inference and a hostname/organiser-based dedup pass against every other scraper before upserting.",
  },
  {
    id:    'schema-jsonld',
    title: 'Schema.org Event JSON-LD',
    description: "Some independent WordPress venues don't expose a REST API or an ICS feed but do embed a clean Schema.org @type:Event JSON-LD block on every detail page (name, startDate, location, offers, image, description). When that's the case the scraper just harvests permalinks from the listing page and reads the structured-data block on each — no HTML parsing of card markup required.",
  },
  {
    id:    'wp-hybrid',
    title: 'EventON & custom WordPress',
    description: "WordPress sites that don't expose a Tribe Events feed — typically because they use the EventON plugin or hand-rolled custom post types — get a per-site combination: AJAX or WP REST API for the schedule, secondary fetches for images and descriptions.",
  },
  {
    id:    'html',
    title: 'Custom HTML Scrapers',
    description: "When a venue's CMS exposes no machine-readable feed, the scraper parses the rendered HTML directly. Each one is bespoke to its target site's structure. Most are stable for years; CMS redesigns are caught by the Scraper Health monitor below.",
  },
  {
    id:    'lrmr',
    title: 'LRMR (House Three Thirty)',
    description: "House Three Thirty runs on the LeBron James Family Foundation's in-house \"LRMR\" web platform — a Vue front end whose LrmrEvents component reads an unauthenticated JSON feed (GET /api/vtl/events). We hit that endpoint directly. It returns display-formatted date/time strings rather than ISO timestamps, so the scraper parses them back to Eastern time and assigns recurring occurrences a per-date source_id.",
  },
]

// Maps each DATA_SOURCES key to its SOURCE_GROUPS id. Kept separate from the
// source records so the existing entries stay easy to edit and the grouping is
// auditable at a glance.
export const SOURCE_GROUP_BY_KEY: Record<string, string> = {
  // Aggregators
  eventbrite:         'eventbrite',
  ticketmaster:       'ticketmaster',
  musica:             'dice',

  // The Events Calendar (Tribe / WordPress)
  summit_artspace:    'tribe',
  summit_metro_parks: 'tribe',
  cvnp_conservancy:   'tribe',
  players_guild:      'tribe',
  missing_falls:      'tribe',
  torchbearers:       'tribe',
  indivisible_akron:  'tribe',
  royal_palace:       'tribe',

  // iCalendar (ICS) feeds
  akron_symphony:      'ics',
  north_hill_cdc:      'ics',
  akron_public_schools:'ics',
  life_gurukula:       'ics',

  // CivicPlus iCalendar (Summit County municipalities)
  city_of_green:        'civicplus',
  city_of_stow:         'civicplus',
  city_of_hudson:       'civicplus',
  city_of_tallmadge:    'civicplus',
  city_of_new_franklin: 'civicplus',
  city_of_fairlawn:     'civicplus',

  // Evvnt (Akron Life) — its own group; ICS isn't accurate
  akron_life:          'evvnt',

  // Squarespace Events Collection
  leadership_akron:    'squarespace',
  artisan_coffee:      'squarespace',
  rialto:              'squarespace',
  crown_point_ecology: 'squarespace',
  cascade_locks:       'squarespace',
  hiho_brewing:        'squarespace',

  // LiveWhale (UAkron)
  uakron_calendar:  'livewhale',
  ejthomas_hall:    'livewhale',
  uakron_myers_art: 'livewhale',
  uakron_chp:       'livewhale',

  // Single-platform APIs
  visit_akron_cvb:     'simpleview',
  akron_library:       'communico',
  cuyahoga_falls_library: 'communico',
  rubberducks:         'mlb',
  akron_zips:          'sidearm',
  akron_rec_parks:     'recdesk',
  city_of_akron_lock3: 'revize',
  killbox_comedy:      'seatengine',
  akron_marathon:      'html',
  akron_promise:       'html',
  release_yoga:        'html',

  // EventON / custom WordPress
  jillys_music_room: 'wp-hybrid',
  akronym_brewing:   'wp-hybrid',
  mustard_seed:      'wp-hybrid',

  // LRMR platform (House Three Thirty's own calendar API)
  house_three_thirty: 'lrmr',

  // Custom HTML scrapers
  akron_art_museum:       'html',
  akron_zoo:              'html',
  city_of_cuyahoga_falls: 'html',
  akron_community_foundation: 'html',
  the_well_cdc:           'html',
  better_kenmore:         'html',
  first_glance:           'html',
  full_grip_games:        'ics',
  akron_makerspace:       'html',
  akron_soul_train:       'html',
  southgate_farm:         'html',
  meetup:                 'ics',
  highland_square_theatre: 'html',
  highland_square:        'html',
  downtown_akron:         'html',
  weathervane:            'html',
  ohio_shakespeare:       'html',
  painting_twist:         'html',
  blu_jazz:               'html',
  akron_childrens_museum: 'html',
  nightlight_cinema:      'html',
  stan_hywet:             'html',
  akron_urban_league:     'html',
  hale_farm:              'html',
  cvart:                  'html',

  // Schema.org Event JSON-LD on every detail page
  kent_stage:             'schema-jsonld',
  akron_civic:            'html',
  get_away_with_murder:   'schema-jsonld',

  // Aggregator-routed organizations (share a parent scraper via `subOf`)
  tm_blossom_music_center:'ticketmaster',
  sv_jsk_center:          'simpleview',
  eb_house_three_thirty:  'eventbrite',
  eb_the_matinee:         'eventbrite',
  eb_green_dragon_inn:    'eventbrite',
  eb_summit_historical:   'eventbrite',
  eb_bounce_innovation_hub:'eventbrite',
  eb_black_chamber:       'eventbrite',
  eb_black_artist_guild:  'eventbrite',
  eb_interbelt:           'eventbrite',
  eb_akron_canton_foodbank:'eventbrite',
  eb_blu_tique:           'eventbrite',
}
