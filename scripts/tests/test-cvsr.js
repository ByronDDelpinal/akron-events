/**
 * test-cvsr.js
 *
 * Tests for the Cuyahoga Valley Scenic Railroad calendar parser. Fixtures are
 * captured verbatim from the live /book-tickets/calendar grid (2026-07-14) and
 * lock in:
 *   - time parsing ("9:00am", "12:20pm", meridiem-aware, null when absent)
 *   - one record per departure, station code + Etix link + Details slug
 *   - "outside" adjacent-month cells and event-less cells are ignored
 *   - same-day departures of one (excursion, station) collapse into one group
 *     with the earliest time first and every departure time retained
 *   - source_id / slug stability, category-path mapping
 *   - excursion detail parsing (og:description, hero image, AggregateOffer)
 *
 * Run:
 *   node --test scripts/tests/test-cvsr.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Dummy env vars before importing the scraper module ──────────────────────
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseGridTime,
  excursionSlug,
  parseMonthGrid,
  groupDepartures,
  formatClock,
  departuresLine,
  parseExcursionDetail,
  monthsToFetch,
} from '../scrape-cvsr.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A filled day cell with three National Park Scenic departures from three
// stations (RS out-of-county, PN + AN in Summit) plus a second PN departure to
// exercise same-day/same-station grouping.
const CELL_MULTI = `<td class=" filled">
  <p class="day">15</p>
  <p class="time">9:00am</p>
  <div class="event">
    <span>RS</span>
    <p class="title">National Park Scenic </p>
    <a href="excursions/national-park-excursions/national-park-scenic">Details</a>
    <a href="https://www.etix.com/ticket/e/1056992/2026-national-park-scenic--rockside-station " target="_blank">Tix</a>
  </div><p class="time">10:00am</p><div class="event">
    <span>PN</span>
    <p class="title">National Park Scenic </p>
    <a href="excursions/national-park-excursions/national-park-scenic">Details</a>
    <a href="https://www.etix.com/ticket/e/1057055/2026-national-park-scenic-peninsula-peninsula-depot" target="_blank">Tix</a>
  </div><p class="time">11:20am</p><div class="event">
    <span>AN</span>
    <p class="title">National Park Scenic </p>
    <a href="excursions/national-park-excursions/national-park-scenic">Details</a>
    <a href="https://www.etix.com/ticket/e/1056850/2026-national-park-scenic-akron-akron-northside-station" target="_blank">Tix</a>
  </div><p class="time">2:45pm</p><div class="event">
    <span>PN</span>
    <p class="title">National Park Scenic </p>
    <a href="excursions/national-park-excursions/national-park-scenic">Details</a>
    <a href="https://www.etix.com/ticket/e/1057055/2026-national-park-scenic-peninsula-peninsula-depot" target="_blank">Tix</a>
  </div>
</td>`

// A themed event with no Details/Tix link (sold-out / info-only).
const CELL_NOLINK = `<td class=" filled">
  <p class="day">16</p>
  <p class="time">6:30pm</p>
  <div class="event">
    <span>RS</span>
    <p class="title">Bingo Train</p>
  </div>
</td>`

// Adjacent-month overflow cell (must be ignored) + an event-less current cell.
const CELL_OUTSIDE = `<td class=" past outside weekend empty">
  <p class="day">30</p>
  <p class="time"></p>
</td>
<td class="current empty">
  <p class="day">14</p>
  <p class="time"></p>
</td>`

// ── parseGridTime ────────────────────────────────────────────────────────────

describe('parseGridTime', () => {
  it('parses am/pm times to 24h HH:MM:SS', () => {
    assert.equal(parseGridTime('9:00am'), '09:00:00')
    assert.equal(parseGridTime('11:20am'), '11:20:00')
    assert.equal(parseGridTime('12:20pm'), '12:20:00')
    assert.equal(parseGridTime('1:45pm'), '13:45:00')
    assert.equal(parseGridTime('6:30pm'), '18:30:00')
  })
  it('handles noon and midnight edges', () => {
    assert.equal(parseGridTime('12:00pm'), '12:00:00')
    assert.equal(parseGridTime('12:00am'), '00:00:00')
  })
  it('returns null when no meridiem-qualified time present', () => {
    assert.equal(parseGridTime(''), null)
    assert.equal(parseGridTime(null), null)
    assert.equal(parseGridTime('Coming soon'), null)
  })
})

// ── excursionSlug ────────────────────────────────────────────────────────────

describe('excursionSlug', () => {
  it('extracts the leaf slug', () => {
    assert.equal(excursionSlug('excursions/national-park-excursions/national-park-scenic'), 'national-park-scenic')
    assert.equal(excursionSlug('excursions/fun-games/murder-mystery'), 'murder-mystery')
  })
  it('returns null for missing href', () => {
    assert.equal(excursionSlug(null), null)
  })
})

// ── parseMonthGrid ───────────────────────────────────────────────────────────

describe('parseMonthGrid', () => {
  it('emits one record per departure with station + links + date', () => {
    const recs = parseMonthGrid(CELL_MULTI, 2026, 7)
    assert.equal(recs.length, 4)
    const first = recs[0]
    assert.equal(first.date, '2026-07-15')
    assert.equal(first.time, '09:00:00')
    assert.equal(first.stationCode, 'RS')
    assert.equal(first.title, 'National Park Scenic')
    assert.equal(first.slug, 'national-park-scenic')
    assert.equal(first.categoryPath, 'national-park-excursions')
    assert.match(first.ticketUrl, /etix\.com\/ticket\/e\/1056992/)
  })

  it('captures events without Details/Tix links via slugified title', () => {
    const recs = parseMonthGrid(CELL_NOLINK, 2026, 7)
    assert.equal(recs.length, 1)
    assert.equal(recs[0].title, 'Bingo Train')
    assert.equal(recs[0].slug, 'bingo-train')
    assert.equal(recs[0].ticketUrl, null)
    assert.equal(recs[0].detailsHref, null)
  })

  it('ignores adjacent-month "outside" cells and event-less cells', () => {
    const recs = parseMonthGrid(CELL_OUTSIDE, 2026, 7)
    assert.equal(recs.length, 0)
  })

  it('zero-pads month and day in the date', () => {
    const recs = parseMonthGrid(CELL_MULTI, 2026, 7)
    assert.ok(recs.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)))
  })

  it('drops a cancelled/postponed departure (title marker)', () => {
    const cancelled = `<td class=" filled">
      <p class="day">17</p>
      <p class="time">10:00am</p>
      <div class="event">
        <span>PN</span>
        <p class="title">National Park Scenic - CANCELLED</p>
      </div>
    </td>`
    assert.equal(parseMonthGrid(cancelled, 2026, 7).length, 0)
  })
})

// ── groupDepartures ──────────────────────────────────────────────────────────

describe('groupDepartures', () => {
  it('collapses same-day same-station departures, earliest first', () => {
    const recs = parseMonthGrid(CELL_MULTI, 2026, 7)
    const groups = groupDepartures(recs)
    // RS, PN(x2 → 1), AN → 3 groups
    assert.equal(groups.length, 3)
    const pn = groups.find((g) => g.stationCode === 'PN')
    assert.deepEqual(pn.times, ['10:00:00', '14:45:00'])
    assert.equal(pn.date, '2026-07-15')
  })

  it('keeps different stations as separate events', () => {
    const groups = groupDepartures(parseMonthGrid(CELL_MULTI, 2026, 7))
    const codes = groups.map((g) => g.stationCode).sort()
    assert.deepEqual(codes, ['AN', 'PN', 'RS'])
  })

  it('backfills a details/ticket link from any departure in the group', () => {
    const recs = [
      { slug: 'x', stationCode: 'PN', date: '2026-08-01', time: '10:00:00', title: 'X', detailsHref: null, ticketUrl: null, categoryPath: null },
      { slug: 'x', stationCode: 'PN', date: '2026-08-01', time: '12:00:00', title: 'X', detailsHref: 'excursions/a/x', ticketUrl: 'https://www.etix.com/ticket/e/1/x', categoryPath: 'a' },
    ]
    const [g] = groupDepartures(recs)
    assert.equal(g.detailsHref, 'excursions/a/x')
    assert.equal(g.ticketUrl, 'https://www.etix.com/ticket/e/1/x')
    assert.deepEqual(g.times, ['10:00:00', '12:00:00'])
  })
})

// ── formatClock / departuresLine ─────────────────────────────────────────────

describe('formatClock + departuresLine', () => {
  it('formats 24h to 12h clock', () => {
    assert.equal(formatClock('09:00:00'), '9:00 AM')
    assert.equal(formatClock('14:45:00'), '2:45 PM')
    assert.equal(formatClock('12:00:00'), '12:00 PM')
    assert.equal(formatClock('00:00:00'), '12:00 AM')
  })
  it('builds a singular/plural departures line', () => {
    assert.equal(
      departuresLine('CVSR Peninsula Depot', ['10:00:00']),
      'Departure from CVSR Peninsula Depot: 10:00 AM.',
    )
    assert.equal(
      departuresLine('CVSR Peninsula Depot', ['10:00:00', '14:45:00']),
      'Departures from CVSR Peninsula Depot: 10:00 AM, 2:45 PM.',
    )
  })
})

// ── parseExcursionDetail ─────────────────────────────────────────────────────

describe('parseExcursionDetail', () => {
  const HTML = `
    <meta property="og:description" content="Enjoy breakfast on the train while traveling through the Cuyahoga Valley.">
    <div style="background-image:url(https://cvsr.b-cdn.net/files/excursions/header/national-park-scenic-hero.jpg);"></div>
    <script type="application/ld+json">
    {"@type":"AggregateOffer","priceCurrency":"USD","lowPrice":"25.00","highPrice":"38.00","availability":"https://schema.org/InStock"}
    </script>`

  it('extracts description, hero image, and price range', () => {
    const d = parseExcursionDetail(HTML)
    assert.equal(d.description, 'Enjoy breakfast on the train while traveling through the Cuyahoga Valley.')
    assert.equal(d.imageUrl, 'https://cvsr.b-cdn.net/files/excursions/header/national-park-scenic-hero.jpg')
    assert.equal(d.priceMin, 25)
    assert.equal(d.priceMax, 38)
  })

  it('handles a page with no AggregateOffer', () => {
    const d = parseExcursionDetail('<meta property="og:description" content="Detective fun.">')
    assert.equal(d.description, 'Detective fun.')
    assert.equal(d.priceMin, null)
    assert.equal(d.priceMax, null)
    assert.equal(d.imageUrl, null)
  })
})

// ── monthsToFetch ────────────────────────────────────────────────────────────

describe('monthsToFetch', () => {
  it('rolls over the year boundary', () => {
    const months = monthsToFetch('2026-11-14', 4)
    assert.deepEqual(months, [
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
      { year: 2027, month: 2 },
    ])
  })
  it('returns the requested count starting at the current month', () => {
    const months = monthsToFetch('2026-07-14', 7)
    assert.equal(months.length, 7)
    assert.deepEqual(months[0], { year: 2026, month: 7 })
  })
})
