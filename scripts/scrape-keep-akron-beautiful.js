/**
 * scrape-keep-akron-beautiful.js — Keep Akron Beautiful
 * (keepakronbeautiful.org), the nonprofit behind the city's flowerscapes,
 * litter cleanups and the Beautify & Boogie fundraiser.
 *
 * Its events run on The Events Calendar with an open REST API. The venue is
 * the one the feed names; an event outside Summit County is skipped. The
 * calendar is quiet in winter and busier in spring, so an empty run is normal.
 *
 * Usage:
 *   node scripts/scrape-keep-akron-beautiful.js
 *   node scripts/scrape-keep-akron-beautiful.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { collectTribe } from './lib/tribe-planned.js'

export const SOURCE_KEY = 'keep_akron_beautiful'
const ORIGIN = 'https://www.keepakronbeautiful.org'

const ORG = {
  name: 'Keep Akron Beautiful',
  details: { website: ORIGIN, description: 'Nonprofit that plants and maintains Akron\'s public flowerscapes and organizes litter cleanups and beautification projects.' },
}

export function categoriesFor(title = '') {
  if (/\b(clean ?up|sweep|planting|plant|litter|adopt)\b/i.test(title)) return ['outdoors', 'civic']
  return ['civic']
}

export const config = {
  source: SOURCE_KEY,
  label: 'Keep Akron Beautiful',
  baseUrl: `${ORIGIN}/wp-json/tribe/events/v1/events`,
  daysAhead: 365,
  categories: categoriesFor,
  tags: ['volunteer', 'beautification', 'akron'],
}

export const collect = (opts) => collectTribe(config, opts)

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY, label: config.label, emoji: '🌷', org: ORG, homeVenue: null,
    collect: () => collect({ fetchImpl, now }), dryRun, emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
