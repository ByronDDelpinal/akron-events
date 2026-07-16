// select.ts — pure, dependency-free event matching + digest selection.
//
// This module holds the brains of the digest: which events a subscriber
// matches, and which ~14 of them actually go in the email. It imports
// nothing (no Deno, no Supabase, no network) so it runs identically in
// the edge function and in a plain Node unit test (see
// scripts/tests/test-digest-selection.mjs).
//
// Everything here is in-memory CPU over the single events query the
// edge function already makes — zero extra DB calls, which matters: the
// project runs on a non-profit budget.

export interface Event {
  id: string
  title: string
  description: string | null
  start_at: string
  end_at: string | null
  category: string        // primary content category (shim; = categories[0])
  categories: string[]    // 1–2 content categories from event_categories
  tags: string[]
  price_min: number | null
  price_max: number | null
  age_restriction: string
  image_url: string | null
  ticket_url: string | null
  featured: boolean
  // Venue/org carry image_url so the email's image-resolution helper can
  // walk event → venue → organizer when the event has no image of its own.
  venues: { name: string; address: string | null; lat: number | null; lng: number | null; image_url: string | null }[]
  organizations: { id: string; name: string; image_url: string | null }[]
}

export interface Subscriber {
  id: string
  email: string
  frequency: string
  lookahead_days: number
  preferences: {
    intents: string[]
    categories: string[]
    venue_ids: string[]
    org_ids: string[]
    price_max: number | null
    age_restriction: string | null
    event_days: number[]
    location: {
      mode: string
      areas?: { lat: number; lng: number; label: string }[]
      lat?: number
      lng?: number
      radius_miles: number
      label?: string
    } | null
    keywords: string[]
    keywords_title_only: boolean
  }
  token: string
}

// ── Selection tuning ─────────────────────────────────────────────────
// Rich image-card "picks" — the entire body of the email. There is no
// plain-text tail: an "also coming up" list used to run under the picks,
// removed 2026-07-15 as unhelpful filler. Everything that ships now is a
// card, which means every event in the email has a real image.
export const MAX_EVENTS_PER_EMAIL = 14
// Diversity cap: at most this many picks from one organizer/venue, so a
// single high-volume org can't crowd out the rest of the region.
export const MAX_PER_ORG = 2

// Quality weights. Stable, audience-appropriate signals — kept small and
// named so they're easy to tune and assert on. Featured events are
// handled separately (they become the hero card), not scored here.
//
// NOTE: there is deliberately no `hasImage` weight. Having an image is a
// HARD GATE on rich cards (see selectDigestEvents), not a preference — so
// every event scored here already has one, and a weight would add the
// same constant to all of them. It previously lived here as `hasImage: 6`,
// which could only ever *rank* an image-less event lower, never exclude
// it: that's how a featured event with no image became a hero card
// rendering a bare gradient placeholder. A score cannot express "never".
export const SCORE = {
  free: 8,        // free events are a headline feature for this audience
  described: 3,   // a non-trivial description signals a complete listing
  ticketed: 2,    // a ticket link signals a "real", actionable event
  jitter: 4,      // seeded rotation: breaks ties + freshens day to day
} as const

// ── Geo + calendar helpers (pure) ────────────────────────────────────
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959 // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

// ── Matcher ──────────────────────────────────────────────────────────
// Returns EVERY event in the subscriber's window that matches their
// preferences (or keywords), de-duped and ordered by start time. No cap:
// the caller uses the full length as the true "N events" count, and
// selectDigestEvents() does the windowed, diversity-aware pick.
export function filterEventsForSubscriber(allEvents: Event[], sub: Subscriber, now: Date): Event[] {
  const prefs = sub.preferences
  const startWindow = now
  let endWindow: Date

  if (sub.frequency === 'monthly') {
    endWindow = new Date(now.getFullYear(), now.getMonth(), lastDayOfMonth(now.getFullYear(), now.getMonth()), 23, 59, 59)
  } else {
    endWindow = new Date(now.getTime() + sub.lookahead_days * 86400000)
  }

  const preferenceMatched = allEvents.filter(event => {
    const eventStart = new Date(event.start_at)

    // Date window
    if (eventStart < startWindow || eventStart > endWindow) return false

    // Event day-of-week filter
    const eventDay = eventStart.getDay()
    if (!prefs.event_days.includes(eventDay)) return false

    // Intents/categories (skip if "all"). Match if ANY content category overlaps.
    if (!prefs.intents.includes('all') && prefs.categories.length > 0) {
      const cats = event.categories ?? []
      if (!cats.some((c) => prefs.categories.includes(c))) return false
    }

    // Venue filter (empty = all venues)
    if (prefs.venue_ids.length > 0) {
      const eventVenueIds = event.venues.map((v: any) => v.id).filter(Boolean)
      if (!eventVenueIds.some((vid: string) => prefs.venue_ids.includes(vid))) return false
    }

    // Organization filter (empty = all orgs)
    if (prefs.org_ids.length > 0) {
      const eventOrgIds = event.organizations.map((o: any) => o.id).filter(Boolean)
      if (!eventOrgIds.some((oid: string) => prefs.org_ids.includes(oid))) return false
    }

    // Price filter
    if (prefs.price_max !== null) {
      if ((event.price_min ?? 0) > prefs.price_max) return false
    }

    // Age restriction filter
    if (prefs.age_restriction) {
      if (prefs.age_restriction === 'all_ages' && event.age_restriction !== 'all_ages' && event.age_restriction !== 'not_specified') return false
    }

    // Location filter (haversine, no API)
    if (prefs.location) {
      const venue = event.venues[0]
      if (venue?.lat && venue?.lng) {
        const r = prefs.location.radius_miles
        if (prefs.location.areas && prefs.location.areas.length > 0) {
          const nearAny = prefs.location.areas.some(
            (a) => haversine(a.lat, a.lng, venue.lat!, venue.lng!) <= r
          )
          if (!nearAny) return false
        } else if (prefs.location.lat != null && prefs.location.lng != null) {
          if (haversine(prefs.location.lat, prefs.location.lng, venue.lat, venue.lng) > r) return false
        }
      }
      // If venue has no coords, include it (don't penalize missing data)
    }

    return true
  })

  // Keyword matches — BYPASS all other filters except the date window.
  const keywordMatched: Event[] = []
  if (prefs.keywords.length > 0) {
    for (const event of allEvents) {
      const eventStart = new Date(event.start_at)
      if (eventStart < startWindow || eventStart > endWindow) continue
      if (preferenceMatched.some(pe => pe.id === event.id)) continue

      for (const keyword of prefs.keywords) {
        const kw = keyword.toLowerCase()
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        if (re.test(event.title)) { keywordMatched.push(event); break }
        if (!prefs.keywords_title_only && event.description && re.test(event.description)) { keywordMatched.push(event); break }
      }
    }
  }

  // De-dupe (an event can match both prefs and keywords) and order by start.
  const seen = new Set<string>()
  const combined: Event[] = []
  for (const e of [...preferenceMatched, ...keywordMatched]) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    combined.push(e)
  }
  combined.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
  return combined
}

// ── Scoring + deterministic rotation ─────────────────────────────────
// FNV-1a string hash → 32-bit seed.
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// mulberry32 PRNG → one float in [0, 1). Tiny, fast, deterministic.
function rand01(seed: number): number {
  let a = (seed >>> 0) + 0x6D2B79F5
  let t = Math.imul(a ^ a >>> 15, 1 | a)
  t = (t + Math.imul(t ^ t >>> 7, 61 | t)) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

// Per-event jitter that depends only on (seedBase, event id) — so it's
// independent of iteration order and reproducible. seedBase folds in the
// subscriber + the send date, so the sample rotates each day (a daily
// subscriber sees a fresh slice) without any stored state.
function jitter(seedBase: number, id: string): number {
  return rand01(seedBase ^ hashSeed(id))
}

function isFree(e: Event): boolean {
  return e.price_min === 0 && (e.price_max == null || e.price_max === 0)
}

/**
 * True when a real image resolves for this event. MUST stay in lockstep
 * with resolveEventImage() in index.ts — same event → venue → organizer
 * chain, same http(s) test. If these two ever disagree, the digest will
 * either gate out events it could have rendered, or (worse) admit an
 * event whose card then falls back to the gradient placeholder.
 */
export function hasImage(e: Event): boolean {
  const urls = [e.image_url, e.venues?.[0]?.image_url, e.organizations?.[0]?.image_url]
  return urls.some((u) => !!u && /^https?:\/\//i.test(u))
}

function baseScore(e: Event): number {
  let s = 0
  if (isFree(e)) s += SCORE.free
  if (e.description && e.description.trim().length > 40) s += SCORE.described
  if (e.ticket_url) s += SCORE.ticketed
  return s
}

// Diversity key: prefer organizer id, then venue name, then the title.
export function orgKey(e: Event): string {
  return e.organizations?.[0]?.id || e.venues?.[0]?.name || e.title
}

// ── Event URL ────────────────────────────────────────────────────────
// Canonical event path is /events/{slug}/{id} (see src/lib/slug.js). The
// digest can't import from src/ (Deno + date-fns), so the slug logic is
// mirrored here and guarded by a drift test against slug.js. The id is
// the source of truth — EventPage 301-redirects a stale slug — but the
// slug SEGMENT must be present: a bare /events/{id} hits the slug-only
// router and errors. The date suffix uses Eastern time (the audience TZ)
// to match the links the app itself generates.
const RESERVED_SLUGS = new Set(['submit', 'new', 'edit', 'featured'])

export function makeEventSlug(e: { title?: string | null; start_at?: string | null }): string {
  let titlePart = String(e?.title || 'event')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')

  if (!titlePart) titlePart = 'event'
  if (RESERVED_SLUGS.has(titlePart)) titlePart = `evt-${titlePart}`

  const start = e?.start_at ? new Date(e.start_at) : null
  if (start && !Number.isNaN(start.getTime())) {
    const datePart = start
      .toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
      .toLowerCase()
      .replace(/\s+/g, '-') // "may 28" → "may-28"
    return `${titlePart}-${datePart}`
  }
  return titlePart
}

export function eventPath(e: { id?: string | null; title?: string | null; start_at?: string | null }): string {
  if (!e?.id) return '/'
  return `/events/${makeEventSlug(e)}/${e.id}`
}

// Pick n elements spread evenly across an array (inclusive of both ends),
// preserving order and de-duping any rounding collisions.
function evenSample<T>(arr: T[], n: number): T[] {
  if (n <= 0) return []
  if (arr.length <= n) return arr.slice()
  if (n === 1) return [arr[Math.floor((arr.length - 1) / 2)]]
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * (arr.length - 1) / (n - 1))])
  return [...new Set(out)]
}

// Bucket by the Eastern calendar day (en-CA → YYYY-MM-DD), matching how the
// digest groups events for display. A UTC slice would file an 8 PM-Eastern
// event under the next day and skew the per-day spread.
const dayKeyOf = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

export interface DigestSelection {
  picks: Event[]   // the rich-card events (≤ MAX_EVENTS_PER_EMAIL), chronological
}

/**
 * Choose the events that actually go in the email.
 *
 * Goals, in order: (1) spread across the subscriber's whole window so a
 * high-volume day can't swallow the email, (2) organizer/venue variety,
 * (3) quality, (4) gentle day-to-day rotation. Strategy:
 *
 *   - Reserve the single best featured event as the hero.
 *   - Bucket the rest by day. If there are more days than open slots
 *     (the 30-day "sampler" case), sample days evenly across the window
 *     so coverage reaches the end, not just the front.
 *   - Round-robin one best-scoring, org-allowed event per day before any
 *     day gets a second — temporal spread first, density second.
 *   - Backfill (relaxing the org cap) only if slots remain, so we never
 *     ship a needlessly thin email.
 *
 * Only events with a resolvable image are eligible — see the gate below.
 *
 * Pure and deterministic given (matched, sub.id, now's date).
 */
export function selectDigestEvents(matched: Event[], sub: Subscriber, now: Date): DigestSelection {
  if (matched.length === 0) return { picks: [] }

  // Every event in the email is a rich card, and a card renders an <img>.
  // With no resolvable image a card falls back to a category-colored
  // gradient placeholder, which reads as a broken design in the inbox — so
  // an image is a hard gate here, never merely a score.
  //
  // Since the plain-text tail was removed, this gate is now the email's
  // only door: an event with no image does not appear at all. If nothing
  // is eligible, picks comes back empty and the caller skips the send.
  const cardEligible = matched.filter(hasImage)

  const seedBase = hashSeed(`${sub.id}:${dayKeyOf(now.toISOString())}`)
  const score = (e: Event): number => baseScore(e) + jitter(seedBase, e.id) * SCORE.jitter

  const picks: Event[] = []
  const used = new Set<string>()
  const orgCount = new Map<string, number>()

  const take = (e: Event): boolean => {
    if (used.has(e.id)) return false
    const k = orgKey(e)
    if ((orgCount.get(k) ?? 0) >= MAX_PER_ORG) return false
    picks.push(e)
    used.add(e.id)
    orgCount.set(k, (orgCount.get(k) ?? 0) + 1)
    return true
  }

  // 1) Hero — the best featured event WITH an image renders the hero card.
  //    A featured event with no image is not promoted to hero, and since
  //    the tail is gone it does not appear in the email at all. `featured`
  //    is a request for prominence, not a bypass of the image gate.
  const featured = cardEligible.filter(e => e.featured).sort((a, b) => score(b) - score(a))
  if (featured.length) take(featured[0])

  // 2) Bucket the remaining events by day, best-first within each day.
  const byDay = new Map<string, Event[]>()
  for (const e of cardEligible) {
    if (used.has(e.id)) continue
    const key = dayKeyOf(e.start_at)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(e)
  }
  for (const evs of byDay.values()) evs.sort((a, b) => score(b) - score(a))

  let days = [...byDay.keys()].sort()
  const slotsLeft = MAX_EVENTS_PER_EMAIL - picks.length
  if (days.length > slotsLeft) days = evenSample(days, slotsLeft)

  // 3) Round-robin: one per day before any day gets a second.
  let progressed = true
  while (picks.length < MAX_EVENTS_PER_EMAIL && progressed) {
    progressed = false
    for (const k of days) {
      if (picks.length >= MAX_EVENTS_PER_EMAIL) break
      const bucket = byDay.get(k)!
      while (bucket.length) {
        const e = bucket.shift()!
        if (take(e)) { progressed = true; break }
      }
    }
  }

  // 4) Fill remaining slots from anywhere in the window, STILL honoring
  //    the org cap. This recovers diverse events on days the even
  //    sampling skipped, before we ever relax diversity.
  if (picks.length < MAX_EVENTS_PER_EMAIL) {
    for (const e of cardEligible) {
      if (picks.length >= MAX_EVENTS_PER_EMAIL) break
      take(e)
    }
  }

  // 5) Last resort: only if a handful of orgs dominate the entire window
  //    and we're still short, relax the cap so we never ship a thin email.
  if (picks.length < MAX_EVENTS_PER_EMAIL) {
    for (const e of cardEligible) {
      if (picks.length >= MAX_EVENTS_PER_EMAIL) break
      if (!used.has(e.id)) { picks.push(e); used.add(e.id) }
    }
  }

  // Chronological order for the day-grouped layout.
  picks.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())

  return { picks }
}
