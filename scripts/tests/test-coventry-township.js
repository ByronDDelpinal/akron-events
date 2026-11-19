/**
 * test-coventry-township.js — the Coventry Township scraper. No network, no database.
 *
 * Fixtures (captured live 2026-11-19):
 *   coventry-township-feed.xml                  the Wix blog RSS feed, as served (20 posts)
 *   coventry-township-post-tree-lighting.html   a community event with a date line and "Location:"
 *   coventry-township-post-zoning-meeting.html  a board meeting at the Community Center
 *   coventry-township-post-food-drive.html      a dated post that states no time
 * Post pages are reduced by script to the JSON-LD block and the post body;
 * staff names, emails and phone numbers are replaced.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, FEED_URL, COMMUNITY_CENTER, parseFeed, titleDate, isCancelled, isNewsTitle, parsePost,
  statedYear, eventYear, findPlace, describe: describePost, categoriesFor, buildRow, run,
} = await import('../scrape-coventry-township.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const FEED = fx('coventry-township-feed.xml')
const TREE = fx('coventry-township-post-tree-lighting.html')
const ZONING = fx('coventry-township-post-zoning-meeting.html')
const FOOD = fx('coventry-township-post-food-drive.html')
const NOW = Date.parse('2026-11-19T15:00:00Z')
const posts = parseFeed(FEED)
const postLike = (re) => posts.find((p) => re.test(p.title))
const at = (iso) => Date.parse(iso)

describe('the feed', () => {
  it('reads every post with its slug, link and publication time', () => {
    assert.equal(posts.length, 20)
    const tree = postLike(/Tree Lighting/)
    assert.equal(tree.slug, 'coventry-clock-tower-tree-lighting-holiday-kick-off-event-dec-6th')
    assert.equal(tree.link, `https://www.coventrytownship.com/post/${tree.slug}`)
    assert.equal(new Date(tree.publishedAt).toISOString().slice(0, 10), '2026-10-29')
    assert.ok(tree.categories.includes('News & Events'))
  })

  it('returns nothing for something that is not a feed', () => {
    assert.deepEqual(parseFeed('<html><body>Maintenance</body></html>'), [])
  })
})

describe('which posts are events: the title ends with a date', () => {
  it('reads the township\'s date styles and removes the date from the title', () => {
    assert.deepEqual(titleDate('Zoning Commission Board Meeting  - NOV 17'), { month: 11, day: 17, title: 'Zoning Commission Board Meeting' })
    assert.deepEqual(titleDate('Zoning Appeals Board Meeting - Nov. 10'), { month: 11, day: 10, title: 'Zoning Appeals Board Meeting' })
    assert.deepEqual(titleDate("Coventry Firefighters' Fill-the-Fire-Truck Community Food Drive - Mon. Nov 23rd"),
      { month: 11, day: 23, title: "Coventry Firefighters' Fill-the-Fire-Truck Community Food Drive" })
    assert.deepEqual(titleDate('Coventry Clock Tower Tree Lighting - Holiday Kick-Off Event Dec. 6th'),
      { month: 12, day: 6, title: 'Coventry Clock Tower Tree Lighting - Holiday Kick-Off Event' })
  })

  it('news posts have no date at the end of the title', () => {
    for (const t of ['Township Newsletter', "We're now a \"Do Not Knock\" Community!", 'COVENTRY RESIDENT LEAF DROP-OFF EVENTS 2026',
      'NOVEMBER 3, 2026 - GENERAL ELECTION BALLOT ISSUES', 'Board Vacancies Appointed - Board of Trustees and Zoning Commission', 'Nov 17', 'Meeting - Smarch 3', '']) {
      assert.equal(titleDate(t), null, t)
    }
  })

  it('12 of the 20 posts in the feed carry a date', () => {
    assert.equal(posts.filter((p) => titleDate(p.title)).length, 12)
  })

  it('recognises cancelled titles and dated titles that are reports, not invitations', () => {
    assert.equal(isCancelled('Zoning Commission Board Meeting (CANCELLED) - AUG. 18'), true)
    assert.equal(isCancelled('Zoning Commission Board Meeting - NOV 17'), false)
    assert.equal(isNewsTitle('PRESS RELEASE: E. Reservoir Drowning - Jul 15th'), true)
    assert.equal(isNewsTitle('Coventry Clock Tower Tree Lighting - Holiday Kick-Off Event Dec. 6th'), false)
  })
})

describe('the year', () => {
  it('is the first such date after posting, within five months', () => {
    assert.equal(eventYear(at('2026-10-29T12:50:00Z'), 12, 6), 2026)
    assert.equal(eventYear(at('2026-12-20T12:00:00Z'), 1, 12), 2027) // December post, January meeting
    assert.equal(eventYear(at('2026-11-17T14:00:00Z'), 11, 17), 2026) // posted the same day
  })

  it('a title dated before its post is not an event', () => {
    assert.equal(eventYear(at('2026-07-17T12:00:00Z'), 7, 15), null)   // a report two days later
    assert.equal(eventYear(at('2026-03-01T12:00:00Z'), 12, 6), null)   // more than five months out
  })

  it('a year printed in the post for the same day wins', () => {
    assert.equal(statedYear('Sunday, December 6, 2026 | 4:00–6:30 p.m.', 12, 6), 2026)
    assert.equal(statedYear('a public hearing on Tuesday, November 17, 2026 at 6:00 PM', 11, 17), 2026)
    assert.equal(statedYear('Adopted November 3, 2025. Meeting November 17.', 11, 17), null)
  })
})

describe('post pages', () => {
  it('tree lighting: body lines and the post image', () => {
    const page = parsePost(TREE)
    assert.equal(page.lines[0], 'Sunday, December 6, 2026 | 4:00–6:30 p.m.')
    assert.equal(page.lines[1], 'Location: Coventry Clock Tower')
    assert.match(page.imageUrl, /^https:\/\/static\.wixstatic\.com\/media\//)
    assert.ok(page.lines.every((l) => !/[<>]/.test(l)))
  })

  it('a page without a post body yields no lines', () => {
    assert.deepEqual(parsePost('<html><body>top of page</body></html>'), { lines: [], imageUrl: null })
  })

  it('finds the place: Community Center for meetings, a "Location:" line, otherwise none', () => {
    assert.equal(findPlace(parsePost(ZONING).lines), COMMUNITY_CENTER)
    assert.deepEqual(findPlace(parsePost(TREE).lines), { name: 'Coventry Clock Tower', details: { city: 'Akron', state: 'OH', zip: '44319' } })
    assert.equal(findPlace(['Bring non-perishable food items.']), null)
  })

  it('a named street address in the text is used, unless it is outside Summit County', () => {
    assert.deepEqual(findPlace(['Join us at the Lockwood United Methodist Church, 3680 S. Main Street, Akron.']),
      { name: 'Lockwood United Methodist Church', details: { address: '3680 S. Main Street', city: 'Akron', state: 'OH' } })
    assert.equal(findPlace(['Join us at the Civic Center, 1101 Market Avenue, Canton.']), null)
  })

  it('the description drops contact lines and file downloads', () => {
    const d = describePost(parsePost(TREE).lines)
    assert.match(d, /^Sunday, December 6, 2026/)
    assert.doesNotMatch(d, /@|\.pdf|Download PDF/i)
    assert.ok(d.length <= 1500)
    assert.equal(describePost([]), null)
  })

  it('categories', () => {
    assert.deepEqual(categoriesFor('Zoning Commission Board Meeting'), ['civic'])
    assert.deepEqual(categoriesFor('Coventry Clock Tower Tree Lighting - Holiday Kick-Off Event'), ['festival'])
    assert.deepEqual(categoriesFor('Community Food Drive'), ['civic'])
  })
})

describe('rows', () => {
  it('tree lighting: 4:00 to 6:30 PM on December 6 at the clock tower', () => {
    const { row, venue } = buildRow(postLike(/Tree Lighting/), parsePost(TREE))
    assert.equal(row.title, 'Coventry Clock Tower Tree Lighting - Holiday Kick-Off Event')
    assert.equal(row.start_at, '2026-12-06T21:00:00.000Z')
    assert.equal(row.end_at, '2026-12-06T23:30:00.000Z')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'coventry-clock-tower-tree-lighting-holiday-kick-off-event-dec-6th')
    assert.deepEqual(row.categories, ['festival'])
    assert.equal(row.price_min, null)
    assert.equal(venue.name, 'Coventry Clock Tower')
  })

  it('zoning meeting: "6 p.m." and "6:00 PM" are one time; held at the Community Center', () => {
    const { row, venue } = buildRow(postLike(/NOV 17/), parsePost(ZONING))
    assert.equal(row.title, 'Zoning Commission Board Meeting')
    assert.equal(row.start_at, '2026-11-17T23:00:00.000Z')
    assert.equal(row.end_at, null)
    assert.deepEqual(row.categories, ['civic'])
    assert.equal(venue, COMMUNITY_CENTER)
  })

  it('a post that states no time is skipped, never given one', () => {
    assert.deepEqual(buildRow(postLike(/Food Drive/), parsePost(FOOD)), { skip: 'no_single_time' })
  })

  it('skips cancelled meetings, reports and undated posts', () => {
    const page = parsePost(ZONING)
    assert.deepEqual(buildRow(postLike(/CANCELLED/), page), { skip: 'cancelled' })
    assert.deepEqual(buildRow(postLike(/PRESS RELEASE/), page), { skip: 'news' })
    assert.deepEqual(buildRow(postLike(/Newsletter/), page), { skip: 'invalid' })
  })

  it('a dated title posted after its date is not turned into next year\'s event', () => {
    const late = { title: 'Road Closure Recap - Jul 15th', slug: 'recap', link: 'x', publishedAt: at('2026-07-17T12:00:00Z') }
    assert.deepEqual(buildRow(late, { lines: ['Crews worked until 3 p.m.'], imageUrl: null }), { skip: 'dated_before_posting' })
  })
})

describe('run (dry, fixtures served by a fake fetch)', () => {
  const pages = {
    [FEED_URL]: FEED,
    [postLike(/Tree Lighting/).link]: TREE,
    [postLike(/NOV 17/).link]: ZONING,
    [postLike(/Food Drive/).link]: FOOD,
  }
  const fetchImpl = async (url) => {
    const body = pages[String(url)]
    return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 404, text: async () => '' }
  }

  it('plans the one upcoming event that states a time', async () => {
    const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 12)
    assert.equal(result.planned, 1)
  })

  it('earlier in the month the zoning meeting is planned too', async () => {
    const result = await run({ dryRun: true, fetchImpl, now: () => at('2026-11-12T15:00:00Z'), delayMs: 0 })
    assert.equal(result.planned, 2)
  })

  it('a feed of news only is an empty run, not an error', async () => {
    const news = '<rss><channel><item><title>Township Newsletter</title><link>https://www.coventrytownship.com/post/township-newsletter</link><pubDate>Mon, 21 Sep 2026 14:00:00 GMT</pubDate></item></channel></rss>'
    const result = await run({ dryRun: true, fetchImpl: async () => ({ ok: true, status: 200, text: async () => news }), now: () => NOW, delayMs: 0 })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 0)
    assert.equal(result.exitCode, 0)
  })

  it('something that is not a feed is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>Maintenance</html>' }), now: () => NOW, delayMs: 0 })
    assert.notEqual(result.status, 'dry-run')
  })
})
