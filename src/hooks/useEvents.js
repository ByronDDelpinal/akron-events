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
export function useEvents({
  categories    = [],
  dateRange     = null,
  dateFrom      = null,
  dateTo        = null,
  search        = null,
  freeOnly      = false,
  priceMax      = null,
  hiddenSources = [],
  sort          = 'soonest',
  limit         = PAGE_SIZE,
  offset        = 0,
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
        let query = supabase
          .from('events')
          .select(`
            *,
            event_venues ( venue:venues ( id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website ) ),
            event_organizations ( organization:organizations ( id, name, website, description, image_url ) )
          `, { count: 'exact' })
          .eq('status', 'published')
          .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())

        if (categories.length > 0) {
          query = query.in('category', categories)
        }

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
  }, [categories.join(','), dateRange, dateFrom, dateTo, search, freeOnly, priceMax, hiddenSources.join(','), sort, limit, offset])

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
            id, title, start_at, end_at, category,
            price_min, price_max, image_url, image_width, image_height,
            ticket_url, age_restriction, status, featured,
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

          // Flatten org junction for backward compat
          setEvents(unwrapped.map(e => ({
            ...e,
            organizer: e.event_organizations?.[0]?.organization ?? null,
            organizations: (e.event_organizations ?? []).map(eo => eo.organization).filter(Boolean),
          })))
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
          event_venues ( venue:venues (
            id, name, address, city, state, zip,
            parking_type, parking_notes, lat, lng, website
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
 */
export function useRelatedEvents(eventId, category, { limit = 6 } = {}) {
  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    if (!eventId || !category) {
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
            id, title, start_at, end_at, category,
            price_min, price_max, image_url, image_width, image_height,
            ticket_url, age_restriction, status, featured, tags,
            event_venues ( venue:venues ( id, name, city ) ),
            event_organizations ( organization:organizations ( id, name ) )
          `)
          .eq('status', 'published')
          .eq('category', category)
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
  }, [eventId, category, limit])

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
            id, title, start_at, category, price_min, price_max,
            event_venues ( venue:venues ( id, name, address, city, lat, lng ) )
          `, { count: 'exact' })
          .eq('status', 'published')
          .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())
          .order('start_at', { ascending: true })

        if (categories.length > 0) {
          query = query.in('category', categories)
        }

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
            return { ...e, venue: venues[0] ?? null, venues, event_venues: undefined }
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
  }, [categories.join(','), dateRange, dateFrom, dateTo, search, freeOnly, priceMax, hiddenSources.join(',')])

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
              id, title, start_at, end_at, category,
              price_min, price_max, image_url, image_width, image_height,
              ticket_url, age_restriction, status, featured,
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
            .map(e => ({
              ...e,
              venue: e.event_venues?.[0]?.venue ?? null,
              venues: (e.event_venues ?? []).map(ev => ev.venue).filter(Boolean),
            }))

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

  return {
    ...event,
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
  }
}
