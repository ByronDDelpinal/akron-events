/**
 * scrape-meetup.js
 *
 * Meetup groups in/around Akron. Meetup retired its open REST API (the current
 * GraphQL API needs a paid Pro account), and the site itself is a client-
 * rendered SPA behind bot protection — so we do NOT scrape HTML. Instead we
 * consume the per-group **iCal feed** Meetup publishes for calendar apps
 * (https://www.meetup.com/<group>/events/ical/) — a sanctioned, free, no-auth
 * feed in a format our ics.js parser already handles.
 *
 * There is no global "all Akron events" feed, so coverage is a CURATED list of
 * groups (KNOWN_GROUPS). New groups are added by appending a slug; empty feeds
 * are harmless (they just yield nothing).
 *
 * Locality: every event is routed through the shared Summit County gate. Meetup
 * events are frequently posted as "Location TBD" (no address) or online — those
 * have no resolvable Summit County location, so they FAIL the gate and are not
 * posted. When the organizer announces an in-person location in Summit County,
 * the next scrape picks the event up. That's the intended behavior.
 *
 * Price is left null (never assume free). We link back to the Meetup event page.
 *
 * Usage:  node scripts/scrape-meetup.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
} from './lib/normalize.js'
import { fetchIcsFeed, parseIcs, normaliseIcsEvent } from './lib/ics.js'
import { preloadSummitCountyBoundary, isSummitCountyLocation } from './lib/summit-county.js'

const SOURCE_KEY    = 'meetup'
const MAX_DAYS_AHEAD = 180

// Curated Akron/Summit-area groups. `tag` is a stable per-group filter tag.
// Add a group by appending its slug (the path in meetup.com/<slug>/). Feeds
// that are empty or whose events lack a Summit County location simply produce
// nothing — safe to list speculative/seasonal groups here.
export const KNOWN_GROUPS = [
  { slug: 'south-of-akron-good-fun-group',                  label: 'Akron and Beyond, Good Fun Group', tag: 'social' },
  { slug: 'whynotadventure-org',                            label: 'WhyNot Adventures',                tag: 'outdoors' },
  { slug: 'Crooked-River-Chapter-Buckeye-Trail-Association',label: 'Buckeye Trail: Crooked River Chapter', tag: 'outdoors' },
  { slug: 'akron-game-developers',                          label: 'Akron Game Developers',            tag: 'tech' },
  { slug: 'business-akron',                                 label: 'Akron Business Network',           tag: 'networking' },
  { slug: 'akron-oh-20-30s-group',                          label: 'Akron, OH 20/30s group',           tag: 'social' },
  { slug: 'spinoffcyclists',                                label: 'Spinoff Cyclists Bicycle Club',    tag: 'cycling' },
  { slug: 'uxakron',                                        label: 'UX Akron',                         tag: 'tech' },
  { slug: 'akronmakerspace',                                label: 'Akron Makerspace',                 tag: 'maker' },
]

const icalUrl = (slug) => `https://www.meetup.com/${slug}/events/ical/`

// ── Location parsing ─────────────────────────────────────────────────────────

/**
 * Pull coordinates and a city out of a VEVENT for the locality gate.
 * Meetup encodes a physical location in LOCATION (free text, e.g.
 * "Venue Name, 123 Main St, Akron, OH 44308") and sometimes GEO ("lat;lng").
 * Online / "TBD" events have neither → { lat:null, lng:null, city:null }.
 */
export function parseEventGeo(ev) {
  let lat = null, lng = null
  if (typeof ev.GEO === 'string') {
    const [a, b] = ev.GEO.split(';').map((s) => parseFloat(s))
    if (Number.isFinite(a) && Number.isFinite(b) && (a !== 0 || b !== 0)) { lat = a; lng = b }
  }
  const loc = String(ev.LOCATION ?? '').trim()
  // "…, <City>, OH[ 44xxx]" — the token right before the state.
  const cityM = loc.match(/(?:^|,)\s*([A-Za-z][A-Za-z .'-]+?)\s*,\s*(?:OH|Ohio)\b/i)
  const city = cityM ? cityM[1].trim() : null
  return { lat, lng, city, loc }
}

/**
 * Best-effort venue name + street from a Meetup LOCATION string. Returns null
 * when the location is city-only (e.g. "Akron, OH") so we don't mint a venue
 * literally named after the city — the event still posts, just venue-less.
 */
export function parseVenue(loc, city = null) {
  const segs = String(loc ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!segs.length) return null
  const street = segs.find((s) => /^\d+\s+\S/.test(s)) ?? null
  const name = (segs[0] === street ? null : segs[0]) ?? street
  if (!name) return null
  if (city && name.toLowerCase() === city.toLowerCase()) return null
  return { name, street }
}

// ── Process one group's feed ─────────────────────────────────────────────────

async function processGroup(group, now, cutoffFuture) {
  const result = { inserted: 0, skipped: 0, gated: 0, found: 0 }

  let events
  try {
    events = parseIcs(await fetchIcsFeed(icalUrl(group.slug)))
  } catch (err) {
    console.warn(`  ⚠ ${group.label} (${group.slug}) feed error: ${err.message}`)
    return result
  }
  result.found = events.length
  if (!events.length) return result

  const organizerId = await ensureOrganization(group.label, {
    website: `https://www.meetup.com/${group.slug}/`,
    description: `Meetup group: ${group.label}.`,
  })

  for (const ev of events) {
    try {
      const row = normaliseIcsEvent(ev, {
        source: SOURCE_KEY,
        mapTags: () => ['meetup', group.tag, 'akron'],
        // price stays null (normaliseIcsEvent default) — never assume free
      })
      if (!row?.start_at) { result.skipped++; continue }

      const startMs = Date.parse(row.start_at)
      if (startMs < now.getTime() - 86_400_000) { result.skipped++; continue }
      if (startMs > cutoffFuture.getTime())      { result.skipped++; continue }

      // ── Summit County gate ──────────────────────────────────────────────
      // No resolvable in-Summit-County location (TBD / online / elsewhere) →
      // not posted. Picked up automatically once a real location is announced.
      const geo = parseEventGeo(ev)
      if (!isSummitCountyLocation(geo)) { result.gated++; continue }

      const enriched = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)
      if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); result.skipped++; continue }

      const venueInfo = parseVenue(geo.loc, geo.city)
      if (venueInfo) {
        const venueId = await ensureVenue(venueInfo.name, {
          address: venueInfo.street, city: geo.city ?? undefined, state: 'OH',
          lat: geo.lat ?? undefined, lng: geo.lng ?? undefined,
        })
        if (venueId) await linkEventVenue(upserted.id, venueId)
      }
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      result.inserted++
    } catch (err) {
      console.warn(`  ⚠ Error on a ${group.label} event: ${err.message}`)
      result.skipped++
    }
  }
  return result
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🤝  Starting Meetup ingestion…')
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary() // required before the polygon gate
    const now = new Date()
    const cutoffFuture = new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000)

    let inserted = 0, skipped = 0, gated = 0, found = 0
    for (const group of KNOWN_GROUPS) {
      const r = await processGroup(group, now, cutoffFuture)
      inserted += r.inserted; skipped += r.skipped; gated += r.gated; found += r.found
      await new Promise((res) => setTimeout(res, 200))
    }

    console.log(`\n  ${found} feed events → ${inserted} posted, ${gated} gated out (no Summit County location), ${skipped} skipped`)
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped + gated, {
      eventsFound: found,
      durationMs:  Date.now() - start,
    })
    console.log(`✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
