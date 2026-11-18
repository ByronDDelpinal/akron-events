import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { EVENT_LIST_COLUMNS, FIRST_PAGE_CACHE_ROWS } from '@/lib/firstPageQuery'
import { applyBrowseVisibility } from '@/lib/browseVisibility'
import { dateRangeBounds } from '@/lib/dateRange'
import { easternIsoAt } from '@/lib/easternDate'
import { timeOfDayBounds, type TimeOfDayId } from '@/lib/whenFilter'
import { withOneRetry } from '@/lib/queryRetry'
import { useAsync } from './useAsync'

/**
 * A raw PostgREST row with embedded join arrays. The conditional selects in
 * this file (aliased inner embeds, `venue:venues(...)`, etc.) produce shapes
 * that are awkward to express through supabase-js's string-select generics, so
 * the query builders here are intentionally loose and the *public* surface
 * (hook options + the normalized `AppEvent`) carries the types consumers rely on.
 */
type RawRow = LooseRow

/**
 * The normalized event shape every UI surface consumes. Common fields are
 * typed; the index signature keeps the many scraper-provided extras available
 * without enumerating all of them here.
 */
export interface AppEvent {
  id: string
  title: string
  start_at: string
  category: string
  categories: string[]
  venue: RawRow | null
  venues: RawRow[]
  organizer: RawRow | null
  organizations: RawRow[]
  areas?: RawRow[]
  end_at?: string | null
  description?: string | null
  featured?: boolean | null
  tags?: string[] | null
  banner_eligible?: boolean | null
  image_width?: number | null
  image_height?: number | null
  image_url?: string | null
  ticket_url?: string | null
  /** Scraper key (see scripts/manifest.js). Drives the "Listed on X" credit. */
  source?: string | null
  source_url?: string | null
  price_min?: number | null
  price_max?: number | null
  age_restriction?: string | null
  [key: string]: unknown
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return fallback
}

/** True when a search term is active (non-blank after trimming). */
function isSearching(search: string | null | undefined): search is string {
  return !!search && search.trim().length > 0
}

interface EventSourceOptions {
  search: string | null | undefined
  /** The start_at floor this result set is pinned to (see floorRef). */
  floorIso: string
  neighborhoodSlug: string | null | undefined
  venueCities: string[]
  withCount: boolean
}

/**
 * Start an events query: the plain `events` table, or — when a search term is
 * active — the `search_events` RPC (migration 074).
 *
 * Why search is an RPC and not a filter on the table: a text-match filter on
 * `events` (the old word-boundary regex, or a full-text `@@`) is a
 * non-leakproof operator, and under RLS Postgres will not use an index for
 * one. It applied the policy first and then ran the match over every upcoming
 * row, descriptions included — the scan that hit anon's 3s statement timeout
 * on 2026-11-12. `search_events` is SECURITY DEFINER over a full-text index,
 * hard-codes the same published-only rule as the policy, and returns SETOF
 * events, so every filter / order / embed / count chained after this applies
 * exactly as it does on the table.
 *
 * Matching (migration 076): whole words only ("improv" does not match
 * "improve"), against the title, description, tags, venue names and organizer
 * names. The words must appear as a phrase; if no event has the phrase, all
 * the words in any order. Case, accents, apostrophes and punctuation are
 * ignored, and "G.A.R." / "gar", "theatre" / "theater", "&" / "and" are the
 * same thing. All normalization happens in SQL (search_canon), so the trimmed
 * term is sent as typed. Prefixes and misspellings are never matched here —
 * see fetchSearchSuggestion.
 *
 * One PostgREST limit shapes the callers: embedded-resource filters
 * (`event_venues.venues.city=…`, `_catfilter.category=…`) are rejected on an
 * RPC result. So while searching, the venue scope travels as `p_neighborhood`
 * / `p_cities`, and the category filter uses the denormalized
 * `category_slugs` column (see applyCategoryFilter).
 */
function selectEvents(columns: string, opts: EventSourceOptions): LooseQuery {
  const countOption = opts.withCount ? { count: 'exact' as const } : undefined
  if (!isSearching(opts.search)) {
    return supabase.from('events').select(columns, countOption)
  }
  const args: Record<string, unknown> = { p_term: opts.search.trim(), p_floor: opts.floorIso }
  if (opts.neighborhoodSlug) args.p_neighborhood = opts.neighborhoodSlug
  if (opts.venueCities.length > 0) args.p_cities = opts.venueCities
  // Cast: search_events is newer than the generated Database types. `get`
  // keeps it a plain GET (read-only transaction, same as the table read).
  return (supabase as LooseQuery)
    .rpc('search_events', args, { get: true, ...countOption })
    .select(columns)
}

/** A term that found nothing, and the term whose results are shown instead. */
export interface SearchReplacement {
  /** What the visitor searched for (trimmed). */
  from: string
  /** The completed or corrected term the results belong to. */
  to: string
}

/**
 * After a search found nothing, ask for a replacement term (migration 076's
 * `search_suggest`): the last word completed ("jilly" → "jillys") or a
 * misspelling corrected ("musika" → "musica"). Resolves to null when there is
 * nothing to offer.
 *
 * Why this is a second request and not a looser tier inside search_events:
 * results are sorted by date, not relevance, so a prefix or fuzzy match
 * blended into the list is indistinguishable from an exact one. Measured on
 * prod, "drag" (no whole-word match) silently became 61 Dungeons & Dragons
 * listings. Asking separately lets the UI say what was substituted, and costs
 * a round trip only on searches that would otherwise show an empty page.
 *
 * Never throws: a failure here (including the function not existing yet,
 * before 076 is applied) just means the visitor sees the empty state.
 */
async function fetchSearchSuggestion(term: string, floorIso: string): Promise<string | null> {
  try {
    const { data, error } = await (supabase as LooseQuery)
      .rpc('search_suggest', { p_term: term.trim(), p_floor: floorIso }, { get: true })
    if (error || typeof data !== 'string') return null
    const suggestion = data.trim()
    return suggestion.length > 0 ? suggestion : null
  } catch {
    return null
  }
}

export const PAGE_SIZE = 24

/**
 * Build the embedded-category select + apply an any-match (OR) filter on the
 * event_categories join table.
 *
 * PostgREST trick: we embed event_categories TWICE —
 *   • a normal embed `event_categories(category)` so every event comes back
 *     with its FULL category list (for badges), and
 *   • an aliased INNER embed `_catfilter:event_categories!inner(category)`
 *     used purely to filter the parent down to events that have at least one
 *     of the requested categories.
 */
function categorySelectFragment(categories: string[], searching: boolean): string {
  const filterEmbed = categories.length > 0 && !searching
    ? '_catfilter:event_categories!inner ( category ),'
    : ''
  return `${filterEmbed} event_categories ( category ),`
}

function applyCategoryFilter(query: LooseQuery, categories: string[], searching: boolean): LooseQuery {
  if (categories.length === 0) return query
  // Search runs through an RPC, where PostgREST rejects embedded-resource
  // filters. category_slugs is the trigger-maintained mirror of
  // event_categories (migration 039), so overlap on it is the same any-match.
  if (searching) return query.overlaps('category_slugs', categories)
  return query.in('_catfilter.category', categories)
}

export interface UseEventsOptions {
  categories?: string[]
  /** Content categories to hide (anti-join on category_slugs). */
  excludedCategories?: string[]
  family?: boolean
  /** Hide events flagged is_family (the "Hide kids' events" audience toggle). */
  excludeFamily?: boolean
  fundraiser?: boolean
  dateRange?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  /** Time-of-day bucket filter. Requires migration 056's `start_hour_et`
   * column — see whenFilter.ts's timeOfDayBounds. */
  timeOfDay?: TimeOfDayId | null
  search?: string | null
  freeOnly?: boolean
  priceMax?: string | null
  hiddenSources?: string[]
  neighborhoodSlug?: string | null
  venueCities?: string[]
  sort?: string
  limit?: number
  offset?: number
  /**
   * When set, the FIRST page (offset 0) is served from the edge-cached
   * /api/events-hub?slug=<hubSlug> endpoint instead of PostgREST. The caller
   * (CategoryPage) passes the hub slug only when the current request equals
   * the hub's pristine defaults — i.e. the same filters the cached endpoint
   * applies. Any cache miss falls through to the live query below.
   */
  hubSlug?: string | null
}

/**
 * Fetch a paginated page of published events with server-side filtering.
 * Uses junction tables for venue/organization relationships.
 */
export function useEvents({
  categories       = [],
  excludedCategories = [],
  family           = false,
  excludeFamily    = false,
  fundraiser       = false,
  dateRange        = null,
  dateFrom         = null,
  dateTo           = null,
  timeOfDay        = null,
  search           = null,
  freeOnly         = false,
  priceMax         = null,
  hiddenSources    = [],
  neighborhoodSlug = null,
  venueCities      = [],
  sort             = 'soonest',
  limit            = PAGE_SIZE,
  offset           = 0,
  hubSlug          = null,
}: UseEventsOptions = {}) {
  const [events,  setEvents]  = useState<AppEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [total,   setTotal]   = useState(0)
  // Set when page one found nothing for the typed term and the rows on screen
  // belong to a replacement term instead (see fetchSearchSuggestion).
  const [searchReplacement, setSearchReplacement] = useState<SearchReplacement | null>(null)

  // The `start_at` floor page one of the CURRENT filter set was fetched with,
  // so every later page can reuse it. That floor is "now", and it advances
  // between requests: if page 2 re-evaluated it, every event that started in
  // between would drop out of the result set, the whole window would shift up
  // by that many rows, and exactly that many events would be skipped at the
  // page boundary. `sig` scopes the pin to one filter set (limit and offset
  // excluded) so changing a filter starts from a fresh floor.
  // `searchTerm` rides along for the same reason: when page one was served
  // for a replacement term, later pages must keep paging THAT term.
  const floorRef = useRef<{ sig: string; floorIso: string; searchTerm?: string | null } | null>(null)

  // The caller may pass fresh array literals on every render, so the fetch
  // effect keys on a serialized form and reads memoized arrays derived from
  // it. Values are slugs/keys (never contain commas), so join/split is safe.
  const categoriesKey    = categories.join(',')
  const excludedCatsKey  = excludedCategories.join(',')
  const hiddenSourcesKey = hiddenSources.join(',')
  const venueCitiesKey   = venueCities.join(',')
  const categoriesStable    = useMemo(() => categoriesKey.split(',').filter(Boolean), [categoriesKey])
  const excludedCatsStable  = useMemo(() => excludedCatsKey.split(',').filter(Boolean), [excludedCatsKey])
  const hiddenSourcesStable = useMemo(() => hiddenSourcesKey.split(',').filter(Boolean), [hiddenSourcesKey])
  const venueCitiesStable   = useMemo(() => venueCitiesKey.split(',').filter(Boolean), [venueCitiesKey])

  useEffect(() => {
    let cancelled = false
    const categories = categoriesStable, excludedCategories = excludedCatsStable, hiddenSources = hiddenSourcesStable, venueCities = venueCitiesStable

    // Identifies the current filter set for the pinned start_at floor (see
    // floorRef above). Deliberately excludes `limit` and `offset`: paging
    // through one feed must keep the floor page one used, while changing any
    // actual filter must start a fresh one. JSON.stringify, not a join —
    // `search` is free text, and a delimiter join lets a term containing the
    // delimiter collide with a different filter set. Same shape as
    // useMapEvents' cacheKey below.
    const sig = JSON.stringify([
      categories, excludedCategories, family, excludeFamily, fundraiser,
      dateRange, dateFrom, dateTo, timeOfDay, search, freeOnly, priceMax,
      hiddenSources, neighborhoodSlug, venueCities, sort, hubSlug,
    ])

    // The pristine homepage request (page one, no filters, default
    // sort) is byte-identical for every visitor, so it's served from
    // /api/events-first-page — cached at Vercel's edge (s-maxage=28800 +
    // a day of stale-while-revalidate), answering in ~50 ms worldwide
    // instead of paying PostgREST latency. Any failure falls through
    // to the normal live query.
    // `&& !timeOfDay` is load-bearing, not decoration: /api/events-first-page
    // is a pre-baked response with no start_hour_et predicate applied, so a
    // time-filtered request that slipped through this guard would silently
    // get served the UNFILTERED cached page (docs/when-filter.md §3.2's cache
    // guard note — this is one of the two sites it calls out).
    // No `limit` condition on purpose: the cached page always holds
    // FIRST_PAGE_CACHE_ROWS rows, so ANY pristine offset-0 request can use it —
    // smaller limits slice the head, larger ones (efficient density, restored
    // scroll depth) add a live tail beyond the boundary. See the head+tail
    // seam comment inside fetchEvents.
    const isDefaultFirstPage =
      categories.length === 0 && excludedCategories.length === 0 &&
      !family && !excludeFamily && !fundraiser &&
      !dateRange && !dateFrom && !dateTo && !timeOfDay &&
      (!search || search.trim().length === 0) &&
      !freeOnly && !priceMax &&
      hiddenSources.length === 0 && !neighborhoodSlug &&
      venueCities.length === 0 &&
      sort === 'soonest' && offset === 0

    async function fetchEvents() {
      setLoading(true)
      setError(null)

      // Page one sets the floor; later pages of the same feed reuse it. A page
      // whose filter set doesn't match the pinned one starts fresh.
      const nowIso = new Date().toISOString()
      const floorIso = offset > 0 && floorRef.current?.sig === sig ? floorRef.current.floorIso : nowIso

      // ── Shared live-query builder ─────────────────────────────────────
      // ONE construction site for the PostgREST query, used by three paths:
      //   • the normal (non-pristine) fetch — behaviorally identical to the
      //     previous inline construction (count only on offset 0),
      //   • the live TAIL beyond a cached head (rows FIRST_PAGE_CACHE_ROWS
      //     .. limit-1, never with a count),
      //   • the serial fallback when the edge layer is unavailable.
      // `term` defaults to the typed search; the replacement-term re-query and
      // its later pages pass their own.
      const buildLiveQuery = (rangeStart: number, rangeEnd: number, withCount: boolean, term: string | null | undefined = search): LooseQuery => {
        // The venue embed is an inner join only when neighborhoodSlug is
        // set — that flips PostgREST into "filter the parent by the
        // child" mode and lets us hand the slug constraint to Postgres.
        // While searching, the venue scope is applied inside search_events
        // (p_neighborhood / p_cities) instead — see selectEvents.
        const searching = isSearching(term)
        const useInnerVenue = !searching && (!!neighborhoodSlug || venueCities.length > 0)
        const venueJoin = useInnerVenue ? 'event_venues!inner' : 'event_venues'
        const venueTbl  = useInnerVenue ? 'venues!inner'      : 'venues'

        // Explicit column list (shared with api/events-first-page.js),
        // NOT `*`: the list surfaces never render event descriptions,
        // and the *_normalized columns are server-side search
        // artifacts. Dropping them halves the page payload (~48 kB →
        // ~26 kB measured 2026-06). Detail pages (useEvent) still
        // select * for the full record.
        // Exact COUNT is only fetched on the first page (withCount): it's
        // needed for the "N events" total and the initial hasMore, but
        // re-running a full filtered COUNT on every "load more" — or on a
        // tail fetch whose total already came from the cached head — is pure
        // overhead. Later pages reuse the page-one total (held in state) for
        // hasMore, so they skip the count entirely.
        let query: LooseQuery = selectEvents(`
            ${EVENT_LIST_COLUMNS},
            ${categorySelectFragment(categories, searching)}
            ${venueJoin} ( venue:${venueTbl} ( id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website, image_url, neighborhood_slug ) ),
            event_organizations ( organization:organizations ( id, name, website, description, image_url ) )
          `, { search: term, floorIso, neighborhoodSlug, venueCities, withCount })
          .eq('status', 'published')
          // Drop events the moment their start time passes — no in-progress grace window.
          .gte('start_at', floorIso)

        // Festival children are hidden from the browse grid; the umbrella
        // stands in for them and links to the hub. Skipped when a search
        // term is active — decision 2, search must always find a band name.
        // See src/lib/browseVisibility.js and docs/umbrella-child-hiding.md.
        if (!searching) query = applyBrowseVisibility(query)

        if (useInnerVenue && neighborhoodSlug) {
          query = query.eq('event_venues.venues.neighborhood_slug', neighborhoodSlug)
        }
        if (useInnerVenue && venueCities.length > 0) {
          query = query.in('event_venues.venues.city', venueCities)
        }

        // Content axis: any-match against the event_categories join table.
        query = applyCategoryFilter(query, categories, searching)
        // Exclusion axis: anti-join via the denormalized category_slugs array
        // (migration 039). `not.ov` = "has NONE of these categories".
        if (excludedCategories.length > 0) {
          query = query.not('category_slugs', 'ov', `{${excludedCategories.join(',')}}`)
        }

        // Facet axis: cross-cutting boolean flags.
        if (family)        query = query.eq('is_family', true)
        // Hide kids'/family events. `.not(is, true)` keeps false AND null rows.
        else if (excludeFamily) query = query.not('is_family', 'is', true)
        if (fundraiser) query = query.eq('is_fundraiser', true)

        if (hiddenSources.length > 0) {
          query = query.not('source', 'in', `(${hiddenSources.join(',')})`)
        }

        if (dateFrom || dateTo) {
          // Eastern, NOT viewer-local. `new Date('2026-08-15T00:00:00')` is
          // parsed in the BROWSER's timezone, so the identical ?from=&to= URL
          // returned three different windows from New York, Los Angeles and
          // London. Presets were fixed in dateRangeBounds; this custom-range
          // path is the one most likely to be in a shared link, so it matters
          // most. See src/lib/easternDate.ts.
          if (dateFrom) query = query.gte('start_at', easternIsoAt(dateFrom, '00:00:00'))
          if (dateTo)   query = query.lte('start_at', easternIsoAt(dateTo, '23:59:59'))
        } else if (dateRange) {
          const { start, end } = dateRangeBounds(dateRange)
          query = query.gte('start_at', start.toISOString()).lte('start_at', end.toISOString())
        }

        // Time of day: ANDed with whatever date window is active. Requires
        // migration 056's start_hour_et column (a trigger-maintained hour,
        // NOT a generated column — AT TIME ZONE is STABLE, not IMMUTABLE, see
        // the migration header). Single-select for v1; `.in(...)` is the
        // drop-in for multi-select later, the column already supports it.
        const todBounds = timeOfDayBounds(timeOfDay)
        if (todBounds) {
          query = query.gte('start_hour_et', todBounds[0]).lte('start_hour_et', todBounds[1])
        }

        if (freeOnly) {
          query = query.eq('price_min', 0).or('price_max.is.null,price_max.eq.0')
        } else if (priceMax === 'under10') {
          query = query.lte('price_min', 10)
        } else if (priceMax === 'under25') {
          query = query.lte('price_min', 25)
        }

        // No search filter here: when a term is active the query was started
        // from search_events (selectEvents above), which already matched it
        // against title, description and tags.

        if (sort === 'latest') {
          query = query.order('start_at', { ascending: false })
        } else if (sort === 'recent') {
          query = query.order('created_at', { ascending: false })
        } else {
          query = query.order('start_at', { ascending: true })
        }

        return query.range(rangeStart, rangeEnd)
      }

      // ── Bounded stale-head / live-tail seam ───────────────────────────
      // Both cached endpoints bake exactly FIRST_PAGE_CACHE_ROWS rows (the
      // single variant — no per-limit variants at the edge). A pristine
      // offset-0 request DEEPER than that (efficient density's 48-row page at
      // a smaller future bake, or a back-navigation restoring scroll depth)
      // is assembled from two pieces fetched in parallel:
      //   head — rows 0..FIRST_PAGE_CACHE_ROWS-1 from the edge cache (may be
      //          up to the cache TTL stale),
      //   tail — rows FIRST_PAGE_CACHE_ROWS..limit-1 live from PostgREST,
      //          no count (the total comes from the cached head).
      // The staleness seam at the 48-row boundary is bounded and accepted:
      // rows that moved across the boundary between bake time and now are
      // deduped by id (head wins), so the worst case is a short gap or a
      // slightly stale first 48 — never duplicates.
      if (isDefaultFirstPage) {
        // Start head AND tail before awaiting either, so they overlap.
        // Promise.resolve() assimilates the lazy PostgrestBuilder thenable,
        // firing its HTTP request NOW — a bare builder only sends when
        // .then()/awaited, which would serialize the tail behind the head
        // fetch + res.json(). The no-op catch keeps a tail rejection from
        // escaping as unhandled when the head path bails before the tail is
        // awaited (supabase-js resolves with { error } rather than rejecting,
        // so this is purely defensive).
        const headPromise = fetch('/api/events-first-page')
        const tailPromise: Promise<{ data: RawRow[] | null; error: unknown }> | null =
          limit > FIRST_PAGE_CACHE_ROWS
            ? Promise.resolve(buildLiveQuery(FIRST_PAGE_CACHE_ROWS, limit - 1, false))
            : null
        tailPromise?.catch(() => {})
        try {
          const res = await headPromise
          if (res.ok) {
            const { events: rows, total: cachedTotal, bakedAt } = await res.json()
            if (Array.isArray(rows)) {
              let combined = (rows as RawRow[]).slice(0, limit)
              if (tailPromise) {
                const { data: tailRows, error: tailError } = await tailPromise
                if (tailError) throw tailError
                // Head then tail preserves start_at ordering (both are
                // soonest-first and the tail starts at the boundary); drop
                // tail rows whose id already appears in the head.
                const seen = new Set(combined.map((r) => r.id))
                combined = [...combined, ...((tailRows ?? []) as RawRow[]).filter((r) => !seen.has(r.id))]
              }
              if (!cancelled) {
                // One floor shared by every page of a list is the whole point
                // of the pin, so pin the ordering the DEEPEST RENDERED ROW came
                // from — that is where the next page must continue.
                //   no tail: every rendered row is a baked row, so the bake's
                //     floor is the right one. The cached body can be more than
                //     a day stale (s-maxage=28800 + stale-while-revalidate=
                //     86400), which is exactly why "now" would be wrong here.
                //   tail: the deepest rows came from the live query, which was
                //     started before this JSON was parsed and so necessarily
                //     used `floorIso`. Pinning `bakedAt` would shift page 2
                //     forward by however many events started since the bake and
                //     re-serve rows already on screen.
                // A response with no `bakedAt` (older deploy, or a cache still
                // holding a pre-bakedAt body) falls back to this fetch's floor.
                floorRef.current = { sig, floorIso: tailPromise ? floorIso : (bakedAt ?? floorIso) }
                setEvents(combined.map((r) => normalizeEventJoins(r) as AppEvent))
                setTotal(cachedTotal ?? 0)
                setLoading(false)
              }
              return
            }
          }
        } catch {
          // CDN/function unavailable (or vite dev, where /api doesn't exist),
          // or the tail query failed — fall through to the full live query
          // below. Serial cost is only paid when the edge layer is down.
        }
      }

      // Hub first page (page one of a category/neighborhood/city hub with no
      // user filters): served from the edge-cached /api/events-hub. The caller
      // only passes hubSlug when the request matches the hub's pristine
      // defaults, so the cached rows equal what buildLiveQuery returns for the
      // current closure — which is also why the SAME builder produces the tail
      // beyond the cached head (same head+tail seam as above).
      if (hubSlug && offset === 0) {
        const headPromise = fetch(`/api/events-hub?slug=${encodeURIComponent(hubSlug)}`)
        // Same eager-start + defensive catch as the pristine block above: the
        // builder is lazy, so wrap it in a real promise to overlap with the
        // head fetch.
        const tailPromise: Promise<{ data: RawRow[] | null; error: unknown }> | null =
          limit > FIRST_PAGE_CACHE_ROWS
            ? Promise.resolve(buildLiveQuery(FIRST_PAGE_CACHE_ROWS, limit - 1, false))
            : null
        tailPromise?.catch(() => {})
        try {
          const res = await headPromise
          if (res.ok) {
            const { events: rows, total: cachedTotal, bakedAt } = await res.json()
            if (Array.isArray(rows)) {
              let combined = (rows as RawRow[]).slice(0, limit)
              if (tailPromise) {
                const { data: tailRows, error: tailError } = await tailPromise
                if (tailError) throw tailError
                const seen = new Set(combined.map((r) => r.id))
                combined = [...combined, ...((tailRows ?? []) as RawRow[]).filter((r) => !seen.has(r.id))]
              }
              if (!cancelled) {
                // Same rule as the pristine block: pin the ordering the deepest
                // rendered row came from. /api/events-hub returns no `bakedAt`
                // today, so both arms collapse to `floorIso` — no behavior
                // change now, and the hub is correct for free if that endpoint
                // ever starts baking one.
                floorRef.current = { sig, floorIso: tailPromise ? floorIso : (bakedAt ?? floorIso) }
                setEvents(combined.map((r) => normalizeEventJoins(r) as AppEvent))
                setTotal(cachedTotal ?? 0)
                setLoading(false)
              }
              return
            }
          }
          // Non-OK (e.g. an uncacheable hub returns 404) — fall through.
        } catch {
          // CDN/function unavailable, vite dev, or the tail query failed —
          // fall through to the live query.
        }
      }

      try {
        type PageResult = { data: RawRow[] | null; error: unknown; count: number | null; status?: number }

        // Later pages of a replaced search page the replacement term, not the
        // typed one (which has no rows at all).
        const pinned = floorRef.current
        const pageTerm = offset > 0 && pinned?.sig === sig && pinned.searchTerm ? pinned.searchTerm : search

        // One retry on a statement timeout / gateway error (see queryRetry.ts):
        // the failed attempt warms the pages the second one needs.
        const first = await withOneRetry<PageResult>(
          () => buildLiveQuery(offset, offset + limit - 1, offset === 0, pageTerm),
        )
        if (first.error) throw first.error

        let rows  = first.data ?? []
        let count = first.count
        let replacement: SearchReplacement | null = null

        // Page one of a search that found nothing: ask for a completed or
        // corrected term and, if there is one, show ITS results instead — with
        // every other filter still applied. search_suggest only answers when
        // the typed term matches nothing anywhere, so a search that is empty
        // merely because of the other filters is left alone. If the
        // replacement is also empty under those filters, keep the honest
        // empty state rather than announcing a substitution with no rows.
        if (offset === 0 && isSearching(search) && rows.length === 0) {
          const suggestion = await fetchSearchSuggestion(search, floorIso)
          if (suggestion) {
            const second = await withOneRetry<PageResult>(
              () => buildLiveQuery(0, limit - 1, true, suggestion),
            )
            if (!second.error && (second.data ?? []).length > 0) {
              rows  = second.data ?? []
              count = second.count
              replacement = { from: search.trim(), to: suggestion }
            }
          }
        }

        if (!cancelled) {
          // Page one of a live feed pins the floor (and the term) its later
          // pages will use.
          if (offset === 0) {
            floorRef.current = { sig, floorIso, searchTerm: replacement?.to ?? null }
            setSearchReplacement(replacement)
          }
          setEvents(rows.map((r: RawRow) => normalizeEventJoins(r) as AppEvent))
          // Only page one carries a count; later pages leave the page-one
          // total untouched (a filter change resets offset to 0 and recounts).
          if (offset === 0) setTotal(count ?? 0)
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err, 'Failed to load events.'))
          // A failed page one must not leave the PREVIOUS filter set's rows in
          // state: the consumers render `events` under the new filters, so a
          // failed search showed the error above an unfiltered list that read
          // as wrong results. A failed "load more" (offset > 0) keeps what is
          // already on screen.
          if (offset === 0) {
            setEvents([])
            setTotal(0)
            setSearchReplacement(null)
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [categoriesStable, excludedCatsStable, family, excludeFamily, fundraiser, dateRange, dateFrom, dateTo, timeOfDay, search, freeOnly, priceMax, hiddenSourcesStable, neighborhoodSlug, venueCitiesStable, sort, limit, offset, hubSlug])

  const hasMore = offset + limit < total

  // Only while it still describes the CURRENT term: useEvents starts its fetch
  // from an effect, so for one render after the term changes the state above
  // still belongs to the previous search. (The cached first-page paths never
  // clear it either; they only run with no search term, which this covers.)
  const activeReplacement =
    searchReplacement && isSearching(search) && searchReplacement.from === search.trim()
      ? searchReplacement
      : null

  return { events, loading, error, total, hasMore, searchReplacement: activeReplacement }
}

/**
 * Fetch all venues, ordered by name. Includes organization join and areas.
 */
export function useVenues() {
  const { data: venues, loading, error } = useAsync(async () => {
    const { data, error: fetchError } = await supabase
      .from('venues')
      .select(`
        id, name, address, city, state, zip, website,
        parking_type, parking_notes, lat, lng,
        description, tags, status, image_url,
        organization:organizations ( id, name ),
        areas ( id, name, description, capacity )
      `)
      .eq('listed', true)   // hide unlisted venues (e.g. bare-address race starts) from the directory
      .order('name', { ascending: true })
    if (fetchError) throw fetchError
    return (data ?? []) as RawRow[]
  }, [], [] as RawRow[])

  return { venues, loading, error }
}

/**
 * Fetch a single venue by ID. Includes organization, areas.
 */
export function useVenue(id: string | null | undefined) {
  const { data: venue, loading, error } = useAsync(async () => {
    if (!id) return null
    const { data, error: fetchError } = await supabase
      .from('venues')
      .select(`
        id, name, address, city, state, zip, website,
        parking_type, parking_notes, lat, lng,
        description, tags, status, image_url,
        organization:organizations ( id, name, website ),
        areas ( id, name, description, capacity )
      `)
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError
    return data as RawRow
  }, [id])

  return { venue, loading, error }
}

/**
 * Fetch all upcoming published events at a given venue.
 */
export function useVenueEvents(venueId: string | null | undefined) {
  const { data: events, loading, error } = useAsync(async () => {
    if (!venueId) return []
    const { data, error: fetchError } = await supabase
      .from('event_venues')
      .select(`
        event:events (
          id, title, start_at, end_at, is_family, is_fundraiser,
          price_min, price_max, image_url, image_width, image_height,
          ticket_url, age_restriction, status, featured,
          event_categories ( category ),
          event_organizations ( organization:organizations ( id, name ) )
        )
      `)
      .eq('venue_id', venueId)
      .not('event', 'is', null)
    if (fetchError) throw fetchError
    return ((data ?? []) as RawRow[])
      .map((row) => row.event as RawRow)
      .filter((e) => e && e.status === 'published')
      .filter((e) => new Date(e.start_at).getTime() > Date.now() - 3 * 3600_000)
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
      .map((e) => {
        const cats = ((e.event_categories ?? []) as RawRow[]).map((ec) => ec.category).filter(Boolean)
        return {
          ...e,
          categories: cats,
          category: cats[0] ?? 'other',
          organizer: e.event_organizations?.[0]?.organization ?? null,
          organizations: ((e.event_organizations ?? []) as RawRow[]).map((eo) => eo.organization).filter(Boolean),
          event_categories: undefined,
        }
      })
  }, [venueId], [] as RawRow[])

  return { events, loading, error }
}

/**
 * Fetch a single event by ID, with venues + organizations joined.
 *
 * Visibility is governed by RLS, not a query filter: anon visitors can only
 * read published events (so an unpublished id resolves to "not found"), while a
 * logged-in admin (authenticated role) can read any status. This is what lets
 * the admin "view public page" / preview links work for pending_review events
 * before they're published — without exposing drafts to the public.
 */
export function useEvent(id: string | null | undefined) {
  const { data: event, loading, error } = useAsync(async () => {
    if (!id) return null
    const { data, error: fetchError } = await supabase
      .from('events')
      .select(`
        *,
        event_categories ( category ),
        event_venues ( venue:venues (
          id, name, address, city, state, zip,
          parking_type, parking_notes, lat, lng, website, image_url
        )),
        event_organizations ( organization:organizations (
          id, name, website, description, image_url
        )),
        event_areas ( area:areas (
          id, name, description, capacity,
          venue:venues ( id, name )
        ))
      `)
      .eq('id', id)
      .single()
    if (fetchError) throw fetchError
    return normalizeEventJoins(data as RawRow)
  }, [id])

  return { event, loading, error }
}

export interface UseRelatedEventsOptions {
  limit?: number
}

/**
 * Fetch upcoming events related to a given event for the "More like this"
 * block. Relatedness = shares ANY of the source event's content categories.
 */
export function useRelatedEvents(
  eventId: string | null | undefined,
  categories: string[] | string | null | undefined,
  { limit = 6 }: UseRelatedEventsOptions = {},
) {
  const catList = Array.isArray(categories)
    ? categories.filter(Boolean)
    : (categories ? [categories] : [])

  const { data: events, loading, error } = useAsync(async () => {
    if (!eventId || catList.length === 0) return []
    let query: LooseQuery = supabase
      .from('events')
      .select(`
        id, title, start_at, end_at, is_family, is_fundraiser,
        price_min, price_max, image_url, image_width, image_height,
        ticket_url, age_restriction, status, featured, tags,
        _catfilter:event_categories!inner ( category ),
        event_categories ( category ),
        event_venues ( venue:venues ( id, name, city, image_url ) ),
        event_organizations ( organization:organizations ( id, name, image_url ) )
      `)
      .eq('status', 'published')
      .in('_catfilter.category', catList)
      .neq('id', eventId)
      .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())
    // "More like this" is a browse surface with the same flood risk: on
    // festival day every music/free/outdoor event's related block would
    // otherwise fill with porch sets. No search concept here, so apply
    // unconditionally. See docs/umbrella-child-hiding.md §2.4.
    query = applyBrowseVisibility(query)
    const { data, error: fetchError } = await query
      .order('start_at', { ascending: true })
      .limit(limit)
    if (fetchError) throw fetchError
    return ((data ?? []) as RawRow[]).map((r) => normalizeEventJoins(r) as AppEvent)
  }, [eventId, catList.join(','), limit], [] as AppEvent[])

  return { events, loading, error }
}

// ── Full-result cache for the map/calendar fetch ─────────────────────────────
// The Map and Calendar views are gated with `enabled` (EventsBrowser mounts
// one hook instance per view), and both can ask for the same filter set.
// Before this cache, every view switch re-downloaded the entire result set —
// measured on the live Everyday Akron embed at 6 SERIAL requests / 5,026 rows /
// ~2.4 MB / ~4.4 s of summed TTFB per switch (2026-08-16). Entries are keyed
// by the full filter signature, deduped while in flight (map + calendar
// asking for the same key share one fetch), and expire after MAP_CACHE_TTL_MS
// so a long-lived tab still refreshes. Module scope on purpose: the cache must
// survive the hook unmounting on a view switch.
interface MapFetchResult { rows: RawRow[]; total: number }
interface MapCacheEntry extends MapFetchResult { at: number }
const mapCache = new Map<string, MapCacheEntry>()
const mapCacheInflight = new Map<string, Promise<MapFetchResult>>()
const MAP_CACHE_TTL_MS = 5 * 60_000
const MAP_CACHE_MAX_ENTRIES = 24

function mapCacheGet(key: string): MapCacheEntry | null {
  const hit = mapCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > MAP_CACHE_TTL_MS) {
    mapCache.delete(key)
    return null
  }
  return hit
}

function mapCachePut(key: string, value: MapFetchResult): void {
  if (mapCache.size >= MAP_CACHE_MAX_ENTRIES) {
    // Evict the oldest entry — Map preserves insertion order.
    const oldest = mapCache.keys().next().value
    if (oldest !== undefined) mapCache.delete(oldest)
  }
  mapCache.set(key, { ...value, at: Date.now() })
}

export interface UseMapEventsOptions {
  categories?: string[]
  excludedCategories?: string[]
  family?: boolean
  excludeFamily?: boolean
  fundraiser?: boolean
  dateRange?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  /** Time-of-day bucket filter. Applied here too so the map view can't
   * diverge from the list view under the same filters (docs/when-filter.md §3.3). */
  timeOfDay?: TimeOfDayId | null
  search?: string | null
  freeOnly?: boolean
  priceMax?: string | null
  hiddenSources?: string[]
  neighborhoodSlug?: string | null
  venueCities?: string[]
  /** When false, the hook holds off fetching (and clears results). */
  enabled?: boolean
}

/**
 * Fetch ALL published events matching the current filters — no pagination.
 * Used by the Map and Calendar views. Lighter select to keep the payload small.
 */
export function useMapEvents({
  categories    = [],
  excludedCategories = [],
  family        = false,
  excludeFamily = false,
  fundraiser    = false,
  dateRange     = null,
  dateFrom      = null,
  dateTo        = null,
  timeOfDay     = null,
  search        = null,
  freeOnly      = false,
  priceMax      = null,
  hiddenSources = [],
  neighborhoodSlug = null,
  venueCities      = [],
  enabled       = true,
}: UseMapEventsOptions = {}) {
  const [events,  setEvents]  = useState<RawRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [total,   setTotal]   = useState(0)

  // The caller may pass fresh array literals on every render, so the fetch
  // effect keys on a serialized form and reads memoized arrays derived from
  // it. Values are slugs/keys (never contain commas), so join/split is safe.
  const categoriesKey    = categories.join(',')
  const excludedCatsKey  = excludedCategories.join(',')
  const hiddenSourcesKey = hiddenSources.join(',')
  const venueCitiesKey   = venueCities.join(',')
  const categoriesStable    = useMemo(() => categoriesKey.split(',').filter(Boolean), [categoriesKey])
  const excludedCatsStable  = useMemo(() => excludedCatsKey.split(',').filter(Boolean), [excludedCatsKey])
  const hiddenSourcesStable = useMemo(() => hiddenSourcesKey.split(',').filter(Boolean), [hiddenSourcesKey])
  const venueCitiesStable   = useMemo(() => venueCitiesKey.split(',').filter(Boolean), [venueCitiesKey])

  useEffect(() => {
    let cancelled = false
    const categories = categoriesStable, excludedCategories = excludedCatsStable, hiddenSources = hiddenSourcesStable, venueCities = venueCitiesStable

    if (!enabled) {
      // Leaving the view is not a reason to forget its data: the old
      // wipe-on-disable (setEvents([]) here) is what forced a full re-download
      // on every List → Map → List round trip. Hold the last result; the
      // cache below serves a fresh copy the moment the view returns.
      return
    }

    // Full filter signature. The `gte(start_at, now())` floor is deliberately
    // NOT part of the key — it moves every second. The TTL bounds the
    // staleness of that floor (and of the data) to a few minutes, which is no
    // worse than what a visitor sitting on an open map view already sees.
    const cacheKey = JSON.stringify([
      categories, excludedCategories, family, excludeFamily, fundraiser,
      dateRange, dateFrom, dateTo, timeOfDay, search, freeOnly, priceMax,
      hiddenSources, neighborhoodSlug, venueCities,
    ])

    const cached = mapCacheGet(cacheKey)
    if (cached) {
      setEvents(cached.rows)
      setTotal(cached.total)
      setError(null)
      setLoading(false)
      return
    }

    async function fetchAllPages(): Promise<MapFetchResult> {
        // Geo scope forces an inner join so events without a matching venue
        // drop out (mirrors useEvents / the hub pages).
        // While searching, the venue scope is applied inside search_events
        // (p_neighborhood / p_cities) instead — see selectEvents.
        const searching = isSearching(search)
        const useInnerVenue = !searching && (!!neighborhoodSlug || venueCities.length > 0)
        const venueJoin = useInnerVenue ? 'event_venues!inner' : 'event_venues'
        const venueTbl  = useInnerVenue ? 'venues!inner'      : 'venues'

        // Rebuilt fresh per page — a Supabase query builder can't be re-awaited
        // once it has resolved, so each .range() call needs its own instance.
        // The exact count is only requested on page 0; re-counting the same
        // filtered set on every parallel page is pure planner overhead.
        const buildQuery = (withCount: boolean): LooseQuery => {
          const floorIso = new Date().toISOString()
          let query: LooseQuery = selectEvents(`
              id, title, start_at, price_min, price_max, is_family, is_fundraiser,
              ${categorySelectFragment(categories, searching)}
              ${venueJoin} ( venue:${venueTbl} ( id, name, address, city, lat, lng, neighborhood_slug ) )
            `, { search, floorIso, neighborhoodSlug, venueCities, withCount })
            .eq('status', 'published')
            // Drop events the moment their start time passes — no in-progress grace window.
            .gte('start_at', floorIso)
            .order('start_at', { ascending: true })

          // Festival children are hidden from the map/calendar too — the
          // calendar in particular would otherwise show a festival-day cell
          // with 160+ events, which is unusable. Skipped when a search term
          // is active, mirroring buildLiveQuery above (the map cannot
          // diverge from the list under identical filters). See
          // docs/umbrella-child-hiding.md §2.2.
          if (!searching) query = applyBrowseVisibility(query)

          query = applyCategoryFilter(query, categories, searching)
          if (excludedCategories.length > 0) {
            query = query.not('category_slugs', 'ov', `{${excludedCategories.join(',')}}`)
          }
          if (family)             query = query.eq('is_family', true)
          else if (excludeFamily) query = query.not('is_family', 'is', true)
          if (fundraiser) query = query.eq('is_fundraiser', true)

          if (useInnerVenue && neighborhoodSlug) {
            query = query.eq('event_venues.venues.neighborhood_slug', neighborhoodSlug)
          }
          if (useInnerVenue && venueCities.length > 0) {
            query = query.in('event_venues.venues.city', venueCities)
          }

          if (hiddenSources.length > 0) {
            query = query.not('source', 'in', `(${hiddenSources.join(',')})`)
          }

          if (dateFrom || dateTo) {
            if (dateFrom) query = query.gte('start_at', new Date(dateFrom + 'T00:00:00').toISOString())
            if (dateTo)   query = query.lte('start_at', new Date(dateTo + 'T23:59:59').toISOString())
          } else if (dateRange) {
            const { start, end } = dateRangeBounds(dateRange)
            query = query.gte('start_at', start.toISOString()).lte('start_at', end.toISOString())
          }

          const todBounds = timeOfDayBounds(timeOfDay)
          if (todBounds) {
            query = query.gte('start_hour_et', todBounds[0]).lte('start_hour_et', todBounds[1])
          }

          if (freeOnly) {
            query = query.eq('price_min', 0).or('price_max.is.null,price_max.eq.0')
          } else if (priceMax === 'under10') {
            query = query.lte('price_min', 10)
          } else if (priceMax === 'under25') {
            query = query.lte('price_min', 25)
          }

          // No search filter here: a term is matched by search_events
          // (selectEvents above), exactly as in useEvents.
          return query
        }

        // PostgREST caps any single response at ~1000 rows, and this fetch
        // must return *all* matching events (the Calendar lays them across its
        // visible grid; the map draws every pin). Page 0 carries the exact
        // count, so every remaining page is known up front and fetched IN
        // PARALLEL: the previous do…while awaited each 1000-row page before
        // asking for the next — six serial round trips on the full corpus,
        // which was the dominant cost on partner embeds. MAX_ROWS stays as the
        // safety stop against a runaway query.
        const CHUNK = 1000
        const MAX_ROWS = 20000
        // One retry per page on a statement timeout / gateway error (see
        // queryRetry.ts); each attempt builds its own query.
        type PageResult = { data: RawRow[] | null; error: unknown; count: number | null; status?: number }
        const first = await withOneRetry<PageResult>(() => buildQuery(true).range(0, CHUNK - 1))
        if (first.error) throw first.error
        const total = (first.count as number | null) ?? (first.data?.length ?? 0)
        const allRows: RawRow[] = [...((first.data ?? []) as RawRow[])]
        const target = Math.min(total, MAX_ROWS)
        if (allRows.length === CHUNK && allRows.length < target) {
          const starts: number[] = []
          for (let s = CHUNK; s < target; s += CHUNK) starts.push(s)
          // Bare builders are lazy thenables; Promise.all assimilates them,
          // firing every page request concurrently.
          const pages = await Promise.all(
            starts.map((s) => withOneRetry<PageResult>(() => buildQuery(false).range(s, s + CHUNK - 1))),
          )
          // Rows can shift between parallel pages if the table changes
          // mid-flight; dedupe by id so a shifted row can't appear twice.
          // (The old serial loop had the same race, without the dedupe.)
          const seen = new Set(allRows.map((r) => r.id))
          for (const page of pages) {
            if (page.error) throw page.error
            for (const row of (page.data ?? []) as RawRow[]) {
              if (!seen.has(row.id)) {
                seen.add(row.id)
                allRows.push(row)
              }
            }
          }
        }

        const mapped = allRows.map((e) => {
          const venues = ((e.event_venues ?? []) as RawRow[]).map((ev) => ev.venue).filter(Boolean)
          const cats = ((e.event_categories ?? []) as RawRow[]).map((ec) => ec.category).filter(Boolean)
          return {
            ...e,
            categories: cats,
            category: cats[0] ?? 'other',
            venue: venues[0] ?? null,
            venues,
            event_venues: undefined,
            event_categories: undefined,
          }
        })
        return { rows: mapped, total }
    }

    async function run() {
      setLoading(true)
      setError(null)
      try {
        // In-flight dedupe: when the map and calendar instances (or a rapid
        // view flip) ask for the same key, they share ONE network fetch.
        let promise = mapCacheInflight.get(cacheKey)
        if (!promise) {
          promise = fetchAllPages()
          mapCacheInflight.set(cacheKey, promise)
          promise
            .then((result) => mapCachePut(cacheKey, result))
            .catch(() => { /* surfaced to each awaiting subscriber below */ })
            .finally(() => mapCacheInflight.delete(cacheKey))
        }
        const result = await promise
        if (!cancelled) {
          setEvents(result.rows)
          setTotal(result.total)
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err, 'Failed to load map events.'))
          // Same rule as useEvents: rows held from a previous filter set must
          // not be drawn under filters whose fetch failed.
          setEvents([])
          setTotal(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => { cancelled = true }
  }, [enabled, categoriesStable, excludedCatsStable, family, excludeFamily, fundraiser, dateRange, dateFrom, dateTo, timeOfDay, search, freeOnly, priceMax, hiddenSourcesStable, neighborhoodSlug, venueCitiesStable])

  return { events, loading, error, total }
}

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATION HOOKS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all organizations, ordered by name. Includes upcoming-event counts.
 */
export function useOrganizations() {
  const { data: organizations, loading, error } = useAsync(async () => {
    const { data, error: fetchError } = await supabase
      .from('organizations')
      .select(`
        id, name, website, description, image_url,
        address, city, state, zip, status, photos,
        venues ( id, name ),
        event_organizations ( event_id )
      `)
      .eq('status', 'published')
      .order('name', { ascending: true })
    if (fetchError) throw fetchError
    return ((data ?? []) as RawRow[]).map((org) => ({
      ...org,
      venueCount: org.venues?.length ?? 0,
      eventCount: org.event_organizations?.length ?? 0,
    }))
  }, [], [] as RawRow[])

  return { organizations, loading, error }
}

/**
 * Fetch a single organization by ID with venues and events.
 */
export function useOrganization(id: string | null | undefined) {
  const { data: organization, loading, error } = useAsync<RawRow | null>(async () => {
    if (!id) return null
    const { data, error: fetchError } = await supabase
      .from('organizations')
      .select(`
        *,
        venues ( id, name, address, city, state, zip, lat, lng, website, tags, status ),
        event_organizations (
          event:events (
            id, title, start_at, end_at, is_family, is_fundraiser,
            price_min, price_max, image_url, image_width, image_height,
            ticket_url, age_restriction, status, featured,
            event_categories ( category ),
            event_venues ( venue:venues ( id, name, city ) )
          )
        )
      `)
      .eq('id', id)
      .eq('status', 'published')
      .single()
    if (fetchError) throw fetchError
    if (!data) return null
    const row = data as RawRow
    const events = ((row.event_organizations ?? []) as RawRow[])
      .map((eo) => eo.event as RawRow)
      .filter((e) => e && e.status === 'published')
      .filter((e) => new Date(e.start_at).getTime() > Date.now() - 3 * 3600_000)
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
      .map((e) => {
        const cats = ((e.event_categories ?? []) as RawRow[]).map((ec) => ec.category).filter(Boolean)
        return {
          ...e,
          categories: cats,
          category: cats[0] ?? 'other',
          venue: e.event_venues?.[0]?.venue ?? null,
          venues: ((e.event_venues ?? []) as RawRow[]).map((ev) => ev.venue).filter(Boolean),
          event_categories: undefined,
        }
      })
    return { ...row, events } as RawRow
  }, [id])

  return { organization, loading, error }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Flatten junction table arrays into the backward-compatible `AppEvent` shape:
 * singular `venue`/`organizer` plus the full `venues`/`organizations`/`areas`
 * arrays, and a `categories` list with a singular `category` shim (= primary).
 */
function normalizeEventJoins(event: RawRow | null | undefined): AppEvent | null {
  if (!event) return null

  const venues = ((event.event_venues ?? []) as RawRow[])
    .map((ev) => ev.venue)
    .filter(Boolean)

  const organizations = ((event.event_organizations ?? []) as RawRow[])
    .map((eo) => eo.organization)
    .filter(Boolean)

  const areas = ((event.event_areas ?? []) as RawRow[])
    .map((ea) => ea.area)
    .filter(Boolean)

  const categories = ((event.event_categories ?? []) as RawRow[])
    .map((ec) => ec.category)
    .filter(Boolean)

  return {
    ...event,
    categories,
    category:   categories[0] ?? event.category ?? 'other',
    venue:      venues[0] ?? null,
    venues,
    organizer:  organizations[0] ?? null,
    organizations,
    areas,
    event_venues: undefined,
    event_organizations: undefined,
    event_areas: undefined,
    event_categories: undefined,
  } as unknown as AppEvent
}
