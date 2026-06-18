/**
 * geocode-venues.js
 *
 * Backfills lat/lng for venues that are missing coordinates, using the Mapbox
 * geocoding API. Runs anywhere with network + the repo .env (locally or CI) —
 * NOT inside the Cowork sandbox, which has no outbound internet.
 *
 * Quality gates (never write a bad coordinate):
 *   - Mapbox relevance >= MIN_RELEVANCE
 *   - result falls inside the NE-Ohio sanity box
 * Anything failing a gate is listed for manual review, not written.
 *
 * Env:
 *   VITE_MAPBOX_TOKEN          — Mapbox token (same one the map uses)
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — service role (bypasses RLS to update venues)
 *
 * Flags:
 *   --dry-run     geocode + report, but write nothing
 *   --limit N     only process the first N missing-coordinate venues
 *   --recheck     also re-geocode venues that already have coordinates
 *
 * Usage:  node scripts/geocode-venues.js [--dry-run] [--limit 50]
 */
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

const MAPBOX_TOKEN = process.env.VITE_MAPBOX_TOKEN

// Confidence + sanity gates.
const MIN_RELEVANCE = 0.8
// NE-Ohio / Greater Akron bounding box: [west, south, east, north].
const SANITY_BBOX = { west: -82.3, south: 40.6, east: -80.7, north: 41.7 }
// Bias geocodes toward Akron and keep under Mapbox's rate limit.
const PROXIMITY = '-81.519,41.081'
const RATE_LIMIT_MS = 150

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const RECHECK = args.includes('--recheck')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1], 10) : null
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fullAddress(v) {
  return [v.address, v.city, v.state, v.zip].filter(Boolean).join(', ')
}

function inSanityBox(lng, lat) {
  return lng >= SANITY_BBOX.west && lng <= SANITY_BBOX.east &&
         lat >= SANITY_BBOX.south && lat <= SANITY_BBOX.north
}

/** Geocode one address; returns { lat, lng, relevance } or null. */
async function geocode(address) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json` +
    `?access_token=${MAPBOX_TOKEN}&limit=1&country=US&types=address&proximity=${PROXIMITY}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Mapbox ${res.status}`)
  const json = await res.json()
  const feature = json.features && json.features[0]
  if (!feature || !Array.isArray(feature.center)) return null
  const [lng, lat] = feature.center
  return { lat, lng, relevance: feature.relevance ?? 0 }
}

async function main() {
  if (!MAPBOX_TOKEN) throw new Error('Missing VITE_MAPBOX_TOKEN in .env')

  let query = supabaseAdmin
    .from('venues')
    .select('id, name, address, city, state, zip, lat, lng')
    .not('address', 'is', null)
    .order('name', { ascending: true })
  if (!RECHECK) query = query.or('lat.is.null,lng.is.null')
  if (LIMIT) query = query.limit(LIMIT)

  const { data: venues, error } = await query
  if (error) throw new Error(`loading venues: ${error.message}`)

  console.log(`📍  ${venues.length} venue(s) to geocode${DRY_RUN ? ' (dry run)' : ''}…\n`)

  let updated = 0
  const skipped = []
  const failed = []

  for (const v of venues) {
    const address = fullAddress(v)
    if (!address) { skipped.push({ v, why: 'no address' }); continue }

    try {
      const hit = await geocode(address)
      await sleep(RATE_LIMIT_MS)

      if (!hit) { failed.push({ v, why: 'no result' }); continue }
      if (hit.relevance < MIN_RELEVANCE) {
        skipped.push({ v, why: `low confidence ${hit.relevance.toFixed(2)}` }); continue
      }
      if (!inSanityBox(hit.lng, hit.lat)) {
        skipped.push({ v, why: `out of area (${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)})` }); continue
      }

      if (!DRY_RUN) {
        const { error: upErr } = await supabaseAdmin
          .from('venues').update({ lat: hit.lat, lng: hit.lng }).eq('id', v.id)
        if (upErr) { failed.push({ v, why: upErr.message }); continue }
      }
      updated++
      console.log(`  ✓ ${v.name} → ${hit.lat.toFixed(6)}, ${hit.lng.toFixed(6)}`)
    } catch (err) {
      failed.push({ v, why: err.message })
    }
  }

  console.log(`\n${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`)
  if (skipped.length) {
    console.log(`\n⚠️  Skipped for manual review (${skipped.length}):`)
    for (const s of skipped) console.log(`   - ${s.v.name} [${fullAddress(s.v)}] — ${s.why}`)
  }
  if (failed.length) {
    console.log(`\n✖  Failed (${failed.length}):`)
    for (const f of failed) console.log(`   - ${f.v.name} — ${f.why}`)
  }
}

// Import-safe: only run when invoked directly (never on import, e.g. in tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`✖ geocode-venues failed: ${err.message}`)
    process.exit(1)
  })
}
