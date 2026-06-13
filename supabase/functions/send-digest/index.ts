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
import { THEME, escapeHtml, button, renderEmailShell } from '../_shared/email.ts'
import {
  type Event,
  type Subscriber,
  filterEventsForSubscriber,
  selectDigestEvents,
  eventPath,
} from './select.ts'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'
const BATCH_SIZE = 100

/**
 * Tag a link so GA4 can attribute email-driven sessions. utm_medium=email is
 * what lands them in GA4's built-in Email channel; utm_campaign carries the
 * subscriber's cadence (`weekly_digest`) so cadences can be compared; and
 * utm_content marks which link in the email drove the click. Applied to event
 * and CTA links only — never the preferences/unsubscribe links, which would
 * pollute campaign data.
 */
function withUtm(url: string, campaign: string, content: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}utm_source=newsletter&utm_medium=email&utm_campaign=${campaign}&utm_content=${content}`
}

// Brand theme, masthead/footer shell, and button/escape helpers all
// live in ../_shared/email.ts so every subscriber-facing email renders
// the same brand system. The matcher + windowed, diversity-aware pick
// live in ./select.ts (pure + unit-tested). CATEGORY_GRADIENT /
// CATEGORY_LABEL stay in this file: they're digest-specific and
// test-send-digest-schema.js statically asserts they cover every slug.

// ── Email template helpers ───────────────────────────────────────

// Category → gradient colors for the no-image placeholder. Mirrors
// the gradient palette used in the app, simplified to two stops so
// email clients (which strip CSS gradients only sometimes) can
// fall back to the first color as a solid. Lock these in sync with
// src/styles/globals.css if the brand palette shifts.
const CATEGORY_GRADIENT: Record<string, [string, string]> = {
  music:        ['#162806', '#2A5C18'],
  theater:      ['#1A0A26', '#4A1870'],
  film:         ['#0A0A1A', '#1A2860'],
  comedy:       ['#1A1A08', '#585820'],
  'visual-art': ['#180A26', '#481870'],
  food:         ['#082010', '#186030'],
  sports:       ['#081828', '#1040A0'],
  fitness:      ['#0A2818', '#18784A'],
  outdoors:     ['#1A2A0E', '#4A6818'],
  learning:     ['#100828', '#2E1060'],
  festival:     ['#1A0808', '#602018'],
  market:       ['#0A1818', '#186060'],
  civic:        ['#082010', '#186030'],
  games:        ['#330000', '#690000'],
  other:        ['#1D2B1F', '#3A6B4A'],
}

// Display labels for the no-image placeholder. Single word per
// category, short enough to render at any thumb size.
const CATEGORY_LABEL: Record<string, string> = {
  music: 'Music', theater: 'Theater', film: 'Film', comedy: 'Comedy',
  'visual-art': 'Art', food: 'Food', sports: 'Sports', fitness: 'Fitness',
  outdoors: 'Outdoors', learning: 'Learning', festival: 'Festival',
  market: 'Market', civic: 'Civic', games: 'Games', other: 'Event',
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
    return `<img src="${url}" alt="" width="${opts.width.replace('px', '')}" style="display:block;width:${opts.width};height:${opts.height};object-fit:cover;border-radius:${opts.radius};">`
  }
  const [c1, c2] = CATEGORY_GRADIENT[e.category] || CATEGORY_GRADIENT.other
  const label = CATEGORY_LABEL[e.category] || 'Event'
  // Solid bg + linear-gradient: clients that strip gradients
  // (Outlook desktop) fall back to the solid color. Label is
  // legible in either state. Centered via line-height (NOT flexbox —
  // Outlook ignores flex and the label would pin to the top-left).
  return `
    <div style="
      width:${opts.width};height:${opts.height};border-radius:${opts.radius};
      background:${c1};
      background-image:linear-gradient(135deg, ${c1} 0%, ${c2} 100%);
      color:#FCFAF4;font-family:${THEME.fonts.display};
      font-size:12px;font-weight:700;letter-spacing:0.08em;
      text-transform:uppercase;text-align:center;line-height:${opts.height};
      overflow:hidden;
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

// Short, human category words for the subscription-aware headline,
// keyed off the taxonomy slugs in src/lib/categories.js. Edge functions
// can't import from src/, so the words live here — keep in sync if the
// taxonomy slugs change.
const CATEGORY_WORD: Record<string, string> = {
  music: 'music',
  theater: 'theater',
  film: 'film',
  comedy: 'comedy',
  'visual-art': 'art',
  food: 'food & drink',
  sports: 'sports',
  fitness: 'fitness',
  outdoors: 'outdoors',
  learning: 'learning',
  festival: 'festival',
  market: 'market',
  civic: 'civic',
  games: 'games',
}

const CADENCE_WORD: Record<string, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' }

/**
 * Subscription-aware headline. Expresses the subscriber's send CADENCE
 * (daily/weekly/monthly) and their event WINDOW (today / this week /
 * this month / upcoming) plus content focus (a single chosen category,
 * or "free"). Cadence and window are configured independently:
 *   - when they line up, we show just the window:
 *       "This week's music events", "Today's free events"
 *   - when they differ, we name both so the reach is clear:
 *       "Here's your daily look at this month's events"
 */
function headlineLabel(sub: Subscriber): string {
  const prefs = sub.preferences

  // Event window → a Capitalized frame and a lowercase form for mid-sentence.
  let frame: string
  let frameLower: string
  if (sub.frequency === 'monthly') { frame = 'This month’s'; frameLower = 'this month’s' }
  else if (sub.lookahead_days <= 1) { frame = 'Today’s'; frameLower = 'today’s' }
  else if (sub.lookahead_days <= 7) { frame = 'This week’s'; frameLower = 'this week’s' }
  else if (sub.lookahead_days <= 31) { frame = 'This month’s'; frameLower = 'this month’s' }
  else { frame = 'Upcoming'; frameLower = 'upcoming' }

  // Content focus: a "free" price filter wins; otherwise a single chosen
  // category. Multiple categories or "all" stay generic.
  let focus = ''
  const filteringCats = !prefs.intents?.includes('all') && (prefs.categories?.length ?? 0) > 0
  if (prefs.price_max === 0) focus = 'free'
  else if (filteringCats && prefs.categories.length === 1) focus = CATEGORY_WORD[prefs.categories[0]] ?? ''
  const focusPart = focus ? `${focus} ` : ''

  // Does the cadence already line up with the window? (daily↔today,
  // weekly↔this week, monthly↔this month) — if so, naming both is redundant.
  const cadence = CADENCE_WORD[sub.frequency] ?? ''
  const aligned =
    (sub.frequency === 'daily' && frame === 'Today’s') ||
    (sub.frequency === 'weekly' && frame === 'This week’s') ||
    (sub.frequency === 'monthly' && frame === 'This month’s')

  if (aligned || !cadence) return `${frame} ${focusPart}events`
  return `Here’s your ${cadence} look at ${frameLower} ${focusPart}events`
}

// ── Build email HTML ──────────────────────────────────────────────
// Digest content only — the brand shell (masthead, mission footer,
// palette) comes from _shared/email.ts. Layout rules: tables only (no
// flexbox — Outlook), px font sizes only (no rem), and every piece of
// scraped/user-submitted text goes through escapeHtml().
function buildDigestHtml(events: Event[], sub: Subscriber, totalMatchCount: number, tailEvents: Event[] = []): string {
  const prefsUrl = `${BASE_URL}/subscribe/preferences?token=${sub.token}`
  const unsubUrl = `${BASE_URL}/unsubscribe?token=${sub.token}`
  const campaign = `${sub.frequency}_digest`
  const c = THEME.colors
  const f = THEME.fonts

  // Featured event becomes the hero; remaining events go into the
  // day-grouped picks list below.
  const hero = events.find(e => e.featured)
  const picks = events.filter(e => e !== hero)
  const dayGroups = groupByDay(picks)

  // Preheader: inbox preview snippet. Keep under ~110 chars.
  const preheaderBits: string[] = []
  if (hero) preheaderBits.push(`Featured: ${hero.title}`)
  preheaderBits.push(`${events.length} picks${tailEvents.length > 0 ? ` + ${tailEvents.length} more` : ''}`)
  const firstFree = events.find(e => priceLabel(e)?.free)
  if (firstFree && firstFree !== hero) preheaderBits.push(`free: ${firstFree.title}`)
  const preheader = escapeHtml(preheaderBits.join(' · ').slice(0, 110))

  // Headline — subscription-aware: names the subscriber's cadence and/or
  // window + content focus ("This week's music events", "Here's your
  // daily look at this month's events"). Keyed off prefs, never the raw
  // 30-day lookahead, so the copy matches what they signed up for.
  let content = `
  <div style="font-family:${f.display};font-size:20px;font-weight:700;color:${c.primary};line-height:1.25;letter-spacing:-0.01em;margin:0 0 20px;">
    ${headlineLabel(sub)}
  </div>
`

  // Hero event — full-width image (or gradient) on top, content below.
  if (hero) {
    const venue = hero.venues[0]
    const heroUrl = withUtm(`${BASE_URL}${eventPath(hero)}`, campaign, 'hero')
    const heroDate = new Date(hero.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const price = priceLabel(hero)
    content += `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
    <tr>
      <td style="border:1px solid ${c.border};border-radius:12px;">
        <a href="${heroUrl}" style="display:block;text-decoration:none;color:inherit;">
          ${imageBlock(hero, { width: '100%', height: '200px', radius: '12px 12px 0 0' })}
          <div style="padding:18px 20px 20px;">
            <div style="font-family:${f.display};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${c.primary};margin-bottom:6px;">Featured</div>
            <div style="font-family:${f.display};font-size:18px;font-weight:700;color:${c.textPrimary};margin-bottom:6px;line-height:1.3;">${escapeHtml(hero.title)}</div>
            <div style="font-size:13px;color:${c.textSecondary};margin-bottom:4px;">${heroDate}${venue ? ` &middot; ${escapeHtml(venue.name)}` : ''}</div>
            ${price ? `<div style="display:inline-block;margin-top:8px;padding:3px 10px;background:${price.free ? c.freeBg : c.primary};color:${price.free ? c.freeTxt : c.white};font-size:12px;font-weight:600;border-radius:10px;">${price.label}</div>` : ''}
            ${hero.ticket_url ? `<div style="margin-top:12px;">${button(heroUrl, 'Get Tickets', { align: 'left' })}</div>` : ''}
          </div>
        </a>
      </td>
    </tr>
  </table>
`
  }

  // Picks — grouped by day. One table; day headers and event rows are
  // <tr>s so the thumb/text columns align without flexbox.
  if (dayGroups.length > 0) {
    content += `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td colspan="2" style="font-family:${f.display};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.textMuted};border-bottom:1px solid ${c.border};padding-bottom:8px;">Your picks</td>
    </tr>
`
    for (const group of dayGroups) {
      // Per-day header (Sunday, Jun 1) — small uppercase label
      content += `
    <tr>
      <td colspan="2" style="font-family:${f.display};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${c.primary};padding:18px 0 4px;">${group.label}</td>
    </tr>
`
      for (const event of group.events) {
        const venue = event.venues[0]
        const eventUrl = withUtm(`${BASE_URL}${eventPath(event)}`, campaign, 'list')
        const meta = [formatTimeOnly(event.start_at), venue ? escapeHtml(venue.name) : null].filter(Boolean).join(' &middot; ')
        const price = priceLabel(event)
        const pills: string[] = []
        if (event.featured) {
          pills.push(`<span style="display:inline-block;margin-top:4px;margin-right:6px;padding:2px 8px;background:${c.primary};color:${c.white};font-size:11px;font-weight:600;border-radius:8px;letter-spacing:0.04em;text-transform:uppercase;">Featured</span>`)
        }
        if (price?.free) {
          pills.push(`<span style="display:inline-block;margin-top:4px;padding:2px 8px;background:${c.freeBg};color:${c.freeTxt};font-size:11px;font-weight:600;border-radius:8px;">Free</span>`)
        } else if (price) {
          pills.push(`<span style="display:inline-block;margin-top:4px;padding:2px 8px;background:${c.background};color:${c.textSecondary};font-size:11px;font-weight:600;border-radius:8px;border:1px solid ${c.border};">${price.label}</span>`)
        }

        content += `
    <tr>
      <td width="68" valign="middle" style="padding:10px 12px 10px 0;border-bottom:1px solid ${c.border};">
        <a href="${eventUrl}" style="display:block;text-decoration:none;">${imageBlock(event, { width: '56px', height: '56px', radius: '8px' })}</a>
      </td>
      <td valign="middle" style="padding:10px 0;border-bottom:1px solid ${c.border};">
        <a href="${eventUrl}" style="display:block;text-decoration:none;color:inherit;">
          <div style="font-family:${f.display};font-size:15px;font-weight:700;color:${c.textPrimary};margin-bottom:2px;line-height:1.3;">${escapeHtml(event.title)}</div>
          <div style="font-size:12px;color:${c.textSecondary};">${meta}</div>
          ${pills.length > 0 ? `<div>${pills.join('')}</div>` : ''}
        </a>
      </td>
    </tr>
`
      }
    }
    content += `
  </table>
`
  }

  // "Also coming up" — tail of plain-text event links. No images,
  // no metadata clutter; just titles + dates so the reader feels
  // depth without scrolling through more cards.
  if (tailEvents.length > 0) {
    content += `
  <div style="margin-top:26px;padding-top:18px;border-top:1px solid ${c.border};">
    <div style="font-family:${f.display};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.textMuted};margin-bottom:10px;">Also coming up</div>
`
    for (const event of tailEvents) {
      const eventUrl = withUtm(`${BASE_URL}${eventPath(event)}`, campaign, 'tail')
      const date = new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      content += `
    <a href="${eventUrl}" style="display:block;padding:6px 0;text-decoration:none;color:${c.textSecondary};font-size:14px;line-height:1.4;">
      <span style="color:${c.primary};font-weight:600;">${date}</span>
      <span style="color:${c.textMuted};"> &middot; </span>
      <span style="color:${c.textPrimary};">${escapeHtml(event.title)}</span>
    </a>
`
    }
    content += `  </div>
`
  }

  // See-all CTA — "find your reason to go out" moment.
  if (totalMatchCount > events.length) {
    content += `
  <div style="margin:26px 0 4px;">
    <div style="text-align:center;font-family:${f.display};font-size:13px;font-weight:600;color:${c.textSecondary};margin-bottom:10px;">Find your reason to go out.</div>
    ${button(withUtm(BASE_URL, campaign, 'see_all'), `See all ${totalMatchCount} events &rarr;`, { bg: c.dark })}
  </div>
`
  }

  return renderEmailShell({
    preheader,
    content,
    footer: { prefsUrl, unsubUrl, showMission: true },
  })
}

// ── Build plain-text alternative ──────────────────────────────────
// Multipart text/plain part: a deliverability best practice (spam
// filters distrust HTML-only mail) and what screen-reader and
// text-mode clients actually read.
function buildDigestText(events: Event[], sub: Subscriber, totalMatchCount: number, tailEvents: Event[] = []): string {
  const campaign = `${sub.frequency}_digest`
  const lines: string[] = [
    `${THEME.brandName}: Never miss a beat`,
    headlineLabel(sub),
    '',
  ]

  const hero = events.find(e => e.featured)
  const picks = events.filter(e => e !== hero)

  if (hero) {
    const venue = hero.venues[0]
    const heroDate = new Date(hero.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    lines.push(`FEATURED: ${hero.title}`)
    lines.push(`  ${heroDate}${venue ? ` · ${venue.name}` : ''}`)
    lines.push(`  ${withUtm(`${BASE_URL}${eventPath(hero)}`, campaign, 'hero')}`, '')
  }

  for (const group of groupByDay(picks)) {
    lines.push(group.label.toUpperCase())
    for (const event of group.events) {
      const venue = event.venues[0]
      const meta = [formatTimeOnly(event.start_at), venue?.name].filter(Boolean).join(' · ')
      const price = priceLabel(event)
      lines.push(`- ${event.title}${price ? ` (${price.label})` : ''}`)
      lines.push(`  ${meta}`)
      lines.push(`  ${withUtm(`${BASE_URL}${eventPath(event)}`, campaign, 'list')}`)
    }
    lines.push('')
  }

  if (tailEvents.length > 0) {
    lines.push('ALSO COMING UP')
    for (const event of tailEvents) {
      const date = new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      lines.push(`- ${date} · ${event.title} — ${withUtm(`${BASE_URL}${eventPath(event)}`, campaign, 'tail')}`)
    }
    lines.push('')
  }

  if (totalMatchCount > events.length) {
    lines.push(`See all ${totalMatchCount} events: ${withUtm(BASE_URL, campaign, 'see_all')}`, '')
  }

  lines.push(
    'Never miss a beat.',
    'Thanks for checking Akron Pulse, your free, easy, go-to regional events calendar, courtesy of your friendly neighborhood Summit County residents.',
    `Have an event? Submit it here, see it live in 24 hours: ${withUtm(`${BASE_URL}/submit`, campaign, 'submit')}`,
    '',
    `Manage preferences: ${BASE_URL}/subscribe/preferences?token=${sub.token}`,
    `Unsubscribe: ${BASE_URL}/unsubscribe?token=${sub.token}`,
  )

  return lines.join('\n')
}

// ── Subject line builder ──
// Keyed off the subscriber's event WINDOW (monthly calendar window or
// lookahead_days), not their send frequency — a daily subscriber with
// a 7-day lookahead was getting "Tomorrow in Akron" over a week of
// events.
function buildSubject(sub: Subscriber, eventCount: number): string {
  if (eventCount === 0) return 'No new events this time — we\'ll keep looking!'

  const loc = THEME.location.split(',')[0] // "Akron"
  const s = eventCount !== 1 ? 's' : ''

  if (sub.frequency === 'monthly') {
    const month = new Date().toLocaleDateString('en-US', { month: 'long' })
    return `${month} in ${loc}: ${eventCount} event${s} for you`
  }

  switch (sub.lookahead_days) {
    case 1:
      return `Tomorrow in ${loc}: ${eventCount} event${s} for you`
    case 30:
      return `Your month in ${loc}: ${eventCount} event${s} for you`
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

  // Body modes:
  //   { force: true }        → send to ALL active subscribers now (admin trigger)
  //   { only: ["a@b.com"] }  → targeted test: send only to these subscribers,
  //                            regardless of their frequency/scheduled day
  //   (neither)              → scheduled mode (subscribers due today)
  let forceAll = false
  let only: string[] | null = null
  try {
    const body = await req.json()
    forceAll = body?.force === true
    if (Array.isArray(body?.only)) {
      const list = body.only
        .map((e: unknown) => String(e).trim().toLowerCase())
        .filter((e: string) => e.includes('@'))
      if (list.length > 0) only = [...new Set(list)].slice(0, 25) // de-dupe + safety cap
    }
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
  const ephemeral = forceAll || !!only
  const sessionTag = ephemeral ? `force-${Date.now()}` : 'scheduled'

  console.log(`[send-digest] Starting for ${dateStr}, DOW=${todayDow}, 1st=${isFirstOfMonth}, force=${forceAll}, only=${only ? only.length : 0}, session=${sessionTag}`)

  try {
    // ── Step 1: WHO gets emailed? ──
    let query = supabase
      .from('subscribers')
      .select('id, email, frequency, lookahead_days, preferences, token')
      .eq('confirmed', true)
      .is('unsubscribed_at', null)

    if (only) {
      // Targeted test send: just these subscribers, ignoring schedule.
      // Still gated to confirmed + not-unsubscribed above.
      query = query.in('email', only)
    } else if (!forceAll) {
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
    const emailBatch: { from: string; to: string[]; reply_to: string; subject: string; html: string; text: string; headers: Record<string, string> }[] = []
    const sendLog: { subscriber_id: string; event_count: number; status: string; error_message?: string }[] = []

    for (const sub of subscribers as Subscriber[]) {
      try {
        // Match ALL events in the window (allMatching.length is the true
        // "N events" count), then pick the windowed, diversity-aware set
        // for the rich cards plus a plain-text "also coming up" tail.
        const allMatching = filterEventsForSubscriber(flatEvents, sub, now)
        const { picks: events, tail } = selectDigestEvents(allMatching, sub, now)

        if (events.length === 0) {
          // Skip — don't send empty digests
          sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'skipped' })
          continue
        }

        const html = buildDigestHtml(events, sub, allMatching.length, tail)
        const text = buildDigestText(events, sub, allMatching.length, tail)
        const subject = buildSubject(sub, events.length)

        emailBatch.push({
          from: THEME.from,
          to: [sub.email],
          reply_to: THEME.replyTo,
          subject,
          html,
          text,
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
