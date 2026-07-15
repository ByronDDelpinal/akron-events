/**
 * scrape-akron-ymca.js
 *
 * Scrapes upcoming public events from the Akron Area YMCA — a multi-branch
 * nonprofit whose branches span Summit County (Akron, Cuyahoga Falls, Green…)
 * and just over its edges (a Wadsworth branch in Medina County). Output is
 * modest: a handful of signature fundraisers and community races per season
 * (triathlons, charity golf outings, wine-and-craft-brew benefits, tribute 5Ks).
 *
 * Platform: Drupal 11 (OpenY distribution, Commerce 3). The site exposes a
 * fully OPEN JSON:API — no auth, no anti-bot challenge — at
 *   /jsonapi/node/event
 * so we skip HTML scraping entirely and read structured nodes. Each event node
 * carries:
 *   - `field_event_dates`  → { value, end_value } as OFFSET-AWARE ISO strings
 *     already anchored to Eastern (e.g. "2026-08-02T16:00:00-04:00"). Because
 *     the offset is embedded, we normalise straight to UTC with `new Date()`
 *     rather than re-anchoring through easternToIso (which is for NAIVE local
 *     date+time). This sidesteps all DST guessing — the feed already did it.
 *   - `field_event_location` → a (possibly empty, possibly multi) reference to
 *     `node--branch` nodes, each with a real `field_location_address` and
 *     `field_location_coordinates` (lat/lng). We gate each event on its branch
 *     coordinates via classifySummitLocation (strict Summit-County mandate):
 *     the Wadsworth branch (Medina County) lands 'out' and is skipped; branches
 *     in Akron/Cuyahoga Falls/Green land 'in' and publish. An event with NO
 *     branch reference (e.g. an offsite golf outing) has unknown locality, so it
 *     is ingested as pending_review for an admin to place — never silently
 *     dropped, never auto-published.
 *   - `field_event_image` → media--image → field_media_image → file, whose
 *     `uri.url` is a site-relative path we absolutize against the base domain.
 *   - `field_event_description` → full_html body (the event's real write-up).
 *
 * Categories: OpenY events carry no taxonomy, and generic text inference
 * mis-reads them ("P.S. I Love You" 5K → 'music'; triathlons → 'other'), so we
 * map content explicitly — races/triathlons/runs/walks/charity golf → 'fitness',
 * wine/brew benefits → 'food' — and fall back to inferCategory only otherwise.
 * Facet flags (is_fundraiser, is_family) are keyword-derived from title+body.
 *
 * Prices: the feed has no structured price field, so price_min/price_max stay
 * null (never assumed free) even when the body mentions a registration fee.
 *
 * Usage:
 *   node scripts/scrape-akron-ymca.js
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
  htmlToText,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  inferCategory,
} from './lib/normalize.js'
import {
  preloadSummitCountyBoundary,
  classifySummitLocation,
} from './lib/summit-county.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'akron_ymca'
const BASE_DOMAIN = 'https://www.akronymca.org'
const SOURCE_URL  = `${BASE_DOMAIN}/events`

// JSON:API collection for the `event` content type, with the branch + image
// references sideloaded. We filter to published nodes whose end date is still
// in the future and sort ascending by start.
const API_URL = `${BASE_DOMAIN}/jsonapi/node/event`

// Roughly a six-month horizon; a signature-event calendar this small never
// nears the limit, but it keeps a runaway "annual event" a year out from
// publishing prematurely.
const HORIZON_DAYS = 200

const USER_AGENT =
  'Mozilla/5.0 (compatible; AkronEventsBot/1.0; +https://akronpulse.com)'

// The organization behind every event.
const ORGANIZATION = {
  name:        'Akron Area YMCA',
  website:     BASE_DOMAIN,
  description:
    'Multi-branch nonprofit serving Greater Akron and Summit County with ' +
    'wellness programs plus community events, races, and fundraisers.',
}

// ════════════════════════════════════════════════════════════════════════════
// DATE / TIME
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert one of the feed's offset-aware ISO timestamps
 * ("2026-08-02T16:00:00-04:00") into a UTC ISO string. Returns null on empty
 * or unparseable input. The embedded Eastern offset makes this exact — we do
 * NOT route through easternToIso, which is for naive (offset-less) input.
 */
export function isoFromEventDate(raw) {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

// ════════════════════════════════════════════════════════════════════════════
// CATEGORY / FACET MAPPING
// ════════════════════════════════════════════════════════════════════════════

// Races, endurance events, and charity golf → the 'fitness' content axis. The
// YMCA's marquee events are overwhelmingly athletic; generic text inference
// misses "triathlon"/"dry tri" and mis-tags a "5K … Run or Walk" as music.
const FITNESS_RE =
  /\b(triathlon|dry tri|y tri|\btri\b|5k|10k|fun run|road race|run or walk|run\/walk|walk\/run|half[- ]?marathon|marathon|golf outing|golf scramble|golf classic|golf tournament)\b/i

// Wine / craft-beer tasting benefits → the 'food' (food & drink) axis.
const FOOD_RE =
  /\b(wine|craft brew|craft beer|beer tasting|wine tasting|\bbrews?\b|grape falls)\b/i

/**
 * Resolve the content category (single badge). Explicit athletic/food keywords
 * win over inferCategory, which is unreliable on these untagged nodes; anything
 * unmatched falls back to inference, then 'other'.
 */
export function parseCategory(title = '', description = '') {
  const text = `${title} ${description}`
  if (FITNESS_RE.test(text)) return 'fitness'
  if (FOOD_RE.test(text))    return 'food'
  const inferred = inferCategory(title, description)
  return inferred && inferred !== 'other' ? inferred : 'other'
}

// Fundraiser signals. Charity golf outings and "benefitting … Annual Campaign"
// language are the YMCA's tells; a bare event name alone never trips this.
const FUNDRAISER_RE =
  /\b(fundrais\w*|benefit(?:t?ing|s)?|annual campaign|proceeds|\bcharity\b|\bgala\b|golf outing|golf scramble|golf classic|silent auction)\b/i

/** is_fundraiser facet — undefined (not false) when no signal, so it's omitted. */
export function parseIsFundraiser(title = '', description = '') {
  return FUNDRAISER_RE.test(`${title} ${description}`) || undefined
}

// Family signal, noun-phrase gated so an adults' "Fore the Kids Golf Outing"
// or a "Family YMCA" branch name never flips it — only genuine youth/kids
// programming does.
const FAMILY_RE =
  /\b(youth triathlon|youth tri|kids? camp|day camp|summer camp|children'?s|family fun (?:day|night|fest)|storytime|toddler)\b/i

/** is_family facet — explicit boolean so text inference can't override it. */
export function isFamilyEvent(title = '', description = '') {
  return FAMILY_RE.test(`${title} ${description}`)
}

// ════════════════════════════════════════════════════════════════════════════
// JSON:API PARSE (pure — exported for tests)
// ════════════════════════════════════════════════════════════════════════════

/** Absolutize a site-relative path against the base domain. */
function absoluteUrl(path) {
  if (!path) return null
  if (/^https?:/i.test(path)) return path
  return BASE_DOMAIN + (path.startsWith('/') ? '' : '/') + path
}

/**
 * Build an index of a JSON:API `included` array keyed by "type:id" so
 * relationships can be resolved in O(1).
 */
export function indexIncluded(included = []) {
  const map = new Map()
  for (const item of included) map.set(`${item.type}:${item.id}`, item)
  return map
}

/** Resolve the image URL for an event node from the sideloaded media/file. */
function resolveImage(node, included) {
  const ref = node.relationships?.field_event_image?.data
  if (!ref) return null
  const media = included.get(`${ref.type}:${ref.id}`)
  const fileRef = media?.relationships?.field_media_image?.data
  if (!fileRef) return null
  const file = included.get(`${fileRef.type}:${fileRef.id}`)
  const url = file?.attributes?.uri?.url
  return url ? absoluteUrl(url) : null
}

/**
 * Resolve the list of branch locations referenced by an event node into
 * { name, address, city, state, zip, lat, lng } records (dropping any branch
 * that failed to sideload). Empty when the event carries no branch reference.
 */
export function resolveBranches(node, included) {
  let refs = node.relationships?.field_event_location?.data ?? []
  if (!Array.isArray(refs)) refs = refs ? [refs] : []
  const out = []
  for (const ref of refs) {
    const branch = included.get(`${ref.type}:${ref.id}`)
    if (!branch) continue
    const a = branch.attributes ?? {}
    const addr = a.field_location_address ?? {}
    const coords = a.field_location_coordinates ?? {}
    out.push({
      name:  a.title ?? null,
      address: addr.address_line1 ?? null,
      city:  (addr.locality ?? '').trim() || null,
      state: addr.administrative_area ?? null,
      zip:   addr.postal_code ?? null,
      lat:   coords.lat ?? null,
      lng:   coords.lng ?? null,
    })
  }
  return out
}

/**
 * Choose the locality verdict + venue branch for an event from its branches.
 * The strict Summit mandate drives the resolution:
 *   - any branch 'in'      → 'in',      venue = first in-county branch
 *   - else any 'unknown'   → 'unknown', venue = first branch (if any)
 *   - else (all 'out')     → 'out',     venue = null (event is skipped)
 * With NO branches at all we return 'unknown' + null venue (admin will place).
 */
export function resolveLocality(branches = []) {
  if (!branches.length) return { locality: 'unknown', branch: null }
  const verdicts = branches.map((b) => ({
    b,
    v: classifySummitLocation({ lat: b.lat, lng: b.lng, city: b.city }),
  }))
  const inOne = verdicts.find((x) => x.v === 'in')
  if (inOne) return { locality: 'in', branch: inOne.b }
  const unknownOne = verdicts.find((x) => x.v === 'unknown')
  if (unknownOne) return { locality: 'unknown', branch: unknownOne.b }
  return { locality: 'out', branch: null }
}

/**
 * Flatten one JSON:API event node (+ the included index) into a raw record:
 * { sourceId, title, alias, url, startRaw, endRaw, description, imageUrl,
 *   branches }. Nodes missing a title or a start date come back null so the
 * caller can skip them.
 */
export function parseEventNode(node, included) {
  const a = node.attributes ?? {}
  const title = (a.title ?? '').trim()
  const dates = a.field_event_dates ?? {}
  if (!title || !dates.value) return null

  const alias = a.path?.alias ?? null
  const descHtml = a.field_event_description?.value ?? ''
  const description = htmlToText(descHtml).replace(/\s+/g, ' ').trim() || null

  return {
    sourceId:    String(a.drupal_internal__nid ?? node.id),
    title,
    alias,
    url:         alias ? absoluteUrl(alias) : SOURCE_URL,
    startRaw:    dates.value,
    endRaw:      dates.end_value ?? null,
    description,
    imageUrl:    resolveImage(node, included),
    branches:    resolveBranches(node, included),
  }
}

/** Parse a full JSON:API collection response into raw event records. */
export function parseCollection(payload) {
  if (!payload || !Array.isArray(payload.data)) return []
  const included = indexIncluded(payload.included ?? [])
  const out = []
  for (const node of payload.data) {
    const rec = parseEventNode(node, included)
    if (rec) out.push(rec)
  }
  return out
}

// ════════════════════════════════════════════════════════════════════════════
// FETCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fetch every upcoming published event node, following JSON:API `links.next`
 * pagination. Filters (published + end_value in the future) and the sort are
 * applied server-side; the include pulls branch + image resources inline.
 */
async function fetchAllEvents() {
  const todayEastern = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()) // "YYYY-MM-DD"

  const params = new URLSearchParams()
  params.set('filter[status]', '1')
  params.set('filter[future][condition][path]', 'field_event_dates.end_value')
  params.set('filter[future][condition][operator]', '>')
  params.set('filter[future][condition][value]', `${todayEastern}T00:00:00`)
  params.set('sort', 'field_event_dates.value')
  params.set('include', 'field_event_location,field_event_image,field_event_image.field_media_image')
  params.set('page[limit]', '50')

  let url = `${API_URL}?${params.toString()}`
  const records = []
  const seen = new Set()

  // Cap page walks defensively; a small calendar never needs more than one.
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.api+json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`JSON:API returned ${res.status} for ${url}`)
    const payload = await res.json()
    for (const rec of parseCollection(payload)) {
      if (seen.has(rec.sourceId)) continue
      seen.add(rec.sourceId)
      records.push(rec)
    }
    url = payload.links?.next?.href ?? null
  }

  return records
}

// ════════════════════════════════════════════════════════════════════════════
// VENUE / ORGANIZATION
// ════════════════════════════════════════════════════════════════════════════

async function ensureYmcaOrganization() {
  return ensureOrganization(ORGANIZATION.name, {
    website:     ORGANIZATION.website,
    description: ORGANIZATION.description,
  })
}

/** Ensure a venue row for a branch; returns its id (or null). */
async function ensureBranchVenue(branch) {
  if (!branch || !branch.name) return null
  return ensureVenue(branch.name, {
    address: branch.address ?? undefined,
    city:    branch.city ?? undefined,
    state:   branch.state ?? undefined,
    zip:     branch.zip ?? undefined,
    lat:     branch.lat ?? undefined,
    lng:     branch.lng ?? undefined,
  })
}

// ════════════════════════════════════════════════════════════════════════════
// PROCESS
// ════════════════════════════════════════════════════════════════════════════

async function processRecords(records, organizerId) {
  let inserted = 0, skipped = 0

  for (const rec of records) {
    try {
      const startAt = isoFromEventDate(rec.startRaw)
      if (!startAt) {
        console.warn(`  ⚠ Skipping "${rec.title}" — unparseable start: "${rec.startRaw}"`)
        skipped++
        continue
      }
      const endAt = isoFromEventDate(rec.endRaw)

      // Skip events that ended more than a day ago, or start beyond the horizon.
      const refMs = (endAt ? new Date(endAt) : new Date(startAt)).getTime()
      if (refMs < Date.now() - 86_400_000) { skipped++; continue }
      if (new Date(startAt).getTime() > Date.now() + HORIZON_DAYS * 86_400_000) {
        skipped++
        continue
      }

      // Geography gate (strict Summit mandate).
      const { locality, branch } = resolveLocality(rec.branches)
      if (locality === 'out') {
        console.warn(`  ⤫ Skipping "${rec.title}" — outside Summit County (${rec.branches.map((b) => b.city).join(', ') || 'no branch'})`)
        skipped++
        continue
      }

      const venueId = await ensureBranchVenue(branch)

      const description = rec.description
      const category = parseCategory(rec.title, description ?? '')

      const row = {
        title:           rec.title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        categories:      [category],
        tags:            ['ymca'],
        is_family:       isFamilyEvent(rec.title, description ?? ''),
        is_fundraiser:   parseIsFundraiser(rec.title, description ?? ''),
        price_min:       null,
        price_max:       null,
        image_url:       rec.imageUrl,
        ticket_url:      rec.url,
        source:          SOURCE_KEY,
        source_id:       rec.sourceId,
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
      if (venueId) await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

      const flags = [
        locality === 'in' ? category : `${category}/review`,
        row.is_fundraiser ? 'fundraiser' : null,
        row.is_family ? 'family' : null,
      ].filter(Boolean).join(', ')
      console.log(`  ✓ "${row.title}" — ${startAt} [${flags}]`)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${rec.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ════════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('🚀  Starting Akron Area YMCA ingestion…')
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary()
    const organizerId = await ensureYmcaOrganization()

    console.log('🔍  Fetching JSON:API event nodes…')
    const records = await fetchAllEvents()
    console.log(`  Found ${records.length} upcoming event node(s)`)

    if (records.length === 0) {
      console.warn('  ⚠ No event nodes returned. If unexpected, verify ' +
        `${API_URL} still serves the OpenY 'event' content type.`)
    }

    console.log(`\n📥  Processing ${records.length} event(s)…`)
    const { inserted, skipped } = await processRecords(records, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: records.length,
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
