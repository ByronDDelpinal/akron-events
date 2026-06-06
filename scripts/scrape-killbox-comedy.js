/**
 * scrape-killbox-comedy.js
 *
 * Fetches upcoming shows from The KillBox Comedy Club (Akron) — a stand-up
 * comedy venue at 1305 E Tallmadge Ave that books open mics, weeknight
 * specials, and multi-show weekend headliners.
 *
 * Platform: thekillboxcomedyclub.com runs on Seat Engine, which renders a
 * client-hydrated React listing at /events plus per-show detail pages at
 * /events/<slug>. The detail page is the canonical source of truth — it
 * carries the title, image, full description, price range, and one or more
 * showtimes broken out as `Weekday • Mon DD H:MM AM/PM` blocks. Each
 * showtime becomes its own DB row keyed by `<slug>-<YYYY-MM-DD-HH-MM>` so
 * Friday/Saturday weekend runs surface as distinct events.
 *
 * Strategy:
 *   1. Render /events with Puppeteer, wait for the hydrated `/events/<slug>`
 *      anchors, and harvest the slug list.
 *   2. For each slug render the detail page and extract title / description
 *      / image / price / showtimes via in-page DOM inspection.
 *   3. Emit one row per showtime (multi-show weekend headliners fan out).
 *   4. Upsert via the shared pipeline.
 *
 * Year inference: detail-page dates omit the year (`Jun 11`). We infer the
 * current year first; if the resulting date is more than a week behind
 * today, we roll it forward a year so winter shows posted in autumn don't
 * land in the past.
 *
 * Usage:
 *   node scripts/scrape-killbox-comedy.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'

const SOURCE_KEY   = 'killbox_comedy'
const BASE_URL     = 'https://www.thekillboxcomedyclub.com'
const LISTING_URL  = `${BASE_URL}/events`
const NAV_TIMEOUT  = 30_000
const HYDRATE_WAIT = 1_800   // ms — Seat Engine hydrates anchors after first paint

const VENUE_INFO = {
  name:    'The KillBox Comedy Club',
  address: '1305 E Tallmadge Ave',
  city:    'Akron',
  state:   'OH',
  zip:     '44310',
  website: BASE_URL,
  description:
    "Akron's dedicated stand-up comedy club — open mics, weeknight specials, and " +
    "multi-show weekend headliner runs. Shows are 21+ unless noted otherwise.",
  parking_type:  'lot',
  parking_notes: 'Free parking lot on-site.',
}

const ORG_INFO = {
  name: 'The KillBox Comedy Club',
  details: {
    website: BASE_URL,
    description:
      'Stand-up comedy club at 1305 E Tallmadge Ave in Akron, hosting open mics, ' +
      'touring headliners, and special-event shows. Ticketing powered by Seat Engine.',
  },
}

const MONTH_MAP = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Sept: 9, Oct: 10, Nov: 11, Dec: 12,
}

// ── Page fetch via Puppeteer ──────────────────────────────────────────────

/**
 * Open the listing page and harvest unique `/events/<slug>` paths.
 * The listing is server-rendered but the slug anchors are React-hydrated,
 * so we wait a beat after `networkidle2` before reading the DOM.
 */
async function harvestSlugs(browser) {
  const page = await newConfiguredPage(browser)
  await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT })
  await page.waitForFunction(
    () => document.querySelectorAll('a[href^="/events/"]').length > 1,
    { timeout: NAV_TIMEOUT },
  ).catch(() => {})
  // Extra short pause — some cards hydrate in a second render pass.
  await new Promise(r => setTimeout(r, HYDRATE_WAIT))

  const slugs = await page.evaluate(() => {
    const seen = new Set()
    document.querySelectorAll('a[href^="/events/"]').forEach((a) => {
      const href = a.getAttribute('href')
      if (!href) return
      // Filter to single-segment event slugs ("/events/foo"), skip the bare
      // "/events" listing or any nested asset/api path.
      const m = href.match(/^\/events\/([A-Za-z0-9_-]+)$/)
      if (m) seen.add(m[1])
    })
    return Array.from(seen)
  })

  await page.close()
  return slugs
}

/**
 * Render a single detail page and pull the structured fields we need.
 *
 * Returns:
 *   {
 *     title, description, imageUrl, priceMin, priceMax,
 *     showtimes: [{ month, day, year, hour, minute }]
 *   }
 */
async function fetchDetailPage(browser, slug) {
  const page = await newConfiguredPage(browser)
  const url  = `${BASE_URL}/events/${slug}`
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT })
    await page.waitForSelector('h1', { timeout: NAV_TIMEOUT }).catch(() => {})
    await new Promise(r => setTimeout(r, HYDRATE_WAIT))

    return await page.evaluate(() => {
      const text = document.body.innerText
      const title = document.querySelector('h1')?.textContent?.trim() ?? null

      // Image: first Seat Engine CDN asset — the per-show banner is the
      // first `<img>` element in the hydrated card.
      const imageUrl = Array.from(document.querySelectorAll('img'))
        .map(i => i.src)
        .find(s => s && /files\.seatengine\.com/i.test(s)) ?? null

      // Showtimes parsing uses this marker too; compute once.
      const endMarker = text.indexOf('Know Before You Go')

      // Description hierarchy:
      //   1. Schema.org Event JSON-LD — Seat Engine emits this on most
      //      ticketed shows and it carries the full artist bio.
      //   2. The "Price includes fee" → "Know Before You Go:" slice that
      //      worked before JSON-LD coverage existed. Still the best
      //      source for show-specific blurbs that don't make it into
      //      the structured-data block.
      // Open-mic / standing-night listings legitimately have no bio,
      // so a null fallthrough is acceptable.
      let description = null
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(s.textContent || '')
          const items = Array.isArray(parsed) ? parsed : [parsed]
          for (const it of items) {
            const entries = it && it['@graph'] ? it['@graph'] : [it]
            for (const e of entries) {
              if (e && (e['@type'] === 'Event' || (Array.isArray(e['@type']) && e['@type'].includes('Event')))) {
                if (typeof e.description === 'string' && e.description.trim()) {
                  description = e.description.trim()
                  break
                }
              }
            }
            if (description) break
          }
          if (description) break
        } catch { /* skip invalid JSON */ }
      }
      if (!description) {
        const startMarker = text.indexOf('Price includes fee')
        if (startMarker !== -1 && endMarker !== -1 && endMarker > startMarker) {
          description = text.slice(startMarker + 'Price includes fee'.length, endMarker).trim()
        }
      }

      // Price: first "$" amount. May be a range "$13.75 - $17.00".
      const priceLine = text.match(/\$\s?([\d.,]+)\s*-\s*\$\s?([\d.,]+)/)
        ?? text.match(/\$\s?([\d.,]+)/)
      let priceMin = null, priceMax = null
      if (priceLine) {
        const a = parseFloat(priceLine[1].replace(/,/g, ''))
        const b = priceLine[2] != null ? parseFloat(priceLine[2].replace(/,/g, '')) : null
        if (Number.isFinite(a)) {
          priceMin = a
          priceMax = Number.isFinite(b) ? b : null
        }
      }

      // Showtimes: lines after "Know Before You Go" are
      //   Weekday \n • \n Mon DD \n H:MM AM \n [H:MM PM \n ...]
      // We walk the lines, latch onto a date when we see "Mon DD", and
      // then emit a showtime for every subsequent "H:MM AM/PM" line until
      // we see another weekday/date.
      const showtimes = []
      const weekdays = new Set(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])
      const monthRe  = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\s+(\d{1,2})$/
      const timeRe   = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i

      const lines = text
        .slice(endMarker === -1 ? 0 : endMarker)
        .split(/\n+/)
        .map(s => s.trim())
        .filter(Boolean)

      let currentDate = null
      for (const line of lines) {
        if (weekdays.has(line) || line === '•') continue
        const md = line.match(monthRe)
        if (md) {
          currentDate = { month: md[1], day: parseInt(md[2], 10) }
          continue
        }
        const tm = line.match(timeRe)
        if (tm && currentDate) {
          showtimes.push({
            month:    currentDate.month,
            day:      currentDate.day,
            hour:     parseInt(tm[1], 10),
            minute:   parseInt(tm[2], 10),
            meridiem: tm[3].toUpperCase(),
          })
        }
      }

      return { title, description, imageUrl, priceMin, priceMax, showtimes }
    })
  } finally {
    await page.close()
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────

/**
 * Infer the year for a (month, day) pair given today's date. If the
 * resulting date is more than 7 days in the past, roll it to next year —
 * Seat Engine never shows past events, so a date in the past is a December
 * listing crossing into January, not a stale entry.
 */
function inferYear(monthName, day) {
  const m = MONTH_MAP[monthName]
  if (!m) return null
  const today = new Date()
  const candidate = new Date(today.getFullYear(), m - 1, day)
  const oneWeekAgo = new Date(today.getTime() - 7 * 86_400_000)
  if (candidate < oneWeekAgo) candidate.setFullYear(today.getFullYear() + 1)
  return candidate.getFullYear()
}

/** Convert {month, day, hour, minute, meridiem} → ISO UTC string. */
function showtimeToIso({ month, day, hour, minute, meridiem }) {
  const year = inferYear(month, day)
  if (!year) return null
  const m = MONTH_MAP[month]
  let h = hour % 12
  if (meridiem === 'PM') h += 12
  const mm = String(m).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  const hh = String(h).padStart(2, '0')
  const min = String(minute).padStart(2, '0')
  return easternToIso(`${year}-${mm}-${dd} ${hh}:${min}:00`)
}

// ── Category & tags ───────────────────────────────────────────────────────

// Category is always 'comedy' — Killbox is a comedy-only venue.

function mapTags(title = '') {
  const tags = ['comedy', 'stand-up', 'akron', '21-and-over']
  const lower = title.toLowerCase()
  if (lower.includes('open mic'))                tags.push('open-mic')
  if (lower.includes('special event'))           tags.push('special-event')
  return [...new Set(tags)]
}

// ── Process & upsert ──────────────────────────────────────────────────────

async function processEvents(detailRows, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const { slug, data } of detailRows) {
    if (!data || !data.title || data.showtimes.length === 0) {
      skipped++
      continue
    }

    const { title, description, imageUrl, priceMin, priceMax, showtimes } = data
    // Drop "*SPECIAL EVENT*" prefix from titles — the tag captures it.
    const cleanTitle = title.replace(/^\*?\s*SPECIAL EVENT\s*\*?\s*/i, '').trim()

    for (const st of showtimes) {
      try {
        const startAt = showtimeToIso(st)
        if (!startAt) { skipped++; continue }

        // Past-show guard: never store anything more than a day old.
        if (new Date(startAt).getTime() < Date.now() - 86_400_000) {
          skipped++
          continue
        }

        const yyyy = startAt.slice(0, 4)
        const sourceId = `${slug}-${yyyy}${String(MONTH_MAP[st.month]).padStart(2,'0')}${String(st.day).padStart(2,'0')}-${String(st.hour).padStart(2,'0')}${String(st.minute).padStart(2,'0')}`

        const row = {
          title:           cleanTitle,
          description:     description || null,
          start_at:        startAt,
          end_at:          null,
          category:        'comedy',
          tags:            mapTags(title),
          price_min:       priceMin,
          price_max:       priceMax ?? priceMin,
          age_restriction: '21_plus',
          image_url:       imageUrl,
          ticket_url:      `${BASE_URL}/events/${slug}`,
          source:          SOURCE_KEY,
          source_id:       sourceId,
          status:          'published',
          featured:        false,
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)

        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}" (${sourceId}):`, error.message)
          skipped++
        } else {
          if (venueId)     await linkEventVenue(upserted.id, venueId)
          if (organizerId) await linkEventOrganization(upserted.id, organizerId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing showtime for "${title}":`, err.message)
        skipped++
      }
    }
  }

  return { inserted, skipped }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🎤  Starting KillBox Comedy Club ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address:       VENUE_INFO.address,
      city:          VENUE_INFO.city,
      state:         VENUE_INFO.state,
      zip:           VENUE_INFO.zip,
      website:       VENUE_INFO.website,
      description:   VENUE_INFO.description,
      parking_type:  VENUE_INFO.parking_type,
      parking_notes: VENUE_INFO.parking_notes,
    })
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    const detailRows = await withBrowser(async (browser) => {
      console.log(`\n🔍  Fetching listing: ${LISTING_URL}`)
      const slugs = await harvestSlugs(browser)
      console.log(`  Found ${slugs.length} event slugs`)

      const rows = []
      for (const slug of slugs) {
        try {
          const data = await fetchDetailPage(browser, slug)
          rows.push({ slug, data })
        } catch (err) {
          console.warn(`  ⚠ Failed to fetch ${slug}: ${err.message}`)
        }
      }
      return rows
    })

    console.log(`\n📥  Processing ${detailRows.length} events…`)
    const { inserted, skipped } = await processEvents(detailRows, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: detailRows.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
