/**
 * scrape-bath-township.js
 *
 * Bath Township, Ohio (Summit County) — Revize CMS. Bath Township runs the
 * same Revize Calendar plugin the City of Akron does, and it exposes the
 * identical public JSON feed endpoint (calendar_data_handler.php). We pull that
 * feed rather than scraping the prose community-events page: the JSON carries
 * clean, timezone-consistent start/end fields, per-item locations, and event
 * detail URLs, so there is no need to reverse-engineer the "Month Day, Weekday"
 * prose grid.
 *
 * Feed:
 *   https://www.bathtownship.org/_assets_/plugins/revizeCalendar/calendar_data_handler.php
 *     ?webspace=bathtownshipoh&relative_revize_url=//builder1.revize.com&protocol=https:
 *
 * Wire format (mirrors the Akron Lock 3 feed):
 *   Array of events; each has title, start, end, desc, url, location, image,
 *   rid, id, calendar_displays[], color, duration, options, [rrule].
 *   `start`/`end` are ISO-shaped LOCAL-EASTERN strings without a "Z" suffix
 *   (e.g. "2026-06-07T10:00:00"); we convert via easternToIso.
 *   `desc`/`image` are URL-encoded HTML fragments — decode + sanitise.
 *
 * The critical difference from Akron: this is a TOWNSHIP GOVERNMENT calendar.
 * ~90% of the feed is administrative — Board of Trustees work sessions, Zoning
 * Commission, Board of Zoning Appeals, Appearance Review Commission, committee
 * meetings, public hearings — plus holiday "Township Offices Closed" markers.
 * None of those are public-facing events, so we drop them with a meeting filter
 * (same pattern as scrape-city-of-cuyahoga-falls.js). What survives is the small
 * set of genuine community events: the Bath Art Festival, Celebrate America 250,
 * the Heritage Corridors Barn Social, Memorial Day Observance, Project Pride,
 * the BBA Garage Sale, and nature/STEM programming.
 *
 * Venues: the feed's `location` field is usually a bare street address, which the
 * ensureVenue address guard (correctly) refuses to mint as a venue name. We map
 * the handful of known community-event addresses to their real venue names
 * (Bath Community Park, Bath Nature Preserve, Bath Township Veterans Memorial);
 * township-wide or unspecified events fall back to a "Bath Township" venue.
 *
 * Geography: every event is inside Bath Township (Summit County). We still run
 * the venue city through classifySummitLocation so the strict Summit gate is
 * honoured uniformly — 'in' → published, 'unknown' → pending_review, 'out' →
 * skip.
 *
 * Usage:
 *   node scripts/scrape-bath-township.js
 *   node scripts/scrape-bath-township.js --dry-run   # fetch + parse only
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'bath_township'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://www.bathtownship.org'
const FEED_URL =
  `${ORIGIN}/_assets_/plugins/revizeCalendar/calendar_data_handler.php` +
  '?webspace=bathtownshipoh&relative_revize_url=//builder1.revize.com&protocol=https:'

// Public community-events landing page, used as a source_url fallback when a
// feed row carries no event-specific URL.
const LANDING_URL = `${ORIGIN}/residents/stay_informed/community_events/index.php`

// 1 day of grace so same-day events stay visible until midnight ET.
const PAST_GRACE_MS = 86_400_000
// 180-day forward horizon — matches the project's other ingestion windows.
const HORIZON_DAYS = 180

// ── Non-event filter ─────────────────────────────────────────────────────────
//
// This is a government calendar: the overwhelming majority of rows are board
// meetings, commissions, committees, hearings, and holiday office closures.
// None are public events. We gate on the title the same way the Cuyahoga Falls
// and CivicPlus scrapers do. "Heritage Corridors of Bath" and "Discover Bath
// Barns Committee" are the township's heritage-committee MEETINGS (their public
// output — the Barn Social — is a separate, differently-titled row that passes).
// "Content Editing Training" rows are internal Revize CMS training sessions.
const MEETING_RE = new RegExp(
  [
    'board of trustees', '\\btrustees?\\b', 'board of zoning',
    'zoning commission', 'zoning appeals?', 'appearance review',
    'water and sewer', 'park board', 'business association meeting',
    'heritage corridors', 'discover bath barns', 'content editing training',
    '\\bcommittee\\b', '\\bcommission\\b', 'city council', '\\bcouncil\\b',
    'work session', 'public hearing', 'special meeting', 'regular meeting',
    'settlement meeting', 'executive session', 'board meeting', '\\bcaucus\\b',
    '\\bboard\\b',
  ].join('|'),
  'i',
)

// Holiday / office-closure markers. Every closure row except a bare "New Year's
// Eve" carries "Offices Closed"; the New Year's tokens catch the exception.
const CLOSURE_RE = /offices?\s+closed|\bnew\s+year'?’?s\s+(eve|day)\b/i

// Cancelled / postponed rows. Revize leaves the calendar entry in place with a
// CANCELLED marker rather than removing it, so a scratched community event
// ("Bath Art Festival - CANCELLED", "**CANCELLED** …") is still in the feed and
// must be dropped. Matches both spellings (cancelled / canceled). Mirrors the
// shared CivicPlus filter (lib/civicplus.js isPublicCivicPlusEvent).
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

export function isPublicCommunityEvent(title) {
  const t = stripHtml(String(title || '')).trim().toLowerCase()
  if (!t) return false
  if (CANCELLED_RE.test(t)) return false
  if (CLOSURE_RE.test(t)) return false
  if (MEETING_RE.test(t)) return false
  return true
}

// ── Venue resolution ─────────────────────────────────────────────────────────
//
// Feed `location` values for community events are bare street addresses. We map
// the known ones to their real venue names (the ensureVenue guard refuses to
// mint address-named venues, and rightly so). Unmapped / empty locations fall
// back to a township-wide "Bath Township" venue.
const DEFAULT_VENUE = {
  name: 'Bath Township',
  address: null,
  city: 'Akron',
  state: 'OH',
  zip: '44333',
}

const KNOWN_VENUES = {
  '4160 ira road': {
    name: 'Bath Nature Preserve',
    address: '4160 Ira Rd',
    city: 'Akron',
    state: 'OH',
    zip: '44333',
  },
  '1615 n cleveland-massillon rd': {
    name: 'Bath Community Park',
    address: '1615 N Cleveland-Massillon Rd',
    city: 'Akron',
    state: 'OH',
    zip: '44333',
  },
  '1241 n. cleveland massillon road': {
    name: 'Bath Township Veterans Memorial',
    address: '1241 N Cleveland-Massillon Rd',
    city: 'Akron',
    state: 'OH',
    zip: '44333',
  },
}

function normalizeLocationKey(raw) {
  return stripHtml(String(raw || ''))
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase()
}

/**
 * Resolve a feed `location` string to a venue spec.
 * - empty / "Bath Township" → township-wide default
 * - known bare address       → mapped real venue
 * - other bare address       → passed through; ensureVenue's guard will route
 *   it to a canonical venue by address or leave the event venue-less
 * - real place name          → used as-is
 */
export function resolveVenueSpec(rawLocation) {
  const key = normalizeLocationKey(rawLocation)
  if (!key || key === 'bath township') return DEFAULT_VENUE
  if (KNOWN_VENUES[key]) return KNOWN_VENUES[key]
  const cleanName = stripHtml(String(rawLocation)).replace(/\s+/g, ' ').trim()
  return { name: cleanName, city: 'Akron', state: 'OH', zip: '44333' }
}

// ── Field helpers ────────────────────────────────────────────────────────────

/**
 * Convert a Revize start/end value into a UTC ISO string.
 * Feed values look like "2026-06-07T10:00:00" — local Eastern, no zone.
 */
export function revizeIsoToUtc(raw) {
  if (!raw) return null
  const cleaned = String(raw).trim().replace(/Z$/, '').replace('T', ' ').slice(0, 19)
  return easternToIso(cleaned)
}

/** Decode the URL-encoded `desc` HTML fragment to readable plain text. */
export function decodeDescription(rawDesc) {
  if (!rawDesc || typeof rawDesc !== 'string') return null
  let html
  try {
    html = decodeURIComponent(rawDesc)
  } catch {
    html = rawDesc
  }
  const text = htmlToText(html).trim()
  return text.length ? text : null
}

/**
 * Extract a usable image URL from the feed's `image` markup. Drops Revize
 * placeholder assets, and resolves relative paths (including the "./Events/…"
 * form Bath uses, whose spaces must be percent-encoded) against the origin.
 */
export function extractImageUrl(rawImage) {
  if (!rawImage || typeof rawImage !== 'string') return null
  let html
  try {
    html = decodeURIComponent(rawImage)
  } catch {
    html = rawImage
  }
  const m = html.match(/<img[^>]*src="([^"]+)"/i)
  if (!m) return null
  let src = m[1].trim()
  if (/placeholder\.png|noimage\.(?:gif|png)/i.test(src)) return null
  if (/^https?:/i.test(src)) return src
  if (/^\/\//.test(src)) return `https:${src}`
  src = src.replace(/^\.?\//, '') // "./Events/…" or "/Events/…" → "Events/…"
  return encodeURI(`${ORIGIN}/${src}`)
}

/**
 * Normalise a feed URL: rewrite the internal Revize builder host to the public
 * bathtownship.org origin; reject non-http values.
 */
export function normalizeSourceUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  const u = raw.trim()
  if (!/^https?:/i.test(u)) return null
  return u.replace(
    /^https?:\/\/builder1\.revize\.com\/revize\/bathtownshipoh\//i,
    `${ORIGIN}/`,
  )
}

/** True when the event's window overlaps [now - grace, now + horizon]. */
export function isWithinWindow(startUtc, endUtc, nowMs = Date.now()) {
  if (!startUtc) return false
  const startMs = new Date(startUtc).getTime()
  const endMs = endUtc ? new Date(endUtc).getTime() : startMs
  if (Number.isNaN(startMs)) return false
  if (endMs < nowMs - PAST_GRACE_MS) return false
  if (startMs > nowMs + HORIZON_DAYS * 86_400_000) return false
  return true
}

/**
 * Pure transform: feed row → { row, venueSpec } (no DB access).
 * Returns null for non-events.
 */
export function buildRow(ev) {
  if (!ev || !ev.title || !ev.start) return null
  const title = stripHtml(ev.title).replace(/\s+/g, ' ').trim()
  if (!isPublicCommunityEvent(title)) return null

  const start_at = revizeIsoToUtc(ev.start)
  const end_at = revizeIsoToUtc(ev.end)
  if (!start_at) return null

  const description = decodeDescription(ev.desc)
  const category = inferCategory(title, description || '')
  const evUrl = normalizeSourceUrl(ev.url)
  const venueSpec = resolveVenueSpec(ev.location)

  // Stable id. Append the occurrence date for recurring rows so a future series
  // instance never collides with another (community events are one-offs today,
  // but this keeps the id contract correct if that changes).
  const baseId = `revize_${ev.rid || ev.id}`
  const source_id = ev.rrule ? `${baseId}-${String(start_at).slice(0, 10)}` : baseId

  return {
    venueSpec,
    row: {
      title,
      description,
      start_at,
      end_at,
      category,
      tags: ['bath-township', 'summit-county'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: extractImageUrl(ev.image),
      ticket_url: evUrl,
      source_url: evUrl ?? LANDING_URL,
      source: SOURCE_KEY,
      source_id,
      status: 'published',
      featured: false,
    },
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Revize feed HTTP ${res.status}`)
  const json = await res.json()
  if (Array.isArray(json)) return json
  if (Array.isArray(json?.events)) return json.events
  throw new Error(`Unexpected feed shape: top-level=${typeof json}`)
}

// ── Venue / organizer ────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureBathVenue(venueSpec, organizerId) {
  const key = venueSpec.name
  if (venueCache.has(key)) return venueCache.get(key)

  const venueId = await ensureVenue(venueSpec.name, {
    address: venueSpec.address || undefined,
    city: venueSpec.city,
    state: venueSpec.state,
    zip: venueSpec.zip,
    website: ORIGIN,
  })

  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(key, venueId)
  return venueId
}

async function ensureTownshipOrg() {
  return ensureOrganization('Bath Township', {
    website: ORIGIN,
    description:
      'Bath Township, Ohio (Summit County). Hosts community events including ' +
      'the Bath Art Festival, Memorial Day Observance, and Heritage Corridors ' +
      'of Bath programming.',
  })
}

// ── Upsert pipeline ──────────────────────────────────────────────────────────

async function processEvents(prepared, organizerId) {
  let inserted = 0
  let skipped = 0

  for (const { row, venueSpec } of prepared) {
    try {
      // Strict Summit gate, applied on the resolved venue's city. Every Bath
      // Township event is in Summit County, but we route defensively.
      const geo = classifySummitLocation({ city: venueSpec.city })
      if (geo === 'out') {
        skipped++
        continue
      }
      if (geo === 'unknown') {
        row.status = 'pending_review'
        row.needs_review = true
      }

      const venueId = await ensureBathVenue(venueSpec, organizerId)
      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${row.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Bath Township ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    const organizerId = DRY_RUN ? null : await ensureTownshipOrg()

    console.log('\n🔍  Fetching Bath Township Revize feed…')
    const all = await fetchFeed()
    console.log(`  Feed returned ${all.length} total calendar row(s).`)

    const now = Date.now()
    const built = all.map(buildRow).filter(Boolean)
    console.log(`  ${built.length} public community event(s) after dropping meetings/closures.`)

    const prepared = built.filter(b => isWithinWindow(b.row.start_at, b.row.end_at, now))
    console.log(`  ${prepared.length} within the ${HORIZON_DAYS}-day window.`)

    // Defensive within-run dedup on source_id.
    const seen = new Set()
    const unique = prepared.filter(b => {
      if (seen.has(b.row.source_id)) return false
      seen.add(b.row.source_id)
      return true
    })

    if (DRY_RUN) {
      console.log(`\n🧪  Dry-run: ${unique.length} event(s) prepared — nothing written.`)
      for (const { row, venueSpec } of unique) {
        console.log(`     • ${row.title}  [${row.start_at}]  cat=${row.category}  @ ${venueSpec.name}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    console.log(`\n📥  Processing ${unique.length} event(s)…`)
    const { inserted, skipped } = await processEvents(unique, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: unique.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
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
