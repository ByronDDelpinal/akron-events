/**
 * test-habitat-summit.js — pure parsers for the Habitat for Humanity of Summit
 * County scraper. Fixtures mirror the real hfhsummitcounty.org/joinus/events/
 * markup (fundraiser cards + ECWD calendar grid).
 *
 * Run:  node --test scripts/tests/test-habitat-summit.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseCardDate, inferFundraiserTime, parseFundraiserCards, parseEcwdEvents, parseGridDates,
  planHabitatRetirement, hasStatusOverride, stageEvent, SOURCE_KEY,
} = await import('../scrape-habitat-summit.js')

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LIVE_2026_09 = readFileSync(join(FIXTURES, 'habitat-summit-events-2026-09.html'), 'utf8')

const CARDS = `
<h2>Events</h2>
<h1>Annual Fundraising Events</h1>
<div><a href="/buildinstyle/"><img></a></div>
<div><div>
  <h2>Build In Style</h2>
  <h4>Tuesday, March 9th, 2027</h4>
  <h4>Summit County ReStore</h4>
  <p>Support our Women Build Project and connect with other amazing women. Enjoy shopping for fashion accessories, a delicious lunch, and raffle prizes.</p>
  <a href="https://hfhsummitcounty.org/buildinstyle/">More Here</a>
</div></div>
<div><a href="/golfouting/"><img></a></div>
<div><div>
  <h2>Home In One</h2>
  <h4>Monday, July 27th, 2026</h4>
  <h4>Gleneagles Golf Club</h4>
  <p>Tee off for a fun-filled day of golf, complete with games, raffles, lunch, and prizes.</p>
  <a href="https://hfhsummitcounty.org/golfouting/">More Here</a>
</div></div>
<div><a href="/bourbonbuild/"><img></a></div>
<div><div>
  <h2>Bourbon Build</h2>
  <h4>Thursday, September 3rd, 2026</h4>
  <h4>The Akron RubberDucks Duck Club</h4>
  <p>Sip and support Habitat's mission with bourbon flights, food, live music, and a bottle raffle.</p>
  <a href="https://hfhsummitcounty.org/bourbonbuild/">More Here</a>
</div></div>
<h3>Support these Fundraising Events</h3>
<h2>Footer Heading Should Be Ignored</h2><h4>Junk</h4><h4>Junk</h4>
`

const ECWD = `
<li><a href="https://hfhsummitcounty.org/event/barberton-neighborhood-reborn-26/"><span>Barberton Neighborhood Reborn 2026</span></a>
  <div><div><h5><a>Barberton Neighborhood Reborn 2026</a></h5></div>
  <div><span>9:00 am-3:00 pm</span></div>
  <div><span> 2026.06.05-2026.06.06</span></div><img></div></li>
<li><a href="https://hfhsummitcounty.org/event/barberton-neighborhood-reborn-26/"><span>Barberton Neighborhood Reborn 2026</span></a>
  <div><span>9:00 am-3:00 pm</span></div><div><span> 2026.06.06-2026.06.06</span></div></li>
`

describe('parseCardDate', () => {
  it('parses "Weekday, Month Dth, YYYY"', () => {
    assert.equal(parseCardDate('Tuesday, March 9th, 2027'), '2027-03-09')
    assert.equal(parseCardDate('Monday, July 27th, 2026'), '2026-07-27')
    assert.equal(parseCardDate('Thursday, September 3rd, 2026'), '2026-09-03')
  })
  it('returns null for non-dates', () => assert.equal(parseCardDate('soon'), null))
})

describe('inferFundraiserTime', () => {
  it('golf → morning, luncheon → midday, else evening', () => {
    assert.equal(inferFundraiserTime('Home In One', 'a day of golf'), '9:00 AM')
    assert.equal(inferFundraiserTime('Build In Style', 'fashion + lunch'), '11:00 AM')
    assert.equal(inferFundraiserTime('Bourbon Build', 'bourbon flights and music'), '6:00 PM')
  })
})

describe('parseFundraiserCards', () => {
  const cards = parseFundraiserCards(CARDS)
  it('parses all 3 cards and ignores headings outside the section', () => {
    assert.equal(cards.length, 3)
    assert.deepEqual(cards.map((c) => c.title), ['Build In Style', 'Home In One', 'Bourbon Build'])
  })
  it('captures date, location, inferred time, and link', () => {
    const golf = cards.find((c) => c.title === 'Home In One')
    assert.equal(golf.date, '2026-07-27')
    assert.equal(golf.location, 'Gleneagles Golf Club')
    assert.equal(golf.time, '9:00 AM')
    assert.equal(golf.url, 'https://hfhsummitcounty.org/golfouting/')
    assert.match(golf.description, /day of golf/)
  })
})

describe('parseEcwdEvents', () => {
  const evs = parseEcwdEvents(ECWD)
  it('extracts the volunteer event with date + time; same slug on a second date is a second entry', () => {
    assert.equal(evs.length, 2)
    assert.equal(evs[0].title, 'Barberton Neighborhood Reborn 2026')
    assert.equal(evs[0].date, '2026-06-05')
    assert.equal(evs[0].time, '9:00 AM')
    assert.equal(evs[0].kind, 'volunteer')
    assert.equal(evs[0].url, 'https://hfhsummitcounty.org/event/barberton-neighborhood-reborn-26/')
    assert.equal(evs[1].date, '2026-06-06')
    assert.equal(evs[1].url, evs[0].url)
  })
  it('dedupes an exact slug+date repeat', () => {
    assert.equal(parseEcwdEvents(ECWD + ECWD).length, 2)
  })
})

// The live 2026-09 page plus two grid cells for a twice-monthly recurrence (same
// slug, two dates), in the exact ECWD cell markup the live page uses.
const ecwdCell = (day, slug, title, time, date) =>
  `<td class="day-with-date has-events" data-date="2026-9-${day}"><div class="day-number">${day}</div><ul class="events"><li style="" class=" 0">` +
  `<a href="https://hfhsummitcounty.org/event/${slug}/" ><span>${title}</span></a><div class="event-details-container"><div class="event-details">` +
  `<h5><a href="https://hfhsummitcounty.org/event/${slug}/" >${title}</a></h5><div class="ecwd-time"><span class="metainfo">${time}</span></div>` +
  `<div class="ecwd-date"><span class="metainfo"> ${date}</span></div></div></div></li></ul></td>`
const LIVE_PLUS_REBORN = LIVE_2026_09 +
  ecwdCell(13, 'reborn', 'Neighborhood Reborn', '9:00 am-3:00 pm', '2026.09.13') +
  ecwdCell(27, 'reborn', 'Neighborhood Reborn', '9:00 am-3:00 pm', '2026.09.27')

describe('parseEcwdEvents on the live 2026-09 page', () => {
  it('ignores foreign /event/ links (gofevo.com) embedded in card text', () => {
    const evs = parseEcwdEvents(LIVE_2026_09)
    assert.deepEqual(evs.map((e) => e.url.split('/event/')[1].replace(/\/$/, '')),
      ['welcome-home-social', 'silver-maple-ridge-block-party'])
    assert.deepEqual(evs.map((e) => e.title), ['Welcome Home Social', 'Silver Maple Ridge Block Party'])
    assert.deepEqual(evs.map((e) => e.date), ['2026-09-03', '2026-09-25'])
  })
  it('keeps BOTH dates of a same-slug recurrence (reborn 09-13 and 09-27)', () => {
    const reborn = parseEcwdEvents(LIVE_PLUS_REBORN).filter((e) => e.url.endsWith('/event/reborn/'))
    assert.deepEqual(reborn.map((e) => e.date), ['2026-09-13', '2026-09-27'])
    assert.equal(parseEcwdEvents(LIVE_PLUS_REBORN).length, 4)
  })
  it('parses the full month grid from data-date cells', () => {
    const dates = parseGridDates(LIVE_2026_09)
    assert.equal(dates.length, 30)
    assert.equal(dates[0], '2026-09-01')
    assert.equal(dates.at(-1), '2026-09-30')
    assert.deepEqual(parseGridDates('<td data-date="">'), [])
  })
})

describe('planHabitatRetirement', () => {
  // start_at is UTC; 2026-09-xxT16:00Z is noon Eastern on the same date.
  const row = (source_id, date, extra = {}) =>
    ({ id: source_id, title: source_id, source_id, status: 'published', start_at: `${date}T16:00:00.000Z`, manual_overrides: null, ...extra })
  const HEALTHY = { gridCells: 30, cardCount: 3, ecwdCount: 2 }
  const WINDOW = { windowStart: '2026-09-12', windowEnd: '2026-09-30' }
  const CARDS3 = new Set(['build-in-style', 'home-in-one', 'bourbon-build'])
  // Filler rows the page still lists, so a single retirement stays under the 50% ceiling.
  const filler = [row('a-2026-09-14', '2026-09-14'), row('b-2026-09-15', '2026-09-15'), row('c-2026-09-16', '2026-09-16')]
  const fillerIds = filler.map((r) => r.source_id)

  it('(a) reschedule within the month: old row retired, new row seen', () => {
    const rows = [...filler, row('block-party-2026-09-18', '2026-09-18'), row('block-party-2026-09-25', '2026-09-25')]
    const plan = planHabitatRetirement({ rows, seenSourceIds: new Set([...fillerIds, 'block-party-2026-09-25']), cardSlugs: CARDS3, ...WINDOW, health: HEALTHY })
    assert.equal(plan.skipped, null)
    assert.deepEqual(plan.retire.map((r) => r.source_id), ['block-party-2026-09-18'])
  })
  it('(b) monthly recurrence: both dates on the grid → neither retired (seen-set derived from the parser)', () => {
    const seenSourceIds = new Set(fillerIds)
    const now = Date.parse('2026-09-12T16:00:00Z')
    for (const ev of parseEcwdEvents(LIVE_PLUS_REBORN)) stageEvent(ev, { now, seenSourceIds })
    assert.ok(seenSourceIds.has('neighborhood-reborn-2026-09-13'))
    assert.ok(seenSourceIds.has('neighborhood-reborn-2026-09-27'))
    const rows = [...filler, row('neighborhood-reborn-2026-09-13', '2026-09-13'), row('neighborhood-reborn-2026-09-27', '2026-09-27')]
    const plan = planHabitatRetirement({ rows, seenSourceIds, cardSlugs: CARDS3, ...WINDOW, health: HEALTHY })
    assert.equal(plan.skipped, null)
    assert.deepEqual(plan.retire, [])
  })
  it('(c) row dated next month, not on the grid → untouched', () => {
    const rows = [...filler, row('october-thing-2026-10-08', '2026-10-08')]
    const plan = planHabitatRetirement({ rows, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, ...WINDOW, health: HEALTHY })
    assert.deepEqual(plan.retire, [])
  })
  it('(d) manual_overrides.status pin protects the row', () => {
    const pinned = row('pinned-2026-09-20', '2026-09-20', { manual_overrides: { status: { at: '2026-09-01T00:00:00Z', by: 'admin' } } })
    const rows = [...filler, pinned]
    const plan = planHabitatRetirement({ rows, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, ...WINDOW, health: HEALTHY })
    assert.deepEqual(plan.retire, [])
    assert.equal(plan.protectedCount, 1)
    assert.equal(hasStatusOverride(pinned), true)
    assert.equal(hasStatusOverride(row('x-2026-09-20', '2026-09-20', { manual_overrides: { title: {} } })), false)
  })
  it('(e) fundraiser card date moved: old row retired even months out', () => {
    const rows = [...filler, row('home-in-one-2027-07-27', '2027-07-27'), row('other-2027-07-27', '2027-07-27')]
    const plan = planHabitatRetirement({ rows, seenSourceIds: new Set([...fillerIds, 'home-in-one-2027-07-20']), cardSlugs: CARDS3, ...WINDOW, health: HEALTHY })
    assert.deepEqual(plan.retire.map((r) => r.source_id), ['home-in-one-2027-07-27'])
  })
  it('(f) grid parse returns 0 cells → sweep skipped', () => {
    const rows = [...filler, row('gone-2026-09-18', '2026-09-18')]
    const plan = planHabitatRetirement({ rows, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, windowStart: '2026-09-12', windowEnd: null, health: { ...HEALTHY, gridCells: 0 } })
    assert.equal(plan.skipped, 'grid-incomplete')
    assert.deepEqual(plan.retire, [])
  })
  it('caps at 5 rows and 50% of eligible; ignores non-published and already-cancelled rows', () => {
    const gone = [1, 2, 3, 4, 5, 6].map((i) => row(`gone${i}-2026-09-2${i}`, `2026-09-2${i}`))
    const many = [...filler, ...gone, ...[7, 8, 9].map((i) => row(`k${i}-2026-09-1${i}`, `2026-09-1${i}`))]
    const seen = new Set(many.filter((r) => !r.source_id.startsWith('gone')).map((r) => r.source_id))
    assert.equal(planHabitatRetirement({ rows: many, seenSourceIds: seen, cardSlugs: CARDS3, ...WINDOW, health: HEALTHY }).skipped, 'above-ceiling')
    const half = [...filler, ...[7, 8, 9, 20].map((i) => row(`gone${i}-2026-09-${i > 9 ? i : `1${i}`}`, `2026-09-${i > 9 ? i : `1${i}`}`))]  // 4/7 eligible = 57%
    assert.equal(planHabitatRetirement({ rows: half, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, ...WINDOW, health: HEALTHY }).skipped, 'above-ceiling')
    const cancelled = [...filler, row('gone-2026-09-18', '2026-09-18', { status: 'cancelled' })]
    assert.deepEqual(planHabitatRetirement({ rows: cancelled, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, ...WINDOW, health: HEALTHY }).retire, [])
  })
  it('skips when cards or calendar events are missing', () => {
    const rows = [...filler, row('gone-2026-09-18', '2026-09-18')]
    assert.equal(planHabitatRetirement({ rows, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, ...WINDOW, health: { ...HEALTHY, cardCount: 1 } }).skipped, 'cards-missing')
    assert.equal(planHabitatRetirement({ rows, seenSourceIds: new Set(fillerIds), cardSlugs: CARDS3, ...WINDOW, health: { ...HEALTHY, ecwdCount: 0 } }).skipped, 'ecwd-missing')
  })
})

describe('stageEvent', () => {
  const now = Date.parse('2026-09-12T16:00:00Z')
  it('records the source_id in the seen-set BEFORE the MAX_DAYS_AHEAD skip', () => {
    const seenSourceIds = new Set()
    const far = stageEvent({ title: 'Home In One', date: '2028-07-27', time: '9:00 AM' }, { now, seenSourceIds })
    assert.equal(far.skip, 'outside-horizon')
    assert.equal(far.sourceId, 'home-in-one-2028-07-27')
    assert.ok(seenSourceIds.has('home-in-one-2028-07-27'))
    const past = stageEvent({ title: 'Old', date: '2026-09-01', time: '9:00 AM' }, { now, seenSourceIds })
    assert.equal(past.skip, 'outside-horizon')
    assert.ok(seenSourceIds.has('old-2026-09-01'))
  })
  it('in-horizon event is not skipped; unparseable date is skipped without a source_id', () => {
    const seenSourceIds = new Set()
    const ok = stageEvent({ title: 'Block Party', date: '2026-09-25', time: '11:35 AM' }, { now, seenSourceIds })
    assert.equal(ok.skip, null)
    assert.equal(ok.sourceId, 'block-party-2026-09-25')
    assert.equal(ok.startIso.slice(0, 10), '2026-09-25')
    const bad = stageEvent({ title: 'Soon', date: null, time: null }, { now, seenSourceIds })
    assert.equal(bad.skip, 'no-start')
    assert.equal(seenSourceIds.size, 1)
  })
})

describe('SOURCE_KEY', () => {
  it('is habitat_summit', () => assert.equal(SOURCE_KEY, 'habitat_summit'))
})
