/**
 * cities.js
 *
 * Canonical list of Summit County, Ohio cities surfaced as Akron Pulse
 * hubs. Mirrors src/lib/neighborhoods.js: one source of truth for the
 * slug ↔ display name mapping, shared by:
 *
 *   - The city / county hub registry in src/lib/seo/categories.js
 *   - The SummitCountyMap component (matches GeoJSON features by slug)
 *   - scripts/convert-summit-cities.js (the offline GeoJSON builder)
 *
 * Scope is the 14 major incorporated places in Summit County. Smaller
 * villages (Boston Heights, Lakemore, Mogadore, Peninsula, Richfield,
 * Silver Lake, etc.) aren't included here — adding them later is a
 * pure data + content task: append to this list and re-run the
 * conversion script.
 *
 * Names match the NAME field in the US Census TIGER/Line Places
 * shapefile (`tl_2025_39_place`). The converter throws on any
 * mismatch so drift fails the build loudly rather than silently
 * dropping a polygon.
 */

export const CITIES = [
  { slug: 'akron',           label: 'Akron'           },
  { slug: 'cuyahoga-falls',  label: 'Cuyahoga Falls'  },
  { slug: 'stow',            label: 'Stow'            },
  { slug: 'hudson',          label: 'Hudson'          },
  { slug: 'green',           label: 'Green'           },
  { slug: 'fairlawn',        label: 'Fairlawn'        },
  { slug: 'tallmadge',       label: 'Tallmadge'       },
  { slug: 'barberton',       label: 'Barberton'       },
  { slug: 'new-franklin',    label: 'New Franklin'    },
]

/** Set of valid slugs for fast membership checks. */
export const CITY_SLUGS = new Set(CITIES.map((c) => c.slug))

/** Slug → display label lookup. */
export const CITY_LABELS = Object.freeze(
  Object.fromEntries(CITIES.map((c) => [c.slug, c.label])),
)

/** Convenience: dropdown-ready { value, label } pairs. */
export const CITY_OPTIONS = CITIES.map((c) => ({ value: c.slug, label: c.label }))

/**
 * The Akron city slug — called out separately because Akron is the
 * only city in the set that has a neighborhood drill-down. The
 * CategoryPage hero renders the NeighborhoodMap (not the
 * SummitCountyMap) on `/events/akron`, and Akron-neighborhood hubs
 * use it as their breadcrumb parent ("Home > Akron > Highland Square").
 */
export const AKRON_SLUG = 'akron'
export const AKRON_LABEL = 'Akron'

/**
 * Regional rollups — every Summit County township/village that
 * doesn't have its own city hub gets folded into one of these three
 * quadrants. The SummitCountyMap renders them as MultiPolygon
 * features alongside the 14 cities so the map shows the complete
 * county shape rather than islands of incorporated places floating
 * in empty space.
 *
 * Each region is a clickable hub on its own (`/events/{slug}`) and
 * matches events whose venue.city falls inside its constituent
 * townships and villages — see CITY_HUBS in src/lib/seo/categories.js
 * for the per-region cityMatch arrays.
 *
 * Region → township/village assignments live in
 * scripts/convert-summit-cities.js (TOWNSHIP_REGION + VILLAGE_REGION).
 */
export const REGIONS = [
  { slug: 'northwest-summit-county', label: 'Northwest Summit County' },
  { slug: 'northeast-summit-county', label: 'Northeast Summit County' },
  { slug: 'southeast-summit-county', label: 'Southeast Summit County' },
]

export const REGION_SLUGS  = new Set(REGIONS.map((r) => r.slug))
export const REGION_LABELS = Object.freeze(
  Object.fromEntries(REGIONS.map((r) => [r.slug, r.label])),
)

/**
 * Combined slug → label lookup for everything that can appear on the
 * Summit County map: the 14 individual cities plus the 3 regional
 * rollups. SummitCountyMap.jsx reads from this so the panel can
 * display either kind of name without branching.
 */
export const PLACE_LABELS = Object.freeze({
  ...CITY_LABELS,
  ...REGION_LABELS,
})
