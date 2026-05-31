/**
 * /api/og/hub/[slug] — dynamic Open Graph image per category /
 * neighborhood hub.
 *
 * Renders a branded 1200×630 PNG so a shared `/events/concerts` link
 * gets a distinct preview ("Concerts in Akron, OH | Akron Pulse")
 * instead of falling back to the generic og-default.jpg. This is the
 * companion to /api/og/event/[id] — same Edge runtime, same brand
 * mark, same caching policy.
 *
 * The hub registry lives in src/lib/seo/categories.js and is the
 * single source of truth for the title, the gradient family, and
 * which hub slugs are valid.
 *
 * Cached at the edge for a day with a week-long SWR window — hub
 * copy changes rarely so aggressive caching is safe.
 */

import { ImageResponse } from '@vercel/og'
import { createElement as h } from 'react'
import { getHub, getCategoryHub } from '../../../src/lib/seo/categories.js'

export const config = { runtime: 'edge' }

// Mirrors --gradient-* tokens in src/styles/globals.css and the event
// OG endpoint. Hub pages pick a gradient by category for the category
// hubs; neighborhood hubs use a neutral gradient because they span
// multiple categories.
const GRADIENTS = {
  // Category hub gradients map slug → gradient
  concerts:     'linear-gradient(140deg, #162806 0%, #2A5C18 55%, #D4922A 100%)',
  art:          'linear-gradient(140deg, #180A26 0%, #481870 55%, #9848E0 100%)',
  'food-drink': 'linear-gradient(140deg, #082010 0%, #186030 50%, #68AF78 100%)',
  family:       'linear-gradient(140deg, #100828 0%, #2E1060 45%, #8050D0 100%)',
  outdoor:      'linear-gradient(140deg, #1A2A0E 0%, #4A6818 55%, #B5C268 100%)',
  free:         'linear-gradient(140deg, #1D2B1F 0%, #3A6B4A 55%, #D4922A 100%)',
  'this-weekend': 'linear-gradient(140deg, #1D2B1F 0%, #3A6B4A 55%, #D4922A 100%)',
  today:        'linear-gradient(140deg, #162806 0%, #2A5C18 55%, #D4922A 100%)',
  // Neighborhood hub fallback
  _neighborhood: 'linear-gradient(140deg, #081828 0%, #1040A0 50%, #60B8E8 100%)',
  // Generic fallback
  _other:       'linear-gradient(140deg, #1D2B1F 0%, #3A6B4A 55%, #D4922A 100%)',
}

function gradientForHub(slug) {
  if (GRADIENTS[slug]) return GRADIENTS[slug]
  // If the slug is a known category hub, use its mapped gradient;
  // otherwise default to the neighborhood gradient.
  const isCat = !!getCategoryHub(slug)
  return isCat ? GRADIENTS._other : GRADIENTS._neighborhood
}

function brandMark() {
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      fontSize: '34px',
      fontWeight: 500,
      letterSpacing: '-0.01em',
    },
  },
    h('div', {
      style: {
        width: '14px',
        height: '14px',
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

function fallbackImage(message) {
  return new ImageResponse(
    h('div', {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: GRADIENTS._other,
        color: '#FCFAF4',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      },
    },
      brandMark(),
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
    const slug = searchParams.get('slug')
    if (!slug) return fallbackImage('Missing hub slug')

    const hub = getHub(slug)
    if (!hub) return fallbackImage('Unknown hub')

    const gradient = gradientForHub(slug)
    const title    = hub.h1 || hub.title || hub.label
    const subtitle = (hub.metaDescription || '').slice(0, 140)

    // Same title sizing logic the event OG uses.
    const titleSize =
      title.length > 60 ? '64px' :
      title.length > 40 ? '78px' :
                          '96px'

    return new ImageResponse(
      h('div', {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: '64px 72px',
          background: gradient,
          color: '#FCFAF4',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        },
      },
        brandMark(),
        h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            marginTop: 'auto',
          },
        },
          // Eyebrow — "Category" or "Neighborhood" hint that frames
          // the title for someone seeing the share for the first time.
          h('div', {
            style: {
              display: 'flex',
              fontSize: '22px',
              opacity: 0.7,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontWeight: 600,
            },
          }, getCategoryHub(slug) ? 'Akron Events Guide' : 'Akron Neighborhood Guide'),
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
              fontSize: '28px',
              fontWeight: 400,
              opacity: 0.82,
              maxWidth: '1056px',
              lineHeight: 1.35,
            },
          }, subtitle),
        ),
        h('div', {
          style: {
            display: 'flex',
            marginTop: '32px',
            fontSize: '20px',
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
          'Cache-Control':
            'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    )
  } catch {
    return fallbackImage()
  }
}
