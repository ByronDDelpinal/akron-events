import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import { useEvents, useMapEvents, PAGE_SIZE, type AppEvent } from '@/hooks/useEvents'
import { useRestorablePagination } from '@/hooks/useRestorablePagination'
import { useEventFilters } from '@/hooks/useEventFilters'
import EventCard from '@/components/EventCard'
import FilterBar, { type LockedDimensions } from '@/components/FilterBar'
import MapView from '@/components/MapView'
import CalendarView from '@/components/CalendarView'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap } from '@/lib/eventGrouping'
import { trackEvent, EVENTS } from '@/lib/analytics'
// Grid / list / load-more styles live in HomePage.css (global, deduped by Vite).
import '@/pages/HomePage.css'

const COMPACT_PAGE_SIZE = 48
const PREFETCH_PX = 400

interface Features {
  filter: boolean
  map: boolean
  calendar: boolean
  density: boolean
  price: boolean
  tags: boolean
}

const ALL_FEATURES_ON: Features = { filter: true, map: true, calendar: true, density: true, price: true, tags: true }

type Filters = ReturnType<typeof useEventFilters>

interface EventsBrowserProps {
  /** return value of useEventFilters */
  filters: Filters
  /** 'list' | 'map' (controlled) */
  view: string
  onView: (v: string) => void
  /** 'comfortable' | 'efficient' (controlled) */
  density: string
  onDensity: (v: string) => void
  features?: Features
  lockedDimensions?: LockedDimensions
  /** Partner's locked category set (embed) — enables narrow-within in the tray. */
  lockedCategories?: string[]
  renderPromoMid?: () => ReactNode
  renderPromoEnd?: () => ReactNode
  onFirstPageLoad?: () => void
  onItemsChange?: (events: AppEvent[]) => void
}

/**
 * EventsBrowser — the reusable event-browsing surface: filter bar, list / map
 * views, paginated grid, infinite scroll, and per-source overflow capping.
 * Filter STATE is owned by the caller (via useEventFilters) and passed in.
 */
export default function EventsBrowser({
  filters,
  view,
  onView,
  density,
  onDensity,
  features = ALL_FEATURES_ON,
  lockedDimensions = {},
  lockedCategories = [],
  renderPromoMid,
  renderPromoEnd,
  onFirstPageLoad,
  onItemsChange,
}: EventsBrowserProps) {
  const { effective } = filters

  // View toggle gated by feature flags: an unavailable view falls back to list.
  const viewAllowed =
    view === 'list' ||
    (view === 'map' && features.map) ||
    (view === 'calendar' && features.calendar)
  const effectiveView = viewAllowed ? view : 'list'
  const isEfficient = density === 'efficient'
  const activePageSize = isEfficient ? COMPACT_PAGE_SIZE : PAGE_SIZE

  // ── Pagination state ──────────────────────────────────────────────────
  // offset/limit come from the history entry: a back navigation resumes at the
  // depth the visitor left, so the page is tall enough for App.tsx to restore
  // their scroll position instead of clamping them to the end of page one.
  const { offset, limit, loadMore, reset: resetPagination } = useRestorablePagination(activePageSize)
  const [allEvents, setAllEvents] = useState<AppEvent[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)

  // Reset pagination whenever the filter signature (or density) changes.
  const filterKey = `${filters.filterKey}|${density}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      resetPagination()
      setIsRefreshing(true)
    }
  }, [filterKey, resetPagination])

  // ── Data fetch (one page at a time) ───────────────────────────────────
  const { events: page, loading, error, total, hasMore } = useEvents({
    ...effective,
    limit,
    offset,
  })

  // Separate unpaginated fetch for the map — same filters, all results. Only
  // runs while the map is showing.
  const { events: mapEvents, loading: mapLoading } = useMapEvents({
    categories: effective.categories,
    excludedCategories: effective.excludedCategories,
    family: effective.family,
    excludeFamily: effective.excludeFamily,
    fundraiser: effective.fundraiser,
    dateRange: effective.dateRange,
    dateFrom: effective.dateFrom,
    dateTo: effective.dateTo,
    search: effective.search,
    freeOnly: effective.freeOnly,
    priceMax: effective.priceMax,
    neighborhoodSlug: effective.neighborhoodSlug,
    venueCities: effective.venueCities,
    enabled: effectiveView === 'map',
  })

  // Calendar fetch — same filters EXCEPT the date range: the calendar owns the
  // date dimension (it pages by day/week/month), so it shouldn't be limited to
  // the active preset. The preset still seeds the calendar's starting view. A
  // ~13-month upper horizon bounds the payload without restricting navigation.
  const calendarHorizon = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 13)
    return d.toISOString().slice(0, 10)
  }, [])
  const { events: calendarEvents, loading: calendarLoading } = useMapEvents({
    categories: effective.categories,
    excludedCategories: effective.excludedCategories,
    family: effective.family,
    excludeFamily: effective.excludeFamily,
    fundraiser: effective.fundraiser,
    search: effective.search,
    freeOnly: effective.freeOnly,
    priceMax: effective.priceMax,
    neighborhoodSlug: effective.neighborhoodSlug,
    venueCities: effective.venueCities,
    dateTo: calendarHorizon,
    enabled: effectiveView === 'calendar',
  })

  // ── Search reporting ──────────────────────────────────────────────────
  // The `search` event has to carry a TRUE result_count, because the
  // zero-result case is the entire point: a query that returns nothing is a
  // gap in what we list, which is actionable, whereas a raw search count is
  // just traffic. Neither input owns that number — HomePage and CategoryPage
  // have the text box but never see a total, and at Enter-time no fetch has
  // run yet. EventsBrowser is the one place a committed query and its settled
  // count meet, and it backs both pages, so both are covered from here.
  //
  // The term is read through a ref rather than taken as a dependency below.
  // useEvents kicks off its fetch from an effect, so there is exactly one
  // render where `effective.search` is already the NEW term while `total` and
  // `loading` still describe the PREVIOUS query. A search-keyed effect would
  // fire on that render and record the wrong count — reporting a real result
  // set as a zero-result, which is the one number we most need to trust.
  // Mirroring during render is safe and is React's sanctioned pattern here.
  const searchTermRef = useRef(effective.search)
  searchTermRef.current = effective.search

  // Keyed on the term alone: re-firing whenever any OTHER filter is tweaked
  // while a search is active would inflate that term's volume. Cleared when
  // the search is cleared, so re-running the same query later counts again —
  // that's a genuine second search.
  const reportedSearchRef = useRef<string | null>(null)

  // Append each incoming page to the accumulated list.
  useEffect(() => {
    if (loading) return
    if (offset === 0) {
      setAllEvents(page)
      setIsRefreshing(false)
      setResultsKey((k) => k + 1)
      onItemsChange?.(page)

      // Page zero has just settled, so `total` now describes THIS query —
      // useEvents batches setEvents/setTotal/setLoading, so reading it any
      // earlier yields the previous one.
      const term = (searchTermRef.current ?? '').trim()
      if (!term) {
        reportedSearchRef.current = null
      } else if (reportedSearchRef.current !== term) {
        reportedSearchRef.current = term
        trackEvent(EVENTS.SEARCH, {
          search_term: term,
          content_type: 'events',
          result_count: total,
        })
      }
    } else {
      setAllEvents((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        return [...prev, ...page.filter((e) => !ids.has(e.id))]
      })
    }
  }, [page, loading, offset, total, onItemsChange])

  // Fire the first-page callback exactly once (homepage hero-video unlock).
  const firstLoadFired = useRef(false)
  useEffect(() => {
    if (allEvents.length > 0 && !firstLoadFired.current) {
      firstLoadFired.current = true
      onFirstPageLoad?.()
    }
  }, [allEvents.length, onFirstPageLoad])

  const grouped = useMemo(() => groupEventsByDate(allEvents), [allEvents])

  // ── Source overflow expansion state (keys: `${dateKey}-${source}`) ────
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set())
  const toggleSource = useCallback((dateKey: string, source: string) => {
    const key = `${dateKey}-${source}`
    setExpandedSources((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // ── Infinite scroll ───────────────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(loading)
  loadingRef.current = loading

  const loadMoreRef = useRef<() => void>(() => {})
  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMore) return
    loadMore()
  }

  const observerRef = useRef<IntersectionObserver | null>(null)
  const attachSentinel = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    sentinelRef.current = node
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreRef.current?.()
            break
          }
        }
      },
      { rootMargin: `0px 0px ${PREFETCH_PX}px 0px` },
    )
    observer.observe(node)
    observerRef.current = observer
  }, [])

  // Continuation check: keep loading until the viewport is filled.
  useEffect(() => {
    if (loading || !hasMore) return
    const el = sentinelRef.current
    if (!el) return
    if (el.getBoundingClientRect().top < window.innerHeight + PREFETCH_PX) {
      loadMoreRef.current?.()
    }
  }, [allEvents.length, loading, hasMore])

  // ── FilterBar visibility ──────────────────────────────────────────────
  const showFilterBar = features.filter || features.map || features.density

  return (
    <>
      {showFilterBar && (
        <FilterBar
          activeIntentId={filters.activeIntentId}  onIntentId={filters.setActiveIntentId}
          dateRange={filters.dateRange}            onDateRange={filters.setDateRange}
          dateFrom={filters.dateFrom}              onDateFrom={filters.setDateFrom}
          dateTo={filters.dateTo}                  onDateTo={filters.setDateTo}
          rawCategories={filters.rawCategories}    onRawCategories={filters.setRawCategories}
          excludedCategories={filters.excludedCategories}
          onExcludedCategories={filters.setExcludedCategories}
          onCycleCategory={filters.cycleCategory}
          priceFilter={filters.priceFilter}        onPriceFilter={filters.setPriceFilter}
          sort={filters.sort}                      onSort={filters.setSort}
          search={filters.search}                  onSearch={filters.setSearch}
          excludeFamily={filters.excludeFamily}    onExcludeFamily={filters.setExcludeFamily}
          showAudienceToggle={features.filter}
          view={effectiveView}                     onView={(features.map || features.calendar) ? onView : undefined}
          showMapView={features.map}               showCalendarView={features.calendar}
          total={total}
          cardViewMode={features.density ? density : undefined}
          onCardViewMode={features.density ? onDensity : undefined}
          onClearAll={filters.clearFilters}
          lockedDimensions={lockedDimensions}
          lockedCategories={lockedCategories}
          showFilterButton={features.filter}
        />
      )}

      {/* ── MAP VIEW ── */}
      {effectiveView === 'map' && (
        mapLoading
          ? <div className="map-loading"><span>Loading map…</span></div>
          : <MapView events={mapEvents} onBackToList={() => onView?.('list')} neighborhoodSlug={effective.neighborhoodSlug} />
      )}

      {/* ── CALENDAR VIEW ── */}
      {effectiveView === 'calendar' && (
        <CalendarView
          events={calendarEvents}
          loading={calendarLoading}
          initialRange={effective.dateRange}
          initialFrom={effective.dateFrom}
          initialTo={effective.dateTo}
        />
      )}

      {/* ── LIST VIEW ── */}
      {effectiveView === 'list' && (
        <div className={`content${isRefreshing ? ' content--refreshing' : ''}`}>

          {loading && allEvents.length === 0 && !isRefreshing && (
            <div className="empty-state">Loading events…</div>
          )}

          {error && (
            <div className="empty-state error">Couldn't load events. Please try again.</div>
          )}

          {!loading && !isRefreshing && !error && allEvents.length === 0 && (
            <div className="empty-state">
              <p>No events match your current filters.</p>
              <button className="btn-clear" onClick={filters.clearFilters}>
                Clear filters
              </button>
            </div>
          )}

          {(() => {
            let cardIdx = 0
            let midPromoShown = false
            const midThreshold = getMidPromoThreshold()
            const gridCols = getGridColumns()
            return grouped.map(([dateKey, dayEvents]) => {
              const cappedItems = applySourceCap(dayEvents, expandedSources, dateKey)
              const gridItems: ReactNode[] = []
              let dayCardIdx = 0

              for (const item of cappedItems) {
                if (item.type === 'overflow') {
                  gridItems.push(
                    <SourceOverflowCard
                      key={`overflow-${item.dateKey}-${item.source}`}
                      source={item.source}
                      hiddenCount={item.hiddenCount}
                      isExpanded={item.isExpanded}
                      onToggle={() => toggleSource(item.dateKey, item.source)}
                    />
                  )
                  continue
                }

                const event = item.event
                const isFeatured = Boolean(event.featured) && dayCardIdx === 0

                if (
                  renderPromoMid &&
                  !isEfficient &&
                  !midPromoShown &&
                  cardIdx >= midThreshold &&
                  gridItems.length % gridCols === 0
                ) {
                  gridItems.push(
                    <div key="__mid-promo__" className="cards-grid-promo">
                      {renderPromoMid()}
                    </div>
                  )
                  midPromoShown = true
                }

                const delay = item.isRevealed ? 0 : cardIdx * 28
                cardIdx++
                gridItems.push(
                  <div
                    key={event.id}
                    className={`card-enter${item.isRevealed ? ' card-reveal' : ''}`}
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    <EventCard
                      event={event}
                      featured={isFeatured}
                      viewMode={density}
                    />
                  </div>
                )
                dayCardIdx++
              }

              return (
                <div key={`${resultsKey}-${dateKey}`}>
                  <DateHeading dateKey={dateKey} />
                  <div className={isEfficient ? 'cards-grid--efficient' : 'cards-grid'}>
                    {gridItems}
                  </div>
                </div>
              )
            })
          })()}

          {/* End-of-grid promo — only when there's enough content to earn it */}
          {renderPromoEnd && allEvents.length >= getMidPromoThreshold() && !hasMore && renderPromoEnd()}

          {/* Infinite-scroll sentinel + end-of-list marker. */}
          {allEvents.length > 0 && (
            <div className="load-more">
              {hasMore ? (
                <>
                  <div ref={attachSentinel} aria-hidden="true" className="load-more-sentinel" />
                  <p className="load-more-loading" aria-live="polite">
                    <span className="load-more-spinner" aria-hidden="true" />
                    <span className="sr-only">Loading more events…</span>
                  </p>
                </>
              ) : (
                <p className="load-more-end">
                  Showing all {total} {total === 1 ? 'event' : 'events'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}

// Column count for the comfortable cards-grid — kept in sync with EventCard.css.
function getGridColumns(): number {
  const w = window.innerWidth
  if (w >= 900) return 3
  if (w >= 600) return 2
  return 1
}

// Inject the mid promo after ~3 rows; threshold scales with column count.
function getMidPromoThreshold(): number {
  return getGridColumns() * 3
}
