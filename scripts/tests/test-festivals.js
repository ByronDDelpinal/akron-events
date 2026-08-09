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

describe('registry hygiene for the derivation the features rely on', () => {
  it('every real registry entry derives at least one candidate', () => {
    for (const f of FESTIVALS) {
      assert.ok(festivalSearchCandidates(f).length > 0, `${f.slug} derives no candidates`)
    }
  })
})
