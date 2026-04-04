import { useState, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { format } from 'date-fns'
import { useEvent } from '@/hooks/useEvents'
import { VenueMap } from '@/components/MapView'
import './EventPage.css'

// ── Minimum dimensions to consider an image "quality enough" ──
const MIN_IMG_WIDTH  = 600
const MIN_IMG_HEIGHT = 338

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
const AGE_LABEL = {
  all_ages: 'All ages', '18_plus': '18+', '21_plus': '21+',
}
const PARKING_LABEL = {
  street: 'Street parking', lot: 'Parking lot nearby', garage: 'Parking garage nearby',
  none: 'No dedicated parking', unknown: 'Parking info unavailable',
}

function formatPrice(min, max) {
  if (min == null && max == null) return { label: 'See tickets', free: false }
  if (min === 0 && (!max || max === 0)) return { label: 'Free', free: true }
  if (max && max > min) return { label: `$${min}–$${max}`, free: false }
  return { label: `$${min}`, free: false }
}

function isUsableImageUrl(url) {
  return url && /^https?:\/\//i.test(url)
}

function isImageQualityOk(event) {
  if (event.image_width == null || event.image_height == null) return true
  return event.image_width >= MIN_IMG_WIDTH && event.image_height >= MIN_IMG_HEIGHT
}

function buildGoogleCalUrl(event) {
  const start  = new Date(event.start_at).toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
  const end    = event.end_at
    ? new Date(event.end_at).toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
    : start
  const loc    = event.venue ? `${event.venue.name}, ${event.venue.address ?? ''}, ${event.venue.city}, ${event.venue.state}` : ''
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text:   event.title,
    dates:  `${start}/${end}`,
    details: event.description ?? '',
    location: loc,
  })
  return `https://calendar.google.com/calendar/render?${params}`
}

function buildIcsContent(event) {
  const fmt  = (d) => new Date(d).toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
  const loc  = event.venue ? `${event.venue.name}\\, ${event.venue.address ?? ''}\\, ${event.venue.city}` : ''
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Turnout//AkronEvents//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}@turnout.app`,
    `DTSTART:${fmt(event.start_at)}`,
    `DTEND:${event.end_at ? fmt(event.end_at) : fmt(event.start_at)}`,
    `SUMMARY:${event.title}`,
    `DESCRIPTION:${(event.description ?? '').replace(/\n/g,'\\n')}`,
    `LOCATION:${loc}`,
    `URL:${event.ticket_url ?? ''}`,
    'END:VEVENT','END:VCALENDAR',
  ].join('\r\n')
}

function downloadIcs(event) {
  const blob = new Blob([buildIcsContent(event)], { type: 'text/calendar' })
  const a    = document.createElement('a')
  a.href     = URL.createObjectURL(blob)
  a.download = `${event.title.replace(/\s+/g,'-').toLowerCase()}.ics`
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function EventPage() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const { event, loading, error } = useEvent(id)

  if (loading) return <div className="event-loading">Loading event…</div>
  if (error || !event) return (
    <div className="event-loading">
      <p>Event not found.</p>
      <button className="event-back-btn" onClick={() => navigate(-1)}>← Back to events</button>
    </div>
  )

  const price    = formatPrice(event.price_min, event.price_max)
  const tagClass = TAG_CLASS_MAP[event.category] ?? 'tag-other'
  const catLabel = CATEGORY_LABEL[event.category] ?? event.category

  // ── Image quality gating ──
  const rawUrl    = isUsableImageUrl(event.image_url) ? event.image_url : null
  const qualityOk = rawUrl && isImageQualityOk(event)
  const gradient  = GRADIENT_MAP[event.category] ?? 'g-default'

  // Determine if image is wide enough to span full page width (>=1120px content area)
  // If we know dimensions and the image is narrower, use float-left layout
  const isNarrowImage = qualityOk && event.image_width != null && event.image_width < 1120

  return (
    <div className="page-event">

      {/* ── BANNER / IMAGE ── */}
      {qualityOk ? (
        isNarrowImage ? null : (
          <EventBannerImage
            imageUrl={rawUrl}
            event={event}
            tagClass={tagClass}
            catLabel={catLabel}
            gradient={gradient}
          />
        )
      ) : (
        <div className="event-detail-banner">
          <div className={`thumb-fill ${gradient}`} style={{ height: '100%' }} />
          <div className="banner-scrim" />
          <div className="banner-tags">
            {event.featured && <span className="featured-tag">Featured</span>}
            <span className={`event-tag ${tagClass}`}>{catLabel}</span>
          </div>
        </div>
      )}

      {/* ── CONTENT ── */}
      <div className="event-detail-content">
        <button className="event-back-btn" onClick={() => navigate(-1)}>
          <BackIcon /> Back to events
        </button>

        <div className="event-detail-layout">

          {/* ── MAIN COLUMN ── */}
          <div>
            {event.featured && <div className="event-detail-featured">Featured Event</div>}
            <h1 className="event-detail-title">{event.title}</h1>
            {event.organizations?.length > 0 ? (
              <p className="event-detail-organizer">
                Presented by{' '}
                {event.organizations.map((org, i) => (
                  <span key={org.id}>
                    {i > 0 && ', '}
                    <Link to={`/organizations/${org.id}`} className="event-detail-org-link">{org.name}</Link>
                  </span>
                ))}
              </p>
            ) : event.organizer ? (
              <p className="event-detail-organizer">
                Presented by{' '}
                <Link to={`/organizations/${event.organizer.id}`} className="event-detail-org-link">{event.organizer.name}</Link>
              </p>
            ) : null}
            <div className="event-detail-type-row">
              <span className={`event-tag ${tagClass}`}>{catLabel}</span>
              {event.tags?.map(tag => (
                <span key={tag} className="user-tag">{tag}</span>
              ))}
            </div>

            {/* Mobile info (shown below 820px, before the description) */}
            <div className="event-mobile-info">
              <MobileInfoGrid event={event} price={price} />
              <ActionButtons event={event} price={price} />
            </div>

            {/* Narrow image: float left alongside text */}
            {qualityOk && isNarrowImage && (
              <EventFloatImage imageUrl={rawUrl} event={event} />
            )}

            <p className="event-section-label">About this event</p>
            {event.description
              ? <EventDescription text={event.description} />
              : <p className="event-detail-desc">No description available.</p>
            }
          </div>

          {/* ── SIDEBAR ── */}
          <aside className="event-detail-sidebar">
            <div className="info-card">
              <div className={`info-card-price ${price.free ? 'free-price' : ''}`}>
                {price.label}
              </div>
              {event.age_restriction !== 'not_specified' && (
                <p className="info-card-age">
                  {AGE_LABEL[event.age_restriction] ?? ''} · Age restriction applies
                </p>
              )}
              {event.age_restriction === 'not_specified' && (
                <p className="info-card-age">Age info not specified</p>
              )}

              <InfoRow icon={<CalIcon />} label="Date & Time"
                value={format(new Date(event.start_at), 'EEEE, MMMM d, yyyy') +
                  '\n' + format(new Date(event.start_at), 'h:mm a') +
                  (event.end_at ? ' – ' + format(new Date(event.end_at), 'h:mm a') : '')}
              />

              {event.venue && (
                <>
                  <InfoRow icon={<PinIcon />} label="Venue"
                    value={`${event.venue.name}\n${event.venue.address ?? ''}, ${event.venue.city}`}
                    link={`https://maps.google.com/?q=${encodeURIComponent(event.venue.name + ' ' + (event.venue.address ?? '') + ' ' + event.venue.city)}`}
                    linkLabel="Get directions"
                    internalLink={`/venues/${event.venue.id}`}
                    internalLinkLabel="View venue"
                  />
                  <VenueMap
                    lat={event.venue.lat}
                    lng={event.venue.lng}
                    venueName={event.venue.name}
                  />
                </>
              )}

              {event.areas?.length > 0 && (
                <InfoRow icon={<AreaIcon />} label="Area"
                  value={event.areas.map(a => a.name).join(', ')}
                  sub={event.areas[0]?.capacity ? `Capacity: ${event.areas[0].capacity}` : null}
                />
              )}

              {event.venue?.parking_type && event.venue.parking_type !== 'unknown' && (
                <InfoRow icon={<ParkingIcon />} label="Parking"
                  value={PARKING_LABEL[event.venue.parking_type] ?? ''}
                  sub={event.venue.parking_notes}
                />
              )}

              <ActionButtons event={event} price={price} />
            </div>
          </aside>

        </div>
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────── */

/**
 * Full-width banner image that respects native aspect ratio.
 * Uses the actual image_width/image_height from DB when available.
 */
function EventBannerImage({ imageUrl, event, tagClass, catLabel, gradient }) {
  const [imgFailed, setImgFailed] = useState(false)
  const handleError = useCallback(() => setImgFailed(true), [])

  if (imgFailed) {
    // Fall back to gradient banner on load failure
    return (
      <div className="event-detail-banner">
        <div className={`thumb-fill ${gradient}`} style={{ height: '100%' }} />
        <div className="banner-scrim" />
        <div className="banner-tags">
          {event.featured && <span className="featured-tag">Featured</span>}
          <span className={`event-tag ${tagClass}`}>{catLabel}</span>
        </div>
      </div>
    )
  }

  // Use native aspect ratio: let the image determine its own height
  return (
    <div className="event-detail-banner event-detail-banner--native">
      <img
        src={imageUrl}
        alt={event.title}
        className="event-banner-img event-banner-img--native"
        referrerPolicy="no-referrer"
        onError={handleError}
      />
      <div className="banner-scrim" />
      <div className="banner-tags">
        {event.featured && <span className="featured-tag">Featured</span>}
        <span className={`event-tag ${tagClass}`}>{catLabel}</span>
      </div>
    </div>
  )
}

/**
 * Float-left image for narrow images that don't span full width.
 * Text flows around it.
 */
function EventFloatImage({ imageUrl, event }) {
  const [imgFailed, setImgFailed] = useState(false)
  const handleError = useCallback(() => setImgFailed(true), [])

  if (imgFailed) return null

  return (
    <img
      src={imageUrl}
      alt={event.title}
      className="event-float-img"
      referrerPolicy="no-referrer"
      onError={handleError}
    />
  )
}

/**
 * Renders a plain-text description that was produced by htmlToText().
 * Splits on double newlines into paragraphs; paragraphs where every line
 * starts with "• " are rendered as <ul> lists.
 */
function EventDescription({ text }) {
  const blocks = text.split(/\n\n+/).filter(Boolean)
  return (
    <div className="event-detail-desc">
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter(Boolean)
        const isList = lines.length > 1 && lines.every(l => l.trimStart().startsWith('• '))
        if (isList) {
          return (
            <ul key={i} className="event-detail-list">
              {lines.map((l, j) => (
                <li key={j}>{l.trimStart().replace(/^•\s*/, '')}</li>
              ))}
            </ul>
          )
        }
        return <p key={i}>{block}</p>
      })}
    </div>
  )
}

function InfoRow({ icon, label, value, link, linkLabel, sub, internalLink, internalLinkLabel }) {
  return (
    <div className="info-row">
      <div className="info-row-icon">{icon}</div>
      <div>
        <p className="info-row-label">{label}</p>
        <p className="info-row-value" style={{ whiteSpace: 'pre-line' }}>{value}</p>
        {sub   && <p className="info-row-sub">{sub}</p>}
        {link  && <a href={link} target="_blank" rel="noopener noreferrer" className="info-row-link">{linkLabel}</a>}
        {internalLink && <Link to={internalLink} className="info-row-link">{internalLinkLabel}</Link>}
      </div>
    </div>
  )
}

function MobileInfoGrid({ event, price }) {
  return (
    <div className="mobile-info-grid">
      <div className="mobile-info-cell">
        <p className="mobile-info-lbl">Date</p>
        <p className="mobile-info-val">{format(new Date(event.start_at), 'EEE, MMM d')}</p>
      </div>
      <div className="mobile-info-cell">
        <p className="mobile-info-lbl">Time</p>
        <p className="mobile-info-val">{format(new Date(event.start_at), 'h:mm a')}</p>
      </div>
      <div className="mobile-info-cell">
        <p className="mobile-info-lbl">Price</p>
        <p className={`mobile-info-val ${price.free ? '' : 'amber'}`}>{price.label}</p>
      </div>
      <div className="mobile-info-cell">
        <p className="mobile-info-lbl">Ages</p>
        <p className="mobile-info-val">
          {event.age_restriction === 'not_specified' ? 'Not specified' : (AGE_LABEL[event.age_restriction] ?? '')}
        </p>
      </div>
    </div>
  )
}

function ActionButtons({ event, price }) {
  return (
    <>
      {event.ticket_url && (
        <a href={event.ticket_url} target="_blank" rel="noopener noreferrer" className="btn-ticket">
          {price.free ? 'Register — Free' : `Get Tickets — ${price.label}`}
        </a>
      )}
      <a
        href={buildGoogleCalUrl(event)}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-ticket-secondary"
      >
        + Add to Google Calendar
      </a>
      <button
        className="btn-ticket-secondary"
        onClick={() => downloadIcs(event)}
      >
        + Add to Apple / Outlook Calendar
      </button>
    </>
  )
}

/* ── Icons ────────────────────────────────────────── */
function BackIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
}
function CalIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
}
function PinIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
}
function ParkingIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/></svg>
}
function AreaIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="9" x2="9" y1="21" y2="9"/></svg>
}
