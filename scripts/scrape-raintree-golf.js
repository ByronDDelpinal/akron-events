/**
 * scrape-raintree-golf.js
 *
 * Raintree Golf & Event Center — a public golf course and banquet venue at
 * 4350 Mayfair Rd in Uniontown (Summit County; Uniontown straddles the county
 * line and is deliberately on the SUMMIT_COUNTY_CITIES allowlist). Beyond public
 * play it hosts a steady summer schedule of charity golf outings — the exact
 * kind of open-registration community events Akron Pulse surfaces.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Peninsula Coffee House / Peninsula Foundation / Royal Palace scrapers.
 *   https://www.golfraintree.com/wp-json/tribe/events/v1/events
 *
 * Feed quirks (verified 2026-07-14):
 *   • MIXED TIMEZONE CONFIG. Some events report timezone "America/New_York"
 *     (correct: utc_start_date is the true UTC instant), but at least one older
 *     event reports "UTC+0" with utc_start_date === start_date — i.e. its "UTC"
 *     field is really Eastern wall-clock. Rather than branch on the (unreliable)
 *     timezone field or trust utc_start_date, we take the LOCAL `start_date`
 *     wall-clock string — which is Eastern in BOTH configs — and run it through
 *     easternToIso. That yields the correct UTC instant universally, and we never
 *     append 'Z' to utc_start_date (which would shift the misconfigured event 4h
 *     early). This is the same timezone-misconfiguration guard the Peninsula
 *     Coffee House scraper documents.
 *   • MOST OUTINGS ARE all_day: true WITH A REAL TEE-OFF TIME IN THE PROSE. The
 *     feed stores golf outings as all-day (00:00:00) even though the description
 *     states a "9:00 AM Shotgun Start". We never silently synthesize midnight:
 *     for all-day / midnight events we extract the shotgun/tee-off time from the
 *     description (extractTimeToken) and only fall back to a documented
 *     midnight-Eastern all-day start if the prose carries no time.
 *   • PRICE IS INTENTIONALLY LEFT NULL. The Tribe `cost` range conflates the
 *     per-person / per-foursome entry fee with a ladder of sponsorship tiers
 *     ($100 hole sign … $3,000 title sponsor), so a naive min/max (e.g.
 *     "$30 – $2,000") misrepresents what an attendee actually pays. The entry
 *     fee is preserved verbatim in the description instead. Never assume free.
 *   • Single fixed, known-in-county venue: every event is at Raintree, so we pin
 *     to one canonical venue record and skip per-event geo classification.
 *   • image is often `false` even when the description embeds a banner <img>; we
 *     fall back to the inline image (parseImage).
 *
 * Category: the feed's only category is "Golf Outing" → sports (open-registration
 * outings/leagues). Dinners/holiday events (should the venue list any) → food;
 * anything else falls through to inferCategory. Private banquets/weddings are
 * skipped (shouldSkip).
 *
 * Usage:   node scripts/scrape-raintree-golf.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue, parseTagsFromTribe,
} from './lib/normalize.js'

export const SOURCE_KEY = 'raintree_golf'
const BASE_URL   = 'https://www.golfraintree.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
// A normal desktop UA — WordPress/Tribe installs behind WAFs (mod_security,
// Wordfence) reject non-browser User-Agents with a 406.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ORG_NAME   = 'Raintree Golf & Event Center'
const VENUE_NAME = 'Raintree Golf & Event Center'
const VENUE_DETAILS = {
  address: '4350 Mayfair Rd',
  city: 'Uniontown', state: 'OH', zip: '44685',
  phone: '330.699.3232',
  website: 'https://www.golfraintree.com',
  parking_type: 'lot',
  description: 'Public golf course and event center in Uniontown (Summit County) hosting charity golf outings, leagues, and banquet events.',
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

// Content category from the Tribe categories + title. This venue's public
// programming is golf outings (→ sports); dinners/holiday events map to food;
// anything else defers to inferCategory. Matched on category names + title (not
// the description — outing descriptions mention "buffet dinner", which must not
// pull them into food).
const SPORTS_RE = /\b(golf|outing|scramble|league|tournament|tee\s*off|shotgun|open\b)/i
const FOOD_RE   = /\b(dinner|brunch|breakfast|buffet|tasting|thanksgiving|christmas|easter|holiday\s+(dinner|meal)|fish\s*fry)\b/i

/** 'sports' | 'food' | null (null → let inferCategory decide). Exported for tests. */
export function parseCategory(ev = {}) {
  const catText = (ev.categories ?? [])
    .map((c) => `${c.slug ?? ''} ${c.name ?? ''}`).join(' ')
  const hay = `${catText} ${ev.title ?? ''}`
  if (SPORTS_RE.test(hay)) return 'sports'
  if (FOOD_RE.test(hay))   return 'food'
  return null
}

/**
 * Private, non-public rentals the venue might list (a specific couple's wedding,
 * a private shower/party). Public shows ("Bridal Resale Show" — a market) are NOT
 * private and are deliberately not matched. Exported for tests.
 */
const PRIVATE_RE = /\b(wedding|rehearsal dinner|private (party|event|banquet|rental)|baby shower|bridal shower)\b/i
export function shouldSkip(title = '') {
  return PRIVATE_RE.test(String(title))
}

/**
 * Pull a clock token (e.g. "9:00 AM", "9 a.m.") from an event's description
 * prose. Prefers a time adjacent to a "shotgun"/"tee-off"/"start" cue (the
 * tee-off time golf outings publish); falls back to the first am/pm time. The
 * returned raw token is handed to easternToIso's time arg (which parses 12-hour
 * formats). Returns null when the prose carries no time. Exported for tests.
 */
const TIME = String.raw`\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?`
const TIME_BEFORE_CUE = new RegExp(`(${TIME})\\s*(?:shotgun|tee\\s*off|start)`, 'i')
const CUE_BEFORE_TIME = new RegExp(`(?:shotgun|tee\\s*off|start)[^\\d]{0,15}(${TIME})`, 'i')
const ANY_TIME        = new RegExp(`(${TIME})`, 'i')
export function extractTimeToken(text = '') {
  const s = stripHtml(String(text))
  return (
    s.match(TIME_BEFORE_CUE)?.[1] ??
    s.match(CUE_BEFORE_TIME)?.[1] ??
    s.match(ANY_TIME)?.[1] ??
    null
  )?.trim() ?? null
}

/**
 * Resolve start/end to correct UTC ISO instants. The local `start_date` string
 * is Eastern wall-clock in every timezone config this feed emits (see header),
 * so easternToIso on it is universally correct. For all-day / midnight events we
 * override the time with the description's tee-off time; only when no prose time
 * exists do we fall back to a documented midnight-Eastern all-day start (end
 * unknown). Returns { start_at, end_at, timeSource }. Exported for tests.
 */
export function resolveStartEnd(ev = {}) {
  const startLocal = String(ev.start_date ?? '')
  const date = startLocal.slice(0, 10)
  if (!date) return { start_at: null, end_at: null, timeSource: 'none' }

  const timePart   = startLocal.slice(11)            // "HH:MM:SS" or ''
  const isMidnight = !timePart || timePart.startsWith('00:00')

  if (ev.all_day || isMidnight) {
    const token = extractTimeToken(ev.description ?? '')
    if (token) {
      return { start_at: easternToIso(date, token), end_at: null, timeSource: 'prose' }
    }
    // Genuinely all-day with no time anywhere: documented midnight-Eastern start.
    return { start_at: easternToIso(date, ''), end_at: null, timeSource: 'all_day' }
  }

  return {
    start_at: easternToIso(startLocal),
    end_at:   ev.end_date ? easternToIso(String(ev.end_date)) : null,
    timeSource: 'feed',
  }
}

/** Stable per-event source_id. These outings are one-off posts with unique ids. */
export function buildSourceId(ev = {}) {
  return String(ev.id)
}

/** Image from a Tribe image object (may be `false`), else an inline <img>. */
export function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return String(descriptionHtml).match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Raintree Golf events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    })
    // Tribe returns 400 with a "no results" code when the window is empty —
    // treat that as zero events rather than an error.
    if (res.status === 400) break
    if (!res.ok) throw new Error(`Raintree Golf API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const cutoff = Date.now() - 86400_000 // skip anything ended > ~1 day ago

  for (const ev of rawEvents) {
    try {
      const title = stripHtml(ev.title ?? '')
      if (!title) { skipped++; continue }
      if (shouldSkip(title)) { skipped++; continue }

      const { start_at, end_at, timeSource } = resolveStartEnd(ev)
      if (!start_at) { skipped++; continue }
      if (new Date(start_at).getTime() < cutoff) { skipped++; continue }
      if (timeSource === 'all_day') {
        console.warn(`  ⚠ "${title}" has no tee-off time in prose — stored as midnight-Eastern all-day`)
      }

      const description = htmlToText(ev.description ?? '') || null
      const cat = parseCategory(ev)

      const row = {
        title,
        description,
        start_at,
        end_at,
        // Golf outings are unambiguously 'sports'; passing a `categories` ARRAY
        // bypasses upsertEventSafe's text inference for the content axis (the
        // "buffet dinner"/"silent auction" prose would otherwise mis-tag). When
        // parseCategory can't classify, we omit it and let inference decide.
        ...(cat ? { categories: [cat] } : {}),
        tags:            parseTagsFromTribe(ev.categories, ev.tags, ['golf', 'raintree']),
        price_min:       null,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       parseImage(ev.image, ev.description),
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing event ${ev.id}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('⛳  Starting Raintree Golf & Event Center ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: VENUE_DETAILS.website, description: VENUE_DETAILS.description }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

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
