import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
import { format, isToday, isTomorrow } from 'date-fns'
import { Link, useSearchParams } from 'react-router-dom'
import { useEvents, useMapEvents, PAGE_SIZE } from '@/hooks/useEvents'
import { supabase } from '@/lib/supabase'

const COMPACT_PAGE_SIZE = 48
import EventCard from '@/components/EventCard'
import FilterBar from '@/components/FilterBar'
import MapView from '@/components/MapView'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import { INTENTS, SEARCH_SUGGESTIONS } from '@/lib/intents'
import { SEO } from '@/lib/seo'
import './HomePage.css'

// ── Source overflow cap ───────────────────────────────────────────────────────
// Per-source limit before an overflow card is injected. Events beyond this
// count are hidden until the user clicks the overflow card to expand them.
const SOURCE_CAP = 3

/**
 * applySourceCap(dayEvents, expandedSources, dateKey)
 *
 * Takes a flat, time-sorted array of events for one day and returns a mixed
 * array of items that the grid should render:
 *
 *   { type: 'event',    event, isRevealed }
 *   { type: 'overflow', source, dateKey, hiddenCount, isExpanded }
 *
 * Algorithm:
 *  - Count events per source as we walk the list.
 *  - When a source hits SOURCE_CAP+1, inject an overflow card *at that position*
 *    (the card stays here forever — its grid slot never shifts).
 *  - Subsequent events from that source are hidden unless expanded.
 *  - Expanded sources show their hidden events immediately after the overflow
 *    card, interleaved in correct time order.
 */
function applySourceCap(dayEvents, expandedSources, dateKey) {
  // sourceCounts: how many events we've emitted (not including overflow card) per source
  const sourceCounts    = {}
  // overflowEmitted: have we already emitted the overflow card for this source?
  const overflowEmitted = {}
  // hiddenEvents: buffer of events suppressed per source (needed for total count)
  const hiddenCounts    = {}

  // First pass — collect how many events each source has beyond the cap so
  // we know the overflow card label before we emit it.
  const sourceTotal = {}
  for (const ev of dayEvents) {
    const src = ev.source ?? 'unknown'
    sourceTotal[src] = (sourceTotal[src] ?? 0) + 1
  }

  const items = []

  for (const ev of dayEvents) {
    const src        = ev.source ?? 'unknown'
    const count      = sourceCounts[src] ?? 0
    const isExpanded = expandedSources.has(`${dateKey}-${src}`)
    const total      = sourceTotal[src]

    if (count < SOURCE_CAP) {
      // Always show events within the cap
      items.push({ type: 'event', event: ev, isRevealed: false })
      sourceCounts[src] = count + 1
    } else {
      // This source has hit the cap
      if (!overflowEmitted[src]) {
        // Emit the overflow card at this exact position (will never move)
        const hiddenCount = total - SOURCE_CAP
        items.push({
          type: 'overflow',
          source: src,
          dateKey,
          hiddenCount,
          isExpanded,
        })
        overflowEmitted[src] = true
        hiddenCounts[src]    = hiddenCount
      }

      // Only show the event if this source is expanded
      if (isExpanded) {
        items.push({ type: 'event', event: ev, isRevealed: true })
      }
      // (if not expanded, event is simply omitted from the item list)
    }
  }

  return items
}

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

function groupEventsByDate(events) {
  const groups = {}
  events.forEach((event) => {
    const key = format(new Date(event.start_at), 'yyyy-MM-dd')
    if (!groups[key]) groups[key] = []
    groups[key].push(event)
  })
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
}

function DateHeading({ dateKey }) {
  const d = new Date(dateKey + 'T12:00:00')
  return (
    <div className="date-group">
      <div className="date-heading">
        <span className="date-label">{format(d, 'EEEE, MMMM d')}</span>
        {isToday(d)    && <span className="today-badge">Today</span>}
        {isTomorrow(d) && <span className="today-badge" style={{ background: 'var(--green-mid)' }}>Tomorrow</span>}
        <div className="date-line" />
      </div>
    </div>
  )
}

export default function HomePage() {
  // ── Filter state ──────────────────────────────────────────────────────
  const [activeIntentId, setActiveIntentId] = useState(null)  // 'date-night' | 'give-back' | etc.
  const [dateRange,      setDateRange]      = useState(null)  // 'today' | 'this_weekend' | 'this_week' | 'this_month' | null
  const [dateFrom,       setDateFrom]       = useState(null)  // custom 'YYYY-MM-DD'
  const [dateTo,         setDateTo]         = useState(null)  // custom 'YYYY-MM-DD'
  // ── Category filter is URL-backed ─────────────────────────────────────
  // Drives the FilterTray category chips AND lets external links land
  // pre-filtered (e.g. "/?categories=music" from the related-events
  // block, or the About-page persona links). The URL is the single
  // source of truth — setRawCategories rewrites the query string and
  // the next render re-derives the array.
  const [searchParams, setSearchParams] = useSearchParams()
  const rawCategories = useMemo(() => {
    const raw = searchParams.get('categories') || ''
    return raw.split(',').map((c) => c.trim()).filter(Boolean)
  }, [searchParams])

  const setRawCategories = useCallback((next) => {
    const arr = Array.isArray(next) ? next : []
    const params = new URLSearchParams(searchParams)
    if (arr.length > 0) params.set('categories', arr.join(','))
    else params.delete('categories')
    // replace, not push — filter toggles shouldn't clutter back-history.
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  const [hiddenSources,  setHiddenSources]  = useState([])   // source strings to exclude
  const [priceFilter,    setPriceFilter]    = useState(null) // null | 'free' | 'under10' | 'under25'
  const [sort,           setSort]           = useState('soonest')

  // ── Search is URL-backed so it survives back-navigation and can be shared ─
  // `search` is the committed query (derived from ?q=); `searchInput` is the
  // local draft that lives in the <input> until the user presses Enter.
  const search = useMemo(() => searchParams.get('q') || '', [searchParams])
  const [searchInput, setSearchInput] = useState(() => searchParams.get('q') || '')

  // Commits the search draft to the URL (?q=). Preserves other params (e.g.
  // categories). Uses replace so rapid typing doesn't pollute back-history.
  const setSearch = useCallback((value) => {
    const params = new URLSearchParams(searchParams)
    if (value) params.set('q', value)
    else params.delete('q')
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

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
  // Tray raw categories narrow; if empty, fall back to intent's categories
  const effectiveCategories = rawCategories.length > 0
    ? rawCategories
    : (activeIntent?.freeOnly ? [] : (activeIntent?.categories ?? []))
  // freeOnly is true when intent is Free Fun, OR tray price is 'free'
  const effectiveFreeOnly = (activeIntent?.freeOnly ?? false) || priceFilter === 'free'
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
  const filterKey = `${activeIntentId}|${effectiveCategories.join(',')}|${dateRange}|${dateFrom}|${dateTo}|${search}|${effectiveFreeOnly}|${effectivePriceMax}|${hiddenSources.join(',')}|${sort}|${cardViewMode}`
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
    dateRange, dateFrom, dateTo,
    search,
    freeOnly:      effectiveFreeOnly,
    priceMax:      effectivePriceMax,
    hiddenSources,
    sort,
    limit: activePageSize,
    offset,
  })

  // Separate unpaginated fetch for the map — same filters, all results
  const { events: mapEvents, loading: mapLoading, total: mapTotal } = useMapEvents({
    categories: effectiveCategories,
    dateRange, dateFrom, dateTo,
    search,
    freeOnly:      effectiveFreeOnly,
    priceMax:      effectivePriceMax,
    hiddenSources,
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
    setActiveIntentId(null)
    setDateRange(null)
    setDateFrom(null)
    setDateTo(null)
    setPriceFilter(null)
    setHiddenSources([])
    setSort('soonest')
    setSearchInput('')
    // Wipe all URL params (clears both ?q= and ?categories= in one replace).
    setSearchParams({}, { replace: true })
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') setSearch(searchInput)
  }

  const loadMore = () => {
    if (!loading && hasMore) setOffset(prev => prev + activePageSize)
  }

  // `loadedCount` is used by the "Load more" button below to show
  // how many results are still un-fetched relative to `total`.
  const loadedCount = allEvents.length

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

  return (
    <>
      <SEO
        titleExact
        title="Akron Events — Concerts, Art Shows, Markets & More | Akron Pulse"
        description="Discover events happening in Akron, Ohio and Summit County. Browse concerts, art shows, community gatherings, fundraisers, farmers markets, and more — updated daily."
        path="/"
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
      {lastUpdated && (
        <div className="stat-bar">
          <div className="stat-bar-inner">
            <div className="stat-pill">Updated <strong>{lastUpdated}</strong></div>
          </div>
        </div>
      )}

      {/* ── FILTER BAR ── */}
      <FilterBar
        activeIntentId={activeIntentId}  onIntentId={setActiveIntentId}
        dateRange={dateRange}            onDateRange={setDateRange}
        dateFrom={dateFrom}              onDateFrom={setDateFrom}
        dateTo={dateTo}                  onDateTo={setDateTo}
        rawCategories={rawCategories}    onRawCategories={setRawCategories}
        hiddenSources={hiddenSources}    onHiddenSources={setHiddenSources}
        priceFilter={priceFilter}        onPriceFilter={setPriceFilter}
        sort={sort}                      onSort={setSort}
        view={view}                      onView={setView}
        total={total}
        cardViewMode={cardViewMode}      onCardViewMode={handleCardViewMode}
      />

      {/* ── MAP VIEW ── */}
      {view === 'map' && (
        mapLoading
          ? <div className="map-loading"><span>Loading map data…</span></div>
          : <MapView events={mapEvents} />
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

                // Inject mid-grid promo at threshold (comfortable only)
                if (!isEfficient && !midPromoShown && cardIdx >= midThreshold) {
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

          {/* Load more */}
          {allEvents.length > 0 && (
            <div className="load-more">
              {hasMore ? (
                <button
                  className="btn-load-more"
                  onClick={loadMore}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : `Load more events (${total - loadedCount} remaining)`}
                </button>
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

// Inject after ~3 rows — count depends on how many columns are visible
function getMidPromoThreshold() {
  const w = window.innerWidth
  if (w >= 900) return 9  // 3 cols × 3 rows
  if (w >= 600) return 6  // 2 cols × 3 rows
  return 3                // 1 col × 3 rows
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
