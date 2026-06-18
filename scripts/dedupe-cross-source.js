/**
 * dedupe-cross-source.js
 *
 * Find and delete events that are the same physical event represented by
 * multiple sources — typically aggregator (akron_life) republishing
 * something we already scrape directly (ticketmaster, eventbrite).
 *
 * Matching rule:
 *   Two events are "the same physical event" when they share ALL of
 *     • the same linked venue (event_venues.venue_id), AND
 *     • the same start_at timestamp (exact second match), AND
 *     • the same normalized title (lowercased, punctuation/whitespace folded)
 *
 *   The title check is essential: libraries and museums host many parallel
 *   programs at the same start time in different rooms — venue+time alone
 *   wildly over-matches. The forward fix in scrape-akron-life.js (filter
 *   by Evvnt's `sources` field) handles the common cross-source case
 *   proactively; this script cleans up what slipped through.
 *
 * For each duplicate group, the canonical entry is chosen by SOURCE_PRIORITY
 * (lower index = more authoritative). Non-canonical entries are deleted.
 * Junction rows cascade.
 *
 * Safety:
 *   • Default is dry-run — pass `--apply` to delete
 *   • Events whose `manual_overrides` is non-empty are NEVER deleted, even
 *     when not chosen as canonical (respects manual edits — Byron's policy)
 *   • Events with no linked venue are skipped (can't be matched reliably)
 *
 * Usage:
 *   node scripts/dedupe-cross-source.js          # dry run
 *   node scripts/dedupe-cross-source.js --apply  # do it
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { normalizeStreetAddress } from './lib/normalize.js'

const APPLY = process.argv.includes('--apply')

// Lower index = higher priority (kept as canonical).
// Direct primary-source scrapers first, then aggregators / republishers last.
//
// 2026-06-11: ticketmaster/eventbrite moved from the TOP to the aggregator
// block at the bottom — they are republishers, and having them first
// contradicted this comment and let an Eventbrite copy beat the first-party
// scraper on priority ties. (Data-quality tiers still outrank priority, so a
// first-party row with no image and no description can still lose — fix the
// scraper's data gap in that case, e.g. akron_art_museum's empty
// descriptions, rather than this list.)
const SOURCE_PRIORITY = [
  'akron_civic',
  'akronym',
  'akron_symphony',
  'akron_zoo',
  'akron_art_museum',
  'akron_childrens_museum',
  'akron_library',
  'akron_public_schools',
  'blu_jazz',
  'city_of_akron_lock3',     // first-party source for city programming
  'downtown_akron',
  'jillys',
  'leadership_akron',
  'missing_falls',
  'nightlight',
  'north_hill_cdc',
  'ohio_shakespeare',
  'painting_twist',
  'rubberducks',
  'stan_hywet',              // first-party venue calendar
  'summit_artspace',
  'summit_metro_parks',
  'torchbearers',
  'uakron_calendar',
  'weathervane',
]

// Aggregators / re-syndicators — always rank BELOW any first-party source, in
// this internal order. Kept separate from SOURCE_PRIORITY so that first-party
// venue scrapers we haven't explicitly ranked still beat an aggregator copy
// (the bug that let an Eventbrite "…at Crown Point" win canonical over Crown
// Point's own "…- Alex Bevan").
const AGGREGATOR_PRIORITY = ['ticketmaster', 'eventbrite', 'visit_akron_cvb', 'akron_life']

export function priority(source) {
  const i = SOURCE_PRIORITY.indexOf(source)
  if (i !== -1) return i                       // explicitly-ranked first-party
  const a = AGGREGATOR_PRIORITY.indexOf(source)
  if (a !== -1) return 1000 + a                // aggregators last, in their own order
  return 900                                   // unlisted first-party: before aggregators
}

function hasManualOverrides(ev) {
  return ev.manual_overrides && typeof ev.manual_overrides === 'object' &&
         Object.keys(ev.manual_overrides).length > 0
}

// ── Fuzzy-time matching (second pass) ────────────────────────────────────────

/**
 * Same-day time window for the fuzzy-time pass.
 * Covers the "doors open vs. show start" pattern (30–90 min typical gap)
 * and allows for aggregator feeds that round times differently.
 */
const FUZZY_TIME_WINDOW_MS = 2 * 60 * 60 * 1000  // 2 hours

/**
 * Words that carry no event-identity signal. Excluded from fuzzy token
 * matching so "Jazz Brunch: Doors Open" and "Sunday Jazz Brunch" share
 * the same meaningful tokens: [jazz, brunch].
 */
const STOPWORDS = new Set([
  'a','an','the','and','or','of','in','at','to','for','with','by','on','is',
  'are','be','was','were','has','have','had','from','as','its','it','this',
  'that','their','our','your','his','her','we','they','you','i','my','no',
  'not','so','if','but','do','get','all','more','up','out',
  // Event calendar noise words — appear in many unrelated titles
  'music','live','presents','featuring','ft','feat','event','events',
  'show','shows','night','evening','morning','afternoon','day','sunday','monday',
  'tuesday','wednesday','thursday','friday','saturday','am','pm','annual',
  'first','second','third','special',
  // Venue-logistics words that don't identify the act
  'doors','open','free','admission','tickets','register','rsvp',
])

function tokenizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w))
}

const FUZZY_THRESHOLD       = 0.75
const MIN_MEANINGFUL_TOKENS = 2

function tokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  const longerSet = new Set(longer)
  return shorter.filter(t => longerSet.has(t)).length / shorter.length
}

/**
 * Fuzzy title match: significant token overlap between two event titles.
 * Only fires when both titles carry at least MIN_MEANINGFUL_TOKENS keywords,
 * preventing single-word titles ("Jazz") from over-matching.
 */
export function fuzzyTitlesMatch(a, b) {
  const ta = tokenizeTitle(a)
  const tb = tokenizeTitle(b)
  if (ta.length < MIN_MEANINGFUL_TOKENS || tb.length < MIN_MEANINGFUL_TOKENS) return false
  return tokenOverlap(ta, tb) >= FUZZY_THRESHOLD
}

// ── Pass 3: placeholder-time matching (same venue + same Eastern day) ────────
//
// Re-syndicators (CVB, Akron Life) frequently drop the real time and emit a
// placeholder — most notably the CVB's 09:00 ET "no time given" default. Such a
// copy sits far (often 10+ h) from the real show time, so the 2-hour Pass 2
// window can never reach it and the wrong-time duplicate survives. Pass 3
// matches on the calendar DAY instead of clock proximity, but is gated hard so
// it only ever collapses a placeholder aggregator copy onto a first-party copy.

const PLACEHOLDER_SOURCES = new Set(['visit_akron_cvb', 'akron_life'])

/** America/New_York calendar date (YYYY-MM-DD) for an ISO instant. */
export function easternDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/** America/New_York wall-clock HH:MM for an ISO instant. */
function easternHHMM(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/**
 * True when an event's start time is NOT trustworthy: it's from a known
 * re-syndicator AND either sits at the tell-tale "no time given" default
 * (09:00 ET — the CVB placeholder) or carries no end_at. Used both to gate the
 * day-level Pass 3 and to keep such a copy from ever being chosen canonical
 * (so the surviving row keeps the real time and merely inherits the
 * placeholder copy's image/description).
 */
export function isLowConfidenceAggregatorTime(e) {
  if (!PLACEHOLDER_SOURCES.has(e.source)) return false
  return easternHHMM(e.start_at) === '09:00' || !e.end_at
}

/**
 * Strict title match for the day-level pass — much tighter than
 * fuzzyTitlesMatch. One normalized title must (near-)contain the other, OR
 * token overlap ≥ 0.9 with both titles carrying ≥ MIN_MEANINGFUL_TOKENS
 * keywords. This is what keeps a matinee and an evening show of the same act,
 * or two different same-day shows, from collapsing.
 */
export function strongTitlesMatch(a, b) {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  if (long.startsWith(short + ' ') || long.endsWith(' ' + short) || long.includes(' ' + short + ' ')) return true
  const ta = tokenizeTitle(a)
  const tb = tokenizeTitle(b)
  if (ta.length < MIN_MEANINGFUL_TOKENS || tb.length < MIN_MEANINGFUL_TOKENS) return false
  if (tokenOverlap(ta, tb) >= 0.9) return true
  // Shared headliner: identical first two meaningful tokens. Catches divergent
  // suffixes like "Mac Saturn w/ The Sweet Spot" vs "Mac Saturn Live at Musica".
  // Safe only because Pass 3 additionally requires same venue + same day + a
  // placeholder aggregator copy — it never merges two trusted-time events.
  return ta[0] === tb[0] && ta[1] === tb[1]
}

// ── Existing exact-match helpers ──────────────────────────────────────────────

/**
 * Normalize a title so cosmetic differences don't break the dedup match:
 *   "Martell School of Dance: Afternoon of Dance" and
 *   "Martell School Of Dance - Afternoon of Dance"
 * → both become "martell school of dance afternoon of dance"
 */
/**
 * Bucketing key for duplicate grouping. Venue-id bucketing alone misses
 * duplicates when two sources mint DIFFERENT venue records for the same
 * building — e.g. better_kenmore once stored a venue literally named
 * "1000 Kenmore Blvd" (no address) for a show The Rialto Theatre (address:
 * 1000 Kenmore Blvd) also published, and the pair could never group
 * (2026-06-11). Key precedence:
 *   1. the venue's normalized street address,
 *   2. the venue NAME when it looks like a bare street address (starts with
 *      a number) — covers junk venues that store the address as the name,
 *   3. the venue_id (original behavior).
 * Same-address-different-venue collisions are still gated by the fuzzy-title
 * and time-window checks before anything groups. Exported for tests.
 */
export function locationKey(e) {
  const ev = e.event_venues?.[0]
  if (!ev?.venue_id) return null
  const v = ev.venues ?? {}
  const addr = normalizeStreetAddress(v.address)
  if (addr) return `addr:${addr}`
  const nameAsAddr = normalizeStreetAddress(v.name)
  if (nameAsAddr && /^\d/.test(nameAsAddr)) return `addr:${nameAsAddr}`
  return `venue:${ev.venue_id}`
}

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['']/g, '')               // strip apostrophes so "Akron's" matches "Akrons"
    .replace(/[^a-z0-9]+/g, ' ')         // fold all other punctuation/whitespace to single space
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Flexible title comparison that tolerates two common cross-source title
 * divergence patterns at the SAME venue and start_at:
 *
 *   A) Leading city/org prefix on one source only.
 *      Ticketmaster:  "Akron RubberDucks vs. Hartford Yard Goats"
 *      RubberDucks:   "RubberDucks vs. Hartford Yard Goats"
 *      → strip up to MAX_PREFIX_WORDS leading words from the longer title and
 *        check if the remainder equals the shorter title.
 *
 *   B) Aggregator strips the marketing tagline; the authoritative source
 *      keeps it.
 *      Ticketmaster:  "HARDY: THE COUNTRY! COUNTRY! TOUR!"
 *      Akron Life:    "Hardy"
 *      → the shorter title is the prefix of the longer (with a word
 *        boundary after).  We check whether `longer.startsWith(shorter + ' ')`.
 *
 * Both strategies are gated by the strict venue + exact-start_at requirement
 * in the calling code, which keeps false-positive risk bounded: even if
 * "Hardy" matches "Hardy Boys Mystery Hour" at the library on some other
 * day, they'll be in different venue+time buckets and never compared.
 */
const MAX_PREFIX_WORDS = 2

function titlesMatch(a, b) {
  if (a === b) return true
  // Ensure `longer` is always the title we'll inspect.
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]

  // Strategy B — shorter is a prefix of longer with a word boundary after.
  // Cheap check, ordered first because the prefix case is more common in
  // practice (aggregators routinely trim marketing taglines).
  if (longer.startsWith(shorter + ' ')) return true

  // Strategy A — peel up to MAX_PREFIX_WORDS leading words off the longer
  // title and look for an exact match with the shorter.
  let trimmed = longer
  for (let i = 0; i < MAX_PREFIX_WORDS; i++) {
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) break
    trimmed = trimmed.slice(spaceIdx + 1)
    if (trimmed === shorter) return true
  }
  return false
}

// Minimum identical leading meaningful tokens for a shared-name-prefix match.
const MIN_SHARED_PREFIX_TOKENS = 3

/**
 * Same-event match for two titles that share a series/event NAME as their
 * leading words but then diverge — the classic cross-source pattern where one
 * source appends the venue and the other appends the act:
 *   "Meadow Music Concert Series at Crown Point"   (Eventbrite)
 *   "Meadow Music Concert Series - Alex Bevan"     (Crown Point's own site)
 * Both tokenize (stopwords dropped) to a shared leading run [meadow, concert,
 * series]; we require ≥ MIN_SHARED_PREFIX_TOKENS identical leading tokens.
 *
 * Used ONLY in Pass 1, which already requires the same venue AND the same exact
 * start instant — that hard gate is what makes a 3-token name prefix safe: two
 * genuinely different programs would have to start at the same venue on the
 * same second and share their first three meaningful words to false-merge.
 */
export function sharedNamePrefixMatch(a, b) {
  const ta = tokenizeTitle(a)
  const tb = tokenizeTitle(b)
  const n = Math.min(ta.length, tb.length)
  if (n < MIN_SHARED_PREFIX_TOKENS) return false
  let shared = 0
  for (let i = 0; i < n; i++) {
    if (ta[i] === tb[i]) shared++
    else break
  }
  return shared >= MIN_SHARED_PREFIX_TOKENS
}

/** Truncate an ISO/timestamp to whole-second resolution (UTC) so sub-second
 *  fractions some sources emit (Squarespace's `…:00.219Z`) don't split a
 *  venue+time bucket from a whole-second copy of the same event. */
export function toSecondKey(ts) {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 19)
}

/**
 * Group events into cross-source duplicate clusters. Pure + exported for tests.
 *
 * Three passes, coarsest to finest, each only considering events not already
 * matched by an earlier pass:
 *   Pass 1 — same venue + exact start_at + flexible title.
 *   Pass 2 — same venue + start_at within FUZZY_TIME_WINDOW_MS + fuzzy title.
 *   Pass 3 — same venue + same Eastern calendar day + STRICT title, gated so it
 *            only collapses a low-confidence placeholder aggregator copy onto a
 *            first-party (trusted-time) copy of the same show.
 *
 * @param {object[]} events  rows with { id, title, start_at, end_at, source,
 *                           event_venues:[{venue_id, venues:{name,address}}], … }
 * @returns {{ groups: object[][], withoutVenue: number }}
 */
export function findDuplicateGroups(events) {
  const byVenue = new Map()
  let withoutVenue = 0
  for (const e of events) {
    const key = locationKey(e)
    if (!key) { withoutVenue++; continue }
    if (!e.title) continue
    if (!byVenue.has(key)) byVenue.set(key, [])
    byVenue.get(key).push({ ...e, _titleKey: normalizeTitle(e.title) })
  }

  const groups = []
  const matchedIds = new Set()   // prevent an event appearing in two groups

  // ── Pass 1: exact start_at (whole-second resolution) ───────────────────────
  const byVenueTime = new Map()
  for (const [venueKey, evs] of byVenue) {
    for (const e of evs) {
      const bucket = `${venueKey}|${toSecondKey(e.start_at)}`
      if (!byVenueTime.has(bucket)) byVenueTime.set(bucket, [])
      byVenueTime.get(bucket).push(e)
    }
  }
  for (const bucket of byVenueTime.values()) {
    const clusters = []
    for (const e of bucket) {
      // Same venue + same exact second is a hard gate; a title match can be the
      // flexible prefix/peel form OR a shared series-name leading prefix.
      const existing = clusters.find(c =>
        titlesMatch(c[0]._titleKey, e._titleKey) || sharedNamePrefixMatch(c[0].title, e.title))
      if (existing) existing.push(e)
      else clusters.push([e])
    }
    for (const cluster of clusters) {
      if (cluster.length > 1) { groups.push(cluster); cluster.forEach(e => matchedIds.add(e.id)) }
    }
  }

  // ── Pass 2: fuzzy time window (doors vs. show start, aggregator lag) ────────
  for (const evs of byVenue.values()) {
    const unmatched = evs.filter(e => !matchedIds.has(e.id))
    unmatched.sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
    for (let i = 0; i < unmatched.length; i++) {
      const a = unmatched[i]
      if (matchedIds.has(a.id)) continue
      const cluster = [a]
      for (let j = i + 1; j < unmatched.length; j++) {
        const b = unmatched[j]
        if (matchedIds.has(b.id)) continue
        if (Math.abs(new Date(a.start_at) - new Date(b.start_at)) > FUZZY_TIME_WINDOW_MS) break
        if (fuzzyTitlesMatch(a.title, b.title)) cluster.push(b)
      }
      if (cluster.length > 1) { groups.push(cluster); cluster.forEach(e => matchedIds.add(e.id)) }
    }
  }

  // ── Pass 3: placeholder-time copies (same venue + same Eastern day) ─────────
  // Anchor on a first-party (trusted-time) event and pull in low-confidence
  // aggregator copies of the same show on the same day with a STRICT title
  // match. Never anchors on an aggregator and never pulls in a trusted-time
  // event, so two genuine same-day shows can't be merged here.
  for (const evs of byVenue.values()) {
    const unmatched = evs.filter(e => !matchedIds.has(e.id))
    const byDay = new Map()
    for (const e of unmatched) {
      const day = easternDay(e.start_at)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(e)
    }
    for (const dayEvents of byDay.values()) {
      if (dayEvents.length < 2) continue
      for (const anchor of dayEvents) {
        if (matchedIds.has(anchor.id)) continue
        if (PLACEHOLDER_SOURCES.has(anchor.source)) continue          // anchor must be trusted-time
        const cluster = [anchor]
        for (const cand of dayEvents) {
          if (cand.id === anchor.id || matchedIds.has(cand.id)) continue
          if (!isLowConfidenceAggregatorTime(cand)) continue          // only pull in placeholder copies
          if (strongTitlesMatch(anchor.title, cand.title)) cluster.push(cand)
        }
        if (cluster.length > 1) { groups.push(cluster); cluster.forEach(e => matchedIds.add(e.id)) }
      }
    }
  }

  return { groups: groups.filter(g => g.length > 1), withoutVenue }
}

async function main() {
  console.log(`🔍  ${APPLY ? 'APPLYING' : 'DRY RUN —'} cross-source duplicate cleanup`)
  console.log(`    Match rule: same venue + same start_at across different sources`)
  console.log('')

  // Pull every event with its linked venue. Page through in case there are
  // more than the default page size.
  const all = []
  let from = 0
  const pageSize = 1000
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, description, image_url, start_at, source, source_id, ticket_url, manual_overrides, event_venues(venue_id, venues(name, address))')
      .order('start_at', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) {
      console.error('Query failed:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  // Deduplicate by event ID. If an event has multiple rows in event_venues
  // (e.g. a duplicate junction row), PostgREST can return the same event
  // more than once in the paginated result, which would cause the grouping
  // logic below to cluster an event with itself and flag it as a duplicate.
  const seen = new Set()
  const unique = all.filter(e => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })
  if (unique.length < all.length) {
    console.log(`Collapsed ${all.length - unique.length} duplicate row(s) from multi-venue joins`)
  }
  console.log(`Loaded ${unique.length} unique events`)

  const { groups: dupeGroups, withoutVenue } = findDuplicateGroups(unique)
  console.log(`Excluded ${withoutVenue} events with no linked venue`)
  console.log('')
  console.log(`Found ${dupeGroups.length} duplicate group(s)`)
  console.log('')

  let totalToDelete = 0
  let preserved    = 0
  const deletes    = []
  const merges     = []  // { id, fields } — canonical events that need a field merge

  for (const group of dupeGroups) {
    // Sort to find the canonical event — data quality wins over source priority.
    //
    // Tier 1 (best): has both image_url AND a non-trivial description
    // Tier 2:        has image_url OR a non-trivial description
    // Tier 3:        has neither
    //
    // Within the same tier, fall back to SOURCE_PRIORITY so we consistently
    // prefer authoritative first-party data over aggregators.
    const dataScore = (e) => {
      const hasImage = !!e.image_url
      const hasDesc  = !!(e.description && e.description.trim().length > 20)
      if (hasImage && hasDesc) return 0   // best
      if (hasImage || hasDesc) return 1
      return 2                            // worst
    }
    // A placeholder-time copy (CVB 09:00 default, etc.) must never be chosen
    // canonical when a trusted-time copy exists — otherwise the surviving row
    // would carry the fabricated time. It still donates its image/description
    // to the canonical via the merge step below.
    const sorted = [...group].sort((a, b) => {
      const lcDiff = (isLowConfidenceAggregatorTime(a) ? 1 : 0) - (isLowConfidenceAggregatorTime(b) ? 1 : 0)
      if (lcDiff !== 0) return lcDiff
      const scoreDiff = dataScore(a) - dataScore(b)
      if (scoreDiff !== 0) return scoreDiff
      return priority(a.source) - priority(b.source)
    })
    const canonical = sorted[0]
    const dupes     = sorted.slice(1)

    const qualityLabel = (e) => {
      const hasImage = !!e.image_url
      const hasDesc  = !!(e.description && e.description.trim().length > 20)
      if (hasImage && hasDesc) return '✓img ✓desc'
      if (hasImage) return '✓img  desc'
      if (hasDesc)  return ' img ✓desc'
      return ' img  desc'
    }

    // Collect fields the canonical is missing but a dupe can supply.
    // We merge image_url and description rather than losing them on deletion.
    const mergeFields = {}
    const hasGoodDesc = (e) => !!(e.description && e.description.trim().length > 20)
    for (const d of dupes) {
      if (!canonical.image_url && d.image_url && !mergeFields.image_url) {
        mergeFields.image_url = d.image_url
      }
      if (!hasGoodDesc(canonical) && hasGoodDesc(d) && !mergeFields.description) {
        mergeFields.description = d.description
      }
    }
    const mergeNote = Object.keys(mergeFields).length > 0
      ? ` [will merge: ${Object.keys(mergeFields).join(', ')}]`
      : ''

    console.log(`Group: ${sorted[0].start_at}  venue=${sorted[0].event_venues?.[0]?.venue_id?.slice(0, 8)}…`)
    console.log(`  KEEP  [${canonical.source}/${canonical.source_id}] (${qualityLabel(canonical)})${mergeNote} ${canonical.title?.slice(0, 50)}`)
    for (const d of dupes) {
      const protect = hasManualOverrides(d)
      const tag = protect ? '🛡 KEEP (manual_overrides)' : 'DROP'
      console.log(`  ${tag.padEnd(26)} [${d.source}/${d.source_id}] (${qualityLabel(d)}) ${d.title?.slice(0, 50)}`)
      if (protect) { preserved++ }
      else         { deletes.push(d.id); totalToDelete++ }
    }

    if (Object.keys(mergeFields).length > 0) merges.push({ id: canonical.id, fields: mergeFields })
  }

  console.log('')
  console.log(`Summary: ${totalToDelete} to delete, ${merges.length} to enrich, ${preserved} preserved by manual_overrides`)

  if (!APPLY) {
    console.log('')
    console.log(`(Dry run — pass --apply to delete ${totalToDelete} and enrich ${merges.length} canonical events.)`)
    return
  }

  // Apply field merges to canonicals before deleting dupes
  if (merges.length > 0) {
    let merged = 0
    for (const { id, fields } of merges) {
      const { error } = await supabaseAdmin.from('events').update(fields).eq('id', id)
      if (error) console.warn(`  ⚠ Merge failed for ${id}: ${error.message}`)
      else merged++
    }
    console.log(`✅  Merged fields into ${merged} canonical event(s).`)
  }

  if (deletes.length === 0) {
    console.log('Nothing to delete.')
    return
  }

  // Batch deletes
  const CHUNK = 100
  let deleted = 0
  for (let i = 0; i < deletes.length; i += CHUNK) {
    const batch = deletes.slice(i, i + CHUNK)
    const { error, count } = await supabaseAdmin
      .from('events')
      .delete({ count: 'exact' })
      .in('id', batch)
    if (error) {
      console.error(`  ✗ Delete batch ${i} failed:`, error.message)
      process.exit(1)
    }
    deleted += count ?? batch.length
  }
  console.log(`✅  Deleted ${deleted} events. Junction-table rows cascaded.`)
}

// Run only when invoked directly (`node scripts/dedupe-cross-source.js`);
// importing the module (tests) must never trigger a live dedupe — the same
// import-safety contract every scraper follows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Dedupe failed:', err)
    process.exit(1)
  })
}
