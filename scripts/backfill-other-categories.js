/**
 * backfill-other-categories.js
 *
 * One-off backfill: re-categorize events currently tagged `category='other'`
 * using the new text inference helper in lib/normalize.js. Only updates the
 * category column — no other event fields are touched.
 *
 * Why this exists:
 *   Until inferCategory was wired into the Eventbrite scraper, every
 *   Eventbrite event (~240 rows) landed as 'other' because the search-page
 *   JSON doesn't include category_id. The forward fix is now live; this
 *   script catches up the historical rows so the existing corpus shows the
 *   right categories without waiting on a full re-scrape.
 *
 * Safety:
 *   • Default is dry-run — prints proposed changes, writes nothing.
 *   • Pass `--apply` to commit updates.
 *   • Events with `manual_overrides.category` set are PRESERVED — respects
 *     any manual category edits.
 *   • Events for which inference still returns 'other' are left alone.
 *
 * Usage:
 *   node scripts/backfill-other-categories.js          # dry run
 *   node scripts/backfill-other-categories.js --apply  # do it
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { inferCategory } from './lib/normalize.js'

const APPLY = process.argv.includes('--apply')
const CHUNK = 50

async function main() {
  console.log(`🏷  ${APPLY ? 'APPLYING' : 'DRY RUN —'} category backfill for events tagged 'other'`)
  console.log('')

  // Pull every event currently classified as 'other'. We need title +
  // description for inference, and manual_overrides to respect manual edits.
  const all = []
  let from = 0
  const pageSize = 500
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, description, source, manual_overrides')
      .eq('category', 'other')
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
  console.log(`Found ${all.length} events tagged 'other'`)
  console.log('')

  const changes  = [] // { id, title, newCategory, source }
  let preserved  = 0
  let unchanged  = 0
  for (const ev of all) {
    const mo = ev.manual_overrides
    if (mo && typeof mo === 'object' && 'category' in mo) { preserved++; continue }
    const inferred = inferCategory(ev.title || '', ev.description || '')
    if (inferred === 'other') { unchanged++; continue }
    changes.push({ id: ev.id, title: ev.title, newCategory: inferred, source: ev.source })
  }

  // Summary by new category + source for visibility
  const byCat    = {}
  const bySource = {}
  for (const c of changes) {
    byCat[c.newCategory] = (byCat[c.newCategory] || 0) + 1
    bySource[c.source]   = (bySource[c.source] || 0) + 1
  }

  console.log(`Proposed changes: ${changes.length}`)
  console.log(`Preserved (manual_overrides): ${preserved}`)
  console.log(`Inference still 'other':     ${unchanged}`)
  console.log('')
  console.log('By new category:')
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)} → ${c}`)
  }
  console.log('')
  console.log('By source:')
  for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)} ${s}`)
  }

  // Sample 3 from each new category for review
  console.log('')
  console.log('Sample (3 per category):')
  const samples = {}
  for (const c of changes) (samples[c.newCategory] ||= []).push(c)
  for (const [cat, items] of Object.entries(samples)) {
    console.log(`  [${cat}]`)
    for (const c of items.slice(0, 3)) {
      console.log(`    • ${c.title?.slice(0, 70) ?? '(no title)'}`)
    }
  }

  if (!APPLY) {
    console.log('')
    console.log(`(Dry run — pass --apply to update these ${changes.length} events.)`)
    return
  }
  if (changes.length === 0) {
    console.log('\nNothing to update.')
    return
  }

  // Apply in chunks to keep request bodies reasonable.
  console.log(`\nApplying updates in chunks of ${CHUNK}…`)
  let updated = 0, failed = 0
  for (let i = 0; i < changes.length; i += CHUNK) {
    const batch = changes.slice(i, i + CHUNK)
    // Supabase doesn't have native bulk-update-with-different-values for one
    // column, so we issue parallel single-row updates within each batch.
    const results = await Promise.all(batch.map(c =>
      supabaseAdmin.from('events').update({ category: c.newCategory }).eq('id', c.id)
    ))
    for (const r of results) {
      if (r.error) {
        failed++
        console.warn(`  ⚠ ${r.error.message}`)
      } else {
        updated++
      }
    }
    process.stderr.write(`\r  ${Math.min(i + CHUNK, changes.length)}/${changes.length} processed`)
  }
  console.log('')
  console.log(`✅  Updated ${updated} events. Failed: ${failed}.`)
}

main().catch(err => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
