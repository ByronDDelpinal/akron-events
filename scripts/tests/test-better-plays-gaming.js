/**
 * test-better-plays-gaming.js — config, calendar registry, feed tagging, and
 * tag mapping for the Better Plays Gaming multi-calendar iCal scraper. Feed
 * parsing, RRULE expansion, and RECURRENCE-ID override handling are covered
 * by the shared lib tests in test-ics.js; here we lock the scraper's own
 * config, the ten-calendar SSOT, and the calendar → tag mapping.
 *
 * Run:  node --test scripts/tests/test-better-plays-gaming.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// Import safety: with dummy env only, the module must load without side
// effects (guarded main, lazy supabase-admin).
const {
  mapCategory, mapTags, config, SOURCE_KEY, CALENDARS, tagIcsWithCalendar, icsUrlFor,
} = await import('../scrape-better-plays-gaming.js')
const { parseIcs, isDateOnlyIcsEvent } = await import('../lib/ics.js')

describe('Better Plays Gaming CALENDARS registry', () => {
  it('has exactly ten calendars with unique IDs and slugs', () => {
    const ids = Object.keys(CALENDARS)
    const slugs = Object.values(CALENDARS).map(c => c.slug)
    assert.equal(ids.length, 10)
    assert.equal(new Set(ids).size, 10)
    assert.equal(new Set(slugs).size, 10)
  })

  it('every calendar ID is a Google group calendar address', () => {
    for (const id of Object.keys(CALENDARS)) {
      assert.ok(id.endsWith('@group.calendar.google.com'), id)
    }
  })

  it('covers the expected game-system slugs', () => {
    const slugs = Object.values(CALENDARS).map(c => c.slug).sort()
    assert.deepEqual(slugs, [
      'dnd', 'gundam', 'lorcana', 'mtg', 'one-piece',
      'other', 'pokemon', 'riftbound', 'swu', 'warhammer',
    ])
  })

  it('every calendar declares a tags array ("other" is empty by design)', () => {
    for (const { slug, tags } of Object.values(CALENDARS)) {
      assert.ok(Array.isArray(tags), slug)
      if (slug === 'other') assert.deepEqual(tags, [])
      else assert.ok(tags.length >= 1, `${slug} should carry game-system tags`)
    }
  })

  it('icsUrlFor percent-encodes the @ in the calendar ID', () => {
    const [id] = Object.keys(CALENDARS)
    const url = icsUrlFor(id)
    assert.ok(url.startsWith('https://calendar.google.com/calendar/ical/'))
    assert.ok(url.endsWith('%40group.calendar.google.com/public/basic.ics'))
    assert.ok(!url.includes('@'))
  })
})

describe('Better Plays Gaming tagIcsWithCalendar', () => {
  const FEED = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:a1',
    'SUMMARY:Commander Night',
    'DTSTART;TZID=America/New_York:20260722T180000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:a2',
    'SUMMARY:Draft Night',
    'DTSTART;TZID=America/New_York:20260724T183000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('injects exactly one X-BPG-CALENDAR header per VEVENT', () => {
    const tagged = tagIcsWithCalendar(FEED, 'mtg')
    const markers = tagged.match(/X-BPG-CALENDAR:mtg/g) || []
    assert.equal(markers.length, 2)
    // Immediately after each BEGIN:VEVENT
    assert.equal((tagged.match(/BEGIN:VEVENT\r\nX-BPG-CALENDAR:mtg/g) || []).length, 2)
  })

  it('is idempotent — tagging twice inserts nothing new', () => {
    const once  = tagIcsWithCalendar(FEED, 'mtg')
    const twice = tagIcsWithCalendar(once, 'mtg')
    assert.equal(twice, once)
  })

  it('the marker survives parseIcs as an event property', () => {
    const events = parseIcs(tagIcsWithCalendar(FEED, 'pokemon'))
    assert.equal(events.length, 2)
    for (const ev of events) assert.equal(ev['X-BPG-CALENDAR'], 'pokemon')
  })

  it('tolerates empty/non-string input', () => {
    assert.equal(tagIcsWithCalendar('', 'mtg'), '')
    assert.equal(tagIcsWithCalendar(null, 'mtg'), null)
  })
})

describe('Better Plays Gaming mapCategory', () => {
  it('always games (the whole calendar set is game programming)', () => {
    assert.equal(mapCategory({ SUMMARY: 'Commander Night' }), 'games')
    assert.equal(mapCategory({ SUMMARY: 'Pokémon League' }), 'games')
    assert.equal(mapCategory({ SUMMARY: 'Anything at all' }), 'games')
  })
})

describe('Better Plays Gaming mapTags', () => {
  it('always tags games + tabletop + stow', () => {
    const t = mapTags({ SUMMARY: 'Open Event' })
    assert.ok(t.includes('games') && t.includes('tabletop') && t.includes('stow'))
  })

  it('maps every calendar slug to its game-system tags', () => {
    for (const { slug, tags } of Object.values(CALENDARS)) {
      const t = mapTags({ SUMMARY: 'Weekly Event', 'X-BPG-CALENDAR': slug })
      for (const tag of tags) assert.ok(t.includes(tag), `${slug} → ${tag}`)
    }
  })

  it('dnd calendar carries both dungeons-and-dragons and rpg', () => {
    const t = mapTags({ SUMMARY: 'Adventure League', 'X-BPG-CALENDAR': 'dnd' })
    assert.ok(t.includes('dungeons-and-dragons'))
    assert.ok(t.includes('rpg'))
  })

  it('is graceful when the calendar marker is missing or unknown', () => {
    assert.deepEqual(mapTags({ SUMMARY: 'Mystery Event' }), ['games', 'tabletop', 'stow'])
    assert.deepEqual(
      mapTags({ SUMMARY: 'Mystery Event', 'X-BPG-CALENDAR': 'nope' }),
      ['games', 'tabletop', 'stow'],
    )
  })

  it('derives event-type tags from the title/description', () => {
    assert.ok(mapTags({ SUMMARY: 'MTG Prerelease' }).includes('pre-release'))
    assert.ok(mapTags({ SUMMARY: 'Pre-Release Weekend' }).includes('pre-release'))
    assert.ok(mapTags({ SUMMARY: 'Booster Draft' }).includes('draft'))
    assert.ok(mapTags({ SUMMARY: 'Store Tournament' }).includes('tournament'))
    assert.ok(mapTags({ SUMMARY: 'Weekly League' }).includes('league'))
    assert.ok(mapTags({ SUMMARY: 'Commander Night' }).includes('commander'))
    assert.ok(mapTags({ SUMMARY: 'EDH Pods', DESCRIPTION: '' }).includes('commander'))
    assert.ok(mapTags({ SUMMARY: 'Open Play Sunday' }).includes('open-play'))
    assert.ok(mapTags({ SUMMARY: 'Board Game Night' }).includes('board-games'))
  })

  it('returns a de-duplicated list', () => {
    const t = mapTags({ SUMMARY: 'Commander Commander EDH', 'X-BPG-CALENDAR': 'mtg' })
    assert.equal(new Set(t).size, t.length)
  })
})

describe('Better Plays Gaming config', () => {
  it('uses the right source key', () => {
    assert.equal(SOURCE_KEY, 'better_plays_gaming')
    assert.equal(config.source, 'better_plays_gaming')
  })

  it('fetches via a custom getIcsText (ten merged feeds)', () => {
    assert.equal(typeof config.getIcsText, 'function')
    assert.equal(config.feedUrl, undefined)
  })

  it('expands recurring masters over 120 days and skips past events', () => {
    assert.equal(config.expandRecurring, true)
    assert.equal(config.recurrenceWindowDays, 120)
    assert.equal(config.skipPast, true)
  })

  it('flags date-only VEVENTs for review (sanctioned noon default)', () => {
    assert.equal(config.flagNeedsReview, isDateOnlyIcsEvent)
  })

  it('never assumes free (price stays null)', () => {
    assert.equal(config.defaultPriceMin, null)
    assert.equal(config.defaultPriceMax, null)
  })

  it('pins the Stow store venue', () => {
    assert.equal(config.defaultVenueName, 'Better Plays Gaming')
    assert.equal(config.defaultVenueDetails.address, '4958 Darrow Rd')
    assert.equal(config.defaultVenueDetails.city, 'Stow')
    assert.equal(config.defaultVenueDetails.state, 'OH')
    assert.equal(config.defaultVenueDetails.zip, '44224')
    assert.equal(config.defaultVenueDetails.website, 'https://www.betterplaysgaming.com')
  })

  it('credits the store as organizer with its website', () => {
    assert.equal(config.organizationName, 'Better Plays Gaming')
    assert.equal(config.organizationDetails.website, 'https://www.betterplaysgaming.com')
  })

  it('is all-ages with category forced to games', () => {
    assert.equal(config.ageRestriction, 'all_ages')
    assert.equal(config.mapCategory({}), 'games')
  })
})
