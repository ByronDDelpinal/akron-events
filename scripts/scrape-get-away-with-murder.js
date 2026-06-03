/**
 * scrape-get-away-with-murder.js
 *
 * Fetches upcoming shows and workshops from Get Away With Murder, inc. —
 * an Akron immersive-theatre company specialising in murder-mystery
 * parties and acting workshops, headquartered at 1653 Merriman Rd.
 *
 * Platform: GAWM markets through a Weebly site
 * (getawaywithmurdermystery.weebly.com) but every actual ticketed event
 * lives on a 330tix.com organisation page:
 *   https://330tix.com/organizations/get-away-with-murder-killer-parties
 *
 * That page emits one clean Schema.org `@type:Event` JSON-LD block per
 * upcoming event (name, description, location, startDate/endDate with
 * TZ offset, offers, url) — same shape Kent Stage and Akron Civic use.
 * We fetch the org page and read the JSON-LD; no Weebly HTML scraping
 * needed.
 *
 * Why this scraper exists: GAWM is the last priority on the
 * Akron Life dwindle queue (~6 events in the Evvnt feed). All of their
 * events ticket via 330tix, but a generic 330tix scraper would mostly
 * duplicate Hale Farm — so we go directly to their org listing page on
 * 330tix instead.
 *
 * Usage:
 *   node scripts/scrape-get-away-with-murder.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
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

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'get_away_with_murder'
const SOURCE_URL  = 'https://330tix.com/organizations/get-away-with-murder-killer-parties'
const SITE_URL    = 'https://getawaywithmurdermystery.weebly.com'
const USER_AGENT  = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com)'

const VENUE_INFO = {
  name:    'Get Away With Murder Theatre',
  address: '1653 Merriman Rd',
  city:    'Akron',
  state:   'OH',
  zip:     '44313',
  // Approximate coords for the Sand Run / W Market corridor in NW Akron.
  lat:     41.1255,
  lng:     -81.5708,
  website: SITE_URL,
  description:
    "Immersive-theatre studio and home venue of Get Away With Murder, inc. — a Northeast Ohio " +
    "company producing murder-mystery parties, acting workshops, and short-run interactive shows.",
  parking_type:  'lot',
  parking_notes: 'On-site parking lot at 1653 Merriman Rd.',
}

const ORG_INFO = {
  name: 'Get Away With Murder, inc.',
  details: {
    website:     SITE_URL,
    description:
      'Akron-area immersive-theatre company. Produces ticketed murder-mystery parties, ' +
      'short-run interactive shows, and acting/audition workshops. Ticketing via 330tix.com.',
  },
}

// ── HTML fetch ────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── JSON-LD extraction (shared shape with Kent Stage / Akron Civic) ──────

function extractEvents(html) {
  const events = []
  const re = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    let parsed
    try { parsed = JSON.parse(m[1]) } catch { continue }
    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      const entries = item && item['@graph'] ? item['@graph'] : [item]
      for (const e of entries) {
        const t = e?.['@type']
        if (t === 'Event' || (Array.isArray(t) && t.includes('Event'))) events.push(e)
      }
    }
  }
  return events
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
}

// ── Category / tag mapping ───────────────────────────────────────────────

function mapCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase()
  // Audition / acting / workshop content → education; everything else
  // (murder mystery party, immersive show) → art.
  if (/\b(audition|workshop|class\b|lesson|coaching|training)\b/.test(text)) return 'education'
  return 'art'
}

function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['gawm', 'immersive-theatre', 'murder-mystery', 'akron']
  if (/audition/i.test(t))                 tags.push('audition', 'acting')
  if (/workshop|class\b/i.test(t))         tags.push('workshop')
  if (/dinner|party/i.test(t))             tags.push('dinner-theatre')
  if (/holiday|christmas|halloween/i.test(t)) tags.push('seasonal')
  return [...new Set(tags)]
}

// ── Process + upsert ─────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const now = Date.now()

  for (const ld of rawEvents) {
    try {
      const title = decodeEntities(ld.name)
      if (!title) { skipped++; continue }

      const startAt = ld.startDate ? new Date(ld.startDate).toISOString() : null
      if (!startAt) { skipped++; continue }
      const endAt   = ld.endDate   ? new Date(ld.endDate).toISOString()   : null

      // Past-event guard (1-day grace)
      if (new Date(startAt).getTime() < now - 86_400_000) { skipped++; continue }

      const rawDesc = typeof ld.description === 'string' ? ld.description : null
      const description = rawDesc ? stripHtml(decodeEntities(rawDesc)).slice(0, 2000) : null

      // 330tix gives us a usable ld.url pointing at the per-event ticket
      // page. ld.offers[0]?.url is the same URL in the cases I've seen,
      // so prefer ld.url and fall back through offers.
      const offers = Array.isArray(ld.offers) ? ld.offers : (ld.offers ? [ld.offers] : [])
      const offer  = offers[0] || {}
      const ticketUrl = ld.url || offer.url || SOURCE_URL
      const rawPrice = Number(offer.price)
      const priceMin = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null

      // Image isn't always provided by 330tix; pass through when present.
      const imageUrl =
        typeof ld.image === 'string' ? ld.image
        : Array.isArray(ld.image)    ? ld.image[0]
        : (ld.image?.url ?? null)

      // Source ID: stable per-event 330tix slug from the ld.url, with
      // the start-date suffix so recurring titles (e.g. "Secrets to
      // Audition Success" running monthly) don't collide.
      const slug    = ld.url?.match(/\/events\/([^/?#]+)/)?.[1] ?? null
      const dateKey = startAt.slice(0, 10)
      const sourceId = slug ? `${slug}` : `${title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}-${dateKey}`

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category:        mapCategory(title, description ?? ''),
        tags:            mapTags(title),
        price_min:       priceMin,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          SOURCE_KEY,
        source_id:       sourceId,
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
        continue
      }
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ld?.name}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🔪  Starting Get Away With Murder ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address:       VENUE_INFO.address,
      city:          VENUE_INFO.city,
      state:         VENUE_INFO.state,
      zip:           VENUE_INFO.zip,
      lat:           VENUE_INFO.lat,
      lng:           VENUE_INFO.lng,
      website:       VENUE_INFO.website,
      description:   VENUE_INFO.description,
      parking_type:  VENUE_INFO.parking_type,
      parking_notes: VENUE_INFO.parking_notes,
    })
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html = await fetchHtml(SOURCE_URL)
    const rawEvents = extractEvents(html)
    console.log(`  Found ${rawEvents.length} JSON-LD events`)

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
