import { Link } from 'react-router-dom'
import { CategoryBadges } from './CategoryBadge'
import AddToPlanButton from './AddToPlanButton'
import EventLink from './EventLink'
import { useEmbed } from '@/hooks/useEmbed'
import type { EmbedConfig } from '@/lib/embedConfig'
import type { AppEvent } from '@/hooks/useEvents'
import type { PlanSurface } from '@/lib/analyticsEvents'
import {
  formatPrice,
  formatEventDate,
  gradientForEvent,
  AGE_LABEL,
  imageUrlForEvent,
  optimizedImageUrl,
  type PriceDisplay,
} from '@/lib/eventFormatting'
import { getSourceLabel, shouldShowSourceCredit } from '@/lib/sources'
import { umbrellaFestival } from '@/lib/browseVisibility'
import { useFestivalChildCount } from '@/hooks/useFestivalChildCount'
import './EventCard.css'
import { CalIcon, PinIcon } from '@/components/icons'

// Whether a card feature is on. Outside the embed (embed === null) every
// feature is implicitly enabled; inside the embed the partner can switch
// price / tags off via the `features` config.
function featureOn(embed: EmbedConfig | null, name: string): boolean {
  return !embed || (embed.features as Record<string, boolean>)[name] !== false
}

function AgeRestrictionPill({ value }: { value?: string | null }) {
  if (!value || value === 'not_specified') return null
  const label = AGE_LABEL[value] ?? value
  return <span className="age-pill">{label}</span>
}

/** Minimal shape FestivalUmbrellaLine needs — deliberately looser than the
 *  full `Festival` interface (festivals.ts) so it structurally matches
 *  whatever browseVisibility.js's plain-JS umbrellaFestival() infers to. */
interface UmbrellaFestivalLike {
  slug: string
  tag: string
  childLabel?: { singular: string; plural: string }
}

/**
 * The umbrella card treatment (docs/umbrella-child-hiding.md §3): the
 * "N sets on the schedule. See the full lineup." line. Copy states, exactly
 * per §3.3 — NEVER a bare "0 sets", NEVER a number with no link. Loading and
 * a failed count both collapse into the same zero-state copy: the link is
 * always right, the count is the only uncertain part.
 */
function FestivalUmbrellaLine({ festival, embed }: { festival: UmbrellaFestivalLike; embed: EmbedConfig | null }) {
  const { count, loading } = useFestivalChildCount(festival.tag)
  const label = festival.childLabel ?? { singular: 'event', plural: 'events' }
  // Embeds hide children too (maintainer ruling, docs/umbrella-child-hiding.md
  // §3.4): unlike EventPage's festival-hub button (gated behind !embed, the
  // white-label "never navigate a partner's iframe away" rule), this link
  // stays but opens in a new tab so the embed is never a dead end.
  const hubProps = embed ? { target: '_blank' as const, rel: 'noopener' } : {}

  if (loading || count == null || count === 0) {
    return (
      <div className="card-umbrella-line">
        See <Link to={`/festival/${festival.slug}`} {...hubProps}>the festival page</Link> for details and a map.
      </div>
    )
  }
  const noun = count === 1 ? label.singular : label.plural
  return (
    <div className="card-umbrella-line">
      {count} {noun} on the schedule. See the{' '}
      <Link to={`/festival/${festival.slug}`} {...hubProps}>full lineup</Link>.
    </div>
  )
}

interface EventCardProps {
  event: AppEvent
  featured?: boolean
  viewMode?: string
  /** Which analytics surface this card's AddToPlanButton reports (§6.8).
   *  Defaults to 'card'; the festival hub passes 'festival_hub'. */
  planSurface?: PlanSurface
  /** Optional muted one-liner under the title. Rendered by the EFFICIENT
   *  card only (the festival hub passes the set's genre); other view modes
   *  ignore it. */
  subtitle?: string
}

// ── COMFORTABLE MODE (default) ──────────────────────────────────────────────

export default function EventCard({ event, featured = false, viewMode = 'comfortable', planSurface = 'card', subtitle }: EventCardProps) {
  const embed    = useEmbed()
  const price    = formatPrice(event.price_min, event.price_max)
  const gradient = gradientForEvent(event)

  if (viewMode === 'efficient') {
    return (
      <EfficientCard
        event={event}
        featured={featured}
        price={price}
        embed={embed}
        gradient={gradient}
        planSurface={planSurface}
        subtitle={subtitle}
      />
    )
  }

  return (
    <ComfortableCard
      event={event}
      featured={featured}
      price={price}
      embed={embed}
      planSurface={planSurface}
    />
  )
}

interface CardProps {
  event: AppEvent
  featured: boolean
  price: PriceDisplay
  embed: EmbedConfig | null
  planSurface: PlanSurface
}

// Stretched-link contract (EventCard.css): the card is NOT a button — the
// title anchor is the one real link, and its ::after overlay (z-index 3) is
// the whole-card hit area. Anything interactive inside a card must sit at
// z-index 4+ to stay clickable above the overlay; duplicate links to the same
// destination ("View Details →") use EventLink's `decorative` so assistive
// tech hears one link per card. Stacking-context trap: .card-body and
// .card-footer are their own stacking contexts (z-index: 2), so the overlay —
// stuck inside .card-body's context — can never reach above .card-footer.
// Footer interactives therefore work by paint order alone (footer paints
// after body); the featured row's interactives live INSIDE .card-body with
// the overlay and genuinely need the z-index 4 rules.
function ComfortableCard({ event, featured, price, embed, planSurface }: CardProps) {
  const gradient  = gradientForEvent(event)
  // Image fallback chain: event → venue → organizer.
  const imageUrl  = imageUrlForEvent(event)
  const hasImage  = Boolean(imageUrl)
  const showPrice = featureOn(embed, 'price')
  const showTags  = featureOn(embed, 'tags')
  const umbrella  = umbrellaFestival(event.tags)

  return (
    <div className={`card ${featured ? 'featured' : ''}${hasImage ? ' card--has-image' : ''}`}>
      {/* Faint background photo — scrim keeps all text at WCAG AA contrast.
          A real <img> (not a CSS background) so the browser can lazy-load
          offscreen cards and pick the AVIF/WebP rendition. On load failure
          the img hides itself; the scrim + card background still render. */}
      {hasImage && (
        <>
          <img
            className="card-bg-image"
            src={optimizedImageUrl(imageUrl, 480) ?? undefined}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
          <div className="card-bg-scrim" aria-hidden="true" />
        </>
      )}
      <div className={`card-accent ${gradient}`} aria-hidden="true" />

      <div className="card-body">
        <div className="card-top">
          <div className="card-tags">
            {featured && <span className="featured-tag">Featured</span>}
            {showTags && <CategoryBadges event={event} />}
          </div>
          {showPrice && (
            <span className={`card-price ${price.free ? 'free' : ''}`}>{price.label}</span>
          )}
        </div>

        <EventLink event={event} className="card-title card-title-link">{event.title}</EventLink>
        {event.organizer ? (
          <div className="card-organizer">{event.organizer.name}</div>
        ) : shouldShowSourceCredit(event.source, false) ? (
          // Provenance fallback for aggregator-sourced events with no known
          // organizer. Styled distinctly from .card-organizer on purpose: this
          // says where we FOUND the event, not who runs it, and the two must
          // never be mistakable for each other. See shouldShowSourceCredit.
          <div className="card-source-credit">Listed on {getSourceLabel(event.source)}</div>
        ) : null}

        <div className="card-meta">
          <div className="meta-row">
            <CalIcon size={13} />
            {formatEventDate(event.start_at)}
          </div>
          {event.venue && (
            <div className="meta-row">
              <PinIcon size={13} />
              {event.venue.name}{event.venue.city !== 'Akron' ? `, ${event.venue.city}` : ''}
            </div>
          )}
        </div>

        {umbrella && <FestivalUmbrellaLine festival={umbrella} embed={embed} />}

        {featured && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <EventLink event={event} className="btn-details" decorative>View Details →</EventLink>
            <AddToPlanButton event={event} surface={planSurface} variant="chip" />
          </div>
        )}
      </div>

      {!featured && (
        <div className="card-footer">
          <AgeRestrictionPill value={event.age_restriction} />
          <AddToPlanButton event={event} surface={planSurface} variant="chip" />
          <EventLink event={event} className="btn-details" decorative>View Details →</EventLink>
        </div>
      )}
    </div>
  )
}

// ── EFFICIENT MODE ──────────────────────────────────────────────────────────

function EfficientCard({ event, featured, price, embed, gradient, planSurface, subtitle }: CardProps & { gradient: string; subtitle?: string }) {
  const showPrice = featureOn(embed, 'price')
  const showTags  = featureOn(embed, 'tags')
  const umbrella  = umbrellaFestival(event.tags)
  return (
    <div className={`card-efficient ${featured ? 'card-efficient--featured' : ''}`}>
      {/* Gradient accent bar — only on non-featured cards; featured uses border-left */}
      {!featured && (
        <div className={`card-efficient-accent ${gradient}`} aria-hidden="true" />
      )}
      <div className="card-efficient-inner">
        <div className="card-efficient-main">
          <EventLink event={event} className="card-efficient-title card-title-link">{event.title}</EventLink>
          {umbrella ? (
            <div className="card-efficient-subtitle">
              <FestivalUmbrellaLine festival={umbrella} embed={embed} />
            </div>
          ) : subtitle ? (
            <div className="card-efficient-subtitle">{subtitle}</div>
          ) : null}
          <div className="card-efficient-meta">
            <div className="card-efficient-meta-row">
              <CalIcon size={13} />
              <span>{formatEventDate(event.start_at)}</span>
            </div>
            {event.venue && (
              <div className="card-efficient-meta-row">
                <PinIcon size={13} />
                <span>{event.venue.name}{event.venue.city !== 'Akron' ? `, ${event.venue.city}` : ''}</span>
              </div>
            )}
          </div>
        </div>
        <div className="card-efficient-end">
          <AddToPlanButton event={event} surface={planSurface} variant="chip" />
          {showTags && <CategoryBadges event={event} />}
          {showPrice && (
            <span className={`card-efficient-price ${price.free ? 'free' : ''}`}>{price.label}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Inline icon components ────────────────────────────────────



