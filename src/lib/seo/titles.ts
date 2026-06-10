/**
 * Systematic page-title and meta-description framework.
 *
 * Centralized so every page type generates the exact title/description
 * format Google rewards for our keyword targets. Used by the <SEO />
 * component on each page so a future audit can grep one file to verify
 * conformance instead of crawling every page.
 *
 * The SEO action plan (May 2026) recommends:
 *
 *   - Homepage:        "Akron Events: [tagline] | Akron Pulse"
 *   - Events index:    "Events in Akron, OH [Year] | Akron Pulse"
 *   - Individual event "[Title] on [Date] in Akron, OH | Akron Pulse"
 *   - Category page:   "[Category] in Akron, OH | Akron Pulse"
 *   - Neighborhood:    "[Neighborhood] Events | Akron Pulse"
 *
 * Page templates here always RETURN the page-side title (no brand
 * suffix); the <SEO /> component appends " | Akron Pulse" unless
 * `titleExact` is set.
 */

import { format } from 'date-fns'

/** Event fields the title/description helpers read. */
export interface TitleEventInput {
  title?: string | null
  start_at?: string | null
  description?: string | null
  venue?: { name?: string | null } | null
}

/** A category/neighborhood hub registry entry (subset used here). */
export interface HubInput {
  title: string
  metaDescription: string
}

/** Stable display year — used in the homepage title. */
function currentYear(): number {
  return new Date().getFullYear()
}

/**
 * Homepage title. The plan's recommended format positions Akron Pulse
 * as the canonical events index with the strongest head keywords
 * up-front.
 */
export function homeTitle(): string {
  return `Events in Akron, OH ${currentYear()}: Concerts, Art Shows & More`
}

export function homeDescription(): string {
  return (
    `Find every event happening in Akron, OH and Summit County: ` +
    `concerts, art shows, festivals, free events, family activities, ` +
    `and more. Updated daily by Akron Pulse.`
  )
}

/**
 * Individual event detail page title.
 *
 *   "Akron Art Walk on Jun 14, 2026 in Akron, OH"
 *   "Akron Art Walk on Jun 14, 2026 at Summit Artspace in Akron, OH"
 */
export function eventTitle(event: TitleEventInput | null | undefined): string {
  if (!event?.title) return 'Event in Akron, OH'
  const dateLabel = event.start_at
    ? format(new Date(event.start_at), 'MMM d, yyyy')
    : null
  const venue = event.venue?.name
  const base = dateLabel
    ? `${event.title} on ${dateLabel}`
    : event.title
  if (venue) return `${base} at ${venue} in Akron, OH`
  return `${base} in Akron, OH`
}

/**
 * Event meta description. Trims to ~155 chars and falls back to a
 * date+venue sentence when the event has no description.
 */
export function eventDescription(event: TitleEventInput | null | undefined): string {
  const dateLabel = event?.start_at
    ? format(new Date(event.start_at), 'EEE MMM d, yyyy')
    : null
  const venueName = event?.venue?.name
  const fallback = `${event?.title || 'Event'}${dateLabel ? ' on ' + dateLabel : ''}${venueName ? ' at ' + venueName : ''} in Akron, OH.`
  const raw = (event?.description || fallback).replace(/\s+/g, ' ').trim()
  if (raw.length <= 155) return raw
  // Truncate at the last word boundary before 155 so we don't cut a
  // word in half mid-meta. Then add an ellipsis if we trimmed.
  const cut = raw.slice(0, 155)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 130 ? cut.slice(0, lastSpace) : cut).trim() + '…'
}

/**
 * Category hub page title. Uses the registry's own `title`, which is
 * authored per-hub for keyword targeting (e.g. "Free Events in Akron,
 * OH"). The <SEO /> component appends the brand suffix.
 */
export function hubTitle(hub: HubInput): string {
  return hub.title
}

export function hubDescription(hub: HubInput): string {
  return hub.metaDescription
}

/** Submit / about / venue / org pages — pass-through helpers so each
 *  page type calls a function instead of writing the format inline. */
export function staticPageTitle(label: string): string {
  return `${label} in Akron, OH`
}
