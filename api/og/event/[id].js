/**
 * /api/og/event/[id] — dynamic Open Graph image per event.
 *
 * Renders a branded 1200×630 PNG on-demand using @vercel/og. Every event
 * gets a consistent share preview regardless of whether it has a banner-
 * eligible photo, so social shares (Slack, iMessage, Discord, Twitter)
 * always show event-specific details + Akron Pulse branding instead of
 * a generic placeholder.
 *
 * Plain .js (not .jsx) using React.createElement — Vercel's auto-
 * discovery for /api/ functions reliably picks up .js across project
 * types; .jsx is only consistent inside Next.js projects.
 *
 * Cached at the edge for a day with a week-long stale-while-revalidate
 * window — event details rarely change after publish.
 *
 * Vercel Edge runtime, not Node — required by @vercel/og.
 */

import { ImageResponse } from '@vercel/og'
import { createElement as h } from 'react'

export const config = { runtime: 'edge' }

// Mirrors --gradient-* tokens in src/styles/globals.css. Satori can't
// read CSS vars; values are inlined. Keep in sync when palettes shift.
const GRADIENTS = {
  music:     'linear-gradient(140deg, #162806 0%, #2A5C18 55%, #D4922A 100%)',
  art:       'linear-gradient(140deg, #180A26 0%, #481870 55%, #9848E0 100%)',
  food:      'linear-gradient(140deg, #082010 0%, #186030 50%, #68AF78 100%)',
  community: 'linear-gradient(140deg, #082010 0%, #186030 50%, #68AF78 100%)',
  nonprofit: 'linear-gradient(140deg, #180808 0%, #501828 50%, #D4922A 100%)',
  education: 'linear-gradient(140deg, #100828 0%, #2E1060 45%, #8050D0 100%)',
  sports:    'linear-gradient(140deg, #081828 0%, #1040A0 50%, #60B8E8 100%)',
  fitness:   'linear-gradient(140deg, #0A2818 0%, #18784A 50%, #58C888 100%)',
  nature:    'linear-gradient(140deg, #1A2A0E 0%, #4A6818 55%, #B5C268 100%)',
  other:     'linear-gradient(140deg, #1D2B1F 0%, #3A6B4A 55%, #D4922A 100%)',
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

function formatDateLine(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day   = DAYS[d.getUTCDay()]
  const month = MONTHS[d.getUTCMonth()]
  const date  = d.getUTCDate()
  let hours   = d.getUTCHours()
  const mins  = d.getUTCMinutes()
  const ampm  = hours >= 12 ? 'PM' : 'AM'
  hours       = hours % 12 || 12
  const minStr = mins === 0 ? '' : `:${String(mins).padStart(2, '0')}`
  return `${day}, ${month} ${date} · ${hours}${minStr} ${ampm}`
}

// Brand mark — pulse dot + "Akron Pulse" wordmark with teal accent on
// "Pulse". Reused in both the primary layout and the fallback.
function brandMark({ size = 'large' } = {}) {
  const fontSize = size === 'large' ? '34px' : '56px'
  const dotPx    = size === 'large' ? 14 : 22
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      fontSize,
      fontWeight: 500,
      letterSpacing: '-0.01em',
    },
  },
    h('div', {
      style: {
        width:  `${dotPx}px`,
        height: `${dotPx}px`,
        borderRadius: '50%',
        background: '#FCFAF4',
        opacity: 0.95,
      },
    }),
    h('span', { style: { display: 'flex', gap: '8px' } },
      h('span', { style: { opacity: 0.92 } }, 'Akron'),
      h('span', { style: { color: '#56B0C2', fontWeight: 600 } }, 'Pulse'),
    ),
  )
}

// Fallback layout when something goes wrong — always returns a 200 with
// minimal Akron Pulse branding so a broken event never breaks the share.
function fallbackImage(message) {
  return new ImageResponse(
    h('div', {
      style: {
        width:  '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: GRADIENTS.other,
        color: '#FCFAF4',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      },
    },
      brandMark({ size: 'xl' }),
      h('div', {
        style: { display: 'flex', marginTop: '20px', fontSize: '28px', opacity: 0.75 },
      }, message || 'Akron events · in one place'),
    ),
    { width: 1200, height: 630 },
  )
}

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return fallbackImage('Missing event id')

    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseKey) return fallbackImage()

    // Direct REST query — avoids pulling supabase-js into the Edge bundle.
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/events?id=eq.${encodeURIComponent(id)}` +
        `&select=title,start_at,category,venue:venues(name)`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: 'application/json',
        },
      },
    )
    if (!resp.ok) return fallbackImage()
    const rows = await resp.json()
    const event = Array.isArray(rows) ? rows[0] : null
    if (!event) return fallbackImage('Event not found')

    const gradient  = GRADIENTS[event.category] || GRADIENTS.other
    const dateLine  = formatDateLine(event.start_at)
    const venueName = event.venue?.name || event.venue?.[0]?.name || ''
    const subtitle  = [dateLine, venueName].filter(Boolean).join(' · ')
    const title     = (event.title || 'Event').slice(0, 200)

    // Heuristic title sizing — long titles drop a tier so they don't
    // overflow. Satori wraps on word boundaries inside flex.
    const titleSize =
      title.length > 80 ? '54px' :
      title.length > 50 ? '68px' :
                          '88px'

    return new ImageResponse(
      h('div', {
        style: {
          width:  '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 72px',
          background: gradient,
          color: '#FCFAF4',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        },
      },
        // Brand mark, top-left
        brandMark(),

        // Title + meta — pushed to bottom-left
        h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '22px',
            marginTop: 'auto',
          },
        },
          h('div', {
            style: {
              display: 'flex',
              fontSize: titleSize,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: '-0.025em',
              maxWidth: '1056px',
            },
          }, title),
          subtitle && h('div', {
            style: {
              display: 'flex',
              fontSize: '32px',
              fontWeight: 400,
              opacity: 0.85,
              maxWidth: '1056px',
            },
          }, subtitle),
        ),

        // Tagline — bottom, low emphasis. Doubles as a brand repeat
        // for shares where the top mark gets cropped.
        h('div', {
          style: {
            display: 'flex',
            marginTop: '36px',
            fontSize: '22px',
            opacity: 0.55,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          },
        }, 'Akron events · in one place'),
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          // Browser holds for an hour; edge holds for a day; SWR covers a
          // week so slow regeneration never blocks.
          'Cache-Control':
            'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    )
  } catch (err) {
    return fallbackImage()
  }
}
