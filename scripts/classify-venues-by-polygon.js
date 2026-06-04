/**
 * classify-venues-by-polygon.js
 *
 * One-time backfill: stamp `venues.neighborhood_slug` for every venue
 * whose (lat, lng) sits inside a City of Akron neighborhood polygon.
 *
 * Why this exists:
 *   Migration 028 added the column; admins can fill it via the venue
 *   editor; new scraped venues auto-resolve at insert (see
 *   scripts/lib/neighborhood-resolver.js + ensureVenue). This script
 *   closes the loop for everything already in the table — typically
 *   the long-tail of venues that pre-date the column.
 *
 * Safety:
 *   - Idempotent. Only touches rows where neighborhood_slug IS NULL,
 *     so manual classifications and prior runs are never overwritten.
 *   - Default is a DRY RUN. Pass --execute to actually write.
 *   - Logs an exact summary before any writes: how many venues will
 *     be classified, how many fall outside city limits (correct
 *     behavior — those are non-Akron venues), how many are missing
 *     coordinates (operator-visible gap to chase via geocode.js).
 *
 * Usage:
 *   node scripts/classify-venues-by-polygon.js              # dry run (default)
 *   node scripts/classify-venues-by-polygon.js --execute    # apply
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { resolveNeighborhoodSlug } from './lib/neighborhood-resolver.js'

const EXECUTE = process.argv.includes('--execute')
const VERBOSE = process.argv.includes('--verbose')

// Updates run in chunks so a single failure doesn't roll back the world,
// and so progress is visible on large tables. 50 keeps each batch under
// PostgREST's URL-length budget comfortably even with UUIDs.
const CHUNK = 50

async function main() {
  console.log(
    `\n📍  Classifying venues by neighborhood polygon` +
    `${EXECUTE ? '' : '   (DRY RUN — pass --execute to apply)'}\n`,
  )

  // Pull every venue's id + coordinates + current slug. We only need
  // these three columns for the work, and the venues table is small
  // enough (~hundreds, not millions) that one query is fine.
  const { data: venues, error } = await supabaseAdmin
    .from('venues')
    .select('id, name, lat, lng, neighborhood_slug')

  if (error) {
    console.error('❌ Failed to fetch venues:', error.message)
    process.exit(1)
  }

  // Bucket every venue into one of four states so the operator sees
  // exactly what's about to happen before --execute does anything.
  const buckets = {
    alreadyClassified: [],   // neighborhood_slug already non-null — left alone
    noCoords:          [],   // missing lat or lng — needs geocoding first
    outsideAkron:      [],   // has coords but falls outside every polygon
    toClassify:        [],   // { id, name, slug } — the rows we'll write
  }

  for (const v of venues) {
    if (v.neighborhood_slug) { buckets.alreadyClassified.push(v); continue }
    if (v.lat == null || v.lng == null) { buckets.noCoords.push(v); continue }
    const slug = await resolveNeighborhoodSlug(v.lat, v.lng)
    if (slug == null) { buckets.outsideAkron.push(v); continue }
    buckets.toClassify.push({ id: v.id, name: v.name, slug })
  }

  const total = venues.length
  console.log(`Total venues:                 ${total}`)
  console.log(`Already classified:           ${buckets.alreadyClassified.length}`)
  console.log(`Missing lat/lng:              ${buckets.noCoords.length}   ${buckets.noCoords.length ? '(needs geocoding)' : ''}`)
  console.log(`Outside Akron polygons:       ${buckets.outsideAkron.length}   (expected for Cuyahoga Falls, Stow, Fairlawn, Copley, etc.)`)
  console.log(`Will classify in this run:    ${buckets.toClassify.length}`)
  console.log('')

  // Per-slug breakdown — useful both as a sanity check (no slug ends
  // up with zero matches if the data is healthy) and as a quick eye
  // on which neighborhoods have venue density.
  const bySlug = {}
  for (const row of buckets.toClassify) bySlug[row.slug] = (bySlug[row.slug] ?? 0) + 1
  if (Object.keys(bySlug).length > 0) {
    console.log('Per-neighborhood counts (about to be set):')
    for (const [slug, count] of Object.entries(bySlug).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${slug}`)
    }
    console.log('')
  }

  // Optional per-row preview for hand-auditing edge cases.
  if (VERBOSE) {
    console.log('Sample of classifications (first 20):')
    for (const row of buckets.toClassify.slice(0, 20)) {
      console.log(`  • ${row.slug.padEnd(20)} ← ${row.name}`)
    }
    if (buckets.outsideAkron.length > 0) {
      console.log('\nOutside-Akron sample (first 10):')
      for (const v of buckets.outsideAkron.slice(0, 10)) {
        console.log(`  • ${v.name}   (${v.lat}, ${v.lng})`)
      }
    }
    if (buckets.noCoords.length > 0) {
      console.log('\nNo-coords sample (first 10):')
      for (const v of buckets.noCoords.slice(0, 10)) {
        console.log(`  • ${v.name}`)
      }
    }
    console.log('')
  }

  if (!EXECUTE) {
    console.log('Dry run complete. Re-run with --execute to apply.\n')
    return
  }

  if (buckets.toClassify.length === 0) {
    console.log('Nothing to write — every classifiable venue already has a slug.\n')
    return
  }

  // Apply updates. Supabase's REST client doesn't support a bulk
  // CASE-WHEN update, so we issue one update per chunk × per slug
  // group — but rows of the same slug can share one update.
  const grouped = {}
  for (const row of buckets.toClassify) {
    grouped[row.slug] = grouped[row.slug] ?? []
    grouped[row.slug].push(row.id)
  }

  let written = 0
  let failed = 0
  for (const [slug, ids] of Object.entries(grouped)) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      // The `.is('neighborhood_slug', null)` guard is belt-and-braces:
      // we already filtered nulls when we built `toClassify`, but a
      // concurrent admin save could have stamped one of these rows
      // between the read and the write. Letting the DB enforce the
      // "don't overwrite" rule means we can never clobber a manual
      // edit even under that race.
      const { error: updErr, count } = await supabaseAdmin
        .from('venues')
        .update({ neighborhood_slug: slug }, { count: 'exact' })
        .in('id', chunk)
        .is('neighborhood_slug', null)
      if (updErr) {
        console.error(`  ⚠ Update failed for ${slug} batch ${i}: ${updErr.message}`)
        failed += chunk.length
        continue
      }
      written += count ?? chunk.length
    }
    console.log(`  ✓ ${slug.padEnd(20)} ${grouped[slug].length} rows`)
  }

  console.log(`\nDone. Wrote ${written} updates, ${failed} failed.\n`)
}

main().catch((err) => {
  console.error('classify-venues-by-polygon failed:', err)
  process.exit(1)
})
