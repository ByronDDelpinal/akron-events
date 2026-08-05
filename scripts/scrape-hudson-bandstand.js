/**
 * scrape-hudson-bandstand.js
 *
 * Scrapes the Hudson Bandstand summer concert series — a free, family-friendly
 * live-music series (since 1977) on the Hudson Green in downtown Hudson, Ohio
 * (Summit County).
 *
 * SOURCE MIGRATION (2026-08): the series used to live on a single hand-built
 * WordPress page at myhcf.org/hudson-bandstand-2/. The Hudson Community
 * Foundation removed that page (real HTTP 404) and moved every Hudson event to
 * a new community calendar, "Hudson Happenings", built on Localist Event
 * Calendar Software at https://events.hudsonhappenings.org. Localist exposes a
 * standard whole-calendar iCalendar feed at /calendar/1.ics (RFC 5545,
 * icalendar-ruby, UTC "Z" DTSTART/DTEND), so we now consume that feed via the
 * shared lib/ics.js primitives instead of parsing bespoke HTML.
 *
 * Scope: the Hudson Happenings feed carries EVERY Hudson event (library
 * programs, city meetings, farmers market, other greens' concert series, …).
 * The Bandstand concerts are the subset staged at the town green's bandstand
 * gazebo. They are identified by BOTH:
 *   • LOCATION = "Gazebo and Clocktower Greens" (the historic town green), and
 *   • GEO      = "41.240056;-81.440667"          (the bandstand gazebo point).
 * Requiring both cleanly separates the concert series from the other events
 * that share the green — e.g. "Destination Hudson Art & Wine" sits at the same
 * LOCATION but a different GEO (art festival, excluded), and the one-off
 * "Back to the Bandstand Ribbon Cutting" carries LOCATION "Main Green with
 * Gazebo" and a different GEO (excluded). See isBandstandConcert().
 *
 * Time: every concert begins at 6:30 p.m. Eastern; the feed already encodes
 * that as a real UTC DTSTART (e.g. 20260712T223000Z = 6:30 p.m. EDT), so we
 * take the feed's time verbatim — no invented default (the stan_hywet lesson).
 *
 * Geography: single fixed venue — the Hudson Green in downtown Hudson (44236),
 * Summit County — so every event publishes directly (no classifySummitLocation
 * needed; the Summit County gate is satisfied by construction). Reuses the
 * existing "Hudson Green" venue that scrape-city-of-hudson mints so the two
 * Hudson sources share one venue row (ensureVenue matches by exact name;
 * dedupe buckets by venue).
 *
 * Category: asserted explicitly as ['music'] (a `categories` array, not a
 * `category` hint) so text inference can't add spurious tags from band names —
 * e.g. "80's Vinyl Arcade" would otherwise trip the 'games' classifier on
 * "Arcade". Every event in this source is unambiguously a live concert.
 *
 * Pricing: the series is free — price is set to 0 explicitly, not assumed.
 *
 * source_id stays the date-keyed `hudson-bandstand-YYYY-MM-DD` (Eastern date of
 * the concert) it always was, so the source migration UPDATES the existing
 * published rows rather than duplicating them.
 *
 * Usage:
 *   node scripts/scrape-hudson-bandstand.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
} from './lib/normalize.js'
import { fetchIcsFeed, parseIcs, icsDateToIso } from './lib/ics.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY = 'hudson_bandstand'
// Whole-calendar Localist iCalendar feed (all Hudson Happenings events).
const FEED_URL = 'https://events.hudsonhappenings.org/calendar/1.ics'
// Public calendar the events live on — used as the organizer site + ticket URL
// fallback when a VEVENT omits its own URL.
const CALENDAR_URL = 'https://events.hudsonhappenings.org'
const DAYS_AHEAD = 180

// The two-signal fingerprint of a Bandstand concert on the shared calendar.
const BANDSTAND_LOCATION = 'Gazebo and Clocktower Greens'
const BANDSTAND_GEO = '41.240056;-81.440667'

// A cancelled/postponed concert names it in the title/description — drop it
// rather than publish. Same convention lib/civicplus.js uses.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/**
 * True when a parsed VEVENT is a Hudson Bandstand concert: it is staged at the
 * town green's bandstand gazebo (LOCATION + GEO both match). Requiring both
 * signals excludes the other events that share the green (art festival at a
 * different GEO, ribbon cutting at a different LOCATION) without an ad-hoc
 * title blocklist. If the calendar ever renames the venue or nudges the
 * coordinates, this yields zero rows (a visible logged signal), never a
 * silently mis-scoped ingest.
 */
export function isBandstandConcert(ev = {}) {
  const location = (ev.LOCATION || '').trim()
  const geo = (ev.GEO || '').trim()
  return location === BANDSTAND_LOCATION && geo === BANDSTAND_GEO
}

/** America/New_York calendar date ("YYYY-MM-DD") for an ISO instant. */
export function easternDateOf(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // en-CA renders ISO-order YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/**
 * Collapse an ICS DESCRIPTION (already \n-unescaped by parseIcs) into a single
 * clean paragraph: runs of whitespace/newlines become one space. ICS text
 * carries no HTML, so no stripHtml is needed.
 */
export function cleanDescription(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * Build an event row from a parsed Bandstand VEVENT, or null to skip
 * (cancelled, or an unparseable start). Pure — no DB, no clock-dependent
 * horizon filtering (that lives in processEvents), so tests can assert on it
 * directly against the fixture regardless of the wall clock.
 */
export function buildRow(ev = {}) {
  const band = (ev.SUMMARY || '').trim()
  if (!band) return null

  // Skip a cancelled/postponed concert rather than publishing it.
  const rawDesc = ev.DESCRIPTION || ''
  if (CANCELLED_RE.test(band) || CANCELLED_RE.test(rawDesc)) return null

  const startAt = ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null
  if (!startAt) return null
  const endAt = ev.DTEND ? icsDateToIso(ev.DTEND.value, ev.DTEND.params) : null

  const dateStr = easternDateOf(startAt)
  if (!dateStr) return null

  const descParts = [
    `${band} performs live at the Hudson Bandstand free summer concert ` +
    `series on the Hudson Green in downtown Hudson, Ohio.`,
  ]
  const feedDesc = cleanDescription(rawDesc)
  if (feedDesc) descParts.push(feedDesc)

  return {
    row: {
      title: `Hudson Bandstand: ${band}`,
      description: descParts.join(' '),
      start_at: startAt,
      end_at: endAt,
      // Assert the category explicitly (a `categories` array, not a `category`
      // hint) so inference can't add e.g. 'games' from "80's Vinyl Arcade".
      categories: ['music'],
      tags: ['live-music', 'concert', 'hudson-ohio', 'summit-county', 'free'],
      // Series is explicitly free — set 0, don't assume.
      price_min: 0,
      price_max: 0,
      is_family: true,
      age_restriction: 'all_ages',
      // No per-concert photos on the feed; leave null rather than probe a
      // generic banner once per event on every run.
      image_url: null,
      // The Localist per-event page, falling back to the calendar home.
      ticket_url: (ev.URL || '').trim() || CALENDAR_URL,
      source: SOURCE_KEY,
      source_id: `hudson-bandstand-${dateStr}`,
      status: 'published',
      featured: false,
    },
    startMs: new Date(startAt).getTime(),
  }
}

// ── Venue / Organizer ───────────────────────────────────────────────────────

async function ensureBandstandVenue() {
  // Name/address match scrape-city-of-hudson's defaultVenue so both Hudson
  // sources share ONE venue row (ensureVenue matches by exact name).
  return ensureVenue('Hudson Green', {
    address: '1 Clinton St',
    city: 'Hudson',
    state: 'OH',
    zip: '44236',
    lat: 41.2423,
    lng: -81.4405,
    website: 'https://www.hudson.oh.us',
    description:
      'The historic town green in downtown Hudson, Ohio, home to the Hudson ' +
      'Bandstand gazebo and host to free community concerts, festivals, and ' +
      'markets through the summer season.',
  })
}

async function ensureBandstandOrganizer() {
  return ensureOrganization('Hudson Bandstand', {
    website: CALENDAR_URL,
    description:
      'All-volunteer committee that has presented the free Hudson Bandstand ' +
      'summer concert series on the Hudson Green since 1977, supported by ' +
      'sponsors and donors through the Hudson Community Foundation.',
  })
}

// ── Process ─────────────────────────────────────────────────────────────────

async function processEvents(events, venueId, organizerId) {
  const now = Date.now()
  const horizon = now + DAYS_AHEAD * 86400_000
  let inserted = 0
  let skipped = 0
  const seenIds = new Set()

  for (const ev of events) {
    try {
      if (!isBandstandConcert(ev)) {
        skipped++
        continue
      }

      const built = buildRow(ev)
      if (!built) {
        skipped++
        continue
      }
      const { row, startMs } = built

      // Skip past concerts (ended > ~1 day ago) and anything beyond the horizon.
      if (startMs < now - 86400_000 || startMs > horizon) {
        skipped++
        continue
      }

      // One concert per date in practice; guard against a duplicate date anyway.
      if (seenIds.has(row.source_id)) {
        const slug = (ev.SUMMARY || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        row.source_id = `${row.source_id}-${slug}`
      }
      seenIds.add(row.source_id)

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.SUMMARY}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Hudson Bandstand ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureBandstandVenue(),
      ensureBandstandOrganizer(),
    ])
    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    console.log(`\n🔍  Fetching ${FEED_URL}…`)
    const icsText = await fetchIcsFeed(FEED_URL)
    const allEvents = parseIcs(icsText)
    const concerts = allEvents.filter(isBandstandConcert)
    console.log(`  Parsed ${allEvents.length} VEVENTs; ${concerts.length} are Bandstand concerts`)

    if (concerts.length === 0) {
      console.warn('  ⚠ No Bandstand concerts matched. If unexpected, the calendar may have renamed the "Gazebo and Clocktower Greens" venue or moved its coordinates — inspect the feed and update BANDSTAND_LOCATION/BANDSTAND_GEO.')
    }

    console.log(`\n📥  Processing ${concerts.length} concerts…`)
    const { inserted, skipped } = await processEvents(concerts, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: concerts.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
