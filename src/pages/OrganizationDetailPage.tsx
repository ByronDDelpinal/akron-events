import type { LooseRow } from '@/types'
import { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useOrganization } from '@/hooks/useEvents'
import CategoryBadge from '@/components/CategoryBadge'
import {
  SEO,
  buildGraph,
  organizerSchema,
  breadcrumbSchema,
  itemListSchema,
} from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import {
  formatPrice,
  formatEventDate,
  gradientForEvent,
  imageUrlForEvent,
  optimizedImageUrl,
} from '@/lib/eventFormatting'
import './OrganizationDetailPage.css'
import { BackIcon, CalIcon, GlobeIcon, PinIcon, SearchIcon } from '@/components/icons'

type Row = LooseRow

const EVENTS_PAGE_SIZE = 25

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
  const events: Row[] = org.events ?? []
  const venues: Row[] = org.venues ?? []

  // ── SEO: Organization schema + breadcrumb + event list ──────────
  const seoTitle = `Organization: ${org.name} | Events & Programs in Akron, OH`
  const seoDesc = (
    org.description
    || `Upcoming events and programs from ${org.name}, a local organization in Akron, OH.`
  ).replace(/\s+/g, ' ').trim().slice(0, 155)

  const seoGraph = buildGraph(
    organizerSchema(org),
    breadcrumbSchema([
      { name: 'Home',          url: '/' },
      { name: 'Organizations', url: '/organizations' },
      { name: org.name,        url: `/organizations/${org.id}` },
    ]),
    itemListSchema(
      events.slice(0, 25).map((e) => ({
        name: e.title,
        url:  eventPath(e),
      }))
    ),
  )

  return (
    <div className="page-org-detail">

      <SEO
        title={seoTitle}
        description={seoDesc}
        path={`/organizations/${org.id}`}
        image={hasImage ? org.image_url : undefined}
        type="profile"
        jsonLd={seoGraph}
      />
      {/* ── HERO ── */}
      <div className="org-detail-hero">
        <div className="org-detail-hero-inner">
          {hasImage && <img src={optimizedImageUrl(org.image_url ?? null, 960) ?? org.image_url} alt={org.name} className="org-detail-hero-img" referrerPolicy="no-referrer" loading="eager" fetchPriority="high" decoding="async" />}
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
                    {venues.map((v) => (
                      <Link key={v.id} to={`/venues/${v.id}`} className="org-venue-chip">
                        <PinIcon size={12} /> {v.name}
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
            <OrgEventsSection events={events} organizerImageUrl={org.image_url} />
          </div>
        </div>
      </div>
    </div>
  )
}

interface CollapsibleHeaderProps {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  search: string
  onSearchChange: (v: string) => void
  searchPlaceholder: string
}

function CollapsibleHeader({ title, count, open, onToggle, search, onSearchChange, searchPlaceholder }: CollapsibleHeaderProps) {
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
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {search && (
            <button className="org-section-search-clear" onClick={() => onSearchChange('')}>✕</button>
          )}
        </div>
      )}
    </div>
  )
}

function OrgVenuesSection({ venues }: { venues: Row[] }) {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return venues
    return venues.filter((v) =>
      v.name?.toLowerCase().includes(q) ||
      (v.address ?? '').toLowerCase().includes(q) ||
      (v.city ?? '').toLowerCase().includes(q) ||
      (v.tags ?? []).some((t: string) => t.toLowerCase().includes(q))
    )
  }, [venues, search])

  return (
    <div className="org-venues-block">
      <CollapsibleHeader
        title="Venues"
        count={venues.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
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
            {filtered.map((v) => (
              <Link key={v.id} to={`/venues/${v.id}`} className="org-venue-card">
                <div className="org-venue-card-accent" />
                <div className="org-venue-card-body">
                  <h2 className="org-venue-card-name">{v.name}</h2>
                  <p className="org-venue-card-address">
                    {[v.address, v.city, v.state].filter(Boolean).join(', ')}
                  </p>
                  {v.tags?.length > 0 && (
                    <div className="org-venue-card-tags">
                      {v.tags.slice(0, 3).map((tag: string) => (
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

function OrgEventsSection({ events, organizerImageUrl }: { events: Row[]; organizerImageUrl?: string | null }) {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(EVENTS_PAGE_SIZE)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return events
    return events.filter((e) =>
      e.title?.toLowerCase().includes(q) ||
      e.category?.toLowerCase().includes(q) ||
      (e.venue?.name ?? '').toLowerCase().includes(q) ||
      (e.venues ?? []).some((v: Row) => v.name?.toLowerCase().includes(q))
    )
  }, [events, search])

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  // ── Infinite scroll ───────────────────────────────────────────────
  // Data is already client-side; this just reveals more rows on scroll.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + EVENTS_PAGE_SIZE)
        }
      },
      { rootMargin: '0px 0px 1500px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, visibleCount])

  return (
    <div className="org-events-block">
      <CollapsibleHeader
        title="Upcoming Events"
        count={events.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        search={search}
        onSearchChange={(v) => { setSearch(v); setVisibleCount(EVENTS_PAGE_SIZE) }}
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
              {visible.map((event) => (
                <OrgEventRow
                  key={event.id}
                  event={event}
                  organizerImageUrl={organizerImageUrl}
                />
              ))}
            </div>
          )}

          {hasMore && (
            <div
              ref={sentinelRef}
              aria-hidden="true"
              className="org-load-more-sentinel"
            />
          )}
        </>
      )}
    </div>
  )
}

function OrgEventRow({ event, organizerImageUrl }: { event: Row; organizerImageUrl?: string | null }) {
  const navigate = useNavigate()
  const price = formatPrice(event.price_min, event.price_max)
  // Fallback chain: event → venue → organizer (provided by parent).
  const imageUrl = imageUrlForEvent(event, { organizerImageUrl })
  const gradient = imageUrl ? null : gradientForEvent(event)
  const venueName = event.venue?.name ?? event.venues?.[0]?.name

  return (
    <div
      className="org-event-row"
      onClick={() => navigate(eventPath(event))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(eventPath(event))}
    >
      <div className="org-event-thumb">
        {imageUrl
          ? <img src={optimizedImageUrl(imageUrl, 240) ?? imageUrl} alt={event.title} className="org-event-img" referrerPolicy="no-referrer" loading="lazy" decoding="async" />
          : <div className={`thumb-fill ${gradient}`} />
        }
      </div>
      <div className="org-event-info">
        <div className="org-event-top">
          <CategoryBadge category={event.category} />
          <span className={`org-event-price ${price.free ? 'free' : ''}`}>{price.label}</span>
        </div>
        <p className="org-event-title">{event.title}</p>
        {venueName && <p className="org-event-venue"><PinIcon size={12} /> {venueName}</p>}
        <p className="org-event-date"><CalIcon size={12} /> {formatEventDate(event.start_at)}</p>
      </div>
      <span className="org-event-arrow">→</span>
    </div>
  )
}

/* ── Icons ── */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: 'transform 0.2s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}





