/**
 * CategoryBadge — single source of truth for category pills across the app.
 *
 * Display labels (CATEGORY_DISPLAY) and pill color classes (TAG_CLASS_MAP)
 * both come from the canonical taxonomy registry (@/lib/categories) so badge
 * copy and colors stay in sync with every other category-aware surface.
 *
 * CLICKABLE BADGES — only `CategoryBadges` (the plural, event-driven one) opts
 * in. It resolves each pill through lib/categoryHref and renders a react-router
 * <Link> (a PUSH, so browser/hardware Back returns the visitor to their previous
 * filters) that lands on the browse grid filtered to that ONE category.
 *
 * The DEFAULT export deliberately stays a plain <span>: VenueDetailPage and
 * OrganizationDetailPage render the singular badge INSIDE a
 * `<div role="button" onClick={navigate(...)}>` row, so turning it into an
 * anchor would fire two competing navigations with a nondeterministic winner.
 *
 * Stretched-link contract: inside an EventCard the title anchor's ::after
 * overlay (z-index 3) covers the whole card, so these anchors only receive
 * clicks because EventCard.css lifts `a.event-tag` to z-index 4. See the
 * contract comment in EventCard.tsx — that CSS rule is load-bearing, not
 * cosmetic; without it every badge click silently opens the event page.
 */

import type { MouseEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { CATEGORY_DISPLAY, TAG_CLASS_MAP, FACETS } from '@/lib/categories'
import { CATEGORY_GLYPHS } from '@/lib/categoryGlyphs'
import { resolveCategoryBadgeHref, type CategoryBadgeHref } from '@/lib/categoryHref'
import { useEmbed } from '@/hooks/useEmbed'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { AppEvent } from '@/hooks/useEvents'

interface FacetDef { slug: string; emoji: string; label: string }

const FACET_BY_SLUG: Record<string, FacetDef> = Object.fromEntries(
  FACETS.map((f) => [f.slug, f]),
)

// The taxonomy maps are authored in plain JS; widen to a string index here.
const TAG_CLASS = TAG_CLASS_MAP as Record<string, string>
const CAT_DISPLAY = CATEGORY_DISPLAY as Record<string, string>

/** The non-linking target — what the default <span> badge always renders. */
const INERT: CategoryBadgeHref = { kind: 'inert' }

interface CategoryBadgeProps {
  category: string
  className?: string
}

export default function CategoryBadge({ category, className = '' }: CategoryBadgeProps) {
  return <BadgePill category={category} className={className} target={INERT} />
}

/**
 * CategoryBadges — render every content category an event carries (primary
 * first, up to 2), with the secondary de-emphasized. These are the LINKED
 * badges: each resolves to the grid filtered to that one category (or, for a
 * `festival` badge on a festival's umbrella row, to that festival's hub).
 *
 * useEmbed() rather than a prop: there are four call sites across two density
 * forks plus a sub-component on the event page, and the resolver needs the
 * partner's lock VALUES (lockedKeys / permitted categories), not just a
 * "we're in an embed" boolean.
 */
export function CategoryBadges({ event }: { event: AppEvent }) {
  const embed = useEmbed()
  const { pathname, search } = useLocation()
  const cats = (event.categories?.length ? event.categories : [event.category])
    .filter(Boolean)
    .slice(0, 2)
  return cats.map((c: string, i: number) => (
    <BadgePill
      key={c}
      category={c}
      className={i > 0 ? 'event-tag--secondary' : ''}
      target={resolveCategoryBadgeHref(c, { pathname, search, embed, tags: event.tags })}
    />
  ))
}

/**
 * The pill body, rendered as either a <span> (inert) or a <Link>. One
 * component so the linked and unlinked variants can never drift in markup,
 * classes, or glyph handling.
 */
function BadgePill({
  category,
  className = '',
  target,
}: CategoryBadgeProps & { target: CategoryBadgeHref }) {
  const tagClass = TAG_CLASS[category] ?? 'tag-other'
  const label    = CAT_DISPLAY[category] ?? category
  const cls      = `event-tag ${tagClass}${className ? ' ' + className : ''}`

  if (target.kind === 'link') {
    return (
      <Link
        to={target.href}
        className={cls}
        aria-label={`Browse ${label} events`}
        onClick={(e) => handleBadgeClick(e, category)}
      >
        <CategoryIcon category={category} />
        {label}
      </Link>
    )
  }

  return (
    // `current` marks the one inert case that is a STATE rather than a missing
    // destination: this category is already the sole active filter. The other
    // inert cases (unknown slug, non-filterable 'other', embed locks) get no
    // aria-current — there is nothing to be current about. Deliberately NOT a
    // <Link replace> to the same URL (mints a fresh location.key, which changes
    // the scroll/pagination sessionStorage keys for no benefit) and NOT a
    // <Link> plus preventDefault (a screen reader would announce a link that
    // does nothing).
    <span className={cls} aria-current={target.current ? 'true' : undefined}>
      <CategoryIcon category={category} />
      {label}
    </span>
  )
}

/**
 * Analytics + scroll reset for a badge activation.
 *
 * Scroll: App.tsx's scroll-to-top effect depends on `location.pathname` ALONE,
 * on purpose (read the comment above it — adding navigationType or the location
 * key there caused a real regression). A badge click on a grid card is a
 * search-only PUSH on the SAME pathname, so that effect will not fire and the
 * visitor would land mid-grid on a freshly filtered list. Scroll here instead,
 * bailing on anything that is not a plain primary-button activation so
 * cmd/ctrl/shift-click and middle-click still open a new tab without yanking
 * the page the visitor is still reading. React Router runs this handler first
 * and skips navigating entirely if it calls preventDefault, so checking
 * defaultPrevented is sufficient. Inside an embed the scroll is a harmless
 * no-op (auto-height iframe; the parent page owns scrolling, cross-origin) —
 * the same accepted trade-off as EventPage's back-to-list.
 */
function handleBadgeClick(e: MouseEvent<HTMLAnchorElement>, category: string) {
  if (e.defaultPrevented) return
  // Defence only, and known to be unreachable: a middle click fires `auxclick`,
  // not `click`, so React's onClick never runs for it. Do not build anything
  // on this guard.
  if (e.button !== 0) return
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  // Tracking sits AFTER the guards on purpose, so the funnel counts in-tab
  // navigations consistently: previously a ctrl-click logged select_content
  // while a middle-click (auxclick, no handler at all) logged nothing, for two
  // outcomes the visitor experiences identically.
  //
  // select_content takes free-form strings, so the badge funnel needs no new
  // event name and no registry change. Deliberately NOT category_filter —
  // that event describes the filter-tray and hub funnels, and badge clicks
  // would pollute it.
  trackEvent(EVENTS.SELECT_CONTENT, { content_type: 'category_badge', item_id: category })
  window.scrollTo({ top: 0, behavior: 'instant' })
}

/**
 * FacetBadges — render the cross-cutting facet pills an event carries
 * (Family, Fundraiser) from its boolean flags.
 */
export function FacetBadges({ event }: { event?: AppEvent | null }) {
  const active: string[] = []
  if (event?.is_family) active.push('family')
  if (event?.is_fundraiser) active.push('fundraiser')
  return active.map((slug) => {
    const f = FACET_BY_SLUG[slug]
    return (
      <span key={slug} className={`event-tag tag-facet tag-facet--${slug}`}>
        {f.emoji} {f.label}
      </span>
    )
  })
}

/**
 * Category glyph rendered inside the badge. Uses the same SVG assets as the
 * card-accent gradients (CATEGORY_GLYPHS), tinted via CSS mask. Unknown slugs
 * fall back to a star.
 */
function CategoryIcon({ category }: { category: string }) {
  const svg = CATEGORY_GLYPHS[category]
  if (svg) {
    return (
      <span
        className="cat-glyph"
        aria-hidden="true"
        style={{ WebkitMaskImage: `url(${svg})`, maskImage: `url(${svg})` }}
      />
    )
  }
  // other / unknown — generic star
  return (
    <svg
      width={13} height={13} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="m12 3-2 6-6 2 6 2 2 6 2-6 6-2-6-2z"/>
    </svg>
  )
}
