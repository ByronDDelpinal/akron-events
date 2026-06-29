/**
 * /api/events-hub?slug=<hub> — edge-cached first page of a category,
 * neighborhood, or city hub (page one, hub-locked filters only, soonest
 * first). The hub equivalent of /api/events-first-page.
 *
 * Why: hub pages are the highest-traffic event lists after the homepage and,
 * like it, their pristine first page is byte-identical for every visitor —
 * so they're just as cacheable. Serving them from Vercel's edge removes the
 * PostgREST round-trip that made them slow.
 *
 *   Cache-Control: s-maxage=28800 (8h), stale-while-revalidate=86400
 *   Vercel-Cache-Tag: events,hub-<slug>
 *
 * The shared `events` tag means scripts/run-all.js busts every hub (and the
 * homepage) with one purge at the end of a scrape; `hub-<slug>` allows a
 * targeted purge if ever needed. Any failure or a non-cacheable hub falls
 * through to the client's live PostgREST query, so this is pure speed-up
 * with no correctness risk.
 *
 * Date-range hubs (This Weekend / Today) are refused on purpose: their
 * window is time-relative and must not be long-cached.
 *
 * Query + columns live in src/lib/firstPageQuery.js (shared with useEvents)
 * and the hub registry in src/lib/seo/categories.js, so nothing can drift.
 */

import { createClient } from '@supabase/supabase-js'
import { buildHubFirstPageQuery } from '../src/lib/firstPageQuery.js'
import {
  getCategoryHub,
  getNeighborhoodHub,
  getCityHub,
} from '../src/lib/seo/categories.js'

const PAGE_SIZE = 24 // keep in sync with PAGE_SIZE in src/hooks/useEvents.ts

/** Resolve a slug to its hub + the locked filters useEvents would apply. */
function resolveHub(slug) {
  const category = getCategoryHub(slug)
  if (category) {
    return {
      hub: category,
      opts: {
        categories: category.categoryFilter || [],
        facets:     category.facetFilter || [],
        freeOnly:   !!category.freeOnly,
      },
    }
  }
  const neighborhood = getNeighborhoodHub(slug)
  if (neighborhood) {
    return { hub: neighborhood, opts: { neighborhoodSlug: slug } }
  }
  const city = getCityHub(slug)
  if (city) {
    return { hub: city, opts: { cityMatch: city.cityMatch || [] } }
  }
  return null
}

export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

  if (!url || !key) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(500).json({ error: 'Supabase env vars missing' })
    return
  }

  const slug = String(req.query.slug || '')
  const resolved = resolveHub(slug)

  // Unknown, disabled (non-preview), or time-relative (date-range) hubs are
  // not cacheable here — tell the client to use its live query instead.
  if (!resolved || (resolved.hub.disabled && !resolved.hub.preview) || resolved.hub.dateRange) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(404).json({ error: 'hub not cacheable' })
    return
  }

  const supabase = createClient(url, key)
  const { data, error, count } = await buildHubFirstPageQuery(supabase, resolved.opts, PAGE_SIZE)

  if (error) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(502).json({ error: error.message })
    return
  }

  res.setHeader('Cache-Control', 'public, s-maxage=28800, stale-while-revalidate=86400')
  res.setHeader('Vercel-Cache-Tag', `events,hub-${slug}`)
  res.status(200).json({ events: data ?? [], total: count ?? 0 })
}
