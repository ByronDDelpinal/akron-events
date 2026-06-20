/**
 * scrape-gather-round-games.js
 *
 * Gather 'Round Games & Collectibles — a TCG / board-game store at 121 Ghent Rd,
 * Fairlawn (Summit County). Pokémon, Magic, Lorcana, One Piece, board games.
 *
 * Their public-facing brochure site (gatherround.net, Squarespace) has no
 * events; the events live on grgcollect.com, a Wix site running **Wix
 * Bookings**. Each event is a bookable "service" (`/service-page/<slug>`) with a
 * recurring session schedule — NOT the Wix Events app, so lib/wix-events.js
 * doesn't apply. The Bookings widget hydrates client-side, so we render with the
 * shared lib/puppeteer.js and parse the human-readable text (robust to Wix's
 * hashed CSS classes).
 *
 * Scope: we ingest only NON-product-release events — the recurring community
 * play nights (Trade Night, Friday Night Magic). We drop set-launch events
 * (prereleases, commander parties, set-specific booster drafts) two ways: by
 * RELEASE-keyword on the title, and by dropping one-time services (launch events
 * are single-session; community nights recur). Per byron's request.
 *
 * Usage:   node scripts/scrape-gather-round-games.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import { evaluateOnPage } from './lib/puppeteer.js'

export const SOURCE_KEY = 'gather_round_games'
const SITE = 'https://www.grgcollect.com'
const MAX_DAYS_AHEAD = 180

const VENUE = {
  name: "Gather 'Round Games & Collectibles",
  address: '121 Ghent Rd', city: 'Fairlawn', state: 'OH', zip: '44333',
  website: 'https://www.gatherround.net',
}

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 }

// Title patterns that mark a product-release / set-launch event (excluded).
const RELEASE_RE = /pre-?release|\brelease\b|\blaunch\b|commander party|commander celebration|booster draft|set debut|street date|\bdebut\b/i

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Clean a Wix service title: drop the store suffix + a trailing "(date)" note. */
export function cleanTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/\s*\|\s*Gather Round Games\s*$/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')        // "Trade Night (June 13th)" → "Trade Night"
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when a service title looks like a product-release / set-launch event. */
export function isProductRelease(title) {
  return RELEASE_RE.test(String(title || ''))
}

/** Year for a session month, inferred from the service's "Dates: … - …" range. */
export function inferYear(monthNum, startMonth, startYear, endYear) {
  if (startYear === endYear) return startYear
  return monthNum >= startMonth ? startYear : endYear
}

/**
 * Parse a Wix Bookings service page (document.title + body.innerText) into a
 * normalised service object: { title, description, priceMin, sessions[] }.
 * sessions = [{ dateYmd, time }]. Robust to Wix hashed classes (text-based).
 */
export function parseService({ title, text } = {}) {
  const cleanName = cleanTitle(title)
  const body = String(text || '')

  // Price: first "$NN" (absent for free events → null, never assumed).
  const priceMatch = body.match(/\$(\d+(?:\.\d{2})?)/)
  const priceMin = priceMatch ? Number(priceMatch[1]) : null

  // Description: between "Service Description" and "Upcoming Sessions".
  const descMatch = body.match(/Service Description\s*([\s\S]*?)\s*Upcoming Sessions/i)
  const description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() || null : null

  // Year range: "Dates: May 9, 2026 - Dec 26, 2026".
  const range = body.match(/Dates:\s*([A-Za-z]+)\s+\d{1,2},\s*(\d{4})\s*-\s*[A-Za-z]+\s+\d{1,2},\s*(\d{4})/i)
  const startMonth = range ? (MONTHS[range[1].slice(0, 3).toLowerCase()] ?? 1) : 1
  const startYear  = range ? Number(range[2]) : new Date().getFullYear()
  const endYear    = range ? Number(range[3]) : startYear

  // Sessions: "Friday, Jun 5  7:00 PM  4 hr" (whitespace/newlines between).
  const re = /(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s+([A-Za-z]+)\s+(\d{1,2})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+\d+\s*hr\b/gi
  const sessions = []
  const seen = new Set()
  for (const m of body.matchAll(re)) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()]
    if (!month) continue
    const day = Number(m[2])
    const year = inferYear(month, startMonth, startYear, endYear)
    const dateYmd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const time = m[3].replace(/\s+/g, ' ').trim()
    const key = `${dateYmd} ${time}`
    if (seen.has(key)) continue
    seen.add(key)
    sessions.push({ dateYmd, time })
  }

  return { title: cleanName, description, priceMin, sessions }
}

/** Should this service be ingested? Recurring + not a product-release. */
export function isIngestableService(service) {
  if (!service?.title) return false
  if (isProductRelease(service.title)) return false      // set launch / prerelease
  if ((service.sessions?.length ?? 0) < 2) return false  // one-time → treat as launch
  return true
}

/** Tags from the service title + description. */
export function buildTags(title, description) {
  const t = `${title || ''} ${description || ''}`.toLowerCase()
  const tags = ['tcg', 'game-night', 'tabletop']
  if (/pok[eé]mon/.test(t))                 tags.push('pokemon')
  if (/magic|mtg|\bfnm\b/.test(t))          tags.push('magic-the-gathering')
  if (/lorcana/.test(t))                    tags.push('lorcana')
  if (/one piece/.test(t))                  tags.push('one-piece')
  if (/\bdraft\b/.test(t))                  tags.push('draft')
  if (/trade|trading/.test(t))              tags.push('trading')
  return [...new Set(tags)]
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎲  Starting Gather Round Games (Wix Bookings) ingestion…')
  const start = Date.now()
  try {
    // Discover service-page URLs from the homepage's "Upcoming Events".
    const serviceUrls = await evaluateOnPage(`${SITE}/`, () =>
      [...new Set([...document.querySelectorAll('a[href*="/service-page/"]')].map((a) => a.href))],
    )
    console.log(`  Found ${serviceUrls.length} service page(s)`)

    const organizerId = await ensureOrganization(VENUE.name, {
      website: VENUE.website,
      description: "Gather 'Round Games & Collectibles is a family-owned TCG and board-game store in Fairlawn (Pokémon, Magic, Lorcana, One Piece) hosting community game nights and tournaments.",
    })
    const venueId = await ensureVenue(VENUE.name, {
      address: VENUE.address, city: VENUE.city, state: VENUE.state, zip: VENUE.zip, website: VENUE.website,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const url of serviceUrls) {
      try {
        const slug = url.split('/service-page/')[1]?.split(/[?#]/)[0] || ''
        const data = await evaluateOnPage(url, () => ({ title: document.title, text: document.body.innerText }))
        const service = parseService(data)
        if (!isIngestableService(service)) { skipped++; continue }

        const tags = buildTags(service.title, service.description)
        let added = 0
        for (const session of service.sessions) {
          const startIso = easternToIso(session.dateYmd, session.time)
          if (!startIso) continue
          const ms = Date.parse(startIso)
          if (ms < now - 86_400_000 || ms > cutoff) continue

          const row = {
            title:           service.title,
            description:     service.description,
            start_at:        startIso,
            end_at:          null,
            category:        'games',
            tags,
            price_min:       service.priceMin,   // null when no fee shown (never assumed)
            price_max:       service.priceMin,
            age_restriction: 'all_ages',
            image_url:       null,
            ticket_url:      url,
            source:          SOURCE_KEY,
            source_id:       `${slug}-${startIso.slice(0, 10)}`,
            status:          'published',
            featured:        false,
          }
          const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
          if (error) { console.warn(`  ⚠ Upsert failed "${row.title}" ${session.dateYmd}:`, error.message); skipped++; continue }
          if (venueId)     await linkEventVenue(upserted.id, venueId)
          if (organizerId) await linkEventOrganization(upserted.id, organizerId)
          inserted++; added++
        }
        console.log(`  ✓ ${service.title}: ${added} session(s)`)
      } catch (err) {
        console.warn(`  ⚠ Error on ${url}:`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: serviceUrls.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
