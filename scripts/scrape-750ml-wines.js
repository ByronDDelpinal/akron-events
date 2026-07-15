/**
 * scrape-750ml-wines.js
 *
 * 750ml Wines — a champagne-forward wine bar and boutique at 2287 W. Market St
 * in Akron's Pilgrim Square neighborhood (Summit County, on the edge of
 * Fairlawn). Their /akron-events/ page is a hand-built WordPress + Elementor
 * page with TWO shapes of event data:
 *
 *   1. "Upcoming Events" — a small set of image tiles, each linking to a
 *      per-event detail page under /akron-events/<slug>/. Those detail pages
 *      carry clean, structured fields (📅 date, ⏰ time, 📍 location, and a
 *      "Club750 Members / General Admission" price list). These are the
 *      reliable, high-value events.
 *   2. "Live Music" — a prose schedule ("Saturday Nights from 6pm - 8pm")
 *      listing a performer per date. The prose is unreliable: as captured
 *      2026-07-15 every listed date's WEEKDAY WORD contradicted the actual
 *      weekday of the stated calendar date (all four "Saturday" dates were
 *      Mondays in 2026). We therefore treat the prose defensively — see the
 *      weekday-integrity guard below.
 *
 * Platform: static HTML (list page + detail pages). No events plugin, no feed,
 * no JSON-LD events — everything is parsed out of the rendered markup, which is
 * why this is a bespoke HTML scraper rather than a Tribe/Wix/ICS lib call.
 *
 * Strategy:
 *   • Fetch /akron-events/, discover detail-page links, fetch each and parse
 *     its structured date/time/price block. Category → food (wine tasting /
 *     pairing) unless the text clearly reads music.
 *   • Parse the Live Music prose, but only ingest an occurrence when the
 *     stated weekday matches the computed weekday of the stated date AND the
 *     date is still in the future. A "Saturday, July 13th" that is actually a
 *     Monday is internally inconsistent — we cannot trust either field, so we
 *     skip it (never guess). This self-heals: the moment the shop lists a
 *     correct weekday+date pair, it flows in on the next scrape.
 *   • Prose dates carry no year — inference is anchored to America/New_York
 *     "today", rolling forward when the month/day has already passed (never
 *     local Date + toISOString; see the ET off-by-one lesson).
 *   • Times: easternToIso(date, time). Prices only when the detail page states
 *     them; the prose live-music series lists none (price_min/max stay null).
 *
 * Geography: single fixed Summit County venue (Akron 44313). The business also
 * has a non-Summit location (a 440 area-code phone appears in the footer) but
 * this /akron-events/ page is scoped to the Akron shop only, so every event
 * pins to the one Akron venue — no per-event geo classification needed.
 *
 * Key note: the DB `source` value is "750ml_wines". Source keys are only ever
 * used as quoted string literals / Set members (manifest.js, source-tiers.js,
 * DB `source` column), never as bare JS identifiers, so the leading digit is
 * safe; `seven_fifty_ml` is unnecessary.
 *
 * Usage:
 *   node scripts/scrape-750ml-wines.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
  easternToIso,
  htmlToText,
} from './lib/normalize.js'

export const SOURCE_KEY = '750ml_wines'
const LIST_URL   = 'https://750mlwines.com/akron-events/'
const ORIGIN     = 'https://750mlwines.com'
const DAYS_AHEAD = 180
const UA = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME   = '750ml Wines'
const VENUE_NAME = '750ml Wines'
const VENUE_DETAILS = {
  address: '2287 W. Market St',
  city: 'Akron', state: 'OH', zip: '44313',
  lat: 41.1182933, lng: -81.5882722,
  website: ORIGIN,
  parking_type: 'lot',
  description:
    'Champagne-forward wine bar and boutique in Akron\'s Pilgrim Square ' +
    'neighborhood, with a Veuve Clicquot patio, cocktails, cheeses, and ' +
    'international charcuterie.',
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// getUTCDay indices for the weekday-word prefixes the site uses.
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, tues: 2, wednes: 3, thur: 4, thurs: 4, fri: 5, satur: 6 }

// ════════════════════════════════════════════════════════════════════════════
// Pure helpers (exported for tests)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Discover per-event detail links on the list page. Returns de-duplicated
 * { url, slug, imageUrl, alt } — the same detail page is linked twice (image
 * tile + button), so we key by slug. The list page itself
 * (/akron-events/ with no trailing slug) is excluded.
 */
export function extractEventLinks(listHtml = '') {
  const out = new Map()
  const anchorRe = /<a\b[^>]*href="(https?:\/\/750mlwines\.com\/akron-events\/([a-z0-9][a-z0-9-]*)\/)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = anchorRe.exec(listHtml)) !== null) {
    const [, url, slug, inner] = m
    if (!slug) continue
    const imageUrl = inner.match(/<img[^>]*?(?:data-src|src)="([^"]+\.(?:jpe?g|png|webp))"/i)?.[1] ?? null
    const alt = inner.match(/alt="([^"]*)"/i)?.[1] ?? null
    if (!out.has(slug)) out.set(slug, { url, slug, imageUrl, alt: alt ? stripHtml(alt) : null })
  }
  return [...out.values()]
}

/** Pull a `<meta property="og:NAME" content="…">` (or name=…) value. */
export function metaContent(html = '', key = '') {
  const re = new RegExp(
    `<meta[^>]*(?:property|name)="(?:og:)?${key}"[^>]*content="([^"]*)"`, 'i')
  const alt = new RegExp(
    `<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="(?:og:)?${key}"`, 'i')
  const raw = html.match(re)?.[1] ?? html.match(alt)?.[1] ?? null
  return raw ? stripHtml(raw) : null
}

/**
 * Strip promotional suffixes off an og:title so it reads as a clean event
 * name: "Turnbull Wine & Tatuaje Cigar Night in Akron on July 14" →
 * "Turnbull Wine & Tatuaje Cigar Night"; "Una Serata Italiana | Italian Wine
 * Patio Night on July 22" → "Una Serata Italiana".
 */
export function cleanEventTitle(raw = '') {
  let t = stripHtml(raw).split(' | ')[0].trim()
  t = t.replace(/\s+in\s+Akron\b.*$/i, '')
  t = t.replace(
    /\s+on\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b.*$/i,
    '')
  return t.trim()
}

/** "Tuesday, July 14, 2026" → "2026-07-14" (weekday word ignored). */
export function parseDetailDate(text = '') {
  const m = text.match(
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  const day = parseInt(m[2], 10)
  const year = parseInt(m[3], 10)
  if (!month || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "6:30 PM" / "6 PM" → "6:30 pm" (easternToIso-friendly), or null. */
export function normalizeClock(tok) {
  if (!tok) return null
  const t = String(tok).trim().toLowerCase().replace(/\./g, '')
  if (t === 'noon') return '12:00 pm'
  if (t === 'midnight') return '12:00 am'
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  if (hour < 1 || hour > 12) return null
  return `${hour}:${m[2] ?? '00'} ${m[3]}`
}

/**
 * Parse the structured block of a detail page.
 * Returns { title, dateStr, timeStr, location, isPatio, priceMin, priceMax,
 *           description, imageUrl } — fields that could not be read are null.
 */
export function parseDetailPage(html = '') {
  const dateLine = html.match(/📅\s*([^<\n]+)/)?.[1] ?? ''
  const timeLine = html.match(/⏰\s*([^<\n]+)/)?.[1] ?? ''
  const locLine  = html.match(/📍\s*([^<\n]+)/)?.[1] ?? ''

  const dateStr = parseDetailDate(stripHtml(dateLine))
  const timeStr = normalizeClock(stripHtml(timeLine).match(/\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?/i)?.[0])

  const location = stripHtml(locLine).trim() || null
  const isPatio  = /patio/i.test(location ?? '')

  const { priceMin, priceMax } = parseDetailPrice(html)

  const ogTitle = metaContent(html, 'title')
  const title = cleanEventTitle(ogTitle ?? '')
  const description = metaContent(html, 'description')
  const imageUrl = metaContent(html, 'image')

  return { title, dateStr, timeStr, location, isPatio, priceMin, priceMax, description, imageUrl }
}

/**
 * Read the "Club750 Members: $NN" / "General Admission: $NN" price list.
 * price_min = the lower of the two, price_max = the higher. When only one is
 * present, both mirror it. When none are stated, both stay null (never assume
 * free — the "Club750" label deliberately isn't matched as a dollar amount).
 */
export function parseDetailPrice(html = '') {
  const grab = (label) => {
    const re = new RegExp(`${label}\\s*:?\\s*<\\/strong>\\s*\\$?(\\d+(?:\\.\\d{2})?)`, 'i')
    const alt = new RegExp(`${label}\\s*:?\\s*\\$(\\d+(?:\\.\\d{2})?)`, 'i')
    const v = html.match(re)?.[1] ?? html.match(alt)?.[1]
    return v != null ? parseFloat(v) : null
  }
  const member = grab('Club750 Members')
  const general = grab('General Admission')
  const nums = [member, general].filter((n) => n != null && !Number.isNaN(n))
  if (!nums.length) return { priceMin: null, priceMax: null }
  return { priceMin: Math.min(...nums), priceMax: Math.max(...nums) }
}

/** Category hint for a detail page — wine tastings/pairings are food. */
export function parseDetailCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase()
  if (/\b(concert|live music|band|dj|performance)\b/.test(text)) return 'music'
  if (/\b(wine|cigar|tasting|pairing|charcuterie|aperitivo|champagne|cocktail|italian)\b/.test(text)) return 'food'
  return null // defer to text inference
}

// ── Live-music prose ────────────────────────────────────────────────────────

// One performer per line (line-based — run on htmlToText output, not stripHtml):
//   "Saturday, July 13th - Ceci Taylor"
//   "Saturday, August 17th & October 12th - Daniel Rylander"
const LIVE_LINE_RE =
  /(sun|mon|tues?|wednes|thurs?|fri|satur)day,\s*([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*(?:&|and|,)\s*(?:[A-Za-z]+\s+)?\d{1,2}(?:st|nd|rd|th)?)*)\s*[-–—]\s*([^\n]+)/gi

/** Header time, e.g. "Saturday Nights from 6pm - 8pm" → { timeStr, endTimeStr }. */
export function parseLiveMusicTime(text = '') {
  const m = text.match(/from\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return { timeStr: null, endTimeStr: null }
  const endMer = m[6].toLowerCase()
  const startMer = (m[3] ?? endMer).toLowerCase()
  return {
    timeStr: normalizeClock(`${m[1]}:${m[2] ?? '00'} ${startMer}`),
    endTimeStr: normalizeClock(`${m[4]}:${m[5] ?? '00'} ${endMer}`),
  }
}

/**
 * ET "today" as { year, ms } (midnight ET that day, expressed as a UTC ms of
 * the same Y-M-D). Anchors year inference and future filtering to Eastern.
 */
export function easternToday(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const g = (t) => parseInt(parts.find((p) => p.type === t).value, 10)
  const year = g('year')
  return { year, ms: Date.UTC(year, g('month') - 1, g('day')) }
}

/**
 * Parse the Live Music prose into occurrence candidates. Each carries a
 * `weekdayMatches` flag (stated weekday word vs the actual weekday of the
 * stated date) and an `isFuture` flag. main() ingests only those where BOTH
 * are true — an internally inconsistent "Saturday" that is really a Monday is
 * dropped rather than guessed at.
 */
export function parseLiveMusicEvents(sectionText = '', opts = {}) {
  const { year: nowYear, ms: todayMs } = easternToday(opts.nowMs ?? Date.now())
  const { timeStr, endTimeStr } = parseLiveMusicTime(sectionText)
  const out = []

  for (const m of sectionText.matchAll(LIVE_LINE_RE)) {
    const weekdayWord = m[1].toLowerCase()
    const targetDow = WEEKDAY_INDEX[weekdayWord]
    const performer = stripHtml(m[3]).trim().replace(/[.,;]+$/, '')
    if (!performer) continue

    let lastMonth = null
    for (const tok of m[2].split(/\s*(?:&|and|,)\s*/)) {
      const dm = tok.match(/(?:([A-Za-z]+)\s+)?(\d{1,2})(?:st|nd|rd|th)?/)
      if (!dm) continue
      const month = dm[1] ? MONTHS[dm[1].toLowerCase()] : lastMonth
      if (!month) continue
      lastMonth = month
      const day = parseInt(dm[2], 10)
      if (day < 1 || day > 31) continue

      // Year inference anchored to ET today; roll forward if already ~2 months past.
      let year = nowYear
      if (Date.UTC(year, month - 1, day) < todayMs - 60 * 86400_000) year += 1
      const dateMs = Date.UTC(year, month - 1, day)
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

      out.push({
        dateStr,
        performer,
        weekdayWord,
        weekdayMatches: new Date(dateMs).getUTCDay() === targetDow,
        isFuture: dateMs >= todayMs - 86400_000,
        timeStr,
        endTimeStr,
      })
    }
  }
  return out
}

/**
 * Isolate the Live Music block so unrelated "Saturday" text can't be parsed.
 * Uses htmlToText (line breaks preserved) — LIVE_LINE_RE is line-based, so a
 * performer name can't swallow the following performer's line.
 */
export function extractLiveMusicSection(html = '') {
  const text = htmlToText(html)
  const start = text.search(/Live Music/i)
  if (start === -1) return ''
  return text.slice(start, start + 800)
}

// ════════════════════════════════════════════════════════════════════════════
// Fetch
// ════════════════════════════════════════════════════════════════════════════

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.text()
}

// ════════════════════════════════════════════════════════════════════════════
// Process
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('🍷  Starting 750ml Wines ingestion…')
  const start = Date.now()
  const now = Date.now()
  const horizon = now + DAYS_AHEAD * 86400_000

  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: VENUE_DETAILS.website, description: VENUE_DETAILS.description }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, venueId)

    const listHtml = await fetchHtml(LIST_URL)
    const links = extractEventLinks(listHtml)
    console.log(`  Found ${links.length} detail link(s): ${links.map((l) => l.slug).join(', ') || '(none)'}`)

    let found = 0, inserted = 0, skipped = 0
    const rows = []

    // ── Detail-page events ────────────────────────────────────────────────
    for (const link of links) {
      try {
        const detailHtml = await fetchHtml(link.url)
        const d = parseDetailPage(detailHtml)
        found++
        if (!d.title || !d.dateStr) {
          console.log(`  ⚠ Skipping ${link.slug} — missing title/date`)
          skipped++
          continue
        }
        if (!d.timeStr) {
          // Never synthesize a silent midnight: a detail page with a date but no
          // parseable ⏰ time falls back to midnight-Eastern — flag it in the log.
          console.warn(`  ⚠ "${d.title}" (${d.dateStr}) has no time on the detail page — stored as midnight-Eastern (date-only)`)
        }
        const startAt = easternToIso(d.dateStr, d.timeStr ?? '')
        if (!startAt) { console.log(`  ⚠ Skipping "${d.title}" — bad start`); skipped++; continue }

        rows.push({
          title:           d.title,
          description:     d.description || null,
          start_at:        startAt,
          end_at:          d.timeStr ? new Date(new Date(startAt).getTime() + 2.5 * 3600_000).toISOString() : null,
          category:        parseDetailCategory(d.title, d.description ?? ''),
          tags:            ['wine', 'wine-tasting', '750ml', 'akron', ...(d.isPatio ? ['patio'] : [])],
          price_min:       d.priceMin,
          price_max:       d.priceMax,
          age_restriction: '21_plus',
          image_url:       d.imageUrl ?? link.imageUrl ?? null,
          ticket_url:      link.url,
          source:          SOURCE_KEY,
          source_id:       link.slug,
          status:          'published',
          featured:        false,
        })
      } catch (err) {
        console.warn(`  ⚠ Error on ${link.slug}: ${err.message}`)
        skipped++
      }
    }

    // ── Live-music prose (weekday-integrity guarded) ──────────────────────
    const liveEvents = parseLiveMusicEvents(extractLiveMusicSection(listHtml), { nowMs: now })
    for (const ev of liveEvents) {
      if (!ev.weekdayMatches) {
        console.log(`  ⛔ Live music "${ev.performer}" ${ev.dateStr}: stated ${ev.weekdayWord}day ≠ actual weekday — skipping (unreliable prose)`)
        skipped++
        continue
      }
      if (!ev.isFuture) { skipped++; continue }
      const startAt = easternToIso(ev.dateStr, ev.timeStr ?? '')
      if (!startAt) { skipped++; continue }
      found++
      rows.push({
        title:           `Live Music: ${ev.performer}`,
        description:     `Live music at 750ml Wines${ev.timeStr ? ` from ${ev.timeStr} to ${ev.endTimeStr}` : ''}.`,
        start_at:        startAt,
        end_at:          ev.timeStr && ev.endTimeStr ? easternToIso(ev.dateStr, ev.endTimeStr) : null,
        category:        'music',
        tags:            ['live-music', 'wine-bar', '750ml', 'akron'],
        price_min:       null,
        price_max:       null,
        age_restriction: '21_plus',
        image_url:       null,
        ticket_url:      LIST_URL,
        source:          SOURCE_KEY,
        source_id:       `live-music-${ev.dateStr}`,
        status:          'published',
        featured:        false,
      })
    }

    // ── Upsert ────────────────────────────────────────────────────────────
    console.log(`\n📥  ${rows.length} candidate event(s)…`)
    for (const row of rows) {
      const startMs = new Date(row.start_at).getTime()
      if (startMs < now - 86400_000 || startMs > horizon) {
        console.log(`  ⚠ Skipping "${row.title}" — outside window (${row.start_at})`)
        skipped++
        continue
      }
      try {
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
          skipped++
        } else {
          await linkEventVenue(upserted.id, venueId)
          await linkEventOrganization(upserted.id, organizerId)
          console.log(`  ✓ ${row.title} — ${row.start_at}`)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error upserting "${row.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: found, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
