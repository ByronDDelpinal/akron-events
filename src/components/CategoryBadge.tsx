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
import {
  resolveCategoryBadgeHref,
  shouldScrollToGrid,
  BROWSE_RESULTS_ID,
  type CategoryBadgeHref,
} from '@/lib/categoryHref'
import { useEmbed } from '@/hooks/useEmbed'
import { prefersReducedMotion } from '@/lib/feedback'
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
  return cats.map((c: string, i: number) => {
    // One ctx, one resolve, one predicate — evaluated HERE because this is the
    // component that holds `embed` (BadgePill and the click handler do not,
    // and the embed exclusion must be explicit; see shouldScrollToGrid).
    const ctx = { pathname, search, embed, tags: event.tags }
    const target = resolveCategoryBadgeHref(c, ctx)
    return (
      <BadgePill
        key={c}
        category={c}
        className={i > 0 ? 'event-tag--secondary' : ''}
        target={target}
        scrollToGrid={shouldScrollToGrid(target, ctx)}
      />
    )
  })
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
  scrollToGrid = false,
}: CategoryBadgeProps & { target: CategoryBadgeHref; scrollToGrid?: boolean }) {
  const tagClass = TAG_CLASS[category] ?? 'tag-other'
  const label    = CAT_DISPLAY[category] ?? category
  const cls      = `event-tag ${tagClass}${className ? ' ' + className : ''}`

  if (target.kind === 'link') {
    return (
      <Link
        to={target.href}
        // `pressable` (globals.css) rides on the LINKED branch only. The inert
        // <span> below deliberately does not get it: EventCard.css gives that
        // pill `cursor: default` precisely so it stops advertising
        // interactivity, and a pill that depresses under the finger would put
        // the promise straight back.
        className={`${cls} pressable`}
        aria-label={`Browse ${label} events`}
        onClick={(e) => handleBadgeClick(e, category, scrollToGrid)}
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
 * Analytics + the post-click scroll for a badge activation.
 *
 * WHY A SCROLL AT ALL. App.tsx's scroll-to-top effect depends on
 * `location.pathname` ALONE, on purpose (read the comment above it — adding
 * navigationType or the location key there caused a real regression). A badge
 * click on a grid card is a search-only PUSH on the SAME pathname, so that
 * effect will not fire and the visitor would be left mid-grid on a freshly
 * filtered list with no sign anything happened.
 *
 * WHY THE GRID AND NOT THE PAGE TOP. This used to be
 * `window.scrollTo({ top: 0, behavior: 'instant' })` — a hard jump past the
 * hero to a viewport with no results in it, which is the complaint. Scroll the
 * BROWSE REGION into view instead, smoothly, so the motion itself carries the
 * "your list changed" message. `BROWSE_RESULTS_ID` is HomePage's stable
 * wrapper around EventsBrowser; do not reach for `.cards-grid`, which is one
 * element PER DATE GROUP and is destroyed by this very navigation. FilterBar
 * renders inside that wrapper, so landing at its top puts the filter bar where
 * it sticks with the first date heading and card row beneath it. The offset
 * lives in HomePage.css as `scroll-margin-top`, not in arithmetic here.
 *
 * WHY NO ANIMATION ON THE BADGE ITSELF. After this navigation the URL IS the
 * href this badge computed, so resolveCategoryBadgeHref returns the
 * already-the-sole-filter inert case, BadgePill swaps <Link> for <span>, and
 * React unmounts the node the visitor pressed — in the same commit. A
 * post-click animation here would not flicker, it would never render. The
 * observable feedback is the `pressable` :active depress (which happens
 * BEFORE the navigation, always), then the grid's own refresh dimming, this
 * scroll, and the staggered card entrance.
 *
 * WHY rAF. The location must have changed before the scroll starts, so
 * App.tsx's scroll-persistence key has rotated to the NEW history entry;
 * otherwise the first frames of a smooth animation get written over the
 * previous entry's saved position and Back lands wrong on the page the
 * visitor just left. Same reason and same shape as HomePage's search-commit
 * scroll.
 *
 * GUARDS. Bail on anything that is not a plain primary-button activation so
 * cmd/ctrl/shift-click and middle-click still open a new tab without yanking
 * the page the visitor is still reading. React Router runs this handler first
 * and skips navigating entirely if it calls preventDefault, so checking
 * defaultPrevented is sufficient.
 *
 * `scrollToGrid` is decided by the caller (CategoryBadges), which is the
 * component that can see the embed — see shouldScrollToGrid for why the embed
 * is excluded by an explicit rule rather than left as a presumed no-op.
 */
function handleBadgeClick(
  e: MouseEvent<HTMLAnchorElement>,
  category: string,
  scrollToGrid: boolean,
) {
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
  if (!scrollToGrid) return
  // 'instant', never 'auto': per CSSOM-View 'auto' defers to the scrolling
  // box's computed scroll-behavior, which globals.css sets to `smooth` — so
  // the `reduced ? 'auto' : 'smooth'` idiom used elsewhere in this codebase
  // animates in both branches. Only 'instant' forces the jump.
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'instant' : 'smooth'
  requestAnimationFrame(() => {
    document.getElementById(BROWSE_RESULTS_ID)?.scrollIntoView({ block: 'start', behavior })
  })
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
