/**
 * render.ts: the reply caps, the truncation, and the small formatting
 * primitives every handler shares.
 *
 * Pure functions of their arguments, in the shape of slack-notify/render.ts:
 * no Deno globals, no fetch, no Supabase client, so render.test.ts runs with
 * no network and no database.
 *
 * ── THE CAPS ARE THE POINT ────────────────────────────────────────────────
 * ADR section 6: "Fast lane: 6 lines or fewer, 600 characters or fewer. Hard-
 * capped in code." Byron reads on a phone and has corrected agents for
 * verbosity. The cap therefore lives HERE and not in each handler: handlers
 * return an array of lines, this file decides what actually ships. A handler
 * author cannot opt out of the cap by returning a pre-joined string, because
 * the type will not let them.
 *
 * That is the same reasoning as `MAX_ESCAPED_AGENT_TEXT_LEN` in
 * slack-notify/request.ts (3900), just far tighter, because that number caps
 * a report and this one caps a chat reply.
 *
 * ── WHY TRUNCATION IS NOT `slice()` ───────────────────────────────────────
 * Everything dynamic in a reply has already been through `escapeSlackText`,
 * so the string contains `&amp;`, `&lt;`, and `&gt;` sequences. A naive
 * `slice(0, 600)` can land in the middle of one and emit `&am`, which Slack
 * renders as literal garbage, or worse, land after `&` and `l` in a way that
 * changes how the remaining text parses. `truncateEscaped` refuses to cut
 * inside an entity and refuses to split a surrogate pair.
 *
 * Escaping itself is NOT done here. Handlers escape each dynamic value at the
 * moment they interpolate it (rule 5), because escaping a whole assembled
 * line would double-encode the ampersands the handler just produced, which is
 * the exact bug `escapeSlackText`'s own docstring warns about.
 */

import { escapeSlackText } from '../_shared/slack.ts'

/** ADR section 6. Both are hard caps, both enforced in `composeReply`. */
export const MAX_REPLY_LINES = 6
export const MAX_REPLY_CHARS = 600

/** The single-character ellipsis used for every truncation, so tests can pin it. */
export const ELLIPSIS = '…'

/**
 * Escape any value for Slack mrkdwn, coercing nullish to a visible placeholder
 * rather than the string "undefined".
 *
 * Every dynamic value in a reply goes through this: scraper names, error
 * strings, venue names, event titles. Scraper `last_error` is the highest-risk
 * field in the whole function (third-party text, stored verbatim, would
 * otherwise reach a channel raw), which is why `errorSnippet` below exists as
 * a named path for it rather than leaving it to each caller.
 */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '(none)'
  return escapeSlackText(String(value))
}

/**
 * Escape AND shorten a third-party error string.
 *
 * Order matters: shorten first, escape second. Escaping first then slicing
 * would reintroduce the mid-entity cut this file exists to prevent. Newlines
 * collapse to spaces so one stack trace cannot consume the whole line budget.
 */
export function errorSnippet(raw: unknown, max = 70): string {
  return shortEscaped(raw, max, 'no detail')
}

/**
 * Flatten, clip, then escape any third-party string: error text, event
 * titles, venue names. The general form of `errorSnippet`.
 *
 * Same order-of-operations rule: clip the RAW string, escape the result.
 * Escaping first and clipping second is how you emit a half-written `&am`.
 */
export function shortEscaped(raw: unknown, max = 70, fallback = '(untitled)'): string {
  if (raw === null || raw === undefined) return fallback
  const flat = String(raw).replace(/\s+/g, ' ').trim()
  if (!flat) return fallback
  const short = flat.length > max ? `${flat.slice(0, max - 1)}${ELLIPSIS}` : flat
  return escapeSlackText(short)
}

/** `1 event` / `2 events`, without a caller having to remember the plural. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// ── GA4 figures: the floor marker ─────────────────────────────────────────

/**
 * THE FLOOR MARKER. Every number sourced from GA4 is written `~1,234`.
 *
 * ── Why anything at all ───────────────────────────────────────────────────
 * GA4 under-counts, badly and by an unknown margin. Ad blockers, Safari and
 * Firefox tracking protection, and DNS blocklists all drop the beacon before
 * it fires; Byron's own browser network-blocks google-analytics.com, so his
 * own visits are not in the property at all. `page_views = 573` means "at
 * least 573", never "573". A bot that prints the bare number is making a
 * claim the data cannot support, and the person reading it will quote it to
 * a partner.
 *
 * ── Why a tilde on every figure, and not just one caveat line ─────────────
 * Three candidate designs, and the reasons the other two lose:
 *
 *   (a) A caveat line only. Cheapest, but a Slack reply gets screenshotted,
 *       quoted, and pasted one line at a time. The moment "2,431 views this
 *       week" travels without its footer it is a false claim, and the footer
 *       is the first thing to go.
 *   (b) The word "about" or "roughly" on each figure. Costs 5-7 characters
 *       per number in a 600-character budget, and it says the wrong thing:
 *       "about 573" means the truth could be 560, when in fact the truth is
 *       strictly HIGHER and possibly much higher. A symmetric hedge on an
 *       asymmetric error is a second inaccuracy.
 *   (c) `≥` or "at least" on each figure. Accurate but unreadable at a
 *       glance, and "at least" costs nine characters a number.
 *
 * So: one character per figure, which survives being quoted, plus ONE short
 * line per reply that says what the character means. The tilde alone would be
 * read as "rounded"; the line alone would be lost the first time someone
 * copies a number. Together they cost about 60 characters of a 600-character
 * budget and one line of six, which is the cheapest honest option available.
 *
 * Locale is pinned to en-US so the same data always renders the same string.
 */
export function gaNum(n: unknown): string {
  const value = Number(n)
  if (!Number.isFinite(value)) return '~0'
  return `~${Math.max(0, Math.round(value)).toLocaleString('en-US')}`
}

/**
 * The one line that gives the tilde its meaning. Appended by every handler
 * that reports a GA4 figure, and by no other handler.
 *
 * Deliberately a constant rather than a per-handler sentence: it must read
 * identically every time so a regular reader stops parsing it after the first
 * week, which is the only way a standing caveat avoids becoming noise.
 */
export const GA_FLOOR_NOTE = '~ = GA floor, not a count. Blocked browsers are invisible.'

/**
 * `up 15%` / `down 8%` / `flat`, or an empty string when there is no prior
 * figure to compare against.
 *
 * A zero prior is NOT rendered as an infinite rise: "up 100%" from nothing is
 * a number people repeat, and it means nothing. It renders as `new` instead.
 */
export function deltaPhrase(current: number, prior: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return ''
  if (prior <= 0) return current > 0 ? 'new' : ''
  const pct = Math.round(((current - prior) / prior) * 100)
  if (pct === 0) return 'flat'
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%`
}

/**
 * `eventbrite 12, akron_civic 6, akron_library 5`, the compact breakdown
 * shape from the ADR's worked example.
 *
 * Labels are escaped here because every caller feeds this database values.
 */
export function tallyLine(entries: readonly (readonly [string, number])[], max = 4): string {
  return entries
    .slice(0, max)
    .map(([label, count]) => `${esc(label)} ${count}`)
    .join(', ')
}

/**
 * Sort a tally map into descending-count order, ties broken alphabetically so
 * the same data always renders the same way (a reply that reshuffles between
 * two identical questions looks broken).
 */
export function rankTally(counts: ReadonlyMap<string, number>): (readonly [string, number])[] {
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
}

const ET_STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const ET_TIME_ONLY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/**
 * A timestamp as a human would say it, in Eastern time, never UTC.
 *
 * Same rule as everywhere else in this project: the reader is in Akron. When
 * the instant falls on the reader's own Eastern date the month and day are
 * dropped, because "10:02pm" is shorter than "Aug 22 10:02pm" and the line
 * budget is six lines.
 */
const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function etStamp(iso: unknown, todayEt: string): string {
  if (typeof iso !== 'string' || !iso) return 'unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  const sameDay = ET_DAY.format(d) === todayEt
  return (sameDay ? ET_TIME_ONLY : ET_STAMP)
    .format(d)
    .replace(/,\s+/g, ' ')
    .replace(/\s?([AP])M/, (_m, p) => `${p.toLowerCase()}m`)
}

/** Whole hours between an ISO instant and now, floored, never negative. */
export function hoursAgo(iso: unknown, now: Date): number | null {
  if (typeof iso !== 'string' || !iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 3_600_000))
}

/**
 * Truncate without breaking an escape sequence or a surrogate pair.
 *
 * Three guards, in order:
 *  1. Back off a trailing lone high surrogate, which would render as U+FFFD.
 *  2. If the cut point sits inside an unterminated `&…;` entity, move the cut
 *     back to before that `&`. Only the last 8 characters need inspecting,
 *     since the longest sequence this codebase emits is `&amp;` (5).
 *  3. If a space appears close to the cut, prefer it, so the reply ends on a
 *     word rather than mid-token.
 */
export function truncateEscaped(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text

  let cut = max - ELLIPSIS.length
  if (cut <= 0) return ELLIPSIS.slice(0, max)

  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1

  const window = text.slice(Math.max(0, cut - 8), cut)
  const amp = window.lastIndexOf('&')
  if (amp !== -1 && !window.slice(amp).includes(';')) {
    cut = Math.max(0, cut - 8) + amp
  }

  const tail = text.slice(Math.max(0, cut - 16), cut)
  const space = tail.lastIndexOf(' ')
  if (space > 0) cut = Math.max(0, cut - 16) + space

  return `${text.slice(0, cut).trimEnd()}${ELLIPSIS}`
}

/**
 * Apply the line cap. When there are more lines than fit, the last slot
 * becomes a count of what was dropped rather than silently vanishing: a
 * truncated ops answer that does not say it is truncated is how someone
 * concludes only three scrapers are broken.
 */
export function capLines(lines: readonly string[], max = MAX_REPLY_LINES): string[] {
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 0)
  if (clean.length <= max) return clean
  const kept = clean.slice(0, max - 1)
  kept.push(`+${clean.length - kept.length} more`)
  return kept
}

/**
 * Lines in, one Slack message out, both caps enforced.
 *
 * An empty result is never an empty string: silence is the worst outcome (ADR
 * section 7), so an empty line array becomes an explicit "no answer" that a
 * reader can act on. redact.ts treats a genuinely empty string as a violation
 * for the same reason, which makes this a belt-and-braces pair.
 */
export function composeReply(lines: readonly string[]): string {
  const capped = capLines(lines)
  if (capped.length === 0) return 'No answer produced.'
  return truncateEscaped(capped.join('\n'), MAX_REPLY_CHARS)
}
