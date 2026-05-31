/**
 * One-time backfill: decode HTML entities lurking in `events.tags`.
 *
 * Why this exists:
 *   Before sanitizeEventText was extended to cover tags, some scrapers
 *   wrote tag values straight from upstream feeds — values like
 *   "health &amp; fitness" landed in the DB with the entity intact.
 *   New ingests after the normalize.js fix won't reintroduce the bug,
 *   but existing rows still need cleaning.
 *
 * What it does:
 *   - Streams every event with at least one tag that contains "&".
 *   - Decodes each tag using the same decodeEntities helper the
 *     scraper pipeline now uses.
 *   - Writes the cleaned tags array back. Skips rows where the
 *     decoded array equals the original (nothing to change).
 *   - Honors a --dry-run flag so you can see the diff before
 *     touching production data.
 *
 * Usage:
 *   node scripts/backfill-tag-entities.js --dry-run
 *   node scripts/backfill-tag-entities.js
 *
 * Idempotent — safe to re-run.
 */

import { supabaseAdmin } from './lib/supabase-admin.js'
import { decodeEntities } from './lib/normalize.js'

const DRY_RUN = process.argv.includes('--dry-run')
const PAGE_SIZE = 500

function cleanTags(tags) {
  if (!Array.isArray(tags)) return tags
  const cleaned = tags
    .map(t => (typeof t === 'string' ? decodeEntities(t).trim() : t))
    .filter(Boolean)
  // Detect drift — same length AND same entries AND same order ⇒ no change.
  const same =
    cleaned.length === tags.length &&
    cleaned.every((v, i) => v === tags[i])
  return same ? null : cleaned
}

async function run() {
  console.log(DRY_RUN ? '[backfill-tags] DRY RUN — no writes' : '[backfill-tags] live run')

  let from = 0
  let totalScanned = 0
  let totalChanged = 0
  const sample = []

  /* eslint-disable no-constant-condition */
  while (true) {
    // Postgres array containment can't easily ask "any entry contains &",
    // so we just stream every event with a non-null, non-empty tags array
    // and filter in JS. Volume is small (few thousand events).
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, tags')
      .not('tags', 'is', null)
      .range(from, from + PAGE_SIZE - 1)

    if (error) {
      console.error('[backfill-tags] query error:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break

    for (const row of data) {
      totalScanned++
      const next = cleanTags(row.tags)
      if (!next) continue

      totalChanged++
      if (sample.length < 5) {
        sample.push({ id: row.id, title: row.title, before: row.tags, after: next })
      }
      if (!DRY_RUN) {
        const { error: updErr } = await supabaseAdmin
          .from('events')
          .update({ tags: next })
          .eq('id', row.id)
        if (updErr) {
          console.error(`[backfill-tags] update failed for ${row.id}:`, updErr.message)
        }
      }
    }

    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  console.log(`[backfill-tags] scanned ${totalScanned} rows`)
  console.log(`[backfill-tags] ${DRY_RUN ? 'would change' : 'changed'} ${totalChanged} rows`)
  if (sample.length > 0) {
    console.log('[backfill-tags] sample diffs:')
    for (const s of sample) {
      console.log(`  - ${s.title}`)
      console.log(`      before: ${JSON.stringify(s.before)}`)
      console.log(`      after:  ${JSON.stringify(s.after)}`)
    }
  }
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
