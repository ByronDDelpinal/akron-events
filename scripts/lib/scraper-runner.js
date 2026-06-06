/**
 * scraper-runner.js — Generic fetch→parse→upsert runner for event scrapers.
 *
 * Every custom-main() scraper repeats the same skeleton:
 *   1. Ensure venue + org exist (ensureVenue / ensureOrganization)
 *   2. Fetch raw items (HTML, JSON, …)
 *   3. For each item: parse → enrich images → upsert → link venue/org
 *   4. Log aggregate result; exit(1) on fatal error
 *
 * `defineScraper` encapsulates that loop so each scraper only needs to
 * supply a fetch function and a parse function. The returned `run()` is
 * called at the bottom of the scraper file (replacing the old `main()` call).
 *
 * Usage:
 *
 *   import { defineScraper } from './lib/scraper-runner.js'
 *
 *   const { run } = defineScraper({
 *     source: 'my_source',
 *     label:  'My Venue',              // optional, defaults to source
 *     fetch:  fetchItems,              // async () => RawItem[]
 *     parse:  parseItem,               // (RawItem) => EventRow | null
 *     venue:  { name, details },       // or async () => venueId
 *     org:    { name, details },       // or async () => orgId   (optional)
 *   })
 *
 *   run()
 *
 * `parse` may throw — thrown errors are caught, logged, and counted as
 * skipped. Returning null also skips the item.
 *
 * For scrapers with a per-event venue (e.g. the venue changes per item),
 * include `venue_id` directly on the returned EventRow and omit `venue`.
 *
 * Both `venue` and `org` accept either:
 *   • `{ name: string, details: object }` — passed through to ensureVenue /
 *     ensureOrganization; the resolved ID is linked to every upserted event.
 *   • `async () => id` — custom resolver for cases that need special logic.
 *   • `null` / omitted — no linking performed.
 */

import {
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  logUpsertResult,
  logScraperError,
} from './normalize.js'

// ── Entity resolver ───────────────────────────────────────────────────────────

/**
 * Resolve a venue or org descriptor to a DB id.
 *
 * @param {'venue'|'org'} kind
 * @param {{ name: string, details?: object } | (() => Promise<string>) | null | undefined} descriptor
 * @returns {Promise<string|null>}
 */
async function resolveEntity(kind, descriptor) {
  if (!descriptor) return null
  if (typeof descriptor === 'function') return descriptor()
  const { name, details = {} } = descriptor
  if (!name) return null
  return kind === 'venue'
    ? ensureVenue(name, details)
    : ensureOrganization(name, details)
}

// ── Core runner ───────────────────────────────────────────────────────────────

/**
 * Define a scraper and return a `run()` function.
 *
 * @param {{
 *   source: string,
 *   label?: string,
 *   fetch: () => Promise<unknown[]>,
 *   parse: (item: unknown) => object | null,
 *   venue?: { name: string, details?: object } | (() => Promise<string>) | null,
 *   org?:   { name: string, details?: object } | (() => Promise<string>) | null,
 * }} config
 * @returns {{ run: () => Promise<void> }}
 */
export function defineScraper({ source, label, fetch: fetchItems, parse, venue, org }) {
  if (!source) throw new Error('defineScraper: `source` is required')
  if (typeof fetchItems !== 'function') throw new Error('defineScraper: `fetch` must be a function')
  if (typeof parse !== 'function') throw new Error('defineScraper: `parse` must be a function')

  const displayName = label ?? source

  async function run() {
    console.log(`🚀  Starting ${displayName} ingestion…`)
    const start = Date.now()

    try {
      // Resolve venue + org IDs in parallel (both are no-ops if null/undefined).
      const [venueId, orgId] = await Promise.all([
        resolveEntity('venue', venue),
        resolveEntity('org', org),
      ])

      const items = await fetchItems()
      console.log(`  Found ${items.length} item(s)`)

      let inserted = 0, skipped = 0

      for (const item of items) {
        let row
        try {
          row = parse(item)
        } catch (parseErr) {
          console.warn(`  ⚠ Parse error: ${parseErr.message}`)
          skipped++
          continue
        }
        if (!row) { skipped++; continue }

        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)

        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
          skipped++
          continue
        }

        // Link venue + org if provided (or if the row carries an explicit venue_id).
        const rowVenueId = row.venue_id ?? venueId
        const rowOrgId   = row.org_id   ?? orgId
        if (rowVenueId) await linkEventVenue(upserted.id, rowVenueId)
        if (rowOrgId)   await linkEventOrganization(upserted.id, rowOrgId)

        inserted++
        console.log(`  ✓ ${row.title}`)
      }

      await logUpsertResult(source, inserted, 0, skipped, {
        eventsFound: items.length,
        durationMs:  Date.now() - start,
      })
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
    } catch (err) {
      await logScraperError(source, err, start)
      process.exit(1)
    }
  }

  return { run }
}
