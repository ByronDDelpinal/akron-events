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

const BASE_URL = Deno.env.get('PUBLIC_SITE_URL') || 'https://events.supportlocalakron.com'
const BATCH_SIZE = 100
const MAX_EVENTS_PER_EMAIL = 10

// ── Brand theme (mirrors src/lib/emailTheme.js — update both together) ──
const THEME = {
  brandName: 'Turnout',
  copyrightHolder: 'Turnout',
  location: 'Akron, OH',
  from: 'Turnout <digest@events.supportlocalakron.com>',
  colors: {
    primary:       '#D4922A',
    background:    '#FAF6EF',
    card:          '#FFFFFF',
    dark:          '#1D2B1F',
    textPrimary:   '#17200F',
    textSecondary: '#3A4E30',
    textMuted:     '#7A9068',
    border:        '#E0D9CA',
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
  category: string
  tags: string[]
  price_min: number
  price_max: number | null
  age_restriction: string
  image_url: string | null
  ticket_url: string | null
  featured: boolean
  venues: { name: string; address: string | null; lat: number | null; lng: number | null }[]
  organizations: { id: string; name: string }[]
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

    // Intents/categories (skip if "all")
    if (!prefs.intents.includes('all') && prefs.categories.length > 0) {
      if (!prefs.categories.includes(event.category)) return false
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

// ── Build email HTML (inline styles for email client compatibility) ──
// All colors/fonts reference THEME so a brand swap only touches one object.
function buildDigestHtml(events: Event[], sub: Subscriber, totalMatchCount: number): string {
  const prefsUrl = `${BASE_URL}/subscribe/preferences?token=${sub.token}`
  const unsubUrl = `${BASE_URL}/unsubscribe?token=${sub.token}`
  const c = THEME.colors
  const f = THEME.fonts

  const hero = events.find(e => e.featured)
  const picks = events.filter(e => e !== hero)

  let html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:${c.background};font-family:${f.body};">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;">

  <div style="text-align:center;margin-bottom:28px;">
    <span style="font-family:${f.display};font-size:1.3rem;font-weight:700;color:${c.dark};letter-spacing:-0.02em;">${THEME.brandName}</span>
  </div>
`

  // Hero event
  if (hero) {
    const venue = hero.venues[0]
    const date = new Date(hero.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    html += `
  <div style="background:${c.card};border-radius:12px;overflow:hidden;margin-bottom:20px;border:1px solid ${c.border};">
    ${hero.image_url ? `<img src="${hero.image_url}" alt="" style="width:100%;height:200px;object-fit:cover;display:block;">` : ''}
    <div style="padding:20px;">
      <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${c.primary};margin-bottom:6px;">Featured</div>
      <div style="font-family:${f.display};font-size:1.1rem;font-weight:700;color:${c.textPrimary};margin-bottom:6px;">${hero.title}</div>
      <div style="font-size:0.82rem;color:${c.textSecondary};margin-bottom:4px;">${date}</div>
      ${venue ? `<div style="font-size:0.78rem;color:${c.textMuted};">${venue.name}</div>` : ''}
      ${hero.price_min === 0 && !hero.price_max ? `<div style="display:inline-block;margin-top:8px;padding:3px 10px;background:${c.freeBg};color:${c.freeTxt};font-size:0.72rem;font-weight:600;border-radius:10px;">Free</div>` : ''}
      ${hero.ticket_url ? `<a href="${hero.ticket_url}" style="display:inline-block;margin-top:10px;padding:8px 18px;background:${c.primary};color:${c.white};text-decoration:none;border-radius:8px;font-size:0.82rem;font-weight:600;">Get Tickets</a>` : ''}
    </div>
  </div>
`
  }

  // Picks
  if (picks.length > 0) {
    html += `<div style="font-family:${f.display};font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${c.textMuted};border-bottom:1px solid ${c.border};padding-bottom:8px;margin-bottom:16px;">Your picks</div>`

    for (const event of picks) {
      const venue = event.venues[0]
      const date = new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      const isFree = event.price_min === 0 && !event.price_max

      html += `
  <div style="display:flex;gap:14px;padding:14px 0;border-bottom:1px solid ${c.border};">
    ${event.image_url ? `<img src="${event.image_url}" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:8px;flex-shrink:0;">` : ''}
    <div style="flex:1;min-width:0;">
      <div style="font-family:${f.display};font-size:0.88rem;font-weight:700;color:${c.textPrimary};margin-bottom:3px;">${event.title}</div>
      <div style="font-size:0.78rem;color:${c.textSecondary};">${date}</div>
      ${venue ? `<div style="font-size:0.73rem;color:${c.textMuted};">${venue.name}</div>` : ''}
      ${isFree ? `<span style="display:inline-block;margin-top:4px;padding:2px 8px;background:${c.freeBg};color:${c.freeTxt};font-size:0.68rem;font-weight:600;border-radius:8px;">Free</span>` : ''}
    </div>
  </div>
`
    }
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

  const now = new Date()
  const todayDow = now.getDay() // 0=Sun..6=Sat
  const isFirstOfMonth = now.getDate() === 1
  const dateStr = now.toISOString().slice(0, 10)

  console.log(`[send-digest] Starting for ${dateStr}, DOW=${todayDow}, 1st=${isFirstOfMonth}`)

  try {
    // ── Step 1: WHO is due today? ──
    let query = supabase
      .from('subscribers')
      .select('id, email, frequency, lookahead_days, preferences, token')
      .eq('confirmed', true)
      .is('unsubscribed_at', null)

    // Build OR conditions for frequency matching
    // Daily subscribers: always due
    // Weekly subscribers: due if send_day matches today
    // Monthly subscribers: due on the 1st only
    const conditions = [`frequency.eq.daily`]
    conditions.push(`and(frequency.eq.weekly,send_day.eq.${todayDow})`)
    if (isFirstOfMonth) {
      conditions.push(`frequency.eq.monthly`)
    }

    query = query.or(conditions.join(','))

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
        id, title, description, start_at, end_at, category, tags,
        price_min, price_max, age_restriction, image_url, ticket_url, featured,
        event_venues!inner ( venues!inner ( id, name, address, lat, lng ) ),
        event_organizations ( organizations ( id, name ) )
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
      venues: (e.event_venues || []).map((ev: any) => ev.venues).filter(Boolean),
      organizations: (e.event_organizations || []).map((eo: any) => eo.organizations).filter(Boolean),
    }))

    console.log(`[send-digest] ${flatEvents.length} events in 30-day window`)

    // ── Step 3+4+5: Filter → Render → Batch send ──
    const emailBatch: { from: string; to: string[]; subject: string; html: string; headers: Record<string, string> }[] = []
    const sendLog: { subscriber_id: string; event_count: number; status: string; error_message?: string }[] = []

    for (const sub of subscribers as Subscriber[]) {
      try {
        // Get ALL matching events (for count), then take top N
        const allMatching = filterEventsForSubscriber(flatEvents, sub, now)
        const events = allMatching.slice(0, MAX_EVENTS_PER_EMAIL)

        if (events.length === 0) {
          // Skip — don't send empty digests
          sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'skipped' })
          continue
        }

        const html = buildDigestHtml(events, sub, allMatching.length)
        const subject = buildSubject(sub.frequency, events.length)

        emailBatch.push({
          from: THEME.from,
          to: [sub.email],
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
          idempotencyKey: `digest-${dateStr}/chunk-${chunkIndex}`,
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
      idempotency_key: `digest-${dateStr}/${log.subscriber_id}`,
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
