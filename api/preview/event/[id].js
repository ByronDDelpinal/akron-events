/**
 * /api/preview/event/[id] — SSR'd HTML preview for link-unfurler /
 * crawler clients. Real users never hit this directly; the root
 * middleware.js rewrites bot-UA requests to /events/[id] here so
 * Slack/Discord/Facebook/Twitter/AI bots get correct meta tags inline.
 *
 * The HTML body intentionally contains minimal but real content (title,
 * summary, link to the live event page) so non-JS readers and AI
 * crawlers extracting article text still get something useful. A
 * meta-refresh sends any browser that lands here to the real SPA URL
 * after rendering — defensive, since middleware should prevent that.
 *
 * Vercel Edge runtime — fetches event data from Supabase REST directly.
 */

export const config = { runtime: 'edge' }

const SITE_NAME = 'Akron Pulse'
const SITE_ORIGIN = 'https://events.supportlocalakron.com'
const SITE_TAGLINE = 'Everything happening in Akron & Summit County'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

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

// Fallback HTML when something goes wrong — minimal brand chrome so
// shares don't render a "Not Found" preview even when Supabase blips.
// `reason` is echoed in an x-preview-fallback header so we can diagnose
// which branch fired without parsing response bodies.
function fallbackHtml(message, reason = 'unknown') {
  const title = `${SITE_NAME} — ${SITE_TAGLINE}`
  const desc  = message || `${SITE_NAME} is a free directory of local events in Akron, Ohio and Summit County.`
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:image" content="${SITE_ORIGIN}/og-default.jpg">
<meta name="twitter:card" content="summary_large_image">
</head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(desc)}</p></body>
</html>`
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'x-preview-fallback': reason,
    },
  })
}

export default async function handler(req) {
  try {
    const url = new URL(req.url)
    // Primary path: explicit ?id= query param (set by middleware).
    // Fallback: parse from the pathname, since Vercel's auto-mapping of
    // [id] segments isn't always present on middleware-rewritten URLs.
    let id = url.searchParams.get('id')
    if (!id) {
      const m = url.pathname.match(/\/event\/([a-f0-9-]{8,})/i)
      if (m) id = m[1]
    }
    if (!id) return fallbackHtml('Missing event id', 'no-id')

    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseKey) return fallbackHtml(null, 'no-env')

    const resp = await fetch(
      `${supabaseUrl}/rest/v1/events?id=eq.${encodeURIComponent(id)}` +
        `&select=id,title,description,start_at,end_at,category,venue:venues(name,city,address_1)`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: 'application/json',
        },
      },
    )
    if (!resp.ok) return fallbackHtml(null, `fetch-${resp.status}`)
    const rows = await resp.json()
    const event = Array.isArray(rows) ? rows[0] : null
    if (!event) return fallbackHtml('Event not found', 'no-row')

    // Build display strings
    const dateLine  = formatDateLine(event.start_at)
    const venue     = event.venue?.name || event.venue?.[0]?.name || ''
    const venueCity = event.venue?.city || event.venue?.[0]?.city || ''
    const eventTitle = event.title || 'Event'

    // Page title format mirrors what EventPage.jsx builds for SEO:
    //   "<title> — <date> at <venue> | Akron Pulse"
    const titleCore = venue
      ? `${eventTitle} — ${dateLine} at ${venue}`
      : `${eventTitle} — ${dateLine}`
    const pageTitle = `${titleCore} | ${SITE_NAME}`

    // Description: first 155 chars of the event description, or a built one.
    const rawDesc = (event.description ||
      `${eventTitle} — ${dateLine}${venue ? ' at ' + venue : ''} in Akron, OH.`)
      .replace(/\s+/g, ' ')
      .trim()
    const description = rawDesc.length > 155
      ? rawDesc.slice(0, 152).trimEnd() + '…'
      : rawDesc

    const canonical = `${SITE_ORIGIN}/events/${event.id}`
    const ogImage   = `${SITE_ORIGIN}/api/og/event/${event.id}`

    // Minimal but real body content — gives non-JS readers and AI
    // crawlers something useful to extract beyond the meta tags.
    const venueLine = [venue, venueCity].filter(Boolean).join(', ')
    const body = [
      `<h1>${escapeHtml(eventTitle)}</h1>`,
      dateLine && `<p><strong>When:</strong> ${escapeHtml(dateLine)}</p>`,
      venueLine && `<p><strong>Where:</strong> ${escapeHtml(venueLine)}</p>`,
      `<p>${escapeHtml(description)}</p>`,
      `<p><a href="${canonical}">View event on ${escapeHtml(SITE_NAME)} →</a></p>`,
    ].filter(Boolean).join('\n')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">

<meta property="og:type" content="event">
<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${escapeHtml(titleCore)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="en_US">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(titleCore)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${ogImage}">

<!-- Defense in depth: middleware should keep real users out of here,
     but if one lands, send them to the real SPA URL. Crawlers ignore. -->
<meta http-equiv="refresh" content="0;url=${canonical}">
</head>
<body>
${body}
</body>
</html>`

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Match the OG image's cache profile so previews and the image
        // age together. 1h browser, 1d edge, 1w stale-while-revalidate.
        'Cache-Control':
          'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        // Lets us confirm "the function ran the success path" with one
        // curl, without parsing the HTML body.
        'x-preview-ok': '1',
      },
    })
  } catch (err) {
    return fallbackHtml()
  }
}
