/**
 * scrape-full-grip-games.js
 *
 * Full Grip Games — a tabletop / trading-card game store in downtown Akron
 * (121 E Market St). It's a small local business whose calendar is exactly the
 * kind of grassroots programming Akron Pulse exists to surface: weekly Magic
 * and Pokémon nights, Commander, Friday Night Magic, drafts, league play.
 *
 * Source: the store publishes a public Google Calendar, exposed as an iCal
 * feed. Crucially, Google Calendar encodes the regular weekly/monthly schedule
 * as recurring masters (RRULE) rather than one VEVENT per night — so we ingest
 * it through runIcsScraper with `expandRecurring` on, which materialises each
 * recurrence into a concrete dated event over a bounded future window.
 *
 * The feed also carries the store's full event *history* (years of past
 * one-offs), so `skipPast` drops anything that's already over.
 *
 * Category is forced to 'games' (the entire calendar is game programming).
 * Price stays null — never assume free; entry fees vary per event and aren't
 * in the feed. Single store venue (no per-event LOCATION in the feed).
 *
 * Usage:  node scripts/scrape-full-grip-games.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *         FULL_GRIP_GAMES_ICS_URL — optional feed URL override
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'

export const SOURCE_KEY = 'full_grip_games'

// Public Google Calendar iCal feed for the store.
const ICS_URL =
  process.env.FULL_GRIP_GAMES_ICS_URL ||
  'https://calendar.google.com/calendar/ical/natalie%40fullgripgames.com/public/basic.ics'

// The whole calendar is game programming, so the category is fixed.
export const mapCategory = () => 'games'

/**
 * Light tagging from the event title so the game system is searchable. These
 * are supplementary tags only — category is always 'games'.
 */
export function mapTags(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  const tags = ['games', 'tabletop', 'akron']
  if (/\bpok[eé]mon\b|\bptcg\b/.test(text))         tags.push('pokemon')
  if (/\bmagic\b|\bmtg\b|\bcommander\b|\bedh\b/.test(text)) tags.push('magic-the-gathering')
  if (/\bfriday night magic\b|\bfnm\b/.test(text))  tags.push('friday-night-magic')
  if (/\bdraft\b/.test(text))                       tags.push('draft')
  if (/\bcommander\b|\bedh\b/.test(text))           tags.push('commander')
  if (/\bleague\b/.test(text))                      tags.push('league')
  if (/\byu-?gi-?oh\b/.test(text))                  tags.push('yugioh')
  if (/\blorcana\b/.test(text))                     tags.push('lorcana')
  if (/\bone piece\b/.test(text))                   tags.push('one-piece')
  if (/\bwarhammer\b|\b40k\b/.test(text))           tags.push('warhammer')
  if (/\bboard game\b/.test(text))                  tags.push('board-games')
  if (/\btournament\b/.test(text))                  tags.push('tournament')
  return [...new Set(tags)]
}

export const config = {
  source: SOURCE_KEY,
  feedUrl: ICS_URL,
  // Materialise recurring masters (weekly game nights, monthly events) and
  // drop the years of past one-offs the feed also carries.
  expandRecurring: true,
  recurrenceWindowDays: 120,
  skipPast: true,
  organizationName: 'Full Grip Games',
  organizationDetails: {
    website:     'https://www.fullgripgames.com',
    description: 'Full Grip Games is a downtown Akron tabletop and trading-card game store hosting regular Magic: The Gathering, Pokémon, and board game events, tournaments, and league play.',
  },
  defaultVenueName: 'Full Grip Games',
  defaultVenueDetails: {
    address: '121 E Market St', city: 'Akron', state: 'OH', zip: '44308',
    neighborhood_slug: 'downtown-akron',
    website: 'https://www.fullgripgames.com',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: null,   // never assume free
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIcsScraper(config)
}
