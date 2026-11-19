/**
 * test-hudson-community-first.js — the Hudson Community First scraper.
 * No network, no database.
 *
 * Fixture (captured live 2026-11-19): hudson-community-first.ics, the 21
 * upcoming entries of the coalition's public Google Calendar.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { parseIcs } = await import('../lib/ics.js')
const { SOURCE_KEY, FEED_URL, config, cityOf, isCommunityEvent, mapCategory, dryRun } = await import('../scrape-hudson-community-first.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICS = readFileSync(resolve(__dirname, 'fixtures', 'hudson-community-first.ics'), 'utf8')
const events = parseIcs(ICS)

describe('which entries are community events', () => {
  it('keeps the six community events', () => {
    assert.deepEqual(events.filter(isCommunityEvent).map((e) => e.SUMMARY.trim()).sort(), [
      'Charting Your Course', 'Holiday Shoppe & Community Craft Fair', 'Presentation: HPD', 'Spring Career Panel', 'Toast to Hudson', 'Uncharted Waters',
    ])
  })

  it('drops school-calendar markers, board meetings and deadlines', () => {
    for (const SUMMARY of ['No School - HCS', 'Thanksgiving Break - WRA', 'Winter Break - HCS', 'Spring Break - WRA', 'Last Day of School - HCS', 'Advisory Board Meeting', 'Volunteer Board Meeting', 'Michael-Waly Award Nominations Due']) {
      assert.equal(isCommunityEvent({ SUMMARY }), false, SUMMARY)
    }
    assert.equal(events.filter((e) => !isCommunityEvent(e)).length, 15)
  })

  it('drops an event outside Summit County and keeps one with no readable city', () => {
    assert.equal(isCommunityEvent({ SUMMARY: 'Parent Night', LOCATION: 'Aurora High School\\, 109 W Pioneer Trail\\, Aurora\\, OH 44202\\, USA' }), false)
    assert.equal(isCommunityEvent({ SUMMARY: 'Parent Night', LOCATION: 'Hudson High School' }), true)
    assert.equal(isCommunityEvent({ SUMMARY: 'Parent Night' }), true)
    assert.equal(isCommunityEvent({}), false)
  })

  it('cityOf', () => {
    assert.equal(cityOf('Hudson Middle School\\, 83 N Oviatt St\\, Hudson\\, OH 44236\\, USA'), 'Hudson')
    assert.equal(cityOf(''), null)
  })
})

describe('config and dry run', () => {
  it('is wired to the public calendar and assumes no price', () => {
    assert.equal(config.source, SOURCE_KEY)
    assert.equal(config.feedUrl, FEED_URL)
    assert.equal(config.includeEvent, isCommunityEvent)
    assert.equal(config.skipPast, true)
    assert.equal(config.defaultPriceMin, null)
  })

  it('categories', () => {
    assert.equal(mapCategory({ SUMMARY: 'Holiday Shoppe & Community Craft Fair' }), 'market')
    assert.equal(mapCategory({ SUMMARY: 'Toast to Hudson' }), 'festival')
    assert.equal(mapCategory({ SUMMARY: 'Spring Career Panel' }), 'learning')
  })

  it('dry run lists the upcoming community events, soonest first', async () => {
    const { found, upcoming } = await dryRun({ fetchText: async () => ICS, now: Date.parse('2026-11-19T15:00:00Z') })
    assert.equal(found, 21)
    assert.equal(upcoming.length, 6)
    assert.equal(upcoming[0].title, 'Holiday Shoppe & Community Craft Fair')
    assert.equal(upcoming[0].start, '2026-12-05T15:00:00.000Z')
  })
})
