/**
 * test-release-yoga.js — parsing for the Release Yoga MINDBODY enrollments
 * scraper: widget-id discovery, enrollment extraction from the healcode widget
 * markup, date/time resolution, row building, and the window walk.
 *
 * Fixtures: three verbatim responses from the widget's JSON endpoint, captured
 * 2026-11-10 — the default window (Nov 10 - Dec 9, three enrollments), the
 * next one (from Dec 10, three enrollments) and one with no enrollments (from
 * Jan 10). The live fetch is injected, so nothing here touches the network.
 *
 * Run:  node --test scripts/tests/test-release-yoga.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseEnrollments, parseEnrollmentWhen, parseWidgetDate, parseWidgetTime,
  isWidgetMarkup, nextWindowStart, extractWidgetId, fetchAllEnrollments,
  buildRow, SOURCE_KEY, FALLBACK_WIDGET_ID,
} = await import('../scrape-release-yoga.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const raw = (name) => readFileSync(resolve(__dirname, `fixtures/release-yoga-widget-${name}.json`), 'utf8')
const NOV = JSON.parse(raw('2026-11')).contents
const DEC = JSON.parse(raw('2026-12')).contents
const EMPTY = JSON.parse(raw('empty')).contents

describe('Release Yoga extractWidgetId', () => {
  it('reads the enrollments widget id off the studio page tag', () => {
    const page = '<div><healcode-widget data-type="enrollments" data-widget-partner="object" data-widget-id="fe114957e7e9" data-widget-version="0" ></healcode-widget></div>'
    assert.equal(extractWidgetId(page), 'fe114957e7e9')
    assert.equal(FALLBACK_WIDGET_ID, 'fe114957e7e9')
  })
  it('ignores a widget of another type and a page with no widget', () => {
    assert.equal(extractWidgetId('<healcode-widget data-type="schedules" data-widget-id="abc123">'), null)
    assert.equal(extractWidgetId('<html><body>Home</body></html>'), null)
    assert.equal(extractWidgetId(null), null)
  })
})

describe('Release Yoga isWidgetMarkup / nextWindowStart', () => {
  it('recognises the widget list in a full and in an empty window', () => {
    assert.equal(isWidgetMarkup(NOV), true)
    assert.equal(isWidgetMarkup(EMPTY), true, 'an empty month is still the widget')
  })
  it('rejects anything that is not the widget', () => {
    assert.equal(isWidgetMarkup('<html><body>Home</body></html>'), false)
    assert.equal(isWidgetMarkup(undefined), false)
  })
  it('reads the next window start from the Next link', () => {
    assert.equal(nextWindowStart(NOV), '2026-12-10')
    assert.equal(nextWindowStart('<div>no links</div>'), null)
  })
})

describe('Release Yoga parseEnrollments', () => {
  const items = parseEnrollments(NOV)

  it('extracts one entry per enrollment block', () => {
    assert.deepEqual(items.map((e) => e.title), [
      'Transcendent Breathwork Experience',
      'Full Moon Flow w/ Inspired Cocktail & Bonfire',
      'Aerial UnWined',
    ])
    assert.equal(parseEnrollments(DEC).length, 3)
  })

  it('parses title, price, instructor, date, times, description, image', () => {
    const e = items[0]
    assert.equal(e.title, 'Transcendent Breathwork Experience')
    assert.equal(e.price, 39)
    assert.equal(e.instructor, 'Mary Laske Bell, PhD')
    assert.equal(e.startDate, 'Nov 15 2026')
    assert.equal(e.startTime, '6:00 PM')
    assert.equal(e.endTime, '7:30 PM')
    assert.equal(e.endDate, null)
    assert.match(e.description, /^In this workshop, you.ll learn to manipulate the breath/)
    assert.doesNotMatch(e.description, /<|&amp;|Sign Up/, 'no markup, entities or button text')
    assert.match(e.imageUrl, /^https:\/\/clients-content\.mindbodyonline\.com\/studios\/release\/reservations\/724\.jpg/)
  })

  it('decodes entities in the title and strips the price off it', () => {
    assert.equal(items[1].title, 'Full Moon Flow w/ Inspired Cocktail & Bonfire')
    assert.equal(items[1].price, 18)
  })

  it('leaves price null when no $ is present (does not assume free)', () => {
    const html = NOV.replaceAll('Aerial UnWined - $18', 'Aerial UnWined')
    assert.equal(parseEnrollments(html)[2].price, null)
    assert.equal(parseEnrollments(html)[2].title, 'Aerial UnWined')
  })

  it('returns [] for an empty window and for empty/invalid input', () => {
    assert.deepEqual(parseEnrollments(EMPTY), [])
    assert.deepEqual(parseEnrollments(''), [])
    assert.deepEqual(parseEnrollments(null), [])
  })
})

describe('Release Yoga date and time parsing', () => {
  it('parses the widget date with or without a comma', () => {
    assert.equal(parseWidgetDate('Nov 15 2026'), '2026-11-15')
    assert.equal(parseWidgetDate('Dec 04, 2026'), '2026-12-04')
    assert.equal(parseWidgetDate('sometime soon'), null)
  })
  it('parses clock times to 24h, including noon and midnight', () => {
    assert.equal(parseWidgetTime(' 6:00 PM'), '18:00:00')
    assert.equal(parseWidgetTime('9:30 am'), '09:30:00')
    assert.equal(parseWidgetTime('12:00 PM'), '12:00:00')
    assert.equal(parseWidgetTime('12:15 AM'), '00:15:00')
    assert.equal(parseWidgetTime(''), null)
  })
  it('resolves a single-day enrollment', () => {
    assert.deepEqual(
      parseEnrollmentWhen({ startDate: 'Nov 15 2026', startTime: ' 6:00 PM', endTime: ' 7:30 PM' }),
      { dateYmd: '2026-11-15', start: '18:00:00', end: '19:30:00', multiDay: false },
    )
  })
  it('keeps a missing end time as null', () => {
    assert.equal(parseEnrollmentWhen({ startDate: 'Nov 15 2026', startTime: '6:00 PM' }).end, null)
  })
  it('flags a series whose end date is after its start date', () => {
    assert.equal(parseEnrollmentWhen({ startDate: 'Jan 05 2027', endDate: 'Feb 09 2027', startTime: '6:00 PM' }).multiDay, true)
    assert.equal(parseEnrollmentWhen({ startDate: 'Jan 05 2027', endDate: 'Jan 05 2027', startTime: '6:00 PM' }).multiDay, false)
  })
  it('returns null without a date or without a start time (never invents one)', () => {
    assert.equal(parseEnrollmentWhen({ startDate: 'Nov 15 2026' }), null)
    assert.equal(parseEnrollmentWhen({ startTime: '6:00 PM' }), null)
    assert.equal(parseEnrollmentWhen(), null)
  })
})

describe('Release Yoga buildRow', () => {
  const items = parseEnrollments(NOV)

  it('builds a UTC-anchored row from a live enrollment', () => {
    const row = buildRow(items[0])
    assert.equal(row.title, 'Transcendent Breathwork Experience')
    assert.equal(row.start_at, '2026-11-15T23:00:00.000Z') // 6:00 PM EST
    assert.equal(row.end_at, '2026-11-16T00:30:00.000Z')
    assert.equal(row.price_min, 39)
    assert.equal(row.price_max, 39)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.status, 'published')
    assert.equal(row.ticket_url, 'https://releaseyoga.com/workshops-and-events')
    assert.equal(row.needs_review, undefined)
  })

  it('keeps the source_id the pre-widget scraper minted for the same enrollment', () => {
    // This row was in prod, ingested from the old page, on 2026-11-10.
    assert.equal(
      buildRow(items[1]).source_id,
      'release_yoga-full-moon-flow-w-inspired-cocktail-bonfire-2026-11-24',
    )
  })

  it('flags a multi-day series for review and anchors it to its first session', () => {
    const row = buildRow({ ...items[0], endDate: 'Dec 20 2026' })
    assert.equal(row.needs_review, true)
    assert.equal(row.start_at, '2026-11-15T23:00:00.000Z')
  })

  it('returns null when the enrollment has no parseable date', () => {
    assert.equal(buildRow({ ...items[0], startDate: null }), null)
    assert.equal(buildRow({ ...items[0], startTime: null }), null)
  })
})

describe('Release Yoga fetchAllEnrollments', () => {
  /** A fake widget endpoint: default window → NOV, then by start_date. */
  function fakeWidget(pages) {
    const urls = []
    const getText = async (url) => {
      urls.push(url)
      const start = decodeURIComponent(url).match(/options\[start_date\]=(\d{4}-\d{2}-\d{2})/)?.[1] ?? 'default'
      if (!(start in pages)) throw new Error(`unexpected window ${start}`)
      return pages[start]
    }
    return { urls, getText }
  }
  const json = (contents) => JSON.stringify({ contents, use_iframe: false })

  it('walks consecutive windows by following each Next link', async () => {
    const { urls, getText } = fakeWidget({ default: raw('2026-11'), '2026-12-10': raw('2026-12'), '2027-01-10': raw('empty') })
    const { enrollments, validWindows } = await fetchAllEnrollments({ widgetId: 'abc', windows: 3, getText })
    assert.equal(validWindows, 3)
    assert.equal(enrollments.length, 6)
    assert.equal(urls[0], 'https://widgets.mindbodyonline.com/widgets/enrollments/abc.json')
    assert.match(urls[1], /abc\.json\?options%5Bstart_date%5D=2026-12-10$/)
    assert.match(urls[2], /start_date%5D=2027-01-10$/)
  })

  it('stops at the requested number of windows', async () => {
    const { urls, getText } = fakeWidget({ default: raw('2026-11'), '2026-12-10': raw('2026-12') })
    const { enrollments } = await fetchAllEnrollments({ widgetId: 'abc', windows: 1, getText })
    assert.equal(enrollments.length, 3)
    assert.equal(urls.length, 1)
  })

  it('does not double-count an enrollment repeated across windows', async () => {
    const { getText } = fakeWidget({ default: raw('2026-11'), '2026-12-10': raw('2026-11') })
    const { enrollments, validWindows } = await fetchAllEnrollments({ widgetId: 'abc', windows: 2, getText })
    assert.equal(validWindows, 2)
    assert.equal(enrollments.length, 3)
  })

  it('reports a quiet calendar as valid windows with no enrollments', async () => {
    const { getText } = fakeWidget({ default: raw('empty'), [nextWindowStart(EMPTY)]: raw('empty') })
    const { enrollments, validWindows } = await fetchAllEnrollments({ widgetId: 'abc', windows: 2, getText })
    assert.equal(enrollments.length, 0)
    assert.equal(validWindows, 2, 'a quiet month is healthy, not a parse failure')
  })

  it('reports zero valid windows when the response is not the widget', async () => {
    for (const body of [json('<html><body>Home</body></html>'), 'not json at all', json(null)]) {
      const { getText } = fakeWidget({ default: body })
      const { enrollments, validWindows } = await fetchAllEnrollments({ widgetId: 'abc', getText })
      assert.equal(validWindows, 0)
      assert.equal(enrollments.length, 0)
    }
  })
})
