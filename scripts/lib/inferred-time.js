/**
 * Shared "invented vs parsed" start-time infrastructure.
 *
 * Promoted from scripts/scrape-city-of-cuyahoga-falls.js, the first scraper
 * to compute an inferred/parsed time boundary and disclose it. Before this
 * module existed, that distinction died at each scraper's own boundary: a
 * scraper could tell a parsed "7 p.m." from an invented SANCTIONED-DEFAULT-TIME
 * noon, but nothing in the shared scripts/lib/normalize.js upsert path ever
 * saw that signal, so needs_review was derived solely from category
 * confidence. A scraper now sets `row.time_inferred = true` on a row whose
 * start time it invented, and upsertEventSafe in normalize.js does the rest:
 * appends TIME_NOTE to the description, sets needs_review (unless a human has
 * already locked start_at via manual_overrides), and strips the transient key
 * before the row reaches Postgres.
 *
 * TIME_NOTE is a VERBATIM reuse of the string scripts/lib/ics.js has shipped
 * for years as DATE_ONLY_TIME_NOTE — not a new sentence. ics.js re-exports
 * DATE_ONLY_TIME_NOTE from here instead of keeping a second copy, so every
 * existing `import { DATE_ONLY_TIME_NOTE } from './lib/ics.js'` across the
 * scrapers and tests keeps working, and TIME_NOTES in
 * supabase/functions/send-digest/select.ts (which subtracts every known note
 * before scoring description length) already covers this string with no
 * edge function redeploy required.
 */
// Inlined rather than imported from normalize.js: normalize.js imports
// withTimeNote from this module, so importing clampChars back would
// create a live ESM cycle (normalize.js:18 <-> here). This module must
// have NO import edge back to normalize.js. Kept behaviourally identical
// to normalize.js's clampChars (never split a character, never grow).
function clampChars(str, max) {
  if (str == null) return str
  const s = String(str)
  if (s.length <= max) return s
  const kept = []
  let used = 0
  for (const ch of s) {
    if (used + ch.length > max) break
    kept.push(ch)
    used += ch.length
  }
  return kept.join('')
}

export const TIME_NOTE =
  'This listing does not include a start time, so the time shown is a placeholder. Confirm with the organizer before you go.'

/**
 * Cap on the stored description. Applied to the base text and again when the
 * note is appended, so the disclosure can never push the row past it.
 */
export const MAX_DESCRIPTION = 5000

/**
 * Append TIME_NOTE to a description, reserve-then-append. Generalised from
 * ics.js's withDateOnlyTimeNote (née buildDescription() in
 * scrape-city-of-cuyahoga-falls.js):
 *
 *   • A null/blank base stays null. The note is a suffix to real prose, never
 *     a description in its own right — a note-only description reads as a
 *     complete listing to anything measuring description length and would
 *     promote an event with no prose above events that have some.
 *   • The includes() guard keeps a feed that already quotes the sentence (or a
 *     description round-tripped back out of the database) from doubling it —
 *     also what makes this safe to call from upsertEventSafe even when a
 *     scraper already appended the note itself before this module existed.
 *   • The note is reserved for, never truncated: room is MAX_DESCRIPTION minus
 *     the note and its separating space.
 *
 * Exported so tests exercise the real text.
 */
export function withTimeNote(base) {
  if (!base || !base.trim()) return base
  if (base.includes(TIME_NOTE)) return base
  const room = MAX_DESCRIPTION - TIME_NOTE.length - 1
  return `${clampChars(base, room)} ${TIME_NOTE}`
}

/**
 * Moved verbatim from scrape-city-of-cuyahoga-falls.js's undisclosedDefaultTime.
 *
 * Pure: did an occurrence end up shipping an invented default time with
 * nothing in the description telling the reader so? Keyed on the OUTCOME
 * (was the time invented, and does the stored description carry the
 * disclosure), not on comparing the resulting time string to a sentinel.
 *
 * Never compare a time string to '12:00:00' to answer this — a genuine
 * "12 - 2 p.m." event parses to exactly that string with inferred:false.
 * That landmine produced false positives before this boundary was tracked
 * explicitly via `timeInferred`.
 */
export function undisclosedDefaultTime({ timeInferred } = {}, description) {
  if (timeInferred !== true) return false
  return !(description && description.includes(TIME_NOTE))
}
