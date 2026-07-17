import { useEffect, useRef } from 'react'
import type { AppEvent } from '@/hooks/useEvents'
import { trackEvent, EVENTS } from '@/lib/analytics'

/**
 * Fire the GA4 `search` event once per committed term, with a TRUE result count.
 *
 * Why this is a hook and not two call sites: EventsBrowser (home + embed) and
 * CategoryPage (every neighborhood / city / category hub) are independent forks
 * — each owns its own useEvents call and its own page-append effect. The first
 * version of this instrumentation lived inside EventsBrowser and claimed to
 * cover both; it silently covered neither hub searches nor hub filters for the
 * whole of the hub surface. Anything that needs to be true of both funnels has
 * to live somewhere both of them call.
 *
 * The count is the point. A search returning nothing is a gap in what we list —
 * something we can go and fix — whereas a bare search count is just traffic.
 * That makes a WRONG count worse than no event at all: it reports a real result
 * set as unmet demand and sends someone chasing a supply gap that isn't there.
 * Both hazards below exist solely to protect that number.
 */
interface SearchReportingArgs {
  /** The COMMITTED term (from `?q=`), never the input draft. */
  term: string
  /** Result count from useEvents. Only meaningful once page zero has settled. */
  total: number
  loading: boolean
  /** useEvents' fetch error, or null. */
  error: string | null
  /** Pagination offset; only page zero carries a count. */
  offset: number
  /** The settled page. Its identity changing is what marks a real settle. */
  page: AppEvent[]
}

export function useSearchReporting({
  term, total, loading, error, offset, page,
}: SearchReportingArgs): void {
  // HAZARD 1 — the term must not be a dependency.
  // useEvents starts its fetch from an effect, so there is exactly one render
  // where `term` is already the NEW value while `total` and `loading` still
  // describe the PREVIOUS query. An effect keyed on the term fires on that
  // render and records the previous query's count against the new term.
  // Mirroring during render is React's sanctioned pattern for this.
  const termRef = useRef(term)
  termRef.current = term

  // Keyed on the term alone: re-firing whenever some OTHER filter is tweaked
  // while a search is active would inflate that term's volume. Cleared when the
  // search clears, so running the same query again later counts again — that is
  // a real second search.
  const reportedRef = useRef<string | null>(null)

  useEffect(() => {
    if (loading || offset !== 0) return

    const committed = (termRef.current ?? '').trim()
    if (!committed) {
      reportedRef.current = null
      return
    }

    // HAZARD 2 — a failed fetch leaves the PREVIOUS query's numbers in place.
    // useEvents' catch sets only `error`; `finally` sets loading false without
    // touching events/total. Since this effect keys on `loading`, it re-runs on
    // that transition with a stale `total`. Bail without marking the term
    // reported, so a later successful fetch still records the true count.
    if (error) return

    if (reportedRef.current === committed) return
    reportedRef.current = committed

    trackEvent(EVENTS.SEARCH, {
      search_term: committed,
      content_type: 'events',
      result_count: total,
    })
    // `page` is a dependency because its identity changing is the only reliable
    // signal that a fetch settled and `total` now describes THIS term.
  }, [page, loading, offset, total, error])
}
