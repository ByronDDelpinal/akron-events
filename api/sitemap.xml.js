/**
 * /api/sitemap.xml — Vercel serverless function.
 *
 * Builds the XML sitemap from live Supabase data on each request, then
 * tells Vercel to edge-cache it for an hour. Served under the
 * /sitemap.xml path via the rewrite in vercel.json.
 *
 * Uses the anon key only — all content we emit here is already published
 * and publicly readable. Never use the service_role key in browser-
 * reachable code paths.
 */

import { createClient } from '@supabase/supabase-js'
import { eventPath } from '../src/lib/slug.js'
import { ENABLED_HUB_PATHS } from '../src/lib/seo/categories.js'

const SITE_ORIGIN = 'https://akronpulse.com'

// The static routes — kept in one place so every prerender/sitemap
// tool agrees on what "the site" is. Category and neighborhood hub
// pages are imported from the SEO registry so adding a new hub is one
// file edit and the sitemap automatically picks it up.
const STATIC_ROUTES = [
  { path: '/',               priority: 1.0, changefreq: 'daily'   },
  { path: '/venues',         priority: 0.8, changefreq: 'weekly'  },
  { path: '/organizations',  priority: 0.8, changefreq: 'weekly'  },
  { path: '/about',          priority: 0.6, changefreq: 'monthly' },
  { path: '/organizers',     priority: 0.6, changefreq: 'monthly' },
  { path: '/submit',         priority: 0.5, changefreq: 'monthly' },
  { path: '/embed-builder',  priority: 0.4, changefreq: 'monthly' },
  { path: '/venues/submit',  priority: 0.4, changefreq: 'monthly' },
  { path: '/organizations/submit', priority: 0.4, changefreq: 'monthly' },
  { path: '/subscribe',      priority: 0.5, changefreq: 'monthly' },
  // Category & neighborhood hub pages. High priority because these
  // are the keyword-targeted landing pages most likely to win on
  // local-intent queries ("free events in Akron", "downtown Akron
  // events", "concerts in Akron").
  ...ENABLED_HUB_PATHS.map((path) => ({
    path,
    priority:   0.85,
    changefreq: 'daily',
  })),
]

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
  const parts = [`    <loc>${xmlEscape(loc)}</loc>`]
  if (lastmod)    parts.push(`    <lastmod>${xmlEscape(lastmod)}</lastmod>`)
  if (changefreq) parts.push(`    <changefreq>${changefreq}</changefreq>`)
  if (priority != null) parts.push(`    <priority>${priority}</priority>`)
  return `  <url>\n${parts.join('\n')}\n  </url>`
}

export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

  if (!url || !key) {
    res.status(500).send('Sitemap misconfigured: Supabase env vars missing')
    return
  }

  const supabase = createClient(url, key)

  // Exclude events that ended more than 90 days ago. Long-tail past
  // events waste Google's crawl budget on dead URLs that won't
  // appear in any user-facing list — SEO action plan item 07
  // ("Past event pages should 301-redirect or be removed from the
  // sitemap to avoid wasting crawl budget"). We keep recent past
  // events (≤90 days) because Google still has them in its index and
  // we don't want to abruptly drop fresh URLs the day after the
  // event happens.
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600 * 1000)
    .toISOString()
  const [eventsRes, venuesRes, orgsRes] = await Promise.all([
    supabase
      .from('events')
      .select('id, title, updated_at, start_at')
      .eq('status', 'published')
      .gte('start_at', ninetyDaysAgo)
      .order('start_at', { ascending: false }),
    supabase
      .from('venues')
      .select('id, updated_at')
      .eq('status', 'published'),
    supabase
      .from('organizations')
      .select('id, updated_at')
      .eq('status', 'published'),
  ])

  const events = eventsRes.data ?? []
  const venues = venuesRes.data ?? []
  const orgs   = orgsRes.data   ?? []

  const entries = [
    ...STATIC_ROUTES.map((r) => ({
      loc: SITE_ORIGIN + r.path,
      changefreq: r.changefreq,
      priority: r.priority,
    })),
    ...events.map((e) => ({
      loc: `${SITE_ORIGIN}${eventPath(e)}`,
      lastmod: (e.updated_at || e.start_at || '').slice(0, 10),
      changefreq: 'weekly',
      priority: 0.9,
    })),
    ...venues.map((v) => ({
      loc: `${SITE_ORIGIN}/venues/${v.id}`,
      lastmod: (v.updated_at || '').slice(0, 10),
      changefreq: 'monthly',
      priority: 0.7,
    })),
    ...orgs.map((o) => ({
      loc: `${SITE_ORIGIN}/organizations/${o.id}`,
      lastmod: (o.updated_at || '').slice(0, 10),
      changefreq: 'monthly',
      priority: 0.7,
    })),
  ]

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.map(urlEntry).join('\n'),
    '</urlset>',
  ].join('\n')

  // Edge-cache for an hour. Stale-while-revalidate for another 24 so the
  // cache never goes cold even if Supabase is slow to respond.
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400')
  res.status(200).send(xml)
}
