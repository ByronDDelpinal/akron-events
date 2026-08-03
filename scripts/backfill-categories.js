/**
 * backfill-categories.js
 *
 * Re-run the content-category inference over events that are still sitting in a
 * bare `['other']` (or have no category row at all) and write the improved
 * categories into `event_categories`. This is the batch counterpart to what
 * `upsertEventSafe` does per-row at ingest: over time the inference keyword table
 * and per-source `defaultCategory` priors improve, but rows written before those
 * improvements stay stuck at 'other'. The daily fix sweep runs this so the
 * public calendar's "uncategorized" tail keeps shrinking instead of ossifying.
 *
 * Scope: only events whose CURRENT categories are exactly ['other'] or empty are
 * candidates, and a candidate is only rewritten when inference now yields
 * something better than 'other'. We never downgrade a real category, and
 * `syncEventCategories` skips any event with an admin `manual_overrides` lock on
 * categories — so this is safe to run repeatedly.
 *
 * Dry-run by default (prints counts + samples + the proposed-category
 * distribution). Pass --apply to write.
 *
 * Usage:
 *   node scripts/backfill-categories.js                 # dry run, published + pending_review
 *   node scripts/backfill-categories.js --apply         # write
 *   node scripts/backfill-categories.js --status=pending_review --apply
 *   node scripts/backfill-categories.js --limit=200 --apply
 *
 * Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { resolveEventCategories, syncEventCategories } from './lib/normalize.js'
import { inferCategories } from './lib/category-inference.js'
import { defaultCategoryFor } from './manifest.js'

/**
 * The categories inference would assign to an event now, given its text and
 * source. Mirrors the resolve path in upsertEventSafe: text inference, then the
 * per-source `defaultCategory` rescues a bare ['other']. Pure — exported for
 * tests. `overrideInfer` lets tests inject inference without the keyword table.
 */
export function decideCategories(event, overrideInfer = inferCategories) {
  const inferred = overrideInfer(event.title || '', event.description || '')
  return resolveEventCategories(
    { category: event.category, categories: event.categories },
    inferred.categories,
    defaultCategoryFor(event.source),
  )
}

/** The event's current category slugs (from an embedded event_categories list). */
export function currentCategories(event) {
  const rows = event.event_categories || event.categories || []
  const slugs = rows.map((r) => (typeof r === 'string' ? r : r.category)).filter(Boolean)
  return [...new Set(slugs)]
}

/**
 * True when an event is a re-categorization candidate AND we can improve it:
 * its current categories are empty or exactly ['other'], and the proposed set
 * is something other than ['other']. Never touches a row that already has a real
 * category (no downgrades), and never writes ['other'] over ['other'] (no-op).
 */
export function shouldRecategorize(current, proposed) {
  const cur = [...new Set(current)].filter(Boolean)
  const isBare = cur.length === 0 || (cur.length === 1 && cur[0] === 'other')
  const proposedReal = proposed.length > 0 && !(proposed.length === 1 && proposed[0] === 'other')
  return isBare && proposedReal
}

// ── Runner ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const apply = argv.includes('--apply')
  const statusArg = (argv.find((a) => a.startsWith('--status=')) || '').split('=')[1]
  const limitArg = (argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]
  const statuses = statusArg && statusArg !== 'all'
    ? [statusArg]
    : ['published', 'pending_review']
  return { apply, statuses, limit: limitArg ? parseInt(limitArg, 10) : null }
}

async function main() {
  const { apply, statuses, limit } = parseArgs(process.argv.slice(2))
  console.log(`🏷️  Category backfill — statuses [${statuses.join(', ')}]${limit ? `, limit ${limit}` : ''} — ${apply ? 'APPLY' : 'dry run'}`)

  // Pull candidates with their current categories embedded. PostgREST paginates
  // at 1000; page through so a large backlog is fully covered.
  const candidates = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, description, source, event_categories(category)')
      .in('status', statuses)
      .range(from, from + PAGE - 1)
    if (error) { console.error(`  ✗ query failed: ${error.message}`); process.exit(1) }
    if (!data?.length) break
    for (const ev of data) {
      const current = currentCategories(ev)
      const proposed = decideCategories(ev)
      if (shouldRecategorize(current, proposed)) candidates.push({ ev, current, proposed })
    }
    if (data.length < PAGE) break
  }

  const work = limit ? candidates.slice(0, limit) : candidates
  const dist = {}
  for (const c of work) { const k = c.proposed.join('+'); dist[k] = (dist[k] || 0) + 1 }

  console.log(`  ${candidates.length} improvable event(s)${limit ? ` (capping at ${work.length})` : ''}`)
  console.log(`  proposed category distribution: ${JSON.stringify(dist)}`)
  console.log(`  samples: ${work.slice(0, 5).map((c) => `${c.ev.id.slice(0, 8)}→${c.proposed.join('+')}`).join(', ')}`)

  if (!apply) { console.log('\n(dry run — pass --apply to write)'); return }

  let written = 0
  for (const c of work) {
    await syncEventCategories(c.ev.id, c.proposed) // skips admin-locked rows internally
    written++
  }
  console.log(`\n✅  Recategorized ${written} event(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
