/**
 * check-scraper-health.js
 *
 * Query the scraper_health view and print a colour-coded status report.
 * Exits with code 1 if any scraper is in an alert state.
 *
 * Usage:
 *   node scripts/check-scraper-health.js
 *   npm run health
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

const RESET  = '\x1b[0m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const GREEN  = '\x1b[32m'
const BOLD   = '\x1b[1m'
const DIM    = '\x1b[2m'
const CYAN   = '\x1b[36m'

async function main() {
  const { data: rows, error } = await supabaseAdmin
    .from('scraper_health')
    .select('*')

  if (error) {
    console.error(`${RED}❌  Failed to query scraper_health:${RESET}`, error.message)
    console.error(`    Have you applied migration 003_scraper_health.sql?`)
    process.exit(1)
  }

  if (!rows || rows.length === 0) {
    console.log(`${DIM}  No scraper runs recorded yet.${RESET}`)
    console.log(`  Run your scrapers first: npm run scrape:all`)
    process.exit(0)
  }

  console.log(`\n${BOLD}🩺  Scraper Health Report${RESET}  ${DIM}(${new Date().toLocaleString()})${RESET}\n`)

  // Column widths
  const nameWidth = Math.max(16, ...rows.map(r => r.scraper_name.length))

  // Header
  console.log(
    `  ${BOLD}${'SCRAPER'.padEnd(nameWidth)}  STATUS    LAST RUN      EVENTS  AVG(5)  TOTAL RUNS${RESET}`
  )
  console.log('  ' + '─'.repeat(nameWidth + 52))

  let anyAlert = false

  for (const row of rows) {
    const {
      scraper_name, last_ran_at, hours_since_run, last_status,
      last_events_found, avg_events_last5, total_runs,
      is_stale, is_zero_streak, is_error, alert,
    } = row

    const hasAlert = is_error || is_stale || is_zero_streak
    if (hasAlert) anyAlert = true

    // Colour-code status
    let statusIcon, statusColor
    if (is_error)        { statusIcon = '❌ ERROR '; statusColor = RED }
    else if (is_stale)   { statusIcon = '⚠ STALE '; statusColor = YELLOW }
    else if (is_zero_streak) { statusIcon = '⚠ ZEROS '; statusColor = YELLOW }
    else                 { statusIcon = '✓ OK    '; statusColor = GREEN }

    // Format last run time
    const hoursAgo = hours_since_run != null
      ? (hours_since_run < 1 ? '<1h ago' : `${Math.round(hours_since_run)}h ago`)
      : 'never'

    const line = [
      `  ${hasAlert ? statusColor + BOLD : DIM}${scraper_name.padEnd(nameWidth)}${RESET}`,
      `  ${statusColor}${statusIcon}${RESET}`,
      `  ${String(hoursAgo).padStart(8)}`,
      `  ${String(last_events_found ?? 0).padStart(7)}`,
      `  ${String(avg_events_last5 ?? 0).padStart(6)}`,
      `  ${String(total_runs ?? 0).padStart(10)}`,
    ].join('')

    console.log(line)

    if (alert) {
      console.log(`  ${' '.repeat(nameWidth)}  ${statusColor}↳ ${alert}${RESET}`)
    }
  }

  console.log()

  if (anyAlert) {
    console.log(`${RED}${BOLD}  ⚠  One or more scrapers need attention.${RESET}\n`)
    process.exit(1)
  } else {
    console.log(`${GREEN}${BOLD}  ✓  All scrapers are healthy.${RESET}\n`)
    process.exit(0)
  }
}

main().catch(err => {
  console.error(`${RED}Fatal:${RESET}`, err.message)
  process.exit(1)
})
