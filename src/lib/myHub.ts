/**
 * "My Neighborhood" memory for the PWA app shortcut.
 *
 * Manifest shortcuts are static (frozen at install time, same for every
 * user), so per-user personalization works through indirection: the
 * shortcut points at /go/neighborhood, and this module remembers the
 * locality hub (neighborhood OR suburb city) the visitor most recently
 * viewed. CategoryPage writes it; the /go/neighborhood route reads it
 * and redirects. Device-local by design — the site has no accounts.
 */

import { NEIGHBORHOOD_LABELS } from '@/lib/neighborhoods'
import { CITY_LABELS, REGION_LABELS } from '@/lib/cities'

const MY_HUB_KEY = 'akronpulse.my_hub'

export function rememberMyHub(slug: string): void {
  try {
    localStorage.setItem(MY_HUB_KEY, slug)
  } catch { /* private mode etc. — feature simply stays cold */ }
}

export function getMyHubSlug(): string | null {
  try {
    const slug = localStorage.getItem(MY_HUB_KEY)
    // Slug sanity check only; if a stored hub has since been disabled,
    // CategoryPage redirects to the homepage, which is the same place
    // first-time users land.
    return slug && /^[a-z0-9-]+$/.test(slug) ? slug : null
  } catch {
    return null
  }
}

/** Forget the saved hub (the "Clear my neighborhood" action). */
export function clearMyHub(): void {
  try {
    localStorage.removeItem(MY_HUB_KEY)
  } catch { /* nothing to clear if storage is unavailable */ }
}

/**
 * Resolve a hub slug to its display label. Covers everything a saved hub
 * can be: an Akron neighborhood, a Summit County city, or a regional
 * rollup. Returns null for an unknown slug (e.g. a hub since removed),
 * so callers can fall back to a generic label.
 */
export function getHubLabel(slug: string | null): string | null {
  if (!slug) return null
  return (
    NEIGHBORHOOD_LABELS[slug] ??
    CITY_LABELS[slug] ??
    REGION_LABELS[slug] ??
    null
  )
}
