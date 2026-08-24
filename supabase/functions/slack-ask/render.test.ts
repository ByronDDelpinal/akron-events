/**
 * render.test.ts: Deno tests for the reply caps, the truncation, and the
 * formatting primitives.
 *
 * Run: `deno test supabase/functions/slack-ask/`.
 *
 * Same posture as _shared/slack.test.ts: no network, no database, no env vars.
 * Everything here is a pure function of its arguments.
 *
 * The truncation tests are the ones that matter. A reply is assembled from
 * already-escaped text, so a naive `slice()` can cut `&amp;` into `&am` and
 * leave Slack rendering garbage in the one message the reader was going to
 * act on.
 */

import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  capLines,
  composeReply,
  deltaPhrase,
  ELLIPSIS,
  errorSnippet,
  esc,
  etStamp,
  GA_FLOOR_NOTE,
  gaNum,
  hoursAgo,
  MAX_REPLY_CHARS,
  MAX_REPLY_LINES,
  plural,
  rankTally,
  shortEscaped,
  tallyLine,
} from './render.ts'
import { MENU_LINES } from './handlers.ts'

// ── Escaping ──────────────────────────────────────────────────────────────

Deno.test('esc applies the Slack escape contract, ampersand first', () => {
  assertEquals(esc('Barnes & Noble'), 'Barnes &amp; Noble')
  assertEquals(esc('<!channel>'), '&lt;!channel&gt;')
  assertEquals(esc('<@U123>'), '&lt;@U123&gt;')
  // No double-encoding: the & produced by &lt; must not be re-escaped.
  assertEquals(esc('a<b&c>d'), 'a&lt;b&amp;c&gt;d')
})

Deno.test('esc never emits the string "undefined"', () => {
  assertEquals(esc(null), '(none)')
  assertEquals(esc(undefined), '(none)')
  assertEquals(esc(0), '0')
  assertEquals(esc(false), 'false')
})

Deno.test('escaping makes a broadcast structurally impossible', () => {
  // Same guarantee README:128 makes for Tier 2. A scraper error string
  // containing a mention cannot become a mention.
  const hostile = 'timeout contacting <!channel> see <@U0FAKE> and <https://evil.test|click>'
  const out = esc(hostile)
  assertEquals(out.includes('<'), false)
  assertEquals(out.includes('>'), false)
})

Deno.test('errorSnippet flattens, clips, THEN escapes third-party text', () => {
  assertEquals(errorSnippet('  proxy   403\n  forbidden '), 'proxy 403 forbidden')
  assertEquals(errorSnippet(null), 'no detail')
  assertEquals(errorSnippet(''), 'no detail')
  assertEquals(errorSnippet('   '), 'no detail')
  // Clipping happens on the RAW string, so an entity can never be halved.
  const clipped = errorSnippet('&'.repeat(50), 10)
  assertEquals(clipped, `${'&amp;'.repeat(9)}${ELLIPSIS}`)
  assertEquals(clipped.includes('&am '), false)
})

Deno.test('shortEscaped clips long titles and keeps the escape contract', () => {
  assertEquals(shortEscaped('Short Title'), 'Short Title')
  assertEquals(shortEscaped(null), '(untitled)')
  assertEquals(shortEscaped('Tom & Jerry'), 'Tom &amp; Jerry')
  const long = shortEscaped('x'.repeat(100), 20)
  assertEquals(long.length, 20)
  assertEquals(long.endsWith(ELLIPSIS), true)
})

// ── Small formatters ──────────────────────────────────────────────────────

Deno.test('plural', () => {
  assertEquals(plural(0, 'event'), '0 events')
  assertEquals(plural(1, 'event'), '1 event')
  assertEquals(plural(2, 'event'), '2 events')
  assertEquals(plural(1, 'scraper is', 'scrapers are'), '1 scraper is')
})

Deno.test('gaNum marks every GA figure as a floor', () => {
  // The tilde is the load-bearing character. GA4 under-counts by an unknown
  // margin (blocked beacons), so `573` is a claim the data cannot support and
  // `~573` is one it can.
  assertEquals(gaNum(573), '~573')
  assertEquals(gaNum(0), '~0')
  // Grouped, and pinned to en-US so identical data always renders identically.
  assertEquals(gaNum(2431), '~2,431')
  assertEquals(gaNum(1234567), '~1,234,567')
  // A fraction is rounded, never printed with a decimal tail no measurement
  // supports.
  assertEquals(gaNum(171.7), '~172')
  // Junk becomes a visible zero, never "NaN" or "undefined".
  for (const junk of [null, undefined, 'abc', NaN, Infinity]) {
    assertEquals(gaNum(junk), '~0', `gaNum(${String(junk)})`)
  }
  // Negative is impossible from a count, and would read as a real finding.
  assertEquals(gaNum(-5), '~0')
})

Deno.test('the floor note is one short constant, identical every time', () => {
  // Identical wording every time is what lets a regular reader stop parsing
  // it. A caveat that is phrased differently per handler reads as new
  // information and becomes noise.
  assertStringIncludes(GA_FLOOR_NOTE, '~')
  assertStringIncludes(GA_FLOOR_NOTE, 'floor')
  // It has to be cheap: one line of six, and a small slice of 600 characters.
  assertEquals(GA_FLOOR_NOTE.includes('\n'), false)
  assertEquals(GA_FLOOR_NOTE.length <= 70, true)
})

Deno.test('deltaPhrase never turns a zero baseline into an infinite rise', () => {
  assertEquals(deltaPhrase(115, 100), 'up 15%')
  assertEquals(deltaPhrase(92, 100), 'down 8%')
  assertEquals(deltaPhrase(100, 100), 'flat')
  // Rounding, not a decimal tail.
  assertEquals(deltaPhrase(1004, 1000), 'flat')
  // "up 100%" from nothing is a number people repeat and it means nothing.
  assertEquals(deltaPhrase(50, 0), 'new')
  assertEquals(deltaPhrase(0, 0), '')
  assertEquals(deltaPhrase(NaN, 100), '')
})

Deno.test('rankTally sorts by count then alphabetically, so it is stable', () => {
  const counts = new Map([['b', 3], ['a', 3], ['c', 9]])
  assertEquals(rankTally(counts), [['c', 9], ['a', 3], ['b', 3]])
  // Same input, same output, every time.
  assertEquals(rankTally(counts), rankTally(counts))
})

Deno.test('tallyLine renders the compact breakdown and escapes labels', () => {
  assertEquals(tallyLine([['Eventbrite', 12], ['Akron Civic', 6]]), 'Eventbrite 12, Akron Civic 6')
  assertEquals(tallyLine([['A & B', 1]]), 'A &amp; B 1')
  assertEquals(tallyLine([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]], 2), 'a 1, b 2')
})

Deno.test('etStamp renders Eastern time, dropping the date when it is today', () => {
  // 2026-08-26T21:00Z is 5:00pm EDT on the 26th.
  assertEquals(etStamp('2026-08-26T21:00:00Z', '2026-08-26'), '5:00pm')
  assertEquals(etStamp('2026-08-26T21:00:00Z', '2026-08-27'), 'Aug 26 5:00pm')
  // Winter, EST.
  assertEquals(etStamp('2026-01-15T22:02:00Z', '2026-01-15'), '5:02pm')
  assertEquals(etStamp(null, '2026-08-26'), 'unknown')
  assertEquals(etStamp('not a date', '2026-08-26'), 'unknown')
})

Deno.test('etStamp never renders the UTC hour', () => {
  // 03:30Z on 15 Mar is 11:30pm ET on the 14th. Rendering "3:30am" here would
  // be the same class of bug as a UTC "today".
  assertEquals(etStamp('2026-03-15T03:30:00Z', '2026-03-14'), '11:30pm')
})

Deno.test('hoursAgo floors, clamps at zero, and survives junk', () => {
  const now = new Date('2026-08-26T16:00:00Z')
  assertEquals(hoursAgo('2026-08-26T13:30:00Z', now), 2)
  assertEquals(hoursAgo('2026-08-26T16:00:00Z', now), 0)
  assertEquals(hoursAgo('2026-08-27T16:00:00Z', now), 0) // future clamps to 0
  assertEquals(hoursAgo(null, now), null)
  assertEquals(hoursAgo('nonsense', now), null)
})

// ── The caps ──────────────────────────────────────────────────────────────

Deno.test('capLines drops blank lines and collapses internal whitespace', () => {
  assertEquals(capLines(['a', '', '  ', ' b   c ']), ['a', 'b c'])
})

Deno.test('capLines keeps six lines and reports what it dropped', () => {
  const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
  const out = capLines(nine)
  assertEquals(out.length, MAX_REPLY_LINES)
  assertEquals(out[MAX_REPLY_LINES - 1], '+4 more')
  // Silent truncation is the failure mode: a reader must never conclude only
  // five scrapers are broken because the sixth line vanished.
  assertEquals(out.slice(0, 5), ['1', '2', '3', '4', '5'])
})

Deno.test('capLines leaves a short reply untouched', () => {
  assertEquals(capLines(['one', 'two']), ['one', 'two'])
})

Deno.test('truncation refuses to cut inside an escape sequence', () => {
  // The line is built so that a naive slice lands mid-`&amp;`.
  const line = `${'x'.repeat(MAX_REPLY_CHARS - 3)}&amp;tail`
  const out = composeReply([line])
  assertEquals(out.length <= MAX_REPLY_CHARS, true)
  assertEquals(/&(?!amp;|lt;|gt;)/.test(out), false, 'emitted a bare or half-written ampersand')
  assertEquals(out.includes('&am'), false)
  assertEquals(out.includes('&a'), false)
})

Deno.test('truncation handles a run of entities at the boundary', () => {
  const out = composeReply(['&amp;'.repeat(400)])
  assertEquals(out.length <= MAX_REPLY_CHARS, true)
  // Every ampersand still opens a complete entity.
  assertEquals(out.replace(/&amp;/g, '').includes('&'), false)
})

Deno.test('truncation does not split a surrogate pair', () => {
  const out = composeReply(['a'.repeat(MAX_REPLY_CHARS - 2) + '\u{1F600}' + 'b'.repeat(20)])
  assertEquals(out.length <= MAX_REPLY_CHARS, true)
  assertEquals(out.includes('�'), false)
  // No lone surrogate survived.
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = out.charCodeAt(i + 1)
      assertEquals(next >= 0xdc00 && next <= 0xdfff, true, 'lone high surrogate at end')
    }
  }
})

Deno.test('composeReply enforces both caps together', () => {
  const long = Array.from({ length: 20 }, (_, i) => `line ${i} ${'y'.repeat(80)}`)
  const out = composeReply(long)
  assertEquals(out.length <= MAX_REPLY_CHARS, true)
  assertEquals(out.split('\n').length <= MAX_REPLY_LINES, true)
})

Deno.test('composeReply leaves a normal answer exactly as written', () => {
  // The shape from the ADR's worked example. A reply inside the caps must not
  // be reformatted, reordered, or have an ellipsis added.
  const lines = ['47 events Fri-Sun. Prior 3d: 41.', 'Eventbrite 12, Akron Civic 6, Akron Library 5']
  assertEquals(composeReply(lines), lines.join('\n'))
})

Deno.test('composeReply never returns an empty string', () => {
  assertEquals(composeReply([]), 'No answer produced.')
  assertEquals(composeReply(['', '   ']), 'No answer produced.')
})

Deno.test('the no_match menu fits inside the caps', () => {
  // The menu exists to teach the phrasing. A menu that gets truncated teaches
  // half a phrasing, which is worse than none.
  const out = composeReply([...MENU_LINES])
  assertEquals(out.split('\n').length <= MAX_REPLY_LINES, true)
  assertEquals(out.length <= MAX_REPLY_CHARS, true)
  assertEquals(out.includes(ELLIPSIS), false, 'the menu was truncated')
  assertEquals(out.includes('+'), false, 'the menu lost a line')
  assertStringIncludes(out, 'scrapers?')
  assertStringIncludes(out, 'status')
})
