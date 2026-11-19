/**
 * test-one-of-a-kind-pets.js — the One of A Kind Pet Rescue scraper.
 * No network, no database.
 *
 * Fixture (captured live 2026-11-19): one-of-a-kind-pets-posts.json, three
 * posts from the "calendar" category as the WordPress REST API returns them
 * (an event at the clinic, a fundraiser in North Canton, and a standing offer
 * with no date). Divi shortcode attributes are dropped and staff email
 * addresses replaced; the shortcodes themselves are kept.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, contentLines, parseDateLine, resolveYear, parsePost, buildRow, run,
} = await import('../scrape-one-of-a-kind-pets.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const POSTS = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'one-of-a-kind-pets-posts.json'), 'utf8'))
const post = (slug) => POSTS.find((p) => p.slug === slug)
const SANTA = post('santa-claus-is-coming-to-town')
const RAFFLE = post('reverse-raffle')
const PUPPY = post('corporate-puppy-party')
const NOW = new Date('2026-11-19T15:00:00Z')
const fetchJson = (body) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const withLines = (lines) => ({ slug: 'x', link: 'https://www.oneofakindpets.com/x/', title: { rendered: 'Adoption Day' }, content: { rendered: lines.map((l) => `<p>${l}</p>`).join('') } })

describe('reading a Divi post', () => {
  it('removes shortcodes and tags and keeps the text, one line per block', () => {
    const lines = contentLines(SANTA.content.rendered)
    assert.ok(lines.includes('EVENT DETAILS'))
    assert.ok(lines.includes('Saturday, November 21st // 12pm-3pm'))
    assert.ok(lines.every((l) => !/\[\/?et_pb|[<>]/.test(l)))
  })

  it('date line: weekday, month, day and whatever follows as the time text', () => {
    assert.deepEqual(parseDateLine('Saturday, November 21st // 12pm-3pm'), { weekday: 6, month: 11, day: 21, year: null, timeText: '12pm-3pm' })
    assert.deepEqual(parseDateLine('Friday, December 11th // Doors Open at 6:30pm, Dinner Starts at 8pm'),
      { weekday: 5, month: 12, day: 11, year: null, timeText: 'Doors Open at 6:30pm, Dinner Starts at 8pm' })
    assert.deepEqual(parseDateLine('Sunday June 6, 2027 | 1pm-4pm'), { weekday: 0, month: 6, day: 6, year: 2027, timeText: '1pm-4pm' })
  })

  it('ordinary sentences are not date lines', () => {
    for (const l of ['', 'EVENT DETAILS', 'November 21st // 12pm-3pm', 'Join us on December 11, 2026, at the Eagles', 'Saturday mornings are busy', 'Saturday, Smarch 3rd']) {
      assert.equal(parseDateLine(l), null, l)
    }
  })
})

describe('the year', () => {
  const sat = { weekday: 6, month: 11, day: 21, year: null }
  it('is the year that puts the date on the named weekday', () => {
    assert.equal(resolveYear(sat, '', NOW), 2026)                                   // Nov 21, 2026 is a Saturday
    assert.equal(resolveYear({ weekday: 0, month: 11, day: 21, year: null }, '', NOW), 2027) // a Sunday only in 2027
  })
  it('is null when neither this year nor next fits the weekday', () => {
    assert.equal(resolveYear({ weekday: 3, month: 11, day: 21, year: null }, '', NOW), null)
  })
  it('a year printed in the post wins, and must still fit the weekday', () => {
    assert.equal(resolveYear({ weekday: 5, month: 12, day: 11, year: null }, 'Join us on December 11, 2026, at the Eagles', NOW), 2026)
    assert.equal(resolveYear({ weekday: 1, month: 12, day: 11, year: null }, 'Join us on December 11, 2026', NOW), null)
  })
})

describe('posts', () => {
  it('an event at the clinic: title without decoration, venue from the three lines, description without the footer', () => {
    const p = parsePost(SANTA)
    assert.equal(p.title, 'Santa Claus is coming to town!')
    assert.deepEqual(p.venue, { name: 'One of a Kind Pet Rescue Spay & Neuter Clinic', details: { address: '1700 W Exchange St', city: 'Akron', state: 'OH', zip: '44313' } })
    assert.match(p.description, /^Grab the human kiddos/)
    assert.doesNotMatch(p.description, /Two Convenient Locations|MAP IT|Adoption Center|BACK TO EVENTS|@/)
  })

  it('a standing offer with no date line is not an event', () => {
    assert.equal(parsePost(PUPPY), null)
    assert.deepEqual(buildRow(PUPPY, NOW), { skip: 'not_an_event' })
  })

  it('a date line with no address block still parses, with no venue', () => {
    const p = parsePost(withLines(['EVENT DETAILS', 'Saturday, November 21st // 12pm-3pm', 'Meet adoptable cats and dogs.', 'Two Convenient Locations', 'Adoption Center']))
    assert.equal(p.venue, null)
    assert.equal(p.description, 'Meet adoptable cats and dogs.')
  })
})

describe('rows', () => {
  it('Santa photos: noon to 3 PM on Saturday, November 21', () => {
    const { row, venue } = buildRow(SANTA, NOW)
    assert.equal(row.start_at, '2026-11-21T17:00:00.000Z')
    assert.equal(row.end_at, '2026-11-21T20:00:00.000Z')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'santa-claus-is-coming-to-town-2026-11-21')
    assert.equal(row.price_min, null)
    assert.match(row.image_url, /^https:\/\/www\.oneofakindpets\.com\/wp-content\/uploads\//)
    assert.equal(row.ticket_url, SANTA.link)
    assert.equal(venue.details.city, 'Akron')
  })

  it('a fundraiser in North Canton is outside Summit County and is skipped', () => {
    assert.deepEqual(buildRow(RAFFLE, NOW), { skip: 'out_of_county' })
  })

  it('a date line with no time, or a weekday that fits no year, is skipped', () => {
    assert.deepEqual(buildRow(withLines(['Saturday, November 21st', 'Details soon.']), NOW), { skip: 'no_single_time' })
    assert.deepEqual(buildRow(withLines(['Wednesday, November 21st // 12pm-3pm']), NOW), { skip: 'weekday_mismatch' })
  })

  it('"Doors Open at 6:30pm, Dinner Starts at 8pm" resolves to the stated start', () => {
    const local = withLines(['Friday, December 11th // Doors Open at 6:30pm, Dinner Starts at 8pm', 'A night out.'])
    assert.equal(buildRow(local, NOW).row.start_at, '2026-12-12T01:00:00.000Z') // 8:00 PM EST
  })
})

describe('run (dry)', () => {
  it('plans the one in-county event and counts the other', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchJson(POSTS), now: () => NOW.getTime() })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 2)
    assert.equal(result.planned, 1)
  })

  it('a category holding only standing offers is an empty run, not an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchJson([PUPPY]), now: () => NOW.getTime() })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 0)
    assert.equal(result.exitCode, 0)
  })

  it('an endpoint that stops returning a list is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchJson({ code: 'rest_forbidden' }), now: () => NOW.getTime() })
    assert.notEqual(result.status, 'dry-run')
  })
})
