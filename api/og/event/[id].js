/**
 * /api/og/event/[id] — dynamic share image per event.
 *
 * Renders a branded PNG on-demand using @vercel/og. Every event gets a
 * consistent share preview regardless of whether it has a banner-eligible
 * photo, so social shares (Slack, iMessage, Discord, Twitter) always show
 * event-specific details + Akron Pulse branding instead of a generic
 * placeholder.
 *
 * THREE SIZES, one renderer, chosen with ?size= (see SIZES below):
 *
 *   link    1200×630   the default. This is the og:image, unchanged, and
 *                      every existing caller keeps getting it by omitting
 *                      the parameter.
 *   square  1080×1080  Instagram feed.
 *   story   1080×1920  Instagram/Facebook Stories and Reels covers.
 *
 * The square and story sizes exist for the partner share kit: a partner
 * cannot create a Facebook Event through any API (Meta removed
 * create_event in 2014 and never replaced it), so the product ships them a
 * ready-to-post image and caption instead. See PartnerShareDialog.tsx.
 *
 * Story CENTERS its text block rather than bottom-anchoring it, because
 * Stories crop hard top and bottom and put UI chrome over both ends. Every
 * other size keeps the bottom-left composition.
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

/**
 * The SAME gradient the site paints, per theme.
 *
 * Generated from the `--green-deep` / `--green-mid` / `--coral` triple in
 * src/styles/themes.css, which is where all 15 palettes live. Satori cannot
 * read a stylesheet, so the values are inlined here; test-share-kit.js pins
 * this table against the THEMES list so a new palette cannot ship with the
 * card silently falling back to the category ramp.
 *
 * WHY A THEME RAMP AT ALL: a partner posting to their own feed is posting
 * their own brand. The category ramp is right for a link unfurl on the open
 * web (nobody there has picked a palette), so `?theme=` is opt-in and the
 * default is unchanged.
 */
const THEME_GRADIENTS = {
  'civic-classic': `linear-gradient(140deg, #1D2B1F 0%, #3A6B4A 55%, #BC4F28 100%)`,
  'akron-pulse': `linear-gradient(140deg, #0A3B48 0%, #2A8A9D 55%, #BB4E3E 100%)`,
  'pulse-red': `linear-gradient(140deg, #1F2A40 0%, #4A5878 55%, #C03423 100%)`,
  'twilight-plum': `linear-gradient(140deg, #2D1A28 0%, #8B5D7D 55%, #8F6818 100%)`,
  'forest-amber': `linear-gradient(140deg, #1F2D24 0%, #5C9476 55%, #B8761A 100%)`,
  'harbor-civic': `linear-gradient(140deg, #0F2540 0%, #B8893E 55%, #B04E31 100%)`,
  'violet-hour': `linear-gradient(140deg, #1E0E2E 0%, #2D9B9B 55%, #C03F3F 100%)`,
  'boardwalk': `linear-gradient(140deg, #0F3D5E 0%, #FBB13C 55%, #C54123 100%)`,
  'olive-grove': `linear-gradient(140deg, #1B2021 0%, #A6A867 55%, #B04D3D 100%)`,
  'arcade-night': `linear-gradient(140deg, #272727 0%, #2B50AA 55%, #E3000F 100%)`,
  'stargazer': `linear-gradient(140deg, #183642 0%, #73628A 55%, #B5496A 100%)`,
  'grand-piano': `linear-gradient(140deg, #111111 0%, #555555 55%, #514A4A 100%)`,
  'prime-time': `linear-gradient(140deg, #0D2C54 0%, #FFB400 55%, #CF360F 100%)`,
  'postcard': `linear-gradient(140deg, #035E68 0%, #0BAEC1 55%, #DA0553 100%)`,
  'howard-street': `linear-gradient(140deg, #0A5236 0%, #0B7345 55%, #0C7A4D 100%)`,
}

/**
 * Text on the card is near-white, and several palettes put a LIGHT stop mid
 * ramp (Prime Time's #FFB400, Boardwalk's #FBB13C, Olive Grove's #A6A867).
 * White on those is about 2:1, under the 3:1 floor for large text, and the
 * title sits exactly there.
 *
 * So the veil covers the whole frame, not just the foot: ~20% at the top
 * where the ramps are already dark, ~30% through the text band, ~52% at the
 * bottom where the CTA sits. It costs a little saturation on the dark
 * palettes and buys legibility on every one of the fifteen.
 */
const SCRIM = 'linear-gradient(0deg, rgba(0,0,0,0.52) 0%, rgba(0,0,0,0.30) 45%, rgba(0,0,0,0.20) 100%)'

/** ?theme=, validated against the table. Anything unknown falls back to null. */
function resolveThemeGradient(raw) {
  return (raw && THEME_GRADIENTS[raw]) || null
}

/**
 * The three renders. Everything that changes between them lives here, so a
 * layout tweak cannot land on one size and miss the other two.
 *
 * `titleTiers` is the same heuristic the single-size version used, scaled:
 * long titles drop a tier so Satori's word-boundary wrapping does not
 * overflow the frame. `maxTextWidth` is the frame minus its own padding.
 *
 * `titleBreaks` is per-size and NOT shared, which is the non-obvious part.
 * What decides how many lines a title takes is characters per line, and
 * that is maxTextWidth/fontSize: about 12 em on link, 8.8 on square, 7.9 on
 * story. The same title wraps to noticeably more lines on the narrower
 * frames, so they have to step down to a smaller tier at a shorter title.
 * One shared pair of thresholds would size link correctly and overrun the
 * other two on exactly the long titles the heuristic exists for.
 */
const SIZES = {
  link: {
    width: 1200, height: 630,
    padding: '64px 72px',
    markFont: '34px', markDot: 14,
    titleTiers: ['88px', '68px', '54px'],
    titleBreaks: [50, 80],
    subFont: '32px', tagFont: '22px',
    gap: '22px', tagGap: '36px',
    maxTextWidth: '1056px',
    center: false,
  },
  square: {
    width: 1080, height: 1080,
    padding: '80px 84px',
    markFont: '40px', markDot: 17,
    titleTiers: ['104px', '84px', '64px'],
    titleBreaks: [40, 66],
    subFont: '38px', tagFont: '26px',
    gap: '28px', tagGap: '48px',
    maxTextWidth: '912px',
    center: false,
  },
  story: {
    width: 1080, height: 1920,
    // Deep top and bottom padding: the Stories UI puts a profile row over
    // the top and a reply bar over the bottom of every frame.
    padding: '220px 88px 260px',
    markFont: '42px', markDot: 18,
    titleTiers: ['116px', '92px', '70px'],
    titleBreaks: [36, 60],
    subFont: '46px', tagFont: '30px',
    gap: '34px', tagGap: '56px',
    maxTextWidth: '904px',
    /**
     * A story is a POSTER, not a wide card with margins.
     *
     * Anchoring the text like the other two left 1,920px of frame with a
     * paragraph floating in the upper third and nothing else, which is what
     * an unfinished slide looks like. This composition spreads three blocks
     * across the whole height (mark at the top safe line, the event in the
     * optical centre, the address at the bottom one) so the gradient reads as
     * a designed surface rather than an oversized background.
     */
    composition: 'poster',
    dateFont: '54px',
    ctaFont: '34px',
  },
}

/** ?size=, defaulted and validated. An unknown value is the default, never an error. */
function resolveSize(raw) {
  return SIZES[raw] ?? SIZES.link
}

/**
 * "Wednesday, November 18 · 6 PM", read in EASTERN.
 *
 * Was getUTC* until 2026-08-25, which ran every card and every unfurl 4-5
 * hours late and rolled anything from 8 PM onward onto the next DAY: the
 * Ward 2 meeting at 6 PM Eastern rendered "November 18 · 11 PM". Every event
 * in this corpus happens in Akron, so the card is written for a reader
 * standing there, never in UTC and never in the viewer's own zone.
 *
 * Intl with an explicit timeZone rather than a fixed -4/-5 offset: an offset
 * constant is wrong for the hours around each DST switch. Mirrors
 * src/lib/admin/shareShared.ts's shareDateLine and src/lib/easternDate.ts,
 * which cannot be imported here (Edge bundle, no src/ alias).
 */
const EASTERN_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'long', month: 'long', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
})

function formatDateLine(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = EASTERN_PARTS.formatToParts(d)
  const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
  const minute = get('minute')
  const time = `${get('hour')}${minute === '00' ? '' : `:${minute}`} ${get('dayPeriod')}`
  return `${get('weekday')}, ${get('month')} ${get('day')} · ${time}`
}

// Brand mark — pulse dot + "Akron Pulse" wordmark with teal accent on
// "Pulse". Reused in both the primary layout and the fallback.
function brandMark({ size = 'large', fontSize: fontOverride, dotPx: dotOverride } = {}) {
  const fontSize = fontOverride ?? (size === 'large' ? '34px' : '56px')
  const dotPx    = dotOverride ?? (size === 'large' ? 14 : 22)
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
function fallbackImage(message, size = SIZES.link) {
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
    { width: size.width, height: size.height },
  )
}

export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    const size = resolveSize(searchParams.get('size'))
    const themeGradient = resolveThemeGradient(searchParams.get('theme'))
    if (!id) return fallbackImage('Missing event id', size)

    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseKey) return fallbackImage(undefined, size)

    // Direct REST query — avoids pulling supabase-js into the Edge bundle.
    // Venues live in event_venues (many-to-many junction); nested select
    // matches what useEvents/useEvent does in the SPA.
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/events?id=eq.${encodeURIComponent(id)}` +
        `&select=title,start_at,event_categories(category),event_venues(venue:venues(name))`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Accept: 'application/json',
        },
      },
    )
    if (!resp.ok) return fallbackImage(undefined, size)
    const rows = await resp.json()
    const event = Array.isArray(rows) ? rows[0] : null
    if (!event) return fallbackImage('Event not found', size)

    const primaryCategory = event.event_categories?.[0]?.category
    // A theme, when the caller named one (the partner share kit does), else
    // the event's own category ramp — which is what every public unfurl gets.
    const gradient  = themeGradient || GRADIENTS[primaryCategory] || GRADIENTS.other
    const dateLine  = formatDateLine(event.start_at)
    const venueName = event.event_venues?.[0]?.venue?.name || ''
    const subtitle  = [dateLine, venueName].filter(Boolean).join(' · ')
    const title     = (event.title || 'Event').slice(0, 200)

    // Heuristic title sizing — long titles drop a tier so they don't
    // overflow. Satori wraps on word boundaries inside flex. Tiers come
    // from the size table so all three frames step down together.
    const titleSize =
      title.length > size.titleBreaks[1] ? size.titleTiers[2] :
      title.length > size.titleBreaks[0] ? size.titleTiers[1] :
                                           size.titleTiers[0]

    // ── Poster (story) ────────────────────────────────────────────────
    // Three blocks, spread across the full height. Date gets its own line
    // and its own size: in a story the only question a viewer answers in the
    // two seconds it is on screen is "when, and can I go".
    if (size.composition === 'poster') {
      return new ImageResponse(
        h('div', {
          style: {
            width: '100%', height: '100%',
            display: 'flex', flexDirection: 'column',
            justifyContent: 'space-between',
            padding: size.padding,
            background: gradient,
            color: '#FCFAF4',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            position: 'relative',
          },
        },
          h('div', {
            style: {
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              display: 'flex', background: SCRIM,
            },
          }),

          brandMark({ fontSize: size.markFont, dotPx: size.markDot }),

          h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: size.maxTextWidth },
          },
            h('div', {
              style: {
                display: 'flex', fontSize: titleSize, fontWeight: 700,
                lineHeight: 1.06, letterSpacing: '-0.025em',
              },
            }, title),
            dateLine && h('div', {
              style: { display: 'flex', fontSize: size.dateFont, fontWeight: 600, letterSpacing: '-0.01em' },
            }, dateLine),
            venueName && h('div', {
              style: { display: 'flex', fontSize: size.subFont, fontWeight: 400, opacity: 0.82 },
            }, venueName),
          ),

          h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '18px' },
          },
            // A hairline instead of a box: it separates the address from the
            // event without adding a second shape to a frame that is carrying
            // one idea.
            h('div', { style: { display: 'flex', width: '140px', height: '3px', background: '#FCFAF4', opacity: 0.5 } }),
            h('div', {
              style: {
                display: 'flex', fontSize: size.ctaFont, opacity: 0.82,
                letterSpacing: '0.02em',
              },
            }, 'Full details at akronpulse.com'),
          ),
        ),
        { width: size.width, height: size.height },
      )
    }

    return new ImageResponse(
      h('div', {
        style: {
          width:  '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          // Story centers its block; the others keep the bottom-left
          // composition and push the text down with marginTop: auto below.
          justifyContent: size.center ? 'center' : 'flex-start',
          padding: size.padding,
          background: gradient,
          color: '#FCFAF4',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          position: 'relative',
        },
      },
        // Scrim, under everything. Satori has no z-index worth trusting, so
        // this is a positioned sibling declared FIRST and the content after
        // it paints on top in document order.
        h('div', {
          style: {
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            display: 'flex',
            background: SCRIM,
          },
        }),
        // Brand mark, top-left. On a centered (story) frame it must not
        // absorb the free space, so it only grows on the anchored layouts.
        brandMark({ fontSize: size.markFont, dotPx: size.markDot }),

        // Title + meta — pushed to bottom-left
        h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: size.gap,
            marginTop: size.center ? '0px' : 'auto',
            paddingTop: size.center ? '64px' : '0px',
          },
        },
          h('div', {
            style: {
              display: 'flex',
              fontSize: titleSize,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: '-0.025em',
              maxWidth: size.maxTextWidth,
            },
          }, title),
          subtitle && h('div', {
            style: {
              display: 'flex',
              fontSize: size.subFont,
              fontWeight: 400,
              opacity: 0.85,
              maxWidth: size.maxTextWidth,
            },
          }, subtitle),
        ),

        // Tagline — bottom, low emphasis. Doubles as a brand repeat
        // for shares where the top mark gets cropped.
        h('div', {
          style: {
            display: 'flex',
            // Plain margin, never `auto`: the title block above already
            // claims the free space with marginTop:auto on the anchored
            // layouts, and a second auto would split it between the two.
            marginTop: size.tagGap,
            fontSize: size.tagFont,
            opacity: 0.55,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          },
        }, 'Akron events · in one place'),
      ),
      {
        width: size.width,
        height: size.height,
        headers: {
          // Browser holds for an hour; edge holds for a day; SWR covers a
          // week so slow regeneration never blocks.
          'Cache-Control':
            'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    )
  } catch {
    // Binding dropped, not renamed: the fallback is unconditional, so the
    // error was never read. (Surfaced when `npm run lint` started covering
    // api/ on 2026-08-14.) The size is re-read here rather than hoisted:
    // the throw can come from the URL parse itself.
    return fallbackImage()
  }
}
