import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Fetch published events with optional filtering.
 *
 * @param {Object} filters
 * @param {string|null}  filters.category  - e.g. 'music', 'art', or null for all
 * @param {string|null}  filters.dateRange - 'today' | 'this_week' | 'this_weekend' | 'this_month' | null
 * @param {string|null}  filters.search    - free-text search against title + description
 */
export function useEvents({ category = null, dateRange = null, search = null } = {}) {
  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

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
              id, name, address, city, state,
              parking_type, parking_notes, website
            ),
            organizer:organizers (
              id, name, website, description, image_url
            )
          `)
          .eq('status', 'published')
          .order('start_at', { ascending: true })

        // ── Category filter ──────────────────────────────
        if (category) {
          query = query.eq('category', category)
        }

        // ── Date range filter ────────────────────────────
        if (dateRange) {
          const now   = new Date()
          const start = new Date(now)
          const end   = new Date(now)

          if (dateRange === 'today') {
            start.setHours(0, 0, 0, 0)
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_week') {
            start.setHours(0, 0, 0, 0)
            end.setDate(now.getDate() + (6 - now.getDay()))
            end.setHours(23, 59, 59, 999)
          } else if (dateRange === 'this_weekend') {
            const dayOfWeek = now.getDay() // 0=Sun 6=Sat
            const daysToSat = (6 - dayOfWeek + 7) % 7 || 7
            start.setDate(now.getDate() + daysToSat)
            start.setHours(0, 0, 0, 0)
            end.setDate(start.getDate() + 1)
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

        // ── Full-text search ─────────────────────────────
        if (search && search.trim().length > 0) {
          query = query.or(
            `title.ilike.%${search.trim()}%,description.ilike.%${search.trim()}%`
          )
        }

        const { data, error: fetchError } = await query

        if (fetchError) throw fetchError
        if (!cancelled) setEvents(data ?? [])
      } catch (err) {
        if (!cancelled) setError(err.message ?? 'Failed to load events.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [category, dateRange, search])

  return { events, loading, error }
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
