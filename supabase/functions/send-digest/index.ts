// send-digest — daily cron-triggered function that sends personalized event digests
// Triggered by the `send-daily-digest` pg_cron job (cron.job jobid 1). pg_cron
// runs in UTC, so the schedule is `30 12 * * *` = 12:30 UTC = 8:30 AM ET during
// EDT. NOTE: a fixed UTC time drifts with daylight saving — 12:30 UTC is 7:30 AM
// ET during EST (winter). For year-round 8:30 AM ET, gate on the Eastern hour in
// scheduled mode and widen the cron (see the digest-cron memory / TODO).
// A second job, `send-daily-digest-sweep` (migration 057), re-fires the same
// URL at 13:00 UTC as crash recovery — see the chaining notes below.
//
// Architecture (cost-optimized, self-chaining since the 2026-08-13 CPU fault):
//   1. Query WHO is due today (subscribers by frequency + send_day),
//      keyset-paginated: ORDER BY id LIMIT 26 (SLICE_SIZE + 1 lookahead)
//   2. Query ALL published events for next 30 days (ONE query, cached in memory)
//   3. Filter per subscriber in-memory (no additional DB calls)
//   4. Batch send via Resend — one chunk per link (25 < 100)
//   5. Log results to email_sends
//   6. If the 26th row existed, self-invoke with `{ continue: {...} }` via
//      EdgeRuntime.waitUntil and return — each link stays well under the
//      ~2s CPU isolate budget that one 91-subscriber invocation blew.
// The chain's pure logic (continuation parsing, slice math, chunk keys,
// runaway guards, Resend-409 classification) lives in ./chain.ts.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@4'
import { THEME, escapeHtml, button, renderEmailShell } from '../_shared/email.ts'
import {
  type Event,
  type Subscriber,
  filterEventsForSubscriber,
  selectDigestEvents,
  eventPath,
  easternDayKey,
  isFestivalChildHidden,
} from './select.ts'
import { type SendLogEntry, markChunkFailed } from './batch.ts'
import {
  type ContinuationBody,
  SLICE_SIZE,
  parseContinuation,
  buildContinuation,
  chainGuardError,
  sliceDue,
  filterAlreadyLogged,
  chunkIdempotencyKey,
  resolveChunkSendError,
} from './chain.ts'

// Supabase Edge Runtime global — lets a background promise (our continuation
// self-fetch) outlive the response. Declared here because the runtime injects
// it; absent under plain `deno test`/older local serves, hence the typeof
// guard at the call site.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://akronpulse.com'
const BATCH_SIZE = 100

// All dates/times in the digest render in the event's local zone. The
// function runs server-side (Deno, UTC clock) with no browser context, so
// — unlike the web app, which uses the viewer's browser zone — email has
// to pin an explicit zone. Akron Pulse is a Summit County calendar, so
// that zone is Eastern; toLocale* without `timeZone` would otherwise emit
// the UTC wall-clock (a 7 PM show printed as "11:00 PM"). select.ts
// already uses this same zone for event-slug dates.
const DISPLAY_TZ = 'America/New_York'

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

// CPU rider (2026-08-13 incident): module-level cached Intl.DateTimeFormat
// instances. toLocale*String constructs a fresh timeZone-aware formatter on
// EVERY call (ICU setup is the expensive part), and these run per event per
// subscriber. Same locales/options as the calls they replace — output is
// byte-identical, this is purely a CPU change.
const DAY_LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TZ, weekday: 'long', month: 'short', day: 'numeric',
})
const TIME_ONLY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TZ, hour: 'numeric', minute: '2-digit',
})
const HERO_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
})

/** Group events by their Eastern-calendar start day. Order preserved. */
function groupByDay(events: Event[]): { dayKey: string; label: string; events: Event[] }[] {
  const groups = new Map<string, Event[]>()
  for (const e of events) {
    // en-CA gives a YYYY-MM-DD key; computing it in DISPLAY_TZ keeps an
    // 8 PM-Eastern event on its real day rather than rolling it to the
    // next UTC day. Precomputed once per event in the flatten step
    // (e._dayKey); the fallback keeps this correct for any caller that
    // didn't precompute.
    const key = e._dayKey ?? easternDayKey(new Date(e.start_at))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  return [...groups.entries()].map(([dayKey, evs]) => ({
    dayKey,
    // Noon UTC always lands on the same calendar day in Eastern, so it's a
    // safe instant to format the day label from.
    label: DAY_LABEL_FMT.format(new Date(dayKey + 'T12:00:00Z')),
    events: evs,
  }))
}

function formatTimeOnly(iso: string): string {
  return TIME_ONLY_FMT.format(new Date(iso))
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
function buildDigestHtml(events: Event[], sub: Subscriber, totalMatchCount: number): string {
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
  preheaderBits.push(`${events.length} picks`)
  const firstFree = events.find(e => priceLabel(e)?.free)
  if (firstFree && firstFree !== hero) preheaderBits.push(`free: ${firstFree.title}`)
  const preheader = escapeHtml(preheaderBits.join(' · ').slice(0, 110))

  // Headline — subscription-aware: names the subscriber's cadence and/or
  // window + content focus ("This week's music events", "Here's your
  // daily look at this month's events"). Keyed off prefs, never the raw
  // 30-day lookahead, so the copy matches what they signed up for.
  let content = `
  <div style="font-family:${f.display};font-size:20px;font-weight:700;color:${c.primary};line-height:1.25;letter-spacing:-0.01em;margin:0 0 20px;text-align:center;">
    ${headlineLabel(sub)}
  </div>
`

  // Hero event — full-width image (or gradient) on top, content below.
  if (hero) {
    const venue = hero.venues[0]
    const heroUrl = withUtm(`${BASE_URL}${eventPath(hero)}`, campaign, 'hero')
    const heroDate = HERO_DATE_FMT.format(new Date(hero.start_at))
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
function buildDigestText(events: Event[], sub: Subscriber, totalMatchCount: number): string {
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
    const heroDate = HERO_DATE_FMT.format(new Date(hero.start_at))
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

  if (totalMatchCount > events.length) {
    lines.push(`See all ${totalMatchCount} events: ${withUtm(BASE_URL, campaign, 'see_all')}`, '')
  }

  lines.push(
    'Never miss a beat.',
    'Thanks for checking Akron Pulse, your free, customizable, and go-to regional events calendar.',
    `Have an event? Submit it here, see it live in 24 hours: ${withUtm(`${BASE_URL}/submit`, campaign, 'submit')}`,
    "Hit reply and tell us what you'd change.",
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
    const month = new Date().toLocaleDateString('en-US', { timeZone: DISPLAY_TZ, month: 'long' })
    return `${month} in ${loc}: ${eventCount} event${s} for you`
  }

  switch (sub.lookahead_days) {
    case 1:
      // 1-day lookahead = the window that starts now and runs 24h, i.e. the
      // rest of today. Must match the "Today's events" headline (headlineLabel)
      // and the window in select.ts — was wrongly "Tomorrow in ...".
      return `Today in ${loc}: ${eventCount} event${s} for you`
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

/**
 * Fire the next chain link: a self-fetch carrying the continuation body,
 * handed to EdgeRuntime.waitUntil so it survives this invocation's response
 * WITHOUT being awaited in the request path (awaiting would nest every
 * link's wall clock inside link 0's for nothing).
 *
 * Auth: the same header shape pg_cron jobid 1 uses per migration 045's
 * documentation — `apikey` plus `Authorization: Bearer` — with the bearer
 * preferring CRON_SECRET (this function's own optional gate, above) and
 * falling back to the service-role key. Both env vars already exist in this
 * function; no new trust boundary is created — a forged continuation body
 * can only trigger the sends the daily cron would send anyway, and
 * idempotency forbids duplicates.
 */
function dispatchContinuation(cont: ContinuationBody): void {
  const selfUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-digest`
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const bearer = Deno.env.get('CRON_SECRET') ?? serviceRoleKey

  const p = fetch(selfUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${bearer}`,
    },
    body: JSON.stringify({ continue: cont }),
  }).then(async (res) => {
    // Non-2xx downstream is a FINDING for the logs, not something this link
    // can fix — the 13:00 UTC sweep (migration 057) is the recovery net.
    if (!res.ok) {
      console.error(`[send-digest] continuation dispatch for link=${cont.link} got HTTP ${res.status}`)
    }
    // Drain/release the body so the runtime can close the connection.
    await res.body?.cancel()
  }).catch((err) => {
    console.error(`[send-digest] continuation dispatch for link=${cont.link} failed:`, err)
  })

  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime) {
    EdgeRuntime.waitUntil(p)
  }
  // Without EdgeRuntime (local `deno test`, old serves) the promise still
  // runs; it just isn't guaranteed to outlive the response.
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
  //   { continue: {...} }    → a chain link re-invoking itself (see chain.ts);
  //                            carries pinned date/dow/first + keyset cursor
  //   (neither)              → scheduled mode (subscribers due today), link 0
  let forceAll = false
  let only: string[] | null = null
  let continuation: ContinuationBody | null = null
  try {
    const body = await req.json()
    if (body?.continue !== undefined) {
      continuation = parseContinuation(body.continue)
      if (!continuation) {
        console.error('[send-digest] FATAL: invalid continuation body — aborting chain link')
        return json({ error: 'Invalid continuation body' }, 400)
      }
    } else {
      forceAll = body?.force === true
      if (Array.isArray(body?.only)) {
        // Annotate: req.json() is `any`, so without this `new Set(list)`
        // infers Set<unknown> and the spread below yields unknown[], which
        // won't assign to string[].
        const list: string[] = body.only
          .map((e: unknown) => String(e).trim().toLowerCase())
          .filter((e: string) => e.includes('@'))
        if (list.length > 0) only = [...new Set(list)].slice(0, 25) // de-dupe + safety cap
      }
    }
  } catch {
    // No body or invalid JSON — that's fine, default to scheduled mode
  }

  const now = new Date()
  const todayUtc = now.toISOString().slice(0, 10)

  // Runaway guards: a chain that has out-lived its day (or its link budget)
  // must die, not keep firing — its due-ness and every idempotency key were
  // computed for a day that is over. FATAL is greppable on purpose.
  if (continuation) {
    const guardErr = chainGuardError(continuation, todayUtc)
    if (guardErr) {
      console.error(`[send-digest] FATAL: ${guardErr}`)
      return json({ error: guardErr }, 400)
    }
  }

  // Run parameters. A continuation link PINS date/dow/first from link 0 so
  // every link of one chain agrees on who is due and what the key date is,
  // even if links straddle midnight UTC or the 1st of the month.
  const dateStr = continuation ? continuation.date : todayUtc
  const todayDow = continuation ? continuation.dow : now.getDay() // 0=Sun..6=Sat
  const isFirstOfMonth = continuation ? continuation.first : now.getDate() === 1

  // Idempotency session tag.
  //
  // Scheduled cron should stay idempotent for a given day — if pg_cron
  // fires twice for the 2026-06-01 run (or the 13:00 UTC sweep re-fires a
  // completed chain), both attempts produce the same keys and Resend / the
  // email_sends upsert silently dedupe. That's the safety net we want.
  //
  // Force mode (manual admin trigger, curl tests, template iteration)
  // intentionally bypasses that safety: every invocation must produce
  // a fresh key so the test can actually send. Otherwise Resend
  // returns 409 invalid_idempotent_request the second time you click
  // "Send digest now" with a new template (which is exactly what we
  // hit when redeploying the email layout). Date.now() per request is
  // sufficient — within a single force run, the membership-derived chunk
  // key keeps the batches distinct, and continuation links CARRY the
  // force-<ts> tag through the body so keys stay consistent across the
  // whole run.
  const ephemeral = forceAll || !!only
  const sessionTag = continuation ? continuation.sessionTag : (ephemeral ? `force-${Date.now()}` : 'scheduled')
  const isForceChain = sessionTag.startsWith('force-') && !only
  const link = continuation ? continuation.link : 0
  // Scheduled and force runs both chain; `only` (≤ 25 subscribers, the
  // slice size, by its safety cap) never needs to and never does.
  const chainMode = !only

  console.log(`[send-digest] Starting for ${dateStr}, DOW=${todayDow}, 1st=${isFirstOfMonth}, force=${forceAll}, only=${only ? only.length : 0}, session=${sessionTag}, link=${link}, cursor=${continuation ? continuation.cursor : 'start'}`)

  try {
    // ── Step 1: WHO gets emailed? ──
    // Due-ness conditions, shared by the page query and the advisory count
    // below. Scheduled mode only — force emails every active subscriber.
    // Daily subscribers: always due
    // Weekly subscribers: due if send_day matches today (PINNED dow)
    // Monthly subscribers: due on the 1st only (PINNED first-of-month)
    const dueConditions = [
      `frequency.eq.daily`,
      `and(frequency.eq.weekly,send_day.eq.${todayDow})`,
    ]
    if (isFirstOfMonth) dueConditions.push(`frequency.eq.monthly`)

    let query = supabase
      .from('subscribers')
      .select('id, email, frequency, lookahead_days, preferences, token')
      .eq('confirmed', true)
      .is('unsubscribed_at', null)

    if (only) {
      // Targeted test send: just these subscribers, ignoring schedule.
      // Still gated to confirmed + not-unsubscribed above.
      query = query.in('email', only)
    } else {
      if (!isForceChain) query = query.or(dueConditions.join(','))
      // Keyset page: deterministic id order, SLICE_SIZE + 1 lookahead — the
      // presence of a 26th row is the "more remain" signal (see chain.ts).
      if (continuation) query = query.gt('id', continuation.cursor)
      query = query.order('id', { ascending: true }).limit(SLICE_SIZE + 1)
    }

    // Advisory remaining-count for the observability lines (chain modes
    // only). HEAD + count=exact: no rows move, no CPU spent parsing them.
    // Logging-only — hasMore from the 26-row lookahead is the authoritative
    // "does the chain continue" signal, so a race with a new signup can at
    // worst make a log number stale, never fork the chain.
    let dueRemaining: number | null = null
    if (chainMode) {
      let countQuery = supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', true)
        .is('unsubscribed_at', null)
      if (!isForceChain) countQuery = countQuery.or(dueConditions.join(','))
      if (continuation) countQuery = countQuery.gt('id', continuation.cursor)
      const { count, error: countErr } = await countQuery
      if (countErr) {
        console.error('[send-digest] Subscriber count error (logs will show remaining_after=?):', countErr)
      } else {
        dueRemaining = count
      }
    }

    const { data: subscribers, error: subErr } = await query

    if (subErr) {
      console.error('[send-digest] Subscriber query error:', subErr)
      return json({ error: 'Subscriber query failed' }, 500)
    }

    const fetched = (subscribers ?? []) as Subscriber[]

    if (!chainMode && fetched.length === 0) {
      console.log('[send-digest] No subscribers matched the only: filter')
      return json({ ok: true, sent: 0, skipped: 0 })
    }

    // Slice math — `only` mode processes everything it fetched (≤ 25 by the
    // safety cap) and never chains.
    const { slice, hasMore, nextCursor } = chainMode
      ? sliceDue(fetched)
      : { slice: fetched, hasMore: false, nextCursor: null }

    // Already-logged pre-filter (scheduled chain only): subscribers with ANY
    // email_sends row for today's scheduled session were already decided
    // (sent, skipped, or failed) — a sweep re-fire or crash-resume must not
    // re-send them. Force runs skip this: their force-<ts> keys are
    // ephemeral and never collide with a prior run's rows.
    //
    // Paged read: PostgREST caps a single response at 1000 rows, so we page
    // with .range(). Offset pagination is only stable under a deterministic
    // total order — without .order(), Postgres may return pages in any order,
    // skipping or repeating rows across page boundaries. A skipped row here
    // means a sweep re-composes (and re-sends) an already-delivered digest,
    // so we order by the unique primary key `id` to make the walk complete.
    const loggedIds = new Set<string>()
    if (chainMode && !isForceChain) {
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data: page, error: logReadErr } = await supabase
          .from('email_sends')
          .select('subscriber_id')
          .like('idempotency_key', `digest-${dateStr}/%/scheduled`)
          .order('id')
          .range(from, from + PAGE - 1)
        if (logReadErr) {
          // Fail CLOSED: proceeding without the pre-filter could double-send
          // on a sweep re-fire. The next sweep (or a manual re-POST) retries.
          console.error('[send-digest] email_sends pre-filter read error:', logReadErr)
          return json({ error: 'Pre-filter query failed' }, 500)
        }
        for (const r of page ?? []) loggedIds.add(r.subscriber_id as string)
        if (!page || page.length < PAGE) break
      }
    }

    const subsToProcess = chainMode ? filterAlreadyLogged(slice, loggedIds) : slice

    if (chainMode && link === 0) {
      const dueTotal = dueRemaining ?? fetched.length
      console.log(`[send-digest] chain start date=${dateStr} due_total=${dueTotal} already_logged=${loggedIds.size} remaining=${Math.max(0, dueTotal - loggedIds.size)}`)
    }

    console.log(`[send-digest] ${subsToProcess.length} subscribers to process this invocation`)

    // ── Step 2: WHAT events exist? (ONE query) ──
    // Skipped entirely when this link has nothing to compose (every
    // subscriber in the slice was already logged — the sweep-after-complete
    // path). That keeps a no-op sweep walk down to subscriber queries only:
    // zero event parsing, zero rendering, zero Resend calls.
    let flatEvents: Event[] = []
    if (subsToProcess.length > 0) {
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

      // Exactly 1000 rows = PostgREST's default per-request cap, which means
      // the 30-day window was almost certainly TRUNCATED and late-window
      // events are silently missing from every digest this link renders.
      // Deliberately a WARNING, not a fix: range-paginating the events query
      // has its own CPU implications and is tracked as its own change.
      if ((events || []).length === 1000) {
        console.warn('[send-digest] WARNING: events query returned 1000 rows (PostgREST cap) — window truncated')
      }

      // Festival children never enter the digest pool at all — hidden
      // before any subscriber matching, so no subscriber (including a
      // keyword match, which bypasses every OTHER subscriber filter) can
      // pull one in. The umbrella row itself is never hidden. See
      // docs/umbrella-child-hiding.md and isFestivalChildHidden's header.
      const rawEvents = events || []
      const visibleEvents = rawEvents.filter((e: any) => !isFestivalChildHidden(e.tags))
      const hiddenCount = rawEvents.length - visibleEvents.length
      if (hiddenCount > 0) {
        console.log(`[send-digest] festival-child filter: hid ${hiddenCount} row(s) from the digest pool`)
      }

      // Flatten the joined data for easier filtering. _startMs/_dayKey are
      // the CPU rider: parse each start_at and compute its Eastern calendar
      // day ONCE here, instead of per (event × subscriber) in the filter/
      // select/render hot loops (see select.ts's Event interface).
      flatEvents = visibleEvents.map((e: any) => {
        const startMs = new Date(e.start_at).getTime()
        return {
          ...e,
          categories: (e.event_categories || []).map((ec: any) => ec.category).filter(Boolean),
          // Primary-category shim so gradient/label helpers keep working.
          category: (e.event_categories || [])[0]?.category ?? 'other',
          venues: (e.event_venues || []).map((ev: any) => ev.venues).filter(Boolean),
          organizations: (e.event_organizations || []).map((eo: any) => eo.organizations).filter(Boolean),
          _startMs: startMs,
          _dayKey: easternDayKey(new Date(startMs)),
        }
      })

      console.log(`[send-digest] ${flatEvents.length} events in 30-day window`)
    }

    // ── Step 3+4+5: Filter → Render → Batch send ──
    // Typed from the SDK rather than hand-rolled. A hand-written shape here
    // previously declared `reply_to`, which taught the compiler a field the
    // SDK does not read — so the batch silently shipped with no Reply-To
    // and nothing flagged it. Deriving the type means the SDK's contract is
    // the source of truth and drift like that fails the build.
    const emailBatch: Parameters<typeof resend.batch.send>[0] = []
    const sendLog: SendLogEntry[] = []
    // Parallel to emailBatch: batchLogIndex[k] is the sendLog index that
    // emailBatch[k] actually corresponds to. sendLog also carries 'skipped'
    // (zero-match) and render-failure entries that never make it into
    // emailBatch, so the two arrays are NOT parallel by position — this
    // explicit index is what markChunkFailed uses instead of recomputing a
    // position from the chunk's offset into emailBatch. See batch.ts.
    const batchLogIndex: number[] = []

    for (const sub of subsToProcess) {
      try {
        // Match ALL events in the window (allMatching.length is the true
        // "N events" count, and drives the "see all N" CTA), then pick the
        // windowed, diversity-aware set that becomes the rich cards.
        const allMatching = filterEventsForSubscriber(flatEvents, sub, now)
        const { picks: events } = selectDigestEvents(allMatching, sub, now)

        if (events.length === 0) {
          // Skip — don't send empty digests
          sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'skipped' })
          continue
        }

        const html = buildDigestHtml(events, sub, allMatching.length)
        const text = buildDigestText(events, sub, allMatching.length)
        const subject = buildSubject(sub, events.length)

        // Record the sendLog index this batch entry will land at BEFORE
        // pushing to sendLog, so batchLogIndex[k] always points at the
        // right entry regardless of how many subscribers were skipped
        // earlier in the loop.
        const logIndex = sendLog.length

        emailBatch.push({
          from: THEME.from,
          to: [sub.email],
          replyTo: THEME.replyTo,
          subject,
          html,
          text,
          headers: {
            'List-Unsubscribe': `<${BASE_URL}/unsubscribe?token=${sub.token}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        })
        batchLogIndex.push(logIndex)

        sendLog.push({ subscriber_id: sub.id, event_count: events.length, status: 'sent' })
      } catch (err) {
        console.error(`[send-digest] Filter/render error for ${sub.id}:`, err)
        sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'failed', error_message: String(err) })
      }
    }

    // Send in chunks of BATCH_SIZE. With chaining, a link's slice (25) is
    // always a single chunk (< 100); the loop stays for `only:` mode and as
    // a guard if the constants ever diverge.
    let sentCount = 0
    for (let i = 0; i < emailBatch.length; i += BATCH_SIZE) {
      const chunk = emailBatch.slice(i, i + BATCH_SIZE)
      // The sendLog indices that correspond 1:1 to `chunk`, NOT `i..i +
      // chunk.length` — sendLog also holds 'skipped'/render-failed entries
      // that emailBatch never saw, so a recomputed positional range would
      // (and used to) attribute a failure to the wrong subscribers the
      // moment any subscriber upstream was skipped.
      const chunkLogIndexes = batchLogIndex.slice(i, i + BATCH_SIZE)
      // Membership-deterministic idempotency key: named by the FIRST
      // subscriber whose email is actually in this chunk (looked up through
      // batchLogIndex, same correspondence as above), NOT a positional
      // chunk-<i> — a resumed run starting from a different cursor would
      // renumber positions, but the same slice always re-forms the same
      // membership and therefore the same key. See chain.ts.
      const chunkKey = chunkIdempotencyKey(dateStr, sendLog[chunkLogIndexes[0]].subscriber_id, sessionTag)

      try {
        const { error: sendErr } = await resend.batch.send(chunk, {
          idempotencyKey: chunkKey,
        })

        if (sendErr) {
          if (resolveChunkSendError(sendErr) === 'replayed') {
            // Idempotency-key conflict (409): the only way this key exists
            // at Resend is a PRIOR ACCEPTED send of this same deterministic
            // chunk — the crash-after-Resend-before-upsert window, or a
            // double-fired link whose payload drifted (`now` moved between
            // renders). The emails were delivered; record the rows as sent
            // with a note. Deliberately NOT routed through markChunkFailed:
            // marking delivered mail 'failed' would invite a manual re-send
            // and a duplicate email.
            console.log(`[send-digest] chunk replay key=${chunkKey} — Resend already accepted this chunk, recording as sent`)
            for (const logIndex of chunkLogIndexes) {
              const entry = sendLog[logIndex]
              if (entry) entry.error_message = 'resend idempotency conflict (409): prior send accepted, recorded as sent'
            }
            sentCount += chunk.length
          } else {
            console.error(`[send-digest] Batch chunk ${chunkKey} error:`, sendErr)
            markChunkFailed(sendLog, chunkLogIndexes, sendErr.message || 'Batch send failed')
          }
        } else {
          sentCount += chunk.length
        }
      } catch (err) {
        console.error(`[send-digest] Batch chunk ${chunkKey} exception:`, err)
        // A thrown exception (network failure, timeout, response-parse error)
        // means delivery is genuinely UNKNOWN here — the request may have
        // reached Resend and even succeeded, with only our handling of the
        // response failing. 'failed' is therefore a conservative claim, not
        // a certain one. It is still strictly better than leaving these
        // sendLog entries at 'sent': that would silently claim delivery for
        // subscribers who were never confirmed handed off, hiding the very
        // possibility we can't rule out. (If the send DID reach Resend, the
        // retry hits the 409-replay branch above and corrects the record.)
        markChunkFailed(sendLog, chunkLogIndexes, err instanceof Error ? err.message : String(err))
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

    const skippedCount = sendLog.filter(l => l.status === 'skipped').length
    const failedCount = sendLog.filter(l => l.status === 'failed').length

    // ── Step 7: chain bookkeeping ──
    // One greppable line per link; `chain start` (link 0, above) without a
    // matching `chain complete` = a partial run, and email_sends rows show
    // exactly how far it got. remaining_after counts due subscribers beyond
    // this link's keyset window (advisory — from the HEAD count above).
    if (chainMode) {
      const remainingAfter = dueRemaining !== null
        ? Math.max(0, dueRemaining - slice.length)
        : (hasMore ? '?' : 0)
      console.log(`[send-digest] link=${link} cursor=${continuation ? continuation.cursor : 'start'} processed=${subsToProcess.length} sent=${sentCount} skipped=${skippedCount} failed=${failedCount} remaining_after=${remainingAfter}`)

      if (hasMore && nextCursor) {
        console.log(`[send-digest] link=${link} dispatching continuation cursor=${nextCursor}`)
        dispatchContinuation(buildContinuation(
          { date: dateStr, dow: todayDow, first: isFirstOfMonth, sessionTag, link },
          nextCursor,
        ))
      } else {
        console.log(`[send-digest] chain complete date=${dateStr} links=${link + 1}`)
      }
    }

    const summary = {
      ok: true,
      date: dateStr,
      link,
      has_more: hasMore,
      // subscribers_due: kept for the admin EmailPage's result message
      // ("sent N of M"). For a chain link 0 this is the WHOLE cohort (the
      // advisory count), while emails_sent covers only this link's slice —
      // has_more tells the caller the rest is continuing in the background.
      subscribers_due: dueRemaining ?? subsToProcess.length,
      subscribers_processed: subsToProcess.length,
      emails_sent: sentCount,
      skipped: skippedCount,
      failed: failedCount,
    }

    console.log('[send-digest] Complete:', summary)
    return json(summary)
  } catch (err) {
    console.error('[send-digest] Fatal error:', err)
    return json({ error: 'Internal error' }, 500)
  }
})
