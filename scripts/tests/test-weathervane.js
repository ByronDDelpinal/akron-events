/**test-weathervane.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2 } from './fixtures/weathervane-events.js'
import { LATE_EDT, LATE_EST } from './fixtures/late-night-clocks.js'
import { parseShows, extractWvDescription, extractWvTicketUrl } from '../scrape-weathervane.js'

// Real listing markup: an <a href="/events/{slug}"> wrapping a poster <img> and
// the title + month-name date text (the contract parseShows documents). Built
// as a helper so every date assertion below goes through the REAL htmlToText
// path rather than a forked reimplementation.
const card = (slug, title, dateText) =>
  `<a href="/events/${slug}"><img src="https://www.weathervaneplayhouse.com/${slug}.png" alt="${title}">
     <div>${title}</div>
     <div>${dateText}</div>
   </a>`

/** Same card with no whitespace or block boundaries between the fields. */
const cardOneLine = (slug, title, dateText) =>
  `<a href="/events/${slug}"><img src="https://www.weathervaneplayhouse.com/${slug}.png"><span>${title}</span><span>${dateText}</span></a>`

describe('Weathervane: date-range parsing via the real parser', () => {
  it('parses a month-to-month range from a listing card', () => {
    // F1: "March 15 - April 10, 2026" — future at the winter clock.
    const shows = parseShows(card('urinetown', 'Urinetown', F1.raw), LATE_EST)
    assert.equal(shows.length, 1)
    assert.equal(shows[0].dateStr, F1.expStart)
  })

  it('parses a same-month day range from a listing card', () => {
    // F2: "May 5 - 28, 2026"
    const shows = parseShows(card('the-play', 'The Play That Goes Wrong', F2.raw), LATE_EST)
    assert.equal(shows.length, 1)
    assert.equal(shows[0].dateStr, F2.expStart)
  })
})

// The bug: at 11pm ET the UTC date is already tomorrow, so a UTC-derived
// `todayMs` cut today's show out of the listing entirely.
describe('Weathervane: late-evening ET runs keep today\'s shows', () => {
  for (const [label, now, todayText, todayYmd, pastText, pastYmd] of [
    ['EDT (11:30pm Jul 15)', LATE_EDT, 'JULY 15, 2026',    '2026-07-15', 'JULY 14, 2026',    '2026-07-14'],
    ['EST (11:30pm Jan 15)', LATE_EST, 'JANUARY 15, 2026', '2026-01-15', 'JANUARY 14, 2026', '2026-01-14'],
  ]) {
    it(`keeps a show dated TODAY and drops yesterday's — ${label}`, () => {
      const html = card('opens-today', 'Opens Today', todayText) +
                   card('closed-yesterday', 'Closed Yesterday', pastText)
      const shows = parseShows(html, now)
      const today = shows.find((s) => s.slug === 'opens-today')
      assert.ok(today, `today's show must survive the past-filter (${label})`)
      assert.equal(today.dateStr, todayYmd)
      assert.equal(shows.find((s) => s.slug === 'closed-yesterday'), undefined,
        `yesterday's show must still be dropped (${label}) — got ${pastYmd}`)
    })

    it(`infers the year for a year-less date without rolling to next year — ${label}`, () => {
      // "JULY 15" with no year: inferYear must resolve to the CURRENT Eastern
      // year. A UTC "today" of the 16th pushed this a full year forward.
      const bare = todayText.replace(/,\s*\d{4}$/, '')
      const shows = parseShows(card('year-less', 'Year Less Show', bare), now)
      assert.equal(shows.length, 1)
      assert.equal(shows[0].dateStr, todayYmd)
    })

    it(`applies the same cutoff to single-line markup — ${label}`, () => {
      const shows = parseShows(cardOneLine('glued-today', 'Glued Today', todayText), now)
      assert.equal(shows.length, 1)
      assert.equal(shows[0].title, 'Glued Today')
      assert.equal(shows[0].dateStr, todayYmd)
    })
  }
})

// 2026-07-02 rework: crawl each show's own detail page for description +
// ticket link, and pull title/date/poster/href from the listing page's
// single <a href="/events/{slug}"> card (see scrape-weathervane.js).
describe('Weathervane: listing-page parsing (rework 2026-07-02)', () => {
  const listingHtml = `
    <a href="/events/92nd-season"><img src="https://x.com/92.jpg" alt="92"><div>92nd Season</div><div>August 20, 2026 to July 11, 2027</div></a>
    <a href="/events/deathtrap"><img src="https://www.weathervaneplayhouse.com/deathtrap.png" alt="Deathtrap"><div>Deathtrap</div><div>October 8 - November 1, 2026</div></a>
  `

  it('skips season-header cards (two-year range, no explicit show)', () => {
    const shows = parseShows(listingHtml, LATE_EDT)
    assert.ok(!shows.some(s => s.slug === '92nd-season'))
  })

  it('captures title, date, detail-page href, and poster image for a real show card', () => {
    const shows = parseShows(listingHtml, LATE_EDT)
    const dt = shows.find(s => s.slug === 'deathtrap')
    assert.ok(dt, 'Deathtrap card parsed')
    assert.equal(dt.title, 'Deathtrap')
    assert.equal(dt.dateStr, '2026-10-08')
    assert.equal(dt.href, 'https://www.weathervaneplayhouse.com/events/deathtrap')
    assert.equal(dt.posterUrl, 'https://www.weathervaneplayhouse.com/deathtrap.png')
  })

  it('splits title from date even with no whitespace between them (regression)', () => {
    // htmlToText doesn't break on <span>/<div> boundaries, only <p>/<br>/<li>/headings —
    // real markup could glue "DeathtrapOctober 8 - November 1, 2026" together.
    const glued = `<a href="/events/deathtrap"><img src="https://x.com/d.png"><span>Deathtrap</span><span>October 8 - November 1, 2026</span></a>`
    const shows = parseShows(glued, LATE_EDT)
    assert.equal(shows.length, 1)
    assert.equal(shows[0].title, 'Deathtrap')
    assert.equal(shows[0].dateStr, '2026-10-08')
  })

  it('skips cards with no poster image (nav links, not show cards)', () => {
    const noPoster = `<a href="/events/deathtrap">Deathtrap October 8 - November 1, 2026</a>`
    assert.equal(parseShows(noPoster, LATE_EDT).length, 0)
  })
})

describe('Weathervane: detail-page extraction (rework 2026-07-02)', () => {
  const detailHtml = `
    <p><em><strong>PARADE</strong></em><br>Music and Lyrics by Jason Robert Brown<br>JUNE 18 to JULY 12, 2026</p>
    <p>Powerful, moving, and unforgettable, <em>Parade</em> tells a tragic and true story of injustice in 1913 Georgia.</p>
    <p><strong>CONTENT WARNING:</strong> Parade contains themes of racism and antisemitism, viewer discretion is advised.</p>
    <p><em>Parade</em> is presented through special arrangement with Music Theatre International (MTI).</p>
    <a href="https://ci.ovationtix.com/35614/production/1234880">Buy Tickets</a>
  `

  it('extracts the synopsis paragraph, skipping the byline/warning/licensing blocks', () => {
    const desc = extractWvDescription(detailHtml)
    assert.ok(desc?.startsWith('Powerful, moving, and unforgettable'))
    assert.ok(!/CONTENT WARNING/i.test(desc))
  })

  it('returns null when no qualifying paragraph exists', () => {
    assert.equal(extractWvDescription('<p>Short.</p>'), null)
  })

  it('extracts the Buy Tickets link', () => {
    assert.equal(extractWvTicketUrl(detailHtml), 'https://ci.ovationtix.com/35614/production/1234880')
  })

  it('returns null when there is no Buy Tickets link', () => {
    assert.equal(extractWvTicketUrl('<p>No tickets here.</p>'), null)
  })
})
