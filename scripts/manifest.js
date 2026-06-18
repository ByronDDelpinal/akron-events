/**
 * manifest.js — Single source of truth for all event scrapers.
 *
 * This replaces the 52-entry `scrape:all` chain in package.json and the
 * parallel DATA_SOURCES / SCRAPER_LABELS registries that were previously
 * kept in sync by hand. Every tool that needs to know "what scrapers exist"
 * imports from here — the run-all runner, health-check scripts, CI, and
 * future admin tooling.
 *
 * Each entry:
 *   key     — the `source` column value in the DB (snake_case)
 *   script  — path relative to the repo root (used by run-all.js)
 *   label   — human-readable name (dashboards, logs, Technical page)
 *   group   — platform / publisher group (for the Technical page grouping)
 *   active  — false means run-all skips it (preserves the record for reference)
 *   defaultCategory — OPTIONAL. A per-source fallback content category used ONLY
 *             when a row's native source category AND text inference both come
 *             back 'other' (see resolveEventCategories in scripts/lib/normalize.js).
 *             It is a blunt prior, never an override: confident native/text
 *             classifications always win, so e.g. a theater show on a
 *             music-default feed still resolves to 'theater'. Set it only for
 *             sources whose unlabelled long tail is dominated by one type
 *             (a music-venue feed, a civic org's own programming). This is what
 *             lets these events self-heal on every scrape instead of decaying
 *             back to 'other' + needs_review.
 *
 * Run order matters: `scrape:all` runs scrapers sequentially in the order
 * listed here. Place deduplication last.
 *
 * To add a new scraper:
 *   1. Create scripts/scrape-<key>.js
 *   2. Add one entry here — that's it.
 *      run-all.js, CI, and the health dashboard pick it up automatically.
 */

export const SCRAPERS = [
  // ── Anchors (high-volume, high-quality) ────────────────────────────────
  { key: 'summit_artspace',       script: 'scripts/scrape-summit-artspace.js',        label: 'Summit Artspace',              group: 'wordpress',      active: true  },
  { key: 'summit_metro_parks',    script: 'scripts/scrape-summit-metro-parks.js',      label: 'Summit Metro Parks',           group: 'custom',         active: true  },
  { key: 'cvnp_conservancy',      script: 'scripts/scrape-cvnp-conservancy.js',        label: 'CVNP Conservancy',             group: 'custom',         active: true  },
  { key: 'players_guild',         script: 'scripts/scrape-players-guild.js',           label: 'Players Guild Theatre',      group: 'wordpress',      active: true  },
  { key: 'uakron_calendar',       script: 'scripts/scrape-uakron-calendar.js',         label: 'University of Akron',          group: 'custom',         active: true  },
  { key: 'rubberducks',           script: 'scripts/scrape-rubberducks.js',             label: 'Akron RubberDucks',            group: 'custom',         active: true  },
  { key: 'nightlight_cinema',     script: 'scripts/scrape-nightlight.js',              label: 'The Nightlight Cinema',        group: 'custom',         active: true  },
  { key: 'akron_library',         script: 'scripts/scrape-akron-library.js',           label: 'Akron Library', group: 'civicplus', active: true  },
  { key: 'cuyahoga_falls_library', script: 'scripts/scrape-cuyahoga-falls-library.js',  label: 'Cuyahoga Falls Library',       group: 'communico',      active: true  },
  { key: 'jillys_music_room',    script: 'scripts/scrape-jillys.js',                  label: "Jilly's Music Room",           group: 'custom',         active: true  },
  { key: 'blu_jazz',             script: 'scripts/scrape-blu-jazz.js',                label: 'BLU Jazz+',                    group: 'custom',         active: true  },

  // ── Music & entertainment venues ───────────────────────────────────────
  { key: 'missing_falls',        script: 'scripts/scrape-missing-falls.js',           label: 'Missing Falls Brewery',        group: 'custom',         active: true  },
  { key: 'akronym_brewing',      script: 'scripts/scrape-akronym.js',                 label: 'Akronym Brewing',              group: 'custom',         active: true  },
  { key: 'rialto',               script: 'scripts/scrape-rialto.js',                  label: 'The Rialto Theatre',           group: 'squarespace',    active: true  },
  { key: 'kent_stage',           script: 'scripts/scrape-kent-stage.js',              label: 'The Kent Stage',                 group: 'custom',         active: true  },
  { key: 'highland_square_theatre', script: 'scripts/scrape-highland-square-theatre.js', label: 'Highland Square Theatre',  group: 'custom',         active: true  },
  { key: 'killbox_comedy',       script: 'scripts/scrape-killbox-comedy.js',          label: 'KillBox Comedy Club',          group: 'custom',         active: true  },

  // ── Arts & culture ─────────────────────────────────────────────────────
  { key: 'akron_art_museum',     script: 'scripts/scrape-akron-art-museum.js',        label: 'Akron Art Museum',             group: 'wordpress',      active: true  },
  { key: 'akron_civic',          script: 'scripts/scrape-akron-civic.js',             label: 'Akron Civic Theatre',          group: 'custom',         active: true  },
  { key: 'downtown_akron',       script: 'scripts/scrape-downtown-akron.js',          label: 'Downtown Akron Partnership',   group: 'custom',         active: true  },
  { key: 'ohio_shakespeare',     script: 'scripts/scrape-ohio-shakespeare.js',        label: 'Ohio Shakespeare Festival',    group: 'ics',            active: true  },
  { key: 'weathervane',          script: 'scripts/scrape-weathervane.js',             label: 'Weathervane Playhouse',        group: 'ics',            active: true  },
  { key: 'painting_twist',       script: 'scripts/scrape-painting-twist.js',          label: 'Painting with a Twist',        group: 'custom',         active: true  },
  { key: 'cvart',                script: 'scripts/scrape-cvart.js',                   label: 'CV Art Center',   group: 'custom',         active: true  },

  // ── Performing arts ────────────────────────────────────────────────────
  { key: 'akron_symphony',       script: 'scripts/scrape-akron-symphony.js',          label: 'Akron Symphony',     group: 'ics',            active: true  },
  { key: 'stan_hywet',           script: 'scripts/scrape-stan-hywet.js',              label: 'Stan Hywet',    group: 'custom',         active: true  },
  { key: 'get_away_with_murder', script: 'scripts/scrape-get-away-with-murder.js',    label: 'Get Away With Murder',         group: 'json-ld',        active: true  },

  // ── Attractions & nature ───────────────────────────────────────────────
  { key: 'akron_zips',           script: 'scripts/scrape-akron-zips.js',              label: 'University of Akron Athletics (Zips)', group: 'ics',   active: true  },
  { key: 'akron_zoo',            script: 'scripts/scrape-akron-zoo.js',               label: 'Akron Zoo',                    group: 'custom',         active: true  },
  { key: 'hale_farm',            script: 'scripts/scrape-hale-farm.js',               label: 'Hale Farm & Village',          group: 'custom',         active: true  },
  { key: 'cascade_locks',        script: 'scripts/scrape-cascade-locks.js',           label: 'Cascade Locks',    group: 'squarespace',    active: true  },
  { key: 'hiho_brewing',         script: 'scripts/scrape-hiho-brewing.js',            label: 'HiHO Brewing Co.',             group: 'squarespace',    active: true  },
  { key: 'crown_point_ecology',  script: 'scripts/scrape-crown-point-ecology.js',     label: 'Crown Point Ecology Center',   group: 'squarespace',    active: true  },
  { key: 'highland_square',      script: 'scripts/scrape-highland-square.js',         label: 'Highland Square (PorchROKR)', group: 'custom',         active: true  },

  // ── Community / neighborhood orgs ──────────────────────────────────────
  { key: 'akron_childrens_museum', script: 'scripts/scrape-akron-childrens-museum.js', label: 'Akron Children\'s Museum',   group: 'drupal',         active: true  },
  { key: 'akron_makerspace',     script: 'scripts/scrape-akron-makerspace.js',        label: 'Akron Makerspace',             group: 'wordpress',      active: true, defaultCategory: 'learning' },
  { key: 'akron_soul_train',     script: 'scripts/scrape-akron-soul-train.js',        label: 'Akron Soul Train',             group: 'wix',            active: true, defaultCategory: 'visual-art' },
  { key: 'southgate_farm',       script: 'scripts/scrape-southgate-farm.js',          label: 'Southgate Farm',               group: 'wix',            active: true, defaultCategory: 'outdoors' },
  { key: 'north_hill_cdc',       script: 'scripts/scrape-north-hill-cdc.js',          label: 'North Hill CDC',               group: 'ics',            active: true  },
  { key: 'leadership_akron',     script: 'scripts/scrape-leadership-akron.js',        label: 'Leadership Akron',             group: 'squarespace',    active: true  },
  { key: 'artisan_coffee',       script: 'scripts/scrape-artisan-coffee.js',          label: 'Artisan Coffee',               group: 'squarespace',    active: true  },
  { key: 'musica',               script: 'scripts/scrape-musica.js',                  label: 'Musica',                       group: 'dice',           active: true  },
  { key: 'akron_urban_league',   script: 'scripts/scrape-akron-urban-league.js',      label: 'Akron Urban League',           group: 'custom',         active: true  },
  { key: 'the_well_cdc',        script: 'scripts/scrape-the-well-cdc.js',             label: 'The Well CDC',                 group: 'custom',         active: true  },
  { key: 'better_kenmore',       script: 'scripts/scrape-better-kenmore.js',          label: 'Better Kenmore CDC',           group: 'wordpress',      active: true  },
  { key: 'first_glance',         script: 'scripts/scrape-first-glance.js',            label: 'First Glance Student Center',  group: 'wordpress',      active: true  },
  { key: 'full_grip_games',      script: 'scripts/scrape-full-grip-games.js',         label: 'Full Grip Games',              group: 'ics',            active: true, defaultCategory: 'games' },
  { key: 'mustard_seed',         script: 'scripts/scrape-mustard-seed.js',            label: 'Mustard Seed Market & Café',   group: 'custom',         active: true  },
  { key: 'royal_palace',         script: 'scripts/scrape-royal-palace.js',            label: 'Royal Palace Akron',           group: 'tribe',          active: true, defaultCategory: 'music' },
  { key: 'release_yoga',         script: 'scripts/scrape-release-yoga.js',            label: 'Release Yoga',                 group: 'mindbody',       active: true, defaultCategory: 'fitness' },
  { key: 'life_gurukula',        script: 'scripts/scrape-life-gurukula.js',           label: 'Life Gurukula',                group: 'ics',            active: true  },
  { key: 'torchbearers',         script: 'scripts/scrape-torchbearers.js',            label: 'Torchbearers',        group: 'custom',         active: true, defaultCategory: 'civic' },
  { key: 'indivisible_akron',    script: 'scripts/scrape-indivisible-akron.js',       label: 'Indivisible Akron',            group: 'tribe',          active: true, defaultCategory: 'civic' },
  { key: 'house_three_thirty',   script: 'scripts/scrape-house-three-thirty.js',      label: 'House Three Thirty',           group: 'lrmr',           active: true  },

  // ── Education ──────────────────────────────────────────────────────────
  { key: 'akron_public_schools', script: 'scripts/scrape-akron-public-schools.js',    label: 'Akron Public Schools',         group: 'ics',            active: true  },
  { key: 'akron_community_foundation', script: 'scripts/scrape-acf.js',                     label: 'Akron Community Foundation',   group: 'drupal',         active: true  },

  // ── Aggregators & feeds ────────────────────────────────────────────────
  { key: 'akron_life',           script: 'scripts/scrape-akron-life.js',              label: 'Akron Life',          group: 'evvnt',          active: true  },
  { key: 'eventbrite',           script: 'scripts/scrape-eventbrite.js',              label: 'Eventbrite',            group: 'api',            active: true  },
  { key: 'ticketmaster',         script: 'scripts/fetch-ticketmaster.js',             label: 'Ticketmaster',          group: 'api',            active: true  },
  { key: 'visit_akron_cvb',      script: 'scripts/scrape-visit-akron-cvb.js',         label: 'Visit Akron CVB',             group: 'custom',         active: true  },
  { key: 'meetup',               script: 'scripts/scrape-meetup.js',                  label: 'Meetup',                       group: 'ics',            active: true  },

  // ── City calendars (CivicPlus) ─────────────────────────────────────────
  { key: 'akron_rec_parks',      script: 'scripts/scrape-akron-rec-parks.js',         label: 'Akron Recreation & Parks',     group: 'recdesk',        active: true  },
  { key: 'city_of_akron_lock3',  script: 'scripts/scrape-city-of-akron-lock3.js',     label: 'City of Akron (Lock 3)',       group: 'civicplus',      active: true  },
  { key: 'city_of_green',        script: 'scripts/scrape-city-of-green.js',           label: 'City of Green',                group: 'ics',            active: true  },
  { key: 'city_of_stow',         script: 'scripts/scrape-city-of-stow.js',            label: 'City of Stow',                 group: 'civicplus',      active: true  },
  { key: 'city_of_hudson',       script: 'scripts/scrape-city-of-hudson.js',          label: 'City of Hudson',               group: 'civicplus',      active: true  },
  { key: 'city_of_tallmadge',    script: 'scripts/scrape-city-of-tallmadge.js',       label: 'City of Tallmadge',            group: 'civicplus',      active: true  },
  { key: 'city_of_new_franklin', script: 'scripts/scrape-city-of-new-franklin.js',    label: 'City of New Franklin',         group: 'civicplus',      active: true  },
  { key: 'city_of_fairlawn',     script: 'scripts/scrape-city-of-fairlawn.js',        label: 'City of Fairlawn',             group: 'civicplus',      active: true  },
  { key: 'city_of_cuyahoga_falls', script: 'scripts/scrape-city-of-cuyahoga-falls.js', label: 'City of Cuyahoga Falls',     group: 'custom',         active: true  },
  { key: 'akron_marathon',       script: 'scripts/scrape-akron-marathon.js',          label: 'Akron Marathon',               group: 'custom',         active: true  },
]

// Active scrapers only — what run-all.js iterates.
export const ACTIVE_SCRAPERS = SCRAPERS.filter((s) => s.active)

// Lookup maps derived from the manifest — no separate SCRAPER_LABELS needed.
export const SCRAPER_BY_KEY   = Object.freeze(Object.fromEntries(SCRAPERS.map((s) => [s.key, s])))
export const SCRAPER_LABEL    = Object.freeze(Object.fromEntries(SCRAPERS.map((s) => [s.key, s.label])))
export const SCRAPER_GROUP    = Object.freeze(Object.fromEntries(SCRAPERS.map((s) => [s.key, s.group])))

// All active source keys — useful for validation and health checks.
export const ACTIVE_SOURCE_KEYS = Object.freeze(ACTIVE_SCRAPERS.map((s) => s.key))

// Per-source fallback content category (see the `defaultCategory` note in the
// header). Only sources that declare one appear here.
export const SOURCE_DEFAULT_CATEGORY = Object.freeze(
  Object.fromEntries(SCRAPERS.filter((s) => s.defaultCategory).map((s) => [s.key, s.defaultCategory]))
)

/** The fallback content category for a source key, or null if none is set. */
export function defaultCategoryFor(sourceKey) {
  return SOURCE_DEFAULT_CATEGORY[sourceKey] ?? null
}
