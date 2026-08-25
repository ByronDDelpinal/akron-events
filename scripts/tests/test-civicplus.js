/**
 * test-civicplus.js
 *
 * Unit tests for the shared CivicPlus library — covering:
 *   • isPublicCivicPlusEvent — drops meetings, holidays, cancellations
 *   • cleanLocationName      — strips trailing address fragments
 *   • parseCivicPlusLocation — cleanLocationName's {name, address} superset
 *
 * Run:
 *   node --test scripts/tests/test-civicplus.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import {
  isPublicCivicPlusEvent, cleanLocationName, parseCivicPlusLocation, civicPlusEventUrl, isDateOnlyIcsEvent,
} from '../lib/civicplus.js'
import { normaliseIcsEvent, parseIcs, salvagedDescriptionUrl } from '../lib/ics.js'

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

  it('flags an all-day VALUE=DATE event and defaults it to noon ET', () => {
    const row = buildAndFlag({
      SUMMARY: 'City-Wide Scavenger Hunt', UID: '9001',
      DTSTART: { value: '20260731', params: { VALUE: 'DATE' } },
    })
    // Noon is a sanctioned default, not a confirmed time, so the flag stays.
    assert.equal(row.needs_review, true)
    // SANCTIONED-DEFAULT-TIME: the date survives and the clock is noon ET
    // (16:00Z in EDT). It is deliberately NOT the old 04:00Z midnight, which
    // dropped the row out of every feed at 00:00:01 on the event's own day.
    assert.equal(row.start_at, '2026-07-31T16:00:00.000Z')
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

// A real CivicPlus VEVENT: the DESCRIPTION is the event permalink and nothing
// else. Ingested verbatim it became the event's description, so the card, the
// RSS item and the SEO meta tag all read as a raw link. These tests run the
// same two steps runCivicPlusScraper does — normaliseIcsEvent, then the
// civicPlusEventUrl deep-link overwrite.
describe('CivicPlus row: permalink-only DESCRIPTION, numeric UID (deep link re-minted)', () => {
  const ORIGIN = 'https://www.springfieldtownship.us'
  const FEED = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:5152',
    'SUMMARY:Summer Concert Series',
    'DTSTART;TZID=America/New_York:20260731T190000',
    'DTEND;TZID=America/New_York:20260731T210000',
    'DESCRIPTION:https://www.springfieldtownship.us/calendar.aspx?EID=5152',
    'URL:/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  function buildRow() {
    const [ev] = parseIcs(FEED)
    const row = normaliseIcsEvent(ev, { source: 'springfield_township', linkBaseUrl: ORIGIN })
    const eventUrl = civicPlusEventUrl(ev, ORIGIN)
    if (eventUrl) {
      row.ticket_url = eventUrl
      row.source_url = eventUrl
    }
    return row
  }

  it('stores no description at all', () => {
    assert.equal(buildRow().description, null)
  })

  it('still links straight to the event detail page', () => {
    const row = buildRow()
    assert.equal(row.ticket_url, 'https://www.springfieldtownship.us/calendar.aspx?EID=5152')
    assert.equal(row.source_url, 'https://www.springfieldtownship.us/calendar.aspx?EID=5152')
  })

  it('leaves the rest of the row untouched', () => {
    const row = buildRow()
    assert.equal(row.title, 'Summer Concert Series')
    assert.equal(row.start_at, '2026-07-31T23:00:00.000Z')
    assert.equal(row.source_id, '5152')
  })
})

// The case above passes whether or not the salvage exists: UID 5152 is numeric,
// so civicPlusEventUrl re-mints the identical link and overwrites ticket_url
// regardless. THIS block is the one that actually exercises the salvage. A
// non-numeric UID makes civicPlusEventUrl return null, and every CivicPlus
// VEVENT sets URL to the broken whole-feed download link — so the permalink
// that normaliseIcsEvent lifted out of the DESCRIPTION is the only working link
// left. Delete the `|| salvagedDescriptionUrl(ev)` fallback in civicplus.js and
// these assertions fail.
describe('CivicPlus row: permalink-only DESCRIPTION, non-numeric UID (salvage is the only link)', () => {
  const ORIGIN = 'https://www.springfieldtownship.us'
  const FEED = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:abc-123',
    'SUMMARY:Fall Festival',
    'DTSTART;TZID=America/New_York:20260731T190000',
    'DESCRIPTION:https://www.springfieldtownship.us/calendar.aspx?EID=9001',
    'URL:/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  // Mirrors runCivicPlusScraper's ticket_url step exactly (civicplus.js).
  function buildRow() {
    const [ev] = parseIcs(FEED)
    const row = normaliseIcsEvent(ev, { source: 'springfield_township', linkBaseUrl: ORIGIN })
    const eventUrl = civicPlusEventUrl(ev, ORIGIN) || salvagedDescriptionUrl(ev)
    if (eventUrl) {
      row.ticket_url = eventUrl
      row.source_url = eventUrl
    }
    return row
  }

  it('cannot re-mint a deep link from a non-numeric UID', () => {
    const [ev] = parseIcs(FEED)
    assert.equal(civicPlusEventUrl(ev, ORIGIN), null)
  })

  it('normaliseIcsEvent alone would keep the broken whole-feed link', () => {
    // The regression this guards: ev.URL is always truthy on CivicPlus, so
    // normaliseIcsEvent's own `absolutiseIcsUrl(...) || salvaged` fallback is
    // dead here and the permalink is lost unless the caller reaches for it.
    const [ev] = parseIcs(FEED)
    const row = normaliseIcsEvent(ev, { source: 'springfield_township', linkBaseUrl: ORIGIN })
    assert.equal(
      row.ticket_url,
      'https://www.springfieldtownship.us/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar'
    )
  })

  it('the scraper links to the salvaged permalink, not the feed download', () => {
    const row = buildRow()
    assert.equal(row.description, null)
    assert.equal(row.ticket_url, 'https://www.springfieldtownship.us/calendar.aspx?EID=9001')
    assert.equal(row.source_url, 'https://www.springfieldtownship.us/calendar.aspx?EID=9001')
    assert.ok(!/iCalendar\.aspx/.test(row.ticket_url))
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

// ════════════════════════════════════════════════════════════════════════════
// parseCivicPlusLocation — cleanLocationName's {name, address} superset
// ════════════════════════════════════════════════════════════════════════════

describe('parseCivicPlusLocation', () => {
  it('splits a plain "Name - Street  City ST ZIP" LOCATION into name + address', () => {
    assert.deepEqual(
      parseCivicPlusLocation('Tallmadge Circle Park - 10 Tallmadge Circle  Tallmadge OH 44278'),
      { name: 'Tallmadge Circle Park', address: '10 Tallmadge Circle' },
    )
  })

  it('splits a "Building > Room - Street  City ST ZIP" LOCATION into name + address', () => {
    assert.deepEqual(
      parseCivicPlusLocation('Stow City Hall > Council Chambers - 3760 Darrow Road  Stow OH 44224'),
      { name: 'Stow City Hall - Council Chambers', address: '3760 Darrow Road' },
    )
  })

  it('populates address on an em-dash LOCATION with no City/ST/ZIP tail', () => {
    const { name, address } = parseCivicPlusLocation('Eastwood Preserve — 4712 W. Streetsboro Rd')
    assert.equal(name, 'Eastwood Preserve')
    assert.equal(address, '4712 W. Streetsboro Rd')
  })

  it('leaves address null for multi-block HTML LOCATION (Richfield name/address <p> split)', () => {
    // The address lives in a SEPARATE block from the venue name — a different,
    // unrelated shape that this function does not attempt to parse (only the
    // first block is ever inspected for a dash boundary).
    assert.deepEqual(
      parseCivicPlusLocation(
        '<p><span style="color: rgb(0, 0, 0)">Village Green Pavilion</span></p><p>Corner of Route 303 &amp; Broadview Rd</p>',
      ),
      { name: 'Village Green Pavilion', address: null },
    )
  })

  it('leaves address null when LOCATION has no dash boundary', () => {
    assert.deepEqual(
      parseCivicPlusLocation('Hudson Green'),
      { name: 'Hudson Green', address: null },
    )
  })

  it('name matches cleanLocationName for every pre-existing case', () => {
    for (const raw of [
      'Tallmadge Circle Park - 10 Tallmadge Circle  Tallmadge OH 44278',
      'Stow City Hall > Council Chambers - 3760 Darrow Road  Stow OH 44224',
      'The AMP - 1680 Norton Rd.  Stow OH 44224',
      '<p>First &amp; Main Green</p> - First Street  Hudson OH 44236',
      'Kent - Ravenna Community Room',
      ' -   Stow OH 44224',
      'Eastwood Preserve — 4712 W. Streetsboro Rd',
      'Jan Weber Social Center (Formerly Richfield Senior Center)',
      'Village Hall - 4410 W. Streetsboro Road Richfield OH 44286',
      'Beginners 10AM then it advances from 10:30 Am on to 1:30 PM',
      'Fire Station 2',
      null,
      undefined,
      '',
    ]) {
      assert.equal(parseCivicPlusLocation(raw).name, cleanLocationName(raw), raw)
    }
  })

  it('returns {name: null, address: null} for a rejected LOCATION', () => {
    assert.deepEqual(parseCivicPlusLocation(' -   Stow OH 44224'), { name: null, address: null })
    assert.deepEqual(parseCivicPlusLocation(null), { name: null, address: null })
  })

  // ── Review gaps (2026-08-18) ────────────────────────────────────────────

  it('decodes HTML entities in the recovered address instead of storing them raw', () => {
    // sPreserved is tag-stripped only (see the comment above its two
    // assignments); skipping decodeEntities on that path would leak
    // "&amp;"/"&#39;" straight into the stored address — the same
    // HTML-in-stored-data defect this project already fixed for venue names.
    assert.deepEqual(
      parseCivicPlusLocation('First Church - 500 Main St &amp; 5th Ave  Akron OH 44301'),
      { name: 'First Church', address: '500 Main St & 5th Ave' },
    )
    assert.deepEqual(
      parseCivicPlusLocation("First Church - 500 O&#39;Brien Ave  Akron OH 44301"),
      { name: 'First Church', address: "500 O'Brien Ave" },
    )
  })

  it('strips an "&nbsp;"-separated City/ST/ZIP tail instead of storing it as part of the address', () => {
    // This project's NAMED_ENTITIES table maps nbsp to a plain ASCII space
    // (normalize.js), so decoding "&nbsp;&nbsp;" lands on the same
    // double-space boundary a literal "  " separator would — the tail-strip
    // below sees it and cuts there, rather than storing the whole
    // "<street>&nbsp;&nbsp;<city> <state> <zip>" tail as prose-shaped junk
    // the geocoder's precision gate would never catch.
    assert.deepEqual(
      parseCivicPlusLocation('Village Hall - 4410 W. Streetsboro Road&nbsp;&nbsp;Richfield OH 44286'),
      { name: 'Village Hall', address: '4410 W. Streetsboro Road' },
    )
  })

  it('returns a null address (never a best-effort string) when the tail cannot be confidently stripped', () => {
    // No double space and no "&nbsp;" boundary before "Richfield" — the
    // fallback City/ST/ZIP stripper over-matches and leaves an unusably
    // short fragment. ensureVenue overwrites `address` unconditionally on
    // every re-scrape of an existing venue, so a wrong address here would
    // silently clobber a previously-correct one; null is the only safe
    // output when the parse is this uncertain.
    const { address } = parseCivicPlusLocation('Village Hall - 4410 W. Streetsboro Road Richfield OH 44286')
    assert.equal(address, null)
  })

  it('splits at the dash that precedes the street address, not the first dash in a venue name', () => {
    // The venue name itself carries a dash ("Stow City Hall - North
    // Annex"). `name` still cuts at the FIRST dash — cleanLocationName's
    // output for this input must stay byte-identical to today's behavior —
    // but the address must NOT inherit that same boundary, or it picks up
    // "North Annex" as if it were part of the street address.
    assert.deepEqual(
      parseCivicPlusLocation('Stow City Hall - North Annex - 3760 Darrow Road  Stow OH 44224'),
      { name: 'Stow City Hall', address: '3760 Darrow Road' },
    )
  })
})
