import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useEvents, useMapEvents, PAGE_SIZE } from '@/hooks/useEvents'
import EventCard from '@/components/EventCard'
import FilterBar from '@/components/FilterBar'
import MapView from '@/components/MapView'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap } from '@/lib/eventGrouping'
// Grid / list / load-more styles live in HomePage.css. Importing it here
// (global, deduped by Vite) keeps EventsBrowser self-sufficient so any
// surface that mounts it — the homepage or the white-label embed — gets
// the grid styling without having to remember to import the sheet.
import '@/pages/HomePage.css'

const COMPACT_PAGE_SIZE = 48
const PREFETCH_PX = 400

const ALL_FEATURES_ON = { filter: true, map: true, density: true, price: true, tags: true }

/**
 * EventsBrowser — the reusable event-browsing surface: filter bar, list /
 * map views, paginated grid, infinite scroll, and per-source overflow
 * capping. Extracted from HomePage so the homepage and the white-label
 * embed render the exact same browsing experience from one implementation.
 *
 * Filter STATE is owned by the caller (via useEventFilters) and passed in,
 * because the homepage also drives that state from its hero search box and
 * intent suggestions. View / density are controlled props for the same
 * reason (the homepage persists density to localStorage; the embed seeds it
 * from its config).
 *
 * Homepage-specific furniture (promos, hero-video unlock) is injected via
 * optional render props / callbacks, so the embed simply omits them.
 *
 * @param {object}   filters          - return value of useEventFilters
 * @param {string}   view             - 'list' | 'map'  (controlled)
 * @param {function} onView
 * @param {string}   density          - 'comfortable' | 'efficient' (controlled)
 * @param {function} onDensity
 * @param {object}   features         - { filter, map, density, price, tags }
 * @param {object}   lockedDimensions - passed through to FilterBar / tray
 * @param {function} [renderPromoMid] - () => node, injected mid-grid
 * @param {function} [renderPromoEnd] - () => node, injected after the grid
 * @param {function} [onFirstPageLoad]- called once when the first page lands
 */
export default function EventsBrowser({
  filters,
  view,
  onView,
  density,
  onDensity,
  features = ALL_FEATURES_ON,
  lockedDimensions = {},
  renderPromoMid,
  renderPromoEnd,
  onFirstPageLoad,
  onItemsChange,
}) {
  const { effective } = filters

  // Map toggle gated by feature flag: when the partner hides the map, force
  // the list so a stale ?view=map can never strand the embed on a blank map.
  const effectiveView = features.map ? view : 'list'
  const isEfficient = density === 'efficient'
  const activePageSize = isEfficient ? COMPACT_PAGE_SIZE : PAGE_SIZE

  // ── Pagination state ──────────────────────────────────────────────────
  const [offset, setOffset] = useState(0)
  const [allEvents, setAllEvents] = useState([])
  // isRefreshing: true between a filter change and the arrival of fresh data.
  // We keep old events rendered (dimmed) instead of wiping them instantly.
  const [isRefreshing, setIsRefreshing] = useState(false)
  // resultsKey increments each time a fresh first page is committed, so the
  // date-group divs remount and the CSS entrance animation re-fires.
  const [resultsKey, setResultsKey] = useState(0)

  // Reset pagination whenever the filter signature (or density, which
  // changes page size) changes.
  const filterKey = `${filters.filterKey}|${density}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      setOffset(0)
      setIsRefreshing(true)
      // Don't clear allEvents here — old cards stay visible (dimmed) during load.
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
  const [expandedSources, setExpandedSources] = useState(() => new Set())
  const toggleSource = useCallback((dateKey, source) => {
    const key = `${dateKey}-${source}`
    setExpandedSources((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // ── Infinite scroll ───────────────────────────────────────────────────
  // A sentinel div at the end of the grid is observed; entering a generous
  // rootMargin around the viewport prefetches the next page. See the long
  // notes in the original HomePage implementation for why this uses a
  // callback ref (the sentinel mounts a render *after* hasMore flips true).
  const sentinelRef = useRef(null)
  const loadingRef = useRef(loading)
  loadingRef.current = loading

  const loadMoreRef = useRef()
  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMore) return
    setOffset((prev) => prev + activePageSize)
  }

  const observerRef = useRef(null)
  const attachSentinel = useCallback((node) => {
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

  // Continuation check: after each page settles, if the sentinel is still
  // inside the prefetch zone keep loading until the viewport is filled,
  // then hand off to the observer for real scroll events.
  useEffect(() => {
    if (loading || !hasMore) return
    const el = sentinelRef.current
    if (!el) return
    if (el.getBoundingClientRect().top < window.innerHeight + PREFETCH_PX) {
      loadMoreRef.current?.()
    }
  }, [allEvents.length, loading, hasMore]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── FilterBar visibility ──────────────────────────────────────────────
  // Render the bar when it would carry any control. The embed can switch
  // all three off, in which case we skip it entirely rather than show an
  // empty sticky strip.
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
              const gridItems = []
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
                const isFeatured = event.featured && dayCardIdx === 0

                // Inject the mid-grid promo (comfortable only) at a row
                // boundary so the full-width promo never leaves empty grid
                // cells. Only when the caller supplied one.
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
function getGridColumns() {
  const w = window.innerWidth
  if (w >= 900) return 3
  if (w >= 600) return 2
  return 1
}

// Inject the mid promo after ~3 rows; threshold scales with column count.
function getMidPromoThreshold() {
  return getGridColumns() * 3
}
