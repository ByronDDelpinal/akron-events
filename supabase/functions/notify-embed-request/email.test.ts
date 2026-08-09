// email.test.ts — Deno tests for notify-embed-request/email.ts.
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
//
// linkifyWebsite is the sharpest injection risk in the whole embed-request
// feature (docs/embed-request-capture.md §4.5): an anon-supplied string
// turning into a clickable <a href> in the maintainer's inbox is a working
// phishing primitive. These are the allow/deny cases the task explicitly
// requires coverage for.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { normalizeConfig } from '../_shared/embedSnippet.ts'
import {
  linkifyWebsite,
  sanitizeSubjectPart,
  buildEmbedRequestEmailHtml,
  buildEmbedRequestEmailText,
  type EmbedRequestEmailRow,
} from './email.ts'

// ── linkifyWebsite: ALLOW cases ─────────────────────────────────────────

Deno.test('linkifyWebsite ALLOW: https URL becomes a link', () => {
  const out = linkifyWebsite('https://example.org/calendar')
  assertEquals(out.href, 'https://example.org/calendar')
  assertEquals(out.label, 'https://example.org/calendar')
})

Deno.test('linkifyWebsite ALLOW: http URL becomes a link', () => {
  const out = linkifyWebsite('http://example.org')
  assertEquals(out.href, 'http://example.org/')
  assertEquals(out.label, 'http://example.org')
})

Deno.test('linkifyWebsite ALLOW: https URL with path, query, and fragment becomes a link', () => {
  const out = linkifyWebsite('https://example.org/events?utm=1#section')
  assertEquals(out.href, 'https://example.org/events?utm=1#section')
})

// ── linkifyWebsite: DENY cases ──────────────────────────────────────────

Deno.test('linkifyWebsite DENY: not provided (null) renders "Not provided", no link', () => {
  const out = linkifyWebsite(null)
  assertEquals(out.href, null)
  assertEquals(out.label, 'Not provided')
})

Deno.test('linkifyWebsite DENY: javascript: protocol never becomes a link', () => {
  const out = linkifyWebsite('javascript:alert(1)')
  assertEquals(out.href, null)
  assertEquals(out.label, 'javascript:alert(1)')
})

Deno.test('linkifyWebsite DENY: data: protocol never becomes a link', () => {
  const out = linkifyWebsite('data:text/html,<script>alert(1)</script>')
  assertEquals(out.href, null)
})

Deno.test('linkifyWebsite DENY: file: protocol never becomes a link', () => {
  const out = linkifyWebsite('file:///etc/passwd')
  assertEquals(out.href, null)
})

Deno.test('linkifyWebsite DENY: mailto: protocol never becomes a link (only http/https are allowed)', () => {
  const out = linkifyWebsite('mailto:someone@example.com')
  assertEquals(out.href, null)
})

Deno.test('linkifyWebsite DENY: a bare/malformed string (no scheme) never becomes a link', () => {
  const out = linkifyWebsite('not a url at all')
  assertEquals(out.href, null)
  assertEquals(out.label, 'not a url at all')
})

Deno.test('linkifyWebsite DENY: an empty string is treated as not provided', () => {
  const out = linkifyWebsite('')
  assertEquals(out.href, null)
  assertEquals(out.label, 'Not provided')
})

// ── QA REGRESSION (FINDING B): userinfo-authority phishing ───────────────
//
// `https://akronpulse.com@evil.com/phish` passes both a protocol check
// (https:) and (pre-fix) a `new URL(...)` parse, and used to become a
// clickable link — the classic `trusted@evil-host` spoof: the maintainer
// sees "akronpulse.com" up front and reasonably assumes it names the
// destination, but the link actually navigates to evil.com. These cases
// must render as escaped plain text, never a link.

Deno.test('linkifyWebsite DENY: userinfo-authority phishing (trusted-looking username@evil host) never becomes a link', () => {
  const out = linkifyWebsite('https://akronpulse.com@evil.com/phish')
  assertEquals(out.href, null)
  assertEquals(out.label, 'https://akronpulse.com@evil.com/phish')
})

Deno.test('linkifyWebsite DENY: userinfo with both username and password never becomes a link', () => {
  const out = linkifyWebsite('https://user:pass@evil.com')
  assertEquals(out.href, null)
})

Deno.test('linkifyWebsite DENY: bare userinfo (no password) still never becomes a link', () => {
  const out = linkifyWebsite('https://user@evil.com')
  assertEquals(out.href, null)
})

Deno.test('linkifyWebsite DENY: userinfo phishing over plain http: is also rejected', () => {
  const out = linkifyWebsite('http://akronpulse.com@evil.com')
  assertEquals(out.href, null)
})

Deno.test('linkifyWebsite ALLOW: a benign URL with an "@" in the path still linkifies', () => {
  const out = linkifyWebsite('https://example.org/team/@handle')
  assertEquals(out.href, 'https://example.org/team/@handle')
})

Deno.test('linkifyWebsite ALLOW: a benign URL with an "@" in the query string still linkifies', () => {
  const out = linkifyWebsite('https://example.org/search?q=hello@world')
  assertEquals(out.href, 'https://example.org/search?q=hello@world')
})

Deno.test('buildEmbedRequestEmailHtml: a userinfo-authority phishing website renders as escaped plain text, not a clickable link', () => {
  const row: EmbedRequestEmailRow = {
    name: 'Jordan',
    email: 'jordan@example.com',
    organization: 'Highland Square Neighbors',
    website: 'https://akronpulse.com@evil.com/phish',
    note: null,
    created_at: '2026-08-07T12:00:00Z',
  }
  const cfg = normalizeConfig({})
  const html = buildEmbedRequestEmailHtml({ row, cfg, snippet: '<iframe src="x"></iframe>', url: 'https://akronpulse.com/embed' })
  assert(!html.includes('href="https://akronpulse.com@evil.com/phish"'), 'a userinfo-authority URL must never be rendered as a live link')
  // Still visible as escaped text so the operator can see the raw value.
  assertStringIncludes(html, 'akronpulse.com@evil.com/phish')
})

// ── linkifyWebsite: rendered into HTML never produces a live link for a denied case ──

Deno.test('buildEmbedRequestEmailHtml: a javascript: website renders as escaped plain text, not a clickable link', () => {
  const row: EmbedRequestEmailRow = {
    name: 'Jordan',
    email: 'jordan@example.com',
    organization: 'Highland Square Neighbors',
    website: 'javascript:alert(document.cookie)',
    note: null,
    created_at: '2026-08-07T12:00:00Z',
  }
  const cfg = normalizeConfig({})
  const html = buildEmbedRequestEmailHtml({ row, cfg, snippet: '<iframe src="x"></iframe>', url: 'https://akronpulse.com/embed' })
  // The dangerous scheme must never appear inside an href attribute.
  assert(!html.includes('href="javascript:'), 'a javascript: URL must never be rendered as a live link')
  // It should still be visible as escaped text so the operator can see it.
  assertStringIncludes(html, 'javascript:alert(document.cookie)')
})

Deno.test('buildEmbedRequestEmailHtml: an https: website renders as a clickable link', () => {
  const row: EmbedRequestEmailRow = {
    name: 'Jordan',
    email: 'jordan@example.com',
    organization: 'Highland Square Neighbors',
    website: 'https://highlandsquare.example.org',
    note: null,
    created_at: '2026-08-07T12:00:00Z',
  }
  const cfg = normalizeConfig({})
  const html = buildEmbedRequestEmailHtml({ row, cfg, snippet: '<iframe src="x"></iframe>', url: 'https://akronpulse.com/embed' })
  assertStringIncludes(html, 'href="https://highlandsquare.example.org/"')
})

Deno.test('buildEmbedRequestEmailHtml: website not provided renders "Not provided" text', () => {
  const row: EmbedRequestEmailRow = {
    name: 'Jordan',
    email: 'jordan@example.com',
    organization: 'Highland Square Neighbors',
    website: null,
    note: null,
    created_at: '2026-08-07T12:00:00Z',
  }
  const cfg = normalizeConfig({})
  const html = buildEmbedRequestEmailHtml({ row, cfg, snippet: '<iframe src="x"></iframe>', url: 'https://akronpulse.com/embed' })
  assertStringIncludes(html, 'Not provided')
})

// ── sanitizeSubjectPart ──────────────────────────────────────────────────

Deno.test('sanitizeSubjectPart: strips control characters', () => {
  const out = sanitizeSubjectPart('Highland\x00Square\x1F Neighbors')
  assertEquals(out, 'HighlandSquare Neighbors')
})

Deno.test('sanitizeSubjectPart: clamps to 78 code points with an ellipsis', () => {
  const out = sanitizeSubjectPart('x'.repeat(200))
  assertEquals([...out].length, 79) // 78 chars + the ellipsis marker
  assert(out.endsWith('…'))
})

Deno.test('sanitizeSubjectPart: ordinary text passes through unchanged', () => {
  assertEquals(sanitizeSubjectPart('Highland Square Neighbors'), 'Highland Square Neighbors')
})

// ── HTML escaping in the email body ──────────────────────────────────────

Deno.test('buildEmbedRequestEmailHtml: hostile name/organization/note are escaped, not rendered as tags', () => {
  const row: EmbedRequestEmailRow = {
    name: '<img src=x onerror=alert(1)>',
    email: 'jordan@example.com',
    organization: '</td></tr></table><script>alert(1)</script>',
    website: null,
    note: '<b>bold note</b>',
    created_at: '2026-08-07T12:00:00Z',
  }
  const cfg = normalizeConfig({})
  const html = buildEmbedRequestEmailHtml({ row, cfg, snippet: '<iframe src="x"></iframe>', url: 'https://akronpulse.com/embed' })
  assert(!html.includes('<img src=x onerror=alert(1)>'))
  assert(!html.includes('<script>alert(1)</script>'))
  assert(!html.includes('<b>bold note</b>'))
  assertStringIncludes(html, '&lt;img src=x onerror=alert(1)&gt;')
  assertStringIncludes(html, '&lt;script&gt;alert(1)&lt;/script&gt;')
})

// ── Plain-text alternative ────────────────────────────────────────────────

Deno.test('buildEmbedRequestEmailText: carries the summary, URL, and snippet', () => {
  const row: EmbedRequestEmailRow = {
    name: 'Jordan',
    email: 'jordan@example.com',
    organization: 'Highland Square Neighbors',
    website: 'https://highlandsquare.example.org',
    note: 'Please make it teal.',
    created_at: '2026-08-07T12:00:00Z',
  }
  const cfg = normalizeConfig({ place: 'highland-square' })
  const text = buildEmbedRequestEmailText({ row, cfg, snippet: '<iframe src="x"></iframe>', url: 'https://akronpulse.com/embed?place=highland-square' })
  assertStringIncludes(text, 'Highland Square Neighbors')
  assertStringIncludes(text, 'https://akronpulse.com/embed?place=highland-square')
  assertStringIncludes(text, '<iframe src="x"></iframe>')
  assertStringIncludes(text, 'Please make it teal.')
})
