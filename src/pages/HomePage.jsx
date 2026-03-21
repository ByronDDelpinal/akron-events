import { useState, useMemo } from 'react'
import { format, isToday, isTomorrow } from 'date-fns'
import { useEvents } from '@/hooks/useEvents'
import EventCard from '@/components/EventCard'
import FilterBar from '@/components/FilterBar'
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
  const d = new Date(dateKey + 'T12:00:00') // noon to avoid TZ edge cases
  const label = isToday(d)
    ? format(d, 'EEEE, MMMM d')
    : isTomorrow(d)
    ? format(d, 'EEEE, MMMM d')
    : format(d, 'EEEE, MMMM d')

  return (
    <div className="date-group">
      <div className="date-heading">
        <span className="date-label">{label}</span>
        {isToday(d)    && <span className="today-badge">Today</span>}
        {isTomorrow(d) && <span className="today-badge" style={{ background: 'var(--green-mid)' }}>Tomorrow</span>}
        <div className="date-line" />
      </div>
    </div>
  )
}

export default function HomePage() {
  const [category,  setCategory]  = useState(null)
  const [dateRange, setDateRange] = useState(null)
  const [freeOnly,  setFreeOnly]  = useState(false)
  const [sort,      setSort]      = useState('soonest')
  const [search,    setSearch]    = useState('')
  const [searchInput, setSearchInput] = useState('')

  const { events, loading, error } = useEvents({ category, dateRange, search })

  // Client-side free filter + sort (Supabase already handles category/dateRange/search)
  const filtered = useMemo(() => {
    let list = freeOnly ? events.filter(e => e.price_min === 0 && (!e.price_max || e.price_max === 0)) : events
    if (sort === 'latest')  list = [...list].sort((a,b) => new Date(b.start_at) - new Date(a.start_at))
    if (sort === 'recent')  list = [...list].sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
    return list
  }, [events, freeOnly, sort])

  const grouped    = groupEventsByDate(filtered)
  const totalCount = filtered.length
  const freeCount  = filtered.filter(e => e.price_min === 0 && (!e.price_max || e.price_max === 0)).length
  const weekendCount = filtered.filter(e => {
    const day = new Date(e.start_at).getDay()
    return day === 0 || day === 6
  }).length

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') setSearch(searchInput)
  }

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
          <div className="stat-pill"><strong>{totalCount}</strong> upcoming {totalCount === 1 ? 'event' : 'events'}</div>
          <div className="stat-sep" />
          <div className="stat-pill"><strong>{weekendCount}</strong> this weekend</div>
          <div className="stat-sep" />
          <div className="stat-pill"><strong>{freeCount}</strong> free to attend</div>
          <div className="stat-sep" />
          <div className="stat-pill">Updated <strong>today</strong></div>
        </div>
      </div>

      {/* ── FILTER BAR ── */}
      <FilterBar
        category={category}    onCategory={setCategory}
        dateRange={dateRange}  onDateRange={setDateRange}
        freeOnly={freeOnly}    onFreeOnly={setFreeOnly}
        sort={sort}            onSort={setSort}
      />

      {/* ── EVENTS ── */}
      <div className="content">
        {loading && <div className="empty-state">Loading events…</div>}
        {error   && <div className="empty-state error">Couldn't load events. Please try again.</div>}

        {!loading && !error && filtered.length === 0 && (
          <div className="empty-state">
            <p>No events match your current filters.</p>
            <button className="btn-clear" onClick={() => { setCategory(null); setDateRange(null); setFreeOnly(false); setSearch(''); setSearchInput('') }}>
              Clear filters
            </button>
          </div>
        )}

        {grouped.map(([dateKey, dayEvents]) => (
          <div key={dateKey}>
            <DateHeading dateKey={dateKey} />
            <div className="cards-grid">
              {dayEvents.map((event, i) => (
                <EventCard
                  key={event.id}
                  event={event}
                  featured={event.featured && i === 0}
                />
              ))}
            </div>
          </div>
        ))}

        {!loading && filtered.length > 0 && (
          <div className="load-more">
            <button className="btn-load-more">Load more events</button>
          </div>
        )}
      </div>
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
