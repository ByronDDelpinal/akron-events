/**
 * sweep-placeholder-venues.js — one-time cleanup for legacy geo-less
 * placeholder venues ("more information to come", "Fairlawn (location to be
 * announced)", …) minted before ensureVenue's junk-name gate. event_venues is
 * add-only, so events linked before the gate stay pinned to them.
 *
 * Candidates: isJunkVenueName(name) AND address IS NULL AND lat IS NULL.
 * The dry run (default) lists every candidate; online markers (Virtual, Zoom,
 * Online, …) are marked "online signal — excluded by default".
 * --apply REQUIRES --ids=<id,id,…> naming candidates to act on. For those it:
 *   1. writes a JSON backup of their {event_id, venue_id} links (os.tmpdir()),
 *   2. sets needs_review=true on linked events and listed=false on the venues,
 *   3. deletes the links. Venue rows are never deleted or renamed.
 * Manual only: never wire into run-all.js or a workflow.
 *
 *   node scripts/sweep-placeholder-venues.js
 *   node scripts/sweep-placeholder-venues.js --apply --ids=<uuid>,<uuid>
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isJunkVenueName } from './lib/normalize.js'
import { fetchAllRows } from './lib/paginate.js'

const BATCH = 200
const ONLINE_RE = /^(?:virtual|online|zoom|webinar|livestream|google meet|(?:virtual|online) event)$/i

/** Pure selector: geo-less junk-named venues, each tagged `online`. Exported for tests. */
export function selectPlaceholderVenues(venues) {
  return (venues ?? [])
    .filter((v) => v && isJunkVenueName(v.name) && v.address == null && v.lat == null)
    .map((v) => ({ ...v, online: ONLINE_RE.test(String(v.name).trim()) }))
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const ids = (argv.find((a) => a.startsWith('--ids=')) ?? '').slice(6).split(',').map((s) => s.trim()).filter(Boolean)
  if (apply && !ids.length) {
    console.error('✗ --apply requires an explicit --ids=<id,id,…> allowlist. Nothing written.')
    process.exit(1)
  }
  await import('dotenv/config') // lazy: module stays import-safe for tests
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')

  const venues = await fetchAllRows((from, to) => supabaseAdmin.from('venues')
    .select('id, name, address, lat').is('address', null).is('lat', null).order('id').range(from, to))
  const candidates = selectPlaceholderVenues(venues)
  const links = []
  for (const part of chunk(candidates.map((v) => v.id), BATCH)) {
    links.push(...await fetchAllRows((from, to) => supabaseAdmin.from('event_venues')
      .select('event_id, venue_id').in('venue_id', part).order('event_id').order('venue_id').range(from, to)))
  }
  console.log(`🧹 Placeholder-venue sweep — ${apply ? 'APPLY' : 'dry run'}: ${candidates.length} candidate(s)`)
  for (const v of candidates) {
    const n = links.filter((l) => l.venue_id === v.id).length
    console.log(`    - "${v.name}" (${v.id}) — ${n} link(s)${v.online ? ' [online signal — excluded by default]' : ''}`)
  }
  if (!apply) { console.log('\n(dry run — pass --apply --ids=<id,…> to act on chosen candidates)'); return }

  const known = new Set(candidates.map((v) => v.id))
  const bad = ids.filter((id) => !known.has(id))
  if (bad.length) { console.error(`✗ Not a current candidate: ${bad.join(', ')}. Nothing written.`); process.exit(1) }
  const chosen = new Set(ids)
  const pairs = links.filter((l) => chosen.has(l.venue_id)).map(({ event_id, venue_id }) => ({ event_id, venue_id }))
  const eventIds = [...new Set(pairs.map((p) => p.event_id))]

  const backup = join(tmpdir(), `sweep-placeholder-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(backup, JSON.stringify(pairs, null, 2))
  console.log(`  backup: ${backup} (${pairs.length} link(s))`)

  const run = async (label, op) => { const { error } = await op; if (error) throw new Error(`${label}: ${error.message}`) }
  for (const part of chunk(eventIds, BATCH)) await run('flag needs_review', supabaseAdmin.from('events').update({ needs_review: true }).in('id', part))
  for (const part of chunk(ids, BATCH)) await run('unlist venues', supabaseAdmin.from('venues').update({ listed: false }).in('id', part))
  for (const part of chunk(ids, BATCH)) await run('delete links', supabaseAdmin.from('event_venues').delete().in('venue_id', part))
  console.log(`\n✅  Flagged ${eventIds.length} event(s), unlisted ${ids.length} venue(s), removed ${pairs.length} link(s).`)
  console.log(`   Restore: re-insert the pairs in ${backup} into event_venues and set listed=true on those venues.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1) })
}
