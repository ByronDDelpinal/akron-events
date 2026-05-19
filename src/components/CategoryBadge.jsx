/**
 * CategoryBadge — single source of truth for category pills across the app.
 *
 * Owns three things that previously lived (duplicated) in EventCard,
 * EventPage, VenueDetailPage, and OrganizationDetailPage:
 *   - TAG_CLASS_MAP   — category → CSS class for tag colors
 *   - CATEGORY_LABEL  — category → human-readable label
 *   - CategoryIcon    — small SVG glyph providing a non-color identifier
 *                       (WCAG 1.4.1: don't rely on color alone)
 *
 * Pair with the gradient accent (GRADIENT_MAP) separately — that one
 * applies to the card/page accent strip and isn't strictly part of the
 * badge. Kept distinct so the two concerns can evolve independently.
 */

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

export default function CategoryBadge({ category, className = '' }) {
  const tagClass = TAG_CLASS_MAP[category] ?? 'tag-other'
  const label    = CATEGORY_LABEL[category] ?? category
  return (
    <span className={`event-tag ${tagClass}${className ? ' ' + className : ''}`}>
      <CategoryIcon category={category} />
      {label}
    </span>
  )
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
