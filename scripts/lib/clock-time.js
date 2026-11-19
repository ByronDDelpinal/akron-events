/**
 * clock-time.js — strict parsing for a clock time and a month name printed on
 * a hand-maintained page ("7:30 PM", "7:30pm", "2 PM"; "November", "Nov.").
 *
 * Strict on purpose: these feed start times, and a start time that is guessed
 * is worse than a listing that is skipped and counted. Anything that is not a
 * whole clock time returns null.
 */

export const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

/** Alternation of full month names, for building regular expressions. */
export const MONTH_RE = Object.keys(MONTHS).join('|')

/** "November" / "nov" / "Sept." → 11 / 11 / 9; null for anything else. */
export function monthNumber(name = '') {
  const key = String(name).toLowerCase().replace(/\.$/, '').trim()
  if (key.length < 3) return null
  if (MONTHS[key]) return MONTHS[key]
  const hits = Object.keys(MONTHS).filter((m) => m.startsWith(key))
  return hits.length === 1 ? MONTHS[hits[0]] : null
}

/**
 * "7:30 PM" / "7:30pm" / "2 PM" / "12:30 a.m." →
 *   { time: '7:30 pm', hhmm: '1930' }   (time is the easternToIso() format)
 * null when the text is not exactly one 12-hour clock time.
 */
export function parseClockTime(text = '') {
  const m = String(text).trim().match(/^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)$/i)
  if (!m) return null
  const hour = Number(m[1])
  if (hour < 1 || hour > 12) return null
  const minute = m[2] ?? '00'
  const mer = /^p/i.test(m[3]) ? 'pm' : 'am'
  const hour24 = (hour % 12) + (mer === 'pm' ? 12 : 0)
  return { time: `${hour}:${minute} ${mer}`, hhmm: `${String(hour24).padStart(2, '0')}${minute}` }
}
