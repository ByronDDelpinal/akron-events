import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { EVENT_LIST_COLUMNS } from '@/lib/firstPageQuery'
import { dateRangeBounds } from '@/lib/dateRange'
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

/**
 * Normalize a search term for accent-insensitive matching against the
 * title_normalized / description_normalized columns in Postgres.
 *
 * Strategy mirrors the DB trigger (unaccent + lower):
 *   "Pokémon" → NFD decompose → strip combining diacritics → lowercase → "pokemon"
 *   "Pokemon" →                                                           "pokemon"
 *
 * Both resolve to the same form, so either spelling finds "Pokémon Club".
 */
function normalizeSearch(term: string): string {
  return term
    .normalize('NFD')              // decompose: é → e + U+0301 combining acute
    .replace(/\p{Diacritic}/gu, '') // strip all combining diacritic marks
    .toLowerCase()
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
function categorySelectFragment(categories: string[]): string {
  const filterEmbed = categories.length > 0
    ? '_catfilter:event_categories!inner ( category ),'
    : ''
  return `${filterEmbed} event_categories ( category ),`
}

function applyCategoryFilter(query: LooseQuery, categories: string[]): LooseQuery {
  if (categories.length > 0) {
    query = query.in('_catfilter.category', categories)
  }
  return query
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
  search?: string | null
  freeOnly?: boolean
  priceMax?: string | null
  hiddenSources?: string[]
  neighborhoodSlug?: string | null
  venueCities?: string[]
  sort?: string
  limit?: number
  offset?: number
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
  search           = null,
  freeOnly         = false,
  priceMax         = null,
  hiddenSources    = [],
  neighborhoodSlug = null,
  venueCities      = [],
  sort             = 'soonest',
  limit            = PAGE_SIZE,
  offset           = 0,
}: UseEventsOptions = {}) {
  const [events,  setEvents]  = useState<AppEvent[]>([])
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

    // The pristine homepage request (page one, no filters, default
    // sort) is byte-identical for every visitor, so it's served from
    // /api/events-first-page — cached at Vercel's edge (s-maxage=300 +
    // a day of stale-while-revalidate), answering in ~50 ms worldwide
    // instead of paying PostgREST latency. Any failure falls through
    // to the normal live query.
    const isDefaultFirstPage =
      categories.length === 0 && excludedCategories.length === 0 &&
      !family && !excludeFamily && !fundraiser &&
      !dateRange && !dateFrom && !dateTo &&
      (!search || search.trim().length === 0) &&
      !freeOnly && !priceMax &&
      hiddenSources.length === 0 && !neighborhoodSlug &&
      venueCities.length === 0 &&
      sort === 'soonest' && offset === 0 && limit === PAGE_SIZE

    async function fetchEvents() {
      setLoading(true)
      setError(null)

      if (isDefaultFirstPage) {
        try {
          const res = await fetch('/api/events-first-page')
          if (res.ok) {
            const { events: rows, total: cachedTotal } = await res.json()
            if (Array.isArray(rows)) {
              if (!cancelled) {
                setEvents(rows.map((r: RawRow) => normalizeEventJoins(r) as AppEvent))
                setTotal(cachedTotal ?? 0)
                setLoading(false)
              }
              return
            }
          }
        } catch {
          // CDN/function unavailable (or vite dev, where /api doesn't
          // exist) — fall through to the live PostgREST query.
        }
      }

      try {
        // The venue embed is an inner join only when neighborhoodSlug is
        // set — that flips PostgREST into "filter the parent by the
        // child" mode and lets us hand the slug constraint to Postgres.
        const useInnerVenue = !!neighborhoodSlug || venueCities.length > 0
        const venueJoin = useInnerVenue ? 'event_venues!inner' : 'event_venues'
        const venueTbl  = useInnerVenue ? 'venues!inner'      : 'venues'

        // Explicit column list (shared with api/events-first-page.js),
        // NOT `*`: the list surfaces never render event descriptions,
        // and the *_normalized columns are server-side search
        // artifacts. Dropping them halves the page payload (~48 kB →
        // ~26 kB measured 2026-06). Detail pages (useEvent) still
        // select * for the full record.
        let query: LooseQuery = supabase
          .from('events')
          .select(`
            ${EVENT_LIST_COLUMNS},
            ${categorySelectFragment(categories)}
            ${venueJoin} ( venue:${venueTbl} ( id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website, image_url, neighborhood_slug ) ),
            event_organizations ( organization:organizations ( id, name, website, description, image_url ) )
          `, { count: 'exact' })
          .eq('status', 'published')
          // Drop events the moment their start time passes — no in-progress grace window.
          .gte('start_at', new Date().toISOString())

        if (neighborhoodSlug) {
          query = query.eq('event_venues.venues.neighborhood_slug', neighborhoodSlug)
        }
        if (venueCities.length > 0) {
          query = query.in('event_venues.venues.city', venueCities)
        }

        // Content axis: any-match against the event_categories join table.
        query = applyCategoryFilter(query, categories)
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
          if (dateFrom) query = query.gte('start_at', new Date(dateFrom + 'T00:00:00').toISOString())
          if (dateTo)   query = query.lte('start_at', new Date(dateTo + 'T23:59:59').toISOString())
        } else if (dateRange) {
          const { start, end } = dateRangeBounds(dateRange)
          query = query.gte('start_at', start.toISOString()).lte('start_at', end.toISOString())
        }

        if (freeOnly) {
          query = query.eq('price_min', 0).or('price_max.is.null,price_max.eq.0')
        } else if (priceMax === 'under10') {
          query = query.lte('price_min', 10)
        } else if (priceMax === 'under25') {
          query = query.lte('price_min', 25)
        }

        if (search && search.trim().length > 0) {
          const term = normalizeSearch(search.trim())
          // Tags are folded into description_normalized server-side (migration
          // 031), so this title/description match also covers tag searches
          // (e.g. "baseball" → events tagged baseball) without a fragile
          // array-contains filter inside .or().
          query = query.or(
            `title_normalized.ilike.*${term}*,description_normalized.ilike.*${term}*`
          )
        }

        if (sort === 'latest') {
          query = query.order('start_at', { ascending: false })
        } else if (sort === 'recent') {
          query = query.order('created_at', { ascending: false })
        } else {
          query = query.order('start_at', { ascending: true })
        }

        query = query.range(offset, offset + limit - 1)

        const { data, error: fetchError, count } = await query

        if (fetchError) throw fetchError
        if (!cancelled) {
          setEvents((data ?? []).map((r: RawRow) => normalizeEventJoins(r) as AppEvent))
          setTotal(count ?? 0)
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Failed to load events.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [categoriesStable, excludedCatsStable, family, excludeFamily, fundraiser, dateRange, dateFrom, dateTo, search, freeOnly, priceMax, hiddenSourcesStable, neighborhoodSlug, venueCitiesStable, sort, limit, offset])

  const hasMore = offset + limit < total

  return { events, loading, error, total, hasMore }
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
 * Fetch a single published event by ID, with venues + organizations joined.
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
      .eq('status', 'published')
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
    const { data, error: fetchError } = await supabase
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
      .order('start_at', { ascending: true })
      .limit(limit)
    if (fetchError) throw fetchError
    return ((data ?? []) as RawRow[]).map((r) => normalizeEventJoins(r) as AppEvent)
  }, [eventId, catList.join(','), limit], [] as AppEvent[])

  return { events, loading, error }
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
  search?: string | null
  freeOnly?: boolean
  priceMax?: string | null
  hiddenSources?: string[]
  neighborhoodSlug?: string | null
  venueCities?: string[]
}

/**
 * Fetch ALL published events matching the current filters — no pagination.
 * Used exclusively by MapView. Lighter select to keep the payload small.
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
  search        = null,
  freeOnly      = false,
  priceMax      = null,
  hiddenSources = [],
  neighborhoodSlug = null,
  venueCities      = [],
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

    async function fetchMapEvents() {
      setLoading(true)
      setError(null)

      try {
        // Geo scope forces an inner join so events without a matching venue
        // drop out (mirrors useEvents / the hub pages).
        const useInnerVenue = !!neighborhoodSlug || venueCities.length > 0
        const venueJoin = useInnerVenue ? 'event_venues!inner' : 'event_venues'
        const venueTbl  = useInnerVenue ? 'venues!inner'      : 'venues'

        let query: LooseQuery = supabase
          .from('events')
          .select(`
            id, title, start_at, price_min, price_max, is_family, is_fundraiser,
            ${categorySelectFragment(categories)}
            ${venueJoin} ( venue:${venueTbl} ( id, name, address, city, lat, lng, neighborhood_slug ) )
          `, { count: 'exact' })
          .eq('status', 'published')
          // Drop events the moment their start time passes — no in-progress grace window.
          .gte('start_at', new Date().toISOString())
          .order('start_at', { ascending: true })

        query = applyCategoryFilter(query, categories)
        if (excludedCategories.length > 0) {
          query = query.not('category_slugs', 'ov', `{${excludedCategories.join(',')}}`)
        }
        if (family)             query = query.eq('is_family', true)
        else if (excludeFamily) query = query.not('is_family', 'is', true)
        if (fundraiser) query = query.eq('is_fundraiser', true)

        if (neighborhoodSlug) {
          query = query.eq('event_venues.venues.neighborhood_slug', neighborhoodSlug)
        }
        if (venueCities.length > 0) {
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

        if (freeOnly) {
          query = query.eq('price_min', 0).or('price_max.is.null,price_max.eq.0')
        } else if (priceMax === 'under10') {
          query = query.lte('price_min', 10)
        } else if (priceMax === 'under25') {
          query = query.lte('price_min', 25)
        }

        if (search && search.trim().length > 0) {
          const term = normalizeSearch(search.trim())
          // Tags are folded into description_normalized server-side (migration
          // 031), so this title/description match also covers tag searches
          // (e.g. "baseball" → events tagged baseball) without a fragile
          // array-contains filter inside .or().
          query = query.or(
            `title_normalized.ilike.*${term}*,description_normalized.ilike.*${term}*`
          )
        }

        const { data, error: fetchError, count } = await query

        if (fetchError) throw fetchError
        if (!cancelled) {
          const mapped = ((data ?? []) as RawRow[]).map((e) => {
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
          setEvents(mapped)
          setTotal(count ?? 0)
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Failed to load map events.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchMapEvents()
    return () => { cancelled = true }
  }, [categoriesStable, excludedCatsStable, family, excludeFamily, fundraiser, dateRange, dateFrom, dateTo, search, freeOnly, priceMax, hiddenSourcesStable, neighborhoodSlug, venueCitiesStable])

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
