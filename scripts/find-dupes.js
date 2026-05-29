/**
 * find-dupes.js — diagnostic
 *
 * Surfaces potential cross-source duplicate events that the strict
 * `dedupe-cross-source.js` rule (same venue + exact start_at + fuzzy title)
 * doesn't catch.  Looser by design — meant to be eyeballed, not run via
 * --apply.  Use this when an event is appearing multiple times in the UI
 * and you want to see WHY the deduper isn't collapsing it.
 *
 * Clustering rule (permissive):
 *   - Normalize titles to lowercase, strip punctuation/whitespace.
 *   - Two events join a cluster when they share a normalized title AND
 *     their start_at values fall inside `--window-hours` of each other.
 *   - Venue is NOT required to match — the whole point of this tool is
 *     to surface clusters where venue naming or source-side venue
 *     normalisation differs (e.g. "Blossom Music Center" vs "Blossom").
 *
 * Usage:
 *   node scripts/find-dupes.js                          # scan everything
 *   node scripts/find-dupes.js --title hardy            # title contains "hardy"
 *   node scripts/find-dupes.js --window-hours 4         # widen the time window
 *   node scripts/find-dupes.js --min-sources 2          # only multi-source clusters
 *   node scripts/find-dupes.js --json                   # pipeable output
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

// ── CLI ────────────────────────────────────────────────────────────────────

function flag(name, fallback = null) {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return fallback
  const next = process.argv[idx + 1]
  if (!next || next.startsWith('--')) return true
  return next
}

const TITLE_PATTERN = flag('--title', null)
const WINDOW_HOURS  = parseFloat(flag('--window-hours', '2')) || 2
const MIN_SOURCES   = parseInt(flag('--min-sources', '2'),  10) || 2
const AS_JSON       = process.argv.includes('--json')

// ── Title normalisation (mirrors dedupe-cross-source.js semantics) ────────

function normalizeTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── DB ─────────────────────────────────────────────────────────────────────

async function fetchEvents() {
  const all = []
  let from = 0
  const BATCH = 1000

  for (;;) {
    let q = supabaseAdmin
      .from('events')
      .select(`
        id, title, start_at, source, source_id, category, status,
        ticket_url, image_url,
        event_venues(venue_id, venues(name))
      `)
      .eq('status', 'published')
      .order('start_at', { ascending: true })
      .range(from, from + BATCH - 1)

    if (TITLE_PATTERN) q = q.ilike('title', `%${TITLE_PATTERN}%`)

    const { data, error } = await q
    if (error) throw new Error(`Query failed: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < BATCH) break
    from += BATCH
  }

  // Collapse multi-junction rows.
  const seen = new Set()
  return all.filter(e => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
}

// ── Clustering ─────────────────────────────────────────────────────────────

function cluster(events) {
  const windowMs = WINDOW_HOURS * 3_600_000
  const byTitle = new Map()

  for (const ev of events) {
    const key = normalizeTitle(ev.title)
    if (!key) continue
    if (!byTitle.has(key)) byTitle.set(key, [])
    byTitle.get(key).push(ev)
  }

  const clusters = []

  for (const [key, list] of byTitle) {
    if (list.length < 2) continue
    // Sort by start_at, then group by overlapping time windows.
    list.sort((a, b) => new Date(a.start_at) - new Date(b.start_at))

    let current = [list[0]]
    for (let i = 1; i < list.length; i++) {
      const prev = current[current.length - 1]
      const dt = Math.abs(new Date(list[i].start_at) - new Date(prev.start_at))
      if (dt <= windowMs) {
        current.push(list[i])
      } else {
        if (current.length >= 2) clusters.push({ key, events: current })
        current = [list[i]]
      }
    }
    if (current.length >= 2) clusters.push({ key, events: current })
  }

  // Apply min-sources filter (a cluster has to span 2+ distinct sources to
  // be interesting — single-source repeats are usually correct).
  return clusters.filter(c => new Set(c.events.map(e => e.source)).size >= MIN_SOURCES)
}

// ── Reporting ──────────────────────────────────────────────────────────────

function venueName(ev) {
  const v = ev.event_venues?.[0]?.venues?.name
  return v || '(no venue)'
}

function printEventLine(ev, indent = '   ') {
  const cat = (ev.category   || '?').padEnd(10)
  const src = (ev.source     || '?').padEnd(22)
  const sid = (ev.source_id  || '?').padEnd(20).slice(0, 20)
  console.log(`${indent}${ev.start_at}  ${cat}  ${src}  ${sid}  @ ${venueName(ev)}`)
}

function reportText(clusters, allMatchedEvents) {
  // Always lead with the cluster report when we have any clusters.
  if (clusters.length) {
    console.log(`Found ${clusters.length} cluster(s) (≥${MIN_SOURCES} sources, within ±${WINDOW_HOURS}h):\n`)
    for (const c of clusters) {
      console.log(`▸ "${c.events[0].title}"  (normalized: "${c.key}")`)
      for (const ev of c.events) printEventLine(ev)
      console.log('')
    }
    const byPair = {}
    for (const c of clusters) {
      const sources = [...new Set(c.events.map(e => e.source))].sort()
      const key = sources.join(' ↔ ')
      byPair[key] = (byPair[key] || 0) + 1
    }
    console.log('Source-pair frequency (which combos slip through dedup most often):')
    for (const [pair, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n).padStart(3)}  ${pair}`)
    }
    return
  }

  // No clusters — but if the user gave a title filter and matches exist,
  // dump them so the user can eyeball what's there.  This is the diagnostic
  // payoff: "I see Hardy is duplicated" → tool shows every Hardy row.
  if (TITLE_PATTERN && allMatchedEvents.length > 0) {
    console.log(`No multi-source clusters cleared the threshold (≥${MIN_SOURCES} sources, within ±${WINDOW_HOURS}h).`)
    console.log(`Listing all ${allMatchedEvents.length} event(s) matching title "${TITLE_PATTERN}" for inspection:\n`)
    for (const ev of allMatchedEvents) {
      console.log(`▸ "${ev.title}"  (normalized: "${normalizeTitle(ev.title)}")`)
      printEventLine(ev)
      console.log('')
    }
    // Common reasons matches don't cluster — give the caller hints.
    const sources = new Set(allMatchedEvents.map(e => e.source))
    const titles  = new Set(allMatchedEvents.map(e => normalizeTitle(e.title)))
    console.log('Diagnostic hints:')
    console.log(`   distinct sources:     ${sources.size}  (${[...sources].join(', ')})`)
    console.log(`   distinct normalized titles: ${titles.size}`)
    if (sources.size < 2) {
      console.log('   → All matches are from the SAME source. That source is producing duplicates internally; check its source_id strategy.')
    } else if (titles.size > 1) {
      console.log('   → Matches come from multiple sources but with DIFFERENT normalized titles — the deduper would never cluster them.')
      console.log('     Look at the title variants above; the fix is either normalising the titles harder or adding aliases.')
    } else {
      const times = allMatchedEvents.map(e => new Date(e.start_at).getTime())
      const span  = Math.max(...times) - Math.min(...times)
      const spanH = (span / 3_600_000).toFixed(1)
      console.log(`   → Multi-source AND same normalized title, but spread over ${spanH}h — widen --window-hours to cluster them.`)
    }
    return
  }

  console.log(TITLE_PATTERN
    ? `No events matched title pattern "${TITLE_PATTERN}".`
    : 'No multi-source clusters found.')
}

function reportJson(clusters) {
  process.stdout.write(JSON.stringify(clusters.map(c => ({
    title: c.events[0].title,
    normalizedTitle: c.key,
    events: c.events.map(ev => ({
      id:        ev.id,
      title:     ev.title,
      start_at:  ev.start_at,
      source:    ev.source,
      source_id: ev.source_id,
      category:  ev.category,
      venue:     venueName(ev),
    })),
  })), null, 2) + '\n')
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  if (!AS_JSON) {
    console.log(`🔍  Searching for potential duplicates`)
    console.log(`    title filter:  ${TITLE_PATTERN ? `"${TITLE_PATTERN}"` : '(none — scanning everything)'}`)
    console.log(`    time window:   ±${WINDOW_HOURS}h`)
    console.log(`    min sources:   ${MIN_SOURCES}`)
    console.log('')
  }

  const events = await fetchEvents()
  if (!AS_JSON) console.log(`Loaded ${events.length} published event(s); clustering…\n`)

  const clusters = cluster(events)
  AS_JSON ? reportJson(clusters) : reportText(clusters, events)
}

main().catch(err => {
  console.error('find-dupes failed:', err.message)
  process.exit(1)
})
