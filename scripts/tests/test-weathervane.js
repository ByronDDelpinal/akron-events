/**test-weathervane.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2 } from './fixtures/weathervane-events.js'
import { parseShows, extractWvDescription, extractWvTicketUrl } from '../scrape-weathervane.js'

function parseDateString(raw) {
  const rangePat = /^(\w+)\s+(\d{1,2})\s*-\s*(?:(\w+)\s+)?(\d{1,2}),\s+(\d{4})$/
  const m = raw.match(rangePat)
  if (!m) return null
  const startStr = new Date(`${m[1]} ${m[2]}, ${m[5]}`).toISOString().split('T')[0]
  const endMonth = m[3] || m[1]
  const endStr = new Date(`${endMonth} ${m[4]}, ${m[5]}`).toISOString().split('T')[0]
  return { start: startStr, end: endStr }
}

describe('Weathervane: Date Range Parsing', () => {
  it('parses month-to-month range', () => {
    const p = parseDateString(F1.raw)
    assert.ok(p)
    assert.equal(p.start, F1.expStart)
    assert.equal(p.end, F1.expEnd)
  })

  it('parses day range in same month', () => {
    const p = parseDateString(F2.raw)
    assert.ok(p)
    assert.equal(p.start, F2.expStart)
    assert.equal(p.end, F2.expEnd)
  })
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
    const shows = parseShows(listingHtml)
    assert.ok(!shows.some(s => s.slug === '92nd-season'))
  })

  it('captures title, date, detail-page href, and poster image for a real show card', () => {
    const shows = parseShows(listingHtml)
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
    const shows = parseShows(glued)
    assert.equal(shows.length, 1)
    assert.equal(shows[0].title, 'Deathtrap')
    assert.equal(shows[0].dateStr, '2026-10-08')
  })

  it('skips cards with no poster image (nav links, not show cards)', () => {
    const noPoster = `<a href="/events/deathtrap">Deathtrap October 8 - November 1, 2026</a>`
    assert.equal(parseShows(noPoster).length, 0)
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
