/**
 * /api/og/event/[id] — dynamic Open Graph image per event.
 *
 * Renders a branded 1200×630 PNG on-demand using @vercel/og (Satori under
 * the hood). Every event gets a beautiful, consistent share preview
 * regardless of whether it has a banner-eligible photo, so social posts
 * (Slack, iMessage, Discord, Twitter, etc.) always show event-specific
 * details + Akron Pulse branding instead of a generic placeholder.
 *
 * Cached at the edge for a day with a week-long stale-while-revalidate
 * window — event titles and dates rarely change after publish, and even
 * if they do, the stale image being served briefly is harmless.
 *
 * Vercel Edge runtime, not Node — required by @vercel/og.
 */

import { ImageResponse } from '@vercel/og'

export const config = { runtime: 'edge' }

// Mirrors --gradient-* tokens in src/styles/globals.css. Satori can't read
// CSS variables, so the values are inlined. Keep in sync when palettes
// shift; ideally extract to a shared lib once we have a second consumer.
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

// Errors should still return a 200 with a fallback image so social
// previews don't break when something goes sideways. This is the
// fallback layout — minimal Akron Pulse branding, no event-specific data.
function fallbackImage(message) {
  return new ImageResponse(
    (
      <div style={{
        width:  '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: GRADIENTS.other,
        color: '#FCFAF4',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '56px', fontWeight: 700 }}>
          <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: '#FCFAF4' }} />
          <span>Akron <span style={{ color: '#56B0C2' }}>Pulse</span></span>
        </div>
        <div style={{ marginTop: '20px', fontSize: '28px', opacity: 0.75 }}>
          {message || 'Akron events · in one place'}
        </div>
      </div>
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

    // Direct REST query — avoids pulling the supabase-js client into the
    // Edge bundle just for one read.
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
    // overflow the canvas. Satori wraps on word boundaries inside flex.
    const titleSize =
      title.length > 80 ? '54px' :
      title.length > 50 ? '68px' :
                          '88px'

    return new ImageResponse(
      (
        <div style={{
          width:  '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 72px',
          background: gradient,
          color: '#FCFAF4',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          {/* Brand mark, top-left */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            fontSize: '34px',
            fontWeight: 500,
            letterSpacing: '-0.01em',
          }}>
            <div style={{
              width:  '14px',
              height: '14px',
              borderRadius: '50%',
              background: '#FCFAF4',
              opacity: 0.95,
            }} />
            <span style={{ display: 'flex', gap: '8px' }}>
              <span style={{ opacity: 0.92 }}>Akron</span>
              <span style={{ color: '#56B0C2', fontWeight: 600 }}>Pulse</span>
            </span>
          </div>

          {/* Title + meta — pushed to the bottom-left so the page reads
              brand → headline → details from top to bottom-left. */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '22px',
            marginTop: 'auto',
          }}>
            <div style={{
              display: 'flex',
              fontSize: titleSize,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: '-0.025em',
              maxWidth: '1056px',
            }}>{title}</div>

            {subtitle && (
              <div style={{
                display: 'flex',
                fontSize: '32px',
                fontWeight: 400,
                opacity: 0.85,
                maxWidth: '1056px',
              }}>{subtitle}</div>
            )}
          </div>

          {/* Tagline — bottom-right, low emphasis. Doubles as a brand
              repeat for shares where the top mark gets cropped. */}
          <div style={{
            display: 'flex',
            marginTop: '36px',
            fontSize: '22px',
            opacity: 0.55,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            Akron events · in one place
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          // Browser holds for an hour; edge holds for a day; stale-while-
          // revalidate covers a week so a slow regeneration never blocks.
          'Cache-Control':
            'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    )
  } catch (err) {
    return fallbackImage()
  }
}
