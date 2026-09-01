/**
 * lib/series.js - the pure planner behind the nightly series extender
 * (ADR-069 slice 2). Given already-loaded rows plus an injected `todayYmd`,
 * it answers "which occurrence rows are missing inside the horizon, and what
 * should they look like".
 *
 * PURE, on purpose: no I/O, no supabase, no clock. It must never import
 * scripts/lib/supabase-admin.js, directly or transitively, for the same
 * reason src/lib/recurrence.js states at its own header: the planner is the
 * part worth testing exhaustively, and it is only exhaustively testable if a
 * test can hand it rows and a fixed date instead of a database and a clock.
 *
 * "Today" arrives as a parameter. scripts/extend-series.js calls
 * easternTodayIso() once (normalize.js) and passes the result down, so every
 * test pins a date and no code here can drift onto a UTC calendar day (the
 * nightly job runs at 02:00 UTC, which is the previous evening in Eastern).
 *
 * The expansion itself is delegated to src/lib/recurrence.js, the single
 * source of truth shared with the browser. Nothing here reimplements
 * calendar arithmetic.
 */

import {
  DEFAULT_HORIZON_DAYS,
  MAX_SERIES_OCCURRENCES,
  addDaysYmd,
  expandRuleDates,
  occurrenceSourceId,
  parseRrule,
} from '../../src/lib/recurrence.js'
import { easternToIso } from './normalize.js'

// easternToIso is the one import that reaches outside this file's own purity
// rule. normalize.js does transitively import supabase-admin.js, but that
// module is lazy by construction (its own header: importing it must never
// require credentials or perform side effects), so this file still imports
// with no env, does no I/O and reads no clock, which is what the rule
// protects. A second copy of the EST/EDT conversion would be strictly worse:
// the two-argument form here is the exact behaviour ADR-069 depends on.

/**
 * Columns copied verbatim from the template occurrence onto every new one.
 * Inventory taken from the events table plus every later ALTER; anything not
 * listed here is either recomputed per occurrence (see buildOccurrencePayload)
 * or deliberately absent (see NEVER_COPY_COLUMNS).
 *
 * manual_overrides is copied on purpose: it is how a reviewer's decision
 * travels forward to next quarter's occurrences without a second review.
 * needs_review is copied rather than defaulted: an occurrence is exactly as
 * confident as the template it came from.
 */
export const TEMPLATE_COPY_COLUMNS = [
  'title', 'description', 'image_url', 'image_width', 'image_height',
  'image_file_size', 'ticket_url', 'source_url', 'price_min', 'price_max',
  'age_restriction', 'tags', 'is_family', 'is_fundraiser',
  'event_attendance_mode', 'event_status', 'is_accessible_for_free',
  'needs_review', 'manual_overrides', 'source',
]

/**
 * Columns that must NEVER appear in an insert payload, each for a reason:
 * database defaults (id, created_at, updated_at), admin-only paths
 * (reviewed_at, reviewed_by), trigger-maintained (start_hour_et,
 * title_normalized, description_normalized, category_slugs), generated
 * always (banner_eligible), or not a join key (slug). `category` was dropped
 * from the table entirely. Exported so the tests assert against the same list
 * the code is written from.
 */
export const NEVER_COPY_COLUMNS = [
  'id', 'created_at', 'updated_at', 'reviewed_at', 'reviewed_by',
  'start_hour_et', 'title_normalized', 'description_normalized',
  'category_slugs', 'banner_eligible', 'slug', 'category',
]

/** The four junction tables that reference events(id), copied forward verbatim. */
export const JUNCTION_SPECS = [
  { key: 'venues',        table: 'event_venues',        column: 'venue_id',        onConflict: 'event_id,venue_id' },
  { key: 'areas',         table: 'event_areas',         column: 'area_id',         onConflict: 'event_id,area_id' },
  { key: 'organizations', table: 'event_organizations', column: 'organization_id', onConflict: 'event_id,organization_id' },
  { key: 'categories',    table: 'event_categories',    column: 'category',        onConflict: 'event_id,category' },
]

/** Every column extend-series.js needs to read off an occurrence row. */
export const TEMPLATE_SELECT_COLUMNS = [
  'id', 'status', 'start_at', 'end_at', 'created_at', 'series_id',
  ...TEMPLATE_COPY_COLUMNS,
].join(', ')

/**
 * Set key for one (source, source_id) pair. Uniqueness on events is on the
 * PAIR, never on source_id alone, so every skip-set lookup goes through this.
 * @param {string} source
 * @param {string} sourceId
 */
export const occurrenceKey = (source, sourceId) => `${source} ${sourceId}`

/**
 * Newest published occurrence of a series, or null.
 *
 * Published only: a cancelled occurrence must not seed new ones, and neither
 * must a pending_review one, which is how "pending series never extend" falls
 * out with no extra state anywhere. Ties break on created_at, then on id
 * (string compare), so the choice is deterministic and a test can pin it.
 *
 * @param {Array<Record<string, any>>} rows occurrences of one series
 * @returns {Record<string, any> | null}
 */
export function selectTemplate(rows) {
  const published = (rows || []).filter((r) => r && r.status === 'published')
  if (!published.length) return null
  return published.reduce((best, row) => {
    const a = String(row.start_at ?? ''), b = String(best.start_at ?? '')
    if (a !== b) return a > b ? row : best
    const ca = String(row.created_at ?? ''), cb = String(best.created_at ?? '')
    if (ca !== cb) return ca > cb ? row : best
    return String(row.id) > String(best.id) ? row : best
  })
}

/**
 * How long one occurrence lasts, in ms: the series duration when it has one,
 * else the template's own start-to-end delta, else unknown (null). Added to
 * the INSTANT rather than to a civil time, which is correct: a two-hour event
 * starting at 19:00 on the fall-back night genuinely runs two hours.
 *
 * @param {Record<string, any>} series
 * @param {Record<string, any>} template
 * @returns {number | null}
 */
export function occurrenceDurationMs(series, template) {
  if (series && series.duration_min != null) {
    const mins = Number(series.duration_min)
    if (Number.isFinite(mins)) return mins * 60_000
  }
  if (template && template.start_at && template.end_at) {
    const delta = Date.parse(template.end_at) - Date.parse(template.start_at)
    // A template whose end precedes its start is corrupt; copying that delta
    // forward would mint occurrences that end before they begin.
    if (Number.isFinite(delta) && delta > 0) return delta
  }
  return null
}

/**
 * One insert payload: the copy set plus the per-date recomputations.
 * `featured` is a false literal, always. `status` is a published literal: the
 * template was published and the occurrence is the same event on another day.
 * The template's `source` wins over event_series.source, because uniqueness,
 * RLS, source priority and attribution all key off events.source.
 *
 * @param {Record<string, any>} series
 * @param {Record<string, any>} template
 * @param {string} ymd
 * @returns {Record<string, any> | null} null when the instant cannot be built
 */
export function buildOccurrencePayload(series, template, ymd) {
  // Two-argument easternToIso: (civil date, wall-clock time). This is the
  // whole reason event_series stores a date and a time instead of a
  // timestamptz, and it is what keeps a 19:00 series at 19:00 across the
  // November DST change instead of drifting an hour.
  const startAt = easternToIso(ymd, series.start_time)
  if (!startAt) return null

  /** @type {Record<string, any>} */
  const payload = {}
  // `in`, not `?? null`: a column the select set never fetched must be absent
  // from the payload (letting the column default apply), not written as an
  // explicit NULL, which a NOT NULL column would reject outright.
  for (const col of TEMPLATE_COPY_COLUMNS) {
    if (col in template) payload[col] = template[col]
  }
  payload.source = template.source

  const durationMs = occurrenceDurationMs(series, template)
  payload.start_at = startAt
  payload.end_at = durationMs == null
    ? null
    : new Date(Date.parse(startAt) + durationMs).toISOString()
  payload.source_id = occurrenceSourceId(series.id, ymd)
  payload.series_id = series.id
  payload.status = 'published'
  payload.featured = false
  return payload
}

/**
 * Expand every series into the candidate dates it still owes inside the
 * horizon, paired with the template it would copy from.
 *
 * exdates note: the engine removes them AFTER COUNT accounting, so filtering
 * them here instead of passing them through produces the identical list, and
 * it is the only way to report a skipped_exdate count (the engine returns the
 * post-filter list only). Cancelling one night therefore never shifts the
 * rest of the series forward, which is the invariant the tests pin.
 *
 * validateOrganizerRule is deliberately NOT called: it enforces the
 * organizer-submission subset (BYDAY required, exactly one of COUNT/UNTIL),
 * which is stricter than the database CHECK on event_series.rrule. A series
 * that is legal in the table would otherwise silently stop extending. The
 * bounds here are the horizon and maxOccurrences.
 *
 * @param {Array<Record<string, any>>} seriesRows
 * @param {Array<Record<string, any>>} occurrenceRows every occurrence of those series
 * @param {string} todayYmd 'YYYY-MM-DD' in Eastern, injected by the caller
 * @param {{ horizonDays?: number }} [opts]
 */
export function planCandidates(seriesRows, occurrenceRows, todayYmd, opts = {}) {
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS
  const horizonYmd = addDaysYmd(todayYmd, horizonDays)

  /** @type {Map<string, Array<Record<string, any>>>} */
  const bySeries = new Map()
  for (const row of occurrenceRows || []) {
    if (!row || row.series_id == null) continue
    const list = bySeries.get(row.series_id)
    if (list) list.push(row)
    else bySeries.set(row.series_id, [row])
  }

  const candidates = []
  for (const series of seriesRows || []) {
    const template = selectTemplate(bySeries.get(series.id) || [])
    if (!template) {
      // Never synthesise from event_series alone: it carries a rule, a date,
      // a time and a duration, and no title, description, image or price.
      // There is nothing to build an event from, so this is a loud counter.
      candidates.push({ series, template: null, dates: [], skippedExdate: 0, sourceMismatch: false })
      continue
    }
    const parts = parseRrule(series.rrule)
    const untilYmd = parts.UNTIL
      ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
      : undefined
    const raw = expandRuleDates(parts, series.dtstart_date, {
      fromYmd: todayYmd,
      toYmd: horizonYmd,
      untilYmd,
      maxOccurrences: MAX_SERIES_OCCURRENCES,
    })
    const exSet = new Set(series.exdates ?? [])
    const dates = raw.filter((d) => !exSet.has(d))
    candidates.push({
      series,
      template,
      dates,
      skippedExdate: raw.length - dates.length,
      sourceMismatch: series.source != null && series.source !== template.source,
    })
  }
  return { candidates, horizonYmd }
}

/**
 * Every (source, source_id) pair a candidate set would occupy, as
 * { source, sourceId } records. The runner feeds the ids to the collision
 * and alias queries before asking for the final plan.
 * @param {ReturnType<typeof planCandidates>['candidates']} candidates
 */
export function candidateSourceIds(candidates) {
  const out = []
  for (const c of candidates) {
    if (!c.template) continue
    for (const ymd of c.dates) {
      out.push({ source: c.template.source, sourceId: occurrenceSourceId(c.series.id, ymd) })
    }
  }
  return out
}

/**
 * The whole plan for one night.
 *
 * Skip rules, in order: outside [todayYmd, horizonYmd] (never returned by the
 * engine), in exdates, already present as a (source, source_id) pair in any
 * status including cancelled, merged away through event_aliases, else insert.
 *
 * @param {object} input
 * @param {Array<Record<string, any>>} input.seriesRows active series (cancelled_at is null)
 * @param {Array<Record<string, any>>} input.occurrenceRows every occurrence of those series
 * @param {Set<string>} [input.existingKeys] occurrenceKey() of pairs already in events
 * @param {Set<string>} [input.existingSourceIds] bare source_ids already in events,
 *   under ANY source (see the skip order below)
 * @param {Set<string>} [input.aliasKeys] occurrenceKey() of merged-away slots
 * @param {Record<string, Record<string, any[]>>} [input.templateJunctions]
 *   template event id to { venues, areas, organizations, categories } value lists
 * @param {string} input.todayYmd
 * @param {number} [input.horizonDays]
 * @param {ReturnType<typeof planCandidates>} [input.precomputed] candidates from an
 *   earlier planCandidates call, so the runner expands each rule exactly once.
 *   It carries its own horizon, so horizonDays is ignored when this is passed.
 * @returns {{ inserts: Array<Record<string, any>>, junctions: Map<string, Record<string, any[]>>,
 *             counters: Record<string, number>, perSeries: Array<Record<string, any>>,
 *             horizonYmd: string }}
 */
export function planSeriesExtension({
  seriesRows, occurrenceRows, existingKeys = new Set(), existingSourceIds = new Set(),
  aliasKeys = new Set(), templateJunctions = {}, todayYmd, horizonDays, precomputed,
}) {
  const { candidates, horizonYmd } = precomputed
    ?? planCandidates(seriesRows, occurrenceRows, todayYmd, { horizonDays })

  const counters = {
    active_series: (seriesRows || []).length,
    with_template: 0,
    no_template: 0,
    source_mismatch: 0,
    planned: 0,
    skipped_existing: 0,
    skipped_existing_other_source: 0,
    skipped_alias: 0,
    skipped_exdate: 0,
    skipped_bad_time: 0,
  }
  /** @type {Array<Record<string, any>>} */
  const inserts = []
  /** @type {Map<string, Record<string, any[]>>} source_id to the template's junction values */
  const junctions = new Map()
  /** @type {Array<Record<string, any>>} */
  const perSeries = []

  for (const c of candidates) {
    if (!c.template) {
      counters.no_template++
      perSeries.push({
        seriesId: c.series.id, templateId: null, rrule: c.series.rrule,
        planned: 0, skippedExisting: 0, skippedExistingOtherSource: 0,
        skippedAlias: 0, skippedExdate: 0,
        sourceMismatch: false, reason: 'no_template',
      })
      continue
    }
    counters.with_template++
    counters.skipped_exdate += c.skippedExdate
    if (c.sourceMismatch) counters.source_mismatch++

    let planned = 0, skippedExisting = 0, skippedOtherSource = 0, skippedAlias = 0, skippedBadTime = 0
    for (const ymd of c.dates) {
      const sourceId = occurrenceSourceId(c.series.id, ymd)
      const key = occurrenceKey(c.template.source, sourceId)
      if (existingKeys.has(key)) { skippedExisting++; continue }
      // Same civil date, different source: the series' source changed after
      // those rows were materialised (manual promoted to partner:x, say).
      // The unique constraint is on the PAIR, so Postgres would happily
      // accept a second row for the same night under the new source. A
      // source_id is already unique per (series, date) by construction, so a
      // bare-id hit is that date, whoever owns it, and it must not be minted
      // twice. Counted apart because it is a migration artefact, not a
      // steady-state skip.
      if (existingSourceIds.has(sourceId)) { skippedOtherSource++; continue }
      if (aliasKeys.has(key)) { skippedAlias++; continue }
      const payload = buildOccurrencePayload(c.series, c.template, ymd)
      // Unparseable start_time: no instant, no row, and a counter rather
      // than a silent drop.
      if (!payload) { skippedBadTime++; continue }
      inserts.push(payload)
      junctions.set(sourceId, templateJunctions[c.template.id] ?? {})
      planned++
    }

    counters.planned += planned
    counters.skipped_existing += skippedExisting
    counters.skipped_existing_other_source += skippedOtherSource
    counters.skipped_alias += skippedAlias
    counters.skipped_bad_time += skippedBadTime
    perSeries.push({
      seriesId: c.series.id, templateId: c.template.id, rrule: c.series.rrule,
      planned, skippedExisting, skippedExistingOtherSource: skippedOtherSource,
      skippedAlias, skippedExdate: c.skippedExdate, skippedBadTime,
      sourceMismatch: Boolean(c.sourceMismatch), reason: null,
    })
  }

  return { inserts, junctions, counters, perSeries, horizonYmd }
}
