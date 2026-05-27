import { useNavigate } from 'react-router-dom'
import { format, isToday, isTomorrow } from 'date-fns'
import CategoryBadge from './CategoryBadge'
import './EventCard.css'

// Map category → CSS class for the colored accent bar at the top of each card.
// Same gradient palette previously used for thumbnails — now repurposed as
// a thin category-identifying stripe. Image rendering was removed because
// scraper image yield is too sparse to justify the inconsistent grid.
const GRADIENT_MAP = {
  music:     'gradient-jazz',
  art:       'gradient-art',
  community: 'gradient-civic',
  nonprofit: 'gradient-gala',
  food:      'gradient-market',
  sports:    'gradient-sports',
  fitness:   'gradient-run',
  education: 'gradient-openmic',
  nature:    'gradient-forest',
  other:     'gradient-default',
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

function AgeRestrictionPill({ value }) {
  if (!value || value === 'not_specified') return null
  const label = value === 'all_ages' ? 'All ages' : value === '18_plus' ? '18+' : '21+'
  return <span className="age-pill">{label}</span>
}

// ── COMFORTABLE MODE (default) ──────────────────────────────────────────────

export default function EventCard({ event, featured = false, viewMode = 'comfortable' }) {
  const navigate = useNavigate()
  const price    = formatPrice(event.price_min, event.price_max)
  const gradient = GRADIENT_MAP[event.category] ?? 'gradient-default'

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
  const gradient  = GRADIENT_MAP[event.category] ?? 'gradient-default'
  const hasImage  = Boolean(event.image_url)

  return (
    <div
      className={`card ${featured ? 'featured' : ''}${hasImage ? ' card--has-image' : ''}`}
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${event.id}`)}
    >
      {/* Faint background photo — scrim keeps all text at WCAG AA contrast */}
      {hasImage && (
        <>
          <div
            className="card-bg-image"
            aria-hidden="true"
            style={{ backgroundImage: `url(${event.image_url})` }}
          />
          <div className="card-bg-scrim" aria-hidden="true" />
        </>
      )}
      <div className={`card-accent ${gradient}`} aria-hidden="true" />

      <div className="card-body">
        <div className="card-top">
          <div className="card-tags">
            {featured && <span className="featured-tag">Featured</span>}
            <CategoryBadge category={event.category} />
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
            {formatDate(event.start_at)}
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
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${event.id}`)}
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
              <span>{formatDate(event.start_at)}</span>
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
          <CategoryBadge category={event.category} />
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

