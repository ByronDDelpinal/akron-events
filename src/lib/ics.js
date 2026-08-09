/**
 * ics.js
 *
 * Shared RFC 5545 `.ics` (iCalendar) export builder. Used by BOTH the
 * single-event "Add to Apple / Outlook Calendar" button (EventPage.tsx) and
 * the day-planner's "Export .ics" action. One implementation, one UID/
 * SEQUENCE convention -- the same event added individually and later inside
 * a plan must produce the SAME UID, so a re-export UPDATES a user's existing
 * calendar entry instead of duplicating it (docs/day-planner.md §7.2, which
 * is gitignored and will not exist when this file is read later -- see the
 * inline rationale below instead of a pointer to it).
 *
 * Plain JS, not TS, on purpose: `node --test` (scripts/tests/test-ics-
 * export.js) imports this directly with no build step, mirroring
 * src/lib/slug.js's stated rationale. JSDoc-typed for editor/tsc support via
 * `allowJs`.
 *
 * Fixes four real RFC 5545 bugs the previous EventPage-local builder had:
 *   1. No TEXT escaping (a comma in a title corrupted the file) -- fixed by
 *      escapeIcsText, applied to every TEXT-valued property.
 *   2. No line folding (§3.1 caps a content line at 75 octets) -- fixed by
 *      foldLine, which folds on OCTET boundaries and never splits a UTF-8
 *      multi-byte sequence.
 *   3. Missing DTSTAMP (required by §3.6.1) -- fixed, computed at build time.
 *   4. Empty `URL:` property when a link was absent, and DTEND==DTSTART for
 *      a null end_at (a zero-length "event") -- fixed: URL is omitted
 *      entirely when there is nothing to point at, and a null end_at gets an
 *      assumed 2-hour block with the assumption stated in DESCRIPTION (D9 --
 *      same posture as the scraper SANCTIONED-DEFAULT-TIME convention:
 *      invent, but mark it. See ASSUMED_DURATION_NOTE below).
 *
 * Deliberately NO `METHOD` property. METHOD:PUBLISH/REQUEST triggers iTIP
 * handling -- Outlook renders a METHOD-bearing file as a meeting invitation
 * with accept/decline buttons, which this is not. Do not add one.
 *
 * Timezone: every DTSTART/DTEND is emitted in UTC (`...Z` form), never
 * floating local time and never `TZID=America/New_York`. `events.start_at`
 * is already an absolute UTC instant (timestamptz), so this conversion is
 * lossless, and every calendar client renders it in the VIEWER's own zone --
 * exactly the site's viewer-local display rule, for free. A `TZID` form
 * would need a full VTIMEZONE component (DST transition rules) to be
 * strictly conforming, which scripts/lib/ics.js's own parser notes is
 * unsupported on the read side -- real code for zero user-visible gain.
 *
 * @typedef {object} IcsVenue
 * @property {string|null} [name]
 * @property {string|null} [address]
 * @property {string|null} [city]
 * @property {string|null} [state]
 * @property {string|null} [zip]
 * @property {number|null} [lat]
 * @property {number|null} [lng]
 *
 * @typedef {object} IcsExportEvent
 * @property {string} id                 - the RESOLVED (post-alias) event id; used for UID so a
 *                                          merged event converges with its canonical entry.
 * @property {string} title
 * @property {string|null} [description]
 * @property {string} start_at           - ISO 8601, absolute (UTC or offset-bearing).
 * @property {string|null} [end_at]      - null triggers the D9 assumed-2h block.
 * @property {string|null} [updated_at]  - drives SEQUENCE; missing/unparseable treated as 0.
 * @property {IcsVenue|null} [venue]
 * @property {string|null} [ticket_url]
 * @property {string|null} [source_url]
 * @property {string[]|null} [category_slugs]
 * @property {string} canonicalUrl       - the event's own /events/... URL. NEVER a /d/<code> plan
 *                                          URL -- that would park the plan's bearer code in every
 *                                          calendar client that imports the file (§11 of the design).
 * @property {string} [rot_status]       - only plan items carry this. 'gone' and 'merged_duplicate'
 *                                          are filtered out of the export entirely by buildVCalendar
 *                                          (no reliable end time/location for 'gone'; 'merged_duplicate'
 *                                          would just re-emit an event already in the file under its
 *                                          canonical id). 'cancelled' emits STATUS:CANCELLED so a
 *                                          re-import cancels the entry in the user's calendar instead
 *                                          of leaving a stale block -- the single highest-value line
 *                                          in the whole export. Anything else (including undefined,
 *                                          for the single-event export path) emits STATUS:CONFIRMED.
 */

import { makeEventSlug } from './slug.js'

// SEQUENCE = minutes since this epoch, floored at 0. Monotonic in the only
// thing that actually changes an event (updated_at); minute granularity
// keeps the integer small and stable across a same-minute re-export. Must
// stay IDENTICAL between the single-event and plan export paths (both route
// through computeSequence) or the two paths fight over the same UID.
const SEQUENCE_EPOCH_MS = Date.parse('2026-01-01T00:00:00Z')

// D9: the disclosure line appended to DESCRIPTION when end_at is null and we
// assume a 2-hour block. Same posture as SANCTIONED-DEFAULT-TIME elsewhere
// in this codebase: invent a value, but never invent it silently.
export const ASSUMED_DURATION_NOTE =
  "This listing does not include an end time, so a 2-hour block is shown here. Confirm the length with the organizer before you go."

// Note shown once in the plan export's own copy (not per-VEVENT) about
// removal semantics -- restated here because it explains why REMOVED items
// never appear as CANCELLED: a plain .ics import cannot express "this row
// should never have been in the file", only "this row is now cancelled",
// and re-emitting every past removal as CANCELLED forever would grow the
// file without bound. Removed items are simply absent (§7.5 of the design).
export const REMOVED_ITEMS_NOTE =
  "Removing an event from a plan will not remove it from a calendar you already imported. Re-export and re-import to update."

/** Escape RFC 5545 §3.3.11 TEXT special characters, in the correct order. */
export function escapeIcsText(value) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return normalized
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/**
 * Fold one logical content line at 75 octets per RFC 5545 §3.1, continuing
 * with CRLF + a single space. Splits on OCTET boundaries (UTF-8 bytes), not
 * JS string characters, and never inside a multi-byte sequence -- a naive
 * `slice(0, 75)` corrupts any non-ASCII title (the codebase already handles
 * `Café`-class titles elsewhere; see slug.js's NFD normalization for the
 * same concern in a different place).
 */
export function foldLine(line) {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line

  const decoder = new TextDecoder()
  const chunks = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Back off while the byte at the split point is a UTF-8 continuation
    // byte (10xxxxxx) -- splitting there would sever a multi-byte sequence.
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--
    chunks.push(bytes.slice(start, end))
    start = end
    limit = 74 // a continuation line's leading space counts toward its own 75-octet cap
  }
  return chunks.map((chunk, i) => (i === 0 ? '' : ' ') + decoder.decode(chunk)).join('\r\n')
}

/** `YYYYMMDDTHHMMSSZ` for a Date or ISO string, always UTC. */
export function formatUtcStamp(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate)
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}

/** ISO string `hours` after another ISO string. */
function addHoursIso(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString()
}

/**
 * SEQUENCE, per the design's shared formula (§7.5). Identical in both export
 * paths so the same event never gets two different SEQUENCE values.
 */
export function computeSequence(updatedAtIso) {
  if (!updatedAtIso) return 0
  const ms = Date.parse(updatedAtIso)
  if (!Number.isFinite(ms)) return 0
  const seconds = Math.floor((ms - SEQUENCE_EPOCH_MS) / 1000)
  return Math.max(0, Math.floor(seconds / 60))
}

/**
 * "{venue.name}, {address}, {city}, {state} {zip}" with empty parts dropped.
 * Returns null (property omitted) when there is no venue at all.
 */
function buildLocationText(venue) {
  if (!venue) return null
  const stateZip = [venue.state, venue.zip].filter((p) => p && String(p).trim()).join(' ')
  const parts = [venue.name, venue.address, venue.city, stateZip]
    .filter((p) => p && String(p).trim())
  return parts.length ? parts.join(', ') : null
}

/** Minimal filesystem-safe slug for the plan `.ics` filename (title only, no date suffix). */
function slugifyTitle(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/**
 * Filesystem-safe filename for a single event's `.ics` download.
 * Uses makeEventSlug (src/lib/slug.js) which already strips `/`, `\`, `:` --
 * the previous EventPage-local builder's naive `.replace(/\s+/g,'-')` did not.
 */
export function eventIcsFilename(event) {
  return `akron-pulse-${makeEventSlug(event)}.ics`
}

/**
 * Filesystem-safe filename for a plan export. NEVER the plan code -- a code
 * in a Downloads folder or a screen-share is the same leak the URL already
 * risks, just persisted to disk. Falls back to today's date (decorative
 * only, not a filter/business-logic date, so a UTC-derived fallback here
 * does not trip the project's "never derive today from toISOString()" rule).
 */
export function planIcsFilename(title) {
  const slug = title && title.trim() ? slugifyTitle(title) : ''
  const fallback = new Date().toISOString().slice(0, 10)
  return `akron-pulse-plan-${slug || fallback}.ics`
}

/** Build the unfolded content lines (no CRLF, no folding yet) for one VEVENT. */
function buildVEventLines(item, { now }) {
  const uid = `${item.id}@akronpulse.com`
  const hasEnd = !!item.end_at
  const endIso = hasEnd ? item.end_at : addHoursIso(item.start_at, 2)

  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatUtcStamp(now)}`,
    `DTSTART:${formatUtcStamp(item.start_at)}`,
    `DTEND:${formatUtcStamp(endIso)}`,
    `SUMMARY:${escapeIcsText(item.title)}`,
  ]

  const baseDesc = (item.description || '').slice(0, 500)
  const moreLine = `More: ${item.canonicalUrl}`
  let descBody = baseDesc ? `${baseDesc}\n\n${moreLine}` : moreLine
  if (!hasEnd) descBody += `\n\n${ASSUMED_DURATION_NOTE}`
  lines.push(`DESCRIPTION:${escapeIcsText(descBody)}`)

  const location = buildLocationText(item.venue)
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`)

  if (item.venue?.lat != null && item.venue?.lng != null) {
    lines.push(`GEO:${item.venue.lat};${item.venue.lng}`)
  }

  // URI value type -- not TEXT -- so no TEXT escaping. Omitted entirely (not
  // emitted empty) when there is nothing to link to; the previous builder's
  // `URL:` with no value was invalid per RFC 5545.
  const url = item.ticket_url || item.source_url || item.canonicalUrl
  if (url) lines.push(`URL:${url}`)

  if (item.category_slugs && item.category_slugs.length > 0) {
    lines.push(`CATEGORIES:${item.category_slugs.map(escapeIcsText).join(',')}`)
  }

  // The single highest-value line in the export: a re-import cancels the
  // entry in the user's real calendar instead of leaving a stale block.
  lines.push(`STATUS:${item.rot_status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`)
  lines.push(`SEQUENCE:${computeSequence(item.updated_at)}`)
  lines.push('END:VEVENT')
  return lines
}

/**
 * Build a full VCALENDAR document from one or more events.
 *
 * `gone` and `merged_duplicate` rot_status items are filtered out entirely:
 * a `gone` event has no reliable end time or location left to export (a
 * half-populated VEVENT is worse than an absent one), and a
 * `merged_duplicate` item is already represented in the file under its
 * canonical id. Every other item -- including `cancelled` -- IS exported;
 * see STATUS above for why `cancelled` especially must not be dropped.
 *
 * @param {IcsExportEvent[]} events
 * @param {{ name?: string|null }} [opts] - X-WR-CALNAME; defaults to a generic name.
 * @returns {string} CRLF-terminated VCALENDAR text.
 */
export function buildVCalendar(events, opts = {}) {
  const now = new Date()
  const visible = (events || []).filter(
    (e) => e.rot_status !== 'gone' && e.rot_status !== 'merged_duplicate',
  )
  const veventLines = visible.flatMap((e) => buildVEventLines(e, { now }))
  const calName = opts.name && opts.name.trim() ? opts.name.trim() : 'Akron Pulse day plan'

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Akron Pulse//Day Planner//EN',
    'CALSCALE:GREGORIAN',
    // No METHOD -- see this file's header. Do not add one.
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    ...veventLines,
    'END:VCALENDAR',
  ]

  return lines.map(foldLine).join('\r\n') + '\r\n'
}

/** Trigger a browser download of `content` as a `.ics` file named `filename`. Browser-only. */
export function downloadIcs(filename, content) {
  const blob = new Blob([content], { type: 'text/calendar' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
