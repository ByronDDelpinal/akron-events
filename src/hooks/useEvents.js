import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

export const PAGE_SIZE = 24

/**
 * Fetch a paginated page of published events with server-side filtering.
 *
 * @param {Object}   opts
 * @param {string[]} opts.categories  - category values to include; empty = all
 * @param {string}   opts.dateRange   - 'today' | 'this_weekend' | 'this_week' | 'this_month' | null
 * @param {string}   opts.dateFrom    - custom ISO date string 'YYYY-MM-DD', overrides dateRange when set
 * @param {string}   opts.dateTo      - custom ISO date string 'YYYY-MM-DD', overrides dateRange when set
 * @param {string}   opts.search      - free-text search
 * @param {boolean}  opts.freeOnly    - only return price_min = 0 events
 * @param {string}   opts.priceMax    - 'under10' | 'under25' | null  (ignored when freeOnly=true)
 * @param {string}   opts.sort        - 'soonest' | 'latest' | 'recent'
 * @param {number}   opts.limit       - rows per page (default PAGE_SIZE)
 * @param {number}   opts.offset      - row offset for pagination
 *
 * Returns { events, loading, error, total, hasMore }
 *   total   — total matching row count from Supabase (for the stat bar)
 *   hasMore — true when there are more rows beyond this page
 */
export function useEvents({
  categories = [],
  dateRange  = null,   // preset: 'today' | 'this_weekend' | 'this_week' | 'this_month' | null
  dateFrom   = null,   // custom ISO date string 'YYYY-MM-DD', overrides dateRange when set
  dateTo     = null,   // custom ISO date string 'YYYY-MM-DD', overrides dateRange when set
  search     = null,
  freeOnly   = false,
  priceMax   = null,   // 'under10' | 'under25' | null
  sort       = 'soonest',
  limit      = PAGE_SIZE,
  offset     = 0,
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
            venue:venues (
              id, name, address, city, state, zip,
              lat, lng, parking_type, parking_notes, website
            ),
            organizer:organizers (
              id, name, website, description, image_url
            )
          `, { count: 'exact' })
          .eq('status', 'published')
          // Always exclude events that have already ended
          .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())

        // ── Category ─────────────────────────────────────
        if (categories.length > 0) {
          query = query.in('category', categories)
        }

        // ── Date range ───────────────────────────────────
        if (dateFrom || dateTo) {
          // Custom range takes precedence over presets
          if (dateFrom) {
            query = query.gte('start_at', new Date(dateFrom + 'T00:00:00').toISOString())
          }
          if (dateTo) {
            query = query.lte('start_at', new Date(dateTo + 'T23:59:59').toISOString())
          }
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
            // End of Sunday of the current week (or 7 days out if already Sunday)
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

        // ── Free only ────────────────────────────────────
        if (freeOnly) {
          query = query
            .eq('price_min', 0)
            .or('price_max.is.null,price_max.eq.0')
        } else if (priceMax === 'under10') {
          query = query.lte('price_min', 10)
        } else if (priceMax === 'under25') {
          query = query.lte('price_min', 25)
        }

        // ── Search ───────────────────────────────────────
        if (search && search.trim().length > 0) {
          query = query.or(
            `title.ilike.%${search.trim()}%,description.ilike.%${search.trim()}%`
          )
        }

        // ── Sort ─────────────────────────────────────────
        if (sort === 'latest') {
          query = query.order('start_at', { ascending: false })
        } else if (sort === 'recent') {
          query = query.order('created_at', { ascending: false })
        } else {
          query = query.order('start_at', { ascending: true })
        }

        // ── Pagination ───────────────────────────────────
        query = query.range(offset, offset + limit - 1)

        const { data, error: fetchError, count } = await query

        if (fetchError) throw fetchError
        if (!cancelled) {
          setEvents(data ?? [])
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
  }, [categories.join(','), dateRange, dateFrom, dateTo, search, freeOnly, priceMax, sort, limit, offset])

  const hasMore = offset + limit < total

  return { events, loading, error, total, hasMore }
}

/**
 * Fetch a single published event by ID, with venue + organizer joined.
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
          venue:venues (
            id, name, address, city, state, zip,
            parking_type, parking_notes, lat, lng, website
          ),
          organizer:organizers (
            id, name, website, description, image_url
          )
        `)
        .eq('id', id)
        .eq('status', 'published')
        .single()

      if (!cancelled) {
        if (fetchError) setError(fetchError.message)
        else setEvent(data)
        setLoading(false)
      }
    }

    fetchEvent()
    return () => { cancelled = true }
  }, [id])

  return { event, loading, error }
}
