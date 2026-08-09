/**
 * festivals.ts
 *
 * Tiny static registry of festival hub pages (/festival/:slug). A festival
 * hub is a per-tag schedule view over ordinary event rows — discovery is by
 * the `tag` below (GIN-indexed events.tags), so adding next year's festival
 * is one entry here plus a new data file for the importer; no schema work.
 * Unknown slugs render not-found (see src/pages/FestivalPage.tsx).
 *
 * mapBounds uses the same [west, south, east, north] BBox shape as
 * planMapPoints.ts / neighborhoodGeo.ts. landmarks feed the (optional) SVG
 * festival map; an empty list simply renders no landmark layer — never
 * invent coordinates to fill it.
 */

export type FestivalBBox = [number, number, number, number]

export interface FestivalLandmark {
  name: string
  lat: number
  lng: number
}

export interface Festival {
  slug: string
  name: string
  /** Eastern calendar date of the festival day, 'yyyy-MM-dd'. Compare via
   *  dayPlanDate.ts's easternDateKey/easternTodayIso — never a UTC-derived
   *  "today", never a Date-vs-string compare. */
  dateKey: string
  /** events.tags value that marks every row belonging to this festival
   *  (per-set events AND the umbrella, which additionally carries
   *  'festival-umbrella'). */
  tag: string
  mapBounds: FestivalBBox
  landmarks: FestivalLandmark[]
  website?: string
}

export const FESTIVALS: Festival[] = [
  {
    slug: 'porchrokr-2026',
    name: 'PorchRokr Music & Arts Festival',
    dateKey: '2026-08-15',
    tag: 'porchrokr-2026',
    // Highland Square box from the PorchRokr ADR (lat 41.08..41.11,
    // lng -81.56..-81.51) — mirrors HS_BBOX in scripts/import-porchrokr.js.
    mapBounds: [-81.56, 41.08, -81.51, 41.11],
    // Populated once porch coordinates are geocoded and eyeballed; empty on
    // purpose until then (no invented coordinates).
    landmarks: [],
    website: 'https://www.highlandsquareakron.org/',
  },
]

export function festivalBySlug(slug: string | undefined): Festival | null {
  if (!slug) return null
  return FESTIVALS.find((f) => f.slug === slug) ?? null
}
