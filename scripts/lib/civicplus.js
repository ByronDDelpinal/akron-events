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
  if (/\b(movie|movies|film|screen on the green|flix)\b/.test(text))                 return 'film'
  if (/\b(festival|parade|block party|fireworks|tree lighting)\b/.test(text))        return 'festival'
  if (/\b(art|paint|craft|gallery|exhibit)\b/.test(text))                            return 'visual-art'
  if (/\b(market|farmers market|vendor|craft fair)\b/.test(text))                    return 'market'
  if (/\b(food|tasting|brew|biergarten|oktoberfest|wine|culinary|breakfast)\b/.test(text)) return 'food'
  if (/\b(5k|10k|run|race|walk|tournament|derby|fitness|yoga)\b/.test(text))         return 'fitness'
  if (/\b(class|lesson|workshop|camp|education|training)\b/.test(text))              return 'learning'
  if (/\b(nature|trail|park clean|earth day|arbor day|recycling)\b/.test(text))      return 'outdoors'
  if (/\b(council|commission|board of|public hearing|town hall|ward meeting)\b/.test(text)) return 'civic'
  // No keyword hit — let text inference decide (municipal calendars mix
  // civic meetings with rec programming; a blanket guess helps neither).
  return null
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
          // Never assume free. CivicPlus VEVENT feeds carry no price field, and
          // "overwhelmingly free" is not "always free" — a paid class or
          // ticketed festival shown as $0 would turn someone away at the door.
          // Leave price UNKNOWN (null) rather than asserting free.
          defaultPriceMin: null,
          defaultPriceMax: null,
          ageRestriction:  'all_ages',
          // CivicPlus VEVENT URLs are root-relative; absolutise against the
          // city's own origin so ticket_url/source_url are valid links.
          linkBaseUrl:     origin,
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }

        // The VEVENT URL field points back at the feed, not the event (a
        // CivicPlus quirk). Replace it with the reconstructed detail-page
        // deep link so the card links straight to the event.
        const eventUrl = civicPlusEventUrl(ev, origin)
        if (eventUrl) {
          row.ticket_url = eventUrl
          row.source_url = eventUrl
        }

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
/**
 * Build the canonical CivicPlus event-detail URL from a VEVENT.
 *
 * CivicPlus iCalendar feeds ship a *broken* per-event URL field: every
 * VEVENT sets `URL:/common/modules/iCalendar/iCalendar.aspx?feed=calendar&catID=N`,
 * i.e. a link back to the whole feed, not the event. Following it downloads
 * the entire .ics calendar instead of opening the event page. The real
 * detail page lives at `/calendar.aspx?EID={id}`, and CivicPlus uses the
 * numeric event id as the VEVENT UID — so we can reconstruct a working deep
 * link from the UID. (Confirmed against Hudson, Stow, Fairlawn, New Franklin;
 * the `EID=<UID>` page returns HTTP 200 with the correct event title.)
 *
 * Returns null when the UID isn't a plain numeric EID, so callers fall back
 * to whatever normaliseIcsEvent produced rather than minting a bad link.
 */
export function civicPlusEventUrl(ev, origin) {
  const uid = (ev?.UID || '').trim()
  if (!origin || !/^\d+$/.test(uid)) return null
  return `${origin.replace(/\/$/, '')}/calendar.aspx?EID=${uid}`
}

export function cleanLocationName(raw) {
  if (!raw) return null
  let s
  const rawStr = String(raw)
  // Some sites (Richfield, 2026-07-09) store LOCATION as rich-text HTML with
  // the venue name and its street address in SEPARATE block elements, e.g.
  //   <p><span style="color: rgb(0, 0, 0)">Village Green Pavilion</span></p>
  //   <p>Corner of Route 303 &amp; Broadview Rd</p>
  // stripHtml alone flattens that to one line ("Village Green Pavilion Corner
  // of Route 303 & Broadview Rd") with no " - " boundary to split on, which
  // would mint the whole string as a junk venue name. Split on block
  // boundaries FIRST and keep only the first non-empty block — the venue-name
  // slot; later blocks are address/detail lines the address-tail logic below
  // can't see. Single-block HTML (name and address on one line) falls through
  // to the normal dash-splitting path unchanged.
  if (/<\/(?:p|div)>|<br\s*\/?>/i.test(rawStr)) {
    s = rawStr
      .split(/<\/(?:p|div)>|<br\s*\/?>/i)
      .map(part => stripHtml(part))
      .find(part => part) || ''
  } else {
    s = stripHtml(rawStr).trim()
  }
  if (!s) return null
  // A leading "-" means the venue-name slot was empty: the feed emitted
  // " - <street>  City ST ZIP" with no name. Nothing usable → fall back.
  if (/^[-–—]/.test(s)) return null
  // CivicPlus uses " - " to separate the venue name from its street address,
  // formatted "<Name> - <Street>  <City> <ST> <ZIP>". At this point the raw
  // string has no other " - " (the "Building > Room" hierarchy is still ">",
  // converted below), so the first spaced dash is the name/address boundary.
  // Split there when the remainder looks like an address — either it starts
  // with a street number ("Council Chambers - 3760 Darrow") or it carries the
  // trailing "City ST ZIP" tail ("First & Main Green - First Street  Hudson
  // OH 44236", where the street name is a word, not a number).
  // The dash class covers hyphen, en dash, AND em dash — Richfield writes
  // "Eastwood Preserve — 4712 W. Streetsboro Rd" (em dash, 2026-07-09), which
  // a hyphen/en-dash-only class left glued to the venue name.
  const dashIdx = s.search(/\s[-–—]\s/)
  if (dashIdx !== -1) {
    const after = s.slice(dashIdx)
    if (/^\s[-–—]\s+\d/.test(after) || /\b[A-Za-z]{2}\s+\d{5}\b/.test(after)) {
      s = s.slice(0, dashIdx)
    }
  }
  // "Building > Room" hierarchy → "Building - Room"
  s = s.replace(/\s*>\s*/g, ' - ').trim()
  // Drop a trailing bare state/zip fragment if it slipped through.
  s = s.replace(/\s+OH\s+\d{5}.*$/i, '').trim()
  // Reject pure addresses, time fragments, and empties.
  if (!s || /^\d/.test(s) || !/[a-z]/i.test(s) || s.length < 3) return null
  // A clock time ANYWHERE marks schedule prose, not a place — Springfield
  // Township stuffed "Beginners 10AM then it advances from 10:30 Am on to
  // 1:30 PM" into LOCATION (2026-07-08), short enough to pass the length
  // guard below. No real venue name contains a time of day.
  if (/\b\d{1,2}(:\d{2})?\s*[ap]\.?m\.?\b/i.test(s)) return null
  // Reject a LOCATION field stuffed with a full event description (a CMS
  // data-entry error — e.g. Copley crammed a paragraph into LOCATION). A real
  // venue name is short; anything sentence-length is not a venue, so fall back
  // to the default venue rather than minting a paragraph-named row.
  if (s.length > 80) return null
  return s
}
