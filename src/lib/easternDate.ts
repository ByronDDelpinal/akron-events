/**
 * easternDate.ts
 *
 * Pure, clock-injectable Eastern-time date primitives shared across the
 * site. Originally lived only in `dayPlanDate.ts` (day-planner-only, by that
 * module's own docstring); extracted here because the "When" date filter
 * (`whenFilter.ts`, `dateRange.js`) needs the same primitives and widening
 * `dayPlanDate.ts`'s contract would make its docstring wrong. `dayPlanDate.ts`
 * re-exports `easternDateKey` / `easternTodayIso` from here unchanged so no
 * existing call site has to move.
 *
 * Every function goes through `Intl.DateTimeFormat` with an explicit
 * `America/New_York` timeZone instead of arithmetic on a fixed UTC offset, so
 * results stay correct across the EST/EDT boundary without a manual DST
 * table. Never derive "today" from `new Date().toISOString()` or compare a
 * Date object to a date string -- a UTC-derived "today" rolls over up to 5
 * hours before Eastern midnight, which is the exact class of bug this module
 * exists to prevent (see `scripts/tests/test-no-utc-today.js`).
 */

const EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const EASTERN_CLOCK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

/**
 * `yyyy-MM-dd` of an ISO instant, AS OBSERVED IN America/New_York.
 * `en-CA` locale formats numeric dates as `yyyy-MM-dd` directly, so no
 * further reassembly of Intl's parts is needed.
 */
export function easternDateKey(isoInstant: string | Date): string {
  const d = isoInstant instanceof Date ? isoInstant : new Date(isoInstant)
  return EASTERN_DATE_FORMATTER.format(d)
}

/** Today's date, as observed in America/New_York, as `yyyy-MM-dd`. */
export function easternTodayIso(): string {
  return easternDateKey(new Date())
}

/**
 * Convert a wall-clock instant expressed as a UTC-ms value (Date.UTC of the
 * LOCAL Y/M/D/h/m/s) in America/New_York to an ISO 8601 UTC string.
 *
 * Uses Intl to resolve the EST<->EDT offset -- the browser twin of
 * `scripts/lib/normalize.js`'s `easternWallMsToUtcIso`, same technique
 * (format the candidate instant back through the America/New_York zone,
 * measure the drift, correct for it). A fixed -4/-5 approximation puts the
 * boundary hours early on transition days; do not reintroduce one here.
 */
function easternWallMsToUtcIso(asIfUtcMs: number): string {
  const parts = EASTERN_CLOCK_FORMATTER.formatToParts(new Date(asIfUtcMs))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const asTzMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    parseInt(get('hour'), 10) % 24,
    parseInt(get('minute'), 10),
    parseInt(get('second'), 10),
  )
  return new Date(asIfUtcMs + (asIfUtcMs - asTzMs)).toISOString()
}

/**
 * Convert an Eastern wall-clock date + time to an ISO 8601 UTC instant.
 * `ymd` is `'YYYY-MM-DD'`; `hms` is `'HH:mm:ss'` (24-hour). This is the
 * browser twin of `scripts/lib/normalize.js`'s `easternToIso` two-argument
 * form, and a drift test in `scripts/tests/test-when-filter.js` asserts the
 * two stay byte-identical across a DST-transition fixture set -- the browser
 * bundle must not import `scripts/lib/normalize.js` directly, so the
 * duplicate exists on purpose and the test is what keeps it honest.
 */
export function easternIsoAt(ymd: string, hms: string): string {
  const [year, month, day] = ymd.split('-').map(Number)
  const [hour, minute, second] = hms.split(':').map(Number)
  const asIfUtcMs = Date.UTC(year, month - 1, day, hour, minute, second || 0)
  return easternWallMsToUtcIso(asIfUtcMs)
}

/**
 * `HH:mm:ss` clock time of an ISO instant, AS OBSERVED IN America/New_York.
 * The twin of `easternDateKey`: together they give the Eastern civil
 * date+time pair `event_series` stores (`dtstart_date` / `start_time`, whose
 * `tz` is CHECK-pinned to America/New_York by migration 069).
 *
 * Reads `EASTERN_CLOCK_FORMATTER` through `formatToParts` exactly the way
 * `easternWallMsToUtcIso` above does. Do not reach for a second
 * `Intl.DateTimeFormat` with a slightly different option set: a divergent
 * formatter is the drift this module exists to prevent.
 */
export function easternTimeKey(isoInstant: string | Date): string {
  const d = isoInstant instanceof Date ? isoInstant : new Date(isoInstant)
  const parts = EASTERN_CLOCK_FORMATTER.formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  // en-US with hour12:false renders midnight as '24'; normalise to '00'.
  const hour = String(parseInt(get('hour'), 10) % 24).padStart(2, '0')
  return `${hour}:${get('minute')}:${get('second')}`
}
