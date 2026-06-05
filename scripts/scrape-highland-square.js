/**
 * scrape-highland-square.js
 *
 * Highland Square Neighborhood Association (HSNA) — the 501(c)(3) behind
 * PorchROKR, Akron's annual porch-music-and-arts festival in the Highland
 * Square neighborhood (third Saturday of August).
 *   https://www.highlandsquareakron.org/
 *
 * The site is a Wix build. Wix is normally client-rendered, but it server-side
 * renders the festival date and metadata into the initial HTML for SEO, so a
 * plain fetch sees the content. The homepage is effectively a single-event
 * promo: a prominent "<Month> <DD>, <YYYY>" heading plus the festival
 * description (og:description) and poster (og:image). HSNA runs essentially one
 * marquee public event a year (PorchROKR; the Highland Square Film Festival
 * appears on a separate page when active), so this scraper publishes that one
 * dated festival rather than a recurring list.
 *
 * Why a dedicated scraper for one event: PorchROKR is the defining Highland
 * Square event and we want the canonical date/venue straight from HSNA rather
 * than depending on it surfacing through Eventbrite.
 *
 * Usage:   node scripts/scrape-highland-square.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
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
  easternToIso,
} from './lib/normalize.js'

const SOURCE_KEY = 'highland_square'
const HOME_URL = 'https://www.highlandsquareakron.org/'

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

function metaContent(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    firstMatch(html, new RegExp(`<meta[^>]+(?:name|property)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
    firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${esc}["']`, 'i'))
  )
}

function firstMatch(html, re) {
  const m = html.match(re)
  return m ? m[1] : null
}

/**
 * Pull the single PorchROKR festival from the homepage HTML.
 * Returns the event object, or null if no date is present.
 */
export function parseHomepage(html) {
  // The festival date is rendered as a prominent heading, e.g. "AUGUST 15,
  // 2026". Prefer a date inside a heading tag; fall back to the first
  // Month-DD-YYYY anywhere in the page text.
  const headingDates = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map(m => stripHtml(m[1]))
    .map(t => t.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/))
    .find(Boolean)
  const anyDate = headingDates || stripHtml(html).match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (!anyDate) return null
  const month = MONTH_MAP[anyDate[1].toLowerCase()]
  if (!month) return null
  const dateStr = `${anyDate[3]}-${String(month).padStart(2, '0')}-${String(parseInt(anyDate[2], 10)).padStart(2, '0')}`

  const description = metaContent(html, 'og:description') || metaContent(html, 'description')
  const imageUrl = metaContent(html, 'og:image')

  return {
    title:       'PorchROKR Music & Arts Festival',
    dateStr,
    // PorchROKR porch sets run ~11 a.m.–7 p.m., with a headliner to ~9 p.m.
    startTime:   '11:00:00',
    endTime:     '21:00:00',
    description: description ? stripHtml(description) : null,
    imageUrl:    imageUrl || null,
    sourceId:    `porchrokr-${anyDate[3]}`,
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎪  Starting Highland Square / PorchROKR ingestion (Wix HTML)…')
  const start = Date.now()

  try {
    const html = await fetchHtml(HOME_URL)
    const ev = parseHomepage(html)

    if (!ev) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'No PorchROKR date found on the homepage — Wix markup or the festival date placement may have changed.',
        durationMs:  Date.now() - start,
        eventsFound: 0,
      })
      console.warn('  ⚠ No date found — exiting 0.')
      process.exit(0)
    }

    const today = new Date().toISOString().split('T')[0]
    if (ev.dateStr < today) {
      console.log(`  Found PorchROKR ${ev.dateStr} but it is in the past — nothing to ingest.`)
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, { eventsFound: 1, durationMs: Date.now() - start })
      process.exit(0)
    }

    const organizerId = await ensureOrganization('Highland Square Neighborhood Association', {
      website:     'https://www.highlandsquareakron.org',
      description: 'The Highland Square Neighborhood Association (HSNA) is a 501(c)(3) that celebrates the art, history, and character of Akron\'s Highland Square neighborhood — best known for PorchROKR, its annual outdoor porch-music and arts festival, plus the Highland Square Film Festival and community workshops.',
    })
    const venueId = await ensureVenue('Highland Square', {
      city: 'Akron', state: 'OH', zip: '44303',
      website: 'https://www.highlandsquareakron.org',
      description: 'The Highland Square neighborhood district in West Akron — the host area for PorchROKR, with porch and street stages along the W Market St corridor.',
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const startAt = easternToIso(`${ev.dateStr} ${ev.startTime}`)
    const endAt   = easternToIso(`${ev.dateStr} ${ev.endTime}`)
    if (!startAt) {
      throw new Error(`Could not build start timestamp from ${ev.dateStr} ${ev.startTime}`)
    }

    const row = {
      title:           ev.title,
      description:     ev.description,
      start_at:        startAt,
      end_at:          endAt,
      category:        'music',
      tags:            ['porchrokr', 'highland-square', 'akron', 'festival', 'music', 'free', 'outdoor'],
      price_min:       0,
      price_max:       null,
      age_restriction: 'all_ages',
      image_url:       ev.imageUrl || null,
      ticket_url:      HOME_URL,
      source:          SOURCE_KEY,
      source_id:       ev.sourceId,
      status:          'published',
      featured:        false,
    }

    const enrichedRow = await enrichWithImageDimensions(row)
    const { data: upserted, error } = await upsertEventSafe(enrichedRow)
    if (error) throw new Error(`Upsert failed: ${error.message}`)

    if (venueId)     await linkEventVenue(upserted.id, venueId)
    if (organizerId) await linkEventOrganization(upserted.id, organizerId)

    await logUpsertResult(SOURCE_KEY, 1, 0, 0, { eventsFound: 1, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — PorchROKR ${ev.dateStr} ingested`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
