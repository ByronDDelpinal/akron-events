/**
 * whenFilter.ts
 *
 * Pure, clock-injectable logic for the "When" section (date preset + custom
 * range + time of day). No React, no URL access -- see `WhenSection.tsx` for
 * the component that consumes this, and `docs/when-filter.md` (gitignored,
 * secondary reference only) for the full design.
 */

import { WHEN_PRESETS } from './filterOptions.ts'

// ── Preset derivation ────────────────────────────────────────────────────

const KNOWN_PRESET_IDS = new Set(WHEN_PRESETS.map((p) => p.id))

export type WhenKind = 'any' | 'preset' | 'custom'

export interface DerivedWhen {
  kind: WhenKind
  /** Set only when kind === 'preset'. */
  id?: string
  /** Set only when kind === 'custom'. */
  from?: string | null
  to?: string | null
}

export interface DeriveWhenArgs {
  dateRange: string | null
  dateFrom: string | null
  dateTo: string | null
}

/**
 * What a WhenSection interaction wrote. Every variant maps to exactly ONE
 * atomic multi-param write (see useEventFilters.ts's setWhen / CategoryPage's
 * equivalent) — never two sequential single-param setters, which would each
 * derive from the same render's searchParams snapshot and the second would
 * clobber the first (docs/when-filter.md §1.2).
 */
export type WhenAction =
  | { type: 'preset'; id: string }
  | { type: 'range'; from: string | null; to: string | null }
  | { type: 'clear' }

/**
 * The chip row is a pure function of the three URL values that already
 * exist (`date`, `from`, `to`) -- there is no separate "which chip is
 * selected" state field, so it can never disagree with what the query
 * actually returns.
 *
 * Mirrors useEvents' own precedence (`useEvents.ts` / `useMapEvents`): a
 * custom range wins over a preset. A hand-edited URL carrying both
 * (`?date=today&from=2026-09-01`) is contradictory, and the chip shows
 * "custom" because that is what the grid is actually showing -- the chip
 * never lies about the result set, even when the URL is nonsense. An unknown
 * `date` value falls back to "Any time" and the query ignores it, the same
 * defensive posture as intent validation elsewhere in the filter stack.
 */
export function deriveWhen({ dateRange, dateFrom, dateTo }: DeriveWhenArgs): DerivedWhen {
  if (dateFrom || dateTo) return { kind: 'custom', from: dateFrom ?? null, to: dateTo ?? null }
  if (dateRange && KNOWN_PRESET_IDS.has(dateRange)) return { kind: 'preset', id: dateRange }
  return { kind: 'any' }
}

// ── Time of day ──────────────────────────────────────────────────────────

export type TimeOfDayId = 'morning' | 'afternoon' | 'evening'

export const TIME_OF_DAY_OPTIONS: { id: TimeOfDayId; label: string }[] = [
  { id: 'morning', label: 'Morning' },
  { id: 'afternoon', label: 'Afternoon' },
  { id: 'evening', label: 'Evening' },
]

// Hour buckets are computed from `start_at`, and `start_at` is NOT always a real
// published time. Roughly a dozen scrapers substitute a sanctioned default hour when
// their source publishes none (grep marker: SANCTIONED-DEFAULT-TIME). That marker
// exists ONLY as a source-code comment -- there is no column, no flag, nothing in the
// row -- so this filter CANNOT tell a fabricated 7pm from a real one, and it will
// include events whose hour was invented. Known offenders and the hour they invent:
// ohio_festivals/ics/city_of_cuyahoga_falls/downtown_cf/stewarts/peninsula/civicplus
// -> noon (Afternoon), ohio_erie_canalway -> 9am (Morning), workz -> 7pm (Evening).
//
// Three of them append a disclosure sentence to `description`; the rest do not, so
// filtering on that sentence would suppress SOME fabricated hours and not others --
// arbitrary and unreviewable. Do not add that predicate here. The only honest fix is a
// real column written by the scrapers at upsert time (see `start_time_confidence` in
// the "When" design); until that exists the mitigation is COPY, not a query. The UI
// hint next to these chips says "approximate" for exactly this reason -- do not
// tighten that wording to imply certainty.
//
// MAINTAINER OVERRIDE (2026-08-10): the design draft above proposed shipping that
// "approximate" hint as user-facing copy under the chip row. The maintainer decided
// AGAINST it -- no accuracy caveat ships in the UI, full stop -- while accepting the
// underlying tradeoff (an Evening filter can and will surface a fabricated 7pm). The
// paragraph above is kept verbatim as the record of WHY that tradeoff is safe to ship
// unhedged; do not resurrect the hint text into a component. See WhenSection.tsx's
// own comment at the same spot for the live decision.
//
// Hours 0-4 belong to NO bucket and are excluded whenever any bucket is selected --
// deliberate: a 2am start in this dataset is nearly always an artifact, and ~28 rows
// with a literal T000000 start survive by design from the midnight-starts patch
// (landed 2026-08-02, d87ae36). Bucketing them into "Morning" would put data-quality
// residue in front of someone looking for a genuine 9am hike.
const TIME_OF_DAY_BUCKETS: Record<TimeOfDayId, [number, number]> = {
  morning: [5, 11],
  afternoon: [12, 16],
  evening: [17, 23],
}

/** `[lo, hi]` inclusive hour bounds for a time-of-day bucket, or null when
 * `id` is null/unset (no filter). */
export function timeOfDayBounds(id: TimeOfDayId | null | undefined): [number, number] | null {
  if (!id) return null
  return TIME_OF_DAY_BUCKETS[id] ?? null
}
