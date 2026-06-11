/**
 * TEMP dry-run classifier for the review-queue cleanup. Read-only. No writes.
 * Pulls every needs_review=true event, runs the CURRENT inference, and buckets:
 *   - resolved_real : already has a non-'other' category (stale flag)
 *   - locked        : manual_overrides.category already set
 *   - confident     : inference now yields a real category
 *   - still_other   : inference still 'other' (genuine human review)
 * Writes /sessions/.../outputs/queue-proposals.json and prints a summary.
 */
import 'dotenv/config'
import fs from 'node:fs'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { inferCategories } from './lib/category-inference.js'

const rows = []
let from = 0
const page = 500
for (;;) {
  const { data, error } = await supabaseAdmin
    .from('events')
    .select('id, title, description, source, start_at, manual_overrides, is_family, is_fundraiser, event_categories ( category )')
    .eq('needs_review', true)
    .order('start_at', { ascending: true })
    .range(from, from + page - 1)
  if (error) { console.error(error.message); process.exit(1) }
  if (!data?.length) break
  rows.push(...data)
  if (data.length < page) break
  from += page
}

const now = Date.now()
const out = { resolved_real: [], locked: [], confident: [], still_other: [] }

for (const ev of rows) {
  const cats = (ev.event_categories ?? []).map(c => c.category)
  const realCats = cats.filter(c => c && c !== 'other')
  const mo = ev.manual_overrides
  const isLocked = mo && typeof mo === 'object' && mo.category
  const past = ev.start_at ? new Date(ev.start_at).getTime() < now : false

  const rec = { id: ev.id, title: ev.title, source: ev.source, start_at: ev.start_at, past, currentCats: cats }

  if (realCats.length > 0) { out.resolved_real.push({ ...rec, realCats }); continue }
  if (isLocked) { out.locked.push(rec); continue }

  const inf = inferCategories(ev.title || '', ev.description || '')
  rec.inferred = inf.categories
  rec.family = inf.family
  rec.fundraiser = inf.fundraiser
  if (inf.categories.length === 1 && inf.categories[0] === 'other') out.still_other.push(rec)
  else out.confident.push(rec)
}

fs.writeFileSync('/sessions/kind-dreamy-brahmagupta/mnt/outputs/queue-proposals.json', JSON.stringify(out, null, 2))

const dist = {}
for (const r of out.confident) {
  const k = r.inferred.join('+')
  dist[k] = (dist[k] || 0) + 1
}
console.log('TOTAL queued:', rows.length)
console.log('resolved_real (stale flag):', out.resolved_real.length)
console.log('locked (manual override):', out.locked.length)
console.log('confident (auto-assign):', out.confident.length)
console.log('still_other (human review):', out.still_other.length)
console.log('  of still_other, past:', out.still_other.filter(r => r.past).length, 'upcoming:', out.still_other.filter(r => !r.past).length)
console.log('\nConfident assignment distribution:')
for (const [k, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)
console.log('\nConfident facets — family:', out.confident.filter(r => r.family).length, 'fundraiser:', out.confident.filter(r => r.fundraiser).length)
