/**
 * scrape-nightlight.js
 *
 * Fetches upcoming screenings from The Nightlight Cinema (nightlightcinema.com).
 *
 * Platform: INDY Cinema Group — a Vue 3 + Quasar SPA. Raw HTTP fetches of
 * /home/ and /movie/{slug}/ return only an SPA shell; the actual showtimes
 * are injected client-side after Apollo's /graphql calls hydrate. That means
 * this scraper's current DOM parser sees 0 "Standard Screening" blocks —
 * degraded by design until one of the paths below is implemented.
 *
 * Next steps (pick one):
 *   (a) Install Playwright, render /home/ in a headless browser, and reuse
 *       the parseHomeScreenings() helper below against the hydrated DOM.
 *   (b) Reverse-engineer the session headers INDY's SPA sends with its
 *       /graphql POSTs — same-body replays from Node currently hit 403 on
 *       the showingsForDate / datesWithShowing fields even with the right
 *       cookies and siteIds: ['175'].
 *   (c) Request API or partner-feed access from INDY Cinema Group directly.
 *
 * The parser helpers below (parseHomeScreenings, parseMoviePage, buildEventRow)
 * are exported so whichever path lands first can reuse them — they work
 * correctly against the HYDRATED DOM (confirmed via Chrome DevTools), they
 * just need a renderer feeding them real HTML.
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

// ── Constants ─────────────────────────────────────────────────────────────

const BASE_URL    = 'https://nightlightcinema.com'
const HOME_URL    = `${BASE_URL}/home/`
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`

const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://events.supportlocalakron.com)'

const DETAIL_RATE_LIMIT_MS = 1000   // polite per-request delay
const DETAIL_TIMEOUT_MS    = 15_000

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
  // marker. The subsequent non-empty lines follow a predictable order
  // (see observed DOM text in proposal §4):
  //
  //   Standard Screening
  //   play_arrow            ← Material Icon literal; ignore
  //   Screen 1|2            ← optional
  //   {film title}
  //   {runtime} · {genre}   ← e.g. "1 hr 40 min · Crime"
  //   {h:mm AM|PM}
  //
  // We don't hard-fail on missing optional lines — just pick off what we can.
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^Standard Screening$/i.test(lines[i])) continue
    const window = lines.slice(i + 1, i + 8)  // look at next few lines
    const screenLine  = window.find(l => /^Screen\s+\w+/i.test(l))
    const timeLine    = window.find(l => /\b\d{1,2}:\d{2}\s?(?:am|pm|AM|PM)\b/.test(l))
    const runtimeLine = window.find(l => /·/.test(l))
    // Title: first non-ignorable line that isn't a Screen/time/runtime/icon line
    const titleLine = window.find(l =>
      l !== 'play_arrow' &&
      !/^Screen\s+\w+/i.test(l) &&
      !/·/.test(l) &&
      !/\b\d{1,2}:\d{2}\s?(?:am|pm|AM|PM)\b/.test(l) &&
      !/^Standard Screening$/i.test(l) &&
      l.length > 1
    )

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

/** Map MPAA rating strings (G, PG, PG-13, R, NC-17, NR) to our categories. */
export function mapAgeRestriction(rating) {
  if (!rating || typeof rating !== 'string') return 'not_specified'
  const r = rating.trim().toUpperCase()
  if (r === 'G' || r === 'PG') return 'all_ages'
  if (r === 'PG-13')           return 'teens_and_up'
  if (r === 'R' || r === 'NC-17') return 'adults_only'
  return 'not_specified'
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
    category:        'art',
    tags:            [...new Set(tags)],
    price_min:       0,
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

    // ── Layer 1: home page for today's showtimes ─────────────────────────
    console.log(`\n🔍  Fetching ${HOME_URL}`)
    const homeHtml = await fetchText(HOME_URL)

    // Detect the "scraper was blocked" condition — the SPA still returns
    // 200 for most paths, so we sanity-check for expected markers.
    if (homeHtml.includes('cf-browser-verification') || homeHtml.includes('cf_clearance')) {
      throw new BlockedError('Cloudflare challenge detected on /home/')
    }

    const screenings = parseHomeScreenings(homeHtml)
    console.log(`  Parsed ${screenings.length} "Standard Screening" block${screenings.length === 1 ? '' : 's'}`)

    if (screenings.length === 0) {
      // Degraded: the home page shape may have changed, or there really
      // are no screenings today. Log and exit 0 — scrape:all continues.
      await logUpsertResult('nightlight_cinema', 0, 0, 0, {
        status: 'error',
        errorMessage: 'Home page yielded 0 "Standard Screening" blocks — check parse logic',
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      process.exit(0)
    }

    // ── Slug discovery — home HTML first, sitemap as backup ──────────────
    let slugs = extractMovieSlugs(homeHtml)
    if (slugs.length < screenings.length) {
      console.log(`  Home page yielded ${slugs.length} slugs; trying sitemap.xml`)
      const fromSitemap = await discoverSlugsViaSitemap()
      slugs = Array.from(new Set([...slugs, ...fromSitemap]))
      console.log(`  Combined slug pool: ${slugs.length}`)
    }

    // ── Layer 2: per-movie JSON-LD enrichment ────────────────────────────
    const metaBySlug = new Map()
    for (const slug of slugs) {
      try {
        const pageHtml = await fetchText(`${BASE_URL}/movie/${slug}/`)
        metaBySlug.set(slug, parseMoviePage(pageHtml))
      } catch (err) {
        console.warn(`  ⚠ movie fetch failed for "${slug}": ${err.message}`)
        metaBySlug.set(slug, {})
      }
      await new Promise(r => setTimeout(r, DETAIL_RATE_LIMIT_MS))
    }

    // ── Build + upsert ────────────────────────────────────────────────────
    const easternDateYmd = todayEasternYmd()
    console.log(`\n📥  Processing ${screenings.length} screenings for ${easternDateYmd}…`)

    let inserted = 0, skipped = 0
    for (const screening of screenings) {
      try {
        const slug      = matchSlug(screening.title, slugs)
        const movieMeta = slug ? (metaBySlug.get(slug) || {}) : {}
        const row       = buildEventRow({ slug, screening, movieMeta, easternDateYmd })
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
        console.warn(`  ⚠ Error processing "${screening.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult('nightlight_cinema', inserted, 0, skipped, {
      eventsFound: screenings.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
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
