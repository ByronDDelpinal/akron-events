// render.test.ts — Deno tests for the Tier 1 Slack renderers.
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
//
// Per this project's standing rule, code isn't done until its real parse
// path has run against realistic inputs, including both line-broken and
// single-line variants where that distinction matters.

import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { escapeSlackText } from '../_shared/slack.ts'
import {
  renderFeedback,
  renderSignup,
  renderConfirmed,
  describePreferences,
  frequencyNoun,
  lookaheadPhrase,
  capMessage,
  MAX_MESSAGE_LEN,
  TRUNCATION_MARKER,
  type Preferences,
  type ResolvedNames,
} from './render.ts'

// ── 1. escapeSlackText neutralizes the @-everyone vector ─────────────────

Deno.test('escapeSlackText neutralizes <!channel>, <@U123>, links, and &', () => {
  const input = '<!channel> <@U123> <http://x|y> & <b>'
  const out = escapeSlackText(input)

  // The literal @-everyone trigger must not survive intact.
  assertEquals(out.includes('<!channel>'), false)
  assertEquals(out.includes('<@U123>'), false)

  assertEquals(
    out,
    '&lt;!channel&gt; &lt;@U123&gt; &lt;http://x|y&gt; &amp; &lt;b&gt;',
  )
})

// ── 2. Escape ordering: & must run before < and > ─────────────────────────

Deno.test('escapeSlackText ordering does not double-encode an existing entity', () => {
  // If '<' were escaped before '&', the '&' inside the '&lt;' it just
  // produced would get re-escaped into '&amp;lt;' twice over. Escaping '&'
  // first prevents that: the only '&' in the input is escaped once, and no
  // new '&' characters are introduced afterward for '<'/'>' to touch.
  const out = escapeSlackText('&lt;')
  assertEquals(out, '&amp;lt;')

  // Round-trip: decoding &amp; back to & (the only entity Slack itself
  // would decode) reproduces the original raw text, not a smuggled '<'.
  const decoded = out.replace(/&amp;/g, '&')
  assertEquals(decoded, '&lt;')
})

Deno.test('escapeSlackText combined & + angle-bracket input escapes exactly once', () => {
  const out = escapeSlackText('<b>&')
  assertEquals(out, '&lt;b&gt;&amp;')
})

// ── 3. Feedback body: line-broken vs single-line ──────────────────────────

Deno.test('renderFeedback: multi-line body becomes a multi-line blockquote', () => {
  const out = renderFeedback({
    body: 'line one\nline two\nline three',
    page_path: '/events',
    created_at: '2026-07-01T12:00:00Z',
  })
  assertStringIncludes(out, '> line one')
  assertStringIncludes(out, '> line two')
  assertStringIncludes(out, '> line three')
  assertEquals(out.split('\n').filter((l) => l.startsWith('> ')).length, 3)
})

Deno.test('renderFeedback: single-line body becomes one blockquote line', () => {
  const out = renderFeedback({
    body: 'this is a single line note',
    page_path: '/events',
    created_at: '2026-07-01T12:00:00Z',
  })
  assertStringIncludes(out, '> this is a single line note')
  assertEquals(out.split('\n').filter((l) => l.startsWith('> ')).length, 1)
})

Deno.test('renderFeedback: header, page, and timestamp lines are present', () => {
  const out = renderFeedback({
    body: 'hello',
    page_path: '/submit',
    created_at: '2026-07-01T12:00:00Z',
  })
  assertStringIncludes(out, 'New feedback from akronpulse.com')
  assertStringIncludes(out, 'Page: /submit')
})

Deno.test('renderFeedback: null page_path renders "Unknown"', () => {
  const out = renderFeedback({ body: 'hello', page_path: null, created_at: '2026-07-01T12:00:00Z' })
  assertStringIncludes(out, 'Page: Unknown')
})

// ── 4. Body length boundary: 999 / 1000 / 1001 ────────────────────────────

function bodyOfLength(n: number): string {
  return 'x'.repeat(n)
}

function blockquotedLength(out: string): number {
  // Single-line body -> exactly one "> " line; strip the prefix.
  const line = out.split('\n').find((l) => l.startsWith('> '))
  if (!line) throw new Error('no blockquote line found')
  return line.slice(2).length
}

Deno.test('renderFeedback: 999-char body is not truncated', () => {
  const out = renderFeedback({ body: bodyOfLength(999), page_path: null, created_at: '2026-07-01T12:00:00Z' })
  assertEquals(blockquotedLength(out), 999)
})

Deno.test('renderFeedback: 1000-char body is not truncated', () => {
  const out = renderFeedback({ body: bodyOfLength(1000), page_path: null, created_at: '2026-07-01T12:00:00Z' })
  assertEquals(blockquotedLength(out), 1000)
})

Deno.test('renderFeedback: 1001-char body is truncated to 1000', () => {
  const out = renderFeedback({ body: bodyOfLength(1001), page_path: null, created_at: '2026-07-01T12:00:00Z' })
  assertEquals(blockquotedLength(out), 1000)
})

// ── 5. renderSignup — full 3x3 frequency x lookahead_days matrix ─────────

const FREQUENCIES: { frequency: string; noun: string }[] = [
  { frequency: 'daily', noun: 'day' },
  { frequency: 'weekly', noun: 'week' },
  { frequency: 'monthly', noun: 'month' },
]
const LOOKAHEADS: { days: number; phrase: string }[] = [
  { days: 1, phrase: '1 day of events' },
  { days: 7, phrase: '7 days of events' },
  { days: 30, phrase: '30 days of events' },
]

const DEFAULT_PREFS: Preferences = {
  intents: ['all'],
  categories: [],
  venue_ids: [],
  org_ids: [],
  price_max: null,
  age_restriction: null,
  event_days: [0, 1, 2, 3, 4, 5, 6],
  location: null,
  keywords: [],
  keywords_title_only: false,
}

for (const { frequency, noun } of FREQUENCIES) {
  for (const { days, phrase } of LOOKAHEADS) {
    Deno.test(`renderSignup: frequency=${frequency} lookahead_days=${days}`, () => {
      const out = renderSignup({
        email: 'jane@example.com',
        frequency,
        lookahead_days: days,
        preferences: DEFAULT_PREFS,
      })
      const expected = [
        `jane@example.com has signed up to receive ${phrase} every ${noun}.`,
        'They will not receive any emails until they confirm their subscription.',
        '',
        'What they asked for:',
        '• Interests: Everything happening in Akron',
      ].join('\n')
      assertEquals(out, expected)
      assertEquals(frequencyNoun(frequency), noun)
      assertEquals(lookaheadPhrase(days), phrase)
    })
  }
}

Deno.test('renderSignup: Byron\'s copy verbatim with curated intents', () => {
  const out = renderSignup({
    email: 'jane@example.com',
    frequency: 'weekly',
    lookahead_days: 7,
    preferences: { ...DEFAULT_PREFS, intents: ['date-night', 'arts-stage'] },
  })
  // "Arts & Stage" is escaped to "Arts &amp; Stage" in the wire text — Slack
  // decodes &amp; back to & when it renders the message, so what a human
  // reads in the channel is Byron's copy verbatim ("Arts & Stage"); the
  // &amp; here is the correctly-escaped source string this function must
  // produce, not a bug.
  const expected = [
    'jane@example.com has signed up to receive 7 days of events every week.',
    'They will not receive any emails until they confirm their subscription.',
    '',
    'What they asked for:',
    '• Interests: Date Night, Arts &amp; Stage',
  ].join('\n')
  assertEquals(out, expected)
})

// ── 6. renderConfirmed — exact string ─────────────────────────────────────

Deno.test('renderConfirmed: exact copy, nothing else', () => {
  assertEquals(
    renderConfirmed('jane@example.com'),
    'jane@example.com has confirmed their subscription!',
  )
})

// ── 7. describePreferences — literal default object -> "Everything ..." ──

Deno.test('describePreferences: literal subscribe/index.ts default object', () => {
  // Copied verbatim from subscribe/index.ts:109-120 (minus intents, which is
  // caller-supplied there — 'all' is its own default when omitted by the
  // signup form).
  const prefs: Preferences = {
    intents: ['all'],
    categories: [],
    venue_ids: [],
    org_ids: [],
    price_max: null,
    age_restriction: null,
    event_days: [0, 1, 2, 3, 4, 5, 6],
    location: null,
    keywords: [],
    keywords_title_only: false,
  }
  const out = describePreferences(prefs)
  assertEquals(out, 'What they asked for:\n• Interests: Everything happening in Akron')
})

// ── 8. Each facet non-default, individually and combined ─────────────────

Deno.test('describePreferences: price_max = 0 -> Free events only', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, price_max: 0 })
  assertStringIncludes(out, '• Free events only')
})

Deno.test('describePreferences: price_max = 25 -> Under $25', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, price_max: 25 })
  assertStringIncludes(out, '• Under $25')
})

Deno.test('describePreferences: event_days omitted when all 7 selected', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, event_days: [0, 1, 2, 3, 4, 5, 6] })
  assertEquals(out.includes('Days:'), false)
})

Deno.test('describePreferences: event_days shown when a subset is selected', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, event_days: [5, 6] })
  assertStringIncludes(out, '• Days: Fri, Sat')
})

Deno.test('describePreferences: location mode=area prints the label', () => {
  const out = describePreferences({
    ...DEFAULT_PREFS,
    location: { mode: 'area', label: 'Highland Square', lat: 41.087, lng: -81.538 },
  })
  assertStringIncludes(out, '• Highland Square')
})

Deno.test('describePreferences: location mode=zipcode prints "Within N miles of NNNNN"', () => {
  const out = describePreferences({
    ...DEFAULT_PREFS,
    location: { mode: 'zipcode', label: '44304', radius_miles: 5 },
  })
  assertStringIncludes(out, '• Within 5 miles of 44304')
})

Deno.test('describePreferences: keywords quoted, title-only suffix appended', () => {
  const out = describePreferences({
    ...DEFAULT_PREFS,
    keywords: ['jazz', 'food truck'],
    keywords_title_only: true,
  })
  assertStringIncludes(out, '• Keywords: "jazz", "food truck" (title only)')
})

Deno.test('describePreferences: keywords without title-only has no suffix', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, keywords: ['jazz'] })
  assertStringIncludes(out, '• Keywords: "jazz"')
  assertEquals(out.includes('(title only)'), false)
})

Deno.test('describePreferences: categories under 6 render as human labels, not raw slugs', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, categories: ['music', 'food'] })
  // "Food & Drink" is escaped to "Food &amp; Drink" in the wire text, same
  // as the Interests "Arts & Stage" case above — Slack decodes it back to
  // "&" client-side.
  assertStringIncludes(out, '• Categories: Music, Food &amp; Drink')
  assertEquals(out.includes('music, food'), false)
})

Deno.test('describePreferences: categories past 6 collapse with "+N more" (labels, not slugs)', () => {
  const cats = ['music', 'food', 'sports', 'fitness', 'outdoors', 'learning', 'festival', 'market']
  const out = describePreferences({ ...DEFAULT_PREFS, categories: cats })
  assertStringIncludes(out, '• Categories: Music, Food &amp; Drink, Sports, Fitness, Outdoors, Learning +2 more')
})

Deno.test('describePreferences: an unmapped category slug falls back to the raw slug, not dropped', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, categories: ['some-future-slug'] })
  assertStringIncludes(out, '• Categories: some-future-slug')
})

// ── 8b. age_restriction ───────────────────────────────────────────────────

Deno.test('describePreferences: age_restriction all_ages -> "Ages: All ages"', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: 'all_ages' })
  assertStringIncludes(out, '• Ages: All ages')
})

Deno.test('describePreferences: age_restriction 18_plus -> "Ages: 18+"', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: '18_plus' })
  assertStringIncludes(out, '• Ages: 18+')
})

Deno.test('describePreferences: age_restriction 21_plus -> "Ages: 21+"', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: '21_plus' })
  assertStringIncludes(out, '• Ages: 21+')
})

Deno.test('describePreferences: age_restriction null omits the Ages bullet', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: null })
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('describePreferences: age_restriction "not_specified" omits the Ages bullet (means no restriction)', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: 'not_specified' })
  assertEquals(out.includes('Ages:'), false)
})

// NOTE — contract change, code-reviewer re-review 2026-07-27, MINOR 4: an
// unrecognized age_restriction used to render raw (escaped). The reviewer
// ruled that wrong: AGE_LABEL is a closed enum with no legitimate raw-value
// fallback (unlike Categories, an open registry — see render.ts's comment),
// so an unrecognized value is now omitted entirely instead of rendered. See
// section 13d below for the full replacement coverage (object/array/boolean/
// number/unrecognized-string all omitted, never JSON.stringify-dumped).
Deno.test('describePreferences: an unrecognized age_restriction value does not throw and omits the bullet', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: 'some-future-value' })
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('describePreferences: all facets non-default combined', () => {
  const prefs: Preferences = {
    intents: ['family'],
    categories: ['music', 'food'],
    venue_ids: [],
    org_ids: [],
    price_max: 10,
    age_restriction: '21_plus',
    event_days: [0, 6],
    location: { mode: 'zipcode', label: '44304', radius_miles: 3 },
    keywords: ['trivia'],
    keywords_title_only: false,
  }
  const out = describePreferences(prefs)
  assertStringIncludes(out, '• Interests: Family')
  assertStringIncludes(out, '• Under $10')
  assertStringIncludes(out, '• Ages: 21+')
  assertStringIncludes(out, '• Days: Sun, Sat')
  assertStringIncludes(out, '• Within 3 miles of 44304')
  assertStringIncludes(out, '• Keywords: "trivia"')
  assertStringIncludes(out, '• Categories: Music, Food &amp; Drink')
})

// ── 8c. Every facet non-default, full output string ──────────────────────
//
// The 37/37-passing suite that shipped with Tier 1 still missed two entire
// facets (age_restriction never rendered; categories rendered raw slugs)
// because every fixture in this file nulled most fields out. A
// substring-only assertion over a fully-populated object would have caught
// neither: assertStringIncludes doesn't fail when an *extra* undocumented
// bullet silently never appears, and it wouldn't have told us "Ages:" was
// entirely absent unless we happened to assert for it. This test instead
// pins the COMPLETE rendered string for a preferences object where every
// declared Preferences field is set to a non-default, realistic value, so
// any facet that render.ts silently drops (now or in the future) fails
// this test even if nobody thought to add a bullet-specific assertion.
Deno.test('describePreferences: every Preferences field non-default -> complete pinned output', () => {
  const orgId = '55555555-5555-4555-8555-555555555555'
  const venueId = '66666666-6666-4666-8666-666666666666'
  const prefs: Preferences = {
    intents: ['date-night', 'arts-stage'],
    categories: ['music', 'food'],
    venue_ids: [venueId],
    org_ids: [orgId],
    price_max: 25,
    age_restriction: '21_plus',
    event_days: [5, 6],
    location: { mode: 'zipcode', label: '44304', radius_miles: 5 },
    keywords: ['jazz', 'trivia'],
    keywords_title_only: true,
  }
  const resolved: ResolvedNames = {
    orgNames: new Map([[orgId, 'Highland Square Neighborhood Association']]),
    venueNames: new Map([[venueId, 'Musica']]),
  }

  const out = describePreferences(prefs, resolved)

  const expected = [
    'What they asked for:',
    '• Interests: Date Night, Arts &amp; Stage',
    '• Under $25',
    '• Ages: 21+',
    '• Days: Fri, Sat',
    '• Within 5 miles of 44304',
    '• Keywords: "jazz", "trivia" (title only)',
    '• Categories: Music, Food &amp; Drink',
    '• Organizations: Highland Square Neighborhood Association',
    '• Venues: Musica',
  ].join('\n')

  assertEquals(out, expected)
})

// ── 9. Unresolvable org_ids -> "(removed organizer)", UUID never printed ──

Deno.test('describePreferences: unresolvable org_ids render placeholder, never the UUID', () => {
  const orgId = '11111111-1111-4111-8111-111111111111'
  const prefs: Preferences = { ...DEFAULT_PREFS, org_ids: [orgId] }
  const resolved: ResolvedNames = { orgNames: new Map(), venueNames: new Map() }

  const out = describePreferences(prefs, resolved)

  assertStringIncludes(out, '• Organizations: (removed organizer)')
  assertEquals(out.includes(orgId), false)
})

Deno.test('describePreferences: unresolvable venue_ids render placeholder, never the UUID', () => {
  const venueId = '22222222-2222-4222-8222-222222222222'
  const prefs: Preferences = { ...DEFAULT_PREFS, venue_ids: [venueId] }
  const resolved: ResolvedNames = { orgNames: new Map(), venueNames: new Map() }

  const out = describePreferences(prefs, resolved)

  assertStringIncludes(out, '• Venues: (removed venue)')
  assertEquals(out.includes(venueId), false)
})

// ── 10. Resolved org/venue names are escaped ──────────────────────────────

Deno.test('describePreferences: a resolved org name containing <script> is escaped', () => {
  const orgId = '33333333-3333-4333-8333-333333333333'
  const prefs: Preferences = { ...DEFAULT_PREFS, org_ids: [orgId] }
  const resolved: ResolvedNames = {
    orgNames: new Map([[orgId, '<script>alert(1)</script>']]),
    venueNames: new Map(),
  }

  const out = describePreferences(prefs, resolved)

  assertEquals(out.includes('<script>'), false)
  assertStringIncludes(out, '&lt;script&gt;alert(1)&lt;/script&gt;')
})

Deno.test('describePreferences: a resolved venue name containing & is escaped', () => {
  const venueId = '44444444-4444-4444-8444-444444444444'
  const prefs: Preferences = { ...DEFAULT_PREFS, venue_ids: [venueId] }
  const resolved: ResolvedNames = {
    orgNames: new Map(),
    venueNames: new Map([[venueId, 'Barley & Vine']]),
  }

  const out = describePreferences(prefs, resolved)

  assertStringIncludes(out, '• Venues: Barley &amp; Vine')
})

// ── 11. SECURITY REGRESSIONS — code-reviewer REQUEST CHANGES, 2026-07-26 ──
//
// `preferences` is untyped JSONB at rest: `009_subscribers.sql` grants anon
// INSERT on `subscribers` with `with check (true)`, so every fixture below
// is built with `as unknown as Preferences` on purpose — a same-shaped
// hostile fixture is the only thing that actually exercises the runtime
// guards these tests pin. A fixture built the normal (TS-checked) way could
// never construct these shapes in the first place, and the hole these tests
// close would silently reopen the next time someone "simplifies" the cast
// away.

// ── 11a. B1 — escapeSlackText gaps: Days: String(d) and the miles interpolation ──

Deno.test('SECURITY (B1): hostile event_days strings never reach the wire raw — sanitized to a valid subset', () => {
  // Byron's exact reviewer-demonstrated payload: a channel-ping smuggled in
  // as a "day of week", mixed with one real day so the bullet still renders
  // something useful instead of silently vanishing.
  const hostile = {
    ...DEFAULT_PREFS,
    event_days: [1, '<!channel>', '<https://evil.example|Reset your password>'],
  } as unknown as Preferences

  const out = describePreferences(hostile)

  assertEquals(out.includes('<'), false)
  assertEquals(out.includes('!channel'), false)
  assertEquals(out.includes('evil.example'), false)
  assertStringIncludes(out, '• Days: Mon')
})

Deno.test('SECURITY (B1): event_days entirely hostile (no valid day survives) omits the bullet instead of leaking raw text', () => {
  const hostile = {
    ...DEFAULT_PREFS,
    event_days: ['<!channel>', '<!here>'],
  } as unknown as Preferences

  const out = describePreferences(hostile)

  assertEquals(out.includes('<'), false)
  assertEquals(out.includes('Days:'), false)
})

Deno.test('SECURITY (B1): hostile radius_miles never reaches the wire raw — non-number coerces to 0', () => {
  // Byron's exact reviewer-demonstrated payload for the second sink.
  const hostile = {
    ...DEFAULT_PREFS,
    location: { mode: 'zipcode', label: '44304', radius_miles: '<!here>' },
  } as unknown as Preferences

  const out = describePreferences(hostile)

  assertEquals(out.includes('<'), false)
  assertEquals(out.includes('!here'), false)
  assertStringIncludes(out, '• Within 0 miles of 44304')
})

Deno.test('SECURITY (B1): combined exploit payload from the code-reviewer\'s report — full output contains no "<" anywhere', () => {
  // This is the literal reproduction from the review: a hostile row shaped
  // to ping the whole channel via Days AND plant a masked phishing link via
  // radius_miles in the same message.
  const hostile = {
    ...DEFAULT_PREFS,
    event_days: ['<!channel>', '<https://evil.example|Reset your password>'],
    location: { mode: 'zipcode', label: '44304', radius_miles: '<!here>' },
  } as unknown as Preferences

  const out = describePreferences(hostile)

  assertEquals(out.includes('<'), false)
  assertEquals(out.includes('>'), false)
})

// ── 11b. M3 — a renderer that touches JSONB must not be able to throw ──

const HOSTILE_ARRAY_SHAPES: { label: string; value: unknown }[] = [
  { label: 'a bare string', value: '<!channel>' },
  { label: 'a number array', value: [123] },
  { label: 'a plain object', value: { a: 1 } },
]

for (const field of ['intents', 'keywords', 'categories', 'org_ids', 'venue_ids'] as const) {
  for (const { label, value } of HOSTILE_ARRAY_SHAPES) {
    Deno.test(`SECURITY (M3): ${field} as ${label} renders without throwing`, () => {
      const hostile = { ...DEFAULT_PREFS, [field]: value } as unknown as Preferences
      // The assertion IS that this call completes at all — render.ts's own
      // contract ("a renderer that touches JSONB must not be able to
      // throw") means Deno.test would fail this case with an uncaught
      // exception if the coercion regressed, with no try/catch needed here.
      const out = describePreferences(hostile)
      assertEquals(typeof out, 'string')
      assertEquals(out.includes('<'), false)
    })
  }
}

Deno.test('SECURITY (M3): every hostile shape combined in one preferences object renders without throwing', () => {
  const hostile = {
    ...DEFAULT_PREFS,
    intents: '<!channel>',
    keywords: [123, 456],
    categories: { music: true },
    org_ids: 'not-an-array',
    venue_ids: [{ id: 'nope' }],
    event_days: 'monday',
    age_restriction: { toxic: true },
    location: 'downtown',
  } as unknown as Preferences

  const out = describePreferences(hostile)
  assertEquals(typeof out, 'string')
  assertStringIncludes(out, 'What they asked for:')
})

// ── 11c. m5 — AGE_LABEL is a prototype-reachable lookup keyed by untrusted input ──
//
// NOTE — updated for the MINOR 4 contract change (section 13d below): these
// three cases used to assert the prototype-chain value never leaked AND that
// the raw key still rendered escaped (e.g. "• Ages: constructor"). The
// render-raw half of that assertion no longer holds — unrecognized
// age_restriction values are omitted entirely now — but the prototype-chain
// non-leak property these were actually testing still must hold, so it's
// re-asserted here in its new form: omitted, not merely non-prototype-leaked.

Deno.test('SECURITY (m5): age_restriction "constructor" does not resolve Object\'s constructor via the prototype chain (and is now omitted, not rendered raw)', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: 'constructor' } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('[native code]'), false)
  assertEquals(out.includes('function'), false)
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('SECURITY (m5): age_restriction "toString" does not resolve Object.prototype.toString (and is now omitted, not rendered raw)', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: 'toString' } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('[native code]'), false)
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('SECURITY (m5): age_restriction "hasOwnProperty" does not resolve Object.prototype.hasOwnProperty (and is now omitted, not rendered raw)', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: 'hasOwnProperty' } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('[native code]'), false)
  assertEquals(out.includes('Ages:'), false)
})

// ── 11d. m6 — frequencyNoun's default branch is one dropped CHECK constraint from being a live sink ──

Deno.test('SECURITY (m6): frequencyNoun escapes an unrecognized frequency instead of passing it through raw', () => {
  assertEquals(frequencyNoun('<!channel>'), '&lt;!channel&gt;')
})

// ── 12. m7 — pin renderFeedback's full output, including the exact timestamp ──

Deno.test('renderFeedback: pinned full output including the exact America/New_York timestamp', () => {
  const out = renderFeedback({
    body: 'hello',
    page_path: '/submit',
    created_at: '2026-07-01T12:00:00Z',
  })
  const expected = [
    'New feedback from akronpulse.com',
    '',
    '> hello',
    '',
    'Page: /submit  ·  Wed, Jul 1, 2026, 8:00 AM',
  ].join('\n')
  assertEquals(out, expected)
})

// ── 13. SECURITY REGRESSIONS — code-reviewer re-review, 2026-07-27 ────────
//
// MAJOR: list facets were uncapped. `subscribe/index.ts` writes `preferences`
// with the SERVICE-ROLE client from a public, unauthenticated, un-rate-limited
// POST — so any facet here that isn't capped in both item count AND per-item
// length is a volume vector: under Slack's 40,000-char chat.postMessage limit
// it posts a wall of attacker-chosen text into the partner channel; over it,
// the send fails with msg_too_long and the dedupe key is burned permanently
// (the M3 failure mode, arriving via size instead of a throw).

// ── 13a. MAJOR — intents: huge array, huge single string ─────────────────

Deno.test('SECURITY (MAJOR): a 50,000-element intents array stays under a fixed message-length bound and still renders something useful', () => {
  const hostile = { ...DEFAULT_PREFS, intents: Array(50_000).fill('date-night') } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.length <= 3050, true)
  assertStringIncludes(out, 'Interests:')
  assertStringIncludes(out, 'Date Night')
  assertStringIncludes(out, '+49994 more')
})

Deno.test('SECURITY (MAJOR): a single 40,000-char intent string stays under the same message-length bound', () => {
  const hostile = { ...DEFAULT_PREFS, intents: ['x'.repeat(40_000)] } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.length <= 3050, true)
  assertStringIncludes(out, 'Interests:')
})

Deno.test('SECURITY (MAJOR): the exact "tuned-under-40k" payload from the code-reviewer\'s report also stays under the bound', () => {
  // The reviewer's report: a payload deliberately sized to land under Slack's
  // 40,000-char limit (so it would have posted successfully pre-fix) rather
  // than over it (which would merely fail loudly). This is the "posts a 36KB
  // wall of text" case, not the "burns the dedupe key" case.
  const hostile = { ...DEFAULT_PREFS, intents: Array(900).fill('x'.repeat(40)) } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.length <= 3050, true)
})

// ── 13b. MAJOR — per-facet caps: keywords, orgs, venues, days ────────────

Deno.test('SECURITY (MAJOR): keywords facet caps at 6 shown plus a "+N more" suffix', () => {
  const hostile = { ...DEFAULT_PREFS, keywords: Array(50_000).fill('jazz') } as unknown as Preferences
  const out = describePreferences(hostile)
  assertStringIncludes(out, '• Keywords: "jazz", "jazz", "jazz", "jazz", "jazz", "jazz" +49994 more')
})

Deno.test('SECURITY (MAJOR): a single 40,000-char keyword is clamped per-item, not rendered whole', () => {
  const hostile = { ...DEFAULT_PREFS, keywords: ['y'.repeat(40_000)] } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.length <= 3050, true)
})

Deno.test('SECURITY (MAJOR): org_ids facet caps at 6 shown even when none resolve', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`)
  const hostile = { ...DEFAULT_PREFS, org_ids: ids } as unknown as Preferences
  const out = describePreferences(hostile)
  assertStringIncludes(
    out,
    '• Organizations: (removed organizer), (removed organizer), (removed organizer), (removed organizer), (removed organizer), (removed organizer) +994 more',
  )
})

Deno.test('SECURITY (MAJOR): venue_ids facet caps at 6 shown even when none resolve', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`)
  const hostile = { ...DEFAULT_PREFS, venue_ids: ids } as unknown as Preferences
  const out = describePreferences(hostile)
  assertStringIncludes(
    out,
    '• Venues: (removed venue), (removed venue), (removed venue), (removed venue), (removed venue), (removed venue) +994 more',
  )
})

Deno.test('SECURITY (MAJOR): event_days with 200,000 entries all mapping to Sunday dedupes to a single "Sun", not 200,000 of them', () => {
  const hostile = { ...DEFAULT_PREFS, event_days: Array(200_000).fill(0) } as unknown as Preferences
  const out = describePreferences(hostile)
  assertStringIncludes(out, '• Days: Sun')
  assertEquals(out.length < 200, true)
})

Deno.test('SECURITY (MAJOR): event_days with 200,000 entries covering only Sun and Sat dedupes to the sorted distinct set', () => {
  const values = Array.from({ length: 200_000 }, (_, i) => (i % 2 === 0 ? 0 : 6))
  const hostile = { ...DEFAULT_PREFS, event_days: values } as unknown as Preferences
  const out = describePreferences(hostile)
  assertStringIncludes(out, '• Days: Sun, Sat')
  assertEquals(out.length < 200, true)
})

Deno.test('SECURITY (MAJOR): event_days with 200,000 entries cycling through all 7 values dedupes to "all days" and omits the bullet', () => {
  const values = Array.from({ length: 200_000 }, (_, i) => i % 7)
  const hostile = { ...DEFAULT_PREFS, event_days: values } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Days:'), false)
})

// ── 13c. MINOR 3 — describePreferences must not throw on a null/non-object prefs value ──

Deno.test('SECURITY (MINOR 3): describePreferences(null) does not throw and renders the default bullet', () => {
  const out = describePreferences(null)
  assertEquals(out, 'What they asked for:\n• Interests: Everything happening in Akron')
})

Deno.test('SECURITY (MINOR 3): describePreferences(undefined) does not throw and renders the default bullet', () => {
  const out = describePreferences(undefined)
  assertEquals(out, 'What they asked for:\n• Interests: Everything happening in Akron')
})

Deno.test('SECURITY (MINOR 3): describePreferences([]) (a JSONB array, not an object) does not throw and renders the default bullet', () => {
  const out = describePreferences([] as unknown as Preferences)
  assertEquals(out, 'What they asked for:\n• Interests: Everything happening in Akron')
})

// ── 13d. MINOR 4 — an unrecognized age_restriction is omitted, never dumped as JSON ──

Deno.test('SECURITY (MINOR 4): age_restriction as a plain object is omitted, not JSON.stringify-dumped', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: { a: { b: '<!channel>' } } } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Ages:'), false)
  assertEquals(out.includes('{'), false)
  assertEquals(out.includes('<!channel>'), false)
})

Deno.test('SECURITY (MINOR 4): age_restriction as an array is omitted, not JSON.stringify-dumped', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: ['<!channel>'] } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Ages:'), false)
  assertEquals(out.includes('['), false)
})

Deno.test('SECURITY (MINOR 4): age_restriction as a boolean is omitted', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: true } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('SECURITY (MINOR 4): age_restriction as a number is omitted', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: 42 } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('SECURITY (MINOR 4): an unrecognized age_restriction STRING is now omitted too (contract change from "still renders raw")', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, age_restriction: 'some-future-value' })
  assertEquals(out.includes('Ages:'), false)
})

Deno.test('SECURITY (MINOR 4): age_restriction "constructor" is omitted (was previously rendered raw as "Ages: constructor")', () => {
  const hostile = { ...DEFAULT_PREFS, age_restriction: 'constructor' } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Ages:'), false)
  assertEquals(out.includes('[native code]'), false)
})

// ── 13e. NIT — price_max Infinity / 1e21 ──────────────────────────────────

Deno.test('NIT: price_max Infinity omits the bullet instead of rendering "Under $Infinity"', () => {
  const hostile = { ...DEFAULT_PREFS, price_max: Infinity } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Infinity'), false)
  assertEquals(out.includes('Under $'), false)
})

Deno.test('NIT: price_max -Infinity also omits the bullet', () => {
  const hostile = { ...DEFAULT_PREFS, price_max: -Infinity } as unknown as Preferences
  const out = describePreferences(hostile)
  assertEquals(out.includes('Infinity'), false)
})

Deno.test('NIT: price_max 1e21 renders without JS scientific notation', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, price_max: 1e21 })
  assertEquals(out.includes('e+'), false)
  assertStringIncludes(out, '• Under $1,000,000,000,000,000,000,000')
})

Deno.test('NIT: price_max 25 (realistic value) is unaffected by the toLocaleString change', () => {
  const out = describePreferences({ ...DEFAULT_PREFS, price_max: 25 })
  assertStringIncludes(out, '• Under $25')
})

Deno.test('renderFeedback: DST spring-forward edge (2026-03-08, America/New_York 2am -> 3am) renders the correct offset either side of the jump', () => {
  // 2026-03-08 06:59 UTC is 1:59 AM EST (UTC-5, still standard time).
  // 2026-03-08 07:00 UTC is the first instant of 3:00 AM EDT (UTC-4) — the
  // wall clock skips 2:00-2:59 AM entirely. Picking timestamps 30 minutes
  // either side of that boundary pins that fmtDateTimeET resolves the
  // correct UTC offset on both sides, not just "some" offset that happens
  // to look plausible.
  const before = renderFeedback({ body: 'x', page_path: null, created_at: '2026-03-08T06:30:00Z' })
  const after = renderFeedback({ body: 'x', page_path: null, created_at: '2026-03-08T07:30:00Z' })
  assertStringIncludes(before, 'Sun, Mar 8, 2026, 1:30 AM')
  assertStringIncludes(after, 'Sun, Mar 8, 2026, 3:30 AM')
})

// ── 14. SECURITY REGRESSIONS — code-reviewer re-review round 3, 2026-07-27 ──
//
// MAJOR: MAX_MESSAGE_LEN only ever bounded describePreferences's own return
// value, not the fully-assembled message any renderer actually sends to
// Slack. Two free-text fields reached the wire completely uncapped:
// subscriber `email` (renderSignup, renderConfirmed) and feedback
// `page_path` (renderFeedback) — neither goes through capList, and neither
// had a clamp of its own. The fix is structural: `capMessage` is now called
// at the exit of every renderer in this file, not just describePreferences.
// The upper bound on ANY renderer's output is MAX_MESSAGE_LEN +
// TRUNCATION_MARKER.length — computed from the real exported constants
// below, never hardcoded, so a future change to either constant can't make
// this test suite quietly assert a stale ceiling.

const MAX_RENDERED_LEN = MAX_MESSAGE_LEN + TRUNCATION_MARKER.length

Deno.test('SECURITY (MAJOR): MAX_RENDERED_LEN is derived from the real exported constants, not hardcoded', () => {
  // Pins the derivation itself, not a magic number — if MAX_MESSAGE_LEN or
  // TRUNCATION_MARKER ever change, this test (and every test below that
  // uses MAX_RENDERED_LEN) automatically re-derives the new ceiling instead
  // of silently asserting a stale one.
  assertEquals(MAX_RENDERED_LEN, MAX_MESSAGE_LEN + TRUNCATION_MARKER.length)
})

// ── 14a. A 100,000-char email / page_path is bounded, per renderer ───────

Deno.test('SECURITY (MAJOR, renderSignup): a 100,000-char email cannot grow the message past MAX_RENDERED_LEN', () => {
  const out = renderSignup({
    email: `${'&'.repeat(100_000)}@example.com`,
    frequency: 'weekly',
    lookahead_days: 7,
    preferences: DEFAULT_PREFS,
  })
  assertEquals(out.length <= MAX_RENDERED_LEN, true)
  assertStringIncludes(out, 'has signed up to receive')
})

Deno.test('SECURITY (MAJOR, renderFeedback): a 100,000-char page_path cannot grow the message past MAX_RENDERED_LEN', () => {
  const out = renderFeedback({
    body: 'hello',
    page_path: '&'.repeat(100_000),
    created_at: '2026-07-01T12:00:00Z',
  })
  assertEquals(out.length <= MAX_RENDERED_LEN, true)
  assertStringIncludes(out, 'New feedback from akronpulse.com')
})

Deno.test('SECURITY (MAJOR, renderConfirmed): a 100,000-char email cannot grow the message past MAX_RENDERED_LEN', () => {
  const out = renderConfirmed(`${'&'.repeat(100_000)}@example.com`)
  assertEquals(out.length <= MAX_RENDERED_LEN, true)
  assertStringIncludes(out, 'has confirmed their subscription!')
})

// ── 14b. A test per renderer proving each is independently bounded ───────
//
// The point of these three tests, together, is that EVERY renderer this
// file exports is proven bounded on its own, not just describePreferences.
// A future renderer added to this file without its own capMessage call
// would have no equivalent test here passing for it — that absence is
// exactly what should prompt whoever adds it to notice the missing call.

Deno.test('BOUNDED: renderSignup output is always <= MAX_RENDERED_LEN, even with a maximally hostile subscriber', () => {
  const out = renderSignup({
    email: `${'x'.repeat(100_000)}@example.com`,
    frequency: '<!channel>'.repeat(10_000),
    lookahead_days: 999_999,
    preferences: {
      intents: Array(50_000).fill('x'.repeat(1000)),
      categories: Array(50_000).fill('x'.repeat(1000)),
      venue_ids: Array(50_000).fill('x'.repeat(1000)),
      org_ids: Array(50_000).fill('x'.repeat(1000)),
      price_max: 1e21,
      age_restriction: 'x'.repeat(1000),
      event_days: Array(200_000).fill(0),
      location: { mode: 'zipcode', label: 'x'.repeat(100_000), radius_miles: 5 },
      keywords: Array(50_000).fill('x'.repeat(1000)),
      keywords_title_only: true,
    } as unknown as Preferences,
  })
  assertEquals(out.length <= MAX_RENDERED_LEN, true)
})

Deno.test('BOUNDED: renderFeedback output is always <= MAX_RENDERED_LEN, even with a maximally hostile feedback row', () => {
  const out = renderFeedback({
    body: 'y'.repeat(1_000_000),
    page_path: 'x'.repeat(1_000_000),
    created_at: '2026-07-01T12:00:00Z',
  })
  assertEquals(out.length <= MAX_RENDERED_LEN, true)
})

Deno.test('BOUNDED: renderConfirmed output is always <= MAX_RENDERED_LEN, even with a maximally hostile email', () => {
  const out = renderConfirmed('x'.repeat(1_000_000))
  assertEquals(out.length <= MAX_RENDERED_LEN, true)
})

// ── 14c. capMessage itself — the shared backstop ──────────────────────────

Deno.test('capMessage: a string at exactly MAX_MESSAGE_LEN is not truncated', () => {
  const s = 'x'.repeat(MAX_MESSAGE_LEN)
  const out = capMessage(s)
  assertEquals(out, s)
  assertEquals(out.length, MAX_MESSAGE_LEN)
})

Deno.test('capMessage: a string one char over MAX_MESSAGE_LEN is truncated with the marker appended', () => {
  const s = 'x'.repeat(MAX_MESSAGE_LEN + 1)
  const out = capMessage(s)
  assertEquals(out, 'x'.repeat(MAX_MESSAGE_LEN) + TRUNCATION_MARKER)
  assertEquals(out.length, MAX_RENDERED_LEN)
})

Deno.test('capMessage: a huge string never exceeds MAX_RENDERED_LEN', () => {
  const out = capMessage('z'.repeat(10_000_000))
  assertEquals(out.length, MAX_RENDERED_LEN)
})

// ── 14d. MINOR 2 — surrogate-pair boundary: slicing must never split an emoji ──
//
// A lone (unpaired) UTF-16 surrogate in the output is what Slack renders as
// U+FFFD ("�"). This helper detects one; every test below asserts its
// absence, which fails if `.slice()` (UTF-16 code unit based) ever
// regresses back in for any of these four sites in place of the
// code-point-based `[...s].slice()` clamp.
function hasLoneSurrogate(s: string): boolean {
  // deno-lint-ignore no-control-regex
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
}

const EMOJI = '\u{1F4A9}' // U+1F4A9 PILE OF POO — a real surrogate-pair character (2 UTF-16 code units).

Deno.test('sanity: hasLoneSurrogate correctly detects a deliberately-broken surrogate pair', () => {
  const broken = 'a'.repeat(58) + EMOJI[0] // the high surrogate alone, no low surrogate following.
  assertEquals(hasLoneSurrogate(broken), true)
  assertEquals(hasLoneSurrogate('a'.repeat(58) + EMOJI + 'ZZZ'), false)
})

Deno.test('SECURITY (MINOR 2): keywords facet — emoji at the capList item clamp boundary is never split', () => {
  // toLabel wraps the raw keyword in quotes (`"${k}"`) before clampLabel
  // clamps to ITEM_MAX_LEN(60) code points, so the leading `"` shifts the
  // emoji's position by one relative to the raw keyword. 58 'a's + EMOJI
  // lands the emoji as the 60th code point of the quoted string — exactly
  // at the naive UTF-16 slice(0,60) boundary that used to split it.
  const keyword = 'a'.repeat(58) + EMOJI + 'ZZZ'
  const out = describePreferences({ ...DEFAULT_PREFS, keywords: [keyword] })
  assertEquals(hasLoneSurrogate(out), false)
  assertStringIncludes(out, EMOJI)
})

Deno.test('SECURITY (MINOR 2): categories facet — emoji at the capList item clamp boundary is never split', () => {
  // Categories render the raw slug with no wrapping (unlike keywords), so
  // the emoji needs to sit one code point later than the keywords case to
  // land at the same clamp boundary: 59 'a's + EMOJI is the 60th code point.
  const slug = 'a'.repeat(59) + EMOJI + 'ZZZ'
  const out = describePreferences({ ...DEFAULT_PREFS, categories: [slug] })
  assertEquals(hasLoneSurrogate(out), false)
  assertStringIncludes(out, EMOJI)
})

Deno.test('SECURITY (MINOR 2): location label — emoji at the clampLabel boundary is never split', () => {
  const label = 'a'.repeat(59) + EMOJI + 'ZZZ'
  const out = describePreferences({
    ...DEFAULT_PREFS,
    location: { mode: 'area', label },
  })
  assertEquals(hasLoneSurrogate(out), false)
  assertStringIncludes(out, EMOJI)
})

Deno.test('SECURITY (MINOR 2): capMessage — emoji at exactly the MAX_MESSAGE_LEN boundary is never split', () => {
  // MAX_MESSAGE_LEN-1 'x's (all single UTF-16 units) + EMOJI lands the emoji
  // as the MAX_MESSAGE_LEN-th code point — exactly the naive UTF-16
  // slice(0, MAX_MESSAGE_LEN) boundary that used to cut through its
  // surrogate pair (high surrogate kept, low surrogate dropped).
  const s = 'x'.repeat(MAX_MESSAGE_LEN - 1) + EMOJI + 'YYY'
  const out = capMessage(s)
  assertEquals(hasLoneSurrogate(out), false)
  assertStringIncludes(out, EMOJI)
  assertEquals(out, 'x'.repeat(MAX_MESSAGE_LEN - 1) + EMOJI + TRUNCATION_MARKER)
})

Deno.test('SECURITY (MINOR 2): email — emoji at the clampLabel boundary in renderSignup is never split', () => {
  const email = `${'a'.repeat(59)}${EMOJI}ZZZ@example.com`
  const out = renderSignup({
    email,
    frequency: 'weekly',
    lookahead_days: 7,
    preferences: DEFAULT_PREFS,
  })
  assertEquals(hasLoneSurrogate(out), false)
})

Deno.test('SECURITY (MINOR 2): page_path — emoji at the clampLabel boundary in renderFeedback is never split', () => {
  const pagePath = 'a'.repeat(59) + EMOJI + 'ZZZ'
  const out = renderFeedback({ body: 'hello', page_path: pagePath, created_at: '2026-07-01T12:00:00Z' })
  assertEquals(hasLoneSurrogate(out), false)
})
