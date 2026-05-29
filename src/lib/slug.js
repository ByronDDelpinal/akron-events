/**
 * Event URL slugs.
 *
 * Slugs are *decorative* — the canonical event URL pairs the slug with
 * the event's UUID:
 *
 *   /events/{slug}/{id}
 *
 * The ID is the source of truth for lookups. The slug is computed from
 * the event's title + start date, so:
 *
 *   - Renames on the source side (scraper updates a title) produce a
 *     new slug, and EventPage 301-redirects stale URLs to the new
 *     canonical form. No slug history table needed.
 *
 *   - Recurring events ("Jazz Night" every Tuesday) get different
 *     slugs because the month/day suffix disambiguates them.
 *
 *   - Two events with literally identical title + date still share a
 *     slug but resolve to different URLs via their distinct UUIDs.
 *
 * Keep this file dependency-light: it's imported by sitemap generation
 * (Node), schema.org JSON-LD (browser), and every event link in the UI.
 */

import { format } from 'date-fns'

// Reserved first-segments under /events/ — if a slug happens to match
// one of these, prefix it so the router never confuses a slug for a
// known sub-route. There are no /events/* sub-routes today, but this
// future-proofs us against, e.g., adding /events/featured later.
const RESERVED_SLUGS = new Set(['submit', 'new', 'edit', 'featured'])

/**
 * Build a stable, URL-safe slug for an event.
 *
 * Format: `{kebab-title}-{mmm}-{d}` — e.g. `cardboard-garden-may-28`.
 * Falls back to `event` if the title is missing or fully strips out.
 *
 * @param {object} event - must have `title`; `start_at` optional but
 *   recommended (the date suffix is what disambiguates recurrences).
 * @returns {string}
 */
export function makeEventSlug(event) {
  const rawTitle = String(event?.title || 'event')
  const start = event?.start_at ? new Date(event.start_at) : null

  // Normalize to NFD so accented characters split into base + combining
  // mark, then strip the combining-mark block (U+0300–U+036F). This
  // turns "Café" into "cafe" instead of dropping it as non-ASCII later.
  let titlePart = rawTitle
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')     // drop punctuation, emoji, etc.
    .trim()
    .replace(/[\s-]+/g, '-')           // whitespace/hyphens → single hyphen
    .replace(/^-+|-+$/g, '')           // trim edge hyphens
    .slice(0, 80)                      // hard cap before re-trim
    .replace(/-+$/g, '')               // trim again in case slice cut mid-hyphen

  if (!titlePart) titlePart = 'event'
  if (RESERVED_SLUGS.has(titlePart)) titlePart = `evt-${titlePart}`

  if (start && !Number.isNaN(start.getTime())) {
    const datePart = format(start, 'MMM-d').toLowerCase()
    return `${titlePart}-${datePart}`
  }

  return titlePart
}

/**
 * Canonical pathname for an event detail page.
 *
 * Slug-first, ID trailing: `/events/{slug}/{id}`. Falls back to the
 * site root if the event has no ID (defensive — shouldn't happen in
 * normal flows).
 *
 * @param {object} event - needs `id`, `title`, and `start_at`.
 * @returns {string}
 */
export function eventPath(event) {
  if (!event?.id) return '/'
  return `/events/${makeEventSlug(event)}/${event.id}`
}
