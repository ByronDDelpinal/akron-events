/**
 * Shared normalization utilities for ingestion scripts.
 * Each source maps its raw data into this common shape before upsert.
 */

import { supabaseAdmin } from './supabase-admin.js'

/**
 * Strip HTML tags and decode ALL HTML entities from a string.
 *
 * Handles:
 *   • Named entities: &amp; &nbsp; &lt; &gt; &quot; &apos;
 *   • Decimal numeric entities: &#038; &#160; &#8217; …
 *   • Hex numeric entities: &#x26; &#xA0; …
 *
 * WordPress (and many CMSes) frequently encodes & as &#038; in
 * titles/content — the old approach of hard-coding specific entities
 * missed this entire class of encoding.
 */
export function stripHtml(html = '') {
  return html
    // 1. Remove all tags first
    .replace(/<[^>]*>/g, ' ')
    // 2. Decode ALL decimal numeric entities (e.g. &#038; → &)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    // 3. Decode ALL hex numeric entities (e.g. &#x26; → &)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // 4. Decode common named entities
    .replace(/&amp;/g,  '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // 5. Normalize curly/smart quotes to straight ASCII
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    // 6. Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

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
 * Log a summary of an upsert result to the console AND write a row to
 * the scraper_runs table for health monitoring.
 *
 * @param {string}  source      - scraper identifier (e.g. 'summit_artspace')
 * @param {number}  inserted    - new rows created
 * @param {number}  updated     - existing rows updated
 * @param {number}  skipped     - rows that failed or were intentionally skipped
 * @param {object}  [opts]
 * @param {string}  [opts.status='success'] - 'success' | 'error'
 * @param {string}  [opts.errorMessage]     - set when status='error'
 * @param {number}  [opts.durationMs]       - wall-clock ms for the full run
 * @param {number}  [opts.eventsFound]      - total events seen from the source
 *                                           (defaults to inserted + updated + skipped)
 */
export async function logUpsertResult(source, inserted, updated, skipped, opts = {}) {
  const {
    status       = 'success',
    errorMessage = null,
    durationMs   = null,
  } = opts

  const eventsFound = opts.eventsFound ?? (inserted + updated + skipped)

  // ── Console output ──────────────────────────────────────────────────────
  const icon = status === 'error' ? '❌' : '✓'
  console.log(
    `[${source}] ${icon}  ${inserted} inserted  ${updated} updated  ${skipped} skipped` +
    (eventsFound !== inserted + updated + skipped ? `  (${eventsFound} total from source)` : '') +
    (durationMs != null ? `  [${(durationMs / 1000).toFixed(1)}s]` : '')
  )

  // ── Persist to scraper_runs ─────────────────────────────────────────────
  try {
    const { error } = await supabaseAdmin
      .from('scraper_runs')
      .insert({
        scraper_name:    source,
        status,
        events_found:    eventsFound,
        events_inserted: inserted,
        events_updated:  updated,
        events_skipped:  skipped,
        error_message:   errorMessage,
        duration_ms:     durationMs,
      })

    if (error) {
      // Don't crash the scraper over a monitoring write failure — just warn
      console.warn(`  ⚠ Health log write failed for ${source}:`, error.message)
    }
  } catch (err) {
    console.warn(`  ⚠ Health log exception for ${source}:`, err.message)
  }
}

/**
 * Convenience wrapper: call at the top of each scraper's try/catch to log
 * fatal errors to scraper_runs without crashing the process.
 *
 * Usage:
 *   } catch (err) {
 *     await logScraperError('my_scraper', err, startTime)
 *     process.exit(1)
 *   }
 */
export async function logScraperError(source, err, startMs = null) {
  console.error(`\n❌  Fatal error [${source}]:`, err.message)
  const durationMs = startMs != null ? Date.now() - startMs : null
  await logUpsertResult(source, 0, 0, 0, {
    status:       'error',
    errorMessage: err.message,
    durationMs,
    eventsFound:  0,
  })
}
