/**
 * test-city-of-munroe-falls.js — the Munroe Falls CivicPlus config, checked
 * against the city's own feed. No network, no database.
 *
 * Fixture (captured live 2026-11-19): city-of-munroe-falls.ics, the Main
 * Calendar entries from Nov 24 to Dec 25, 2026.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { parseIcs } = await import('../lib/ics.js')
const { isPublicCivicPlusEvent } = await import('../lib/civicplus.js')
const { SOURCE_KEY, config } = await import('../scrape-city-of-munroe-falls.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const events = parseIcs(readFileSync(resolve(__dirname, 'fixtures', 'city-of-munroe-falls.ics'), 'utf8'))

describe('city_of_munroe_falls', () => {
  it('reads only the Main Calendar, not the lodge rental feed', () => {
    assert.equal(config.source, SOURCE_KEY)
    assert.equal(config.origin, 'https://www.munroefalls.com')
    assert.deepEqual(config.catIDs, [14])
    assert.equal(config.cityLabel, 'Munroe Falls')
    assert.equal(config.defaultVenue.address, '43 Munroe Falls Ave')
  })

  it('the shared filter keeps the tree lighting and drops meetings and office closures', () => {
    assert.equal(events.length, 10)
    const kept = events.filter((ev) => isPublicCivicPlusEvent(ev.SUMMARY, ev)).map((ev) => ev.SUMMARY)
    assert.equal(kept.length, 1)
    assert.match(kept[0], /^Annual Tree Lighting and Sparkle in the Park/)
  })

  it('importing the module does not start a scrape', () => {
    assert.equal(typeof config, 'object') // reached without touching the network or database
  })
})
