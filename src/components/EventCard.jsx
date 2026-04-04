import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, isToday, isTomorrow } from 'date-fns'
import './EventCard.css'

// ── Minimum dimensions to consider an image "quality enough" ──
const MIN_IMG_WIDTH  = 600
const MIN_IMG_HEIGHT = 338

// Map category → CSS class for thumbnail gradient
const GRADIENT_MAP = {
  music:     'g-jazz',
  art:       'g-art',
  community: 'g-market',
  nonprofit: 'g-gala',
  food:      'g-market',
  sports:    'g-sports',
  fitness:   'g-run',
  education: 'g-openmic',
  other:     'g-default',
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

// Reject data URIs and blob URLs — they are scraper placeholder artifacts,
// not real hostable images. Fall back to the gradient thumb instead.
function isUsableImageUrl(url) {
  return url && /^https?:\/\//i.test(url)
}

/**
 * Check if the image meets the quality threshold.
 * If dimensions are stored in the DB, use those. If dimensions are unknown
 * (null), show the image optimistically (it will fallback on error).
 */
function isImageQualityOk(event) {
  // No dimensions stored → show optimistically
  if (event.image_width == null || event.image_height == null) return true
  return event.image_width >= MIN_IMG_WIDTH && event.image_height >= MIN_IMG_HEIGHT
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
  const [imgFailed, setImgFailed] = useState(false)

  const rawUrl   = isUsableImageUrl(event.image_url) ? event.image_url : null
  const qualityOk = rawUrl && isImageQualityOk(event)
  const imageUrl  = qualityOk && !imgFailed ? rawUrl : null
  const gradient  = imageUrl ? null : (GRADIENT_MAP[event.category] ?? 'g-default')

  const handleImgError = useCallback(() => setImgFailed(true), [])

  return (
    <div
      className={`card ${featured ? 'featured' : ''}`}
      onClick={() => navigate(`/events/${event.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/events/${event.id}`)}
    >
      <div className="card-thumb">
        {imageUrl
          ? <img src={imageUrl} alt={event.title} className="card-img" referrerPolicy="no-referrer" onError={handleImgError} />
          : (
            <div className={`thumb-fill ${gradient}`}>
              <span className="thumb-lbl">{event.title}</span>
            </div>
          )
        }
      </div>

      <div className="card-body">
        <div className="card-top">
          <div className="card-tags">
            {featured && <span className="featured-tag">Featured</span>}
            <span className={`event-tag ${tagClass}`}>{catLabel}</span>
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
        <span className={`event-tag ${tagClass}`}>{catLabel}</span>
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
