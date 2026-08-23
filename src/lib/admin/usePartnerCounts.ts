/**
 * usePartnerCounts.ts
 *
 * The four tiles on the partner overview band (design §4.4). Head-counts
 * through the partner's own RLS lens, scoped to their orgs via an
 * inner-joined event_organizations filter. Deliberately NOT useShellCounts:
 * that hook fetches admin telemetry (scraper runs, the review queue) a
 * partner has no business paying for.
 *
 * Every predicate date goes through easternDate.ts / expiry.ts /
 * dateRange.js; never derive "today" from `new Date().toISOString()` (the
 * house landmine scripts/tests/test-no-utc-today.js exists for).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LooseQuery } from '@/types'
import { supabase } from '@/lib/supabase'
import { upcomingBounds } from '@/lib/admin/expiry'
import { dateRangeBounds } from '@/lib/dateRange'

export interface PartnerCounts {
  /** Published, not yet started or still ahead of now. Null while loading. */
  upcoming: number | null
  /** status = pending_review in scope. */
  awaitingReview: number | null
  /** Published, started, known end time only (the admin predicate, reused). */
  liveNow: number | null
  /** Published, starting inside the Eastern this-weekend window. */
  weekend: number | null
}

const EMPTY: PartnerCounts = { upcoming: null, awaitingReview: null, liveNow: null, weekend: null }

async function scopedHeadCount(
  scopeIds: string[],
  build: (q: LooseQuery) => LooseQuery,
): Promise<number | null> {
  const base: LooseQuery = supabase
    .from('events')
    .select('id, event_organizations!inner(organization_id)', { count: 'exact', head: true })
    .in('event_organizations.organization_id', scopeIds)
  const { count, error } = await build(base)
  return error ? null : (count ?? 0)
}

export function usePartnerCounts(scopeIds: string[]): PartnerCounts {
  const [counts, setCounts] = useState<PartnerCounts>(EMPTY)
  // The array identity churns with the provider; key the effect on content.
  const scopeKey = useMemo(() => scopeIds.join(','), [scopeIds])

  const load = useCallback(async () => {
    const ids = scopeKey === '' ? [] : scopeKey.split(',')
    if (ids.length === 0) {
      setCounts({ upcoming: 0, awaitingReview: 0, liveNow: 0, weekend: 0 })
      return
    }
    const { nowIso } = upcomingBounds()
    const weekendWindow = dateRangeBounds('this_weekend')
    const [upcoming, awaitingReview, liveNow, weekend] = await Promise.all([
      scopedHeadCount(ids, (q) => q.eq('status', 'published').gte('start_at', nowIso)),
      scopedHeadCount(ids, (q) => q.eq('status', 'pending_review')),
      // Known end times only -- null-end rows are "maybe live", not live
      // (the useShellCounts predicate, reused verbatim).
      scopedHeadCount(ids, (q) =>
        q.eq('status', 'published').lte('start_at', nowIso).gte('end_at', nowIso)),
      scopedHeadCount(ids, (q) =>
        q.eq('status', 'published')
          .gte('start_at', weekendWindow.start.toISOString())
          .lte('start_at', weekendWindow.end.toISOString())),
    ])
    setCounts({ upcoming, awaitingReview, liveNow, weekend })
  }, [scopeKey])

  useEffect(() => { load() }, [load])

  return counts
}
