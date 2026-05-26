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
 *   • No linked venue, OR linked venue has no lat/lng coordinates
 *   • Linked venue lat/lng > 25 miles from downtown Akron
 *   • No ticket_url, OR ticket_url points to akronlife.com (broken page)
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

const AKRON_LAT          = 41.0814
const AKRON_LNG          = -81.5190
const MAX_DISTANCE_MILES = 25

const APPLY = process.argv.includes('--apply')

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lon2 - lon1) * Math.PI / 180
  const a  = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2
  return (2 * R * Math.asin(Math.sqrt(a))) / 1609.34
}

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
    const lat = Number(venue.lat), lng = Number(venue.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      reasons.push(`venue "${venue.name}" missing coordinates`)
    } else {
      const dist = haversineMiles(lat, lng, AKRON_LAT, AKRON_LNG)
      if (dist > MAX_DISTANCE_MILES) {
        reasons.push(`venue "${venue.name}" is ${dist.toFixed(1)} mi from Akron`)
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
  console.log(`🧹  ${APPLY ? 'APPLYING' : 'DRY RUN —'} cleanup of source='akron_life' events`)
  console.log(`    Criteria: keep events with linked venue within ${MAX_DISTANCE_MILES} mi of Akron and a non-akronlife ticket_url`)
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
