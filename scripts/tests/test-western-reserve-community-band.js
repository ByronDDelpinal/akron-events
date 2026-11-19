/**
 * test-western-reserve-community-band.js — the Western Reserve Community Band
 * scraper. No network, no database.
 *
 * Fixture (captured live 2026-11-19): western-reserve-community-band.ics is
 * the feed's own header plus 14 real VEVENTs picked by script, one per kind of
 * entry the band keeps (concerts, rehearsals, meetings, an out-of-county
 * concert, a recurring rehearsal). ATTENDEE/ORGANIZER lines removed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { parseIcs } = await import('../lib/ics.js')
const {
  SOURCE_KEY, FEED_URL, config, cityOf, isPublicPerformance, expandTitles, dryRun, mapCategory,
} = await import('../scrape-western-reserve-community-band.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICS = readFileSync(resolve(__dirname, 'fixtures', 'western-reserve-community-band.ics'), 'utf8')
const events = parseIcs(ICS)
const titles = (list) => list.map((e) => e.SUMMARY).sort()

describe('which calendar entries are public performances', () => {
  it('keeps concerts and community performances', () => {
    assert.deepEqual(titles(events.filter(isPublicPerformance)), [
      'Hudson Ice Cream Social',
      'WRCB Holiday Concert',
      'WRCB Hudson Bandstand Concert',
      'WRCB Liberty Park Concert',
      'WRCB Spring Concert',
      'WRCB Summer Winds Event Time 2:45-3:50',
    ])
  })

  it('drops rehearsals, including a dress rehearsal that has "Concert" in its title', () => {
    const dropped = titles(events.filter((e) => !isPublicPerformance(e)))
    for (const t of ['WRCB Holiday Concert Dress Rehearsal', 'WRCB Rehearsal 7-9 pm', 'WRCB Rehearsal', 'No WRCB Rehearsal']) {
      assert.ok(dropped.includes(t), t)
    }
  })

  it('drops meetings, members-only socials and a concert for a residence', () => {
    for (const SUMMARY of ['WRCB Annual Meeting', 'WRCB Social Event', 'Concert Danbury Senior Living']) {
      assert.equal(isPublicPerformance({ SUMMARY }), false, SUMMARY)
    }
  })

  it('drops a concert outside Summit County by its LOCATION city', () => {
    const aurora = events.find((e) => /Independence Village/.test(e.SUMMARY))
    assert.equal(cityOf(aurora.LOCATION), 'Aurora')
    assert.equal(isPublicPerformance(aurora), false)
  })

  it('keeps a concert whose LOCATION is missing or has no readable city', () => {
    assert.equal(isPublicPerformance({ SUMMARY: 'WRCB Fall Concert' }), true)
    assert.equal(isPublicPerformance({ SUMMARY: 'WRCB Fall Concert', LOCATION: 'Hudson Green' }), true)
  })

  it('an untitled or unrelated entry is not a performance', () => {
    assert.equal(isPublicPerformance({}), false)
    assert.equal(isPublicPerformance({ SUMMARY: 'Board packet due' }), false)
  })
})

describe('cityOf', () => {
  it('reads the city before the state, escaped commas or not', () => {
    assert.equal(cityOf('Hudson Middle School\\, 83 N Oviatt St\\, Hudson\\, OH 44236\\, USA'), 'Hudson')
    assert.equal(cityOf('Liberty Park Nature Center, 9999 Liberty Rd, Twinsburg, OH 44087, USA'), 'Twinsburg')
    assert.equal(cityOf('Hudson Green, Hudson, OH'), 'Hudson')
  })
  it('returns null when there is no city to read', () => {
    assert.equal(cityOf(''), null)
    assert.equal(cityOf('Hudson Middle School Band Room'), null)
  })
})

describe('expandTitles', () => {
  const expanded = parseIcs(expandTitles(ICS))
  const has = (t) => expanded.some((e) => e.SUMMARY === t)

  it('spells the band out in public titles', () => {
    assert.ok(has('Western Reserve Community Band: Holiday Concert'))
    assert.ok(has('Western Reserve Community Band: Hudson Bandstand Concert'))
  })

  it('names the band on a performance whose title never mentions it', () => {
    assert.ok(has('Hudson Ice Cream Social (Western Reserve Community Band)'))
  })

  it('leaves internal entries exactly as written, so they are still filtered out', () => {
    assert.ok(has('WRCB Holiday Concert Dress Rehearsal'))
    assert.ok(has('WRCB Annual Meeting'))
    assert.equal(expanded.filter(isPublicPerformance).length, events.filter(isPublicPerformance).length)
  })

  it('changes nothing but SUMMARY lines', () => {
    const strip = (s) => s.split('\n').filter((l) => !l.startsWith('SUMMARY:')).join('\n')
    assert.equal(strip(expandTitles(ICS)), strip(ICS))
  })
})

describe('config and dry run', () => {
  it('is wired to the band\'s public Google Calendar and never assumes a price', () => {
    assert.equal(config.source, SOURCE_KEY)
    assert.match(FEED_URL, /calendar\.google\.com\/calendar\/ical\/wrcband97%40gmail\.com\/public\/basic\.ics$/)
    assert.equal(config.includeEvent, isPublicPerformance)
    assert.equal(config.skipPast, true)
    assert.equal(config.allowEmptyFeed, true)
    assert.equal(config.defaultPriceMin, null)
    assert.equal(config.defaultVenueName, undefined) // a concert with no LOCATION gets no venue
    assert.equal(mapCategory(), 'music')
  })

  it('dry run lists only upcoming public performances, soonest first', async () => {
    const { found, upcoming } = await dryRun({ fetchText: async () => ICS, now: Date.parse('2026-11-19T15:00:00Z') })
    assert.equal(found, 14)
    assert.deepEqual(upcoming.map((e) => [e.title, e.start]), [
      ['Western Reserve Community Band: Holiday Concert', '2026-12-13T21:00:00.000Z'],
    ])
    assert.match(upcoming[0].location, /^Hudson Middle School/)
  })

  it('dry run from earlier in the year sees the whole season in order', async () => {
    const { upcoming } = await dryRun({ fetchText: async () => ICS, now: Date.parse('2026-04-01T12:00:00Z') })
    assert.deepEqual(upcoming.map((e) => e.title), [
      'Western Reserve Community Band: Spring Concert',
      'Hudson Ice Cream Social (Western Reserve Community Band)',
      'Western Reserve Community Band: Hudson Bandstand Concert',
      'Western Reserve Community Band: Liberty Park Concert',
      'Western Reserve Community Band: Holiday Concert',
    ])
  })
})
