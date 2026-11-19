/**
 * test-akron-roundtable.js — the Akron Roundtable scraper. No network, no database.
 * Fixture (captured live 2026-11-19, contact address replaced): akron-roundtable-home.html.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, parseDateLine, parseSpeakers, resolvePlace, buildRow, run } = await import('../scrape-akron-roundtable.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOME = readFileSync(resolve(__dirname, 'fixtures', 'akron-roundtable-home.html'), 'utf8')
const speakers = parseSpeakers(HOME)
const named = (re) => speakers.find((s) => re.test(s.speaker))
const serve = (body) => async () => ({ ok: true, status: 200, text: async () => body })

describe('date line', () => {
  it('reads noon, the weekday, the full date and the place', () => {
    assert.deepEqual(parseDateLine('noon • Thursday • December 10, 2026 Doubletree by Hilton Akron/Fairlawn'),
      { time: { time: '12:00 pm', hhmm: '1200' }, weekday: 4, month: 12, day: 10, year: 2026, place: 'Doubletree by Hilton Akron/Fairlawn' })
    assert.equal(parseDateLine('5:30 pm • Tuesday • March 2, 2027').time.hhmm, '1730')
    assert.equal(parseDateLine('evening • Tuesday • March 2, 2027').time, null)
  })
  it('other lines are not date lines', () => {
    for (const l of ['', 'December', 'Presentation Title: X', 'Thursday, December 10, 2026']) assert.equal(parseDateLine(l), null, l)
  })
})

describe('the season list', () => {
  it('finds every speaker block once, with its id from the speaker link', () => {
    assert.equal(speakers.length, 14)
    assert.equal(new Set(speakers.map((s) => s.id)).size, 14)
    const boyd = named(/Rhea Boyd/)
    assert.equal(boyd.id, '25196')
    assert.equal(boyd.url, 'https://www.akronroundtable.org/speakers/dr-rhea-boyd/25196/')
    assert.equal(boyd.speaker, 'Dr. Rhea Boyd') // the month label above the name is not part of it
    assert.equal(boyd.about, 'Pediatrician, public health advocate, and scholar')
    assert.equal(boyd.date.place, 'Doubletree by Hilton Akron/Fairlawn')
    assert.equal(boyd.talk, 'The Politics, Policing, and Possibilities of Black Motherhood')
    assert.match(boyd.sponsor, /made possible by a gift from Akron Children's/)
  })
  it('a page with no speaker blocks yields nothing', () => {
    assert.deepEqual(parseSpeakers('<h1>Akron Roundtable</h1>'), [])
  })
})

describe('places', () => {
  it('maps the hotel to its address, keeps an unfamiliar place by name, and has no venue while TBD', () => {
    assert.equal(resolvePlace('Doubletree by Hilton Akron/Fairlawn').details.address, '3180 W Market St')
    assert.deepEqual(resolvePlace('John S. Knight Center'), { name: 'John S. Knight Center', details: { city: 'Akron', state: 'OH' } })
    assert.equal(resolvePlace('Event Location TBD'), null)
    assert.equal(resolvePlace(''), null)
  })
})

describe('rows', () => {
  it('a luncheon at noon Eastern, titled the way emailed luncheons are', () => {
    const { row, venue } = buildRow(named(/Rhea Boyd/))
    assert.equal(row.title, 'Akron Roundtable: Dr. Rhea Boyd')
    assert.equal(row.start_at, '2026-12-10T17:00:00.000Z')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '25196')
    assert.equal(row.price_min, null)
    assert.match(row.description, /^Akron Roundtable luncheon with Dr\. Rhea Boyd, Pediatrician, public health advocate, and scholar\. Presentation: The Politics, Policing, and Possibilities of Black Motherhood\./)
    assert.equal(venue.name, 'DoubleTree by Hilton Akron Fairlawn')
  })
  it('a luncheon whose location is still TBD is listed without a venue', () => {
    const { row, venue } = buildRow(named(/Callie Brownson/))
    assert.equal(row.start_at, '2027-02-18T17:00:00.000Z')
    assert.equal(venue, null)
  })
  it('skips unannounced speakers, a missing time and a date that contradicts its weekday', () => {
    assert.deepEqual(buildRow(named(/^Speaker TBA$/)), { skip: 'speaker_unannounced' })
    const boyd = named(/Rhea Boyd/)
    assert.deepEqual(buildRow({ ...boyd, date: { ...boyd.date, time: null } }), { skip: 'no_time' })
    assert.deepEqual(buildRow({ ...boyd, date: { ...boyd.date, weekday: 2 } }), { skip: 'weekday_mismatch' })
  })
})

describe('run (dry)', () => {
  it('plans every named luncheon still to come', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HOME), now: () => Date.parse('2026-11-19T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 14)
    assert.equal(result.planned, 11)
  })
  it('a page with no speaker listings is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve('<h1>Akron Roundtable</h1>'), now: () => Date.now() })
    assert.notEqual(result.status, 'dry-run')
  })
})
