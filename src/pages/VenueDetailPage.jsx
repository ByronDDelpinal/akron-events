import { useParams, useNavigate, Link } from 'react-router-dom'
import { format, isToday, isTomorrow } from 'date-fns'
import { useVenue, useVenueEvents } from '@/hooks/useEvents'
import { VenueMap } from '@/components/MapView'
import './VenueDetailPage.css'

const PARKING_LABEL = {
  street:  'Street parking',
  lot:     'Parking lot nearby',
  garage:  'Parking garage nearby',
  none:    'No dedicated parking',
  unknown: 'Parking info unavailable',
}

const GRADIENT_MAP = {
  music: 'g-jazz', art: 'g-art', community: 'g-market',
  nonprofit: 'g-gala', food: 'g-market', sports: 'g-run',
  education: 'g-openmic', other: 'g-default',
}
const TAG_CLASS_MAP = {
  music: 'tag-music', art: 'tag-art', nonprofit: 'tag-nonprofit',
  community: 'tag-community', food: 'tag-food', sports: 'tag-fitness',
  education: 'tag-education', other: 'tag-other',
}
const CATEGORY_LABEL = {
  music: 'Music', art: 'Art', nonprofit: 'Non-Profit', community: 'Community',
  food: 'Food & Drink', sports: 'Fitness', education: 'Education', other: 'Other',
}

function formatPrice(min, max) {
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
  const venueTags = venue.tags ?? []
  const venueAreas = venue.areas ?? []
  const venueOrg = venue.organization ?? null

  return (
    <div className="page-venue-detail">

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
                  href={`https://maps.google.com/?q=${encodeURIComponent(
                    [venue.name, venue.address, venue.city, venue.state].filter(Boolean).join(' ')
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="venue-info-link"
                >
                  <PinIcon /> Get directions
                </a>
              </div>

              {/* Map */}
              {hasMap && (
                <div className="venue-map-wrap">
                  <VenueMap lat={venue.lat} lng={venue.lng} venueName={venue.name} />
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
                    {venueTags.map(tag => (
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
                  {venueAreas.map(area => (
                    <div key={area.id} className="venue-area-card">
                      <h3 className="venue-area-name">{area.name}</h3>
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
                {events.map(event => (
                  <VenueEventRow key={event.id} event={event} />
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
function VenueEventRow({ event }) {
  const navigate  = useNavigate()
  const price     = formatPrice(event.price_min, event.price_max)
  const imageUrl  = event.image_url && /^https?:\/\//i.test(event.image_url) ? event.image_url : null
  const gradient  = imageUrl ? null : (GRADIENT_MAP[event.category] ?? 'g-default')
  const tagClass  = TAG_CLASS_MAP[event.category] ?? 'tag-other'
  const catLabel  = CATEGORY_LABEL[event.category] ?? event.category

  return (
    <div
      className="venue-event-row"
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && navigate(`/events/${event.id}`)}
    >
      {/* Thumbnail */}
      <div className="venue-event-thumb">
        {imageUrl
          ? <img src={imageUrl} alt={event.title} className="venue-event-img" referrerPolicy="no-referrer" />
          : <div className={`thumb-fill ${gradient}`} />
        }
      </div>

      {/* Info */}
      <div className="venue-event-info">
        <div className="venue-event-top">
          <span className={`event-tag ${tagClass}`}>{catLabel}</span>
          <span className={`venue-event-price ${price.free ? 'free' : ''}`}>{price.label}</span>
        </div>
        <p className="venue-event-title">{event.title}</p>
        {event.organizer && (
          <p className="venue-event-organizer">{event.organizer.name}</p>
        )}
        <p className="venue-event-date">
          <CalIcon /> {formatDate(event.start_at)}
        </p>
      </div>

      <span className="venue-event-arrow">→</span>
    </div>
  )
}

/* ── Icons ── */
function BackIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
}
function PinIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
}
function GlobeIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
}
function CalIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
}
function OrgIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>
}
