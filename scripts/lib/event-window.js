/**
 * event-window.js — shared ingestion-window filter for calendar scrapers.
 *
 * Five municipal scrapers (Bath Township, Richfield Township, Village of
 * Northfield, Village of Peninsula, Village of Reminderville) each carried a
 * byte-identical `isWithinWindow` implementation differing only in their
 * `HORIZON_DAYS` constant. This module is the single definition; each scraper
 * builds its own filter from its own horizon.
 *
 * The horizon stays a per-scraper parameter on purpose. Peninsula publishes a
 * full year out (365) while the other four use the project's usual 180-day
 * window, so a hardcoded horizon here would silently drop nine months of
 * Peninsula events. If you are tempted to collapse them to one number, that is
 * a product decision about each calendar's publishing habits, not a refactor.
 */

/** One day in milliseconds. */
export const DAY_MS = 86_400_000

/**
 * Build an ingestion-window predicate.
 *
 * The returned function keeps the exact `(startUtc, endUtc, nowMs)` signature
 * the scrapers already exported, so their unit tests call it unchanged.
 *
 * @param {object}  options
 * @param {number}  options.horizonDays   Forward horizon in days. Required —
 *   there is no sensible default (see the module note above).
 * @param {number} [options.pastGraceMs]  How long an already-ended event stays
 *   eligible. Defaults to one day so same-day events survive until midnight ET.
 * @returns {(startUtc: string|null, endUtc: string|null, nowMs?: number) => boolean}
 */
export function makeWindowFilter({ horizonDays, pastGraceMs = DAY_MS } = {}) {
  if (!Number.isFinite(horizonDays) || horizonDays <= 0) {
    throw new TypeError(`makeWindowFilter: horizonDays must be a positive number, got ${horizonDays}`)
  }

  /** True when the event's window overlaps [now - grace, now + horizon]. */
  return function isWithinWindow(startUtc, endUtc, nowMs = Date.now()) {
    if (!startUtc) return false
    const startMs = new Date(startUtc).getTime()
    const endMs = endUtc ? new Date(endUtc).getTime() : startMs
    if (Number.isNaN(startMs)) return false
    if (endMs < nowMs - pastGraceMs) return false
    if (startMs > nowMs + horizonDays * DAY_MS) return false
    return true
  }
}
