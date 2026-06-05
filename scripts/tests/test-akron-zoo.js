/**test-akron-zoo.js — unit tests for the Akron Zoo scraper's parsing logic*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DATE_FIXTURES, CARD_HTML, FIXTURE_1, FIXTURE_2, ALL_FIXTURES } from './fixtures/zoo-events.js'

// ── Helpers (inlined to avoid importing the scraper which requires .env) ───

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

function parseDateText(raw) {
  if (!raw) return { dateStr: null, timeStr: '09:00:00' }
  const s = raw.trim()

  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) {
    const timeMatch = s.match(/T(\d{2}:\d{2})/)
    return { dateStr: isoMatch[1], timeStr: timeMatch ? timeMatch[1] + ':00' : '09:00:00' }
  }

  let timeStr = '09:00:00'

  // "Month DD, YYYY" or "Month DD-DD, YYYY"
  const fullMatch = s.match(/([A-Za-z]+)\s+(\d{1,2})(?:-\d{1,2})?,?\s*(\d{4})/)
  if (fullMatch) {
    const [, mon, day, year] = fullMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) return {
      dateStr: `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`,
      timeStr,
    }
  }

  // "Month DD" no year (zoo format: "JUN 13", "OCT 3 & OCT 4", "JUL 24 - JUL 26", etc.)
  const shortMatch = s.match(/([A-Za-z]+)\s+(\d{1,2})/)
  if (shortMatch) {
    const [, mon, day] = shortMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = new Date().getFullYear()
      return {
        dateStr: `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`,
        timeStr,
      }
    }
  }

  return { dateStr: null, timeStr }
}

/**
 * Mirrors the parseEvents logic in scrape-akron-zoo.js.
 * Extracts events from the zoo's card HTML structure:
 *   <div class="item xxtight"><a href="...">...<div class="date">JUN 13</div></a></div>
 */
function parseEvents(html) {
  const events = []
  const seen   = new Set()

  const cardRegex = /<div[^>]*class="[^"]*\bitem\b[^"]*\bxxtight\b[^"]*"[^>]*>([\s\S]*?<\/a>)\s*<\/div>/gi
  for (const match of html.matchAll(cardRegex)) {
    const cardHtml = match[1]

    const hrefMatch = cardHtml.match(/<a[^>]*href="([^"]+)"/)
    const href = hrefMatch ? hrefMatch[1] : null

    const textDivMatch = cardHtml.match(/<div[^>]*class="text"[^>]*>([\s\S]*?)<\/div>/i)
    let title = null, rawDate = null
    if (textDivMatch) {
      const inner = textDivMatch[1]
      const dateSpanMatch = inner.match(/<span[^>]*class="date"[^>]*>([\s\S]*?)<\/span>/i)
      rawDate = dateSpanMatch ? stripHtml(dateSpanMatch[1]).trim() : null
      title = stripHtml(
        inner
          .replace(/<span[^>]*class="date"[^>]*>[\s\S]*?<\/span>/gi, '')
          .replace(/<br\s*\/?>/gi, ' ')
      ).replace(/\s+/g, ' ').trim()
    }
    if (!title || title.length < 3) continue

    const { dateStr } = parseDateText(rawDate ?? '')
    const slug = href ? href.replace(/^\//, '').replace(/\?.*$/, '') : title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const sourceId = dateStr ? `${slug}-${dateStr}` : slug

    if (seen.has(sourceId)) continue
    seen.add(sourceId)

    events.push({ title, dateStr, href, sourceId })
  }

  return events
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Zoo: Date Parsing — zoo abbreviated formats', () => {
  for (const { raw, expectedDate } of DATE_FIXTURES) {
    it(`parses "${raw}"`, () => {
      const { dateStr } = parseDateText(raw)
      assert.equal(dateStr, expectedDate)
    })
  }
})

describe('Zoo: Date Parsing — legacy long formats', () => {
  it('parses "July 15, 2026"', () => {
    const { dateStr } = parseDateText(FIXTURE_1.raw)
    assert.equal(dateStr, FIXTURE_1.expectedDate)
  })

  it('parses "December 25, 2026"', () => {
    const { dateStr } = parseDateText(FIXTURE_2.raw)
    assert.equal(dateStr, FIXTURE_2.expectedDate)
  })

  it('all legacy fixtures parse successfully', () => {
    for (const fixture of ALL_FIXTURES) {
      const { dateStr } = parseDateText(fixture.raw)
      assert.equal(dateStr, fixture.expectedDate)
    }
  })
})

describe('Zoo: Card HTML Parsing', () => {
  it('extracts all event cards from fixture HTML', () => {
    const events = parseEvents(CARD_HTML)
    assert.equal(events.length, 3)
  })

  it('extracts correct title from first card', () => {
    const events = parseEvents(CARD_HTML)
    assert.equal(events[0].title, "Lions, Tigers and Bears...OH MY!")
  })

  it('extracts correct href from first card', () => {
    const events = parseEvents(CARD_HTML)
    assert.equal(events[0].href, '/lions-tigers-and-bearsoh-my')
  })

  it('extracts correct date from first card', () => {
    const events = parseEvents(CARD_HTML)
    assert.equal(events[0].dateStr, '2026-06-13')
  })

  it('disambiguates recurring events by date in source_id', () => {
    const events = parseEvents(CARD_HTML)
    const zoothing = events.filter(e => e.href === '/zoothing-hour')
    assert.equal(zoothing.length, 2, 'both Zoothing Hour occurrences should be kept')
    assert.notEqual(zoothing[0].sourceId, zoothing[1].sourceId, 'source_ids must differ')
  })
})
