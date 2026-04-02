import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { format, isToday, isTomorrow } from 'date-fns'
import { Link } from 'react-router-dom'
import { useEvents, useMapEvents, PAGE_SIZE } from '@/hooks/useEvents'

const COMPACT_PAGE_SIZE = 48
import EventCard from '@/components/EventCard'
import FilterBar from '@/components/FilterBar'
import MapView from '@/components/MapView'
import ViewModeToggle from '@/components/ViewModeToggle'
import { INTENTS, SEARCH_SUGGESTIONS } from '@/lib/intents'
import './HomePage.css'

// ── localStorage key for persisting card view mode ──
const VIEW_MODE_KEY = 'turnout_card_view_mode'

function getStoredViewMode() {
  try {
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
  const [rawCategories,  setRawCategories]  = useState([])   // from FilterTray only
  const [priceFilter,    setPriceFilter]    = useState(null) // null | 'free' | 'under10' | 'under25'
  const [sort,           setSort]           = useState('soonest')
  const [search,         setSearch]         = useState('')
  const [searchInput,    setSearchInput]    = useState('')
  const [view,           setView]           = useState('list')

  // ── Card view mode (Comfortable / Efficient) ─────────────────────────
  const [cardViewMode, setCardViewMode] = useState(getStoredViewMode)

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
  const filterKey = `${activeIntentId}|${effectiveCategories.join(',')}|${dateRange}|${dateFrom}|${dateTo}|${search}|${effectiveFreeOnly}|${effectivePriceMax}|${sort}|${cardViewMode}`
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
    freeOnly:  effectiveFreeOnly,
    priceMax:  effectivePriceMax,
    sort,
    limit: activePageSize,
    offset,
  })

  // Separate unpaginated fetch for the map — same filters, all results
  const { events: mapEvents, loading: mapLoading, total: mapTotal } = useMapEvents({
    categories: effectiveCategories,
    dateRange, dateFrom, dateTo,
    search,
    freeOnly:  effectiveFreeOnly,
    priceMax:  effectivePriceMax,
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

  const grouped = useMemo(() => groupEventsByDate(allEvents), [allEvents])

  const clearFilters = () => {
    setActiveIntentId(null)
    setRawCategories([])
    setDateRange(null)
    setDateFrom(null)
    setDateTo(null)
    setPriceFilter(null)
    setSort('soonest')
    setSearch('')
    setSearchInput('')
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') setSearch(searchInput)
  }

  const loadMore = () => {
    if (!loading && hasMore) setOffset(prev => prev + activePageSize)
  }

  // ── Stat bar numbers ─────────────────────────────────────────────────
  // `total` is the exact count from Supabase for the current filters.
  // Loaded/weekend/free counts reflect what's actually been fetched so far.
  const loadedCount  = allEvents.length
  const weekendCount = allEvents.filter(e => { const d = new Date(e.start_at).getDay(); return d === 0 || d === 6 }).length

  const isEfficient = cardViewMode === 'efficient'

  return (
    <>
      {/* ── HERO ── */}
      <div className="hero">
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
          <div className="stat-pill">
            <strong>{total}</strong> upcoming {total === 1 ? 'event' : 'events'}
          </div>
          <div className="stat-sep" />
          <div className="stat-pill"><strong>{weekendCount}</strong> this weekend</div>
          <div className="stat-sep" />
          <div className="stat-pill">Updated <strong>today</strong></div>
        </div>
      </div>

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

          {/* ── View mode toggle (right-aligned above grid) ── */}
          {allEvents.length > 0 && (
            <div className="view-mode-row">
              <ViewModeToggle mode={cardViewMode} onChange={handleCardViewMode} />
            </div>
          )}

          {/* Initial load — only show spinner when we have nothing to show yet */}
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
              const items = []
              for (let i = 0; i < dayEvents.length; i++) {
                const event = dayEvents[i]
                // Inject promo into the grid at the exact threshold position (comfortable only)
                if (!isEfficient && !midPromoShown && cardIdx >= midThreshold) {
                  items.push(
                    <div key="__mid-promo__" className="cards-grid-promo">
                      <GridPromo />
                    </div>
                  )
                  midPromoShown = true
                }
                const delay = cardIdx++ * 28
                items.push(
                  <div
                    key={event.id}
                    className="card-enter"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    <EventCard
                      event={event}
                      featured={event.featured && i === 0}
                      viewMode={cardViewMode}
                    />
                  </div>
                )
              }
              return (
                <div key={`${resultsKey}-${dateKey}`}>
                  <DateHeading dateKey={dateKey} />
                  <div className={isEfficient ? 'cards-grid--efficient' : 'cards-grid'}>{items}</div>
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
      title: 'Turnout — Akron Events',
      text: "Check out Turnout — it's where I find everything happening in Akron & Summit County.",
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
        <div className="grid-promo-col">
          <span className="grid-promo-icon">📣</span>
          <div className="grid-promo-text">
            <strong>Got an event?</strong>
            <p>Submit it and we'll add it to the grid.</p>
          </div>
          <Link to="/submit" className="grid-promo-btn">Submit an event →</Link>
        </div>
        <div className="grid-promo-divider" />
        <div className="grid-promo-col">
          <span className="grid-promo-icon">📤</span>
          <div className="grid-promo-text">
            <strong>Know an organizer?</strong>
            <p>The more events on here, the better. Send them the link.</p>
          </div>
          <button className="grid-promo-btn" onClick={handleShare}>
            {copied ? '✓ Link copied!' : 'Share Turnout →'}
          </button>
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
