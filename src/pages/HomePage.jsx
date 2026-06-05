import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useEvents, useMapEvents, PAGE_SIZE } from '@/hooks/useEvents'
import { supabase } from '@/lib/supabase'

const COMPACT_PAGE_SIZE = 48
import EventCard from '@/components/EventCard'
import FilterBar from '@/components/FilterBar'
import MapView from '@/components/MapView'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap } from '@/lib/eventGrouping'
import { INTENTS, SEARCH_SUGGESTIONS } from '@/lib/intents'
import { CITIES, REGIONS } from '@/lib/cities'
import { NEIGHBORHOODS } from '@/lib/neighborhoods'
import {
  SEO,
  homeTitle,
  homeDescription,
  ENABLED_CATEGORY_HUBS,
  ENABLED_NEIGHBORHOOD_HUBS,
  buildGraph,
  itemListSchema,
} from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import './HomePage.css'

// ── localStorage key for persisting card view mode ──
const VIEW_MODE_KEY = 'akronpulse_card_view_mode'
const LEGACY_VIEW_MODE_KEY = 'turnout_card_view_mode'

function getStoredViewMode() {
  try {
    // Rebrand migration: move pre-rebrand value into the new key on first read.
    const legacy = localStorage.getItem(LEGACY_VIEW_MODE_KEY)
    if (legacy && !localStorage.getItem(VIEW_MODE_KEY)) {
      localStorage.setItem(VIEW_MODE_KEY, legacy)
      localStorage.removeItem(LEGACY_VIEW_MODE_KEY)
    }
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return v === 'efficient' ? 'efficient' : 'comfortable'
  } catch { return 'comfortable' }
}

export default function HomePage() {
  // ── All filter state is URL-backed ───────────────────────────────────
  // Every filter param lives in the URL so that navigating to an event
  // detail page and pressing Back (or the "← Back to events" button)
  // restores the exact filter state the user had set. `replace: true`
  // on every setter means toggling a filter never pollutes back-history
  // with intermediate states — only the navigation away from the home
  // page (PUSH) creates a new history entry.
  const [searchParams, setSearchParams] = useSearchParams()

  // Single helper that writes one param key → value into the URL.
  // Passing null/empty removes the key so the URL stays clean.
  const updateParam = useCallback((key, value) => {
    const params = new URLSearchParams(searchParams)
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      params.delete(key)
    } else {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  // intent — 'date-night' | 'give-back' | 'outdoors-active' | etc.
  // Validated against the canonical INTENTS registry so a stale or
  // hand-edited param can never set a phantom intent.
  const activeIntentId = useMemo(() => {
    const id = searchParams.get('intent')
    return INTENTS.some((i) => i.id === id) ? id : null
  }, [searchParams])
  const setActiveIntentId = useCallback((v) => updateParam('intent', v), [updateParam])

  // date — predefined date-range preset ('today' | 'this_weekend' | etc.)
  const dateRange = useMemo(() => searchParams.get('date') || null, [searchParams])
  const setDateRange = useCallback((v) => updateParam('date', v), [updateParam])

  // from / to — custom 'YYYY-MM-DD' date range (FilterTray date picker)
  const dateFrom = useMemo(() => searchParams.get('from') || null, [searchParams])
  const setDateFrom = useCallback((v) => updateParam('from', v), [updateParam])
  const dateTo = useMemo(() => searchParams.get('to') || null, [searchParams])
  const setDateTo = useCallback((v) => updateParam('to', v), [updateParam])

  // categories — comma-separated list (e.g. "music,outdoors")
  const rawCategories = useMemo(() => {
    const raw = searchParams.get('categories') || ''
    return raw.split(',').map((c) => c.trim()).filter(Boolean)
  }, [searchParams])
  const setRawCategories = useCallback((v) => updateParam('categories', v), [updateParam])

  // price — null | 'free' | 'under10' | 'under25'
  const priceFilter = useMemo(() => searchParams.get('price') || null, [searchParams])
  const setPriceFilter = useCallback((v) => updateParam('price', v), [updateParam])

  // sort — 'soonest' (default, omitted from URL) | 'latest'
  const sort = useMemo(() => searchParams.get('sort') || 'soonest', [searchParams])
  const setSort = useCallback((v) => updateParam('sort', v === 'soonest' ? null : v), [updateParam])

  // Location dropdown → navigate to the city / neighborhood hub page.
  // Reuses the existing CategoryPage hubs (/events/{slug}); the <select>
  // is purely an action menu, so it never holds a value of its own.
  const navigate = useNavigate()
  const handleLocationChange = (e) => {
    const slug = e.target.value
    if (slug) navigate(`/events/${slug}`)
  }

  // ── Hub slug resolver ─────────────────────────────────────────────────
  // Normalises a freeform query (any casing, spaces, hyphens, underscores)
  // and checks whether it matches a known neighborhood, city, or region.
  // Returns the matching slug, or null if no match.
  const ALL_HUB_ENTRIES = useMemo(() => [
    ...NEIGHBORHOODS,
    ...CITIES,
    ...REGIONS,
  ], [])

  const resolveHubSlug = useCallback((query) => {
    // Strip everything that isn't a letter or digit, then lowercase.
    const normalise = (s) => s.replace(/[\s\-_]+/g, '').toLowerCase()
    const needle = normalise(query)
    if (!needle) return null
    return ALL_HUB_ENTRIES.find((h) => normalise(h.label) === needle || normalise(h.slug) === needle)?.slug ?? null
  }, [ALL_HUB_ENTRIES])

  // ── Search is URL-backed so it survives back-navigation and can be shared ─
  // `search` is the committed query (derived from ?q=); `searchInput` is the
  // local draft that lives in the <input> until the user presses Enter.
  const search = useMemo(() => searchParams.get('q') || '', [searchParams])
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') || '')

  // Commits the search draft to the URL (?q=). Uses replace so rapid
  // typing doesn't pollute back-history.
  const setSearch = useCallback((value) => updateParam('q', value || null), [updateParam])

  // Keep the search <input> in sync when the URL's ?q= changes externally —
  // most importantly when the user presses the browser back button after
  // navigating to an event detail page.
  useEffect(() => {
    setSearchInput(search)
  }, [search])

  const [view,           setView]           = useState('list')

  // ── Card view mode (Comfortable / Efficient) ─────────────────────────
  const [cardViewMode, setCardViewMode] = useState(getStoredViewMode)

  // ── Hero video: deferred until the first page of events has loaded ────
  // This ensures the video fetch doesn't compete with Supabase on first paint.
  const [videoUnlocked, setVideoUnlocked] = useState(false)

  const handleCardViewMode = (mode) => {
    setCardViewMode(mode)
    try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch {}
  }

  // ── Search suggestion dropdown ─────────────────────────────────────────
  const [searchFocused,  setSearchFocused]  = useState(false)
  const searchWrapRef = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!searchFocused) return
    function onDown(e) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
        setSearchFocused(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchFocused])

  // ── Derived: what to pass to useEvents ────────────────────────────────
  const activeIntent      = INTENTS.find(i => i.id === activeIntentId) ?? null
  const intentFacets      = activeIntent?.facets ?? []
  // Tray raw categories narrow; if empty, fall back to intent's categories.
  // Facet-only intents (Family, Give Back) carry no categories — they filter
  // purely on the facet flags below.
  const effectiveCategories = rawCategories.length > 0
    ? rawCategories
    : (activeIntent?.categories ?? [])
  // Facet flags from the active intent (the new cross-cutting axis).
  const effectiveFamily     = intentFacets.includes('family')
  const effectiveFundraiser = intentFacets.includes('fundraiser')
  // freeOnly is true when the intent carries the 'free' facet, OR tray price is 'free'
  const effectiveFreeOnly = intentFacets.includes('free') || priceFilter === 'free'
  // priceMax only applies when not using freeOnly
  const effectivePriceMax = effectiveFreeOnly ? null : priceFilter

  // ── Last-updated label (from most recent scraper run) ─────────────────
  const [lastUpdated, setLastUpdated] = useState(null)
  useEffect(() => {
    supabase
      .from('scraper_runs')
      .select('ran_at')
      .order('ran_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data?.[0]?.ran_at) {
          const hours = (Date.now() - new Date(data[0].ran_at).getTime()) / 3.6e6
          if (hours < 1)       setLastUpdated('< 1 hour ago')
          else if (hours < 24) setLastUpdated(`${Math.round(hours)}h ago`)
          else                 setLastUpdated(`${Math.round(hours / 24)}d ago`)
        }
      })
  }, [])

  // ── Pagination state ──────────────────────────────────────────────────
  const [offset,      setOffset]      = useState(0)
  const [allEvents,   setAllEvents]   = useState([])
  // isRefreshing: true between a filter change and the arrival of fresh data.
  // We keep old events rendered (dimmed) instead of wiping them instantly.
  const [isRefreshing, setIsRefreshing] = useState(false)
  // resultsKey increments each time a fresh first page is committed.
  // Date-group divs use it in their key so React remounts them → CSS animation fires.
  const [resultsKey, setResultsKey] = useState(0)

  // Track the filter signature so we can reset pagination on any change
  const activePageSize = cardViewMode === 'efficient' ? COMPACT_PAGE_SIZE : PAGE_SIZE
  const filterKey = `${activeIntentId}|${effectiveCategories.join(',')}|${effectiveFamily}|${effectiveFundraiser}|${dateRange}|${dateFrom}|${dateTo}|${search}|${effectiveFreeOnly}|${effectivePriceMax}|${sort}|${cardViewMode}`
  const prevFilterKey = useRef(filterKey)

  // On filter change: signal a refresh but keep old events visible
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      setOffset(0)
      setIsRefreshing(true)
      // Don't clear allEvents here — old cards stay visible (dimmed) during load
    }
  }, [filterKey])

  // ── Data fetch (one page at a time) ───────────────────────────────────
  const { events: page, loading, error, total, hasMore } = useEvents({
    categories: effectiveCategories,
    family:        effectiveFamily,
    fundraiser:    effectiveFundraiser,
    dateRange, dateFrom, dateTo,
    search,
    freeOnly:      effectiveFreeOnly,
    priceMax:      effectivePriceMax,
    sort,
    limit: activePageSize,
    offset,
  })

  // Separate unpaginated fetch for the map — same filters, all results
  const { events: mapEvents, loading: mapLoading, total: mapTotal } = useMapEvents({
    categories: effectiveCategories,
    family:        effectiveFamily,
    fundraiser:    effectiveFundraiser,
    dateRange, dateFrom, dateTo,
    search,
    freeOnly:      effectiveFreeOnly,
    priceMax:      effectivePriceMax,
  })

  // Append each incoming page to the accumulated list
  useEffect(() => {
    if (loading) return
    if (offset === 0) {
      setAllEvents(page)
      setIsRefreshing(false)
      setResultsKey(k => k + 1) // causes date-group keys to change → entrance animation
    } else {
      setAllEvents(prev => {
        // Deduplicate by id in case of any overlap
        const ids = new Set(prev.map(e => e.id))
        return [...prev, ...page.filter(e => !ids.has(e.id))]
      })
    }
  }, [page, loading, offset])

  // Unlock the hero video once the first batch of events has arrived.
  // allEvents is empty until the first page commits, so this fires exactly once.
  useEffect(() => {
    if (allEvents.length > 0 && !videoUnlocked) setVideoUnlocked(true)
  }, [allEvents.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => groupEventsByDate(allEvents), [allEvents])

  const clearFilters = () => {
    setSearchInput('')
    // Wipe all URL params in one replace — clears every filter at once.
    setSearchParams({}, { replace: true })
  }

  const handleSearchKeyDown = (e) => {
    if (e.key !== 'Enter') return
    const hubSlug = resolveHubSlug(searchInput)
    if (hubSlug) {
      setSearchInput('')
      navigate(`/events/${hubSlug}`)
    } else {
      setSearch(searchInput)
    }
  }

  // ── Infinite scroll ──────────────────────────────────────────────────
  // The "Load more" button has been replaced with an IntersectionObserver-
  // driven prefetch. A sentinel div sits at the end of the grid; whenever it
  // enters a generous rootMargin around the viewport, we fetch the next
  // page. The observer is recreated whenever the loaded count or hasMore
  // flips, which naturally cascades: once a page settles, the observer
  // re-evaluates intersection state and — if the sentinel is still within
  // the prefetch zone — triggers the next page immediately. The result is
  // that page 2 is fetched as soon as page 1 paints, and subsequent pages
  // are queued before the user scrolls anywhere near the bottom.
  const sentinelRef = useRef(null)
  const loadingRef  = useRef(loading)
  useEffect(() => { loadingRef.current = loading }, [loading])

  // Latest-loadMore in a ref so the observer effect doesn't churn each
  // render just because the closure captured a new activePageSize.
  const loadMoreRef = useRef()
  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMore) return
    setOffset(prev => prev + activePageSize)
  }

  useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreRef.current?.()
            break
          }
        }
      },
      // Prefetch zone: start loading the next page when the sentinel is
      // 400px below the viewport — enough runway to feel seamless without
      // cascading through every page on initial paint.
      { rootMargin: '0px 0px 400px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  // Intentionally omit allEvents.length — including it caused the observer
  // to reconnect after every page load, re-check intersection, and
  // immediately trigger the next page in a runaway cascade.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore])

  const isEfficient = cardViewMode === 'efficient'

  // ── Source overflow expansion state ──────────────────────────────────
  // Keys are `${dateKey}-${source}` strings.
  const [expandedSources, setExpandedSources] = useState(() => new Set())

  const toggleSource = useCallback((dateKey, source) => {
    const key = `${dateKey}-${source}`
    setExpandedSources(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Build an ItemList JSON-LD of the next ~12 upcoming events. AI
  // assistants (Claude, ChatGPT, Perplexity) parse structured lists
  // like this when answering "what's happening in Akron this week"
  // queries — emitting it here turns the homepage into a citable
  // surface for AI-driven discovery without requiring a separate
  // crawl pass on category pages.
  const homepageItemList = useMemo(() => {
    if (!allEvents || allEvents.length === 0) return null
    return itemListSchema(
      allEvents.slice(0, 12).map((e) => ({
        name: e.title,
        url: eventPath(e),
      })),
    )
  }, [allEvents])
  const homeGraph = homepageItemList ? buildGraph(homepageItemList) : null

  return (
    <>
      <SEO
        title={homeTitle()}
        description={homeDescription()}
        path="/"
        jsonLd={homeGraph}
      />

      {/* ── HERO ── */}
      <div className="hero">
        {/* Background layer: poster always visible, video fades in after events load */}
        <div className="hero-bg" aria-hidden="true">
          <div className="hero-bg-poster" />
          {videoUnlocked && (
            <video
              className="hero-bg-video"
              autoPlay
              muted
              loop
              playsInline
              disablePictureInPicture
              src="/video/akron-pulse-banner.mp4"
            />
          )}
          <div className="hero-bg-scrim" />
        </div>
        <div className="hero-glow" />
        <p className="hero-eyebrow">Summit County, Ohio</p>
        <h1>What's happening<br />in <span>Akron?</span></h1>
        <p className="hero-sub">Concerts, galas, art shows, markets, and more — happening right now in Akron.</p>
        <div className="search-wrap" ref={searchWrapRef}>
          <SearchIcon />
          <input
            className={`search-input${searchFocused && !searchInput ? ' search-input--open' : ''}`}
            type="text"
            placeholder="Search events, venues, organizers…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => { if (!searchInput) setSearch('') }}
          />

          {/* ── Intent suggestion dropdown ── */}
          {searchFocused && !searchInput && (
            <div className="search-suggestions">
              <p className="search-suggestions-label">What are you looking for?</p>
              {SEARCH_SUGGESTIONS.map((s, i) => {
                const intent = INTENTS.find(it => it.id === s.intentId)
                return (
                  <button
                    key={i}
                    className="search-suggestion-item"
                    onMouseDown={() => {
                      // mouseDown fires before blur — apply then close
                      setActiveIntentId(s.intentId)
                      if (s.datePreset) setDateRange(s.datePreset)
                      setSearchFocused(false)
                    }}
                  >
                    <span className="suggestion-emoji">{intent?.emoji ?? '✨'}</span>
                    <span className="suggestion-text">
                      <span className="suggestion-label">{s.label}</span>
                      {intent?.tagline && (
                        <span className="suggestion-tagline">{intent.tagline}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── STAT BAR ── */}
      <div className="stat-bar">
        <div className="stat-bar-inner">
          {lastUpdated && (
            <div className="stat-pill">Updated <strong>{lastUpdated}</strong></div>
          )}

          {/* Location jump menu — pick a city or Akron neighborhood to
              land on its hub page. Cities first; the 24 Akron
              neighborhoods are grouped at the end so they don't crowd
              the middle of the list. */}
          <div className="location-jump">
            <LocationIcon />
            <select
              className="location-jump-select"
              value=""
              onChange={handleLocationChange}
              aria-label="Choose a city or neighborhood"
            >
              <option value="" disabled>Choose a city or neighborhood</option>
              <optgroup label="Cities">
                {CITIES.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.label}</option>
                ))}
              </optgroup>
              <optgroup label="Akron Neighborhoods">
                {NEIGHBORHOODS.map((n) => (
                  <option key={n.slug} value={n.slug}>{n.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
      </div>

      {/* ── HUB STRIP ──
       * Compact strip of links into each category and neighborhood
       * hub page. Sits above the filter bar so search engines see
       * descriptive internal anchor text on the homepage and so
       * users browsing by category have a one-click path to the
       * topical landing page. The links are wrapped in a <nav>
       * with an aria-label for accessibility and crawler
       * comprehension. */}
      {/* Hub strip — categories only for now. Top 3 enabled
          neighborhoods will rejoin the strip once GIS data lands. */}
      {(ENABLED_CATEGORY_HUBS.length + ENABLED_NEIGHBORHOOD_HUBS.length) > 0 && (
        <nav className="home-hub-strip" aria-label="Browse Akron events by category and neighborhood">
          <p className="home-hub-strip-label">Popular searches</p>
          <div className="home-hub-strip-scroll-wrap">
          <ul className="home-hub-strip-list">
            {ENABLED_CATEGORY_HUBS.map((h) => (
              <li key={`cat-${h.slug}`}>
                <Link to={`/events/${h.slug}`}>{h.label}</Link>
              </li>
            ))}
            {ENABLED_NEIGHBORHOOD_HUBS.slice(0, 3).map((h) => (
              <li key={`nb-${h.slug}`}>
                <Link to={`/events/${h.slug}`}>{h.label}</Link>
              </li>
            ))}
          </ul>
          </div>
        </nav>
      )}

      {/* ── FILTER BAR ── */}
      <FilterBar
        activeIntentId={activeIntentId}  onIntentId={setActiveIntentId}
        dateRange={dateRange}            onDateRange={setDateRange}
        dateFrom={dateFrom}              onDateFrom={setDateFrom}
        dateTo={dateTo}                  onDateTo={setDateTo}
        rawCategories={rawCategories}    onRawCategories={setRawCategories}
        priceFilter={priceFilter}        onPriceFilter={setPriceFilter}
        sort={sort}                      onSort={setSort}
        view={view}                      onView={setView}
        total={total}
        cardViewMode={cardViewMode}      onCardViewMode={handleCardViewMode}
      />

      {/* ── MAP VIEW ── */}
      {view === 'map' && (
        mapLoading
          ? <div className="map-loading"><span>Loading map…</span></div>
          : <MapView events={mapEvents} onBackToList={() => setView('list')} />
      )}

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <div className={`content${isRefreshing ? ' content--refreshing' : ''}`}>

          {/* ── Initial load — only show spinner when we have nothing to show yet ── */}
          {loading && allEvents.length === 0 && !isRefreshing && (
            <div className="empty-state">Loading events…</div>
          )}

          {error && (
            <div className="empty-state error">Couldn't load events. Please try again.</div>
          )}

          {!loading && !isRefreshing && !error && allEvents.length === 0 && (
            <div className="empty-state">
              <p>No events match your current filters.</p>
              <button className="btn-clear" onClick={clearFilters}>
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
              let dayCardIdx = 0  // track index within day for featured logic

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
                  // overflow card does not increment cardIdx (it's not a real event)
                  continue
                }

                // type === 'event'
                const event = item.event
                const isFeatured = event.featured && dayCardIdx === 0

                // Inject mid-grid promo at threshold (comfortable only).
                // The promo spans the full row (grid-column: 1 / -1) so we
                // must only inject when the current grid position is at a
                // row boundary — otherwise CSS Grid leaves empty cells in
                // the prior row. Overflow cards occupy real grid cells but
                // do not increment cardIdx, so we use gridItems.length
                // (the true cell count for this date's grid) for the
                // row-boundary check.
                if (
                  !isEfficient &&
                  !midPromoShown &&
                  cardIdx >= midThreshold &&
                  gridItems.length % gridCols === 0
                ) {
                  gridItems.push(
                    <div key="__mid-promo__" className="cards-grid-promo">
                      <GridPromo />
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
                      viewMode={cardViewMode}
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

          {/* End-of-grid promo — only when there's enough content to make it feel earned */}
          {allEvents.length >= getMidPromoThreshold() && !hasMore && <GridPromo />}

          {/* Infinite scroll sentinel + end-of-list marker.
           * The sentinel is a zero-height div observed by IntersectionObserver.
           * When it enters the prefetch zone we fetch the next page; this
           * effectively replaces the legacy "Load more" button. */}
          {allEvents.length > 0 && (
            <div className="load-more">
              {hasMore ? (
                <>
                  <div ref={sentinelRef} aria-hidden="true" className="load-more-sentinel" />
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

// Column count for the comfortable cards-grid — kept in sync with EventCard.css
function getGridColumns() {
  const w = window.innerWidth
  if (w >= 900) return 3
  if (w >= 600) return 2
  return 1
}

// Inject after ~3 rows — count depends on how many columns are visible
function getMidPromoThreshold() {
  return getGridColumns() * 3
}

function GridPromo() {
  const [copied, setCopied] = useState(false)

  const handleShare = async () => {
    const shareData = {
      title: 'Akron Pulse — Akron Events',
      text: "Check out Akron Pulse — it's where I find everything happening in Akron & Summit County.",
      url: window.location.origin,
    }
    if (navigator.share) {
      try { await navigator.share(shareData) } catch { /* dismissed */ }
    } else {
      try {
        await navigator.clipboard.writeText(window.location.origin)
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      } catch { /* clipboard unavailable */ }
    }
  }

  return (
    <div className="grid-promo">
      <div className="grid-promo-inner">
        {/* Order: Subscribe → Share → Submit. Subscribe owns the leftmost
         * (strongest reading position) since it's our primary engagement
         * driver — owned audience compounds, one-off submissions don't. */}
        <div className="grid-promo-col">
          <span className="grid-promo-icon">✉️</span>
          <div className="grid-promo-text">
            <strong>Never miss an event</strong>
            <p>Get a personalized digest delivered to your inbox.</p>
          </div>
          <Link to="/subscribe" className="grid-promo-btn grid-promo-btn--subscribe">Subscribe →</Link>
        </div>
        <div className="grid-promo-divider" />
        <div className="grid-promo-col">
          <span className="grid-promo-icon">📤</span>
          <div className="grid-promo-text">
            <strong>Know an organizer?</strong>
            <p>The more events on here, the better. Send them the link.</p>
          </div>
          <button className="grid-promo-btn" onClick={handleShare}>
            {copied ? '✓ Link copied!' : 'Share Akron Pulse →'}
          </button>
        </div>
        <div className="grid-promo-divider" />
        <div className="grid-promo-col">
          <span className="grid-promo-icon">📣</span>
          <div className="grid-promo-text">
            <strong>Got an event?</strong>
            <p>Submit it and we'll add it to the grid.</p>
          </div>
          <Link to="/submit" className="grid-promo-btn">Submit an event →</Link>
        </div>
      </div>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  )
}

function LocationIcon() {
  return (
    <svg className="location-jump-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}
