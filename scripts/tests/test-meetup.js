/**
 * test-meetup.js — location parsing + the Summit County gate for the Meetup
 * iCal scraper. The behavioral contract: events with no resolvable in-county
 * location (TBD / online / elsewhere) must NOT pass the gate; a real Summit
 * County address must.
 *
 * Run:  node --test scripts/tests/test-meetup.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseEventGeo, parseVenue, KNOWN_GROUPS } = await import('../scrape-meetup.js')
const { parseIcs } = await import('../lib/ics.js')
const { isSummitCountyLocation } = await import('../lib/summit-county.js')

// A feed with the four shapes that matter: TBD (no LOCATION), online,
// in-Summit-County address, and an out-of-county address.
const FEED = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Meetup//Meetup Calendar 1.0//EN
BEGIN:VEVENT
UID:event_1@meetup.com
DTSTART;TZID=America/New_York:20260701T180000
DTEND;TZID=America/New_York:20260701T200000
SUMMARY:Weekly Evening Hike- Location TBD
END:VEVENT
BEGIN:VEVENT
UID:event_2@meetup.com
DTSTART;TZID=America/New_York:20260702T180000
SUMMARY:Online UX Talk
LOCATION:Online event
END:VEVENT
BEGIN:VEVENT
UID:event_3@meetup.com
DTSTART;TZID=America/New_York:20260703T180000
SUMMARY:Board Game Night
LOCATION:Akron Civic Theatre\\, 182 S Main St\\, Akron\\, OH 44308
END:VEVENT
BEGIN:VEVENT
UID:event_4@meetup.com
DTSTART;TZID=America/New_York:20260704T180000
SUMMARY:Cleveland Meetup
LOCATION:Some Hall\\, 100 Public Sq\\, Cleveland\\, OH 44113
END:VEVENT
BEGIN:VEVENT
UID:event_5@meetup.com
DTSTART;TZID=America/New_York:20260705T180000
SUMMARY:Coffee in Akron
LOCATION:Akron\\, OH
END:VEVENT
END:VCALENDAR`

const byUid = Object.fromEntries(parseIcs(FEED).map((e) => [e.UID, e]))

describe('parseEventGeo', () => {
  it('TBD event (no LOCATION) → no city/coords', () => {
    assert.deepEqual(parseEventGeo(byUid['event_1@meetup.com']), { lat: null, lng: null, city: null, loc: '' })
  })
  it('online event → no city', () => {
    assert.equal(parseEventGeo(byUid['event_2@meetup.com']).city, null)
  })
  it('full address → extracts the city', () => {
    assert.equal(parseEventGeo(byUid['event_3@meetup.com']).city, 'Akron')
    assert.equal(parseEventGeo(byUid['event_4@meetup.com']).city, 'Cleveland')
  })
  it('city-only location → extracts the city', () => {
    assert.equal(parseEventGeo(byUid['event_5@meetup.com']).city, 'Akron')
  })
  it('reads GEO lat;lng and ignores 0;0', () => {
    assert.deepEqual(
      { ...parseEventGeo({ GEO: '41.08;-81.51' }), loc: undefined, city: undefined },
      { lat: 41.08, lng: -81.51, loc: undefined, city: undefined },
    )
    assert.equal(parseEventGeo({ GEO: '0;0' }).lat, null)
  })
})

describe('Summit County gate (the posting contract)', () => {
  const gated = (uid) => isSummitCountyLocation(parseEventGeo(byUid[uid]))
  it('does NOT post TBD or online events', () => {
    assert.equal(gated('event_1@meetup.com'), false) // TBD
    assert.equal(gated('event_2@meetup.com'), false) // online
  })
  it('posts an in-Summit-County address', () => {
    assert.equal(gated('event_3@meetup.com'), true)  // Akron
    assert.equal(gated('event_5@meetup.com'), true)  // Akron (city-only)
  })
  it('does NOT post an out-of-county address', () => {
    assert.equal(gated('event_4@meetup.com'), false) // Cleveland
  })
})

describe('parseVenue', () => {
  it('extracts name + street from a full address', () => {
    assert.deepEqual(parseVenue('Akron Civic Theatre, 182 S Main St, Akron, OH 44308', 'Akron'),
      { name: 'Akron Civic Theatre', street: '182 S Main St' })
  })
  it('returns null for a city-only location (no venue literally named "Akron")', () => {
    assert.equal(parseVenue('Akron, OH', 'Akron'), null)
  })
  it('returns null for empty', () => {
    assert.equal(parseVenue('', null), null)
  })
})

describe('KNOWN_GROUPS', () => {
  it('every group has a slug, label, and tag', () => {
    assert.ok(KNOWN_GROUPS.length >= 1)
    for (const g of KNOWN_GROUPS) {
      assert.ok(g.slug && g.label && g.tag, `incomplete group: ${JSON.stringify(g)}`)
    }
  })
  it('slugs are unique', () => {
    const slugs = KNOWN_GROUPS.map((g) => g.slug)
    assert.equal(new Set(slugs).size, slugs.length)
  })
})
