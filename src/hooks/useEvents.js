import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

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
function normalizeSearch(term) {
  return term
    .normalize('NFD')              // decompose: é → e + U+0301 combining acute
    .replace(/\p{Diacritic}/gu, '') // strip all combining diacritic marks
    .toLowerCase()
}

export const PAGE_SIZE = 24

/**
 * Fetch a paginated page of published events with server-side filtering.
 * v2: Uses junction tables for venue/organization relationships.
 *
 * Supabase PostgREST can resolve junction tables with the spread syntax:
 *   event_venues!inner ( venue:venues (...) )
 * But for many-to-many where events may have 0..N venues, we need left joins.
 * We fetch venues and organizations as nested arrays.
 */
/**
 * Build the embedded-category select + apply an any-match (OR) filter on the
 * event_categories join table.
 *
 * PostgREST trick: we embed event_categories TWICE —
 *   • a normal embed `event_categories(category)` so every event comes back
 *     with its FULL category list (for badges), and
 *   • an aliased INNER embed `_catfilter:event_categories!inner(category)`
 *     used purely to filter the parent down to events that have at least one
 *     of the requested categories. Without the alias, filtering the embed
 *     would also prune the displayed list.
 * Returns the select fragment to splice in; caller applies `.in()` when
 * categories are present.
 */
function categorySelectFragment(categories) {
  const filterEmbed = categories.length > 0
    ? '_catfilter:event_categories!inner ( category ),'
    : ''
  return `${filterEmbed} event_categories ( category ),`
}

function applyCategoryFilter(query, categories) {
  if (categories.length > 0) {
    query = query.in('_catfilter.category', categories)
  }
  return query
}

export function useEvents({
  categories       = [],
  family           = false,
  fundraiser       = false,
  dateRange        = null,
  dateFrom         = null,
  dateTo           = null,
  search           = null,
  freeOnly         = false,
  priceMax         = null,
  hiddenSources    = [],
  // When set, restrict to events whose venue.neighborhood_slug matches.
  // This is the push-down used by neighborhood hub pages so they don't
  // have to fetch 100 events and filter client-side — which silently
  // misses events when other neighborhoods crowd the first page.
  neighborhoodSlug = null,
  // When non-empty, restrict to events whose venue.city is one of these
  // values. Used by Summit County city hub pages (Hudson, Stow, etc.) to
  // push city filtering server-side rather than fetching all 2,500+ events
  // and discarding most of them on the client.
  venueCities      = [],
  sort             = 'soonest',
  limit            = PAGE_SIZE,
  offset           = 0,
} = {}) {
  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [total,   setTotal]   = useState(0)

  useEffect(() => {
    let cancelled = false

    async function fetchEvents() {
      setLoading(true)
      setError(null)

      try {
        // The venue embed is an inner join only when neighborhoodSlug is
        // set — that flips PostgREST into "filter the parent by the
        // child" mode and lets us hand the slug constraint to Postgres
        // (see the .eq below). Without !inner, embedded filters become
        // a "filter the embedded resource" — the event still comes
        // back, just with venue=null, which would silently lie to the
        // matcher. The empty-string trick keeps the syntax stable
        // whether or not we're filtering.
        const useInnerVenue = !!neighborhoodSlug || venueCities.length > 0
        const venueJoin = useInnerVenue ? 'event_venues!inner' : 'event_venues'
        const venueTbl  = useInnerVenue ? 'venues!inner'      : 'venues'

        let query = supabase
          .from('events')
          .select(`
            *,
            ${categorySelectFragment(categories)}
            ${venueJoin} ( venue:${venueTbl} ( id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website, image_url, neighborhood_slug ) ),
            event_organizations ( organization:organizations ( id, name, website, description, image_url ) )
          `, { count: 'exact' })
          .eq('status', 'published')
          .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())

        if (neighborhoodSlug) {
          // PostgREST embedded-table filter: references the actual table
          // names (`event_venues.venues.neighborhood_slug`), not the
          // `venue:` alias we used in the select. Inner-joined embeds
          // propagate the filter up so the events query returns only
          // rows where at least one joined venue matches.
          query = query.eq('event_venues.venues.neighborhood_slug', neighborhoodSlug)
        }
        if (venueCities.length > 0) {
          query = query.in('event_venues.venues.city', venueCities)
        }

        // Content axis: any-match against the event_categories join table.
        query = applyCategoryFilter(query, categories)

        // Facet axis: cross-cutting boolean flags.
        if (family)     query = query.eq('is_family', true)
        if (fundraiser) query = query.eq('is_fundraiser', true)

        if (hiddenSources.length > 0) {
          query = query.not('source', 'in', `(${hiddenSources.join(',')})`)
        }

        if (dateFrom || dateTo) {
          if (dateFrom) query = query.gte('start_at', new Date(dateFrom + 'T00:00:00').toISOString())
          if (dateTo)   query = query.lte('start_at', new Date(dateTo + 'T23:59:59').toISOString())
        } else if (dateRange) {
          const now   = new Date()
          const start = new Date(now)
          const end   = new Date(now)

          if (dateRange === 'today') {
            start.setHours(0, 0, 0, 0)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_weekend') {
            const dayOfWeek = now.getDay()
            const daysToSat = (6 - dayOfWeek + 7) % 7 || 7
            start.setDate(now.getDate() + daysToSat)
            start.setHours(0, 0, 0, 0)
            end.setDate(start.getDate() + 1)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_week') {
            start.setHours(0, 0, 0, 0)
            const daysToSun = (7 - now.getDay()) % 7 || 7
            end.setDate(now.getDate() + daysToSun)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_month') {
            start.setHours(0, 0, 0, 0)
            end.setMonth(now.getMonth() + 1, 0)
            end.setHours(23, 59, 59, 999)
          }

          query = query
            .gte('start_at', start.toISOString())
            .lte('start_at', end.toISOString())
        }

        if (freeOnly) {
          query = query.eq('price_min', 0).or('price_max.is.null,price_max.eq.0')
        } else if (priceMax === 'under10') {
          query = query.lte('price_min', 10)
        } else if (priceMax === 'under25') {
          query = query.lte('price_min', 25)
        }

        if (search && search.trim().length > 0) {
          // Normalize the term to match the DB's trigger-maintained columns
          // (unaccent + lower). This makes search accent-insensitive in both
          // directions: "Pokemon" and "Pokémon" both resolve to "pokemon" and
          // hit the GIN trigram index on title_normalized / description_normalized.
          // NOTE: inside .or() PostgREST uses * as the ilike wildcard, not %.
          const term = normalizeSearch(search.trim())
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
          // Flatten junction table results for backward compatibility
          setEvents((data ?? []).map(normalizeEventJoins))
          setTotal(count ?? 0)
        }
      } catch (err) {
        if (!cancelled) setError(err.message ?? 'Failed to load events.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [categories.join(','), family, fundraiser, dateRange, dateFrom, dateTo, search, freeOnly, priceMax, hiddenSources.join(','), neighborhoodSlug, venueCities.join(','), sort, limit, offset])

  const hasMore = offset + limit < total

  return { events, loading, error, total, hasMore }
}

/**
 * Fetch all venues, ordered by name.
 * v2: Includes organization join and areas.
 */
export function useVenues() {
  const [venues,  setVenues]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchVenues() {
      setLoading(true)
      setError(null)

      const { data, error: fetchError } = await supabase
        .from('venues')
        .select(`
          id, name, address, city, state, zip, website,
          parking_type, parking_notes, lat, lng,
          description, tags, status, image_url,
          organization:organizations ( id, name ),
          areas ( id, name, description, capacity )
        `)
        .order('name', { ascending: true })

      if (!cancelled) {
        if (fetchError) setError(fetchError.message)
        else setVenues(data ?? [])
        setLoading(false)
      }
    }

    fetchVenues()
    return () => { cancelled = true }
  }, [])

  return { venues, loading, error }
}

/**
 * Fetch a single venue by ID.
 * v2: Includes organization, areas.
 */
export function useVenue(id) {
  const [venue,   setVenue]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    async function fetchVenue() {
      setLoading(true)
      setError(null)

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

      if (!cancelled) {
        if (fetchError) setError(fetchError.message)
        else setVenue(data)
        setLoading(false)
      }
    }

    fetchVenue()
    return () => { cancelled = true }
  }, [id])

  return { venue, loading, error }
}

/**
 * Fetch all upcoming published events at a given venue.
 * v2: Uses event_venues junction table.
 */
export function useVenueEvents(venueId) {
  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false

    async function fetchVenueEvents() {
      setLoading(true)
      setError(null)

      // Query through the junction table
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

      if (!cancelled) {
        if (fetchError) {
          setError(fetchError.message)
        } else {
          // Unwrap the junction: each row is { event: {...} }
          const unwrapped = (data ?? [])
            .map(row => row.event)
            .filter(e => e && e.status === 'published')
            .filter(e => new Date(e.start_at).getTime() > Date.now() - 3 * 3600_000)
            .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))

          // Flatten org + category junctions for backward compat
          setEvents(unwrapped.map(e => {
            const cats = (e.event_categories ?? []).map(ec => ec.category).filter(Boolean)
            return {
              ...e,
              categories: cats,
              category: cats[0] ?? 'other',
              organizer: e.event_organizations?.[0]?.organization ?? null,
              organizations: (e.event_organizations ?? []).map(eo => eo.organization).filter(Boolean),
              event_categories: undefined,
            }
          }))
        }
        setLoading(false)
      }
    }

    fetchVenueEvents()
    return () => { cancelled = true }
  }, [venueId])

  return { events, loading, error }
}

/**
 * Fetch a single published event by ID, with venues + organizations joined.
 * v2: Uses junction tables.
 */
export function useEvent(id) {
  const [event,   setEvent]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    async function fetchEvent() {
      setLoading(true)
      setError(null)

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

      if (!cancelled) {
        if (fetchError) setError(fetchError.message)
        else setEvent(normalizeEventJoins(data))
        setLoading(false)
      }
    }

    fetchEvent()
    return () => { cancelled = true }
  }, [id])

  return { event, loading, error }
}

/**
 * Fetch upcoming events related to a given event for the "More like this"
 * block on the event detail page.
 *
 * Strategy:
 *   1. Same category as the source event.
 *   2. Different event id (don't link to self).
 *   3. status = 'published'.
 *   4. start_at in the future (no past events).
 *   5. Order by start_at ascending — soonest next is most relevant.
 *   6. Limit 6 so the UI has room to drop any with broken data.
 *
 * Returns an empty array (not null) when there's nothing to show; the
 * caller's render path treats empty as "render nothing."
 *
 * `categories` may be an array (preferred) or a single slug string (back-compat
 * with callers still passing event.category). Relatedness = shares ANY of the
 * source event's content categories (matches the OR/any-match filter model).
 */
export function useRelatedEvents(eventId, categories, { limit = 6 } = {}) {
  const catList = Array.isArray(categories)
    ? categories.filter(Boolean)
    : (categories ? [categories] : [])

  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!eventId || catList.length === 0) {
      setEvents([])
      setLoading(false)
      return
    }
    let cancelled = false

    async function fetchRelated() {
      setLoading(true)
      setError(null)

      try {
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

        if (!cancelled) {
          if (fetchError) setError(fetchError.message)
          else setEvents((data ?? []).map(normalizeEventJoins))
        }
      } catch (err) {
        if (!cancelled) setError(err.message ?? 'Failed to load related events.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchRelated()
    return () => { cancelled = true }
  }, [eventId, catList.join(','), limit])

  return { events, loading, error }
}

/**
 * Fetch ALL published events matching the current filters — no pagination.
 * Used exclusively by MapView so it can display every matching venue/event.
 *
 * Uses a lighter select (only the fields the map actually needs) to keep
 * the payload small even when there are hundreds of events.
 */
export function useMapEvents({
  categories    = [],
  family        = false,
  fundraiser    = false,
  dateRange     = null,
  dateFrom      = null,
  dateTo        = null,
  search        = null,
  freeOnly      = false,
  priceMax      = null,
  hiddenSources = [],
} = {}) {
  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [total,   setTotal]   = useState(0)

  useEffect(() => {
    let cancelled = false

    async function fetchMapEvents() {
      setLoading(true)
      setError(null)

      try {
        let query = supabase
          .from('events')
          .select(`
            id, title, start_at, price_min, price_max, is_family, is_fundraiser,
            ${categorySelectFragment(categories)}
            event_venues ( venue:venues ( id, name, address, city, lat, lng ) )
          `, { count: 'exact' })
          .eq('status', 'published')
          .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())
          .order('start_at', { ascending: true })

        query = applyCategoryFilter(query, categories)
        if (family)     query = query.eq('is_family', true)
        if (fundraiser) query = query.eq('is_fundraiser', true)

        if (hiddenSources.length > 0) {
          query = query.not('source', 'in', `(${hiddenSources.join(',')})`)
        }

        if (dateFrom || dateTo) {
          if (dateFrom) query = query.gte('start_at', new Date(dateFrom + 'T00:00:00').toISOString())
          if (dateTo)   query = query.lte('start_at', new Date(dateTo + 'T23:59:59').toISOString())
        } else if (dateRange) {
          const now   = new Date()
          const start = new Date(now)
          const end   = new Date(now)

          if (dateRange === 'today') {
            start.setHours(0, 0, 0, 0)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_weekend') {
            const dayOfWeek = now.getDay()
            const daysToSat = (6 - dayOfWeek + 7) % 7 || 7
            start.setDate(now.getDate() + daysToSat)
            start.setHours(0, 0, 0, 0)
            end.setDate(start.getDate() + 1)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_week') {
            start.setHours(0, 0, 0, 0)
            const daysToSun = (7 - now.getDay()) % 7 || 7
            end.setDate(now.getDate() + daysToSun)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_month') {
            start.setHours(0, 0, 0, 0)
            end.setMonth(now.getMonth() + 1, 0)
            end.setHours(23, 59, 59, 999)
          }

          query = query
            .gte('start_at', start.toISOString())
            .lte('start_at', end.toISOString())
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
          query = query.or(
            `title_normalized.ilike.*${term}*,description_normalized.ilike.*${term}*`
          )
        }

        // No .range() — fetch everything
        const { data, error: fetchError, count } = await query

        if (fetchError) throw fetchError
        if (!cancelled) {
          // Flatten venue junction for the map
          const mapped = (data ?? []).map(e => {
            const venues = (e.event_venues ?? []).map(ev => ev.venue).filter(Boolean)
            const cats = (e.event_categories ?? []).map(ec => ec.category).filter(Boolean)
            return {
              ...e,
              categories: cats,
              category: cats[0] ?? 'other', // back-compat: marker color keys off primary
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
        if (!cancelled) setError(err.message ?? 'Failed to load map events.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchMapEvents()
    return () => { cancelled = true }
  }, [categories.join(','), family, fundraiser, dateRange, dateFrom, dateTo, search, freeOnly, priceMax, hiddenSources.join(',')])

  return { events, loading, error, total }
}

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATION HOOKS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all organizations, ordered by name.
 * Includes a count of upcoming events for each org.
 */
export function useOrganizations() {
  const [organizations, setOrganizations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchOrganizations() {
      setLoading(true)
      setError(null)

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

      if (!cancelled) {
        if (fetchError) {
          setError(fetchError.message)
        } else {
          setOrganizations((data ?? []).map(org => ({
            ...org,
            venueCount: org.venues?.length ?? 0,
            eventCount: org.event_organizations?.length ?? 0,
          })))
        }
        setLoading(false)
      }
    }

    fetchOrganizations()
    return () => { cancelled = true }
  }, [])

  return { organizations, loading, error }
}

/**
 * Fetch a single organization by ID with venues and events.
 */
export function useOrganization(id) {
  const [organization, setOrganization] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    async function fetchOrganization() {
      setLoading(true)
      setError(null)

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

      if (!cancelled) {
        if (fetchError) {
          setError(fetchError.message)
        } else if (data) {
          // Unwrap event junction + flatten venue data on events
          const events = (data.event_organizations ?? [])
            .map(eo => eo.event)
            .filter(e => e && e.status === 'published')
            .filter(e => new Date(e.start_at).getTime() > Date.now() - 3 * 3600_000)
            .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
            .map(e => {
              const cats = (e.event_categories ?? []).map(ec => ec.category).filter(Boolean)
              return {
                ...e,
                categories: cats,
                category: cats[0] ?? 'other',
                venue: e.event_venues?.[0]?.venue ?? null,
                venues: (e.event_venues ?? []).map(ev => ev.venue).filter(Boolean),
                event_categories: undefined,
              }
            })

          setOrganization({ ...data, events })
        }
        setLoading(false)
      }
    }

    fetchOrganization()
    return () => { cancelled = true }
  }, [id])

  return { organization, loading, error }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Flatten junction table arrays into backward-compatible shape.
 *
 * Input (from Supabase):
 *   event_venues: [{ venue: { id, name, ... } }, ...]
 *   event_organizations: [{ organization: { id, name, ... } }, ...]
 *
 * Output:
 *   venue:         first venue (for backward compat with EventCard/EventPage)
 *   venues:        all venues array
 *   organizer:     first organization (backward compat alias)
 *   organizations: all organizations array
 *   areas:         all areas array (with parent venue info)
 */
function normalizeEventJoins(event) {
  if (!event) return event

  const venues = (event.event_venues ?? [])
    .map(ev => ev.venue)
    .filter(Boolean)

  const organizations = (event.event_organizations ?? [])
    .map(eo => eo.organization)
    .filter(Boolean)

  const areas = (event.event_areas ?? [])
    .map(ea => ea.area)
    .filter(Boolean)

  // Content axis now lives in the event_categories join table. Expose the full
  // list as `categories`, plus a singular `category` shim (= primary) so the
  // many components still reading `event.category` keep working until Phase 5
  // updates them to render the full multi-category set.
  const categories = (event.event_categories ?? [])
    .map(ec => ec.category)
    .filter(Boolean)

  return {
    ...event,
    categories,
    category:   categories[0] ?? event.category ?? 'other',
    // Backward compat: first venue/org as singular
    venue:      venues[0] ?? null,
    venues,
    organizer:  organizations[0] ?? null,
    organizations,
    areas,
    // Clean up raw junction data
    event_venues: undefined,
    event_organizations: undefined,
    event_areas: undefined,
    event_categories: undefined,
  }
}
