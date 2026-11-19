/**
 * test-summit-indoor-mx.js — the Summit Indoor MX scraper. No network, no database.
 *
 * Built while the site showed only a finished season, so it is tested against
 * two real seasons with the clock set back:
 *   summit-indoor-mx-2026.html   the live page, captured 2026-11-19
 *   summit-indoor-mx-2025.html   the Internet Archive capture of 2025-02-21
 * Both reduced by script (head, scripts, styles, layout attributes removed;
 * the contact address replaced).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, VENUE, parseSchedule, buildRow, run } = await import('../scrape-summit-indoor-mx.js')
const { htmlLines } = await import('../lib/html-lines.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const PAGE_2026 = fx('summit-indoor-mx-2026.html')
const PAGE_2025 = fx('summit-indoor-mx-2025.html')
const S26 = parseSchedule(htmlLines(PAGE_2026))
const S25 = parseSchedule(htmlLines(PAGE_2025))
const serve = (body) => async () => ({ ok: true, status: 200, text: async () => body })
const at = (iso) => () => Date.parse(iso)

describe('the schedule, two seasons', () => {
  it('2026: year, rounds, six dates with their weekdays', () => {
    assert.equal(S26.year, 2026)
    assert.deepEqual(S26.rounds, { 1: 1, 2: 2 })
    assert.deepEqual(S26.dates.map((d) => `${d.month}/${d.day}:${d.weekday}`), ['1/8:4', '1/9:5', '1/10:6', '2/19:4', '2/20:5', '2/21:6'])
  })

  it('2025: the same shape, including a date typed without its space ("Jan10th - Fri")', () => {
    assert.equal(S25.year, 2025)
    assert.deepEqual(S25.dates.map((d) => `${d.month}/${d.day}:${d.weekday}`), ['1/9:4', '1/10:5', '1/11:6', '2/20:4', '2/21:5', '2/22:6'])
  })

  it('reads each day\'s own times, which changed between seasons', () => {
    assert.equal(S26.rules[5].racing.time, '8:00 pm')
    assert.equal(S26.rules[5].gate.time, '2:30 pm')
    assert.equal(S26.rules[6].racing.time, '7:00 pm') // "Racing 7pm", no colon
    assert.equal(S25.rules[5].gate.time, '3:00 pm')
    assert.equal(S25.rules[5].practice.time, '7:00 pm')
  })

  it('reads the gate fee the page prints', () => {
    assert.equal(S26.gateFee, 20)
    assert.equal(S26.kidsFree, true)
    assert.equal(S25.gateFee, 15)
  })

  it('a page with no schedule heading has no year', () => {
    assert.equal(parseSchedule(htmlLines('<h1>Summit Indoor MX</h1><p>See you next winter</p>')).year, null)
  })
})

describe('rows', () => {
  it('Friday of round 1 starts at the Friday racing time', () => {
    const { row, venue } = buildRow(S26.dates[1], S26)
    assert.equal(row.title, 'Summit Indoor MX Round 1: Friday Night Racing')
    assert.equal(row.start_at, '2026-01-10T01:00:00.000Z') // Jan 9, 8:00 PM EST
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '2026-01-09-racing')
    assert.deepEqual(row.categories, ['sports'])
    assert.equal(row.price_min, 20)
    assert.match(row.description, /round 1 of the 2026 series\. Gates open at 2:30 pm, practice at 6:00 pm, racing at 8:00 pm\. Gate fee \$20 per person; kids 5 and under free\.$/)
    assert.equal(venue, VENUE)
  })

  it('Saturday uses the Saturday time; Thursday practice is not listed', () => {
    assert.equal(buildRow(S26.dates[2], S26).row.start_at, '2026-01-11T00:00:00.000Z') // Jan 10, 7:00 PM EST
    assert.deepEqual(buildRow(S26.dates[0], S26), { skip: 'practice_day' })
  })

  it('last year\'s dates under a new heading fail the weekday check instead of becoming events', () => {
    const stale = { ...S26, year: 2027 }
    for (const d of S26.dates.filter((x) => x.weekday !== 4)) assert.deepEqual(buildRow(d, stale), { skip: 'weekday_mismatch' })
  })

  it('no racing time for the day, or no year, means no event', () => {
    assert.deepEqual(buildRow(S26.dates[1], { ...S26, rules: { 5: { gate: S26.rules[5].gate } } }), { skip: 'no_race_time' })
    assert.deepEqual(buildRow(S26.dates[1], { ...S26, year: null }), { skip: 'no_year' })
  })

  it('a fee the page does not print is not invented', () => {
    const { row } = buildRow(S26.dates[1], { ...S26, gateFee: null, kidsFree: false })
    assert.equal(row.price_min, null)
    assert.doesNotMatch(row.description, /fee|free/i)
  })
})

describe('run (dry), with the clock set to each season', () => {
  it('before the 2026 series: four race nights planned, two practice days counted', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(PAGE_2026), now: at('2025-12-15T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 6)
    assert.equal(result.planned, 4)
  })

  it('between the 2026 rounds: only round 2 is left', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(PAGE_2026), now: at('2026-02-01T15:00:00Z') })
    assert.equal(result.planned, 2)
  })

  it('the 2025 page, before the 2025 series: four race nights', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(PAGE_2025), now: at('2024-12-15T15:00:00Z') })
    assert.equal(result.planned, 4)
  })

  it('today, with only the finished season posted: an empty run, not an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(PAGE_2026), now: at('2026-11-19T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 0)
    assert.equal(result.exitCode, 0)
  })

  it('a page with no schedule heading is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve('<h1>Summit Indoor MX</h1>'), now: at('2026-11-19T15:00:00Z') })
    assert.notEqual(result.status, 'dry-run')
  })
})
