/**
 * test-nightlight.js
 *
 * Tests for the Nightlight Cinema scraper's HTML + JSON-LD parsing.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseHomeScreenings,
  extractMovieSlugs,
  titleToSlug,
  matchSlug,
  showtimeToUtcIso,
  todayEasternYmd,
  mapAgeRestriction,
  parseMoviePage,
  parseMovieDateLine,
  parseMovieShowtimes,
  buildEventRow,
} from '../scrape-nightlight.js'

import {
  HOME_HTML,
  HOME_HTML_EMPTY,
  HOME_HTML_MISSING_SCREEN_LINE,
  MOVIE_PAGE_HTML,
  MOVIE_PAGE_NO_LD,
  MOVIE_PAGE_GRAPH,
  SITEMAP_XML,
} from './fixtures/nightlight-events.js'

// ── parseHomeScreenings ───────────────────────────────────────────────────

describe('Nightlight: parseHomeScreenings', () => {
  it('extracts two screening blocks from a normal home page', () => {
    const out = parseHomeScreenings(HOME_HTML)
    assert.equal(out.length, 2)
    assert.equal(out[0].title, 'The Christophers')
    assert.equal(out[0].screen, 'Screen 2')
    assert.equal(out[0].timeStr, '5:50 PM')
    assert.equal(out[0].runtimeMin, 100)
    assert.equal(out[0].genre, 'Crime')
    assert.equal(out[1].title, 'Exit 8')
    assert.equal(out[1].timeStr, '8:00 PM')
    assert.equal(out[1].runtimeMin, 95)
    assert.equal(out[1].genre, 'Horror')
  })

  it('returns [] when no "Standard Screening" markers are present', () => {
    assert.deepEqual(parseHomeScreenings(HOME_HTML_EMPTY), [])
  })

  it('tolerates a missing Screen line (optional field)', () => {
    const out = parseHomeScreenings(HOME_HTML_MISSING_SCREEN_LINE)
    assert.equal(out.length, 1)
    assert.equal(out[0].title, 'Silence of the Lambs 35th Anniversary')
    assert.equal(out[0].screen, null)
    assert.equal(out[0].timeStr, '7:00 PM')
  })

  it('does not crash on empty / null input', () => {
    assert.deepEqual(parseHomeScreenings(null), [])
    assert.deepEqual(parseHomeScreenings(''), [])
  })
})

// ── parseMovieDateLine ────────────────────────────────────────────────────

describe('Nightlight: parseMovieDateLine', () => {
  it('parses bare day-of-week date headers', () => {
    assert.equal(parseMovieDateLine('Sat, May 23, 2026'), '2026-05-23')
    assert.equal(parseMovieDateLine('Sun, May 24, 2026'), '2026-05-24')
  })
  it('strips Today/Tomorrow prefixes', () => {
    assert.equal(parseMovieDateLine('Today Thu, May 21, 2026'), '2026-05-21')
    assert.equal(parseMovieDateLine('Tomorrow Fri, May 22, 2026'), '2026-05-22')
  })
  it('handles full + abbreviated day names', () => {
    assert.equal(parseMovieDateLine('Wednesday, May 27, 2026'), '2026-05-27')
  })
  it('returns null for non-date strings', () => {
    assert.equal(parseMovieDateLine('Screen 1'), null)
    assert.equal(parseMovieDateLine('6:15 PM'), null)
    assert.equal(parseMovieDateLine(''), null)
    assert.equal(parseMovieDateLine(null), null)
  })
})

// ── parseMovieShowtimes ───────────────────────────────────────────────────

describe('Nightlight: parseMovieShowtimes', () => {
  // Synthetic HTML modelled on the live /movie/obsession/ DOM. Each block
  // is a date/screen/time triplet, closed by the cookie banner footer.
  const SAMPLE_MOVIE_HTML = `
    <div>Showtimes</div>
    <div>All</div><div>Today</div><div>Tomorrow</div>
    <div>Today Thu, May 21, 2026</div>
    <div>Screen 1</div><div>6:15 PM</div><div>8:30 PM</div>
    <div>Tomorrow Fri, May 22, 2026</div>
    <div>Screen 1</div><div>5:30 PM</div><div>7:45 PM</div>
    <div>Sat, May 23, 2026</div>
    <div>Screen 1</div><div>3:45 PM</div><div>6:05 PM</div><div>8:30 PM</div>
    <div>Sun, May 24, 2026</div>
    <div>Screen 1</div><div>2:10 PM</div><div>7:00 PM</div>
    <div>This website uses cookies. For more information, see our Cookie Policy.</div>
    <div>Accept &amp; Dismiss</div>
  `

  it('extracts all date/screen/time triplets across 4 days', () => {
    const out = parseMovieShowtimes(SAMPLE_MOVIE_HTML)
    // 2 + 2 + 3 + 2 = 9 showtimes
    assert.equal(out.length, 9)
    assert.deepEqual(out[0], { dateYmd: '2026-05-21', screen: 'Screen 1', timeStr: '6:15 PM' })
    assert.deepEqual(out[2], { dateYmd: '2026-05-22', screen: 'Screen 1', timeStr: '5:30 PM' })
    assert.deepEqual(out[5], { dateYmd: '2026-05-23', screen: 'Screen 1', timeStr: '6:05 PM' })
    assert.deepEqual(out[6], { dateYmd: '2026-05-23', screen: 'Screen 1', timeStr: '8:30 PM' })
    assert.deepEqual(out[7], { dateYmd: '2026-05-24', screen: 'Screen 1', timeStr: '2:10 PM' })
  })

  it('returns [] when no showtimes are present', () => {
    assert.deepEqual(parseMovieShowtimes('<div>Showtimes</div><div>No upcoming screenings</div>'), [])
  })

  it('does not crash on empty / null input', () => {
    assert.deepEqual(parseMovieShowtimes(null), [])
    assert.deepEqual(parseMovieShowtimes(''), [])
  })
})

// ── extractMovieSlugs ─────────────────────────────────────────────────────

describe('Nightlight: extractMovieSlugs', () => {
  it('finds every /movie/{slug}/ reference in HTML', () => {
    const slugs = extractMovieSlugs(HOME_HTML)
    assert.ok(slugs.includes('the-christophers'))
    assert.ok(slugs.includes('exit-8'))
    assert.equal(slugs.length, 2)
  })

  it('finds slugs in sitemap XML', () => {
    const slugs = extractMovieSlugs(SITEMAP_XML)
    assert.ok(slugs.includes('the-christophers'))
    assert.ok(slugs.includes('exit-8'))
    assert.ok(slugs.includes('city-wide-fever'))
    assert.ok(slugs.includes('the-silence-of-the-lambs-35th-anniversary'))
    assert.equal(slugs.length, 4)
  })

  it('deduplicates repeated references', () => {
    const html = '<a href="/movie/foo/">F</a><a href="/movie/foo/">F</a>'
    assert.deepEqual(extractMovieSlugs(html), ['foo'])
  })

  it('returns [] for empty input', () => {
    assert.deepEqual(extractMovieSlugs(null), [])
    assert.deepEqual(extractMovieSlugs(''), [])
  })
})

// ── titleToSlug / matchSlug ───────────────────────────────────────────────

describe('Nightlight: titleToSlug / matchSlug', () => {
  it('kebab-cases titles', () => {
    assert.equal(titleToSlug('The Christophers'), 'the-christophers')
    assert.equal(titleToSlug("Kiki's Delivery Service"), 'kikis-delivery-service')
    assert.equal(titleToSlug('Love, Brooklyn'), 'love-brooklyn')
    assert.equal(titleToSlug('Cat & Mouse'), 'cat-and-mouse')
    assert.equal(titleToSlug('The Silence Of The Lambs 35th Anniversary'), 'the-silence-of-the-lambs-35th-anniversary')
  })

  it('returns null for unknown title', () => {
    assert.equal(titleToSlug(null), '')
    assert.equal(titleToSlug(''), '')
  })

  it('matches an exact candidate', () => {
    const candidates = ['the-christophers', 'exit-8']
    assert.equal(matchSlug('The Christophers', candidates), 'the-christophers')
  })

  it('falls back to a prefix match when exact is missing', () => {
    // Candidate has a suffix the title lacks
    const candidates = ['silence-of-the-lambs-35th-anniversary']
    assert.equal(matchSlug('Silence of the Lambs', candidates), 'silence-of-the-lambs-35th-anniversary')
  })

  it('returns null when nothing plausibly matches', () => {
    assert.equal(matchSlug('Completely Unrelated Film', ['the-christophers']), null)
    assert.equal(matchSlug(null, ['x']), null)
  })
})

// ── Time conversion ──────────────────────────────────────────────────────

describe('Nightlight: showtimeToUtcIso', () => {
  it('converts PM times on a DST date', () => {
    // May 10 2026 is EDT (UTC-4): 5:50 PM → 21:50 UTC
    assert.equal(showtimeToUtcIso('5:50 PM', '2026-05-10'), '2026-05-10T21:50:00.000Z')
  })

  it('converts PM times on a non-DST date', () => {
    // Jan 10 2026 is EST (UTC-5): 5:50 PM → 22:50 UTC
    assert.equal(showtimeToUtcIso('5:50 PM', '2026-01-10'), '2026-01-10T22:50:00.000Z')
  })

  it('converts 12:XX AM / PM correctly', () => {
    // 12:00 AM = midnight local
    assert.equal(showtimeToUtcIso('12:00 AM', '2026-05-10'), '2026-05-10T04:00:00.000Z') // EDT
    // 12:00 PM = noon local
    assert.equal(showtimeToUtcIso('12:00 PM', '2026-05-10'), '2026-05-10T16:00:00.000Z')
  })

  it('returns null on malformed input', () => {
    assert.equal(showtimeToUtcIso(null, '2026-05-10'), null)
    assert.equal(showtimeToUtcIso('5:50 PM', null), null)
    assert.equal(showtimeToUtcIso('not a time', '2026-05-10'), null)
  })
})

describe('Nightlight: todayEasternYmd', () => {
  it('returns YYYY-MM-DD shape', () => {
    const s = todayEasternYmd()
    assert.match(s, /^\d{4}-\d{2}-\d{2}$/)
  })

  it('matches Eastern local date for a UTC instant near midnight', () => {
    // 2026-05-10T03:30:00Z = 2026-05-09 23:30 EDT — yesterday in Eastern
    const when = new Date('2026-05-10T03:30:00Z')
    assert.equal(todayEasternYmd(when), '2026-05-09')
  })
})

// ── mapAgeRestriction ─────────────────────────────────────────────────────

describe('Nightlight: mapAgeRestriction', () => {
  it('maps MPAA ratings', () => {
    assert.equal(mapAgeRestriction('G'),     'all_ages')
    assert.equal(mapAgeRestriction('PG'),    'all_ages')
    assert.equal(mapAgeRestriction('PG-13'), 'not_specified')  // no exact bucket
    assert.equal(mapAgeRestriction('R'),     '18_plus')
    assert.equal(mapAgeRestriction('NC-17'), '18_plus')
  })

  it('treats NR, null, odd strings as not_specified', () => {
    assert.equal(mapAgeRestriction('NR'),      'not_specified')
    assert.equal(mapAgeRestriction(null),      'not_specified')
    assert.equal(mapAgeRestriction(''),        'not_specified')
    assert.equal(mapAgeRestriction('Unrated'), 'not_specified')
  })
})

// ── parseMoviePage ────────────────────────────────────────────────────────

describe('Nightlight: parseMoviePage', () => {
  it('extracts Movie metadata from JSON-LD', () => {
    const meta = parseMoviePage(MOVIE_PAGE_HTML)
    assert.equal(meta.title, 'The Silence Of The Lambs 35th Anniversary')
    assert.ok(meta.description.includes('FBI trainee'))
    assert.equal(meta.durationMin, 123)
    assert.equal(meta.genre, 'Crime')
    assert.equal(meta.contentRating, 'R')
    assert.ok(meta.imageUrl.startsWith('https://indy-systems.imgix.net/'))
  })

  it('returns {} when no JSON-LD is present', () => {
    assert.deepEqual(parseMoviePage(MOVIE_PAGE_NO_LD), {})
  })

  it('handles @graph-wrapped JSON-LD', () => {
    const meta = parseMoviePage(MOVIE_PAGE_GRAPH)
    assert.equal(meta.title, "Kiki's Delivery Service")
    assert.equal(meta.durationMin, 103)
    assert.equal(meta.genre, 'Animation')
    assert.equal(meta.contentRating, 'G')
    assert.equal(meta.imageUrl, 'https://indy-systems.imgix.net/kiki')
  })
})

// ── buildEventRow end-to-end ─────────────────────────────────────────────

describe('Nightlight: buildEventRow', () => {
  const screening = { title: 'Exit 8', screen: 'Screen 1', timeStr: '8:00 PM', runtimeMin: 95, genre: 'Horror' }
  const movieMeta = { title: 'Exit 8', description: 'A lost commuter.', durationMin: 95, genre: 'Horror', contentRating: 'PG-13', imageUrl: 'https://indy-systems.imgix.net/exit8' }

  it('assembles a complete event row', () => {
    const row = buildEventRow({ slug: 'exit-8', screening, movieMeta, easternDateYmd: '2026-05-10' })
    assert.ok(row)
    assert.equal(row.source, 'nightlight_cinema')
    assert.equal(row.source_id, 'exit-8-2026-05-11T00:00:00.000Z')
    assert.equal(row.start_at, '2026-05-11T00:00:00.000Z')      // 8PM EDT → midnight UTC next day
    assert.equal(row.end_at,   '2026-05-11T01:35:00.000Z')      // +95 min
    assert.equal(row.title, 'Exit 8')
    assert.equal(row.category, 'film')
    assert.deepEqual(row.tags, ['film', 'cinema', 'horror'])
    assert.equal(row.age_restriction, 'not_specified')   // PG-13 has no exact bucket
    assert.equal(row.ticket_url, 'https://nightlightcinema.com/movie/exit-8/')
    assert.equal(row.image_url, 'https://indy-systems.imgix.net/exit8')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
  })

  it('falls back to screening title when movieMeta.title is missing', () => {
    const row = buildEventRow({ slug: 'x', screening, movieMeta: {}, easternDateYmd: '2026-05-10' })
    assert.equal(row.title, 'Exit 8')
  })

  it('leaves end_at null when no duration is known', () => {
    const bare = { title: 'Foo', timeStr: '7:00 PM' }
    const row = buildEventRow({ slug: 'foo', screening: bare, movieMeta: {}, easternDateYmd: '2026-05-10' })
    assert.equal(row.end_at, null)
  })

  it('synthesises a slug from title when none is passed', () => {
    const bare = { title: 'Linda Linda Linda', timeStr: '7:00 PM' }
    const row = buildEventRow({ slug: null, screening: bare, movieMeta: {}, easternDateYmd: '2026-05-10' })
    assert.ok(row.source_id.startsWith('linda-linda-linda-'))
    assert.equal(row.ticket_url, 'https://nightlightcinema.com/home/')   // no slug → home fallback
  })

  it('returns null when showtime cannot be parsed', () => {
    const bad = { title: 'Foo', timeStr: 'whenever' }
    const row = buildEventRow({ slug: 'foo', screening: bad, movieMeta: {}, easternDateYmd: '2026-05-10' })
    assert.equal(row, null)
  })
})
