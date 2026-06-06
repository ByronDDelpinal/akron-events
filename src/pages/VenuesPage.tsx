import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useVenues } from '@/hooks/useEvents'
import { SEO, buildGraph, itemListSchema, breadcrumbSchema } from '@/lib/seo'
import { PARKING_LABEL } from '@/lib/eventFormatting'
import './VenuesPage.css'

type Row = Record<string, any>

export default function VenuesPage() {
  const { venues, loading, error } = useVenues()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return venues
    return venues.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      (v.city ?? '').toLowerCase().includes(q) ||
      (v.address ?? '').toLowerCase().includes(q)
    )
  }, [venues, search])

  const seoGraph = buildGraph(
    breadcrumbSchema([
      { name: 'Home',   url: '/' },
      { name: 'Venues', url: '/venues' },
    ]),
    itemListSchema(
      (filtered || []).slice(0, 50).map((v) => ({
        name: v.name,
        url:  `/venues/${v.id}`,
      }))
    ),
  )

  return (
    <>
      <SEO
        title="Venues — Event Venues in Akron & Summit County"
        description="A directory of concert halls, gallery spaces, parks, theatres, and more around Akron and Summit County. Browse venues to find where events are happening."
        path="/venues"
        jsonLd={seoGraph}
      />
      {/* ── HERO ── */}
      <div className="venues-hero">
        <div className="venues-hero-inner">
          <p className="venues-hero-eyebrow">Summit County</p>
          <h1 className="venues-hero-title">Where it happens</h1>
          <p className="venues-hero-sub">
            Every venue we track — from concert halls and gallery spaces to parks,
            theatres, and dive bars.
          </p>
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="venues-body">

        {/* ── Search ── */}
        <div className="venues-search-row">
          <div className="venues-search-wrap">
            <SearchIcon />
            <input
              className="venues-search"
              type="text"
              placeholder="Search venues by name, city, or address…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search venues"
            />
            {search && (
              <button className="venues-search-clear" onClick={() => setSearch('')} aria-label="Clear">✕</button>
            )}
          </div>
          {!loading && (
            <p className="venues-count">
              {filtered.length} {filtered.length === 1 ? 'venue' : 'venues'}
            </p>
          )}
        </div>

        {/* ── States ── */}
        {loading && (
          <div className="venues-state">
            <div className="venues-spinner" />
            <p>Loading venues…</p>
          </div>
        )}

        {error && (
          <div className="venues-state venues-error">
            <p>Could not load venues.</p>
            <p className="venues-state-sub">{error}</p>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="venues-state">
            <p>No venues match "{search}"</p>
            <button className="venues-clear-btn" onClick={() => setSearch('')}>Clear search</button>
          </div>
        )}

        {/* ── Grid ── */}
        {!loading && !error && filtered.length > 0 && (
          <div className="venues-grid">
            {filtered.map((venue) => (
              <VenueCard key={venue.id} venue={venue} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function VenueCard({ venue }: { venue: Row }) {
  // Hide the parking row entirely when the type is 'unknown' (less noise here
  // than on the event detail page).
  const parking = venue.parking_type && venue.parking_type !== 'unknown'
    ? PARKING_LABEL[venue.parking_type] ?? null
    : null

  return (
    <Link to={`/venues/${venue.id}`} className="venue-card">
      <div className="venue-card-accent" />
      <div className="venue-card-body">
        <h2 className="venue-card-name">{venue.name}</h2>
        <p className="venue-card-address">
          {[venue.address, venue.city, venue.state].filter(Boolean).join(', ')}
        </p>
        <div className="venue-card-meta">
          {parking && (
            <span className="venue-meta-chip">
              <ParkingIcon /> {parking}
            </span>
          )}
          {venue.website && (
            <span
              className="venue-meta-chip venue-meta-web"
              onClick={(e) => { e.preventDefault(); window.open(venue.website, '_blank', 'noopener') }}
            >
              <GlobeIcon /> Website
            </span>
          )}
        </div>
      </div>
      <span className="venue-card-arrow">→</span>
    </Link>
  )
}

/* ── Icons ── */
function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
  )
}
function ParkingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2"/>
      <path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>
    </svg>
  )
}
function GlobeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  )
}
