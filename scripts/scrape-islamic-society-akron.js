/**
 * scrape-islamic-society-akron.js
 *
 * Islamic Society of Akron & Kent (ISAK) — the mosque / Islamic community center
 * at 152 E Steels Corners Rd, Cuyahoga Falls, OH 44224 (Summit County). Its
 * calendar is dominated by internal congregational life (Jummah/Friday prayers,
 * Qur'an classes, halaqas, youth group, maktab school) but ISAK also runs a
 * steady run of genuinely PUBLIC-community events: interfaith potlucks, community
 * iftars, Eid festivals & prayers, charity fundraisers (Gaza relief, the AAIC
 * Hunger Walk), film screenings, and outreach programs. Those public events are
 * what Akron Pulse surfaces.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Royal Palace / Torchbearers / Indivisible Akron scrapers.
 *   http://isak.us/wp-json/tribe/events/v1/events
 *
 * ── QUIRK 1: broken site timezone ────────────────────────────────────────────
 * ISAK's WordPress timezone is misconfigured to "UTC+0", so the API's
 * `utc_start_date` is IDENTICAL to the local `start_date` and both hold the
 * EASTERN WALL-CLOCK time (verified: the hike whose description reads "3:00 PM"
 * carries start_date "…15:00:00"). Feeding utc_start_date to the DB as UTC would
 * shift every event 4–5 hours early. We therefore parse `start_date` as Eastern
 * local via easternToIso(), NOT utc_start_date. (Royal Palace / Torchbearers can
 * trust utc_start_date because those sites are configured correctly.)
 *
 * ── QUIRK 2: faith allowlist (mandatory) ─────────────────────────────────────
 * A mosque calendar is overwhelmingly internal. We gate every event through a
 * category-driven allowlist (isPublicISAKEvent):
 *   • PUBLIC_CATEGORIES  (Outreach Programming / Eid Celebration / Fundraiser) —
 *     ISAK's own public-facing buckets — auto-include.
 *   • PRIVATE_CATEGORIES (Youth Services, Classes, Halaqa, Jummah Services,
 *     Education, Sunday School, Convert Services, Brothers'/Women's Programming) —
 *     audience-targeted / worship / class programming — hard skip, even if the
 *     title trips a public keyword (a "Reverts' Potluck Iftar" under Convert
 *     Services is a members-only program, not a public iftar). PRIVATE wins over
 *     PUBLIC when an event carries both (strict faith stance).
 *   • Everything else (Programs, Ramadan, uncategorized) falls to the shared
 *     text allowlist isPublicFaithEvent() PLUS a local mosque-term supplement
 *     (EXTRA_PUBLIC_RE: "iftar", "eid", "interfaith") the shared church-oriented
 *     list misses. This catches e.g. "ISAK Community Iftar" [Ramadan] and
 *     "Fall Bazaar" [Programs] while dropping "Ramadan Recharge" and internal
 *     meetings. (Recommend folding iftar/eid/interfaith into faith-events.js;
 *     see report.) Expect to skip the large majority of the feed — that's correct.
 *
 * ── QUIRK 3: geography ───────────────────────────────────────────────────────
 * Most events are at the Cuyahoga Falls mosque, but ISAK also holds events at
 * outside venues (Ledges Trailhead in Peninsula, Fairlawn for the Hunger Walk,
 * even a Columbia Station hall in Lorain County). Each Tribe event carries its
 * own venue, so we gate per-event through classifySummitLocation():
 *   'out' → skip; 'unknown' → ingest pending_review; 'in' → published.
 * The mosque's several room-level sub-venues (ISAK, ISAK Prayer Hall, ISAK Youth
 * Lounge, Islamic Community Hall — all at 152 E Steels Corners Rd) collapse onto
 * one canonical venue, "Islamic Society of Akron & Kent". Events with no venue
 * default to that canonical mosque venue (Cuyahoga Falls → published).
 *
 * Usage:   node scripts/scrape-islamic-society-akron.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, fetchSchemaDescription,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  easternToIso, inferCategory, parseCostFromTribe, parseTagsFromTribe,
} from './lib/normalize.js'
import { isPublicFaithEvent } from './lib/faith-events.js'
import { classifySummitLocation, preloadSummitCountyBoundary } from './lib/summit-county.js'

export const SOURCE_KEY = 'islamic_society_akron'
const BASE_URL   = 'http://isak.us/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME = 'Islamic Society of Akron & Kent'
const MOSQUE_VENUE_NAME = 'Islamic Society of Akron & Kent'
const MOSQUE_VENUE_DETAILS = {
  address: '152 E Steels Corners Rd', city: 'Cuyahoga Falls', state: 'OH', zip: '44224',
  website: 'http://isak.us',
  description: 'Mosque and Islamic community center in Cuyahoga Falls serving the greater Akron and Kent Muslim community.',
}

// ── Faith allowlist gate (exported for tests) ───────────────────────────────

// ISAK's own public-facing categories. Everything filed here is a public
// community event (outreach, an Eid celebration, or a fundraiser).
const PUBLIC_CATEGORIES = new Set([
  'outreach programming', 'eid celebration', 'fundraiser',
])

// Internal / audience-targeted / worship / class categories — a hard skip even
// when the title carries a public keyword. Deliberately does NOT include the
// generic "Programs" or "Ramadan" buckets, which are genuinely mixed (they hold
// both public bazaars/iftars and internal meetings) and so defer to the text
// allowlist below.
const PRIVATE_CATEGORIES = new Set([
  'youth services', 'classes', 'halaqa', 'jummah services', 'education',
  'sunday school', 'school', "brothers' programming", "women's programming",
  'convert services',
])

// Public mosque-event terms the shared (church-oriented) allowlist misses.
// Reached only for NEUTRAL-category events, so audience-targeted iftars/picnics
// filed under Youth/Convert Services are already excluded before we get here.
const EXTRA_PUBLIC_RE = new RegExp([
  '\\biftar\\b',        // community / fundraising iftars (Ramadan fast-breaking meal)
  '\\beid\\b',          // Eid al-Fitr / Eid al-Adha celebrations
  'interfaith',         // interfaith council potlucks, dialogues
].join('|'), 'i')

/** Fold curly apostrophes so possessives match ("Reverts’" ≡ "reverts'"). */
function normApostrophe(s) {
  return String(s || '').replace(/[‘’]/g, "'").toLowerCase()
}

/**
 * True when an ISAK event is a genuinely public-community event (allowlist).
 * @param {string} title
 * @param {string} description
 * @param {string[]} categoryNames  Tribe category NAMES (e.g. ['Outreach Programming'])
 */
export function isPublicISAKEvent(title, description = '', categoryNames = []) {
  const cats = categoryNames.map(normApostrophe)
  // Strict: an internal / audience-targeted category vetoes even a public keyword.
  if (cats.some((c) => PRIVATE_CATEGORIES.has(c))) return false
  if (cats.some((c) => PUBLIC_CATEGORIES.has(c))) return true
  const text = `${title || ''} ${description || ''}`
  return isPublicFaithEvent(title, description) || EXTRA_PUBLIC_RE.test(text)
}

// ── Venue resolution (exported for tests) ───────────────────────────────────

/** True when a Tribe venue is one of the mosque's room-level sub-venues. */
function isMosqueVenue(tv) {
  if (!tv) return false
  const addr = String(tv.address || '').toLowerCase()
  if (/steels?\s+corner/.test(addr)) return true
  const slug = String(tv.slug || '').toLowerCase()
  if (slug.startsWith('isak') || slug === 'islamic-community-center') return true
  return false
}

/**
 * Resolve a Tribe venue into { name, details, city } for the Summit gate.
 * Mosque sub-venues collapse onto the canonical ISAK record; a missing venue
 * defaults to the mosque; any other venue keeps its own name/address.
 */
export function resolveVenue(tribeVenue) {
  if (!tribeVenue || !tribeVenue.venue || isMosqueVenue(tribeVenue)) {
    return { name: MOSQUE_VENUE_NAME, details: MOSQUE_VENUE_DETAILS, city: 'Cuyahoga Falls' }
  }
  const city = (tribeVenue.city || '').replace(/,\s*$/, '').trim() // feed sometimes stores "Columbia Station,"
  const details = {
    address: tribeVenue.address || null,
    city:    city || null,
    state:   tribeVenue.stateprovince || tribeVenue.state || 'OH',
    zip:     tribeVenue.zip || null,
    lat:     tribeVenue.geo_lat ? parseFloat(tribeVenue.geo_lat) : null,
    lng:     tribeVenue.geo_lng ? parseFloat(tribeVenue.geo_lng) : null,
    website: tribeVenue.website || null,
  }
  return { name: tribeVenue.venue.trim(), details, city }
}

// ── Field mapping (exported for tests) ──────────────────────────────────────

/**
 * Content category (the badge). Eid celebrations are festivals; otherwise defer
 * to shared text inference, falling back to 'other' for the many community/faith
 * events with no strong content signal.
 */
export function parseCategory(categoryNames = [], title = '', description = '') {
  const cats = categoryNames.map((c) => String(c).toLowerCase())
  if (cats.includes('eid celebration')) return 'festival'
  return inferCategory(title, description) || 'other'
}

/** is_fundraiser facet — true for the Fundraiser category or fundraiser/charity text. */
export function parseIsFundraiser(categoryNames = [], title = '', description = '') {
  const cats = categoryNames.map((c) => String(c).toLowerCase())
  if (cats.includes('fundraiser')) return true
  const text = `${title} ${description}`
  return /fundrais|hunger walk|charity drive|relief drive/i.test(text) || undefined
}

/** Stable per-occurrence source_id (Tribe recurring series reuse the numeric id). */
export function buildSourceId(ev) {
  const day = String(ev.start_date || ev.utc_start_date || '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/** Image from the Tribe image object, else the first <img> in the description. */
function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return descriptionHtml.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

/** Eastern-local YYYY-MM-DD, `offsetDays` from today (anchored to America/New_York). */
function etDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t) => parts.find((p) => p.type === t).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = etDateStr(-1)             // ~1 day grace on past events
  const endDate   = etDateStr(DAYS_AHEAD)

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching ISAK events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      redirect: 'follow',
    })
    // Tribe returns 404/400 with a "no results" code when the window is empty.
    if (res.status === 404 || res.status === 400) break
    if (!res.ok) throw new Error(`ISAK API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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

async function processEvents(rawEvents, organizerId, mosqueVenueId) {
  let inserted = 0, skippedInternal = 0, skippedGeo = 0, skippedOther = 0
  const venueCache = new Map([[MOSQUE_VENUE_NAME, mosqueVenueId]])

  for (const ev of rawEvents) {
    try {
      const categoryNames = (ev.categories ?? []).map((c) => c.name).filter(Boolean)

      let descText = stripHtml(ev.description)
      if (!descText && ev.url) descText = (await fetchSchemaDescription(ev.url)) ?? ''

      // Faith allowlist — the common case is a skip.
      if (!isPublicISAKEvent(ev.title, descText, categoryNames)) {
        skippedInternal++
        continue
      }

      // Eastern wall-clock (see QUIRK 1) — parse start_date, NOT utc_start_date.
      const start_at = easternToIso(ev.start_date)
      if (!start_at) { skippedOther++; continue }
      const end_at = ev.end_date ? easternToIso(ev.end_date) : null

      // Per-event Summit gate.
      const { name: venueName, details: venueDetails, city } = resolveVenue(ev.venue)
      const locality = classifySummitLocation({ lat: venueDetails.lat, lng: venueDetails.lng, city })
      if (locality === 'out') {
        console.log(`  ⤫ Out of Summit County ("${ev.title}" → ${city}) — skipped`)
        skippedGeo++
        continue
      }
      const status = locality === 'in' ? 'published' : 'pending_review'

      let venueId = venueCache.get(venueName)
      if (venueId === undefined) {
        venueId = await ensureVenue(venueName, venueDetails)
        venueCache.set(venueName, venueId)
      }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const row = {
        title:           stripHtml(ev.title),
        description:     descText || null,
        start_at,
        end_at,
        category:        parseCategory(categoryNames, ev.title, descText),
        is_fundraiser:   parseIsFundraiser(categoryNames, ev.title, descText),
        tags:            parseTagsFromTribe(ev.categories, ev.tags,
          ['islamic-society-akron', 'cuyahoga-falls', 'faith', 'community']),
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       parseImage(ev.image, ev.description),
        ticket_url:      ev.website || ev.url || null,
        source_url:      ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status,
        needs_review:    locality !== 'in',
        featured:        false,
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
        skippedOther++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        console.log(`  ✓ ${status === 'published' ? '' : '[review] '}"${row.title}" — ${start_at} @ ${venueName}`)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}": ${err.message}`)
      skippedOther++
    }
  }
  return { inserted, skippedInternal, skippedGeo, skippedOther }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🕌  Starting Islamic Society of Akron & Kent ingestion…')
  const start = Date.now()

  try {
    // Preload the county polygon so the per-event Summit gate can use coords if a
    // venue ever carries them (most ISAK venues supply only a city).
    await preloadSummitCountyBoundary()

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'http://isak.us',
      description: 'Mosque and Islamic community center in Cuyahoga Falls (Summit County) serving the greater Akron and Kent Muslim community.',
    })
    const mosqueVenueId = await ensureVenue(MOSQUE_VENUE_NAME, MOSQUE_VENUE_DETAILS)
    if (organizerId && mosqueVenueId) await linkOrganizationVenue(organizerId, mosqueVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skippedInternal, skippedGeo, skippedOther } =
      await processEvents(rawEvents, organizerId, mosqueVenueId)

    const skipped = skippedInternal + skippedGeo + skippedOther
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ` +
      `${skipped} skipped (${skippedInternal} internal, ${skippedGeo} out-of-county, ${skippedOther} other).`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
