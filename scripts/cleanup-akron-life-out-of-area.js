/**
 * cleanup-akron-life-out-of-area.js
 *
 * One-off cleanup: remove `source='akron_life'` events that don't meet the
 * quality filters added to scrape-akron-life.js (geographic + real link).
 *
 * Why this exists:
 *   Earlier scraper runs (before filters were added) inserted events from
 *   across Ohio because Akron Life's Evvnt publisher feed includes nationwide
 *   backfill from Ticketmaster, Eventbrite, etc. Some events were 2+ hours
 *   from Akron. Other events were ingested with no linkable source URL.
 *   The new filters block these going forward; this script removes the ones
 *   already in the database.
 *
 * Drop criteria (any one disqualifies the event):
 *   • No linked venue
 *   • Linked venue.city is a known non-Summit-County town (Cleveland
 *     suburbs, Kent, Canton, Medina, Wadsworth, etc. — see
 *     NOT_SUMMIT_COUNTY_TOWNS below for the full list)
 *   • No ticket_url, OR ticket_url points to akronlife.com (broken page)
 *
 * Permissive default: events whose venue has no city OR whose city
 * isn't on the blocklist are kept. This matches scrape-akron-life.js's
 * runtime gate and Byron's preference for "1-2 slip-throughs over
 * losing real Summit County events".
 *
 * Safety:
 *   • Default mode is dry-run — prints what would be deleted, deletes nothing
 *   • Pass `--apply` to actually delete
 *   • Events with non-empty `manual_overrides` are PRESERVED (respects Byron's
 *     manual edits even if the auto-quality check now fails them)
 *   • Junction-table rows (event_venues, event_areas, event_organizations)
 *     cascade-delete automatically — only deletes from `events` are issued
 *
 * Usage:
 *   node scripts/cleanup-akron-life-out-of-area.js          # dry run
 *   node scripts/cleanup-akron-life-out-of-area.js --apply  # do it
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { preloadSummitCountyBoundary, pointInSummitCounty } from './lib/summit-county.js'

// Mirrors scrape-akron-life.js — blocklist is the coord-less fallback
// for venues where lat/lng isn't available. When lat/lng exists, we
// run the authoritative point-in-Summit-County polygon check instead.
const NOT_SUMMIT_COUNTY_TOWNS = new Set([
  // Cuyahoga County (Cleveland metro)
  'cleveland', 'east cleveland', 'cleveland heights', 'shaker heights',
  'university heights', 'south euclid', 'lyndhurst', 'mayfield',
  'mayfield heights', 'gates mills', 'pepper pike', 'beachwood',
  'orange', 'moreland hills', 'hunting valley', 'chagrin falls',
  'solon', 'bedford', 'bedford heights', 'oakwood village',
  'walton hills', 'glenwillow', 'maple heights', 'garfield heights',
  'newburgh heights', 'cuyahoga heights', 'valley view', 'independence',
  'brecksville', 'broadview heights', 'north royalton', 'seven hills',
  'parma', 'parma heights', 'strongsville', 'brooklyn', 'brook park',
  'middleburg heights', 'berea', 'olmsted falls', 'north olmsted',
  'fairview park', 'rocky river', 'lakewood', 'bay village',
  'westlake', 'avon', 'avon lake', 'north ridgeville', 'euclid',
  'richmond heights', 'highland heights', 'willowick',
  // Portage County
  'kent', 'aurora', 'streetsboro', 'ravenna', 'mantua', 'garrettsville',
  'hiram', 'rootstown', 'windham',
  // Medina County
  'medina', 'wadsworth', 'brunswick', 'lodi', 'seville',
  'sharon center', 'rittman', 'spencer',
  // Stark County
  'canton', 'north canton', 'massillon', 'alliance', 'louisville',
  'uniontown', 'east canton', 'minerva', 'hartville', 'magnolia',
  'navarre', 'brewster',
  // Lake / Lorain / Wayne
  'mentor', 'painesville', 'willoughby', 'eastlake', 'wickliffe',
  'kirtland', 'lorain', 'elyria', 'amherst', 'wooster', 'orrville',
])

const APPLY = process.argv.includes('--apply')

function evaluate(event) {
  const reasons = []
  const overrides = event.manual_overrides
  const hasOverrides = overrides && typeof overrides === 'object' && Object.keys(overrides).length > 0

  // Locate linked venue (events ↔ venues is M:N, but our scrapers create
  // exactly one link per event; pick the first if there are multiple).
  const venueLinks = event.event_venues || []
  const venue      = venueLinks[0]?.venue

  if (!venue) {
    reasons.push('no linked venue')
  } else {
    // Authoritative: point-in-polygon against Summit County's actual
    // TIGER/Line boundary. Falls back to the town blocklist only when
    // lat/lng is missing on the venue row.
    const lat = Number(venue.lat), lng = Number(venue.lng)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      if (!pointInSummitCounty(lat, lng)) {
        reasons.push(`venue "${venue.name}" coords (${lat.toFixed(4)}, ${lng.toFixed(4)}) outside Summit County polygon`)
      }
    } else {
      const city = String(venue.city ?? '').toLowerCase().trim()
      if (city && NOT_SUMMIT_COUNTY_TOWNS.has(city)) {
        reasons.push(`venue "${venue.name}" in "${venue.city}" (no coords) — known non-Summit-County town`)
      }
    }
  }

  if (!event.ticket_url) {
    reasons.push('no ticket_url')
  } else if (/akronlife\.com/i.test(event.ticket_url)) {
    reasons.push('ticket_url points to akronlife.com (broken page)')
  }

  return { shouldDelete: reasons.length > 0, reasons, hasOverrides }
}

async function main() {
  // Load the Summit County polygon once before walking events;
  // pointInSummitCounty() is synchronous after this point.
  await preloadSummitCountyBoundary()

  console.log(`🧹  ${APPLY ? 'APPLYING' : 'DRY RUN —'} cleanup of source='akron_life' events`)
  console.log(`    Criteria: keep events whose linked venue passes the Summit County polygon check (or, coord-less venues, the town blocklist) and that have a non-akronlife ticket_url`)
  console.log('')

  // Page through events. Supabase caps result size; we don't expect more
  // than ~300 akron_life rows so a single fetch is fine, but use range()
  // just in case the corpus has grown.
  const all = []
  let from = 0
  const pageSize = 500
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, start_at, ticket_url, manual_overrides, event_venues(venue:venues(id, name, lat, lng))')
      .eq('source', 'akron_life')
      .order('start_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) {
      console.error('Query failed:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  console.log(`Found ${all.length} akron_life events total`)
  console.log('')

  const toDelete = []
  const preserved = []
  for (const ev of all) {
    const { shouldDelete, reasons, hasOverrides } = evaluate(ev)
    if (!shouldDelete) continue
    if (hasOverrides) {
      preserved.push({ ev, reasons })
    } else {
      toDelete.push({ ev, reasons })
    }
  }

  if (preserved.length > 0) {
    console.log(`🛡  ${preserved.length} event(s) failed checks but kept due to manual_overrides:`)
    for (const { ev, reasons } of preserved) {
      console.log(`    • "${ev.title}" — ${reasons.join('; ')}`)
    }
    console.log('')
  }

  if (toDelete.length === 0) {
    console.log('✓  Nothing to delete. All eligible akron_life events are in-area with valid links.')
    return
  }

  console.log(`Events to delete (${toDelete.length}):`)
  for (const { ev, reasons } of toDelete) {
    const date = ev.start_at ? ev.start_at.slice(0, 10) : '????-??-??'
    console.log(`  • [${date}] ${ev.title.slice(0, 60)}`)
    console.log(`      reasons: ${reasons.join('; ')}`)
  }
  console.log('')

  if (!APPLY) {
    console.log(`(Dry run — pass --apply to delete these ${toDelete.length} events.)`)
    return
  }

  // Delete in chunks to keep the IN(...) clause manageable for Postgres.
  const ids = toDelete.map(d => d.ev.id)
  const CHUNK = 100
  let deleted = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK)
    const { error, count } = await supabaseAdmin
      .from('events')
      .delete({ count: 'exact' })
      .in('id', batch)
    if (error) {
      console.error(`  ✗ Delete batch ${i}-${i + batch.length - 1} failed:`, error.message)
      process.exit(1)
    }
    deleted += count ?? batch.length
  }

  console.log(`✅  Deleted ${deleted} events. Junction-table rows cascaded.`)
}

main().catch(err => {
  console.error('Cleanup failed:', err)
  process.exit(1)
})
