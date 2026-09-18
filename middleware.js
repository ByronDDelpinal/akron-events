/**
 * middleware.js — runs at the Vercel Edge before every matched request.
 *
 * Detects link-unfurler and search/AI crawler User-Agents. When such a
 * client requests an event detail URL, rewrites it to the preview
 * function at /api/preview/event/[id], which returns SSR'd HTML with
 * event-specific title, description, OpenGraph, and Twitter Card tags.
 *
 * Real users (browsers) are no-op'd — they keep getting the SPA from
 * the catch-all rewrite in vercel.json, with React hydrating as normal.
 *
 * Why this exists: react-helmet-async sets meta tags AFTER JS runs, but
 * link unfurlers (Slack, Discord, iMessage, Facebook, Twitter) don't
 * execute JS. Without this rewrite they see the static site-level meta
 * from index.html and no og:image, producing a generic preview for
 * every link.
 */

import { rewrite, next } from '@vercel/edge'

export const config = {
  // Event detail URLs (crawler SSR, below) plus /unsubscribe, where we need to
  // separate a mailbox provider's one-click POST from a human's GET. Everything
  // else passes through untouched. Note: middleware can't filter by
  // User-Agent or method in `matcher`, so we do that inside the function.
  matcher: ['/events/:path*', '/unsubscribe'],
}

// User-Agent substrings we treat as "non-JS client; serve SSR'd HTML".
// Conservative pattern — case-insensitive, anchored to known crawler /
// unfurler names. False positives (a real user with one of these tokens
// in their UA) just get the static preview HTML, which still renders
// the SPA at the destination via a meta-refresh fallback.
const CRAWLER_PATTERN = new RegExp(
  [
    // Social link unfurlers
    'slackbot', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
    'discordbot', 'telegrambot', 'whatsapp', 'imessage', 'preview',
    'outlook', 'skypeuripreview',
    // AI search bots
    'gptbot', 'claudebot', 'claude-web', 'claude-user', 'claude-searchbot',
    'perplexitybot', 'perplexity-user', 'chatgpt-user', 'oai-searchbot',
    // Search engines (mostly handle JS but doesn't hurt; cheaper to SSR)
    'googlebot', 'bingbot', 'duckduckbot', 'applebot', 'yandexbot',
    'baiduspider', 'ccbot', 'bytespider', 'google-extended',
    'applebot-extended',
  ].join('|'),
  'i',
)

// Event DETAIL URLs, in both shapes that exist:
//
//   /events/<uuid>                 (what api/preview emits as og:url)
//   /events/<slug>/<uuid>          (what the app links and shares)
//
// The uuid is required and fully shaped, which is what keeps the hub routes
// out: /events/akron, /events/this-weekend, /events/concerts and friends all
// live under the same prefix and must fall through to the SPA.
//
// 🔴 This regex was `/^\/events\/([a-f0-9-]{8,})(?:\/?.*)?$/i` from July 2026
// until 2026-08-25, which demanded a HEX FIRST SEGMENT. Every real event URL
// carries the slug there, so nothing ever matched: 0 of 1,000 sitemap URLs,
// zero Edge Middleware invocations, and every shared link unfurled as the bare
// SPA shell with no og:image at all. api/preview/event/[id].js was correct the
// whole time and was simply never reached. If you touch this line, re-run
// scripts/tests/test-middleware-preview.js, which pins both shapes and the
// hubs.
const EVENT_PATH_PATTERN =
  /^\/events\/(?:[^/]+\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i

// Exported for scripts/tests/test-middleware-preview.js only. The edge entry
// point stays the default export.
export { EVENT_PATH_PATTERN, CRAWLER_PATTERN }

export default function middleware(req) {
  const url = new URL(req.url)

  // ── RFC 8058 one-click unsubscribe ───────────────────────────────────────
  //
  // /unsubscribe is a client-side React route, so a POST to it hits Vercel's
  // catch-all and dies with a 405. Our digest publishes that exact URL in its
  // `List-Unsubscribe` header alongside `List-Unsubscribe-Post`, which means
  // every Gmail/Outlook unsubscribe button POSTed into that 405 and the
  // subscriber was never unsubscribed. Found 2026-09-17; never worked.
  //
  // Route the POST — and only the POST — to a real endpoint. A human's GET
  // still falls through to the SPA, which renders the goodbye page. Keep this
  // check ABOVE the crawler logic: the provider's UA may well match
  // CRAWLER_PATTERN ('outlook' is in that list) and it must not be handed
  // preview HTML instead of having its unsubscribe honoured.
  if (url.pathname === '/unsubscribe') {
    if (req.method !== 'POST') return next()
    const target = new URL('/api/unsubscribe', url)
    target.search = url.search
    return rewrite(target)
  }

  const ua = req.headers.get('user-agent') || ''
  if (!CRAWLER_PATTERN.test(ua)) return next()

  const match = url.pathname.match(EVENT_PATH_PATTERN)
  if (!match) return next()

  // Rewrite path — keep the original host so canonical URLs in the
  // preview HTML come out right. Explicitly pass the event id as a
  // query param too: Vercel's auto-mapping of dynamic-route segments
  // ([id]) into searchParams isn't always applied to URLs reached via
  // middleware rewrite, and a missing id sends the function down its
  // fallback path.
  const rewriteUrl = new URL(`/api/preview/event/${match[1]}`, url)
  rewriteUrl.searchParams.set('id', match[1])
  return rewrite(rewriteUrl)
}
