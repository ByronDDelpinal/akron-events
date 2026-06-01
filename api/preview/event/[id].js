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
const SITE_ORIGIN = 'https://akronpulse.com'
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

// JSON-LD lives inside a <script> tag, so any '<' in the payload could
// terminate the script context early. JSON.stringify can produce '</', so
// we defensively escape the slash. Also escape U+2028/U+2029 which break
// some older JSON parsers.
function safeJsonLd(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// ────────────────────────────────────────────────────────────────────────
// SCHEMA BUILDERS (inlined so this Edge function stays self-contained)
//
// Keep these shapes aligned with src/lib/seo/schema.js — both run for the
// same event, so the SPA (after hydration) and the SSR preview (for bots)
// should describe events identically. If we change one builder, change
// the other.
// ────────────────────────────────────────────────────────────────────────

function buildPlaceSchema(venue) {
  if (!venue?.name) return undefined
  const place = { '@type': 'Place', name: venue.name }
  if (venue.address || venue.city) {
    place.address = {
      '@type': 'PostalAddress',
      streetAddress:   venue.address || undefined,
      addressLocality: venue.city    || 'Akron',
      addressRegion:   venue.state   || 'OH',
      postalCode:      venue.zip     || undefined,
      addressCountry:  'US',
    }
  }
  return place
}

function buildEventSchema(ev, origin) {
  const venue = ev.event_venues?.[0]?.venue ?? null
  const schema = {
    '@type': 'Event',
    '@id': `${origin}/events/${ev.id}#event`,
    name: ev.title,
    startDate: ev.start_at,
    url: `${origin}/events/${ev.id}`,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  }
  if (ev.end_at)      schema.endDate = ev.end_at
  if (ev.description) schema.description = ev.description
  if (ev.image_url)   schema.image = [ev.image_url]
  const place = buildPlaceSchema(venue)
  if (place) schema.location = place

  if (ev.price_min != null) {
    schema.offers = {
      '@type': 'Offer',
      price: String(ev.price_min),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: ev.ticket_url || `${origin}/events/${ev.id}`,
    }
  }
  return schema
}

function buildBreadcrumbSchema(crumbs, origin) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: `${origin}${c.path}`,
    })),
  }
}

// Related events become a full schema.org ItemList with embedded Event
// items. Richer than a bare URL list — gives LLMs enough metadata to
// summarize ("here are other family events you might like…") without
// having to follow each link separately.
function buildRelatedItemListSchema(events, origin, categoryLabel) {
  if (!events || events.length === 0) return undefined
  return {
    '@type': 'ItemList',
    name: `More ${categoryLabel} events in Akron`,
    numberOfItems: events.length,
    itemListElement: events.map((ev, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: buildEventSchema(ev, origin),
    })),
  }
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

    // Venues live in event_venues (many-to-many junction). Nested
    // select pattern matches what useEvents/useEvent does in the SPA.
    // Pulls the fields needed for a complete schema.org Event (price +
    // ticket + image + full venue address).
    const supabaseHeaders = {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: 'application/json',
    }
    const eventSelect =
      'id,title,description,start_at,end_at,category,' +
      'price_min,price_max,ticket_url,image_url,' +
      'event_venues(venue:venues(id,name,address,city,state,zip))'

    const resp = await fetch(
      `${supabaseUrl}/rest/v1/events?id=eq.${encodeURIComponent(id)}` +
        `&select=${eventSelect}`,
      { headers: supabaseHeaders },
    )
    if (!resp.ok) return fallbackHtml(null, `fetch-${resp.status}`)
    const rows = await resp.json()
    const event = Array.isArray(rows) ? rows[0] : null
    if (!event) return fallbackHtml('Event not found', 'no-row')

    // Related events: same category, different id, upcoming, status=published,
    // ordered by start_at, limit 5. Defensive — if this fetch fails, we
    // still emit the main event schema. Don't let related-events failure
    // tank the whole preview response.
    let related = []
    if (event.category) {
      try {
        const nowIso = new Date(Date.now() - 3 * 3600_000).toISOString()
        const relResp = await fetch(
          `${supabaseUrl}/rest/v1/events?` +
            `category=eq.${encodeURIComponent(event.category)}` +
            `&id=neq.${encodeURIComponent(event.id)}` +
            `&status=eq.published` +
            `&start_at=gte.${encodeURIComponent(nowIso)}` +
            `&order=start_at.asc&limit=5` +
            `&select=${eventSelect}`,
          { headers: supabaseHeaders },
        )
        if (relResp.ok) {
          const relRows = await relResp.json()
          if (Array.isArray(relRows)) related = relRows
        }
      } catch { /* swallow — preview still works without related */ }
    }

    // Build display strings. event_venues is an array of junction rows;
    // each has a nested `venue` (or null if the FK is unresolved).
    const venueRel  = event.event_venues?.[0]?.venue ?? null
    const venue     = venueRel?.name || ''
    const venueCity = venueRel?.city || ''
    const dateLine   = formatDateLine(event.start_at)
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

    // ── JSON-LD graph ────────────────────────────────────────────────
    // Event + BreadcrumbList for the current event, plus an ItemList of
    // related events when we have any. AI crawlers (GPTBot, ClaudeBot,
    // PerplexityBot, Google-Extended) extract this structured data and
    // use it as primary signal for citations and answer composition.
    const graph = [
      buildEventSchema(event, SITE_ORIGIN),
      buildBreadcrumbSchema([
        { name: 'Home',        path: '/' },
        { name: 'Events',      path: '/' },
        { name: eventTitle,    path: `/events/${event.id}` },
      ], SITE_ORIGIN),
      buildRelatedItemListSchema(related, SITE_ORIGIN, event.category || 'related'),
    ].filter(Boolean)

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': graph,
    }

    // Minimal but real body content — gives non-JS readers and AI
    // crawlers something useful to extract beyond the meta tags. Includes
    // a visible related-events list with internal links so the crawl
    // topology in the SSR'd HTML matches what client-side React renders.
    const venueLine = [venue, venueCity].filter(Boolean).join(', ')
    const relatedListHtml = related.length > 0
      ? `<h2>More ${escapeHtml(event.category || 'related')} events in Akron</h2>\n<ul>\n` +
        related.map(ev => {
          const evVenue = ev.event_venues?.[0]?.venue?.name || ''
          const evDate  = formatDateLine(ev.start_at)
          const suffix  = [evDate, evVenue].filter(Boolean).join(' · ')
          return `  <li><a href="${SITE_ORIGIN}/events/${ev.id}">${escapeHtml(ev.title)}</a>` +
                 (suffix ? ` — ${escapeHtml(suffix)}` : '') + `</li>`
        }).join('\n') +
        `\n</ul>`
      : ''
    const body = [
      `<h1>${escapeHtml(eventTitle)}</h1>`,
      dateLine && `<p><strong>When:</strong> ${escapeHtml(dateLine)}</p>`,
      venueLine && `<p><strong>Where:</strong> ${escapeHtml(venueLine)}</p>`,
      `<p>${escapeHtml(description)}</p>`,
      `<p><a href="${canonical}">View event on ${escapeHtml(SITE_NAME)} →</a></p>`,
      relatedListHtml,
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

<script type="application/ld+json">${safeJsonLd(jsonLd)}</script>

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
