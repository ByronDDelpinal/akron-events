/**
 * planned-run.js — run loop for scrapers that build their whole work list first.
 *
 * A scraper supplies `collect()`, which fetches and parses and returns a plan:
 *
 *   { found, rows: [{ row, venue }], skipped: { <reason>: <count> } }
 *
 *   found    how many listings the source carried, before any skip
 *   row      an event row for upsertEventSafe (source + source_id set)
 *   venue    { name, details } for THIS row, or null for a venue-less row
 *   skipped  why listings were left out, by reason
 *
 * and this module does the rest: dry-run printing, organization and venue
 * resolution, upsert, linking, and the scraper_runs record.
 *
 * Why this exists next to scraper-runner.js: defineScraper() takes one venue
 * for the whole source, has no dry run, and records a source that parsed to
 * nothing as a success. The scrapers built on this one need a venue per row
 * (a library program in a room vs. a bookmobile stop), must be runnable
 * against the live site without touching the database, and treat zero
 * listings as a broken parser rather than a quiet night.
 *
 * Decisions that are deliberate:
 *
 *   • ZERO LISTINGS IS AN ERROR RUN by default (`emptyIsError`). Every source
 *     here is a hand-read HTML page or a feed that is never legitimately
 *     empty; "0 found, status success" is how a redesigned page hides for
 *     weeks. Recorded as status 'error' with exit code 0, the same shape as
 *     emptyFeedOutcome() in lib/ics.js, so it surfaces in the health check
 *     without failing the whole nightly chain. A seasonal source passes
 *     `emptyIsError: false`.
 *   • ONE VENUE PER EVENT. setEventVenue, not linkEventVenue: these sources
 *     publish one place per listing, and a listing that moves must not keep
 *     its old link (linkEventVenue only ever adds).
 *   • AN ALIAS-SKIP IS NOT A FAILURE. upsertEventSafe returns it in the error
 *     slot for a row that was hand-merged into another event; it is counted
 *     separately and never logged as a failed write.
 *   • A DRY RUN LOADS NO DATABASE CODE. normalize.js is imported only on the
 *     write path, so `--dry-run` needs no credentials and cannot write.
 *
 * Usage:
 *   const result = await runPlannedScraper({
 *     source: 'my_source', label: 'My Venue', emoji: '🎭',
 *     org: { name, details },
 *     homeVenue: MAIN_VENUE,          // optional: the org's own building
 *     collect: () => collect(),
 *     dryRun,
 *   })
 *   if (result.exitCode) process.exit(result.exitCode)
 */

/** "3 past, 1 canceled" — or "none". Exported for tests. */
export function formatSkips(skipped = {}) {
  const parts = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${n} ${reason}`)
  return parts.length ? parts.join(', ') : 'none'
}

/** One dry-run line per planned row. Exported for tests. */
export function describePlannedRow({ row, venue }) {
  const flags = [
    row.status && row.status !== 'published' ? `[${row.status}]` : '',
    row.time_inferred ? '[time_inferred]' : '',
    row.needs_review ? '[needs_review]' : '',
  ].filter(Boolean).join(' ')
  const price = row.price_min == null ? 'price ?' : row.price_min === 0 ? 'free' : `$${row.price_min}${row.price_max ? `–$${row.price_max}` : ''}`
  return `     • ${row.title}\n       ${row.start_at} → ${row.end_at ?? '(no end)'}` +
    `  @ ${venue ? venue.name : '(no venue)'}  ${price}` +
    `  cats=${row.categories ? row.categories.join('+') : row.category ?? '(inferred)'}` +
    `${flags ? `  ${flags}` : ''}  id=${row.source_id}`
}

/**
 * @param {object} p
 * @param {string} p.source
 * @param {string} [p.label]
 * @param {string} [p.emoji]
 * @param {{name: string, details?: object}|null} [p.org]
 * @param {{name: string, details?: object}|null} [p.homeVenue]  linked to `org`
 *   the first time a row uses it (compared by identity, then by name)
 * @param {() => Promise<{found: number, rows: Array<{row: object, venue: object|null}>, skipped?: object}>} p.collect
 * @param {boolean} [p.dryRun=false]
 * @param {boolean} [p.emptyIsError=true]
 * @returns {Promise<{exitCode: number, status: string, found: number, planned: number,
 *   inserted: number, updated: number, failed: number, aliasSkipped: number, error: string|null}>}
 */
export async function runPlannedScraper({
  source, label, emoji = '📅', org = null, homeVenue = null, collect, dryRun = false, emptyIsError = true,
}) {
  if (!source) throw new Error('runPlannedScraper: `source` is required')
  if (typeof collect !== 'function') throw new Error('runPlannedScraper: `collect` must be a function')

  const name = label ?? source
  const start = Date.now()
  const result = {
    exitCode: 0, status: 'success', found: 0, planned: 0,
    inserted: 0, updated: 0, failed: 0, aliasSkipped: 0, error: null,
  }
  console.log(`${emoji}  Starting ${name} scrape…`)
  if (dryRun) console.log('   [dry-run mode: fetch + parse only, no DB access]')

  // Loaded on the write path only: a dry run must not need credentials.
  const db = dryRun ? null : await import('./normalize.js')

  try {
    const plan = await collect()
    const rows = plan.rows ?? []
    const skipped = plan.skipped ?? {}
    result.found = plan.found ?? rows.length
    result.planned = rows.length
    console.log(`\n📥  ${result.found} listing(s) at the source; ${rows.length} to publish`)
    console.log(`   Skipped: ${formatSkips(skipped)}`)

    if (result.found === 0 && emptyIsError) {
      const reason = `${name}: the source returned 0 listings`
      console.warn(`  ❌  ${reason}`)
      result.status = 'error'
      result.error = reason
      if (db) {
        await db.logUpsertResult(source, 0, 0, 0, {
          status: 'error', errorMessage: reason, durationMs: Date.now() - start, eventsFound: 0,
        })
      }
      return result
    }

    if (dryRun) {
      console.log(`\n🧪  Dry-run: ${rows.length} event(s) prepared, nothing written.`)
      for (const planned of rows) console.log(describePlannedRow(planned))
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      result.status = 'dry-run'
      return result
    }

    const organizationId = org?.name ? await db.ensureOrganization(org.name, org.details ?? {}) : null
    const venueIds = new Map()

    for (const { row, venue } of rows) {
      try {
        const enriched = await db.enrichWithImageDimensions(row, { organizationId })
        const { data: upserted, error, isNew } = await db.upsertEventSafe(enriched)
        if (error) {
          if (/^alias-skip:/.test(String(error.message ?? ''))) {
            console.log(`  ↷ Merged duplicate, not re-created: "${row.title}" (${row.source_id})`)
            result.aliasSkipped++
          } else {
            console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`)
            result.failed++
          }
          continue
        }

        if (venue?.name) {
          let venueId = venueIds.get(venue.name)
          if (venueId === undefined) {
            venueId = await db.ensureVenue(venue.name, venue.details ?? {})
            venueIds.set(venue.name, venueId)
            // Only the organization's own building belongs to it. An off-site
            // host must never be claimed.
            const isHome = homeVenue && (venue === homeVenue || venue.name === homeVenue.name)
            if (isHome && organizationId && venueId) await db.linkOrganizationVenue(organizationId, venueId)
          }
          if (venueId) await db.setEventVenue(upserted.id, venueId)
        }
        if (organizationId) await db.linkEventOrganization(upserted.id, organizationId)

        if (isNew) result.inserted++
        else result.updated++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${row?.title}": ${err.message}`)
        result.failed++
      }
    }

    const skippedTotal = Object.values(skipped).reduce((a, n) => a + n, 0)
    await db.logUpsertResult(source, result.inserted, result.updated, skippedTotal + result.failed, {
      eventsFound: result.found,
      durationMs: Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ` +
      `${result.inserted} new, ${result.updated} updated, ${result.failed} failed` +
      `${result.aliasSkipped ? `, ${result.aliasSkipped} merged duplicates left alone` : ''}`,
    )
    return result
  } catch (err) {
    result.status = 'error'
    result.error = err?.message ?? String(err)
    result.exitCode = 1
    if (db) await db.logScraperError(source, err, start)
    else console.error(`❌ ${name} scrape failed: ${err?.stack ?? err}`)
    return result
  }
}

/** True when the process was started with --dry-run or DRY_RUN=1. */
export function isDryRun(argv = process.argv, env = process.env) {
  return argv.includes('--dry-run') || env.DRY_RUN === '1'
}
