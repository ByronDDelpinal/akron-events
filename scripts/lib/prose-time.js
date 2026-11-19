/**
 * prose-time.js — read a start time out of a sentence, or decline to.
 *
 * Several small organizations publish a date field with no time and put the
 * time in the description: "Saturday, November 21st from 12-3 p.m.",
 * "Doors open at 6:30pm". Leaving those at the noon placeholder mis-states
 * the event; guessing wrong mis-states it worse. So this is deliberately
 * narrow:
 *
 *   • It returns a time only when the text contains EXACTLY ONE distinct
 *     clock expression. "6:30am registration, 8:00am race begins" has two,
 *     and which one is "the start" is a judgment this module will not make:
 *     it returns null and the caller keeps the flagged placeholder.
 *   • An explicit statement wins: "Doors open at 5 p.m. … The program will
 *     start at 6 p.m." is two clock times, but only one of them is said to
 *     be the start, so 6 p.m. is returned.
 *   • A bare number is never a time. "12-3" counts only because "p.m."
 *     follows; "ages 5-12" and "room 245" do not.
 *   • Phone numbers and street numbers cannot match: a meridiem is required
 *     on at least one side of every expression.
 *
 * Pure: no clock, no I/O.
 */

const MERIDIEM = '(a\\.?m\\.?|p\\.?m\\.?)'
const CLOCK = '(\\d{1,2})(?::([0-5]\\d))?'

// "12-3 p.m.", "10:00 - 11:30 AM", "6pm to 8pm", "9 a.m.–noon" is NOT handled
// (no second clock), and falls through to the single-time pattern.
const RANGE_RE = new RegExp(
  `(?<![\\d:$.])${CLOCK}\\s*${MERIDIEM}?\\s*(?:-|–|—|to|until)\\s*${CLOCK}\\s*${MERIDIEM}(?![a-z])`, 'gi',
)
const SINGLE_RE = new RegExp(`(?<![\\d:$.])${CLOCK}\\s*${MERIDIEM}(?![a-z])`, 'gi')
// "will start at 6 p.m.", "begins promptly at 7:30pm", "kicks off at noon" (no).
const STATED_START_RE = new RegExp(
  `\\b(?:starts?|begins?|kicks?\\s+off)\\s+(?:promptly\\s+)?at\\s+${CLOCK}\\s*${MERIDIEM}(?![a-z])`, 'gi',
)

function meridiem(token) {
  return /^p/i.test(token) ? 'pm' : 'am'
}

function valid(hour, minute) {
  return hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59
}

function fmt(hour, minute, mer) {
  return `${hour}:${String(minute).padStart(2, '0')} ${mer}`
}

function minutesOfDay(hour, minute, mer) {
  return ((hour % 12) + (mer === 'pm' ? 12 : 0)) * 60 + minute
}

/**
 * @param {string} text  plain text (strip HTML first)
 * @param {object} [opts]
 * @param {boolean} [opts.earliestOfSlots=false]  when the text lists several
 *   bare start times and no ranges ("tours at 1 p.m., 2 p.m. and 3 p.m."),
 *   return the earliest instead of declining. Off by default: it is right for
 *   a source whose listings are repeated slots of one thing, and wrong for one
 *   where the times are different things ("6:30am registration, 8am race").
 *   The calling scraper has to know which it is.
 * @returns {{startTime: string, endTime: string|null}|null}
 *   times as "h:mm am|pm", ready for easternToIso(date, time)
 */
export function proseTime(text, { earliestOfSlots = false } = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ')
  if (!s) return null

  const stated = new Map()
  for (const m of s.matchAll(STATED_START_RE)) {
    const hour = Number(m[1]), minute = Number(m[2] ?? 0)
    if (valid(hour, minute)) stated.set(fmt(hour, minute, meridiem(m[3])), true)
  }
  if (stated.size === 1) return { startTime: [...stated.keys()][0], endTime: null }

  const found = []
  const consumed = []

  for (const m of s.matchAll(RANGE_RE)) {
    const [whole, h1, m1, mer1, h2, m2, mer2] = m
    const startHour = Number(h1), startMin = Number(m1 ?? 0)
    const endHour = Number(h2), endMin = Number(m2 ?? 0)
    if (!valid(startHour, startMin) || !valid(endHour, endMin)) continue
    const endMer = meridiem(mer2)
    // "12-3 p.m." and "10:00 - 11:30 AM": the start borrows the end's
    // meridiem, unless that would put it after the end ("11-1 p.m." starts in
    // the morning).
    let startMer = mer1 ? meridiem(mer1) : endMer
    if (!mer1 && minutesOfDay(startHour, startMin, startMer) >= minutesOfDay(endHour, endMin, endMer)) {
      startMer = endMer === 'pm' ? 'am' : 'pm'
    }
    found.push({ startTime: fmt(startHour, startMin, startMer), endTime: fmt(endHour, endMin, endMer) })
    consumed.push([m.index, m.index + whole.length])
  }

  for (const m of s.matchAll(SINGLE_RE)) {
    if (consumed.some(([a, b]) => m.index >= a && m.index < b)) continue
    const hour = Number(m[1]), minute = Number(m[2] ?? 0)
    if (!valid(hour, minute)) continue
    found.push({ startTime: fmt(hour, minute, meridiem(m[3])), endTime: null })
  }

  // The same expression repeated ("7 p.m." in the headline and the body) is
  // one time. Two different ones are ambiguous.
  const distinct = new Map(found.map((f) => [`${f.startTime}|${f.endTime ?? ''}`, f]))
  // A range plus its own start stated alone ("7-9 p.m. ... doors at 7 p.m.")
  // is still one answer: keep the range.
  if (distinct.size === 2) {
    const [a, b] = [...distinct.values()]
    if (a.startTime === b.startTime && (a.endTime === null) !== (b.endTime === null)) {
      return a.endTime ? a : b
    }
  }
  if (distinct.size === 1) return [...distinct.values()][0]

  const all = [...distinct.values()]
  if (earliestOfSlots && all.length > 1 && all.every((f) => f.endTime === null)) {
    const toMinutes = (t) => {
      const [, h, mi, mer] = t.match(/^(\d{1,2}):(\d{2}) (am|pm)$/)
      return minutesOfDay(Number(h), Number(mi), mer)
    }
    return all.reduce((a, b) => (toMinutes(b.startTime) < toMinutes(a.startTime) ? b : a))
  }
  return null
}
