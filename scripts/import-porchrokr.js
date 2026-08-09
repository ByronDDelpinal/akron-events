/**
 * import-porchrokr.js
 *
 * PorchRokr 2026 festival importer — turns the checked-in brochure data file
 * (scripts/data/porchrokr-2026.json) into per-set events under the dedicated
 * `porchrokr` sub-source (subOf highland_square in src/lib/dataSources.ts; NO
 * scripts/manifest.js entry — this is not a scraper, there is nothing to
 * re-scrape; the importer itself is the reproducible "re-scrape"). Designed
 * per the 2026-08-09 PorchRokr ADR.
 *
 * What it writes (only ever with --write):
 *   • ~1 event per act per 30-minute slot, slot-keyed source_ids
 *     (`2026-p07-1300`, `2026-stage-main-1930`) so an act swap updates the
 *     title in place instead of churning source_ids into duplicates.
 *   • One unlisted venue per porch/stage via ensureVenue (listed:false),
 *     stamped in venues.manual_overrides with by:'porchrokr-2026-import' as
 *     an advisory provenance marker for sweeps and the post-festival
 *     tombstone runbook. Porches 38/39 reuse the existing listed
 *     'House Three Thirty' venue — never minted, never stamped.
 *   • Umbrella enrichment: the existing highland_square/porchrokr-2026 row
 *     gains a logistics block + hub tags, pinned via manual_overrides with
 *     FRESH `at` values (the live pin trigger reverts un-re-stamped keys on
 *     every write; a re-stamp must accompany any changed pinned column).
 *     Skipped entirely when nothing changed.
 *   • Category lock: every per-set row upserts with categories
 *     ['music','festival'] (order matters — music primary) and is then
 *     pinned via manual_overrides.categories + category_slugs
 *     (by:'porchrokr-2026-import', stampEventCategoryLock below). The
 *     umbrella's junction is verified festival-primary and pinned the same
 *     way — its own idempotent update, never piggybacked on the enrichment.
 *
 * Hard gates (never write a bad row):
 *   • classifySummitLocation(coords) must be 'in' AND the coords must pass
 *     BOTH the Summit County bbox and a tight Highland Square bbox. Any
 *     failure aborts that row loudly — never a quiet skip.
 *   • FLAG-confidence porches (unresolved location) are excluded from the
 *     write plan and reported; their acts wait for Byron's confirmation.
 *   • featured is ALWAYS false. Human-only editorial flag.
 *
 * Usage:
 *   node scripts/import-porchrokr.js                      # dry run: validate + print plan (no network/DB)
 *   node scripts/import-porchrokr.js --geocode            # geocode dry run (Nominatim, network, no file write)
 *   node scripts/import-porchrokr.js --geocode --write    # geocode HIGH rows missing coords, write back into the JSON
 *   node scripts/import-porchrokr.js --write              # write events/venues/umbrella to the DB
 *   node scripts/import-porchrokr.js --prune-missing            # report DB rows no longer in the file
 *   node scripts/import-porchrokr.js --prune-missing --write    # set those rows status='cancelled' (never delete)
 *
 * Env (only for --write / --prune-missing --write):
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { easternToIso, sanitizeEventText } from './lib/normalize.js'
// Pure gate helpers + the Nominatim client (1100ms limiter lives inside
// nominatimFetch's shared rate limiter, so every request this file makes is
// paced automatically). geocode-venues.js is import-safe: guarded main(),
// lazy supabase-admin.
import { geocodeAddress, passesAddressGate, inSummitBbox } from './geocode-venues.js'

export const SOURCE_KEY = 'porchrokr'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DATA_PATH = join(__dirname, 'data', 'porchrokr-2026.json')

const HSNA_URL = 'https://www.highlandsquareakron.org/'
const STAMP_BY = 'porchrokr-2026-import'

// Tight Highland Square box (ADR Decision 2) — every porch/stage coordinate
// must fall inside it. Deliberately much tighter than the Summit bbox: a
// geocoder answer in Barberton is wrong even though it's in-county.
export const HS_BBOX = { south: 41.08, north: 41.11, west: -81.56, east: -81.51 }

export function inHighlandSquareBbox(lat, lng) {
  return lat >= HS_BBOX.south && lat <= HS_BBOX.north &&
         lng >= HS_BBOX.west && lng <= HS_BBOX.east
}

// ── Slot math ────────────────────────────────────────────────────────────────

const ODD_SLOTS  = ['11:00 AM', '1:00 PM', '3:00 PM', '5:00 PM']
const EVEN_SLOTS = ['12:00 PM', '2:00 PM', '4:00 PM', '6:00 PM']
const SET_MINUTES = 30
const HEADLINER_MINUTES = 90

/** '1:00 PM' → '1300'; '11:00 AM' → '1100'. Null for garbage. */
export function slotKey(slot) {
  const m = String(slot ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const isPm = /^p/i.test(m[3])
  if (isPm && h !== 12) h += 12
  if (!isPm && h === 12) h = 0
  return `${String(h).padStart(2, '0')}${m[2]}`
}

export function porchSourceId(porch, slot) {
  return `2026-p${String(porch).padStart(2, '0')}-${slotKey(slot)}`
}

export function stageSourceId(stageKey, slot) {
  return `2026-stage-${stageKey}-${slotKey(slot)}`
}

/** start/end UTC instants for one set. easternToIso two-arg — NEVER a local Date. */
export function slotInstants(date, slot, minutes = SET_MINUTES) {
  const start_at = easternToIso(date, slot)
  if (!start_at) return { start_at: null, end_at: null }
  const end_at = new Date(Date.parse(start_at) + minutes * 60_000).toISOString()
  return { start_at, end_at }
}

// ── Data file validation (pure) ──────────────────────────────────────────────

// Researched artist links (act.link) — platform allowlist. The URL must be
// http(s), contain no whitespace, and contain NO '&': sanitizeEventText runs
// descriptions through htmlToText (entity decoding), and an ampersand-free
// URL is what guarantees the plan-time round-trip stays byte-identical.
export const LINK_PLATFORMS = ['spotify', 'bandcamp', 'soundcloud', 'youtube', 'facebook', 'instagram', 'website']

function actLinkProblems(where, act) {
  const problems = []
  if (act?.link == null) return problems
  const url = act.link.url
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url) || url.includes('&') || /\s/.test(url)) {
    problems.push(`${where}: act "${act.name}" link url must be http(s) with no whitespace and no '&' (got ${JSON.stringify(url)})`)
  }
  if (!LINK_PLATFORMS.includes(act.link.platform)) {
    problems.push(`${where}: act "${act.name}" link platform ${JSON.stringify(act.link.platform)} not in [${LINK_PLATFORMS.join(', ')}]`)
  }
  return problems
}

/** Returns an array of human-readable problems; empty = valid. */
export function validateDataFile(data) {
  const problems = []
  if (!data?.festival?.date || !data?.festival?.tag) problems.push('festival.date/tag missing')
  const porches = data?.porches ?? []
  const seen = new Map()
  for (const p of porches) seen.set(p.porch, (seen.get(p.porch) ?? 0) + 1)
  for (let n = 1; n <= 40; n++) {
    const count = seen.get(n) ?? 0
    if (count !== 1) problems.push(`porch ${n} appears ${count} times (expected exactly once)`)
  }
  for (const key of seen.keys()) {
    if (!(Number.isInteger(key) && key >= 1 && key <= 40)) problems.push(`unexpected porch number ${key}`)
  }
  const stageKeys = new Set((data?.stages ?? []).map((s) => s.key))
  if (stageKeys.size !== (data?.stages ?? []).length) problems.push('duplicate stage keys')
  for (const p of porches) {
    if (p.confidence !== 'HIGH' && p.confidence !== 'FLAG') {
      problems.push(`porch ${p.porch}: bad confidence ${JSON.stringify(p.confidence)}`)
    }
    if (p.confidence === 'HIGH' && !((p.houseNumber && p.street) || (p.lat != null && p.lng != null))) {
      problems.push(`porch ${p.porch}: HIGH confidence requires houseNumber + street, or reviewed coordinates`)
    }
    if (p.routesTo && !stageKeys.has(p.routesTo)) {
      problems.push(`porch ${p.porch}: routesTo '${p.routesTo}' is not a known stage`)
    }
    if ((p.porch === 38 || p.porch === 39) && p.venueOverride !== 'House Three Thirty') {
      problems.push(`porch ${p.porch}: expected venueOverride 'House Three Thirty'`)
    }
    if (p.lat != null && p.lng != null) {
      if (!inSummitBbox(p.lng, p.lat)) problems.push(`porch ${p.porch}: coords outside Summit bbox`)
      if (!inHighlandSquareBbox(p.lat, p.lng)) problems.push(`porch ${p.porch}: coords outside Highland Square bbox`)
    } else if ((p.lat == null) !== (p.lng == null)) {
      problems.push(`porch ${p.porch}: half a coordinate pair`)
    }
    const wantSlots = p.porch % 2 === 1 ? ODD_SLOTS : EVEN_SLOTS
    for (const act of p.acts ?? []) {
      if (!act?.name || !act?.slot) { problems.push(`porch ${p.porch}: act missing name/slot`); continue }
      if (!wantSlots.includes(act.slot)) {
        problems.push(`porch ${p.porch} (${p.porch % 2 === 1 ? 'odd' : 'even'}): unexpected slot '${act.slot}' for "${act.name}"`)
      }
      problems.push(...actLinkProblems(`porch ${p.porch}`, act))
    }
  }
  for (const s of data?.stages ?? []) {
    for (const act of s.acts ?? []) problems.push(...actLinkProblems(`stage ${s.key}`, act))
  }
  if (porches.length && porches.find((p) => p.porch === 26)?.routesTo !== 'beer-garden') {
    problems.push("porch 26 must route to 'beer-garden' (it IS the Beer Garden & Stage)")
  }
  return problems
}

// ── Plan builder (pure) ──────────────────────────────────────────────────────

function porchVenueName(p) {
  // street null = printed street text unconfirmed (coords are map-derived and
  // authoritative) — no dangling house number in the venue name.
  return p.street
    ? `PorchRokr Porch ${p.porch} - ${p.houseNumber} ${p.street}`
    : `PorchRokr Porch ${p.porch}`
}

function stageVenueName(stage) {
  return `PorchRokr ${stage.name} (Highland Square)`
}

function porchSetRow(festival, p, act) {
  const room = p.venueOverride ? p.room : null
  const title = p.venueOverride
    ? `${act.name} - PorchRokr (House Three Thirty ${room})`
    : `${act.name} - PorchRokr Porch ${p.porch}`
  const where = p.venueOverride
    ? `Porch at ${p.houseNumber} ${p.street} (House Three Thirty ${room}).`
    : p.street
      ? `Porch at ${p.houseNumber} ${p.street}.`
      : `See the festival map on the PorchRokr page for this porch's exact spot.`
  const { start_at, end_at } = slotInstants(festival.date, act.slot)
  // Researched artist link — always the FINAL sentence, no trailing period
  // (a period would glue itself onto the URL). Unlinked acts append nothing,
  // so their descriptions stay byte-identical to the pre-link output.
  const listen = act.link ? ` Listen: ${act.link.url}` : ''
  return {
    title,
    description: `Genre: ${act.genre}. 30-minute porch set for PorchRokr 2026, the Highland Square porch music and arts festival. ${where} Free and open to all.${listen}`,
    start_at,
    end_at,
    // Explicit v2 list — resolveEventCategories passes it verbatim and
    // syncEventCategories inserts in order, so 'music' stays primary.
    categories:      ['music', 'festival'],
    tags:            [festival.tag, `porch-${p.porch}`, 'highland-square', 'free', 'outdoor'],
    price_min:       0,
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       null,
    ticket_url:      festival.website ?? HSNA_URL,
    source:          SOURCE_KEY,
    source_id:       porchSourceId(p.porch, act.slot),
    status:          'published',
    featured:        false, // ALWAYS false — human-only editorial flag
  }
}

function stageSetRow(festival, stage, act) {
  const headliner = act.headliner === true
  const minutes = headliner ? HEADLINER_MINUTES : SET_MINUTES
  const { start_at, end_at } = slotInstants(festival.date, act.slot, minutes)
  const title = headliner
    ? `${act.name} - PorchRokr Main Stage (Headliner)`
    : `${act.name} - PorchRokr ${stage.name}`
  // Same convention as porchSetRow: link is the final sentence, no trailing
  // period, and absent links change nothing.
  const listen = act.link ? ` Listen: ${act.link.url}` : ''
  const description = headliner
    ? `Genre: ${act.genre}. Headline set closing PorchRokr 2026, the Highland Square porch music and arts festival, on the Main Stage. Free and open to all.${listen}`
    : `Genre: ${act.genre}. 30-minute set on the ${stage.name} for PorchRokr 2026, the Highland Square porch music and arts festival. Free and open to all.${listen}`
  const row = {
    title,
    description,
    start_at,
    end_at,
    // Explicit v2 list — resolveEventCategories passes it verbatim and
    // syncEventCategories inserts in order, so 'music' stays primary.
    categories:      ['music', 'festival'],
    tags:            [festival.tag, `stage-${stage.key}`, 'highland-square', 'free', 'outdoor'],
    price_min:       0,
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       null,
    ticket_url:      festival.website ?? HSNA_URL,
    source:          SOURCE_KEY,
    source_id:       stageSourceId(stage.key, act.slot),
    status:          'published',
    featured:        false, // ALWAYS false — human-only editorial flag
  }
  if (stage.isFamily) row.is_family = true
  return row
}

/**
 * Build the full write plan from the data file. Pure — no DB, no clock.
 * Returns:
 *   planned  — [{ row, venue }] where venue describes how the write path
 *              resolves it: {kind:'override', name} | {kind:'mint', name,
 *              address?, lat, lng, description, isFamily?}
 *   excluded — FLAG porches (unresolved location), acts + would-be
 *              source_ids reported so nothing disappears silently
 *   problems — validateDataFile output (callers must refuse to write on any)
 */
export function buildPlan(data) {
  const problems = validateDataFile(data)
  const festival = data.festival
  const planned = []
  const excluded = []

  // Acts routed off a porch onto a stage (porch 26 → beer-garden).
  const routedActs = new Map()

  for (const p of data.porches) {
    if (p.routesTo) {
      routedActs.set(p.routesTo, [...(routedActs.get(p.routesTo) ?? []), ...p.acts])
      continue
    }
    if (p.confidence === 'FLAG') {
      excluded.push({
        porch: p.porch,
        reason: `FLAG — location unresolved (${p.notes ?? 'needs confirmation'})`,
        acts: p.acts.map((a) => ({ ...a, source_id: porchSourceId(p.porch, a.slot) })),
      })
      continue
    }
    const venue = p.venueOverride
      ? { kind: 'override', name: p.venueOverride }
      : {
          kind: 'mint',
          name: porchVenueName(p),
          address: p.street ? `${p.houseNumber} ${p.street}` : undefined,
          lat: p.lat,
          lng: p.lng,
          description: 'Residential porch stage for PorchRokr 2026. Not a public venue.',
        }
    for (const act of p.acts) planned.push({ row: porchSetRow(festival, p, act), venue })
  }

  for (const stage of data.stages ?? []) {
    const acts = [...(stage.acts ?? []), ...(routedActs.get(stage.key) ?? [])]
    if (!acts.length) continue
    const venue = {
      kind: 'mint',
      name: stageVenueName(stage),
      lat: stage.lat,
      lng: stage.lng,
      description: 'Festival stage for PorchRokr 2026 in Highland Square. Not a permanent venue.',
      isFamily: stage.isFamily === true,
    }
    for (const act of acts) planned.push({ row: stageSetRow(festival, stage, act), venue })
  }

  planned.sort((a, b) =>
    a.row.start_at === b.row.start_at
      ? a.row.source_id.localeCompare(b.row.source_id)
      : a.row.start_at.localeCompare(b.row.start_at))

  const ids = new Set()
  for (const { row } of planned) {
    if (ids.has(row.source_id)) problems.push(`duplicate source_id in plan: ${row.source_id}`)
    ids.add(row.source_id)
  }
  for (const ex of excluded) {
    for (const a of ex.acts) {
      if (ids.has(a.source_id)) problems.push(`excluded source_id collides with plan: ${a.source_id}`)
    }
  }

  return { planned, excluded, problems }
}

/** Every source_id derivable from the file — planned AND FLAG-excluded. Used
 *  by --prune-missing so a porch flipping HIGH→FLAG never cancels its rows
 *  (that's a human call); pruning only touches rows the file no longer
 *  accounts for at all (act dropped, rain cancellation edit, …). */
export function allFileSourceIds(plan) {
  const ids = new Set(plan.planned.map(({ row }) => row.source_id))
  for (const ex of plan.excluded) for (const a of ex.acts) ids.add(a.source_id)
  return ids
}

// ── Umbrella enrichment (pure) ───────────────────────────────────────────────

// Idempotency marker: everything from this line onward in the umbrella's
// description belongs to the importer and is replaced wholesale on re-run,
// so re-imports never stack logistics blocks.
export const LOGISTICS_MARKER = 'PorchRokr 2026 festival guide:'
export const UMBRELLA_TAGS = ['porchrokr-2026', 'festival-umbrella']

/**
 * Compute the umbrella update. Returns null when nothing would change (the
 * importer then skips the write entirely — no pointless trigger churn), else
 * { updates: {description?, tags?}, overrides } where overrides is the FULL
 * manual_overrides object to write: existing pins preserved, and a fresh
 * {at, by} re-stamp for exactly the keys being changed (the live pin trigger
 * reverts any pinned key not re-stamped alongside its new value).
 */
export function computeUmbrellaEnrichment(existing, festival, nowIso = new Date().toISOString()) {
  const scraperProse = String(existing.description ?? '')
    .split(LOGISTICS_MARKER)[0]
    .trimEnd()
  const description = `${scraperProse}${scraperProse ? '\n\n' : ''}${LOGISTICS_MARKER}\n${festival.logistics}`

  const tags = [...(existing.tags ?? [])]
  for (const t of UMBRELLA_TAGS) if (!tags.includes(t)) tags.push(t)

  const updates = {}
  if (description !== existing.description) updates.description = description
  if (tags.length !== (existing.tags ?? []).length) updates.tags = tags
  if (!Object.keys(updates).length) return null

  const overrides = { ...(existing.manual_overrides ?? {}) }
  for (const key of Object.keys(updates)) overrides[key] = { at: nowIso, by: STAMP_BY }
  return { updates, overrides }
}

// ── Category lock (pure) ─────────────────────────────────────────────────────

/**
 * Compute the manual_overrides object that pins categories + category_slugs
 * on a PorchRokr event, or null when this importer already stamped it
 * (categories?.by === STAMP_BY). Pure — exported for tests.
 *
 * Merge-not-clobber: every foreign key in the existing overrides survives
 * untouched; only the two category keys are (re)stamped.
 *
 * FUTURE EDITS: the live pin trigger reverts any pinned key whose value
 * changes without a re-stamp, so an intentional category change later must
 * write the new junction/columns AND re-stamp BOTH pinned keys with a fresh
 * `at` (a DIFFERENT value than the stored stamp) in the same statement.
 */
export function computeCategoryLockOverrides(existing, nowIso = new Date().toISOString()) {
  const overrides = { ...(existing ?? {}) }
  if (overrides.categories?.by === STAMP_BY) return null
  const stamp = { at: nowIso, by: STAMP_BY }
  overrides.categories = stamp
  overrides.category_slugs = stamp
  return overrides
}

// ── Reporting ────────────────────────────────────────────────────────────────

function venueKindLabel(venue) {
  if (venue.kind === 'override') return `existing venue "${venue.name}"`
  if (venue.lat != null && venue.lng != null) return 'mint (geocoded)'
  return 'mint (PENDING GEOCODE — will hard-abort at --write until coords land)'
}

function printPlan(data, plan) {
  const { planned, excluded } = plan
  const byReadiness = { override: 0, geocoded: 0, pending: 0 }
  for (const { venue } of planned) {
    if (venue.kind === 'override') byReadiness.override++
    else if (venue.lat != null && venue.lng != null) byReadiness.geocoded++
    else byReadiness.pending++
  }
  const excludedActs = excluded.reduce((n, ex) => n + ex.acts.length, 0)

  console.log(`\n📋  PorchRokr 2026 import plan — ${data.festival.date} (${data.festival.tag})`)
  console.log(`    planned events:  ${planned.length}`)
  console.log(`      via existing venue (House Three Thirty): ${byReadiness.override}`)
  console.log(`      via minted venue, coords present:        ${byReadiness.geocoded}`)
  console.log(`      via minted venue, coords pending:        ${byReadiness.pending}`)
  console.log(`    excluded (FLAG porches): ${excludedActs} sets on ${excluded.length} porches`)
  console.log(`    categories: every row ['music','festival'] (music primary); pinned post-upsert via manual_overrides.categories/category_slugs (by '${STAMP_BY}')\n`)

  const venues = new Map()
  for (const { venue } of planned) {
    if (!venues.has(venue.name)) venues.set(venue.name, { venue, count: 0 })
    venues.get(venue.name).count++
  }
  console.log(`    venue plan (${venues.size} venues):`)
  for (const { venue, count } of venues.values()) {
    console.log(`      • ${venue.name} — ${count} set(s) — ${venueKindLabel(venue)}`)
  }

  console.log('\n    events:')
  for (const { row } of planned) {
    console.log(`      ${row.source_id}  ${row.start_at} → ${row.end_at}  ${row.title}`)
  }

  if (excluded.length) {
    console.log('\n    ⚠ excluded — FLAG porches awaiting Byron (NOT written, NOT pruned):')
    for (const ex of excluded) {
      console.log(`      porch ${ex.porch}: ${ex.reason}`)
      for (const a of ex.acts) console.log(`        - ${a.source_id}  ${a.slot}  ${a.name}`)
    }
  }
}

function printUmbrellaPlan(data) {
  console.log('\n    umbrella enrichment (highland_square/porchrokr-2026):')
  console.log(`      tags += ${JSON.stringify(UMBRELLA_TAGS)}`)
  console.log(`      description += logistics block (idempotent via marker "${LOGISTICS_MARKER}"):`)
  for (const line of data.festival.logistics.split('\n')) console.log(`        ${line}`)
  console.log(`      pins: manual_overrides.description/tags re-stamped {at: <now>, by: '${STAMP_BY}'}`)
  console.log('      (live diff + unchanged-skip decided against the DB row at --write)')
  console.log('      category lock: verify junction is festival-primary, then pin categories+category_slugs (own idempotent update)')
}

// ── Geocode mode (network; JSON write-back only with --write) ────────────────

async function runGeocode(data, write) {
  const candidates = data.porches.filter(
    (p) => p.confidence === 'HIGH' && !p.venueOverride && p.lat == null && p.street && p.houseNumber
  )
  console.log(`\n📍  --geocode ${write ? '(writing back into the JSON)' : '(dry run — pass --write to update the JSON)'}`)
  console.log(`    ${candidates.length} HIGH-confidence porch(es) missing coords (FLAG rows skipped by design)\n`)

  let accepted = 0
  const rejected = []
  for (const p of candidates) {
    const venueLike = { address: `${p.houseNumber} ${p.street}`, city: 'Akron', state: 'OH', zip: '44303' }
    const result = await geocodeAddress(venueLike)
    const gotHouse = result?.address?.house_number ?? null
    const lat = result ? parseFloat(result.lat) : NaN
    const lng = result ? parseFloat(result.lon) : NaN

    let why = null
    if (!result) why = 'no result'
    else if (String(gotHouse) !== String(p.houseNumber)) why = `house number mismatch (want ${p.houseNumber}, got ${gotHouse ?? 'none'})`
    else if (!passesAddressGate(venueLike, result)) why = 'failed address-precision/zip/sanity gate'
    else if (!inSummitBbox(lng, lat)) why = 'outside Summit bbox'
    else if (!inHighlandSquareBbox(lat, lng)) why = 'outside Highland Square bbox'

    if (why) {
      console.log(`  ✖ porch ${p.porch} "${venueLike.address}" — ${why}`)
      rejected.push({ porch: p.porch, why })
      continue
    }

    p.lat = lat
    p.lng = lng
    p.geocode = {
      display_name: result.display_name ?? null,
      osm_id: result.osm_id ?? null,
      at: new Date().toISOString(),
    }
    accepted++
    console.log(`  ✓ porch ${p.porch} "${venueLike.address}" → ${lat.toFixed(6)}, ${lng.toFixed(6)}`)
  }

  if (write && accepted) {
    writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n')
    console.log(`\n  💾 wrote ${accepted} coordinate pair(s) back into ${DATA_PATH}`)
    console.log('     Eyeball them (git diff scripts/data/porchrokr-2026.json) before running --write.')
  } else if (accepted) {
    console.log(`\n  (dry run) would write ${accepted} coordinate pair(s) into the JSON`)
  }
  if (rejected.length) console.log(`  ${rejected.length} porch(es) left for manual review — never guessed.`)
}

// ── Write path (DB; lazy-loaded so dry runs need no env) ────────────────────

async function resolveHouseThreeThirty(supabaseAdmin) {
  const { data: rows, error } = await supabaseAdmin
    .from('venues')
    .select('id')
    .eq('name', 'House Three Thirty')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) throw new Error(`House Three Thirty lookup failed: ${error.message}`)
  return rows?.[0]?.id ?? null
}

/** Advisory provenance stamp on a venue WE minted. Never touches a venue
 *  whose name isn't the exact PorchRokr name we asked for (ensureVenue may
 *  legitimately resolve our address onto a pre-existing real venue — e.g.
 *  867 W Market St is Mustard Seed's building — and stamping/unlisting a
 *  real venue would be vandalism). Idempotent: skips when already stamped. */
async function stampMintedVenue(supabaseAdmin, venueId, expectedName) {
  const { data: v, error } = await supabaseAdmin
    .from('venues')
    .select('id, name, listed, manual_overrides')
    .eq('id', venueId)
    .maybeSingle()
  if (error || !v) { console.warn(`  ⚠ venue stamp lookup failed for ${venueId}`); return }
  if (v.name !== expectedName) {
    console.log(`  ⤷ resolved onto pre-existing venue "${v.name}" — leaving it unstamped and listed as-is`)
    return
  }
  const existing = v.manual_overrides ?? {}
  if (existing.listed?.by === STAMP_BY) return
  const at = new Date().toISOString()
  const stamp = { at, by: STAMP_BY }
  const manual_overrides = { ...existing, lat: stamp, lng: stamp, listed: stamp, name: stamp }
  const { error: upErr } = await supabaseAdmin
    .from('venues')
    .update({ manual_overrides })
    .eq('id', venueId)
  if (upErr) console.warn(`  ⚠ venue stamp failed for "${expectedName}": ${upErr.message}`)
}

/** Idempotent category-lock stamp, mirroring stampMintedVenue: read the
 *  event's manual_overrides, skip when already stamped by us, else pin
 *  categories + category_slugs (computeCategoryLockOverrides). NEVER touches
 *  the category columns/junction themselves — it runs AFTER upsertEventSafe
 *  returns, when the junction rows and the trigger-computed category_slugs
 *  are already final, and the update writes manual_overrides ONLY. Locks
 *  nothing else: no status key, no featured key — featured is human-only. */
async function stampEventCategoryLock(supabaseAdmin, eventId) {
  const { data: ev, error } = await supabaseAdmin
    .from('events')
    .select('id, manual_overrides')
    .eq('id', eventId)
    .maybeSingle()
  if (error || !ev) { console.warn(`  ⚠ category-lock lookup failed for ${eventId}`); return }
  const manual_overrides = computeCategoryLockOverrides(ev.manual_overrides)
  if (!manual_overrides) return // already stamped by this importer
  const { error: upErr } = await supabaseAdmin
    .from('events')
    .update({ manual_overrides })
    .eq('id', eventId)
  if (upErr) console.warn(`  ⚠ category-lock stamp failed for ${eventId}: ${upErr.message}`)
}

async function runWrite(data, plan) {
  // Lazy imports: dry runs must work with no env at all.
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const {
    ensureVenue, ensureOrganization, linkOrganizationVenue,
    upsertEventSafe, setEventVenue, linkEventOrganization,
  } = await import('./lib/normalize.js')
  const { preloadSummitCountyBoundary, classifySummitLocation } = await import('./lib/summit-county.js')
  await preloadSummitCountyBoundary()

  console.log('\n✍️  WRITE mode — upserting events/venues + umbrella enrichment…')

  const organizerId = await ensureOrganization('Highland Square Neighborhood Association', {
    website: 'https://www.highlandsquareakron.org',
    description: 'The Highland Square Neighborhood Association (HSNA) is a 501(c)(3) that celebrates the art, history, and character of Akron\'s Highland Square neighborhood — best known for PorchROKR, its annual outdoor porch-music and arts festival, plus the Highland Square Film Festival and community workshops.',
  })

  // ── Umbrella enrichment (direct update, NOT upsertEventSafe) ──────────────
  const { source, source_id } = data.festival.umbrella
  const { data: umbrella, error: umbErr } = await supabaseAdmin
    .from('events')
    .select('id, description, tags, manual_overrides')
    .eq('source', source)
    .eq('source_id', source_id)
    .maybeSingle()
  if (umbErr || !umbrella) {
    console.warn(`  ⚠ umbrella ${source}/${source_id} not found — run scrape:highland-square first; skipping enrichment`)
  } else {
    const enrichment = computeUmbrellaEnrichment(umbrella, data.festival)
    if (!enrichment) {
      console.log('  ⤷ umbrella already enriched — no write')
    } else {
      const { error } = await supabaseAdmin
        .from('events')
        .update({ ...enrichment.updates, manual_overrides: enrichment.overrides })
        .eq('id', umbrella.id)
      if (error) console.warn(`  ⚠ umbrella enrichment failed: ${error.message}`)
      else console.log(`  ✓ umbrella enriched + pinned (${Object.keys(enrichment.updates).join(', ')})`)
    }

    // Umbrella category lock — its OWN idempotent update, deliberately NOT
    // piggybacked on computeUmbrellaEnrichment (which skips entirely when
    // nothing changed, and this pin must land regardless). The scraper
    // already makes the umbrella festival-primary; verify before pinning so
    // the lock can never freeze a wrong junction. stampEventCategoryLock
    // re-reads manual_overrides, so the enrichment pins above are preserved.
    const { data: umbCats, error: umbCatErr } = await supabaseAdmin
      .from('event_categories')
      .select('category')
      .eq('event_id', umbrella.id)
    const umbList = (umbCats ?? []).map((c) => c.category)
    if (umbCatErr) {
      console.warn(`  ⚠ umbrella junction lookup failed: ${umbCatErr.message} (category lock skipped)`)
    } else if (umbList[0] === 'festival') {
      await stampEventCategoryLock(supabaseAdmin, umbrella.id)
      console.log('  ✓ umbrella junction verified festival-primary; categories pinned')
    } else {
      console.warn(`  ⚠ umbrella junction is NOT festival-primary (${JSON.stringify(umbList)}) - NOT pinning; fix scrape:highland-square first`)
    }
  }

  // ── Venues ────────────────────────────────────────────────────────────────
  const venueIds = new Map() // venue.name → id | null
  const abortedVenues = new Set()
  const uniqueVenues = new Map()
  for (const { venue } of plan.planned) if (!uniqueVenues.has(venue.name)) uniqueVenues.set(venue.name, venue)

  for (const venue of uniqueVenues.values()) {
    if (venue.kind === 'override') {
      const id = await resolveHouseThreeThirty(supabaseAdmin)
      if (!id) {
        console.error(`  🚨 ABORT rows for "${venue.name}": existing venue not found — never mint a duplicate of a real venue`)
        abortedVenues.add(venue.name)
      }
      venueIds.set(venue.name, id)
      continue
    }
    // HARD Summit + Highland Square gate — missing coords is a loud abort,
    // not a quiet skip (ADR Decision 2).
    if (venue.lat == null || venue.lng == null) {
      console.error(`  🚨 ABORT rows for "${venue.name}": no coordinates yet — run --geocode (or resolve FLAG) first`)
      abortedVenues.add(venue.name)
      continue
    }
    if (classifySummitLocation({ lat: venue.lat, lng: venue.lng }) !== 'in' ||
        !inSummitBbox(venue.lng, venue.lat) ||
        !inHighlandSquareBbox(venue.lat, venue.lng)) {
      console.error(`  🚨 ABORT rows for "${venue.name}": coords (${venue.lat}, ${venue.lng}) failed the Summit/Highland Square gate`)
      abortedVenues.add(venue.name)
      continue
    }
    const id = await ensureVenue(venue.name, {
      address: venue.address,
      city: 'Akron', state: 'OH', zip: '44303',
      lat: venue.lat, lng: venue.lng,
      website: HSNA_URL,
      description: venue.description,
    }, { listed: false })
    if (!id) {
      console.error(`  🚨 ABORT rows for "${venue.name}": ensureVenue refused`)
      abortedVenues.add(venue.name)
      continue
    }
    await stampMintedVenue(supabaseAdmin, id, venue.name)
    if (organizerId) await linkOrganizationVenue(organizerId, id)
    venueIds.set(venue.name, id)
  }

  // ── Events ────────────────────────────────────────────────────────────────
  let upserted = 0, skipped = 0, aborted = 0
  for (const { row, venue } of plan.planned) {
    if (abortedVenues.has(venue.name)) { aborted++; continue }
    const venueId = venueIds.get(venue.name)
    const { data: ev, error } = await upsertEventSafe(row)
    if (error) { console.warn(`  ⚠ upsert failed "${row.title}": ${error.message}`); skipped++; continue }
    // AFTER upsertEventSafe returns: junction rows + trigger-computed
    // category_slugs are final, so the pin freezes the intended state. The
    // 32 pre-lock live rows converge on the same re-run — they're unstamped,
    // so syncEventCategories rewrites their junction first, then this lands.
    await stampEventCategoryLock(supabaseAdmin, ev.id)
    if (venueId) await setEventVenue(ev.id, venueId)
    if (organizerId) await linkEventOrganization(ev.id, organizerId)
    upserted++
  }
  console.log(`\n  ✅ ${upserted} upserted, ${skipped} skipped, ${aborted} aborted (venue gate)`)
}

// ── Prune (status='cancelled', NEVER delete; scoped to source='porchrokr') ──

async function runPrune(plan, write) {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const keep = allFileSourceIds(plan)
  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('id, title, source_id, status')
    .eq('source', SOURCE_KEY)
    .limit(1000)
  if (error) throw new Error(`prune lookup failed: ${error.message}`)

  const missing = (rows ?? []).filter((r) => !keep.has(r.source_id) && r.status !== 'cancelled')
  console.log(`\n🧹  --prune-missing ${write ? '(WRITE)' : '(dry run)'} — ${rows?.length ?? 0} DB row(s), ${missing.length} not in the file`)
  for (const r of missing) console.log(`    - ${r.source_id}  [${r.status}]  ${r.title}`)
  if (!write || !missing.length) return
  const { error: upErr } = await supabaseAdmin
    .from('events')
    .update({ status: 'cancelled' })
    .in('id', missing.map((r) => r.id))
  if (upErr) throw new Error(`prune update failed: ${upErr.message}`)
  console.log(`    ✓ ${missing.length} row(s) set status='cancelled' (never deleted)`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const WRITE = args.includes('--write')
  const GEOCODE = args.includes('--geocode')
  const PRUNE = args.includes('--prune-missing')

  const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
  const plan = buildPlan(data)

  if (plan.problems.length) {
    console.error('✖ data file failed validation:')
    for (const p of plan.problems) console.error(`   - ${p}`)
    process.exit(1)
  }

  // Round-trip guard: every planned title/description must survive
  // sanitizeEventText unchanged (apostrophes, ampersands, "[Redacted]" —
  // if the sanitizer would rewrite it, we want to know at plan time).
  for (const { row } of plan.planned) {
    const clean = sanitizeEventText(row)
    if (clean.title !== row.title) {
      console.warn(`  ⚠ sanitizer would rewrite title: ${JSON.stringify(row.title)} → ${JSON.stringify(clean.title)}`)
    }
    if (clean.description !== row.description) {
      console.warn(`  ⚠ sanitizer would rewrite description for ${row.source_id}: ${JSON.stringify(row.description)} → ${JSON.stringify(clean.description)}`)
    }
  }

  if (GEOCODE) {
    await runGeocode(data, WRITE)
    return // geocode mode never touches the DB — Byron eyeballs, THEN --write
  }

  printPlan(data, plan)
  printUmbrellaPlan(data)

  if (PRUNE) {
    await runPrune(plan, WRITE)
    return
  }

  if (!WRITE) {
    console.log('\n(dry run — nothing written. Pass --write to upsert, --geocode to fill coords.)')
    return
  }

  await runWrite(data, plan)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`✖ import-porchrokr failed: ${err.message}`)
    process.exit(1)
  })
}
