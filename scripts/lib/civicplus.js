/**
 * lib/civicplus.js
 *
 * Shared runner for Summit County municipalities whose websites run on
 * CivicPlus (CivicEngage). CivicPlus exposes every public calendar as a
 * standards-compliant RFC 5545 iCalendar feed at:
 *
 *   /common/modules/iCalendar/iCalendar.aspx?catID={id}&feed=calendar
 *
 * Unlike the City of Green feed (a single "Main Calendar" that mixes
 * public events with meetings), most CivicPlus sites split content across
 * many category calendars — "Main Calendar", "Recreation Events", "City
 * Council", "Board of Zoning Appeals", etc. — each with its own catID and
 * no aggregate feed (catID=0 returns empty). So a city config supplies the
 * list of catIDs that actually carry public-facing events, we fetch each,
 * merge + dedupe by UID, and run the shared admin/meeting filter before
 * upsert. New specials the city adds to those calendars flow in without a
 * code change.
 *
 * This generalises the single-catID approach in scrape-city-of-green.js;
 * Green predates this helper and is left on its bespoke path to avoid a
 * regression, but it could be migrated here.
 *
 * Each per-city scraper is a thin wrapper that supplies:
 *   - source key + display name
 *   - origin (https://www.<domain>) and catIDs[]
 *   - default venue + organization metadata
 *   - optional mapCategory / mapTags overrides
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { fetchIcsFeed, parseIcs, normaliseIcsEvent } from './ics.js'
import {
  ensureOrganization,
  ensureVenue,
  linkOrganizationVenue,
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
} from './normalize.js'

// ── Public-event filter ────────────────────────────────────────────────────
//
// EXCLUDE rather than allowlist, same rationale as City of Green: a city's
// public lineup grows every year and a closed allowlist would force a code
// change for each new event. We drop the administrative summaries (council
// and board/commission meetings, agendas, hearings, office closures) and
// bare federal-holiday observances, then let everything else through.

// Administrative / governance entries — never public events.
const ADMIN_RE =
  /\b(meeting|commission|committee|council|board|caucus|work session|workshop session|executive session|agenda|hearing|trustees?|levy|board of (zoning|control|review)|civil service|records commission|screening committee|steering committee|jedd|cic|public notice)\b/i

// Building / office closures (e.g. "Office Closed-Veterans Day").
const CLOSURE_RE = /\b(office|offices|building|city hall)\s+closed\b|\bclosed\b.*\b(holiday|observ)/i

// Bare federal-holiday observances. Kept *out* unless the title also carries
// a public-event word (a "Veterans Day Ceremony" / "Memorial Day Parade"
// stays; the "Veterans Day" holiday row drops).
const HOLIDAY_EXACT = new Set([
  'christmas day', 'christmas eve', 'veterans day', 'independence day',
  "new year's day", 'new years day', "new year's eve", 'memorial day',
  'labor day', 'thanksgiving', 'thanksgiving day', 'presidents day',
  "president's day", 'martin luther king jr. day', 'martin luther king day',
  'juneteenth', 'columbus day', 'good friday', 'easter',
])

// Words that mark a row as a genuine public event even if it overlaps a
// holiday name. Does NOT override ADMIN_RE — a "Council Meeting" never
// contains these.
const PUBLIC_EVENT_RE =
  /\b(festival|parade|concert|fireworks|market|movie|movies|music|fest|celebration|ceremony|egg\s?hunt|egg scramble|trick.?or.?treat|santa|tree lighting|run|walk|5k|10k|expo|open house|touch a truck|bandstand|cruise|biergarten|oktoberfest|pop-?up|camp|class|lesson|tournament|jubilee|breakfast|brunch|social|fair|show|paint|craft|story|bingo|dance|yoga|clean ?up|derby|gala|sale)\b/i

export function isPublicCivicPlusEvent(summary) {
  const s = (summary || '').trim().toLowerCase()
  if (!s) return false
  // Drop cancelled / postponed rows.
  if (/\bcancel?led\b|\bpostponed\b/.test(s)) return false
  // Administrative entries are never public, regardless of other words.
  if (ADMIN_RE.test(s)) return false
  if (CLOSURE_RE.test(s)) return false
  // Holiday observances drop unless they carry a public-event word.
  if (HOLIDAY_EXACT.has(s) && !PUBLIC_EVENT_RE.test(s)) return false
  return true
}

// ── Default category / tag mapping ──────────────────────────────────────────
// Cities can override these, but the defaults handle typical municipal
// Parks & Rec programming reasonably well.

export function defaultMapCategory(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  if (/\b(concert|band|music|jazz|bandstand|symphony)\b/.test(text))                 return 'music'
  if (/\b(movie|movies|film|screen on the green|flix)\b/.test(text))                 return 'art'
  if (/\b(art|paint|craft|gallery|exhibit)\b/.test(text))                            return 'art'
  if (/\b(market|farmers market|vendor|craft fair)\b/.test(text))                    return 'community'
  if (/\b(food|tasting|brew|biergarten|oktoberfest|wine|culinary|breakfast)\b/.test(text)) return 'food'
  if (/\b(5k|10k|run|race|walk|tournament|derby|fitness|yoga)\b/.test(text))         return 'fitness'
  if (/\b(class|lesson|workshop|camp|education|training)\b/.test(text))              return 'education'
  if (/\b(nature|trail|park clean|earth day|arbor day|recycling)\b/.test(text))      return 'nature'
  return 'community'
}

function buildTags(ev, extraTags = []) {
  const text = (ev.SUMMARY || '').toLowerCase()
  const tags = [...extraTags]
  if (/freedomfest|4th of july|fourth of july|independence/.test(text)) tags.push('fourth-of-july')
  if (/christmas|holiday|tree lighting|santa/.test(text))               tags.push('seasonal', 'holiday')
  if (/trick.?or.?treat|halloween|oktoberfest/.test(text))              tags.push('halloween')
  if (/concert|music|bandstand/.test(text))                            tags.push('music', 'outdoor')
  if (/movie|movies|flix|screen on the green/.test(text))              tags.push('family', 'outdoor', 'free')
  if (/farmers market|market/.test(text))                              tags.push('market')
  if (/parade|ceremony|veterans|memorial/.test(text))                  tags.push('community')
  return [...new Set(tags)]
}

// ── Main runner ─────────────────────────────────────────────────────────────

/**
 * @param {object} config
 *   @param {string}   config.source            — scraper source key (required)
 *   @param {string}   config.origin            — https://www.<domain> (no trailing slash)
 *   @param {number[]} config.catIDs            — CivicPlus category IDs to ingest
 *   @param {string}   config.cityLabel         — venue city name (e.g. 'Stow')
 *   @param {string}   [config.stateLabel]      — default 'OH'
 *   @param {object}   config.organization      — { name, details }
 *   @param {object}   [config.defaultVenue]    — fallback venue when LOCATION is empty
 *   @param {string[]} [config.baseTags]        — tags applied to every event
 *   @param {Function} [config.mapCategory]     — (ev) → category override
 *   @param {string}   [config.emoji]           — log emoji
 */
export async function runCivicPlusScraper(config) {
  const {
    source,
    origin,
    catIDs,
    cityLabel,
    stateLabel = 'OH',
    organization,
    defaultVenue = null,
    baseTags = [],
    mapCategory = defaultMapCategory,
    emoji = '🏛️',
  } = config

  if (!source)   throw new Error('runCivicPlusScraper: config.source is required')
  if (!origin)   throw new Error('runCivicPlusScraper: config.origin is required')
  if (!Array.isArray(catIDs) || catIDs.length === 0) {
    throw new Error('runCivicPlusScraper: config.catIDs must be a non-empty array')
  }

  console.log(`${emoji}  Starting ${source} ingestion (CivicPlus iCalendar, catIDs ${catIDs.join(', ')})…`)
  const start = Date.now()

  try {
    // Fetch every category feed and merge, deduping by UID. A single event
    // can appear in more than one category calendar.
    const byUid = new Map()
    let totalParsed = 0
    for (const catID of catIDs) {
      const url = `${origin}/common/modules/iCalendar/iCalendar.aspx?catID=${catID}&feed=calendar`
      console.log(`  → Fetching catID=${catID}: ${url}`)
      try {
        const icsText = await fetchIcsFeed(url)
        const events = parseIcs(icsText)
        totalParsed += events.length
        for (const ev of events) {
          const uid = (ev.UID || '').trim()
          const key = uid || `${ev.SUMMARY}|${ev.DTSTART?.value}`
          if (!byUid.has(key)) byUid.set(key, ev)
        }
        console.log(`    parsed ${events.length} VEVENTs`)
      } catch (err) {
        // A single bad category shouldn't sink the whole run.
        console.warn(`    ⚠ catID=${catID} failed: ${err.message}`)
      }
      await new Promise(r => setTimeout(r, 300))
    }

    const allEvents = [...byUid.values()]
    const publicEvents = allEvents.filter(ev => isPublicCivicPlusEvent(ev.SUMMARY))
    console.log(
      `  Merged ${allEvents.length} unique VEVENTs (from ${totalParsed} across ${catIDs.length} calendars); ` +
      `${publicEvents.length} public after filter (dropped ${allEvents.length - publicEvents.length} admin/holiday)`
    )

    if (publicEvents.length === 0) {
      await logUpsertResult(source, 0, 0, 0, {
        status: 'error',
        errorMessage: 'CivicPlus feeds parsed but contained 0 public-facing events after filter',
        durationMs:  Date.now() - start,
        eventsFound: allEvents.length,
      })
      console.warn('  ⚠ No public events — exiting 0 so the next scheduled run still tries.')
      process.exit(0)
    }

    // Ensure org + default venue once before the loop.
    const organizationId = organization?.name
      ? await ensureOrganization(organization.name, organization.details || {})
      : null

    let defaultVenueId = null
    if (defaultVenue?.name) {
      defaultVenueId = await ensureVenue(defaultVenue.name, {
        city:  cityLabel,
        state: stateLabel,
        ...defaultVenue,
      })
      if (organizationId && defaultVenueId) {
        await linkOrganizationVenue(organizationId, defaultVenueId)
      }
    }

    console.log(`\n📥  Processing ${publicEvents.length} events…`)
    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of publicEvents) {
      try {
        const row = normaliseIcsEvent(ev, {
          source,
          mapCategory,
          mapTags: (e) => buildTags(e, baseTags),
          defaultPriceMin: 0,        // Municipal programming is overwhelmingly free
          defaultPriceMax: null,
          ageRestriction:  'all_ages',
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }

        // CivicPlus LOCATION often arrives as "Venue Name - 123 St  City OH 44000"
        // (and sometimes wrapped in an HTML <p>). Clean it into a venue name.
        let venueId = defaultVenueId
        const locName = cleanLocationName(ev.LOCATION)
        if (locName) {
          if (venueCache.has(locName)) {
            venueId = venueCache.get(locName)
          } else {
            venueId = await ensureVenue(locName, { city: cityLabel, state: stateLabel })
            venueCache.set(locName, venueId)
          }
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }

        if (venueId)        await linkEventVenue(upserted.id, venueId)
        if (organizationId) await linkEventOrganization(upserted.id, organizationId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.SUMMARY}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(source, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  ${source} done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
    return { inserted, skipped, eventsFound: allEvents.length }
  } catch (err) {
    await logScraperError(source, err, start)
    process.exit(1)
  }
}

/**
 * Turn a CivicPlus LOCATION string into a clean venue name.
 *   "Tallmadge Circle Park - 10 Tallmadge Circle  Tallmadge OH 44278" → "Tallmadge Circle Park"
 *   "Stow City Hall > Council Chambers - 3760 Darrow Road  Stow OH 44224" → "Stow City Hall - Council Chambers"
 *   "<p>7:30 AM - Holy Family Church...</p> - 3179 Kent Rd. ..." → stripped + first segment
 * Returns null when nothing usable remains.
 */
export function cleanLocationName(raw) {
  if (!raw) return null
  let s = stripHtml(String(raw)).trim()
  if (!s) return null
  // A leading "-" means the venue-name slot was empty: the feed emitted
  // " - <street>  City ST ZIP" with no name. Nothing usable → fall back.
  if (/^[-–]/.test(s)) return null
  // CivicPlus uses " - " to separate the venue name from its street address.
  // Take everything before the first " - " that is followed by a digit
  // (street number) — keeps "Council Chambers - 3760 Darrow" → name only.
  const dashAddr = s.search(/\s[-–]\s+\d/)
  if (dashAddr !== -1) s = s.slice(0, dashAddr)
  // "Building > Room" hierarchy → "Building - Room"
  s = s.replace(/\s*>\s*/g, ' - ').trim()
  // Drop a trailing bare state/zip fragment if it slipped through.
  s = s.replace(/\s+OH\s+\d{5}.*$/i, '').trim()
  // Reject pure addresses, time fragments, and empties.
  if (!s || /^\d/.test(s) || !/[a-z]/i.test(s) || s.length < 3) return null
  if (/^\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/i.test(s)) return null
  return s
}
