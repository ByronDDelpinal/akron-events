// @ts-check
/**
 * datetimeLocal.js
 *
 * The bridge between the UTC instants we store (`events.start_at` /
 * `end_at` are `timestamptz`) and the native `<input type="datetime-local">`
 * controls in the admin editor and the public submit form.
 *
 * Product decision (June 2026): event times are shown in the *viewer's*
 * own timezone, consistently, everywhere. The public listing/detail
 * surfaces already get this for free because they format through
 * date-fns, which renders in the browser's local zone. The two form
 * surfaces did not: a `datetime-local` input is timezone-naive — it
 * displays and returns a bare `YYYY-MM-DDTHH:mm` wall-clock string with
 * no offset — so binding a raw UTC ISO string straight into one (via
 * `.slice(0, 16)`) leaked the UTC clock (a 5 PM Eastern event showed as
 * "9:00 PM"), and reading one back without interpreting it as local
 * mis-stored the instant.
 *
 * These two helpers are the single, symmetric conversion point:
 *   instant (UTC ISO)  →  toDatetimeLocalValue   →  input value (local)
 *   input value (local) → fromDatetimeLocalValue →  instant (UTC ISO)
 *
 * Kept as a pure, dependency-free `.js` module (matching dateRange.js /
 * slug.js) so the node:test harness can exercise the offset math under a
 * pinned TZ without a DOM or a TS loader.
 */

/**
 * Convert a stored UTC instant into the `YYYY-MM-DDTHH:mm` value a native
 * `<input type="datetime-local">` expects, expressed in the runtime's
 * local timezone (the viewer's browser zone in the app; `process.env.TZ`
 * in tests).
 *
 * Returns `''` for null / undefined / empty / unparseable input so the
 * result can bind directly to a controlled input without a guard.
 *
 * @param {string | null | undefined} iso
 *   An ISO-8601 instant, e.g. "2026-06-18T21:00:00+00:00". Any form
 *   `new Date()` accepts works.
 * @returns {string} `YYYY-MM-DDTHH:mm` in local time, or `''`.
 */
export function toDatetimeLocalValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // getTimezoneOffset() is minutes the local zone is *behind* UTC (EDT =
  // 240). Subtracting it shifts the instant so the UTC wall-clock equals
  // the local wall-clock, then we slice off the `YYYY-MM-DDTHH:mm` head.
  const localMs = d.getTime() - d.getTimezoneOffset() * 60_000
  return new Date(localMs).toISOString().slice(0, 16)
}

/**
 * Inverse of {@link toDatetimeLocalValue}: interpret a `datetime-local`
 * value as local wall-clock time and return the UTC ISO instant to
 * persist.
 *
 * Returns `null` for empty / unparseable input so it maps cleanly onto a
 * nullable column (e.g. `end_at`). `new Date('YYYY-MM-DDTHH:mm')` is
 * parsed in the local zone by the JS engine, which is exactly the
 * interpretation we want.
 *
 * @param {string | null | undefined} localValue
 *   A `YYYY-MM-DDTHH:mm` string from a datetime-local input.
 * @returns {string | null} UTC ISO instant (e.g. "2026-06-18T21:00:00.000Z"),
 *   or `null`.
 */
export function fromDatetimeLocalValue(localValue) {
  if (!localValue) return null
  const d = new Date(localValue)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
