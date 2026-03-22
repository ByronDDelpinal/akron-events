import { useState, useEffect, useMemo, useRef } from 'react'
import { format, isToday, isTomorrow } from 'date-fns'
import { useEvents, PAGE_SIZE } from '@/hooks/useEvents'
import EventCard from '@/components/EventCard'
import FilterBar from '@/components/FilterBar'
import MapView from '@/components/MapView'
import './HomePage.css'

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
  const [categories,  setCategories]  = useState([])
  const [dateRange,   setDateRange]   = useState(null)
  const [dateFrom,    setDateFrom]    = useState(null)
  const [dateTo,      setDateTo]      = useState(null)
  const [freeOnly,    setFreeOnly]    = useState(false)
  const [sort,        setSort]        = useState('soonest')
  const [search,      setSearch]      = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [view,        setView]        = useState('list')

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
  const filterKey = `${categories.join(',')}|${dateRange}|${dateFrom}|${dateTo}|${search}|${freeOnly}|${sort}`
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
    categories, dateRange, dateFrom, dateTo, search, freeOnly, sort,
    limit: PAGE_SIZE,
    offset,
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
    setCategories([])
    setDateRange(null)
    setDateFrom(null)
    setDateTo(null)
    setFreeOnly(false)
    setSearch('')
    setSearchInput('')
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') setSearch(searchInput)
  }

  const loadMore = () => {
    if (!loading && hasMore) setOffset(prev => prev + PAGE_SIZE)
  }

  // ── Stat bar numbers ─────────────────────────────────────────────────
  // `total` is the exact count from Supabase for the current filters.
  // Loaded/weekend/free counts reflect what's actually been fetched so far.
  const loadedCount  = allEvents.length
  const weekendCount = allEvents.filter(e => { const d = new Date(e.start_at).getDay(); return d === 0 || d === 6 }).length

  return (
    <>
      {/* ── HERO ── */}
      <div className="hero">
        <div className="hero-glow" />
        <p className="hero-eyebrow">Summit County, Ohio</p>
        <h1>What's happening<br />in <span>Akron?</span></h1>
        <p className="hero-sub">Concerts, galas, art shows, markets, and more — all in the 330.</p>
        <div className="search-wrap">
          <SearchIcon />
          <input
            className="search-input"
            type="text"
            placeholder="Search events, venues, organizers…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onBlur={() => setSearch(searchInput)}
          />
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
        categories={categories}   onCategories={setCategories}
        dateRange={dateRange}     onDateRange={setDateRange}
        dateFrom={dateFrom}       onDateFrom={setDateFrom}
        dateTo={dateTo}           onDateTo={setDateTo}
        freeOnly={freeOnly}       onFreeOnly={setFreeOnly}
        sort={sort}               onSort={setSort}
        view={view}               onView={setView}
      />

      {/* ── MAP VIEW ── */}
      {view === 'map' && <MapView events={allEvents} />}

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <div className={`content${isRefreshing ? ' content--refreshing' : ''}`}>
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
            return grouped.map(([dateKey, dayEvents]) => (
              <div key={`${resultsKey}-${dateKey}`}>
                <DateHeading dateKey={dateKey} />
                <div className="cards-grid">
                  {dayEvents.map((event, i) => {
                    const delay = cardIdx++ * 28
                    return (
                      <div
                        key={event.id}
                        className="card-enter"
                        style={{ animationDelay: `${delay}ms` }}
                      >
                        <EventCard
                          event={event}
                          featured={event.featured && i === 0}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          })()}

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

function SearchIcon() {
  return (
    <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  )
}
