/**
 * Shared normalization utilities for ingestion scripts.
 * Each source maps its raw data into this common shape before upsert.
 */

// Eventbrite category ID → our category enum
export const EVENTBRITE_CATEGORY_MAP = {
  '103': 'music',        // Music
  '105': 'art',          // Performing & Visual Arts
  '110': 'food',         // Food & Drink
  '113': 'community',    // Community & Culture
  '115': 'nonprofit',    // Charity & Causes
  '107': 'sports',       // Health & Wellness
  '102': 'education',    // Science & Technology
  '101': 'education',    // Business & Professional
  '108': 'sports',       // Sports & Fitness
  '104': 'art',          // Film, Media & Entertainment
  '109': 'community',    // Travel & Outdoor
  '111': 'community',    // Government & Politics
  '112': 'education',    // Education
  '114': 'community',    // Family & Education (catch-all)
}

/**
 * Parse Eventbrite ticket_classes into price_min / price_max.
 * Returns { price_min: number, price_max: number|null }
 */
export function parseEventbritePrice(ticketClasses = [], isFree = false) {
  if (isFree) return { price_min: 0, price_max: 0 }

  const prices = ticketClasses
    .filter(tc => !tc.free && tc.cost?.major_value != null)
    .map(tc => parseFloat(tc.cost.major_value))
    .filter(p => !isNaN(p) && p > 0)

  if (prices.length === 0) return { price_min: 0, price_max: null }

  const min = Math.min(...prices)
  const max = Math.max(...prices)
  return {
    price_min: min,
    price_max: max > min ? max : null,
  }
}

/**
 * Log a summary of an upsert result.
 */
export function logUpsertResult(source, inserted, updated, skipped) {
  console.log(`[${source}] ✓ ${inserted} inserted  ${updated} updated  ${skipped} skipped`)
}
