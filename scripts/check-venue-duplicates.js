/**
 * check-venue-duplicates.js
 *
 * Analyzes all venues in Supabase and reports potential duplicates using
 * four independent signals:
 *
 *   1. EXACT   — normalized names are identical after stripping punctuation
 *   2. FUZZY   — Jaccard token similarity ≥ 0.65 on venue name tokens
 *   3. ADDRESS — same normalized street address (non-empty)
 *   4. GEO     — lat/lng within 150 metres of each other
 *
 * Each cluster is assigned a confidence level based on how many signals
 * fired: HIGH (2+ signals or exact), MEDIUM (1 address/geo signal),
 * LOW (fuzzy name only, lower similarity).
 *
 * Also shows event counts per venue so you can easily tell which record
 * is canonical (the one events are actually attached to).
 *
 * Usage:
 *   node scripts/check-venue-duplicates.js
 *   node scripts/check-venue-duplicates.js --min-similarity 0.75
 *   node scripts/check-venue-duplicates.js --quiet   (clusters only, no hints)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

// ── ANSI colours ────────────────────────────────────────────────────────────
const R = '\x1b[0m'
const BOLD    = '\x1b[1m'
const DIM     = '\x1b[2m'
const RED     = '\x1b[31m'
const YELLOW  = '\x1b[33m'
const GREEN   = '\x1b[32m'
const CYAN    = '\x1b[36m'
const MAGENTA = '\x1b[35m'
const WHITE   = '\x1b[37m'

// ── CLI flags ───────────────────────────────────────────────────────────────
const args          = process.argv.slice(2)
const QUIET         = args.includes('--quiet')
const MIN_SIM_ARG   = args.find(a => a.startsWith('--min-similarity='))
const MIN_SIM       = MIN_SIM_ARG ? parseFloat(MIN_SIM_ARG.split('=')[1]) : 0.65
const GEO_THRESHOLD = 150  // metres — venues within this distance are flagged

// ── Normalisation helpers ───────────────────────────────────────────────────

/**
 * Normalise a venue name for comparison:
 *   - lowercase
 *   - expand common abbreviations (& → and, @ → at)
 *   - strip punctuation
 *   - collapse whitespace
 *   - remove very common filler stopwords that vary between scrapers
 */
function normaliseName(raw = '') {
  return raw
    .toLowerCase()
    .replace(/&/g,  ' and ')
    .replace(/@/g,  ' at ')
    .replace(/[^\w\s]/g, ' ')   // strip all punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalise a street address:
 *   - lowercase
 *   - expand directionals (n. → north, etc.)
 *   - expand common suffix abbreviations (st → street, ave → avenue, etc.)
 *   - strip punctuation
 *   - collapse whitespace
 */
function normaliseAddress(raw = '') {
  return raw
    .toLowerCase()
    .replace(/\bn\.?\b/g,   'north ')
    .replace(/\bs\.?\b/g,   'south ')
    .replace(/\be\.?\b/g,   'east ')
    .replace(/\bw\.?\b/g,   'west ')
    .replace(/\bst\.?\b/g,  'street ')
    .replace(/\bave\.?\b/g, 'avenue ')
    .replace(/\bblvd\.?\b/g,'boulevard ')
    .replace(/\bdr\.?\b/g,  'drive ')
    .replace(/\brd\.?\b/g,  'road ')
    .replace(/\bln\.?\b/g,  'lane ')
    .replace(/\bct\.?\b/g,  'court ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Tokenise a normalised string into a Set of words (≥ 2 chars, non-numeric).
 * Pure numbers like street numbers are excluded — they cause false positives
 * between "123 Main St" and "456 Main St".
 */
function tokenSet(normalised) {
  return new Set(
    normalised
      .split(' ')
      .filter(t => t.length >= 2 && !/^\d+$/.test(t))
  )
}

/**
 * Jaccard similarity between two token sets: |A∩B| / |A∪B|
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) { if (b.has(t)) inter++ }
  return inter / (a.size + b.size - inter)
}

/**
 * Haversine distance in metres between two lat/lng pairs.
 */
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000  // Earth radius in metres
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lon2 - lon1) * Math.PI / 180
  const a  = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ── Union-Find for clustering ───────────────────────────────────────────────
function makeUnionFind(ids) {
  const parent = {}
  for (const id of ids) parent[id] = id
  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x])
    return parent[x]
  }
  function union(x, y) {
    parent[find(x)] = find(y)
  }
  return { find, union }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${BOLD}🔍  Venue Duplicate Analyser${R}  ${DIM}(${new Date().toLocaleString()})${R}\n`)

  // 1. Fetch all venues
  const { data: venues, error: venueErr } = await supabaseAdmin
    .from('venues')
    .select('id, name, address, city, state, zip, lat, lng, website, parking_type')
    .order('name', { ascending: true })

  if (venueErr) {
    console.error(`${RED}❌  Failed to fetch venues:${R}`, venueErr.message)
    process.exit(1)
  }

  if (!venues || venues.length === 0) {
    console.log(`${DIM}  No venues found in the database.${R}`)
    process.exit(0)
  }

  // 2. Fetch event counts grouped by venue_id
  const { data: eventCounts, error: eventErr } = await supabaseAdmin
    .from('events')
    .select('venue_id')
    .not('venue_id', 'is', null)

  const countMap = {}
  if (!eventErr && eventCounts) {
    for (const row of eventCounts) {
      countMap[row.venue_id] = (countMap[row.venue_id] ?? 0) + 1
    }
  }

  console.log(`  ${CYAN}${venues.length}${R} venues loaded   ${CYAN}${Object.keys(countMap).length}${R} have events attached\n`)

  // 3. Pre-compute normalised values for every venue
  const meta = venues.map(v => ({
    ...v,
    normName:    normaliseName(v.name),
    normAddr:    normaliseAddress(v.address ?? ''),
    nameTokens:  tokenSet(normaliseName(v.name)),
    events:      countMap[v.id] ?? 0,
  }))

  // 4. Compare all pairs and collect match signals
  // matchMap[id] = [ { otherId, signals: [...], similarity } ]
  const matchEdges = []   // { a, b, signals, similarity }

  for (let i = 0; i < meta.length; i++) {
    for (let j = i + 1; j < meta.length; j++) {
      const A = meta[i]
      const B = meta[j]
      const signals = []
      let topSim = 0

      // Signal 1 — exact normalised name
      if (A.normName && B.normName && A.normName === B.normName) {
        signals.push({ type: 'EXACT', detail: `identical name "${A.normName}"` })
        topSim = Math.max(topSim, 1.0)
      }

      // Signal 2 — fuzzy name (Jaccard ≥ MIN_SIM, but not already flagged exact)
      if (!signals.find(s => s.type === 'EXACT')) {
        const sim = jaccard(A.nameTokens, B.nameTokens)
        if (sim >= MIN_SIM) {
          signals.push({ type: 'FUZZY', detail: `name similarity ${(sim * 100).toFixed(0)}%` })
          topSim = Math.max(topSim, sim)
        }
      }

      // Signal 3 — same normalised address (non-empty, skip "tbd" style values)
      const addrOk = A.normAddr.length >= 4 && B.normAddr.length >= 4
      if (addrOk && A.normAddr === B.normAddr) {
        signals.push({ type: 'ADDRESS', detail: `same address "${A.address}"` })
        topSim = Math.max(topSim, 0.9)
      }

      // Signal 4 — geo proximity
      if (A.lat && A.lng && B.lat && B.lng) {
        const dist = haversineMetres(A.lat, A.lng, B.lat, B.lng)
        if (dist <= GEO_THRESHOLD) {
          signals.push({ type: 'GEO', detail: `${Math.round(dist)}m apart` })
          topSim = Math.max(topSim, 0.8)
        }
      }

      if (signals.length > 0) {
        matchEdges.push({ a: A.id, b: B.id, signals, similarity: topSim })
      }
    }
  }

  if (matchEdges.length === 0) {
    console.log(`${GREEN}${BOLD}  ✓  No potential duplicates found.${R}\n`)
    process.exit(0)
  }

  // 5. Union-Find to cluster connected venues
  const uf = makeUnionFind(meta.map(v => v.id))
  for (const edge of matchEdges) {
    uf.union(edge.a, edge.b)
  }

  // Build clusters: root → [venue IDs]
  const clusters = {}
  for (const v of meta) {
    const root = uf.find(v.id)
    if (!clusters[root]) clusters[root] = []
    clusters[root].push(v.id)
  }

  // Only keep clusters with ≥ 2 members
  const dupClusters = Object.values(clusters).filter(c => c.length >= 2)

  // Build edge lookup: Set of "a|b" strings for quick lookup
  const edgeLookup = {}
  for (const edge of matchEdges) {
    const key = [edge.a, edge.b].sort().join('|')
    edgeLookup[key] = edge
  }

  // ── 6. Print results ────────────────────────────────────────────────────
  console.log(`${BOLD}  Found ${YELLOW}${dupClusters.length}${R}${BOLD} cluster(s) of potential duplicates${R}\n`)
  console.log('  ' + '─'.repeat(72) + '\n')

  const venueById = Object.fromEntries(meta.map(v => [v.id, v]))

  let totalFlagged = 0
  let clusterNum   = 0

  for (const cluster of dupClusters.sort((a, b) => b.length - a.length)) {
    clusterNum++
    totalFlagged += cluster.length

    // Determine overall confidence for this cluster
    const allSignals = []
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const key  = [cluster[i], cluster[j]].sort().join('|')
        const edge = edgeLookup[key]
        if (edge) allSignals.push(...edge.signals)
      }
    }

    const hasExact   = allSignals.some(s => s.type === 'EXACT')
    const signalTypes = new Set(allSignals.map(s => s.type))
    const multiSignal = signalTypes.size >= 2

    let confidence, confColor
    if (hasExact || multiSignal) {
      confidence = 'HIGH';    confColor = RED
    } else if (signalTypes.has('ADDRESS') || signalTypes.has('GEO')) {
      confidence = 'MEDIUM';  confColor = YELLOW
    } else {
      confidence = 'LOW';     confColor = DIM
    }

    // Identify suggested primary (most events, else most fields populated)
    const clusterVenues = cluster.map(id => venueById[id])
    const suggested = clusterVenues.reduce((best, v) => {
      const score = (v.events * 10) +
        (v.address ? 2 : 0) + (v.lat ? 2 : 0) +
        (v.website ? 1 : 0) + (v.parking_type && v.parking_type !== 'unknown' ? 1 : 0)
      const bestScore = (best.events * 10) +
        (best.address ? 2 : 0) + (best.lat ? 2 : 0) +
        (best.website ? 1 : 0) + (best.parking_type && best.parking_type !== 'unknown' ? 1 : 0)
      return score >= bestScore ? v : best
    })

    // ── Cluster header ──
    console.log(
      `  ${BOLD}Cluster ${clusterNum}${R}  ${confColor}${BOLD}${confidence} confidence${R}` +
      `  ${DIM}(${allSignals.length} signal${allSignals.length !== 1 ? 's' : ''})${R}`
    )

    // ── Venue rows ──
    for (const v of clusterVenues) {
      const isSuggested = v.id === suggested.id
      const prefix = isSuggested ? `${GREEN}  ★${R}` : `${DIM}  ·${R}`
      const nameStr  = isSuggested
        ? `${GREEN}${BOLD}${v.name}${R}`
        : `${WHITE}${v.name}${R}`
      const addrStr  = [v.address, v.city, v.state, v.zip].filter(Boolean).join(', ')
      const evStr    = v.events > 0
        ? `${CYAN}${v.events} event${v.events !== 1 ? 's' : ''}${R}`
        : `${DIM}0 events${R}`
      const hint     = isSuggested ? `${GREEN}${DIM} ← keep${R}` : ''

      console.log(`${prefix} ${nameStr}${hint}`)
      console.log(`       ${DIM}ID: ${v.id}${R}`)
      if (addrStr) console.log(`       ${DIM}${addrStr}${R}`)
      if (v.website) console.log(`       ${DIM}${v.website}${R}`)
      console.log(`       ${evStr}`)
    }

    // ── Signal details (skip in quiet mode) ──
    if (!QUIET) {
      console.log(`\n       ${DIM}Signals fired:${R}`)
      for (const sig of [...new Map(allSignals.map(s => [s.detail, s])).values()]) {
        const sigColor = sig.type === 'EXACT' ? RED : sig.type === 'FUZZY' ? YELLOW : CYAN
        console.log(`         ${sigColor}[${sig.type}]${R} ${DIM}${sig.detail}${R}`)
      }
    }

    console.log()
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('  ' + '─'.repeat(72))
  console.log(`\n  ${BOLD}Summary${R}`)
  console.log(`  Total venues in DB:          ${CYAN}${venues.length}${R}`)
  console.log(`  Duplicate clusters found:    ${YELLOW}${dupClusters.length}${R}`)
  console.log(`  Venues flagged:              ${YELLOW}${totalFlagged}${R}`)

  const highCount   = dupClusters.filter(c => {
    const sigs = []
    for (let i = 0; i < c.length; i++) for (let j = i+1; j < c.length; j++) {
      const key = [c[i],c[j]].sort().join('|')
      if (edgeLookup[key]) sigs.push(...edgeLookup[key].signals)
    }
    const types = new Set(sigs.map(s => s.type))
    return sigs.some(s => s.type === 'EXACT') || types.size >= 2
  }).length
  const medCount    = dupClusters.length - highCount

  console.log(`    ${RED}HIGH confidence:${R}           ${RED}${highCount}${R}`)
  console.log(`    ${YELLOW}MEDIUM/LOW confidence:${R}     ${YELLOW}${medCount}${R}`)

  if (totalFlagged > 0) {
    console.log(`\n  ${DIM}To investigate, look up venue IDs in Supabase Table Editor → venues${R}`)
    console.log(`  ${DIM}Merge by re-pointing events: UPDATE events SET venue_id = <keep_id> WHERE venue_id = <drop_id>${R}`)
    console.log(`  ${DIM}Then DELETE FROM venues WHERE id = <drop_id>${R}\n`)
  }

  process.exit(totalFlagged > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`${RED}Fatal:${R}`, err.message)
  process.exit(1)
})
