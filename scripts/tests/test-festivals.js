/**
 * test-festivals.js — pure-logic tests for the festival discovery helpers
 * in src/lib/festivals.ts: search-query candidate derivation, the
 * resolveFestivalSlug shortcut (incl. hub-collision and length guards and
 * the upcoming-vs-past tie-break), and the homepage banner window math
 * (upcomingFestival + festivalDayLabel).
 *
 * Every function takes the registry as a parameter (FESTIVALS by default)
 * and "today" as an injected Eastern date key, so all cases here are
 * deterministic — no clock, no DOM, no network.
 *
 * Run:  node --test scripts/tests/test-festivals.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  FESTIVALS,
  normalizeQueryLabel,
  festivalSearchCandidates,
  resolveFestivalSlug,
  upcomingFestival,
  festivalDayLabel,
  festivalEndDateKey,
  isFestivalDateKey,
  festivalDateKeys,
  festivalDayCount,
  festivalDateRangeLabel,
  festivalBannerPhrase,
  festivalScheduleMode,
} from '../../src/lib/festivals.ts'

/** Minimal valid Festival fixture; override what the case needs. */
function fixture(overrides) {
  return {
    slug: 'porchrokr-2026',
    name: 'PorchRokr Music & Arts Festival',
    dateKey: '2026-08-15',
    tag: 'porchrokr-2026',
    mapBounds: [-81.56, 41.08, -81.51, 41.11],
    landmarks: [],
    ...overrides,
  }
}

/** Minimal 3-day fixture mirroring the Rubber City Jazz 2026 registry entry. */
function multiDayFixture(overrides) {
  return fixture({
    slug: 'rubber-city-jazz-2026',
    name: 'Rubber City Jazz & Blues Festival',
    dateKey: '2026-09-10',
    endDateKey: '2026-09-12',
    tag: 'rubber-city-jazz-2026',
    mapBounds: [-81.528, 41.075, -81.511, 41.1],
    ...overrides,
  })
}

describe('normalizeQueryLabel', () => {
  it('strips whitespace, hyphens, and underscores and lowercases', () => {
    assert.equal(normalizeQueryLabel('Porch-Rokr  Music_&_Arts'), 'porchrokrmusic&arts')
    assert.equal(normalizeQueryLabel('  Highland   Square '), 'highlandsquare')
    assert.equal(normalizeQueryLabel(''), '')
  })
})

describe('festivalSearchCandidates: derivation from registry data alone', () => {
  const candidates = festivalSearchCandidates(fixture())

  it('includes the normalized slug', () => {
    assert.ok(candidates.includes('porchrokr2026'))
  })

  it('includes the slug with a trailing -yyyy year stripped', () => {
    assert.ok(candidates.includes('porchrokr'))
  })

  it('includes the normalized full name', () => {
    assert.ok(candidates.includes('porchrokrmusic&artsfestival'))
  })

  it('includes progressive prefixes down to the first non-generic token', () => {
    // "…Music & Arts Festival" sheds Festival, Arts, &, Music in turn.
    assert.ok(candidates.includes('porchrokrmusic&arts'))
    assert.ok(candidates.includes('porchrokrmusic'))
    assert.ok(candidates.includes('porchrokr'))
  })

  it('never derives a candidate shorter than 4 normalized chars', () => {
    assert.ok(!candidates.includes('porch')) // not a prefix candidate at all
    for (const c of candidates) assert.ok(c.length >= 4, `too-short candidate: ${c}`)
    const short = festivalSearchCandidates(
      fixture({ slug: 'po-fest-2026', name: 'Po Festival', tag: 'po-fest-2026' }),
    )
    assert.ok(!short.includes('po'), '2-char prefix must be dropped')
    assert.ok(short.includes('pofest'))
  })

  it('drops candidates that collide with neighborhood/city/region hubs', () => {
    const colliding = festivalSearchCandidates(
      fixture({
        slug: 'highland-square-street-festival-2026',
        name: 'Highland Square Street Festival',
        tag: 'highland-square-street-festival-2026',
      }),
    )
    // "Highland Square" is a neighborhood hub; the prefix derivation would
    // reach it ("… Street Festival" → "… Street" → "Highland Square") but
    // the guard must drop it so the hub jump keeps winning.
    assert.ok(!colliding.includes('highlandsquare'))
    // The longer, non-colliding prefixes survive.
    assert.ok(colliding.includes('highlandsquarestreet'))
    assert.ok(colliding.includes('highlandsquarestreetfestival'))
  })
})

describe('resolveFestivalSlug: memo acceptance cases against the real registry', () => {
  const TODAY = '2026-08-09'

  for (const q of [
    'PorchRokr',
    'porchrokr',
    'porch-rokr',
    'PorchRokr Music & Arts Festival',
    'porchrokr-2026',
  ]) {
    it(`"${q}" → porchrokr-2026`, () => {
      assert.equal(resolveFestivalSlug(q, TODAY), 'porchrokr-2026')
    })
  }

  it('"porch" → null (partial words never match)', () => {
    assert.equal(resolveFestivalSlug('porch', TODAY), null)
  })

  it('empty and whitespace-only queries → null', () => {
    assert.equal(resolveFestivalSlug('', TODAY), null)
    assert.equal(resolveFestivalSlug('   ', TODAY), null)
  })

  it('a hub label never resolves as a festival (collision guard end-to-end)', () => {
    const registry = [
      fixture({
        slug: 'highland-square-street-festival-2026',
        name: 'Highland Square Street Festival',
        tag: 'highland-square-street-festival-2026',
      }),
    ]
    assert.equal(resolveFestivalSlug('Highland Square', TODAY, registry), null)
    assert.equal(
      resolveFestivalSlug('highland square street festival', TODAY, registry),
      'highland-square-street-festival-2026',
    )
  })

  it('defaults today and registry when omitted (no relevance window)', () => {
    // Only one entry ever derives "porchrokr", so this holds on any date.
    assert.equal(resolveFestivalSlug('porchrokr'), 'porchrokr-2026')
  })
})

describe('resolveFestivalSlug: tie-break when two entries share a candidate', () => {
  const registry = [
    fixture({ slug: 'porchrokr-2025', tag: 'porchrokr-2025', dateKey: '2025-08-16' }),
    fixture({ slug: 'porchrokr-2026', tag: 'porchrokr-2026', dateKey: '2026-08-15' }),
  ]

  it('prefers the nearest upcoming dateKey over a past one', () => {
    assert.equal(resolveFestivalSlug('porchrokr', '2026-08-01', registry), 'porchrokr-2026')
  })

  it('prefers the nearest of two upcoming dateKeys', () => {
    assert.equal(resolveFestivalSlug('porchrokr', '2025-08-01', registry), 'porchrokr-2025')
  })

  it('falls back to the most recent past dateKey when all are past', () => {
    assert.equal(resolveFestivalSlug('porchrokr', '2026-09-01', registry), 'porchrokr-2026')
  })

  it('a festival happening today counts as upcoming (dateKey >= today)', () => {
    assert.equal(resolveFestivalSlug('porchrokr', '2025-08-16', registry), 'porchrokr-2025')
  })
})

describe('upcomingFestival: banner window math [0, 7] days out', () => {
  const registry = [fixture()] // dateKey 2026-08-15

  it('in-window on every diff 0..7 inclusive', () => {
    for (const today of [
      '2026-08-15', // 0 — festival day itself
      '2026-08-14', // 1
      '2026-08-13', // 2
      '2026-08-12', // 3
      '2026-08-11', // 4
      '2026-08-10', // 5
      '2026-08-09', // 6
      '2026-08-08', // 7 — boundary, still in
    ]) {
      assert.equal(upcomingFestival(today, registry)?.slug, 'porchrokr-2026', `today=${today}`)
    }
  })

  it('out of window at diff 8 (too far out) and diff -1 (festival passed)', () => {
    assert.equal(upcomingFestival('2026-08-07', registry), null)
    assert.equal(upcomingFestival('2026-08-16', registry), null)
  })

  it('multiple in-window festivals: earliest dateKey wins', () => {
    const two = [
      fixture({ slug: 'later-fest-2026', tag: 'later-fest-2026', dateKey: '2026-08-15' }),
      fixture({ slug: 'sooner-fest-2026', tag: 'sooner-fest-2026', dateKey: '2026-08-12' }),
    ]
    assert.equal(upcomingFestival('2026-08-09', two)?.slug, 'sooner-fest-2026')
  })

  it('empty registry → null', () => {
    assert.equal(upcomingFestival('2026-08-09', []), null)
  })
})

describe('festivalDayLabel: today / tomorrow / weekday selection', () => {
  it('diff 0 → "today"', () => {
    assert.equal(festivalDayLabel('2026-08-15', '2026-08-15'), 'today')
  })

  it('diff 1 → "tomorrow"', () => {
    assert.equal(festivalDayLabel('2026-08-15', '2026-08-14'), 'tomorrow')
  })

  it('diff 2..7 → the weekday name of the festival date', () => {
    // 2026-08-15 is a Saturday, 2026-08-13 a Thursday.
    assert.equal(festivalDayLabel('2026-08-15', '2026-08-09'), 'Saturday')
    assert.equal(festivalDayLabel('2026-08-15', '2026-08-13'), 'Saturday')
    assert.equal(festivalDayLabel('2026-08-13', '2026-08-09'), 'Thursday')
  })
})

describe('festivalEndDateKey', () => {
  it('returns dateKey when endDateKey is absent', () => {
    assert.equal(festivalEndDateKey(fixture()), '2026-08-15')
  })

  it('returns endDateKey when present', () => {
    assert.equal(festivalEndDateKey(multiDayFixture()), '2026-09-12')
  })
})

describe('festivalDateKeys / festivalDayCount', () => {
  it('a 3-day fixture returns exactly the three Eastern day keys', () => {
    assert.deepEqual(festivalDateKeys(multiDayFixture()), ['2026-09-10', '2026-09-11', '2026-09-12'])
    assert.equal(festivalDayCount(multiDayFixture()), 3)
  })

  it('a single-day fixture returns one key', () => {
    assert.deepEqual(festivalDateKeys(fixture()), ['2026-08-15'])
    assert.equal(festivalDayCount(fixture()), 1)
  })
})

describe('isFestivalDateKey', () => {
  it('true for every day in a 3-day run, false just outside it', () => {
    const f = multiDayFixture()
    assert.ok(isFestivalDateKey(f, '2026-09-10'))
    assert.ok(isFestivalDateKey(f, '2026-09-11'))
    assert.ok(isFestivalDateKey(f, '2026-09-12'))
    assert.ok(!isFestivalDateKey(f, '2026-09-09'))
    assert.ok(!isFestivalDateKey(f, '2026-09-13'))
  })

  it('single-day: true only on dateKey itself', () => {
    const f = fixture()
    assert.ok(isFestivalDateKey(f, '2026-08-15'))
    assert.ok(!isFestivalDateKey(f, '2026-08-14'))
    assert.ok(!isFestivalDateKey(f, '2026-08-16'))
  })
})

describe('upcomingFestival: multi-day window', () => {
  const registry = [multiDayFixture()] // 2026-09-10 through 2026-09-12

  it('in window for every todayIso from 7 days before the start through the end day', () => {
    for (const today of [
      '2026-09-03', // start - 7
      '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09',
      '2026-09-10', // start itself
      '2026-09-11', // mid-run
      '2026-09-12', // end day
    ]) {
      assert.equal(upcomingFestival(today, registry)?.slug, 'rubber-city-jazz-2026', `today=${today}`)
    }
  })

  it('out of window one day before the 7-day mark, and the day after the run ends', () => {
    assert.equal(upcomingFestival('2026-09-02', registry), null)
    assert.equal(upcomingFestival('2026-09-13', registry), null)
  })

  it('single-day regression: the existing [0, 7] table still passes unchanged', () => {
    const single = [fixture()] // dateKey 2026-08-15
    for (const today of [
      '2026-08-15', '2026-08-14', '2026-08-13', '2026-08-12',
      '2026-08-11', '2026-08-10', '2026-08-09', '2026-08-08',
    ]) {
      assert.equal(upcomingFestival(today, single)?.slug, 'porchrokr-2026', `today=${today}`)
    }
    assert.equal(upcomingFestival('2026-08-07', single), null)
    assert.equal(upcomingFestival('2026-08-16', single), null)
  })
})

describe('resolveFestivalSlug: a multi-day festival mid-run still counts as upcoming', () => {
  it('day 2 of a 3-day run resolves, not falls back to a past tie-break', () => {
    const registry = [
      multiDayFixture({ slug: 'rubber-city-jazz-2025', tag: 'rubber-city-jazz-2025', dateKey: '2025-09-11', endDateKey: '2025-09-13' }),
      multiDayFixture(),
    ]
    assert.equal(resolveFestivalSlug('rubber city jazz', '2026-09-11', registry), 'rubber-city-jazz-2026')
  })
})

describe('festivalDateRangeLabel', () => {
  it('single day: unchanged shape', () => {
    assert.equal(festivalDateRangeLabel(fixture()), 'Saturday, August 15, 2026')
  })

  it('multi-day: "<start> to <end>"', () => {
    assert.equal(
      festivalDateRangeLabel(multiDayFixture()),
      'Thursday, September 10 to Saturday, September 12, 2026',
    )
  })

  it('never contains an em dash', () => {
    assert.ok(!festivalDateRangeLabel(fixture()).includes(String.fromCharCode(0x2014)))
    assert.ok(!festivalDateRangeLabel(multiDayFixture()).includes(String.fromCharCode(0x2014)))
  })
})

describe('festivalBannerPhrase', () => {
  it('single day: byte-identical to festivalDayLabel', () => {
    for (const today of ['2026-08-15', '2026-08-14', '2026-08-09']) {
      assert.equal(festivalBannerPhrase(fixture(), today), festivalDayLabel('2026-08-15', today))
    }
  })

  it('multi-day, before it starts: "<festivalDayLabel(start)> through <weekday(end)>"', () => {
    // 2026-09-10 is a Thursday, 2026-09-12 a Saturday.
    assert.equal(festivalBannerPhrase(multiDayFixture(), '2026-09-06'), 'Thursday through Saturday')
    assert.equal(festivalBannerPhrase(multiDayFixture(), '2026-09-09'), 'tomorrow through Saturday')
  })

  it('multi-day, on its first day: "today through <weekday(end)>"', () => {
    assert.equal(festivalBannerPhrase(multiDayFixture(), '2026-09-10'), 'today through Saturday')
  })

  it('multi-day, mid-run: "on now through <weekday(end)>"', () => {
    assert.equal(festivalBannerPhrase(multiDayFixture(), '2026-09-11'), 'on now through Saturday')
  })

  it('multi-day, on its last day: "on its final day"', () => {
    assert.equal(festivalBannerPhrase(multiDayFixture(), '2026-09-12'), 'on its final day')
  })

  it('multi-day, AFTER the run ended: the plain weekday form, never "on now"', () => {
    // Unreachable from HomePage (upcomingFestival excludes a finished run),
    // but the helper is exported and "on now" about a finished festival is
    // the worst thing it could say.
    for (const today of ['2026-09-13', '2026-09-20']) {
      const phrase = festivalBannerPhrase(multiDayFixture(), today)
      assert.ok(!phrase.includes('on now'), `today=${today}: ${phrase}`)
      assert.equal(phrase, festivalDayLabel('2026-09-10', today))
    }
  })

  it('never contains an em dash', () => {
    for (const today of ['2026-09-06', '2026-09-10', '2026-09-11', '2026-09-12']) {
      assert.ok(!festivalBannerPhrase(multiDayFixture(), today).includes(String.fromCharCode(0x2014)))
    }
  })
})

describe('festivalScheduleMode: the hub layout switch', () => {
  it("defaults to 'slot' when the field is absent", () => {
    assert.equal(festivalScheduleMode(fixture()), 'slot')
    assert.equal(festivalScheduleMode(multiDayFixture()), 'slot')
  })

  it("returns 'day' when the entry asks for it", () => {
    assert.equal(festivalScheduleMode(multiDayFixture({ schedule: 'day' })), 'day')
  })

  it("an explicit 'slot' and an omitted field are indistinguishable", () => {
    assert.equal(
      festivalScheduleMode(fixture({ schedule: 'slot' })),
      festivalScheduleMode(fixture()),
    )
  })
})

describe('registry hygiene for the derivation the features rely on', () => {
  it('every real registry entry derives at least one candidate', () => {
    for (const f of FESTIVALS) {
      assert.ok(festivalSearchCandidates(f).length > 0, `${f.slug} derives no candidates`)
    }
  })

  it('every entry with endDateKey satisfies endDateKey >= dateKey', () => {
    for (const f of FESTIVALS) {
      if (f.endDateKey) assert.ok(f.endDateKey >= f.dateKey, `${f.slug}: endDateKey < dateKey`)
    }
  })

  it("every entry's schedule field is absent, 'slot' or 'day', and nothing else", () => {
    // A typo ('days', 'Day', 'timeslot') would silently fall through
    // festivalScheduleMode's ?? and render the WRONG layout rather than
    // failing, so the registry is where it has to be caught.
    for (const f of FESTIVALS) {
      assert.ok(
        f.schedule === undefined || f.schedule === 'slot' || f.schedule === 'day',
        `${f.slug}: schedule must be undefined, 'slot' or 'day' (got ${JSON.stringify(f.schedule)})`,
      )
      assert.ok(['slot', 'day'].includes(festivalScheduleMode(f)), f.slug)
    }
  })

  it('the single-day entries stay on the default slot layout', () => {
    for (const f of FESTIVALS) {
      if (!f.endDateKey) {
        assert.equal(festivalScheduleMode(f), 'slot',
          `${f.slug}: a single-day festival has no day breaks to group by`)
      }
    }
  })

  it('rubber-city-jazz-2026 is the day-mode entry', () => {
    const rcj = FESTIVALS.find((f) => f.slug === 'rubber-city-jazz-2026')
    assert.equal(festivalScheduleMode(rcj), 'day')
  })
})
