/**
 * tribe-planned.js — The Events Calendar (Tribe) REST feeds, as a plan for
 * runPlannedScraper.
 *
 * The older Tribe scrapers each carry their own fetch-and-write loop. Sources
 * added from November 2026 use this instead, so a Tribe source is a short
 * config: where the feed is, which entries to keep, and what the venue is.
 * They get a dry run, per-row venues and honest skip counts from planned-run.
 *
 * Conventions, all deliberate:
 *   • TIMES come from the feed's LOCAL start_date/end_date, read as Eastern.
 *     The utc_* fields are wrong on sites configured with a fixed offset
 *     (see scrape-wine-mill.js), and every source here is in Summit County.
 *   • ALL-DAY entries have no real start time. They get the house noon
 *     placeholder and time_inferred, so the listing discloses it.
 *   • VENUE is the feed's own venue when it has a name. When a city is given
 *     and it is outside Summit County the entry is skipped, unless the source
 *     pins every event to one venue of its own (`fixedVenue`).
 *   • Nothing is published without a title and a start.
 */
import { decodeEntities, stripHtml, clampChars, easternToIso, easternTodayIso, parseCostFromTribe } from './normalize.js'
import { fetchTribeEvents, resolveTribeTimes } from './tribe-events.js'
import { fetchWithRetry } from './http.js'
import { classifySummitLocation } from './summit-county.js'

const MAX_DESCRIPTION = 4000
const DAY_MS = 86_400_000
export const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com/technical)'

const text = (s = '') => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim()

/** "2026-12-06 16:30:00" → ISO instant, reading the wall time as Eastern. */
function localToIso(local) {
  const [day, clock] = String(local ?? '').trim().split(/[ T]/)
  return day && clock ? easternToIso(day, clock) : null
}

/** The feed's venue object → { name, details } or null. */
export function tribeVenue(ev = {}) {
  const v = Array.isArray(ev.venue) ? ev.venue[0] : ev.venue
  const name = text(v?.venue)
  if (!v || typeof v !== 'object' || !name) return null
  const details = {}
  if (text(v.address)) details.address = text(v.address)
  if (text(v.city)) details.city = text(v.city)
  details.state = text(v.stateprovince) || text(v.state) || 'OH'
  if (text(v.zip)) details.zip = text(v.zip)
  return { name, details }
}

/**
 * One raw Tribe event → { row, venue } or { skip }.
 * @param {object} ev
 * @param {object} cfg  { source, categories, tags, fixedVenue?, include?, titleOf? }
 */
export function buildTribeRow(ev, cfg) {
  const title = text(cfg.titleOf ? cfg.titleOf(text(ev?.title), ev) : ev?.title)
  if (!ev?.id || !title) return { skip: 'invalid' }
  if (cfg.include) {
    const verdict = cfg.include(text(ev.title), ev)
    if (verdict !== true) return { skip: typeof verdict === 'string' ? verdict : 'filtered' }
  }
  const venue = cfg.fixedVenue ?? tribeVenue(ev)
  if (!cfg.fixedVenue && venue?.details?.city && classifySummitLocation({ city: venue.details.city }) === 'out') {
    return { skip: 'out_of_county' }
  }
  let startAt
  let endAt = null
  let inferred = false
  if (ev.all_day === true) {
    const t = resolveTribeTimes(ev)
    startAt = t.start_at
    endAt = t.end_at
    inferred = true
  } else {
    startAt = localToIso(ev.start_date)
    const end = localToIso(ev.end_date)
    endAt = end && startAt && end > startAt ? end : null
  }
  if (!startAt) return { skip: 'undatable' }
  const description = clampChars(stripHtml(ev.description ?? '').trim(), MAX_DESCRIPTION) || null
  const row = {
    title,
    description,
    start_at: startAt,
    end_at: endAt,
    categories: typeof cfg.categories === 'function' ? cfg.categories(title, ev) : cfg.categories,
    tags: cfg.tags ?? [],
    ...parseCostFromTribe(ev.cost ?? '', ev.cost_details ?? {}),
    age_restriction: 'not_specified',
    image_url: ev.image?.url ?? null,
    ticket_url: ev.website || ev.url || null,
    source: cfg.source,
    source_id: String(ev.id),
    status: 'published',
    featured: false,
  }
  if (row.price_max == null) row.price_max = row.price_min
  if (inferred) row.time_inferred = true
  return { row, venue: venue ?? null }
}

/** Fetch the feed and build the plan. `cfg` adds { baseUrl, label, daysAhead? }. */
export async function collectTribe(cfg, { fetchImpl, now = Date.now } = {}) {
  const today = easternTodayIso(new Date(now()))
  const end = easternTodayIso(new Date(now() + (cfg.daysAhead ?? 270) * DAY_MS))
  const events = await fetchTribeEvents({
    baseUrl: cfg.baseUrl,
    label: cfg.label,
    startDate: today,
    endDate: end,
    userAgent: BOT_USER_AGENT,
    fetchImpl: fetchImpl ?? ((url, init) => fetchWithRetry(url, init)),
    emptyStatuses: [400, 404],
    pageDelayMs: fetchImpl ? 0 : undefined,
    log: () => {},
  })
  const rows = []
  const skipped = {}
  const seen = new Set()
  const earliest = now() - DAY_MS
  for (const ev of events) {
    if (seen.has(ev?.id)) continue
    seen.add(ev?.id)
    const built = buildTribeRow(ev, cfg)
    if (built.skip) { skipped[built.skip] = (skipped[built.skip] ?? 0) + 1; continue }
    if (Date.parse(built.row.start_at) < earliest) { skipped.past = (skipped.past ?? 0) + 1; continue }
    rows.push(built)
  }
  return { found: seen.size, rows, skipped }
}
