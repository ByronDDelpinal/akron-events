/**
 * test-akron-power-squadron.js — pure parsers for the Akron Sail & Power
 * Squadron scraper (WordPress + The Events Calendar iCal export, behind a
 * SiteGround sgcaptcha wall). Fixtures are the real LOCATION / UID / DTSTART
 * values captured from akronpowersquadron.com's list-view iCal export on
 * 2026-07-15.
 *
 * Run:  node --test scripts/tests/test-akron-power-squadron.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, parseLocation, isInternalEvent, mapCategory, normalizeEvent,
} = await import('../scrape-akron-power-squadron.js')

// A fixed "now" well before every fixture start so nothing is filtered as past.
const NOW = Date.parse('2026-07-15T00:00:00Z')

// Real VEVENTs, in the shape parseIcs() returns (LOCATION commas already
// unescaped; DTSTART carries TZID=America/New_York).
const PADDLESMART = {
  SUMMARY: 'PaddleSmart 07/28/26',
  DTSTART: { value: '20260728T173000', params: { TZID: 'America/New_York' } },
  DTEND:   { value: '20260728T210000', params: { TZID: 'America/New_York' } },
  UID: '12402-1785259800-1785272400@akronpowersquadron.com',
  URL: 'https://akronpowersquadron.com/event/paddlesmart-07-21-26/',
  LOCATION: 'Craftsman Park, Portage Lakes, 4450 Rex Lake Road, Akron, 44319, United States',
  DESCRIPTION: 'Enjoy a warm summer evening on the Portage Lakes at Craftsman Park! For beginner kayakers, this seminar put on by Akron Sail and Power Squadron provides one hour of in-class instruction followed by two hours on the water.',
  ATTACH: 'https://akronpowersquadron.com/wp-content/uploads/paddlesmart.jpg',
}
const PADDLE_MOGADORE = {
  SUMMARY: 'Paddle Mogadore Reservoir',
  DTSTART: { value: '20260804T170000', params: { TZID: 'America/New_York' } },
  DTEND:   { value: '20260804T200000', params: { TZID: 'America/New_York' } },
  UID: '12554-1785862800-1785873600@akronpowersquadron.com',
  URL: 'https://akronpowersquadron.com/event/paddle-mogadore-reservoir/',
  LOCATION: 'Boathouse at Mogadore Reservoir, 2578 OH-43, Mogadore, OH, United States',
}
const CORN_ROAST = {
  SUMMARY: 'ASPS ANNUAL CORN ROAST',
  DTSTART: { value: '20260815T120000', params: { TZID: 'America/New_York' } },
  UID: '12522-1786795200-1786809600@akronpowersquadron.com',
  LOCATION: 'Lion’s Park Pavillion – Sandusky, 533 Winnebago Ave., Sandusky, OH, 44870, United States',
}
const DINNER_MEETING = {
  SUMMARY: 'September Dinner Meeting',
  DTSTART: { value: '20260903T180000', params: { TZID: 'America/New_York' } },
  UID: '12566-1788458400-1788472800@akronpowersquadron.com',
  LOCATION: 'Butcher & Sprout, 1846 Front St., Cuyahoga Falls, OH, 44221, United States',
}

describe('SOURCE_KEY', () => {
  it('is the snake_case source key', () => assert.equal(SOURCE_KEY, 'akron_power_squadron'))
})

describe('parseLocation', () => {
  it('splits a name-with-locality + street + city + zip (no state token)', () => {
    const r = parseLocation(PADDLESMART.LOCATION)
    assert.equal(r.name, 'Craftsman Park, Portage Lakes')
    assert.equal(r.details.address, '4450 Rex Lake Road')
    assert.equal(r.details.city, 'Akron')
    assert.equal(r.details.zip, '44319')
    assert.equal(r.details.state, 'OH')
  })

  it('parses a venue with a state token but no zip', () => {
    const r = parseLocation(PADDLE_MOGADORE.LOCATION)
    assert.equal(r.name, 'Boathouse at Mogadore Reservoir')
    assert.equal(r.details.address, '2578 OH-43')
    assert.equal(r.details.city, 'Mogadore')
    assert.equal(r.details.state, 'OH')
    assert.equal(r.details.zip, null)
  })

  it('keeps a full name/street/city/state/zip venue', () => {
    const r = parseLocation(DINNER_MEETING.LOCATION)
    assert.equal(r.name, 'Butcher & Sprout')
    assert.equal(r.details.city, 'Cuyahoga Falls')
    assert.equal(r.details.zip, '44221')
  })

  it('returns null for empty input', () => {
    assert.equal(parseLocation(''), null)
    assert.equal(parseLocation(null), null)
  })
})

describe('isInternalEvent', () => {
  it('skips business/board meetings', () => {
    assert.equal(isInternalEvent('September Dinner Meeting'), true)
    assert.equal(isInternalEvent('Bridge Meeting'), true)
    assert.equal(isInternalEvent('Board Meeting'), true)
  })
  it('skips member/family socials', () => {
    assert.equal(isInternalEvent('ASPS ANNUAL CORN ROAST'), true)
    assert.equal(isInternalEvent('ASPS CHRISTMAS PARTY'), true)
    assert.equal(isInternalEvent('Annual Awards Banquet'), true)
    assert.equal(isInternalEvent('Change of Watch'), true)
  })
  it('keeps public boating education and open paddles', () => {
    assert.equal(isInternalEvent('PaddleSmart 07/28/26'), false)
    assert.equal(isInternalEvent('Paddle Mogadore Reservoir'), false)
    assert.equal(isInternalEvent('America’s Boating Course'), false)
  })
})

describe('mapCategory', () => {
  it('boating-safety education → learning (title alone)', () => {
    assert.equal(mapCategory('PaddleSmart 07/28/26', ''), 'learning')
    assert.equal(mapCategory('America’s Boating Course', ''), 'learning')
    assert.equal(mapCategory('Kayak Safety Seminar', ''), 'learning')
  })
  it('education wins even when the seminar is on the water', () => {
    assert.equal(mapCategory(PADDLESMART.SUMMARY, PADDLESMART.DESCRIPTION), 'learning')
  })
  it('open on-water outings → outdoors', () => {
    assert.equal(mapCategory('Paddle Mogadore Reservoir', ''), 'outdoors')
    assert.equal(mapCategory('Sunset Cruise on the Lake', ''), 'outdoors')
  })
})

describe('normalizeEvent', () => {
  it('publishes an in-county public seminar with the correct Eastern→UTC time', () => {
    const { row, venue, geo } = normalizeEvent(PADDLESMART, NOW)
    assert.equal(geo, 'in')
    assert.equal(row.status, 'published')
    assert.equal(row.needs_review, false)
    assert.equal(row.category, 'learning')
    // 17:30 EDT (UTC-4) → 21:30 UTC — a real posted time, never midnight.
    assert.equal(row.start_at, '2026-07-28T21:30:00.000Z')
    assert.equal(row.end_at, '2026-07-29T01:00:00.000Z')
    assert.equal(row.source, 'akron_power_squadron')
    assert.equal(row.source_id, '12402-1785259800-1785272400@akronpowersquadron.com')
    assert.equal(row.ticket_url, PADDLESMART.URL)
    assert.equal(row.image_url, PADDLESMART.ATTACH)
    assert.equal(row.price_min, null)
    assert.equal(venue.name, 'Craftsman Park, Portage Lakes')
  })

  it('publishes the in-county open paddle as outdoors', () => {
    const { row, geo } = normalizeEvent(PADDLE_MOGADORE, NOW)
    assert.equal(geo, 'in')            // Mogadore is on the Summit allowlist
    assert.equal(row.status, 'published')
    assert.equal(row.category, 'outdoors')
  })

  it('skips internal meetings and member socials', () => {
    assert.equal(normalizeEvent(DINNER_MEETING, NOW).skip, 'internal')
    assert.equal(normalizeEvent(CORN_ROAST, NOW).skip, 'internal')
  })

  it('queues an unknown-locality public event for review', () => {
    const ev = {
      ...PADDLE_MOGADORE,
      SUMMARY: 'Paddle Outing',
      UID: 'x-1@akronpowersquadron.com',
      LOCATION: 'River Access, 1 Dock Rd, Nowhereville, United States',
    }
    const { row, geo } = normalizeEvent(ev, NOW)
    assert.equal(geo, 'unknown')
    assert.equal(row.status, 'pending_review')
    assert.equal(row.needs_review, true)
  })

  it('drops an out-of-county public event', () => {
    const ev = {
      ...PADDLE_MOGADORE,
      SUMMARY: 'Kayak Cruise',
      UID: 'x-2@akronpowersquadron.com',
      LOCATION: 'Edgewater Park, 6500 Cleveland Memorial Shoreway, Cleveland, OH, 44102, United States',
    }
    assert.equal(normalizeEvent(ev, NOW).skip, 'out_of_county')
  })

  it('drops an event that ended more than a day ago', () => {
    const ev = {
      ...PADDLESMART,
      UID: 'x-3@akronpowersquadron.com',
      DTSTART: { value: '20260101T170000', params: { TZID: 'America/New_York' } },
    }
    assert.equal(normalizeEvent(ev, NOW).skip, 'past')
  })
})
