import type { LooseRow } from '@/types'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useVenue, useVenueEvents } from '@/hooks/useEvents'
import { VenueMap } from '@/components/MapView'
import CategoryBadge from '@/components/CategoryBadge'
import {
  SEO,
  buildGraph,
  placeSchema,
  breadcrumbSchema,
  itemListSchema,
} from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import {
  formatPrice,
  formatEventDate,
  gradientForEvent,
  PARKING_LABEL,
  imageUrlForEvent,
  optimizedImageUrl,
} from '@/lib/eventFormatting'
import './VenueDetailPage.css'
import { BackIcon, CalIcon, GlobeIcon, OrgIcon, PinIcon } from '@/components/icons'

type Row = LooseRow

export default function VenueDetailPage() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const { venue, loading: venueLoading, error: venueError } = useVenue(id)
  const { events, loading: eventsLoading } = useVenueEvents(id)

  if (venueLoading) {
    return <div className="venue-detail-loading">Loading venue…</div>
  }

  if (venueError || !venue) {
    return (
      <div className="venue-detail-loading">
        <p>Venue not found.</p>
        <Link to="/venues" className="venue-back-btn-link">← Back to venues</Link>
      </div>
    )
  }

  const hasMap = venue.lat && venue.lng
  const parking = PARKING_LABEL[venue.parking_type] ?? null
  const venueTags: string[] = venue.tags ?? []
  const venueAreas: Row[] = venue.areas ?? []
  const venueOrg: Row | null = venue.organization ?? null

  // Shared directions URL — used by the link and the map modal's pin popup.
  const directionsUrl = `https://maps.google.com/?q=${encodeURIComponent(
    [venue.name, venue.address, venue.city, venue.state].filter(Boolean).join(' ')
  )}`

  // ── SEO: Place schema + breadcrumb + list of upcoming events ────
  const seoTitle = `Venue: ${venue.name} | Upcoming Events in ${venue.city || 'Akron'}`
  const seoDesc = (
    venue.description
    || `See upcoming events at ${venue.name} in ${venue.city || 'Akron'}, ${venue.state || 'OH'}. Concerts, community gatherings, and more.`
  ).replace(/\s+/g, ' ').trim().slice(0, 155)

  const seoGraph = buildGraph(
    placeSchema(venue),
    breadcrumbSchema([
      { name: 'Home',   url: '/' },
      { name: 'Venues', url: '/venues' },
      { name: venue.name, url: `/venues/${venue.id}` },
    ]),
    itemListSchema(
      (events || []).slice(0, 25).map((e) => ({
        name: e.title,
        url:  eventPath(e),
      }))
    ),
  )

  return (
    <div className="page-venue-detail">

      <SEO
        title={seoTitle}
        description={seoDesc}
        path={`/venues/${venue.id}`}
        image={venue.image_url || undefined}
        type="place"
        jsonLd={seoGraph}
      />

      {/* ── HERO ── */}
      <div className="venue-detail-hero">
        <div className="venue-detail-hero-inner">
          <p className="venue-detail-eyebrow">
            {[venue.city, venue.state].filter(Boolean).join(', ')}
          </p>
          <h1 className="venue-detail-title">{venue.name}</h1>
          {venue.address && (
            <p className="venue-detail-address">
              {venue.address}{venue.zip ? `, ${venue.zip}` : ''}
            </p>
          )}
          {venue.status && venue.status !== 'published' && (
            <span className="venue-detail-status">{venue.status.replace('_', ' ')}</span>
          )}
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="venue-detail-content">

        <button className="venue-back-btn" onClick={() => navigate('/venues')}>
          <BackIcon /> All Venues
        </button>

        <div className="venue-detail-layout">

          {/* ── SIDEBAR (venue info) ── */}
          <aside className="venue-detail-sidebar">
            <div className="venue-info-card">

              {/* Address block */}
              <div className="venue-info-section">
                <p className="venue-info-label">Address</p>
                <p className="venue-info-value">
                  {venue.address && <>{venue.address}<br /></>}
                  {venue.city}{venue.state ? `, ${venue.state}` : ''}{venue.zip ? ` ${venue.zip}` : ''}
                </p>
                <a
                  href={directionsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="venue-info-link"
                >
                  <PinIcon size={13} /> Get directions
                </a>
              </div>

              {/* Map */}
              {hasMap && (
                <div className="venue-map-wrap">
                  <VenueMap
                    lat={venue.lat}
                    lng={venue.lng}
                    venueName={venue.name}
                    venueAddress={[
                      venue.address,
                      [venue.city, venue.state].filter(Boolean).join(', '),
                      venue.zip,
                    ].filter(Boolean).join('\n')}
                    directionsUrl={directionsUrl}
                  />
                </div>
              )}

              {/* Parking */}
              {parking && venue.parking_type !== 'unknown' && (
                <div className="venue-info-section">
                  <p className="venue-info-label">Parking</p>
                  <p className="venue-info-value">{parking}</p>
                  {venue.parking_notes && (
                    <p className="venue-info-sub">{venue.parking_notes}</p>
                  )}
                </div>
              )}

              {/* Website */}
              {venue.website && (
                <div className="venue-info-section">
                  <p className="venue-info-label">Website</p>
                  <a
                    href={venue.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="venue-info-link"
                  >
                    <GlobeIcon />
                    {venue.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                </div>
              )}

              {/* Organization */}
              {venueOrg && (
                <div className="venue-info-section">
                  <p className="venue-info-label">Organization</p>
                  <Link to={`/organizations/${venueOrg.id}`} className="venue-info-link">
                    <OrgIcon />
                    {venueOrg.name}
                  </Link>
                </div>
              )}

              {/* Tags */}
              {venueTags.length > 0 && (
                <div className="venue-info-section">
                  <p className="venue-info-label">Tags</p>
                  <div className="venue-tag-list">
                    {venueTags.map((tag) => (
                      <span key={tag} className="venue-tag-chip">{tag}</span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </aside>

          {/* ── MAIN (description, areas, events) ── */}
          <div className="venue-detail-main">
            {/* Description */}
            {venue.description && (
              <div className="venue-description-block">
                <p className="venue-section-label">About</p>
                <p className="venue-description-text">{venue.description}</p>
              </div>
            )}

            {/* Areas */}
            {venueAreas.length > 0 && (
              <div className="venue-areas-block">
                <p className="venue-section-label">Spaces &amp; Areas</p>
                <div className="venue-areas-grid">
                  {venueAreas.map((area) => (
                    <div key={area.id} className="venue-area-card">
                      <h2 className="venue-area-name">{area.name}</h2>
                      {area.description && <p className="venue-area-desc">{area.description}</p>}
                      {area.capacity && <p className="venue-area-cap">Capacity: {area.capacity}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="venue-section-label">Upcoming Events</p>

            {eventsLoading && (
              <div className="venue-events-state">
                <div className="venue-spinner" />
                <p>Loading events…</p>
              </div>
            )}

            {!eventsLoading && events.length === 0 && (
              <div className="venue-events-empty">
                <p>No upcoming events listed for this venue.</p>
                <p className="venue-events-empty-sub">
                  Check back soon, or{' '}
                  <Link to="/">browse all events</Link> to see what's happening.
                </p>
              </div>
            )}

            {!eventsLoading && events.length > 0 && (
              <div className="venue-events-list">
                {events.map((event) => (
                  <VenueEventRow
                    key={event.id}
                    event={event}
                    venueImageUrl={venue.image_url}
                  />
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}

/* ── Event row component ── */
function VenueEventRow({ event, venueImageUrl }: { event: Row; venueImageUrl?: string | null }) {
  const navigate  = useNavigate()
  const price    = formatPrice(event.price_min, event.price_max)
  // Fallback chain: event → venue (provided by parent) → organizer.
  const imageUrl = imageUrlForEvent(event, { venueImageUrl })
  const gradient = imageUrl ? null : gradientForEvent(event)

  return (
    <div
      className="venue-event-row"
      onClick={() => navigate(eventPath(event))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(eventPath(event))}
    >
      {/* Thumbnail */}
      <div className="venue-event-thumb">
        {imageUrl
          ? <img src={optimizedImageUrl(imageUrl, 240) ?? imageUrl} alt={event.title} className="venue-event-img" referrerPolicy="no-referrer" loading="lazy" decoding="async" />
          : <div className={`thumb-fill ${gradient}`} />
        }
      </div>

      {/* Info */}
      <div className="venue-event-info">
        <div className="venue-event-top">
          <CategoryBadge category={event.category} />
          <span className={`venue-event-price ${price.free ? 'free' : ''}`}>{price.label}</span>
        </div>
        <p className="venue-event-title">{event.title}</p>
        {event.organizer && (
          <p className="venue-event-organizer">{event.organizer.name}</p>
        )}
        <p className="venue-event-date">
          <CalIcon size={12} /> {formatEventDate(event.start_at)}
        </p>
      </div>

      <span className="venue-event-arrow">→</span>
    </div>
  )
}

/* ── Icons ── */





