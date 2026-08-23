/**
 * scrape-akron-zips.js
 *
 * Ingests University of Akron (Zips) athletics HOME games from the gozips.com
 * composite calendar — a Sidearm Sports site that publishes every sport as a
 * single RFC 5545 iCalendar feed.
 *
 * Scope: home games only (games at Akron venues), all sports — mirroring the
 * RubberDucks scraper's home-only convention. Away games (in other cities) and
 * non-games (BYE weeks) are skipped.
 *
 * Usage:
 *   node scripts/scrape-akron-zips.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  parseIcs,
  fetchIcsFeed,
  icsDateToIso,
  icsDateOnlyToNoonIso,
  withDateOnlyTimeNote,
} from './lib/ics.js'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'

const SOURCE = 'akron_zips'
// Composite calendar for all sports (sport_id=0 = every sport).
const FEED_URL = 'https://gozips.com/calendar.ashx/calendar.ics?sport_id=0'
const TICKETS_URL = 'https://gozips.com/tickets'

// ── Pure parsing helpers (exported for tests) ────────────────────────────────

/** Strip a leading result/marker token like "[W] " / "[L] " / "[N] ". */
export function stripResultMarker(summary = '') {
  return summary.replace(/^\s*\[[A-Za-z]\]\s*/, '').trim()
}

/**
 * Pull a clean venue name out of an ICS LOCATION. The gozips formats vary:
 *   "Akron, Ohio, InfoCision Stadium - Summa Health Field"
 *   "Firestone Stadium | Akron, Ohio"
 *   "Akron, Ohio, James A. Rhodes Arena "
 * We drop the city/state tokens and keep the remaining venue segment.
 */
export function parseVenueName(location = '') {
  const parts = location.split(/[|,]/).map((s) => s.trim()).filter(Boolean)
  const venueParts = parts.filter((p) => !/^(akron|ohio|oh)$/i.test(p))
  const name = venueParts.join(', ').trim()
  return name || 'University of Akron'
}

/** Lowercase kebab slug for a sport name, e.g. "Women's Volleyball" → "womens-volleyball". */
function sportSlug(sport = '') {
  return sport
    .toLowerCase()
    .replace(/['’]/g, '')            // women's → womens (not women-s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Turn a raw VEVENT into a normalized Zips home-game row, or null if it should
 * be skipped (away game, non-Akron, BYE week, no date, in the past).
 *
 * @param {object} ev   raw VEVENT from parseIcs()
 * @param {Date}   now  reference "now" for the past-game filter (default: real now)
 */
export function parseZipsGame(ev, now = new Date()) {
  const rawSummary = (ev.SUMMARY || '').trim()
  if (!rawSummary) return null

  const summary = stripResultMarker(rawSummary)
  const location = (ev.LOCATION || '').trim()

  // Skip non-games (bye weeks, placeholders).
  if (/\bbye\b/i.test(summary)) return null

  // Home games only: must be a "vs" matchup AND at an Akron venue.
  const isVs = /\bvs\.?\b/i.test(summary)
  const inAkron = /akron,\s*(ohio|oh)\b/i.test(location)
  if (!isVs || !inAkron) return null

  let startAt = ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null
  if (!startAt) return null

  // SANCTIONED-DEFAULT-TIME — see icsDateOnlyToNoonIso in lib/ics.js. This
  // scraper parses VEVENTs itself instead of going through normaliseIcsEvent,
  // so it has to apply the same noon default: a bare-date DTSTART yields
  // 00:00 ET from icsDateToIso, and every feed filters `start_at >= now()`
  // with no grace window, so the row disappears on the morning it happens.
  // Gate on the RAW value via icsDateOnlyToNoonIso's "null unless bare date"
  // contract, not on the VALUE=DATE param: a VALUE=DATE property that
  // nonetheless carries a real clock time has a time we must not overwrite.
  // Applied before the past-game filter so the comparison sees the stored
  // start, not the midnight we are about to discard.
  const noonIso = icsDateOnlyToNoonIso(ev.DTSTART.value)
  const timeSynthesized = noonIso !== null
  if (timeSynthesized) startAt = noonIso

  if (new Date(startAt) < now) return null // past game

  let endAt = ev.DTEND ? icsDateToIso(ev.DTEND.value, ev.DTEND.params) : null

  // Pushing the start forward 12 hours can invert the interval — a same-day
  // DTEND, or the RFC's exclusive next-day date-only DTEND read as midnight,
  // would now end before it begins. Drop the end rather than store a negative
  // duration. NaN <= n is false, so a malformed end falls through untouched.
  if (timeSynthesized && endAt && Date.parse(endAt) <= Date.parse(startAt)) endAt = null

  // "University of Akron <Sport> vs <Opponent>" → sport + opponent
  const m = summary.match(/^University of Akron\s+(.+?)\s+vs\.?\s+(.+)$/i)
  const sport = m ? m[1].trim() : summary.replace(/^University of Akron\s+/i, '').trim()
  const matchup = summary.replace(/^University of Akron\s+/i, '').trim() // "Football vs Robert Morris"
  const title = `Akron Zips ${matchup}`

  // game id from UID "vcal_11322-admin.gozips.com" → "11322"
  const uid = (ev.UID || '').trim()
  const idMatch = uid.match(/vcal_(\d+)/i)
  const sourceId = idMatch ? idMatch[1] : (uid || null)
  if (!sourceId) return null

  const venueName = parseVenueName(location)
  const slug = sportSlug(sport)
  const tags = ['sports', 'zips', 'college', 'university-of-akron', 'family']
  if (slug) tags.push(slug)

  const rawDesc = stripHtml(ev.DESCRIPTION || '').trim()
  let description = rawDesc
    ? rawDesc.slice(0, 5000)
    : `University of Akron Zips ${sport} home game${venueName ? ` at ${venueName}` : ''}.`

  // The invented noon must never be silent. Appended LAST, after the fallback
  // prose: the boilerplate must not feed category/tag inference downstream.
  if (timeSynthesized) description = withDateOnlyTimeNote(description)

  return { title, description, startAt, endAt, venueName, sourceId, sport, tags, timeSynthesized }
}

// ── Venue / Organizer ────────────────────────────────────────────────────────

async function ensureZipsOrganizer() {
  return ensureOrganization('University of Akron Athletics', {
    website:     'https://gozips.com',
    description: 'University of Akron Zips — NCAA Division I athletics (Mid-American Conference), competing in football, basketball, baseball, soccer, volleyball and more.',
  })
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processGames(games, organizerId) {
  let inserted = 0, skipped = 0
  const venueCache = new Map()

  for (const g of games) {
    try {
      let venueId = venueCache.get(g.venueName)
      if (venueId === undefined) {
        venueId = await ensureVenue(g.venueName, { city: 'Akron', state: 'OH' })
        venueCache.set(g.venueName, venueId)
        if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)
      }

      const row = {
        title:           g.title,
        description:     g.description,
        start_at:        g.startAt,
        end_at:          g.endAt,
        category:        'sports',
        tags:            g.tags,
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       null,
        ticket_url:      TICKETS_URL,
        source:          SOURCE,
        source_id:       g.sourceId,
        status:          'published',
        featured:        false,
        // Noon was invented (see SANCTIONED-DEFAULT-TIME above): flag for the
        // review queue, the only audit trail we have for an invented time.
        // needs_review does not change `status`, so the row stays published.
        ...(g.timeSynthesized ? { needs_review: true } : {}),
      }

      const enrichedRow = await enrichWithImageDimensions(row, { organizationId: organizerId })
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${g.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting University of Akron (Zips) athletics ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureZipsOrganizer()

    console.log(`\n🔍  Fetching ${FEED_URL}…`)
    // The gozips composite feed (sport_id=0) is large/slow; the default 20s
    // timeout in fetchIcsFeed was aborting runs on transient upstream slowness.
    const icsText = await fetchIcsFeed(FEED_URL, { timeoutMs: 45_000 })
    const rawEvents = parseIcs(icsText)
    console.log(`  Parsed ${rawEvents.length} VEVENT blocks`)

    const games = rawEvents.map((ev) => parseZipsGame(ev)).filter(Boolean)
    console.log(`  ${games.length} upcoming home games after filtering`)

    if (games.length === 0) {
      await logUpsertResult(SOURCE, 0, 0, 0, {
        status: rawEvents.length === 0 ? 'error' : 'ok',
        errorMessage: rawEvents.length === 0
          ? 'Feed parsed 0 VEVENTs — gozips iCal structure may have changed.'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: rawEvents.length,
      })
      console.warn('  ⚠ No upcoming home games to ingest.')
      process.exit(0)
    }

    console.log(`\n📥  Processing ${games.length} games…`)
    const { inserted, skipped } = await processGames(games, organizerId)

    await logUpsertResult(SOURCE, inserted, 0, skipped, {
      eventsFound: games.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE, err, start)
    process.exit(1)
  }
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
