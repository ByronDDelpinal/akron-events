import { useState, useCallback } from 'react'

/**
 * A single manual-override marker: when the operator locked the field.
 * `at` is null for locks whose timestamp we do not know -- legacy rows
 * wrote bare `true` instead of `{ at }` (the review queue's approve action
 * did, before 2026-08), and no migration is going to rewrite them. The
 * shape is widened rather than special-cased so every consumer handles
 * both vintages through one code path.
 */
// A type alias, not an interface: aliases get an implicit index signature,
// so Overrides stays assignable to the generated Json column type.
export type OverrideMarker = {
  at: string | null
}

export type Overrides = Record<string, OverrideMarker>

/**
 * Normalize a `manual_overrides` JSON value of ANY vintage into the
 * canonical `Record<string, { at: string | null }>` shape:
 *   - object values with a string `.at` pass through unchanged;
 *   - any other truthy value (legacy `true`, an object without `.at`,
 *     a number, a string) becomes `{ at: null }` -- locked, date unknown;
 *   - falsy values are dropped (not locked);
 *   - non-object input (null, arrays, scalars) normalizes to `{}`.
 *
 * The scraper side only checks key PRESENCE (`'category' in overrides`,
 * scripts/lib/normalize.js), so normalizing values never changes what is
 * locked -- only how the lock renders. Seeding an edit form through this
 * and saving writes the canonical shape back, so legacy rows self-heal on
 * their next save.
 */
export function normalizeOverrides(json: unknown): Overrides {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return {}
  const out: Overrides = {}
  for (const [field, value] of Object.entries(json as Record<string, unknown>)) {
    if (!value) continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      const at = (value as { at?: unknown }).at
      out[field] = { at: typeof at === 'string' ? at : null }
    } else {
      out[field] = { at: null }
    }
  }
  return out
}

/**
 * Build the manual_overrides value that pins a human STATUS decision
 * (Publish, Unpublish, and Cancel in the review queue) against re-scrape.
 *
 * Cross-boundary contract, pinned by scripts/tests/test-review-reasons.js:
 * scraper payloads carry `status` and the moderation pass re-sets it, and
 * `_stripOverriddenFields` (scripts/lib/normalize.js) protects exactly the
 * keys PRESENT in the existing row's manual_overrides. So the returned
 * object must contain a `status` key in the canonical `{ at: ISO }` marker
 * shape (matching the category lock), and must preserve every other lock
 * already on the row -- normalized, so legacy bare-`true` markers self-heal
 * on this write.
 */
export function withStatusLock(existing: unknown, at: string = new Date().toISOString()): Overrides {
  return { ...normalizeOverrides(existing), status: { at } }
}

/**
 * Manages manual_overrides state for scraper-safe admin edits.
 * Accepts the raw JSON column value; state is always canonical.
 */
export function useOverrides(initial: unknown = {}) {
  const [overrides, setOverrides] = useState<Overrides>(() => normalizeOverrides(initial))

  const toggleOverride = useCallback((field: string) => {
    setOverrides((prev) => {
      const next = { ...prev }
      if (next[field]) delete next[field]
      else next[field] = { at: new Date().toISOString() }
      return next
    })
  }, [])

  return { overrides, toggleOverride }
}
