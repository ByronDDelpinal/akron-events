/**
 * backfill-image-dimensions.js
 *
 * One-time (or repeat-safe) script that fetches image dimensions for all
 * published events that have an image_url but no image_width/image_height.
 *
 * Usage:
 *   node scripts/backfill-image-dimensions.js
 *   node scripts/backfill-image-dimensions.js --force   # re-check all, even those already measured
 *   node scripts/backfill-image-dimensions.js --dry-run  # log results without writing to DB
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { getImageDimensions } from './lib/image-dimensions.js'

const FORCE   = process.argv.includes('--force')
const DRY_RUN = process.argv.includes('--dry-run')

// Rate-limit: delay between fetches to be respectful to image hosts
const DELAY_MS = 200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`\n📐 Backfilling image dimensions${FORCE ? ' (FORCE — re-checking all)' : ''}${DRY_RUN ? ' (DRY RUN)' : ''}\n`)

  // Fetch events that need dimension data
  let query = supabaseAdmin
    .from('events')
    .select('id, title, image_url, image_width, image_height')
    .eq('status', 'published')
    .not('image_url', 'is', null)
    .order('start_at', { ascending: true })

  if (!FORCE) {
    query = query.is('image_width', null)
  }

  const { data: events, error } = await query

  if (error) {
    console.error('❌ Failed to fetch events:', error.message)
    process.exit(1)
  }

  console.log(`Found ${events.length} events to process\n`)

  let updated = 0
  let failed  = 0
  let skipped = 0

  for (const event of events) {
    // Skip non-http URLs
    if (!event.image_url || !/^https?:\/\//i.test(event.image_url)) {
      skipped++
      continue
    }

    const dims = await getImageDimensions(event.image_url)

    if (dims) {
      const qualityOk = dims.width >= 600 && dims.height >= 338
      const symbol = qualityOk ? '✅' : '⚠️ '
      console.log(`${symbol} ${dims.width}×${dims.height}  ${event.title.slice(0, 50)}`)

      if (!DRY_RUN) {
        const { error: updateErr } = await supabaseAdmin
          .from('events')
          .update({ image_width: dims.width, image_height: dims.height })
          .eq('id', event.id)

        if (updateErr) {
          console.error(`   ❌ DB update failed: ${updateErr.message}`)
          failed++
        } else {
          updated++
        }
      } else {
        updated++
      }
    } else {
      console.log(`❓ Could not determine dimensions: ${event.title.slice(0, 50)}`)
      failed++
    }

    await sleep(DELAY_MS)
  }

  console.log(`\n────────────────────────────────`)
  console.log(`✅ Updated: ${updated}`)
  console.log(`❓ Failed:  ${failed}`)
  console.log(`⏭️  Skipped: ${skipped}`)
  console.log(`────────────────────────────────\n`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
