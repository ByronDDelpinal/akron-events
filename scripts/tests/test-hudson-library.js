/**
 * test-hudson-library.js — pure parsers for the Hudson Library
 * (EngagedPatrons.org) scraper. Network fetch + upsert are integration
 * concerns and are not unit-tested here.
 *
 * Fixtures are real snippets captured from engagedpatrons.org (SiteID=3850).
 *
 * Run:  node --test scripts/tests/test-hudson-library.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  encodeImageUrl, parseListDate, parseListTime, mapCategory, parseIsFamily,
  parseListPage, parseDetailJsonLd, buildRow, SOURCE_KEY,
} = await import('../scrape-hudson-library.js')

const NOW = new Date('2026-07-10T12:00:00Z') // anchor year deterministically

// Real detail-page JSON-LD block (Teen Creative Studio, EventID 586273).
const DETAIL_HTML = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "Teen Creative Studio: Build Your Own Dinosaur",
  "startDate": "2026-07-17T15:00-05:00",
  "endDate": "2026-07-17T15:00-05:00",
  "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
  "eventStatus": "https://schema.org/EventScheduled",
  "location": {
    "@type": "Place",
    "name": "Hudson Library & Historical Society",
    "address": { "@type": "PostalAddress", "streetAddress": "96 Library St. ",
      "addressLocality": "Hudson", "postalCode": "44236", "addressRegion": "OH", "addressCountry": "US" }
  },
  "image": [ "https://engagedpatrons.org/clientimages/3850/July Build Your Own Dino (1).jpg" ],
  "description": "Bring a dinosaur to life using recycled materials!&nbsp;",
  "organizer": { "@type": "Organization", "name": "Hudson Library & Historical Society", "url": "https://www.hudsonlibrary.org" },
  "offers": "",
  "performer": ""
}
</script>`

// Real list markup: two wrappers (a single-occurrence event + a recurring one).
const LIST_HTML = `
<div class="LEEventWrapper">
  <div class="LEGraphicDiv"><a href="EventsExtended.cfm?SiteID=3850&EventID=586273&PK="><img class="LEGraphic" src="/clientimages/3850/July Build Your Own Dino (1).jpg" alt="Teen"></a></div>
  <div class="LETitle"><a href="EventsExtended.cfm?SiteID=3850&EventID=586273&PK=">Teen Creative Studio: Build Your Own Dinosaur</a></div>
  <div class="LEDate LEAgeRange">Friday, Jul. 17, 3-4</div>
</div>
<div class="LEEventWrapper">
  <div class="LETitle"><a href="EventsExtended.cfm?SiteID=3850&EventID=588551&PK=955652">Family Drop-In Storytime</a></div>
  <div class="LEDate LEAgeRange">Wednesday, Jul. 15, 10:00 a.m.</div>
</div>`

describe('encodeImageUrl', () => {
  it('encodes spaces but leaves parens', () => {
    assert.equal(
      encodeImageUrl('https://engagedpatrons.org/clientimages/3850/July Build Your Own Dino (1).jpg'),
      'https://engagedpatrons.org/clientimages/3850/July%20Build%20Your%20Own%20Dino%20(1).jpg',
    )
    assert.equal(encodeImageUrl(null), null)
  })
})

describe('parseListDate', () => {
  it('parses "Weekday, Mon. DD" with the year inferred', () => {
    assert.equal(parseListDate('Friday, Jul. 17, 3-4', NOW), '2026-07-17')
    assert.equal(parseListDate('Wednesday, Jul. 15, 10:00 a.m.', NOW), '2026-07-15')
  })
  it('rolls a past month into next year', () => {
    const dec = new Date('2026-12-20T12:00:00Z')
    assert.equal(parseListDate('Saturday, Jan. 9, 2 p.m.', dec), '2027-01-09')
  })
  it('ignores the weekday name and returns null with no month/day', () => {
    assert.equal(parseListDate('Ongoing'), null)
    assert.equal(parseListDate(''), null)
  })
})

describe('parseListTime', () => {
  const cases = [
    ['Tuesday, Jul. 14, 10:00 a.m.',            { startClock: '10:00:00', endClock: null,       startHasMeridiem: true }],
    ['Thursday, Jul. 16, 10 a.m.',              { startClock: '10:00:00', endClock: null,       startHasMeridiem: true }],
    ['Sunday, Jul. 19, 2pm',                    { startClock: '14:00:00', endClock: null,       startHasMeridiem: true }],
    ['Wednesday, Jul. 15, 2:00 pm',             { startClock: '14:00:00', endClock: null,       startHasMeridiem: true }],
    ['Tuesday, Jul. 14, 1-4pm',                 { startClock: '13:00:00', endClock: '16:00:00', startHasMeridiem: true }],
    ['Thursday, Jul. 16, 2:00 p.m. - 4:00 p.m.',{ startClock: '14:00:00', endClock: '16:00:00', startHasMeridiem: true }],
    // meridiem-less range → unresolved (caller falls back to JSON-LD clock)
    ['Friday, Jul. 17, 3-4',                    { startClock: null,       endClock: null,       startHasMeridiem: false }],
  ]
  for (const [text, want] of cases) {
    it(`parses "${text.split(',').slice(2).join(',').trim()}"`, () => {
      assert.deepEqual(parseListTime(text), want)
    })
  }
  it('strips a trailing recurrence parenthetical before parsing', () => {
    assert.deepEqual(
      parseListTime('Monday, Jul. 20, 12pm-1pm (Mondays June 15, 22, 29 & July 6, 13, 20 12:00 - 1:00)'),
      { startClock: '12:00:00', endClock: '13:00:00', startHasMeridiem: true },
    )
    assert.deepEqual(
      parseListTime('Thursday, Jul. 16, 10 a.m. (Thursdays, July 9, 16, 23, 30)'),
      { startClock: '10:00:00', endClock: null, startHasMeridiem: true },
    )
  })
})

describe('mapCategory', () => {
  it('hints library program types', () => {
    assert.equal(mapCategory('Family Drop-In Storytime'), 'learning')
    assert.equal(mapCategory('IN-PERSON: Adult Gentle Flow Yoga'), 'fitness')
    assert.equal(mapCategory('Dungeons & Dragons Group One'), 'games')
    assert.equal(mapCategory('Minecraft Club'), 'games')
    assert.equal(mapCategory('LIVE MUSIC: Young Artist Concert Series'), 'music')
    assert.equal(mapCategory('Science Wednesday: Explosive Science!'), 'learning')
    assert.equal(mapCategory('Scandals of Hudson Walking Tour'), 'learning')
    assert.equal(mapCategory('Memory Café: Pets & Animals'), null)
  })
})

describe('parseIsFamily', () => {
  it('flags kid/family/teen programs from the title', () => {
    assert.equal(parseIsFamily('Family Drop-In Storytime'), true)
    assert.equal(parseIsFamily('Babytime Drop-In'), true)
    assert.equal(parseIsFamily('Zumbini (ages 3-5)'), true)
    assert.equal(parseIsFamily('Teen Creative Studio: Build Your Own Dinosaur'), true)
    assert.equal(parseIsFamily('Minecraft Club'), true)
    assert.equal(parseIsFamily('Grandparents Storytime'), true)
  })
  it('does NOT flag adult-only programs', () => {
    assert.equal(parseIsFamily('IN-PERSON: Adult Gentle Flow Yoga'), undefined)
    assert.equal(parseIsFamily('Staycation Tech Camp for Adults'), undefined)
    assert.equal(parseIsFamily('Virtual Book Club'), undefined)
  })
})

describe('parseListPage', () => {
  it('pairs each wrapper title with its date, keeping EventID + PK', () => {
    const occs = parseListPage(LIST_HTML)
    assert.equal(occs.length, 2)
    assert.deepEqual(occs[0], {
      eventId: '586273', pk: '',
      title: 'Teen Creative Studio: Build Your Own Dinosaur',
      dateText: 'Friday, Jul. 17, 3-4',
    })
    assert.deepEqual(occs[1], {
      eventId: '588551', pk: '955652',
      title: 'Family Drop-In Storytime',
      dateText: 'Wednesday, Jul. 15, 10:00 a.m.',
    })
  })
})

describe('parseDetailJsonLd', () => {
  it('extracts name/description/image + a 24h clock (ignoring the wrong offset)', () => {
    const d = parseDetailJsonLd(DETAIL_HTML)
    assert.equal(d.name, 'Teen Creative Studio: Build Your Own Dinosaur')
    assert.equal(d.description, 'Bring a dinosaur to life using recycled materials!')
    assert.equal(d.image, 'https://engagedpatrons.org/clientimages/3850/July%20Build%20Your%20Own%20Dino%20(1).jpg')
    assert.equal(d.jsonClock, '15:00:00') // clock only; the -05:00 offset is discarded
  })
  it('returns null when no Event JSON-LD is present', () => {
    assert.equal(parseDetailJsonLd('<html>no ld</html>'), null)
  })
})

describe('buildRow', () => {
  const detail = parseDetailJsonLd(DETAIL_HTML)

  it('falls back to the JSON-LD clock when the list time lacks a meridiem', () => {
    const occ = { eventId: '586273', pk: '', title: 'Teen Creative Studio: Build Your Own Dinosaur', dateText: 'Friday, Jul. 17, 3-4' }
    const { row } = buildRow(occ, detail, NOW)
    assert.equal(row.start_at, '2026-07-17T19:00:00.000Z') // 15:00 ET (EDT −4)
    assert.equal(row.end_at, null)                          // ambiguous list end dropped
    assert.equal(row.source_id, '586273-2026-07-17')        // no PK → date-suffixed
    assert.equal(row.price_min, null)                        // never assumed free
    assert.equal(row.price_max, null)
    assert.equal(row.is_family, true)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.image_url, 'https://engagedpatrons.org/clientimages/3850/July%20Build%20Your%20Own%20Dino%20(1).jpg')
  })

  it('uses the per-occurrence list time when it carries a meridiem', () => {
    const occ = { eventId: '588551', pk: '955652', title: 'Family Drop-In Storytime', dateText: 'Wednesday, Jul. 15, 10:00 a.m.' }
    const { row } = buildRow(occ, { jsonClock: '10:00:00' }, NOW)
    assert.equal(row.start_at, '2026-07-15T14:00:00.000Z') // 10:00 ET
    assert.equal(row.source_id, '588551-955652')            // PK preserved for recurring occurrences
    assert.equal(row.category, 'learning')
  })

  it('reads a start+end range from the list line', () => {
    const occ = { eventId: '587370', pk: '954590', title: 'Invention Project', dateText: 'Thursday, Jul. 16, 2:00 p.m. - 4:00 p.m.' }
    const { row } = buildRow(occ, {}, NOW)
    assert.equal(row.start_at, '2026-07-16T18:00:00.000Z')
    assert.equal(row.end_at, '2026-07-16T20:00:00.000Z')
  })

  it('skips administrative non-events', () => {
    assert.equal(buildRow({ eventId: '1', pk: '', title: 'Library Closed', dateText: 'Friday, Jul. 17, 3-4' }, {}, NOW), null)
  })

  it('returns null when no reliable time can be resolved', () => {
    const occ = { eventId: '2', pk: '', title: 'Mystery Program', dateText: 'Friday, Jul. 17, 3-4' }
    assert.equal(buildRow(occ, {}, NOW), null) // ambiguous list time + no JSON-LD clock
  })
})
