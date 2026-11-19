/**
 * test-astronomy-club-akron.js — the Astronomy Club of Akron scraper.
 * No network, no database.
 *
 * Built while the page showed only a meeting already past, so it is tested
 * against two real states of the page with the clock set back:
 *   astronomy-club-akron-2026-11.html   the live page, captured 2026-11-19 (one entry, time printed)
 *   astronomy-club-akron-2025-03.html   Internet Archive capture of 2025-03-02 (two entries, no time)
 * Both reduced by script (head, scripts, styles, layout attributes removed).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, parseDateLine, parsePage, buildRow, run } = await import('../scrape-astronomy-club-akron.js')
const { htmlLines } = await import('../lib/html-lines.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const HTML_2026 = fx('astronomy-club-akron-2026-11.html')
const HTML_2025 = fx('astronomy-club-akron-2025-03.html')
const P26 = parsePage(htmlLines(HTML_2026))
const P25 = parsePage(htmlLines(HTML_2025))
const serve = (body) => async () => ({ ok: true, status: 200, text: async () => body })
const at = (iso) => () => Date.parse(iso)

describe('date lines', () => {
  it('reads a full date, with or without a time', () => {
    assert.deepEqual(parseDateLine('November 15, 2026 - 2PM'), { year: 2026, month: 11, day: 15, time: { time: '2:00 pm', hhmm: '1400' } })
    assert.deepEqual(parseDateLine('March 16, 2025'), { year: 2025, month: 3, day: 16, time: null })
    assert.equal(parseDateLine('April 27, 2025 - afternoon').time, null)
  })
  it('a line without a year, or prose that mentions a date, is not an entry', () => {
    for (const l of ['', 'November 15', 'ACA Meeting', 'Saturday October 29, 2022 from 1:00 PM to 3:00 PM', 'Message added: Mon Nov 16 2026 07:15 PM', 'Smarch 3, 2026']) {
      assert.equal(parseDateLine(l), null, l)
    }
  })
})

describe('the page, in two states', () => {
  it('2026: one entry with its kind, speaker, talk and blurb', () => {
    assert.equal(P26.entries.length, 1)
    const e = P26.entries[0]
    assert.equal(e.kind, 'ACA Public Lecture Meeting')
    assert.equal(e.speaker, 'Stacy McGaugh, Case Western Reserve University')
    assert.equal(e.talk, 'Missing Mass Problem – Dark Matter & Our Understanding of Gravity')
    assert.match(e.blurb, /^There is ample evidence for missing mass/)
    assert.doesNotMatch(e.blurb, /All meetings|Activity Schedule/)
  })

  it('2025: two entries, neither with a time on its date line', () => {
    assert.deepEqual(P25.entries.map((e) => [e.date.month, e.date.day, e.date.time, e.talk]), [
      [3, 16, null, 'Astronomy in the Era of Giant Surveys'],
      [4, 27, null, 'Verification of the Standard Model of Particle Physics'],
    ])
  })

  it('reads the standing facts the page states: meeting time, meeting place, free admission', () => {
    for (const p of [P26, P25]) {
      assert.deepEqual(p.meetingTime, { time: '2:00 pm', hhmm: '1400' })
      assert.deepEqual(p.meetingVenue, { name: 'Portage Lakes Kiwanis Civic Center', details: { address: '725 Portage Lakes Drive', city: 'Akron', state: 'OH' } })
      assert.equal(p.free, true)
    }
  })

  it('a bulletin announcing a star party is not an entry', () => {
    assert.ok(P26.entries.every((e) => !/star party|observatory/i.test(`${e.kind} ${e.talk}`)))
  })

  it('a page without the block is reported as such', () => {
    const p = parsePage(htmlLines('<h1>Astronomy Club of Akron</h1><p>Welcome</p>'))
    assert.equal(p.found, false)
    assert.deepEqual(p.entries, [])
  })
})

describe('rows', () => {
  it('a meeting with a printed time uses it and is not flagged', () => {
    const { row, venue } = buildRow(P26.entries[0], P26)
    assert.equal(row.title, 'Missing Mass Problem – Dark Matter & Our Understanding of Gravity (Astronomy Club of Akron)')
    assert.equal(row.start_at, '2026-11-15T19:00:00.000Z') // 2:00 PM EST
    assert.equal('time_inferred' in row, false)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '2026-11-15-meeting')
    assert.equal(row.price_min, 0)
    assert.deepEqual(row.categories, ['learning'])
    assert.match(row.description, /^Astronomy Club of Akron public lecture meeting, open to the public and free of charge\. Speaker: Stacy McGaugh, Case Western Reserve University\.\n\nThere is ample evidence/)
    assert.equal(venue.name, 'Portage Lakes Kiwanis Civic Center')
  })

  it('a meeting with no printed time uses the page\'s standing time and discloses it', () => {
    const { row } = buildRow(P25.entries[0], P25)
    assert.equal(row.start_at, '2025-03-16T18:00:00.000Z') // 2:00 PM EDT
    assert.equal(row.time_inferred, true)
  })

  it('with no time anywhere on the page the meeting is skipped', () => {
    assert.deepEqual(buildRow(P25.entries[0], { ...P25, meetingTime: null }), { skip: 'no_time' })
  })

  it('admission is not called free unless the page says so, and a missing venue stays missing', () => {
    const { row, venue } = buildRow(P26.entries[0], { ...P26, free: false, meetingVenue: null })
    assert.equal(row.price_min, null)
    assert.doesNotMatch(row.description, /free/i)
    assert.equal(venue, null)
  })

  it('an entry announced before its speaker gets a plain title and keeps its id later', () => {
    const bare = { date: P26.entries[0].date, kind: 'ACA Public Lecture Meeting', speaker: null, talk: null, blurb: null }
    const { row } = buildRow(bare, P26)
    assert.equal(row.title, 'Astronomy Club of Akron: Public Lecture Meeting')
    assert.equal(row.source_id, buildRow(P26.entries[0], P26).row.source_id)
  })

  it('an entry that is not a meeting is not listed', () => {
    assert.deepEqual(buildRow({ date: P26.entries[0].date, kind: 'Star Party' }, P26), { skip: 'not_a_meeting' })
  })
})

describe('run (dry), with the clock set to each state', () => {
  it('the week before the November 2026 meeting: one planned', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2026), now: at('2026-11-10T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 1)
  })
  it('March 2025: both meetings planned', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2025), now: at('2025-03-02T15:00:00Z') })
    assert.equal(result.found, 2)
    assert.equal(result.planned, 2)
  })
  it('today, with only a past meeting posted: an empty run, not an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2026), now: at('2026-11-19T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 0)
    assert.equal(result.exitCode, 0)
  })
  it('a page that lost the block is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve('<h1>Astronomy Club of Akron</h1>'), now: at('2026-11-19T15:00:00Z') })
    assert.notEqual(result.status, 'dry-run')
  })
})
