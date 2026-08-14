/**
 * browseVisibility.js — the ONE place the "hide festival children from the
 * browse grid" rule is expressed. Plain JS (DOM-free, no React) so both the
 * browser bundle (useEvents.ts, useMapEvents, EventCard.tsx) and the plain-JS
 * Vercel functions (api/events-first-page.js, api/events-hub.js,
 * api/feed.xml.js) import the SAME module. See docs/umbrella-child-hiding.md
 * for the full design; this file implements §1.
 *
 * Every browse query path MUST call applyBrowseVisibility — never
 * re-implement the predicate inline. scripts/tests/test-browse-visibility.js
 * and scripts/tests/test-browse-visibility-callsites.js both fail if a call
 * site ships the rule some other way.
 */

import { FESTIVALS } from './festivalsData.js'

export const FESTIVAL_UMBRELLA_TAG = 'festival-umbrella'

// A registry tag containing a comma, brace, or paren would silently corrupt
// the whole PostgREST filter string into something that could match
// everything or nothing — the exact class of bug behind the comma-in-search
// incident (regexEscape missing ',' → live 400s on search). Every tag is
// validated before it ever reaches a filter string, and the helper throws
// rather than degrading silently.
const TAG_PATTERN = /^[a-z0-9-]+$/

function assertValidTag(tag) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) {
    throw new Error(
      `browseVisibility: registry tag ${JSON.stringify(tag)} fails ${TAG_PATTERN} — ` +
      'a comma, brace, or paren here would silently corrupt the whole PostgREST filter. ' +
      'See docs/umbrella-child-hiding.md §1.3.',
    )
  }
}

/**
 * FESTIVAL_TAGS is **exactly** FESTIVALS.map(f => f.tag) — the registry's
 * `tag` field and nothing else. Validated once at module load so a bad
 * registry entry fails fast (import time), not on the first request that
 * happens to hit a query builder.
 */
export const FESTIVAL_TAGS = FESTIVALS.map((f) => {
  assertValidTag(f.tag)
  return f.tag
})

/**
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  A FESTIVAL CHILD IS **NOT** "AN EVENT THAT SHARES A TAG WITH AN      │
 * │  UMBRELLA".                                                           │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The PorchRokr umbrella carries these ordinary tags in addition to its
 * festival tag: free, akron, music, outdoor, festival, community,
 * downtown-akron, highland-square. Measured 2026-08-14: defining a child by
 * shared tags would hide 3,479 events tagged `free` and 2,173 tagged `akron`
 * — i.e. most of the site, silently, with a correct-looking `total`.
 *
 * A child is: carries a tag that appears as `tag` in the FESTIVALS registry
 * (src/lib/festivalsData.js), AND does not itself carry 'festival-umbrella'.
 *
 * FESTIVAL_TAGS is derived by .map(f => f.tag) and MUST NOT be hand-edited.
 * scripts/tests/test-browse-visibility.js fails if an ordinary tag ever
 * reaches this list.
 *
 * `festivalTags` is injectable (default FESTIVAL_TAGS) purely for tests —
 * every real call site uses the default.
 */
export function isHiddenFromBrowse(tags, festivalTags = FESTIVAL_TAGS) {
  festivalTags.forEach(assertValidTag)
  const list = Array.isArray(tags) ? tags : []
  if (list.includes(FESTIVAL_UMBRELLA_TAG)) return false
  return list.some((t) => festivalTags.includes(t))
}

// MUST-VERIFY before merge (docs/umbrella-child-hiding.md §1.3, §8.C): the
// primary encoding nests `not.cs` inside `and(...)` inside `or(...)`, and
// that `or=` must coexist with `freeOnly`'s own `or=` on the same request
// (two `or=` params, one query). This repo cannot hit the live anon API from
// here — confirm with a real anon curl before this ships. If either check
// fails, flip this flag to `true`: the fallback issues one `.or()` call PER
// registry tag instead of one combined call. The two are logically
// identical — AND_i(not t_i OR U) == U OR (not t_1 AND ... AND not t_N) is a
// standard distributive-law identity — so flipping this is a pure encoding
// change, not a behavior change. Cost: N `or=` params instead of 1.
export const USE_PER_TAG_OR_FALLBACK = false

/**
 * Build the `.or()` clause string(s) implementing isHiddenFromBrowse as a
 * PostgREST filter: *(carries none of the registry tags) OR (is an
 * umbrella)*. Returns an array of clause strings to `.or()` in order — empty
 * when the registry is empty (a no-op, never "hide everything"), one clause
 * in the primary encoding, or `festivalTags.length` clauses in the fallback.
 *
 * Exported (not just used internally by applyBrowseVisibility) so tests can
 * assert on the exact string without a stub query builder.
 */
export function buildBrowseVisibilityOrClauses(festivalTags = FESTIVAL_TAGS) {
  festivalTags.forEach(assertValidTag)
  if (festivalTags.length === 0) return []

  if (USE_PER_TAG_OR_FALLBACK) {
    return festivalTags.map(
      (t) => `tags.not.cs.{${t}},tags.cs.{${FESTIVAL_UMBRELLA_TAG}}`,
    )
  }

  if (festivalTags.length === 1) {
    // 1 registry tag → skip the and(...) wrapper.
    return [`tags.not.cs.{${festivalTags[0]}},tags.cs.{${FESTIVAL_UMBRELLA_TAG}}`]
  }

  // N >= 2 → wrap the negations in and(...).
  const negations = festivalTags.map((t) => `tags.not.cs.{${t}}`).join(',')
  return [`and(${negations}),tags.cs.{${FESTIVAL_UMBRELLA_TAG}}`]
}

/**
 * Apply the festival-child-hiding rule to a supabase-js query builder.
 * Every browse query path (list, map, calendar, the two edge-cached first-
 * page endpoints, the RSS feed, "More like this") calls this — never
 * re-implements the filter inline. Skipped by the caller (not by this
 * function) when a search term is active: see useEvents.ts / useMapEvents.
 *
 * A 0-entry registry is a deliberate, tested no-op: `festivalTags` empty ⇒
 * buildBrowseVisibilityOrClauses returns [] ⇒ this loop never runs ⇒ the
 * SAME query object comes back untouched.
 */
export function applyBrowseVisibility(query, festivalTags = FESTIVAL_TAGS) {
  let q = query
  for (const clause of buildBrowseVisibilityOrClauses(festivalTags)) {
    q = q.or(clause)
  }
  return q
}

/**
 * The Festival this row is the UMBRELLA for, or null. A row qualifies only
 * when it carries BOTH 'festival-umbrella' AND a registry tag — an event
 * that carries 'festival-umbrella' alone (a retired registry entry's
 * orphaned umbrella, see check-festivals.js's orphan-umbrella check) is not
 * treated as belonging to any festival here.
 */
export function umbrellaFestival(tags, registry = FESTIVALS) {
  const list = Array.isArray(tags) ? tags : []
  if (!list.includes(FESTIVAL_UMBRELLA_TAG)) return null
  return registry.find((f) => list.includes(f.tag)) ?? null
}
