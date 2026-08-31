// @ts-check
/**
 * eventTimes.js
 *
 * Pure, dependency-free helpers for the start/end coupling in every event
 * form. They operate on the same timezone-naive `YYYY-MM-DDTHH:mm` local
 * wall-clock strings that the form state already holds (the shape
 * datetimeLocal.js bridges to/from the stored UTC instant), so they slot in
 * without touching that bridge.
 *
 * Kept as a `.js` module (matching datetimeLocal.js / dateRange.js) so the
 * node:test harness can exercise the math under a pinned TZ with no DOM.
 *
 * Parsing uses `new Date('YYYY-MM-DDTHH:mm')`, which the JS engine reads in
 * the local zone -- the same interpretation datetimeLocal.js relies on.
 */

/** Default gap applied to a fresh end when a start is chosen: two hours. */
export const DEFAULT_EVENT_MINUTES = 120

/**
 * Format a Date as a local `YYYY-MM-DDTHH:mm` string (no offset), the exact
 * shape the form controls consume.
 * @param {Date} d
 * @returns {string}
 */
function formatLocal(d) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * Shift a local datetime string by a number of minutes, returning the same
 * local shape. Empty / unparseable input returns `''`.
 * @param {string | null | undefined} value `YYYY-MM-DDTHH:mm`
 * @param {number} minutes
 * @returns {string}
 */
export function addMinutesToLocal(value, minutes) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  d.setMinutes(d.getMinutes() + minutes)
  return formatLocal(d)
}

/**
 * Chronological comparison of two local datetime strings. Empty strings are
 * treated as "unset" and sort AFTER any real instant, so an unset bound never
 * looks like it precedes a set one. Returns <0, 0, or >0.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number}
 */
export function compareLocal(a, b) {
  const ta = a ? new Date(a).getTime() : NaN
  const tb = b ? new Date(b).getTime() : NaN
  const va = Number.isNaN(ta) ? Infinity : ta
  const vb = Number.isNaN(tb) ? Infinity : tb
  return va - vb
}

/**
 * Raise a value to a floor: if `value` is chronologically before `min`,
 * return `min`; otherwise return `value` unchanged. Missing operands pass
 * `value` through untouched. This is how the end control makes "before the
 * start" simply not expressible -- no error, the value is snapped forward.
 * @param {string} value
 * @param {string | null | undefined} min
 * @returns {string}
 */
export function clampToMin(value, min) {
  if (!value || !min) return value
  return new Date(value).getTime() < new Date(min).getTime() ? min : value
}

/**
 * The end value to use after a start is set or changed. An empty or now-invalid
 * end (at or before the start) is refilled to start + `durationMinutes`; an end
 * that still sits after the start is left exactly as the user set it.
 * @param {string} start `YYYY-MM-DDTHH:mm` or ''
 * @param {string} end   `YYYY-MM-DDTHH:mm` or ''
 * @param {number} [durationMinutes]
 * @returns {string}
 */
export function deriveEndForStart(start, end, durationMinutes = DEFAULT_EVENT_MINUTES) {
  if (!start) return end
  if (!end) return addMinutesToLocal(start, durationMinutes)
  if (new Date(end).getTime() <= new Date(start).getTime()) {
    return addMinutesToLocal(start, durationMinutes)
  }
  return end
}
