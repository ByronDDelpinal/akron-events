/**
 * backfill-nature-category.js
 *
 * One-time backfill that re-tags existing events into the new 'nature'
 * category introduced by migration 019. Rule:
 *
 *   source IN ('summit_metro_parks', 'cvnp_conservancy')
 *     AND category IN ('community', 'education')   → 'nature'
 *
 * The source restriction keeps the change scoped to scrapers that are
 * unambiguously nature-flavored. The category restriction protects
 * music/art/sports/fitness events that happen to be hosted at park
 * venues — a concert in a park is still a music event.
 *
 * Usage:
 *   node scripts/backfill-nature-category.js              # DRY RUN (default)
 *   node scripts/backfill-nature-category.js --execute    # actually apply
 *
 * Prerequisite:
 *   Migration 019_nature_category.sql must be applied first, or the
 *   CHECK constraint will reject the new category value.
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

const EXECUTE = process.argv.includes('--execute')

const NATURE_SOURCES = ['summit_metro_parks', 'cvnp_conservancy']
const SOURCE_CATEGORIES_TO_REMAP = ['community', 'education']

async function main() {
  console.log(
    `\n🌿  Backfilling Nature category${EXECUTE ? '' : '  (DRY RUN — pass --execute to apply)'}\n`
  )

  // Pre-state: how many events match the rule?
  const { data: candidates, error: selectErr } = await supabaseAdmin
    .from('events')
    .select('id, source, category, title')
    .in('source', NATURE_SOURCES)
    .in('category', SOURCE_CATEGORIES_TO_REMAP)

  if (selectErr) {
    console.error('❌ Failed to query candidates:', selectErr.message)
    process.exit(1)
  }

  console.log(`Found ${candidates.length} events matching the rule.\n`)

  // Per-source / per-category breakdown so the operator sees what's moving.
  const breakdown = {}
  for (const ev of candidates) {
    const key = `${ev.source}  ${ev.category}`
    breakdown[key] = (breakdown[key] ?? 0) + 1
  }
  for (const [key, count] of Object.entries(breakdown).sort()) {
    console.log(`  ${count.toString().padStart(4)}  ${key}  →  nature`)
  }
  console.log('')

  // Sample five titles for sanity-checking the rule's precision.
  console.log('Sample of events that will be re-tagged:')
  for (const ev of candidates.slice(0, 5)) {
    console.log(`  • [${ev.category}] ${ev.title.slice(0, 70)}`)
  }
  console.log('')

  if (!EXECUTE) {
    console.log('Dry run complete. Re-run with --execute to apply the update.\n')
    return
  }

  // Execute: bulk UPDATE via id IN (...) in chunks to stay under URL/PostgREST limits.
  const CHUNK = 100
  let updated = 0
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    const ids = chunk.map((e) => e.id)
    const { error: updateErr } = await supabaseAdmin
      .from('events')
      .update({ category: 'nature' })
      .in('id', ids)

    if (updateErr) {
      console.error(`❌ Chunk starting at ${i} failed:`, updateErr.message)
      process.exit(1)
    }
    updated += chunk.length
    process.stdout.write(`  Updated ${updated}/${candidates.length}\r`)
  }
  console.log(`  Updated ${updated}/${candidates.length}`)

  // Post-state verification: count rows now in nature.
  const { count: natureCount, error: countErr } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('category', 'nature')

  if (countErr) {
    console.warn('⚠️ Post-update count failed:', countErr.message)
  } else {
    console.log(`\n✅ Done. Events now tagged 'nature': ${natureCount}\n`)
  }
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err)
  process.exit(1)
})
