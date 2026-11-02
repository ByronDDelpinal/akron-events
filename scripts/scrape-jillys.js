/**
 * scrape-jillys.js
 *
 * Fetches upcoming events from Jilly's Music Room (jillysmusicroom.com).
 *
 * Strategy:
 *   1. POST to EventON's `the_ajax_hook` AJAX endpoint with a 6-month window.
 *      The response is JSON with each event's UTC timestamps and post ID.
 *   2. Batch-fetch full event data (content, image, taxonomies) from the WP
 *      REST API using the `include` parameter — one request per 50-ID chunk.
 *   3. Merge both datasets by post ID and upsert to Supabase.
 *   4. Retire rows the calendar no longer lists — but ONLY after WordPress
 *      itself confirms the post is gone (per-ID REST 404) or unpublished
 *      (401). See "Retirement" below.
 *
 * Why two sources?
 *   EventON stores event dates in custom meta fields that the WP REST API does
 *   not expose publicly. The EventON AJAX endpoint provides correct UTC Unix
 *   timestamps. The WP REST API provides everything else (content, images, tags).
 *
 * Usage:
 *   node scripts/scrape-jillys.js
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
  fetchSchemaDescription,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  hasStatusOverride,
} from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'

const AJAX_URL   = 'https://jillysmusicroom.com/wp-admin/admin-ajax.php'
const REST_BASE  = 'https://jillysmusicroom.com/wp-json/wp/v2/ajde_events'
const DAYS_AHEAD = 180
const BATCH_SIZE = 50   // WP REST API include= batch size

// Jilly's books live music most nights; an empty EventON calendar has never
// been a legitimate state for this source. Flip to `true` (and say why) only if
// the room actually goes dark for a season — same explicit-true opt-out
// convention as `allowEmptyFeed` in lib/ics.js.
const ALLOW_EMPTY_CALENDAR = false

// ── Helpers ───────────────────────────────────────────────────────────────
// stripHtml imported from normalize.js — handles all named + numeric HTML entities

/** Extract first ticket/purchase URL from HTML content */
function extractTicketUrl(html = '', permalink = '') {
  const ticketPatterns = [
    /href="(https?:\/\/(?:www\.)?(?:tickpick|eventbrite|ticketmaster|axs|dice\.fm|bandsintown)[^"]+)"/i,
    /href="([^"]+)"\s[^>]*>\s*(?:BUY\s+)?TICKET/i,
    /href="([^"]+)"\s[^>]*>\s*GET\s+TICKET/i,
  ]
  for (const re of ticketPatterns) {
    const m = html.match(re)
    if (m) return m[1]
  }
  return permalink || null
}

/** Map EventON taxonomy slugs (from class_list) → our category enum */
function parseCategory(classList = []) {
  const classes = classList.join(' ').toLowerCase()
  if (classes.includes('event_type-music')) return 'music'
  if (classes.includes('event_type-food'))  return 'food'
  if (classes.includes('event_type-class') || classes.includes('event_type-workshop')) return 'learning'
  if (classes.includes('event_type-comedy')) return 'comedy'
  return 'music'  // Jilly's is primarily a live music venue
}

/**
 * Detect closure notices that Jilly's publishes as EventON posts
 * ("CLOSED FOR PRIVATE EVENT", "NO BRUNCH SERVICE", "BRUNCH SUSPENDED", ...).
 * These are venue announcements, not events, and must not be ingested.
 * Anchored so titles that merely mention "closed"/"closing" elsewhere
 * (e.g. "OPEN FOR BRUNCH | CLOSING AT 3PM") are NOT treated as closures.
 */
export function isClosureTitle(title) {
  if (typeof title !== 'string') return false
  const t = title.trim()
  if (!t) return false
  return /^(?:closed\b|no\s+brunch\b|private\s+brunch\b)|brunch\s+suspended/i.test(t)
}

/** Extract human-readable tags from WP taxonomy term objects */
function parseTags(termArrays = []) {
  const tags = []
  for (const termList of termArrays) {
    for (const term of termList) {
      if (term.name) tags.push(term.name.toLowerCase())
    }
  }
  tags.push('live music', "jilly's")
  return [...new Set(tags)]
}

/** Sleep helper for rate limiting */
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureJillysVenue() {
  return ensureVenue("Jilly's Music Room", {
    address:       '111 N Main St',
    city:          'Akron',
    state:         'OH',
    zip:           '44308',
    lat:           41.08815,
    lng:           -81.51526,
    parking_type:  'street',
    parking_notes: 'Street parking on N Main St and surrounding blocks. Canal Park garage nearby.',
    website:       'https://jillysmusicroom.com',
    description:   "Akron's premier live music venue in the heart of downtown, featuring jazz, blues, rock, and more.",
  })
}

async function ensureJillysOrganizer() {
  return ensureOrganization("Jilly's Music Room", {
    website:     'https://jillysmusicroom.com',
    description: "Akron's downtown live music venue hosting jazz, blues, Americana, tribute acts, and more.",
  })
}

// ── Step 1: Fetch event IDs + timestamps via EventON AJAX ─────────────────

async function fetchEventonEvents() {
  const now        = new Date()
  const todayUnix  = Math.floor(Date.now() / 1000)
  const endUnix    = todayUnix + DAYS_AHEAD * 86400

  const params = new URLSearchParams({
    action:                              'the_ajax_hook',
    ajaxtype:                            'switchmonth',
    direction:                           'next',
    'shortcode[fixed_month]':            String(now.getMonth() + 1),  // 1-indexed
    'shortcode[fixed_year]':             String(now.getFullYear()),
    'shortcode[fixed_day]':              String(now.getDate()),
    'shortcode[event_count]':            '200',
    'shortcode[cal_id]':                 'MAIN',
    'shortcode[cal_init_nonajax]':       'no',
    'shortcode[hide_past]':              'no',
    'shortcode[event_past_future]':      'future',
    'shortcode[number_of_months]':       String(Math.ceil(DAYS_AHEAD / 30)),
    'shortcode[focus_start_date_range]': String(todayUnix),
    'shortcode[focus_end_date_range]':   String(endUnix),
    'shortcode[sort_by]':                'sort_date',
    'shortcode[_cver]':                  '4.0.6',
  })

  console.log(`\n🔍  Fetching Jilly's events via EventON AJAX…`)

  const res = await fetchWithRetry(AJAX_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) throw new Error(`EventON AJAX error ${res.status}: ${await res.text()}`)

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`EventON AJAX returned non-JSON: ${text.substring(0, 200)}`)
  }

  if (data.status !== 'GOOD' && !Array.isArray(data.json)) {
    throw new Error(`EventON AJAX bad status: ${JSON.stringify(data).substring(0, 200)}`)
  }

  const events = data.json ?? []
  console.log(`  EventON AJAX returned ${events.length} upcoming events`)
  return { events, ajaxStatus: data.status }
}

// ── Step 2: Batch-fetch full post data via WP REST API ────────────────────

async function fetchRestBatch(ids) {
  const url = `${REST_BASE}?include=${ids.join(',')}&per_page=${ids.length}&_embed=true`
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`WP REST API error ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchAllRestData(ids) {
  const chunks = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    chunks.push(ids.slice(i, i + BATCH_SIZE))
  }

  console.log(`\n📦  Fetching full post data in ${chunks.length} REST API batch(es)…`)

  const allPosts = []
  for (let i = 0; i < chunks.length; i++) {
    const posts = await fetchRestBatch(chunks[i])
    allPosts.push(...posts)
    console.log(`  Batch ${i + 1}/${chunks.length}: ${posts.length} posts`)
    if (i < chunks.length - 1) await sleep(300)
  }

  // Index by ID for fast lookup
  const byId = new Map()
  for (const post of allPosts) byId.set(post.id, post)
  return byId
}

// ── Step 3: Process and upsert ────────────────────────────────────────────

async function processEvents(ajaxEvents, restById, venueId, organizerId) {
  let inserted = 0, skipped = 0, closureSkipped = 0

  for (const ev of ajaxEvents) {
    try {
      const postId  = ev.ID
      const restPost = restById.get(postId)

      // Compute UTC timestamps
      // event_start_unix_utc is already UTC
      // event_end_unix is local time; tzOffset = start_utc - start_local
      const tzOffsetSec  = ev.event_start_unix_utc - ev.event_start_unix
      const startAt      = new Date(ev.event_start_unix_utc * 1000).toISOString()
      const endAt        = ev.event_end_unix
        ? new Date((ev.event_end_unix + tzOffsetSec) * 1000).toISOString()
        : null

      // Pull enriched data from REST response (if available)
      let title       = stripHtml(ev.event_title ?? '')
      let description = null
      let imageUrl    = null
      let ticketUrl   = null
      let classList   = []
      let termArrays  = []

      if (restPost) {
        title       = stripHtml(restPost.title?.rendered ?? ev.event_title)
        description = stripHtml(restPost.content?.rendered ?? '') || null
        classList   = restPost.class_list ?? []
        ticketUrl   = extractTicketUrl(restPost.content?.rendered ?? '', restPost.link)

        // Featured media
        const media = restPost._embedded?.['wp:featuredmedia']?.[0]
        imageUrl = media?.source_url ?? null

        // Taxonomy terms (skip first array which is post_tags, usually empty)
        const wpTerms = restPost._embedded?.['wp:term'] ?? []
        termArrays = wpTerms.slice(1)  // skip post_tag, keep event_type + event_type_2
      }

      // Closure notices are announcements, not events. Skip here — before
      // the fetchSchemaDescription fallback — so skips cost no network.
      if (isClosureTitle(title)) {
        console.log(`  \u23ed  Skipping closure notice: "${title}" (post ${postId})`)
        closureSkipped++
        continue
      }

      // When the WordPress post body is empty (Jilly's frequently
      // ships shows with only a poster image and a TicketWeb link),
      // pull the artist blurb out of the venue's own permalink page —
      // it embeds Schema.org Event JSON-LD via the calendar plugin.
      if (!description) {
        const detailUrl = restPost?.link || ticketUrl
        if (detailUrl) {
          description = (await fetchSchemaDescription(detailUrl)) || null
        }
      }

      const category = parseCategory(classList)
      const tags     = parseTags(termArrays)

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category,
        tags,
        price_min:       null, // Jilly's often has free or door-price shows; null = unknown
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          'jillys_music_room',
        source_id:       String(postId),
        status:          'published',
        // NEVER machine-set `featured`. It's a human-only editorial call made
        // in the admin UI; a source flagging its own event says nothing about
        // whether it deserves the digest hero slot.
        // (Was `ev.featured === true || ev.featured === 'yes'`.)
        featured:        false,
      }

      if (!row.start_at) { skipped++; continue }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing event ID ${ev.ID}:`, err.message)
      skipped++
    }
  }

  return { inserted, skipped: skipped + closureSkipped }
}

/**
 * Decide how a zero-event EventON response should be reported. Pure.
 *
 * WHY (2026-09-23): this scraper logged an empty AJAX result through
 * `logUpsertResult`, which defaults to `status='success'`, so a night where
 * EventON's shortcode/params drifted and returned nothing was
 * indistinguishable in scraper_runs from a healthy night, and nothing alerted.
 * A silently empty calendar is a broken calendar until a maintainer says
 * otherwise, so the default is `error`, and EventON's own `status` field rides
 * along in the message so the cause is visible without re-running.
 * `allowEmptyFeed` is the explicit-true opt-out, mirroring `emptyFeedOutcome()`
 * in lib/ics.js.
 *
 * `events_found` stays 0 either way, so scraper_health's consecutive-zero
 * streak still answers "is this source producing"; `status` only answers "did
 * the pipeline work".
 *
 * @param {object} [config]
 * @param {boolean} [config.allowEmptyFeed] calendar is legitimately empty
 * @param {string}  [config.ajaxStatus]     `status` field of the AJAX response
 * @returns {{status: 'success'|'error', errorMessage: string|null, reason: string}}
 */
export function emptyCalendarOutcome({ allowEmptyFeed, ajaxStatus } = {}) {
  if (allowEmptyFeed === true) {
    return {
      status: 'success',
      errorMessage: null,
      reason: 'EventON calendar returned cleanly and is empty — expected for this source, recording 0 events',
    }
  }
  const shown = (typeof ajaxStatus === 'string' && ajaxStatus.trim() !== '') || Number.isFinite(ajaxStatus)
    ? String(ajaxStatus).trim()
    : 'missing'
  const msg = `EventON AJAX returned 0 upcoming events (status=${shown})`
  return { status: 'error', errorMessage: msg, reason: msg }
}

// ── Step 4: Retirement of posts Jilly's removed ───────────────────────────
//
// WHY (2026-11-02): Jill Bacon Madden cancelled "Swing Night with Sam Ross
// Jazz" (post 4614) a month before the show and deleted it from her site. This
// scraper is upsert-only, so our row simply stopped being touched and rode
// into the Friday digest. The venue had to tell us.
//
// A row merely vanishing from the AJAX list is NOT treated as a cancellation —
// a partial fetch or shortcode drift looks identical (the ohio-festivals
// precedent and the guides copy both say so). What makes retirement safe here
// is that WordPress answers a per-ID REST GET authoritatively:
//
//   GET /wp-json/wp/v2/ajde_events/{id}
//     200                        → still published; leave the row alone
//     404 rest_post_invalid_id   → deleted/trashed            → retire
//     401 rest_forbidden         → exists but draft/private   → retire
//     anything else / network    → unknown; leave the row alone
//
// The batch `?include=` fetch in step 2 silently drops missing ids, so only the
// per-ID probe can see a removal. Probes run only for rows absent from the AJAX
// result, so steady state is 0–3 extra GETs a night.
//
// Guards mirror planRetirement in scrape-city-of-cuyahoga-falls.js: a floor on
// the AJAX count (parse broke → retire nothing), a ceiling on the fraction
// retired per run (the run changed, not the venue), rows pinned by a human via
// manual_overrides.status are never touched, and nothing is ever deleted —
// status flips to 'cancelled' with a stamped override so it is auditable and a
// later re-scrape cannot silently re-publish it.

// Below this many AJAX events the calendar read is assumed broken. Jilly's
// lists 40–50 events in a 180-day window; 10 is well under that floor.
export const RETIREMENT_MIN_FOUND = 10

// Retire at most this fraction of retire-eligible in-window rows per run.
export const RETIREMENT_MAX_FRACTION = 0.25

// Explicit bound on the retirement query so PostgREST's implicit 1000-row page
// can never silently understate the ceiling's denominator.
export const RETIREMENT_QUERY_LIMIT = 2000

export const RETIREMENT_STAMP_BY = 'scrape-jillys:retirement'

/**
 * Classify a per-ID WP REST response. Pure.
 *
 * @param {number} status  HTTP status
 * @param {object|null} body  parsed JSON body (may be null)
 * @returns {'live'|'gone'|'unpublished'|'unknown'}
 */
export function classifyRestProbe(status, body = null) {
  if (status === 200) return 'live'
  if (status === 404 && body?.code === 'rest_post_invalid_id') return 'gone'
  if (status === 401 && body?.code === 'rest_forbidden') return 'unpublished'
  return 'unknown'
}

/** Retirement reason stamped into manual_overrides, keyed by probe verdict. */
export function retirementReason(verdict, probedAt) {
  const day = String(probedAt).slice(0, 10)
  return verdict === 'gone'
    ? `post deleted on jillysmusicroom.com (WP REST 404 rest_post_invalid_id on ${day})`
    : `post unpublished on jillysmusicroom.com (WP REST 401 rest_forbidden on ${day})`
}

/**
 * Which in-window rows need a probe: published, not status-pinned, and absent
 * from this run's AJAX result. Pure, so the caller can probe only these.
 */
export function retirementCandidates({ rows = [], seenSourceIds = new Set() } = {}) {
  return rows.filter(r => r.status === 'published' && !hasStatusOverride(r) && !seenSourceIds.has(r.source_id))
}

/**
 * Decide which rows to retire. Pure — the guards are the point.
 *
 * @param rows           in-window rows for this source, ALL statuses
 * @param seenSourceIds  source_ids present in this run's AJAX result
 * @param ajaxCount      number of events the AJAX call returned
 * @param verdicts       Map<source_id, 'live'|'gone'|'unpublished'|'unknown'>
 *                       from classifyRestProbe; a candidate with no entry is
 *                       treated as 'unknown'
 */
export function planRetirement({ rows = [], seenSourceIds = new Set(), ajaxCount = 0, verdicts = new Map() } = {}) {
  const eligible   = rows.filter(r => r.status === 'published' && !hasStatusOverride(r))
  const pinned     = rows.filter(r => r.status === 'published' && hasStatusOverride(r))
  const candidates = retirementCandidates({ rows, seenSourceIds })
  const base = {
    retire: [], leftLive: [], leftUnknown: [],
    examined: rows.length, eligible: eligible.length, candidates: candidates.length,
    protectedCount: pinned.length, fraction: 0, skipped: null, reason: null,
  }

  if (ajaxCount < RETIREMENT_MIN_FOUND) {
    return { ...base, skipped: 'below-floor',
      reason: `EventON returned only ${ajaxCount} event(s) (floor ${RETIREMENT_MIN_FOUND}) — the calendar read looks broken, retiring nothing` }
  }

  const retire = [], leftLive = [], leftUnknown = []
  for (const row of candidates) {
    const v = verdicts.get(row.source_id) ?? 'unknown'
    if (v === 'gone' || v === 'unpublished') retire.push({ row, verdict: v })
    else if (v === 'live') leftLive.push(row)
    else leftUnknown.push(row)
  }

  // Denominator is the retire-ELIGIBLE set, not every in-window row, so
  // already-cancelled closure notices cannot dilute the measurement.
  const fraction = eligible.length ? retire.length / eligible.length : 0
  if (fraction > RETIREMENT_MAX_FRACTION) {
    return { ...base, leftLive, leftUnknown, fraction, skipped: 'above-ceiling',
      reason: `${retire.length}/${eligible.length} retire-eligible rows (${(fraction * 100).toFixed(0)}%) confirmed gone, ` +
        `over the ${(RETIREMENT_MAX_FRACTION * 100).toFixed(0)}% ceiling — the run, not the venue, probably changed. Investigate before retiring.` }
  }

  return { ...base, retire, leftLive, leftUnknown, fraction }
}

/**
 * Ask WordPress whether one post still exists. Never throws: any transport
 * failure or unexpected shape is 'unknown', which the planner leaves alone.
 *
 * @param {string|number} postId
 * @param {object} [opts]  `fetchImpl` is forwarded to fetchWithRetry for tests
 */
export async function probeWpPost(postId, { fetchImpl } = {}) {
  try {
    const res = await fetchWithRetry(`${REST_BASE}/${postId}`, {
      headers: { Accept: 'application/json' },
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    let body = null
    try { body = await res.json() } catch { body = null }
    return classifyRestProbe(res.status, body)
  } catch {
    return 'unknown'
  }
}

/**
 * Fetch in-window rows, probe the ones the AJAX result dropped, and retire the
 * confirmed-removed ones. Returns the number retired. NEVER deletes.
 */
async function retireRemovedPosts({ seenSourceIds, ajaxCount }) {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')

  const from = new Date()
  const to   = new Date(Date.now() + DAYS_AHEAD * 86400 * 1000)
  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('id, title, source_id, status, start_at, manual_overrides')
    .eq('source', 'jillys_music_room')
    .gte('start_at', from.toISOString())
    .lte('start_at', to.toISOString())
    .limit(RETIREMENT_QUERY_LIMIT)
  if (error) {
    console.warn(`  ⚠ Retirement query failed: ${error.message} — retiring nothing.`)
    return 0
  }
  if ((rows?.length ?? 0) >= RETIREMENT_QUERY_LIMIT) {
    console.warn(`  ⚠ Retirement query hit the ${RETIREMENT_QUERY_LIMIT}-row bound — result may be truncated. Retiring nothing.`)
    return 0
  }

  const candidates = retirementCandidates({ rows: rows ?? [], seenSourceIds })
  const verdicts = new Map()
  if (candidates.length) {
    console.log(`\n🔎  ${candidates.length} published row(s) missing from the EventON result — asking WordPress…`)
    for (const row of candidates) {
      verdicts.set(row.source_id, await probeWpPost(row.source_id))
      await sleep(200)
    }
  }

  const plan = planRetirement({ rows: rows ?? [], seenSourceIds, ajaxCount, verdicts })
  if (plan.skipped) {
    console.warn(`  ⏭  Retirement SKIPPED (${plan.skipped}): ${plan.reason}`)
    return 0
  }
  for (const r of plan.leftLive)    console.log(`  ↩  still published on WordPress, kept: "${r.title}" (${r.source_id}) — EventON window/parse drift?`)
  for (const r of plan.leftUnknown) console.warn(`  ❓ probe inconclusive, kept: "${r.title}" (${r.source_id})`)
  if (plan.protectedCount) console.log(`  🛡  ${plan.protectedCount} row(s) skipped: manual_overrides.status is a human decision`)
  if (!plan.retire.length) return 0

  const at = new Date().toISOString()
  let retired = 0
  for (const { row, verdict } of plan.retire) {
    const manual_overrides = {
      ...(row.manual_overrides ?? {}),
      status: { at, by: RETIREMENT_STAMP_BY, reason: retirementReason(verdict, at) },
    }
    const { error: upErr } = await supabaseAdmin
      .from('events')
      .update({ status: 'cancelled', manual_overrides })
      .eq('id', row.id)
      .eq('status', 'published')   // never race a human who just changed it
    if (upErr) {
      console.warn(`  ⚠ Retirement failed for ${row.source_id}: ${upErr.message}`)
      continue
    }
    console.log(`  🗄  retired (${verdict}): "${row.title}" (${row.source_id})`)
    retired++
  }
  return retired
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Starting Jilly's Music Room ingestion…")
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureJillysVenue(), ensureJillysOrganizer()])

    // Step 1: EventON AJAX — get upcoming event IDs and timestamps
    const { events: ajaxEvents, ajaxStatus } = await fetchEventonEvents()
    if (!ajaxEvents.length) {
      const outcome = emptyCalendarOutcome({ allowEmptyFeed: ALLOW_EMPTY_CALENDAR, ajaxStatus })
      await logUpsertResult('jillys_music_room', 0, 0, 0, {
        status:       outcome.status,
        errorMessage: outcome.errorMessage,
        eventsFound:  0,
        durationMs:   Date.now() - start,
      })
      console.warn(`  ⚠ ${outcome.reason} — exiting 0 so the next scheduled run still tries.`)
      process.exit(0)
    }

    // Step 2: WP REST API — get content, images, taxonomies
    const ids       = [...new Set(ajaxEvents.map(e => e.ID))]
    const restById  = await fetchAllRestData(ids)

    // Step 3: Merge and upsert
    console.log(`\n📥  Processing ${ajaxEvents.length} events…`)
    const { inserted, skipped } = await processEvents(ajaxEvents, restById, venueId, organizerId)

    // Step 4: retire posts the venue removed (see "Retirement" above). Runs
    // after the upsert so every row EventON still lists has a fresh touch.
    const retired = await retireRemovedPosts({ seenSourceIds: new Set(ids.map(String)), ajaxCount: ajaxEvents.length })
    if (retired) console.log(`  🗄  ${retired} row(s) retired (status → cancelled)`)

    await logUpsertResult('jillys_music_room', inserted, 0, skipped, {
      eventsFound: ajaxEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('jillys_music_room', err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-jillys.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
