/**
 * useShellCounts.ts
 *
 * One shared fetch for every number the admin shell chrome shows: the rail
 * pip, the overview tiles, the topbar scrape pill, and the pulse divider's
 * breathing rate. Six round trips, all head-counts except the scrape rows,
 * fired in parallel on shell mount and cached in module scope with a 60s
 * TTL so section navigation does not refire them.
 *
 * The review count MUST come from `reviewQueueScope` + `notEndedFilter()`
 * -- the same builders the queue page uses -- so the pip and the page can
 * never disagree (bug 4 from the 08-18 review). Every predicate date goes
 * through easternDate.ts / expiry.ts; never derive "today" from
 * `new Date().toISOString()`.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { LooseQuery } from '@/types'
import { supabase } from '@/lib/supabase'
import { notEndedFilter } from '@/lib/admin/expiry'
import { reviewQueueScope } from '@/lib/admin/reviewReasons'
import { easternIsoAt, easternTodayIso } from '@/lib/easternDate'
import { dateRangeBounds } from '@/lib/dateRange'

export interface ScrapeSummary {
  /** Sum of events_found across the last 24h of runs. */
  eventsFound: number
  /** Distinct sources whose LATEST run in the window succeeded. */
  sourcesOk: number
  /** Distinct sources whose LATEST run in the window errored. */
  sourcesError: number
  /** ISO instant of the most recent run, or null when the window is empty. */
  latestRanAt: string | null
}

export interface ShellCountsValue {
  /** Queue membership count under the default time scope. Null while loading. */
  reviewCount: number | null
  /** Rows a human triaged since Eastern midnight. */
  clearedToday: number | null
  /** Published events running right now, known end times only. */
  liveNow: number | null
  /** Published events starting this weekend (Friday 4pm to Sunday close, Eastern). */
  weekend: number | null
  /** Same window shifted back seven days. */
  weekendPrev: number | null
  /** Last 24h of scraper runs, aggregated client-side. Null while loading. */
  scrape: ScrapeSummary | null
  /** Whether the review surface is currently including ended events. */
  includeEnded: boolean
  setIncludeEnded: (next: boolean) => void
  /** Optimistic pip/tile sync after a successful triage action. */
  decrementReview: () => void
  /** Force-refetch all six numbers, bypassing the TTL cache. */
  refresh: () => void
}

interface Snapshot {
  reviewCount: number | null
  clearedToday: number | null
  liveNow: number | null
  weekend: number | null
  weekendPrev: number | null
  scrape: ScrapeSummary | null
}

const EMPTY: Snapshot = {
  reviewCount: null,
  clearedToday: null,
  liveNow: null,
  weekend: null,
  weekendPrev: null,
  scrape: null,
}

const CACHE_TTL_MS = 60_000

// Module-scope cache: survives section navigation (each unmounts/remounts
// nothing -- the provider lives in AdminLayout -- but React StrictMode and
// login/logout cycles do remount it, and the cache keeps those free).
let cached: Snapshot | null = null
let cachedAt = 0

async function headCount(build: (q: LooseQuery) => LooseQuery): Promise<number | null> {
  const { count, error } = await build(
    supabase.from('events').select('id', { count: 'exact', head: true }),
  )
  return error ? null : (count ?? 0)
}

async function fetchSnapshot(): Promise<Snapshot> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const todayFloorIso = easternIsoAt(easternTodayIso(), '00:00:00')
  const weekendBounds = dateRangeBounds('this_weekend')
  const prevWeekendBounds = dateRangeBounds('this_weekend', new Date(nowMs - 7 * 86_400_000))
  const scrapeWindowIso = new Date(nowMs - 24 * 3_600_000).toISOString()

  const [reviewCount, clearedToday, liveNow, weekend, weekendPrev, scrapeRows] =
    await Promise.all([
      // Rail pip + "Needs review" tile: the queue's own membership + time scope.
      headCount((q) => reviewQueueScope(q).or(notEndedFilter())),
      headCount((q) => q.gte('reviewed_at', todayFloorIso)),
      // Only rows with a KNOWN end count as live -- honest; null-end_at rows
      // are "maybe live", not live.
      headCount((q) =>
        q.eq('status', 'published').lte('start_at', nowIso).gte('end_at', nowIso)),
      headCount((q) =>
        q.eq('status', 'published')
          .gte('start_at', weekendBounds.start.toISOString())
          .lte('start_at', weekendBounds.end.toISOString())),
      headCount((q) =>
        q.eq('status', 'published')
          .gte('start_at', prevWeekendBounds.start.toISOString())
          .lte('start_at', prevWeekendBounds.end.toISOString())),
      // Row select, not a count: ~90-130 rows, aggregated client-side. Ordered
      // by ran_at (the real column -- the created_at ghost noted in
      // ScraperRunsPage.tsx does not exist on this table).
      supabase
        .from('scraper_runs')
        .select('scraper_name, status, events_found, ran_at')
        .gte('ran_at', scrapeWindowIso)
        .order('ran_at', { ascending: false }),
    ])

  let scrape: ScrapeSummary | null = null
  if (!scrapeRows.error) {
    const rows = scrapeRows.data ?? []
    const latestBySource = new Map<string, string>()
    let eventsFound = 0
    for (const r of rows) {
      eventsFound += r.events_found ?? 0
      // Rows arrive newest-first, so first sight of a source is its latest run.
      if (!latestBySource.has(r.scraper_name)) latestBySource.set(r.scraper_name, r.status)
    }
    let sourcesError = 0
    for (const status of latestBySource.values()) {
      if (status === 'error') sourcesError += 1
    }
    scrape = {
      eventsFound,
      sourcesOk: latestBySource.size - sourcesError,
      sourcesError,
      latestRanAt: rows.length > 0 ? rows[0].ran_at : null,
    }
  }

  return { reviewCount, clearedToday, liveNow, weekend, weekendPrev, scrape }
}

/**
 * The provider-side hook: owns the snapshot state and the fetch lifecycle.
 * AdminLayout calls this once and feeds the value into ShellCountsContext.
 */
export function useShellCountsProvider(): ShellCountsValue {
  const [snapshot, setSnapshot] = useState<Snapshot>(() =>
    cached && Date.now() - cachedAt < CACHE_TTL_MS ? cached : EMPTY)
  const [includeEnded, setIncludeEnded] = useState(false)

  const load = useCallback(async (force: boolean) => {
    if (!force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
      setSnapshot(cached)
      return
    }
    const next = await fetchSnapshot()
    cached = next
    cachedAt = Date.now()
    setSnapshot(next)
  }, [])

  useEffect(() => { load(false) }, [load])

  const decrementReview = useCallback(() => {
    setSnapshot((prev) => {
      const next = {
        ...prev,
        reviewCount: prev.reviewCount == null ? null : Math.max(0, prev.reviewCount - 1),
        clearedToday: prev.clearedToday == null ? null : prev.clearedToday + 1,
      }
      cached = next
      return next
    })
  }, [])

  const refresh = useCallback(() => { load(true) }, [load])

  return useMemo(
    () => ({ ...snapshot, includeEnded, setIncludeEnded, decrementReview, refresh }),
    [snapshot, includeEnded, decrementReview, refresh],
  )
}

export const ShellCountsContext = createContext<ShellCountsValue | null>(null)

/** Consumer hook. Throws outside the admin shell -- there is no fallback. */
export function useShellCounts(): ShellCountsValue {
  const value = useContext(ShellCountsContext)
  if (!value) throw new Error('useShellCounts must be used inside AdminLayout')
  return value
}
