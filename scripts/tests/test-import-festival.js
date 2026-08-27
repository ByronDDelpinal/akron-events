/**
 * test-import-festival.js: pure-logic tests for scripts/import-festival.js,
 * the generic "published lineup at real venues" festival importer. Fixture
 * is the real checked-in data file (scripts/data/rubber-city-jazz-2026.json),
 * per the PorchRokr precedent, no synthetic set tables. No env/network/DB:
 * every function under test is pure.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  dataPathFor,
  slotKey,
  setSourceId,
  slotInstants,
  validateDataFile,
  buildPlan,
  allFileSourceIds,
  computeUmbrellaEnrichment,
  computeCategoryLockOverrides,
  computeChildTagPin,
  importStampFor,
  easternRangeLabel,
} from '../import-festival.js'
import { easternToIso, sanitizeEventText } from '../lib/normalize.js'

const DATA_PATH = dataPathFor('rubber-city-jazz-2026')
const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
const plan = buildPlan(data)
const bySourceId = new Map(plan.planned.map((p) => [p.row.source_id, p]))

const EM_DASH = String.fromCharCode(0x2014)
const STAMP_BY = importStampFor(data.festival)

describe('data file validates cleanly (offline, no DB)', () => {
  it('zero problems', () => {
    assert.deepEqual(plan.problems, [])
  })
})

describe('slot math: concrete UTC instants (September 2026 is EDT, UTC-4)', () => {
  it('7:00 PM ET on the first day === 2026-09-10T23:00:00.000Z', () => {
    assert.equal(easternToIso('2026-09-10', '7:00 PM'), '2026-09-10T23:00:00.000Z')
  })

  it('9:00 PM ET on the last day === 2026-09-13T01:00:00.000Z (DST regressions must be loud)', () => {
    assert.equal(easternToIso('2026-09-12', '9:00 PM'), '2026-09-13T01:00:00.000Z')
  })

  it('slotInstants: end null when absent, present when given', () => {
    assert.deepEqual(slotInstants('2026-09-10', '7:00 PM'), { start_at: '2026-09-10T23:00:00.000Z', end_at: null })
    assert.deepEqual(slotInstants('2026-09-11', '6:45 PM', '8:00 PM'), {
      start_at: '2026-09-11T22:45:00.000Z', end_at: '2026-09-12T00:00:00.000Z',
    })
  })
})

describe('slotKey / setSourceId', () => {
  it('slotKey: 12-hour to zero-padded 24-hour', () => {
    assert.equal(slotKey('7:00 PM'), '1900')
    assert.equal(slotKey('12:00 PM'), '1200')
    assert.equal(slotKey('12:00 AM'), '0000')
    assert.equal(slotKey('10:45 AM'), '1045')
    assert.equal(slotKey('garbage'), null)
  })

  it('setSourceId is Eastern-day-prefixed, not UTC-day-prefixed', () => {
    // The Thursday 9:30 PM ET set is 2026-09-11T01:30:00Z in UTC, so the
    // source_id must still carry the Eastern date '2026-09-10'.
    assert.equal(setSourceId('2026-09-10', 'blu-jazz', '9:30 PM'), '2026-09-10-blu-jazz-2130')
    assert.equal(setSourceId('2026-09-12', 'art-museum', '5:30 PM'), '2026-09-12-art-museum-1730')
  })

  it('is stable across calls (an act swap keeps the id)', () => {
    assert.equal(setSourceId('2026-09-10', 'blu-jazz', '7:00 PM'), setSourceId('2026-09-10', 'blu-jazz', '7:00 PM'))
  })
})

describe('end derivation', () => {
  it('next-set-same-venue-same-day chains', () => {
    // Thursday BLU Jazz: 7:00 -> 8:15 -> 9:30 PM ET, three chained sets.
    assert.equal(bySourceId.get('2026-09-10-blu-jazz-1900').row.end_at, '2026-09-11T00:15:00.000Z') // 8:15 PM ET
    assert.equal(bySourceId.get('2026-09-10-blu-jazz-2015').row.end_at, '2026-09-11T01:30:00.000Z') // 9:30 PM ET
    // Saturday Water Wheel: four chained sets, 10:45 -> 11:30 -> 12:30 -> 1:45 PM ET.
    assert.equal(bySourceId.get('2026-09-12-water-wheel-1045').row.end_at, '2026-09-12T15:30:00.000Z') // 11:30 AM ET
    assert.equal(bySourceId.get('2026-09-12-water-wheel-1130').row.end_at, '2026-09-12T16:30:00.000Z') // 12:30 PM ET
    assert.equal(bySourceId.get('2026-09-12-water-wheel-1230').row.end_at, '2026-09-12T17:45:00.000Z') // 1:45 PM ET
  })

  it('the explicit "end": "8:00 PM" override on the 6:45 PM library set', () => {
    const libSecond = bySourceId.get('2026-09-11-main-library-1845')
    assert.equal(libSecond.row.end_at, '2026-09-12T00:00:00.000Z') // 8:00 PM ET
  })

  it('the 5:30 PM library set derives its end from the NEXT set (6:45 PM), not a guess', () => {
    const libFirst = bySourceId.get('2026-09-11-main-library-1730')
    assert.equal(libFirst.row.end_at, '2026-09-11T22:45:00.000Z') // 6:45 PM ET
  })

  it('null for the five venue-day-final sets', () => {
    const finalIds = [
      '2026-09-10-blu-jazz-2130',   // Thu 9:30 PM blu-jazz
      '2026-09-11-blu-jazz-2130',   // Fri 9:30 PM blu-jazz
      '2026-09-12-water-wheel-1345', // Sat 1:45 PM water-wheel
      '2026-09-12-art-museum-1730', // Sat 5:30 PM art-museum
      '2026-09-12-blu-jazz-2100',   // Sat 9:00 PM blu-jazz
    ]
    assert.equal(finalIds.length, 5)
    for (const id of finalIds) {
      assert.equal(bySourceId.get(id).row.end_at, null, id)
    }
  })

  it('end_at > start_at for every non-null end_at', () => {
    for (const { row } of plan.planned) {
      if (row.end_at != null) assert.ok(Date.parse(row.end_at) > Date.parse(row.start_at), row.source_id)
    }
  })
})

describe('plan size', () => {
  it('planned.length === 17, existing.length === 1', () => {
    assert.equal(plan.planned.length, 17)
    assert.equal(plan.existing.length, 1)
  })

  it('every source_id unique; no planned source_id collides with an existing one', () => {
    const plannedIds = plan.planned.map(({ row }) => row.source_id)
    assert.equal(new Set(plannedIds).size, plannedIds.length)
    const existingIds = new Set(plan.existing.map((e) => e.existing.source_id))
    for (const id of plannedIds) assert.ok(!existingIds.has(id))
  })
})

describe('tags', () => {
  it('every planned row carries the festival tag plus exactly one stage-* tag', () => {
    for (const { row } of plan.planned) {
      assert.ok(row.tags.includes('rubber-city-jazz-2026'), row.source_id)
      const stageTags = row.tags.filter((t) => /^stage-/.test(t))
      assert.equal(stageTags.length, 1, row.source_id)
    }
  })

  it("'free' appears on the two library rows and nowhere else", () => {
    const freeRows = plan.planned.filter(({ row }) => row.tags.includes('free'))
    assert.equal(freeRows.length, 2)
    for (const { row } of freeRows) assert.ok(row.source_id.includes('main-library'), row.source_id)
  })

  it("'cascade-valley' only on the water-wheel rows", () => {
    const cascadeRows = plan.planned.filter(({ row }) => row.tags.includes('cascade-valley'))
    assert.ok(cascadeRows.length > 0)
    for (const { row } of cascadeRows) assert.ok(row.source_id.includes('water-wheel'), row.source_id)
  })
})

describe('prices', () => {
  it('exactly two rows have price_min === 0', () => {
    const free = plan.planned.filter(({ row }) => row.price_min === 0)
    assert.equal(free.length, 2)
  })

  it('every other row has price_min === null && price_max === null (never assume free)', () => {
    const notFree = plan.planned.filter(({ row }) => row.price_min !== 0)
    assert.equal(notFree.length, 15)
    for (const { row } of notFree) {
      assert.equal(row.price_min, null, row.source_id)
      assert.equal(row.price_max, null, row.source_id)
    }
  })
})

describe('constant fields', () => {
  it('featured === false on every row', () => {
    for (const { row } of plan.planned) assert.equal(row.featured, false, row.source_id)
  })

  it('image_url === null on every row (digest image gate parity)', () => {
    for (const { row } of plan.planned) assert.equal(row.image_url, null, row.source_id)
  })

  it("age_restriction === 'not_specified' on every row", () => {
    for (const { row } of plan.planned) assert.equal(row.age_restriction, 'not_specified', row.source_id)
  })

  it("categories === ['music', 'festival'] in that order on every row", () => {
    for (const { row } of plan.planned) assert.deepEqual(row.categories, ['music', 'festival'], row.source_id)
  })

  it("source === 'rubber_city_jazz' on every row (the sub-source no scraper writes)", () => {
    for (const { row } of plan.planned) assert.equal(row.source, 'rubber_city_jazz', row.source_id)
  })

  it("status === 'published' on every row", () => {
    for (const { row } of plan.planned) assert.equal(row.status, 'published', row.source_id)
  })

  it('ticket_url falls back to the festival website when the set names none', () => {
    for (const { row } of plan.planned) {
      assert.equal(row.ticket_url, 'https://www.rubbercityjazz.org/', row.source_id)
    }
  })
})

describe('sanitizer round-trip', () => {
  it('every planned title and description survives sanitizeEventText unchanged', () => {
    for (const { row } of plan.planned) {
      const clean = sanitizeEventText(row)
      assert.equal(clean.title, row.title, row.source_id)
      assert.equal(clean.description, row.description, row.source_id)
    }
  })

  it("specifically the '&' rows (Rachel Osherow & The Hangout / Helen Welch & Friends)", () => {
    const amp = plan.planned.filter(({ row }) => row.title.includes('&'))
    assert.ok(amp.length >= 2)
    for (const { row } of amp) assert.equal(sanitizeEventText(row).title, row.title)
  })

  it("specifically the apostrophe rows (Dave Morgan's / Aaron Smith's)", () => {
    const apo = plan.planned.filter(({ row }) => row.title.includes("'"));
    assert.ok(apo.length >= 1)
    for (const { row } of apo) assert.equal(sanitizeEventText(row).title, row.title)
  })
})

describe('descriptions are deterministic, not locale-dependent', () => {
  // These strings are PERSISTED. festivalDateRangeLabel (the hub header) is
  // deliberately ambient-locale and must never be the thing that builds
  // them: under LC_ALL=de-DE it renders "Donnerstag, 10. September".
  it('one full description, pinned byte for byte', () => {
    assert.equal(
      bySourceId.get('2026-09-10-blu-jazz-1900').row.description,
      'UA Jazz Group lead by Sam Ross at BLU Jazz+ for Rubber City Jazz & Blues Festival. ' +
      'Part of the Rubber City Jazz & Blues Festival, Thursday, September 10 to Saturday, ' +
      'September 12, 2026 in Akron, presented by Open Tone Music. ' +
      'Full schedule: https://www.rubbercityjazz.org/',
    )
  })

  it('the free library set adds its own sentence, and nothing else moves', () => {
    assert.equal(
      bySourceId.get('2026-09-11-main-library-1730').row.description,
      'Sam Blakeslee Large Group at Akron Summit Library (Main Branch) for Rubber City Jazz & Blues Festival. ' +
      'Part of the Rubber City Jazz & Blues Festival, Thursday, September 10 to Saturday, ' +
      'September 12, 2026 in Akron, presented by Open Tone Music. Free and open to all. ' +
      'Full schedule: https://www.rubbercityjazz.org/',
    )
  })

  it('easternRangeLabel is en-US and America/New_York pinned', () => {
    assert.equal(
      easternRangeLabel('2026-09-10', '2026-09-12'),
      'Thursday, September 10 to Saturday, September 12, 2026',
    )
    // Single day collapses to the one-date shape.
    assert.equal(easternRangeLabel('2026-08-15', '2026-08-15'), 'Saturday, August 15, 2026')
    assert.equal(easternRangeLabel('2026-08-15'), 'Saturday, August 15, 2026')
  })

  it('every description carries the range label, so a locale regression is loud everywhere', () => {
    for (const { row } of plan.planned) {
      assert.ok(
        row.description.includes('Thursday, September 10 to Saturday, September 12, 2026'),
        row.source_id,
      )
    }
  })
})

describe('festival-specific copy comes from the data file, not the importer', () => {
  it("the genre tag is festival.extraTags, and 'jazz' is not hardcoded in the module", () => {
    assert.deepEqual(data.festival.extraTags, ['jazz'])
    const src = readFileSync(new URL('../import-festival.js', import.meta.url), 'utf8')
    for (const literal of ["'jazz'", 'in Akron', 'Open Tone Music']) {
      assert.ok(!src.includes(literal), `import-festival.js must not hardcode ${literal}`)
    }
  })

  it('a festival with no presenter or city drops those clauses entirely', () => {
    const bare = JSON.parse(JSON.stringify(data))
    delete bare.festival.city
    delete bare.festival.presentedBy
    bare.festival.extraTags = []
    const row = buildPlan(bare).planned.find((p) => p.row.source_id === '2026-09-10-blu-jazz-1900').row
    assert.ok(row.description.includes('Part of the Rubber City Jazz & Blues Festival, ' +
      'Thursday, September 10 to Saturday, September 12, 2026.'))
    assert.ok(!row.description.includes('in Akron'))
    assert.ok(!row.description.includes('presented by'))
    assert.deepEqual(row.tags, ['rubber-city-jazz-2026', 'stage-blu-jazz', 'downtown-akron'])
  })
})

describe('no em dash anywhere in generated strings', () => {
  it('no planned title or description contains U+2014', () => {
    for (const { row } of plan.planned) {
      assert.ok(!row.title.includes(EM_DASH), row.source_id)
      assert.ok(!row.description.includes(EM_DASH), row.source_id)
    }
  })
})

describe('computeUmbrellaEnrichment', () => {
  const festival = data.festival
  const nowIso = '2026-08-27T12:00:00.000Z'

  it('fresh {at, by} on exactly the changed keys; foreign pins preserved', () => {
    const existing = {
      description: 'Scraper prose about the festival.',
      tags: ['festival'],
      image_url: null,
      manual_overrides: { name: { at: '2026-01-01T00:00:00Z', by: 'someone-else' } },
    }
    const result = computeUmbrellaEnrichment(existing, festival, nowIso)
    assert.ok(result)
    assert.ok('description' in result.updates)
    assert.ok('tags' in result.updates)
    assert.ok('image_url' in result.updates)
    assert.deepEqual(result.overrides.description, { at: nowIso, by: STAMP_BY })
    assert.deepEqual(result.overrides.tags, { at: nowIso, by: STAMP_BY })
    assert.deepEqual(result.overrides.image_url, { at: nowIso, by: STAMP_BY })
    // Foreign pin survives untouched.
    assert.deepEqual(result.overrides.name, { at: '2026-01-01T00:00:00Z', by: 'someone-else' })
  })

  it('returns null when nothing would change', () => {
    const already = {
      description: `Scraper prose.\n\n${festival.logisticsMarker}\n${festival.logistics}`,
      tags: [festival.tag, 'festival-umbrella', 'festival'],
      image_url: festival.umbrellaImageUrl,
      manual_overrides: {},
    }
    assert.equal(computeUmbrellaEnrichment(already, festival, nowIso), null)
  })

  it('the logistics marker makes a second run idempotent (no stacked blocks)', () => {
    const existing = { description: 'Scraper prose.', tags: [], image_url: null, manual_overrides: {} }
    const first = computeUmbrellaEnrichment(existing, festival, nowIso)
    const afterFirst = { ...existing, description: first.updates.description, tags: first.updates.tags, image_url: first.updates.image_url, manual_overrides: first.overrides }
    const second = computeUmbrellaEnrichment(afterFirst, festival, nowIso)
    assert.equal(second, null)
    // Only ONE copy of the marker in the description, even if the scraper
    // re-ran and reset scraper prose ahead of it.
    const occurrences = afterFirst.description.split(festival.logisticsMarker).length - 1
    assert.equal(occurrences, 1)
  })
})

describe('importStampFor: the pin stamp is PER FESTIVAL', () => {
  it("is '<slug>-import', matching import-porchrokr.js's precedent", () => {
    assert.equal(STAMP_BY, 'rubber-city-jazz-2026-import')
    assert.equal(importStampFor({ slug: 'porchrokr-2026' }), 'porchrokr-2026-import')
  })

  it('a row category-locked by a DIFFERENT festival is re-stamped, not skipped', () => {
    // The whole point of a per-festival stamp: a shared 'import-festival'
    // stamp would short-circuit here and leave the row pinned under the
    // other festival's name.
    const lockedByAnother = { categories: { at: '2026-01-01T00:00:00Z', by: 'porchrokr-2026-import' } }
    const result = computeCategoryLockOverrides(lockedByAnother, STAMP_BY, '2026-08-27T12:00:00.000Z')
    assert.ok(result, 'must not short-circuit on another festival\'s stamp')
    assert.equal(result.categories.by, STAMP_BY)
  })

  it('the umbrella enrichment stamps with the same per-festival value', () => {
    const existing = { description: 'prose', tags: [], image_url: null, manual_overrides: {} }
    const result = computeUmbrellaEnrichment(existing, data.festival, '2026-08-27T12:00:00.000Z')
    for (const key of Object.keys(result.updates)) {
      assert.equal(result.overrides[key].by, STAMP_BY, key)
    }
  })
})

describe('computeCategoryLockOverrides', () => {
  it('returns null when already stamped by us', () => {
    const existing = { categories: { at: '2026-01-01T00:00:00Z', by: STAMP_BY } }
    assert.equal(computeCategoryLockOverrides(existing, STAMP_BY), null)
  })

  it('merges foreign keys otherwise', () => {
    const existing = { name: { at: '2026-01-01T00:00:00Z', by: 'byron' } }
    const result = computeCategoryLockOverrides(existing, STAMP_BY, '2026-08-27T12:00:00.000Z')
    assert.deepEqual(result.name, { at: '2026-01-01T00:00:00Z', by: 'byron' })
    assert.deepEqual(result.categories, { at: '2026-08-27T12:00:00.000Z', by: STAMP_BY })
    assert.deepEqual(result.category_slugs, { at: '2026-08-27T12:00:00.000Z', by: STAMP_BY })
  })
})

describe('computeChildTagPin (the Lock 3 tag-only exception)', () => {
  it('unions tags without duplicating, preserves foreign pins, stamps a fresh at', () => {
    const existingRow = {
      tags: ['ticketmaster', 'blossom-music', 'jazz'],
      manual_overrides: { title: { at: '2026-01-01T00:00:00Z', by: 'ticketmaster' } },
    }
    const nowIso = '2026-08-27T12:00:00.000Z'
    const result = computeChildTagPin(existingRow, ['rubber-city-jazz-2026', 'stage-lock-3'], STAMP_BY, nowIso)
    assert.deepEqual(result.tags, ['ticketmaster', 'blossom-music', 'jazz', 'rubber-city-jazz-2026', 'stage-lock-3'])
    assert.deepEqual(result.manual_overrides.title, { at: '2026-01-01T00:00:00Z', by: 'ticketmaster' })
    assert.deepEqual(result.manual_overrides.tags, { at: nowIso, by: STAMP_BY })
  })

  it('returns null when every tag is already present (idempotent no-op)', () => {
    const existingRow = { tags: ['rubber-city-jazz-2026', 'stage-lock-3', 'jazz'], manual_overrides: {} }
    assert.equal(computeChildTagPin(existingRow, ['rubber-city-jazz-2026', 'stage-lock-3'], STAMP_BY), null)
  })
})

describe('validateDataFile: rejects one case each', () => {
  function withSets(mutator) {
    const clone = JSON.parse(JSON.stringify(data))
    mutator(clone)
    return clone
  }

  it('unknown venue key', () => {
    const bad = withSets((d) => { d.days[0].sets[0].venue = 'nonexistent-venue' })
    assert.ok(validateDataFile(bad).some((p) => p.includes('unknown venue key')))
  })

  it('duplicate (venue, date, start) triple', () => {
    const bad = withSets((d) => { d.days[0].sets.push({ ...d.days[0].sets[0] }) })
    assert.ok(validateDataFile(bad).some((p) => p.includes('duplicate (venue, date, start)')))
  })

  it('a day outside [startDate, endDate]', () => {
    const bad = withSets((d) => { d.days[0].date = '2026-09-01' })
    assert.ok(validateDataFile(bad).some((p) => p.includes('outside the festival range')))
  })

  it('a malformed start', () => {
    const bad = withSets((d) => { d.days[0].sets[0].start = 'not a time' })
    assert.ok(validateDataFile(bad).some((p) => p.includes('unparseable start')))
  })

  it('a non-uuid venueId', () => {
    const bad = withSets((d) => { d.venues[0].venueId = 'not-a-uuid' })
    assert.ok(validateDataFile(bad).some((p) => p.includes('venueId is not a uuid')))
  })

  it('a missing expectName', () => {
    const bad = withSets((d) => { delete d.venues[0].expectName })
    assert.ok(validateDataFile(bad).some((p) => p.includes('missing expectName')))
  })

  it("a '&' in website", () => {
    const bad = withSets((d) => { d.festival.website = 'https://example.com/a&b' })
    assert.ok(validateDataFile(bad).some((p) => p.includes('festival.website')))
  })

  it("an 'existing' set that also carries 'price'", () => {
    const bad = withSets((d) => {
      const lock3 = d.days.flatMap((day) => day.sets).find((s) => s.existing)
      lock3.price = { min: 0, max: null }
    })
    assert.ok(validateDataFile(bad).some((p) => p.includes("both 'existing' and 'price'")))
  })
})

describe('validateDataFile: the festival block itself (a typo here used to write null tags)', () => {
  function without(key) {
    const clone = JSON.parse(JSON.stringify(data))
    const path = key.split('.')
    let node = clone.festival
    while (path.length > 1) node = node[path.shift()]
    delete node[path[0]]
    return clone
  }

  it('a missing festival.tag is rejected', () => {
    assert.ok(validateDataFile(without('tag')).some((p) => p.includes('festival.tag missing')))
  })

  it('a festival.tag that disagrees with the registry entry is rejected', () => {
    const bad = JSON.parse(JSON.stringify(data))
    bad.festival.tag = 'rubber-city-jazz-2027'
    assert.ok(validateDataFile(bad).some((p) => p.includes('does not equal the registry tag')))
  })

  it('a missing festival.source is rejected', () => {
    assert.ok(validateDataFile(without('source')).some((p) => p.includes('festival.source missing')))
  })

  it('a missing festival.umbrella is rejected', () => {
    assert.ok(validateDataFile(without('umbrella')).some((p) => p.includes('festival.umbrella missing')))
  })

  it('a festival.umbrella missing source_id is rejected', () => {
    assert.ok(validateDataFile(without('umbrella.source_id'))
      .some((p) => p.includes('festival.umbrella.source_id missing')))
  })

  it('a missing festival.slug is rejected', () => {
    assert.ok(validateDataFile(without('slug')).some((p) => p.includes('festival.slug missing')))
  })

  it('a festival.slug matching no FESTIVALS registry entry is rejected', () => {
    const bad = JSON.parse(JSON.stringify(data))
    bad.festival.slug = 'not-a-real-festival-2099'
    assert.ok(validateDataFile(bad).some((p) => p.includes('matches no entry in the FESTIVALS registry')))
  })

  it('a missing festival.name is rejected', () => {
    assert.ok(validateDataFile(without('name')).some((p) => p.includes('festival.name missing')))
  })

  it('malformed extraTags / city / presentedBy are rejected', () => {
    const badTags = JSON.parse(JSON.stringify(data)); badTags.festival.extraTags = 'jazz'
    assert.ok(validateDataFile(badTags).some((p) => p.includes('festival.extraTags')))
    const badCity = JSON.parse(JSON.stringify(data)); badCity.festival.city = ''
    assert.ok(validateDataFile(badCity).some((p) => p.includes('festival.city')))
    const badBy = JSON.parse(JSON.stringify(data)); badBy.festival.presentedBy = 42
    assert.ok(validateDataFile(badBy).some((p) => p.includes('festival.presentedBy')))
  })

  it('the whole block missing does not produce a plan with null tags', () => {
    const bad = JSON.parse(JSON.stringify(data))
    for (const k of ['slug', 'tag', 'source', 'umbrella']) delete bad.festival[k]
    const p = buildPlan(bad)
    assert.ok(p.problems.length >= 4, 'every missing key must be reported')
    // The point of the gate: main() refuses to write on any problem, so the
    // null-tag row can never reach upsertEventSafe.
    assert.ok(p.problems.some((x) => x.includes('festival.tag missing')))
  })
})

describe('midnight-crossing guard on derived ends', () => {
  it('a past-midnight set filed on the PREVIOUS day is a validation problem, not a 22.5-hour event', () => {
    const bad = JSON.parse(JSON.stringify(data))
    // 12:30 AM belongs on 2026-09-11; putting it on the Thursday entry sorts
    // it to the front of the blu-jazz bucket ('0030' < '1900').
    bad.days[0].sets.push({ venue: 'blu-jazz', start: '12:30 AM', title: 'After Hours' })
    const p = buildPlan(bad)
    assert.ok(
      p.problems.some((x) => x.includes('exceeds the 6h') || x.includes('not after start')),
      `expected a span problem, got ${JSON.stringify(p.problems)}`,
    )
  })

  it('the real data file has no derived span over the cap', () => {
    for (const { row } of plan.planned) {
      if (row.end_at == null) continue
      const hours = (Date.parse(row.end_at) - Date.parse(row.start_at)) / 3_600_000
      assert.ok(hours > 0 && hours <= 6, `${row.source_id}: ${hours}h`)
    }
  })
})

describe('sanitizer round-trip is a PROBLEM, not a warning', () => {
  it('a title the sanitizer would rewrite refuses the write', () => {
    const bad = JSON.parse(JSON.stringify(data))
    bad.days[0].sets[0].title = 'Trailing space   <b>and markup</b> '
    const p = buildPlan(bad)
    assert.ok(p.problems.some((x) => x.includes('sanitizer would rewrite the title')),
      `expected a sanitizer problem, got ${JSON.stringify(p.problems)}`)
  })
})

describe('allFileSourceIds', () => {
  it('includes every planned source_id (existing rows belong to another source and are excluded from the safe set)', () => {
    const ids = allFileSourceIds(plan)
    for (const { row } of plan.planned) assert.ok(ids.has(row.source_id))
    for (const ex of plan.existing) assert.ok(!ids.has(ex.existing.source_id))
  })
})
