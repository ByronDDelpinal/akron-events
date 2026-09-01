/**
 * extend-series.js - the nightly recurring-series horizon extender
 * (ADR-069 slice 2).
 *
 * Three phases with a hard wall between them: LOAD (a handful of batched
 * queries, no logic), PLAN (scripts/lib/series.js, pure, given an injected
 * "today"), WRITE (chunked, insert-only, then a summary). The wall is what
 * makes the interesting half testable with no database and every test date
 * fixed.
 *
 * Insert-only is load-bearing. The write is an upsert with
 * ignoreDuplicates: true, which compiles to ON CONFLICT DO NOTHING and can
 * never update a row, so a nightly run can never revert a published or
 * cancelled occurrence, and a race with the scrape over the same
 * (source, source_id) is harmless. upsertEventSafe is deliberately not used:
 * it updates on conflict, strips fields against manual_overrides, re-runs
 * category inference over reviewed content, and records upsert observations
 * keyed by row.source, which would contaminate another path's scraper_runs
 * tallies.
 *
 * No scraper_runs row is written: scraper_runs.status allows only 'success'
 * and 'error', and scrape-report.js grades the manifest's active sources
 * only, so a series_extender row would be written and never read. The step
 * reports to stdout and to the job summary instead.
 *
 * Env:
 *   VITE_SUPABASE_URL          - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  - service role (bypasses RLS to write events)
 *
 * Flags:
 *   --dry-run   plan and print, write nothing at all
 *
 * Run:  node scripts/extend-series.js [--dry-run]
 */

import { appendFileSync } from 'node:fs'
import { easternTodayIso } from './lib/normalize.js'
import {
  JUNCTION_SPECS,
  TEMPLATE_SELECT_COLUMNS,
  candidateSourceIds,
  occurrenceKey,
  planCandidates,
  planSeriesExtension,
} from './lib/series.js'

/** Series ids per occurrence query, ids per URL-filter list, rows per write. */
const SERIES_CHUNK = 200
// PostgREST .in() lists travel in the URL and a series source_id is 54
// characters, so 500 of them is a ~30 KB URL. The repo convention is 50 to
// 100 (geocode-venues.js VENUE_ID_CHUNK_SIZE).
const KEY_CHUNK = 100
const WRITE_CHUNK = 200
/**
 * PostgREST's hard per-page cap. It truncates ANY plain select() at this many
 * rows with no error and no flag (the trap documented in
 * check-attribution.js and geocode-venues.js), so every read below pages
 * explicitly under a total, stable ordering: without one, rows straddling a
 * page boundary are skipped or repeated between queries.
 */
const PAGE = 1000

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Throw on a supabase error so the CLI exits nonzero with the message. */
function unwrap(label, { data, error }) {
  if (error) throw new Error(`${label}: ${error.message || error}`)
  return data || []
}

/**
 * Read every row of a query, one PAGE at a time. `build` must return a FRESH
 * builder on each call (a PostgREST builder is single-use) already carrying
 * its filters and a total ordering.
 * @param {string} label
 * @param {() => any} build
 */
async function fetchAllPages(label, build) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const rows = unwrap(label, await build().range(from, from + PAGE - 1))
    if (!rows.length) break         // empty page = nothing left, belt and braces
    out.push(...rows)
    if (rows.length < PAGE) break   // short page = last page
  }
  return out
}

/** stdout, mirrored to the job summary when GitHub gives us one. */
function report(lines) {
  const text = lines.join('\n')
  console.log(text)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `${text}\n`)
    } catch (err) {
      console.warn(`could not append to GITHUB_STEP_SUMMARY: ${err.message}`)
    }
  }
}

function summaryLines({ todayYmd, horizonYmd, perSeries, counters, inserted, junctionRows, junctionRowsFailed, junctionFailedSeries, dryRun }) {
  const lines = []
  for (const s of perSeries) {
    if (s.reason === 'no_template') {
      lines.push(`series ${s.seriesId} : skipped, no published occurrence to use as a template`)
      continue
    }
    const skipped = s.skippedExisting + s.skippedExistingOtherSource + s.skippedAlias
      + s.skippedExdate + s.skippedBadTime
    if (!s.planned && !skipped) continue
    const skips = [
      s.skippedExisting ? `${s.skippedExisting} existing` : null,
      s.skippedExistingOtherSource ? `${s.skippedExistingOtherSource} existing under another source` : null,
      s.skippedAlias ? `${s.skippedAlias} alias` : null,
      s.skippedExdate ? `${s.skippedExdate} exdate` : null,
      s.skippedBadTime ? `${s.skippedBadTime} unparseable start_time` : null,
    ].filter(Boolean)
    const mismatch = s.sourceMismatch ? ', source mismatch (template source wins)' : ''
    lines.push(
      `series ${s.seriesId} (template ${s.templateId}, ${s.rrule}): planned ${s.planned}` +
      (skips.length ? `, skipped ${skips.join(', ')}` : '') + mismatch
    )
  }
  lines.push('')
  lines.push(`Series extender ${todayYmd} (Eastern), horizon ${todayYmd} .. ${horizonYmd}${dryRun ? ' [dry run]' : ''}`)
  const row = (label, n) => lines.push(`  ${label.padEnd(34)} ${String(n).padStart(4)}`)
  row('active series', counters.active_series)
  row('with template', counters.with_template)
  row('no template', counters.no_template)
  row('source mismatch', counters.source_mismatch)
  row('dates planned', counters.planned)
  row(dryRun ? 'would insert' : 'inserted', inserted)
  row('skipped, existing', counters.skipped_existing)
  row('skipped, existing other source', counters.skipped_existing_other_source)
  row('skipped, alias', counters.skipped_alias)
  row('skipped, exdate', counters.skipped_exdate)
  row('skipped, unparseable start_time', counters.skipped_bad_time)
  row('junction rows inserted', junctionRows)
  row('junction rows failed', junctionRowsFailed)
  if (junctionFailedSeries.length) {
    lines.push(`  junction copy failed for series: ${junctionFailedSeries.join(', ')}`)
    lines.push('  those occurrences are live but missing a page association; repair by hand (ADR-069 slice 2 brief, section 3).')
  }
  return lines
}

/**
 * @param {{ dryRun?: boolean }} [opts] --dry-run is read from argv by default;
 *   the tests pass it explicitly so one process can exercise both modes.
 */
async function main({ dryRun = process.argv.includes('--dry-run') } = {}) {
  // Lazy: importing this file (a test, the no-utc-today scanner, a linter)
  // must never require credentials.
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')

  const todayYmd = easternTodayIso()   // the ONLY clock read in the whole run

  // ── Q1: active series ─────────────────────────────────────────────────
  // cancelled_at is null is the whole-series cancel gate and the exact
  // predicate idx_event_series_active was built for.
  const seriesRows = await fetchAllPages('load event_series', () => supabaseAdmin
    .from('event_series')
    .select('id, rrule, dtstart_date, start_time, duration_min, exdates, source')
    .is('cancelled_at', null)
    .order('id', { ascending: true }))

  // ── Q2: every occurrence of those series, one query per 200 series ─────
  // Paged, and ordered by series_id FIRST. An unpaged start_at DESC across a
  // whole chunk hands every row to the busiest few series and truncates the
  // rest away at 1000, so a series below the cut looks like it has no
  // occurrences at all, is misreported as no_template, and stops extending
  // for good. series_id then start_at then id is total and stable, so no row
  // straddles a page boundary.
  const occurrenceRows = []
  for (const ids of chunk(seriesRows.map((s) => s.id), SERIES_CHUNK)) {
    occurrenceRows.push(...await fetchAllPages('load occurrences', () => supabaseAdmin
      .from('events')
      .select(TEMPLATE_SELECT_COLUMNS)
      .in('series_id', ids)
      .order('series_id', { ascending: true })
      .order('start_at', { ascending: false })
      .order('id', { ascending: true })))
  }

  const candidatePlan = planCandidates(seriesRows, occurrenceRows, todayYmd)
  const { candidates } = candidatePlan
  const plannedIds = candidateSourceIds(candidates).map((p) => p.sourceId)

  // ── Q3: rows already holding a planned (source, source_id) ────────────
  // Keyed on source_id, not on series_id: the FK is on delete set null, so a
  // row can occupy an occurrence's slot with series_id null and Q2 would
  // miss it. Any status counts, including cancelled.
  // The bare-id set catches the same date sitting under a DIFFERENT source
  // (a series whose source changed after its occurrences were materialised):
  // the unique constraint is on the pair, so only we can stop that duplicate.
  const existingKeys = new Set()
  const existingSourceIds = new Set()
  for (const ids of chunk(plannedIds, KEY_CHUNK)) {
    for (const row of await fetchAllPages('load existing events', () => supabaseAdmin
      .from('events').select('source, source_id').in('source_id', ids)
      .order('source_id', { ascending: true }).order('source', { ascending: true }))) {
      existingKeys.add(occurrenceKey(row.source, row.source_id))
      existingSourceIds.add(row.source_id)
    }
  }

  // ── Q4: slots merged away through event_aliases, never re-minted ──────
  const aliasKeys = new Set()
  for (const ids of chunk(plannedIds, KEY_CHUNK)) {
    for (const row of await fetchAllPages('load event_aliases', () => supabaseAdmin
      .from('event_aliases')
      .select('duplicate_source, duplicate_source_id')
      .in('duplicate_source_id', ids)
      .order('duplicate_source_id', { ascending: true })
      .order('duplicate_source', { ascending: true }))) {
      aliasKeys.add(occurrenceKey(row.duplicate_source, row.duplicate_source_id))
    }
  }

  // ── Q5: the templates' junction rows, four queries per id chunk ───────
  const templateIds = candidates.filter((c) => c.template).map((c) => c.template.id)
  /** @type {Record<string, Record<string, any[]>>} */
  const templateJunctions = {}
  for (const ids of chunk(templateIds, KEY_CHUNK)) {
    for (const spec of JUNCTION_SPECS) {
      for (const row of await fetchAllPages(`load ${spec.table}`, () => supabaseAdmin
        .from(spec.table).select(`event_id, ${spec.column}`).in('event_id', ids)
        .order('event_id', { ascending: true }).order(spec.column, { ascending: true }))) {
        const bucket = templateJunctions[row.event_id] ?? (templateJunctions[row.event_id] = {})
        ;(bucket[spec.key] ?? (bucket[spec.key] = [])).push(row[spec.column])
      }
    }
  }

  const { inserts, junctions, counters, perSeries, horizonYmd } = planSeriesExtension({
    seriesRows, occurrenceRows, existingKeys, existingSourceIds, aliasKeys,
    templateJunctions, todayYmd, precomputed: candidatePlan,
  })

  let inserted = 0, junctionRows = 0, junctionRowsFailed = 0
  const junctionFailedSeries = new Set()
  const seriesOfSourceId = new Map(inserts.map((r) => [r.source_id, r.series_id]))

  if (!dryRun && inserts.length) {
    // ON CONFLICT DO NOTHING: still insert-only, and .select() then returns
    // ONLY the rows actually inserted, which is exactly the set the junction
    // copy wants. A row lost to a race with the scrape gets no junction rows,
    // which is correct: the winner owns them.
    /** @type {Record<string, any[]>} */
    const junctionBatches = {}
    for (const rows of chunk(inserts, WRITE_CHUNK)) {
      const created = unwrap('insert occurrences', await supabaseAdmin
        .from('events')
        .upsert(rows, { onConflict: 'source,source_id', ignoreDuplicates: true })
        .select('id, source_id'))
      inserted += created.length
      for (const row of created) {
        const values = junctions.get(row.source_id) || {}
        for (const spec of JUNCTION_SPECS) {
          for (const value of values[spec.key] || []) {
            ;(junctionBatches[spec.key] ?? (junctionBatches[spec.key] = []))
              .push({ event_id: row.id, [spec.column]: value, source_id: row.source_id })
          }
        }
      }
    }

    // Events first, junctions second, so a junction row can never reference a
    // missing event. A junction failure is counted and named, not thrown: the
    // occurrence is live, it is just missing a page association, and because
    // this script is insert-only a later night will NOT repair it.
    for (const spec of JUNCTION_SPECS) {
      for (const batch of chunk(junctionBatches[spec.key] || [], WRITE_CHUNK)) {
        const rows = batch.map(({ source_id: _sourceId, ...row }) => row)
        const { error } = await supabaseAdmin
          .from(spec.table)
          .upsert(rows, { onConflict: spec.onConflict, ignoreDuplicates: true })
        if (error) {
          junctionRowsFailed += rows.length
          for (const r of batch) junctionFailedSeries.add(seriesOfSourceId.get(r.source_id))
          console.warn(`junction copy failed on ${spec.table}: ${error.message || error}`)
        } else {
          junctionRows += rows.length
        }
      }
    }
  }

  report(summaryLines({
    todayYmd, horizonYmd, perSeries, counters, inserted, junctionRows,
    junctionRowsFailed, junctionFailedSeries: [...junctionFailedSeries].filter(Boolean), dryRun,
  }))
}

// Import-safe: only run when invoked directly (never on import, e.g. in tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`extend-series failed: ${err.message}`)
    process.exit(1)
  })
}

export { main }
