/**
 * analytics.ts
 *
 * Thin wrapper around react-ga4. All exports are safe no-ops when
 * VITE_GA_MEASUREMENT_ID is not set, so forks without a GA account
 * work without any changes.
 */
import ReactGA from 'react-ga4'

/** The UA-style options object accepted by ReactGA.event's object overload. */
type UaEventOptions = Parameters<typeof ReactGA.event>[0]

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
  return window.location.pathname.startsWith('/embed') ? 'embed' : 'site'
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
 * Track a custom event.
 * @param action - e.g. "click_event_card"
 * @param params - e.g. { category: "Events", label: "Jazz Night" }
 */
export function trackEvent(
  action: string,
  params: Record<string, unknown> = {}
): void {
  if (!enabled) return
  // Preserve the original UA-style object form. Callers supply `category`
  // (and usually `label`); the cast documents that contract without forcing
  // every call site to satisfy the full UaEventOptions shape here.
  ReactGA.event({ action, ...params } as unknown as UaEventOptions)
}
