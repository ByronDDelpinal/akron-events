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
  // Retired 2026-07-15 — Canton (Stark County). Outside Summit; see dataSources notes.
  { key: 'players_guild',         script: 'scripts/scrape-players-guild.js',           label: 'Players Guild Theatre',      group: 'wordpress',      active: false },
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
  // Retired 2026-07-15 — Kent (Portage County). Outside Summit; see dataSources notes.
  { key: 'kent_stage',           script: 'scripts/scrape-kent-stage.js',              label: 'The Kent Stage',                 group: 'custom',         active: false },
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
  // Retired 2026-07-15 — North Canton (Stark County). Outside Summit; see dataSources notes.
  { key: 'southgate_farm',       script: 'scripts/scrape-southgate-farm.js',          label: 'Southgate Farm',               group: 'wix',            active: false, defaultCategory: 'outdoors' },
  { key: 'helens_studio',        script: 'scripts/scrape-helens-studio.js',           label: "Helen's Ceramic and Art Studio", group: 'wix',          active: true, defaultCategory: 'visual-art' },
  { key: 'north_hill_cdc',       script: 'scripts/scrape-north-hill-cdc.js',          label: 'North Hill CDC',               group: 'ics',            active: true  },
  { key: 'akron_pride',          script: 'scripts/scrape-akron-pride.js',             label: 'Akron Pride Festival',         group: 'ics',            active: true, defaultCategory: 'festival' },
  { key: 'city_of_barberton',    script: 'scripts/scrape-city-of-barberton.js',       label: 'City of Barberton',            group: 'ics',            active: true  },
  { key: 'habitat_summit',       script: 'scripts/scrape-habitat-summit.js',          label: 'Habitat for Humanity Summit',  group: 'html',           active: true, defaultCategory: 'civic' },
  { key: 'ohio_festivals',       script: 'scripts/scrape-ohio-festivals.js',          label: 'Ohio Festivals',               group: 'html',           active: true, defaultCategory: 'festival' },
  { key: 'summit_county_fairgrounds', script: 'scripts/scrape-summit-county-fairgrounds.js', label: 'Summit County Fairgrounds', group: 'html',      active: true  },
  { key: 'ohio_erie_canalway',   script: 'scripts/scrape-ohio-erie-canalway.js',      label: 'Ohio & Erie Canalway',         group: 'html',           active: true  },
  { key: 'akron_roller_derby',   script: 'scripts/scrape-akron-roller-derby.js',      label: 'Akron Roller Derby',           group: 'html',           active: true, defaultCategory: 'sports' },
  { key: 'magic_city_drivein',   script: 'scripts/scrape-magic-city-drivein.js',      label: 'Magic City Drive-In',          group: 'html',           active: true, defaultCategory: 'film' },
  { key: 'dilly_ds',             script: 'scripts/scrape-dilly-ds.js',                label: "Dilly D's Sports Grill",       group: 'html',           active: true, defaultCategory: 'games' },
  { key: 'old_stone_jail',       script: 'scripts/scrape-old-stone-jail.js',          label: 'Old Stone Jail',               group: 'html',           active: true, defaultCategory: 'games' },
  { key: 'leadership_akron',     script: 'scripts/scrape-leadership-akron.js',        label: 'Leadership Akron',             group: 'squarespace',    active: true  },
  { key: 'artisan_coffee',       script: 'scripts/scrape-artisan-coffee.js',          label: 'Artisan Coffee',               group: 'squarespace',    active: true  },
  { key: 'russos',               script: 'scripts/scrape-russos.js',                  label: "Russo's Restaurant",           group: 'squarespace',    active: true, defaultCategory: 'music' },
  { key: 'musica',               script: 'scripts/scrape-musica.js',                  label: 'Musica',                       group: 'dice',           active: true  },
  { key: 'akron_urban_league',   script: 'scripts/scrape-akron-urban-league.js',      label: 'Akron Urban League',           group: 'custom',         active: true  },
  { key: 'the_well_cdc',        script: 'scripts/scrape-the-well-cdc.js',             label: 'The Well CDC',                 group: 'custom',         active: true  },
  { key: 'better_kenmore',       script: 'scripts/scrape-better-kenmore.js',          label: 'Better Kenmore CDC',           group: 'wordpress',      active: true  },
  { key: 'first_glance',         script: 'scripts/scrape-first-glance.js',            label: 'First Glance Student Center',  group: 'wordpress',      active: true  },
  { key: 'full_grip_games',      script: 'scripts/scrape-full-grip-games.js',         label: 'Full Grip Games',              group: 'ics',            active: true, defaultCategory: 'games' },
  { key: 'mustard_seed',         script: 'scripts/scrape-mustard-seed.js',            label: 'Mustard Seed Market & Café',   group: 'custom',         active: true  },
  { key: 'royal_palace',         script: 'scripts/scrape-royal-palace.js',            label: 'Royal Palace Akron',           group: 'tribe',          active: true, defaultCategory: 'music' },
  { key: 'northfield_park',      script: 'scripts/scrape-northfield-park.js',         label: 'Northfield Park Racino',       group: 'tribe',          active: true, defaultCategory: 'music' },
  { key: 'summit_humane',        script: 'scripts/scrape-summit-humane.js',           label: 'Humane Society of Summit County', group: 'tribe',        active: true  },
  { key: 'stewarts_caring_place', script: 'scripts/scrape-stewarts-caring-place.js',  label: "Stewart's Caring Place",       group: 'tribe',          active: true, defaultCategory: 'fitness' },
  { key: 'main_street_barberton', script: 'scripts/scrape-main-street-barberton.js',  label: 'Main Street Barberton',        group: 'ics',            active: true  },
  { key: 'wine_mill',            script: 'scripts/scrape-wine-mill.js',               label: 'The Wine Mill',                group: 'tribe',          active: true, defaultCategory: 'music' },
  { key: 'portage_lakes_kiwanis', script: 'scripts/scrape-portage-lakes-kiwanis.js',  label: 'Portage Lakes Kiwanis',        group: 'tribe',          active: true  },
  { key: 'release_yoga',         script: 'scripts/scrape-release-yoga.js',            label: 'Release Yoga',                 group: 'mindbody',       active: true, defaultCategory: 'fitness' },
  { key: 'life_gurukula',        script: 'scripts/scrape-life-gurukula.js',           label: 'Life Gurukula',                group: 'ics',            active: true  },
  // PAUSED 2026-06-05: public Tribe feed surfaces members-only internal events
  // (board/committee/GMM meetings). Not in scrape:all; marked inactive so the
  // nightly health report doesn't flag it as "did not run". Re-enable after
  // adding a public/internal filter (see scrape-torchbearers.js header).
  { key: 'torchbearers',         script: 'scripts/scrape-torchbearers.js',            label: 'Torchbearers',        group: 'custom',         active: false, defaultCategory: 'civic' },
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
  { key: 'city_of_norton',       script: 'scripts/scrape-city-of-norton.js',          label: 'City of Norton',               group: 'civicplus',      active: true  },
  { key: 'copley_township',      script: 'scripts/scrape-copley-township.js',         label: 'Copley Township',              group: 'civicplus',      active: true  },
  { key: 'springfield_township', script: 'scripts/scrape-springfield-township.js',    label: 'Springfield Township',         group: 'civicplus',      active: true  },
  { key: 'village_of_richfield', script: 'scripts/scrape-village-of-richfield.js',    label: 'Village of Richfield',         group: 'civicplus',      active: true  },
  { key: 'city_of_fairlawn',     script: 'scripts/scrape-city-of-fairlawn.js',        label: 'City of Fairlawn',             group: 'civicplus',      active: true  },
  { key: 'city_of_cuyahoga_falls', script: 'scripts/scrape-city-of-cuyahoga-falls.js', label: 'City of Cuyahoga Falls',     group: 'custom',         active: true  },
  { key: 'akron_marathon',       script: 'scripts/scrape-akron-marathon.js',          label: 'Akron Marathon',               group: 'custom',         active: true  },
  { key: 'akron_promise',        script: 'scripts/scrape-akron-promise.js',           label: 'Akron Promise',                group: 'custom',         active: true, defaultCategory: 'fitness' },
  { key: 'runsignup',            script: 'scripts/scrape-runsignup.js',               label: 'RunSignup',                    group: 'custom',         active: true, defaultCategory: 'fitness' },
  { key: 'akron_dance_festival', script: 'scripts/scrape-akron-dance-festival.js',    label: 'Heinz Poll Dance Festival',    group: 'custom',         active: true, defaultCategory: 'theater' },
  { key: 'gather_round_games',   script: 'scripts/scrape-gather-round-games.js',      label: 'Gather Round Games',           group: 'custom',         active: true, defaultCategory: 'games' },

  // ── Census wave 2026-07-14 ─────────────────────────────────────────────
  { key: 'cvsr',                 script: 'scripts/scrape-cvsr.js',                    label: 'Cuyahoga Valley Scenic Railroad', group: 'custom',      active: true, defaultCategory: 'outdoors' },
  { key: 'stow_library',         script: 'scripts/scrape-stow-library.js',            label: 'Stow-Munroe Falls Library',    group: 'custom',         active: true, defaultCategory: 'learning' },
  { key: 'christ_community_chapel', script: 'scripts/scrape-christ-community-chapel.js', label: 'Christ Community Chapel',  group: 'custom',         active: true  },
  { key: 'bath_township',        script: 'scripts/scrape-bath-township.js',           label: 'Bath Township',                group: 'civicplus',      active: true  },
  { key: 'wolf_creek_winery',    script: 'scripts/scrape-wolf-creek-winery.js',       label: 'The Winery at Wolf Creek',     group: 'wix',            active: true  },
  { key: 'danos_lakeside',       script: 'scripts/scrape-danos-lakeside.js',          label: "Dano's Lakeside Pub",          group: 'wordpress',      active: true, defaultCategory: 'music' },
  { key: 'hudson_library',       script: 'scripts/scrape-hudson-library.js',          label: 'Hudson Library & Historical Society', group: 'custom',  active: true, defaultCategory: 'learning' },
  { key: 'the_grove',            script: 'scripts/scrape-the-grove.js',               label: 'The Grove',                    group: 'custom',         active: true, defaultCategory: 'fitness' },
  { key: 'barnes_noble_akron',   script: 'scripts/scrape-barnes-noble-akron.js',      label: 'Barnes & Noble Akron',         group: 'api',            active: true, defaultCategory: 'learning' },
  { key: 'city_of_twinsburg',    script: 'scripts/scrape-city-of-twinsburg.js',       label: 'City of Twinsburg',            group: 'civicplus',      active: true  },
  { key: 'lake_campground',      script: 'scripts/scrape-lake-campground.js',         label: 'The Lake Campground',          group: 'custom',         active: true  },
  { key: 'hoppin_frog',          script: 'scripts/scrape-hoppin-frog.js',             label: "Hoppin' Frog Brewery",         group: 'wordpress',      active: true  },
  { key: 'peninsula_art_academy', script: 'scripts/scrape-peninsula-art-academy.js',  label: 'Peninsula Art Academy',        group: 'ics',            active: true, defaultCategory: 'visual-art' },
  { key: 'clutch_lanes',         script: 'scripts/scrape-clutch-lanes.js',            label: 'Clutch Lanes',                 group: 'custom',         active: true, defaultCategory: 'music' },
  { key: 'slovene_center',       script: 'scripts/scrape-slovene-center.js',          label: 'Slovene Performance & Events Center', group: 'wix',     active: true  },
  { key: 'explore_hudson',       script: 'scripts/scrape-explore-hudson.js',          label: 'Explore Hudson (Chamber)',     group: 'api',            active: true  },
  { key: 'leos_italian_social',  script: 'scripts/scrape-leos-italian-social.js',     label: "Leo's Italian Social",         group: 'squarespace',    active: true, defaultCategory: 'music' },
  { key: 'peninsula_library',    script: 'scripts/scrape-peninsula-library.js',       label: 'Peninsula Library',            group: 'custom',         active: true  },
  { key: 'lalas_in_the_lakes',   script: 'scripts/scrape-lalas-in-the-lakes.js',      label: "Lala's in the Lakes",          group: 'api',            active: true, defaultCategory: 'music' },
  { key: 'city_of_macedonia',    script: 'scripts/scrape-city-of-macedonia.js',       label: 'City of Macedonia',            group: 'custom',         active: true  },
  { key: 'peninsula_foundation', script: 'scripts/scrape-peninsula-foundation.js',    label: 'Peninsula Foundation (G.A.R. Hall)', group: 'wordpress', active: true, defaultCategory: 'music' },
  { key: 'islamic_society_akron', script: 'scripts/scrape-islamic-society-akron.js',  label: 'Islamic Society of Akron & Kent', group: 'wordpress',   active: true  },
  { key: 'peninsula_coffee_house', script: 'scripts/scrape-peninsula-coffee-house.js', label: 'Peninsula Coffee House',      group: 'wordpress',      active: true  },
  { key: 'akron_fossils',        script: 'scripts/scrape-akron-fossils.js',           label: 'Akron Fossils & Science Center', group: 'squarespace',  active: true, defaultCategory: 'learning' },
  { key: 'western_reserve_playhouse', script: 'scripts/scrape-western-reserve-playhouse.js', label: 'Western Reserve Playhouse', group: 'squarespace', active: true, defaultCategory: 'theater' },
  { key: 'tiki_underground',     script: 'scripts/scrape-tiki-underground.js',        label: 'Tiki Underground',             group: 'custom',         active: true, defaultCategory: 'music' },
  { key: 'hudson_bandstand',     script: 'scripts/scrape-hudson-bandstand.js',        label: 'Hudson Bandstand',             group: 'wordpress',      active: true, defaultCategory: 'music' },
  { key: 'learned_owl',          script: 'scripts/scrape-learned-owl.js',             label: 'The Learned Owl Book Shop',    group: 'custom',         active: true, defaultCategory: 'learning' },
  { key: 'rock_mill',            script: 'scripts/scrape-rock-mill.js',               label: 'Rock Mill Climbing',           group: 'custom',         active: true, defaultCategory: 'fitness' },
  { key: 'beaus_on_the_river',   script: 'scripts/scrape-beaus-on-the-river.js',      label: "Beau's on the River",          group: 'wordpress',      active: true, defaultCategory: 'music' },
  { key: 'raintree_golf',        script: 'scripts/scrape-raintree-golf.js',           label: 'Raintree Golf & Event Center', group: 'wordpress',      active: true, defaultCategory: 'sports' },
  { key: 'village_of_reminderville', script: 'scripts/scrape-village-of-reminderville.js', label: 'Village of Reminderville', group: 'wordpress',    active: true  },
  { key: 'bath_richfield_kiwanis', script: 'scripts/scrape-bath-richfield-kiwanis.js', label: 'Bath Richfield Kiwanis',      group: 'wordpress',      active: true  },
  { key: 'village_of_northfield', script: 'scripts/scrape-village-of-northfield.js',  label: 'Village of Northfield',        group: 'civicplus',      active: true  },
  { key: '750ml_wines',          script: 'scripts/scrape-750ml-wines.js',             label: '750ml Wines',                  group: 'wordpress',      active: true, defaultCategory: 'food' },
  { key: 'akron_power_squadron', script: 'scripts/scrape-akron-power-squadron.js',    label: 'Akron Sail & Power Squadron',  group: 'ics',            active: true  },
  { key: 'village_of_clinton',   script: 'scripts/scrape-village-of-clinton.js',      label: 'Village of Clinton',           group: 'wordpress',      active: true  },
  { key: 'akron_ymca',           script: 'scripts/scrape-akron-ymca.js',              label: 'Akron Area YMCA',              group: 'custom',         active: true, defaultCategory: 'fitness' },
  { key: 'cfalls_natatorium',    script: 'scripts/scrape-cfalls-natatorium.js',       label: 'The Natatorium (Cuyahoga Falls)', group: 'custom',      active: true, defaultCategory: 'fitness' },
  { key: 'heritage_farms',       script: 'scripts/scrape-heritage-farms.js',          label: 'Heritage Farms',               group: 'custom',         active: true  },
  { key: 'jewish_akron',         script: 'scripts/scrape-jewish-akron.js',            label: 'Jewish Akron',                 group: 'custom',         active: true  },
  { key: 'longwood_manor',       script: 'scripts/scrape-longwood-manor.js',          label: 'Longwood Manor Historical Society', group: 'custom',    active: true  },
  { key: 'west_side_gymnastics', script: 'scripts/scrape-west-side-gymnastics.js',    label: 'West Side Gymnastics',         group: 'ics',            active: true, defaultCategory: 'fitness' },
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
