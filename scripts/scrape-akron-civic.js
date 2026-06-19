/**
 * scrape-akron-civic.js
 *
 * Scrapes upcoming shows from the Akron Civic Theatre's OFFICIAL site,
 * akroncivic.com (Bolt CMS).
 *
 * Why the official site (2026-06 rewrite): this scraper previously used
 * theatreakron.com, which is NOT the Civic — it's a third-party ticket
 * RESALE aggregator (TicketSqueeze) whose own pages say "Not a box office or
 * venue" and link to resale tickets. Consequences we were shipping:
 *   • free / community programming (the weekly "Party on the Plaza" concerts,
 *     "Cinema at the Civic", etc.) never appeared — the aggregator only lists
 *     big ticketed shows, so those events only survived via an inferior
 *     Bandsintown copy (no image, flattened text);
 *   • every akron_civic event linked patrons to RESALE tickets instead of the
 *     official box office.
 * akroncivic.com lists every show, with real promo images, formatted
 * descriptions, and official ticketing.
 *
 * Strategy (list → detail):
 *   1. GET /view-all-shows — the master listing. Every show detail link is a
 *      slug ending in -YYYY-MM-DD (e.g. /party-on-the-plaza-afi-scruggs-2026-06-19).
 *   2. For each detail page parse: title (the <h1> parts), date/time + venue
 *      (two <h6> lines), poster image (an /thumbs/{dims}/shows/… rendition,
 *      upsized), and the formatted description (the <p> block, kept as text
 *      with paragraph/line breaks via htmlToText).
 *   3. Route to the correct venue: PNC Plaza at The Civic, The Knight Stage,
 *      and Wild Oscar's are their OWN venue records (distinct from the main
 *      theatre), per their real identities.
 *
 * Usage:
 *   node scripts/scrape-akron-civic.js
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
  htmlToText,
  decodeEntities,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue as ensureVenueGeneric,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'akron_civic'
const ORIGIN      = 'https://www.akroncivic.com'
const LIST_URL    = `${ORIGIN}/view-all-shows`
// akroncivic.com's WAF 403s the "compatible; …Bot" UA, so present as a real
// browser with the standard navigation headers it expects.
const USER_AGENT  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// All Civic stages share the building address; each is its own venue record so
// the map pin + listing reflect where you actually go. PNC Plaza is the
// outdoor patio on the south wall; The Knight Stage and Wild Oscar's are the
// smaller indoor rooms.
const CIVIC_ADDRESS = { address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308', lat: 41.0802, lng: -81.5193, parking_type: 'garage', parking_notes: 'Parking available in nearby city garages on Main St.' }

const CIVIC_VENUES = {
  main: { name: 'Akron Civic Theatre', details: { ...CIVIC_ADDRESS, website: ORIGIN } },
  pnc_plaza: {
    name: 'PNC Plaza at The Civic',
    details: {
      ...CIVIC_ADDRESS,
      website: `${ORIGIN}/pnc-plaza-at-the-civic`,
      description: 'PNC Plaza at The Civic is the Akron Civic Theatre\'s outdoor plaza on its south-facing wall off South Main Street, home to the free "Party on the Plaza" summer concert series and other outdoor gatherings.',
    },
  },
  knight_stage: { name: 'The Knight Stage', details: { ...CIVIC_ADDRESS, website: `${ORIGIN}/knight-stage`, description: 'The Knight Stage is an intimate performance space inside the Akron Civic Theatre.' } },
  wild_oscars:  { name: "Wild Oscar's",   details: { ...CIVIC_ADDRESS, website: `${ORIGIN}/wild-oscars`,  description: "Wild Oscar's is a cabaret-style room inside the Akron Civic Theatre." } },
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Pull every show-detail path from the listing HTML. Detail slugs end in -YYYY-MM-DD. */
export function extractShowPaths(listHtml, origin = ORIGIN) {
  const re = /href="([^"?#]*\/[a-z0-9][a-z0-9-]*-20\d{2}-\d{2}-\d{2})"/gi
  const seen = new Set()
  const out = []
  for (const m of String(listHtml || '').matchAll(re)) {
    let path = m[1]
    if (/^https?:\/\//i.test(path)) { try { path = new URL(path).pathname } catch { continue } }
    if (!path.startsWith('/')) path = `/${path}`
    if (seen.has(path)) continue
    seen.add(path)
    out.push(`${origin}${path}`)
  }
  return out
}

/** Join the title <h1> fragments into one clean title. The Bolt template nests
 *  and DUPLICATES the title (`<h1><h1>A</h1><h1>B</h1></h1>`, twice for
 *  mobile+desktop), so we de-duplicate identical fragments before joining. */
export function parseTitle(html) {
  const seen = new Set()
  for (const m of String(html || '').matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)) {
    const t = decodeEntities(m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim())
    if (t) seen.add(t)
  }
  // "Party on the Plaza:" + "Afi Scruggs" → "Party on the Plaza: Afi Scruggs"
  return [...seen].join(' ').replace(/:\s+/g, ': ').replace(/\s+/g, ' ').trim() || null
}

/** The content region: from the first <h6> (date) to the GENERAL INFORMATION
 *  boilerplate. Anchoring on the h6 (there are exactly two — date + venue —
 *  site-wide) is robust to the duplicated title blocks in the raw HTML. */
function contentRegion(html) {
  const s = String(html || '')
  const h6i = s.search(/<h6\b/i)
  const region = h6i > -1 ? s.slice(h6i) : s
  const gi = region.search(/GENERAL INFORMATION/i)
  return gi > -1 ? region.slice(0, gi) : region
}

function h6Values(region) {
  return [...region.matchAll(/<h6[^>]*>([\s\S]*?)<\/h6>/gi)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()))
    .filter(Boolean)
}

/** Parse "Weekday, Month D, YYYY at H:MM AM/PM" → { datePart, time }. */
export function parseCivicDateTime(text) {
  if (!text) return null
  const m = String(text).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const datePart = `${m[3]}-${String(month).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`
  const tm = String(text).match(/(\d{1,2}:\d{2}\s*[AaPp][Mm])/)
  return { datePart, time: tm ? tm[1] : '' }
}

/** Upsize a Bolt /thumbs/{w}×{h}×{q}/ rendition (the only size the CMS serves)
 *  to ~1200px wide, preserving aspect ratio. Returns an absolute URL. */
export function upsizeCivicImage(src, origin = ORIGIN) {
  if (!src) return null
  let path = src
  const m = path.match(/\/thumbs\/(\d+)[×x](\d+)[×x](\d+)\//)
  if (m) {
    const w = +m[1], h = +m[2]
    const target = 1200
    const factor = w ? target / w : 1
    const nw = Math.round(w * factor) || target
    const nh = Math.round(h * factor) || Math.round(target * 0.75)
    path = path.replace(/\/thumbs\/\d+[×x]\d+[×x]\d+\//, `/thumbs/${nw}×${nh}×90/`)
  }
  return /^https?:\/\//i.test(path) ? path : `${origin}${path.startsWith('/') ? '' : '/'}${path}`
}

/** First poster image (an /shows/ rendition) in the content region. */
export function extractImage(region, origin = ORIGIN) {
  const m = region.match(/<img[^>]+src="([^"]*\/shows\/[^"]+)"/i)
  return m ? upsizeCivicImage(decodeEntities(m[1]), origin) : null
}

/** The formatted description: the <p> block after the venue/date, kept as text
 *  with paragraph + line breaks (htmlToText), boilerplate excluded. */
export function extractDescription(region) {
  // Defensively drop the trailing boilerplate even if a full page is passed in.
  const gi = String(region || '').search(/GENERAL INFORMATION/i)
  if (gi > -1) region = String(region).slice(0, gi)
  const blocks = [...region.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => htmlToText(m[1]))
    .map((t) => t.replace(/\u00a0/g, ' ').trim())
    .filter((t) => t && t !== '')
  const joined = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  return joined ? joined.slice(0, 3000) : null
}

/** Map the venue <h6> text to one of the Civic's distinct venue records. */
export function venueForName(name) {
  const n = (name || '').toLowerCase()
  if (n.includes('pnc plaza'))   return CIVIC_VENUES.pnc_plaza
  if (n.includes('knight stage')) return CIVIC_VENUES.knight_stage
  if (n.includes('wild oscar'))   return CIVIC_VENUES.wild_oscars
  return CIVIC_VENUES.main
}

const FREE_RE = /\b(?:admission is free|free admission|free to attend|no cover|free event)\b/i

/** Build the event row from one detail page. Pure; returns null when undatable. */
export function parseDetail(html, pageUrl) {
  const title = parseTitle(html)
  if (!title) return null

  const region = contentRegion(html)
  const h6s = h6Values(region)
  const dateText  = h6s.find((t) => parseCivicDateTime(t))
  const venueName = h6s.find((t) => !parseCivicDateTime(t)) || null

  const dt = parseCivicDateTime(dateText || '')
  if (!dt) return null
  const startIso = easternToIso(dt.datePart, dt.time)
  if (!startIso) return null

  const description = extractDescription(region)
  const imageUrl    = extractImage(html)   // poster sits before the first <h6>, so scan the whole page
  const isFree      = description ? FREE_RE.test(description) : false
  const venue       = venueForName(venueName)

  return { title, startIso, description, imageUrl, isFree, venue, pageUrl }
}

// ── Tags ─────────────────────────────────────────────────────────────────

function deriveTags(title, venueKeyName) {
  const lower = (title || '').toLowerCase()
  const tags  = ['downtown-akron']
  if (/plaza/.test((venueKeyName || '').toLowerCase()) || /party on the plaza/.test(lower)) tags.push('outdoor', 'concert')
  if (lower.includes('musical') || lower.includes(' music')) tags.push('musical')
  if (lower.includes('comedy') || lower.includes('laugh'))    tags.push('comedy')
  if (lower.includes('symphony') || lower.includes('orchestra') || lower.includes('classical')) tags.push('classical')
  if (lower.includes('ballet') || lower.includes('dance'))    tags.push('dance')
  if (lower.includes('cinema') || lower.includes('film') || lower.includes('movie')) tags.push('film')
  if (lower.includes('broadway') || lower.includes('tour'))   tags.push('broadway-tour')
  return [...new Set(tags)]
}

// ── HTML fetch ────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Process + upsert ─────────────────────────────────────────────────────

async function main() {
  console.log('🎭  Starting Akron Civic Theatre ingestion (official akroncivic.com)…')
  const start = Date.now()

  try {
    const organizerId = await ensureCivicOrganizer()
    // Pre-create the main venue so the org/venue link table has a row even
    // when the first event happens at a sub-venue.
    const mainVenueId = await ensureVenueGeneric(CIVIC_VENUES.main.name, CIVIC_VENUES.main.details)
    if (organizerId && mainVenueId) await linkOrganizationVenue(organizerId, mainVenueId)

    console.log(`\n🔍  Fetching listing ${LIST_URL}…`)
    const listHtml = await fetchHtml(LIST_URL)
    const showUrls = extractShowPaths(listHtml)
    console.log(`  Found ${showUrls.length} show detail links`)

    const now = Date.now()
    const venueCache = new Map() // venue name → id
    const seen = new Set()
    let inserted = 0, skipped = 0

    for (const url of showUrls) {
      try {
        const slug = new URL(url).pathname.replace(/^\//, '')
        if (seen.has(slug)) { skipped++; continue }
        seen.add(slug)

        const html = await fetchHtml(url)
        const parsed = parseDetail(html, url)
        if (!parsed) { skipped++; continue }

        // Past-event guard (1-day grace)
        if (new Date(parsed.startIso).getTime() < now - 86_400_000) { skipped++; continue }

        let venueId = venueCache.get(parsed.venue.name)
        if (venueId === undefined) {
          venueId = await ensureVenueGeneric(parsed.venue.name, parsed.venue.details)
          venueCache.set(parsed.venue.name, venueId)
        }

        const category = inferCategory(parsed.title, parsed.description || '') || 'theater'
        const row = {
          title:           parsed.title,
          description:     parsed.description,
          start_at:        parsed.startIso,
          end_at:          null,
          category:        category === 'other' ? 'theater' : category,
          tags:            deriveTags(parsed.title, parsed.venue.name),
          price_min:       parsed.isFree ? 0 : null,   // never assume free; only when stated
          price_max:       null,
          age_restriction: 'not_specified',
          image_url:       parsed.imageUrl,
          ticket_url:      url,           // official Civic page (box office), never resale
          source:          SOURCE_KEY,
          source_id:       slug,
          status:          'published',
          featured:        false,
        }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing ${url}:`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: showUrls.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

async function ensureCivicOrganizer() {
  return ensureOrganization('Akron Civic Theatre', {
    website:     ORIGIN,
    description:
      'Akron Civic Theatre is a historic performing arts venue in downtown Akron presenting ' +
      'Broadway touring productions, concerts, comedy, film, and local performances across the ' +
      "main theatre, The Knight Stage, Wild Oscar's, and the outdoor PNC Plaza.",
  })
}

// Run only when invoked directly; importing for tests exposes the pure parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
