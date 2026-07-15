/**
 * test-jewish-akron.js
 *
 * Locks the Jewish Akron (Jewish Community Board of Akron) scraper's pure logic:
 *   • the faith allowlist — worship/internal/lifecycle veto wins over public
 *     keywords; the shared + Jewish-community text supplement lets real public
 *     events through,
 *   • month-list extraction (real <a class="title"> events vs <span> holiday
 *     markers),
 *   • detail parsing: Google-Calendar UTC datetime, location → address, the
 *     "JewishAkron"→Shaw JCC / "Off Campus"→no-venue mapping, and the per-venue
 *     Summit gate inputs,
 *   • source_id stability, category + is_fundraiser mapping.
 *
 * Fixtures are trimmed from live https://www.jewishakron.org markup.
 *
 * Run:  node --test scripts/tests/test-jewish-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, isPublicJewishAkronEvent, parseListEvents, gcalTokenToIso,
  parseGcalDates, parseLocation, resolveVenue, parseDetail, parseCategory,
  parseIsFundraiser, buildSourceId,
} = await import('../scrape-jewish-akron.js')

import { classifySummitLocation } from '../lib/summit-county.js'

// ── Faith allowlist ─────────────────────────────────────────────────────────

describe('isPublicJewishAkronEvent — public community/cultural events pass', () => {
  it('festivals, BBQs, golf outings, author talks, apple picking, raffles', () => {
    assert.equal(isPublicJewishAkronEvent('J-Fest (Jewish Heritage Festival)'), true)
    assert.equal(isPublicJewishAkronEvent('JCC Golf Outing', 'The annual Golf Outing'), true)
    assert.equal(isPublicJewishAkronEvent('Welcome Back BBQ at Temple Israel Akron'), true)
    assert.equal(isPublicJewishAkronEvent('The Lippman School - Back to School BBQ'), true)
    assert.equal(isPublicJewishAkronEvent('Beth El BBQ'), true)
    assert.equal(isPublicJewishAkronEvent("Author Talk - Let's Call Her Barbie"), true)
    assert.equal(isPublicJewishAkronEvent('Apple Picking with Temple Israel Akron'), true)
    assert.equal(isPublicJewishAkronEvent("Anshe Sfard Annual Men's Raffle"), true)
  })
  it('Jewish-community terms the shared church list misses', () => {
    assert.equal(isPublicJewishAkronEvent('Community Klezmer Concert'), true) // concert also shared
    assert.equal(isPublicJewishAkronEvent('Purim Carnival'), true)
    assert.equal(isPublicJewishAkronEvent('Community Hanukkah Celebration'), true)
    assert.equal(isPublicJewishAkronEvent('Menorah Lighting at the Square'), true)
  })
})

describe('isPublicJewishAkronEvent — worship / internal / lifecycle are skipped', () => {
  it('Shabbat services and liturgy', () => {
    assert.equal(isPublicJewishAkronEvent('Sisterhood Shabbat at Temple Israel Akron'), false)
    assert.equal(isPublicJewishAkronEvent('Shabbat in the Round Anshe Sfard'), false)
    assert.equal(isPublicJewishAkronEvent('Selichot at Temple Israel Akron'), false)
    assert.equal(isPublicJewishAkronEvent('Ruach Shabbat Service at Temple Israel Akron'), false)
    assert.equal(isPublicJewishAkronEvent('Friday Night Live Beth El'), false)
  })
  it('lifecycle events and internal meetings', () => {
    assert.equal(isPublicJewishAkronEvent('Julianna Fatica Bat Mitzvah'), false)
    assert.equal(isPublicJewishAkronEvent('Wedding of Meir Sasonkin & Kaila Sasonkin'), false)
    assert.equal(isPublicJewishAkronEvent('JA Board Meeting', 'Meeting of the Board of Trustees'), false)
  })
  it('the worship veto wins even when a public keyword co-occurs (strict)', () => {
    // A "Shabbat dinner" is a synagogue service program, not a public meal.
    assert.equal(isPublicJewishAkronEvent('Community Shabbat Dinner'), false)
    // "Legacy and Endowment Shabbat" is a service despite the fundraising theme.
    assert.equal(isPublicJewishAkronEvent('Legacy and Endowment Shabbat'), false)
  })
  it('ambiguous receptions with no public signal are skipped', () => {
    assert.equal(isPublicJewishAkronEvent('Wine and Welcome at Temple Israel Akron', 'Wine and Welcome'), false)
    assert.equal(isPublicJewishAkronEvent('Women’s Chavurah 19 Kislev Event'), false)
  })
})

// ── Month list extraction ───────────────────────────────────────────────────

const LIST_FIXTURE = `
<div class="events-list">
  <div class="special-events-list">
    <div class="event special-event">
      <div class="event-date -is-special"><span>Jul 4, 2026</span></div>
      <span class="title">Independence Day (US)</span>
    </div>
  </div>
  <div class="event">
    <a class="title"
       href="https://www.jewishakron.org/calendar/sisterhood-shabbat-at-temple-israel-akron-1777475208"
    >Sisterhood Shabbat at Temple Israel Akron</a>
  </div>
  <div class="event">
    <a class="title"
       href="https://www.jewishakron.org/calendar/beth-el-bbq-1763734269"
    >Beth El BBQ</a>
  </div>
</div>`

describe('parseListEvents', () => {
  it('extracts real <a class="title"> events and ignores holiday <span> markers', () => {
    const events = parseListEvents(LIST_FIXTURE)
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((e) => e.title), [
      'Sisterhood Shabbat at Temple Israel Akron', 'Beth El BBQ',
    ])
    assert.ok(events[1].url.endsWith('beth-el-bbq-1763734269'))
  })
})

// ── Google-Calendar UTC datetime ────────────────────────────────────────────

describe('gcalTokenToIso / parseGcalDates', () => {
  it('converts a Google-Calendar UTC token to ISO', () => {
    assert.equal(gcalTokenToIso('20260810T160000Z'), '2026-08-10T16:00:00.000Z')
    assert.equal(gcalTokenToIso('nope'), null)
  })
  it('pulls start + end from the detail-page template link (noon-EDT golf outing)', () => {
    const html = '<a href="http://www.google.com/calendar/event?action=TEMPLATE&amp;text=X&amp;' +
      'dates=20260810T160000Z%2F20260810T200000Z&amp;detail=Y">Add</a>'
    const { startAt, endAt } = parseGcalDates(html)
    assert.equal(startAt, '2026-08-10T16:00:00.000Z') // 12:00 PM EDT
    assert.equal(endAt, '2026-08-10T20:00:00.000Z')   // 4:00 PM EDT
  })
})

// ── Location parsing + venue resolution ─────────────────────────────────────

// Congregation venues wrap the address in a <span> (real Temple Israel markup).
const TEMPLE_LOC = `
  Temple Israel Akron
  <span>
    91 Springside Drive
    <br />
    Fairlawn, OH 44333
  </span>
  <span></span>`

// The "JewishAkron" default has an icon + <br>-separated lines, no <span>
// (real JCC / 750 White Pond markup).
const JCC_LOC = `
  <i class="ss-icon ss-location"></i><br>
  JewishAkron<br />
  750 White Pond Drive <br />
  Akron, OH 44320`

describe('parseLocation', () => {
  it('splits a named venue with street + city/state/zip', () => {
    const loc = parseLocation(TEMPLE_LOC)
    assert.equal(loc.name, 'Temple Israel Akron')
    assert.equal(loc.address, '91 Springside Drive')
    assert.equal(loc.city, 'Fairlawn')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44333')
  })
  it('handles the "Off Campus" placeholder (no address)', () => {
    const loc = parseLocation('Off Campus')
    assert.equal(loc.name, 'Off Campus')
    assert.equal(loc.address, null)
    assert.equal(loc.city, null)
  })
})

describe('resolveVenue + Summit gate', () => {
  it('maps the "JewishAkron" default to the Shaw JCC (Akron → in)', () => {
    const r = resolveVenue(parseLocation(JCC_LOC))
    assert.equal(r.name, 'Shaw Jewish Community Center')
    assert.equal(r.details.address, '750 White Pond Drive')
    assert.equal(r.city, 'Akron')
    assert.equal(classifySummitLocation({ city: r.city }), 'in')
  })
  it('keeps a congregation venue with its own address (Fairlawn → in)', () => {
    const r = resolveVenue(parseLocation(TEMPLE_LOC))
    assert.equal(r.name, 'Temple Israel Akron')
    assert.equal(r.city, 'Fairlawn')
    assert.equal(classifySummitLocation({ city: r.city }), 'in')
  })
  it('"Off Campus" → no venue, unknown locality → pending_review', () => {
    const r = resolveVenue(parseLocation('Off Campus'))
    assert.equal(r.name, null)
    assert.equal(r.city, null)
    assert.equal(classifySummitLocation({ city: r.city }), 'unknown')
  })
})

// ── Detail parsing (end to end) ─────────────────────────────────────────────

const DETAIL_FIXTURE = `
<section class="page-main calendar-event" id="calendar-485-event-515154">
  <header class="page-title">
    <div class="event-date"><div class="date-box">
      <div class="month">Aug</div>
      <p><span class="day">10</span><span class="year">2026</span></p>
    </div></div>
    <h2>JCC Golf Outing</h2>
  </header>
  <div class="event-info clearfix -no-price -cols-3">
    <p class="time">12:00PM - 4:00PM <span class="js-rrule" data-rrule="">&nbsp;</span></p>
    <p class="location">
      <i class="ss-icon ss-location"></i><br>
      JewishAkron<br />
      750 White Pond Drive <br />
      Akron, OH 44320
    </p>
  </div>
  <article class="post"><div class="editor-copy"><p>The annual Golf Outing</p></div></article>
  <a href="http://www.google.com/calendar/event?action=TEMPLATE&amp;text=JCC%20Golf%20Outing&amp;dates=20260810T160000Z%2F20260810T200000Z&amp;detail=x">Add to Google</a>
</section>`

describe('parseDetail', () => {
  it('parses id, title, UTC datetime, description and venue', () => {
    const rec = parseDetail(DETAIL_FIXTURE, 'https://www.jewishakron.org/calendar/jcc-golf-outing-2026')
    assert.equal(rec.eventId, '515154')
    assert.equal(rec.title, 'JCC Golf Outing')
    assert.equal(rec.startAt, '2026-08-10T16:00:00.000Z')
    assert.equal(rec.endAt, '2026-08-10T20:00:00.000Z')
    assert.equal(rec.description, 'The annual Golf Outing')
    assert.equal(rec.location.name, 'JewishAkron')
    assert.equal(rec.location.address, '750 White Pond Drive')
    assert.equal(rec.location.city, 'Akron')
    assert.equal(rec.sourceId, '515154')
    // and the default location maps to the Shaw JCC (Akron → in-county).
    assert.equal(resolveVenue(rec.location).name, 'Shaw Jewish Community Center')
  })
})

// ── source_id, category, fundraiser ─────────────────────────────────────────

describe('buildSourceId', () => {
  it('uses the numeric FedWeb event id', () => {
    assert.equal(buildSourceId('515154', 'https://x/calendar/jcc-golf-outing-2026'), '515154')
  })
  it('falls back to the URL slug when the id is missing', () => {
    assert.equal(buildSourceId(null, 'https://x/calendar/beth-el-bbq-1763734269'), 'beth-el-bbq-1763734269')
  })
})

describe('parseCategory', () => {
  it('festivals map to festival; others infer with an "other" fallback', () => {
    assert.equal(parseCategory('J-Fest (Jewish Heritage Festival)'), 'festival')
    const c = parseCategory('Beth El BBQ', 'Community cookout')
    assert.ok(typeof c === 'string' && c.length > 0)
  })
})

describe('parseIsFundraiser', () => {
  it('true for raffles and golf outings; undefined otherwise', () => {
    assert.equal(parseIsFundraiser("Anshe Sfard Annual Men's Raffle"), true)
    assert.equal(parseIsFundraiser('JCC Golf Outing', 'The annual Golf Outing'), true)
    assert.equal(parseIsFundraiser('Beth El BBQ'), undefined)
  })
})

describe('SOURCE_KEY', () => {
  it('is jewish_akron', () => {
    assert.equal(SOURCE_KEY, 'jewish_akron')
  })
})
