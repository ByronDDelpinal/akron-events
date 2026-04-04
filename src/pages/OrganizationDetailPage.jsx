import { useState, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { format, isToday, isTomorrow } from 'date-fns'
import { useOrganization } from '@/hooks/useEvents'
import './OrganizationDetailPage.css'

const EVENTS_PAGE_SIZE = 25

const GRADIENT_MAP = {
  music: 'g-jazz', art: 'g-art', community: 'g-market',
  nonprofit: 'g-gala', food: 'g-market', sports: 'g-sports', fitness: 'g-run',
  education: 'g-openmic', other: 'g-default',
}
const TAG_CLASS_MAP = {
  music: 'tag-music', art: 'tag-art', nonprofit: 'tag-nonprofit',
  community: 'tag-community', food: 'tag-food', sports: 'tag-sports', fitness: 'tag-fitness',
  education: 'tag-education', other: 'tag-other',
}
const CATEGORY_LABEL = {
  music: 'Music', art: 'Art', nonprofit: 'Non-Profit', community: 'Community',
  food: 'Food & Drink', sports: 'Sports', fitness: 'Fitness', education: 'Education', other: 'Other',
}

function formatPrice(min, max) {
  if (min == null && max == null) return { label: 'See tickets', free: false }
  if (min === 0 && (!max || max === 0)) return { label: 'Free', free: true }
  if (max && max > min) return { label: `$${min}–$${max}`, free: false }
  return { label: `$${min}`, free: false }
}

function formatDate(dateStr) {
  const d = new Date(dateStr)
  if (isToday(d))    return `Today · ${format(d, 'h:mm a')}`
  if (isTomorrow(d)) return `Tomorrow · ${format(d, 'h:mm a')}`
  return format(d, 'EEE, MMM d · h:mm a')
}

export default function OrganizationDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { organization, loading, error } = useOrganization(id)

  if (loading) {
    return <div className="org-detail-loading">Loading organization…</div>
  }

  if (error || !organization) {
    return (
      <div className="org-detail-loading">
        <p>Organization not found.</p>
        <Link to="/organizations" className="org-back-link">← Back to organizations</Link>
      </div>
    )
  }

  const org = organization
  const hasImage = org.image_url && /^https?:\/\//i.test(org.image_url)
  const events = org.events ?? []
  const venues = org.venues ?? []

  return (
    <div className="page-org-detail">
      {/* ── HERO ── */}
      <div className="org-detail-hero">
        <div className="org-detail-hero-inner">
          {hasImage && <img src={org.image_url} alt={org.name} className="org-detail-hero-img" referrerPolicy="no-referrer" />}
          {!hasImage && (
            <div className="org-detail-hero-placeholder">
              <span className="org-detail-hero-initial">{org.name?.charAt(0)?.toUpperCase()}</span>
            </div>
          )}
          <div className="org-detail-hero-text">
            {org.status !== 'published' && (
              <span className="org-detail-status-badge">{org.status?.replace('_', ' ')}</span>
            )}
            <h1 className="org-detail-title">{org.name}</h1>
            {(org.city || org.address) && (
              <p className="org-detail-location">
                {[org.address, org.city, org.state].filter(Boolean).join(', ')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="org-detail-content">
        <button className="org-back-btn" onClick={() => navigate('/organizations')}>
          <BackIcon /> All Organizations
        </button>

        <div className="org-detail-layout">
          {/* ── SIDEBAR ── */}
          <aside className="org-detail-sidebar">
            <div className="org-info-card">
              {org.description && (
                <div className="org-info-section">
                  <p className="org-info-label">About</p>
                  <p className="org-info-value">{org.description}</p>
                </div>
              )}

              {org.website && (
                <div className="org-info-section">
                  <p className="org-info-label">Website</p>
                  <a href={org.website} target="_blank" rel="noopener noreferrer" className="org-info-link">
                    <GlobeIcon />
                    {org.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                </div>
              )}

              {(org.city || org.address) && (
                <div className="org-info-section">
                  <p className="org-info-label">Location</p>
                  <p className="org-info-value">
                    {org.address && <>{org.address}<br /></>}
                    {org.city}{org.state ? `, ${org.state}` : ''}{org.zip ? ` ${org.zip}` : ''}
                  </p>
                </div>
              )}

              {venues.length > 0 && (
                <div className="org-info-section">
                  <p className="org-info-label">Venues ({venues.length})</p>
                  <div className="org-sidebar-venues-list">
                    {venues.map(v => (
                      <Link key={v.id} to={`/venues/${v.id}`} className="org-venue-chip">
                        <PinIcon /> {v.name}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </aside>

          {/* ── MAIN ── */}
          <div className="org-detail-main">
            {venues.length > 0 && <OrgVenuesSection venues={venues} />}
            <OrgEventsSection events={events} />
          </div>
        </div>
      </div>
    </div>
  )
}

function CollapsibleHeader({ title, count, open, onToggle, search, onSearchChange, searchPlaceholder }) {
  return (
    <div className="org-collapsible-header">
      <button type="button" className="org-collapse-toggle" onClick={onToggle}>
        <ChevronIcon open={open} />
        <span className="org-section-label-text">{title}</span>
        {count > 0 && <span className="org-section-count">{count}</span>}
      </button>
      {open && count > 2 && (
        <div className="org-section-search-wrap">
          <SearchIcon />
          <input
            className="org-section-search"
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={e => onSearchChange(e.target.value)}
          />
          {search && (
            <button className="org-section-search-clear" onClick={() => onSearchChange('')}>✕</button>
          )}
        </div>
      )}
    </div>
  )
}

function OrgVenuesSection({ venues }) {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return venues
    return venues.filter(v =>
      v.name?.toLowerCase().includes(q) ||
      (v.address ?? '').toLowerCase().includes(q) ||
      (v.city ?? '').toLowerCase().includes(q) ||
      (v.tags ?? []).some(t => t.toLowerCase().includes(q))
    )
  }, [venues, search])

  return (
    <div className="org-venues-block">
      <CollapsibleHeader
        title="Venues"
        count={venues.length}
        open={open}
        onToggle={() => setOpen(o => !o)}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search venues…"
      />
      {open && (
        <>
          {filtered.length === 0 && search && (
            <p className="org-section-no-results">No venues match "{search}"</p>
          )}
          <div className="org-venues-grid">
            {filtered.map(v => (
              <Link key={v.id} to={`/venues/${v.id}`} className="org-venue-card">
                <div className="org-venue-card-accent" />
                <div className="org-venue-card-body">
                  <h3 className="org-venue-card-name">{v.name}</h3>
                  <p className="org-venue-card-address">
                    {[v.address, v.city, v.state].filter(Boolean).join(', ')}
                  </p>
                  {v.tags?.length > 0 && (
                    <div className="org-venue-card-tags">
                      {v.tags.slice(0, 3).map(tag => (
                        <span key={tag} className="org-venue-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="org-venue-card-arrow">→</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function OrgEventsSection({ events }) {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(EVENTS_PAGE_SIZE)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return events
    return events.filter(e =>
      e.title?.toLowerCase().includes(q) ||
      e.category?.toLowerCase().includes(q) ||
      (e.venue?.name ?? '').toLowerCase().includes(q) ||
      (e.venues ?? []).some(v => v.name?.toLowerCase().includes(q))
    )
  }, [events, search])

  // Reset pagination when search changes
  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  return (
    <div className="org-events-block">
      <CollapsibleHeader
        title="Upcoming Events"
        count={events.length}
        open={open}
        onToggle={() => setOpen(o => !o)}
        search={search}
        onSearchChange={v => { setSearch(v); setVisibleCount(EVENTS_PAGE_SIZE) }}
        searchPlaceholder="Search events…"
      />
      {open && (
        <>
          {events.length === 0 && (
            <div className="org-events-empty">
              <p>No upcoming events from this organization.</p>
              <p className="org-events-empty-sub">
                Check back soon, or <Link to="/">browse all events</Link>.
              </p>
            </div>
          )}

          {filtered.length === 0 && search && events.length > 0 && (
            <p className="org-section-no-results">No events match "{search}"</p>
          )}

          {visible.length > 0 && (
            <div className="org-events-list">
              {visible.map(event => (
                <OrgEventRow key={event.id} event={event} />
              ))}
            </div>
          )}

          {hasMore && (
            <button
              className="org-load-more-btn"
              onClick={() => setVisibleCount(c => c + EVENTS_PAGE_SIZE)}
            >
              Show more events ({filtered.length - visibleCount} remaining)
            </button>
          )}
        </>
      )}
    </div>
  )
}

function OrgEventRow({ event }) {
  const navigate = useNavigate()
  const price = formatPrice(event.price_min, event.price_max)
  const imageUrl = event.image_url && /^https?:\/\//i.test(event.image_url) ? event.image_url : null
  const gradient = imageUrl ? null : (GRADIENT_MAP[event.category] ?? 'g-default')
  const tagClass = TAG_CLASS_MAP[event.category] ?? 'tag-other'
  const catLabel = CATEGORY_LABEL[event.category] ?? event.category
  const venueName = event.venue?.name ?? event.venues?.[0]?.name

  return (
    <div
      className="org-event-row"
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && navigate(`/events/${event.id}`)}
    >
      <div className="org-event-thumb">
        {imageUrl
          ? <img src={imageUrl} alt={event.title} className="org-event-img" referrerPolicy="no-referrer" />
          : <div className={`thumb-fill ${gradient}`} />
        }
      </div>
      <div className="org-event-info">
        <div className="org-event-top">
          <span className={`event-tag ${tagClass}`}>{catLabel}</span>
          <span className={`org-event-price ${price.free ? 'free' : ''}`}>{price.label}</span>
        </div>
        <p className="org-event-title">{event.title}</p>
        {venueName && <p className="org-event-venue"><PinIcon /> {venueName}</p>}
        <p className="org-event-date"><CalIcon /> {formatDate(event.start_at)}</p>
      </div>
      <span className="org-event-arrow">→</span>
    </div>
  )
}

/* ── Icons ── */
function ChevronIcon({ open }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function BackIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
}
function GlobeIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
}
function PinIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
}
function CalIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
}
