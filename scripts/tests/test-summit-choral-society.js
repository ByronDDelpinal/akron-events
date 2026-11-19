/**
 * test-summit-choral-society.js — the Summit Choral Society scraper.
 * No network, no database.
 *
 * Fixtures (captured live 2026-11-19, reduced by script):
 *   summit-choral-society-season.html          the season page's ticket links
 *   summit-choral-society-ticket-<id>.html     three ticket pages, cut to their schema.org block
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, DISCOVERY_URLS, findTicketLinks, readEvent, buildRow, run } = await import('../scrape-summit-choral-society.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const SEASON = fx('summit-choral-society-season.html')
const TICKETS = { 387085: fx('summit-choral-society-ticket-387085.html'), 382369: fx('summit-choral-society-ticket-382369.html'), 387084: fx('summit-choral-society-ticket-387084.html') }
const links = findTicketLinks(SEASON)
const NOW = Date.parse('2026-11-19T15:00:00Z')
const fetchImpl = async (url) => {
  const u = String(url)
  const id = u.match(/purplepass\.com\/events\/(\d+)-/)?.[1]
  const body = DISCOVERY_URLS.includes(u) ? SEASON : TICKETS[id]
  return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 404, text: async () => '' }
}

describe('discovery', () => {
  it('finds each ticket link once and ignores the organizer search link', () => {
    assert.deepEqual(links.map((l) => l.id).sort(), ['382369', '387084', '387085'])
    assert.match(links.find((l) => l.id === '387085').url, /^https:\/\/www\.purplepass\.com\/events\/387085-a-concert-for-the-holidays-dec-1st-2026$/)
  })
  it('a page with no ticket links yields none', () => {
    assert.deepEqual(findTicketLinks('<a href="https://www.purplepass.com/events?event_name=summit%20choral">all</a>'), [])
  })
})

describe('ticket page data', () => {
  it('reads the Event even though the site puts raw line breaks inside JSON strings', () => {
    const ev = readEvent(TICKETS[387085])
    assert.equal(ev.name, 'A Concert for the Holidays')
    assert.equal(ev.startDate, '2026-12-01T18:00:00-05:00')
  })
  it('a page without Event data is null', () => {
    assert.equal(readEvent('<script type="application/ld+json">{"@type":"Organization"}</script>'), null)
    assert.equal(readEvent('<html></html>'), null)
  })
})

describe('rows', () => {
  const holiday = links.find((l) => l.id === '387085')
  it('every fact comes from the structured data: time with its offset, venue, price', () => {
    const { row, venue } = buildRow(holiday, readEvent(TICKETS[387085]))
    assert.equal(row.title, 'A Concert for the Holidays')
    assert.equal(row.start_at, '2026-12-01T23:00:00.000Z') // 6:00 PM EST
    assert.equal(row.end_at, '2026-12-02T00:30:00.000Z')
    assert.equal(row.price_min, 12)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '387085')
    assert.deepEqual(row.categories, ['music'])
    assert.equal(row.ticket_url, holiday.url)
    assert.match(row.description, /^A Summit Choral Society concert featuring Children's Choir Program\./)
    assert.deepEqual(venue, { name: 'Akron Public Library Auditorium', details: { address: '60 S. High St', city: 'Akron', state: 'OH', zip: '44326' } })
  })
  it('a spring concert is read in daylight time, with its price range', () => {
    const { row } = buildRow(links.find((l) => l.id === '382369'), readEvent(TICKETS[382369]))
    assert.equal(row.start_at, '2027-05-01T20:00:00.000Z') // 4:00 PM EDT
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 18)
  })
  it('skips another organizer, a cancelled event, a venue outside the county and missing data', () => {
    const ev = readEvent(TICKETS[387085])
    assert.deepEqual(buildRow(holiday, { ...ev, organizer: { name: 'Someone Else' } }), { skip: 'other_organizer' })
    assert.deepEqual(buildRow(holiday, { ...ev, eventStatus: 'https://schema.org/EventCancelled' }), { skip: 'cancelled' })
    assert.deepEqual(buildRow(holiday, { ...ev, location: { name: 'Canton Palace', address: { addressLocality: 'Canton' } } }), { skip: 'out_of_county' })
    assert.deepEqual(buildRow(holiday, { ...ev, startDate: 'soon' }), { skip: 'undatable' })
    assert.deepEqual(buildRow(holiday, null), { skip: 'invalid' })
  })
})

describe('run (dry)', () => {
  it('plans the three ticketed concerts', async () => {
    const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 3)
    assert.equal(result.planned, 3)
  })
  it('a season page with no ticket links is an empty run; no reachable page is an error', async () => {
    const none = await run({ dryRun: true, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<h2>Season Events</h2>' }), now: () => NOW, delayMs: 0 })
    assert.equal(none.status, 'dry-run')
    assert.equal(none.found, 0)
    const down = await run({ dryRun: true, fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }), now: () => NOW, delayMs: 0 })
    assert.notEqual(down.status, 'dry-run')
  })
})
