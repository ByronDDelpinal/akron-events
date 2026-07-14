/**
 * scrape-runsignup.js
 *
 * Broad discovery of Summit County road races hosted on RunSignup
 * (runsignup.com) — 5Ks, 10Ks, fun runs, charity walks, etc. RunSignup is the
 * registration platform behind a large share of local races (including the
 * Akron Promise City Series and the Akron Marathon), so this is a high-coverage
 * fitness source.
 *
 * Source: RunSignup's public REST API (no key). We discover races near downtown
 * Akron via /rest/races (zipcode + radius), gate them to Summit County by city
 * (lib/summit-county.js), then fetch each race's detail for the precise start
 * time, price, description, address, and logo via the shared lib/runsignup.js.
 *
 * Overlap: the City Series + Marathon races also appear here. Per the chosen
 * strategy we ingest everything and let the cross-source dedupe merge overlaps —
 * times are aligned to RunSignup's authoritative start time (scrape-akron-promise
 * now does the same), and `runsignup` is ranked below the curated race scrapers
 * in the dedupe priority so the bespoke source wins a merge.
 *
 * Venues: RunSignup's address.street is freeform — a real place name becomes a
 * normal venue; a bare street address is minted UNLISTED (hidden from the venues
 * index, still navigable) via ensureVenue's allowAddressName/listed options.
 *
 * Usage:   node scripts/scrape-runsignup.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, ensureVenue, easternToIso,
} from './lib/normalize.js'
import { searchRunSignupRaces, fetchRunSignupRaceById, parseRunSignupRace } from './lib/runsignup.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'runsignup'
const SEARCH_ZIP    = '44308'   // downtown Akron
const SEARCH_RADIUS = 25        // miles — generous; the Summit County gate trims it
const MAX_DAYS_AHEAD = 300

const ymd = (d) => d.toISOString().slice(0, 10)

/**
 * Locality for a race — strict Summit mandate (2026-07-14): 'out' races are
 * never ingested; 'unknown' (missing/unrecognized city — rare, RunSignup
 * addresses almost always carry one) is ingested as pending_review so a real
 * Summit race with sloppy address data surfaces in the admin queue instead
 * of silently vanishing.
 */
export function raceLocality(race) {
  return classifySummitLocation({ city: race?.address?.city })
}

/** Keep only real, dated, public races that are not confidently out-of-county. */
export function isIngestableRace(race) {
  if (!race) return false
  if (String(race.is_draft_race) === 'T')   return false
  if (String(race.is_private_race) === 'T') return false
  if (!race.next_date)                       return false   // undated / inactive
  if (/\btest\b/i.test(race.name || ''))     return false   // RunSignup test races
  return raceLocality(race) !== 'out'
}

/** Fallback start when a race has no event-level start time: next_date at 8 AM ET. */
export function fallbackStartIso(nextDate) {
  const m = String(nextDate || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  return easternToIso(`${m[3]}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`, '8:00 AM')
}

/** Tags from the race name + description. */
export function buildTags(race, description) {
  const t = `${race?.name || ''} ${description || ''}`.toLowerCase()
  const tags = ['race', 'running', 'runsignup']
  if (/\b5k\b/.test(t))                         tags.push('5k')
  if (/\b10k\b/.test(t))                        tags.push('10k')
  if (/half[- ]marathon/.test(t))               tags.push('half-marathon')
  else if (/\bmarathon\b/.test(t))              tags.push('marathon')
  if (/\bwalk\b/.test(t))                       tags.push('walk')
  if (/kids|fun run|youth|family|1 mile|1-mile/.test(t)) tags.push('family')
  if (/charity|benefit|fundrais|memorial/.test(t))       tags.push('fundraiser')
  return [...new Set(tags)]
}

async function main() {
  console.log('🏁  Starting RunSignup (Summit County races) ingestion…')
  const start = Date.now()
  try {
    const now = new Date()
    const startDate = ymd(now)
    const endDate   = ymd(new Date(now.getTime() + MAX_DAYS_AHEAD * 86_400_000))

    const races = await searchRunSignupRaces({ zipcode: SEARCH_ZIP, radius: SEARCH_RADIUS, startDate, endDate })
    const inArea = races.filter(isIngestableRace)
    console.log(`  ${races.length} races within ${SEARCH_RADIUS}mi; ${inArea.length} in Summit County`)

    const nowMs = Date.now()
    const cutoff = nowMs + MAX_DAYS_AHEAD * 86_400_000
    const venueCache = new Map()
    let inserted = 0, skipped = 0

    for (const summary of inArea) {
      try {
        // Detail fetch carries events[] (start time + price); fall back to the
        // search summary if it fails.
        const detail = await fetchRunSignupRaceById(summary.race_id).catch(() => null)
        const race = detail || summary
        const parsed = parseRunSignupRace(race)
        if (!parsed) { skipped++; continue }

        const startIso = parsed.startIso || fallbackStartIso(race.next_date)
        if (!startIso) { skipped++; continue }
        const startMs = Date.parse(startIso)
        if (startMs < nowMs - 86_400_000 || startMs > cutoff) { skipped++; continue }

        let venueId = null
        if (parsed.venueName) {
          if (venueCache.has(parsed.venueName)) {
            venueId = venueCache.get(parsed.venueName)
          } else {
            const opts = parsed.bareAddress ? { allowAddressName: true, listed: false } : {}
            venueId = await ensureVenue(parsed.venueName, parsed.venueDetails, opts)
            venueCache.set(parsed.venueName, venueId)
          }
        }

        const title = String(race.name || '').trim()
        if (!title) { skipped++; continue }
        // Prefer the detail record's locality (fuller address); unknown → review queue.
        const geoUnknown = raceLocality(race) === 'unknown'
        if (geoUnknown) console.log(`  🟡 Unknown locality for "${title}" → review queue`)
        const row = {
          title,
          description:     parsed.description,
          start_at:        startIso,
          end_at:          null,
          category:        'fitness',
          tags:            buildTags(race, parsed.description),
          price_min:       parsed.priceMin,
          price_max:       parsed.priceMax,
          age_restriction: 'all_ages',
          image_url:       parsed.logo,
          ticket_url:      race.url || `https://runsignup.com/Race/${summary.race_id}`,
          source:          SOURCE_KEY,
          source_id:       `rs_${summary.race_id}`,
          // Unknown locality → review queue, never the public calendar.
          status:          geoUnknown ? 'pending_review' : 'published',
          needs_review:    geoUnknown ? true : undefined,
          featured:        false,
        }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${title}":`, error.message); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on race ${summary?.race_id}:`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: inArea.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
