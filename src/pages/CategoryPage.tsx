/**
 * CategoryPage.tsx
 *
 * Renders both category hubs ("Concerts in Akron") and neighborhood hubs
 * ("Downtown Akron Events") from a single component. Each hub is defined
 * declaratively in `/src/lib/seo/categories.js`. The only thing that changes
 * between hub types is which filter the page applies before listing events.
 */

import type { LooseRow } from '@/types'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useParams, Link, Navigate, useSearchParams } from 'react-router-dom'
import { useEvents, PAGE_SIZE, type AppEvent } from '@/hooks/useEvents'
import { INTENTS } from '@/lib/intents'
import EventCard from '@/components/EventCard'
import ShareButtons from '@/components/ShareButtons'
import NewsletterCTA from '@/components/NewsletterCTA'
import NeighborhoodMap from '@/components/NeighborhoodMap'
import SummitCountyMap from '@/components/SummitCountyMap'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap } from '@/lib/eventGrouping'
import {
  CATEGORY_OPTIONS,
  SORT_OPTIONS,
  PRICE_OPTIONS,
  type CategoryOption,
} from '@/lib/filterOptions'
import {
  SEO,
  type HubInput,
  buildGraph,
  breadcrumbSchema,
  itemListSchema,
  hubTitle,
  hubDescription,
  getHub,
  getCategoryHub,
  getNeighborhoodHub,
  getCityHub,
} from '@/lib/seo'
import { NEIGHBORHOOD_SLUGS } from '@/lib/neighborhoods'
import { AKRON_SLUG, AKRON_LABEL } from '@/lib/cities'
import { eventPath } from '@/lib/slug'
import { rememberMyHub } from '@/lib/myHub'
import './CategoryPage.css'

type Row = LooseRow
// The hub registry lives in plain JS (seo/categories.js) and returns a wide
// union of shapes; treat it loosely here.
type Hub = LooseRow

interface LockedDimensions {
  category: boolean
  price: boolean
  dateRange: boolean
}

/**
 * Neighborhood matcher — Akron neighborhoods match by venue.neighborhood_slug;
 * non-Akron city hubs match by venue.city against the hub's cityMatch strings.
 */
function eventMatchesNeighborhood(event: Row, hub: Hub): boolean {
  const venue = event.venue
  if (!venue) return false

  if (NEIGHBORHOOD_SLUGS.has(hub.slug)) {
    return venue.neighborhood_slug === hub.slug
  }

  if (!hub.cityMatch || hub.cityMatch.length === 0) return false
  const city = (venue.city || '').toLowerCase()
  return hub.cityMatch.some((c: string) => c.toLowerCase() === city)
}

/** Returns the dimensions locked by this hub — what the page is *about*. */
function getLockedDimensions(hub: Hub, isCategory: boolean): LockedDimensions {
  return {
    category:  isCategory && Array.isArray(hub.categoryFilter) && hub.categoryFilter.length > 0,
    price:     !!hub.freeOnly,
    dateRange: !!hub.dateRange,
  }
}

/**
 * Route component: resolves the hub from the URL slug and redirects when it
 * doesn't exist. Kept hook-free by design — the early return means no hooks
 * may appear above it (react-hooks/rules-of-hooks). All page logic lives in
 * CategoryPageContent, which only mounts with a guaranteed non-null hub.
 */
export default function CategoryPage() {
  const { slug } = useParams()
  const hub: Hub | null = getHub(slug) ?? null

  if (!hub || (hub.disabled && !hub.preview)) return <Navigate to="/" replace />

  return <CategoryPageContent hub={hub} slug={slug} />
}

function CategoryPageContent({ hub, slug }: { hub: Hub; slug?: string }) {
  const isCategory     = !!getCategoryHub(slug)
  const isNeighborhood = !isCategory && !!getNeighborhoodHub(slug)
  const isCity         = !isCategory && !isNeighborhood && !!getCityHub(slug)
  const isAkronCity    = isCity && hub.slug === AKRON_SLUG

  const lockedDimensions = useMemo(() => getLockedDimensions(hub, isCategory), [hub, isCategory])

  // Remember the most recent locality hub (neighborhood or suburb) so
  // the PWA's "My Neighborhood" app shortcut (/go/neighborhood) can
  // deep-link straight back here. Akron-the-city is excluded: it's the
  // site's default scope, not a personal neighborhood.
  useEffect(() => {
    if ((isNeighborhood || isCity) && !isAkronCity) rememberMyHub(hub.slug)
  }, [isNeighborhood, isCity, isAkronCity, hub.slug])

  // ── URL-backed user filters ───────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams()

  const updateParam = useCallback((key: string, value: string | string[] | null | undefined) => {
    const params = new URLSearchParams(searchParams)
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      params.delete(key)
    } else {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  const search        = useMemo(() => searchParams.get('q') || '', [searchParams])
  const rawCategories = useMemo(() => {
    if (lockedDimensions.category) return []
    const c = searchParams.get('categories')
    return c ? c.split(',').filter(Boolean) : []
  }, [searchParams, lockedDimensions.category])
  const priceFilter   = useMemo(() => {
    if (lockedDimensions.price) return null
    return searchParams.get('price') || null
  }, [searchParams, lockedDimensions.price])
  const dateFrom      = useMemo(() => {
    if (lockedDimensions.dateRange) return null
    return searchParams.get('from') || null
  }, [searchParams, lockedDimensions.dateRange])
  const dateTo        = useMemo(() => {
    if (lockedDimensions.dateRange) return null
    return searchParams.get('to') || null
  }, [searchParams, lockedDimensions.dateRange])
  const sort          = useMemo(() => searchParams.get('sort') || 'soonest', [searchParams])
  const activeIntentId = useMemo<string | null>(() => {
    if (lockedDimensions.category) return null
    return searchParams.get('intent') || null
  }, [searchParams, lockedDimensions.category])

  const setSearch         = useCallback((v: string) => updateParam('q', v), [updateParam])
  const setRawCategories  = useCallback((v: string[]) => updateParam('categories', v), [updateParam])
  const setPriceFilter    = useCallback((v: string | null) => updateParam('price', v), [updateParam])
  const setDateFrom       = useCallback((v: string | null) => updateParam('from', v), [updateParam])
  const setDateTo         = useCallback((v: string | null) => updateParam('to', v), [updateParam])
  const setSort           = useCallback((v: string) => updateParam('sort', v === 'soonest' ? null : v), [updateParam])
  const setActiveIntentId = useCallback((v: string | null) => updateParam('intent', v), [updateParam])

  // ── Search input draft (committed on Enter) ───────────────────────
  const [searchInput, setSearchInput] = useState(search)
  useEffect(() => { setSearchInput(search) }, [search])
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') setSearch(searchInput) }
  const onSearchBlur = () => { if (!searchInput) setSearch('') }

  // ── Resolve fetch parameters ──────────────────────────────────────
  const intentDef = useMemo(
    () => (activeIntentId ? (INTENTS.find((i) => i.id === activeIntentId) ?? null) : null),
    [activeIntentId]
  )
  const intentCategories: string[] = intentDef?.categories ?? []
  const intentFacets: string[]     = intentDef?.facets ?? []

  const hubFacets: string[] = Array.isArray(hub.facetFilter) ? hub.facetFilter : []

  const effectiveCategories: string[] = lockedDimensions.category
    ? hub.categoryFilter
    : (rawCategories.length > 0 ? rawCategories : intentCategories)

  const effectiveFamily     = hubFacets.includes('family')     || intentFacets.includes('family')
  const effectiveFundraiser = hubFacets.includes('fundraiser') || intentFacets.includes('fundraiser')

  const effectiveFreeOnly = lockedDimensions.price ? true : (priceFilter === 'free')
  const effectivePriceMax = lockedDimensions.price ? null
    : (priceFilter === 'free' ? null : priceFilter)
  const effectiveDateRange = lockedDimensions.dateRange ? hub.dateRange : null

  // ── Pagination state ──
  const [offset,      setOffset]      = useState(0)
  const [allEvents,   setAllEvents]   = useState<AppEvent[]>([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [resultsKey,  setResultsKey]  = useState(0)

  const [akronMapView, setAkronMapView] = useState('neighborhoods')

  // Source-overflow expansion state — keys `${dateKey}-${source}`.
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

  // ── Filter signature → reset pagination on any change ──
  const filterKey = [
    hub.slug,
    activeIntentId,
    effectiveCategories.join(','),
    effectiveDateRange,
    dateFrom,
    dateTo,
    search,
    effectiveFreeOnly,
    effectivePriceMax,
    sort,
  ].join('|')
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      setOffset(0)
      setIsRefreshing(true)
    }
  }, [filterKey])

  // ── Data fetch ──
  const isAkronNeighborhood = isNeighborhood && NEIGHBORHOOD_SLUGS.has(hub.slug)
  const { events: page, loading, error, total, hasMore } = useEvents({
    categories: effectiveCategories,
    family:     effectiveFamily,
    fundraiser: effectiveFundraiser,
    freeOnly:   effectiveFreeOnly,
    priceMax:   effectivePriceMax,
    dateRange:  effectiveDateRange,
    dateFrom,
    dateTo,
    search,
    sort,
    neighborhoodSlug: isAkronNeighborhood ? hub.slug : null,
    venueCities:      isCity ? (hub.cityMatch || []) : [],
    limit:    PAGE_SIZE,
    offset,
  })

  useEffect(() => {
    if (loading) return
    if (offset === 0) {
      setAllEvents(page)
      setIsRefreshing(false)
      setResultsKey((k) => k + 1)
    } else {
      setAllEvents((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        return [...prev, ...page.filter((e) => !ids.has(e.id))]
      })
    }
  }, [page, loading, offset])

  // City hubs filter server-side now; this client pass is a safety net.
  const events = useMemo(() => {
    if (isCity) {
      return allEvents.filter((e) => eventMatchesNeighborhood(e, hub))
    }
    return allEvents
  }, [allEvents, isCity, hub])

  const grouped = useMemo(() => groupEventsByDate(events), [events])

  // ── Infinite scroll ──
  const PREFETCH_PX = 400
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadingRef  = useRef(loading)
  loadingRef.current = loading

  const loadMoreRef = useRef<() => void>(() => {})
  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMore) return
    setOffset((prev) => prev + PAGE_SIZE)
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

  useEffect(() => {
    if (loading || !hasMore) return
    const el = sentinelRef.current
    if (!el) return
    if (el.getBoundingClientRect().top < window.innerHeight + PREFETCH_PX) {
      loadMoreRef.current?.()
    }
  }, [allEvents.length, loading, hasMore])

  // ── Breadcrumb trail ──
  const canonicalPath = `/events/${hub.slug}`
  const breadcrumbTrail = useMemo(() => {
    const trail = [{ name: 'Home', url: '/' }]
    if (isNeighborhood) {
      trail.push({ name: AKRON_LABEL, url: `/events/${AKRON_SLUG}` })
    }
    trail.push({ name: hub.label, url: canonicalPath })
    return trail
  }, [isNeighborhood, hub.label, canonicalPath])
  const breadcrumb = breadcrumbSchema(breadcrumbTrail)
  const itemList = itemListSchema(
    events.slice(0, 20).map((e) => ({
      name: e.title,
      url: eventPath(e),
    })),
  )

  const seoGraph = buildGraph(breadcrumb, itemList)

  // ── Related hubs strip ──
  const related: Hub[] = (hub.relatedSlugs ?? [])
    .map((s: string) => getHub(s))
    .filter((h: Hub | null) => h && !h.disabled)

  // ── Hero layout pieces ────────────────────────────────────────────
  // Map-bearing hubs (neighborhood / city) arrange the controls — share,
  // search, filter & sort, event count — in a column to the left of the
  // map, with the grid below and the SEO intro copy after the grid.
  // Category hubs (no map) keep the stacked intro-first layout.
  const hasMap = isNeighborhood || isAkronCity || isCity

  const shownCount = isAkronNeighborhood || isCategory ? total : events.length
  const countLabel = shownCount > 0
    ? `${shownCount.toLocaleString()} upcoming ${shownCount === 1 ? 'event' : 'events'}`
    : 'Upcoming events'

  const mapAside: ReactNode = isNeighborhood ? (
    <NeighborhoodMap activeSlug={hub.slug} />
  ) : isAkronCity ? (
    <div className="akron-map-stack">
      {akronMapView === 'neighborhoods'
        ? <NeighborhoodMap activeSlug={null} activeLabelOverride="all of Akron" />
        : <SummitCountyMap activeSlug={AKRON_SLUG} />}

      <div className="akron-map-toggle">
        <label htmlFor="akron-map-toggle-select" className="akron-map-toggle-label">
          View
        </label>
        <select
          id="akron-map-toggle-select"
          className="akron-map-toggle-select"
          value={akronMapView}
          onChange={(e) => setAkronMapView(e.target.value)}
        >
          <option value="neighborhoods">Akron Neighborhoods</option>
          <option value="summit-county">Summit County</option>
        </select>
      </div>
    </div>
  ) : isCity ? (
    <SummitCountyMap activeSlug={hub.slug} />
  ) : null

  const shareRow = (
    <div className="hub-share">
      <ShareButtons
        url={canonicalPath}
        title={hub.h1}
        text={hub.metaDescription}
        campaign={isCategory ? 'category_hub' : isCity ? 'city_hub' : 'neighborhood_hub'}
      />
    </div>
  )

  const searchBox = (
    <div className="hub-search">
      <HubSearchIcon />
      <input
        className="hub-search-input"
        type="text"
        placeholder={`Search ${hub.label.toLowerCase()}…`}
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        onKeyDown={onSearchKeyDown}
        onBlur={onSearchBlur}
        aria-label={`Search ${hub.label}`}
      />
      {searchInput && (
        <button
          type="button"
          className="hub-search-clear"
          onClick={() => { setSearchInput(''); setSearch('') }}
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  )

  const filtersPanel = (
    <HubFilters
      lockedDimensions={lockedDimensions}
      sort={sort}                      onSort={setSort}
      activeIntentId={activeIntentId}  onIntentId={setActiveIntentId}
      rawCategories={rawCategories}    onRawCategories={setRawCategories}
      priceFilter={priceFilter}        onPriceFilter={setPriceFilter}
      dateFrom={dateFrom}              onDateFrom={setDateFrom}
      dateTo={dateTo}                  onDateTo={setDateTo}
      hasAnyUserFilter={
        !!activeIntentId
        || rawCategories.length > 0
        || priceFilter !== null
        || dateFrom !== null
        || dateTo !== null
        || sort !== 'soonest'
      }
      onClearAll={() => {
        setSearchInput('')
        setSearchParams({}, { replace: true })
      }}
    />
  )

  return (
    <div className="hub-page">
      <SEO
        title={hubTitle(hub as HubInput)}
        description={hubDescription(hub as HubInput)}
        path={canonicalPath}
        image={`/api/og/hub/${hub.slug}`}
        type="website"
        jsonLd={seoGraph}
      />

      <div className="hub-header">
        <nav className="hub-breadcrumb" aria-label="Breadcrumb">
          {breadcrumbTrail.map((crumb, i) => {
            const isLast = i === breadcrumbTrail.length - 1
            return (
              <Fragment key={crumb.url}>
                {i > 0 && <span aria-hidden="true">›</span>}
                {isLast
                  ? <span aria-current="page">{crumb.name}</span>
                  : <Link to={crumb.url}>{crumb.name}</Link>}
              </Fragment>
            )
          })}
        </nav>
        <h1 className="hub-h1">{hub.h1}</h1>

        {hasMap ? (
          <div className="hub-hero-grid">
            <div className="hub-hero-controls">
              {shareRow}
              {searchBox}
              {filtersPanel}
              <p className="hub-count" aria-hidden="true">{countLabel}</p>
            </div>
            <div className="hub-hero-aside">{mapAside}</div>
          </div>
        ) : (
          <div className="hub-hero-stack">
            {shareRow}
            {searchBox}
            {filtersPanel}
          </div>
        )}
      </div>

      <section
        className={`hub-events${isRefreshing ? ' hub-events--refreshing' : ''}`}
        aria-labelledby="hub-events-heading"
      >
        {/* On map hubs the count is rendered in the hero controls column;
            the heading stays in the DOM (visually hidden) so the section
            keeps its accessible name. */}
        <h2 id="hub-events-heading" className={hasMap ? 'sr-only' : 'hub-section-heading'}>
          {countLabel}
        </h2>

        {loading && allEvents.length === 0 && !isRefreshing && (
          <p className="hub-empty">Loading events…</p>
        )}

        {error && (
          <p className="hub-empty">Couldn't load events right now. Please try again.</p>
        )}

        {!loading && !isRefreshing && !error && events.length === 0 && (
          <p className="hub-empty">
            No upcoming events match your filters. Try clearing them, or{' '}
            <Link to="/">browse all events</Link>.
          </p>
        )}

        {grouped.map(([dateKey, dayEvents]) => {
          const items = applySourceCap(dayEvents, expandedSources, dateKey)
          return (
            <div key={`${resultsKey}-${dateKey}`}>
              <DateHeading dateKey={dateKey} />
              <div className="cards-grid">
                {items.map((item) => {
                  if (item.type === 'overflow') {
                    return (
                      <SourceOverflowCard
                        key={`overflow-${item.dateKey}-${item.source}`}
                        source={item.source}
                        hiddenCount={item.hiddenCount}
                        isExpanded={item.isExpanded}
                        onToggle={() => toggleSource(item.dateKey, item.source)}
                      />
                    )
                  }
                  const ev = item.event
                  return (
                    <div
                      key={ev.id}
                      className={`card-enter${item.isRevealed ? ' card-reveal' : ''}`}
                    >
                      <EventCard event={ev} viewMode="comfortable" />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

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
                Showing all {(isAkronNeighborhood || isCategory ? total : events.length).toLocaleString()}{' '}
                {(isAkronNeighborhood || isCategory ? total : events.length) === 1 ? 'event' : 'events'}
              </p>
            )}
          </div>
        )}
      </section>

      {/* The SEO intro copy reads below the grid on every hub, so the events
          lead and the prose doesn't push them down. */}
      {hub.intro && (
        <section className="hub-about" aria-label={`About ${hub.label}`}>
          <p className="hub-intro hub-intro--below">{hub.intro}</p>
        </section>
      )}

      <NewsletterCTA
        variant="hub"
        surface={isCategory ? 'category_hub' : isCity ? 'city_hub' : 'neighborhood_hub'}
      />

      {related.length > 0 && (
        <section className="hub-related" aria-labelledby="hub-related-heading">
          <h2 id="hub-related-heading" className="hub-section-heading">Browse other Akron event guides</h2>
          <ul className="hub-related-list">
            {related.map((r) => (
              <li key={r.slug}>
                <Link to={`/events/${r.slug}`}>{r.h1 || r.label}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function HubSearchIcon() {
  return (
    <svg
      className="hub-search-icon"
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

const TODAY = new Date().toISOString().split('T')[0]

interface HubFiltersProps {
  lockedDimensions: LockedDimensions
  sort: string
  onSort: (v: string) => void
  activeIntentId: string | null
  onIntentId: (v: string | null) => void
  rawCategories: string[]
  onRawCategories: (v: string[]) => void
  priceFilter: string | null
  onPriceFilter: (v: string | null) => void
  dateFrom: string | null
  onDateFrom: (v: string | null) => void
  dateTo: string | null
  onDateTo: (v: string | null) => void
  hasAnyUserFilter: boolean
  onClearAll: () => void
}

/**
 * HubFilters — inline (non-modal) filter & sort strip for hub pages. Sections
 * corresponding to a locked dimension are omitted.
 */
function HubFilters({
  lockedDimensions,
  sort,            onSort,
  activeIntentId,  onIntentId,
  rawCategories,   onRawCategories,
  priceFilter,     onPriceFilter,
  dateFrom,        onDateFrom,
  dateTo,          onDateTo,
  hasAnyUserFilter,
  onClearAll,
}: HubFiltersProps) {
  function toggleCategoryOption(opt: CategoryOption) {
    if (opt.kind === 'intent') {
      onIntentId(activeIntentId === opt.value ? null : opt.value)
      return
    }
    if (rawCategories.includes(opt.value)) {
      onRawCategories(rawCategories.filter((c) => c !== opt.value))
    } else {
      onRawCategories([...rawCategories, opt.value])
    }
  }

  function isCategoryOptionActive(opt: CategoryOption) {
    return opt.kind === 'intent'
      ? activeIntentId === opt.value
      : rawCategories.includes(opt.value)
  }

  return (
    <div className="hub-filters" aria-label="Filter and sort">
      <div className="hub-filters-header">
        <span className="hub-filters-title">Filter &amp; sort</span>
        <div className="hub-filters-actions">
          {hasAnyUserFilter && (
            <button type="button" className="hub-filters-clear" onClick={onClearAll}>
              Clear all
            </button>
          )}
          <label className="hub-filters-sort">
            <span className="hub-filters-sort-label">Sort</span>
            <select
              className="hub-filters-sort-select"
              value={sort}
              onChange={(e) => onSort(e.target.value)}
              aria-label="Sort events"
            >
              {SORT_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!lockedDimensions.category && (
        <HubFilterSection label="Category">
          {CATEGORY_OPTIONS.map((opt) => (
            <HubChip
              key={`${opt.kind}:${opt.value}`}
              active={isCategoryOptionActive(opt)}
              onClick={() => toggleCategoryOption(opt)}
            >
              {opt.label}
            </HubChip>
          ))}
        </HubFilterSection>
      )}

      {!lockedDimensions.price && (
        <HubFilterSection label="Price">
          {PRICE_OPTIONS.map(({ value, label }) => (
            <HubChip
              key={String(value)}
              active={priceFilter === value}
              onClick={() => onPriceFilter(priceFilter === value ? null : value)}
            >
              {label}
            </HubChip>
          ))}
        </HubFilterSection>
      )}

      {!lockedDimensions.dateRange && (
        <HubFilterSection label="Custom date range">
          <div className="hub-filter-date-row">
            <label className="hub-filter-date-label">
              From
              <input
                type="date"
                className="hub-filter-date-input"
                value={dateFrom ?? ''}
                min={TODAY}
                onChange={(e) => onDateFrom(e.target.value || null)}
              />
            </label>
            <label className="hub-filter-date-label">
              To
              <input
                type="date"
                className="hub-filter-date-input"
                value={dateTo ?? ''}
                min={dateFrom ?? TODAY}
                onChange={(e) => onDateTo(e.target.value || null)}
              />
            </label>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                className="hub-filter-date-clear"
                onClick={() => { onDateFrom(null); onDateTo(null) }}
              >
                Clear dates
              </button>
            )}
          </div>
        </HubFilterSection>
      )}
    </div>
  )
}

function HubFilterSection({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="hub-filter-section">
      <span className="hub-filter-section-label">{label}</span>
      <div className="hub-filter-chips">{children}</div>
    </div>
  )
}

function HubChip({ active, onClick, children }: { active: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      className={`hub-filter-chip ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
