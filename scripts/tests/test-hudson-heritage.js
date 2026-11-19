/**
 * test-hudson-heritage.js — the Hudson Heritage Association scraper.
 * No network, no database.
 *
 * Fixture (captured live 2026-11-19): hudson-heritage-posts.json, the
 * WordPress REST search result reduced to the three "program calendar" posts
 * (the current 2026-2027 season, last season, and an older post whose slug
 * does not name a season).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, seasonOf, pickSeasonPosts, resolvePlace, statedTime, parseSeasonPost, buildRow, run,
} = await import('../scrape-hudson-heritage.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW = readFileSync(resolve(__dirname, 'fixtures', 'hudson-heritage-posts.json'), 'utf8')
const POSTS = JSON.parse(RAW)
const post = (slug) => POSTS.find((p) => p.slug === slug)
const CURRENT = post('our-2026-2027-program-calendar')
const LAST = post('our-2025-2026-program-calendar')
const NOW = Date.parse('2026-11-19T15:00:00Z')
const SEASON = { startYear: 2026, endYear: 2027 }
const fetchJson = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) })

describe('finding the season', () => {
  it('reads the season from the slug and refuses anything else', () => {
    assert.deepEqual(seasonOf('our-2026-2027-program-calendar'), SEASON)
    for (const slug of ['our-remaining-programming-calendar', 'our-2026-2028-program-calendar', 'our-2026-program-calendar', '', undefined]) {
      assert.equal(seasonOf(slug), null, String(slug))
    }
  })

  it('keeps only seasons that have not ended', () => {
    assert.deepEqual(pickSeasonPosts(POSTS, NOW).map((s) => s.post.slug), ['our-2026-2027-program-calendar'])
    // In spring both the running season and an early-posted next one are current.
    const spring = Date.parse('2026-05-01T12:00:00Z')
    assert.deepEqual(pickSeasonPosts(POSTS, spring).map((s) => s.post.slug), ['our-2025-2026-program-calendar', 'our-2026-2027-program-calendar'])
    assert.deepEqual(pickSeasonPosts(POSTS, Date.parse('2027-07-15T12:00:00Z')), [])
    assert.deepEqual(pickSeasonPosts(null, NOW), [])
  })
})

describe('the season post', () => {
  const parsed = parseSeasonPost(CURRENT.content.rendered)

  it('reads every dated program with its place', () => {
    assert.deepEqual(parsed.programs.map((p) => [p.month, p.day, p.title, p.place]), [
      [9, 10, 'Hudson and the Underground Railroad', 'Barlow Community Center'],
      [10, 8, "A Tour of Hudson's Archives", 'Hudson Library & Historical Society North Room'],
      [11, 12, 'A Viewing of the Frederick Douglas Movie', 'Western Reserve Academy Chapel'],
      [1, 14, 'Program to be announced', 'Laurel Lake Community Room'],
      [2, 11, 'Introducing the Akron History Museum', 'Laurel Lake Community Room'],
      [3, 11, 'The History of the WRA Observatory', 'Laurel Lake Community Room'],
      [4, 8, 'Program to be announced', 'Laurel Lake Community Room'],
      [5, 13, 'Annual Meeting of Members', 'Location to be announced'],
    ])
    assert.equal(parsed.unparsed, 0)
  })

  it('this season prints no start time; last season did', () => {
    assert.equal(parsed.time, null)
    assert.deepEqual(parseSeasonPost(LAST.content.rendered).time, { time: '7:00 pm', hhmm: '1900' })
  })

  it('counts a dated paragraph it cannot read instead of dropping it', () => {
    const r = parseSeasonPost('<p><strong>February 11 Introducing the Akron History Museum</strong></p><p>Thanks for a great year.</p>')
    assert.deepEqual(r.programs, [])
    assert.equal(r.unparsed, 1)
  })

  it('statedTime only trusts an explicit "begin at" phrase', () => {
    assert.deepEqual(statedTime('All meetings begin at 7 p.m.'), { time: '7:00 pm', hhmm: '1900' })
    assert.deepEqual(statedTime('Programs start at 6:30 PM this year'), { time: '6:30 pm', hhmm: '1830' })
    assert.equal(statedTime('Doors open around 7'), null)
    assert.equal(statedTime(''), null)
  })
})

describe('places', () => {
  it('maps the rooms the association uses to their buildings and keeps the room', () => {
    assert.deepEqual(resolvePlace('Barlow Community Center'), {
      venue: { name: 'Barlow Community Center', details: { address: '41 S Oviatt St', city: 'Hudson', state: 'OH', zip: '44236' } }, room: null,
    })
    assert.equal(resolvePlace('Hudson Library & Historical Society North Room').venue.name, 'Hudson Library & Historical Society')
    assert.equal(resolvePlace('Hudson Library & Historical Society North Room').room, 'Hudson Library & Historical Society North Room')
    assert.equal(resolvePlace('Western Reserve Academy Chapel').venue.name, 'Western Reserve Academy')
    assert.equal(resolvePlace('Laurel Lake Community Room').venue.name, 'Laurel Lake Retirement Community')
  })

  it('an unfamiliar place is kept by name in Hudson; an unannounced one is no place', () => {
    assert.deepEqual(resolvePlace('First Congregational Church'), { venue: { name: 'First Congregational Church', details: { city: 'Hudson', state: 'OH', zip: '44236' } }, room: null })
    assert.equal(resolvePlace('Location to be announced'), null)
    assert.equal(resolvePlace(''), null)
  })
})

describe('rows', () => {
  const programs = parseSeasonPost(CURRENT.content.rendered).programs
  const byDay = (month, day) => programs.find((p) => p.month === month && p.day === day)

  it('a winter program lands in the season\'s second year at a disclosed 7 PM placeholder', () => {
    const { row, venue } = buildRow(byDay(2, 11), SEASON, { link: CURRENT.link, time: null })
    assert.equal(row.title, 'Introducing the Akron History Museum')
    assert.equal(row.start_at, '2027-02-12T00:00:00.000Z') // Feb 11, 7:00 PM EST
    assert.equal(row.time_inferred, true)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '2026-2027-2027-02-11')
    assert.equal(row.price_min, 0)
    assert.deepEqual(row.categories, ['learning'])
    assert.match(row.description, /Free and open to the public\. Held in the Laurel Lake Community Room\.$/)
    assert.equal(row.ticket_url, CURRENT.link)
    assert.equal(venue.name, 'Laurel Lake Retirement Community')
  })

  it('an autumn program lands in the first year; a printed time is used and not flagged', () => {
    const { row } = buildRow(byDay(9, 10), SEASON, { time: { time: '6:30 pm', hhmm: '1830' } })
    assert.equal(row.start_at, '2026-09-10T22:30:00.000Z') // EDT
    assert.equal('time_inferred' in row, false)
    assert.doesNotMatch(row.description, /Held in/)
  })

  it('leaves out unannounced programs, the members-only meeting and a program with no place', () => {
    assert.deepEqual(buildRow(byDay(1, 14), SEASON), { skip: 'unannounced' })
    assert.deepEqual(buildRow(byDay(5, 13), SEASON), { skip: 'members_only' })
    assert.deepEqual(buildRow({ month: 3, day: 11, title: 'A Talk', place: 'Location to be announced' }, SEASON), { skip: 'no_place' })
    assert.deepEqual(buildRow({ month: 12, day: 1, title: 'December 2026 (NO PROGRAM)', place: 'x' }, SEASON), { skip: 'unannounced' })
    assert.deepEqual(buildRow(byDay(2, 11), null), { skip: 'invalid' })
  })

  it('the id is the date, so a month announced later keeps its id', () => {
    const tba = { month: 1, day: 14, title: 'Program to be announced', place: 'Laurel Lake Community Room' }
    const named = { ...tba, title: 'Hudson in the Civil War' }
    assert.equal(buildRow(named, SEASON).row.source_id, '2026-2027-2027-01-14')
    assert.deepEqual(buildRow(tba, SEASON), { skip: 'unannounced' })
  })
})

describe('run (dry)', () => {
  it('plans the two named programs still to come', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchJson(POSTS), now: () => NOW })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 8)
    assert.equal(result.planned, 2)
  })

  it('no current season post is an empty run, not an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchJson([post('our-remaining-programming-calendar')]), now: () => NOW })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 0)
    assert.equal(result.exitCode, 0)
  })

  it('an endpoint that stops returning a list is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchJson({ code: 'rest_no_route' }), now: () => NOW })
    assert.notEqual(result.status, 'dry-run')
  })
})
