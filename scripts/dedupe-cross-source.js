/**
 * dedupe-cross-source.js
 *
 * Find and delete events that are the same physical event represented by
 * multiple sources — typically aggregator (akron_life) republishing
 * something we already scrape directly (ticketmaster, eventbrite).
 *
 * Matching rule:
 *   Two events are "the same physical event" when they share ALL of
 *     • the same linked venue (event_venues.venue_id), AND
 *     • the same start_at timestamp (exact second match), AND
 *     • the same normalized title (lowercased, punctuation/whitespace folded)
 *
 *   The title check is essential: libraries and museums host many parallel
 *   programs at the same start time in different rooms — venue+time alone
 *   wildly over-matches. The forward fix in scrape-akron-life.js (filter
 *   by Evvnt's `sources` field) handles the common cross-source case
 *   proactively; this script cleans up what slipped through.
 *
 * For each duplicate group, the canonical entry is chosen by SOURCE_PRIORITY
 * (lower index = more authoritative). Non-canonical entries are deleted.
 * Junction rows cascade.
 *
 * Safety:
 *   • Default is dry-run — pass `--apply` to delete
 *   • Events whose `manual_overrides` is non-empty are NEVER deleted, even
 *     when not chosen as canonical (respects manual edits — Byron's policy)
 *   • Events with no linked venue are skipped (can't be matched reliably)
 *
 * Usage:
 *   node scripts/dedupe-cross-source.js          # dry run
 *   node scripts/dedupe-cross-source.js --apply  # do it
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

const APPLY = process.argv.includes('--apply')

// Lower index = higher priority (kept as canonical).
// Direct primary-source scrapers first, then aggregators / republishers last.
const SOURCE_PRIORITY = [
  'ticketmaster',
  'eventbrite',
  'akron_civic',
  'akronym',
  'akron_symphony',
  'akron_zoo',
  'akron_art_museum',
  'akron_childrens_museum',
  'akron_library',
  'akron_public_schools',
  'blu_jazz',
  'downtown_akron',
  'jillys',
  'leadership_akron',
  'missing_falls',
  'nightlight',
  'north_hill_cdc',
  'ohio_shakespeare',
  'painting_twist',
  'rubberducks',
  'summit_artspace',
  'summit_metro_parks',
  'torchbearers',
  'uakron_calendar',
  'weathervane',
  'akron_life',  // aggregator — last
]

function priority(source) {
  const i = SOURCE_PRIORITY.indexOf(source)
  return i === -1 ? SOURCE_PRIORITY.length : i  // unknown sources sort to the end
}

function hasManualOverrides(ev) {
  return ev.manual_overrides && typeof ev.manual_overrides === 'object' &&
         Object.keys(ev.manual_overrides).length > 0
}

/**
 * Normalize a title so cosmetic differences don't break the dedup match:
 *   "Martell School of Dance: Afternoon of Dance" and
 *   "Martell School Of Dance - Afternoon of Dance"
 * → both become "martell school of dance afternoon of dance"
 */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')               // strip apostrophes so "Akron's" matches "Akrons"
    .replace(/[^a-z0-9]+/g, ' ')         // fold all other punctuation/whitespace to single space
    .replace(/\s+/g, ' ')
    .trim()
}

async function main() {
  console.log(`🔍  ${APPLY ? 'APPLYING' : 'DRY RUN —'} cross-source duplicate cleanup`)
  console.log(`    Match rule: same venue + same start_at across different sources`)
  console.log('')

  // Pull every event with its linked venue. Page through in case there are
  // more than the default page size.
  const all = []
  let from = 0
  const pageSize = 1000
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, start_at, source, source_id, ticket_url, manual_overrides, event_venues(venue_id)')
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
  console.log(`Loaded ${all.length} events`)

  // Group by (venue_id, start_at, normalized_title). Events without a venue
  // link are excluded from the matching pool — we can't reliably dedup
  // without a venue anchor.
  const groups = new Map()
  let withoutVenue = 0
  for (const e of all) {
    const venueId = e.event_venues?.[0]?.venue_id
    if (!venueId) { withoutVenue++; continue }
    const titleKey = normalizeTitle(e.title)
    if (!titleKey) continue
    const key = `${venueId}|${e.start_at}|${titleKey}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  console.log(`Excluded ${withoutVenue} events with no linked venue`)
  console.log('')

  // Keep only multi-event groups
  const dupeGroups = [...groups.values()].filter(g => g.length > 1)
  console.log(`Found ${dupeGroups.length} duplicate group(s)`)
  console.log('')

  let totalToDelete = 0
  let preserved    = 0
  const deletes    = []

  for (const group of dupeGroups) {
    // Sort by priority — index 0 is canonical
    const sorted = [...group].sort((a, b) => priority(a.source) - priority(b.source))
    const canonical = sorted[0]
    const dupes     = sorted.slice(1)

    console.log(`Group: ${sorted[0].start_at}  venue=${sorted[0].event_venues?.[0]?.venue_id?.slice(0, 8)}…`)
    console.log(`  KEEP  [${canonical.source}/${canonical.source_id}] ${canonical.title?.slice(0, 60)}`)
    for (const d of dupes) {
      const protect = hasManualOverrides(d)
      const tag = protect ? '🛡 KEEP (manual_overrides)' : 'DROP'
      console.log(`  ${tag.padEnd(26)} [${d.source}/${d.source_id}] ${d.title?.slice(0, 60)}`)
      if (protect) { preserved++ }
      else         { deletes.push(d.id); totalToDelete++ }
    }
  }

  console.log('')
  console.log(`Summary: ${totalToDelete} to delete, ${preserved} preserved by manual_overrides`)

  if (!APPLY) {
    console.log('')
    console.log(`(Dry run — pass --apply to delete ${totalToDelete} duplicate events.)`)
    return
  }
  if (deletes.length === 0) {
    console.log('Nothing to delete.')
    return
  }

  // Batch deletes
  const CHUNK = 100
  let deleted = 0
  for (let i = 0; i < deletes.length; i += CHUNK) {
    const batch = deletes.slice(i, i + CHUNK)
    const { error, count } = await supabaseAdmin
      .from('events')
      .delete({ count: 'exact' })
      .in('id', batch)
    if (error) {
      console.error(`  ✗ Delete batch ${i} failed:`, error.message)
      process.exit(1)
    }
    deleted += count ?? batch.length
  }
  console.log(`✅  Deleted ${deleted} events. Junction-table rows cascaded.`)
}

main().catch(err => {
  console.error('Dedupe failed:', err)
  process.exit(1)
})
