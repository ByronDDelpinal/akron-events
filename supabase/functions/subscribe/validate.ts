/**
 * validate.ts — pure input-sanitization helpers for the `subscribe` function.
 *
 * Pulled out of index.ts for the same reason slack-notify/render.ts is
 * separate from slack-notify/index.ts: index.ts calls `Deno.serve(...)` and
 * builds a Supabase/Resend client at module scope from required env vars, so
 * IMPORTING it (as a test would need to, to exercise this logic) starts a
 * live HTTP listener and throws immediately in any environment that doesn't
 * have SUPABASE_URL/RESEND_API_KEY set. This file has neither problem — no
 * Deno.serve, no env reads, no client construction — so validate.test.ts can
 * import it directly.
 *
 * That "no env reads" claim used to be false in practice: this file imported
 * INTENT_LABELS from `../_shared/slack.ts`, which reads four Slack env vars
 * and logs at module scope (see slack.ts's cold-start console.log). Nothing
 * broke from that (Deno.env.get on an unset var returns undefined, not a
 * throw), but it meant `subscribe` — a public, unauthenticated, user-facing
 * WRITE endpoint — transitively hard-depended on the Slack module booting
 * cleanly at load time, for no functional reason (code-reviewer re-review,
 * MINOR 1, 2026-07-27). INTENT_LABELS now comes from `../_shared/intents.ts`
 * instead, a zero-dependency, zero-side-effect module that both this file
 * and slack.ts import from — one registry, no cycle, and this file's "no env
 * reads" claim is true again.
 */

import { INTENT_LABELS } from '../_shared/intents.ts'

/**
 * Closed registry for `intents`: INTENT_LABELS' 5 curated ids (imported from
 * _shared/intents.ts, which is kept in sync with src/lib/categories.js's
 * INTENTS by scripts/tests/test-slack-intent-labels.js — see that file for
 * why the ids are duplicated there instead of importing the frontend module
 * directly) plus the 'all' sentinel SubscribePage.tsx sends for "All Events".
 *
 * `preferences` is `jsonb` with `with check (true)` on anon INSERT
 * (009_subscribers.sql) — nothing stops a direct POST to this public
 * function from sending any shape at all for `intents`, and that value is
 * written with the SERVICE-ROLE client in index.ts, so it reaches
 * slack-notify's renderer (and, later, the digest) as fully-trusted-looking
 * data. Validating here, at the one place this array is ever written, is
 * what makes render.ts's "must never throw / must never render something
 * huge" contract achievable in the first place — a renderer can only be as
 * safe as the data reaching it. render.ts's own per-facet caps are
 * defense-in-depth on top of this, not a substitute for it: this is the
 * write-side half of the same MAJOR finding.
 */
export const INTENT_IDS: string[] = ['all', ...INTENT_LABELS.map((i) => i.id)]

// A Set for O(1) membership checks below — INTENT_IDS stays a plain array
// (its export shape is part of the module's public surface, pinned by
// validate.test.ts's `assertEquals(INTENT_IDS, [...])`), but sanitizeIntents
// itself must not pay an O(registry size) `.includes()` scan per element.
// With a 6-entry registry that's not measurable today, but it's the correct
// shape regardless of registry size, and cheap to have right from the start.
const INTENT_ID_SET = new Set(INTENT_IDS)

// Hard ceiling on how many RAW elements sanitizeIntents will even look at,
// independent of MAX_INTENTS below. No legitimate signup form ever sends
// more than the registry's ~6 ids, so this is generous headroom, not a
// meaningful legitimate limit.
const MAX_RAW_INTENTS_SCANNED = 1000

/** Hard ceiling on how many VALID intents survive into storage — no
 * legitimate signup form selects more than the ~6 real intents anyway; this
 * is a hard ceiling on what a direct POST can force into storage. (Not the
 * same number as render.ts's capList default MAX_SHOWN, which is 6 and
 * governs how many are ever displayed in a Slack bullet — MAX_INTENTS
 * governs what's writable to the DB in the first place.) */
export const MAX_INTENTS = 10

/**
 * Sanitize the caller-supplied `intents` field before it's written.
 *
 * Non-array input (missing, null, a bare string, an object, ...) falls back
 * to the same `['all']` default the endpoint always used. An array survives
 * with only its valid, registry-member, string elements kept — including as
 * an empty array, if every supplied element was invalid or none were
 * supplied: that matches the pre-existing `body.intents || ['all']` behavior
 * (an explicit empty array was already stored as `[]`, not coerced to
 * `['all']`), and render.ts's Interests bullet already renders `[]`
 * identically to `['all']` ("Everything happening in Akron"), so nothing
 * downstream depends on which of the two empty-ish shapes is stored.
 *
 * Order of operations matters (code-reviewer re-review, MINOR 4,
 * 2026-07-27): slice the RAW input to MAX_RAW_INTENTS_SCANNED elements
 * FIRST, before the registry-membership filter runs at all, then filter,
 * then slice again to MAX_INTENTS. The previous version filtered across the
 * ENTIRE raw array before ever slicing — for a 50,000-element hostile array
 * that's 50,000 Set/array lookups to produce a result that gets sliced down
 * to at most 10 elements a moment later, the exact inverse of the
 * slice-before-work ordering render.ts's capList already uses for the same
 * reason (see that function's comment). Slicing first bounds the cost of
 * EVERY step that follows to O(MAX_RAW_INTENTS_SCANNED) regardless of the
 * raw array's real size.
 */
export function sanitizeIntents(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['all']
  return raw
    .slice(0, MAX_RAW_INTENTS_SCANNED)
    .filter((i): i is string => typeof i === 'string' && INTENT_ID_SET.has(i))
    .slice(0, MAX_INTENTS)
}

// ── Email validation ───────────────────────────────────────────────────

/**
 * RFC 5321 §4.5.3.1.3's own maximum total mailbox (email address) length.
 * Pulled out as a named export (rather than an inline magic number in
 * index.ts) so validate.test.ts can assert the 254/255-char boundary
 * against the real constant, not a hardcoded number that could silently
 * drift from what index.ts actually enforces.
 */
export const MAX_EMAIL_LEN = 254

// Deliberately unchanged from the pre-fix regex: `[^\s@]+` on both sides of
// `@` plus a `.` somewhere in the domain part. This function ONLY adds the
// length bound (MAX_EMAIL_LEN) on top of it — see isValidEmail's own
// comment for why the regex alone was the write-side half of the MAJOR
// finding.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate a caller-supplied `email` before it's written or used to look up
 * an existing subscriber.
 *
 * Extracted from subscribe/index.ts's inline `if` (code-reviewer re-review,
 * MAJOR, 2026-07-27) for the same reason sanitizeIntents lives here instead
 * of inline in index.ts: index.ts can't be imported directly (Deno.serve +
 * env-required client construction at module scope — see this file's header
 * comment), so its validation logic is untestable unless it's pulled out
 * into a module with none of those side effects.
 *
 * The regex alone (`EMAIL_RE`) has NO length bound — `[^\s@]+` matches
 * greedily regardless of size. Before this fix, a 100,000-char `email`
 * (e.g. mostly `&`, which passes `[^\s@]+` and expands 5x through
 * escapeSlackText) was written as-is via the SERVICE-ROLE client with no
 * DB-side CHECK constraint to catch it either, and reached slack-notify's
 * renderSignup/renderConfirmed as an oversized raw email string (see
 * render.ts's MAX_MESSAGE_LEN comment for the exploit this closed on the
 * read side). MAX_EMAIL_LEN closes it here, at the one place `email` is
 * ever accepted from a request body.
 */
export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string'
    && email.length > 0
    && email.length <= MAX_EMAIL_LEN
    && EMAIL_RE.test(email)
}
