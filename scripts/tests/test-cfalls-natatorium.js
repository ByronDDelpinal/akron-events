/**
 * test-cfalls-natatorium.js
 *
 * Tests the pure parsers for the Natatorium (Cuyahoga Falls) news-blend
 * scraper. Fixtures are trimmed from the live fallsnat.com markup captured
 * 2026-07-15. Covers: list parsing, article extraction, non-event/camp/promo
 * classification, prose date parsing (month-name + numeric + ranges + trailing
 * year), first-explicit-time extraction (Kids-Castle guard, ranges, meridiem
 * requirement), price parsing, and end-to-end timing resolution.
 *
 * Run:
 *   node --test scripts/tests/test-cfalls-natatorium.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseNewsList,
  extractArticleParts,
  classifyPost,
  parseDates,
  parseFirstTime,
  parsePrice,
  resolveEventTiming,
  easternYmd,
} from '../scrape-cfalls-natatorium.js'

// Fixed "now" = 2026-07-15 12:00 EDT so date-window logic is deterministic.
const NOW = Date.parse('2026-07-15T16:00:00Z')

// ── Fixtures (trimmed from live markup) ─────────────────────────────────────

const LIST_HTML = `
<div class="view-content">
  <div class="item"><div class="views-field views-field-nothing"><span class="field-content">
    <a href="/news/summer-sunday-series" class="wrap"><h3>Summer Sunday Series</h3><h5></h5>
    <p>4 Weeks / July 12 - August 2Yoga - 9:15 a.m. (B) Debbie 7/12 - Julie 7/19, 7/26, 8/2Zumba &amp; More…</p></a>
  </span></div></div>
  <div class="item"><div class="views-field views-field-nothing"><span class="field-content">
    <a href="/news/nat-summer-camp" class="wrap"><h3>Nat Summer Camp</h3><h5></h5><p>June 16-18…</p></a>
  </span></div></div>
  <div class="item"><div class="views-field views-field-nothing"><span class="field-content">
    <a href="/news/fall-prevention-safety" class="wrap"><h3>Fall Prevention &amp; Safety</h3><h5></h5><p>Thursdays…</p></a>
  </span></div></div>
</div>`

const FALL_PREVENTION_DETAIL = `
<article data-history-node-id="172">
  <div class="field field--name-body">
    <div class="field__item">
      <h3>Thursdays, May 21 &amp; 28, 2026, from 11:00 a.m. - 12:00 p.m.</h3>
      <p><strong>The Natatorium, Room B</strong></p>
      <p>$10 Fee for both classes</p>
      <ul><li>Improve strength, balance, and confidence</li><li>Learn common causes of falls</li></ul>
      <p>Attendance at both classes is highly recommended.&nbsp;</p>
      <p><a class="btn" href="https://app.amilia.com/store/en/cuyahoga-falls/shop/memberships?selectedTags=4492490&amp;keyword=summer">Join</a></p>
      <p><a class="btn" href="https://app.amilia.com/store/en/cuyahoga-falls/shop/programs/123372?subCategoryIds=6923932">Reserve your spot today!</a></p>
    </div>
  </div>
</article>`

// The multi-class Sunday series body: note the trailing "Kids Castle open from
// 9 a.m. to Noon" line that must NOT be mistaken for the event start time.
const SUMMER_SUNDAY_BODY =
  '4 Weeks / July 12 - August 2\n' +
  'Yoga - 9:15 a.m. (B) Debbie 7/12 - Julie 7/19, 7/26, 8/2\n' +
  'Zumba & More - 9:15 a.m. (Aux) Barb 7/12, 7/26\n' +
  'Spin - 9:15 a.m. (A) Dana\n' +
  'Drum - 10:30 (Aux) Terry 7/12, 7/19 - Megan 7/26, 8/2\n' +
  'Silver Pilates - 10:30 (B) Debbie\n' +
  'All classes are one hour / Kids Castle open from 9 a.m. to Noon'

const CAMP_BODY =
  'Nat Summer Camp:\nJune 16-18 and June 23-25,  9am-3pm\n' +
  'Kids ages 7-12    $175 per week/per child   Camp t-shirts provided\nregister today!'

const SPRING_SUNDAY_BODY =
  '8 weeks of Sunday Classes, March 8th - May 3rd, 2026\n' +
  'No classes on Easter Sunday, 4-5-2026\n' +
  'Yoga - 9:15 (B) Julie/Ashley\nChair Yoga / Pilates - 10:30 (B) Debbie'

// ── List + article extraction ───────────────────────────────────────────────

describe('parseNewsList', () => {
  it('extracts deduped slug/title/url for each card', () => {
    const posts = parseNewsList(LIST_HTML)
    assert.equal(posts.length, 3)
    assert.deepEqual(posts.map(p => p.slug), ['summer-sunday-series', 'nat-summer-camp', 'fall-prevention-safety'])
    assert.equal(posts[2].title, 'Fall Prevention & Safety') // entity decoded
    assert.equal(posts[0].url, 'https://www.fallsnat.com/news/summer-sunday-series')
  })
})

describe('extractArticleParts', () => {
  it('pulls body text and prefers the program registration link over memberships', () => {
    const { bodyText, registrationUrl } = extractArticleParts(FALL_PREVENTION_DETAIL)
    assert.match(bodyText, /Thursdays, May 21 & 28, 2026/)
    assert.match(bodyText, /\$10 Fee/)
    assert.equal(registrationUrl, 'https://app.amilia.com/store/en/cuyahoga-falls/shop/programs/123372?subCategoryIds=6923932')
  })
})

// ── Classification ──────────────────────────────────────────────────────────

describe('classifyPost', () => {
  it('skips youth camps by title', () => {
    assert.equal(classifyPost('Nat Summer Camp', CAMP_BODY).skip, true)
  })
  it('skips membership promos / deals', () => {
    assert.equal(classifyPost('Summer Deal: 3 Months for the Price of 2!', 'Available May 1 – July 15').skip, true)
  })
  it('skips closure / hours notices', () => {
    assert.equal(classifyPost('Holiday Hours', 'The Natatorium will be closed on July 4.').skip, true)
  })
  it('keeps dated wellness classes and swim events', () => {
    assert.equal(classifyPost('Fall Prevention & Safety', 'Thursdays…').skip, false)
    assert.equal(classifyPost('Summer Sunday Series', SUMMER_SUNDAY_BODY).skip, false)
  })
  it('skips cancelled / postponed posts by title', () => {
    assert.equal(classifyPost('CANCELED: Open Swim', 'Saturday, August 8, 2026, 1:00 p.m.').skip, true)
    assert.equal(classifyPost('Summer Swim Meet (Postponed)', 'August 8, 2026, 9:00 a.m.').skip, true)
    assert.equal(classifyPost('Open Swim Cancelled', 'August 8, 2026, 1:00 p.m.').skip, true)
  })
})

// ── Date parsing ────────────────────────────────────────────────────────────

describe('parseDates', () => {
  it('parses enumerated month-name dates with a trailing year ("May 21 & 28, 2026")', () => {
    const dates = parseDates('Thursdays, May 21 & 28, 2026, from 11:00 a.m. - 12:00 p.m.', '2026-07-15')
    assert.deepEqual(dates, ['2026-05-21', '2026-05-28'])
  })

  it('does not swallow the year digits as a day', () => {
    const dates = parseDates('May 21 & 28, 2026', '2026-07-15')
    assert.ok(!dates.includes('2026-05-20'), 'year "2026" must not yield May 20')
  })

  it('parses a cross-month range + numeric session dates (Summer Sunday)', () => {
    const dates = parseDates(SUMMER_SUNDAY_BODY, '2026-07-15')
    for (const d of ['2026-07-12', '2026-07-19', '2026-07-26', '2026-08-02']) {
      assert.ok(dates.includes(d), `expected ${d} in ${JSON.stringify(dates)}`)
    }
  })

  it('applies a trailing range year to the earlier month too', () => {
    const dates = parseDates(SPRING_SUNDAY_BODY, '2026-07-15')
    assert.ok(dates.includes('2026-03-08'))
    assert.ok(dates.includes('2026-05-03'))
    // Every parsed date is in 2026 (no stray year-rolled April from "4-5-2026").
    assert.ok(dates.every(d => d.startsWith('2026-')), JSON.stringify(dates))
  })

  it('infers the year for bare dates and rolls a well-past month forward', () => {
    // Ref mid-July: a bare "August 2" stays this year; a bare "March 2" rolls.
    const dates = parseDates('August 2 … March 2', '2026-07-15')
    assert.ok(dates.includes('2026-08-02'))
    assert.ok(dates.includes('2027-03-02'))
  })
})

// ── Time parsing ────────────────────────────────────────────────────────────

describe('parseFirstTime', () => {
  it('takes the first class time, not the trailing Kids Castle facility note', () => {
    const t = parseFirstTime(SUMMER_SUNDAY_BODY)
    assert.deepEqual(t, { timeStr: '9:15 am', endTimeStr: null })
  })
  it('parses a "from X - Y" range', () => {
    const t = parseFirstTime('Thursdays, May 21 & 28, 2026, from 11:00 a.m. - 12:00 p.m.')
    assert.deepEqual(t, { timeStr: '11:00 am', endTimeStr: '12:00 pm' })
  })
  it('parses a compact "9am-3pm" range', () => {
    const t = parseFirstTime(CAMP_BODY)
    assert.deepEqual(t, { timeStr: '9:00 am', endTimeStr: '3:00 pm' })
  })
  it('returns null when only bare, meridiem-less times are present', () => {
    assert.equal(parseFirstTime('Yoga - 9:15 (B)\nDrum - 10:30 (Aux)'), null)
  })
  it('ignores the Kids Castle facility note when class times lack a meridiem', () => {
    // Class times are meridiem-less; the ONLY meridiem time is the child-watch
    // note. It must NOT be adopted as the event time — the post is unusable.
    const body =
      'Yoga - 9:15 (B)\nPilates - 10:30 (B)\n' +
      '*All classes are one hour. Kids Castle is open 9:00 a.m. - noon'
    assert.equal(parseFirstTime(body), null)
  })
  it('still takes a real meridiem class time that precedes the Kids Castle note', () => {
    assert.deepEqual(parseFirstTime(SUMMER_SUNDAY_BODY), { timeStr: '9:15 am', endTimeStr: null })
  })
})

// ── Price ───────────────────────────────────────────────────────────────────

describe('parsePrice', () => {
  it('reads the first stated fee', () => {
    assert.deepEqual(parsePrice('$10 Fee for both classes'), { price_min: 10, price_max: null })
  })
  it('never assumes free', () => {
    assert.deepEqual(parsePrice('Improve strength and balance.'), { price_min: null, price_max: null })
  })
})

// ── End-to-end timing resolution ────────────────────────────────────────────

describe('resolveEventTiming', () => {
  it('anchors a recurring series to the NEXT upcoming session', () => {
    const r = resolveEventTiming('Summer Sunday Series', SUMMER_SUNDAY_BODY, NOW)
    assert.equal(r.skip, false)
    assert.equal(r.dateStr, '2026-07-19') // 7/12 already past on 7/15
    assert.equal(r.timeStr, '9:15 am')
    assert.equal(easternYmd(r.startAt), '2026-07-19')
  })

  it('skips a fully-past post', () => {
    const r = resolveEventTiming('Fall Prevention & Safety',
      'Thursdays, May 21 & 28, 2026, from 11:00 a.m. - 12:00 p.m. $10 Fee', NOW)
    assert.equal(r.skip, true)
    assert.match(r.reason, /no upcoming date/)
  })

  it('skips youth camps regardless of dates', () => {
    const r = resolveEventTiming('Nat Summer Camp', CAMP_BODY, NOW)
    assert.equal(r.skip, true)
    assert.match(r.reason, /camp/)
  })

  it('skips a promo even when it names a date', () => {
    const r = resolveEventTiming('Summer Deal: 3 Months for the Price of 2!', 'Available July 20, 2026', NOW)
    assert.equal(r.skip, true)
    assert.match(r.reason, /promo|deal/)
  })

  it('ingests a future single-session public event with an explicit time range', () => {
    const r = resolveEventTiming('Community Open Swim',
      'Join us Saturday, October 4, 2026 from 1:00 p.m. - 3:00 p.m. at The Natatorium.', NOW)
    assert.equal(r.skip, false)
    assert.equal(r.dateStr, '2026-10-04')
    assert.equal(r.timeStr, '1:00 pm')
    assert.equal(r.endTimeStr, '3:00 pm')
    assert.equal(easternYmd(r.endAt), '2026-10-04')
  })

  it('skips a dated post that states no explicit time', () => {
    const r = resolveEventTiming('Family Fun Day',
      'Come celebrate on August 30, 2026. Fun for the whole family!', NOW)
    assert.equal(r.skip, true)
    assert.match(r.reason, /no explicit time/)
  })

  it('skips a future series whose only meridiem time is the Kids Castle note', () => {
    const body =
      '8 weeks of Sunday Classes, October 4th - November 22nd, 2026\n' +
      'Yoga - 9:15 (B)\nPilates - 10:30 (B)\n' +
      '*All classes are one hour. Kids Castle is open 9:00 a.m. - noon'
    const r = resolveEventTiming('Fall Sunday Series', body, NOW)
    assert.equal(r.skip, true)
    assert.match(r.reason, /no explicit time/)
  })

  it('rolls the series card forward as sessions pass', () => {
    const later = Date.parse('2026-07-22T16:00:00Z') // 7/19 now >1 day past
    const r = resolveEventTiming('Summer Sunday Series', SUMMER_SUNDAY_BODY, later)
    assert.equal(r.dateStr, '2026-07-26')
  })
})
