/**
 * scrape-habitat-summit.js
 *
 * Habitat for Humanity of Summit County (hfhsummitcounty.org) — affordable-
 * housing nonprofit. Its events page carries two kinds of events:
 *
 *   1. "Annual Fundraising Events" — static cards for the marquee fundraisers
 *      (Build In Style, Home In One golf outing, Bourbon Build). Reliable
 *      title/date/location, but NO published start time (the landing pages are
 *      noisy/stale), so we infer a sensible time from the event type.
 *   2. ECWD (Events Calendar WD plugin) calendar — volunteer/community events
 *      (e.g. Neighborhood Reborn) rendered into a month grid with /event/<slug>
 *      links and machine-readable date ranges (YYYY.MM.DD) + times.
 *
 * Why HTML parsing: the ECWD plugin exposes no public REST/JSON (its /ecwd/v1/
 * routes are write-only and the post type isn't in WP REST), there's no Event
 * JSON-LD, and no all-events iCal feed. The events page is server-rendered, so
 * we parse it directly. These are charity fundraisers + volunteer drives, so
 * they're tagged for the Give Back facet.
 *
 * Usage:   node scripts/scrape-habitat-summit.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, decodeEntities, easternToIso,
  inferCategory, enrichWithImageDimensions, upsertEventSafe, linkEventVenue,
  linkEventOrganization, ensureVenue, ensureOrganization,
} from './lib/normalize.js'

export const SOURCE_KEY = 'habitat_summit'
const SITE = 'https://hfhsummitcounty.org'
const EVENTS_URL = `${SITE}/joinus/events/`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_DAYS_AHEAD = 450

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const TAGS = ['fundraiser', 'charity', 'habitat-for-humanity', 'give-back']

// ── Pure parsers (exported for tests) ───────────────────────────────────────

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Parse "Tuesday, March 9th, 2027" → "YYYY-MM-DD". */
export function parseCardDate(text) {
  const m = String(text || '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`
}

/** Fundraisers publish no time — infer one from the event type. */
export function inferFundraiserTime(title, description) {
  const t = `${title || ''} ${description || ''}`.toLowerCase()
  if (/\bgolf\b|outing|tee\b|scramble/.test(t))            return '9:00 AM'   // morning shotgun
  if (/luncheon|lunch|build in style|fashion|brunch/.test(t)) return '11:00 AM' // midday luncheon
  return '6:00 PM'                                                              // evening gala/social
}

/** Parse the "Annual Fundraising Events" cards. */
export function parseFundraiserCards(html) {
  const s = String(html || '')
  const start = s.search(/Annual Fundraising Events/i)
  if (start < 0) return []
  const endIdx = s.search(/Support these Fundraising/i)
  const region = s.slice(start, endIdx > start ? endIdx : s.length)

  const re = /<h2[^>]*>([\s\S]*?)<\/h2>\s*<h4[^>]*>([\s\S]*?)<\/h4>\s*<h4[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<h2[^>]*>|$)/gi
  const out = []
  for (const m of region.matchAll(re)) {
    const title = stripTags(m[1])
    const date = parseCardDate(stripTags(m[2]))
    const location = stripTags(m[3]) || null
    if (!title || !date) continue
    const rest = m[4]
    const descM = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const description = descM ? htmlToText(descM[1]).slice(0, 2000) || null : null
    const urlM = rest.match(/<a[^>]+href="([^"?#]+)"[^>]*>\s*More Here/i)
    out.push({ title, date, time: inferFundraiserTime(title, description), location, description, url: urlM ? urlM[1] : EVENTS_URL, kind: 'fundraiser' })
  }
  return out
}

/** Best-effort parse of ECWD calendar events (volunteer/community). Deduped by slug. */
export function parseEcwdEvents(html, origin = SITE) {
  const s = String(html || '')
  const re = /\/event\/([a-z0-9-]+)\/?"[^>]*>\s*(?:<span[^>]*>)?([\s\S]*?)<\/(?:span|a)>[\s\S]{0,600}?(\d{1,2}:\d{2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m)[\s\S]{0,160}?(\d{4})\.(\d{2})\.(\d{2})/gi
  const seen = new Map()
  for (const m of s.matchAll(re)) {
    const slug = m[1]
    if (seen.has(slug)) continue
    const title = stripTags(m[2])
    if (!title) continue
    seen.set(slug, {
      title,
      date: `${m[5]}-${m[6]}-${m[7]}`,
      time: m[3].replace(/\s+/g, ' ').toUpperCase(),
      url: `${origin}/event/${slug}/`,
      kind: 'volunteer',
    })
  }
  return [...seen.values()]
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏠  Starting Habitat for Humanity of Summit County ingestion…')
  const start = Date.now()
  try {
    const html = await fetchHtml(EVENTS_URL)
    const events = [...parseFundraiserCards(html), ...parseEcwdEvents(html)]
    console.log(`  Parsed ${events.length} event(s)`)

    const organizerId = await ensureOrganization('Habitat for Humanity of Summit County', {
      website: SITE,
      description: 'Habitat for Humanity of Summit County builds and repairs affordable homes in Summit County, running annual fundraisers and community volunteer drives.',
    })

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    const venueCache = new Map()
    let inserted = 0, skipped = 0

    for (const ev of events) {
      try {
        const startIso = easternToIso(ev.date, ev.time)
        if (!startIso) { skipped++; continue }
        const ms = Date.parse(startIso)
        if (ms < now - 86_400_000 || ms > cutoff) { skipped++; continue }

        let venueId = null
        if (ev.location) {
          if (venueCache.has(ev.location)) venueId = venueCache.get(ev.location)
          else {
            venueId = await ensureVenue(ev.location, { state: 'OH' })
            venueCache.set(ev.location, venueId)
          }
        }

        const category = inferCategory(ev.title, ev.description || '') || 'civic'
        const slug = ev.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const row = {
          title:           ev.title,
          description:     ev.description || null,
          start_at:        startIso,
          end_at:          null,
          category:        category === 'other' ? 'civic' : category,
          tags:            ev.kind === 'volunteer' ? [...TAGS, 'volunteer'] : TAGS,
          price_min:       ev.kind === 'volunteer' ? 0 : null,   // volunteer drives are free; fundraisers never assumed
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      ev.url,
          source:          SOURCE_KEY,
          source_id:       `${slug}-${startIso.slice(0, 10)}`,
          status:          'published',
          featured:        false,
        }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${ev.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
