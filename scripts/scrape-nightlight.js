/**
 * scrape-nightlight.js
 *
 * Fetches upcoming screenings from The Nightlight Cinema (nightlightcinema.com).
 *
 * Platform: INDY Cinema Group — a Vue 3 + Quasar SPA. Raw HTTP fetches of
 * /home/ and /movie/{slug}/ return only an SPA shell; the actual showtimes
 * are hydrated client-side via Apollo /graphql calls. We use Puppeteer to
 * render the pages, then feed the hydrated HTML into the existing parsers.
 *
 * The parser helpers (parseHomeScreenings, parseMoviePage, buildEventRow)
 * are exported so the tests can drive them with captured HTML fixtures.
 *
 * Usage:
 *   npm run scrape:nightlight
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { extractJsonLd, findSchemaObjects, isoDurationToMinutes, firstImageUrl } from './lib/json-ld.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL    = 'https://nightlightcinema.com'
const HOME_URL    = `${BASE_URL}/home/`
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`

const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// Per-page delay is 0 because Puppeteer's `waitUntil: 'networkidle2'` already
// blocks until the page is quiet — that's natural pacing between fetches.
// A larger value here just adds dead time without making us politer.
const DETAIL_RATE_LIMIT_MS = 0
const DETAIL_TIMEOUT_MS    = 15_000

// SPA needs the showtimes section to actually render before we read the HTML.
// We wait for any hydration marker (date headers / time patterns / standard
// screening text / "no showings" copy) before extracting.
const HYDRATION_TIMEOUT_MS = 20_000

// How many days of advance showtimes to ingest from each movie page. Movie
// pages typically list 7–10 days; capping here keeps the event window in
// sync with how confidently the cinema schedules ahead and prevents drift
// when films near the end of their run still list far-future dates.
const ADVANCE_DAYS = 7

class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError' }
}

// ── Low-level fetch ───────────────────────────────────────────────────────

async function fetchText(url, { timeoutMs = DETAIL_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController()
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xml,*/*;q=0.8', 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`)
    return res.text()
  } finally {
    clearTimeout(tid)
  }
}

// ── Puppeteer-rendered page fetch (SPA hydration) ─────────────────────────

/**
 * Render a Nightlight SPA page in a real browser, wait for Vue/Apollo to
 * hydrate the showtime data, and return the final HTML. Caller passes an
 * open Puppeteer page (reused across home + movie pages to amortise the
 * ~3s browser launch cost).
 *
 * Hydration is detected one of two ways:
 *   • The text "Standard Screening" appears (today has screenings)
 *   • The text "No showings" / "no screenings" appears (today is empty)
 * If neither shows up within HYDRATION_TIMEOUT_MS we return whatever HTML
 * we have — the parser will see 0 events and the scraper will log a soft
 * degraded result rather than crashing.
 */
async function renderViaPage(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: HYDRATION_TIMEOUT_MS })
  // Quick check for the unrecoverable case
  const blocked = await page.evaluate(() =>
    document.documentElement.innerHTML.includes('cf-browser-verification') ||
    document.documentElement.innerHTML.includes('cf_clearance')
  )
  if (blocked) throw new BlockedError(`Cloudflare challenge on ${url}`)

  // Wait for hydration marker. The signal we trust most is a real time
  // pattern (h:mm AM|PM) appearing in the body — both /home/ and
  // /movie/{slug}/ render that only after showtime cards/grids hydrate.
  // We also accept "Standard Screening" or the various "no showings" copy
  // as escape hatches when there are no times to wait for.
  try {
    await page.waitForFunction(
      () => /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b|Standard Screening|No showings|no screenings|currently no/i.test(document.body.textContent),
      { timeout: HYDRATION_TIMEOUT_MS }
    )
  } catch {
    // Soft fail — return what we have
  }
  return page.content()
}

// ── Home page parsing ─────────────────────────────────────────────────────

/**
 * Extract today's screening blocks from the home page HTML.
 *
 * Each showtime is a repeating block whose text content reliably contains
 * the literal "Standard Screening" marker followed by the screen number,
 * film title, runtime · genre, and time — in that order. We regex against
 * a tag-stripped text representation rather than Quasar's hash-suffixed
 * class names, which change per build.
 *
 * Returns an array of { title, screen, time, genre, runtime }. Time is the
 * raw "h:mm AM|PM" string; conversion to UTC happens later with today's date.
 */
export function parseHomeScreenings(html) {
  if (!html) return []

  // Flatten HTML to plain text, preserving line breaks around block elements
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]+/g, ' ')

  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)

  // Walk lines; a screening starts with the literal "Standard Screening"
  // marker. The subsequent non-empty lines follow this order:
  //
  //   Standard Screening [play_arrow]   ← marker; may have trailing icon text
  //   [Ends Today | Today | Sold Out…]  ← optional status badge
  //   Screen 1|2                        ← optional
  //   {film title}
  //   {runtime} · {genre}               ← e.g. "1 hr 40 min · Crime"
  //   {h:mm AM|PM}
  //
  // Markup history: the marker used to be on its own line; the SPA now
  // renders <span>Standard Screening</span><i>play_arrow</i> as siblings
  // inside the card div, so our text-flatten collapses them onto one line.
  // We anchor with \b so "Standard Screening" matches with or without the
  // trailing icon literal.
  //
  // Title selection: take the line IMMEDIATELY after the Screen N line.
  // The previous "first non-matching line" approach incorrectly picked
  // status badges like "Ends Today" before the real title.
  const STD_MARKER = /^Standard Screening\b/i
  const SCREEN_RE  = /^Screen\s+\w+/i
  const TIME_RE    = /\b\d{1,2}:\d{2}\s?(?:am|pm)\b/i
  const RUNTIME_RE = /·/

  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (!STD_MARKER.test(lines[i])) continue
    const win = lines.slice(i + 1, i + 9)

    const screenIdx = win.findIndex(l => SCREEN_RE.test(l))
    const screenLine = screenIdx >= 0 ? win[screenIdx] : null

    // Title is the line right after Screen N. When there's no Screen line
    // (rare — special screenings), fall back to first line that doesn't
    // match any other slot and isn't a known badge.
    const BADGE_RE = /^(ends today|today|sold out|few left|last day|few tickets left|members only|free)$/i
    let titleLine
    if (screenIdx >= 0 && win[screenIdx + 1]) {
      titleLine = win[screenIdx + 1]
    } else {
      titleLine = win.find(l =>
        l !== 'play_arrow' &&
        !SCREEN_RE.test(l) &&
        !RUNTIME_RE.test(l) &&
        !TIME_RE.test(l) &&
        !STD_MARKER.test(l) &&
        !BADGE_RE.test(l) &&
        l.length > 1
      )
    }

    const timeLine    = win.find(l => TIME_RE.test(l))
    const runtimeLine = win.find(l => RUNTIME_RE.test(l))

    if (!titleLine || !timeLine) continue

    const timeMatch = timeLine.match(/\b(\d{1,2}):(\d{2})\s?(am|pm)\b/i)
    if (!timeMatch) continue

    let runtimeMin = null, genre = null
    if (runtimeLine) {
      // "1 hr 40 min · Crime"  OR  "Comedy" (just the genre on its own line)
      const runM = runtimeLine.match(/(?:(\d+)\s*hr\s*)?(\d+)\s*min/i)
      if (runM) runtimeMin = (parseInt(runM[1] || '0', 10) * 60) + parseInt(runM[2], 10)
      const genreM = runtimeLine.match(/·\s*([A-Za-z][A-Za-z /&]+)\s*$/)
      if (genreM) genre = genreM[1].trim()
    }

    blocks.push({
      title:      titleLine,
      screen:     screenLine ? screenLine.replace(/\s+/g, ' ').trim() : null,
      timeStr:    `${timeMatch[1]}:${timeMatch[2]} ${timeMatch[3].toUpperCase()}`,
      runtimeMin,
      genre,
    })
  }

  return blocks
}

/**
 * Extract every unique /movie/{slug}/ reference from an HTML or XML string.
 * Used both for slug discovery on the home page and for sitemap parsing.
 */
export function extractMovieSlugs(text) {
  if (!text) return []
  const set = new Set()
  const re  = /\/movie\/([a-z0-9][a-z0-9-]{0,120})/gi
  let m
  while ((m = re.exec(text)) !== null) set.add(m[1].toLowerCase())
  return Array.from(set)
}

/**
 * Heuristic slug match for a film title. When /home/ doesn't link to the
 * /movie/{slug}/ page directly (Vue Router click handlers on <div>s), we
 * fall back to a kebab-case conversion of the title and check it against
 * the set of slugs we harvested from sitemap.xml or the HTML body.
 */
export function titleToSlug(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function matchSlug(title, candidateSlugs) {
  if (!title) return null
  const ideal = titleToSlug(title)
  if (candidateSlugs.includes(ideal)) return ideal
  // Fallback: find the first candidate that shares a significant prefix
  for (const c of candidateSlugs) {
    if (c.startsWith(ideal) || ideal.startsWith(c)) return c
  }
  return null
}

// ── Time conversion ───────────────────────────────────────────────────────

/**
 * Convert "5:50 PM" (h:mm AM|PM) on a given Eastern-local date to ISO 8601
 * UTC. Uses the shared easternToIso() so EST↔EDT is handled consistently
 * with every other scraper.
 */
export function showtimeToUtcIso(timeStr, easternDateYmd) {
  if (!timeStr || !easternDateYmd) return null
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = parseInt(m[2], 10)
  const ampm = m[3].toUpperCase()
  if (ampm === 'PM' && hour < 12) hour += 12
  if (ampm === 'AM' && hour === 12) hour = 0
  const hh = String(hour).padStart(2, '0')
  const mm = String(minute).padStart(2, '0')
  return easternToIso(`${easternDateYmd} ${hh}:${mm}:00`)
}

/**
 * Return today's date in Eastern time as YYYY-MM-DD. Uses Intl so DST
 * transitions are handled correctly.
 */
export function todayEasternYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const y = parts.find(p => p.type === 'year')?.value
  const m = parts.find(p => p.type === 'month')?.value
  const d = parts.find(p => p.type === 'day')?.value
  return `${y}-${m}-${d}`
}

// ── Age-rating mapping ────────────────────────────────────────────────────

/**
 * Map MPAA rating strings to the four age_restriction values the `events`
 * table's CHECK constraint accepts: 'not_specified', 'all_ages', '18_plus',
 * '21_plus'.
 *
 * Mapping:
 *   G, PG   → all_ages       (no age gate)
 *   PG-13   → not_specified  (no exact "teens" bucket; PG-13 isn't a hard gate)
 *   R, NC-17 → 18_plus        (closest available bucket; theaters allow 17+
 *                              with adult but most venues list R as 18+)
 *   anything else / NR / null → not_specified
 */
export function mapAgeRestriction(rating) {
  if (!rating || typeof rating !== 'string') return 'not_specified'
  const r = rating.trim().toUpperCase()
  if (r === 'G' || r === 'PG') return 'all_ages'
  if (r === 'R' || r === 'NC-17') return '18_plus'
  return 'not_specified'
}

// ── Multi-day showtime parsing on /movie/{slug}/ ──────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

/**
 * Convert a parsed movie-page date line like "Thu, May 21, 2026" (or
 * "Today Thu, May 21, 2026" / "Tomorrow Fri, May 22, 2026") into a
 * YYYY-MM-DD Eastern-local string. Returns null on parse failure.
 *
 * Used by parseMovieShowtimes to turn the human-readable header above each
 * day's times into the shape showtimeToUtcIso() expects.
 */
export function parseMovieDateLine(line) {
  const m = (line || '').match(
    /(?:Today |Tomorrow )?(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/
  )
  if (!m) return null
  const month = MONTH_NAMES.findIndex(n => n.toLowerCase().startsWith(m[1].toLowerCase()))
  if (month === -1) return null
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
}

/**
 * Parse all upcoming showtimes from a /movie/{slug}/ page.
 *
 * The page's "Showtimes" section flattens to one repeating block per day:
 *   Today Thu, May 21, 2026
 *   Screen 1
 *   6:15 PM
 *   8:30 PM
 *   Tomorrow Fri, May 22, 2026
 *   Screen 1
 *   5:30 PM
 *   7:45 PM
 *   ...
 *
 * We walk lines as a tiny state machine: dateLine opens a block, Screen sets
 * the screen, time lines accumulate, and the next dateLine (or anything else
 * once we've started collecting times) closes the block.
 *
 * Returns an array of { dateYmd, screen, timeStr } objects, one per showtime.
 * dateYmd is Eastern-local YYYY-MM-DD; timeStr is e.g. "5:30 PM". The
 * combination feeds showtimeToUtcIso() to get a real ISO timestamp.
 */
export function parseMovieShowtimes(html) {
  if (!html) return []
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]+/g, ' ')
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)

  const DATE_RE   = /(?:Today |Tomorrow )?(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}/
  const SCREEN_RE = /^Screen\s+\w+$/i
  const TIME_RE   = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i

  const showtimes = []
  let currentDate = null
  let currentScreen = null

  for (const line of lines) {
    if (DATE_RE.test(line) && line.match(DATE_RE)[0] === line.trim()) {
      // Strict match — the whole line is the date, not just a substring.
      // This avoids matching a footer that quotes the date inline.
      const ymd = parseMovieDateLine(line)
      currentDate = ymd
      currentScreen = null
      continue
    }
    if (!currentDate) continue
    if (SCREEN_RE.test(line)) {
      currentScreen = line
      continue
    }
    const tm = line.match(TIME_RE)
    if (tm) {
      showtimes.push({
        dateYmd: currentDate,
        screen:  currentScreen,
        timeStr: `${tm[1]}:${tm[2]} ${tm[3].toUpperCase()}`,
      })
      continue
    }
    // A line that is neither date, screen, nor time after we've opened a
    // block (e.g., the "This website uses cookies…" footer) closes the
    // current date — but only if we've collected at least one time, so we
    // don't lose a date that hasn't yet received its time lines.
    if (showtimes.length > 0 && showtimes[showtimes.length - 1].dateYmd === currentDate) {
      currentDate = null
      currentScreen = null
    }
  }

  return showtimes
}

// ── Movie detail page parsing ─────────────────────────────────────────────

/**
 * Parse a /movie/{slug}/ HTML page. Returns a `Movie` metadata record
 * extracted from the page's schema.org JSON-LD, or an empty object if
 * the page doesn't contain one.
 */
export function parseMoviePage(html) {
  const blocks  = extractJsonLd(html)
  const movies  = findSchemaObjects(blocks, 'Movie')
  const m       = movies[0] || null
  if (!m) return {}
  return {
    title:         typeof m.name === 'string' ? stripHtml(m.name) : null,
    description:   typeof m.description === 'string' ? stripHtml(m.description).slice(0, 5000) : null,
    durationMin:   isoDurationToMinutes(m.duration),
    genre:         Array.isArray(m.genre) ? m.genre[0] : (typeof m.genre === 'string' ? m.genre : null),
    contentRating: typeof m.contentRating === 'string' ? m.contentRating : null,
    imageUrl:      firstImageUrl(m.image) || firstImageUrl(m.thumbnailUrl),
  }
}

// ── Row assembly ──────────────────────────────────────────────────────────

export function buildEventRow({ slug, screening, movieMeta, easternDateYmd }) {
  const startIso = showtimeToUtcIso(screening.timeStr, easternDateYmd)
  if (!startIso) return null

  // Derive end time from movie duration (min) or the screening's runtimeMin.
  const minutes = movieMeta?.durationMin ?? screening.runtimeMin ?? null
  const endIso  = minutes
    ? new Date(new Date(startIso).getTime() + minutes * 60_000).toISOString()
    : null

  const title = (movieMeta?.title && movieMeta.title.length > 2)
    ? movieMeta.title
    : screening.title

  const genre = (movieMeta?.genre || screening.genre || '').toLowerCase().trim()
  const tags  = ['film', 'cinema']
  if (genre) tags.push(genre)

  return {
    title,
    description:     movieMeta?.description || null,
    start_at:        startIso,
    end_at:          endIso,
    category:        'film',
    tags:            [...new Set(tags)],
    price_min:       null,
    price_max:       null,
    age_restriction: mapAgeRestriction(movieMeta?.contentRating),
    image_url:       movieMeta?.imageUrl || null,
    ticket_url:      slug ? `${BASE_URL}/movie/${slug}/` : HOME_URL,
    source:          'nightlight_cinema',
    source_id:       `${slug || titleToSlug(title)}-${startIso}`,
    status:          'published',
    featured:        false,
  }
}

// ── Sitemap fallback ──────────────────────────────────────────────────────

async function discoverSlugsViaSitemap() {
  try {
    const xml = await fetchText(SITEMAP_URL)
    return extractMovieSlugs(xml)
  } catch (err) {
    console.warn(`  ⚠ sitemap.xml fallback failed: ${err.message}`)
    return []
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Nightlight Cinema (INDY platform) ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue('The Nightlight Cinema', {
      address: '30 N High St', city: 'Akron', state: 'OH', zip: '44308',
      lat: 41.0851, lng: -81.5193,
      parking_type: 'street',
      parking_notes: 'Street parking on N High St and Bowery St.',
      website: BASE_URL,
      description: "Akron's independent cinema and cultural venue in the heart of downtown.",
    })
    const organizerId = await ensureOrganization('The Nightlight Cinema', {
      website: BASE_URL,
      description: 'Independent cinema and arts venue in downtown Akron, OH.',
    })
    await linkOrganizationVenue(organizerId, venueId)

    // ── Rendering: one browser session covers home + each movie page ────
    // Puppeteer launch is ~3s. Reusing the same browser across pages drops
    // total wall time from ~3s × N to ~3s + (per-page hydration time). The
    // /movie/{slug}/ pages are the primary data source — each one already
    // lists the next ~7+ days of showtimes for its film, so a single pass
    // through all currently-playing films gives us the full ADVANCE_DAYS
    // window in one go (no need to drive /full-calendar/ per-day).
    const { showtimesPerSlug, metaBySlug, slugs } = await withBrowser(async (browser) => {
      const page = await newConfiguredPage(browser, { userAgent: USER_AGENT })

      // Slug discovery: home page first (currently-playing films), then
      // sitemap as a backstop for anything home leaves out.
      console.log(`\n🔍  Rendering ${HOME_URL} for slug discovery…`)
      const homeHtml = await renderViaPage(page, HOME_URL)
      let slugs = extractMovieSlugs(homeHtml)
      const fromSitemap = await discoverSlugsViaSitemap()
      slugs = Array.from(new Set([...slugs, ...fromSitemap]))
      console.log(`  Slug pool: ${slugs.length} (home: ${extractMovieSlugs(homeHtml).length}, sitemap: ${fromSitemap.length})`)

      // For each slug, render the movie page and pull both metadata
      // (JSON-LD) and the multi-day showtime grid (rendered DOM).
      const metaBySlug = new Map()
      const showtimesPerSlug = new Map()
      for (const slug of slugs) {
        try {
          const t0 = Date.now()
          const pageHtml = await renderViaPage(page, `${BASE_URL}/movie/${slug}/`)
          const showtimes = parseMovieShowtimes(pageHtml)
          metaBySlug.set(slug, parseMoviePage(pageHtml))
          showtimesPerSlug.set(slug, showtimes)
          console.log(`  ✓ ${slug.padEnd(40).slice(0, 40)} ${showtimes.length} showtimes (${Date.now() - t0}ms)`)
        } catch (err) {
          console.warn(`  ⚠ movie fetch failed for "${slug}": ${err.message}`)
          metaBySlug.set(slug, {})
          showtimesPerSlug.set(slug, [])
        }
        await new Promise(r => setTimeout(r, DETAIL_RATE_LIMIT_MS))
      }

      return { showtimesPerSlug, metaBySlug, slugs }
    })

    // Cap the window to ADVANCE_DAYS (default 7). Each movie page already
    // lists ~7+ days, but a film at the end of its run might have showings
    // beyond our cap, and we don't want to ingest months of future-dated
    // events that might still get cancelled.
    const todayYmd = todayEasternYmd()
    const horizonMs = new Date(`${todayYmd}T00:00:00-05:00`).getTime() + ADVANCE_DAYS * 86_400_000
    const horizonDate = new Date(horizonMs).toISOString().slice(0, 10)

    // Flatten (slug, showtime) pairs and filter to the window.
    const rows = []
    let totalShowtimes = 0
    for (const slug of slugs) {
      const sts = showtimesPerSlug.get(slug) || []
      totalShowtimes += sts.length
      const meta = metaBySlug.get(slug) || {}
      for (const st of sts) {
        if (st.dateYmd > horizonDate) continue   // beyond ADVANCE_DAYS
        if (st.dateYmd < todayYmd)    continue   // safety: don't ingest yesterday
        rows.push({ slug, screening: { title: meta?.title || slug, timeStr: st.timeStr, screen: st.screen }, movieMeta: meta, easternDateYmd: st.dateYmd })
      }
    }

    console.log(`\n📥  Total showtimes parsed: ${totalShowtimes} | within ${ADVANCE_DAYS}d window: ${rows.length}`)

    if (rows.length === 0) {
      await logUpsertResult('nightlight_cinema', 0, 0, 0, {
        status: 'error',
        errorMessage: `Parsed 0 showtimes for any of ${slugs.length} films within ${ADVANCE_DAYS}d window`,
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      process.exit(0)
    }

    // ── Build + upsert ────────────────────────────────────────────────────
    let inserted = 0, skipped = 0
    for (const r of rows) {
      try {
        const row = buildEventRow(r)
        if (!row || !row.start_at) { skipped++; continue }
        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
          skipped++
          continue
        }
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${r.screening?.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult('nightlight_cinema', inserted, 0, skipped, {
      eventsFound: rows.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    if (err instanceof BlockedError) {
      console.warn(`\n⚠  Nightlight Cinema blocked: ${err.message}`)
      await logUpsertResult('nightlight_cinema', 0, 0, 0, {
        status: 'error',
        errorMessage: err.message,
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      process.exit(0)
    }
    await logScraperError('nightlight_cinema', err, start)
    process.exit(1)
  }
}

// Only run when invoked directly — allows tests to import parsing helpers
// without triggering a scrape.
import { fileURLToPath } from 'node:url'
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
