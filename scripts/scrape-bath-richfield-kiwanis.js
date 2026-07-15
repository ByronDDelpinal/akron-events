/**
 * scrape-bath-richfield-kiwanis.js
 *
 * Bath Richfield Kiwanis — a service club straddling Bath and Richfield
 * townships (both Summit County). Like every Kiwanis calendar, theirs is
 * dominated by INTERNAL club life (weekly "General Meeting-with dessert",
 * board meetings, "No Meeting" holidays, Community-Day prep sessions) with a
 * thin seam of genuinely PUBLIC events mixed in — the club's pancake
 * breakfasts, Community Day, craft shows and other fundraisers. Those public
 * events are what Akron Pulse surfaces.
 *
 * ── Platform: Modern Events Calendar (MEC), NOT The Events Calendar ──────────
 * The site runs the MEC WordPress plugin, so there is NO /wp-json/tribe REST
 * API. The calendar body is rendered by an admin-ajax action:
 *
 *   POST /wp-admin/admin-ajax.php
 *     action=mec_list_load_month & mec_year=YYYY & mec_month=MM
 *     & atts[sk-options][list][style]=standard
 *
 * The JSON response carries an `html` string. For each event that HTML holds a
 * schema.org JSON-LD <script> (startDate / endDate / offers.url) IMMEDIATELY
 * followed by an <article class="mec-event-article"> whose
 * <h3 class="mec-event-title"><a data-event-id="…" href="…">TITLE</a> gives the
 * human title, the stable numeric event id, and the permalink. (The JSON-LD
 * itself has NO name field, and the offers.url slug is stale — always read the
 * title from the <h3>.)
 *
 * ── QUIRK 1: broken site timezone ────────────────────────────────────────────
 * MEC's timezone is misconfigured. A "6 PM Regular Meeting" is emitted as
 * startDate "2026-07-16T14:00:00-04:00" — i.e. 14:00 at UTC-4, which is
 * 18:00Z. The intended Eastern wall-clock (18:00 = 6 PM) equals the UTC
 * components of the parsed instant, NOT the -04:00 local representation.
 * Rule: parse the instant, take its getUTC* components, and feed those to
 * easternToIso() as Eastern local. (Verified against the "6 PM" meeting title.)
 *
 * ── QUIRK 2: month responses overlap; has_more_event is unreliable ───────────
 * A month load bleeds the next month's first event into its list (July's load
 * includes the Aug 6 meeting), and empty months return has_more_event=1. So we
 * iterate a fixed forward window of months and dedupe by event id rather than
 * trusting the paging flag.
 *
 * ── QUIRK 3: public-event ALLOWLIST (mandatory) ──────────────────────────────
 * A club calendar defaults to internal business, so — as with the Portage
 * Lakes Kiwanis and faith-source scrapers — an event must LOOK public to
 * ingest (PUBLIC_RE), and hard private/meeting markers (PRIVATE_RE) veto even a
 * public-looking word ("General Meeting-Community Day prep" is a prep meeting,
 * not Community Day). Expect a low but high-quality yield; volume never
 * disqualifies a Summit source.
 *
 * ── QUIRK 4: geography ───────────────────────────────────────────────────────
 * The JSON-LD `location` is always empty and events run at varied Bath/
 * Richfield venues, so there is no per-event venue to link. We parse a city
 * from the title when one is named and gate it with classifySummitLocation():
 * an explicitly out-of-county city is skipped. A title with no parseable city
 * is village-local by nature (a Bath/Richfield club event) and is published —
 * this source is a single Summit club, so "unknown locality" here means "local"
 * rather than "route to review". Price is always MEC's "0" default → null,
 * never assumed free.
 *
 * Usage:   node scripts/scrape-bath-richfield-kiwanis.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml,
  enrichWithImageDimensions, upsertEventSafe, linkEventOrganization,
  ensureOrganization, easternToIso, inferCategory,
} from './lib/normalize.js'
import { classifySummitLocation, SUMMIT_COUNTY_CITIES, NOT_SUMMIT_COUNTY_CITIES, preloadSummitCountyBoundary } from './lib/summit-county.js'

export const SOURCE_KEY = 'bath_richfield_kiwanis'
const AJAX_URL      = 'https://www.bathrichfieldkiwanis.org/wp-admin/admin-ajax.php'
const SITE_URL      = 'https://www.bathrichfieldkiwanis.org'
const MONTHS_AHEAD  = 8
const USER_AGENT    = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME = 'Bath Richfield Kiwanis'
const ORG_DETAILS = {
  website: SITE_URL,
  description: 'Bath Richfield Kiwanis service club — community events and fundraisers across Bath and Richfield (Summit County).',
}

// ── Public-event allowlist (exported for tests) ─────────────────────────────

// Public-community signals — the club's fundraisers and open events. A club
// booking must match one of these to ingest; everything else (the weekly
// meeting, board sessions, prep nights, "No Meeting" holidays) is skipped.
const PUBLIC_RE = new RegExp([
  // meal fundraisers (Kiwanis staples)
  'pancake', 'breakfast', 'fish fry', 'spaghetti', 'pasta dinner', 'chili',
  'pig roast', 'chicken (paprikash|bbq|barbecue)', 'bake sale', 'pancake day',
  // sales / markets
  'craft show', 'craft fair', 'bazaar', 'rummage', 'garage sale', 'book sale',
  'flower sale', 'mum sale', 'poinsettia', 'holiday market', 'peanut day',
  // festivals / gatherings
  'festival', 'fair\\b', 'carnival', 'parade', 'block party', 'concert',
  'live music', 'car show', 'community day', 'family fun day', 'fun day',
  'field day', 'kids.? day', 'open house',
  // charity / drives / classic outings
  'fundraiser', 'benefit', 'charity', 'blood drive', 'golf outing',
  'golf scramble', 'golf classic', 'reverse raffle',
  // seasonal / family
  'santa', 'easter egg', 'egg hunt', 'trick.or.treat', 'trunk.or.treat',
  'fishing derby', 'fun run', '\\b5k\\b',
].join('|'), 'i')

// Hard private/internal markers. These beat the allowlist: a "board breakfast"
// or "Community Day prep" is club business, not a public event. "memorial" is
// gated so "Memorial Day" (a holiday) still passes.
const PRIVATE_RE = new RegExp([
  '\\bmeeting\\b', '\\bno meeting\\b', '\\bboard\\b', '\\bcommittee\\b',
  '\\bprep\\b', '\\bofficer', '\\binstallation\\b', '\\binduction\\b',
  '\\binterclub\\b', '\\bdivision council\\b', '\\bdcm\\b', '\\brehearsal\\b',
  '\\bclosed\\b', '\\borientation\\b', '\\bplanning\\b',
  '\\bmemorial\\b(?!\\s+day)', '\\bfuneral\\b', '\\bcelebration of life\\b',
  '\\bprivate\\b', '\\brental\\b', '\\bwedding\\b', '\\bshower\\b',
  '\\bgraduation\\b', '\\bbirthday\\b',
].join('|'), 'i')

/** True when a club-calendar title is a genuinely public event (allowlist). */
export function includeEvent(title = '') {
  const t = stripHtml(String(title))
  if (PRIVATE_RE.test(t)) return false
  if (!PUBLIC_RE.test(t)) return false
  // Explicit out-of-county venue named in the title → skip.
  const city = extractCityFromTitle(t)
  if (city && classifySummitLocation({ city }) === 'out') return false
  return true
}

/** Why an event was skipped — for the run log. */
export function skipReason(title = '') {
  const t = stripHtml(String(title))
  if (PRIVATE_RE.test(t)) return 'internal club business (meeting/prep/private)'
  if (!PUBLIC_RE.test(t)) return 'no public-event signal (club-calendar default)'
  return 'outside Summit County'
}

// ── Field mapping (exported for tests) ──────────────────────────────────────

// Meal / food-fundraiser keywords — these carry the 'food' content badge even
// though inferCategory doesn't treat a bare "pancake breakfast" as food.
const FOOD_RE = /\b(pancake|breakfast|fish fry|spaghetti|pasta dinner|chili|pig roast|chicken (paprikash|bbq|barbecue)|bake sale|luncheon|dinner)\b/i

// Clear fundraiser signals for a service club (meals, sales, outings, drives).
const FUNDRAISER_RE = /\b(pancake|breakfast|fish fry|spaghetti|pasta dinner|chili|pig roast|chicken (paprikash|bbq|barbecue)|bake sale|peanut day|fundraiser|benefit|charity|golf outing|golf scramble|golf classic|reverse raffle|rummage|bazaar|book sale|flower sale|mum sale|poinsettia|craft show|craft fair|blood drive|.\bdrive\b)\b/i

/** Content category (badge). Meal fundraisers are 'food'; else infer, else 'other'. */
export function parseCategory(title = '', description = '') {
  if (FOOD_RE.test(title)) return 'food'
  return inferCategory(title, description) || 'other'
}

/** is_fundraiser facet — most public Kiwanis events are fundraisers. */
export function parseIsFundraiser(title = '', description = '') {
  return FUNDRAISER_RE.test(`${title} ${description}`) || undefined
}

// Cities we can recognise inside a free-text title (Summit + neighbours), so
// classifySummitLocation() gets a real name. Longest-first so "cuyahoga falls"
// wins over a stray "falls".
const KNOWN_CITY_RE = new RegExp(
  '\\b(' + [...SUMMIT_COUNTY_CITIES, ...NOT_SUMMIT_COUNTY_CITIES]
    .sort((a, b) => b.length - a.length)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') + ')\\b',
  'i',
)

/** Pull a recognizable city out of a title, or null if none is named. */
export function extractCityFromTitle(title = '') {
  const m = String(title).match(KNOWN_CITY_RE)
  return m ? m[1].toLowerCase() : null
}

/**
 * MEC emits the intended Eastern wall-clock as the UTC components of a
 * mislabelled instant (see QUIRK 1). Convert a startDate/endDate string into
 * an Eastern-anchored ISO string. Returns null on unparseable input.
 */
export function mecDateToIso(raw) {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return easternToIso(`${yyyy}-${mm}-${dd}`, `${hh}:${mi}`)
}

/** Stable per-occurrence source_id — MEC's numeric event id, else the slug. */
export function buildSourceId(ev) {
  if (ev.eventId) return String(ev.eventId)
  const slug = String(ev.url || '').replace(/\/+$/, '').split('/').pop()
  return slug || null
}

/**
 * Parse one MEC month-load `html` string into raw event objects. Each event is
 * a JSON-LD <script> immediately followed by its <article>; we pair them and
 * read dates from the JSON-LD, title/id/url from the <h3>.
 */
export function parseEvents(html = '') {
  if (!html || typeof html !== 'string') return []
  const out = []
  const pairRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>\s*<article\b([\s\S]*?)<\/article>/gi
  let m
  while ((m = pairRe.exec(html)) !== null) {
    const ldRaw = m[1].trim()
    const article = m[2]
    let ld
    try { ld = JSON.parse(ldRaw) } catch { continue }
    if (!ld || (ld['@type'] !== 'Event' && !(Array.isArray(ld['@type']) && ld['@type'].includes('Event')))) continue

    const titleM = article.match(/mec-event-title["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i)
    const attrs = titleM ? titleM[1] : ''
    const title = titleM ? stripHtml(titleM[2]) : ''
    const eventId = (attrs.match(/data-event-id=["'](\d+)["']/i) || [])[1] || null
    const url = (attrs.match(/href=["']([^"']+)["']/i) || [])[1] || null
    const descM = article.match(/mec-event-description["'][^>]*>([\s\S]*?)<\/div>/i)
    const description = descM ? stripHtml(descM[1]) : ''
    const imgM = article.match(/<img[^>]+src=["']([^"']+)["']/i)

    if (!title) continue
    out.push({
      eventId,
      title,
      url,
      description: description || null,
      startRaw: ld.startDate || null,
      endRaw: ld.endDate || null,
      image: imgM ? imgM[1] : null,
    })
  }
  return out
}

// ── Fetch ───────────────────────────────────────────────────────────────────

/** Current year/month in America/New_York (anchor, never local Date). */
function easternYearMonth(offsetMonths = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  let year = get('year')
  let month = get('month') + offsetMonths // 1-based
  year += Math.floor((month - 1) / 12)
  month = ((month - 1) % 12) + 1
  return { year, month: String(month).padStart(2, '0') }
}

async function fetchMonth(year, month) {
  const body = new URLSearchParams()
  body.set('action', 'mec_list_load_month')
  body.set('mec_year', String(year))
  body.set('mec_month', String(month))
  body.set('atts[sk-options][list][style]', 'standard')

  const res = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  })
  if (!res.ok) throw new Error(`MEC ajax error ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const data = await res.json()
  return parseEvents(data.html || '')
}

/** Iterate a fixed forward window of months, deduping occurrences by id/slug. */
async function fetchAllEvents() {
  const byKey = new Map()
  console.log('\n🔍  Fetching Bath Richfield Kiwanis events via MEC admin-ajax…')
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const { year, month } = easternYearMonth(i)
    const events = await fetchMonth(year, month)
    console.log(`  ${year}-${month}: ${events.length} events on calendar`)
    for (const ev of events) {
      const key = buildSourceId(ev) || `${ev.title}|${ev.startRaw}`
      if (!byKey.has(key)) byKey.set(key, ev)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return [...byKey.values()]
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skippedInternal = 0, skippedPast = 0, skippedOther = 0
  const cutoff = Date.now() - 86400_000 // ~1 day grace on past events

  for (const ev of rawEvents) {
    try {
      if (!includeEvent(ev.title)) {
        skippedInternal++ // club-calendar default; logging every meeting drowns the log
        continue
      }

      const start_at = mecDateToIso(ev.startRaw)
      if (!start_at) { skippedOther++; continue }
      if (new Date(start_at).getTime() < cutoff) { skippedPast++; continue }
      const end_at = mecDateToIso(ev.endRaw)

      const category = parseCategory(ev.title, ev.description || '')
      const tags = [...new Set([
        'bath-richfield-kiwanis', 'kiwanis', 'community',
        parseIsFundraiser(ev.title, ev.description || '') ? 'fundraiser' : null,
        FOOD_RE.test(ev.title) ? 'food' : null,
      ].filter(Boolean))]

      const row = {
        title:           ev.title,
        description:     ev.description || null,
        start_at,
        end_at,
        category,
        is_fundraiser:   parseIsFundraiser(ev.title, ev.description || ''),
        tags,
        price_min:       null, // MEC default price "0" is meaningless — never assume free
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       ev.image || null,
        ticket_url:      ev.url || null,
        source_url:      ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          'published',
        needs_review:    false,
        featured:        false,
      }
      if (!row.source_id) { skippedOther++; continue }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
        skippedOther++
      } else {
        await linkEventOrganization(upserted.id, organizerId)
        console.log(`  ✓ "${row.title}" — ${start_at} [${category}${row.is_fundraiser ? ', fundraiser' : ''}]`)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}": ${err.message}`)
      skippedOther++
    }
  }
  return { inserted, skippedInternal, skippedPast, skippedOther }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🥞  Starting Bath Richfield Kiwanis ingestion…')
  const start = Date.now()
  try {
    await preloadSummitCountyBoundary() // in case a title ever carries coords-bearing geo

    const organizerId = await ensureOrganization(ORG_NAME, ORG_DETAILS)

    const rawEvents = await fetchAllEvents()
    console.log(`\n📥  Processing ${rawEvents.length} distinct calendar entries (allowlist filter)…`)
    const { inserted, skippedInternal, skippedPast, skippedOther } =
      await processEvents(rawEvents, organizerId)

    const skipped = skippedInternal + skippedPast + skippedOther
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ` +
      `${skipped} skipped (${skippedInternal} internal, ${skippedPast} past, ${skippedOther} other).`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
