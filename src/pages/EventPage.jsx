import { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { format } from 'date-fns'
import { useEvent } from '@/hooks/useEvents'
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
import {
  formatPrice,
  gradientForEvent,
  AGE_LABEL,
  PARKING_LABEL,
  resolveEventImage,
} from '@/lib/eventFormatting'
import './EventPage.css'

// Banner needs to span the page content area; sub-1120 images become thumbnails.
const BANNER_MIN_WIDTH = 1120

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

function downloadIcs(event) {
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
  // embed config) rather than history.back(): a tall iframe's history can be
  // entangled with the host page, so an explicit route keeps us inside the
  // embed reliably. On the site, plain back is the right behavior.
  const backToList = useCallback(() => {
    if (embed) navigate(`/embed${location.search}`)
    else navigate(-1)
  }, [embed, navigate, location.search])

  // Canonicalize the URL: if the user arrived via the bare /events/:id
  // route (slug undefined) or via a stale slug (title or date changed
  // upstream since the link was created), replace the history entry
  // with the up-to-date /events/{slug}/{id} form. Using replace=true
  // keeps the back button pointing at the page they came from.
  //
  // The `event.id === id` guard is critical: when navigating between
  // event pages (e.g. clicking a card in RelatedEvents), useParams
  // updates with the new id+slug before useEvent's fetch lands, so for
  // one render the hook still returns the *previous* event. Without
  // this guard, the effect compares the new slug against the stale
  // event's canonical slug, sees a mismatch, and rewrites the URL back
  // to the old event — making the related-event cards appear broken.
  useEffect(() => {
    if (!event || event.id !== id) return
    const canonicalSlug = makeEventSlug(event)
    if (slug !== canonicalSlug) {
      // In the embed, canonicalize within the /embed tree (carrying the
      // embed config query string) so we never break the iframe out to the
      // full site. On the site, canonicalize to the normal /events path.
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

  // Shared Google Maps directions URL — referenced by both the mobile
  // and sidebar venue blocks (InfoRow + VenueMap). Kept as a single
  // value so the link target stays consistent everywhere on the page.
  const venueDirectionsUrl = event.venue
    ? `https://maps.google.com/?q=${encodeURIComponent(
        [event.venue.name, event.venue.address, event.venue.city]
          .filter(Boolean).join(' ')
      )}`
    : null

  // ── Image routing ──
  // Walk the event → venue → organizer fallback chain. `banner_eligible`
  // and `image_width`/`image_height` only exist for event-row images
  // (the scraper computes them at ingest); when we fall back to a venue
  // or organizer image we have neither, so those fallback images can
  // only render as float thumbnails — never as full-bleed banners — to
  // avoid a CLS jump from an unknown aspect ratio.
  const { url: rawUrl, source: imageSource } = resolveEventImage(event)
  const gradient = gradientForEvent(event)

  const showBanner = !!rawUrl
    && imageSource === 'event'
    && event.banner_eligible
    && event.image_width != null
    && event.image_width >= BANNER_MIN_WIDTH

  // Anything else with a usable URL renders as a float thumbnail under
  // "About this event". Sub-banner-quality images still get shown — they
  // look fine at thumbnail scale.
  const showFloat = !!rawUrl && !showBanner

  // ── Build SEO metadata for this event ────────────────────────────
  // Title + description are produced by the central title framework so
  // every event page conforms to the format Google rewards for
  // event-intent queries. See src/lib/seo/titles.js for the templates.
  const seoTitle = eventTitle(event)
  const seoDesc  = eventDescription(event)
  // Always use the dynamic OG image — branded, consistent, and works for
  // every event regardless of whether it has a banner-eligible photo.
  // The Vercel Edge Function at /api/og/event/[id] renders the image
  // on-demand and caches at the edge.
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

      {/* ── BANNER / IMAGE ──
       * Visual states:
       *   - showBanner → full-width image banner (good wide image)
       *   - showFloat  → no top banner; image floats under About section
       *   - otherwise  → 20px gradient accent
       * Category + Featured badges live in the content section either way. */}
      {showBanner ? (
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
            <h1 className="event-detail-title">{event.title}</h1>
            {event.organizations?.length > 0 ? (
              <p className="event-detail-organizer">
                Presented by{' '}
                {event.organizations.map((org, i) => (
                  <span key={org.id}>
                    {i > 0 && ', '}
                    {/* Organizer is non-clickable inside the embed so the
                        white-label surface never funnels visitors into the
                        full Akron Pulse site. */}
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
            <div className="event-detail-type-row">
              <CategoryBadges event={event} />
              <FacetBadges event={event} />
              {event.tags?.map(tag => (
                <span key={tag} className="user-tag">{tag}</span>
              ))}
            </div>

            {/* Share row — placed near the top of the content so users
                can grab a link without scrolling. UTM-tagged so we can
                tell which platform drove a session in analytics. */}
            <div className="event-detail-share">
              <ShareButtons
                url={canonicalPath}
                title={event.title}
                text={seoDesc}
                campaign="event_detail"
              />
            </div>

            {/* Mobile info (shown below 820px, before the description).
             * The sidebar is hidden on mobile, so anything riders need before
             * they decide to act — venue + map especially — has to live here. */}
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

            {/* Narrow or low-quality images render here as a float-left
             * thumbnail. Description text wraps around it. The float
             * is positioned UNDER the section label so the heading
             * spans the full width above. */}
            {showFloat && (
              <EventFloatImage imageUrl={rawUrl} event={event} />
            )}

            {event.description
              ? <EventDescription text={event.description} />
              : <p className="event-detail-desc">No description available.</p>
            }

            {/* ── NEWSLETTER CTA ──
             * Lives inside the main column so it sits beside the
             * sidebar instead of stretching full-width below the
             * two-column layout. Anchors the bottom of the event-
             * details section and gives share-driven visitors a
             * recurring touchpoint before they decide to leave. */}
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

        {/* ── RELATED EVENTS ──
         * 4 upcoming events in the same category, fetched client-side
         * (hidden until data lands, hidden entirely when none exist).
         * Internal-link topology + sibling discovery — see SEO punch
         * list item #3. */}
        {/* "More events" is omitted in the embed (white-label rule). */}
        {!embed && <RelatedEvents currentEvent={event} />}
      </div>
    </div>
  )
}

/* ── Sub-components ─────────────────────────────────── */

/**
 * Full-width banner image that respects native aspect ratio.
 * Uses the actual image_width/image_height from DB when available.
 */
function EventBannerImage({ imageUrl, event, gradient }) {
  const [imgFailed, setImgFailed] = useState(false)
  const handleError = useCallback(() => setImgFailed(true), [])

  if (imgFailed) {
    // Image URL was valid but failed to load — fall back to the same
    // 20px accent the page uses when no quality image is available.
    return <div className={`event-detail-accent ${gradient}`} aria-hidden="true" />
  }

  // Use native aspect ratio: let the image determine its own height.
  // width/height attributes are populated from the DB columns where
  // available so the browser can reserve layout space before the
  // image loads — that's what eliminates CLS (Cumulative Layout
  // Shift), one of the three Core Web Vitals Google ranks on. The
  // banner is above-the-fold so it stays as eager `loading="eager"`
  // and `fetchpriority="high"` — these are the LCP element on most
  // event pages and we want the browser to prioritize them.
  return (
    <div className="event-detail-banner event-detail-banner--native">
      <img
        src={imageUrl}
        alt={event.title}
        className="event-banner-img event-banner-img--native"
        referrerPolicy="no-referrer"
        onError={handleError}
        width={event.image_width || undefined}
        height={event.image_height || undefined}
        loading="eager"
        fetchpriority="high"
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

/**
 * Float-left image for narrow images that don't span full width.
 * Text flows around it.
 */
function EventFloatImage({ imageUrl, event }) {
  const [imgFailed, setImgFailed] = useState(false)
  const handleError = useCallback(() => setImgFailed(true), [])

  if (imgFailed) return null

  // Float images are below-the-fold (rendered after the page title +
  // metadata + first paragraph of description). Lazy-load so they
  // never compete with the LCP element for bandwidth. width/height
  // pulled from DB when present so the browser reserves layout space.
  return (
    <img
      src={imageUrl}
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

// Only http(s) absolute URLs are safe to render as outbound links. A
// relative / malformed URL would resolve against the current origin
// (akronpulse.com) and 404 — and inside the embed it would break the
// iframe out to a not-found page. Guarding here is defense-in-depth on top
// of the scraper-level URL absolutisation.
function firstAbsoluteUrl(...urls) {
  for (const u of urls) {
    if (u && /^https?:\/\//i.test(u)) return u
  }
  return null
}

function ActionButtons({ event, price }) {
  // Akron Pulse is an aggregator, not a ticketing platform, so every
  // event page MUST surface at least one outbound link the user can
  // follow to register, RSVP, or read the source listing. The CTA
  // chain is:
  //
  //   1. ticket_url   — direct purchase/registration link (best case)
  //   2. source_url   — the event's detail page on the source's site
  //
  // source_url is populated by every scraper via the upsertEventSafe
  // helper (defaulting to ticket_url) and explicitly by sources where
  // the detail page and ticketing page diverge (e.g. visit_akron_cvb).
  const primaryUrl   = firstAbsoluteUrl(event.ticket_url, event.source_url)
  const isTicketLink = !!event.ticket_url && primaryUrl === event.ticket_url
  const primaryLabel = isTicketLink
    ? (price.free ? 'Register — Free' : `Get Tickets — ${price.label}`)
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
