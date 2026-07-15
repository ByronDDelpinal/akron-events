/**
 * scrape-learned-owl.js
 *
 * Scrapes upcoming public events from The Learnéd Owl Book Shop, a beloved
 * independent bookstore in downtown Hudson, OH (Summit County). Author signings,
 * readings, and children's storytimes — a steady ~6–10 events per month.
 *
 * Platform: Drupal 11 (Commerce 3) with the ABA/IndieCommerce "event-list"
 * calendar. The public /events page renders a server-side MONTH view:
 *   - `<article id="event-NNNN" class="event-list">` cards, one per event
 *   - `.event-list__title > a[href="/event/YYYY-MM-DD/slug"]` — title + link
 *   - `.event-tag__term` — one or more category tags ("Author Events-Adults",
 *     "Author Events-Children")
 *   - `.event-list__details--item` rows labelled "Date:" ("Sat, 7/4/2026"),
 *     "Time:" ("11:00am - 1:00pm") and "Place:" (an <address> block)
 * Navigation is by month (`/events/YYYY/MM`), so we walk forward from the
 * current Eastern month across HORIZON_MONTHS to cover the ~180-day horizon.
 * Per-event detail pages (`/event/YYYY-MM-DD/slug`) carry the full write-up in
 * `.event-details__info--body`, which we pull on a second pass — the listing
 * only exposes a one-line auto-generated teaser.
 *
 * Anti-bot quirk (the reason this scraper is more than a fetch + regex): the
 * whole site sits behind an "Obolus" proof-of-work challenge. A plain request
 * gets a "Checking connection…" interstitial that runs a Bitcoin-style PoW in
 * the browser: find a miningNonce whose SHA-256(`{nonce}:mine:{miningNonce}`)
 * has >= `difficulty` (currently 14) leading zero bits, then present a proof
 * cookie `X_Obolus_Proof = timestamp:nonce:token:benchmarkElapsed:miningNonce`.
 * The token is pre-signed by the server, so we only mine the nonce (~16k SHA-256
 * hashes, tens of ms in Node) and replay the cookie. See solveObolusChallenge().
 * If the challenge scheme changes, this scraper will start returning 0 events —
 * re-inspect the interstitial's inline CONFIG object.
 *
 * Geography: the shop is in Hudson (Summit County). Events carry their own
 * Place address, so each row is gated with classifySummitLocation — offsite
 * events outside Summit are skipped, and unknown localities go to review.
 *
 * Usage:
 *   node scripts/scrape-learned-owl.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import {
  preloadSummitCountyBoundary,
  classifySummitLocation,
} from './lib/summit-county.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'learned_owl'
const BASE_DOMAIN = 'https://learnedowl.com'
const SOURCE_URL  = `${BASE_DOMAIN}/events`

// How many months forward to walk (current month inclusive). ~180-day horizon.
const HORIZON_MONTHS = 6

const USER_AGENT =
  'Mozilla/5.0 (compatible; AkronEventsBot/1.0; +https://akronpulse.com)'

// The one physical storefront. Events almost always happen here; offsite
// author events carry their own address and are resolved separately.
const STORE_VENUE = {
  name:          'The Learned Owl Book Shop',
  address:       '204 N Main St',
  city:          'Hudson',
  state:         'OH',
  zip:           '44236',
  lat:           41.24283,
  lng:           -81.44063,
  parking_type:  'street',
  parking_notes: 'On-street and municipal-lot parking around the Hudson green.',
  website:       BASE_DOMAIN,
  description:
    'Independent bookstore on the Hudson green since 1968, hosting author ' +
    'signings, readings, book clubs, and children\'s storytimes.',
}

// ════════════════════════════════════════════════════════════════════════════
// OBOLUS PROOF-OF-WORK CHALLENGE
// ════════════════════════════════════════════════════════════════════════════

/** Count leading zero BITS across the bytes of a Buffer/Uint8Array. */
function countLeadingZeroBits(bytes) {
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) { count += 8; continue }
    count += Math.clz32(byte) - 24 // clz32 works on 32-bit; a byte's top zeros
    break
  }
  return count
}

/** True when the HTML is the Obolus "Checking connection…" interstitial. */
export function isObolusChallenge(html) {
  return typeof html === 'string' &&
    html.includes('X_Obolus_Proof') &&
    /Checking connection/i.test(html)
}

// The interstitial's benchmark loop is a fixed 4096 SHA-256 hashes; the adaptive
// difficulty formula and clamp (12–18 bits) are read straight from its JS.
const OBOLUS_BENCHMARK_ITERATIONS = 4096
const OBOLUS_MIN_DIFFICULTY = 12

/**
 * Parse the inline CONFIG object out of an Obolus interstitial page. Returns
 * { nonce, challengeToken, challengeTimestamp, difficulty, maxTime, iterations }
 * or null. `difficulty` is a number for the fixed-difficulty variant, or the
 * string 'adaptive' for the load-escalated variant that derives difficulty from
 * a client benchmark (see solveObolusChallenge).
 */
export function parseObolusConfig(html) {
  if (typeof html !== 'string') return null
  const nonce             = html.match(/nonce:\s*'([0-9a-f]+)'/i)?.[1]
  const challengeToken    = html.match(/challengeToken:\s*'([0-9a-f]+)'/i)?.[1]
  const challengeTimestamp = html.match(/challengeTimestamp:\s*'(\d+)'/i)?.[1]
  const difficultyRaw     = html.match(/difficulty:\s*'([a-z0-9]+)'/i)?.[1]
  if (!nonce || !challengeToken || !challengeTimestamp || !difficultyRaw) return null
  const maxTime    = parseInt(html.match(/maxTime:\s*parseInt\('(\d+)'/)?.[1] ?? '4000', 10)
  const iterations = parseInt(html.match(/BENCHMARK_ITERATIONS\s*=\s*(\d+)/)?.[1] ?? String(OBOLUS_BENCHMARK_ITERATIONS), 10)
  return {
    nonce,
    challengeToken,
    challengeTimestamp,
    difficulty: /^\d+$/.test(difficultyRaw) ? parseInt(difficultyRaw, 10) : difficultyRaw,
    maxTime,
    iterations,
  }
}

/** Replicate the interstitial's adaptive-difficulty formula (clamped 12–18). */
function adaptiveDifficulty(benchmarkElapsed, targetTime, iterations) {
  const raw = Math.log2(targetTime * (iterations / benchmarkElapsed))
  return Math.max(OBOLUS_MIN_DIFFICULTY, Math.min(18, Math.floor(raw)))
}

/**
 * Solve an Obolus challenge: mine the smallest miningNonce whose
 * SHA-256(`{nonce}:mine:{miningNonce}`) has >= targetBits leading zero bits,
 * then assemble the proof cookie the server expects:
 *   timestamp:nonce:token:benchmarkElapsed:miningNonce
 *
 * Two variants:
 *   • Fixed difficulty (a number): mine that many bits; benchmarkElapsed is a
 *     self-reported figure the server doesn't verify in this mode.
 *   • Adaptive difficulty: the server re-derives the required bits from the
 *     benchmarkElapsed WE report, so we pick a benchmark that pins difficulty to
 *     the 12-bit floor (fastest) and mine exactly that.
 *
 * A safety cap keeps a scheme change (e.g. difficulty jumping to 30) from
 * spinning forever — it returns null instead, which surfaces as a 0-event run.
 * Pure + deterministic (given the config) → unit-testable without network.
 */
export function solveObolusChallenge(config, { benchmarkElapsed, maxAttempts = 1 << 24 } = {}) {
  if (!config?.nonce) return null

  let targetBits, reportedBenchmark
  if (typeof config.difficulty === 'number' && Number.isFinite(config.difficulty)) {
    targetBits = config.difficulty
    reportedBenchmark = benchmarkElapsed ?? 250
  } else {
    // Adaptive: choose a benchmark that lands on the 12-bit floor. targetTime is
    // 75% of maxTime, per the interstitial.
    const iterations = config.iterations ?? OBOLUS_BENCHMARK_ITERATIONS
    const targetTime = (config.maxTime ?? 4000) * 0.75
    reportedBenchmark = benchmarkElapsed
      ?? Math.ceil((targetTime * iterations) / Math.pow(2, OBOLUS_MIN_DIFFICULTY) * 1.2)
    targetBits = adaptiveDifficulty(reportedBenchmark, targetTime, iterations)
  }
  if (!Number.isFinite(targetBits) || targetBits < 1) return null

  let nonce = 0
  while (nonce < maxAttempts) {
    const digest = createHash('sha256').update(`${config.nonce}:mine:${nonce}`).digest()
    if (countLeadingZeroBits(digest) >= targetBits) {
      return `${config.challengeTimestamp}:${config.nonce}:${config.challengeToken}:${reportedBenchmark}:${nonce}`
    }
    nonce++
  }
  return null
}

/** Small async delay — spacing requests keeps the anti-bot from escalating. */
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

// Cache the last accepted proof cookie — it's domain-wide and valid ~30 min, so
// we try it first on each request and only re-solve when the server re-challenges.
let _proofCookie = null

/**
 * Fetch a URL, transparently clearing the Obolus proof-of-work challenge.
 * Strategy: send the cached proof cookie (if any); if the response is still the
 * interstitial, solve the fresh challenge it returned and replay the same URL
 * once with the new cookie.
 */
async function fetchWithObolus(url) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept:       'text/html,application/xhtml+xml',
  }
  // Node's fetch has no default timeout; without one a stalled connection hangs
  // the whole run. 20s is generous for a server-rendered Drupal page.
  const withTimeout = (extra = {}) => ({ headers: { ...headers, ...extra }, signal: AbortSignal.timeout(20_000) })

  // The server rotates challenges and occasionally re-challenges a freshly mined
  // proof (its own JS warns about a "proof rejected" loop), so we retry: on each
  // pass we solve whatever challenge came back and replay with that cookie. We
  // space attempts out — hammering the endpoint escalates the anti-bot to a
  // harder variant. The cap prevents an infinite loop.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1000)
    const res = await fetch(url, withTimeout(_proofCookie ? { Cookie: `X_Obolus_Proof=${_proofCookie}` } : {}))
    const html = await res.text()
    if (!isObolusChallenge(html)) return html

    const config = parseObolusConfig(html)
    if (!config) throw new Error(`Obolus challenge present but CONFIG unparseable at ${url}`)
    const proof = solveObolusChallenge(config)
    if (!proof) throw new Error(`Could not solve Obolus challenge (difficulty ${config.difficulty}) at ${url}`)
    _proofCookie = proof
  }
  throw new Error(`Obolus challenge not cleared after 4 attempts at ${url}`)
}

// ════════════════════════════════════════════════════════════════════════════
// MONTH ITERATION (Eastern-anchored)
// ════════════════════════════════════════════════════════════════════════════

/** Current { year, month } in America/New_York (month is 1-12). */
export function currentEasternYearMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
  }).formatToParts(now)
  return {
    year:  parseInt(parts.find((p) => p.type === 'year').value, 10),
    month: parseInt(parts.find((p) => p.type === 'month').value, 10),
  }
}

/** N consecutive months starting at { year, month }, rolling over years. */
export function monthsForward({ year, month }, count) {
  const out = []
  for (let i = 0; i < count; i++) {
    const zeroBased = month - 1 + i
    out.push({ year: year + Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 })
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════════
// DATE / TIME PARSING
// ════════════════════════════════════════════════════════════════════════════

/** Build "HH:MM:SS" from hour/minute/meridiem, or null when meridiem missing. */
function buildTime(hour, minute, meridiem) {
  if (!meridiem) return null
  let hr = parseInt(hour, 10)
  if (Number.isNaN(hr) || hr < 1 || hr > 12) return null
  const min = minute ?? '00'
  const mer = meridiem.toLowerCase()
  if (mer === 'pm' && hr !== 12) hr += 12
  if (mer === 'am' && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

/**
 * Parse the shop's "Date:" line ("Sat, 7/4/2026", also "7/4/2026") into an
 * ISO date string "YYYY-MM-DD", or null when nothing parses. The full year is
 * always present, so there is no year-rollover guessing.
 */
export function parseListingDate(raw) {
  if (!raw) return null
  const m = String(raw).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  const month = parseInt(mm, 10)
  const day   = parseInt(dd, 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parse the "Time:" line into { startTime, endTime } as "HH:MM:SS" (or null).
 * Handles single times ("11:00am"), ranges ("11:00am - 1:00pm"), and ranges
 * whose meridiem appears only on the end ("11-11:30am" → start inherits am).
 * Returns { startTime: null, endTime: null } when no clock time is published,
 * so the caller can fall back deliberately rather than assume midnight.
 */
export function parseTimeRange(raw) {
  const empty = { startTime: null, endTime: null }
  if (!raw) return empty
  const s = String(raw).toLowerCase().replace(/\./g, '').trim()

  // Range: START[meridiem?] - END meridiem. Start inherits the end's am/pm.
  const range = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (range) {
    const endMer   = range[6]
    const startMer = range[3] || endMer
    return {
      startTime: buildTime(range[1], range[2], startMer),
      endTime:   buildTime(range[4], range[5], endMer),
    }
  }

  // Single time: "6pm", "7:30pm", "10:30am".
  const single = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (single) return { startTime: buildTime(single[1], single[2], single[3]), endTime: null }

  return empty
}

/**
 * Recover a start time from description/teaser prose ("…on Saturday, July 04,
 * 2026 at 11:00 am.") when the Time line is absent. Same meridiem-required rule
 * as parseTimeRange, so dash-joined phone numbers never match.
 */
export function timeFromProse(text) {
  if (!text) return null
  const m = String(text).toLowerCase().replace(/\./g, '')
    .match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  return m ? buildTime(m[1], m[2], m[3]) : null
}

// ════════════════════════════════════════════════════════════════════════════
// LOCATION PARSING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse an <address> block's inner HTML into { name, street, city, state, zip }.
 * The block is line-broken with <br/>:
 *   The Learned Owl Book Shop <br/> 204 N Main St <br/> Hudson, OH 44236-2826
 * Returns null when empty. Missing fields come back null.
 */
export function parseLocation(addressHtml) {
  if (!addressHtml) return null
  const lines = htmlToText(addressHtml).split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null

  const name = lines[0]
  let city = null, state = null, zip = null, cszIdx = -1
  for (let i = lines.length - 1; i >= 1; i--) {
    const m = lines[i].match(/^(.+?),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?$/)
    if (m) { city = m[1].trim(); state = m[2].toUpperCase(); zip = m[3]; cszIdx = i; break }
  }
  const street = cszIdx > 1 ? lines.slice(1, cszIdx).join(', ') : (cszIdx === -1 && lines.length > 1 ? lines[1] : null)
  return { name, street, city, state, zip }
}

// ════════════════════════════════════════════════════════════════════════════
// TAG / CATEGORY / FACET MAPPING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Map the shop's tag terms + title into our lowercase tag slugs. The Owl uses
 * "Author Events-Adults", "Author Events-Children", "Storytime", "Book Club".
 */
export function parseTags(rawTags = [], title = '') {
  const text = `${rawTags.join(' ')} ${title}`.toLowerCase()
  const tags = ['bookstore']
  if (/author/.test(text))                 tags.push('author-event')
  if (/signing/.test(text))                tags.push('book-signing')
  if (/storytime|story time/.test(text))   tags.push('storytime')
  if (/book club/.test(text))              tags.push('book-club')
  if (/poetry|poet\b/.test(text))          tags.push('poetry')
  if (/children|kids|storytime|story time/.test(text)) tags.push('family')
  return [...new Set(tags)]
}

/** Kids' programming (children author events, storytimes) → is_family. */
export function isFamilyEvent(rawTags = [], title = '') {
  const text = `${rawTags.join(' ')} ${title}`.toLowerCase()
  return /children|kids|storytime|story time|young readers|picture book/.test(text)
}

// ════════════════════════════════════════════════════════════════════════════
// LISTING PARSE
// ════════════════════════════════════════════════════════════════════════════

function resolveUrl(href) {
  if (!href) return null
  if (/^https?:/i.test(href)) return href
  return BASE_DOMAIN + (href.startsWith('/') ? '' : '/') + href
}

/**
 * Strip Drupal's `/styles/<name>/public/` image-style segment so we store the
 * original-resolution file rather than the listing thumbnail derivative.
 */
function normalizeImage(src) {
  const full = resolveUrl(src)
  if (!full) return null
  return full.replace(/\/styles\/[^/]+\/public\//, '/').replace(/\?itok=[^&]+$/, '')
}

/**
 * Parse the month view's `<article class="event-list">` cards into raw records:
 * { sourceId, title, href, dateText, timeText, tags, teaser, imageUrl, locationHtml }.
 *
 * Cards are delimited by their opening `<article id="event-NNNN"…>` tag; we
 * slice between consecutive openers because the Place block nests its own
 * (id-less) <article>, so a naive `</article>` match would end a card early.
 */
export function parseEventCards(html) {
  const cards = []
  const seen = new Set()
  const openRe = /<article id="event-(\d+)" class="event-list">/g
  const opens = [...html.matchAll(openRe)]

  for (let i = 0; i < opens.length; i++) {
    const start = opens[i].index
    const end = i + 1 < opens.length ? opens[i + 1].index : html.length
    const block = html.slice(start, end)

    const titleMatch = block.match(/event-list__title"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!titleMatch) continue
    const href  = resolveUrl(titleMatch[1])
    const title = stripHtml(titleMatch[2])
    if (!title) continue

    // source_id = the URL path after /event/ (embeds the date → stable & unique).
    const slugMatch = titleMatch[1].match(/\/event\/(.+)$/)
    const sourceId = slugMatch ? slugMatch[1] : `node-${opens[i][1]}`
    if (seen.has(sourceId)) continue
    seen.add(sourceId)

    const tags = [...block.matchAll(/event-tag__term"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => stripHtml(m[1])).filter(Boolean)

    const dateText = extractLabelled(block, 'Date')
    const timeText = extractLabelled(block, 'Time')

    const teaserMatch = block.match(/event-list__body"[^>]*>([\s\S]*?)<\/div>/i)
    const teaser = teaserMatch ? stripHtml(teaserMatch[1]) : null

    const imgMatch = block.match(/event-list__image[\s\S]*?<img[^>]*src="([^"]+)"/i)
    const imageUrl = imgMatch ? normalizeImage(imgMatch[1]) : null

    const addrMatch = block.match(/<address>([\s\S]*?)<\/address>/i)
    const locationHtml = addrMatch ? addrMatch[1] : null

    cards.push({ sourceId, title, href, dateText, timeText, tags, teaser, imageUrl, locationHtml })
  }

  return cards
}

/** Pull the text after a "Label:" span inside a `.event-list__details--item`. */
function extractLabelled(block, label) {
  const re = new RegExp(`${label}:\\s*</span>([\\s\\S]*?)</div>`, 'i')
  const m = block.match(re)
  return m ? stripHtml(m[1]) : null
}

/**
 * Fetch an event's full description from its detail page. The listing only has
 * an auto-generated one-line teaser; the real copy (synopsis + author bio) is
 * in `.event-details__info--body`. Non-fatal: returns null on any failure.
 */
async function fetchEventDescription(href) {
  if (!href) return null
  try {
    const html = await fetchWithObolus(href)
    const m = html.match(/event-details__info--body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="event-details__info--tags|<\/div>\s*<\/div>)/i)
    if (!m) return null
    const text = htmlToText(m[1]).trim()
    return text || null
  } catch (err) {
    console.warn(`  ⚠ Could not fetch description for ${href}: ${err.message}`)
    return null
  }
}

// ════════════════════════════════════════════════════════════════════════════
// VENUE / ORGANIZATION
// ════════════════════════════════════════════════════════════════════════════

async function ensureStoreVenue() {
  return ensureVenue(STORE_VENUE.name, {
    address:       STORE_VENUE.address,
    city:          STORE_VENUE.city,
    state:         STORE_VENUE.state,
    zip:           STORE_VENUE.zip,
    lat:           STORE_VENUE.lat,
    lng:           STORE_VENUE.lng,
    parking_type:  STORE_VENUE.parking_type,
    parking_notes: STORE_VENUE.parking_notes,
    website:       STORE_VENUE.website,
    description:   STORE_VENUE.description,
  })
}

async function ensureOwlOrganization() {
  return ensureOrganization(STORE_VENUE.name, {
    website:     BASE_DOMAIN,
    description:
      'Independent bookstore in Hudson, Ohio, hosting author events, ' +
      'signings, book clubs, and children\'s storytimes.',
    address:     STORE_VENUE.address,
    city:        STORE_VENUE.city,
    state:       STORE_VENUE.state,
    zip:         STORE_VENUE.zip,
  })
}

/**
 * Resolve the venue for one event from its parsed location. In-store events
 * (the overwhelming majority) reuse the curated store venue with real coords;
 * offsite events get a venue keyed on the parsed name + address.
 */
async function resolveEventVenue(loc, storeVenueId) {
  if (!loc || !loc.name) return storeVenueId
  if (/learned\s*owl/i.test(loc.name)) return storeVenueId
  return ensureVenue(loc.name, {
    address: loc.street ?? undefined,
    city:    loc.city ?? undefined,
    state:   loc.state ?? undefined,
    zip:     loc.zip ?? undefined,
  })
}

// ════════════════════════════════════════════════════════════════════════════
// PROCESS
// ════════════════════════════════════════════════════════════════════════════

async function processCards(cards, storeVenueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const card of cards) {
    try {
      const dateStr = parseListingDate(card.dateText)
      if (!dateStr) {
        console.warn(`  ⚠ Skipping "${card.title}" — unparseable date: "${card.dateText}"`)
        skipped++
        continue
      }

      // Geography gate. In-store events are Hudson (Summit). Offsite events are
      // gated on their own city: 'out' → skip, 'unknown' → review queue.
      const loc = parseLocation(card.locationHtml)
      const locality = classifySummitLocation({ city: loc?.city })
      if (locality === 'out') {
        console.warn(`  ⤫ Skipping "${card.title}" — outside Summit County (${loc?.city ?? 'unknown city'})`)
        skipped++
        continue
      }

      const { startTime, endTime } = parseTimeRange(card.timeText)

      // Prefer the full detail-page description over the listing teaser.
      const detailDescription = await fetchEventDescription(card.href)
      const description = detailDescription
        ?? (card.teaser && card.teaser.length > 0 ? card.teaser : null)

      // Recover a start time from prose if the Time line was empty; document
      // the rare midnight fallback rather than silently landing there.
      const effectiveStart = startTime ?? timeFromProse(description) ?? timeFromProse(card.teaser)
      if (!effectiveStart) {
        console.warn(`  ⚠ "${card.title}" has no published time; storing date-only (midnight ET).`)
      }

      const startAt = easternToIso(dateStr, effectiveStart ?? '')
      if (!startAt) { skipped++; continue }
      const endAt = endTime ? easternToIso(dateStr, endTime) : null

      // Skip events that ended more than a day ago.
      const refMs = endAt ? new Date(endAt).getTime() : new Date(startAt).getTime()
      if (refMs < Date.now() - 86_400_000) { skipped++; continue }

      const venueId = await resolveEventVenue(loc, storeVenueId)

      const row = {
        title:           card.title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        // Every Owl event is an author signing/reading/storytime → learning.
        // Lock the content category so text inference can't mis-tag a signing
        // as 'sports'/'film' from the book's subject matter in the author bio.
        categories:      ['learning'],
        tags:            parseTags(card.tags, card.title),
        // Explicit boolean (not true/undefined): the shop's "Author
        // Events-Children" tag is the authoritative family signal, so we lock it
        // rather than let text inference flip it based on an author's book blurb.
        is_family:       isFamilyEvent(card.tags, card.title),
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       card.imageUrl,
        ticket_url:      card.href ?? SOURCE_URL,
        source:          SOURCE_KEY,
        source_id:       card.sourceId,
        status:          locality === 'in' ? 'published' : 'pending_review',
        needs_review:    locality === 'in' ? undefined : true,
        featured:        false,
      }

      const enriched = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
        continue
      }
      await linkEventVenue(upserted.id, venueId)
      await linkEventOrganization(upserted.id, organizerId)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${card.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('🚀  Starting Learned Owl ingestion…')
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary()

    const [storeVenueId, organizerId] = await Promise.all([
      ensureStoreVenue(),
      ensureOwlOrganization(),
    ])
    if (storeVenueId && organizerId) await linkOrganizationVenue(organizerId, storeVenueId)

    const months = monthsForward(currentEasternYearMonth(), HORIZON_MONTHS)
    const allCards = []
    const seen = new Set()

    for (const [idx, { year, month }] of months.entries()) {
      if (idx > 0) await sleep(600) // space month requests to stay under the radar
      const url = `${SOURCE_URL}/${year}/${String(month).padStart(2, '0')}`
      console.log(`\n🔍  Fetching ${url}…`)
      try {
        const html = await fetchWithObolus(url)
        const cards = parseEventCards(html)
        console.log(`  Found ${cards.length} event cards`)
        for (const c of cards) {
          if (seen.has(c.sourceId)) continue
          seen.add(c.sourceId)
          allCards.push(c)
        }
      } catch (err) {
        console.warn(`  ⚠ Failed to fetch ${url}: ${err.message}`)
      }
    }

    if (allCards.length === 0) {
      console.warn('  ⚠ No event cards parsed across the horizon. If unexpected, ' +
        'inspect /events — the Obolus challenge or event-list markup may have changed.')
    }

    console.log(`\n📥  Processing ${allCards.length} unique events…`)
    const { inserted, skipped } = await processCards(allCards, storeVenueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allCards.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
