/**
 * test-islamic-society-akron.js
 *
 * Locks the ISAK (Islamic Society of Akron & Kent) scraper's pure logic:
 *   • the category-driven faith allowlist (public buckets in, internal/youth out,
 *     neutral categories deferring to the shared+supplemental text allowlist),
 *   • mosque sub-venue canonicalization and the per-event Summit gate inputs,
 *   • Eastern wall-clock date mapping (the site's timezone is misconfigured to
 *     UTC+0, so start_date holds the local wall-clock time),
 *   • source_id stability, content-category and is_fundraiser mapping.
 *
 * Fixtures are trimmed from live http://isak.us/wp-json/tribe/events/v1 payloads.
 *
 * Run:  node --test scripts/tests/test-islamic-society-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, isPublicISAKEvent, resolveVenue, parseCategory,
  parseIsFundraiser, buildSourceId,
} = await import('../scrape-islamic-society-akron.js')

import { easternToIso } from '../lib/normalize.js'
import { classifySummitLocation } from '../lib/summit-county.js'

// ── Faith allowlist ─────────────────────────────────────────────────────────

describe('isPublicISAKEvent — public categories auto-include', () => {
  it('Outreach / Eid / Fundraiser buckets are public', () => {
    assert.equal(isPublicISAKEvent('Teatime for Peace at ISAK', '', ['Outreach Programming']), true)
    assert.equal(isPublicISAKEvent('Eid Festival', '', ['Eid Celebration']), true)
    assert.equal(isPublicISAKEvent('2026 Eid al-Fitr Prayer Services', '', ['Eid Celebration']), true)
    assert.equal(isPublicISAKEvent('One Ummah, One Heart: Together for Gaza Fundraiser', '',
      ['Fundraiser', 'Outreach Programming']), true)
  })
})

describe('isPublicISAKEvent — internal categories hard-skip', () => {
  it('worship / class / youth programming is skipped', () => {
    assert.equal(isPublicISAKEvent('Jummah Prayer – July 18th, 2025', '', ['Jummah Services']), false)
    assert.equal(isPublicISAKEvent("Children’s Maktab Program", '', ['Youth Services']), false)
    assert.equal(isPublicISAKEvent('Weekly Qur’an Tafsir', '', ['Classes']), false)
    assert.equal(isPublicISAKEvent('Gems from Seerah', '', ['Halaqa']), false)
  })
  it('an audience-targeted category vetoes a public keyword (strict)', () => {
    // "Reverts' Potluck Iftar" is a members-only Convert Services program — the
    // "iftar" keyword must NOT rescue it.
    assert.equal(isPublicISAKEvent("Reverts’ Potluck Iftar", '', ['Convert Services']), false)
    // A youth iftar dinner is still a youth program.
    assert.equal(isPublicISAKEvent('ISAK LINKS Iftar Dinner', '', ['Youth Services']), false)
    // PRIVATE wins even when a PUBLIC category co-occurs.
    assert.equal(isPublicISAKEvent('Ramadan Madness', '', ['Fundraiser', 'Youth Services']), false)
  })
})

describe('isPublicISAKEvent — neutral categories defer to text allowlist', () => {
  it('community iftars and bazaars in Programs/Ramadan are caught', () => {
    assert.equal(isPublicISAKEvent('ISAK Community Iftar', '', ['Ramadan']), true)      // "iftar" supplement
    assert.equal(isPublicISAKEvent('Fall Bazaar & Seminar 2025', '', ['Programs']), true) // shared "bazaar"
    assert.equal(isPublicISAKEvent('Ramadan Bazaar', '', ['Programs']), true)
  })
  it('internal Ramadan/Programs items with no public signal are skipped', () => {
    assert.equal(isPublicISAKEvent('Ramadan Recharge', '', ['Ramadan']), false)
    assert.equal(isPublicISAKEvent('General Assembly Meeting', '', ['Programs']), false)
    assert.equal(isPublicISAKEvent('The Fajr Club', '', ['Programs']), false)
  })
  it('interfaith keyword is honored', () => {
    assert.equal(isPublicISAKEvent('Akron Area Interfaith Council Summer Potluck', '', []), true)
  })
})

// ── Venue resolution + Summit gate ──────────────────────────────────────────

const MOSQUE_TRIBE_VENUE = {
  venue: 'ISAK Prayer Hall', slug: 'isak-prayer-hall',
  address: '152 E. Steels Corners Rd', city: 'Cuyahoga Falls', state: 'OH', zip: '44224',
}
const LEDGES_TRIBE_VENUE = {
  venue: 'Ledges Trailhead', slug: 'ledges-trailhead',
  address: '701 Truxell Road', city: 'Peninsula', state: 'OH', zip: '44264',
}
const OUT_OF_COUNTY_VENUE = {
  venue: 'The Ummah Center', slug: 'ummah-center',
  address: '24050 Royalton Rd', city: 'Columbia Station,', state: 'OH', zip: '44028',
}

describe('resolveVenue', () => {
  it('collapses mosque sub-venues onto the canonical ISAK record', () => {
    const r = resolveVenue(MOSQUE_TRIBE_VENUE)
    assert.equal(r.name, 'Islamic Society of Akron & Kent')
    assert.equal(r.city, 'Cuyahoga Falls')
    assert.equal(r.details.address, '152 E Steels Corners Rd')
  })
  it('defaults a missing venue to the mosque', () => {
    const r = resolveVenue(null)
    assert.equal(r.name, 'Islamic Society of Akron & Kent')
    assert.equal(r.city, 'Cuyahoga Falls')
  })
  it('keeps an external venue with its own name/city', () => {
    const r = resolveVenue(LEDGES_TRIBE_VENUE)
    assert.equal(r.name, 'Ledges Trailhead')
    assert.equal(r.city, 'Peninsula')
  })
  it('strips the trailing comma the feed leaves on some cities', () => {
    assert.equal(resolveVenue(OUT_OF_COUNTY_VENUE).city, 'Columbia Station')
  })
})

describe('Summit gate over resolved venues', () => {
  it('mosque + Ledges (Peninsula) are in-county; Columbia Station is not', () => {
    assert.equal(classifySummitLocation({ city: resolveVenue(MOSQUE_TRIBE_VENUE).city }), 'in')
    assert.equal(classifySummitLocation({ city: resolveVenue(LEDGES_TRIBE_VENUE).city }), 'in')
    // Columbia Station (Lorain County) is unrecognized → 'unknown' → pending_review.
    assert.equal(classifySummitLocation({ city: resolveVenue(OUT_OF_COUNTY_VENUE).city }), 'unknown')
  })
})

// ── Eastern wall-clock (QUIRK 1) ────────────────────────────────────────────

describe('start_date parsed as Eastern wall-clock, not UTC', () => {
  it('a 3:00 PM July event → 19:00Z (EDT, UTC-4), never 11:00Z', () => {
    // Live payload: start_date "2026-07-19 15:00:00" for an event the description
    // states is at 3:00 PM. utc_start_date is a broken duplicate; we ignore it.
    assert.equal(easternToIso('2026-07-19 15:00:00'), '2026-07-19T19:00:00.000Z')
  })
  it('a winter event honors EST (UTC-5)', () => {
    assert.equal(easternToIso('2026-02-21 18:00:00'), '2026-02-21T23:00:00.000Z')
  })
})

// ── source_id, category, fundraiser ─────────────────────────────────────────

describe('buildSourceId', () => {
  it('appends the local start date so recurring occurrences stay distinct', () => {
    assert.equal(buildSourceId({ id: 31596, start_date: '2026-07-19 15:00:00' }), '31596-2026-07-19')
  })
  it('falls back to utc_start_date, then the bare id', () => {
    assert.equal(buildSourceId({ id: 7, utc_start_date: '2026-03-07 18:00:00' }), '7-2026-03-07')
    assert.equal(buildSourceId({ id: 99 }), '99')
  })
})

describe('parseCategory', () => {
  it('Eid celebrations map to festival', () => {
    assert.equal(parseCategory(['Eid Celebration'], 'Eid Festival', ''), 'festival')
  })
  it('other events defer to inference, falling back to other', () => {
    const c = parseCategory(['Outreach Programming'], 'Postcards for Palestinian Prisoners', '')
    assert.ok(typeof c === 'string' && c.length > 0)
  })
})

describe('parseIsFundraiser', () => {
  it('true for the Fundraiser category and fundraiser/hunger-walk text', () => {
    assert.equal(parseIsFundraiser(['Fundraiser'], 'Annual Fundraising Iftar', ''), true)
    assert.equal(parseIsFundraiser(['Outreach Programming'], '17th Annual AAIC Hunger Walk', ''), true)
  })
  it('undefined (not false) when absent', () => {
    assert.equal(parseIsFundraiser(['Outreach Programming'], 'Teatime for Peace', ''), undefined)
  })
})

describe('SOURCE_KEY', () => {
  it('is islamic_society_akron', () => {
    assert.equal(SOURCE_KEY, 'islamic_society_akron')
  })
})
