/**
 * useAsync — Generic hook for cancellable async data fetching.
 *
 * Replaces the repeated `let cancelled = false` + loading/error/setState
 * dance that appeared 9 times in useEvents.ts and 2 times in the map
 * components. A single definition here removes ~10 lines of boilerplate
 * per hook while making the cancellation contract explicit.
 *
 * Usage:
 *
 *   const { data, loading, error } = useAsync(
 *     async () => {
 *       const { data, error } = await supabase.from('venues').select('*')
 *       if (error) throw error
 *       return data ?? []
 *     },
 *     []          // dependency array — same semantics as useEffect
 *   )
 *
 * Contract:
 *   • `fetcher` is called on mount and whenever `deps` changes.
 *   • If the component unmounts (or deps change) before the fetch
 *     resolves, the result is silently discarded — no setState-after-
 *     unmount warnings.
 *   • A thrown Error surfaces as `error`; a clean return sets `data`.
 *   • `initialValue` is returned as `data` during the first load. It
 *     defaults to `null` but callers that need an empty array can pass [].
 *
 * Limitations (by design):
 *   • No caching or deduplication — use TanStack Query if you need those.
 *   • One piece of async state per call. For hooks that need multiple
 *     coupled state values (total, hasMore, …) continue to manage state
 *     manually inside useEffect.
 */

import { useState, useEffect, type DependencyList } from 'react'

export interface AsyncState<T> {
  data:    T
  loading: boolean
  error:   string | null
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return fallback
}

/**
 * @param fetcher   Async function that returns the desired data. May throw.
 * @param deps      Dependency array, same semantics as `useEffect`.
 * @param initial   Initial value for `data` before the first fetch resolves.
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  initial: T,
): AsyncState<T>

export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): AsyncState<T | null>

export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  initial: T | null = null,
): AsyncState<T | null> {
  const [data,    setData]    = useState<T | null>(initial)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)

    fetcher()
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(toMessage(err, 'An unexpected error occurred.'))
          setLoading(false)
        }
      })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, loading, error }
}
