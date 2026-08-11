/**
 * scrape-better-plays-gaming.js
 *
 * Better Plays Gaming — a tabletop / trading-card game store at 4958 Darrow
 * Rd in Stow. Weekly Magic, Pokémon, One Piece, Star Wars Unlimited, Lorcana,
 * Riftbound, Gundam, D&D, and Warhammer nights, plus one-off tournaments and
 * pre-releases — exactly the grassroots programming Akron Pulse surfaces.
 *
 * Source: the store publishes TEN public Google Calendars, one per game
 * system, each exposed as an iCal feed. getIcsText fetches them sequentially,
 * stamps every VEVENT with an X-BPG-CALENDAR:<slug> marker naming the feed it
 * came from (parseIcs keeps unknown properties as text, and expandRecurrence
 * clones spread them onto every materialised occurrence), and concatenates
 * the bodies into one document for runIcsScraper.
 *
 * Like Full Grip Games, the schedule is encoded as recurring masters (RRULE),
 * so `expandRecurring` materialises each series over a bounded future window
 * and `skipPast` drops the feed's history. The mtg feed also carries a live
 * RECURRENCE-ID override (an edited single occurrence), handled by
 * expandRecurrenceSet in lib/ics.js.
 *
 * Category is forced to 'games'. Price stays null — never assume free; entry
 * fees vary per event and aren't in the feeds. Single store venue.
 *
 * Usage:  node scripts/scrape-better-plays-gaming.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper, fetchIcsFeed, isDateOnlyIcsEvent } from './lib/ics.js'

export const SOURCE_KEY = 'better_plays_gaming'

const WEBSITE = 'https://www.betterplaysgaming.com'

/**
 * The store's per-game public Google Calendars. Keyed by calendar ID (the
 * stable identifier — CALNAMEs are display text the store can rename at any
 * time). `slug` is the X-BPG-CALENDAR marker stamped on each VEVENT; `tags`
 * are the game-system tags that slug maps to. The 'other' calendar carries
 * mixed one-offs, so it contributes no calendar-level tags — title inference
 * in mapTags still applies.
 */
export const CALENDARS = {
  '292f28bb1279caf33b3ffaf41b58d5b4a3df6f6231f16701a8d736e3504446ee@group.calendar.google.com':
    { slug: 'mtg',       tags: ['magic-the-gathering'] },
  '2fc778e8f4b7460edd3d7822084f600cbc8f84bb69e03ebf1a737e146b025795@group.calendar.google.com':
    { slug: 'pokemon',   tags: ['pokemon'] },
  '2947c9dc1ebdc4b625b5afea07e8450492adedaae658e54606c3ddc8702c49d7@group.calendar.google.com':
    { slug: 'one-piece', tags: ['one-piece'] },
  'f1f3624bfdffa334e32363b45b28274be4bed023c429608ece6e75f9edc4c85e@group.calendar.google.com':
    { slug: 'swu',       tags: ['star-wars-unlimited'] },
  '5b2cddbe821f7846be5671ac208f894a1c8f6a39add6636e69cd8591d528e777@group.calendar.google.com':
    { slug: 'lorcana',   tags: ['lorcana'] },
  'b5f70a5133ace9f33d02ac3ded962d3ccec27258976001fe44e04164c1df600a@group.calendar.google.com':
    { slug: 'riftbound', tags: ['riftbound'] },
  '8d16de3356ffcd5976f6b265719fa6b95bb2f947ae54942dca6c4c9eea376483@group.calendar.google.com':
    { slug: 'gundam',    tags: ['gundam'] },
  'bd12bea365f569992cc507d4ee7c3f16f96b9fec27227f729ad7111d4dbfd82e@group.calendar.google.com':
    { slug: 'dnd',       tags: ['dungeons-and-dragons', 'rpg'] },
  '35414f91c33142178356efc3719835eb368db194b34267adb42b4149d53772aa@group.calendar.google.com':
    { slug: 'warhammer', tags: ['warhammer'] },
  'b4defd21c5ddae39a2b307b803fbe5b4f134f2d00070e476d5720e3100d12c39@group.calendar.google.com':
    { slug: 'other',     tags: [] },
}

/** Tags by slug, derived once from the SSOT above for mapTags lookups. */
const TAGS_BY_SLUG = Object.fromEntries(
  Object.values(CALENDARS).map(({ slug, tags }) => [slug, tags]),
)

/** Public iCal feed URL for a Google Calendar ID. */
export function icsUrlFor(calendarId) {
  return `https://calendar.google.com/calendar/ical/${calendarId.replace(/@/g, '%40')}/public/basic.ics`
}

/**
 * Stamp every VEVENT in an ICS document with `X-BPG-CALENDAR:<slug>` so the
 * per-feed identity survives concatenation, parsing, and recurrence
 * expansion. Pure text transform: the marker line is inserted immediately
 * after each BEGIN:VEVENT. Idempotent — a VEVENT already carrying the marker
 * as its first property line is left alone.
 */
export function tagIcsWithCalendar(icsText, slug) {
  if (!icsText || typeof icsText !== 'string') return icsText
  const lines = icsText.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    if (
      lines[i].trim() === 'BEGIN:VEVENT' &&
      !(lines[i + 1] || '').trim().startsWith('X-BPG-CALENDAR:')
    ) {
      out.push(`X-BPG-CALENDAR:${slug}`)
    }
  }
  return out.join('\r\n')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetch all ten calendar feeds sequentially (200ms courtesy delay between
 * requests), tag each with its calendar slug, and concatenate. A single
 * failing feed is a warning — the other nine still flow. All ten failing is
 * a hard error so the run is logged as failed rather than "0 events".
 */
async function getIcsText() {
  const chunks = []
  const failures = []
  const entries = Object.entries(CALENDARS)
  for (let i = 0; i < entries.length; i++) {
    const [calendarId, { slug }] = entries[i]
    if (i > 0) await sleep(200)
    try {
      const body = await fetchIcsFeed(icsUrlFor(calendarId))
      chunks.push(tagIcsWithCalendar(body, slug))
      console.log(`  ✓ ${slug}: ${body.length} bytes`)
    } catch (err) {
      failures.push(slug)
      console.warn(`  ⚠ ${slug} feed failed: ${err.message}`)
    }
  }
  if (chunks.length === 0) {
    throw new Error(`All ${entries.length} Better Plays Gaming calendar feeds failed (${failures.join(', ')})`)
  }
  return chunks.join('\r\n')
}

// The whole calendar set is game programming, so the category is fixed.
export const mapCategory = () => 'games'

/**
 * Tags: base + the source calendar's game-system tags (via the
 * X-BPG-CALENDAR marker stamped in getIcsText) + light title/description
 * inference for the event type. Graceful when the marker is missing (e.g. a
 * VEVENT normalised outside getIcsText): base + title tags still apply.
 */
export function mapTags(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  const tags = ['games', 'tabletop', 'stow']
  const calTags = TAGS_BY_SLUG[ev['X-BPG-CALENDAR']]
  if (calTags) tags.push(...calTags)
  if (/\bpre-?release\b/.test(text))     tags.push('pre-release')
  if (/\bdraft\b/.test(text))            tags.push('draft')
  if (/\btournament\b/.test(text))       tags.push('tournament')
  if (/\bleague\b/.test(text))           tags.push('league')
  if (/\bcommander\b|\bedh\b/.test(text)) tags.push('commander')
  if (/\bopen play\b/.test(text))        tags.push('open-play')
  if (/\bboard game/.test(text))         tags.push('board-games')
  return [...new Set(tags)]
}

export const config = {
  source: SOURCE_KEY,
  getIcsText,
  // Materialise recurring masters (weekly game nights, monthly events) and
  // drop whatever history the feeds carry.
  expandRecurring: true,
  recurrenceWindowDays: 120,
  skipPast: true,
  // Date-only VEVENTs get the sanctioned noon ET default; flag them so the
  // invented time has an audit trail in the review queue.
  flagNeedsReview: isDateOnlyIcsEvent,
  organizationName: 'Better Plays Gaming',
  organizationDetails: {
    website:     WEBSITE,
    description: 'Better Plays Gaming is a Stow tabletop and trading-card game store hosting regular Magic: The Gathering, Pokémon, One Piece, Star Wars Unlimited, Lorcana, Riftbound, Gundam, Dungeons & Dragons, and Warhammer events, tournaments, and league play.',
  },
  defaultVenueName: 'Better Plays Gaming',
  defaultVenueDetails: {
    address: '4958 Darrow Rd', city: 'Stow', state: 'OH', zip: '44224',
    website: WEBSITE,
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
