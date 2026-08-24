import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 -> Postgres loader. The storage half of the six read-only GA scripts.
 *
 * ga-snapshot.js, ga-top-pages.js, ga-outbound-by-event.js,
 * ga-embeds-snapshot.js, ga-install-snapshot.js and ga-impact.js all query GA4
 * well and then print JSON to stdout, where the number is read once and lost.
 * This script runs the same reports and UPSERTS them into the three tables
 * from supabase/migrations/062_site_metrics.sql, so the Slack bot can answer
 * traffic questions from Postgres with the service role and no GA credential
 * anywhere near an edge function.
 *
 * Auth is NOT reimplemented: `loadConfig` and `mintJwt` are imported from
 * ga-snapshot.js, exactly as the other five siblings do.
 *
 * Usage:
 *   node scripts/ga-to-db.js                        # trailing 3 days (nightly)
 *   node scripts/ga-to-db.js --days 7               # trailing 7 days
 *   node scripts/ga-to-db.js --from 2026-05-27      # backfill to yesterday
 *   node scripts/ga-to-db.js --from 2026-06-01 --to 2026-06-30
 *   node scripts/ga-to-db.js --dry-run              # print rows, write nothing
 *   node scripts/ga-to-db.js --from 2026-05-27 --no-rolling
 *
 * Env vars:
 *   GA4_PROPERTY_ID            numeric GA4 property id (538991588)
 *   GA4_SA_KEY_B64             base64 service-account JSON key
 *   VITE_SUPABASE_URL          } required for a real write; NOT read in
 *   SUPABASE_SERVICE_ROLE_KEY  } --dry-run, which never loads the client
 *
 * ── NOT_CONFIGURED CONTRACT (inherited, unchanged) ─────────────────────────
 * Missing or empty GA4_PROPERTY_ID / GA4_SA_KEY_B64 prints the literal line
 * NOT_CONFIGURED to stdout and exits 0, so the nightly chain skips the section
 * instead of going red. Real failures print ONE line to stderr prefixed
 * "ga-to-db:" and exit 1. No error path ever includes key material, a JWT
 * assertion, an access token, or the service-role key: the only third-party
 * text that reaches stderr is a Google error body, truncated to 200 chars,
 * which is the same rule ga-snapshot.js states.
 *
 * ── WHY A TRAILING WINDOW AND NOT JUST YESTERDAY ───────────────────────────
 * GA4 keeps revising a day for roughly 48 hours after it closes: late hits,
 * session stitching and identity resolution all land after midnight. Writing
 * yesterday once and never looking again bakes that undercount into the table
 * permanently, and the bot would then report a number GA4 itself no longer
 * agrees with.
 *
 * So the default is a TRAILING 3-DAY WINDOW ending yesterday, re-written in
 * full on every run. Three, not two: with a 3-day window every date is written
 * on three separate nights, and the last of those writes happens more than 48
 * hours after the date closed, so every row eventually settles on GA4's final
 * answer. The upserts are keyed on the natural grain, so re-writing is free of
 * consequence -- a re-run overwrites in place and can never duplicate a day.
 *
 * The window NEVER includes today. Today is a partial day that keeps growing;
 * storing it would mean the same script writes a different number at 9am than
 * at noon, and ga-impact.js documents a case where a same-day pull was off by
 * 3x and pointed the wrong way. Same rule, same reason.
 *
 * ── QUOTAS, AND WHAT IS ASSUMED ────────────────────────────────────────────
 * Standard GA4 Data API properties allow far more per day than this needs
 * (property-level request and token quotas in the tens of thousands), but
 * there is a concurrency limit, so every request here is issued SEQUENTIALLY
 * with a short pause between chunks. No parallelism, deliberately: this is a
 * nightly job with no latency requirement, and being a polite client is worth
 * more than finishing eight seconds sooner.
 *
 * Cost is bounded and predictable:
 *   * the six day-dimensioned reports are issued once per CHUNK_DAYS-day
 *     chunk, not once per day, so a 3-day nightly run costs 6 requests and a
 *     full 90-day backfill costs about 78;
 *   * the two rolling distinct-user reports are the exception and cost 2
 *     requests PER DATE, because a distinct-user count over a window cannot be
 *     assembled from per-day rows (see the non-additivity note below). A
 *     nightly run therefore costs 6 more; a 90-day backfill costs 180 more.
 *     `--no-rolling` skips them entirely and leaves those two columns
 *     untouched, which is the right flag for a large historical backfill where
 *     an install-base figure for a date three months ago helps nobody.
 * Worst case measured against the sequential pacing: a full backfill is a
 * couple of minutes, not an hour.
 *
 * ── THE TWO HONESTY RULES THIS SCRIPT ENFORCES AT THE SOURCE ───────────────
 * 1. GA IS A FLOOR. Ad blockers, tracking protection and DNS blocklists drop
 *    the beacon; the maintainer's own browser blocks google-analytics.com.
 *    Every figure written here is a lower bound on reality. This script never
 *    scales, grosses up or "corrects" a number to compensate -- an invented
 *    correction factor would be worse than an honest undercount -- and every
 *    row carries `fetched_at` so a consumer can tell a settled row from a
 *    provisional one.
 * 2. USER COUNTS ARE NOT ADDITIVE. GA4's totalUsers for a day is that day's
 *    distinct users. Summing seven of them counts Tuesday's returning visitor
 *    twice. This script stores the daily figures as GA4 reports them and does
 *    NOT pre-aggregate; anything that sums them owes the reader the words
 *    "visitor-days". The one place a true windowed distinct count is needed --
 *    the installed base -- is asked of GA4 as its own report rather than
 *    derived, which is the whole reason pwa_users_7d/28d exist as columns.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://analyticsdata.googleapis.com/v1beta'

/** First day of data in the property. Matches ga-install-snapshot.js. */
const TRACKING_START = '2026-05-27'

/** The property's own timezone, and therefore what a metric_date means. */
const PROPERTY_TZ = 'America/New_York'

/**
 * Days per GA4 request for the day-dimensioned reports.
 *
 * Seven keeps every response comfortably inside GA4's 10,000-row default cap
 * even for the page report (a busy day has a few hundred distinct paths), and
 * a truncated response is detected rather than assumed away: GA4 returns
 * `rowCount` (total matching rows) alongside the rows it sent, so the loader
 * compares the two and warns on stderr if they differ.
 */
const CHUNK_DAYS = 7

/** GA4's row cap per request. Requested explicitly so the value is visible. */
const ROW_LIMIT = 10000

/**
 * Pages stored per day, on top of every page that had an outbound click.
 *
 * GA4's pagePath dimension excludes the query string, so cardinality is bounded
 * by real routes plus event slugs and 500 covers a normal day whole. The
 * outbound-click exemption matters more than the number: an event page with 2
 * views and 1 click off to a ticket seller is the most valuable row in the
 * table and must never be trimmed for being unpopular.
 */
const TOP_PAGES_PER_DAY = 500

/** Rows per upsert round-trip. */
const UPSERT_BATCH = 500

/**
 * Column bounds from migration 062, enforced HERE as well as by the CHECK
 * constraints.
 *
 * A constraint violation is the worst possible way to learn about a long path.
 * main() writes site, then pages, then embeds with NO enclosing transaction,
 * so one over-length row throws inside upsertAll and the run exits 1 having
 * written site fully and pages partially. A re-run repairs it, but a
 * crawler-forged URL recurs every night, so that partial state would become
 * permanent. Clamping turns a nightly outage into one warning line.
 */
const MAX_PAGE_PATH = 512
const MAX_URL_SLUG = 300
const MAX_EMBED_HOST = 253

/** Pause between chunks. Politeness, not a rate-limit workaround. */
const CHUNK_PAUSE_MS = 250

const EV_OUTBOUND = 'outbound_click'
const EV_VIEW = 'view_event'
const EV_STANDALONE = 'pwa_standalone_launch'
const EV_INSTALL = 'pwa_install_accepted'

/**
 * Event detail pages are /events/{url-slug}/{uuid}. Same shape as ga-impact.js.
 *
 * BOTH captures matter, and only one of them is a key. The uuid is `events.id`
 * and is the ONLY reliable join back to the database. The url-slug is a
 * DATE-suffixed display slug ("ales-on-rails-aug-21") while `events.slug` is
 * YEAR-suffixed ("ales-on-rails-2026"): checked against production, four
 * url-slugs pulled from live GA4 data matched zero rows on events.slug while
 * all four uuids matched events.id exactly, and 11,318 of 11,321 published
 * events carry the year form. Joining on the slug returns nothing, silently.
 * It is stored as a readable label and nothing else.
 */
// `([^/]+)` and NOT `(.+)`. A greedy capture on a malformed
// /events/x/{uuid}/{uuid} path puts a uuid INSIDE the slug, and the bot's
// redaction filter withholds any reply carrying one, so a single junk path in
// a week of GA data would cost a whole top-pages answer. Bounding the capture
// means a slug physically cannot contain a path separator; such a path simply
// comes back unmatched (event_id null) instead of poisoning a label.
const EVENT_PATH_RE =
  /^\/events\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

// ── Argument parsing ────────────────────────────────────────────────────────

/**
 * Parse argv with hard bounds. Every failure here is a thrown Error, which
 * main() turns into one stderr line and exit 1 -- never a silently-clamped
 * value that produces a plausible but wrong load.
 */
export function parseArgs(argv, todayIso) {
  const out = { days: 3, from: null, to: null, dryRun: false, rolling: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--days') out.days = Number(next())
    else if (a === '--from') out.from = String(next() ?? '')
    else if (a === '--to') out.to = String(next() ?? '')
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-rolling') out.rolling = false
    else throw new Error(`unknown argument "${a}"`)
  }

  const yesterday = addDays(todayIso, -1)

  // `--to` on its own would silently do a trailing-window run and ignore the
  // date the caller typed, which is the kind of quiet disagreement that gets
  // noticed three backfills later.
  if (out.to && !out.from) throw new Error('--to requires --from')

  if (out.from) {
    if (!isIsoDate(out.from)) throw new Error('--from must be YYYY-MM-DD')
    if (out.to && !isIsoDate(out.to)) throw new Error('--to must be YYYY-MM-DD')
    const end = out.to ?? yesterday
    // Refuse today and the future outright rather than quietly clipping. A
    // partial day stored as a whole one is the exact trap ga-impact.js exists
    // to avoid, and a caller who typed today's date wants to know.
    if (end >= todayIso) {
      throw new Error(`--to ${end} is not a complete day in ${PROPERTY_TZ}; latest allowed is ${yesterday}`)
    }
    if (out.from > end) throw new Error(`--from ${out.from} is after --to ${end}`)
    if (out.from < TRACKING_START) {
      throw new Error(`--from ${out.from} predates the property's first day of data (${TRACKING_START})`)
    }
    return { ...out, start: out.from, end }
  }

  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 365) {
    throw new Error('--days must be an integer between 1 and 365')
  }
  const start = addDays(yesterday, -(out.days - 1))
  return { ...out, start: start < TRACKING_START ? TRACKING_START : start, end: yesterday }
}

// ── Dates. Eastern, always, because that is the property's timezone ─────────

const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: PROPERTY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today in the property's timezone, YYYY-MM-DD. Never a UTC date. */
export function todayInProperty(now = new Date()) {
  return ET_DAY.format(now)
}

export function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

/**
 * Calendar-date arithmetic done in UTC on a date-only value.
 *
 * Safe here precisely BECAUSE it never touches a clock: `YYYY-MM-DD` is
 * parsed as a UTC midnight, shifted by whole days, and formatted back. No
 * local Date is constructed and no toISOString() is called on an instant, so
 * the off-by-one that rule bans cannot occur.
 */
export function addDays(iso, days) {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

export function eachDate(start, end) {
  const out = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** Split an inclusive range into chunks of at most `size` days. */
export function chunkRange(start, end, size = CHUNK_DAYS) {
  const chunks = []
  let cursor = start
  while (cursor <= end) {
    const last = addDays(cursor, size - 1)
    chunks.push({ start: cursor, end: last > end ? end : last })
    cursor = addDays(last, 1)
  }
  return chunks
}

/** GA4's `date` dimension is YYYYMMDD. */
export function gaDateToIso(raw) {
  const s = String(raw ?? '')
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null
}

/**
 * Clamp a value to a column bound, warning once per distinct offender so a
 * pathological crawler cannot flood stderr with the same path every night.
 */
const clampWarned = new Set()
export function clampField(value, max, label) {
  const str = String(value ?? '')
  if (str.length <= max) return str
  if (!clampWarned.has(str)) {
    clampWarned.add(str)
    warn(`${label} exceeded ${max} chars and was clamped: ${str.slice(0, 80)}`)
  }
  return str.slice(0, max)
}

/**
 * Lowercase any uuid segment in a path so it is ONE primary-key row.
 *
 * GA4 reports the path as it was requested, and a link carrying an upper-case
 * uuid is the same page as one carrying a lower-case uuid. Without this they
 * are two rows under `(metric_date, page_path)` and their views never
 * combine, so a page quietly under-reports itself. event_id is lowercased for
 * the same reason and the path has to agree with it.
 */
export function canonicalPath(path) {
  return String(path ?? '').replace(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    (m) => m.toLowerCase(),
  )
}

/**
 * `/events/{url-slug}/{uuid}` -> `{ eventId, urlSlug }`; anything else ->
 * `{ eventId: null, urlSlug: null }`.
 *
 * eventId is lowercased so the stored value matches events.id regardless of
 * how GA4 happened to report the path.
 */
export function eventKeyFromPath(path) {
  const m = EVENT_PATH_RE.exec(String(path ?? ''))
  if (!m) return { eventId: null, urlSlug: null }
  return { eventId: m[2].toLowerCase(), urlSlug: m[1] }
}

// ── GA4 transport ───────────────────────────────────────────────────────────

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) })
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return JSON.parse(body)
}

/**
 * Exchange the signed JWT for an access token.
 *
 * `mintJwt` comes from ga-snapshot.js. The assertion is built, sent, and
 * dropped; neither it nor the returned token is ever logged, returned in an
 * error, or written to a file.
 */
async function getAccessToken(sa) {
  const data = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: mintJwt(sa),
    }).toString(),
  })
  if (!data.access_token) throw new Error('token endpoint returned no access_token')
  return data.access_token
}

function makeRunner(token, propertyId) {
  return async function runReport(body) {
    const rep = await fetchJson(`${API}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // Truncation is DETECTED, not assumed away. rowCount is the total number
    // of matching rows; rows is what fitted in the response.
    const sent = (rep.rows || []).length
    if (typeof rep.rowCount === 'number' && rep.rowCount > sent) {
      warn(`report truncated: GA4 matched ${rep.rowCount} rows, returned ${sent}. Lower CHUNK_DAYS.`)
    }
    return rep
  }
}

// ── Response shaping ────────────────────────────────────────────────────────

/**
 * Index dimension and metric columns BY HEADER NAME, never by position.
 * GA4 echoes whatever order it likes and moves synthetic columns around; every
 * sibling script makes the same point.
 */
export function indexer(report) {
  const dims = (report?.dimensionHeaders || []).map((h) => h.name)
  const mets = (report?.metricHeaders || []).map((h) => h.name)
  return {
    rows: report?.rows || [],
    dim(row, name) {
      const i = dims.indexOf(name)
      return i >= 0 ? row.dimensionValues?.[i]?.value ?? null : null
    },
    num(row, name) {
      const i = mets.indexOf(name)
      const v = i >= 0 ? row.metricValues?.[i]?.value : undefined
      const n = Number(v ?? 0)
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0
    },
  }
}

/** An empty row for one date, so a zero-traffic day is stored rather than skipped. */
function blankSiteRow(metricDate) {
  return {
    metric_date: metricDate,
    active_users: 0,
    total_users: 0,
    new_users: 0,
    sessions: 0,
    engaged_sessions: 0,
    page_views: 0,
    outbound_clicks: 0,
    outbound_users: 0,
    view_event_fires: 0,
    view_event_users: 0,
    pwa_launches: 0,
    pwa_launch_users: 0,
    pwa_install_accepted: 0,
  }
}

/**
 * Build the site-wide daily rows from the audience report and the event report.
 *
 * A date present in the requested range but absent from GA4's response is
 * still written, as a row of zeros. That is a real fact ("nobody came" or "the
 * beacon reached nobody") and a missing row would be indistinguishable from
 * "the loader never ran for that date".
 */
export function buildSiteRows(dates, audienceReport, eventReport) {
  const byDate = new Map(dates.map((d) => [d, blankSiteRow(d)]))

  const a = indexer(audienceReport)
  for (const row of a.rows) {
    const d = gaDateToIso(a.dim(row, 'date'))
    const target = d && byDate.get(d)
    if (!target) continue
    target.active_users = a.num(row, 'activeUsers')
    target.total_users = a.num(row, 'totalUsers')
    target.new_users = a.num(row, 'newUsers')
    target.sessions = a.num(row, 'sessions')
    target.engaged_sessions = a.num(row, 'engagedSessions')
    target.page_views = a.num(row, 'screenPageViews')
  }

  const e = indexer(eventReport)
  for (const row of e.rows) {
    const d = gaDateToIso(e.dim(row, 'date'))
    const target = d && byDate.get(d)
    if (!target) continue
    // Exact names only. GA4 event names are case-sensitive and the property
    // carries legacy capitalised remnants; grouping BY eventName means a
    // stray `Pwa_install_accepted` arrives as its own row and this switch
    // simply ignores it, which is what ga-install-snapshot.js relies on too.
    const name = e.dim(row, 'eventName')
    const count = e.num(row, 'eventCount')
    const users = e.num(row, 'totalUsers')
    if (name === EV_OUTBOUND) {
      target.outbound_clicks = count
      target.outbound_users = users
    } else if (name === EV_VIEW) {
      target.view_event_fires = count
      target.view_event_users = users
    } else if (name === EV_STANDALONE) {
      target.pwa_launches = count
      target.pwa_launch_users = users
    } else if (name === EV_INSTALL) {
      target.pwa_install_accepted = count
    }
  }

  return dates.map((d) => byDate.get(d))
}

/**
 * Build per-page rows by merging three reports on (date, pagePath).
 *
 * The link_type split is optional: `runByLinkType` may legitimately fail when
 * the custom dimension is not registered in GA4 Admin, and the caller passes
 * null in that case. Totals stay correct; only the tickets/source breakdown
 * is missing, exactly as ga-outbound-by-event.js documents.
 */
export function buildPageRows(viewsReport, outboundReport, linkTypeReport) {
  const rows = new Map()
  // No separator needed and none used: metric_date is a fixed-width 10
  // characters and every page_path begins with `/`, so the concatenation is
  // unambiguous. (A previous revision of this line carried a stray NUL.)
  const key = (d, p) => `${d}${p}`
  const get = (d, rawPath) => {
    // Canonicalised and bounded BEFORE the row is keyed, so the map key and
    // the stored value are the same string and two casings of one uuid land
    // on one row rather than two that never add up.
    const p = clampField(canonicalPath(rawPath), MAX_PAGE_PATH, 'page_path')
    const k = key(d, p)
    if (!rows.has(k)) {
      const { eventId, urlSlug } = eventKeyFromPath(p)
      rows.set(k, {
        metric_date: d,
        page_path: p,
        event_id: eventId,
        url_slug: urlSlug === null ? null : clampField(urlSlug, MAX_URL_SLUG, 'url_slug'),
        page_views: 0,
        users: 0,
        outbound_clicks: 0,
        outbound_users: 0,
        outbound_tickets: 0,
        outbound_source: 0,
      })
    }
    return rows.get(k)
  }

  const v = indexer(viewsReport)
  for (const row of v.rows) {
    const d = gaDateToIso(v.dim(row, 'date'))
    const p = v.dim(row, 'pagePath')
    if (!d || !p) continue
    const t = get(d, p)
    t.page_views = v.num(row, 'screenPageViews')
    t.users = v.num(row, 'totalUsers')
  }

  const o = indexer(outboundReport)
  for (const row of o.rows) {
    const d = gaDateToIso(o.dim(row, 'date'))
    const p = o.dim(row, 'pagePath')
    if (!d || !p) continue
    const t = get(d, p)
    t.outbound_clicks = o.num(row, 'eventCount')
    t.outbound_users = o.num(row, 'totalUsers')
  }

  if (linkTypeReport) {
    const l = indexer(linkTypeReport)
    for (const row of l.rows) {
      const d = gaDateToIso(l.dim(row, 'date'))
      const p = l.dim(row, 'pagePath')
      const kind = l.dim(row, 'customEvent:link_type')
      if (!d || !p) continue
      const t = get(d, p)
      if (kind === 'tickets') t.outbound_tickets = l.num(row, 'eventCount')
      else if (kind === 'source') t.outbound_source = l.num(row, 'eventCount')
    }
  }

  return trimPages([...rows.values()])
}

/**
 * Per-day cap on stored pages.
 *
 * Every page with an outbound click is kept regardless of rank: a page with 2
 * views and 1 handoff is the most valuable row in the table and trimming it
 * for being unpopular would delete the measurement the whole feature exists
 * for. The remaining slots go to the most-viewed pages.
 */
export function trimPages(rows, perDay = TOP_PAGES_PER_DAY) {
  const byDate = new Map()
  for (const r of rows) {
    if (!byDate.has(r.metric_date)) byDate.set(r.metric_date, [])
    byDate.get(r.metric_date).push(r)
  }
  const out = []
  for (const [, dayRows] of byDate) {
    const kept = dayRows.filter((r) => r.outbound_clicks > 0)
    const rest = dayRows
      .filter((r) => r.outbound_clicks === 0)
      .sort((a, b) => b.page_views - a.page_views || a.page_path.localeCompare(b.page_path))
      .slice(0, Math.max(0, perDay - kept.length))
    out.push(...kept, ...rest)
  }
  return out.sort((a, b) =>
    a.metric_date.localeCompare(b.metric_date) || a.page_path.localeCompare(b.page_path)
  )
}

export function buildEmbedRows(report) {
  const e = indexer(report)
  const out = []
  for (const row of e.rows) {
    const d = gaDateToIso(e.dim(row, 'date'))
    if (!d) continue
    const raw = e.dim(row, 'customEvent:embed_host')
    // '(not set)' becomes '(unknown)' rather than being dropped, matching
    // ga-embeds-snapshot.js. Dropping it would shrink the embed total.
    const host = raw && raw !== '(not set)' ? raw : '(unknown)'
    out.push({
      metric_date: d,
      embed_host: clampField(host, MAX_EMBED_HOST, 'embed_host'),
      page_views: e.num(row, 'screenPageViews'),
      users: e.num(row, 'activeUsers'),
    })
  }
  return out
}

// ── The reports ─────────────────────────────────────────────────────────────

const dateDim = { name: 'date' }
const byDateOrder = [{ dimension: { dimensionName: 'date' } }]

const inList = (values) => ({
  filter: { fieldName: 'eventName', inListFilter: { values, caseSensitive: true } },
})

const exactEvent = (value) => ({
  filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value, caseSensitive: true } },
})

/**
 * A 400 naming a custom dimension means it is not registered in GA4 Admin: a
 * setup step, not a failure. Matched narrowly, copied from
 * ga-embeds-snapshot.js, so a genuine API error still goes red.
 */
export function isDimensionNotRegistered(message) {
  return /is not a valid (dimension|metric)/i.test(message) ||
    /Field customEvent:(embed_host|surface|link_type)/i.test(message)
}

async function softReport(run, body, label) {
  try {
    return await run(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err?.status === 400 && isDimensionNotRegistered(msg)) {
      warn(`${label}: custom dimension not registered in GA4 Admin, skipping`)
      return null
    }
    throw err
  }
}

/** The six day-dimensioned reports for one chunk. Issued sequentially. */
async function loadChunk(run, { start, end }) {
  const range = [{ startDate: start, endDate: end }]

  const audience = await run({
    dateRanges: range,
    dimensions: [dateDim],
    metrics: [
      { name: 'activeUsers' }, { name: 'totalUsers' }, { name: 'newUsers' },
      { name: 'sessions' }, { name: 'engagedSessions' }, { name: 'screenPageViews' },
    ],
    orderBys: byDateOrder,
    limit: String(ROW_LIMIT),
  })

  const events = await run({
    dateRanges: range,
    dimensions: [dateDim, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: inList([EV_OUTBOUND, EV_VIEW, EV_STANDALONE, EV_INSTALL]),
    limit: String(ROW_LIMIT),
  })

  const pageViews = await run({
    dateRanges: range,
    dimensions: [dateDim, { name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: String(ROW_LIMIT),
  })

  const outbound = await run({
    dateRanges: range,
    dimensions: [dateDim, { name: 'pagePath' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: exactEvent(EV_OUTBOUND),
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: String(ROW_LIMIT),
  })

  const linkTypes = await softReport(run, {
    dateRanges: range,
    dimensions: [dateDim, { name: 'pagePath' }, { name: 'customEvent:link_type' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: exactEvent(EV_OUTBOUND),
    limit: String(ROW_LIMIT),
  }, 'link_type split')

  const embeds = await softReport(run, {
    dateRanges: range,
    dimensions: [dateDim, { name: 'customEvent:embed_host' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'customEvent:surface', stringFilter: { matchType: 'EXACT', value: 'embed' } },
    },
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: String(ROW_LIMIT),
  }, 'embed_host report')

  return {
    site: buildSiteRows(eachDate(start, end), audience, events),
    pages: buildPageRows(pageViews, outbound, linkTypes),
    embeds: embeds ? buildEmbedRows(embeds) : [],
  }
}

/**
 * Distinct users who fired pwa_standalone_launch in the N days ending `date`.
 *
 * One report per (date, window), because this is the one figure that CANNOT be
 * assembled from stored day rows: distinct-user counts do not add. Two people
 * who each opened the app on three days are 2 distinct users, not 6, and only
 * GA4 can tell those apart. Un-dimensioned on purpose, so GA4 does the
 * de-duplication rather than this script summing per-platform rows and
 * inventing a total (ga-install-snapshot.js's note on why the platform lines
 * may exceed the header applies verbatim).
 */
async function rollingStandaloneUsers(run, date, windowDays) {
  const rep = await run({
    dateRanges: [{ startDate: addDays(date, -(windowDays - 1)), endDate: date }],
    metrics: [{ name: 'totalUsers' }],
    dimensionFilter: exactEvent(EV_STANDALONE),
  })
  const i = indexer(rep)
  return i.rows.length > 0 ? i.num(i.rows[0], 'totalUsers') : 0
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Upsert in batches on the table's natural key.
 *
 * `ignoreDuplicates: false` is what makes this an UPDATE on conflict rather
 * than a skip, which is the whole point of the trailing window: a re-run must
 * replace yesterday's provisional figures with GA4's revised ones.
 *
 * All rows in one call MUST carry the same keys. PostgREST derives the column
 * list from the union of the payload's keys, so a batch mixing rows that have
 * pwa_users_28d with rows that do not would write NULL over a real value for
 * the ones that omitted it. `--no-rolling` therefore strips the two columns
 * from EVERY row rather than from some of them, and stripping them is what
 * leaves whatever is already stored untouched.
 */
async function upsertAll(client, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    const { error } = await client.from(table).upsert(batch, { onConflict, ignoreDuplicates: false })
    if (error) throw new Error(`upsert into ${table} failed: ${error.message}`)
  }
  return rows.length
}

// ── Output ──────────────────────────────────────────────────────────────────

function warn(message) {
  console.error(`ga-to-db: ${message}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const today = todayInProperty()
    const args = parseArgs(process.argv.slice(2), today)

    // NOT_CONFIGURED is checked AFTER argument validation so a typo'd flag is
    // still reported as an error, and BEFORE any network or database work.
    const config = loadConfig()
    if (!config) {
      console.log('NOT_CONFIGURED')
      return
    }

    const token = await getAccessToken(config.sa)
    const run = makeRunner(token, config.propertyId)

    const chunks = chunkRange(args.start, args.end)
    const site = []
    const pages = []
    const embeds = []
    for (const [i, chunk] of chunks.entries()) {
      const part = await loadChunk(run, chunk)
      site.push(...part.site)
      pages.push(...part.pages)
      embeds.push(...part.embeds)
      if (i < chunks.length - 1) await sleep(CHUNK_PAUSE_MS)
    }

    if (args.rolling) {
      // Two requests per date, paced like the chunk loop above. This is by far
      // the loop that issues the most requests, so it is the last place to
      // skip the politeness the header argues for.
      for (const [i, row] of site.entries()) {
        row.pwa_users_7d = await rollingStandaloneUsers(run, row.metric_date, 7)
        row.pwa_users_28d = await rollingStandaloneUsers(run, row.metric_date, 28)
        if (i < site.length - 1) await sleep(CHUNK_PAUSE_MS)
      }
    }
    // With --no-rolling the two columns are absent from EVERY row, so
    // PostgREST's single derived column list omits them from both the INSERT
    // and the DO UPDATE SET and whatever is stored survives untouched. With
    // rolling ON they are present, so a backfilled date from before the PWA
    // shipped stores 0 rather than NULL. That is accepted: 0 is simply true
    // there (nobody had the app installed yet), and the NULL-versus-zero
    // distinction still does its real job on the --no-rolling path.

    const fetchedAt = new Date().toISOString()
    for (const r of site) r.fetched_at = fetchedAt
    for (const r of pages) r.fetched_at = fetchedAt
    for (const r of embeds) r.fetched_at = fetchedAt

    if (args.dryRun) {
      // Every row that would be written, one JSON object per line, in the
      // shape the upsert would send. Nothing is loaded, nothing is written,
      // and no Supabase credential is read.
      for (const r of site) console.log(JSON.stringify({ table: 'site_metrics_daily', row: r }))
      for (const r of pages) console.log(JSON.stringify({ table: 'page_metrics_daily', row: r }))
      for (const r of embeds) console.log(JSON.stringify({ table: 'embed_metrics_daily', row: r }))
      console.log(JSON.stringify({
        dryRun: true,
        range: { start: args.start, end: args.end },
        chunks: chunks.length,
        rolling: args.rolling,
        wrote: 0,
        would: { site: site.length, pages: pages.length, embeds: embeds.length },
      }))
      return
    }

    // Imported lazily so the module stays import-safe and --dry-run never
    // needs VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.
    const { supabaseAdmin } = await import('./lib/supabase-admin.js')
    const wroteSite = await upsertAll(supabaseAdmin, 'site_metrics_daily', site, 'metric_date')
    const wrotePages = await upsertAll(supabaseAdmin, 'page_metrics_daily', pages, 'metric_date,page_path')
    const wroteEmbeds = await upsertAll(supabaseAdmin, 'embed_metrics_daily', embeds, 'metric_date,embed_host')

    console.log(JSON.stringify({
      range: { start: args.start, end: args.end },
      chunks: chunks.length,
      rolling: args.rolling,
      wrote: { site: wroteSite, pages: wrotePages, embeds: wroteEmbeds },
    }))
  } catch (err) {
    // ONE line, no key material, no token, no service-role key. The only
    // third-party text that can appear is a Google error body already
    // truncated to 200 chars by fetchJson.
    console.error(`ga-to-db: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
