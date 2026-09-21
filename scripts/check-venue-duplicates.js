/**
 * check-venue-duplicates.js
 *
 * READ-ONLY reporting tool. Analyses every row in `venues` and prints clusters
 * of likely duplicates. It never writes to the database, never deletes a venue
 * and never emits merge SQL — merges are planned and applied by
 * scripts/audit-venue-duplicates.js (alias-and-unlist, never delete).
 *
 * Signals come in two kinds, and the distinction is the whole point of the tool:
 *
 *   LINKING — may join two venues into a cluster
 *     1. EXACT   — identical normalised names (non-empty)
 *     2. ADDRESS — identical normalised street address (>= 4 chars), via the
 *                  project SSOT `normalizeStreetAddress` (lib/normalize.js)
 *     3. CONTAIN — one name fully contains the other on whole-word boundaries
 *                  ("The KillBox" ⊂ "The KillBox Comedy Club"), via the shared
 *                  `venueNameContains` (audit-venue-duplicates.js). Evaluated
 *                  ONLY INSIDE an address group — see below.
 *
 *   CORROBORATING — recorded only on an edge that ALREADY exists, never creates one
 *     4. FUZZY   — Jaccard token similarity >= --min-similarity on name tokens
 *     5. GEO     — lat/lng within GEO_THRESHOLD metres
 *     6. COORD   — lat/lng identical to 4 decimal places
 *
 * SSOT: both name and address comparison are now the same predicates
 * audit-venue-duplicates.js uses, so the two tools classify the same rows the
 * same way. Read that as agreement BY CONSTRUCTION — shared code over shared
 * input — and never as independent corroboration of a count: agreeing with
 * yourself is not a second opinion, and neither tool's cluster total is
 * evidence that the other's is a floor.
 *
 * CONTAIN'S SCOPE IS LOAD-BEARING. It is evaluated only for a pair that already
 * shares a normalised address — exactly the scope audit-venue-duplicates.js
 * applies `sameVenueName` in, inside one address group. Two separate reasons,
 * both measured:
 *
 *   1. It must not inherit `sameVenueName`'s looksLikeStreetAddress
 *      short-circuit, which returns TRUE whenever EITHER name looks like a
 *      street address. Safe inside an address group; as a standalone linker it
 *      equates every address-named row with every other one.
 *   2. Containment is TRANSITIVE and unguarded containment chains exactly the
 *      way unguarded GEO used to. Run globally against this database it built
 *      an 85-member cluster spanning 61 distinct addresses, bridged by rows
 *      literally named "Akron", "Ohio" and "OH": every name containing the whole
 *      word "Akron" linked to the row named "Akron", and through it to each
 *      other. That is the 145-member mega-cluster again with names in place of
 *      pins.
 *
 * Scoped to an address group both problems vanish, because the address is
 * already doing the linking: CONTAIN then decides whether that group is one
 * venue (audit's `clear`) or one building holding two businesses (audit's
 * `ambiguous`), which is the question the report was failing to answer.
 *
 * WHY: GEO used to be fed to union-find as a standalone edge. Downtown Akron is
 * dense enough that A~B~C~… chained transitively into a single 145-member
 * "cluster" spanning 99 distinct addresses, burying every real duplicate inside
 * it. Proximity is evidence ABOUT a pair that already matches by name or
 * address; it is not evidence that two rows are the same place. Same for fuzzy
 * names ("Firestone Library" vs "Firestone Park Branch Library" are different
 * buildings).
 *
 * Confidence (a name signal means EXACT or CONTAIN):
 *   HIGH   — a name signal plus a location one (ADDRESS / GEO / COORD). This is
 *            the bucket audit-venue-duplicates.js would call `clear`.
 *   MEDIUM — a name signal alone (same name, different addresses — could be a
 *            chain), or ADDRESS + FUZZY
 *   LOW    — ADDRESS alone: two businesses sharing one building, audit's
 *            `ambiguous` bucket
 *
 * Each cluster also carries `nameAgreement` — all / partial / none of its member
 * pairs joined by a name signal — which mirrors audit's clear-vs-ambiguous split
 * so a shared-address pile is no longer reported undifferentiated.
 *
 * Any cluster over `maxClusterSize` members prints as a SUSPECT CLUSTER, sorts
 * BELOW every scored cluster and is excluded from the HIGH tally: past that size
 * it is a normalisation bug, not a pile of duplicates, and letting it win the
 * size tie-break would print it as Cluster 1 and re-bury the real duplicates
 * underneath it. Venues already recorded in `venue_aliases`
 * (alias_venue_id) are excluded entirely — they were merged already, must never
 * be re-proposed, and must never be crowned "keep".
 *
 * Exit codes: 2 = the venue_aliases ledger could not be read (the report is
 * unusable; already-merged venues are all re-proposed), 1 = venues flagged,
 * 0 = clean. A runner must treat 2 as a failure, not as "no aliases".
 *
 * Usage:
 *   node scripts/check-venue-duplicates.js
 *   node scripts/check-venue-duplicates.js --min-similarity=0.80
 *   node scripts/check-venue-duplicates.js --quiet   (clusters only, no hints)
 *
 * NOTE: --min-similarity now tunes CORROBORATION only — it can lift an
 * ADDRESS-linked pair from LOW to MEDIUM, but it can no longer create a cluster.
 * `npm run check:venues:confident` (0.80, formerly `:strict`) therefore reports
 * the SAME clusters as the default run with fewer of them lifted: it is a
 * confidence knob now, not a recall knob. Kept because that is still the useful
 * question to ask of a shared-address pair, but do not read it as a tighter
 * duplicate search.
 *
 * The pure pairing/clustering (`buildVenueClusters`) is exported and tested
 * offline in scripts/tests/test-check-venue-duplicates.js; the module is
 * import-safe (guarded main, lazy supabase-admin).
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { fetchAllRows } from './lib/paginate.js'
import { normalizeStreetAddress } from './lib/normalize.js'
import { venueNameContains } from './audit-venue-duplicates.js'

// ── ANSI colours ────────────────────────────────────────────────────────────
const R = '\x1b[0m'
const BOLD    = '\x1b[1m'
const DIM     = '\x1b[2m'
const RED     = '\x1b[31m'
const YELLOW  = '\x1b[33m'
const GREEN   = '\x1b[32m'
const CYAN    = '\x1b[36m'
const WHITE   = '\x1b[37m'

// ── CLI flags ───────────────────────────────────────────────────────────────
const args          = process.argv.slice(2)
const QUIET         = args.includes('--quiet')
const MIN_SIM_ARG   = args.find(a => a.startsWith('--min-similarity='))
const MIN_SIM       = MIN_SIM_ARG ? parseFloat(MIN_SIM_ARG.split('=')[1]) : 0.65

/** Corroboration radius in metres. NOT a linking edge — see the header. */
const GEO_THRESHOLD = 150

/**
 * Above this many members a "cluster" is a bug, not a duplicate pile. Default
 * only: threaded through `opts.maxClusterSize` like minSim/geoThreshold so
 * tests can trip the wire without building a nine-member chain.
 */
const MAX_PLAUSIBLE_CLUSTER = 8

// ── Normalisation helpers ───────────────────────────────────────────────────

/**
 * Normalise a venue name for comparison:
 *   - lowercase
 *   - expand common abbreviations (& → and, @ → at)
 *   - strip punctuation
 *   - collapse whitespace
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

/** 4-decimal-place coordinate key (~11 m) — the "same pin" test. */
const coord4 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(4) : null)

const hasCoords = (v) => v.lat != null && v.lng != null

/**
 * Pre-compute the comparison fields for one venue row. Address normalisation is
 * the shared SSOT so this tool and audit-venue-duplicates.js group identically.
 */
function withNormalised(v) {
  const normName = normaliseName(v.name ?? '')
  return {
    ...v,
    normName,
    normAddr:   normalizeStreetAddress(v.address ?? '') ?? '',
    nameTokens: tokenSet(normName),
  }
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

const CONFIDENCE_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 }

/** Signal types allowed to union two venues (the rest only corroborate). */
const LINK_SIGNALS = new Set(['EXACT', 'CONTAIN', 'ADDRESS'])

/**
 * Linking signals that say "these two rows name the same venue" (as opposed to
 * merely sharing a building).
 */
const NAME_SIGNALS = ['EXACT', 'CONTAIN']

/**
 * Confidence from the set of signal types present anywhere inside a cluster.
 *   HIGH   — same venue name AND the same place (address/geo/coords back it
 *            up). Matches audit-venue-duplicates.js's `clear` bucket, which is
 *            why this bucket stopped being empty: audit has always called
 *            containment-equal names the same venue, and so does this now.
 *   MEDIUM — same name only (could be a chain), or same address + similar name
 *   LOW    — same address only: usually two businesses in one building
 */
function clusterConfidence(signalTypes) {
  const location = signalTypes.has('ADDRESS') || signalTypes.has('GEO') || signalTypes.has('COORD')
  const named = NAME_SIGNALS.some(t => signalTypes.has(t))
  if (named && location) return 'HIGH'
  if (named || (signalTypes.has('ADDRESS') && signalTypes.has('FUZZY'))) return 'MEDIUM'
  return 'LOW'
}

/**
 * PURE: pair up venue rows, cluster them, and score each cluster. No DB, no env.
 *
 * @param {Array<{id:string,name:string,address?:string|null,lat?:number|null,lng?:number|null,events?:number}>} metaRows
 * @param {{minSim?:number, geoThreshold?:number, maxClusterSize?:number,
 *          aliasIds?:Set<string>|null}} [opts]
 *        aliasIds — venues already recorded in venue_aliases; dropped before
 *        pairing so a merged row is never re-proposed or crowned canonical.
 *        maxClusterSize — members past which a cluster is flagged `suspect`.
 * @returns {{clusters:Array<object>, edges:Array<object>}} clusters sorted with
 *        suspects LAST, then by confidence (HIGH first), then size; each carries
 *        `venues`, `signals`, `signalTypes`, `confidence`, `suspect`,
 *        `nameAgreement`, `distinctAddresses`.
 */
export function buildVenueClusters(metaRows, {
  minSim = 0.65,
  geoThreshold = GEO_THRESHOLD,
  maxClusterSize = MAX_PLAUSIBLE_CLUSTER,
  aliasIds = null,
} = {}) {
  const meta = (metaRows || [])
    .filter(v => !(aliasIds && aliasIds.has(v.id)))
    .map(withNormalised)

  // ── Pairing ────────────────────────────────────────────────────────────
  const edges = []
  for (let i = 0; i < meta.length; i++) {
    for (let j = i + 1; j < meta.length; j++) {
      const A = meta[i]
      const B = meta[j]

      // LINKING signals — the only ones allowed to union two venues.
      const linking = []
      const sameAddress = A.normAddr.length >= 4 && A.normAddr === B.normAddr
      if (A.normName && A.normName === B.normName) {
        linking.push({ type: 'EXACT', detail: `identical name "${A.normName}"` })
      } else if (sameAddress && venueNameContains(A.name, B.name)) {
        // Whole-word containment — the same predicate audit-venue-duplicates.js
        // auto-merges on, applied under the same scope audit applies it in.
        linking.push({ type: 'CONTAIN', detail: `"${A.name}" / "${B.name}" — one name contains the other` })
      }
      if (sameAddress) {
        linking.push({ type: 'ADDRESS', detail: `same address "${A.normAddr}"` })
      }
      if (linking.length === 0) continue

      // CORROBORATING signals — computed only for a pair that already links.
      const corroborating = []
      const sim = jaccard(A.nameTokens, B.nameTokens)
      if (sim >= minSim) {
        corroborating.push({ type: 'FUZZY', detail: `name similarity ${(sim * 100).toFixed(0)}%` })
      }
      if (hasCoords(A) && hasCoords(B)) {
        const dist = haversineMetres(A.lat, A.lng, B.lat, B.lng)
        if (dist <= geoThreshold) {
          corroborating.push({ type: 'GEO', detail: `${Math.round(dist)}m apart` })
        }
        if (coord4(A.lat) === coord4(B.lat) && coord4(A.lng) === coord4(B.lng)) {
          corroborating.push({ type: 'COORD', detail: 'identical coordinates (4dp)' })
        }
      }

      edges.push({
        a: A.id,
        b: B.id,
        signals: [...linking, ...corroborating],
        linking: linking.map(s => s.type),
      })
    }
  }

  // ── Clustering (linking edges only) ────────────────────────────────────
  const uf = makeUnionFind(meta.map(v => v.id))
  for (const edge of edges) uf.union(edge.a, edge.b)

  const byRoot = new Map()
  for (const v of meta) {
    const root = uf.find(v.id)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push(v)
  }

  const edgeLookup = new Map()
  for (const edge of edges) edgeLookup.set([edge.a, edge.b].sort().join('|'), edge)

  const clusters = []
  for (const members of byRoot.values()) {
    if (members.length < 2) continue
    const signals = []
    // Do the member pairs agree on the NAME, or only on the address? This is
    // audit-venue-duplicates.js's clear-vs-ambiguous question, answered on the
    // same predicate, so a shared-building pile is no longer reported as an
    // undifferentiated duplicate cluster.
    let pairsTotal = 0
    let pairsNamed = 0
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairsTotal++
        const edge = edgeLookup.get([members[i].id, members[j].id].sort().join('|'))
        if (!edge) continue
        signals.push(...edge.signals)
        if (edge.linking.some(t => NAME_SIGNALS.includes(t))) pairsNamed++
      }
    }
    const signalTypes = new Set(signals.map(s => s.type))
    clusters.push({
      ids:               members.map(m => m.id),
      venues:            members,
      signals,
      signalTypes:       [...signalTypes],
      confidence:        clusterConfidence(signalTypes),
      suspect:           members.length > maxClusterSize,
      nameAgreement:     pairsNamed === 0 ? 'none' : pairsNamed === pairsTotal ? 'all' : 'partial',
      distinctAddresses: new Set(members.map(m => m.normAddr).filter(Boolean)).size,
    })
  }

  // Suspects LAST, unconditionally. A suspect is a normalisation bug report,
  // and it is usually both HIGH-signalled and the largest cluster in the run —
  // so without this comparator it wins the size tie-break, prints as Cluster 1
  // and buries every real duplicate underneath itself, which is the failure the
  // tripwire exists to surface rather than reproduce.
  clusters.sort((a, b) =>
    (Number(a.suspect) - Number(b.suspect)) ||
    (CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]) ||
    (b.venues.length - a.venues.length))

  return { clusters, edges }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')

  console.log(`\n${BOLD}🔍  Venue Duplicate Analyser${R}  ${DIM}(${new Date().toLocaleString()})${R}\n`)

  // 1. Fetch all venues (paged: the table is past PostgREST's 1000-row cap)
  let venues
  try {
    venues = await fetchAllRows((f, t) => supabaseAdmin
      .from('venues')
      .select('id, name, address, city, state, zip, lat, lng, website, parking_type')
      .order('name', { ascending: true })
      .order('id')
      .range(f, t))
  } catch (venueErr) {
    console.error(`${RED}❌  Failed to fetch venues:${R}`, venueErr.message)
    process.exit(1)
  }

  if (!venues || venues.length === 0) {
    console.log(`${DIM}  No venues found in the database.${R}`)
    process.exit(0)
  }

  // 2. Fetch the alias ledger. Venues already merged away live here; without it
  //    every past merge is re-proposed every night. Non-fatal, but LOUD.
  let aliasRows = []
  let aliasLedgerOk = true
  try {
    aliasRows = await fetchAllRows((f, t) => supabaseAdmin
      .from('venue_aliases')
      .select('alias_venue_id, canonical_venue_id, created_at')
      .order('created_at', { ascending: true })
      .order('alias_venue_id')
      .range(f, t))
  } catch (aliasErr) {
    aliasLedgerOk = false
    // stderr + a distinct exit code: on stdout this read failure is
    // indistinguishable to a runner from a healthy run that simply has no
    // aliases yet (aliasRows stays [], so `excluded` prints 0 either way).
    console.error(`${RED}${BOLD}  ⚠️  WARNING: could not read venue_aliases:${R} ${RED}${aliasErr.message}${R}`)
    console.error(`  ${YELLOW}Already-merged venues CANNOT be excluded — every past merge below is a`)
    console.error(`  false positive. Fix this before acting on this report. Exiting 2.${R}\n`)
  }

  const aliasIds = new Set(aliasRows.map(r => r.alias_venue_id))

  // 3. Fetch event counts grouped by venue_id (via the event_venues junction —
  //    events.venue_id no longer exists)
  let eventCounts = null
  try {
    eventCounts = await fetchAllRows((f, t) => supabaseAdmin
      .from('event_venues')
      .select('venue_id')
      .order('venue_id')
      .order('event_id')
      .range(f, t))
  } catch {
    // Non-fatal, exactly as before: counts just show as 0.
  }

  const countMap = {}
  if (eventCounts) {
    for (const row of eventCounts) {
      countMap[row.venue_id] = (countMap[row.venue_id] ?? 0) + 1
    }
  }

  // 4. Drop already-aliased venues, then build the comparison rows.
  const live = venues.filter(v => !aliasIds.has(v.id))
  const excluded = venues.length - live.length

  console.log(`  ${CYAN}${venues.length}${R} venues loaded   ${CYAN}${Object.keys(countMap).length}${R} have events attached`)
  console.log(aliasLedgerOk
    ? `  ${CYAN}${excluded}${R} venues excluded (already aliased)\n`
    : `  ${RED}venue_aliases unreadable — 0 venues could be excluded${R}\n`)

  const meta = live.map(v => ({ ...v, events: countMap[v.id] ?? 0 }))

  const { clusters } = buildVenueClusters(meta, {
    minSim: MIN_SIM,
    geoThreshold: GEO_THRESHOLD,
    maxClusterSize: MAX_PLAUSIBLE_CLUSTER,
    aliasIds,
  })

  const venueIds = new Set(venues.map(v => v.id))
  const aliasesStillLive = aliasRows.filter(r => venueIds.has(r.alias_venue_id)).length
  const oldestAliasDays = aliasRows.length
    ? Math.floor((Date.now() - Math.min(...aliasRows.map(r => new Date(r.created_at).getTime()))) / 86_400_000)
    : null

  const printLedger = () => {
    console.log(`\n  ${BOLD}Alias ledger${R}`)
    if (!aliasLedgerOk) {
      console.log(`  ${RED}unreadable — see the warning above${R}`)
    } else {
      console.log(`  ${CYAN}${aliasRows.length}${R} recorded, ${CYAN}${aliasesStillLive}${R} still live in venues` +
        (Number.isFinite(oldestAliasDays) ? `, oldest ${CYAN}${oldestAliasDays}${R} days` : ''))
    }
    console.log(`  ${DIM}This script never writes to the database. Merges are planned and applied by${R}`)
    console.log(`  ${DIM}scripts/audit-venue-duplicates.js — alias-and-unlist, venues are never deleted.${R}\n`)
  }

  if (clusters.length === 0) {
    console.log(`${GREEN}${BOLD}  ✓  No potential duplicates found.${R}`)
    printLedger()
    process.exit(aliasLedgerOk ? 0 : 2)
  }

  // ── 5. Print results ────────────────────────────────────────────────────
  console.log(`${BOLD}  Found ${YELLOW}${clusters.length}${R}${BOLD} cluster(s) of potential duplicates${R}\n`)
  console.log('  ' + '─'.repeat(72) + '\n')

  let totalFlagged = 0
  let clusterNum   = 0

  for (const cluster of clusters) {
    clusterNum++
    totalFlagged += cluster.venues.length

    const { confidence, suspect, signals, venues: clusterVenues } = cluster
    const confColor = confidence === 'HIGH' ? RED : confidence === 'MEDIUM' ? YELLOW : DIM

    // Identify suggested primary (most events, else most fields populated).
    // Aliased rows were filtered out above, so one can never be crowned "keep".
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
    if (suspect) {
      console.log(
        `  ${BOLD}Cluster ${clusterNum}${R}  ${RED}${BOLD}⚠ SUSPECT CLUSTER — likely a normalisation bug, not duplicates${R}`
      )
      console.log(
        `  ${YELLOW}${clusterVenues.length} members across ${cluster.distinctAddresses} distinct address(es)` +
        ` — excluded from the HIGH tally${R}`
      )
    } else {
      console.log(
        `  ${BOLD}Cluster ${clusterNum}${R}  ${confColor}${BOLD}${confidence} confidence${R}` +
        `  ${DIM}(${signals.length} signal${signals.length !== 1 ? 's' : ''})${R}`
      )
    }

    // ── Venue rows ──
    for (const v of clusterVenues) {
      const isSuggested = !suspect && v.id === suggested.id
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
      for (const sig of [...new Map(signals.map(s => [s.detail, s])).values()]) {
        const sigColor = sig.type === 'EXACT' ? RED : sig.type === 'FUZZY' ? YELLOW : CYAN
        const kind = LINK_SIGNALS.has(sig.type) ? 'link' : 'corroborates'
        console.log(`         ${sigColor}[${sig.type}]${R} ${DIM}${sig.detail} (${kind})${R}`)
      }
    }

    console.log()
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const scored      = clusters.filter(c => !c.suspect)
  const highCount   = scored.filter(c => c.confidence === 'HIGH').length
  const mediumCount = scored.filter(c => c.confidence === 'MEDIUM').length
  const lowCount    = scored.filter(c => c.confidence === 'LOW').length
  const suspectCount = clusters.length - scored.length

  console.log('  ' + '─'.repeat(72))
  console.log(`\n  ${BOLD}Summary${R}`)
  console.log(`  Total venues in DB:          ${CYAN}${venues.length}${R}`)
  console.log(aliasLedgerOk
    ? `  Excluded (already aliased):  ${CYAN}${excluded}${R}`
    : `  Excluded (already aliased):  ${RED}n/a — venue_aliases unreadable, nothing excluded${R}`)
  console.log(`  Duplicate clusters found:    ${YELLOW}${clusters.length}${R}`)
  console.log(`  Venues flagged:              ${YELLOW}${totalFlagged}${R}`)
  console.log(`    ${RED}HIGH confidence:${R}           ${RED}${highCount}${R}`)
  console.log(`    ${YELLOW}MEDIUM confidence:${R}         ${YELLOW}${mediumCount}${R}`)
  console.log(`    ${DIM}LOW confidence:${R}            ${DIM}${lowCount}${R}`)
  if (suspectCount > 0) {
    console.log(`    ${RED}⚠ SUSPECT clusters:${R}        ${RED}${suspectCount}${R} ${DIM}(not counted above, printed last)${R}`)
  }

  // The same clear-vs-ambiguous split audit-venue-duplicates.js makes, on the
  // same predicate: a shared-address pile whose names disagree is a review
  // item, not a merge, and reporting the two together overstates the pile.
  const agree  = scored.filter(c => c.nameAgreement === 'all').length
  const mixed  = scored.filter(c => c.nameAgreement === 'partial').length
  const differ = scored.filter(c => c.nameAgreement === 'none').length
  console.log(`\n  ${BOLD}Name agreement${R} ${DIM}(mirrors audit-venue-duplicates.js clear vs ambiguous)${R}`)
  console.log(`    all names agree:           ${CYAN}${agree}${R} ${DIM}(audit would auto-merge)${R}`)
  console.log(`    some agree:                ${CYAN}${mixed}${R} ${DIM}(review)${R}`)
  console.log(`    shared address only:       ${DIM}${differ} (audit flags these ambiguous)${R}`)

  printLedger()

  process.exit(!aliasLedgerOk ? 2 : totalFlagged > 0 ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`${RED}Fatal:${R}`, err.message)
    process.exit(1)
  })
}
