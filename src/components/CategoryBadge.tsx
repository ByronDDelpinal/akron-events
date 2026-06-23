/**
 * CategoryBadge — single source of truth for category pills across the app.
 *
 * Display labels (CATEGORY_DISPLAY) and pill color classes (TAG_CLASS_MAP)
 * both come from the canonical taxonomy registry (@/lib/categories) so badge
 * copy and colors stay in sync with every other category-aware surface.
 */

import { CATEGORY_DISPLAY, TAG_CLASS_MAP, FACETS } from '@/lib/categories'
import { CATEGORY_GLYPHS } from '@/lib/categoryGlyphs'
import type { AppEvent } from '@/hooks/useEvents'

interface FacetDef { slug: string; emoji: string; label: string }

const FACET_BY_SLUG: Record<string, FacetDef> = Object.fromEntries(
  FACETS.map((f) => [f.slug, f]),
)

// The taxonomy maps are authored in plain JS; widen to a string index here.
const TAG_CLASS = TAG_CLASS_MAP as Record<string, string>
const CAT_DISPLAY = CATEGORY_DISPLAY as Record<string, string>

interface CategoryBadgeProps {
  category: string
  className?: string
}

export default function CategoryBadge({ category, className = '' }: CategoryBadgeProps) {
  const tagClass = TAG_CLASS[category] ?? 'tag-other'
  const label    = CAT_DISPLAY[category] ?? category
  return (
    <span className={`event-tag ${tagClass}${className ? ' ' + className : ''}`}>
      <CategoryIcon category={category} />
      {label}
    </span>
  )
}

/**
 * CategoryBadges — render every content category an event carries (primary
 * first, up to 2), with the secondary de-emphasized.
 */
export function CategoryBadges({ event }: { event: AppEvent }) {
  const cats = (event.categories?.length ? event.categories : [event.category])
    .filter(Boolean)
    .slice(0, 2)
  return cats.map((c: string, i: number) => (
    <CategoryBadge key={c} category={c} className={i > 0 ? 'event-tag--secondary' : ''} />
  ))
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
