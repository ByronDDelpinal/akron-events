import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { FESTIVAL_UMBRELLA_TAG } from '@/lib/browseVisibility'

/**
 * useFestivalChildCount — the umbrella card's "N sets on the schedule" count
 * (docs/umbrella-child-hiding.md §3.2). A lazy, deduped count-only query,
 * fired only when an umbrella card actually mounts.
 *
 * Module-level promise cache keyed by festival tag: N umbrella cards for the
 * SAME festival on one page (there is at most one per festival today)
 * collapse to exactly one HEAD request per festival per page load. A failed
 * request is evicted from the cache so a later mount can retry rather than
 * being poisoned for the rest of the session.
 */
const countCache = new Map<string, Promise<number | null>>()

function fetchChildCount(tag: string): Promise<number | null> {
  const cached = countCache.get(tag)
  if (cached) return cached

  // Wrapped in an explicit Promise.resolve(): the supabase-js builder's
  // .then() returns a bare PromiseLike (no .catch), so it's assimilated
  // into a real Promise before chaining .catch below.
  const promise = Promise.resolve(
    supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'published')
      // "Children you can still go to" — decays to 0 during/after the
      // festival day with no date logic of its own (§3.3).
      .gte('start_at', new Date().toISOString())
      .contains('tags', [tag])
      .not('tags', 'cs', `{${FESTIVAL_UMBRELLA_TAG}}`),
  )
    .then(({ count, error }) => {
      if (error) throw error
      return count ?? 0
    })
    .catch(() => {
      countCache.delete(tag)
      return null
    })

  countCache.set(tag, promise)
  return promise
}

export interface FestivalChildCountState {
  /** null while loading OR when the count request failed — both collapse
   *  into the umbrella card's zero-state copy (never a stale/bare number). */
  count: number | null
  loading: boolean
}

/**
 * Lazy child count for one festival tag. Pass `null`/`undefined` when the
 * card isn't an umbrella — the hook then does nothing and returns a settled
 * `{ count: null, loading: false }`.
 */
export function useFestivalChildCount(tag: string | null | undefined): FestivalChildCountState {
  const [count, setCount] = useState<number | null>(null)
  const [loading, setLoading] = useState<boolean>(!!tag)

  useEffect(() => {
    if (!tag) {
      setCount(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchChildCount(tag).then((c) => {
      if (!cancelled) {
        setCount(c)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [tag])

  return { count, loading }
}
