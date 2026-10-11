/**
 * test-main-street-barberton.js — pure hooks for the Main Street Barberton
 * ICS scraper. Fixtures are REAL VEVENT fields captured from the live iCal
 * export on 2026-07-08.
 *
 * Run:  node --test scripts/tests/test-main-street-barberton.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { includeEvent, mapCategory, parseLocation, SOURCE_KEY } =
  await import('../scrape-main-street-barberton.js')
const { isSelfCredit, isAggregatorSource } = await import('../lib/source-tiers.js')
const { collectLinkDonations } = await import('../dedupe-cross-source.js')
const { linkEventOrganization } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')

describe('includeEvent (meeting filter)', () => {
  it('drops council and board meetings', () => {
    assert.equal(includeEvent({ SUMMARY: 'City Council Meeting' }), false)
    assert.equal(includeEvent({ SUMMARY: 'Main Street Board Meeting' }), false)
  })
  it('keeps community events', () => {
    assert.equal(includeEvent({ SUMMARY: 'Lake Anna Concert Series' }), true)
    assert.equal(includeEvent({ SUMMARY: '.5K Race' }), true)
    assert.equal(includeEvent({ SUMMARY: 'Summer Crawl- By The Christmas Walk' }), true)
  })
})

describe('mapCategory', () => {
  it('ICS CATEGORIES drive music and art', () => {
    assert.equal(mapCategory({ SUMMARY: 'Summer Concert Series GARALD HARRIS', CATEGORIES: 'Music' }), 'music')
    assert.equal(mapCategory({ SUMMARY: 'Creative Connections: Colored Pencil Still Lifes', CATEGORIES: 'art class' }), 'visual-art')
  })
  it('title keywords back up missing CATEGORIES', () => {
    assert.equal(mapCategory({ SUMMARY: 'Lake Anna Concert Series' }), 'music')
    assert.equal(mapCategory({ SUMMARY: '.5K Race' }), 'fitness')
    assert.equal(mapCategory({ SUMMARY: 'Summer Crawl- By The Christmas Walk' }), 'festival')
  })
  it('returns null when nothing matches (inference decides)', () => {
    assert.equal(mapCategory({ SUMMARY: 'Hungarian Night @GreenDiamond' }), null)
  })
})

describe('parseLocation (Tribe iCal LOCATION)', () => {
  it('splits venue name + street from the comma chain', () => {
    const p = parseLocation('Kavé Coffee Bar, 584 W. Tuscarawas, Barberton, OH, 44203, United States')
    assert.equal(p.name, 'Kavé Coffee Bar')
    assert.equal(p.details.address, '584 W. Tuscarawas')
    assert.equal(p.details.city, 'Barberton')
  })
  it('bare street addresses fall back to the default venue (no address-named venues)', () => {
    assert.equal(parseLocation('576 W Park Avenue'), null)
  })
  it('region-only LOCATION falls back to the default venue (no address-named venues)', () => {
    assert.equal(parseLocation('Ohio, United States'), null)
  })
  it('single-segment names pass through without an address', () => {
    const p = parseLocation('Barberton Public Library')
    assert.equal(p.name, 'Barberton Public Library')
    assert.equal(p.details.address, null)
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'main_street_barberton')
  })
})

describe('Lake Anna canonicalization (live-run fix 2026-07-08)', () => {
  it('cross-street LOCATION maps to the Lake Anna Park record', () => {
    const p = parseLocation('Lake Anna W. Park Ave/6th St NW')
    assert.equal(p.name, 'Lake Anna Park')
    assert.equal(p.details.address, 'W Park Ave & 6th St NW')
  })
})

describe('attribution: aggregator may never credit itself', () => {
  // Main Street Barberton's calendar is a mixed community calendar: library
  // programs and other hosts' events ride alongside its own, and the feed has
  // no organizer field to tell them apart. Policy is "real organizer or none".
  // These tests run the REAL choke points: linkEventOrganization (normalize.js,
  // the scraper path) against a fake Supabase client, and collectLinkDonations
  // (dedupe-cross-source.js, the merge path).
  const SELF_ORG = 'Main Street Barberton'
  const ORG_MSB     = '55555555-5555-5555-5555-555555555555'
  const ORG_LIBRARY = '66666666-6666-6666-6666-666666666666'

  // Fake client, same shape as test-attribution-lock.js: answers the three
  // reads linkEventOrganization makes (manual_overrides, source, org name) and
  // records every event_organizations write.
  function makeMock({ source, orgName }) {
    const orgLinkUpserts = []
    function resolve(st) {
      if (st.table === 'events' && st.cols === 'manual_overrides') return { data: { manual_overrides: null }, error: null }
      if (st.table === 'events' && st.cols === 'source') return { data: { source }, error: null }
      if (st.table === 'organizations' && st.cols === 'name') return { data: { name: orgName }, error: null }
      return { data: null, error: null }
    }
    function builder(table) {
      const st = { table, cols: null }
      const chain = {
        select(cols) { st.cols = cols; return chain },
        eq() { return chain },
        upsert(row) {
          if (table === 'event_organizations') orgLinkUpserts.push(row)
          return Promise.resolve({ error: null })
        },
        maybeSingle() { return Promise.resolve(resolve(st)) },
        single()      { return Promise.resolve(resolve(st)) },
      }
      return chain
    }
    return { client: { from: builder }, orgLinkUpserts }
  }
  // normalize.js caches orgId -> name and eventId -> source for the run and
  // exposes no reset for either, so every case gets fresh ids.
  let _n = 0
  const nextId = (kind) => `${kind}-msb-test-${++_n}`

  it('the source is a Tier-3 aggregator', () => {
    assert.equal(isAggregatorSource(SOURCE_KEY), true)
  })

  it('scraper path: linkEventOrganization writes NO link crediting Main Street Barberton on its own event', async () => {
    // No opts.source is passed, exactly like lib/ics.js: the guard has to
    // look the event's source up itself.
    const mock = makeMock({ source: SOURCE_KEY, orgName: SELF_ORG })
    __setClientForTests(mock.client)
    await linkEventOrganization(nextId('ev'), nextId('org'))
    assert.deepEqual(mock.orgLinkUpserts, [])
  })

  it('scraper path: linkEventOrganization still links a REAL organizer on an MSB event', async () => {
    const mock = makeMock({ source: SOURCE_KEY, orgName: 'Barberton Public Library' })
    __setClientForTests(mock.client)
    const ev = nextId('ev'), org = nextId('org')
    await linkEventOrganization(ev, org)
    assert.deepEqual(mock.orgLinkUpserts, [{ event_id: ev, organization_id: org }])
  })

  it('scraper path: a first-party source may still link Main Street Barberton as organizer', async () => {
    // Pair-keyed guard: only the self-referential (source, org) pair is refused.
    const mock = makeMock({ source: 'barberton_library', orgName: SELF_ORG })
    __setClientForTests(mock.client)
    const ev = nextId('ev'), org = nextId('org')
    await linkEventOrganization(ev, org)
    assert.deepEqual(mock.orgLinkUpserts, [{ event_id: ev, organization_id: org }])
  })

  it('merge path: a deleted MSB donor never launders its self-credit onto the library\'s row', () => {
    // Rows written before this change still carry the hardcoded self-org link
    // until they are cleaned up; when one loses canonical to the library's own
    // copy it must not hand that link over on the way out.
    const canonical = { source: 'barberton_library', event_venues: [], event_organizations: [] }
    const donors = [{
      source: SOURCE_KEY,
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_MSB, organizations: { name: SELF_ORG } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [])
  })

  it('merge path: the same donor carrying a REAL organizer still donates it', () => {
    // The policy is "real organizer or none", not "no organizer".
    const canonical = { source: 'barberton_library', event_venues: [], event_organizations: [] }
    const donors = [{
      source: SOURCE_KEY,
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_LIBRARY, organizations: { name: 'Barberton Public Library' } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [ORG_LIBRARY])
    assert.equal(isSelfCredit(SOURCE_KEY, 'Barberton Public Library'), false)
  })

  it('a first-party source naming Main Street Barberton is unaffected (pair-keyed guard)', () => {
    assert.equal(isSelfCredit('barberton_library', SELF_ORG), false)
  })

  // Source scan, not a behavioural test: the config is built inline inside
  // main(), which cannot run without a live feed and database. It pins the
  // one thing that matters: nobody re-adds the hardcoded self-org.
  //
  // Comments are stripped first (block comments, then full-line and trailing
  // `//` comments; `(?<!:)` leaves the `//` of a URL alone), and the match is
  // on the config-KEY shape, so prose that merely mentions the word in a
  // comment can neither fail nor satisfy the scan.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '')
  const ORG_NAME_KEY    = /\borganizationName\s*:/
  const ORG_DETAILS_KEY = /\borganizationDetails\s*:/

  it('the source scan itself: sees config keys, ignores comments and URLs', () => {
    const sample = [
      '/* organizationName: "in a block comment" */',
      '// organizationName: "in a line comment"',
      'runIcsScraper({',
      "  feedUrl: 'https://example.org/feed', // organizationName: trailing comment",
      '})',
    ].join('\n')
    const code = stripComments(sample)
    assert.doesNotMatch(code, ORG_NAME_KEY)
    assert.match(code, /https:\/\/example\.org\/feed/)
    assert.match(stripComments("  organizationName : 'X', // why"), ORG_NAME_KEY)
    assert.match(stripComments('  organizationDetails: {},'), ORG_DETAILS_KEY)
  })

  it('the scraper passes no default organization to runIcsScraper', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scrape-main-street-barberton.js'),
      'utf8')
    const code = stripComments(src)
    assert.match(code, /runIcsScraper\(\{/)   // the scan is looking at real code
    assert.doesNotMatch(code, ORG_NAME_KEY)
    assert.doesNotMatch(code, ORG_DETAILS_KEY)
  })
})
