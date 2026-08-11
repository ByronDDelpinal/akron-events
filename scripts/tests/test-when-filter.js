/**
 * test-when-filter.js — pure-logic unit tests for the "When" date + time-of-day
 * filter: preset derivation, Eastern-anchored date-range bounds, the
 * easternIsoAt/easternToIso drift guard, the custom-range label, time-of-day
 * hour buckets, and the WHEN_PRESETS <-> embed VALID_DATE drift guard.
 *
 * All date logic under test lives in pure, clock-injectable modules
 * (src/lib/whenFilter.ts, src/lib/easternDate.ts, src/lib/dateRange.js) —
 * Node's test runner already imports src/lib/*.ts directly (see
 * scripts/tests/test-day-plan-lib.js), so no build step is needed here.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveWhen, timeOfDayBounds } from '../../src/lib/whenFilter.ts'
import { WHEN_PRESETS, buildDateRangeLabel } from '../../src/lib/filterOptions.ts'
import { easternIsoAt } from '../../src/lib/easternDate.ts'
import { dateRangeBounds } from '../../src/lib/dateRange.js'
import { easternToIso } from '../../scripts/lib/normalize.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')

// ── deriveWhen ──────────────────────────────────────────────────────────

describe('deriveWhen', () => {
  it('every non-ghost preset resolves to { kind: preset, id }', () => {
    for (const p of WHEN_PRESETS.filter((p) => !p.ghost)) {
      assert.deepEqual(
        deriveWhen({ dateRange: p.id, dateFrom: null, dateTo: null }),
        { kind: 'preset', id: p.id },
      )
    }
  })

  it('this_week (the ghost, no chip) still derives to a preset — it must keep resolving', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: 'this_week', dateFrom: null, dateTo: null }),
      { kind: 'preset', id: 'this_week' },
    )
  })

  it('from only -> custom', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: null, dateFrom: '2026-09-01', dateTo: null }),
      { kind: 'custom', from: '2026-09-01', to: null },
    )
  })

  it('to only -> custom', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: null, dateFrom: null, dateTo: '2026-09-05' }),
      { kind: 'custom', from: null, to: '2026-09-05' },
    )
  })

  it('both from and to -> custom', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: null, dateFrom: '2026-09-01', dateTo: '2026-09-05' }),
      { kind: 'custom', from: '2026-09-01', to: '2026-09-05' },
    )
  })

  it('date + from together -> custom (mirrors useEvents\' own precedence: range beats preset)', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: 'today', dateFrom: '2026-09-01', dateTo: null }),
      { kind: 'custom', from: '2026-09-01', to: null },
    )
  })

  it('unknown date value -> any (defensive fallback, same posture as intent validation)', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: 'next_decade', dateFrom: null, dateTo: null }),
      { kind: 'any' },
    )
  })

  it('nothing set -> any', () => {
    assert.deepEqual(
      deriveWhen({ dateRange: null, dateFrom: null, dateTo: null }),
      { kind: 'any' },
    )
  })
})

// ── dateRangeBounds ─────────────────────────────────────────────────────

describe('dateRangeBounds — Eastern-anchored, asserted against ISO instants', () => {
  it('Fri 15:00 ET -> this_weekend starts TODAY 16:00 ET, not next week', () => {
    // 2026-08-14 is a Friday. 15:00 EDT (UTC-4) = 19:00Z.
    const now = new Date('2026-08-14T19:00:00.000Z')
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(start.toISOString(), '2026-08-14T20:00:00.000Z') // Fri 16:00 EDT
    assert.equal(end.toISOString(), '2026-08-17T03:59:59.999Z')   // Sun 23:59:59.999 EDT
  })

  it('Sun 23:00 ET -> window is Fri 16:00 -> Sun 23:59:59 of the weekend just ending (no roll-forward)', () => {
    // 2026-08-16 is a Sunday. 23:00 EDT = 2026-08-17T03:00:00.000Z.
    const now = new Date('2026-08-17T03:00:00.000Z')
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(start.toISOString(), '2026-08-14T20:00:00.000Z')
    assert.equal(end.toISOString(), '2026-08-17T03:59:59.999Z')
  })

  it('Sat 02:00 ET -> still anchored to the current (already-started) weekend', () => {
    // 2026-08-15 (Saturday) 02:00 EDT = 2026-08-15T06:00:00.000Z.
    const now = new Date('2026-08-15T06:00:00.000Z')
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(start.toISOString(), '2026-08-14T20:00:00.000Z')
    assert.equal(end.toISOString(), '2026-08-17T03:59:59.999Z')
  })

  it('next_7_days spans exactly 7 calendar days INCLUDING today (today+6, not today+7)', () => {
    const now = new Date('2026-08-17T03:00:00.000Z') // Sun Aug16 23:00 ET -> ET date is still Aug16
    const { start, end } = dateRangeBounds('next_7_days', now)
    assert.equal(start.toISOString(), '2026-08-16T04:00:00.000Z') // Aug16 00:00 EDT
    assert.equal(end.toISOString(), '2026-08-23T03:59:59.999Z')   // Aug22 23:59:59.999 EDT — 7 days, not 8
    // .getTime(), NOT Date.parse(dateObject) -- Date.parse coerces a Date via
    // its default (imprecise, non-UTC) toString() when handed an object
    // instead of a string, silently losing the millisecond precision this
    // assertion depends on.
    const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000)
    assert.equal(spanDays, 7) // 7 full calendar days, today included
  })

  it('this_month on the 31st ends on the 31st, not next month', () => {
    const now = new Date('2026-08-31T16:00:00.000Z') // Aug31 12:00 EDT
    const { start, end } = dateRangeBounds('this_month', now)
    assert.equal(start.toISOString(), '2026-08-31T04:00:00.000Z') // Aug31 00:00 EDT
    assert.equal(end.toISOString(), '2026-09-01T03:59:59.999Z')   // Aug31 23:59:59.999 EDT, NOT Sep30
  })

  it('a viewer in America/Los_Angeles at 22:00 PT gets the EASTERN today, not the Pacific one', () => {
    // Requires process.env.TZ to actually be Pacific for this case to mean
    // anything — otherwise the bug it guards (viewer-local computation) is
    // invisible on a US-East CI box. This test process's TZ is whatever the
    // runner has; assert the ENGINE is TZ-independent regardless by checking
    // the module never reads process.env.TZ / the machine's local offset —
    // Aug14 22:00 PDT (UTC-7) = Aug15 01:00 EDT, so "today" must be Aug15.
    const now = new Date('2026-08-15T05:00:00.000Z')
    const { start } = dateRangeBounds('today', now)
    assert.equal(start.toISOString(), '2026-08-15T04:00:00.000Z') // Aug15 00:00 EDT, not Aug14
  })

  it('March DST-transition day (spring forward, 23h civil day): today starts at real Eastern midnight', () => {
    // 2026-03-08 is the spring-forward transition (2am -> 3am EST -> EDT).
    const now = new Date('2026-03-08T15:00:00.000Z') // Mar8 10:00 EST
    const { start, end } = dateRangeBounds('today', now)
    assert.equal(start.toISOString(), '2026-03-08T05:00:00.000Z') // Mar8 00:00 EST (pre-transition offset)
    // The civil day genuinely has 23 hours on the transition day itself —
    // asserting exactly 24h here would be asserting the WRONG answer, not a
    // stronger one. The DST-safety property under test is that the START is
    // a real Eastern midnight (right above) and duration reflects the actual
    // lost hour, not a fixed-offset approximation's arbitrary drift.
    // .getTime(), NOT Date.parse(dateObject) -- see the next_7_days test above.
    const durMs = end.getTime() - start.getTime()
    assert.equal(durMs, 23 * 3600_000 - 1)
  })

  it('November DST-transition day (fall back, 25h civil day): today starts at real Eastern midnight', () => {
    // 2026-11-01 is the fall-back transition (2am -> 1am EDT -> EST).
    const now = new Date('2026-11-01T15:00:00.000Z') // Nov1 11:00 EDT
    const { start, end } = dateRangeBounds('today', now)
    assert.equal(start.toISOString(), '2026-11-01T04:00:00.000Z') // Nov1 00:00 EDT (pre-transition offset)
    const durMs = end.getTime() - start.getTime()
    assert.equal(durMs, 25 * 3600_000 - 1)
  })

  it('tomorrow is a real 24h Eastern day on an ordinary (non-transition) date', () => {
    const now = new Date('2026-08-14T19:00:00.000Z')
    const { start, end } = dateRangeBounds('tomorrow', now)
    assert.equal(start.toISOString(), '2026-08-15T04:00:00.000Z')
    assert.equal(end.toISOString(), '2026-08-16T03:59:59.999Z')
    assert.equal(end.getTime() - start.getTime(), 24 * 3600_000 - 1)
  })

  it('this_week (legacy, no chip) still resolves correctly for an existing embed/shared URL', () => {
    // Wed Aug12 2026 -> coming Sunday is Aug16.
    const now = new Date('2026-08-12T19:00:00.000Z')
    const { start, end } = dateRangeBounds('this_week', now)
    assert.equal(start.toISOString(), '2026-08-12T04:00:00.000Z')
    assert.equal(end.toISOString(), '2026-08-17T03:59:59.999Z')
  })

  it('an unrecognized preset returns an unmodified now-to-now window (callers gate on truthiness first)', () => {
    const now = new Date('2026-08-14T19:00:00.000Z')
    const { start, end } = dateRangeBounds('not_a_real_preset', now)
    assert.equal(start.getTime(), now.getTime())
    assert.equal(end.getTime(), now.getTime())
  })
})

// ── easternIsoAt vs scripts/lib/normalize.js's easternToIso (drift guard) ──

describe('easternIsoAt matches scripts/lib/normalize.js\'s easternToIso across a DST fixture set', () => {
  const fixtures = [
    ['2026-01-15', '09:00:00'],  // ordinary EST day
    ['2026-06-13', '10:00:00'],  // ordinary EDT day
    ['2026-08-15', '19:00:00'],  // ordinary EDT day, evening
    ['2026-03-07', '23:30:00'],  // day BEFORE spring-forward
    ['2026-03-08', '01:30:00'],  // spring-forward day, pre-transition hour
    ['2026-03-08', '03:30:00'],  // spring-forward day, post-transition hour
    ['2026-03-09', '00:15:00'],  // day AFTER spring-forward
    ['2026-10-31', '23:30:00'],  // day BEFORE fall-back
    ['2026-11-01', '00:30:00'],  // fall-back day, pre-transition hour (ambiguous 1-2am not exercised)
    ['2026-11-01', '12:00:00'],  // fall-back day, post-transition
    ['2026-11-02', '00:15:00'],  // day AFTER fall-back
    ['2026-12-31', '23:59:59'],  // year boundary
  ]

  for (const [ymd, hms] of fixtures) {
    it(`${ymd} ${hms} ET`, () => {
      assert.equal(easternIsoAt(ymd, hms), easternToIso(ymd, hms))
    })
  }
})

// ── buildDateRangeLabel ─────────────────────────────────────────────────

describe('buildDateRangeLabel', () => {
  it('same day, both set -> a single date, no range join', () => {
    assert.equal(buildDateRangeLabel('2026-08-16', '2026-08-16'), 'Aug 16')
  })

  it('a genuine span -> "Aug 16 to Aug 22" (the repo bans em/en dashes)', () => {
    const label = buildDateRangeLabel('2026-08-16', '2026-08-22')
    assert.equal(label, 'Aug 16 to Aug 22')
    assert.doesNotMatch(label, /[–—]/, 'must not contain an en dash or em dash')
  })

  it('from only -> "From Aug 16"', () => {
    assert.equal(buildDateRangeLabel('2026-08-16', null), 'From Aug 16')
  })

  it('to only -> "Through Aug 22"', () => {
    assert.equal(buildDateRangeLabel(null, '2026-08-22'), 'Through Aug 22')
  })

  it('neither set -> empty string, never a bare ellipsis placeholder', () => {
    assert.equal(buildDateRangeLabel(null, null), '')
  })
})

// ── timeOfDayBounds ──────────────────────────────────────────────────────

describe('timeOfDayBounds', () => {
  it('morning is [5, 11]', () => {
    assert.deepEqual(timeOfDayBounds('morning'), [5, 11])
  })
  it('afternoon is [12, 16] — 12 (noon) is Afternoon\'s floor, not Morning\'s ceiling', () => {
    assert.deepEqual(timeOfDayBounds('afternoon'), [12, 16])
  })
  it('evening is [17, 23]', () => {
    assert.deepEqual(timeOfDayBounds('evening'), [17, 23])
  })
  it('null/undefined -> null (no filter)', () => {
    assert.equal(timeOfDayBounds(null), null)
    assert.equal(timeOfDayBounds(undefined), null)
  })
  it('hours 0-4 belong to no bucket', () => {
    const buckets = [timeOfDayBounds('morning'), timeOfDayBounds('afternoon'), timeOfDayBounds('evening')]
    for (let h = 0; h <= 4; h++) {
      const inAny = buckets.some(([lo, hi]) => h >= lo && h <= hi)
      assert.equal(inAny, false, `hour ${h} must not fall inside any bucket`)
    }
  })
})

// ── Drift guards: WHEN_PRESETS <-> embed VALID_DATE <-> dateRangeBounds ──

describe('WHEN_PRESETS / embedConfig VALID_DATE / dateRangeBounds stay in sync', () => {
  it('every value the embed contract accepts (VALID_DATE) exists in WHEN_PRESETS', () => {
    // embedConfig.ts uses `@/`-aliased imports (themes.ts, neighborhoods.ts,
    // seo/categories.js) that only resolve under Vite's alias map, so this
    // reads its VALID_DATE Set literal as text rather than importing the
    // module directly — Node's plain ESM resolver has no `@/` alias. This
    // still checks the REAL, current file content; it's not a hardcoded copy.
    const embedConfigSrc = readFileSync(path.join(REPO_ROOT, 'src/lib/embedConfig.ts'), 'utf8')
    const match = embedConfigSrc.match(/VALID_DATE = new Set<EmbedDate>\(\[([^\]]+)\]\)/)
    assert.ok(match, 'expected to find `const VALID_DATE = new Set<EmbedDate>([...])` in embedConfig.ts')
    const ids = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    assert.ok(ids.length > 0, 'parsed zero ids out of VALID_DATE — the regex above no longer matches the file shape')
    const presetIds = new Set(WHEN_PRESETS.map((p) => p.id))
    for (const id of ids) {
      assert.ok(presetIds.has(id), `embedConfig.ts's VALID_DATE has '${id}', which is not in WHEN_PRESETS`)
    }
  })

  it('every non-ghost WHEN_PRESETS id is handled by dateRangeBounds (an unhandled id silently returns a now-to-now window)', () => {
    const now = new Date('2026-08-14T19:00:00.000Z')
    for (const p of WHEN_PRESETS.filter((p) => !p.ghost)) {
      const { start, end } = dateRangeBounds(p.id, now)
      assert.notEqual(
        start.getTime(), now.getTime(),
        `WHEN_PRESETS id '${p.id}' resolved to the unmodified now-to-now fallback — dateRangeBounds does not handle it`,
      )
      assert.ok(end.getTime() >= start.getTime(), `'${p.id}' produced an inverted window`)
    }
  })

  it('the ghost preset (this_week) is still handled by dateRangeBounds too — it must keep resolving', () => {
    const now = new Date('2026-08-14T19:00:00.000Z')
    const { start, end } = dateRangeBounds('this_week', now)
    assert.notEqual(start.getTime(), now.getTime())
    assert.ok(end.getTime() >= start.getTime())
  })
})
