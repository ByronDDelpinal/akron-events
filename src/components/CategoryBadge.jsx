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
 * Small SVG glyph rendered inside the badge. Inherits the badge's text
 * color via stroke="currentColor". Marked aria-hidden because the badge
 * already carries the readable label.
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
    case 'theater': return ( // drama mask
      <svg {...props}>
        <path d="M4 5h16v6a8 8 0 0 1-16 0Z"/>
        <path d="M8.5 9h.01"/>
        <path d="M15.5 9h.01"/>
        <path d="M9 13.5a4 4 0 0 0 6 0"/>
      </svg>
    )
    case 'film': return ( // film strip
      <svg {...props}>
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M7 3v18"/>
        <path d="M17 3v18"/>
        <path d="M3 7.5h4"/>
        <path d="M17 7.5h4"/>
        <path d="M3 12h18"/>
        <path d="M3 16.5h4"/>
        <path d="M17 16.5h4"/>
      </svg>
    )
    case 'comedy': return ( // laughing face
      <svg {...props}>
        <circle cx="12" cy="12" r="10"/>
        <path d="M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z"/>
        <path d="M9 9h.01"/>
        <path d="M15 9h.01"/>
      </svg>
    )
    case 'visual-art': return ( // paint brush
      <svg {...props}>
        <path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/>
        <path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7"/>
        <path d="M14.5 17.5 4.5 15"/>
      </svg>
    )
    case 'food': return ( // apple
      <svg {...props}>
        <path d="M12 7.5c-1.8-1.6-4.4-1.4-5.8.4-1.6 2-1.4 5.6.4 8.2C7.6 17.7 9 19.5 10.4 19.5c.6 0 .9-.3 1.6-.3s1 .3 1.6.3c1.4 0 2.8-1.8 3.8-3.4 1.8-2.6 2-6.2.4-8.2-1.4-1.8-4-2-5.8-.4Z"/>
        <path d="M12 7.5c.4-1.7 1.8-2.8 3.5-2.6"/>
      </svg>
    )
    case 'sports': return ( // baseball
      <svg {...props}>
        <circle cx="12" cy="12" r="9"/>
        <path d="M6.5 5.5c2 2 3 4 3 6.5s-1 4.5-3 6.5"/>
        <path d="M17.5 5.5c-2 2-3 4-3 6.5s1 4.5 3 6.5"/>
      </svg>
    )
    case 'fitness': return ( // dumbbell
      <svg {...props}>
        <path d="M4 7v10"/>
        <path d="M7 5v14"/>
        <path d="M7 12h10"/>
        <path d="M17 5v14"/>
        <path d="M20 7v10"/>
      </svg>
    )
    case 'outdoors': return ( // leaf
      <svg {...props}>
        <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/>
        <path d="M2 21c0-3 1.85-5.36 5.08-6"/>
      </svg>
    )
    case 'learning': return ( // pencil
      <svg {...props}>
        <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
        <path d="m15 5 4 4"/>
      </svg>
    )
    case 'festival': return ( // stage spotlights
      <svg {...props}>
        <path d="M3 6h18"/>
        <circle cx="7" cy="9" r="1.6"/>
        <circle cx="12" cy="9" r="1.6"/>
        <circle cx="17" cy="9" r="1.6"/>
        <path d="m6 11-2 9"/>
        <path d="M12 11v9"/>
        <path d="m18 11 2 9"/>
      </svg>
    )
    case 'market': return ( // market storefront
      <svg {...props}>
        <path d="M4 4h16l1.5 4.5H2.5z"/>
        <path d="M4.5 8.5V20h15V8.5"/>
        <path d="M10 20v-5h4v5"/>
      </svg>
    )
    case 'civic': return ( // city block / buildings
      <svg {...props}>
        <path d="M6 22V4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v18"/>
        <path d="M6 12H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/>
        <path d="M15 9h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2"/>
        <path d="M9 7h2"/>
        <path d="M9 11h2"/>
        <path d="M9 15h2"/>
      </svg>
    )
    default: return ( // other — star
      <svg {...props}>
        <path d="m12 3-2 6-6 2 6 2 2 6 2-6 6-2-6-2z"/>
      </svg>
    )
  }
}
