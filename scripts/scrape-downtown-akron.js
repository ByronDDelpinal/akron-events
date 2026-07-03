/**
 * scrape-downtown-akron.js
 *
 * Scrapes upcoming events from the Downtown Akron Partnership calendar.
 * Platform: CityInsight CMS (ctycms.com) — events rendered server-side as HTML cards.
 *
 * Fetches the current month plus the next 2 months for coverage.
 *
 * Usage:
 *   node scripts/scrape-downtown-akron.js
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
  decodeEntities,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'
import { getTrustedEventsAtVenue, classifyAgainstTrusted } from './lib/source-tiers.js'

const BASE_URL = 'https://www.downtownakron.com'

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// Short month abbreviations as used in the ctycms DOM:
// "Sunday 22 Mar" → day-of-week, day number, month abbrev
function reconstructDate(dayNum, monthAbbr) {
  const m = MONTH_MAP[monthAbbr.toLowerCase()]
  if (!m) return null
  const now   = new Date()
  let   year  = now.getFullYear()
  const d     = parseInt(dayNum, 10)
  // If this month+day combination is in the past this year, move to next year
  const candidate = new Date(Date.UTC(year, m - 1, d))
  const today     = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z')
  if (candidate < today) year++
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Parse time from strings like "2 p.m.", "7:30 p.m.", "noon", "2 p.m. - 11 p.m."
 * Returns the start time as HH:MM:00 or "12:00:00" fallback.
 */
function parseTime(raw) {
  if (!raw) return '12:00:00'
  const s = raw.trim().toLowerCase()

  if (s.includes('noon')) return '12:00:00'
  if (s.includes('midnight')) return '00:00:00'

  // Handle "X p.m." or "X:XX p.m." — extract just the start time
  const match = s.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/)
  if (match) {
    let hr  = parseInt(match[1], 10)
    const m = match[2] ?? '00'
    const isPm = /p/i.test(match[3])
    if (isPm && hr !== 12) hr += 12
    if (!isPm && hr === 12) hr = 0
    return `${String(hr).padStart(2, '0')}:${m}:00`
  }

  return '12:00:00'
}

/**
 * Title keywords → v2 category, or null to let text inference decide.
 * Audience (family/kids) and purpose (gala/benefit) words are NOT mapped —
 * the shared facet inference handles both, and mapping them to a content
 * category was how storytimes and galas landed in the Other bucket.
 */
function parseCategory(title = '') {
  const lower = title.toLowerCase()
  if (/festival|block party|porch/.test(lower)) return 'festival'
  if (/concert|music|jazz|band|symphony|orchestra/.test(lower)) return 'music'
  if (/film|movie|cinema/.test(lower)) return 'film'
  if (/theatre|theater|play\b|ballet|dance/.test(lower)) return 'theater'
  if (/\bart\b|exhibit|gallery/.test(lower)) return 'visual-art'
  if (/market/.test(lower)) return 'market'
  if (/food|tasting|brew|wine|culinary/.test(lower)) return 'food'
  if (/run|race|walk|bike|5k|marathon/.test(lower)) return 'fitness'
  return null
}

// ── Directly-scraped venue suppression ───────────────────────────────────────
//
// downtownakron.com re-lists events hosted at venues we already scrape directly.
// The direct scraper owns the canonical rows (full recurring schedule, real
// venue, descriptions, prices), so the DAP copy is a thinner duplicate. Worse,
// the two sources often name the same event differently (DAP "Casual Commander
// Days" vs Full Grip's own "MTG - Commander"), which defeats title-based
// dedupe. So we suppress DAP events whose venue is one we scrape directly,
// rather than publishing a second, lower-quality copy. Same pattern as Better
// Kenmore suppressing First-Glance-venue events.
//
// Only venues where the direct scraper is a verified COMPLETE superset of what
// DAP lists are suppressed — otherwise we'd drop DAP-only content. Audited
// 2026-06-29 (events at the same venue + date across sources):
//   - full_grip_games  — owns every TCG night (Commander/Modern/Standard/One
//                         Piece/Pokémon/drafts); DAP retitles them ("Casual
//                         Commander Days" vs "MTG - Commander"), defeating dedupe.
//   - blu_jazz         — full show calendar; DAP's lone "BLU-esday" copy is a
//                         hyphen-drift dupe of blu_jazz's "BLUesday".
//   - akron_childrens_museum — both sources carry only the recurring Delight
//                         Nights; DAP's "Delight Night" is a title-drift dupe.
// NOT suppressed (DAP carries unique content the direct scraper lacks): Akron
// Art Museum (exhibitions), Akron Soul Train (exhibitions), Musica/Jilly's
// (one-off shows), The Nightlight (its scraper is currently empty), Library.
const DIRECTLY_SCRAPED_VENUES = [
  { pattern: /full\s*grip\s*games/i,        scraper: 'full_grip_games' },
  { pattern: /blu\s*jazz/i,                 scraper: 'blu_jazz' },
  { pattern: /children.?s\s+museum/i,       scraper: 'akron_childrens_museum' },
  // nightlight_cinema carries the full film schedule; DAP re-lists the same
  // films with drifted titles ("8 1/2" vs "8½"), which defeats dedupe even after
  // the venue records were merged. Matches "The Nightlight" / "The Nightlight Cinema".
  { pattern: /night\s*light/i,              scraper: 'nightlight_cinema' },
]

/** Returns the direct scraper key that owns this venue, or null. */
function directlyScrapedVenue(venueName) {
  if (!venueName) return null
  for (const v of DIRECTLY_SCRAPED_VENUES) {
    if (v.pattern.test(venueName)) return v.scraper
  }
  return null
}

// Some events a direct source owns arrive here with NO usable venue (the DAP
// card omits it), so venue-name suppression can't catch them and dedupe skips
// venue-less rows entirely. Match those by title instead. Keep patterns tight
// so only the owned events match: /rubberducks\s+vs/ hits home games (owned by
// the `rubberducks` feed with the real venue + price) but leaves DAP-only promos
// like "Win RubberDucks Tickets at the Lockview" alone.
const DIRECTLY_SCRAPED_TITLE_PATTERNS = [
  { pattern: /\brubberducks\s+vs\b/i, scraper: 'rubberducks' },
]

/** Returns the direct scraper key that owns this event by title, or null. */
function directlyScrapedTitle(title) {
  if (!title) return null
  for (const t of DIRECTLY_SCRAPED_TITLE_PATTERNS) {
    if (t.pattern.test(title)) return t.scraper
  }
  return null
}

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureVenueByName(venueName) {
  if (!venueName) return null
  const name = venueName.trim()
  if (venueCache.has(name)) return venueCache.get(name)

  // Create a minimal venue record — we don't have full address data from DAP calendar
  const venueId = await ensureVenue(name, {
    city:         'Akron',
    state:        'OH',
    parking_type: 'unknown',
  })

  venueCache.set(name, venueId)
  return venueId
}

async function ensureDapOrganizer() {
  return ensureOrganization('Downtown Akron Partnership', {
    website:     'https://www.downtownakron.com',
    description: "The Downtown Akron Partnership promotes events, culture, and entertainment in downtown Akron's 49-block district.",
  })
}

// ── HTML fetch ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      'Accept':     'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Parse event cards ──────────────────────────────────────────────────────

/**
 * The ctycms calendar page renders events as <a href="/event/{slug}"> elements.
 * The innerText of each link contains tab/newline-separated fields:
 *   title
 *   time / venue
 *   View Details
 *   day-of-week \t day-number \t month-abbr
 *
 * Example innerText:
 *   "Man of LaMancha\n\t\t2 p.m. / Ohio Shakespeare Festival\n\t\tView Details\n\t\n\t\t\tSunday\t\t22\t\tMar"
 */
function parseCalendarHtml(html) {
  const events = []

  // Find all event links
  const linkPattern = /<a[^>]*href="(\/event\/([^"/?#]+))[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const matches     = [...html.matchAll(linkPattern)]

  for (const match of matches) {
    const slug      = match[2]
    const linkHref  = BASE_URL + match[1]
    const innerHtml = match[3]

    // Split the card's inner HTML on tag boundaries so each field (title, time,
    // venue, weekday, day, month) becomes its own part. The previous approach
    // (stripHtml + split on /[\n\t]+/) broke when the ctycms markup stopped
    // emitting literal tabs/newlines between fields and stripHtml started
    // collapsing whitespace — every card flattened to a single part.
    const parts = innerHtml
      .split(/<[^>]+>/)
      .map(p => decodeEntities(p).replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    if (parts.length < 3) continue

    // First non-empty, non-"View Details" part is the title
    const title = parts.find(p => p.toLowerCase() !== 'view details' && p.length > 2)
    if (!title) continue

    let   timeStr  = '12:00:00'
    let   venueName = null

    // Legacy layout: a single "<time> / <venue>" part.
    const timeVenuePart = parts.find(p => p.includes(' / '))
    if (timeVenuePart) {
      const [timePart, ...venueParts] = timeVenuePart.split(' / ')
      timeStr   = parseTime(timePart)
      venueName = venueParts.join(' / ').trim() || null
    } else {
      // Current layout: time and venue are separate parts.
      const timePart = parts.find(p => /\d\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight/i.test(p))
      if (timePart) timeStr = parseTime(timePart)
      const WEEKDAY = /^(?:sun|mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?)(?:day)?$/i
      venueName = parts.find(p =>
        p !== title &&
        p !== timePart &&
        p.toLowerCase() !== 'view details' &&
        !/\d/.test(p) &&
        !WEEKDAY.test(p) &&
        !MONTH_MAP[p.toLowerCase()] &&
        // Exclude bare time words only. The previous /(?:a\.?m\.?|p\.?m\.?)/i
        // test matched "am"/"pm" anywhere in a string, so venues like "Full Grip
        // Games" (the "am" inside "Games") or "Programs" were silently dropped
        // and left null. Real clock times like "12pm" still carry a digit and
        // are already excluded by the !/\d/ test above.
        !/^(?:noon|midnight)$/i.test(p)
      ) || null
    }

    // Find date parts — look for day number and month abbreviation
    // ctycms renders like: "Sunday\t\t22\t\tMar" or "22\tMar"
    // Search for a number 1-31 followed by a month abbreviation
    const remaining = parts.filter(p => p !== title && !p.includes(' / ') && p.toLowerCase() !== 'view details')
    let dayNum  = null
    let monthAb = null

    for (const part of remaining) {
      // Check for numeric day
      const numMatch = part.match(/^(\d{1,2})$/)
      if (numMatch) { dayNum = numMatch[1]; continue }

      // Check for month abbreviation
      const monKey = part.toLowerCase().trim()
      if (MONTH_MAP[monKey]) { monthAb = monKey; continue }
    }

    // Also try to match from the full text with a combined pattern
    if (!dayNum || !monthAb) {
      const combined = parts.join(' ')
      const dateMatch = combined.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\b/)
      if (dateMatch) {
        const candidate = dateMatch[2].toLowerCase()
        if (MONTH_MAP[candidate]) {
          dayNum  = dayNum  || dateMatch[1]
          monthAb = monthAb || candidate
        }
      }
      // Also try "MonthAbbr DayNum" ordering
      const dateMatch2 = combined.match(/\b([A-Za-z]{3,})\s+(\d{1,2})\b/)
      if (dateMatch2 && MONTH_MAP[dateMatch2[1].toLowerCase()]) {
        dayNum  = dayNum  || dateMatch2[2]
        monthAb = monthAb || dateMatch2[1].toLowerCase()
      }
    }

    if (!dayNum || !monthAb) continue

    const dateStr = reconstructDate(dayNum, monthAb)
    if (!dateStr) continue

    events.push({ title, dateStr, timeStr, venueName, slug, linkHref })
  }

  return events
}

// ── Build month URLs ───────────────────────────────────────────────────────

function getMonthUrls() {
  const urls  = [`${BASE_URL}/calendar`]
  const now   = new Date()

  for (let i = 1; i <= 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    urls.push(`${BASE_URL}/calendar?month=${month}`)
  }

  return urls
}

// ── Process ────────────────────────────────────────────────────────────────
//
// Aggregator precedence (2026-07-02 data-quality plan, task 3): DAP is a
// Tier-3 aggregator. DIRECTLY_SCRAPED_VENUES above suppresses the handful of
// venues we've manually audited as a complete superset. For every other
// venue, classify against whatever Tier-1/2 (trusted) events are already
// linked to it:
//   - no trusted events at this venue at all      → publish normally
//   - a trusted event within 3 days at this venue → suppress (real duplicate)
//   - trusted events exist, but none nearby        → publish + needs_review
//     (a scraper gap or a genuine DAP-only program — human decides; never
//     silently drop, per "Free Thursday at Akron Art Museum" — DAP's only
//     copy even though akron_art_museum is scraped)
// One venue lookup per unique venue per run, cached below.
const trustedEventsCache = new Map()
async function trustedEventsFor(venueId) {
  if (!venueId) return []
  if (!trustedEventsCache.has(venueId)) {
    trustedEventsCache.set(venueId, await getTrustedEventsAtVenue(venueId))
  }
  return trustedEventsCache.get(venueId)
}

async function processEvents(events, organizerId) {
  let inserted = 0, skipped = 0, suppressedByTier = 0, flaggedForReview = 0

  for (const ev of events) {
    try {
      const venueId = await ensureVenueByName(ev.venueName)
      const startAt = easternToIso(ev.dateStr, ev.timeStr)
      if (!startAt) { skipped++; continue }

      const trusted = await trustedEventsFor(venueId)
      const { suppress, needsReview } = classifyAgainstTrusted(trusted, startAt)
      if (suppress) {
        suppressedByTier++
        console.log(`  ⤷ Suppressing "${ev.title}" — a Tier-1/2 event covers this venue within 3 days`)
        continue
      }

      const row = {
        title:           ev.title,
        description:     null,
        start_at:        startAt,
        end_at:          null,
        category:        parseCategory(ev.title),
        tags:            ['downtown-akron', 'akron', ...(ev.venueName ? [ev.venueName.toLowerCase()] : [])],
        price_min:       null,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       null,
        ticket_url:      ev.linkHref,
        source:          'downtown_akron',
        source_id:       ev.slug,
        status:          'published',
        featured:        false,
        ...(needsReview ? { needs_review: true } : {}),
      }
      if (needsReview) flaggedForReview++

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
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped, suppressedByTier, flaggedForReview }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Downtown Akron Partnership ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureDapOrganizer()

    const monthUrls = getMonthUrls()
    const allEvents = []
    const seenSlugs = new Set()

    for (const url of monthUrls) {
      console.log(`\n🔍  Fetching ${url}…`)
      try {
        const html   = await fetchHtml(url)
        const events = parseCalendarHtml(html)
        console.log(`  Found ${events.length} events`)

        for (const ev of events) {
          if (!seenSlugs.has(ev.slug)) {
            seenSlugs.add(ev.slug)
            allEvents.push(ev)
          }
        }
      } catch (fetchErr) {
        console.warn(`  ⚠ Could not fetch ${url}:`, fetchErr.message)
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 500))
    }

    // Filter out past events
    const now     = new Date()
    const today   = now.toISOString().split('T')[0]
    const future  = allEvents.filter(ev => ev.dateStr >= today)
    console.log(`\n  Total unique future events: ${future.length} (from ${allEvents.length} total found)`)

    if (future.length === 0) {
      console.warn('  ⚠ No future events found. Calendar page structure may have changed.')
    }

    // Drop events hosted at venues we scrape directly (see DIRECTLY_SCRAPED_VENUES).
    let suppressed = 0
    const visible = future.filter(ev => {
      const owner = directlyScrapedVenue(ev.venueName) || directlyScrapedTitle(ev.title)
      if (owner) {
        suppressed++
        console.log(`  ⤷ Suppressing "${ev.title}" — covered directly by ${owner}`)
        return false
      }
      return true
    })
    if (suppressed > 0) {
      console.log(`\n  Suppressed ${suppressed} event(s) at directly-scraped venues.`)
    }

    console.log(`\n📥  Processing ${visible.length} events…`)
    const { inserted, skipped, suppressedByTier, flaggedForReview } = await processEvents(visible, organizerId)
    if (suppressedByTier > 0) console.log(`  Suppressed ${suppressedByTier} event(s) — a Tier-1/2 source covers the venue within 3 days.`)
    if (flaggedForReview > 0) console.log(`  Flagged ${flaggedForReview} event(s) needs_review — venue has Tier-1/2 coverage but nothing nearby.`)

    await logUpsertResult('downtown_akron', inserted, 0, skipped, {
      eventsFound: future.length,
      suppressed: suppressed + suppressedByTier,
      flaggedForReview,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('downtown_akron', err, start)
    process.exit(1)
  }
}

// Pure parsers exported for unit tests (no live run on import).
export { parseCalendarHtml, parseTime, reconstructDate, directlyScrapedVenue, directlyScrapedTitle }

// Run only when invoked directly (`node scripts/scrape-downtown-akron.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
