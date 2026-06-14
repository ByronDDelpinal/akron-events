import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import { useEvents, useMapEvents, PAGE_SIZE, type AppEvent } from '@/hooks/useEvents'
import { useEventFilters } from '@/hooks/useEventFilters'
import EventCard from '@/components/EventCard'
import FilterBar, { type LockedDimensions } from '@/components/FilterBar'
import MapView from '@/components/MapView'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap } from '@/lib/eventGrouping'
// Grid / list / load-more styles live in HomePage.css (global, deduped by Vite).
import '@/pages/HomePage.css'

const COMPACT_PAGE_SIZE = 48
const PREFETCH_PX = 400

interface Features {
  filter: boolean
  map: boolean
  density: boolean
  price: boolean
  tags: boolean
}

const ALL_FEATURES_ON: Features = { filter: true, map: true, density: true, price: true, tags: true }

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

  // Map toggle gated by feature flag: when the partner hides the map, force list.
  const effectiveView = features.map ? view : 'list'
  const isEfficient = density === 'efficient'
  const activePageSize = isEfficient ? COMPACT_PAGE_SIZE : PAGE_SIZE

  // ── Pagination state ──────────────────────────────────────────────────
  const [offset, setOffset] = useState(0)
  const [allEvents, setAllEvents] = useState<AppEvent[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)

  // Reset pagination whenever the filter signature (or density) changes.
  const filterKey = `${filters.filterKey}|${density}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      setOffset(0)
      setIsRefreshing(true)
    }
  }, [filterKey])

  // ── Data fetch (one page at a time) ───────────────────────────────────
  const { events: page, loading, error, total, hasMore } = useEvents({
    ...effective,
    limit: activePageSize,
    offset,
  })

  // Separate unpaginated fetch for the map — same filters, all results.
  const { events: mapEvents, loading: mapLoading } = useMapEvents({
    categories: effective.categories,
    family: effective.family,
    fundraiser: effective.fundraiser,
    dateRange: effective.dateRange,
    dateFrom: effective.dateFrom,
    dateTo: effective.dateTo,
    search: effective.search,
    freeOnly: effective.freeOnly,
    priceMax: effective.priceMax,
    neighborhoodSlug: effective.neighborhoodSlug,
    venueCities: effective.venueCities,
  })

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
    setOffset((prev) => prev + activePageSize)
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
          priceFilter={filters.priceFilter}        onPriceFilter={filters.setPriceFilter}
          sort={filters.sort}                      onSort={filters.setSort}
          view={effectiveView}                     onView={features.map ? onView : undefined}
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
          : <MapView events={mapEvents} onBackToList={() => onView?.('list')} />
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
