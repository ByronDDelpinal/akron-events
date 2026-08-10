import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import { useEvents, useMapEvents, PAGE_SIZE, type AppEvent } from '@/hooks/useEvents'
import { useRestorablePagination } from '@/hooks/useRestorablePagination'
import { useEventFilters } from '@/hooks/useEventFilters'
import { useEmbed } from '@/hooks/useEmbed'
import EventCard from '@/components/EventCard'
import FeedbackDialog from '@/components/FeedbackDialog'
import FilterBar, { type LockedDimensions } from '@/components/FilterBar'
import MapView from '@/components/MapView'
import CalendarView from '@/components/CalendarView'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap, sortFeaturedFirst } from '@/lib/eventGrouping'
import { useSearchReporting } from '@/hooks/useSearchReporting'
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
  // Null outside the embed; gates the empty-state feedback prompt off
  // partner iframes (white-label rule).
  const embed = useEmbed()

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

  // Home + embed search reporting. CategoryPage is a separate fork of this
  // component and calls the same hook itself — see useSearchReporting.
  useSearchReporting({ term: effective.search, total, loading, error, offset, page })

  // Append each incoming page to the accumulated list.
  useEffect(() => {
    if (loading) return
    if (offset === 0) {
      setAllEvents(page)
      setIsRefreshing(false)
      setResultsKey((k) => k + 1)
      onItemsChange?.(page)
    } else {
      setAllEvents((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        return [...prev, ...page.filter((e) => !ids.has(e.id))]
      })
    }
  }, [page, loading, offset, onItemsChange])

  // Fire the first-page callback exactly once (homepage hero-video unlock).
  const firstLoadFired = useRef(false)
  useEffect(() => {
    if (allEvents.length > 0 && !firstLoadFired.current) {
      firstLoadFired.current = true
      onFirstPageLoad?.()
    }
  }, [allEvents.length, onFirstPageLoad])

  // Day groups, with featured events sorted to the front of their day
  // (stable: featured keep start_at order among themselves, non-featured
  // keep theirs). Applied here — where the day-grouped list is derived —
  // so it happens before the source-cap pass and promo-injection math.
  // Days without featured events pass through as the same array.
  const grouped = useMemo(
    () =>
      groupEventsByDate(allEvents).map(
        ([dateKey, dayEvents]) => [dateKey, sortFeaturedFirst(dayEvents)] as [string, AppEvent[]],
      ),
    [allEvents],
  )

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
              {!embed && (
                <div className="empty-state-feedback">
                  <p>Can't find an event you know about?</p>
                  <FeedbackDialog placement="empty_results" align="center" triggerLabel="Tell us what's missing" triggerClassName="btn-feedback-inline" />
                </div>
              )}
            </div>
          )}

          {(() => {
            let cardIdx = 0
            let midPromoShown = false
            const midThreshold = getMidPromoThreshold(isEfficient)
            const gridCols = getGridColumns(isEfficient)
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

                // Density is the CALLER's decision: renderPromoMid runs in
                // both comfortable and efficient grids (the promo cell spans
                // all columns via .cards-grid-promo). Callers that want a
                // density-gated promo pass undefined (or render nothing) for
                // the density they want to skip.
                if (
                  renderPromoMid &&
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
          {renderPromoEnd && allEvents.length >= getMidPromoThreshold(isEfficient) && !hasMore && renderPromoEnd()}

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
/** Column count must mirror the active grid's CSS: .cards-grid (3/2/1) or
 *  .cards-grid--efficient (4/2/2, EventCard.css). The mid-promo insertion
 *  point aligns to row boundaries, so using the wrong density's count leaves
 *  an empty slot above the full-width promo cell. */
function getGridColumns(efficient: boolean): number {
  const w = window.innerWidth
  if (efficient) return w >= 900 ? 4 : 2
  if (w >= 900) return 3
  if (w >= 600) return 2
  return 1
}

// Inject the mid promo after ~3 rows; threshold scales with column count.
function getMidPromoThreshold(efficient: boolean): number {
  return getGridColumns(efficient) * 3
}
