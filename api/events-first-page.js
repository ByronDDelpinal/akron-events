/**
 * /api/events-first-page — edge-cached copy of the default homepage
 * events query (page one, no filters, soonest first).
 *
 * Why this exists: the homepage's first paint of data otherwise pays
 * PostgREST + connection latency on every cold visit. This endpoint
 * lets Vercel's CDN answer instantly from every edge region:
 *
 *   Cache-Control: s-maxage=300, stale-while-revalidate=86400
 *
 * means a POP serves its cached copy (even a stale one) with zero
 * latency and refreshes from Supabase in the background. Worst-case
 * staleness after a scrape or an admin edit is ~5 minutes without any
 * purge plumbing — good enough that purging is optional, not required.
 *
 * On-demand purge: the response carries the cache tag below, so it can
 * be busted at any time without a redeploy:
 *   • dashboard — project → CDN → Caches → Purge → tag "events-first-page"
 *   • CLI       — `vercel cache invalidate --tag events-first-page`
 *   • REST API  — POST /v1/edge-cache/invalidate-by-tag (e.g. from the
 *     end of scripts/run-all.js if scrape-triggered freshness is ever
 *     wanted). Prefer Invalidate over Delete: stale-serve + background
 *     refresh, no cache-stampede risk.
 *
 * The query itself lives in src/lib/firstPageQuery.js, shared with
 * useEvents so the shapes can't drift.
 *
 * Anon key only — everything served is published and publicly
 * readable. Mirrors feed.xml.js in file shape and env handling.
 */

import { createClient } from '@supabase/supabase-js'
import { buildFirstPageQuery } from '../src/lib/firstPageQuery.js'

const PAGE_SIZE = 24 // keep in sync with PAGE_SIZE in src/hooks/useEvents.ts

export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

  if (!url || !key) {
    res.status(500).json({ error: 'Supabase env vars missing' })
    return
  }

  const supabase = createClient(url, key)
  const { data, error, count } = await buildFirstPageQuery(supabase, PAGE_SIZE)

  if (error) {
    // Don't cache failures.
    res.setHeader('Cache-Control', 'no-store')
    res.status(502).json({ error: error.message })
    return
  }

  res.setHeader(
    'Cache-Control',
    'public, s-maxage=300, stale-while-revalidate=86400',
  )
  // Makes this response purgeable on demand (dashboard, CLI, or REST
  // API) without a redeploy — see header comment.
  res.setHeader('Vercel-Cache-Tag', 'events-first-page')
  res.status(200).json({ events: data ?? [], total: count ?? 0 })
}
