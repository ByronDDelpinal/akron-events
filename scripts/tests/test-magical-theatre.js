/**
 * test-magical-theatre.js — the Magical Theatre Company scraper.
 * No network, no database.
 *
 * Fixtures (captured live 2026-11-18):
 *   magical-theatre-show.html            /events/elf-the-musical-tya/ — cut by a
 *                                        script from the live page: the og:
 *                                        meta tags, then everything from the
 *                                        <h1> through the end of the public
 *                                        ticket list (synopsis, photo, price,
 *                                        nine performances). script/style
 *                                        blocks and inline styles removed.
 *   magical-theatre-upcoming-links.html  every show-page and season-page <a>
 *                                        tag on /upcoming-events/, as written
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, MAIN_VENUE, findShowLinks, findSeasonLinks, parsePerformanceDate, parsePerformanceTime,
  parsePrice, parseShowPage, buildRow, run,
} = await import('../scrape-magical-theatre.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const SHOW = fx('magical-theatre-show.html')
const LINKS = fx('magical-theatre-upcoming-links.html')
const ELF_URL = 'https://www.magicaltheatre.org/events/elf-the-musical-tya/'
const NOW = Date.parse('2026-11-18T17:00:00Z')

describe('discovery', () => {
  it('finds show pages and season pages, absolute and de-duplicated', () => {
    assert.deepEqual(findShowLinks(LINKS), [
      'https://www.magicaltheatre.org/events/elf-the-musical-tya/',
      'https://www.magicaltheatre.org/events/junie-b-jones-toothless-wonder/',
    ])
    assert.deepEqual(findSeasonLinks(LINKS), [
      'https://www.magicaltheatre.org/2025-2026-season/',
      'https://www.magicaltheatre.org/2026-2027-season/',
    ])
  })

  it('accepts relative links and ignores other sites', () => {
    assert.deepEqual(findShowLinks('<a href="/events/a-show/">A</a><a href="/events/a-show">again</a><a href="https://example.org/events/nope/">no</a>'), [
      'https://www.magicaltheatre.org/events/a-show/',
    ])
    assert.deepEqual(findShowLinks('<a href="/upcoming-events/">Upcoming</a>'), [])
  })
})

describe('performance date, time and price', () => {
  it('reads the list\'s date format', () => {
    assert.equal(parsePerformanceDate('Fri December 4, 2026'), '2026-12-04')
    assert.equal(parsePerformanceDate('Saturday, May 1, 2027'), '2027-05-01')
    assert.equal(parsePerformanceDate('December 4, 2026'), '2026-12-04')
  })

  it('declines a date it cannot read in full', () => {
    assert.equal(parsePerformanceDate('Fri December 4'), null)
    assert.equal(parsePerformanceDate('Fri Smarch 4, 2026'), null)
    assert.equal(parsePerformanceDate('TBA'), null)
  })

  it('reads a time and its 24-hour key', () => {
    assert.deepEqual(parsePerformanceTime('7:30 pm'), { time: '7:30 pm', hhmm: '1930' })
    assert.deepEqual(parsePerformanceTime('2:00 pm'), { time: '2:00 pm', hhmm: '1400' })
    assert.deepEqual(parsePerformanceTime('10 a.m.'), { time: '10:00 am', hhmm: '1000' })
    assert.deepEqual(parsePerformanceTime('12:00 pm'), { time: '12:00 pm', hhmm: '1200' })
    assert.deepEqual(parsePerformanceTime('12:15 am'), { time: '12:15 am', hhmm: '0015' })
  })

  it('declines a time that is not one', () => {
    assert.equal(parsePerformanceTime('Evening'), null)
    assert.equal(parsePerformanceTime('13:00 pm'), null)
    assert.equal(parsePerformanceTime(''), null)
  })

  it('reads a price range; no dollar amount is unknown, not free', () => {
    assert.deepEqual(parsePrice('$23 and $25 per person'), { price_min: 23, price_max: 25 })
    assert.deepEqual(parsePrice('$15'), { price_min: 15, price_max: null })
    assert.deepEqual(parsePrice('Tickets on sale soon'), { price_min: null, price_max: null })
  })
})

describe('parseShowPage (real page)', () => {
  const show = parseShowPage(SHOW)

  it('reads the title, synopsis, photo and price', () => {
    assert.equal(show.title, 'Elf the Musical TYA')
    assert.match(show.description, /^Based on the beloved holiday film/)
    assert.match(show.imageUrl, /^https:\/\/www\.magicaltheatre\.org\/wp-content\/uploads\//)
    assert.equal(show.price_min, 23)
    assert.equal(show.price_max, 25)
  })

  it('reads all nine public performances', () => {
    assert.equal(show.performances.length, 9)
    assert.equal(show.unparsed, 0)
    assert.deepEqual(show.performances[0], {
      dateStr: '2026-12-04', time: '7:30 pm', hhmm: '1930',
      ticketUrl: 'https://app.arts-people.com/index.php?show=359435',
    })
    assert.deepEqual(show.performances.at(-1).dateStr, '2026-12-20')
  })

  it('only the list under "Public Performances" counts', () => {
    const page = '<h1>Show</h1><h2>Student Matinees</h2><ul class="ticket-list"><li><div>Tue December 8, 2026</div><div>10:00 am</div></li></ul>' +
      '<h2>Public Performances</h2><ul class="ticket-list"><li><div>Fri December 11, 2026</div><div>7:30 pm</div></li></ul>'
    assert.deepEqual(parseShowPage(page).performances.map((p) => p.dateStr), ['2026-12-11'])
  })

  it('an item whose date or time does not parse is counted, not defaulted', () => {
    const page = '<h1>Show</h1><h2>Public Performances</h2><ul class="ticket-list">' +
      '<li><div>Fri December 11, 2026</div><div>TBA</div></li><li><div>Sat December 12, 2026</div><div>2:00 pm</div></li></ul>'
    const parsed = parseShowPage(page)
    assert.equal(parsed.performances.length, 1)
    assert.equal(parsed.unparsed, 1)
  })

  it('a page with no performance list has none', () => {
    const parsed = parseShowPage('<h1>Coming Soon</h1><p>Dates to be announced.</p>')
    assert.deepEqual([parsed.performances.length, parsed.unparsed, parsed.price_min], [0, 0, null])
  })
})

describe('buildRow', () => {
  const show = parseShowPage(SHOW)

  it('one row per performance, keyed by show, date and time', () => {
    const { row, venue } = buildRow(ELF_URL, show, show.performances[0])
    assert.equal(row.title, 'Elf the Musical TYA')
    assert.equal(row.start_at, '2026-12-05T00:30:00.000Z') // Fri 7:30 pm EST
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'elf-the-musical-tya-2026-12-04-1930')
    assert.deepEqual(row.categories, ['theater'])
    assert.equal(row.is_family, true)
    assert.equal(row.price_min, 23)
    assert.equal(row.price_max, 25)
    assert.equal(row.ticket_url, 'https://app.arts-people.com/index.php?show=359435')
    assert.equal(venue, MAIN_VENUE)
  })

  it('every performance of a run has a distinct id', () => {
    const ids = show.performances.map((p) => buildRow(ELF_URL, show, p).row.source_id)
    assert.equal(new Set(ids).size, 9)
  })

  it('falls back to the show page when a performance has no ticket link', () => {
    const { row } = buildRow(ELF_URL, show, { ...show.performances[0], ticketUrl: null })
    assert.equal(row.ticket_url, ELF_URL)
  })
})

describe('run (dry, stub site)', () => {
  const site = (showBody) => async (url) => {
    const path = new URL(String(url)).pathname
    const body = path === '/upcoming-events/' ? LINKS : /-season\/$/.test(path) ? LINKS : showBody
    return new Response(body, { status: 200 })
  }

  it('walks upcoming → seasons → shows and plans every performance', async () => {
    const log = console.log; console.log = () => {}
    try {
      const result = await run({ dryRun: true, fetchImpl: site(SHOW), now: () => NOW, delayMs: 0 })
      // Two show pages, both served the nine-performance Elf page by the stub.
      assert.deepEqual(
        { status: result.status, found: result.found, planned: result.planned },
        { status: 'dry-run', found: 18, planned: 18 },
      )
    } finally { console.log = log }
  })

  it('between seasons (no performances listed) is a quiet run, not an error', async () => {
    const log = console.log; console.log = () => {}
    try {
      const result = await run({ dryRun: true, fetchImpl: site('<h1>Coming Soon</h1>'), now: () => NOW, delayMs: 0 })
      assert.equal(result.status, 'dry-run')
      assert.equal(result.planned, 0)
    } finally { console.log = log }
  })
})
