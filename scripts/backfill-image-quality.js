/**
 * backfill-image-quality.js
 *
 * One-off backfill for the new image quality signal columns.
 *
 * For every event with an image_url:
 *   1. Run normalizeImageUrl() to upgrade the stored URL to its
 *      highest-resolution variant (per-source transforms).
 *   2. Re-probe the (possibly new) URL for dimensions AND Content-Length.
 *   3. Update image_url, image_width, image_height, image_file_size.
 *
 * banner_eligible is a generated column — Postgres recomputes it
 * automatically from these three signal fields. No need to write it
 * directly.
 *
 * Usage:
 *   node scripts/backfill-image-quality.js                # DRY RUN (default)
 *   node scripts/backfill-image-quality.js --execute      # apply updates
 *   node scripts/backfill-image-quality.js --source=eventbrite --execute
 *
 * Prerequisite: migration 021 must be applied.
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { getImageDimensions } from './lib/image-dimensions.js'
import { normalizeImageUrl } from './lib/image-url-normalizer.js'

const EXECUTE = process.argv.includes('--execute')
const SOURCE_FILTER = (() => {
  const arg = process.argv.find((a) => a.startsWith('--source='))
  return arg ? arg.split('=')[1] : null
})()
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--limit='))
  return arg ? parseInt(arg.split('=')[1], 10) : null
})()
const SKIP = (() => {
  const arg = process.argv.find((a) => a.startsWith('--skip='))
  return arg ? parseInt(arg.split('=')[1], 10) : 0
})()
const CONCURRENCY = (() => {
  const arg = process.argv.find((a) => a.startsWith('--concurrency='))
  return arg ? parseInt(arg.split('=')[1], 10) : 20
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(
    `\n🖼️   Backfilling image quality signals${EXECUTE ? '' : '  (DRY RUN — pass --execute)'}` +
    (SOURCE_FILTER ? `   source=${SOURCE_FILTER}` : '') +
    '\n'
  )

  // Pull all events with an http(s) image_url. Page through to bypass the
  // PostgREST 1000-row default cap.
  const events = await fetchAllCandidates(SOURCE_FILTER, LIMIT, SKIP)
  console.log(`Found ${events.length} events with an http(s) image_url.  concurrency=${CONCURRENCY}\n`)

  const stats = {
    processed:    0,
    urlUpdated:   0,
    metaUpdated:  0,
    failed:       0,
    bannerYes:    0,
    bannerNo:     0,
  }

  // Process events in parallel batches. Each batch fires CONCURRENCY fetches
  // at once and awaits them all before starting the next, so we never have
  // more than CONCURRENCY in-flight connections to a third-party CDN.
  for (let i = 0; i < events.length; i += CONCURRENCY) {
    const batch = events.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map((event) => processOne(event, stats)))
  }

  console.log('\n────────────────────────────────')
  console.log(`Processed:       ${stats.processed}`)
  console.log(`URL upgraded:    ${stats.urlUpdated}`)
  console.log(`Rows changed:    ${stats.metaUpdated}`)
  console.log(`Banner eligible: ${stats.bannerYes}`)
  console.log(`Banner rejected: ${stats.bannerNo}`)
  console.log(`Probe failed:    ${stats.failed}`)
  console.log('────────────────────────────────\n')
}

/**
 * Probe + maybe-update one event. Mutates `stats` in place. Designed to be
 * called concurrently — each invocation is independent.
 */
async function processOne(event, stats) {
  stats.processed++
  const originalUrl = event.image_url
  const normalizedUrl = normalizeImageUrl(originalUrl, event.source)
  const urlChanged = normalizedUrl !== originalUrl

  const meta = await getImageDimensions(normalizedUrl)

  if (!meta) {
    console.log(`❓ ${event.source.padEnd(22)} probe failed   ${event.title.slice(0, 50)}`)
    stats.failed++
    return
  }

  const { width, height, fileSize } = meta
  const bpp = (width && height && fileSize)
    ? fileSize / (width * height)
    : null
  // Mirrors migration 022's banner_eligible logic so the printed stats
  // match what Postgres will compute when the row is updated.
  const bannerEligible =
    width  != null && width  >= 600 &&
    height != null && height >= 338 &&
    (fileSize == null || bpp >= 0.02)

  if (bannerEligible) stats.bannerYes++; else stats.bannerNo++

  const dimsChanged = width !== event.image_width || height !== event.image_height
  const sizeChanged = fileSize !== event.image_file_size
  const anythingChanged = urlChanged || dimsChanged || sizeChanged

  const flag = bannerEligible ? '✅' : '⚠️ '
  const arrow = urlChanged ? ' 🔄' : '   '
  const bppStr = bpp != null ? bpp.toFixed(3) : 'n/a'
  console.log(
    `${flag}${arrow} ${event.source.padEnd(22)} ${(width ?? '?').toString().padStart(4)}×${(height ?? '?').toString().padEnd(4)}  ${(fileSize ?? 0).toString().padStart(8)}b  bpp=${bppStr}  ${event.title.slice(0, 40)}`
  )

  if (urlChanged) stats.urlUpdated++
  if (!anythingChanged || !EXECUTE) {
    if (anythingChanged) stats.metaUpdated++
    return
  }

  const { error } = await supabaseAdmin
    .from('events')
    .update({
      image_url:       normalizedUrl,
      image_width:     width,
      image_height:    height,
      image_file_size: fileSize,
    })
    .eq('id', event.id)

  if (error) {
    console.error(`   ❌ DB update failed: ${error.message}`)
    stats.failed++
  } else {
    stats.metaUpdated++
  }
}

async function fetchAllCandidates(sourceFilter, limit, skip = 0) {
  const events = []
  const BATCH = 1000
  let offset = skip
  // The absolute "stop" position in the ordered result set. Without a
  // limit, paginate until empty.
  const stopAt = limit != null ? skip + limit - 1 : null
  while (true) {
    const rangeEnd = stopAt != null
      ? Math.min(offset + BATCH - 1, stopAt)
      : offset + BATCH - 1
    let q = supabaseAdmin
      .from('events')
      .select('id, source, title, image_url, image_width, image_height, image_file_size')
      .not('image_url', 'is', null)
      .ilike('image_url', 'http%')
      .order('id')
      .range(offset, rangeEnd)
    if (sourceFilter) q = q.eq('source', sourceFilter)
    const { data, error } = await q
    if (error) { console.error('Fetch failed:', error.message); process.exit(1) }
    if (!data.length) break
    events.push(...data)
    if (limit && events.length >= limit) {
      events.length = limit
      break
    }
    if (data.length < BATCH) break
    offset += BATCH
  }
  return events
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
