/**
 * scrape-gather-round-games.js
 *
 * Gather 'Round Games & Collectibles — a TCG / board-game store at 121 Ghent Rd,
 * Fairlawn (Summit County). Pokémon, Magic, Lorcana, One Piece, board games.
 *
 * PLATFORM SWITCH (2026-08): grgcollect.com migrated off Wix **Bookings**
 * (recurring "service" pages we rendered with Puppeteer) onto the Wix **Events**
 * app — an /event-list page of /event-details/<slug> events. We now read it with
 * the shared lib/wix-events.js (#wix-warmup-data JSON, no Puppeteer). The old
 * homepage `/service-page/` anchors are gone, which is why the Bookings scraper
 * reported "0 services found". gatherround.net (Squarespace) still has no events.
 *
 * SCOPE (unchanged, per byron): publish only the recurring COMMUNITY PLAY NIGHTS
 * (Trade Night, Friday Night Magic, League Play, Game Night). Drop the set-launch
 * product events (prereleases, drafts, commander parties, set debuts). The
 * Bookings source let us infer this from recurrence; Wix Events carries no
 * recurrence signal, so we ALLOWLIST community-night titles instead (isCommunityNight).
 *
 * All events are at the one Fairlawn store (Summit County), so no geo gate.
 * Price is left null (RSVP events state no fee; never assumed). Category games.
 *
 * Usage:   node scripts/scrape-gather-round-games.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { fetchWixEvents, normaliseWixEvent } from './lib/wix-events.js'

export const SOURCE_KEY = 'gather_round_games'
const SITE       = 'https://www.grgcollect.com'
const EVENTS_URL = `${SITE}/event-list`
const ORG_NAME   = "Gather 'Round Games & Collectibles"
const VENUE = {
  name: ORG_NAME, address: '121 Ghent Rd', city: 'Fairlawn', state: 'OH', zip: '44333',
  website: 'https://www.gatherround.net',
}

// ── Scope filter (exported for tests) ───────────────────────────────────────

/**
 * True when a title is a recurring COMMUNITY PLAY NIGHT we want to publish.
 * Everything else — the set-named product events (prereleases, drafts, commander
 * parties, "The Hobbit: …", "Vendetta Pre-Rift") — is dropped. Allowlist, not a
 * release denylist, because the Wix Events feed has no recurrence signal and the
 * set events are too varied to enumerate.
 */
export function isCommunityNight(title) {
  return /(trade night|friday night magic|\bfnm\b|league play|game night|open play|open gaming|casual play|learn to play|board game night)/i
    .test(String(title || ''))
}

/** Tags from the event title + description. */
export function buildTags(title, description) {
  const t = `${title || ''} ${description || ''}`.toLowerCase()
  const tags = ['tcg', 'game-night', 'tabletop']
  if (/pok[eé]mon/.test(t))        tags.push('pokemon')
  if (/magic|mtg|\bfnm\b/.test(t)) tags.push('magic-the-gathering')
  if (/lorcana/.test(t))           tags.push('lorcana')
  if (/one piece/.test(t))         tags.push('one-piece')
  if (/\bdraft\b/.test(t))         tags.push('draft')
  if (/trade|trading/.test(t))     tags.push('trading')
  return [...new Set(tags)]
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎲  Starting Gather Round Games (Wix Events) ingestion…')
  const start = Date.now()
  try {
    const all = await fetchWixEvents(EVENTS_URL)
    const events = all.filter((ev) => isCommunityNight(ev?.title))
    console.log(`  ${all.length} event(s) on the calendar → ${events.length} community night(s) to publish`)

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: VENUE.website,
      description: "Gather 'Round Games & Collectibles is a family-owned TCG and board-game store in Fairlawn (Pokémon, Magic, Lorcana, One Piece) hosting community game nights and tournaments.",
    })
    const venueId = await ensureVenue(VENUE.name, {
      address: VENUE.address, city: VENUE.city, state: VENUE.state, zip: VENUE.zip, website: VENUE.website,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    let inserted = 0, skipped = 0
    for (const ev of events) {
      const row = normaliseWixEvent(ev, {
        source:      SOURCE_KEY,
        mapCategory: () => 'games',
        mapTags:     (e) => buildTags(e.title, e.description || e.about),
        ageRestriction: 'all_ages',
        siteBaseUrl: SITE,
      })
      if (!row.start_at || !row.title) { skipped++; continue }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
      console.log(`  ✓ ${row.title} (${row.start_at.slice(0, 10)})`)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
