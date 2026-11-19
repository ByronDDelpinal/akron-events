/**
 * test-stow-players.js — the Stow Players scraper. No network, no database.
 *
 * Fixtures (captured live 2026-11-19, reduced by script: script/style/svg and
 * layout attributes removed, everything from the sponsor list down cut off):
 *   stow-players-home.html                 the home page: season cards
 *   stow-players-production-winnie.html    two showtime lines, "20 and 21"
 *   stow-players-production-murder.html    long day lists, February (next year)
 *   stow-players-production-improv.html    one date, lowercase "7:30pm", no ticket link
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, MAIN_VENUE, findProductions, parseTime, parseShowtimeLine, parseProductionPage,
  yearFor, buildRow, run,
} = await import('../scrape-stow-players.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const HOME = fx('stow-players-home.html')
const WINNIE = fx('stow-players-production-winnie.html')
const MURDER = fx('stow-players-production-murder.html')
const IMPROV = fx('stow-players-production-improv.html')
const NOW = Date.parse('2026-11-19T15:00:00Z')

describe('discovery', () => {
  const productions = findProductions(HOME)

  it('finds every production once, in page order, with its opening month and year', () => {
    assert.deepEqual(productions.map((p) => [p.slug, p.openMonth, p.openYear]), [
      ['winnie-the-pooh', 11, 2026],
      ['holiday-one-acts', 12, 2026],
      ['private-lives', 1, 2027],
      ['an-old-fashioned-family-murder', 2, 2027],
      ['doublewide-texas', 3, 2027],
      ['mid-life-crisis-improv-fall', 11, 2026],
      ['mid-life-crisis-spring', 3, 2027],
    ])
    assert.equal(productions[0].url, 'https://stowplayers.net/production/winnie-the-pooh/')
  })

  it('returns nothing for a page with no production links', () => {
    assert.deepEqual(findProductions('<a href="/about/">About</a>'), [])
  })
})

describe('showtime lines', () => {
  it('reads a two-day line', () => {
    assert.deepEqual(parseShowtimeLine('November 20 and 21 at 7:30 PM'), [
      { month: 11, day: 20, time: '7:30 pm', hhmm: '1930' },
      { month: 11, day: 21, time: '7:30 pm', hhmm: '1930' },
    ])
  })

  it('reads a long list with and without the serial comma, and "PM" glued to the time', () => {
    assert.deepEqual(parseShowtimeLine('February 5, 6, 12, 13, 19 and 20 at 7:30PM').map((s) => s.day), [5, 6, 12, 13, 19, 20])
    assert.deepEqual(parseShowtimeLine('March 7, 14, 20, and 21 at 2:30 PM').map((s) => s.day), [7, 14, 20, 21])
  })

  it('reads a single date with a lowercase meridiem', () => {
    assert.deepEqual(parseShowtimeLine('November 14 at 7:30pm'), [{ month: 11, day: 14, time: '7:30 pm', hhmm: '1930' }])
  })

  it('returns null rather than guessing when the line does not fit', () => {
    for (const line of ['', 'Get Tickets', 'Opens November 20, 2026', 'November 20 at dusk', 'Smarch 3 at 7:30 PM', 'November 32 at 7:30 PM', 'Fridays at 7:30 PM']) {
      assert.equal(parseShowtimeLine(line), null, line)
    }
  })

  it('parseTime handles noon-side and bare hours, and rejects nonsense', () => {
    assert.deepEqual(parseTime('2 PM'), { time: '2:00 pm', hhmm: '1400' })
    assert.deepEqual(parseTime('12:00 pm'), { time: '12:00 pm', hhmm: '1200' })
    assert.deepEqual(parseTime('12:30 a.m.'), { time: '12:30 am', hhmm: '0030' })
    assert.equal(parseTime('13:00 pm'), null)
    assert.equal(parseTime('evening'), null)
  })
})

describe('production pages', () => {
  it('Winnie the Pooh: title, synopsis, image, ticket link, four performances', () => {
    const p = parseProductionPage(WINNIE)
    assert.equal(p.title, 'Winnie the Pooh')
    assert.match(p.description, /^Adapted from A\. A\. Milne's "Winnie the Pooh"\n\nBased on the beloved stories/)
    assert.doesNotMatch(p.description, /Season|Sponsors|Get Tickets/)
    assert.match(p.imageUrl, /\/wp-content\/uploads\/2026\/05\/winnie-the-pooh-1024x1024\.jpg$/)
    assert.equal(p.ticketUrl, 'https://app.arts-people.com/index.php?show=327554')
    assert.deepEqual(p.showtimes.map((s) => `${s.month}/${s.day} ${s.hhmm}`), ['11/20 1930', '11/21 1930', '11/21 1430', '11/22 1430'])
    assert.equal(p.unparsed, 0)
  })

  it('never takes the stale "The 2025-26 Season" heading as the title', () => {
    for (const html of [WINNIE, MURDER, IMPROV]) assert.doesNotMatch(parseProductionPage(html).title, /Season/)
  })

  it('An Old-Fashioned Family Murder: ten performances across two lines', () => {
    const p = parseProductionPage(MURDER)
    assert.equal(p.title, 'An Old-Fashioned Family Murder')
    assert.equal(p.showtimes.length, 10)
    assert.equal(p.unparsed, 0)
  })

  it('improv night: the "(Fall Show)" suffix survives, there is no ticket link, and the image is the show, not a logo', () => {
    const p = parseProductionPage(IMPROV)
    assert.equal(p.title, 'Mid-Life Crisis (Fall Show)')
    assert.match(p.description, /^A Comedy Improv Troupe\n\nGet ready for a night of laughter! Mid Life Crisis brings/)
    assert.equal(p.ticketUrl, null)
    assert.match(p.imageUrl, /mid-life-crisis\.jpg$/)
    assert.equal(p.showtimes.length, 1)
  })

  it('counts a showtime line it cannot read instead of dropping it silently', () => {
    const broken = WINNIE.replace('November 21 and 22 at 2:30 PM', 'Sunday matinees too')
    const p = parseProductionPage(broken)
    assert.equal(p.showtimes.length, 2)
    assert.equal(p.unparsed, 1)
  })

  it('a page with no Showtimes block yields no performances', () => {
    const p = parseProductionPage('<html><title>Coming Soon - Stow Players</title><h1>Coming Soon</h1></html>')
    assert.equal(p.title, 'Coming Soon')
    assert.deepEqual(p.showtimes, [])
  })
})

describe('year and rows', () => {
  const winnie = { slug: 'winnie-the-pooh', url: 'https://stowplayers.net/production/winnie-the-pooh/', openMonth: 11, openYear: 2026 }

  it('takes the year from the opening date; a month before the opening month is the next year', () => {
    assert.equal(yearFor(winnie, 11, 20), 2026)
    assert.equal(yearFor({ openMonth: 12, openYear: 2026 }, 1, 3), 2027) // a run that crosses New Year
    assert.equal(yearFor({ openMonth: 2, openYear: 2027 }, 2, 5), 2027)
  })

  it('falls back to the nearest year when the home page gave no date', () => {
    assert.equal(yearFor({ slug: 'x' }, 12, 4, new Date(NOW)), 2026)
    assert.equal(yearFor({ slug: 'x' }, 2, 5, new Date(NOW)), 2027)
  })

  it('builds a 7:30 PM Eastern performance row at the Heritage Barn', () => {
    const page = parseProductionPage(WINNIE)
    const { row, venue } = buildRow(winnie, page, page.showtimes[0])
    assert.equal(row.start_at, '2026-11-21T00:30:00.000Z') // Nov 20, 7:30 PM EST
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'winnie-the-pooh-2026-11-20-1930')
    assert.deepEqual(row.categories, ['theater'])
    assert.equal(row.price_min, null) // the site publishes no price
    assert.equal(row.ticket_url, 'https://app.arts-people.com/index.php?show=327554')
    assert.equal(venue, MAIN_VENUE)
    assert.equal(venue.details.city, 'Stow')
  })

  it('two performances on one day get different ids', () => {
    const page = parseProductionPage(WINNIE)
    const ids = page.showtimes.map((s) => buildRow(winnie, page, s).row.source_id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.includes('winnie-the-pooh-2026-11-21-1930') && ids.includes('winnie-the-pooh-2026-11-21-1430'))
  })

  it('improv is comedy first, and falls back to the show page when there is no ticket link', () => {
    const production = { slug: 'mid-life-crisis-improv-fall', url: 'https://stowplayers.net/production/mid-life-crisis-improv-fall/', openMonth: 11, openYear: 2026 }
    const page = parseProductionPage(IMPROV)
    const { row } = buildRow(production, page, page.showtimes[0])
    assert.deepEqual(row.categories, ['comedy', 'theater'])
    assert.equal(row.ticket_url, production.url)
  })

  it('refuses a row with no title or slug', () => {
    assert.deepEqual(buildRow({}, { title: 'X' }, { month: 1, day: 1, time: '7:30 pm', hhmm: '1930' }), { skip: 'invalid' })
    assert.deepEqual(buildRow(winnie, { title: '' }, { month: 1, day: 1, time: '7:30 pm', hhmm: '1930' }), { skip: 'invalid' })
  })
})

describe('run (dry, fixtures served by a fake fetch)', () => {
  const pages = {
    'https://stowplayers.net/': HOME,
    'https://stowplayers.net/production/winnie-the-pooh/': WINNIE,
    'https://stowplayers.net/production/an-old-fashioned-family-murder/': MURDER,
    'https://stowplayers.net/production/mid-life-crisis-improv-fall/': IMPROV,
  }
  const fetchImpl = async (url) => {
    const body = pages[String(url)]
    return body
      ? { ok: true, status: 200, text: async () => body }
      : { ok: false, status: 404, text: async () => '' }
  }

  it('plans every upcoming performance, skips the past one, and survives pages that fail', async () => {
    const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.exitCode, 0)
    assert.equal(result.found, 15)   // 4 Winnie + 10 Murder + 1 improv (Nov 14, already past)
    assert.equal(result.planned, 14)
  })

  it('an empty season is not an error', async () => {
    const empty = async () => ({ ok: true, status: 200, text: async () => '<html><body>See you next season</body></html>' })
    const result = await run({ dryRun: true, fetchImpl: empty, now: () => NOW, delayMs: 0 })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 0)
  })
})
