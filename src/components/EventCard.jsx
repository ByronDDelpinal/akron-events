import { useNavigate } from 'react-router-dom'
import { format, isToday, isTomorrow } from 'date-fns'
import './EventCard.css'

// Map category → CSS class for the colored accent bar at the top of each card.
// Same gradient palette previously used for thumbnails — now repurposed as
// a thin category-identifying stripe. Image rendering was removed because
// scraper image yield is too sparse to justify the inconsistent grid.
const GRADIENT_MAP = {
  music:     'gradient-jazz',
  art:       'gradient-art',
  community: 'gradient-market',
  nonprofit: 'gradient-gala',
  food:      'gradient-market',
  sports:    'gradient-sports',
  fitness:   'gradient-run',
  education: 'gradient-openmic',
  nature:    'gradient-forest',
  other:     'gradient-default',
}

// Map category → tag CSS class
const TAG_CLASS_MAP = {
  music:     'tag-music',
  art:       'tag-art',
  nonprofit: 'tag-nonprofit',
  community: 'tag-community',
  food:      'tag-food',
  sports:    'tag-sports',
  fitness:   'tag-fitness',
  education: 'tag-education',
  nature:    'tag-nature',
  other:     'tag-other',
}

const CATEGORY_LABEL = {
  music:     'Music',
  art:       'Art',
  nonprofit: 'Non-Profit',
  community: 'Community',
  food:      'Food & Drink',
  sports:    'Sports',
  fitness:   'Fitness',
  education: 'Education',
  nature:    'Nature',
  other:     'Other',
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
  const tagClass = TAG_CLASS_MAP[event.category] ?? 'tag-other'
  const catLabel = CATEGORY_LABEL[event.category] ?? event.category

  if (viewMode === 'efficient') {
    return (
      <EfficientCard
        event={event}
        featured={featured}
        price={price}
        tagClass={tagClass}
        catLabel={catLabel}
        navigate={navigate}
      />
    )
  }

  return (
    <ComfortableCard
      event={event}
      featured={featured}
      price={price}
      tagClass={tagClass}
      catLabel={catLabel}
      navigate={navigate}
    />
  )
}

function ComfortableCard({ event, featured, price, tagClass, catLabel, navigate }) {
  const gradient = GRADIENT_MAP[event.category] ?? 'gradient-default'

  return (
    <div
      className={`card ${featured ? 'featured' : ''}`}
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${event.id}`)}
    >
      <div className={`card-accent ${gradient}`} aria-hidden="true" />

      <div className="card-body">
        <div className="card-top">
          <div className="card-tags">
            {featured && <span className="featured-tag">Featured</span>}
            <span className={`event-tag ${tagClass}`}>
              <CategoryIcon category={event.category} />
              {catLabel}
            </span>
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

function EfficientCard({ event, featured, price, tagClass, catLabel, navigate }) {
  return (
    <div
      className={`card-efficient ${featured ? 'card-efficient--featured' : ''}`}
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${event.id}`)}
    >
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
        <span className={`event-tag ${tagClass}`}>
          <CategoryIcon category={event.category} />
          {catLabel}
        </span>
        <span className={`card-efficient-price ${price.free ? 'free' : ''}`}>{price.label}</span>
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

/**
 * CategoryIcon — small glyph rendered inside the category badge to provide
 * a redundant non-color signal per category (WCAG 1.4.1). Uses currentColor
 * stroke so each icon inherits its parent badge's text color automatically.
 * Decorative — wrapped span carries the readable category label, so the
 * icon is marked aria-hidden.
 */
function CategoryIcon({ category }) {
  const props = {
    width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2.5,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true, focusable: false,
  }
  switch (category) {
    case 'music': return (
      <svg {...props}>
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/>
        <circle cx="18" cy="16" r="3"/>
      </svg>
    )
    case 'art': return (
      <svg {...props}>
        <path d="M12 2a10 10 0 0 0 0 20c1 0 2-.8 2-2 0-.5-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2H17a5 5 0 0 0 5-5c0-5-4.5-8.5-10-8.5z"/>
        <circle cx="7.5" cy="11" r="1"/>
        <circle cx="12" cy="6.5" r="1"/>
        <circle cx="16.5" cy="9" r="1"/>
      </svg>
    )
    case 'nonprofit': return (
      <svg {...props}>
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    )
    case 'community': return (
      <svg {...props}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    )
    case 'food': return (
      <svg {...props}>
        <path d="M3 2v7c0 1.1.9 2 2 2h2v11"/>
        <path d="M7 2v20"/>
        <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3z"/>
      </svg>
    )
    case 'sports': return (
      <svg {...props}>
        <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
        <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
        <path d="M4 22h16"/>
        <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
        <path d="M14 14.66V17c0 .55.47.98.97 1.21 1.18.53 2.03 2.02 2.03 3.79"/>
        <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
      </svg>
    )
    case 'fitness': return (
      <svg {...props}>
        <path d="M2 12h2"/>
        <path d="M20 12h2"/>
        <path d="M5 8v8"/>
        <path d="M19 8v8"/>
        <path d="M8 6v12"/>
        <path d="M16 6v12"/>
        <path d="M8 12h8"/>
      </svg>
    )
    case 'education': return (
      <svg {...props}>
        <path d="M22 10 12 5 2 10l10 5 10-5z"/>
        <path d="M22 10v6"/>
        <path d="M6 12v4c0 1.66 2.69 3 6 3s6-1.34 6-3v-4"/>
      </svg>
    )
    case 'nature': return (
      <svg {...props}>
        <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/>
        <path d="M2 21c0-3 1.85-5.36 5.08-6"/>
      </svg>
    )
    default: return (
      <svg {...props}>
        <path d="m12 3-2 6-6 2 6 2 2 6 2-6 6-2-6-2z"/>
      </svg>
    )
  }
}
