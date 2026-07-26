/**
 * test-civicplus.js
 *
 * Unit tests for the shared CivicPlus library — covering:
 *   • isPublicCivicPlusEvent — drops meetings, holidays, cancellations
 *   • cleanLocationName      — strips trailing address fragments
 *
 * Run:
 *   node --test scripts/tests/test-civicplus.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import {
  isPublicCivicPlusEvent, cleanLocationName, civicPlusEventUrl, isDateOnlyIcsEvent,
} from '../lib/civicplus.js'
import { normaliseIcsEvent } from '../lib/ics.js'

// ════════════════════════════════════════════════════════════════════════════
// isPublicCivicPlusEvent
// ════════════════════════════════════════════════════════════════════════════

describe('isPublicCivicPlusEvent: drops non-public entries', () => {
  it('drops board / commission / council meetings', () => {
    for (const s of [
      'Building and Zoning Board of Appeals Regular Meeting Agenda',
      'Civil Service Commission Regular Meeting',
      'Planning Commission Meeting',
      'Community Improvement Corporation Meeting',
      'City Council Meeting',
      'City Council Meeting- NO MEETING',
    ]) assert.equal(isPublicCivicPlusEvent(s), false, s)
  })

  it('drops office-closed entries', () => {
    assert.equal(isPublicCivicPlusEvent('Office Closed-Veterans Day'), false)
  })

  it('drops bare municipal closure notices (no public-event word)', () => {
    for (const s of [
      'Closed',
      'Pool Closed',
      'Closed for the Season',
      'Splash Pad Closed',
    ]) assert.equal(isPublicCivicPlusEvent(s), false, s)
  })

  it('drops cancelled events', () => {
    assert.equal(isPublicCivicPlusEvent('Summer Concert - Canceled'), false)
  })

  it('drops bare holiday names', () => {
    assert.equal(isPublicCivicPlusEvent('Veterans Day'), false)
    assert.equal(isPublicCivicPlusEvent('Christmas Day'), false)
  })

  it('drops empty string', () => {
    assert.equal(isPublicCivicPlusEvent(''), false)
  })
})

describe('isPublicCivicPlusEvent: keeps public events', () => {
  it('keeps community festivals and markets', () => {
    for (const s of [
      'Stow City Wide Trick-or-Treat',
      'Joshua Stow Festival',
      'Firecracker Run',
      'Hudson Farmers Market',
      'Touch a Truck',
      'Old Fashioned 4th of July',
      'Lakeside Oktoberfest',
    ]) assert.equal(isPublicCivicPlusEvent(s), true, s)
  })

  it('keeps concert-series and outdoor music events', () => {
    for (const s of [
      'Hudson Bandstand - Clocktower',
      'Screen on the Green - Hook',
      'Music on the Circle - Revolution Pie (Beatles Tribute)',
      'Music by the Lake: Teddy Robb',
    ]) assert.equal(isPublicCivicPlusEvent(s), true, s)
  })

  it('keeps holiday ceremonies (holiday word + ceremony context)', () => {
    assert.equal(isPublicCivicPlusEvent('Veterans Day Ceremony'), true)
  })

  it('keeps a "closed" title that also carries a public-event word', () => {
    // The closure guard must not swallow real events that mention a closure.
    assert.equal(isPublicCivicPlusEvent('Fall Festival - Roads Closed'), true)
    assert.equal(isPublicCivicPlusEvent('Road Closure Cleanup Festival'), true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// isDateOnlyIcsEvent — flag all-day / date-only VEVENTs (never trust midnight)
// ════════════════════════════════════════════════════════════════════════════

describe('isDateOnlyIcsEvent', () => {
  it('true for a VALUE=DATE all-day DTSTART', () => {
    assert.equal(isDateOnlyIcsEvent({ DTSTART: { value: '20260731', params: { VALUE: 'DATE' } } }), true)
  })
  it('true for a bare 8-char date DTSTART (no VALUE param, no T)', () => {
    assert.equal(isDateOnlyIcsEvent({ DTSTART: { value: '20260801', params: {} } }), true)
  })
  it('false for a timed DTSTART', () => {
    assert.equal(isDateOnlyIcsEvent({ DTSTART: { value: '20260731T190000', params: { TZID: 'America/New_York' } } }), false)
  })
  it('false when DTSTART is missing', () => {
    assert.equal(isDateOnlyIcsEvent({}), false)
    assert.equal(isDateOnlyIcsEvent({ DTSTART: null }), false)
  })
})

// The real ingest composition from runCivicPlusScraper: build the row with
// normaliseIcsEvent, then flag needs_review iff the VEVENT is date-only. These
// tests exercise that exact two-step path (not a fork of it).
describe('CivicPlus row: date-only VEVENTs flag needs_review, keep the date', () => {
  function buildAndFlag(ev) {
    const row = normaliseIcsEvent(ev, { source: 'test_city' })
    if (isDateOnlyIcsEvent(ev)) row.needs_review = true
    return row
  }

  it('flags an all-day VALUE=DATE event and preserves the (untrusted midnight) date', () => {
    const row = buildAndFlag({
      SUMMARY: 'City-Wide Scavenger Hunt', UID: '9001',
      DTSTART: { value: '20260731', params: { VALUE: 'DATE' } },
    })
    assert.equal(row.needs_review, true)
    // The date survives; the time is the synthesized midnight ET (04:00Z in EDT).
    assert.equal(row.start_at, '2026-07-31T04:00:00.000Z')
  })

  it('flags a bare 8-char date event', () => {
    const row = buildAndFlag({
      SUMMARY: 'Summer Reading Kickoff', UID: '9002',
      DTSTART: { value: '20260801', params: {} },
    })
    assert.equal(row.needs_review, true)
  })

  it('does NOT force needs_review on a normal timed event', () => {
    const row = buildAndFlag({
      SUMMARY: 'Concert on the Green', UID: '9003',
      DTSTART: { value: '20260731T190000', params: { TZID: 'America/New_York' } },
    })
    assert.equal(row.needs_review, undefined)
    // 7:00 PM ET in July (EDT, UTC-4) → 23:00Z — a real, trusted time.
    assert.equal(row.start_at, '2026-07-31T23:00:00.000Z')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// cleanLocationName
// ════════════════════════════════════════════════════════════════════════════

describe('cleanLocationName', () => {
  it('strips trailing address from plain venue name', () => {
    assert.equal(
      cleanLocationName('Tallmadge Circle Park - 10 Tallmadge Circle  Tallmadge OH 44278'),
      'Tallmadge Circle Park',
    )
  })

  it('converts > sub-location separator to dash', () => {
    assert.equal(
      cleanLocationName('Stow City Hall > Council Chambers - 3760 Darrow Road  Stow OH 44224'),
      'Stow City Hall - Council Chambers',
    )
  })

  it('strips address when venue has no sub-location', () => {
    assert.equal(
      cleanLocationName('The AMP - 1680 Norton Rd.  Stow OH 44224'),
      'The AMP',
    )
  })

  it('strips a word-first street address (no leading number)', () => {
    // Regression: "First Street" starts with a letter, so the old digit-only
    // split left the address glued onto the venue name.
    assert.equal(
      cleanLocationName('<p>First &amp; Main Green</p> - First Street  Hudson OH 44236'),
      'First & Main Green',
    )
  })

  it('keeps a hyphenated name that has no address after it', () => {
    assert.equal(cleanLocationName('Kent - Ravenna Community Room'), 'Kent - Ravenna Community Room')
  })

  it('returns null for address-only strings', () => {
    assert.equal(cleanLocationName(' -   Stow OH 44224'), null)
  })

  it('returns null when a full description was crammed into LOCATION (Copley Game Night)', () => {
    // A CMS data-entry error: the LOCATION field holds a paragraph, not a venue.
    const junk = '<p>Copley Heritage Day kicks off this evening with Game Night at Brighten ' +
      'Brewing Company! Cornhole and euchre tournaments will be held, registration beginning ' +
      'at 6:30.</p> - 1374 S. Cleveland-Massillon Rd  Copley OH 44321'
    assert.equal(cleanLocationName(junk), null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// civicPlusEventUrl — reconstruct the real event-detail deep link
// ════════════════════════════════════════════════════════════════════════════

describe('civicPlusEventUrl', () => {
  it('builds /calendar.aspx?EID=<UID> from a numeric UID', () => {
    assert.equal(
      civicPlusEventUrl({ UID: '5211' }, 'https://www.hudson.oh.us'),
      'https://www.hudson.oh.us/calendar.aspx?EID=5211',
    )
  })

  it('trims whitespace and a trailing slash on origin', () => {
    assert.equal(
      civicPlusEventUrl({ UID: ' 763 ' }, 'https://www.newfranklin.org/'),
      'https://www.newfranklin.org/calendar.aspx?EID=763',
    )
  })

  it('returns null for a non-numeric UID (falls back to normalised URL)', () => {
    assert.equal(civicPlusEventUrl({ UID: 'abc-guid' }, 'https://x.com'), null)
  })

  it('returns null when UID or origin is missing', () => {
    assert.equal(civicPlusEventUrl({}, 'https://x.com'), null)
    assert.equal(civicPlusEventUrl({ UID: '10' }, ''), null)
  })
})

describe('cleanLocationName handles multi-block HTML LOCATION (Richfield fix 2026-07-09)', () => {
  it('keeps only the first block when name and address live in separate <p> blocks', () => {
    // Real Richfield LOCATION: stripHtml alone glues the blocks into
    // "Village Green Pavilion Corner of Route 303 & Broadview Rd" with no
    // " - " boundary, minting the whole string as a junk venue name.
    assert.equal(
      cleanLocationName(
        '<p><span style="color: rgb(0, 0, 0)">Village Green Pavilion</span></p><p>Corner of Route 303 &amp; Broadview Rd</p>',
      ),
      'Village Green Pavilion',
    )
  })

  it('splits on an em dash before a street address (Richfield uses — not -)', () => {
    assert.equal(
      cleanLocationName('Eastwood Preserve — 4712 W. Streetsboro Rd'),
      'Eastwood Preserve',
    )
  })

  it('keeps a parenthetical venue name intact', () => {
    assert.equal(
      cleanLocationName('Jan Weber Social Center (Formerly Richfield Senior Center)'),
      'Jan Weber Social Center (Formerly Richfield Senior Center)',
    )
  })

  it('still strips a hyphen-separated address on a single-block LOCATION', () => {
    assert.equal(
      cleanLocationName('Village Hall - 4410 W. Streetsboro Road Richfield OH 44286'),
      'Village Hall',
    )
  })
})

describe('cleanLocationName rejects schedule prose (Springfield Twp fix 2026-07-08)', () => {
  it('a clock time anywhere in the string is not a venue', () => {
    assert.equal(cleanLocationName('Beginners 10AM then it advances from 10:30 Am on to 1:30 PM'), null)
    assert.equal(cleanLocationName('Doors open 6:30 pm at the pavilion'), null)
  })
  it('still accepts real venue names with plain numbers', () => {
    assert.equal(cleanLocationName('Fire Station 2'), 'Fire Station 2')
    assert.equal(cleanLocationName('Townhall'), 'Townhall')
  })
})
