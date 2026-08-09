/**
 * test-porchrokr-import.js — pure-logic tests for the PorchRokr 2026
 * importer (scripts/import-porchrokr.js): slot math against concrete UTC
 * instants (DST regressions must be loud), slot-keyed source_id stability,
 * the data-file contract (porches 1..40, all coords Byron-approved so 0 FLAG
 * exclusions, porch 1 → main stage + porch 26 → beer garden routing, 38/39
 * House Three Thirty override, street-less venue-name fallback), umbrella
 * re-stamp semantics, category-lock stamp semantics
 * (computeCategoryLockOverrides), sanitizer round-trips for awkward act
 * names, and the researched artist links (act.link → trailing "Listen: <url>"
 * sentence + validateDataFile's url/platform gate).
 *
 * Uses the REAL checked-in data file (scripts/data/porchrokr-2026.json) as
 * the fixture, per the ADR's test plan — no synthetic porch tables. No
 * env/network/DB: every function under test is pure.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DATA_PATH,
  buildPlan,
  validateDataFile,
  allFileSourceIds,
  computeUmbrellaEnrichment,
  computeCategoryLockOverrides,
  slotKey,
  porchSourceId,
  stageSourceId,
  slotInstants,
  inHighlandSquareBbox,
  LOGISTICS_MARKER,
  UMBRELLA_TAGS,
} from '../import-porchrokr.js'
import { easternToIso, sanitizeEventText } from '../lib/normalize.js'

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
const plan = buildPlan(data)
const bySourceId = new Map(plan.planned.map((p) => [p.row.source_id, p]))

describe('slot math — concrete UTC instants (Aug 15 2026 is EDT, UTC-4)', () => {
  it('11:00 AM ET === 2026-08-15T15:00:00.000Z (the ADR anchor instant)', () => {
    assert.equal(easternToIso('2026-08-15', '11:00 AM'), '2026-08-15T15:00:00.000Z')
  })

  it('slotInstants: 30-minute sets across the odd/even grid', () => {
    assert.deepEqual(slotInstants('2026-08-15', '11:00 AM'), {
      start_at: '2026-08-15T15:00:00.000Z', end_at: '2026-08-15T15:30:00.000Z',
    })
    assert.deepEqual(slotInstants('2026-08-15', '12:00 PM'), {
      start_at: '2026-08-15T16:00:00.000Z', end_at: '2026-08-15T16:30:00.000Z',
    })
    assert.deepEqual(slotInstants('2026-08-15', '1:00 PM'), {
      start_at: '2026-08-15T17:00:00.000Z', end_at: '2026-08-15T17:30:00.000Z',
    })
    assert.deepEqual(slotInstants('2026-08-15', '6:00 PM'), {
      start_at: '2026-08-15T22:00:00.000Z', end_at: '2026-08-15T22:30:00.000Z',
    })
  })

  it('headliner: 7:30 PM ET for 90 minutes → 23:30Z ending 01:00Z next UTC day', () => {
    assert.deepEqual(slotInstants('2026-08-15', '7:30 PM', 90), {
      start_at: '2026-08-15T23:30:00.000Z', end_at: '2026-08-16T01:00:00.000Z',
    })
    const headliner = bySourceId.get('2026-stage-main-1930')
    assert.ok(headliner, 'headliner planned under 2026-stage-main-1930')
    assert.equal(headliner.row.start_at, '2026-08-15T23:30:00.000Z')
    assert.equal(headliner.row.end_at, '2026-08-16T01:00:00.000Z')
    assert.equal(headliner.row.title, 'Rent for Cheryl - PorchRokr Main Stage (Headliner)')
  })

  it('planned porch rows land only on the odd/even slot instants', () => {
    const oddStarts = new Set(['2026-08-15T15:00:00.000Z', '2026-08-15T17:00:00.000Z', '2026-08-15T19:00:00.000Z', '2026-08-15T21:00:00.000Z'])
    const evenStarts = new Set(['2026-08-15T16:00:00.000Z', '2026-08-15T18:00:00.000Z', '2026-08-15T20:00:00.000Z', '2026-08-15T22:00:00.000Z'])
    for (const { row } of plan.planned) {
      const m = /^2026-p(\d{2})-/.exec(row.source_id)
      if (!m) continue
      const porch = parseInt(m[1], 10)
      const want = porch % 2 === 1 ? oddStarts : evenStarts
      assert.ok(want.has(row.start_at), `${row.source_id} starts at ${row.start_at}`)
      assert.equal(Date.parse(row.end_at) - Date.parse(row.start_at), 30 * 60_000)
    }
  })

  it('slotKey / source_id formatting', () => {
    assert.equal(slotKey('11:00 AM'), '1100')
    assert.equal(slotKey('1:00 PM'), '1300')
    assert.equal(slotKey('7:30 PM'), '1930')
    assert.equal(slotKey('nonsense'), null)
    assert.equal(porchSourceId(7, '1:00 PM'), '2026-p07-1300')
    assert.equal(stageSourceId('kid-zone', '11:00 AM'), '2026-stage-kid-zone-1100')
  })
})

describe('source_id stability (slot-keyed, NOT act-keyed)', () => {
  it('same file twice → identical row set', () => {
    const again = buildPlan(JSON.parse(readFileSync(DATA_PATH, 'utf8')))
    assert.deepEqual(
      again.planned.map((p) => p.row.source_id),
      plan.planned.map((p) => p.row.source_id),
    )
    assert.deepEqual(again.planned.map((p) => p.row), plan.planned.map((p) => p.row))
  })

  it('an act rename changes the title only — the source_id survives (no churn dupes)', () => {
    const mutated = structuredClone(data)
    const porch13 = mutated.porches.find((p) => p.porch === 13)
    const act = porch13.acts.find((a) => a.slot === '1:00 PM')
    act.name = `${act.name}: The Farewell Tour`
    const replan = buildPlan(mutated)
    assert.deepEqual(
      replan.planned.map((p) => p.row.source_id),
      plan.planned.map((p) => p.row.source_id),
      'source_ids identical after rename',
    )
    const before = bySourceId.get('2026-p13-1300').row
    const after = replan.planned.find((p) => p.row.source_id === '2026-p13-1300').row
    assert.notEqual(after.title, before.title)
    assert.equal(after.start_at, before.start_at)
  })

  it('no duplicate source_ids anywhere (planned or excluded)', () => {
    assert.deepEqual(plan.problems, [])
    const all = allFileSourceIds(plan)
    const total = plan.planned.length + plan.excluded.reduce((n, e) => n + e.acts.length, 0)
    assert.equal(all.size, total)
  })
})

describe('data-file contract (the real scripts/data/porchrokr-2026.json)', () => {
  it('validates cleanly', () => {
    assert.deepEqual(validateDataFile(data), [])
  })

  it('porches 1..40 appear exactly once', () => {
    const nums = data.porches.map((p) => p.porch).sort((a, b) => a - b)
    assert.deepEqual(nums, Array.from({ length: 40 }, (_, i) => i + 1))
  })

  it('all 160 brochure acts plus the headliner are planned: 161 events, 0 excluded', () => {
    // 38 porch venues × 4 sets + 4 routed to main (porch 1) + 4 routed to
    // beer-garden (porch 26) + the headliner. Byron approved map-derived
    // coords for every remaining porch on 2026-08-09, so nothing is FLAGged.
    assert.equal(plan.planned.length, 161)
    assert.deepEqual(plan.excluded, [])
  })

  it('no FLAG porches remain — every porch is HIGH with Byron-reviewed coordinates', () => {
    assert.deepEqual(data.porches.filter((p) => p.confidence === 'FLAG').map((p) => p.porch), [])
  })

  it('every porch without a venueOverride carries reviewed coordinates + provenance', () => {
    for (const p of data.porches) {
      if (p.venueOverride) continue
      assert.notEqual(p.lat, null, `porch ${p.porch} lat`)
      assert.notEqual(p.lng, null, `porch ${p.porch} lng`)
      assert.ok(p.geocode?.at, `porch ${p.porch} geocode provenance`)
    }
    // Map-derived rows carry the affine-fit provenance…
    const p21 = data.porches.find((p) => p.porch === 21)
    assert.equal(p21.geocode.method, 'brochure-map-affine-fit')
    assert.equal(p21.geocode.reviewedBy, 'byron')
    // …while the six Nominatim-geocoded W. Market porches keep theirs untouched.
    for (const n of [32, 33, 34, 35, 36, 37]) {
      const p = data.porches.find((x) => x.porch === n)
      assert.ok(p.geocode.osm_id, `porch ${n} keeps its Nominatim osm_id`)
      assert.equal(p.geocode.method, undefined, `porch ${n} has no affine-fit stamp`)
    }
  })

  it('every porch and stage coordinate passes the Summit + Highland Square gates', () => {
    for (const p of data.porches) {
      if (p.lat != null && p.lng != null) {
        assert.ok(inHighlandSquareBbox(p.lat, p.lng), `porch ${p.porch} in HS bbox`)
      }
    }
    for (const s of data.stages) {
      assert.notEqual(s.lat, null, `stage ${s.key} lat`)
      assert.notEqual(s.lng, null, `stage ${s.key} lng`)
      assert.ok(inHighlandSquareBbox(s.lat, s.lng), `stage ${s.key} in HS bbox`)
    }
    // The gate itself must discriminate: center in, out-of-box out.
    assert.ok(inHighlandSquareBbox(41.095, -81.53))
    assert.ok(!inHighlandSquareBbox(41.07, -81.53))   // south of Highland Square
    assert.ok(!inHighlandSquareBbox(41.095, -81.45))  // east of Highland Square
  })

  it('porches 38/39 resolve onto the existing House Three Thirty venue (never minted, room in the title)', () => {
    for (const [porch, room] of [[38, 'Cabaret'], [39, 'Cafe']]) {
      const p = data.porches.find((x) => x.porch === porch)
      assert.equal(p.venueOverride, 'House Three Thirty')
      const rows = plan.planned.filter((x) => x.row.source_id.startsWith(`2026-p${porch}-`))
      assert.equal(rows.length, 4)
      for (const { row, venue } of rows) {
        assert.equal(venue.kind, 'override')
        assert.equal(venue.name, 'House Three Thirty')
        assert.match(row.title, new RegExp(`House Three Thirty ${room}\\)$`))
      }
    }
  })

  it("porch 26 routes to the beer-garden stage — stage source_ids, no 2026-p26-* anywhere", () => {
    const beerGarden = plan.planned.filter((x) => x.row.source_id.startsWith('2026-stage-beer-garden-'))
    assert.deepEqual(
      beerGarden.map((x) => x.row.source_id).sort(),
      ['2026-stage-beer-garden-1200', '2026-stage-beer-garden-1400', '2026-stage-beer-garden-1600', '2026-stage-beer-garden-1800'],
    )
    assert.deepEqual(
      beerGarden.map((x) => x.row.title).sort(),
      [
        'Aka & Company - PorchRokr Beer Garden & Stage',
        'Cat Stanley - PorchRokr Beer Garden & Stage',
        'Grumpy Plum - PorchRokr Beer Garden & Stage',
        'Roxxymoron - PorchRokr Beer Garden & Stage',
      ],
    )
    for (const id of allFileSourceIds(plan)) assert.ok(!id.startsWith('2026-p26-'), id)
  })

  it("porch 1 routes to the main stage — 4 sets + the headliner under 2026-stage-main-*, no 2026-p01-* anywhere", () => {
    const main = plan.planned.filter((x) => x.row.source_id.startsWith('2026-stage-main-'))
    assert.deepEqual(
      main.map((x) => x.row.source_id).sort(),
      ['2026-stage-main-1100', '2026-stage-main-1300', '2026-stage-main-1500', '2026-stage-main-1700', '2026-stage-main-1930'],
    )
    const titles = main.map((x) => x.row.title)
    assert.ok(titles.includes('A Band Named Ashes - PorchRokr Main Stage'))
    assert.ok(titles.includes('Rent for Cheryl - PorchRokr Main Stage (Headliner)'))
    for (const id of allFileSourceIds(plan)) assert.ok(!id.startsWith('2026-p01-'), id)
    // All five share the one minted Main Stage venue carrying porch 1's map coords.
    for (const { venue } of main) {
      assert.equal(venue.kind, 'mint')
      assert.equal(venue.name, 'PorchRokr Main Stage (Highland Square)')
      assert.equal(venue.lat, 41.095564)
      assert.equal(venue.lng, -81.54406)
    }
  })

  it('street-less porches: venue name has no dangling house number, description points at the festival map', () => {
    const p21rows = plan.planned.filter((x) => x.row.source_id.startsWith('2026-p21-'))
    assert.equal(p21rows.length, 4)
    for (const { row, venue } of p21rows) {
      assert.equal(venue.name, 'PorchRokr Porch 21')
      assert.equal(venue.address, undefined)
      assert.ok(
        row.description.includes("See the festival map on the PorchRokr page for this porch's exact spot."),
        row.description,
      )
      assert.ok(!row.description.includes('null'), row.description)
      assert.ok(!row.description.includes('Porch at '), row.description)
    }
    // Street-present porches keep the addressed forms exactly as before.
    const p2 = plan.planned.find((x) => x.row.source_id === '2026-p02-1200')
    assert.equal(p2.venue.name, 'PorchRokr Porch 2 - 804 Bloomfield Ave')
    assert.ok(p2.row.description.includes('Porch at 804 Bloomfield Ave.'))
    // Porch 30 keeps 958 W. Market St (map position confirmed it)…
    const p30 = plan.planned.find((x) => x.row.source_id === '2026-p30-1200')
    assert.equal(p30.venue.name, 'PorchRokr Porch 30 - 958 W. Market St')
    // …while porch 40's suspect printed address stays out of the venue name.
    const p40 = plan.planned.find((x) => x.row.source_id === '2026-p40-1200')
    assert.equal(p40.venue.name, 'PorchRokr Porch 40')
  })

  it('every planned row: source porchrokr, published, free, all_ages, image-less, featured:false ALWAYS', () => {
    for (const { row } of plan.planned) {
      assert.equal(row.source, 'porchrokr')
      assert.equal(row.status, 'published')
      assert.equal(row.featured, false)
      // Explicit v2 list, ORDER MATTERS (music primary via insertion order);
      // the legacy single-value category hint must be gone entirely.
      assert.deepEqual(row.categories, ['music', 'festival'])
      assert.ok(!('category' in row), `no legacy category field on ${row.source_id}`)
      assert.equal(row.price_min, 0)
      assert.equal(row.age_restriction, 'all_ages')
      assert.equal(row.image_url, null)
      assert.ok(row.tags.includes('porchrokr-2026'))
      assert.ok(row.tags.includes('highland-square'))
      assert.ok(row.tags.some((t) => /^porch-\d+$/.test(t) || /^stage-[a-z0-9-]+$/.test(t)))
    }
  })
})

describe('umbrella enrichment — manual_overrides re-stamp semantics', () => {
  const NOW = '2026-08-09T12:00:00.000Z'
  const existing = {
    description: 'PorchROKR returns to Highland Square with music and art on every porch.',
    tags: ['porchrokr', 'highland-square', 'akron', 'festival', 'music', 'free', 'outdoor'],
    manual_overrides: { image_url: { at: '2026-01-01T00:00:00.000Z' } },
  }

  it('first enrichment: appends the marked logistics block, adds hub tags, re-stamps exactly those keys', () => {
    const e = computeUmbrellaEnrichment(existing, data.festival, NOW)
    assert.ok(e, 'change detected')
    assert.deepEqual(Object.keys(e.updates).sort(), ['description', 'tags'])
    assert.ok(e.updates.description.startsWith(existing.description))
    assert.ok(e.updates.description.includes(`${LOGISTICS_MARKER}\n${data.festival.logistics}`))
    for (const t of UMBRELLA_TAGS) assert.ok(e.updates.tags.includes(t))
    for (const t of existing.tags) assert.ok(e.updates.tags.includes(t))
    assert.deepEqual(e.overrides.description, { at: NOW, by: 'porchrokr-2026-import' })
    assert.deepEqual(e.overrides.tags, { at: NOW, by: 'porchrokr-2026-import' })
    // Pre-existing pins survive untouched.
    assert.deepEqual(e.overrides.image_url, { at: '2026-01-01T00:00:00.000Z' })
  })

  it('re-run with unchanged content → null (no write at all — no trigger churn)', () => {
    const first = computeUmbrellaEnrichment(existing, data.festival, NOW)
    const applied = {
      description: first.updates.description,
      tags: first.updates.tags,
      manual_overrides: first.overrides,
    }
    assert.equal(computeUmbrellaEnrichment(applied, data.festival, '2026-08-10T12:00:00.000Z'), null)
  })

  it('logistics edit → only description re-stamped fresh; the tags pin keeps its old at', () => {
    const first = computeUmbrellaEnrichment(existing, data.festival, NOW)
    const applied = {
      description: first.updates.description,
      tags: first.updates.tags,
      manual_overrides: first.overrides,
    }
    const editedFestival = { ...data.festival, logistics: `${data.festival.logistics} Rain or shine.` }
    const LATER = '2026-08-12T09:00:00.000Z'
    const second = computeUmbrellaEnrichment(applied, editedFestival, LATER)
    assert.deepEqual(Object.keys(second.updates), ['description'])
    assert.equal(second.updates.description.split(LOGISTICS_MARKER).length, 2, 'logistics block never stacks')
    assert.deepEqual(second.overrides.description, { at: LATER, by: 'porchrokr-2026-import' })
    assert.deepEqual(second.overrides.tags, { at: NOW, by: 'porchrokr-2026-import' })
  })
})

describe('category lock — computeCategoryLockOverrides stamp semantics', () => {
  const NOW = '2026-08-09T12:00:00.000Z'
  const OURS = { at: NOW, by: 'porchrokr-2026-import' }

  it('fresh event: stamps exactly categories + category_slugs with {at, by}', () => {
    assert.deepEqual(computeCategoryLockOverrides({}, NOW), {
      categories: OURS,
      category_slugs: OURS,
    })
  })

  it('null / undefined manual_overrides are treated as empty', () => {
    assert.deepEqual(computeCategoryLockOverrides(null, NOW), { categories: OURS, category_slugs: OURS })
    assert.deepEqual(computeCategoryLockOverrides(undefined, NOW), { categories: OURS, category_slugs: OURS })
  })

  it('idempotent: returns null (no write) when already stamped by this importer', () => {
    const first = computeCategoryLockOverrides({}, NOW)
    assert.equal(computeCategoryLockOverrides(first, '2026-08-10T12:00:00.000Z'), null)
  })

  it('merge-not-clobber: foreign pins survive untouched alongside our stamp; input not mutated', () => {
    const existing = {
      image_url: { at: '2026-01-01T00:00:00.000Z' },
      description: { at: '2026-03-03T00:00:00.000Z', by: 'byron' },
    }
    const o = computeCategoryLockOverrides(existing, NOW)
    assert.deepEqual(o.image_url, existing.image_url)
    assert.deepEqual(o.description, existing.description)
    assert.deepEqual(o.categories, OURS)
    assert.deepEqual(o.category_slugs, OURS)
    assert.deepEqual(Object.keys(existing).sort(), ['description', 'image_url'], 'input untouched')
  })

  it('a FOREIGN categories stamp is re-stamped as ours (skip is keyed on by === STAMP_BY only)', () => {
    const o = computeCategoryLockOverrides(
      { categories: { at: '2026-01-01T00:00:00.000Z', by: 'someone-else' } }, NOW,
    )
    assert.deepEqual(o.categories, OURS)
    assert.deepEqual(o.category_slugs, OURS)
  })
})

describe('sanitizer round-trips — real awkward act names survive ingest untouched', () => {
  const cases = [
    { source_id: '2026-p17-1100', name: "It's About Time" },                    // apostrophe
    { source_id: '2026-p16-1800', name: 'Benny Lava & The Guavas' },            // ampersand
    { source_id: '2026-p16-1400', name: 'Marcus Smith & The Rapscallions' },    // ampersand
    { source_id: '2026-stage-main-1930', name: 'Rent for Cheryl' },             // headliner
    { source_id: '2026-p27-1300', name: '[Redacted]' },                         // literally named "[Redacted]"
    { source_id: '2026-p21-1500', name: 'Dave Rich & His Enablers' },           // street-less porch, "porch's" in description
  ]

  for (const { source_id, name } of cases) {
    it(`${JSON.stringify(name)} (${source_id})`, () => {
      const planned = bySourceId.get(source_id)
      assert.ok(planned, `${source_id} planned`)
      assert.ok(planned.row.title.startsWith(`${name} - PorchRokr`), planned.row.title)
      const clean = sanitizeEventText(planned.row)
      assert.equal(clean.title, planned.row.title, 'title round-trips through sanitizeEventText')
      assert.equal(clean.description, planned.row.description, 'description round-trips')
    })
  }
})

describe('researched artist links — act.link → "Listen: <url>" final sentence', () => {
  // Act names are unique across the whole lineup (asserted elsewhere as 161
  // unique planned rows), so a title-prefix lookup is unambiguous.
  const allActs = [
    ...data.porches.flatMap((p) => p.acts ?? []),
    ...data.stages.flatMap((s) => s.acts ?? []),
  ]
  const linked = allActs.filter((a) => a.link)
  const unlinked = allActs.filter((a) => !a.link)
  const rowFor = (name) => plan.planned.find((x) => x.row.title.startsWith(`${name} - PorchRokr`))?.row

  it('the fixture actually exercises links: 103 linked acts, on porches AND stages', () => {
    assert.equal(linked.length, 103)
    assert.ok(unlinked.length > 0, 'some acts stay unlinked')
    assert.ok(data.stages.some((s) => (s.acts ?? []).some((a) => a.link)), 'a stage act is linked (headliner branch)')
  })

  it('every linked act\'s description ends with "Listen: <url>" — final sentence, no trailing period', () => {
    for (const act of linked) {
      const row = rowFor(act.name)
      assert.ok(row, `planned row for linked act ${JSON.stringify(act.name)}`)
      assert.ok(row.description.endsWith(` Listen: ${act.link.url}`), `${row.source_id}: ${row.description}`)
      assert.ok(!row.description.endsWith('.'), `${row.source_id} must not gain a trailing period`)
    }
  })

  it('the headliner (stage branch) carries its link too', () => {
    const headliner = bySourceId.get('2026-stage-main-1930').row
    assert.match(headliner.description, / Listen: https?:\/\/\S+$/)
  })

  it('unlinked acts\' descriptions are untouched: still end "Free and open to all.", never mention Listen:', () => {
    for (const act of unlinked) {
      const row = rowFor(act.name)
      assert.ok(row, `planned row for unlinked act ${JSON.stringify(act.name)}`)
      assert.ok(row.description.endsWith('Free and open to all.'), `${row.source_id}: ${row.description}`)
      assert.ok(!row.description.includes('Listen:'), row.source_id)
    }
  })

  it('linked descriptions round-trip through sanitizeEventText byte-identical (the no-& rule earns its keep)', () => {
    for (const act of linked) {
      const row = rowFor(act.name)
      const clean = sanitizeEventText(row)
      assert.equal(clean.description, row.description, `${row.source_id} description round-trips`)
      assert.equal(clean.title, row.title, `${row.source_id} title round-trips`)
    }
  })

  describe('validateDataFile link gate', () => {
    const withBadLink = (link) => {
      const mutated = structuredClone(data)
      mutated.porches.find((p) => p.porch === 2).acts[0].link = link
      return validateDataFile(mutated)
    }

    it('the real data file (103 links) validates cleanly', () => {
      assert.deepEqual(validateDataFile(data), [])
    })

    it('rejects a scheme-less url', () => {
      const problems = withBadLink({ url: 'open.spotify.com/artist/x', platform: 'spotify' })
      assert.ok(problems.some((p) => p.includes('link url')), JSON.stringify(problems))
    })

    it("rejects a url containing '&' (would not survive sanitizeEventText's entity decoding)", () => {
      const problems = withBadLink({ url: 'https://example.com/a?b=1&c=2', platform: 'website' })
      assert.ok(problems.some((p) => p.includes('link url')), JSON.stringify(problems))
    })

    it('rejects a url containing whitespace', () => {
      const problems = withBadLink({ url: 'https://example.com/a b', platform: 'website' })
      assert.ok(problems.some((p) => p.includes('link url')), JSON.stringify(problems))
    })

    it('rejects a platform outside the allowlist', () => {
      const problems = withBadLink({ url: 'https://myspace.com/band', platform: 'myspace' })
      assert.ok(problems.some((p) => p.includes('link platform')), JSON.stringify(problems))
    })

    it('polices stage acts, not just porch acts', () => {
      const mutated = structuredClone(data)
      mutated.stages[0].acts[0].link = { url: 'https://example.com/ok', platform: 'geocities' }
      const problems = validateDataFile(mutated)
      assert.ok(problems.some((p) => p.startsWith('stage ') && p.includes('link platform')), JSON.stringify(problems))
    })
  })
})
