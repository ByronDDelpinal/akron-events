/**
 * scrape-akron-civic.js
 *
 * Scrapes upcoming shows from the Akron Civic Theatre. As of 2026-06,
 * the Civic publishes its event calendar to two domains:
 *
 *   • akroncivic.com  — legacy Bolt CMS, plain-text listing
 *   • theatreakron.com — modern WordPress build with Schema.org
 *     Event JSON-LD on every page (~10–12 upcoming shows surface on
 *     the homepage at a time)
 *
 * We use theatreakron.com because the JSON-LD is structurally richer
 * and far less fragile than parsing the Bolt CMS three-line-block
 * text format. Same venue, same events; this just switches sources.
 *
 * Strategy:
 *   1. GET https://www.theatreakron.com/ (homepage carries the
 *      JSON-LD Event list).
 *   2. Walk every <script type="application/ld+json"> block, flatten
 *      @graph entries, and keep @type="Event" rows.
 *   3. For each event extract name, startDate (ISO + TZ), location,
 *      url, image, description — same fields the existing pipeline
 *      uses.
 *   4. Route sub-venue events (The Knight Stage, Wild Oscar's, PNC
 *      Plaza) to their own venue record via the CIVIC_VENUES
 *      dispatcher when the event title or description names them;
 *      otherwise default to the main Akron Civic Theatre venue.
 *
 * Migration note (2026-06): this scraper used to parse the legacy
 * Bolt CMS HTML at akroncivic.com/view-all-shows. theatreakron.com
 * is the same venue's modern WordPress site and exposes structured
 * data instead of text we had to regex out. Both domains are owned
 * by the Akron Civic Theatre.
 *
 * Usage:
 *   node scripts/scrape-akron-civic.js
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
  ensureVenue as ensureVenueGeneric,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'akron_civic'
const SOURCE_URL  = 'https://www.theatreakron.com/'
const USER_AGENT  = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com)'

// Known sub-venues inside the Akron Civic complex. Keys are
// lowercased substrings searched against the event name + description;
// the value is the venue record.
const CIVIC_VENUES = {
  'akron civic theatre': {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
  'the knight stage': {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
  "wild oscar's": {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
  'pnc plaza': {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
}

async function ensureCivicVenue(displayName) {
  const key  = (displayName || 'Akron Civic Theatre').toLowerCase().trim()
  const info = CIVIC_VENUES[key] ?? CIVIC_VENUES['akron civic theatre']
  return ensureVenueGeneric(displayName || 'Akron Civic Theatre', {
    address:       info.address,
    city:          info.city,
    state:         info.state,
    zip:           info.zip,
    lat:           info.lat,
    lng:           info.lng,
    parking_type:  info.parking_type,
    parking_notes: info.parking_notes,
    website:       'https://www.theatreakron.com',
  })
}

async function ensureCivicOrganizer() {
  return ensureOrganization('Akron Civic Theatre', {
    website:     'https://www.theatreakron.com',
    description:
      'Akron Civic Theatre is a historic performing arts venue in downtown Akron presenting ' +
      'Broadway touring productions, concerts, comedy, and local performances on three stages: ' +
      "the main theatre, The Knight Stage, and Wild Oscar's.",
  })
}

// ── HTML fetch ────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── JSON-LD extraction ───────────────────────────────────────────────────

/**
 * Walk every <script type="application/ld+json"> block in the HTML and
 * return a flat list of every Schema.org Event entry. theatreakron.com
 * emits one Event object per upcoming show, sometimes inside an @graph,
 * sometimes as a top-level array.
 */
function extractEventsFromHtml(html) {
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

/** Find a sub-venue mentioned in the title or description; default to main. */
function detectSubVenue(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  if (text.includes('the knight stage') || /\bknight stage\b/.test(text)) return 'The Knight Stage'
  if (text.includes("wild oscar"))                                          return "Wild Oscar's"
  if (text.includes('pnc plaza'))                                           return 'PNC Plaza'
  return 'Akron Civic Theatre'
}

/** Slug-based source_id. */
function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Derive tags from show title keywords (kept compatible with prior scraper). */
function deriveTags(title) {
  const lower = (title || '').toLowerCase()
  const tags  = ['theatre', 'live-performance', 'downtown-akron']
  if (lower.includes('musical') || lower.includes(' music')) tags.push('musical')
  if (lower.includes('comedy') || lower.includes('laugh'))    tags.push('comedy')
  if (lower.includes('symphony') || lower.includes('orchestra') || lower.includes('classical')) tags.push('classical')
  if (lower.includes('ballet') || lower.includes('dance'))    tags.push('dance')
  if (lower.includes('broadway') || lower.includes('tour'))   tags.push('broadway-tour')
  return tags
}

// ── Process + upsert ─────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0
  const seen   = new Set()
  const now    = Date.now()

  for (const ld of rawEvents) {
    try {
      const title = decodeEntities(ld.name)
      if (!title) { skipped++; continue }

      const startAt = ld.startDate ? new Date(ld.startDate).toISOString() : null
      if (!startAt) { skipped++; continue }
      const endAt   = ld.endDate   ? new Date(ld.endDate).toISOString()   : null

      // Past-event guard (1-day grace)
      if (new Date(startAt).getTime() < now - 86_400_000) { skipped++; continue }

      const description = decodeEntities(typeof ld.description === 'string' ? ld.description : null)
        // Sometimes the description comes back as HTML; strip if so.
      const cleanDesc = description ? stripHtml(description).slice(0, 2000) : null

      const subVenue = detectSubVenue(title, cleanDesc)
      const venueId  = await ensureCivicVenue(subVenue)

      // Image: ld.image can be a string, an array, or an object {url}
      const imageUrl =
        typeof ld.image === 'string' ? ld.image
        : Array.isArray(ld.image)    ? ld.image[0]
        : (ld.image?.url ?? null)

      // Offers → ticket URL + price when present
      const offers = Array.isArray(ld.offers) ? ld.offers : (ld.offers ? [ld.offers] : [])
      const offer  = offers[0] || {}
      const ticketUrl = ld.url || offer.url || 'https://www.theatreakron.com/'
      const rawPrice  = Number(offer.price)
      const priceMin  = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null

      const id = slugify(title) + '-' + startAt.slice(0, 10)
      if (seen.has(id)) { skipped++; continue }
      seen.add(id)

      const row = {
        title,
        description:     cleanDesc,
        start_at:        startAt,
        end_at:          endAt,
        category:        'theater',
        tags:            deriveTags(title),
        price_min:       priceMin,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          SOURCE_KEY,
        source_id:       id,
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
  console.log('🎭  Starting Akron Civic Theatre ingestion (theatreakron.com JSON-LD)…')
  const start = Date.now()

  try {
    const organizerId = await ensureCivicOrganizer()
    // Pre-create the main venue so the org/venue link table has a row even
    // when the first event happens at a sub-venue (Knight Stage, etc.).
    const mainVenueId = await ensureCivicVenue('Akron Civic Theatre')
    if (organizerId && mainVenueId) await linkOrganizationVenue(organizerId, mainVenueId)

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html = await fetchHtml(SOURCE_URL)
    const rawEvents = extractEventsFromHtml(html)
    console.log(`  Found ${rawEvents.length} JSON-LD events`)

    if (rawEvents.length === 0) {
      console.warn('  ⚠ No events parsed — theatreakron.com may have changed JSON-LD structure.')
    }

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)

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
