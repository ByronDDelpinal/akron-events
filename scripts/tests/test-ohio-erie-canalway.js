/**
 * test-ohio-erie-canalway.js — pure parsers for the Ohio & Erie Canalway
 * Coalition scraper. Fixtures are real markup captured from
 * ohioeriecanal.org/events and its event detail pages:
 *
 *   - Listing rows are <div class="item"> with an <h4 class="title"> link and a
 *     <time datetime="…"> element.
 *   - Detail bodies carry a "Date: / Time: / Location:" block.
 *
 * The Summit County gate must keep Akron events (Summit Lake Float) and drop
 * out-of-county ones (Bike, Hike and Brew at the Canal Tavern of Zoar,
 * Tuscarawas County).
 *
 * Run:  node --test scripts/tests/test-ohio-erie-canalway.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseEvents, parseDetail, parseCanalwayDate,
  cityFromLocationLine, cityFromProse, buildDescription, TIME_NOTE, MAX_DESCRIPTION, SOURCE_KEY,
} = await import('../scrape-ohio-erie-canalway.js')
const { isSummitCountyLocation } = await import('../lib/summit-county.js')

// ── Real listing fixture (7 rows, verbatim structure from /events) ──────────
const LISTING_HTML = `
<div class="view-content">
  <div class="item">
    <h4 class="title"><a href="/float" hreflang="en">Summit Lake Float</a></h4>
    <time datetime="2026-07-11T12:00:00Z" class="datetime">July 11th 2026</time>
  </div>
  <div class="item">
    <h4 class="title"><a href="/cleanups" hreflang="en">Ohio &amp; Erie Canal Cleanups</a></h4>
    <time datetime="2026-08-01T12:00:00Z" class="datetime">August 1st 2026</time>
  </div>
  <div class="item">
    <h4 class="title"><a href="/towpath-50" hreflang="en">Cleveland Clinic Akron General Towpath 50</a></h4>
    <time datetime="2026-08-09T12:00:00Z" class="datetime">August 9th 2026</time>
  </div>
  <div class="item">
    <h4 class="title"><a href="/bike-hike-brew" hreflang="en">Bike, Hike and Brew</a></h4>
    <time datetime="2026-10-10T12:00:00Z" class="datetime">October 10th 2026</time>
  </div>
</div>
`

// ── Real detail fixtures (Event Details blocks, verbatim) ───────────────────
const FLOAT_DETAIL = `
<meta name="description" content="We're bringing back Summit Lake Float! Presented by the Ohio &amp; Erie Canalway Coalition and Summit Metro Parks, Summit Lake Float welcomes community members to experience Summit Lake through water recreation.">
<meta property="og:image" content="https://www.ohioeriecanal.org/sites/default/files/summit-lake-float.jpg">
<h1>Summit Lake Float</h1>
<div class="clearfix text-formatted field field--name-body field--type-text-with-summary">
  <h4>Event Details</h4>
  <p><strong>Date: </strong>Saturday, July 11<br><strong>Time: </strong>8:00 a.m. to 4:00 p.m.<br><strong>Location:</strong> Summit Lake NorthShore Park, 540 W. South Street, Akron</p>
</div>
`

// Bike, Hike and Brew: the location only appears in prose (Canal Tavern of Zoar,
// Tuscarawas County) — outside Summit County.
const BREW_DETAIL = `
<meta name="description" content="Celebrate the fall season with a bicycle ride, hike and family-friendly Oktoberfest!">
<div class="clearfix text-formatted field field--name-body field--type-text-with-summary">
  <p>Join us for a fully-supported 6 or 12-mile bicycle ride or hike from Canal Lands Park. Return to the Canal Tavern of Zoar for an Oktoberfest-themed party with German food and dessert, Lockport beer, live music and a commemorative gift!</p>
  <p>Details<br><strong>Date: </strong>Saturday, October 10, 2026<br><strong>Time: </strong>10:00 a.m. to 2:00 p.m.</p>
</div>
`

describe('parseCanalwayDate', () => {
  it('parses "Month Nth Year" to YYYY-MM-DD', () => {
    assert.equal(parseCanalwayDate('July 11th 2026'), '2026-07-11')
    assert.equal(parseCanalwayDate('November 7th 2026'), '2026-11-07')
    assert.equal(parseCanalwayDate('not a date'), null)
  })
})

describe('parseEvents (listing)', () => {
  const rows = parseEvents(LISTING_HTML)

  it('extracts every event row with title, absolute url, and date', () => {
    assert.equal(rows.length, 4)
    const float = rows[0]
    assert.equal(float.title, 'Summit Lake Float')
    assert.equal(float.url, 'https://www.ohioeriecanal.org/float')
    assert.equal(float.ymd, '2026-07-11')          // from <time datetime>
  })

  it('decodes entities in titles', () => {
    assert.equal(rows[1].title, 'Ohio & Erie Canal Cleanups')
  })

  it('prefers the machine-readable datetime attribute for the date', () => {
    assert.equal(rows[2].ymd, '2026-08-09')
    assert.equal(rows[3].ymd, '2026-10-10')
  })
})

describe('cityFromLocationLine', () => {
  it('takes the trailing city out of a "Name, Address, City" line', () => {
    assert.equal(cityFromLocationLine('Summit Lake NorthShore Park, 540 W. South Street, Akron'), 'akron')
    assert.equal(cityFromLocationLine('Somewhere, 1 Main St, Cuyahoga Falls, OH'), 'cuyahoga falls')
  })
})

describe('cityFromProse', () => {
  it('finds a known locality mentioned in free text', () => {
    assert.equal(cityFromProse('Return to the Canal Tavern of Zoar for Oktoberfest'), 'zoar')
    assert.equal(cityFromProse('starts in downtown Akron'), 'akron')
    assert.equal(cityFromProse('no city here'), null)
  })
})

describe('parseDetail', () => {
  it('parses the Summit Lake Float detail block', () => {
    const d = parseDetail(FLOAT_DETAIL)
    assert.equal(d.time, '8:00 AM')                                  // opener of the range
    assert.equal(d.location, 'Summit Lake NorthShore Park, 540 W. South Street, Akron')
    assert.equal(d.city, 'akron')
    assert.equal(d.imageUrl, 'https://www.ohioeriecanal.org/sites/default/files/summit-lake-float.jpg')
    assert.match(d.description, /Summit Lake Float/)
  })

  it('resolves the city from prose when there is no Location line', () => {
    const d = parseDetail(BREW_DETAIL)
    assert.equal(d.location, null)
    assert.equal(d.city, 'zoar')                                     // Tuscarawas County
    assert.equal(d.time, '10:00 AM')
  })
})

describe('Summit County gate', () => {
  it('keeps an Akron event and drops the out-of-county Zoar event', () => {
    const akron = parseDetail(FLOAT_DETAIL)
    const zoar  = parseDetail(BREW_DETAIL)
    assert.equal(isSummitCountyLocation({ city: akron.city }), true)
    assert.equal(isSummitCountyLocation({ city: zoar.city }), false)   // Zoar = Tuscarawas, excluded
  })

  it('drops events with no resolvable locality (unknown is not trusted)', () => {
    assert.equal(isSummitCountyLocation({ city: null }), false)
  })
})

describe('SOURCE_KEY', () => {
  it('is ohio_erie_canalway', () => assert.equal(SOURCE_KEY, 'ohio_erie_canalway'))
})

// Same page shape as FLOAT_DETAIL with the "Time: " line removed; the case
// where the scraper falls back to the 9:00 AM default.
const NO_TIME_DETAIL = `
<meta name="description" content="Join us for a guided towpath cleanup along the Ohio &amp; Erie Canal in Akron.">
<h1>Canal Cleanup</h1>
<div class="clearfix text-formatted field field--name-body field--type-text-with-summary">
  <h4>Event Details</h4>
  <p><strong>Date: </strong>Saturday, August 1<br><strong>Location:</strong> Mustill Store, 248 Ferndale Street, Akron</p>
</div>
`

describe('default-time disclosure (2026-07-28 decision)', () => {
  // buildDescription is the function main() calls for the stored description,
  // and the details below come from the real parseDetail, so this is the
  // shipped path end to end.
  it('appends the note when the detail page publishes no time', () => {
    const d = parseDetail(NO_TIME_DETAIL)
    assert.equal(d.time, null, 'fixture must exercise the fallback path')
    const description = buildDescription(d)
    assert.ok(description.startsWith('Join us for a guided towpath cleanup'))
    assert.ok(description.endsWith(TIME_NOTE), 'note must be the final clause')
  })

  it('does NOT append the note when the source does publish a time', () => {
    const d = parseDetail(FLOAT_DETAIL)
    assert.equal(d.time, '8:00 AM')
    assert.equal(buildDescription(d), d.description)
    assert.ok(!buildDescription(d).includes(TIME_NOTE))
  })

  it('does not double the note when the incoming description already contains it', () => {
    const already = { time: null, description: `Some blurb. ${TIME_NOTE}` }
    const description = buildDescription(already)
    assert.equal(description, already.description)
    assert.equal(description.split(TIME_NOTE).length - 1, 1, 'note must appear exactly once')
  })

  it('leaves a null description null: the note is a suffix, never a description', () => {
    // A note-only description would be 100+ chars of boilerplate that reads as
    // a complete listing to anything measuring description length, including
    // the digest's `described` weight. Null in, null out, on both branches.
    assert.equal(buildDescription({ time: null, description: null }), null)
    assert.equal(buildDescription({ time: null, description: '' }), null)
  })

  it('leaves a timed event with no description null, as before', () => {
    assert.equal(buildDescription({ time: '8:00 AM', description: null }), null)
  })

  it('never exceeds the description cap, note included', () => {
    // parseDetail caps the base at MAX_DESCRIPTION; appending a ~122-char note
    // used to push the stored value to 2122. The cap now reserves room for it.
    const base = 'a'.repeat(MAX_DESCRIPTION)
    const out = buildDescription({ time: null, description: base })
    assert.ok(out.length <= MAX_DESCRIPTION, `description was ${out.length} chars`)
    assert.ok(out.endsWith(TIME_NOTE), 'the note must survive the cap intact')
  })

  it('truncates on a character boundary, not mid-surrogate-pair', () => {
    const room = MAX_DESCRIPTION - TIME_NOTE.length - 1
    const base = `${'a'.repeat(room - 1)}🚣${'b'.repeat(200)}`
    const out = buildDescription({ time: null, description: base })
    assert.ok(out.isWellFormed(), 'truncation produced a lone surrogate')
    assert.ok(out.length <= MAX_DESCRIPTION, `description was ${out.length} chars`)
    assert.ok(out.endsWith(TIME_NOTE), 'the note must survive the cap intact')
    assert.ok(!out.includes('🚣'), 'a character that does not fit is dropped whole')
  })

  it('parseDetail caps the base it hands to buildDescription', () => {
    // The real parse path, so the two caps are demonstrably the same number.
    const long = 'x'.repeat(MAX_DESCRIPTION + 500)
    const html = `<html><head><meta name="description" content="${long}"></head><body>
      <p><strong>Date: </strong>Saturday, August 1<br><strong>Location:</strong> Mustill Store, 248 Ferndale Street, Akron</p>
    </body></html>`
    const d = parseDetail(html)
    assert.equal(d.time, null, 'fixture must exercise the fallback path')
    assert.equal(d.description.length, MAX_DESCRIPTION)
    assert.ok(buildDescription(d).length <= MAX_DESCRIPTION)
  })
})
