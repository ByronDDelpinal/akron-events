/**
 * neighborhoods.ts
 *
 * Canonical list of City of Akron neighborhoods (24).
 *
 * This is the single source of truth shared by:
 *   - The admin venue editor dropdown (VenueEditPage)
 *   - The CategoryPage neighborhood matcher (eventMatchesNeighborhood)
 *   - The neighborhood hub registry in src/lib/seo/categories.js
 *   - The future PostGIS backfill script (docs/neighborhoods.md path #1)
 *
 * Keep this list in lockstep with the CHECK constraint in
 * supabase/migrations/028_venue_neighborhood_slug.sql — adding or
 * renaming a slug requires both a code change and a migration. The
 * list itself is read off the official City of Akron neighborhood map
 * (see docs/neighborhood-map.webp + docs/neighborhoods.md).
 *
 * Note: Cuyahoga Falls, Stow, Fairlawn (the city), and Copley are
 * separate Summit County municipalities, NOT Akron neighborhoods.
 * They live as city-level hubs in NEIGHBORHOOD_HUBS and are matched
 * via venues.city, not this slug.
 */

export interface Neighborhood {
  slug: string
  label: string
}

export const NEIGHBORHOODS: Neighborhood[] = [
  { slug: 'high-hampton',      label: 'High Hampton' },
  { slug: 'merriman-valley',   label: 'Merriman Valley' },
  { slug: 'northwest-akron',   label: 'Northwest Akron' },
  { slug: 'merriman-hills',    label: 'Merriman Hills' },
  { slug: 'fairlawn-heights',  label: 'Fairlawn Heights' },
  { slug: 'wallhaven',         label: 'Wallhaven' },
  { slug: 'west-akron',        label: 'West Akron' },
  { slug: 'highland-square',   label: 'Highland Square' },
  { slug: 'west-hill',         label: 'West Hill' },
  { slug: 'cascade-valley',    label: 'Cascade Valley' },
  { slug: 'sherbondy-hill',    label: 'Sherbondy Hill' },
  { slug: 'downtown-akron',    label: 'Downtown Akron' },
  { slug: 'university-park',   label: 'University Park' },
  { slug: 'middlebury',        label: 'Middlebury' },
  { slug: 'north-hill',        label: 'North Hill' },
  { slug: 'chapel-hill',       label: 'Chapel Hill' },
  { slug: 'goodyear-heights',  label: 'Goodyear Heights' },
  { slug: 'east-akron',        label: 'East Akron' },
  { slug: 'ellet',             label: 'Ellet' },
  { slug: 'summit-lake',       label: 'Summit Lake' },
  { slug: 'south-akron',       label: 'South Akron' },
  { slug: 'firestone-park',    label: 'Firestone Park' },
  { slug: 'kenmore',           label: 'Kenmore' },
  { slug: 'coventry-crossing', label: 'Coventry Crossing' },
]

/** Set of valid slugs for fast membership checks (hub matcher hot path). */
export const NEIGHBORHOOD_SLUGS = new Set<string>(NEIGHBORHOODS.map((n) => n.slug))

/** Slug → label lookup. */
export const NEIGHBORHOOD_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(NEIGHBORHOODS.map((n) => [n.slug, n.label])),
)

/** Convenience: dropdown-ready option objects ({ value, label }). */
export const NEIGHBORHOOD_OPTIONS = NEIGHBORHOODS.map((n) => ({
  value: n.slug,
  label: n.label,
}))
