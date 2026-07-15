/**
 * scrape-peninsula-foundation.js
 *
 * The Peninsula Foundation — a preservation nonprofit in the village of
 * Peninsula (Cuyahoga Valley), Summit County. Beyond its historic-preservation
 * mission it runs the beloved G.A.R. Hall concert series: a nearly nightly
 * schedule of bluegrass, folk, Americana, blues, and roots-music shows, plus a
 * monthly "Grass Jam," the occasional "Poetry in the Valley" reading, and (from
 * time to time) local-history talks. Those public events are exactly what Akron
 * Pulse surfaces.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Royal Palace / Indivisible Akron / Summit Artspace scrapers.
 *   https://thepeninsulafoundation.org/wp-json/tribe/events/v1/events
 *
 * Domain quirk: the public site is peninsulahistory.org, but its WordPress
 * install (and therefore every REST/event URL) is served from the canonical
 * thepeninsulafoundation.org host — both resolve to the same Tribe API. We hit
 * the canonical host directly so stored URLs match what the API emits.
 *
 * Venue: every event to date is at G.A.R. Hall (1785 Main St, Peninsula). We
 * reuse the EXACT venue name "G.A.R. Hall" that the Peninsula Art Academy
 * scraper already mints for its off-site events, so ensureVenue dedupes onto the
 * one canonical venue record rather than creating a second. Events are still
 * pinned per-event from the Tribe `venue` object (not a hard-coded constant), so
 * an off-site Foundation event would carry its real venue — guarded by the
 * strict Summit County gate below.
 *
 * Geography: Peninsula is inside Summit County (on the SUMMIT_COUNTY_CITIES
 * allowlist). Each event is classified via classifySummitLocation on its venue
 * city: 'out' → skipped; 'unknown' (missing/blank city) → ingested as
 * pending_review; 'in' → published.
 *
 * Category: the Tribe feed carries NO categories/tags, so we classify from the
 * event TITLE. History/educational-format events (talks, lectures, tours,
 * genealogy, preservation programs) → 'learning'; poetry readings → 'learning'
 * (spoken-word, not a concert); everything else at this concert hall → 'music'.
 * Title-only on purpose: performer bios in the description are riddled with
 * incidental uses of these words (e.g. "elevating his poetry") that would
 * wrongly pull concerts into 'learning'.
 * We pass a definitive `categories` array (not a `category` hint),
 * which bypasses upsertEventSafe's text inference for the content axis — that
 * inference was misfiring on this source (tagging bluegrass acts 'visual-art').
 *
 * Price: the feed's cost field is empty for every show (tickets are sold via
 * external links, donations at the door), so price is left null — never assume
 * free. The Grass Jam's "$5 donation appreciated" is a donation, not a ticket
 * price, so it is deliberately not parsed as price.
 *
 * Usage:   node scripts/scrape-peninsula-foundation.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, fetchSchemaDescription,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, easternToIso,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'peninsula_foundation'
const BASE_URL   = 'https://thepeninsulafoundation.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

const ORG_NAME = 'Peninsula Foundation'
const ORG_DETAILS = {
  website: 'https://www.peninsulahistory.org',
  description:
    'The Peninsula Foundation is a preservation nonprofit in the Cuyahoga Valley village of Peninsula that hosts the G.A.R. Hall bluegrass, folk, and roots-music concert series along with local-history programming.',
}

// ── Categorization ───────────────────────────────────────────────────────────

// History / educational-FORMAT signals (a talk, lecture, tour, genealogy or
// preservation program, or a poetry reading) rather than a concert. Matched on
// the TITLE only: this is a concert hall and performer bios are riddled with
// incidental uses of these words ("elevating his poetry", "workshopped the
// album", a song "about history"), which would wrongly pull real concerts into
// 'learning'. Non-concert events here are always titled as what they are
// ("Poetry in the Valley", "A Talk on…", "Walking Tour of…").
const LEARNING_TITLE_RE =
  /\b(history|historical|lecture|talk|presentation|genealog|preservation|walking tour|guided tour|home\s?school|homeschool|seminar|workshop|poetry|open mic|open-mic)\b/i

/**
 * Content category from an event's title. G.A.R. Hall is a concert hall, so the
 * Foundation's public programming is overwhelmingly music; the documented
 * exceptions are history/educational-format events and poetry readings, which
 * map to 'learning'. Returns 'music' otherwise. Exported for tests.
 */
export function parseCategory(title = '') {
  return LEARNING_TITLE_RE.test(title) ? 'learning' : 'music'
}

/** Genre/format tags detected from the title + description. */
export function mapTags(title = '', description = '') {
  const text = `${title} ${stripHtml(description)}`.toLowerCase()
  const isMusic = parseCategory(title) === 'music'
  const tags = ['peninsula', 'g-a-r-hall']
  if (isMusic) {
    tags.push('live-music')
    // Genre tags only make sense for the music events; drawing them from the
    // full description is fine here since a poetry/history event won't reach
    // this branch (parseCategory keys off the title).
    if (/\bbluegrass|grass jam|old[- ]?time|banjo|fiddle|mandolin\b/i.test(text)) tags.push('bluegrass')
    if (/\bfolk\b/i.test(text))                  tags.push('folk')
    if (/\bamericana|roots music\b/i.test(text)) tags.push('americana')
    if (/\bblues\b/i.test(text))                 tags.push('blues')
    if (/\bjazz\b/i.test(text))                  tags.push('jazz')
    if (/\bcountry\b/i.test(text))               tags.push('country')
  } else {
    // Non-music (learning) tags, keyed off the title like parseCategory.
    if (/\bpoetry|open mic|open-mic\b/i.test(title)) tags.push('poetry')
    if (/\bhistory|historical|preservation\b/i.test(title)) tags.push('history')
  }
  return [...new Set(tags)]
}

/**
 * Convert the feed's local wall-clock string to a correct UTC ISO instant,
 * treating it as Eastern (DST-aware) via easternToIso. We deliberately do NOT
 * trust utc_start_date: sibling Tribe installs in this family ship a
 * misconfigured "UTC+0" timezone where utc_start_date is really Eastern-clock
 * labelled as UTC (appending 'Z' would shift shows 4–5h early). start_date is
 * Eastern wall-clock in both the correct and the broken config, so this is
 * correct whether or not the install's tz is ever misconfigured. Returns null
 * when the field is missing/unparseable. Exported for tests.
 */
export function toEasternIso(localDateTime) {
  if (!localDateTime) return null
  return easternToIso(String(localDateTime).replace('T', ' '))
}

/** Stable per-occurrence source_id (Tribe recurring series can repeat ids). */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/**
 * Normalize the Tribe `venue` field (object, or an array of one) into
 * { name, details, city } for ensureVenue, or null when no venue is attached.
 * Reuses the source's own venue name verbatim so "G.A.R. Hall" dedupes onto the
 * canonical record shared with the Peninsula Art Academy scraper. Exported for
 * tests.
 */
export function parseVenue(ev) {
  let v = ev?.venue
  if (Array.isArray(v)) v = v[0]
  if (!v || !v.venue) return null
  const name = stripHtml(v.venue)
  if (!name) return null
  const lat = v.geo_lat != null && v.geo_lat !== '' ? Number(v.geo_lat) : null
  const lng = v.geo_lng != null && v.geo_lng !== '' ? Number(v.geo_lng) : null
  return {
    name,
    city: v.city || null,
    details: {
      address: v.address || null,
      city:    v.city || null,
      state:   v.state || v.stateprovince || 'OH',
      zip:     v.zip || null,
      lat:     Number.isFinite(lat) ? lat : null,
      lng:     Number.isFinite(lng) ? lng : null,
    },
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Peninsula Foundation events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)' },
      redirect: 'follow',
    })
    // Tribe returns 400 with a "no results" code when the window is empty —
    // treat that as zero events rather than an error.
    if (res.status === 400) break
    if (!res.ok) throw new Error(`Peninsula Foundation API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

    const data   = await res.json()
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++
    if (hasMore) await new Promise((r) => setTimeout(r, 200))
  }
  return all
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      // Tribe local wall-clock start (Eastern). We convert start_date via
      // easternToIso (see toEasternIso) rather than trusting utc_start_date, so a
      // "UTC+0" tz misconfiguration on this install can never shift shows early.
      // start_date carries the show time, so this never lands on a bare midnight.
      const startAt = toEasternIso(ev.start_date)
      if (!startAt) { skipped++; continue }

      // Per-event venue + strict Summit gate.
      const venue = parseVenue(ev)
      const locality = classifySummitLocation({
        lat: venue?.details?.lat, lng: venue?.details?.lng, city: venue?.city,
      })
      if (locality === 'out') { skipped++; continue }
      const status = locality === 'in' ? 'published' : 'pending_review'
      const needsReview = locality !== 'in'

      let venueId = null
      if (venue) venueId = await ensureVenue(venue.name, venue.details)

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)

      let descText = stripHtml(ev.description)
      if (!descText && ev.url) descText = (await fetchSchemaDescription(ev.url)) ?? ''

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          toEasternIso(ev.end_date),
        // Deterministic single category: this is a concert hall, so text
        // inference (which otherwise runs when only a `category` hint is passed)
        // was misfiring — tagging bluegrass acts 'visual-art'. Passing a
        // `categories` ARRAY bypasses inference for the content axis entirely.
        categories:      [parseCategory(ev.title)],
        tags:            mapTags(ev.title, ev.description),
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       ev.image?.url ?? null,
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status,
        needs_review:    needsReview,
        featured:        ev.featured ?? false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
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
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎻  Starting Peninsula Foundation ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(ORG_NAME, ORG_DETAILS)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)

    // Best-effort ownership link: tie the org to the G.A.R. Hall venue if it
    // exists (created during processEvents or by the Art Academy scraper).
    if (organizerId) {
      const venueId = await ensureVenue('G.A.R. Hall', {
        address: '1785 Main St', city: 'Peninsula', state: 'OH', zip: '44264',
      })
      if (venueId) await linkOrganizationVenue(organizerId, venueId)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
