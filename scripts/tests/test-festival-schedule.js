/**
 * test-festival-schedule.js — pure-logic tests for src/lib/festivalSchedule.ts
 * (the festival hub's DOM-free schedule derivation): column-tag parsing,
 * slot grouping/ordering (porches numeric then stages), umbrella detection,
 * and the happening-now / up-next logic at Eastern edge instants.
 *
 * Follows scripts/tests/test-plan-map.js's precedent of importing the .ts
 * module directly into `node --test`. The main fixture is the REAL importer
 * plan built from the REAL data file, so the ingest-side tag convention and
 * the hub-side parser can never drift apart silently.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  parseColumnTag,
  isUmbrella,
  firstVenue,
  buildFestivalSchedule,
  isHappeningNow,
  upNextSlot,
  happeningNowSlots,
  stripVenuePrefix,
  toFestivalMapPins,
  plannedVenueIds,
  dayItems,
} from '../../src/lib/festivalSchedule.ts'
import { DATA_PATH, buildPlan } from '../import-porchrokr.js'
import { dataPathFor, buildPlan as buildFestivalPlan } from '../import-festival.js'
import { easternToIso } from '../lib/normalize.js'

// ── Fixture: hub rows exactly as the importer would produce them ────────────

const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
const plan = buildPlan(data)

const umbrellaRow = {
  id: 'umbrella-1',
  title: 'PorchROKR Music & Arts Festival',
  start_at: '2026-08-15T15:00:00.000Z',
  end_at: '2026-08-16T01:00:00.000Z',
  tags: ['porchrokr', 'porchrokr-2026', 'festival-umbrella', 'festival', 'music'],
  status: 'published',
  image_url: 'https://example.org/poster.jpg',
  description: 'The festival umbrella.',
}

const rows = [
  umbrellaRow,
  ...plan.planned.map(({ row }, i) => ({
    id: `evt-${row.source_id}`,
    title: row.title,
    start_at: row.start_at,
    end_at: row.end_at,
    tags: row.tags,
    status: row.status,
    description: row.description,
    event_venues: i % 2 === 0
      ? [{ venues: { id: `v-${i}`, name: `Venue ${i}`, lat: 41.09, lng: -81.52 } }]
      : [],
  })),
]

const schedule = buildFestivalSchedule(rows)

// Eastern edge instants for Aug 15 2026 (EDT, UTC-4).
const T = (iso) => Date.parse(iso)
const AT_1059_ET = T('2026-08-15T14:59:00.000Z')
const AT_1100_ET = T('2026-08-15T15:00:00.000Z')
const AT_1130_ET = T('2026-08-15T15:30:00.000Z')

describe('parseColumnTag', () => {
  it('parses porch-N tags', () => {
    assert.deepEqual(
      parseColumnTag(['porchrokr-2026', 'porch-7', 'free']),
      { key: 'porch-7', kind: 'porch', porch: 7, label: 'Porch 7' },
    )
    assert.equal(parseColumnTag(['porch-40']).porch, 40)
  })

  it('parses stage-* tags with readable labels', () => {
    assert.deepEqual(
      parseColumnTag(['stage-main']),
      { key: 'stage-main', kind: 'stage', stage: 'main', label: 'Main Stage' },
    )
    assert.equal(parseColumnTag(['stage-beer-garden']).label, 'Beer Garden Stage')
  })

  it('ignores garbage — never fabricates a column', () => {
    assert.equal(parseColumnTag(['porch-x', 'stage-', 'porchrokr-2026', 'highland-square']), null)
    assert.equal(parseColumnTag([]), null)
    assert.equal(parseColumnTag(null), null)
    assert.equal(parseColumnTag(undefined), null)
  })
})

describe('umbrella handling', () => {
  it('isUmbrella keys on the festival-umbrella tag', () => {
    assert.ok(isUmbrella(umbrellaRow))
    assert.ok(!isUmbrella(rows[1]))
  })

  it('the umbrella is surfaced separately, never a grid column', () => {
    assert.equal(schedule.umbrella?.id, 'umbrella-1')
    assert.ok(!schedule.columns.some((c) => c.key.includes('umbrella')))
  })
})

describe('slot grouping & ordering (real importer plan as fixture)', () => {
  it('9 slot rows: 11:00–6:00 hourly plus the 7:30 headliner, ascending', () => {
    assert.deepEqual(schedule.slots.map((s) => s.startAt), [
      '2026-08-15T15:00:00.000Z', // 11:00 AM ET
      '2026-08-15T16:00:00.000Z',
      '2026-08-15T17:00:00.000Z',
      '2026-08-15T18:00:00.000Z',
      '2026-08-15T19:00:00.000Z',
      '2026-08-15T20:00:00.000Z',
      '2026-08-15T21:00:00.000Z',
      '2026-08-15T22:00:00.000Z',
      '2026-08-15T23:30:00.000Z', // 7:30 PM ET headliner
    ])
  })

  it('columns: porches numeric ascending, then stages in fixed order', () => {
    const keys = schedule.columns.map((c) => c.key)
    const porchKeys = keys.filter((k) => k.startsWith('porch-'))
    const stageKeys = keys.filter((k) => k.startsWith('stage-'))
    // Porches strictly ascending and all before any stage.
    const porchNums = porchKeys.map((k) => parseInt(k.slice(6), 10))
    assert.deepEqual(porchNums, [...porchNums].sort((a, b) => a - b))
    assert.deepEqual(keys, [...porchKeys, ...stageKeys])
    assert.deepEqual(stageKeys, ['stage-main', 'stage-beer-garden'])
    // 40 porches minus porch 1 (routes to main) and porch 26 (routes to
    // beer-garden) = 38 porch columns; nothing FLAGged out anymore.
    assert.equal(porchKeys.length, 38)
    assert.ok(!keys.includes('porch-1'))
    assert.ok(!keys.includes('porch-26'))
  })

  it('within a slot, items are column-ordered (porches numeric, stages after)', () => {
    const noon = schedule.slots.find((s) => s.startAt === '2026-08-15T16:00:00.000Z')
    const porches = noon.items.map((i) => i.column.porch ?? Infinity)
    const finitePorches = porches.filter(Number.isFinite)
    assert.deepEqual(finitePorches, [...finitePorches].sort((a, b) => a - b))
    // beer-garden (porch 26's routed acts) sorts after every porch.
    const kinds = noon.items.map((i) => i.column.kind)
    assert.equal(kinds.lastIndexOf('porch') < kinds.indexOf('stage') || kinds.indexOf('stage') === -1, true)
    assert.ok(noon.items.some((i) => i.column.key === 'stage-beer-garden'))
  })

  it('rows with unparseable start_at or no column tag are dropped, not NaN-sorted', () => {
    const garbage = buildFestivalSchedule([
      { id: 'a', title: 'A', start_at: 'not-a-date', end_at: null, tags: ['porch-3'], status: 'published' },
      { id: 'b', title: 'B', start_at: '2026-08-15T15:00:00.000Z', end_at: null, tags: ['random-tag'], status: 'published' },
    ])
    assert.deepEqual(garbage.slots, [])
    assert.deepEqual(garbage.columns, [])
  })

  it('firstVenue returns the first linked venue or null', () => {
    assert.equal(firstVenue(rows[1])?.lat, 41.09)
    assert.equal(firstVenue({ ...rows[1], event_venues: [] }), null)
    assert.equal(firstVenue({ ...rows[1], event_venues: undefined }), null)
  })
})

describe('schedule.days: single-day PorchRokr fixture', () => {
  it('exactly one day, dateKey 2026-08-15, matching schedule.slots exactly', () => {
    assert.equal(schedule.days.length, 1)
    assert.equal(schedule.days[0].dateKey, '2026-08-15')
    assert.deepEqual(schedule.days[0].slots, schedule.slots)
  })
})

describe('schedule.days: cross-midnight Eastern grouping (the load-bearing case)', () => {
  it('a 9:30 PM ET Thursday set (01:30 UTC Friday) groups under the EASTERN day, not the UTC day', () => {
    const rows = [
      { id: 'a', title: 'A', start_at: '2026-09-11T01:30:00.000Z', end_at: null, tags: ['stage-blu-jazz'], status: 'published' },
      { id: 'b', title: 'B', start_at: '2026-09-10T23:00:00.000Z', end_at: null, tags: ['stage-blu-jazz'], status: 'published' },
    ]
    const sched = buildFestivalSchedule(rows)
    assert.equal(sched.days.length, 1)
    assert.equal(sched.days[0].dateKey, '2026-09-10')
    assert.equal(sched.days[0].slots.length, 2)
  })
})

// ── Fixture: the real 3-day Rubber City Jazz plan, module scope so both the
// day-grouping cases and the day-mode dayItems cases below share one build.
const rcjData = JSON.parse(readFileSync(dataPathFor('rubber-city-jazz-2026'), 'utf8'))
const rcjPlan = buildFestivalPlan(rcjData)
const rcjRows = rcjPlan.planned.map(({ row }) => ({
  id: row.source_id,
  title: row.title,
  start_at: row.start_at,
  end_at: row.end_at,
  tags: row.tags,
  status: row.status,
  description: row.description,
}))
// The Lock 3 headliner is an "existing" set: owned by the ticketmaster
// scraper, tagged into the festival but never upserted, so buildPlan puts
// it in plan.existing rather than plan.planned. The HUB still renders it
// (it carries the festival tag and a stage-* column tag), so the fixture
// has to include it or the Saturday count would be one short of the real
// page. Its columns come from the plan; its instant is the poster's 7:00
// PM Eastern, via the same easternToIso the importer would use.
for (const ex of rcjPlan.existing) {
  rcjRows.push({
    id: `${ex.existing.source}-${ex.existing.source_id}`,
    title: ex.set.title,
    start_at: easternToIso(ex.date, ex.set.start),
    end_at: null,
    tags: ex.tagsToAdd,
    status: 'published',
  })
}
const rcjSchedule = buildFestivalSchedule(rcjRows)

describe('schedule.days: 3-day Rubber City Jazz fixture (real data file via import-festival.js buildPlan)', () => {
  it('days.length === 3, ascending day keys', () => {
    assert.deepEqual(rcjSchedule.days.map((d) => d.dateKey), ['2026-09-10', '2026-09-11', '2026-09-12'])
  })

  it('per-day slot counts 3 / 4 / 11 (one slot per set: no two sets share a start instant)', () => {
    assert.deepEqual(rcjSchedule.days.map((d) => d.slots.length), [3, 4, 11])
    // 18 children total: the 17 the importer plans plus the tag-only
    // ticketmaster row.
    assert.equal(rcjSchedule.slots.length, 18)
  })

  it('slot starts ascending within each day', () => {
    for (const day of rcjSchedule.days) {
      const starts = day.slots.map((s) => s.startMs)
      assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
    }
  })

  it('parseColumnTag resolves all five new stage tags', () => {
    assert.deepEqual(parseColumnTag(['stage-blu-jazz']), { key: 'stage-blu-jazz', kind: 'stage', stage: 'blu-jazz', label: 'Blu Jazz Stage' })
    assert.deepEqual(parseColumnTag(['stage-main-library']), { key: 'stage-main-library', kind: 'stage', stage: 'main-library', label: 'Main Library Stage' })
    assert.deepEqual(parseColumnTag(['stage-water-wheel']), { key: 'stage-water-wheel', kind: 'stage', stage: 'water-wheel', label: 'Water Wheel Stage' })
    assert.deepEqual(parseColumnTag(['stage-art-museum']), { key: 'stage-art-museum', kind: 'stage', stage: 'art-museum', label: 'Art Museum Stage' })
    assert.deepEqual(parseColumnTag(['stage-lock-3']), { key: 'stage-lock-3', kind: 'stage', stage: 'lock-3', label: 'Lock 3 Stage' })
  })

  it('toFestivalMapPins glyphs on the five stage keys: B, M, W, A, L, all distinct', () => {
    const venue = (id, name) => [{ venues: { id, name, lat: 41.08, lng: -81.52 } }]
    const pinRows = [
      { id: '1', title: 'x', start_at: '2026-09-10T23:00:00.000Z', end_at: null, tags: ['stage-blu-jazz'], status: 'published', event_venues: venue('v-blu', 'BLU Jazz+') },
      { id: '2', title: 'x', start_at: '2026-09-11T21:30:00.000Z', end_at: null, tags: ['stage-main-library'], status: 'published', event_venues: venue('v-lib', 'Akron Summit Library (Main Branch)') },
      { id: '3', title: 'x', start_at: '2026-09-12T14:45:00.000Z', end_at: null, tags: ['stage-water-wheel'], status: 'published', event_venues: venue('v-ww', 'Mustill Store Museum & Trailhead') },
      { id: '4', title: 'x', start_at: '2026-09-12T17:00:00.000Z', end_at: null, tags: ['stage-art-museum'], status: 'published', event_venues: venue('v-am', 'Akron Art Museum') },
      { id: '5', title: 'x', start_at: '2026-09-12T23:00:00.000Z', end_at: null, tags: ['stage-lock-3'], status: 'published', event_venues: venue('v-l3', 'Lock 3') },
    ]
    const pins = toFestivalMapPins(buildFestivalSchedule(pinRows))
    const glyphs = pins.map((p) => p.glyph).sort()
    assert.deepEqual(glyphs, ['A', 'B', 'L', 'M', 'W'])
    assert.equal(new Set(glyphs).size, 5)
  })
})

describe("dayItems: the flat per-day card list the 'day' schedule mode renders", () => {
  it('the PorchRokr single-day fixture flattens to every item, slot order preserved', () => {
    const items = dayItems(schedule.days[0])
    const fromSlots = schedule.slots.flatMap((s) => s.items)
    assert.deepEqual(items, fromSlots)
    assert.equal(items.length, fromSlots.length)
  })

  it('starts are non-decreasing across the flattened list', () => {
    const starts = dayItems(schedule.days[0]).map((i) => i.startMs)
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  })

  it('the 3-day Rubber City Jazz fixture: per-day item counts match the slot counts', () => {
    // Every RCJ slot holds exactly one card (no two sets share a start), so
    // the day-mode grid length equals the slot-mode heading count: 17
    // headings become one grid of 17 cards, which is the point of the mode.
    const perDay = rcjSchedule.days.map((d) => dayItems(d).length)
    assert.deepEqual(perDay, [3, 4, 11])
    assert.equal(perDay.reduce((a, b) => a + b, 0), 18)
  })

  it('each day\'s items are exactly that day\'s slots flattened, in order', () => {
    for (const day of rcjSchedule.days) {
      assert.deepEqual(dayItems(day), day.slots.flatMap((s) => s.items))
      const starts = dayItems(day).map((i) => i.startMs)
      assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
    }
  })

  it('an empty day yields an empty list rather than throwing', () => {
    assert.deepEqual(dayItems({ dateKey: '2026-09-10', slots: [] }), [])
  })
})

describe('happening-now / up-next at Eastern edge instants', () => {
  const slot1100 = schedule.slots[0]

  it('10:59 ET: nothing live, 11:00 slot is up next', () => {
    assert.deepEqual(happeningNowSlots(schedule, AT_1059_ET), [])
    assert.equal(upNextSlot(schedule, AT_1059_ET)?.startAt, '2026-08-15T15:00:00.000Z')
  })

  it('11:00 ET exactly: the 11:00 sets are live, 12:00 is up next', () => {
    for (const item of slot1100.items) assert.ok(isHappeningNow(item, AT_1100_ET))
    assert.deepEqual(happeningNowSlots(schedule, AT_1100_ET).map((s) => s.startAt), ['2026-08-15T15:00:00.000Z'])
    assert.equal(upNextSlot(schedule, AT_1100_ET)?.startAt, '2026-08-15T16:00:00.000Z')
  })

  it('11:30 ET exactly: 30-minute sets are over (end is exclusive), nothing live', () => {
    for (const item of slot1100.items) assert.ok(!isHappeningNow(item, AT_1130_ET))
    assert.deepEqual(happeningNowSlots(schedule, AT_1130_ET), [])
    assert.equal(upNextSlot(schedule, AT_1130_ET)?.startAt, '2026-08-15T16:00:00.000Z')
  })

  it('8:00 PM ET: the 90-minute headliner is live and nothing is up next', () => {
    const at2000 = T('2026-08-16T00:00:00.000Z')
    const headlinerSlot = schedule.slots[schedule.slots.length - 1]
    assert.ok(headlinerSlot.items.every((i) => isHappeningNow(i, at2000)))
    assert.equal(upNextSlot(schedule, at2000), null)
  })

  it('an item with no end_at is never "happening now" (honesty over guessed durations)', () => {
    const item = { event: rows[1], column: { key: 'porch-2', kind: 'porch', porch: 2, label: 'Porch 2' }, startMs: AT_1100_ET, endMs: null }
    assert.ok(!isHappeningNow(item, AT_1100_ET + 1))
  })
})

// ── Festival map pins (FestivalMap.tsx's pure derivation) ───────────────────

const venue = (id, name, lat, lng) => [{ venues: { id, name, lat, lng } }]
const pinRows = [
  // Two sets on the same porch venue, hours apart -> ONE pin, setCount 2,
  // first/lastStartAt spanning both.
  { id: 'p7-early', title: 'A', start_at: '2026-08-15T15:00:00.000Z', end_at: '2026-08-15T15:30:00.000Z', tags: ['porch-7'], status: 'published', event_venues: venue('v-7', 'PorchRokr 123 Main St', 41.09, -81.52) },
  { id: 'p7-late', title: 'B', start_at: '2026-08-15T23:00:00.000Z', end_at: '2026-08-15T23:30:00.000Z', tags: ['porch-7'], status: 'published', event_venues: venue('v-7', 'PorchRokr 123 Main St', 41.09, -81.52) },
  { id: 'main-1', title: 'C', start_at: '2026-08-15T23:30:00.000Z', end_at: '2026-08-16T01:00:00.000Z', tags: ['stage-main'], status: 'published', event_venues: venue('v-main', 'PorchRokr Main Stage', 41.1, -81.53) },
  // Null coords -> skipped silently (still a schedule row, never a pin).
  { id: 'p9-nocoord', title: 'D', start_at: '2026-08-15T16:00:00.000Z', end_at: '2026-08-15T16:30:00.000Z', tags: ['porch-9'], status: 'published', event_venues: venue('v-9', 'PorchRokr 9 Elm St', null, null) },
  // No venue link at all -> skipped silently too.
  { id: 'p11-novenue', title: 'E', start_at: '2026-08-15T16:00:00.000Z', end_at: '2026-08-15T16:30:00.000Z', tags: ['porch-11'], status: 'published', event_venues: [] },
]
const pinSchedule = buildFestivalSchedule(pinRows)

describe('toFestivalMapPins', () => {
  const pins = toFestivalMapPins(pinSchedule, { venueNamePrefix: 'PorchRokr ' })
  const byId = new Map(pins.map((p) => [p.venueId, p]))

  it('groups by venue id and skips null-coord / venueless rows silently', () => {
    assert.deepEqual([...byId.keys()].sort(), ['v-7', 'v-main'])
  })

  it('porch pin: numbered glyph, column label, setCount and start range', () => {
    const p7 = byId.get('v-7')
    assert.equal(p7.kind, 'porch')
    assert.equal(p7.glyph, '7')
    assert.equal(p7.label, 'Porch 7')
    assert.equal(p7.setCount, 2)
    assert.equal(p7.firstStartAt, '2026-08-15T15:00:00.000Z')
    assert.equal(p7.lastStartAt, '2026-08-15T23:00:00.000Z')
  })

  it('stage pin: initial-letter glyph, kind stage', () => {
    const main = byId.get('v-main')
    assert.equal(main.kind, 'stage')
    assert.equal(main.glyph, 'M')
    assert.equal(main.label, 'Main Stage')
    assert.equal(main.setCount, 1)
  })

  it('strips the registry venueNamePrefix; leaves names alone without it', () => {
    assert.equal(byId.get('v-7').venueName, '123 Main St')
    const raw = toFestivalMapPins(pinSchedule)
    assert.equal(raw.find((p) => p.venueId === 'v-7').venueName, 'PorchRokr 123 Main St')
  })

  it('real importer fixture: one pin per venued row, all glyphs non-empty', () => {
    const fixturePins = toFestivalMapPins(schedule, { venueNamePrefix: 'PorchRokr ' })
    const venuedRows = rows.filter((r) => (r.event_venues ?? []).length > 0 && !isUmbrella(r))
    assert.equal(fixturePins.reduce((n, p) => n + p.setCount, 0), venuedRows.length)
    assert.ok(fixturePins.every((p) => p.glyph.length >= 1))
  })
})

describe('stripVenuePrefix', () => {
  it('strips only a leading prefix; null-safe', () => {
    assert.equal(stripVenuePrefix('PorchRokr 12 Oak Ave', 'PorchRokr '), '12 Oak Ave')
    assert.equal(stripVenuePrefix('Jilly\'s Music Room', 'PorchRokr '), 'Jilly\'s Music Room')
    assert.equal(stripVenuePrefix('12 PorchRokr Ave', 'PorchRokr '), '12 PorchRokr Ave')
    assert.equal(stripVenuePrefix('Anywhere'), 'Anywhere')
    assert.equal(stripVenuePrefix(null, 'PorchRokr '), null)
    assert.equal(stripVenuePrefix(undefined), null)
  })
})

describe('plannedVenueIds (the map\'s amber planned ring)', () => {
  it('maps planned event ids to their venue ids, venueless events contribute nothing', () => {
    const ids = plannedVenueIds(pinSchedule, new Set(['p7-late', 'p9-nocoord', 'p11-novenue', 'not-in-schedule']))
    assert.deepEqual([...ids].sort(), ['v-7', 'v-9'])
  })

  it('empty plan -> empty set', () => {
    assert.deepEqual([...plannedVenueIds(pinSchedule, new Set())], [])
  })
})
