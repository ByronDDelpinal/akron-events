/**
 * scrape-village-of-silver-lake.js — Village of Silver Lake
 * (villageofsilverlake.com), the village between Cuyahoga Falls and Stow.
 *
 * The village calendar runs on The Events Calendar and its REST API is open.
 * Most of it is government business: council, planning and zoning, park
 * board and watershed commission meetings. Those are dropped by the same
 * rule the city scrapers use (isPublicCivicPlusEvent), which leaves the
 * community events: the tree lighting, Craft Cafe sessions, seminars.
 *
 * The venue is whatever the feed names ("Village Hall", "Gazebo on Silver
 * Lake Blvd"); an entry with no venue is published without one.
 *
 * Usage:
 *   node scripts/scrape-village-of-silver-lake.js
 *   node scripts/scrape-village-of-silver-lake.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { collectTribe } from './lib/tribe-planned.js'
import { isPublicCivicPlusEvent } from './lib/civicplus.js'

export const SOURCE_KEY = 'village_of_silver_lake'
const ORIGIN = 'https://villageofsilverlake.com'

const ORG = {
  name: 'Village of Silver Lake',
  details: { website: ORIGIN, description: 'Village government for Silver Lake in Summit County.' },
}

export function categoriesFor(title = '') {
  if (/\b(tree lighting|festival|parade|fireworks|egg hunt|halloween|trick or treat)\b/i.test(title)) return ['festival']
  if (/\b(concert|band|music)\b/i.test(title)) return ['music']
  if (/\b(craft|seminar|class|workshop|talk|lecture)\b/i.test(title)) return ['learning']
  return ['civic']
}

export const config = {
  source: SOURCE_KEY,
  label: 'Village of Silver Lake',
  baseUrl: `${ORIGIN}/wp-json/tribe/events/v1/events`,
  daysAhead: 270,
  include: (title, ev) => (isPublicCivicPlusEvent(title, ev) ? true : 'government_meeting_or_notice'),
  categories: categoriesFor,
  tags: ['silver-lake', 'village'],
}

export const collect = (opts) => collectTribe(config, opts)

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY, label: config.label, emoji: '🏛️', org: ORG, homeVenue: null,
    collect: () => collect({ fetchImpl, now }), dryRun, emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
