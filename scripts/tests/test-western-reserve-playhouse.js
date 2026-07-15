/** test-western-reserve-playhouse.js */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  parseFullEvents,
  groupRuns,
  resolveCategory,
  buildNonMainstageRow,
  normalizeMainstageItem,
  easternTodayIso,
} from '../scrape-western-reserve-playhouse.js'

// A realistic slice of the FULL_EVENTS array baked into /nowplaying's calendar
// code block (captured 2026-07-14). Mainstage rows omit `time`; every other
// series carries an explicit time. Includes a literal "&" in a title and a
// title ("Broadway Bingo") that repeats months apart.
const NOW_PLAYING_HTML = `
<script>
(function(){
  const FULL_EVENTS = [
    { date:"2026-08-01", title:"Vintage & Craft Show", time:"10:00 AM", tag:"Special Event", url:"https://www.thewrp.org/vintage-craft-show" },
    { date:"2026-07-31", title:"Broadway Bingo", time:"8:00 PM", tag:"Cabaret", url:"https://www.thewrp.org/bingo" },
    { date:"2026-10-02", title:"Broadway Bingo", time:"8:00 PM", tag:"Cabaret", url:"https://www.thewrp.org/bingo" },
    { date:"2026-08-29", title:"Oz Series I", time:"7:00 PM", tag:"Young Artists", url:"https://www.thewrp.org/youngartists" },
    { date:"2026-08-30", title:"Oz Series I", time:"2:00 PM", tag:"Young Artists", url:"https://www.thewrp.org/youngartists" },
    { date:"2026-08-09", title:"The Kentucky Cycle: Tall Tales", time:"2:00 PM", tag:"Five Bucks", url:"https://www.thewrp.org/fivebucks" },
    { date:"2026-12-19", title:"WRP Awards Ceremony", time:"8:00 PM", tag:"Special Event", url:"https://www.thewrp.org" },
    { date:"2026-07-17", title:"Godspell", tag:"Mainstage", url:"https://www.thewrp.org/mainstageseason/godspell" },
    { date:"2026-07-18", title:"Godspell", tag:"Mainstage", url:"https://www.thewrp.org/mainstageseason/godspell" }
  ];
})();
</script>`

// A real Mainstage Squarespace Events-collection item (trimmed). `body` is
// layout markup; the synopsis lives in `excerpt`.
const GODSPELL_ITEM = {
  id:        '68xyzGODSPELL',
  urlId:     'godspell',
  title:     'Godspell',
  fullUrl:   '/mainstageseason/godspell',
  assetUrl:  'https://images.squarespace-cdn.com/content/v1/x/godspell.png',
  excerpt:   '<p style="white-space:pre-wrap;"><em>Godspell</em> was the first major musical theatre offering from Stephen Schwartz.</p>',
  body:      '<div class="sqs-layout"><div class="row"><div class="col"> </div></div></div>',
  startDate: 1784332800302, // 2026-07-17 8:00 PM EDT  → 2026-07-18T00:00:00Z
  endDate:   1785088800302, // 2026-07-26 2:00 PM EDT  → 2026-07-26T18:00:00Z
  starred:   false,
}

describe('WRP: parseFullEvents', () => {
  const rows = parseFullEvents(NOW_PLAYING_HTML)

  it('extracts every row in the array', () => {
    assert.equal(rows.length, 9)
  })

  it('captures date/title/tag/url and decodes literal ampersands', () => {
    const craft = rows.find((r) => r.tag === 'Special Event' && /Vintage/.test(r.title))
    assert.equal(craft.title, 'Vintage & Craft Show')
    assert.equal(craft.date, '2026-08-01')
    assert.equal(craft.time, '10:00 AM')
    assert.equal(craft.url, 'https://www.thewrp.org/vintage-craft-show')
  })

  it('leaves time null for Mainstage rows (no time in source)', () => {
    const ms = rows.filter((r) => r.tag === 'Mainstage')
    assert.equal(ms.length, 2)
    assert.ok(ms.every((r) => r.time === null))
  })

  it('returns [] when the array is absent', () => {
    assert.deepEqual(parseFullEvents('<html>no calendar here</html>'), [])
  })
})

describe('WRP: groupRuns', () => {
  const nonMainstage = parseFullEvents(NOW_PLAYING_HTML).filter((r) => r.tag !== 'Mainstage')
  const runs = groupRuns(nonMainstage)

  it('collapses a contiguous weekend run into one event', () => {
    const oz = runs.find((run) => run[0].title === 'Oz Series I')
    assert.equal(oz.length, 2)
    assert.equal(oz[0].date, '2026-08-29')
    assert.equal(oz[1].date, '2026-08-30')
  })

  it('keeps a title that repeats months apart as separate events', () => {
    const bingo = runs.filter((run) => run[0].title === 'Broadway Bingo')
    assert.equal(bingo.length, 2)
    assert.ok(bingo.every((run) => run.length === 1))
  })

  it('sorts runs by opening date', () => {
    const dates = runs.map((run) => run[0].date)
    assert.deepEqual(dates, [...dates].sort())
  })
})

describe('WRP: resolveCategory', () => {
  it('maps bingo nights to games', () => {
    assert.equal(resolveCategory('Cabaret', 'Broadway Bingo'), 'games')
  })
  it('maps craft/market special events to market', () => {
    assert.equal(resolveCategory('Special Event', 'Vintage & Craft Show'), 'market')
  })
  it('falls back to other for non-market special events', () => {
    assert.equal(resolveCategory('Special Event', 'WRP Awards Ceremony'), 'other')
  })
  it('maps performance series to theater', () => {
    assert.equal(resolveCategory('Five Bucks', 'The Kentucky Cycle: Tall Tales'), 'theater')
    assert.equal(resolveCategory('Cabaret', 'The Gift of Song Cabaret'), 'theater')
    assert.equal(resolveCategory('Young Artists', 'Oz Series I'), 'theater')
  })
})

describe('WRP: buildNonMainstageRow', () => {
  const nonMainstage = parseFullEvents(NOW_PLAYING_HTML).filter((r) => r.tag !== 'Mainstage')
  const runs = groupRuns(nonMainstage)
  const rowFor = (title) => buildNonMainstageRow(runs.find((run) => run[0].title === title))

  it('sets start from the opening performance (8pm EDT → correct UTC)', () => {
    const bingo = rowFor('Broadway Bingo')
    assert.equal(bingo.start_at, '2026-08-01T00:00:00.000Z') // 2026-07-31 8:00 PM EDT
    assert.equal(bingo.end_at, null) // single performance
    assert.equal(bingo.category, 'games')
    assert.equal(bingo.source_id, 'broadway-bingo-2026-07-31')
  })

  it('sets end from the closing performance for a multi-day run', () => {
    const oz = rowFor('Oz Series I')
    assert.equal(oz.start_at, '2026-08-29T23:00:00.000Z') // 7:00 PM EDT
    assert.equal(oz.end_at, '2026-08-30T18:00:00.000Z')   // 2:00 PM EDT
    assert.equal(oz.source_id, 'oz-series-i-2026-08-29')
  })

  it('never assumes a price and keeps status published', () => {
    const craft = rowFor('Vintage & Craft Show')
    assert.equal(craft.price_min, null)
    assert.equal(craft.price_max, null)
    assert.equal(craft.category, 'market')
    assert.equal(craft.status, 'published')
    assert.equal(craft.source, 'western_reserve_playhouse')
  })

  it('produces stable, unique source_ids per event', () => {
    const ids = runs.map((run) => buildNonMainstageRow(run)).map((r) => r.source_id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe('WRP: normalizeMainstageItem', () => {
  const row = normalizeMainstageItem(GODSPELL_ITEM)

  it('uses excerpt (not empty body) for the description', () => {
    assert.match(row.description, /first major musical theatre offering/)
    assert.ok(!/sqs-layout/.test(row.description))
  })

  it('derives whole-second start/end from epoch millis', () => {
    assert.equal(row.start_at, '2026-07-18T00:00:00.000Z')
    assert.equal(row.end_at, '2026-07-26T18:00:00.000Z')
  })

  it('carries image, absolute ticket url, category theater and item-id source_id', () => {
    assert.equal(row.category, 'theater')
    assert.equal(row.image_url, 'https://images.squarespace-cdn.com/content/v1/x/godspell.png')
    assert.equal(row.ticket_url, 'https://www.thewrp.org/mainstageseason/godspell')
    assert.equal(row.source_id, '68xyzGODSPELL')
  })

  it('returns null when there is no start date', () => {
    assert.equal(normalizeMainstageItem({ title: 'x', startDate: null }), null)
  })
})

describe('WRP: easternTodayIso', () => {
  it('formats a fixed instant in America/New_York as YYYY-MM-DD', () => {
    // 2026-01-01 02:00 UTC is still 2025-12-31 21:00 in Eastern.
    assert.equal(easternTodayIso(new Date('2026-01-01T02:00:00Z')), '2025-12-31')
  })
})
