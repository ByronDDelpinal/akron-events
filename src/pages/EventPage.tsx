import type { LooseRow } from '@/types'
import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { format } from 'date-fns'
import { useEvent, type AppEvent } from '@/hooks/useEvents'
import { useEmbed } from '@/hooks/useEmbed'
import { embedEventPath } from '@/lib/embedConfig'
import { VenueMap } from '@/components/MapView'
import { CategoryBadges, FacetBadges } from '@/components/CategoryBadge'
import RelatedEvents from '@/components/RelatedEvents'
import ShareButtons from '@/components/ShareButtons'
import NewsletterCTA from '@/components/NewsletterCTA'
import {
  SEO,
  buildGraph,
  eventSchema,
  breadcrumbSchema,
  eventTitle,
  eventDescription,
} from '@/lib/seo'
import { makeEventSlug, eventPath } from '@/lib/slug'
import { recordEventView } from '@/lib/engagement'
import {
  formatPrice,
  gradientForEvent,
  AGE_LABEL,
  PARKING_LABEL,
  resolveEventImage,
  optimizedImageUrl,
  type PriceDisplay,
} from '@/lib/eventFormatting'
import './EventPage.css'
import { BackIcon, CalIcon, ParkingIcon, PinIcon } from '@/components/icons'

// Banner needs to span the page content area; sub-1120 images become thumbnails.
const BANNER_MIN_WIDTH = 1120

function buildGoogleCalUrl(event: AppEvent): string {
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

function buildIcsContent(event: AppEvent): string {
  const fmt  = (d: string) => new Date(d).toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
  const loc  = event.venue ? `${event.venue.name}\\, ${event.venue.address ?? ''}\\, ${event.venue.city}` : ''
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Akron Pulse//AkronEvents//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}@akronpulse.com`,
    `DTSTART:${fmt(event.start_at)}`,
    `DTEND:${event.end_at ? fmt(event.end_at) : fmt(event.start_at)}`,
    `SUMMARY:${event.title}`,
    `DESCRIPTION:${(event.description ?? '').replace(/\n/g,'\\n')}`,
    `LOCATION:${loc}`,
    `URL:${event.ticket_url ?? ''}`,
    'END:VEVENT','END:VCALENDAR',
  ].join('\r\n')
}

function downloadIcs(event: AppEvent): void {
  const blob = new Blob([buildIcsContent(event)], { type: 'text/calendar' })
  const a    = document.createElement('a')
  a.href     = URL.createObjectURL(blob)
  a.download = `${event.title.replace(/\s+/g,'-').toLowerCase()}.ics`
  a.click()
  URL.revokeObjectURL(a.href)
}

export default function EventPage() {
  const { id, slug } = useParams()
  const navigate     = useNavigate()
  const location     = useLocation()
  const embed        = useEmbed()
  const { event, loading, error } = useEvent(id)

  // "Back to events" — in the embed, go explicitly to the grid (carrying the
  // embed config); on the site, plain history back is right.
  const backToList = useCallback(() => {
    if (embed) navigate(`/embed${location.search}`)
    else navigate(-1)
  }, [embed, navigate, location.search])

  // Count engaged event-detail views as a PWA-install intent signal. Site
  // only — embeds are partner iframes, not install candidates — and deduped
  // per session inside recordEventView so the canonical redirect below
  // doesn't double-count.
  useEffect(() => {
    if (embed || !event || event.id !== id) return
    recordEventView(event.id)
  }, [embed, event, id])

  // Canonicalize the URL to /events/{slug}/{id}. The `event.id === id` guard
  // prevents rewriting to a stale event while a new one is still fetching.
  useEffect(() => {
    if (!event || event.id !== id) return
    const canonicalSlug = makeEventSlug(event)
    if (slug !== canonicalSlug) {
      const dest = embed
        ? embedEventPath(eventPath(event), location.search)
        : eventPath(event)
      navigate(dest, { replace: true })
    }
  }, [event, id, slug, navigate, embed, location.search])

  if (loading) return <div className="event-loading">Loading event…</div>
  if (error || !event) return (
    <div className="event-loading">
      <p>Event not found.</p>
      <button className="event-back-btn" onClick={backToList}>← Back to events</button>
    </div>
  )

  const price = formatPrice(event.price_min, event.price_max)

  const venueDirectionsUrl = event.venue
    ? `https://maps.google.com/?q=${encodeURIComponent(
        [event.venue.name, event.venue.address, event.venue.city]
          .filter(Boolean).join(' ')
      )}`
    : null

  // ── Image routing ──
  const { url: rawUrl, source: imageSource } = resolveEventImage(event)
  const gradient = gradientForEvent(event)

  const showBanner = !!rawUrl
    && imageSource === 'event'
    && event.banner_eligible
    && event.image_width != null
    && event.image_width >= BANNER_MIN_WIDTH

  const showFloat = !!rawUrl && !showBanner

  // ── Build SEO metadata for this event ────────────────────────────
  const seoTitle = eventTitle(event)
  const seoDesc  = eventDescription(event)
  const seoImage = `/api/og/event/${event.id}`

  const canonicalPath = eventPath(event)
  const seoGraph = buildGraph(
    eventSchema(event),
    breadcrumbSchema([
      { name: 'Home',   url: '/' },
      { name: 'Events', url: '/' },
      { name: event.title, url: canonicalPath },
    ]),
  )

  return (
    <div className="page-event">

      <SEO
        title={seoTitle}
        description={seoDesc}
        path={canonicalPath}
        image={seoImage}
        type="event"
        jsonLd={seoGraph}
      />

      {/* ── BANNER / IMAGE ── */}
      {showBanner && rawUrl ? (
        <EventBannerImage
          imageUrl={rawUrl}
          event={event}
          gradient={gradient}
        />
      ) : (
        <div className={`event-detail-accent ${gradient}`} aria-hidden="true" />
      )}

      {/* ── CONTENT ── */}
      <div className="event-detail-content">
        <button className="event-back-btn" onClick={backToList}>
          <BackIcon /> Back to events
        </button>

        <div className="event-detail-layout">

          {/* ── MAIN COLUMN ── */}
          <div>
            {event.featured && <div className="event-detail-featured">Featured Event</div>}
            {/* Category/facet badges sit inline with the title. Raw source tags
                (event.tags) are intentionally not displayed — they're low-value
                source-internal labels ("partner event", …); still stored on
                intake (they feed search) and available if we surface them later. */}
            <div className="event-detail-title-row">
              <h1 className="event-detail-title">{event.title}</h1>
              <CategoryBadges event={event} />
              <FacetBadges event={event} />
            </div>
            {event.organizations?.length > 0 ? (
              <p className="event-detail-organizer">
                Presented by{' '}
                {event.organizations.map((org: LooseRow, i: number) => (
                  <span key={org.id}>
                    {i > 0 && ', '}
                    {embed
                      ? <span className="event-detail-org-link">{org.name}</span>
                      : <Link to={`/organizations/${org.id}`} className="event-detail-org-link">{org.name}</Link>}
                  </span>
                ))}
              </p>
            ) : event.organizer ? (
              <p className="event-detail-organizer">
                Presented by{' '}
                {embed
                  ? <span className="event-detail-org-link">{event.organizer.name}</span>
                  : <Link to={`/organizations/${event.organizer.id}`} className="event-detail-org-link">{event.organizer.name}</Link>}
              </p>
            ) : null}

            {/* Share row */}
            <div className="event-detail-share">
              <ShareButtons
                url={canonicalPath}
                title={event.title}
                text={seoDesc}
                campaign="event_detail"
              />
            </div>

            {/* Mobile info (shown below 820px, before the description). */}
            <div className="event-mobile-info">
              <MobileInfoGrid event={event} price={price} />
              {event.venue && (
                <div className="mobile-venue-card">
                  <InfoRow icon={<PinIcon />} label="Venue"
                    value={`${event.venue.name}\n${event.venue.address ?? ''}, ${event.venue.city}`}
                    link={venueDirectionsUrl}
                    linkLabel="Get directions"
                    internalLink={embed ? null : `/venues/${event.venue.id}`}
                    internalLinkLabel="View venue"
                  />
                  <VenueMap
                    lat={event.venue.lat}
                    lng={event.venue.lng}
                    venueName={event.venue.name}
                    venueAddress={[event.venue.address, event.venue.city]
                      .filter(Boolean).join(', ')}
                    directionsUrl={venueDirectionsUrl}
                  />
                </div>
              )}
              <ActionButtons event={event} price={price} />
            </div>

            <p className="event-section-label">About this event</p>

            {showFloat && rawUrl && (
              <EventFloatImage imageUrl={rawUrl} event={event} />
            )}

            {event.description
              ? <EventDescription text={event.description} />
              : <p className="event-detail-desc">No description available.</p>
            }

            {/* Subscribe CTA is omitted in the embed (white-label rule). */}
            {!embed && <NewsletterCTA variant="event" surface="event_detail" />}
          </div>

          {/* ── SIDEBAR ── */}
          <aside className="event-detail-sidebar">
            <div className="info-card">
              <div className={`info-card-price ${price.free ? 'free-price' : ''}`}>
                {price.label}
              </div>
              {event.age_restriction !== 'not_specified' && (
                <p className="info-card-age">
                  {AGE_LABEL[event.age_restriction ?? ''] ?? ''} · Age restriction applies
                </p>
              )}
              {event.age_restriction === 'not_specified' && (
                <p className="info-card-age">Age info not specified</p>
              )}

              <InfoRow icon={<CalIcon size={16} />} label="Date & Time"
                value={format(new Date(event.start_at), 'EEEE, MMMM d, yyyy') +
                  '\n' + format(new Date(event.start_at), 'h:mm a') +
                  (event.end_at ? ' – ' + format(new Date(event.end_at), 'h:mm a') : '')}
              />

              {event.venue && (
                <>
                  <InfoRow icon={<PinIcon />} label="Venue"
                    value={`${event.venue.name}\n${event.venue.address ?? ''}, ${event.venue.city}`}
                    link={venueDirectionsUrl}
                    linkLabel="Get directions"
                    internalLink={embed ? null : `/venues/${event.venue.id}`}
                    internalLinkLabel="View venue"
                  />
                  <VenueMap
                    lat={event.venue.lat}
                    lng={event.venue.lng}
                    venueName={event.venue.name}
                    venueAddress={[event.venue.address, event.venue.city]
                      .filter(Boolean).join(', ')}
                    directionsUrl={venueDirectionsUrl}
                  />
                </>
              )}

              {(event.areas?.length ?? 0) > 0 && (
                <InfoRow icon={<AreaIcon />} label="Area"
                  value={event.areas!.map((a: LooseRow) => a.name).join(', ')}
                  sub={event.areas![0]?.capacity ? `Capacity: ${event.areas![0].capacity}` : null}
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

        {/* "More events" is omitted in the embed (white-label rule). */}
        {!embed && <RelatedEvents currentEvent={event} />}
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────── */

interface BannerProps {
  imageUrl: string
  event: AppEvent
  gradient: string
}

function EventBannerImage({ imageUrl, event, gradient }: BannerProps) {
  const [imgFailed, setImgFailed] = useState(false)
  const handleError = useCallback(() => setImgFailed(true), [])

  if (imgFailed) {
    return <div className={`event-detail-accent ${gradient}`} aria-hidden="true" />
  }

  return (
    <div className="event-detail-banner event-detail-banner--native">
      <img
        src={optimizedImageUrl(imageUrl, 960) ?? imageUrl}
        alt={event.title}
        className="event-banner-img event-banner-img--native"
        referrerPolicy="no-referrer"
        onError={handleError}
        width={event.image_width || undefined}
        height={event.image_height || undefined}
        loading="eager"
        fetchPriority="high"
        decoding="async"
      />
      <div className="banner-scrim" />
      <div className="banner-tags">
        {event.featured && <span className="featured-tag">Featured</span>}
        <CategoryBadges event={event} />
      </div>
    </div>
  )
}

function EventFloatImage({ imageUrl, event }: { imageUrl: string; event: AppEvent }) {
  const [imgFailed, setImgFailed] = useState(false)
  const handleError = useCallback(() => setImgFailed(true), [])

  if (imgFailed) return null

  return (
    <img
      src={optimizedImageUrl(imageUrl, 960) ?? imageUrl}
      alt={event.title}
      className="event-float-img"
      referrerPolicy="no-referrer"
      onError={handleError}
      width={event.image_width || undefined}
      height={event.image_height || undefined}
      loading="lazy"
      decoding="async"
    />
  )
}

/**
 * Renders a plain-text description (produced by htmlToText). Splits on double
 * newlines into paragraphs; bullet paragraphs become <ul> lists.
 *
 * Also handles the Ticketmaster/plain-text convention of ALL-CAPS section
 * headers embedded inline (e.g. "…sentence. SECTION TITLE Next sentence…").
 * These are detected and converted to paragraph breaks so the text doesn't
 * render as a single wall of text.
 */
function EventDescription({ text }: { text: string }) {
  // Normalize ALL-CAPS section headers to paragraph boundaries.
  // Pattern: a sentence-ending char (or start-of-string) followed by an
  // ALL-CAPS phrase (1–4 words of 2+ uppercase letters each) followed by
  // the start of a new mixed-case sentence. We insert \n\n before the header
  // and \n\n after so the header becomes its own short paragraph.
  const normalized = text
    .replace(
      /(^|[.!?"])\s+([A-Z]{2}[A-Z ]{0,40}[A-Z])\s+(?=[A-Z][a-z])/g,
      (_, punct, header) => `${punct}\n\n${header}\n\n`,
    )
    // Also handle a header at the very start of the string with no prior punct
    .replace(/^([A-Z]{2}[A-Z ]{0,40}[A-Z])\s+(?=[A-Z][a-z])/, '$1\n\n')

  const blocks = normalized.split(/\n\n+/).filter(Boolean)
  return (
    <div className="event-detail-desc">
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter(Boolean)
        const isList = lines.length > 1 && lines.every((l) => l.trimStart().startsWith('• '))
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

interface InfoRowProps {
  icon: ReactNode
  label: string
  value: ReactNode
  link?: string | null
  linkLabel?: string
  sub?: ReactNode
  internalLink?: string | null
  internalLinkLabel?: string
}

function InfoRow({ icon, label, value, link, linkLabel, sub, internalLink, internalLinkLabel }: InfoRowProps) {
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

function MobileInfoGrid({ event, price }: { event: AppEvent; price: PriceDisplay }) {
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
          {event.age_restriction === 'not_specified' ? 'Not specified' : (AGE_LABEL[event.age_restriction ?? ''] ?? '')}
        </p>
      </div>
    </div>
  )
}

// Only http(s) absolute URLs are safe to render as outbound links.
function firstAbsoluteUrl(...urls: Array<string | null | undefined>): string | null {
  for (const u of urls) {
    if (u && /^https?:\/\//i.test(u)) return u
  }
  return null
}

function ActionButtons({ event, price }: { event: AppEvent; price: PriceDisplay }) {
  // CTA chain: ticket_url (direct purchase) → source_url (source detail page).
  const primaryUrl   = firstAbsoluteUrl(event.ticket_url, event.source_url)
  const isTicketLink = !!event.ticket_url && primaryUrl === event.ticket_url
  const primaryLabel = isTicketLink
    ? (price.free ? 'Register (Free)' : `Get Tickets · ${price.label}`)
    : 'View Event Details →'

  return (
    <>
      {primaryUrl && (
        <a
          href={primaryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ticket"
        >
          {primaryLabel}
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




function AreaIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="9" x2="9" y1="21" y2="9"/></svg>
}
