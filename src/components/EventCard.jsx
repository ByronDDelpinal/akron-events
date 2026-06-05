import { useNavigate } from 'react-router-dom'
import CategoryBadge from './CategoryBadge'
import { eventPath } from '@/lib/slug'
import {
  formatPrice,
  formatEventDate,
  gradientFor,
  AGE_LABEL,
  imageUrlForEvent,
} from '@/lib/eventFormatting'
import './EventCard.css'

function AgeRestrictionPill({ value }) {
  if (!value || value === 'not_specified') return null
  const label = AGE_LABEL[value] ?? value
  return <span className="age-pill">{label}</span>
}

/**
 * Render an event's content categories as badges — primary first, then the
 * secondary (events now carry up to 2 via the event_categories join table).
 * Falls back to the singular `category` shim for any not-yet-migrated caller.
 */
function CategoryBadges({ event }) {
  const cats = (event.categories?.length ? event.categories : [event.category])
    .filter(Boolean)
    .slice(0, 2)
  return cats.map((c, i) => (
    <CategoryBadge
      key={c}
      category={c}
      className={i > 0 ? 'event-tag--secondary' : ''}
    />
  ))
}

// ── COMFORTABLE MODE (default) ──────────────────────────────────────────────

export default function EventCard({ event, featured = false, viewMode = 'comfortable' }) {
  const navigate = useNavigate()
  const price    = formatPrice(event.price_min, event.price_max)
  const gradient = gradientFor(event.category)

  if (viewMode === 'efficient') {
    return (
      <EfficientCard
        event={event}
        featured={featured}
        price={price}
        navigate={navigate}
        gradient={gradient}
      />
    )
  }

  return (
    <ComfortableCard
      event={event}
      featured={featured}
      price={price}
      navigate={navigate}
    />
  )
}

function ComfortableCard({ event, featured, price, navigate }) {
  const gradient  = gradientFor(event.category)
  // Image fallback chain: event → venue → organizer. Resolved by
  // imageUrlForEvent so every card across the app picks the same
  // candidate in the same order.
  const imageUrl  = imageUrlForEvent(event)
  const hasImage  = Boolean(imageUrl)

  return (
    <div
      className={`card ${featured ? 'featured' : ''}${hasImage ? ' card--has-image' : ''}`}
      onClick={() => navigate(eventPath(event))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(eventPath(event))}
    >
      {/* Faint background photo — scrim keeps all text at WCAG AA contrast */}
      {hasImage && (
        <>
          <div
            className="card-bg-image"
            aria-hidden="true"
            style={{ backgroundImage: `url(${imageUrl})` }}
          />
          <div className="card-bg-scrim" aria-hidden="true" />
        </>
      )}
      <div className={`card-accent ${gradient}`} aria-hidden="true" />

      <div className="card-body">
        <div className="card-top">
          <div className="card-tags">
            {featured && <span className="featured-tag">Featured</span>}
            <CategoryBadges event={event} />
          </div>
          <span className={`card-price ${price.free ? 'free' : ''}`}>{price.label}</span>
        </div>

        <div className="card-title">{event.title}</div>
        {event.organizer && (
          <div className="card-organizer">{event.organizer.name}</div>
        )}

        <div className="card-meta">
          <div className="meta-row">
            <CalendarIcon />
            {formatEventDate(event.start_at)}
          </div>
          {event.venue && (
            <div className="meta-row">
              <PinIcon />
              {event.venue.name}{event.venue.city !== 'Akron' ? `, ${event.venue.city}` : ''}
            </div>
          )}
        </div>

        {featured && (
          <div style={{ marginTop: 16 }}>
            <button className="btn-details">View Details →</button>
          </div>
        )}
      </div>

      {!featured && (
        <div className="card-footer">
          <AgeRestrictionPill value={event.age_restriction} />
          <button className="btn-details">View Details →</button>
        </div>
      )}
    </div>
  )
}

// ── EFFICIENT MODE ──────────────────────────────────────────────────────────

function EfficientCard({ event, featured, price, navigate, gradient }) {
  return (
    <div
      className={`card-efficient ${featured ? 'card-efficient--featured' : ''}`}
      onClick={() => navigate(eventPath(event))}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(eventPath(event))}
    >
      {/* Gradient accent bar — only on non-featured cards; featured uses border-left */}
      {!featured && (
        <div className={`card-efficient-accent ${gradient}`} aria-hidden="true" />
      )}
      <div className="card-efficient-inner">
        <div className="card-efficient-main">
          <div className="card-efficient-title">{event.title}</div>
          <div className="card-efficient-meta">
            <div className="card-efficient-meta-row">
              <CalendarIcon />
              <span>{formatEventDate(event.start_at)}</span>
            </div>
            {event.venue && (
              <div className="card-efficient-meta-row">
                <PinIcon />
                <span>{event.venue.name}{event.venue.city !== 'Akron' ? `, ${event.venue.city}` : ''}</span>
              </div>
            )}
          </div>
        </div>
        <div className="card-efficient-end">
          <CategoryBadges event={event} />
          <span className={`card-efficient-price ${price.free ? 'free' : ''}`}>{price.label}</span>
        </div>
      </div>
    </div>
  )
}

// ── Inline icon components ────────────────────────────────────
function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="4" rx="2"/>
      <line x1="16" x2="16" y1="2" y2="6"/>
      <line x1="8"  x2="8"  y1="2" y2="6"/>
      <line x1="3"  x2="21" y1="10" y2="10"/>
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}

