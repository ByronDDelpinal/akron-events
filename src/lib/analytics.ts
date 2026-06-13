/**
 * analytics.ts
 *
 * Thin wrapper around react-ga4. All exports are safe no-ops when
 * VITE_GA_MEASUREMENT_ID is not set, so forks without a GA account
 * work without any changes.
 */
import ReactGA from 'react-ga4'
import { EVENTS, type EventName, type EventParams } from './analyticsEvents'

// Re-exported so call sites import the event registry and the tracker together.
export { EVENTS }
export type { EventName, EventParams }

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID
const enabled = Boolean(MEASUREMENT_ID)

export type Surface = 'site' | 'embed'

/**
 * Which surface this document is: the main site, or a partner embed. A given
 * document is exactly one surface for its whole life (the embed is always the
 * iframe's own /embed document), so we detect it once at init from the initial
 * path rather than per-navigation. Note: useEmbed()/EmbedContext is mounted
 * inside the /embed route subtree and isn't in scope here, so we read the path.
 */
function detectSurface(): Surface {
  if (typeof window === 'undefined') return 'site'
  // Match the embed document exactly: `/embed` or `/embed/...`. A bare
  // startsWith('/embed') also catches the site page `/embed-builder`, which
  // would mislabel a normal site page as a partner embed.
  const path = window.location.pathname
  return path === '/embed' || path.startsWith('/embed/') ? 'embed' : 'site'
}

/**
 * For an embed, the hostname of the page hosting the iframe. ancestorOrigins is
 * the reliable source (Chromium) and survives a stripped referrer; we fall back
 * to document.referrer (Firefox/Safari) and finally to a sentinel.
 */
function detectEmbedHost(): string {
  try {
    const ao = window.location.ancestorOrigins
    if (ao && ao.length > 0) return new URL(ao[0]).hostname
  } catch { /* ancestorOrigins unsupported — fall through to referrer */ }
  try {
    return document.referrer ? new URL(document.referrer).hostname : '(direct)'
  } catch { return '(unknown)' }
}

/**
 * Call once at app startup (main.tsx or App.tsx).
 * Safe to call even if the measurement ID is absent.
 *
 * Registers `surface` (and, for embeds, `embed_host`) as default gtag params on
 * the config command so EVERY hit — pageviews and custom events — carries them.
 * This keeps call sites untouched and lets GA4 segment all traffic by surface.
 * Register both as event-scoped custom dimensions in GA4 Admin to use in reports.
 */
export function initAnalytics(): void {
  if (!enabled || !MEASUREMENT_ID) return
  const surface = detectSurface()
  const gtagOptions: Record<string, string> =
    surface === 'embed' ? { surface, embed_host: detectEmbedHost() } : { surface }
  ReactGA.initialize(MEASUREMENT_ID, { gtagOptions })
}

/**
 * Track a page view. Call this on every route change.
 * @param path - e.g. "/events/123"
 * @param title - optional document title
 */
export function trackPageView(path: string, title?: string): void {
  if (!enabled) return
  ReactGA.send({ hitType: 'pageview', page: path, title })
}

/**
 * Track a custom event using GA4-native parameters.
 *
 * The signature is generic over the EVENTS registry: `name` must be a known
 * event, and the params must match that event's contract in EventParams.
 * Events whose contract is an empty object take no second argument.
 *
 *   trackEvent(EVENTS.NEIGHBORHOOD_CLEARED)
 *   trackEvent(EVENTS.PWA_INSTALL_CLICKED, { placement: 'pill' })
 *
 * Parameters are sent as GA4 event parameters (not coerced into the legacy
 * UA category/label/value fields). Register each parameter as an event-scoped
 * custom dimension in GA4 Admin for it to appear in reports.
 */
export function trackEvent<E extends EventName>(
  name: E,
  ...args: EventParams[E] extends Record<string, never> ? [] : [params: EventParams[E]]
): void {
  if (!enabled) return
  const params = (args[0] ?? {}) as Record<string, unknown>
  ReactGA.event(name, params)
}
