/**
 * test-slovene-center.js — pure parsers of scrape-slovene-center.js.
 *
 * Run:  node --test scripts/tests/test-slovene-center.js
 *
 * Fixtures are shapes captured from slovenecenter.com/calendar, 2026-07-14.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  eventDetailUrl, cleanTitle, mapCategory, mapTags, parsePrice,
  classifyEventLocation, venueKind, rowFromWarmup, CENTER, SOURCE_KEY,
} = await import('../scrape-slovene-center.js')

const { parseWixLocation } = await import('../lib/wix-events.js')

// ── Fixtures ────────────────────────────────────────────────────────────────

// A one-off dance at the hall; cover charge stated in prose.
const DANCE_EV = {
  id: 'abc123',
  title: 'DJ Johnny Dance - Footloose Dance #3',
  description: 'Line dancing, Country & Ballroom! The cover charge for this event is $10.',
  slug: 'dj-johnny-dance-footloose-dance-3',
  scheduling: { config: {
    scheduleTbd: false,
    startDate: '2026-06-19T23:00:00.000Z',   // 7:00 PM ET
    endDate:   '2026-06-20T02:00:00.000Z',
    endDateHidden: false,
    timeZoneId: 'America/New_York',
  } },
  location: {
    name: 'Barberton',
    coordinates: { lat: 41.0127622, lng: -81.6211899 },
    address: '70 14th St NW, Barberton, OH 44203, USA',
    fullAddress: { city: 'Barberton', subdivision: 'OH', postalCode: '44203-7131' },
  },
  mainImage: { id: 'nsplsh_35~mv2.jpg', url: 'https://static.wixstatic.com/media/nsplsh_35~mv2.jpg' },
}

// A weekly recurring occurrence: slug carries a date stamp, price is "at the door".
const JITTERBUG_EV = {
  id: 'def456',
  title: 'Jitterbug Club – ONCJC Every Wednesday 7-10 PM',
  description: 'Dance the jitterbug with us every Wednesday night! Purchase at the door.',
  slug: 'jitterbug-club-oncjc-every-wednesday-7-10-pm-2026-07-15-19-00-1',
  scheduling: { config: {
    scheduleTbd: false,
    startDate: '2026-07-15T23:00:00.000Z',
    endDate:   '2026-07-16T02:00:00.000Z',
    endDateHidden: false,
  } },
  location: {
    name: 'Barberton',
    address: '70 14th St NW, Barberton, OH 44203, USA',
    fullAddress: { city: 'Barberton', subdivision: 'OH', postalCode: '44203-7131' },
  },
  mainImage: null,
}

// An offsite festival listing: a genuinely different address, but the raw
// location "name" is only the city — not a usable venue name.
const OFFSITE_EV = {
  id: 'ghi789',
  title: 'Atomic Rodeo Art & Music Festival Kick-Off Party',
  description: 'Local music & free event.',
  slug: 'atomic-rodeo-art-music-festival-kick-off-party',
  scheduling: { config: { scheduleTbd: false, startDate: '2026-06-12T15:00:00.000Z' } },
  location: {
    name: 'Barberton',
    address: '887 W Tuscarawas Ave, Barberton, Ohio 44203',
    fullAddress: { city: 'Barberton', subdivision: 'OH', postalCode: '44203-7131' },
  },
  mainImage: null,
}

// ── eventDetailUrl ────────────────────────────────────────────────────────────

describe('eventDetailUrl', () => {
  it('builds the /event-details/ URL', () => {
    assert.equal(eventDetailUrl('dj-johnny-dance-footloose-dance-3'),
      'https://www.slovenecenter.com/event-details/dj-johnny-dance-footloose-dance-3')
    assert.equal(eventDetailUrl(null), null)
  })
})

// ── cleanTitle ────────────────────────────────────────────────────────────────

describe('cleanTitle', () => {
  it('decodes entities and strips the Wix (n) duplicate suffix', () => {
    assert.equal(cleanTitle('Art &amp; Music Festival'), 'Art & Music Festival')
    assert.equal(cleanTitle('DJ Johnny Dance (1)'), 'DJ Johnny Dance')
  })
  it('leaves a legitimate parenthetical intact', () => {
    assert.equal(cleanTitle('Jitterbug Club (ONCJC)'), 'Jitterbug Club (ONCJC)')
  })
})

// ── mapCategory ───────────────────────────────────────────────────────────────

describe('mapCategory', () => {
  it('maps social dances and DJ/music nights to music', () => {
    assert.equal(mapCategory('DJ Johnny Dance - Footloose Dance #3', 'Line dancing, Country & Ballroom!'), 'music')
    assert.equal(mapCategory('Jitterbug Club – ONCJC Every Wednesday', 'Dance the jitterbug'), 'music')
  })
  it('maps festivals to festival (before the music keyword)', () => {
    assert.equal(mapCategory('Atomic Rodeo Art & Music Festival Kick-Off Party', 'Local music & free event.'), 'festival')
  })
  it('maps community dinners / fish fries to food', () => {
    assert.equal(mapCategory('Klobasa Sausage Dinner', 'A Slovenian dinner.'), 'food')
    assert.equal(mapCategory('Lenten Fish Fry', ''), 'food')
  })
})

// ── mapTags ───────────────────────────────────────────────────────────────────

describe('mapTags', () => {
  it('always carries the source tags', () => {
    assert.ok(mapTags('Anything').includes('slovene-center'))
    assert.ok(mapTags('Anything').includes('barberton'))
  })
  it('derives topic tags from title + description', () => {
    assert.ok(mapTags('DJ Johnny Dance', 'Ballroom night').includes('dance'))
    assert.ok(mapTags('DJ Johnny Dance', 'Ballroom night').includes('music'))
    assert.ok(mapTags('Atomic Vintage Cruise-In', 'Classic cars').includes('car-show'))
    assert.ok(mapTags('Slovenian Heritage Festival', '').includes('festival'))
  })
})

// ── parsePrice ────────────────────────────────────────────────────────────────

describe('parsePrice', () => {
  it('reads an explicit cover charge', () => {
    assert.deepEqual(parsePrice('The cover charge for this event is $10.'), { price_min: 10, price_max: null })
  })
  it('reads a range as min/max', () => {
    assert.deepEqual(parsePrice('Tickets $10–$15 at the door.'), { price_min: 10, price_max: 15 })
  })
  it('treats an explicit "free" as 0', () => {
    assert.deepEqual(parsePrice('Local music & free event.'), { price_min: 0, price_max: 0 })
  })
  it('never assumes a price when none is stated', () => {
    assert.deepEqual(parsePrice('Purchase at the door.'), { price_min: null, price_max: null })
    assert.deepEqual(parsePrice(''), { price_min: null, price_max: null })
  })
})

// ── classifyEventLocation (gates on address city, not coords) ──────────────────

describe('classifyEventLocation', () => {
  it('passes a Summit-County city', () => {
    assert.equal(classifyEventLocation(parseWixLocation(DANCE_EV.location)), 'in')
  })
  it('skips a known non-Summit city even when coords say otherwise', () => {
    // Wix reuses the center's geocode; the city text is authoritative.
    assert.equal(classifyEventLocation({ city: 'Cleveland' }), 'out')
  })
  it('returns unknown when the city is absent', () => {
    assert.equal(classifyEventLocation({}), 'unknown')
  })
})

// ── venueKind ─────────────────────────────────────────────────────────────────

describe('venueKind', () => {
  it('pins the hall address to the center', () => {
    assert.equal(venueKind(parseWixLocation(DANCE_EV.location)), 'center')
    assert.equal(venueKind({ address: '70 14th Street Northwest, Barberton, OH' }), 'center')
    assert.equal(venueKind({}), 'center')   // no address → default pin
  })
  it('leaves an offsite listing with only a city name venue-less', () => {
    assert.equal(venueKind(parseWixLocation(OFFSITE_EV.location)), 'none')
  })
  it('uses a real venue name for an offsite listing', () => {
    assert.equal(venueKind({ name: "Lake Anna Park", address: '500 W Park Ave, Barberton, OH', city: 'Barberton' }), 'named')
  })
})

// ── rowFromWarmup ─────────────────────────────────────────────────────────────

describe('rowFromWarmup', () => {
  it('maps a hall dance to a published row with parsed price + music category', () => {
    const row = rowFromWarmup(DANCE_EV)
    assert.equal(row.title, 'DJ Johnny Dance - Footloose Dance #3')
    assert.equal(row.start_at, '2026-06-19T23:00:00.000Z')
    assert.equal(row.end_at,   '2026-06-20T02:00:00.000Z')
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, 10)
    assert.equal(row.price_max, null)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'dj-johnny-dance-footloose-dance-3')
    assert.equal(row.ticket_url, 'https://www.slovenecenter.com/event-details/dj-johnny-dance-footloose-dance-3')
    assert.equal(row.source_url, row.ticket_url)
    assert.equal(row.status, 'published')
    assert.ok(row.tags.includes('dance'))
  })
  it('keeps a stable date-stamped source_id for recurring occurrences; null price at-the-door', () => {
    const row = rowFromWarmup(JITTERBUG_EV)
    assert.equal(row.source_id, 'jitterbug-club-oncjc-every-wednesday-7-10-pm-2026-07-15-19-00-1')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.category, 'music')
  })
  it('returns null when title or start time is missing', () => {
    assert.equal(rowFromWarmup({ ...DANCE_EV, title: undefined }), null)
    assert.equal(rowFromWarmup({ ...DANCE_EV, scheduling: { config: { scheduleTbd: true } } }), null)
  })
  it('returns null for a cancelled/postponed title marker', () => {
    assert.equal(rowFromWarmup({ ...DANCE_EV, title: 'DJ Johnny Dance - CANCELLED' }), null)
    assert.equal(rowFromWarmup({ ...DANCE_EV, title: 'Jitterbug Club (Postponed)' }), null)
  })
})

// ── CENTER constant sanity ────────────────────────────────────────────────────

describe('CENTER venue', () => {
  it('is the Barberton hall in Summit County', () => {
    assert.equal(CENTER.city, 'Barberton')
    assert.equal(CENTER.state, 'OH')
    assert.equal(CENTER.zip, '44203')
  })
})
