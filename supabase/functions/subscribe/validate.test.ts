// validate.test.ts — Deno tests for subscribe's `intents` write-side
// sanitization.
//
// code-reviewer, 2026-07-27, MAJOR: `subscribe/index.ts` wrote
// `body.intents || ['all']` straight into `preferences` with no validation,
// no cap, and no rate limit, using the SERVICE-ROLE client — so an
// unauthenticated POST could store an arbitrarily large/shaped `intents`
// value that later reaches slack-notify's renderer. This is the write-side
// half of that fix; render.ts's per-facet caps (render.test.ts) are the
// read-side half.
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).

import { assertEquals } from 'jsr:@std/assert@1'
import { sanitizeIntents, INTENT_IDS, MAX_INTENTS, isValidEmail, MAX_EMAIL_LEN } from './validate.ts'

Deno.test('sanitizeIntents: the registry is exactly the 5 curated intents plus the all sentinel', () => {
  assertEquals(INTENT_IDS, ['all', 'date-night', 'family', 'arts-stage', 'give-back', 'outdoors-active'])
})

Deno.test('sanitizeIntents: non-array input (missing/undefined) falls back to [\'all\']', () => {
  assertEquals(sanitizeIntents(undefined), ['all'])
})

Deno.test('sanitizeIntents: non-array input (null) falls back to [\'all\']', () => {
  assertEquals(sanitizeIntents(null), ['all'])
})

Deno.test('sanitizeIntents: non-array input (a bare string) falls back to [\'all\']', () => {
  assertEquals(sanitizeIntents('<!channel>'), ['all'])
})

Deno.test('sanitizeIntents: non-array input (a plain object) falls back to [\'all\']', () => {
  assertEquals(sanitizeIntents({ a: 1 }), ['all'])
})

Deno.test('sanitizeIntents: non-array input (a number) falls back to [\'all\']', () => {
  assertEquals(sanitizeIntents(42), ['all'])
})

Deno.test('sanitizeIntents: a valid subset of real intents passes through unchanged', () => {
  assertEquals(sanitizeIntents(['date-night', 'arts-stage']), ['date-night', 'arts-stage'])
})

Deno.test('sanitizeIntents: [\'all\'] passes through unchanged', () => {
  assertEquals(sanitizeIntents(['all']), ['all'])
})

Deno.test('sanitizeIntents: non-string elements are dropped, valid strings kept', () => {
  assertEquals(sanitizeIntents([123, 'family', { a: 1 }, null, 'give-back']), ['family', 'give-back'])
})

Deno.test('sanitizeIntents: ids outside the registry are dropped', () => {
  assertEquals(sanitizeIntents(['date-night', '<!channel>', 'not-a-real-intent']), ['date-night'])
})

Deno.test('sanitizeIntents: an array of entirely invalid values stores an empty array, not a throw', () => {
  assertEquals(sanitizeIntents(['<!channel>', 123, { a: 1 }]), [])
})

Deno.test('sanitizeIntents: an explicit empty array stores as empty array (matches prior `[] || [\'all\']` behavior)', () => {
  assertEquals(sanitizeIntents([]), [])
})

Deno.test('sanitizeIntents: more than MAX_INTENTS valid values are capped', () => {
  // Only 5 real intents exist, so repeat 'all' + valid ids past the registry
  // size to exercise the count cap itself, independent of registry size.
  const overLong = Array(50).fill('all')
  const out = sanitizeIntents(overLong)
  assertEquals(out.length, MAX_INTENTS)
  assertEquals(out, Array(MAX_INTENTS).fill('all'))
})

Deno.test('sanitizeIntents: a 50,000-element hostile array is validated and capped, not stored raw', () => {
  const hostile = Array(50_000).fill('<!channel>')
  const out = sanitizeIntents(hostile)
  assertEquals(out, [])
})

Deno.test('sanitizeIntents: a 50,000-element array of a valid id is capped to MAX_INTENTS', () => {
  const hostile = Array(50_000).fill('family')
  const out = sanitizeIntents(hostile)
  assertEquals(out.length, MAX_INTENTS)
})

Deno.test('sanitizeIntents: a single 40,000-char string element is dropped (not in the registry, however long)', () => {
  const out = sanitizeIntents(['x'.repeat(40_000)])
  assertEquals(out, [])
})

// ── isValidEmail — write-side length bound, code-reviewer re-review, MAJOR, 2026-07-27 ──
//
// subscribe/index.ts's Deno.serve handler can't be imported directly for a
// real HTTP-level test (module-scope client construction from required env
// vars — see this file's own header comment for why sanitizeIntents has the
// same constraint), so this exercises the extracted validator function
// index.ts now calls, which is the same code path a real request runs
// through: `if (!isValidEmail(email)) return json({ error: 'Valid email
// required' }, 400)` — the 400 body/status themselves are unchanged from
// before this fix, only the extra length condition is new.

Deno.test('isValidEmail: MAX_EMAIL_LEN is RFC 5321\'s 254-char maximum mailbox length', () => {
  assertEquals(MAX_EMAIL_LEN, 254)
})

Deno.test(`isValidEmail: a ${254}-char email (exactly MAX_EMAIL_LEN) is valid`, () => {
  const local = 'a'.repeat(MAX_EMAIL_LEN - '@example.com'.length)
  const email = `${local}@example.com`
  assertEquals(email.length, MAX_EMAIL_LEN)
  assertEquals(isValidEmail(email), true)
})

Deno.test(`isValidEmail: a ${255}-char email (one over MAX_EMAIL_LEN) is invalid`, () => {
  const local = 'a'.repeat(MAX_EMAIL_LEN + 1 - '@example.com'.length)
  const email = `${local}@example.com`
  assertEquals(email.length, MAX_EMAIL_LEN + 1)
  assertEquals(isValidEmail(email), false)
})

Deno.test('isValidEmail: a well-formed short email is valid', () => {
  assertEquals(isValidEmail('jane@example.com'), true)
})

Deno.test('isValidEmail: a 100,000-char email (mostly hostile "&" characters) is invalid — rejected on length before the regex even matters', () => {
  const email = `${'&'.repeat(100_000)}@example.com`
  assertEquals(isValidEmail(email), false)
})

Deno.test('isValidEmail: missing @ is invalid regardless of length', () => {
  assertEquals(isValidEmail('not-an-email'), false)
})

Deno.test('isValidEmail: missing dot in domain is invalid', () => {
  assertEquals(isValidEmail('jane@examplecom'), false)
})

Deno.test('isValidEmail: empty string is invalid', () => {
  assertEquals(isValidEmail(''), false)
})

Deno.test('isValidEmail: non-string input (undefined/null/number/object) is invalid, never throws', () => {
  assertEquals(isValidEmail(undefined), false)
  assertEquals(isValidEmail(null), false)
  assertEquals(isValidEmail(42), false)
  assertEquals(isValidEmail({ a: 1 }), false)
})
