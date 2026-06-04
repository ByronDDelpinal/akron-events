// send-digest — daily cron-triggered function that sends personalized event digests
// Triggered by pg_cron at 8:30 AM ET daily
//
// Architecture (cost-optimized):
//   1. Query WHO is due today (subscribers by frequency + send_day)
//   2. Query ALL published events for next 30 days (ONE query, cached in memory)
//   3. Filter per subscriber in-memory (no additional DB calls)
//   4. Batch send via Resend (100 per API call)
//   5. Log results to email_sends

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'
const BATCH_SIZE = 100
// Top-of-email picks rendered as full image cards. Bumped from 10 to
// 14 after the row-density redesign — events now use a 56px thumb
// instead of 72px and combine date+venue into one meta line, so the
// extra 4 events fit in the same visual budget.
const MAX_EVENTS_PER_EMAIL = 14
// Plain-text "also coming up" list rendered after the picks. Quick
// scroll past the rich-card section gives the reader a sense of depth
// without bloating the email.
const TAIL_EVENT_COUNT = 8

// ── Brand theme (mirrors src/lib/emailTheme.js — update both together) ──
// `from` falls back to RESEND_FROM env var for parity with subscribe
// fn, so a future sender change is one secret update. `replyTo`
// routes replies to a real human inbox; overridable via RESEND_REPLY_TO.
const THEME = {
  brandName: 'Akron Pulse',
  copyrightHolder: 'Akron Pulse',
  location: 'Akron, OH',
  from: Deno.env.get('RESEND_FROM') || 'Akron Pulse <digest@akronpulse.com>',
  replyTo: Deno.env.get('RESEND_REPLY_TO') || 'byron@akronpulse.com',
  colors: {
    primary:       '#0E5163',
    background:    '#FCFAF4',
    card:          '#FFFFFF',
    dark:          '#0A3B48',
    textPrimary:   '#1F2A30',
    textSecondary: '#3E5560',
    textMuted:     '#5F7886',
    border:        '#DAD5C8',
    freeBg:        '#E4F0E6',
    freeTxt:       '#1A5428',
    white:         '#FFFFFF',
  },
  fonts: {
    display: "'Space Grotesk',system-ui,sans-serif",
    body:    "'DM Sans',system-ui,sans-serif",
  },
} as const

// Haversine distance in miles (no API calls)
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959 // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Get last day of a month
function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

interface Event {
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
  // Venue/org now carry image_url so the email's image-resolution
  // helper can walk event → venue → organizer when the event itself
  // has no image of its own. Mirrors the app's `imageUrlForEvent`.
  venues: { name: string; address: string | null; lat: number | null; lng: number | null; image_url: string | null }[]
  organizations: { id: string; name: string; image_url: string | null }[]
}

interface Subscriber {
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
      lat: number
      lng: number
      radius_miles: number
      label: string
    } | null
    keywords: string[]
    keywords_title_only: boolean
  }
  token: string
}

// ── Per-subscriber event filtering (all in-memory) ──
function filterEventsForSubscriber(allEvents: Event[], sub: Subscriber, now: Date): Event[] {
  const prefs = sub.preferences
  const startWindow = now
  let endWindow: Date

  if (sub.frequency === 'monthly') {
    // Monthly: include through last day of current month
    endWindow = new Date(now.getFullYear(), now.getMonth(), lastDayOfMonth(now.getFullYear(), now.getMonth()), 23, 59, 59)
  } else {
    endWindow = new Date(now.getTime() + sub.lookahead_days * 86400000)
  }

  // Events matching structured preferences
  const preferenceMatched = allEvents.filter(event => {
    const eventStart = new Date(event.start_at)

    // Date window
    if (eventStart < startWindow || eventStart > endWindow) return false

    // Event day-of-week filter
    const eventDay = eventStart.getDay()
    if (!prefs.event_days.includes(eventDay)) return false

    // Intents/categories (skip if "all"). Events now carry 1–2 content
    // categories (event.categories); match if ANY overlaps the prefs.
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
      if (event.price_min > prefs.price_max) return false
    }

    // Age restriction filter
    if (prefs.age_restriction) {
      if (prefs.age_restriction === 'all_ages' && event.age_restriction !== 'all_ages' && event.age_restriction !== 'not_specified') return false
    }

    // Location filter (haversine, no API)
    if (prefs.location) {
      const venue = event.venues[0]
      if (venue?.lat && venue?.lng) {
        const dist = haversine(prefs.location.lat, prefs.location.lng, venue.lat, venue.lng)
        if (dist > prefs.location.radius_miles) return false
      }
      // If venue has no coords, include it (don't penalize missing data)
    }

    return true
  })

  // Keyword matches — BYPASS all other filters (except date window)
  const keywordMatched: Event[] = []
  if (prefs.keywords.length > 0) {
    for (const event of allEvents) {
      const eventStart = new Date(event.start_at)
      if (eventStart < startWindow || eventStart > endWindow) continue

      // Skip events already matched by preferences
      if (preferenceMatched.some(pe => pe.id === event.id)) continue

      const titleLower = event.title.toLowerCase()
      const descLower = (event.description || '').toLowerCase()

      for (const keyword of prefs.keywords) {
        const kw = keyword.toLowerCase()
        // Whole-word match using word boundary regex
        const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')

        if (re.test(event.title)) {
          keywordMatched.push(event)
          break
        }
        if (!prefs.keywords_title_only && event.description && re.test(event.description)) {
          keywordMatched.push(event)
          break
        }
      }
    }
  }

  // Combine: preference matches + keyword matches
  const combined = [...preferenceMatched, ...keywordMatched]

  // Sort: featured first (max 1), then by start_at
  combined.sort((a, b) => {
    if (a.featured && !b.featured) return -1
    if (!a.featured && b.featured) return 1
    return new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
  })

  // Cap at MAX_EVENTS_PER_EMAIL
  return combined.slice(0, MAX_EVENTS_PER_EMAIL)
}

// ── Email template helpers ───────────────────────────────────────

// Category → gradient colors for the no-image placeholder. Mirrors
// the gradient palette used in the app, simplified to two stops so
// email clients (which strip CSS gradients only sometimes) can
// fall back to the first color as a solid. Lock these in sync with
// src/styles/globals.css if the brand palette shifts.
const CATEGORY_GRADIENT: Record<string, [string, string]> = {
  music:     ['#162806', '#2A5C18'],
  art:       ['#180A26', '#481870'],
  community: ['#082010', '#186030'],
  nonprofit: ['#180808', '#501828'],
  food:      ['#082010', '#186030'],
  sports:    ['#081828', '#1040A0'],
  fitness:   ['#0A2818', '#18784A'],
  education: ['#100828', '#2E1060'],
  nature:    ['#1A2A0E', '#4A6818'],
  other:     ['#1D2B1F', '#3A6B4A'],
}

// Display labels for the no-image placeholder. Single word per
// category, short enough to render at any thumb size.
const CATEGORY_LABEL: Record<string, string> = {
  music: 'Music', art: 'Art', community: 'Community', nonprofit: 'Nonprofit',
  food: 'Food', sports: 'Sports', fitness: 'Fitness', education: 'Education',
  nature: 'Nature', other: 'Event',
}

/**
 * Walk the event → venue → organizer fallback chain so the digest
 * always has visual weight. Returns null when nothing usable
 * resolves; the caller renders a colored category placeholder.
 */
function resolveEventImage(e: Event): string | null {
  const candidates = [
    e.image_url,
    e.venues?.[0]?.image_url,
    e.organizations?.[0]?.image_url,
  ]
  for (const url of candidates) {
    if (url && /^https?:\/\//i.test(url)) return url
  }
  return null
}

/**
 * Free/priced helper matching the app's `formatPrice` so an event
 * with `price_max: 0` (which some scrapers emit for free events)
 * still renders as Free in the email. Returns `null` for "no price
 * info" rather than showing "$0" or an empty pill.
 */
function priceLabel(e: Event): { label: string; free: boolean } | null {
  const min = e.price_min
  const max = e.price_max
  if (min == null && max == null) return null
  if (min === 0 && (!max || max === 0)) return { label: 'Free', free: true }
  if (max && max > (min ?? 0)) return { label: `$${min}–$${max}`, free: false }
  if (min != null) return { label: `$${min}`, free: false }
  return null
}

/**
 * Renders the visual block at the head of each card — either the
 * resolved image OR a gradient placeholder labeled with the
 * category. `height` is a fixed value because we don't have image
 * dimensions in the digest path, so we crop to a uniform shape and
 * keep the email height predictable.
 */
function imageBlock(e: Event, opts: { width: string; height: string; radius: string }): string {
  const url = resolveEventImage(e)
  if (url) {
    return `<img src="${url}" alt="" style="display:block;width:${opts.width};height:${opts.height};object-fit:cover;border-radius:${opts.radius};">`
  }
  const [c1, c2] = CATEGORY_GRADIENT[e.category] || CATEGORY_GRADIENT.other
  const label = CATEGORY_LABEL[e.category] || 'Event'
  // Solid bg + linear-gradient: clients that strip gradients
  // (Outlook desktop) fall back to the solid color. Label is
  // legible in either state.
  return `
    <div style="
      display:flex;align-items:center;justify-content:center;
      width:${opts.width};height:${opts.height};border-radius:${opts.radius};
      background:${c1};
      background-image:linear-gradient(135deg, ${c1} 0%, ${c2} 100%);
      color:#FCFAF4;font-family:'Space Grotesk', system-ui, sans-serif;
      font-size:0.78rem;font-weight:700;letter-spacing:0.08em;
      text-transform:uppercase;text-align:center;
    ">${label}</div>
  `
}

/** Group events by their YYYY-MM-DD start day. Order preserved. */
function groupByDay(events: Event[]): { dayKey: string; label: string; events: Event[] }[] {
  const groups = new Map<string, Event[]>()
  for (const e of events) {
    const d = new Date(e.start_at)
    const key = d.toISOString().slice(0, 10)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  return [...groups.entries()].map(([dayKey, evs]) => ({
    dayKey,
    label: new Date(dayKey + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    }),
    events: evs,
  }))
}

function formatTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// ── Build email HTML (inline styles for email client compatibility) ──
// All colors/fonts reference THEME so a brand swap only touches one object.
function buildDigestHtml(events: Event[], sub: Subscriber, totalMatchCount: number, tailEvents: Event[] = []): string {
  const prefsUrl = `${BASE_URL}/subscribe/preferences?token=${sub.token}`
  const unsubUrl = `${BASE_URL}/unsubscribe?token=${sub.token}`
  const c = THEME.colors
  const f = THEME.fonts

  // Featured event becomes the hero; remaining events go into the
  // day-grouped picks list below.
  const hero = events.find(e => e.featured)
  const picks = events.filter(e => e !== hero)
  const dayGroups = groupByDay(picks)

  // Preheader text: hidden span at the very top of the body that
  // mail clients pull into the inbox preview snippet. Without this
  // Gmail just grabs the bare brand wordmark from the header. Keep
  // under ~110 chars so it doesn't get truncated.
  const preheaderBits: string[] = []
  if (hero) preheaderBits.push(`Featured: ${hero.title}`)
  preheaderBits.push(`${events.length} picks${tailEvents.length > 0 ? ` + ${tailEvents.length} more` : ''}`)
  const firstFree = events.find(e => priceLabel(e)?.free)
  if (firstFree && firstFree !== hero) preheaderBits.push(`free: ${firstFree.title}`)
  const preheader = preheaderBits.join(' · ').slice(0, 110)

  let html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${c.background};font-family:${f.body};">

<!-- Preheader (shown by mail clients as the inbox snippet, hidden in the rendered email body). -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${c.background};">
  ${preheader}
</div>

<div style="max-width:560px;margin:0 auto;padding:32px 20px;">

  <div style="text-align:center;margin-bottom:28px;">
    <span style="font-family:${f.display};font-size:1.3rem;font-weight:700;color:${c.dark};letter-spacing:-0.02em;">${THEME.brandName}</span>
  </div>
`

  // Hero event — full-width image (or gradient) on top, content below.
  if (hero) {
    const venue = hero.venues[0]
    const heroUrl = `${BASE_URL}/events/${hero.id}`
    const heroDate = new Date(hero.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const price = priceLabel(hero)
    html += `
  <a href="${heroUrl}" style="display:block;background:${c.card};border-radius:12px;overflow:hidden;margin-bottom:20px;border:1px solid ${c.border};text-decoration:none;color:inherit;">
    ${imageBlock(hero, { width: '100%', height: '200px', radius: '0' })}
    <div style="padding:20px;">
      <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${c.primary};margin-bottom:6px;">Featured</div>
      <div style="font-family:${f.display};font-size:1.1rem;font-weight:700;color:${c.textPrimary};margin-bottom:6px;">${hero.title}</div>
      <div style="font-size:0.82rem;color:${c.textSecondary};margin-bottom:4px;">${heroDate}${venue ? ` · ${venue.name}` : ''}</div>
      ${price ? `<div style="display:inline-block;margin-top:8px;padding:3px 10px;background:${price.free ? c.freeBg : c.primary};color:${price.free ? c.freeTxt : c.white};font-size:0.72rem;font-weight:600;border-radius:10px;">${price.label}</div>` : ''}
      ${hero.ticket_url ? `<span style="display:inline-block;margin-top:10px;padding:8px 18px;background:${c.primary};color:${c.white};text-decoration:none;border-radius:8px;font-size:0.82rem;font-weight:600;">Get Tickets</span>` : ''}
    </div>
  </a>
`
  }

  // Picks — grouped by day. Each row is a compact 56×56 thumb +
  // title + single meta line (time · venue). Same anchor wrapping
  // pattern so the entire row is clickable.
  if (dayGroups.length > 0) {
    html += `<div style="font-family:${f.display};font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.textMuted};border-bottom:1px solid ${c.border};padding-bottom:8px;margin-bottom:16px;">Your picks</div>`

    for (const group of dayGroups) {
      // Per-day header (Sunday, Jun 1) — small uppercase label
      html += `
  <div style="font-family:${f.display};font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${c.primary};margin:18px 0 8px;">
    ${group.label}
  </div>
`
      for (const event of group.events) {
        const venue = event.venues[0]
        const eventUrl = `${BASE_URL}/events/${event.id}`
        const meta = [formatTimeOnly(event.start_at), venue?.name].filter(Boolean).join(' · ')
        const price = priceLabel(event)
        const pills: string[] = []
        if (event.featured) {
          pills.push(`<span style="display:inline-block;margin-top:4px;margin-right:6px;padding:2px 8px;background:${c.primary};color:${c.white};font-size:0.66rem;font-weight:600;border-radius:8px;letter-spacing:0.04em;text-transform:uppercase;">Featured</span>`)
        }
        if (price?.free) {
          pills.push(`<span style="display:inline-block;margin-top:4px;padding:2px 8px;background:${c.freeBg};color:${c.freeTxt};font-size:0.68rem;font-weight:600;border-radius:8px;">Free</span>`)
        } else if (price) {
          pills.push(`<span style="display:inline-block;margin-top:4px;padding:2px 8px;background:${c.background};color:${c.textSecondary};font-size:0.68rem;font-weight:600;border-radius:8px;border:1px solid ${c.border};">${price.label}</span>`)
        }

        html += `
  <a href="${eventUrl}" style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid ${c.border};text-decoration:none;color:inherit;align-items:center;">
    <div style="flex-shrink:0;">${imageBlock(event, { width: '56px', height: '56px', radius: '8px' })}</div>
    <div style="flex:1;min-width:0;">
      <div style="font-family:${f.display};font-size:0.92rem;font-weight:700;color:${c.textPrimary};margin-bottom:2px;line-height:1.3;">${event.title}</div>
      <div style="font-size:0.78rem;color:${c.textSecondary};">${meta}</div>
      ${pills.length > 0 ? `<div>${pills.join('')}</div>` : ''}
    </div>
  </a>
`
      }
    }
  }

  // "Also coming up" — tail of plain-text event links. No images,
  // no metadata clutter; just titles + dates so the reader feels
  // depth without scrolling through more cards.
  if (tailEvents.length > 0) {
    html += `
  <div style="margin-top:28px;padding-top:20px;border-top:1px solid ${c.border};">
    <div style="font-family:${f.display};font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.textMuted};margin-bottom:10px;">Also coming up</div>
`
    for (const event of tailEvents) {
      const eventUrl = `${BASE_URL}/events/${event.id}`
      const date = new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      html += `
    <a href="${eventUrl}" style="display:block;padding:6px 0;text-decoration:none;color:${c.textSecondary};font-size:0.85rem;line-height:1.4;">
      <span style="color:${c.primary};font-weight:600;">${date}</span>
      <span style="color:${c.textMuted};"> · </span>
      <span style="color:${c.textPrimary};">${event.title}</span>
    </a>
`
    }
    html += `  </div>
`
  }

  // See all link
  if (totalMatchCount > events.length) {
    html += `
  <div style="text-align:center;margin:24px 0;">
    <a href="${BASE_URL}" style="display:inline-block;padding:12px 28px;background:${c.dark};color:${c.white};text-decoration:none;border-radius:10px;font-family:${f.display};font-size:0.85rem;font-weight:700;">
      See all ${totalMatchCount} events &rarr;
    </a>
  </div>
`
  }

  // Footer
  html += `
  <div style="text-align:center;padding-top:24px;border-top:1px solid ${c.border};margin-top:24px;">
    <a href="${prefsUrl}" style="color:${c.primary};font-size:0.78rem;font-weight:600;text-decoration:underline;text-underline-offset:2px;">Manage preferences</a>
    <span style="color:${c.border};margin:0 10px;">·</span>
    <a href="${unsubUrl}" style="color:${c.textMuted};font-size:0.78rem;text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a>
    <div style="margin-top:14px;font-size:0.68rem;color:${c.textMuted};">
      &copy; ${new Date().getFullYear()} ${THEME.copyrightHolder} · ${THEME.location}
    </div>
  </div>

</div>
</body></html>`

  return html
}

// ── Subject line builder ──
function buildSubject(frequency: string, eventCount: number): string {
  if (eventCount === 0) return 'No new events this time — we\'ll keep looking!'

  const loc = THEME.location.split(',')[0] // "Akron"
  const s = eventCount !== 1 ? 's' : ''

  switch (frequency) {
    case 'daily':
      return `Tomorrow in ${loc}: ${eventCount} event${s} for you`
    case 'monthly': {
      const month = new Date().toLocaleDateString('en-US', { month: 'long' })
      return `${month} in ${loc}: ${eventCount} event${s} for you`
    }
    default:
      return `Your week in ${loc}: ${eventCount} event${s} for you`
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ── Main handler ──
Deno.serve(async (req) => {
  // Handle CORS preflight (needed for browser calls from admin dashboard)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  // Only allow POST (from pg_cron, admin dashboard, or manual trigger)
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Optional: verify a shared secret for security
  const authHeader = req.headers.get('authorization')
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Check for force mode (admin manual trigger sends to ALL active subscribers)
  let forceAll = false
  try {
    const body = await req.json()
    forceAll = body?.force === true
  } catch {
    // No body or invalid JSON — that's fine, default to scheduled mode
  }

  const now = new Date()
  const todayDow = now.getDay() // 0=Sun..6=Sat
  const isFirstOfMonth = now.getDate() === 1
  const dateStr = now.toISOString().slice(0, 10)

  // Idempotency session tag.
  //
  // Scheduled cron should stay idempotent for a given day — if pg_cron
  // fires twice for the 2026-06-01 run, both attempts produce the same
  // key and Resend / the email_sends upsert silently dedupes. That's
  // the safety net we want.
  //
  // Force mode (manual admin trigger, curl tests, template iteration)
  // intentionally bypasses that safety: every invocation must produce
  // a fresh key so the test can actually send. Otherwise Resend
  // returns 409 invalid_idempotent_request the second time you click
  // "Send digest now" with a new template (which is exactly what we
  // hit when redeploying the email layout). Date.now() per request is
  // sufficient — within a single force run, the chunk index keeps the
  // batches distinct.
  const sessionTag = forceAll ? `force-${Date.now()}` : 'scheduled'

  console.log(`[send-digest] Starting for ${dateStr}, DOW=${todayDow}, 1st=${isFirstOfMonth}, force=${forceAll}, session=${sessionTag}`)

  try {
    // ── Step 1: WHO gets emailed? ──
    let query = supabase
      .from('subscribers')
      .select('id, email, frequency, lookahead_days, preferences, token')
      .eq('confirmed', true)
      .is('unsubscribed_at', null)

    if (!forceAll) {
      // Scheduled mode: only subscribers due today
      // Daily subscribers: always due
      // Weekly subscribers: due if send_day matches today
      // Monthly subscribers: due on the 1st only
      const conditions = [`frequency.eq.daily`]
      conditions.push(`and(frequency.eq.weekly,send_day.eq.${todayDow})`)
      if (isFirstOfMonth) {
        conditions.push(`frequency.eq.monthly`)
      }
      query = query.or(conditions.join(','))
    }

    const { data: subscribers, error: subErr } = await query

    if (subErr) {
      console.error('[send-digest] Subscriber query error:', subErr)
      return json({ error: 'Subscriber query failed' }, 500)
    }

    if (!subscribers || subscribers.length === 0) {
      console.log('[send-digest] No subscribers due today')
      return json({ ok: true, sent: 0, skipped: 0 })
    }

    console.log(`[send-digest] ${subscribers.length} subscribers due`)

    // ── Step 2: WHAT events exist? (ONE query) ──
    const windowEnd = new Date(now.getTime() + 30 * 86400000).toISOString()

    const { data: events, error: evtErr } = await supabase
      .from('events')
      .select(`
        id, title, description, start_at, end_at, tags,
        price_min, price_max, age_restriction, image_url, ticket_url, featured,
        event_categories ( category ),
        event_venues!inner ( venues!inner ( id, name, address, lat, lng, image_url ) ),
        event_organizations ( organizations ( id, name, image_url ) )
      `)
      .eq('status', 'published')
      .gte('start_at', now.toISOString())
      .lte('start_at', windowEnd)
      .order('start_at', { ascending: true })

    if (evtErr) {
      console.error('[send-digest] Events query error:', evtErr)
      return json({ error: 'Events query failed' }, 500)
    }

    // Flatten the joined data for easier filtering
    const flatEvents: Event[] = (events || []).map((e: any) => ({
      ...e,
      categories: (e.event_categories || []).map((ec: any) => ec.category).filter(Boolean),
      // Primary-category shim so gradient/label helpers keep working.
      category: (e.event_categories || [])[0]?.category ?? 'other',
      venues: (e.event_venues || []).map((ev: any) => ev.venues).filter(Boolean),
      organizations: (e.event_organizations || []).map((eo: any) => eo.organizations).filter(Boolean),
    }))

    console.log(`[send-digest] ${flatEvents.length} events in 30-day window`)

    // ── Step 3+4+5: Filter → Render → Batch send ──
    const emailBatch: { from: string; to: string[]; reply_to: string; subject: string; html: string; headers: Record<string, string> }[] = []
    const sendLog: { subscriber_id: string; event_count: number; status: string; error_message?: string }[] = []

    for (const sub of subscribers as Subscriber[]) {
      try {
        // Get ALL matching events (for count), then split into the
        // rich-card "picks" section and the plain-text "also coming
        // up" tail. Both render in buildDigestHtml.
        const allMatching = filterEventsForSubscriber(flatEvents, sub, now)
        const events = allMatching.slice(0, MAX_EVENTS_PER_EMAIL)
        const tail   = allMatching.slice(MAX_EVENTS_PER_EMAIL, MAX_EVENTS_PER_EMAIL + TAIL_EVENT_COUNT)

        if (events.length === 0) {
          // Skip — don't send empty digests
          sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'skipped' })
          continue
        }

        const html = buildDigestHtml(events, sub, allMatching.length, tail)
        const subject = buildSubject(sub.frequency, events.length)

        emailBatch.push({
          from: THEME.from,
          to: [sub.email],
          reply_to: THEME.replyTo,
          subject,
          html,
          headers: {
            'List-Unsubscribe': `<${BASE_URL}/unsubscribe?token=${sub.token}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        })

        sendLog.push({ subscriber_id: sub.id, event_count: events.length, status: 'sent' })
      } catch (err) {
        console.error(`[send-digest] Filter/render error for ${sub.id}:`, err)
        sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'failed', error_message: String(err) })
      }
    }

    // Send in chunks of BATCH_SIZE
    let sentCount = 0
    for (let i = 0; i < emailBatch.length; i += BATCH_SIZE) {
      const chunk = emailBatch.slice(i, i + BATCH_SIZE)
      const chunkIndex = Math.floor(i / BATCH_SIZE)

      try {
        const { error: sendErr } = await resend.batch.send(chunk, {
          idempotencyKey: `digest-${dateStr}/chunk-${chunkIndex}/${sessionTag}`,
        })

        if (sendErr) {
          console.error(`[send-digest] Batch chunk ${chunkIndex} error:`, sendErr)
          // Mark this chunk's subscribers as failed
          for (let j = i; j < i + chunk.length; j++) {
            if (sendLog[j]) {
              sendLog[j].status = 'failed'
              sendLog[j].error_message = sendErr.message || 'Batch send failed'
            }
          }
        } else {
          sentCount += chunk.length
        }
      } catch (err) {
        console.error(`[send-digest] Batch chunk ${chunkIndex} exception:`, err)
      }
    }

    // ── Step 6: Log results ──
    const logRows = sendLog.map(log => ({
      ...log,
      idempotency_key: `digest-${dateStr}/${log.subscriber_id}/${sessionTag}`,
    }))

    if (logRows.length > 0) {
      const { error: logErr } = await supabase
        .from('email_sends')
        .upsert(logRows, { onConflict: 'idempotency_key' })

      if (logErr) {
        console.error('[send-digest] Log write error:', logErr)
      }
    }

    const summary = {
      ok: true,
      date: dateStr,
      subscribers_due: subscribers.length,
      emails_sent: sentCount,
      skipped: sendLog.filter(l => l.status === 'skipped').length,
      failed: sendLog.filter(l => l.status === 'failed').length,
    }

    console.log('[send-digest] Complete:', summary)
    return json(summary)
  } catch (err) {
    console.error('[send-digest] Fatal error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})
