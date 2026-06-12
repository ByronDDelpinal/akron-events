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
 * staleness after a scrape or an admin edit is ~5 minutes — chosen
 * over scrape-triggered purging because (a) Vercel has no per-path
 * purge outside a redeploy, and (b) the twice-daily scrape is NOT the
 * only writer: admin review-queue edits land at any time and should
 * also propagate without extra plumbing.
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
  res.status(200).json({ events: data ?? [], total: count ?? 0 })
}
