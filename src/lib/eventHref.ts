/**
 * eventHref.ts — pure "where does clicking an event go" logic.
 *
 * RELATIVE imports only, on purpose: this module is unit-tested under
 * `node --test` (scripts/tests/test-event-href.js), which imports the .ts
 * file directly via type stripping — the `@/` alias does not resolve there.
 * The EmbedConfig import is type-only so embedConfig's `@/` imports never
 * load at runtime.
 */
import { eventPath } from './slug.js'
import type { EmbedConfig } from './embedConfig.ts'

/** The event shape `eventPath` accepts (id + title + start_at), plus the
 *  outbound URLs the embed's `external` target may jump to directly. */
export type HrefEvent = Parameters<typeof eventPath>[0] & {
  ticket_url?: string | null
  source_url?: string | null
}

export interface EventHref {
  kind: 'internal' | 'external'
  href: string
}

/**
 * Build the in-iframe detail path for an event, carrying the embed config
 * query string forward so theme/features/target survive the navigation.
 * Mirrors lib/slug eventPath but under the /embed prefix.
 */
export function embedEventPath(
  eventPathStr: string,
  configSearch: string | null | undefined
): string {
  // eventPathStr is the canonical "/events/{slug}/{id}". Re-root under /embed.
  const rerooted = `/embed${eventPathStr}`
  const qs = configSearch ? (configSearch.startsWith('?') ? configSearch : `?${configSearch}`) : ''
  return `${rerooted}${qs}`
}

/**
 * buildEventHref — single source of truth for "what an event click means".
 * Shared (via useEventHref / useEventNavigator) by EventCard, EventLink and
 * MapView so the click behavior is identical everywhere.
 *
 *   - Normal site:          internal link to /events/{slug}/{id}.
 *   - Embed, target=inline: internal link within the iframe to
 *                           /embed/events/{slug}/{id}, carrying the embed
 *                           config query string forward.
 *   - Embed, target=blank:  external link to the full hosted (chrome + SEO)
 *                           detail page in a new tab, leaving the partner
 *                           page intact.
 *   - Embed, target=external: skip the detail page entirely — link to the
 *                           event's ticket_url or source_url directly in a
 *                           new tab. Falls back to blank if neither exists.
 *                           Useful for sidebar widgets where a detail page
 *                           visit inside the iframe would be disruptive.
 */
export function buildEventHref(
  event: HrefEvent,
  embed: EmbedConfig | null,
  opts: { search: string; origin: string }
): EventHref {
  const path = eventPath(event)
  if (!embed) {
    return { kind: 'internal', href: path }
  }
  if (embed.target === 'external') {
    // Go straight to the event's own site; skip the Akron Pulse detail page.
    return {
      kind: 'external',
      href: event.ticket_url || event.source_url || `${opts.origin}${path}`,
    }
  }
  if (embed.target === 'blank') {
    // Full hosted detail page (real URL, indexable, full chrome).
    return { kind: 'external', href: `${opts.origin}${path}` }
  }
  // Inline: stay in the iframe, keep the embed config in the URL.
  return { kind: 'internal', href: embedEventPath(path, opts.search) }
}
