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

/**
 * Flexible title comparison that tolerates a leading city/org prefix on one
 * source but not the other.
 *
 * Background: the dedicated RubberDucks scraper produces titles like
 *   "RubberDucks vs. Hartford Yard Goats"
 * while Ticketmaster prepends the city:
 *   "Akron RubberDucks vs. Hartford Yard Goats"
 * After normalizeTitle() these become:
 *   "rubberducks vs hartford yard goats"
 *   "akron rubberducks vs hartford yard goats"
 * A strict equality check misses the match.  We fix this by progressively
 * stripping leading words (up to MAX_PREFIX_WORDS) from the longer title and
 * checking whether the remainder equals the shorter title.
 */
const MAX_PREFIX_WORDS = 2

function titlesMatch(a, b) {
  if (a === b) return true
  // Ensure `longer` is always the title we strip from
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]
  let trimmed = longer
  for (let i = 0; i < MAX_PREFIX_WORDS; i++) {
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) break
    trimmed = trimmed.slice(spaceIdx + 1)
    if (trimmed === shorter) return true
  }
  return false
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
      .select('id, title, description, image_url, start_at, source, source_id, ticket_url, manual_overrides, event_venues(venue_id)')
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
  // Deduplicate by event ID. If an event has multiple rows in event_venues
  // (e.g. a duplicate junction row), PostgREST can return the same event
  // more than once in the paginated result, which would cause the grouping
  // logic below to cluster an event with itself and flag it as a duplicate.
  const seen = new Set()
  const unique = all.filter(e => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
  if (unique.length < all.length) {
    console.log(`Collapsed ${all.length - unique.length} duplicate row(s) from multi-venue joins`)
  }
  console.log(`Loaded ${unique.length} unique events`)

  // Group by (venue_id, start_at, title). Events without a venue link are
  // excluded from the matching pool — we can't reliably dedup without a venue
  // anchor.
  //
  // Two-pass strategy:
  //   Pass 1 — bucket by (venue_id, start_at).  This is fast and exact.
  //   Pass 2 — within each bucket, further group by title using titlesMatch(),
  //             which tolerates leading city/org prefixes (e.g. "Akron
  //             RubberDucks vs. X" from Ticketmaster matching "RubberDucks vs. X"
  //             from the dedicated scraper).
  const byVenueTime = new Map()
  let withoutVenue = 0
  for (const e of unique) {
    const venueId = e.event_venues?.[0]?.venue_id
    if (!venueId) { withoutVenue++; continue }
    const titleKey = normalizeTitle(e.title)
    if (!titleKey) continue
    const bucket = `${venueId}|${e.start_at}`
    if (!byVenueTime.has(bucket)) byVenueTime.set(bucket, [])
    byVenueTime.get(bucket).push({ ...e, _titleKey: titleKey })
  }
  console.log(`Excluded ${withoutVenue} events with no linked venue`)
  console.log('')

  // Pass 2: within each venue+time bucket, group by fuzzy title match.
  const groups = []
  for (const bucket of byVenueTime.values()) {
    // cluster: each item is an array of events with matching titles
    const clusters = []
    for (const e of bucket) {
      const existing = clusters.find(c => titlesMatch(c[0]._titleKey, e._titleKey))
      if (existing) existing.push(e)
      else clusters.push([e])
    }
    for (const cluster of clusters) groups.push(cluster)
  }

  // Keep only multi-event groups
  const dupeGroups = groups.filter(g => g.length > 1)
  console.log(`Found ${dupeGroups.length} duplicate group(s)`)
  console.log('')

  let totalToDelete = 0
  let preserved    = 0
  const deletes    = []
  const merges     = []  // { id, fields } — canonical events that need a field merge

  for (const group of dupeGroups) {
    // Sort to find the canonical event — data quality wins over source priority.
    //
    // Tier 1 (best): has both image_url AND a non-trivial description
    // Tier 2:        has image_url OR a non-trivial description
    // Tier 3:        has neither
    //
    // Within the same tier, fall back to SOURCE_PRIORITY so we consistently
    // prefer authoritative first-party data over aggregators.
    const dataScore = (e) => {
      const hasImage = !!e.image_url
      const hasDesc  = !!(e.description && e.description.trim().length > 20)
      if (hasImage && hasDesc) return 0   // best
      if (hasImage || hasDesc) return 1
      return 2                            // worst
    }
    const sorted = [...group].sort((a, b) => {
      const scoreDiff = dataScore(a) - dataScore(b)
      if (scoreDiff !== 0) return scoreDiff
      return priority(a.source) - priority(b.source)
    })
    const canonical = sorted[0]
    const dupes     = sorted.slice(1)

    const qualityLabel = (e) => {
      const hasImage = !!e.image_url
      const hasDesc  = !!(e.description && e.description.trim().length > 20)
      if (hasImage && hasDesc) return '✓img ✓desc'
      if (hasImage) return '✓img  desc'
      if (hasDesc)  return ' img ✓desc'
      return ' img  desc'
    }

    // Collect fields the canonical is missing but a dupe can supply.
    // We merge image_url and description rather than losing them on deletion.
    const mergeFields = {}
    const hasGoodDesc = (e) => !!(e.description && e.description.trim().length > 20)
    for (const d of dupes) {
      if (!canonical.image_url && d.image_url && !mergeFields.image_url) {
        mergeFields.image_url = d.image_url
      }
      if (!hasGoodDesc(canonical) && hasGoodDesc(d) && !mergeFields.description) {
        mergeFields.description = d.description
      }
    }
    const mergeNote = Object.keys(mergeFields).length > 0
      ? ` [will merge: ${Object.keys(mergeFields).join(', ')}]`
      : ''

    console.log(`Group: ${sorted[0].start_at}  venue=${sorted[0].event_venues?.[0]?.venue_id?.slice(0, 8)}…`)
    console.log(`  KEEP  [${canonical.source}/${canonical.source_id}] (${qualityLabel(canonical)})${mergeNote} ${canonical.title?.slice(0, 50)}`)
    for (const d of dupes) {
      const protect = hasManualOverrides(d)
      const tag = protect ? '🛡 KEEP (manual_overrides)' : 'DROP'
      console.log(`  ${tag.padEnd(26)} [${d.source}/${d.source_id}] (${qualityLabel(d)}) ${d.title?.slice(0, 50)}`)
      if (protect) { preserved++ }
      else         { deletes.push(d.id); totalToDelete++ }
    }

    if (Object.keys(mergeFields).length > 0) merges.push({ id: canonical.id, fields: mergeFields })
  }

  console.log('')
  console.log(`Summary: ${totalToDelete} to delete, ${merges.length} to enrich, ${preserved} preserved by manual_overrides`)

  if (!APPLY) {
    console.log('')
    console.log(`(Dry run — pass --apply to delete ${totalToDelete} and enrich ${merges.length} canonical events.)`)
    return
  }

  // Apply field merges to canonicals before deleting dupes
  if (merges.length > 0) {
    let merged = 0
    for (const { id, fields } of merges) {
      const { error } = await supabaseAdmin.from('events').update(fields).eq('id', id)
      if (error) console.warn(`  ⚠ Merge failed for ${id}: ${error.message}`)
      else merged++
    }
    console.log(`✅  Merged fields into ${merged} canonical event(s).`)
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
