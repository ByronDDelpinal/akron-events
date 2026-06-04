/**
 * eventFormatting.js
 *
 * Single source of truth for the formatters and lookup maps used across
 * every event-rendering surface (EventCard, EventPage, VenueDetailPage,
 * OrganizationDetailPage, MapView, RelatedEvents, VenuesPage,
 * CategoryBadge). Before this module existed, these helpers were copy-
 * pasted across 5+ files and had already drifted out of sync (parking
 * labels notably).
 *
 * Keep this file pure (no React imports) so it stays trivially testable
 * and tree-shake-friendly.
 */

import { format, isToday, isTomorrow } from 'date-fns'

// ──────────────────────────────────────────────────────────────────────
// Price
// ──────────────────────────────────────────────────────────────────────

/**
 * Format an event's price range for a card / detail-page pill.
 *
 * Return shape: { label, free }
 *   - `label` is the human-readable string ("Free", "$25", "$10–$25",
 *     "See tickets").
 *   - `free` is true only when the event is explicitly free — useful
 *     for callers that want to apply a "free" accent style.
 *
 * Inputs are tolerant: null/undefined for either bound is fine. We
 * specifically treat `min === 0 && (!max || max === 0)` as free so
 * scrapers that emit `price_max: 0` for free events still render Free
 * (not "$0").
 */
export function formatPrice(min, max) {
  if (min == null && max == null) return { label: 'See tickets', free: false }
  if (min === 0 && (!max || max === 0)) return { label: 'Free', free: true }
  if (max && max > min) return { label: `$${min}–$${max}`, free: false }
  return { label: `$${min}`, free: false }
}

// ──────────────────────────────────────────────────────────────────────
// Date
// ──────────────────────────────────────────────────────────────────────

/**
 * Card-friendly date string for an event's `start_at`.
 *
 *   Today      → "Today · 7:30 PM"
 *   Tomorrow   → "Tomorrow · 7:30 PM"
 *   Otherwise  → "Sat, Jun 14 · 7:30 PM"
 *
 * Same format the listings use; centralized so a future change to
 * include the year or drop the weekday is a one-file edit.
 */
export function formatEventDate(dateStr) {
  const d = new Date(dateStr)
  if (isToday(d))    return `Today · ${format(d, 'h:mm a')}`
  if (isTomorrow(d)) return `Tomorrow · ${format(d, 'h:mm a')}`
  return format(d, 'EEE, MMM d · h:mm a')
}

// ──────────────────────────────────────────────────────────────────────
// Category lookups (gradients, labels, prose)
// ──────────────────────────────────────────────────────────────────────
//
// These now live in the canonical taxonomy registry (src/lib/categories.js)
// so the filter tray, admin editor, badges, and prose all share one
// definition. Re-exported here under their historical names so the many
// existing `import { CATEGORY_DISPLAY, GRADIENT_MAP, ... } from
// '@/lib/eventFormatting'` call sites keep working unchanged.
export {
  GRADIENT_MAP,
  CATEGORY_DISPLAY,
  CATEGORY_SHORT,
  gradientFor,
} from './categories.js'

// ──────────────────────────────────────────────────────────────────────
// Venue parking
// ──────────────────────────────────────────────────────────────────────

/**
 * Human-readable parking labels. Pre-consolidation, this map existed
 * in three files with subtly different copy ("Parking lot" vs.
 * "Parking lot nearby"). The "nearby" suffix is canonical because it
 * reads correctly on both event pages (parking near the event) and
 * venue pages (parking near the venue entrance).
 *
 * `unknown` resolves to a human-friendly note. Callers that want to
 * suppress unknown entirely should check `venue.parking_type === 'unknown'`
 * before rendering.
 */
export const PARKING_LABEL = Object.freeze({
  street:  'Street parking',
  lot:     'Parking lot nearby',
  garage:  'Parking garage nearby',
  none:    'No dedicated parking',
  unknown: 'Parking info unavailable',
})

// ──────────────────────────────────────────────────────────────────────
// Age restriction
// ──────────────────────────────────────────────────────────────────────

/**
 * Display labels for the `events.age_restriction` enum. Callers that
 * want a "no age restriction" affordance should check for
 * `'not_specified'` before looking up.
 */
export const AGE_LABEL = Object.freeze({
  all_ages: 'All ages',
  '18_plus': '18+',
  '21_plus': '21+',
})

// ──────────────────────────────────────────────────────────────────────
// Image URL validation
// ──────────────────────────────────────────────────────────────────────

/**
 * Returns true if `url` is a non-empty http(s) URL we can render.
 * Filters out null / undefined / blob: / data: / relative paths and
 * anything else a scraper might emit as a placeholder.
 */
export function isUsableImageUrl(url) {
  return !!url && /^https?:\/\//i.test(url)
}

/**
 * Resolve the best image URL to use for an event, walking the
 * fallback chain agreed in the May 2026 product discussion:
 *
 *   1. Event-specific image (`event.image_url`)
 *   2. Venue's primary image (`event.venue.image_url`)
 *   3. Organizer's primary image (`event.organizer.image_url`)
 *
 * Returns `null` when none of the three resolves to a usable URL.
 * Use this everywhere an event renders an image so the priority
 * order stays consistent — EventCard, EventPage banner / float,
 * VenueDetailPage event list, OrganizationDetailPage event list,
 * and the JSON-LD Event schema.
 *
 * `extras` is optional and lets a caller layer additional fallbacks
 * (e.g. VenueDetailPage knows the venue context even when the join
 * didn't carry it on the event row, and can pass it explicitly).
 * Order is event > venue > organizer > extras.
 */
export function imageUrlForEvent(event, extras = {}) {
  if (!event) return null
  const candidates = [
    event.image_url,
    event.venue?.image_url,
    event.venues?.[0]?.image_url,
    event.organizer?.image_url,
    event.organizations?.[0]?.image_url,
    extras.venueImageUrl,
    extras.organizerImageUrl,
  ]
  for (const url of candidates) {
    if (isUsableImageUrl(url)) return url
  }
  return null
}

/**
 * Same chain as `imageUrlForEvent`, but reports which source the
 * resolved URL came from. Useful when downstream code needs to know
 * whether to render with native event-image dimensions (only safe
 * when the source is the event itself — venue/org images don't have
 * `image_width`/`image_height` recorded on the event row).
 *
 * Returns `{ url, source }` where `source` is one of:
 *   'event' | 'venue' | 'organizer' | 'extras' | null
 */
export function resolveEventImage(event, extras = {}) {
  if (!event) return { url: null, source: null }
  const tries = [
    ['event',     event.image_url],
    ['venue',     event.venue?.image_url || event.venues?.[0]?.image_url],
    ['organizer', event.organizer?.image_url || event.organizations?.[0]?.image_url],
    ['extras',    extras.venueImageUrl || extras.organizerImageUrl],
  ]
  for (const [source, url] of tries) {
    if (isUsableImageUrl(url)) return { url, source }
  }
  return { url: null, source: null }
}
