/**
 * /api/feed.xml — RSS 2.0 feed of upcoming Akron Pulse events.
 *
 * Surfaced under /feed.xml via a rewrite in vercel.json. Designed for
 * local news outlets, Substack writers, NetNewsWire-style readers,
 * and any aggregator that consumes RSS — Akron Pulse becomes a
 * content syndication source for free.
 *
 * Cached at the edge for an hour, with a day-long stale-while-
 * revalidate window so the feed stays warm even if Supabase blips.
 *
 * Note: we emit RSS 2.0 (not Atom) because more readers in the wild
 * still default to RSS, and the format reads well as plain XML.
 *
 * Uses the anon Supabase key only — every event we emit is already
 * published and publicly readable. Mirrors the sitemap function in
 * file shape and env handling for consistency.
 */

import { createClient } from '@supabase/supabase-js'
import { eventPath } from '../src/lib/slug.js'

const SITE_ORIGIN  = 'https://akronpulse.com'
const FEED_TITLE   = 'Akron Pulse — Upcoming Events'
const FEED_DESCRIPTION =
  'Concerts, art shows, festivals, family events, food and drink, and more — happening in Akron, OH and Summit County.'

// Max items to include. Most readers fetch the feed every 30–60
// minutes; emitting more than ~50 items hurts cache size without
// helping the user.
const FEED_LIMIT = 50

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function rfc822(date) {
  // RSS pubDate / lastBuildDate require RFC-822 dates. JS toUTCString()
  // is RFC-822 compatible.
  if (!date) return new Date().toUTCString()
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return new Date().toUTCString()
  return d.toUTCString()
}

function itemEntry(event) {
  const url = `${SITE_ORIGIN}${eventPath(event)}`
  // Build a short, factual description for readers that don't render
  // HTML. Falls back to the title if no description is published.
  const desc = event.description
    ? event.description.replace(/\s+/g, ' ').trim().slice(0, 500)
    : event.title
  const venue = event.event_venues?.[0]?.venue
  const venueLine = venue ? ` at ${venue.name}` : ''
  const summary = `${desc}${venueLine}`

  return [
    '  <item>',
    `    <title>${xmlEscape(event.title)}</title>`,
    `    <link>${xmlEscape(url)}</link>`,
    `    <guid isPermaLink="true">${xmlEscape(url)}</guid>`,
    `    <pubDate>${rfc822(event.created_at || event.updated_at || event.start_at)}</pubDate>`,
    `    <description>${xmlEscape(summary)}</description>`,
    event.category ? `    <category>${xmlEscape(event.category)}</category>` : '',
    `    <source url="${xmlEscape(SITE_ORIGIN + '/feed.xml')}">${xmlEscape(FEED_TITLE)}</source>`,
    '  </item>',
  ].filter(Boolean).join('\n')
}

export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

  if (!url || !key) {
    res.status(500).send('Feed misconfigured: Supabase env vars missing')
    return
  }

  const supabase = createClient(url, key)

  // Upcoming + recent (last 3h) events, sorted by start time so the
  // feed leads with what's coming up next — that's what readers
  // actually want to see at the top.
  const nowMinus3h = new Date(Date.now() - 3 * 3600 * 1000).toISOString()

  const { data, error } = await supabase
    .from('events')
    .select(`
      id, title, description, category,
      start_at, created_at, updated_at,
      event_venues ( venue:venues ( name ) )
    `)
    .eq('status', 'published')
    .gte('start_at', nowMinus3h)
    .order('start_at', { ascending: true })
    .limit(FEED_LIMIT)

  if (error) {
    res.status(502).send(`Feed upstream error: ${error.message}`)
    return
  }

  const events = data ?? []
  const lastBuildDate = events.length > 0
    ? rfc822(events.reduce((acc, e) => {
        const ts = new Date(e.updated_at || e.created_at || e.start_at).getTime()
        return ts > acc ? ts : acc
      }, 0))
    : rfc822(new Date())

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `  <title>${xmlEscape(FEED_TITLE)}</title>`,
    `  <link>${xmlEscape(SITE_ORIGIN)}</link>`,
    `  <description>${xmlEscape(FEED_DESCRIPTION)}</description>`,
    `  <language>en-us</language>`,
    `  <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    `  <atom:link href="${xmlEscape(SITE_ORIGIN + '/feed.xml')}" rel="self" type="application/rss+xml" />`,
    '  <ttl>60</ttl>',
    events.map(itemEntry).join('\n'),
    '</channel>',
    '</rss>',
  ].join('\n')

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
  res.setHeader(
    'Cache-Control',
    'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
  )
  res.status(200).send(xml)
}
