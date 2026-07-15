import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { historyEntryKey } from '@/lib/historyKey'

/**
 * How many events a back-navigation is willing to re-fetch in one request.
 *
 * The restore is a single PostgREST call, so this is the payload ceiling for
 * the back button (10 pages x 24 events ~= 260 kB). PostgREST also caps any
 * single response near 1000 rows, so this has to sit well under that.
 *
 * This is a ceiling on the whole feature, not just one fetch: a visitor who
 * paged deeper than 240 events restores 240, and if that still isn't tall
 * enough to reach their saved pixel, App.tsx declines to scroll and leaves
 * them at the top of the hub. Landing at the top is a coherent place to be;
 * the bug this hook exists to fix was landing at the BOTTOM. Restoring at the
 * ceiling also rewrites the stored depth down to it, so the entry converges on
 * 240 — deliberate, and the reason the ceiling is generous enough that real
 * sessions rarely reach it.
 */
const MAX_RESTORE_EVENTS = 240

interface Range {
  /** First row of the next fetch. */
  offset: number
  /** Size of the next fetch. Equals pageSize except on a restore. */
  limit: number
}

function readDepth(key: string): number {
  try {
    const raw = sessionStorage.getItem(key)
    const n = raw ? parseInt(raw, 10) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Pagination state for an infinite-scroll list that survives back/forward.
 *
 * The problem this solves: a paginated list re-mounts at page one. On a back
 * navigation the browser (or our own scroll restoration) then aims for a
 * position that the freshly-mounted, one-page-tall document cannot reach, so
 * the scroll CLAMPS to the bottom — dumping the visitor at the end-of-list
 * marker with the events they were reading nowhere in sight. It reads as a
 * broken page, not a short one.
 *
 * The fix is to make the list as tall as it was before restoring the scroll.
 * We persist the DEPTH (how many events were on screen) rather than the events
 * themselves: it's one integer per history entry instead of ~260 kB of rows in
 * sessionStorage, it can't go stale, and it survives a reload. On a POP the
 * first fetch simply asks for that many rows at once, so the restored page
 * costs one request rather than N sequential pages.
 *
 * Depth is keyed per history entry, so each entry restores to its own depth
 * and a fresh visit (PUSH) to the same URL still starts at page one.
 *
 * Callers must be mounted per history entry for this to engage — the depth is
 * read once, in the state initializer. See the `key` on CategoryPageContent.
 *
 * @param pageSize Rows per normal page. May change at runtime (the density
 *   toggle); depth is stored as a raw event count, so it stays page-size
 *   agnostic and a size change just re-pages from the top.
 */
export function useRestorablePagination(pageSize: number) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const storageKey = `pg:${historyEntryKey(location)}`

  // Read the saved depth exactly once, at mount, before the first fetch fires.
  // `navigationType` is POP for back, forward AND reload, which is precisely
  // the set of navigations that should resume where the visitor left off; a
  // PUSH is a fresh visit and always starts at page one.
  const [range, setRange] = useState<Range>(() => {
    if (navigationType !== 'POP') return { offset: 0, limit: pageSize }
    const depth = Math.min(readDepth(storageKey), MAX_RESTORE_EVENTS)
    return { offset: 0, limit: Math.max(depth, pageSize) }
  })

  // Persist the running depth. `offset + limit` is the total number of rows
  // requested so far, which is what a restore needs to ask for in one go.
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, String(range.offset + range.limit))
    } catch {
      /* private mode / quota — restoration degrades, nothing breaks */
    }
  }, [storageKey, range])

  /** Advance to the next page. The restore's oversized limit applies once. */
  const loadMore = useCallback(() => {
    setRange((r) => ({ offset: r.offset + r.limit, limit: pageSize }))
  }, [pageSize])

  /**
   * Back to page one — for a filter change, which invalidates the depth.
   * Returns the current range untouched when already there, so a filter
   * toggle on an unpaged list doesn't cost a render and a redundant write.
   */
  const reset = useCallback(() => {
    setRange((r) => (r.offset === 0 && r.limit === pageSize ? r : { offset: 0, limit: pageSize }))
  }, [pageSize])

  return { offset: range.offset, limit: range.limit, loadMore, reset }
}
