/**
 * CategoryBadge — single source of truth for category pills across the app.
 *
 * Owns:
 *   - CategoryIcon  — small SVG glyph providing a non-color identifier
 *                     (WCAG 1.4.1: don't rely on color alone)
 *
 * Display labels (CATEGORY_DISPLAY) and pill color classes (TAG_CLASS_MAP)
 * both come from the canonical taxonomy registry (@/lib/categories) so badge
 * copy and colors stay in sync with every other category-aware surface.
 */

import { CATEGORY_DISPLAY, TAG_CLASS_MAP, FACETS } from '@/lib/categories'

const FACET_BY_SLUG = Object.fromEntries(FACETS.map((f) => [f.slug, f]))

export default function CategoryBadge({ category, className = '' }) {
  const tagClass = TAG_CLASS_MAP[category] ?? 'tag-other'
  const label    = CATEGORY_DISPLAY[category] ?? category
  return (
    <span className={`event-tag ${tagClass}${className ? ' ' + className : ''}`}>
      <CategoryIcon category={category} />
      {label}
    </span>
  )
}

/**
 * CategoryBadges — render every content category an event carries (primary
 * first, up to 2, from the event_categories join table), with the secondary
 * de-emphasized. Falls back to the singular `category` shim. Shared by cards
 * and the event detail page so all surfaces stay in sync.
 */
export function CategoryBadges({ event }) {
  const cats = (event.categories?.length ? event.categories : [event.category])
    .filter(Boolean)
    .slice(0, 2)
  return cats.map((c, i) => (
    <CategoryBadge key={c} category={c} className={i > 0 ? 'event-tag--secondary' : ''} />
  ))
}

/**
 * FacetBadges — render the cross-cutting facet pills an event carries
 * (Family, Fundraiser) from its boolean flags. Labels/emoji come from the
 * canonical FACETS registry. Renders nothing when no facet is set.
 */
export function FacetBadges({ event }) {
  const active = []
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
 * Category glyph rendered inside the badge. Uses the SAME SVG assets as the
 * card-accent gradients (in /public), tinted to the badge's text color via a
 * CSS mask, so the pill icon and the card icon are identical. 'other' (and any
 * unknown slug) falls back to a small inline star.
 */
const GLYPH_SVG = {
  music:        '/music-note.svg',
  theater:      '/theater.svg',
  film:         '/film.svg',
  comedy:       '/laugh.svg',
  'visual-art': '/paint-brush.svg',
  food:         '/apple.svg',
  sports:       '/baseball.svg',
  fitness:      '/weight.svg',
  outdoors:     '/leaf.svg',
  learning:     '/pencil.svg',
  festival:     '/sportlights.svg',
  market:       '/market-store.svg',
  civic:        '/city-block.svg',
}

function CategoryIcon({ category }) {
  const svg = GLYPH_SVG[category]
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
