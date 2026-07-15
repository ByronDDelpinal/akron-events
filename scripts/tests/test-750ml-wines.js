/**
 * test-750ml-wines.js — pure helpers for the 750ml Wines HTML scraper.
 *
 * Fixtures mirror the REAL markup captured 2026-07-15:
 *   • /akron-events/ list page: image tiles linking to detail pages, plus the
 *     "Live Music" prose whose weekday words did NOT match their dates.
 *   • Detail pages: structured 📅/⏰/📍 block + "Club750 Members / General
 *     Admission" price list + og: meta.
 *
 * Run:  node --test scripts/tests/test-750ml-wines.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  extractEventLinks, cleanEventTitle, parseDetailDate, normalizeClock,
  parseDetailPrice, parseDetailPage, parseDetailCategory,
  parseLiveMusicTime, parseLiveMusicEvents, extractLiveMusicSection,
  easternToday, SOURCE_KEY,
} = await import('../scrape-750ml-wines.js')

// ── Fixtures ────────────────────────────────────────────────────────────────

const LIST_HTML = `
  <div class="events">
    <a href="https://750mlwines.com/akron-events/wine-and-cigar-night/">
      <img decoding="async" src="https://750mlwines.com/wp-content/uploads/2026/06/wine-cigars-791x1024.png" alt="wine &amp; cigars" />
    </a>
    <a href="https://750mlwines.com/akron-events/wine-and-cigar-night/">Click for details</a>
    <a href="https://750mlwines.com/akron-events/una-serata-italiana/">
      <img src="https://750mlwines.com/wp-content/uploads/2026/06/Una-Serata-Italiana-Event-819x1024.png" alt="Una Serata Italiana Event" />
    </a>
    <a href="https://750mlwines.com/akron-events/">Akron Events</a>
    <a href="https://750mlwines.com/reservations/">Reservations</a>
  </div>
  <section>
    <h3>Live Music In Akron - Saturday Nights from 6pm - 8pm</h3>
    <p>Saturday, July 13th - Ceci Taylor</p>
    <p>Saturday, July 20th - Pat Sandy</p>
    <p>Saturday, August 17th &amp; October 12th - Daniel Rylander</p>
    <p>Saturday, July 18th - Correct Weekday Act</p>
    <p>Friday, November 6th &amp; 13th - Month Carry Duo</p>
    <p>2287 W. Market Street</p>
    <p>Akron, OH 44313</p>
  </section>`

const DETAIL_CIGAR = `
  <meta property="og:title" content="Turnbull Wine &amp; Tatuaje Cigar Night in Akron on July 14" />
  <meta property="og:description" content="Four Turnbull wines paired with a premium Tatuaje cigar." />
  <meta property="og:image" content="https://750mlwines.com/wp-content/uploads/2026/06/wine-cigars.png" />
  <ul>
    <li>📅 Tuesday, July 14, 2026</li>
    <li>⏰ 6:30 PM</li>
    <li>📍 750 ML Wines, Akron</li>
    <li>🍷 4 Wines + Premium Cigar</li>
  </ul>
  <ul>
    <li><strong>Club750 Members:</strong> $35</li>
    <li><strong>General Admission:</strong> $49</li>
  </ul>`

const DETAIL_ITALIANA = `
  <meta property="og:title" content="Una Serata Italiana | Italian Wine Patio Night on July 22" />
  <meta property="og:description" content="An evening of Italian wine and charcuterie on the patio." />
  <meta property="og:image" content="https://750mlwines.com/wp-content/uploads/2026/06/serata.png" />
  <ul>
    <li>📅 Wednesday, July 22, 2026</li>
    <li>⏰ 6:30 PM</li>
    <li>📍 750 ML Wines Patio, Akron</li>
  </ul>
  <ul>
    <li><strong>Club750 Members:</strong> $19</li>
    <li><strong>General Admission:</strong> $25</li>
  </ul>`

// Deterministic "now": noon ET on 2026-07-15.
const NOW = Date.parse('2026-07-15T16:00:00Z')

// ── extractEventLinks ───────────────────────────────────────────────────────

describe('extractEventLinks', () => {
  const links = extractEventLinks(LIST_HTML)
  it('finds the two detail pages, de-duplicated by slug', () => {
    assert.deepEqual(links.map((l) => l.slug).sort(), ['una-serata-italiana', 'wine-and-cigar-night'])
  })
  it('excludes the /akron-events/ list page itself and nav links', () => {
    assert.ok(!links.some((l) => l.url.endsWith('/akron-events/')))
    assert.ok(!links.some((l) => /reservations/.test(l.url)))
  })
  it('captures the tile image and decoded alt text', () => {
    const cigar = links.find((l) => l.slug === 'wine-and-cigar-night')
    assert.match(cigar.imageUrl, /wine-cigars-791x1024\.png$/)
    assert.equal(cigar.alt, 'wine & cigars')
  })
})

// ── cleanEventTitle ─────────────────────────────────────────────────────────

describe('cleanEventTitle', () => {
  it('strips " in Akron on <date>" promo suffix', () => {
    assert.equal(
      cleanEventTitle('Turnbull Wine &amp; Tatuaje Cigar Night in Akron on July 14'),
      'Turnbull Wine & Tatuaje Cigar Night')
  })
  it('keeps the segment before a pipe', () => {
    assert.equal(
      cleanEventTitle('Una Serata Italiana | Italian Wine Patio Night on July 22'),
      'Una Serata Italiana')
  })
})

// ── parseDetailDate / normalizeClock ────────────────────────────────────────

describe('parseDetailDate', () => {
  it('parses "Weekday, Month D, YYYY" ignoring the weekday word', () => {
    assert.equal(parseDetailDate('Tuesday, July 14, 2026'), '2026-07-14')
    assert.equal(parseDetailDate('Wednesday, July 22, 2026'), '2026-07-22')
  })
  it('returns null when no date is present', () => {
    assert.equal(parseDetailDate('4 Wines + Premium Cigar'), null)
  })
})

describe('normalizeClock', () => {
  it('normalizes meridiem clocks', () => {
    assert.equal(normalizeClock('6:30 PM'), '6:30 pm')
    assert.equal(normalizeClock('6 PM'), '6:00 pm')
    assert.equal(normalizeClock('Noon'), '12:00 pm')
  })
  it('rejects garbage', () => {
    assert.equal(normalizeClock('soon'), null)
    assert.equal(normalizeClock(''), null)
  })
})

// ── parseDetailPrice ────────────────────────────────────────────────────────

describe('parseDetailPrice', () => {
  it('reads member + general admission as a min/max range', () => {
    assert.deepEqual(parseDetailPrice(DETAIL_CIGAR), { priceMin: 35, priceMax: 49 })
    assert.deepEqual(parseDetailPrice(DETAIL_ITALIANA), { priceMin: 19, priceMax: 25 })
  })
  it('does not read the "Club750" label as a $750 price', () => {
    const { priceMax } = parseDetailPrice(DETAIL_CIGAR)
    assert.ok(priceMax < 100)
  })
  it('is null/null when no price is stated (never assumes free)', () => {
    assert.deepEqual(parseDetailPrice('<p>No prices here</p>'), { priceMin: null, priceMax: null })
  })
  it('mirrors a single stated price', () => {
    assert.deepEqual(
      parseDetailPrice('<li><strong>General Admission:</strong> $40</li>'),
      { priceMin: 40, priceMax: 40 })
  })
})

// ── parseDetailPage ─────────────────────────────────────────────────────────

describe('parseDetailPage', () => {
  it('parses the full structured block (cigar night)', () => {
    const d = parseDetailPage(DETAIL_CIGAR)
    assert.equal(d.title, 'Turnbull Wine & Tatuaje Cigar Night')
    assert.equal(d.dateStr, '2026-07-14')
    assert.equal(d.timeStr, '6:30 pm')
    assert.equal(d.priceMin, 35)
    assert.equal(d.priceMax, 49)
    assert.equal(d.isPatio, false)
    assert.match(d.imageUrl, /wine-cigars\.png$/)
  })
  it('detects the patio location (una serata)', () => {
    const d = parseDetailPage(DETAIL_ITALIANA)
    assert.equal(d.dateStr, '2026-07-22')
    assert.equal(d.isPatio, true)
  })
})

// ── parseDetailCategory ─────────────────────────────────────────────────────

describe('parseDetailCategory', () => {
  it('wine/cigar/tasting → food', () => {
    assert.equal(parseDetailCategory('Wine & Cigar Night', 'Turnbull wines and a cigar'), 'food')
    assert.equal(parseDetailCategory('Una Serata Italiana', 'Italian wine and charcuterie'), 'food')
  })
  it('an explicit concert → music', () => {
    assert.equal(parseDetailCategory('Summer Concert Series', 'live music on the patio'), 'music')
  })
})

// ── Live-music prose + weekday-integrity guard ──────────────────────────────

describe('parseLiveMusicTime', () => {
  it('reads the header time range', () => {
    assert.deepEqual(
      parseLiveMusicTime('Saturday Nights from 6pm - 8pm'),
      { timeStr: '6:00 pm', endTimeStr: '8:00 pm' })
  })
})

describe('extractLiveMusicSection', () => {
  it('isolates the Live Music block', () => {
    const sec = extractLiveMusicSection(LIST_HTML)
    assert.match(sec, /Live Music/)
    assert.match(sec, /Ceci Taylor/)
  })
})

describe('parseLiveMusicEvents', () => {
  const section = extractLiveMusicSection(LIST_HTML)
  const events = parseLiveMusicEvents(section, { nowMs: NOW })

  it('flags the real (stale) rows as weekday mismatches — all four listed "Saturday" dates are Mondays in 2026', () => {
    const stale = events.filter((e) => ['Ceci Taylor', 'Pat Sandy', 'Daniel Rylander'].includes(e.performer))
    assert.ok(stale.length >= 4)
    assert.ok(stale.every((e) => e.weekdayMatches === false))
  })
  it('expands a two-date line into two occurrences (Aug 17 & Oct 12)', () => {
    const rylander = events.filter((e) => e.performer === 'Daniel Rylander').map((e) => e.dateStr).sort()
    assert.deepEqual(rylander, ['2026-08-17', '2026-10-12'])
  })
  it('passes a genuinely-Saturday date through the guard', () => {
    const good = events.find((e) => e.performer === 'Correct Weekday Act')
    assert.equal(good.dateStr, '2026-07-18') // a real Saturday in 2026
    assert.equal(good.weekdayMatches, true)
    assert.equal(good.isFuture, true)
  })
  it('carries the month forward for a bare second day ("November 6th & 13th")', () => {
    const duo = events.filter((e) => e.performer === 'Month Carry Duo').map((e) => e.dateStr).sort()
    assert.deepEqual(duo, ['2026-11-06', '2026-11-13'])
  })
  it('attaches the header time to each occurrence', () => {
    const good = events.find((e) => e.performer === 'Correct Weekday Act')
    assert.equal(good.timeStr, '6:00 pm')
    assert.equal(good.endTimeStr, '8:00 pm')
  })
  it('marks a past date as not future (July 13 < today)', () => {
    const ceci = events.find((e) => e.performer === 'Ceci Taylor')
    assert.equal(ceci.isFuture, false)
  })
})

// ── easternToday ────────────────────────────────────────────────────────────

describe('easternToday', () => {
  it('anchors to the Eastern calendar day (not local/UTC)', () => {
    const { year, ms } = easternToday(NOW)
    assert.equal(year, 2026)
    assert.equal(ms, Date.UTC(2026, 6, 15))
  })
})

// ── module contract ─────────────────────────────────────────────────────────

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, '750ml_wines')
  })
})
