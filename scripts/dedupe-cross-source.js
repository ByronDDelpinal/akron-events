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
 *   • Events with no linked venue are skipped by the venue-keyed passes (1–3);
 *     a titled one can still be matched by the venue-less Pass 4, so "no venue"
 *     is not by itself protection from deletion
 *
 * Usage:
 *   node scripts/dedupe-cross-source.js                    # dry run
 *   node scripts/dedupe-cross-source.js --apply             # do it
 *   node scripts/dedupe-cross-source.js --apply --max-deletes=100  # raise the cap; a value >= the planned delete count drops the tier filter and deletes EVERY group
 *
 * Safety cap: unattended callers (run-all.js / the nightly Actions workflow)
 * always pass --apply, so this script is the only thing standing between a
 * matching bug and a mass delete. `--max-deletes=<n>` (or env
 * DEDUPE_MAX_DELETES) sets an explicit cap on how many rows a single run may
 * delete; without it, the cap defaults to max(50, 2% of loaded events).
 *
 * The cap is a PARTIAL DRAIN, not an abort. It used to be all-or-nothing:
 * a plan over the cap printed and exited 1 having deleted nothing. With a
 * cap of 40 and a standing backlog of ~230 planned deletes, that meant the
 * nightly dedupe did literally zero work every night while the backlog
 * compounded — and reddened the whole nightly run (run-all.js treats any
 * dedupe non-zero exit as a failure). Now an over-cap run deletes the
 * highest-confidence groups up to the cap and defers the rest to the next
 * run, exiting 0. The cap itself is unchanged and still binding: a run can
 * never delete more than `maxDeletes` rows. When the plan is over the cap,
 * selection only ever considers tier 0/1 groups (see groupConfidenceTier) and
 * never splits a group, so a partial drain never leaves half a merge applied.
 *
 * One capped case is still red: if a run is over the cap and selects ZERO
 * deletes (everything left is tier >= 2, or a single group is bigger than the
 * cap), nothing drains and nothing about the next run will differ. That is the
 * old do-nothing-forever bug in a new costume, so the run exits 1 instead of
 * reporting a green no-op. A drain of >= 1 group stays green.
 *
 * Every row a real (--apply) run is about to delete is also written to
 * scrape-reports/dedupe-deletions-<date>.json before the delete happens, so
 * an unattended run always leaves an audit trail behind.
 */

import 'dotenv/config'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { normalizeStreetAddress, logUpsertResult, logScraperError, easternTodayIso } from './lib/normalize.js'
import { AGGREGATOR_PRIORITY, isSelfCredit } from './lib/source-tiers.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPORT_DIR = join(ROOT, 'scrape-reports')

const APPLY = process.argv.includes('--apply')

// Pinned field list for the pre-delete audit artifact (scrape-reports/
// dedupe-deletions-*.json). This repo is public and the nightly Actions
// workflow uploads scrape-reports/ for 30 days, so the payload is an
// explicit pick rather than the full row — a future `.select()` change to
// the events query can't silently widen what leaves the runner.
const AUDIT_FIELDS = ['id', 'title', 'description', 'image_url', 'start_at', 'source', 'source_id', 'ticket_url', 'manual_overrides']

/** Parse a numeric value from a CLI/env source; null when absent or invalid. */
function parseCapValue(v) {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Resolve the delete-count safety cap for a run. An explicit `--max-deletes=<n>`
 * flag wins over the `DEDUPE_MAX_DELETES` env var, which wins over the
 * default of max(50, 2% of the events loaded this run). Exported for tests.
 */
export function resolveMaxDeletesCap({ argValue, envValue, uniqueLength }) {
  const explicit = parseCapValue(argValue) ?? parseCapValue(envValue)
  if (explicit !== null) return explicit
  return Math.max(50, Math.ceil(uniqueLength * 0.02))
}

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
// Entries MUST be the exact `events.source` keys from manifest.js — a stale
// or abbreviated key here is silently void (the source falls through to the
// unlisted-first-party rank). akronym/jillys/nightlight sat here as short
// forms of akronym_brewing/jillys_music_room/nightlight_cinema until
// 2026-07-15 and never matched anything.
export const SOURCE_PRIORITY = [
  'akron_civic',
  'akronym_brewing',
  'akron_symphony',
  'akron_zoo',
  'akron_art_museum',
  'akron_childrens_museum',
  'akron_library',
  'akron_public_schools',
  'akron_roller_derby',      // first-party (home bouts at Summit County Fairgrounds)
  'blu_jazz',
  'city_of_akron_lock3',     // first-party source for city programming
  'cvfm',                    // first-party (Cuyahoga Valley Farmers Market, Summit venues)
  'city_of_hudson',          // first-party municipal calendar (CivicPlus)
  'ejthomas_hall',           // first-party venue calendar (E.J. Thomas Hall)
  'jillys_music_room',
  'leadership_akron',
  'missing_falls',
  'nightlight_cinema',
  'north_hill_cdc',
  'northfield_park',         // first-party venue (Center Stage) — displaces Ticketmaster copies
  'ohio_erie_canalway',      // first-party (Canalway Coalition towpath events)
  'ohio_shakespeare',
  'painting_twist',
  'rubberducks',
  'stan_hywet',              // first-party venue calendar
  'summit_artspace',
  'tangier',                 // first-party venue (Fairlawn — Tangier West etc.)
  'summit_county_fairgrounds', // first-party venue (Tallmadge)
  'workz',                   // first-party venue (The Workz — Cuyahoga Falls riverfront)
  'summit_humane',           // first-party (Humane Society) — Give Back events
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
//
// 2026-07-02: downtown_akron (DAP) moved here from SOURCE_PRIORITY — it's a
// Tier-3 aggregator (see lib/source-tiers.js), not a first-party source. It
// had been ranked ahead of several real first-party scrapers (weathervane,
// stan_hywet, rubberducks, …), so an exact-match DAP dupe could have won
// canonical over the venue's own, richer copy.
//
// 2026-07-07: the list itself now lives in lib/source-tiers.js (imported
// above) so ingest-time aggregator suppression (classifyAggregatorEvent)
// and dedupe canonical selection can never drift apart.

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

// Ordinal edition markers ("41st Annual…", "3rd Saturday…") are noise like
// 'annual' itself: they mark the edition, not the event's identity. Dropping
// them lets "41st Annual Juried Exhibition" match "CVAC: Juried Exhibition".
// Two DIFFERENT events distinguished only by ordinal would be a year apart,
// so the venue+time gates on every pass keep this safe.
const ORDINAL_RE = /^\d+(st|nd|rd|th)$/

function tokenizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w) && !ORDINAL_RE.test(w))
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
  if (squashTitle(na) === squashTitle(nb)) return true   // "Storytime" vs "Story Time"
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

/**
 * Umbrella/sub-event detector for the venue-less pass. Festival feeds list an
 * umbrella event ("All American Burger & BBQ Festival") ALONGSIDE its
 * sub-events ("All American Burger & BBQ Festival: JT's Electrik Blackout").
 * A bare containment match would merge the umbrella into one arbitrary
 * sub-event and delete the umbrella listing — a real loss (2026-07-03).
 * True when one RAW title is exactly the other's pre-delimiter umbrella name.
 * The reverse pattern (shorter title == the SUFFIX after the delimiter, e.g.
 * "The Michael Weber Show" vs "…Festival: The Michael Weber Show") is the
 * same act and stays matchable.
 */
export function isUmbrellaSubEventPair(rawA, rawB) {
  for (const [shortRaw, longRaw] of [[rawA, rawB], [rawB, rawA]]) {
    const m = (longRaw || '').match(/^(.+?)(?::|\s[—–-]\s)(.+)$/)
    if (!m) continue
    if (normalizeTitle(m[1]) === normalizeTitle(shortRaw) && normalizeTitle(m[2])) return true
  }
  return false
}

/**
 * Strict title match for the venue-less pass (Pass 4). Same as strongTitlesMatch
 * MINUS the shared-headliner (first-two-tokens) fallback — that fallback is only
 * safe under Pass 1's exact-second gate, and Pass 4 matches on the calendar day,
 * so we require exact normalized equality, containment, or ≥0.9 token overlap.
 * The containment arm additionally refuses umbrella/sub-event pairs — "X" must
 * never merge with "X: Y" (see isUmbrellaSubEventPair).
 */
export function venuelessTitleMatch(a, b) {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (squashTitle(na) === squashTitle(nb)) return true   // compound-word split tolerance
  // Umbrella/sub-event pairs are distinct events; the containment arm AND the
  // token-overlap arm (shorter side of a subset title always scores 1.0) would
  // both false-match them, so the guard sits ahead of both.
  if (isUmbrellaSubEventPair(a, b)) return false
  const [s, l] = na.length <= nb.length ? [na, nb] : [nb, na]
  if (l.startsWith(s + ' ') || l.endsWith(' ' + s) || l.includes(' ' + s + ' ')) return true
  const ta = tokenizeTitle(a)
  const tb = tokenizeTitle(b)
  if (ta.length >= MIN_MEANINGFUL_TOKENS && tb.length >= MIN_MEANINGFUL_TOKENS &&
      tokenOverlap(ta, tb) >= 0.9) return true
  return false
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
  const links = e.event_venues ?? []
  if (!links.some((l) => l?.venue_id)) return null
  // Consider EVERY venue link, best key first — not just links[0]. Events can
  // carry a junk link alongside the real venue (city_of_hudson events linked
  // both Hudson Green AND a leftover paragraph-named venue, 2026-07-16), and
  // PostgREST's junction-array order is arbitrary, so keying off [0] made a
  // dupe's bucket depend on join order and let identical events at the same
  // venue + second escape every pass.
  let venueIdKey = null
  let nameAddrKey = null
  for (const ev of links) {
    if (!ev?.venue_id) continue
    const v = ev.venues ?? {}
    const addr = normalizeStreetAddress(v.address)
    if (addr) return `addr:${addr}`               // best: real street address
    const nameAsAddr = normalizeStreetAddress(v.name)
    if (!nameAddrKey && nameAsAddr && /^\d/.test(nameAsAddr)) {
      nameAddrKey = `addr:${nameAsAddr}`          // next: address-as-name junk venue
    }
    if (!venueIdKey) venueIdKey = `venue:${ev.venue_id}`
  }
  return nameAddrKey ?? venueIdKey
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
 * Space-free form of an already-normalized title. Compound-word splits are a
 * real cross-source divergence pattern ("Preschool Storytime" vs "Preschool
 * Story Time", "Firefall" vs "Fire Fall") that defeats both string equality
 * and token overlap. Squashed EQUALITY is the strictest possible fuzzy match
 * — identical letters in identical order — so it is safe everywhere.
 */
function squashTitle(normalized) {
  return normalized.replace(/ /g, '')
}

// ── Pass-1-only typo/word-split tolerant matching ────────────────────────────
//
// Real-world cross-source pairs at the SAME venue and the SAME start second
// still diverge by (a) a single-character typo in a name ("Gospel Sunday -
// Ridanym" vs "Gospel Sunday w Ridanyn") or (b) one source splitting a
// compound word ("Firefall" vs "Fire Fall") while also reordering a lineup.
// These helpers tolerate exactly those two patterns and nothing more, and are
// used ONLY under Pass 1's hard gate (same venue + exact start second +
// different sources). Two genuinely different events would have to start on
// the same second at the same venue AND have ≥90% of their meaningful tokens
// within edit distance 1 to false-merge — effectively impossible.

/** True when a and b are within a single insert/delete/substitute edit. */
export function withinOneEdit(a, b) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0, j = 0, edits = 0
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (s.length === l.length) { i++; j++ }   // substitution
    else j++                                  // skip the extra char in the longer string
  }
  edits += (s.length - i) + (l.length - j)    // any unconsumed tail is more edits
  return edits <= 1
}

// Fuzzy token equality only for tokens long enough that a 1-char slip is a
// typo, not a different word ("ridanym"/"ridanyn" yes; "cat"/"car" no).
const MIN_TYPO_TOKEN_LEN = 5

/**
 * tokenOverlap variant that additionally counts a shorter-side token as
 * matched when (a) it equals the concatenation of two ADJACENT longer-side
 * tokens (word-split tolerance, strict string equality) or (b) it is within
 * one edit of a longer-side token of ≥ MIN_TYPO_TOKEN_LEN chars.
 */
function typoTolerantOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  const longerSet = new Set(longer)
  for (let k = 0; k < longer.length - 1; k++) longerSet.add(longer[k] + longer[k + 1])
  let hits = 0
  for (const t of shorter) {
    if (longerSet.has(t)) { hits++; continue }
    if (t.length >= MIN_TYPO_TOKEN_LEN &&
        longer.some(u => u.length >= MIN_TYPO_TOKEN_LEN && withinOneEdit(t, u))) hits++
  }
  return hits / shorter.length
}

/**
 * Near-identical token sets under typo/word-split tolerance. Threshold 0.9 —
 * same bar as strongTitlesMatch's overlap arm, NOT the loose 0.75 fuzzy bar,
 * because the tolerance itself already relaxes token equality. Exported for
 * tests. Use only under Pass 1's exact venue+second gate.
 */
export function typoTolerantTitlesMatch(a, b) {
  const ta = tokenizeTitle(a)
  const tb = tokenizeTitle(b)
  if (ta.length < MIN_MEANINGFUL_TOKENS || tb.length < MIN_MEANINGFUL_TOKENS) return false
  return typoTolerantOverlap(ta, tb) >= 0.9
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
  // Compound-word split ("preschool storytime" vs "preschool story time"):
  // identical letters, different word boundaries. Strictest fuzzy form there is.
  if (squashTitle(a) === squashTitle(b)) return true
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
  const venueless = []            // events with no linked venue (Pass 4 candidates)
  let withoutVenue = 0
  for (const e of events) {
    const key = locationKey(e)
    if (!key) {
      withoutVenue++
      if (e.title) venueless.push({ ...e, _titleKey: normalizeTitle(e.title) })
      continue
    }
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
      //
      // EVERY arm is additionally gated to DIFFERENT sources. Cross-SOURCE
      // dedupe collapsing two same-source rows was a category error: one
      // source listing two rows at the same venue + second is either two real
      // parallel sessions ("Preschool Story Time Room A"/"Room B" — the
      // library pattern, where "room"+letter survives the prefix stopwords)
      // or a (source, source_id) uniqueness problem — and deleting a row is
      // the wrong response to both.
      const existing = clusters.find(c => {
        if (c[0].source === e.source) return false
        if (titlesMatch(c[0]._titleKey, e._titleKey) || sharedNamePrefixMatch(c[0].title, e.title)) return true
        // Cross-source only: a shared headliner (strongTitlesMatch — same first
        // two meaningful tokens, etc.) is enough at the same venue + exact
        // second. This catches aggregator re-listings that drift the tagline
        // ("Ray LaMontagne at Akron Civic Theatre" vs "Ray LaMontagne: Trouble
        // 20th Anniversary Tour"). Gated to DIFFERENT sources so two distinct
        // same-source programs that share a series prefix ("Job Readiness — Ace
        // Your Interview" vs "Job Readiness — Find Unadvertised Jobs") at a
        // multi-room venue are never collapsed — one source won't list the same
        // event twice at the same second.
        if (c[0].source !== e.source && strongTitlesMatch(c[0].title, e.title)) return true
        // Cross-source only: tolerate a single-character typo in a name and
        // compound-word splits ("Ridanym"/"Ridanyn", "Firefall"/"Fire Fall")
        // when ≥90% of meaningful tokens line up. Safe solely because of the
        // same-venue + exact-second + different-source gate above.
        if (c[0].source !== e.source && typoTolerantTitlesMatch(c[0].title, e.title)) return true
        return false
      })
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
        // Different-source gate, mirroring Pass 1 (:634) and Pass 4 (:747).
        // Pass 2 exists for "doors open vs. show start" and "aggregator feeds
        // that round times differently" — both are two SOURCES disagreeing
        // about the same event. One source publishing two rows within the
        // fuzzy window at one venue is publishing two sessions (age-banded
        // story times, sequential class sessions, back-to-back comedy shows,
        // morning vs. evening yoga classes), not disagreeing with itself.
        // Same-source fuzzy-time matching was a category error, not a
        // tunable — it is what deleted 73 real, distinct same-source events
        // on 2026-07-28. `continue` (not `break`): only this candidate is
        // disqualified, the sorted-time window scan must keep going.
        if (b.source === a.source) continue
        if (Math.abs(new Date(a.start_at) - new Date(b.start_at)) > FUZZY_TIME_WINDOW_MS) break
        if (fuzzyTitlesMatch(a.title, b.title)) cluster.push(b)
      }
      if (cluster.length > 1) { groups.push(cluster); cluster.forEach(e => matchedIds.add(e.id)) }
    }
  }

  // ── Pass 3: placeholder-time copies (same venue + same Eastern day) ─────────
  // Anchor on a trusted-time event and pull in low-confidence aggregator copies
  // of the same show on the same day with a STRICT title match. The anchor is
  // barred only from PLACEHOLDER_SOURCES (other aggregators can still anchor),
  // and a candidate must be a placeholder-time copy, so no trusted-time row is
  // ever pulled in. That is NOT a guarantee that two genuine same-day shows
  // can't merge here: this pass has no umbrella/sub-event guard, and one anchor
  // can absorb two DISTINCT placeholder rows hours apart (the EarthQuaker Day
  // group). What holds that shape back is hasSiblingSessionRisk, downstream.
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

  // ── Pass 4: venue-less aggregator/listing copies (same Eastern day + strict title)
  // Passes 1–3 bucket by venue, so an event with NO linked venue is invisible to
  // them. Thin feeds (ohio_festivals, downtown_akron, intake_email, …) often
  // republish an event we already have from a venue-linked source but drop the
  // venue, so that copy survives. Match a venue-less row to a venue-linked row
  // from a DIFFERENT source on the same Eastern day with a STRICT title match;
  // the venue-linked row wins canonical (see venueScore in main). Distinctive
  // festival titles + same-day + strict match keep unrelated same-titled events
  // (e.g. "LEGO Club" at two branches — both have venues, so neither is
  // venue-less here) from merging.
  const venuedByDay = new Map()
  for (const evs of byVenue.values()) {
    for (const e of evs) {
      if (matchedIds.has(e.id)) continue
      const day = easternDay(e.start_at)
      if (!venuedByDay.has(day)) venuedByDay.set(day, [])
      venuedByDay.get(day).push(e)
    }
  }
  // Score every possible (venue-less, venue-linked) pair and assign GLOBALLY,
  // best match first — never first-encountered-wins. With sequential
  // assignment, a festival umbrella row could consume the venue-linked copy
  // via a loose containment match before the sub-event's EXACT-title twin was
  // even considered, leaving the real duplicate alive (2026-07-03 launch-day
  // bug: "…Festival" grabbed "…Festival: JT's Electrik Blackout" and the
  // exact DAP duplicate of JT's survived to the homepage).
  //   tier 0 — exact/squashed normalized title equality
  //   tier 1 — venuelessTitleMatch (containment / ≥0.9 overlap), or a
  //            typo-tolerant match gated to the SAME start second (singular/
  //            plural drift like "Burger"/"Burgers" — safe only because the
  //            same-second gate mirrors Pass 1's hard gate, minus the venue
  //            the venue-less row doesn't have)
  //   time distance breaks ties within a tier.
  const pairs = []
  for (const vless of venueless) {
    if (matchedIds.has(vless.id)) continue
    const candidates = venuedByDay.get(easternDay(vless.start_at)) || []
    for (const cand of candidates) {
      if (cand.source === vless.source) continue
      const exact = vless._titleKey === cand._titleKey ||
                    squashTitle(vless._titleKey) === squashTitle(cand._titleKey)
      const sameSecond = toSecondKey(vless.start_at) === toSecondKey(cand.start_at)
      const loose = venuelessTitleMatch(vless.title, cand.title) ||
                    (sameSecond && !isUmbrellaSubEventPair(vless.title, cand.title) &&
                     typoTolerantTitlesMatch(vless.title, cand.title))
      if (!exact && !loose) continue
      const dt = Math.abs(new Date(vless.start_at) - new Date(cand.start_at))
      pairs.push({ vless, cand, tier: exact ? 0 : 1, dt })
    }
  }
  pairs.sort((p, q) => (p.tier - q.tier) || (p.dt - q.dt))
  for (const { vless, cand } of pairs) {
    if (matchedIds.has(vless.id) || matchedIds.has(cand.id)) continue
    groups.push([cand, vless])
    matchedIds.add(cand.id)
    matchedIds.add(vless.id)
  }

  return { groups: groups.filter(g => g.length > 1), withoutVenue }
}

/**
 * Junction-link donation: when the canonical event has NO venue links (or no
 * organization links), collect them from the copies being deleted so deleting
 * a dupe never destroys the group's only venue/organization linkage.
 *
 * This mirrors the image/description merge: the canonical is chosen for its
 * trustworthy time and richer content, but a dropped aggregator copy is often
 * the only member that was matched to a venue (Pass 4 exists precisely because
 * thin feeds drop the venue — and sometimes the ONLY venue-linked copy loses
 * canonical to a trusted-time venue-less one, e.g. visit_akron_cvb placeholder
 * copies of festivals).
 *
 * Donation is deliberately all-or-nothing per link type: if the canonical
 * already has ANY venue link we donate nothing, because "same building, two
 * venue records" splits are real (see locationKey) and blindly unioning links
 * would re-attach the split twin we're trying to retire.
 *
 * Pure + exported for tests.
 *
 * @param {object} canonical the event row that survives
 * @param {object[]} donors  the rows being DELETED (already excludes
 *                           manual_overrides-preserved rows)
 * @returns {{ venueIds: string[], orgIds: string[] }}
 */
export function collectLinkDonations(canonical, donors) {
  const canonicalVenues = (canonical.event_venues ?? []).filter(v => v?.venue_id)
  const canonicalOrgs   = (canonical.event_organizations ?? []).filter(o => o?.organization_id)
  const venueIds = new Set()
  const orgIds   = new Set()
  for (const d of donors) {
    if (canonicalVenues.length === 0) {
      for (const v of d.event_venues ?? []) if (v?.venue_id) venueIds.add(v.venue_id)
    }
    if (canonicalOrgs.length === 0) {
      for (const o of d.event_organizations ?? []) {
        if (!o?.organization_id) continue
        // Never launder an aggregator's self-credit onto another source's row.
        //
        // This is how "Twins Days Festival" (Twinsburg, run by Twins Days Inc.)
        // ended up reading "Presented by Visit Akron / Summit County": the CVB
        // copy self-credited, lost canonical to the ohio_festivals copy, and
        // donated its org link on the way out — so the misattribution outlived
        // the row that caused it.
        //
        // Note the check is on the DONOR's source, not the canonical's. The
        // pair (ohio_festivals, 'Visit Akron / Summit County') is not
        // self-referential and would pass a canonical-side check, which is
        // exactly how this slipped through. What makes the link illegitimate is
        // that it was a self-credit AT ITS ORIGIN.
        //
        // Donations of REAL organizers stay allowed and are desirable: a CVB
        // copy carrying "Porthouse Theatre" (from its `hostname` field) should
        // still hand that to a surviving ohio_festivals row.
        if (isSelfCredit(d.source, o?.organizations?.name)) continue
        orgIds.add(o.organization_id)
      }
    }
  }
  return { venueIds: [...venueIds], orgIds: [...orgIds] }
}

/**
 * Build the event_aliases row that records a dropped duplicate → canonical
 * mapping, so a future re-scrape of the dup's (source, source_id) is skipped at
 * ingest instead of resurrecting the merged event. Returns null for a dup with
 * no source_id — there is no stable key to record.
 *
 * `reason` is tagged with the group's confidence tier and whether the drop
 * was same-source or cross-source. This morning's remediation (the
 * 2026-07-28 incident: 188 deleted, 73 of them same-source and largely
 * distinct events) required reconstructing which aliases to delete from
 * stdout because `reason` was a constant — this makes it a query instead:
 *   delete from event_aliases where reason like 'dedupe-cross-source:%same-source';
 * `reason` is free text (src/lib/database.types.ts:102) so this needs no
 * migration. `tier`/`canonicalSource` are optional so callers that don't
 * have them (or old test fixtures) still get a valid, if less specific, row.
 */
export function buildAliasRow(canonicalId, dup, tier, canonicalSource) {
  if (!dup || dup.source_id == null) return null
  return {
    duplicate_source: dup.source,
    duplicate_source_id: dup.source_id,
    canonical_event_id: canonicalId,
    reason: `dedupe-cross-source:tier${tier ?? 'unknown'}:${canonicalSource === dup.source ? 'same-source' : 'cross-source'}`,
  }
}

/**
 * Upsert alias rows, lossless + idempotent on the (duplicate_source,
 * duplicate_source_id) unique key — the same key ingest upserts events on.
 * The provenance tag lives in `reason`, which is NOT part of this key, so
 * tagging it can never fragment the upsert's conflict target.
 * Accepts an injected client so tests can assert the write args without a DB.
 */
export async function recordAliases(aliasRows, client = supabaseAdmin) {
  if (!aliasRows || aliasRows.length === 0) return { recorded: 0, error: null }
  const { error } = await client
    .from('event_aliases')
    .upsert(aliasRows, { onConflict: 'duplicate_source,duplicate_source_id' })
  if (error) return { recorded: 0, error }
  return { recorded: aliasRows.length, error: null }
}

// ── Per-group planning + capped partial drain ────────────────────────────────

/**
 * Confidence tier for a duplicate group, derived from the ROWS themselves
 * rather than from which pass produced the group — the pass is an artifact of
 * grouping order (an event skipped by Pass 1 because its partner was already
 * matched can resurface in Pass 2), while the rows are the evidence.
 *
 *   tier 0 — identical normalized title AND identical start second AND the
 *            same location key AND ≥2 distinct sources. This is the
 *            northfield_park-vs-ticketmaster shape: unambiguous.
 *   tier 1 — same location key + same start second + ≥2 distinct sources, but
 *            the titles only match through a flexible arm (prefix peel, shared
 *            series name, typo/word-split tolerance).
 *   tier 2 — same location key, start times within FUZZY_TIME_WINDOW_MS
 *            (the Pass 2 doors-vs-showtime shape).
 *   tier 3 — everything else: day-level Pass 3 placeholder matches and
 *            venue-less Pass 4 pairs, plus any group whose members disagree on
 *            location.
 *
 * Only tiers 0 and 1 are eligible for an over-cap partial drain. Tier 1 carries
 * the ≥2-distinct-sources requirement too (a deviation from a literal reading
 * of "same locationKey + same second"): a cross-SOURCE dedupe script must
 * never spend its scarce delete budget collapsing two rows from one source.
 * (Pass 2 used to have no different-source gate, so a same-source pair could
 * reach a same-second group here — fixed 2026-07-28; every pass is now
 * different-source-gated. This tier-1 check is kept as defense in depth: a
 * future pass that forgets the gate still can't buy same-source rows a
 * partial-drain eligibility.) Such a group simply falls to tier 2 and waits
 * for a human.
 *
 * Location is compared with locationKey — never event_venues[0], whose order
 * PostgREST does not guarantee (that bug is why locationKey exists).
 * Pure + exported for tests.
 */
export function groupConfidenceTier(group) {
  if (!Array.isArray(group) || group.length < 2) return 3

  const keys = group.map(locationKey)
  const sameLocation = keys.every((k) => k && k === keys[0])
  if (!sameLocation) return 3

  const distinctSources = new Set(group.map((e) => e.source)).size
  const seconds = group.map((e) => toSecondKey(e.start_at))
  const sameSecond = seconds.every((s) => s === seconds[0])

  if (sameSecond && distinctSources >= 2) {
    const titles = group.map((e) => normalizeTitle(e.title))
    if (titles.every((t) => t && t === titles[0])) return 0
    return 1
  }

  const times = group.map((e) => new Date(e.start_at).getTime())
  if (times.every((t) => Number.isFinite(t)) &&
      Math.max(...times) - Math.min(...times) <= FUZZY_TIME_WINDOW_MS) return 2

  return 3
}

/**
 * True when a duplicate group is UNSAFE to ever auto-delete, regardless of
 * how large the cap is: at least one SOURCE contributes rows at more than one
 * distinct start second.
 *
 * This used to require the WHOLE group to be single-source. That guard
 * protected an UNREACHABLE shape: after every pass was gated to different
 * sources (Pass 1 at :634, Pass 2 at :683, Pass 4 at :758, and Pass 3's
 * anchor/candidate split which makes a same-source pair structurally
 * impossible as an anchor), no pass can produce a group where EVERY member
 * shares one source. The shape that IS reachable is a cluster ANCHORED by a
 * third source, carrying two same-source rows at different times —
 * `findDuplicateGroups` only ever requires each member to differ from the
 * ANCHOR, never from each other. Two real incidents of exactly this shape:
 * `the_grove` 7am/8:30am "Chair Yoga Class" pair, both pulled in alongside an
 * `akron_life` anchor; and the EarthQuaker Day group, where an `intake_email`
 * anchor absorbed two distinct `akron_life` performer rows three hours apart
 * (Pass 3 has no equivalent of Pass 4's `isUmbrellaSubEventPair` guard). The
 * old `sources.size !== 1` check passes both of these straight through to
 * DROP, because the anchor's source makes the group multi-source.
 *
 * The corrected predicate: bucket the group's rows by source, and flag it if
 * ANY source's rows span more than one distinct start second — regardless of
 * how many other sources are in the group. This is a strict superset of the
 * old whole-group check (anything the old predicate flagged, this flags too,
 * since a single-source group IS one source's bucket), so nothing currently
 * held is released; it additionally catches the anchored multi-source shape
 * the old predicate missed.
 *
 * Same-source + same-second within a bucket is still allowed through — that's
 * the genuine cosmetic-double-listing shape (wolf_creek `-1-` variants,
 * rubberducks 819018/819019, identical-title akron_library pairs): published
 * twice by mistake, safe to collapse. Same-source + different-second within a
 * bucket is the sibling-session shape (distinct real events: age-banded story
 * times, sequential class sessions, 7:30/9:30pm comedy shows, 7am/8:30am yoga
 * classes, or two distinct performers under one festival umbrella) —
 * collapsing it PERMANENTLY DELETES a real event.
 *
 * This check is unconditional and sits UPSTREAM of the cap (see main()), so a
 * cap large enough to fit the whole plan — the 2026-07-28 incident's
 * `--max-deletes=207` for a 188-delete plan — can never disable it: unlike
 * `groupConfidenceTier`'s tier gate, which lives INSIDE `selectPlansWithinCap`
 * and is only consulted once `plannedDeletes > cap`.
 *
 * A predicate on CAUSE, not STATE: it doesn't key off delete counts or the
 * cap, so it survives re-scraping. Groups it flags are not suppressed —
 * they're routed to the printed report for a human, indefinitely, until a
 * dedicated same-second recovery pass (same source + same location key +
 * exact same second + identical normalized title — NOT this function, and
 * NOT built by loosening any pass's different-source guard) picks up the
 * genuine cosmetic dupes among them.
 *
 * Pure + exported for tests.
 */
export function hasSiblingSessionRisk(group) {
  if (!Array.isArray(group) || group.length < 2) return false
  const secondsBySource = new Map()
  for (const e of group) {
    if (!secondsBySource.has(e.source)) secondsBySource.set(e.source, new Set())
    secondsBySource.get(e.source).add(toSecondKey(e.start_at))
  }
  return [...secondsBySource.values()].some((secs) => secs.size > 1)
}

const hasGoodDesc = (e) => !!(e.description && e.description.trim().length > 20)

function qualityLabel(e) {
  const img  = e.image_url ? '✓img' : ' img'
  const desc = hasGoodDesc(e) ? '✓desc' : ' desc'
  return `${img} ${desc}`
}

/**
 * Turn one duplicate group into a self-contained PLAN: which row survives,
 * which rows would be deleted, the aliases/field merges/link donations that go
 * with those deletes, and the group's confidence tier.
 *
 * Nothing here touches the DB or prints; a plan is inert until it is selected
 * and flattened. That is what makes a partial drain safe — a deferred group
 * contributes NOTHING (no delete, no alias, no field merge, no link donation).
 * Donating a deferred group's links would be actively harmful: the dupe
 * survives the run, and once the canonical has borrowed its venue link the two
 * rows re-bucket differently on the next run.
 *
 * Pure + exported for tests.
 */
export function buildGroupPlan(group) {
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
    if (hasImage && hasGoodDesc(e)) return 0   // best
    if (hasImage || hasGoodDesc(e)) return 1
    return 2                                   // worst
  }
  // A placeholder-time copy (CVB 09:00 default, etc.) must never be chosen
  // canonical when a trusted-time copy exists — otherwise the surviving row
  // would carry the fabricated time. It still donates its image/description
  // to the canonical via the merge step below.
  // A venue-less copy (Pass 4) must never be chosen canonical over the
  // venue-linked row — the whole point is to keep the row that has a venue.
  const venueScore = (e) => (e.event_venues?.[0]?.venue_id ? 0 : 1)
  const sorted = [...group].sort((a, b) => {
    const lcDiff = (isLowConfidenceAggregatorTime(a) ? 1 : 0) - (isLowConfidenceAggregatorTime(b) ? 1 : 0)
    if (lcDiff !== 0) return lcDiff
    const vDiff = venueScore(a) - venueScore(b)
    if (vDiff !== 0) return vDiff
    const scoreDiff = dataScore(a) - dataScore(b)
    if (scoreDiff !== 0) return scoreDiff
    return priority(a.source) - priority(b.source)
  })
  const canonical = sorted[0]
  const dupes     = sorted.slice(1)

  // Collect fields the canonical is missing but a dupe can supply.
  // We merge image_url and description rather than losing them on deletion.
  const mergeFields = {}
  for (const d of dupes) {
    if (!canonical.image_url && d.image_url && !mergeFields.image_url) {
      mergeFields.image_url = d.image_url
    }
    if (!hasGoodDesc(canonical) && hasGoodDesc(d) && !mergeFields.description) {
      mergeFields.description = d.description
    }
  }

  // manual_overrides rows are NEVER deleted, selected or deferred — they are
  // preserved, keep their own junction links, and never donate.
  const preservedRows = dupes.filter(hasManualOverrides)
  const donors        = dupes.filter((d) => !hasManualOverrides(d))
  const { venueIds: donatedVenueIds, orgIds: donatedOrgIds } =
    collectLinkDonations(canonical, donors)

  // Computed before aliasRows below so buildAliasRow can tag provenance —
  // both are cheap pure derivations of `group`/`canonical`, not writes.
  const tier = groupConfidenceTier(group)
  const siblingSessionRisk = hasSiblingSessionRisk(group)

  return {
    canonical,
    dupes,
    preservedRows,
    preservedCount: preservedRows.length,
    deleteIds:   donors.map((d) => d.id),
    deletedRows: donors,
    // Record the dropped dup → keeper mapping so ingest won't resurrect it.
    // Tagged with tier + same/cross-source provenance so a future incident
    // (like 2026-07-28's 188-delete run) can be audited with a query instead
    // of reconstructing it from stdout.
    aliasRows: donors.map((d) => buildAliasRow(canonical.id, d, tier, canonical.source)).filter(Boolean),
    mergeFields,
    donatedVenueIds,
    donatedOrgIds,
    tier,
    // See hasSiblingSessionRisk: true when this group must never auto-delete
    // regardless of the cap. main() partitions on this BEFORE calling
    // selectPlansWithinCap so it can never be defeated by a sufficiently
    // large --max-deletes.
    siblingSessionRisk,
  }
}

/**
 * Choose which plans a single run may execute, given the delete-count cap.
 *
 * Under (or at) the cap this is a no-op: the SAME array is returned, in the
 * same order, with nothing dropped — a normal night behaves exactly as before.
 *
 * Over the cap, the run drains partially instead of aborting:
 *   • only tier 0 and tier 1 groups are eligible (see groupConfidenceTier),
 *   • groups are taken WHOLE — never split, so a group's deletes, aliases,
 *     field merges and link donations always happen together or not at all,
 *   • ordering is deterministic: (tier, canonical start_at, canonical id),
 *   • a group that would overflow the remaining budget is skipped, not
 *     truncated, and a smaller later group may still fit.
 *
 * Everything not selected is deferred to the next run, which re-derives the
 * whole plan from scratch — deferral loses nothing but a night.
 *
 * Pure + exported for tests.
 *
 * @returns {{selected: object[], deferred: object[], plannedDeletes: number,
 *            selectedDeletes: number, deferredDeletes: number, capped: boolean}}
 */
export function selectPlansWithinCap(plans, cap) {
  const plannedDeletes = plans.reduce((n, p) => n + p.deleteIds.length, 0)
  if (plannedDeletes <= cap) {
    return {
      selected: plans, deferred: [],
      plannedDeletes, selectedDeletes: plannedDeletes, deferredDeletes: 0,
      capped: false,
    }
  }

  const startTs = (p) => {
    const t = new Date(p.canonical?.start_at).getTime()
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
  }
  const ordered = [...plans].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    const ta = startTs(a), tb = startTs(b)
    if (ta !== tb) return ta - tb
    const ia = String(a.canonical?.id ?? ''), ib = String(b.canonical?.id ?? '')
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })

  const chosen = new Set()
  const selected = []
  let budget = cap
  for (const p of ordered) {
    if (p.tier > 1) continue
    const n = p.deleteIds.length
    if (n > budget) continue          // skip, never truncate — a smaller group may still fit
    budget -= n
    chosen.add(p)
    selected.push(p)
  }

  const selectedDeletes = cap - budget
  return {
    selected,
    deferred: plans.filter((p) => !chosen.has(p)),
    plannedDeletes,
    selectedDeletes,
    deferredDeletes: plannedDeletes - selectedDeletes,
    capped: true,
  }
}

/**
 * Classify what a run's cap actually DID, so the caller can pick an exit code.
 * Three states, and telling the middle one from the last one is the whole
 * point:
 *
 *   'uncapped'      — the plan fit under the cap; every group ran. Exit 0.
 *   'partial-drain' — over the cap, but at least one group drained. Healthy:
 *                     the backlog shrinks tonight and the remainder is
 *                     re-planned from scratch next run. Exit 0.
 *   'stalled'       — over the cap and ZERO deletes selected. Every remaining
 *                     group is tier ≥ 2 (never eligible) or individually
 *                     bigger than the cap (never fits), so nothing about the
 *                     next run will differ: the backlog can never shrink on
 *                     its own. That is the original "nightly dedupe does
 *                     nothing forever" bug — it must NOT be reported green,
 *                     so the caller exits non-zero.
 *
 * Pure + exported for tests.
 *
 * @returns {'uncapped'|'partial-drain'|'stalled'}
 */
export function capRunOutcome({ capped, selectedDeletes }) {
  if (!capped) return 'uncapped'
  return selectedDeletes > 0 ? 'partial-drain' : 'stalled'
}

/**
 * Flatten selected plans into the flat work lists the apply phase consumes.
 * Only ever called with the SELECTED plans, which is precisely how deferred
 * groups contribute zero deletes, zero aliases, zero merges and zero
 * donations. Pure + exported for tests.
 */
export function flattenPlans(plans) {
  const deletes     = []
  const deletedRows = []
  const aliasRows   = []
  const merges      = []   // { id, fields }        — canonicals needing a field merge
  const linkMerges  = []   // { id, venueIds, orgIds } — links donated by deleted dupes
  for (const p of plans) {
    deletes.push(...p.deleteIds)
    deletedRows.push(...p.deletedRows)
    aliasRows.push(...p.aliasRows)
    if (Object.keys(p.mergeFields).length > 0) merges.push({ id: p.canonical.id, fields: p.mergeFields })
    if (p.donatedVenueIds.length > 0 || p.donatedOrgIds.length > 0) {
      linkMerges.push({ id: p.canonical.id, venueIds: p.donatedVenueIds, orgIds: p.donatedOrgIds })
    }
  }
  return { deletes, deletedRows, aliasRows, merges, linkMerges }
}

/**
 * Print one group's plan. `status` is one of:
 *   'selected' — will DROP the non-canonical rows this run
 *   'deferred' — over the cap, DEFER'd to the next run (which re-plans from
 *                scratch — this is a normal, healthy, temporary state)
 *   'unsafe'   — a source within the group spans more than one start second
 *                (see hasSiblingSessionRisk). NEVER auto-deleted by any cap.
 *                Deliberately NOT labelled DEFER: DEFER implies "the next run
 *                handles it automatically," which is false here — this group
 *                needs a human, indefinitely, until a dedicated same-second
 *                recovery pass exists.
 */
function printPlan(plan, status) {
  const { canonical, dupes, mergeFields, donatedVenueIds, donatedOrgIds, tier } = plan
  const mergeParts = Object.keys(mergeFields)
  if (donatedVenueIds.length > 0) mergeParts.push(`venue link×${donatedVenueIds.length}`)
  if (donatedOrgIds.length > 0)   mergeParts.push(`org link×${donatedOrgIds.length}`)
  const mergeNote = status === 'selected' && mergeParts.length > 0 ? ` [will merge: ${mergeParts.join(', ')}]` : ''

  const bannerByStatus = {
    deferred: '   ⏭ DEFERRED (over cap — retried next run)',
    unsafe:   '   🛑 NEEDS HUMAN REVIEW (a source spans more than one start second — never auto-deleted)',
    selected: '',
  }
  const groupVenueId = canonical.event_venues?.[0]?.venue_id
  console.log(`Group: ${canonical.start_at}  venue=${groupVenueId ? groupVenueId.slice(0, 8) + '…' : '(none)'}  tier=${tier}${bannerByStatus[status]}`)
  console.log(`  KEEP  [${canonical.source}/${canonical.source_id}] (${qualityLabel(canonical)})${mergeNote} ${canonical.title?.slice(0, 50)}`)
  for (const d of dupes) {
    const tagByStatus = { selected: 'DROP', deferred: 'DEFER', unsafe: 'HOLD (needs review)' }
    const tag = hasManualOverrides(d) ? '🛡 KEEP (manual_overrides)' : tagByStatus[status]
    console.log(`  ${tag.padEnd(26)} [${d.source}/${d.source_id}] (${qualityLabel(d)}) ${d.title?.slice(0, 50)}`)
  }
}

async function main() {
  const runStart = Date.now()
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
      // organizations(name) is needed by collectLinkDonations' self-credit
      // guard — donation legitimacy depends on the org's NAME, not just its id.
      .select('id, title, description, image_url, start_at, source, source_id, ticket_url, manual_overrides, event_venues(venue_id, venues(name, address)), event_organizations(organization_id, organizations(name))')
      // `id` tiebreaker makes the page ordering STABLE. Without it, rows that
      // share a start_at (very common — venues cluster on the hour) have
      // nondeterministic order between the separate per-page queries, so
      // events at page boundaries can be silently skipped — and a skipped
      // event means its duplicate partner survives the whole run.
      .order('start_at', { ascending: true })
      .order('id', { ascending: true })
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

  // Build an inert plan per group first, then decide which plans this run may
  // execute. Nothing is printed or flattened until the cap has had its say, so
  // a deferred group can't leak a field merge or a link donation.
  const plans = dupeGroups.map(buildGroupPlan)
  const preserved = plans.reduce((n, p) => n + p.preservedCount, 0)

  // Partition out groups that must NEVER auto-execute, regardless of the cap
  // (see hasSiblingSessionRisk's doc comment). Done HERE, upstream of
  // selectPlansWithinCap, so a --max-deletes large enough to fit the whole
  // remaining plan can never disable this again — which is exactly the
  // mechanism of the 2026-07-28 incident: every sibling-session-risk group is
  // tier ≥ 2, and the tier filter inside selectPlansWithinCap (`if (p.tier >
  // 1) continue`) is only reachable on the OVER-cap path. That morning's
  // `--max-deletes=207` fit the whole 188-delete plan, so `plannedDeletes <=
  // cap` returned early and the tier filter never ran.
  //
  // selectPlansWithinCap itself is intentionally untouched — it carries the
  // partial-drain/stall exit-code contract that run-all.js's red/green logic
  // depends on. The at-risk groups are removed from ITS INPUT instead, so
  // they can never be selected and never inflate `plannedDeletes` below.
  const siblingRiskPlans = plans.filter((p) => p.siblingSessionRisk)
  const eligiblePlans    = plans.filter((p) => !p.siblingSessionRisk)

  // Safety cap. Unattended callers (run-all.js, the nightly Actions workflow)
  // always pass --apply, so this is the only thing standing between a matching
  // bug and a mass delete. Resolved BEFORE the plan is printed because it now
  // decides what the printed plan says (DROP vs DEFER).
  const maxDeletesArg = process.argv.find((a) => a.startsWith('--max-deletes='))?.split('=')[1]
  const maxDeletes = resolveMaxDeletesCap({
    argValue: maxDeletesArg,
    envValue: process.env.DEDUPE_MAX_DELETES,
    uniqueLength: unique.length,
  })

  const {
    selected, deferred, plannedDeletes, selectedDeletes, deferredDeletes, capped,
  } = selectPlansWithinCap(eligiblePlans, maxDeletes)
  const selectedSet = new Set(selected)
  for (const plan of plans) {
    printPlan(plan, plan.siblingSessionRisk ? 'unsafe' : (selectedSet.has(plan) ? 'selected' : 'deferred'))
  }
  if (siblingRiskPlans.length > 0) {
    const siblingRiskDeletes = siblingRiskPlans.reduce((n, p) => n + p.deleteIds.length, 0)
    console.log('')
    console.log(`🛑  ${siblingRiskPlans.length} group(s) / ${siblingRiskDeletes} row(s) tagged NEEDS HUMAN REVIEW above: a source within the group spans more than one start second. These are the sibling-session shape (age-banded story times, sequential class sessions, differently-timed comedy/yoga sessions, distinct performers under one festival umbrella), not disagreeing duplicates — they are NEVER auto-deleted by any cap, at ANY group size (not just single-source groups), and are NOT counted in the ${plannedDeletes} planned below.`)
  }

  const { deletes, deletedRows, aliasRows, merges, linkMerges } = flattenPlans(selected)

  // Cap invariant — asserted HERE, the instant selection is flattened and
  // BEFORE this run performs a single write of any kind (in dry-run mode too:
  // nothing downstream is reachable without passing it).
  //
  // It used to live with the other runtime invariants further down, i.e. AFTER
  // the audit write, the canonical field merges, the junction-link donations
  // and the alias upsert had all landed. If selection were ever wrong, all of
  // those would have committed and only the deletes would abort — leaving
  // canonicals enriched with content and holding venue/org links donated by
  // dupes that then SURVIVED, which re-buckets both rows together on the next
  // run. A cap breach means the selection logic is broken; when the plan can't
  // be trusted, nothing derived from it may be written.
  if (deletes.length > maxDeletes) {
    console.error(`✗  Cap violation: selection produced ${deletes.length} deletes with a cap of ${maxDeletes}.`)
    console.error(`   Aborting before any write — nothing deleted, merged, donated, or aliased.`)
    process.exit(1)
  }

  // A canonical may appear in `merges`, `linkMerges`, or both — count it once.
  const enrichedCount = new Set([...merges, ...linkMerges].map(m => m.id)).size
  const totalToDelete = deletes.length

  const holdSummary = siblingRiskPlans.length > 0
    ? `, ${siblingRiskPlans.length} group(s) held for NEEDS HUMAN REVIEW`
    : ''
  console.log('')
  console.log(`Summary: ${totalToDelete} to delete, ${enrichedCount} to enrich, ${preserved} preserved by manual_overrides${holdSummary}`)
  const outcome = capRunOutcome({ capped, selectedDeletes })
  if (outcome === 'partial-drain') {
    // Not an error: the cap is doing its job, the run drains what it safely
    // can and the rest is re-planned from scratch on the next run. Exiting
    // non-zero here would redden the entire nightly chain (run-all.js treats
    // any dedupe failure as a run failure) for a healthy backlog.
    console.log(`⚠  PARTIAL DRAIN (healthy): deleting ${selectedDeletes} of ${plannedDeletes} planned (cap ${maxDeletes}); ${deferred.length} group(s) deferred to the next run`)
    console.log(`   The backlog shrinks by ${selectedDeletes} tonight. Deferred groups are either lower-confidence (tier ≥ 2) or didn't fit the remaining budget; nothing is merged or donated for them.`)
    console.log(`   To see what a larger cap WOULD additionally include, first DRY RUN it (no --apply, nothing is written):`)
    console.log(`     node scripts/dedupe-cross-source.js --max-deletes=${plannedDeletes}`)
    console.log(`   Raising --max-deletes past the planned count does not just widen the budget — it takes the run off the capped path entirely, and EVERY group runs regardless of tier. That is the 2026-07-28 incident (--max-deletes=207 for a 188-delete plan deleted 73 same-source, largely distinct events). The tier filter is a prioritisation heuristic for over-cap runs, not a confidence gate; the only unconditional gate is the NEEDS HUMAN REVIEW hold. Never guess a bigger cap from this number.`)
  } else if (outcome === 'stalled') {
    // The terminal state a partial drain converges on: the eligible (tier ≤ 1)
    // backlog is fully drained and everything left is tier ≥ 2 or too big to
    // fit, so this run deleted NOTHING and every future run will do exactly
    // the same. Green here would mean "nightly dedupe does nothing forever,
    // reported as success" — the precise bug the partial drain exists to fix.
    // Exit 1 so run-all.js (which always treats a dedupe non-zero as a run
    // failure) turns the nightly red until a human drains it.
    //
    // This fires in DRY RUN too, and deliberately: the stall is decided
    // entirely during planning, before --apply is ever consulted, so a dry run
    // is a faithful preview of the apply run's exit code. No unattended caller
    // runs this script without --apply (run-all.js/scrape:all always pass it),
    // so a red dry run can only ever be a human asking "is dedupe stuck?" and
    // getting the honest answer.
    console.error(`✗  DEDUPE STALLED — deleted 0 of ${plannedDeletes} planned (cap ${maxDeletes}).`)
    console.error(`   All ${deferred.length} remaining group(s) are lower-confidence (tier ≥ 2) or individually larger than the cap, so NO group is eligible to drain — this run did nothing and the next run will do nothing, forever. The backlog cannot shrink on its own.`)
    console.error(`   This is NOT a partial drain: a healthy capped run deletes at least one group and exits 0.`)
    console.error(`   Do NOT raise --max-deletes to ${plannedDeletes} to clear this. It does not widen the budget — once plannedDeletes <= cap the run leaves the capped path and EVERY remaining group is deleted regardless of tier. That is the 2026-07-28 incident (--max-deletes=207 for a 188-delete plan deleted 73 same-source, largely distinct events).`)
    console.error(`   Review the plan above FIRST, as a DRY RUN (no --apply):`)
    console.error(`     node scripts/dedupe-cross-source.js --max-deletes=${plannedDeletes}`)
    console.error(`   The tier >= 2 filter is a prioritisation heuristic for over-cap runs, not a confidence gate — only the NEEDS HUMAN REVIEW hold survives any cap. Draining what is left is a manual, reviewed decision, group by group.`)
    process.exit(1)
  }

  if (!APPLY) {
    console.log('')
    console.log(`(Dry run — pass --apply to delete ${totalToDelete} and enrich ${enrichedCount} canonical events.)`)
    return
  }

  // Audit trail (sync fs write) — written FIRST, before anything below
  // mutates the database. `deletedRows` is fully computed above (nothing
  // past this point can change which rows are being deleted), so this is
  // the earliest point the write can happen, and that's the point: it's the
  // synchronous fail-fast gate for the ENTIRE apply phase. mkdirSync/
  // writeFileSync throw on failure (disk full, perms) and nothing here
  // catches that — it propagates to main().catch(), which exits BEFORE the
  // field merges, junction-link donations, alias recording, and delete loop
  // below ever run. If we can't prove what's about to be deleted, we mutate
  // nothing.
  //
  // This write used to sit after the field merges and junction-link
  // donations below. That was a real gap: if writeFileSync threw there,
  // canonicals had already been enriched with content and links donated
  // from dupes that then survived (the delete loop never ran) — leaving
  // both rows on the same venue to re-group on the next run. Moving the
  // write here closes that gap.
  //
  // scrape-reports/ is gitignored and already uploaded as a workflow
  // artifact by the nightly Actions job, so this survives an unattended run
  // without needing a git write. The repo is public and that artifact is
  // downloadable for 30 days, so the payload is pinned to AUDIT_FIELDS
  // rather than serializing the full row — a future `.select()` change to
  // the query above can't silently widen what leaves the runner. The
  // filename carries a run timestamp (not just the Eastern date) so a
  // same-day rerun can't silently overwrite an earlier run's audit file.
  if (deletedRows.length > 0) {
    mkdirSync(REPORT_DIR, { recursive: true })
    const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
    const deletionsPath = join(REPORT_DIR, `dedupe-deletions-${easternTodayIso()}-${runStamp}.json`)
    const auditRows = deletedRows.map((row) =>
      Object.fromEntries(AUDIT_FIELDS.map((f) => [f, row[f]]))
    )
    writeFileSync(deletionsPath, JSON.stringify(auditRows, null, 2))
    console.log(`📝  Wrote ${deletedRows.length} planned-deletion row(s) to ${deletionsPath}`)
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

  // Donate junction links from soon-to-be-deleted dupes to canonicals that
  // have none, BEFORE the deletes below cascade those junction rows away.
  // Only ever fires when the canonical had zero links of that type, so plain
  // inserts cannot collide with existing rows.
  if (linkMerges.length > 0) {
    let linked = 0
    for (const { id, venueIds, orgIds } of linkMerges) {
      let ok = true
      if (venueIds.length > 0) {
        const { error } = await supabaseAdmin
          .from('event_venues')
          .insert(venueIds.map(venue_id => ({ event_id: id, venue_id })))
        if (error) { console.warn(`  ⚠ Venue-link donation failed for ${id}: ${error.message}`); ok = false }
      }
      if (orgIds.length > 0) {
        const { error } = await supabaseAdmin
          .from('event_organizations')
          .insert(orgIds.map(organization_id => ({ event_id: id, organization_id })))
        if (error) { console.warn(`  ⚠ Org-link donation failed for ${id}: ${error.message}`); ok = false }
      }
      if (ok) linked++
    }
    console.log(`✅  Donated junction links to ${linked} canonical event(s).`)
  }

  // Alias recording (async DB upsert) — runs after the merges/link donations
  // and before the delete loop. It's safe to run here because canonicals are
  // never deleted by this script, so every canonical_event_id an alias
  // references still exists both now and after the delete loop runs below.
  //
  // recordAliases() no longer fails soft (see its definition above): a
  // write error now aborts the whole run instead of being swallowed into a
  // console.warn. Deleting with zero alias coverage is exactly the
  // resurrection bug `feffef9` exists to fix — a transient PostgREST error
  // here must not let the delete loop proceed. Aborting costs one night of
  // surviving dupes (the upsert is idempotent; the next run retries and
  // catches up); NOT aborting costs deleted rows coming back with new UUIDs
  // on the next scrape (URL, permalink, and analytics churn).
  if (aliasRows.length > 0) {
    const { recorded, error } = await recordAliases(aliasRows)
    if (error) {
      console.error(`✗  Alias recording failed: ${error.message}`)
      console.error(`   Deleting NOTHING — deleting without aliases resurrects every dup on the next scrape.`)
      process.exit(1)
    }
    console.log(`✅  Recorded ${recorded} event alias(es).`)
  }

  // Runtime invariants — this exact wiring (audit rows line up with the
  // delete-id list, no manual_overrides row ever reaches the delete list,
  // every delete has an alias) can't be integration-tested without --apply,
  // so assert it holds on every real run, immediately before the delete loop.
  if (deletes.length !== deletedRows.length) {
    console.error(`✗  Audit/delete mismatch: ${deletes.length} ids vs ${deletedRows.length} rows. Deleting nothing.`)
    process.exit(1)
  }
  // (The cap invariant is NOT re-checked here — it is asserted immediately
  // after flattenPlans, before any write, so that a breach can't leave field
  // merges and donated links behind. See the comment there.)
  const shielded = deletedRows.filter(hasManualOverrides)
  if (shielded.length > 0) {
    console.error(`✗  ${shielded.length} manual_overrides row(s) reached the delete list. Deleting nothing.`)
    process.exit(1)
  }
  if (aliasRows.length < deletes.length) {
    console.warn(`  ⚠ ${deletes.length - aliasRows.length} row(s) will be deleted with no alias (null source_id) — these can resurrect.`)
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
  if (deleted === 0) console.log('Nothing to delete.')
  else console.log(`✅  Deleted ${deleted} events. Junction-table rows cascaded.`)

  // Record the pass in scraper_runs like every scraper does. Before this,
  // a dedupe crash at the end of a scrape:all / run-all chain was completely
  // invisible — no row anywhere said whether dedupe ever completed.
  // Columns repurposed: updated = canonicals enriched, skipped = dupes deleted.
  // `deferredDeletes` records the backlog a capped run left behind — a capped
  // run is green, so without it a standing backlog reads as a clean night.
  // NOTE: logUpsertResult currently only forwards status/errorMessage/
  // durationMs/eventsFound to scraper_runs (there is no column for this yet),
  // so today this is carried for the caller/meta contract only; the visible
  // signal is the "Plan exceeded cap" line above and the run's stdout.
  await logUpsertResult('dedupe_cross_source', 0, enrichedCount, deleted, {
    eventsFound: dupeGroups.length,
    deferredDeletes,
    durationMs:  Date.now() - runStart,
  })
}

// Run only when invoked directly (`node scripts/dedupe-cross-source.js`);
// importing the module (tests) must never trigger a live dedupe — the same
// import-safety contract every scraper follows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error('Dedupe failed:', err)
    // Surface the failure in scraper_runs so a broken dedupe step at the end
    // of a chain shows up in health checks instead of failing silently.
    try { await logScraperError('dedupe_cross_source', err) } catch { /* best effort */ }
    process.exit(1)
  })
}
