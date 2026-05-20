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
  // Only intercept event detail URLs. Everything else passes through
  // untouched. Note: middleware can't filter by User-Agent in `matcher`,
  // so we do that inside the function.
  matcher: '/events/:path*',
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

// /events/<uuid>[/anything] — only rewrite plain detail URLs
const EVENT_PATH_PATTERN = /^\/events\/([a-f0-9-]{8,})(?:\/?.*)?$/i

export default function middleware(req) {
  const ua = req.headers.get('user-agent') || ''
  if (!CRAWLER_PATTERN.test(ua)) return next()

  const url = new URL(req.url)
  const match = url.pathname.match(EVENT_PATH_PATTERN)
  if (!match) return next()

  // Rewrite path — keep the original host so canonical URLs in the
  // preview HTML come out right.
  const rewriteUrl = new URL(`/api/preview/event/${match[1]}`, url)
  return rewrite(rewriteUrl)
}
