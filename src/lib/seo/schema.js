/**
 * schema.js
 *
 * Builders for schema.org JSON-LD. Each builder returns a plain object
 * that can be JSON.stringified into a <script type="application/ld+json">
 * tag. Pages compose these into an @graph array via `buildGraph`.
 *
 * Google's requirement is that visible content must match the schema —
 * every value here should come from the same source of truth the page
 * renders (do not invent data).
 *
 * Reference: https://developers.google.com/search/docs/appearance/structured-data/event
 */

import { SITE, canonicalUrl } from './constants'
import { eventPath } from '../slug'

// ──────────────────────────────────────────────────────────────────────
// Website-wide (emitted on every page from App.jsx)
// ──────────────────────────────────────────────────────────────────────

/**
 * Organization — the brand behind the site. Stable, rarely changes.
 * Once we have a real logo asset, set logo + sameAs (social profiles).
 */
export function organizationSchema() {
  return {
    '@type': 'Organization',
    '@id': `${SITE.baseUrl}/#organization`,
    name: SITE.name,
    url: SITE.baseUrl,
    description: SITE.description,
    // logo: `${SITE.baseUrl}/logo.png`,    // TODO once we have a logo asset
    // sameAs: [ ... social profile URLs ... ],
  }
}

/**
 * WebSite — enables the Sitelinks Search Box in Google results when a
 * user searches for "Akron Pulse" (or any brand-intent query).
 */
export function webSiteSchema() {
  return {
    '@type': 'WebSite',
    '@id': `${SITE.baseUrl}/#website`,
    url: SITE.baseUrl,
    name: SITE.name,
    description: SITE.description,
    publisher: { '@id': `${SITE.baseUrl}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${SITE.baseUrl}/?search={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  }
}

// ──────────────────────────────────────────────────────────────────────
// Event + Place + Organization (per event / venue / organizer page)
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a schema.org PostalAddress from a venue row.
 */
function postalAddress(venue) {
  if (!venue) return undefined
  return {
    '@type': 'PostalAddress',
    streetAddress: venue.address || undefined,
    addressLocality: venue.city || SITE.city,
    addressRegion: venue.state || SITE.region,
    postalCode: venue.zip || undefined,
    addressCountry: SITE.country,
  }
}

/**
 * Build a schema.org Place (venue) object. Used nested inside Event and
 * standalone on venue detail pages.
 */
export function placeSchema(venue) {
  if (!venue) return undefined
  const place = {
    '@type': 'Place',
    '@id': `${SITE.baseUrl}/venues/${venue.id}#place`,
    name: venue.name,
    address: postalAddress(venue),
  }
  if (venue.website)     place.url = venue.website
  if (venue.lat && venue.lng) {
    place.geo = {
      '@type': 'GeoCoordinates',
      latitude: venue.lat,
      longitude: venue.lng,
    }
  }
  return place
}

/**
 * Build a schema.org Organization from an organizer/organization row.
 * Used as `organizer` on events and as the main entity on org pages.
 */
export function organizerSchema(org) {
  if (!org) return undefined
  const o = {
    '@type': 'Organization',
    '@id': `${SITE.baseUrl}/organizations/${org.id}#organization`,
    name: org.name,
  }
  if (org.website)     o.url = org.website
  if (org.description) o.description = org.description
  if (org.image_url)   o.image = org.image_url
  return o
}

/**
 * Map our internal `status` + attendance fields to schema.org enum URIs.
 * Our DB doesn't currently store these (migration 019 adds them) — until
 * then we default to scheduled + offline.
 */
function eventStatusEnum(status) {
  switch (status) {
    case 'cancelled':   return 'https://schema.org/EventCancelled'
    case 'postponed':   return 'https://schema.org/EventPostponed'
    case 'rescheduled': return 'https://schema.org/EventRescheduled'
    case 'moved_online':return 'https://schema.org/EventMovedOnline'
    default:            return 'https://schema.org/EventScheduled'
  }
}
function attendanceModeEnum(mode) {
  switch (mode) {
    case 'online': return 'https://schema.org/OnlineEventAttendanceMode'
    case 'hybrid': return 'https://schema.org/MixedEventAttendanceMode'
    default:       return 'https://schema.org/OfflineEventAttendanceMode'
  }
}

/**
 * Build an Offer object from price_min / price_max / ticket_url.
 * Google wants `priceCurrency` whenever offers are present.
 */
function offerSchema(event) {
  const url = event.ticket_url || `${SITE.baseUrl}${eventPath(event)}`
  // Free event
  if ((event.price_min === 0 || event.is_accessible_for_free) &&
      (event.price_max == null || event.price_max === 0)) {
    return {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url,
    }
  }
  // Priced event
  if (event.price_min != null) {
    const offer = {
      '@type': 'Offer',
      price: String(event.price_min),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url,
    }
    // Range via AggregateOffer is the technically-correct path, but a
    // flat Offer with the min price is what most event sites do and is
    // what Google's examples show. Keep it simple.
    return offer
  }
  // Unknown price — skip offers rather than emit an invalid one.
  return undefined
}

/**
 * Build an Event object from an Akron Pulse event row. Matches the exact
 * shape Google requires + recommends. If a value is missing, omit the
 * field rather than emitting null — validators flag nulls.
 *
 * https://developers.google.com/search/docs/appearance/structured-data/event
 */
export function eventSchema(event) {
  if (!event) return undefined

  const schema = {
    '@type': 'Event',
    // Note the #event hash-fragment: schema.org @id must be stable
    // across slug changes. We anchor it to the UUID via the bare
    // /events/{id} path so a title rename doesn't invalidate the
    // canonical entity reference Google has cached.
    '@id': `${SITE.baseUrl}/events/${event.id}#event`,
    name: event.title,
    startDate: event.start_at,
    eventStatus: eventStatusEnum(event.event_status),
    eventAttendanceMode: attendanceModeEnum(event.event_attendance_mode),
    url: `${SITE.baseUrl}${eventPath(event)}`,
  }

  if (event.end_at) schema.endDate = event.end_at
  if (event.description) schema.description = event.description
  if (event.image_url)   schema.image = [event.image_url]

  const venue = event.venue || (event.venues && event.venues[0])
  if (venue) schema.location = placeSchema(venue)

  const org = event.organizer || (event.organizations && event.organizations[0])
  if (org) schema.organizer = organizerSchema(org)

  const offer = offerSchema(event)
  if (offer) schema.offers = offer

  return schema
}

// ──────────────────────────────────────────────────────────────────────
// Navigation + listing structures
// ──────────────────────────────────────────────────────────────────────

/**
 * BreadcrumbList. Caller passes an ordered array of { name, url }. The
 * current page (last crumb) should link to itself.
 *   breadcrumbSchema([{ name: 'Events', url: '/events' },
 *                     { name: 'Sakura Festival', url: '/events/…' }])
 */
export function breadcrumbSchema(crumbs) {
  if (!crumbs || crumbs.length === 0) return undefined
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: canonicalUrl(c.url),
    })),
  }
}

/**
 * ItemList — for /venues, /organizations, and category listing pages.
 * Helps search engines see a page as a curated list rather than prose.
 */
export function itemListSchema(items) {
  if (!items || items.length === 0) return undefined
  return {
    '@type': 'ItemList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      url: canonicalUrl(item.url),
    })),
  }
}

/**
 * FAQPage — used on About (and any other page with a genuine Q&A
 * section). FAQ markup correlates with ~40% higher LLM citation rate.
 */
export function faqPageSchema(faqs) {
  if (!faqs || faqs.length === 0) return undefined
  return {
    '@type': 'FAQPage',
    mainEntity: faqs.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: q.answer,
      },
    })),
  }
}

// ──────────────────────────────────────────────────────────────────────
// Composition
// ──────────────────────────────────────────────────────────────────────

/**
 * Compose multiple schema fragments into a single @graph document. Drops
 * undefined entries so callers don't have to filter. Returns a ready-to-
 * JSON.stringify object or `null` if nothing valid was passed.
 */
export function buildGraph(...fragments) {
  const graph = fragments.filter(Boolean)
  if (graph.length === 0) return null
  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  }
}
