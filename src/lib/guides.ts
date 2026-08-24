/**
 * guides.ts
 *
 * Types and lookup helpers over the GUIDES registry that drives /guides and
 * /guides/:slug. The DATA lives in ./guidesData.js (plain JS, zero imports)
 * so api/sitemap.xml.js and scripts/prerender.js can read the same array;
 * this file is what gives it types. Deliberately NOT named guides.js, see
 * that file's header for the resolver trap.
 *
 * Node-testable and DOM-free, following the festivals.ts precedent, so
 * scripts/tests/test-guides-page-guards.js can read the registry directly.
 */

import { GUIDES as RAW_GUIDES } from './guidesData.js'

/** Which audience a guide is written for. The hub renders one section each. */
export type GuideTrack = 'using' | 'organizers'

export interface Guide {
  slug: string
  track: GuideTrack
  /** Position within its track on the hub. Unique per track. */
  order: number
  title: string
  seoTitle: string
  metaDescription: string
  blurb: string
  /** Human runtime for the video, e.g. "3 min". Display text only. */
  durationLabel: string
  /** Slugs shown in the related list. Falls back to same-track neighbors. */
  related?: string[]
  /** All four video fields are null until the video is shot and uploaded.
   *  Filling them in guidesData.js is the entire go-live change. */
  youtubeId: string | null
  posterSrc: string | null
  /** ISO date, required before VideoObject will emit. */
  uploadDate: string | null
  /** ISO 8601 duration, e.g. 'PT3M20S'. Optional even once a video exists. */
  durationIso: string | null
}

// The explicit annotation is load-bearing: it is what makes a malformed entry
// in guidesData.js (missing field, wrong shape) fail `npm run typecheck` even
// though the data itself lives in a plain-JS file. `track` is the one field
// that has to be narrowed by hand: TypeScript infers plain `string` from the
// .js literal and will not accept it for a union. Every other field keeps its
// compile-time check, and the legal values of `track` are asserted at test
// time by scripts/tests/test-guides-page-guards.js.
export const GUIDES: Guide[] = RAW_GUIDES.map((g) => ({ ...g, track: g.track as GuideTrack }))

export const TRACK_LABELS: Record<GuideTrack, string> = {
  using: 'Using Akron Pulse',
  organizers: 'For organizers and partners',
}

/** Anchor ids for the hub's two sections. The footer links to these. */
export const TRACK_ANCHORS: Record<GuideTrack, string> = {
  using: 'using-akron-pulse',
  organizers: 'for-organizers',
}

export function guideBySlug(slug: string | undefined): Guide | null {
  if (!slug) return null
  return GUIDES.find((g) => g.slug === slug) ?? null
}

export function guidesByTrack(track: GuideTrack, registry: Guide[] = GUIDES): Guide[] {
  return registry.filter((g) => g.track === track).sort((a, b) => a.order - b.order)
}

/**
 * Up to two related guides. Uses the explicit `related` list when the entry
 * has one, otherwise the next guides in the same track, wrapping around, so
 * a guide is never a dead end even if nobody curated its list.
 */
export function relatedGuides(guide: Guide, registry: Guide[] = GUIDES): Guide[] {
  if (guide.related?.length) {
    const seen = new Set<string>()
    const curated = guide.related
      .map((slug) => registry.find((g) => g.slug === slug))
      .filter((g): g is Guide => g !== undefined && g.slug !== guide.slug)
      // Dedupe: a repeated slug in `related` would otherwise render two cards
      // with the same React key.
      .filter((g) => !seen.has(g.slug) && (seen.add(g.slug), true))
      .slice(0, 2)
    // Fall through rather than returning an empty list, so a `related` entry
    // that has been renamed away leaves the reader with somewhere to go.
    if (curated.length > 0) return curated
  }
  const siblings = guidesByTrack(guide.track, registry).filter((g) => g.slug !== guide.slug)
  const startAt = siblings.findIndex((g) => g.order > guide.order)
  const ordered = startAt === -1 ? siblings : [...siblings.slice(startAt), ...siblings.slice(0, startAt)]
  return ordered.slice(0, 2)
}
