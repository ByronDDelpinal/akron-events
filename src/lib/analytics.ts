/**
 * analytics.ts
 *
 * Thin wrapper around react-ga4. All exports are safe no-ops when
 * VITE_GA_MEASUREMENT_ID is not set, so forks without a GA account
 * work without any changes.
 */
import ReactGA from 'react-ga4'
import { EVENTS, type EventName, type EventParams } from './analyticsEvents'
import { THEME_STORAGE_KEY, DEFAULT_THEME, isValidTheme } from './themes'
import { getMyHubSlug } from './myHub'

// Re-exported so call sites import the event registry and the tracker together.
export { EVENTS }
export type { EventName, EventParams }

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID
const enabled = Boolean(MEASUREMENT_ID)

export type Surface = 'site' | 'embed'

/**
 * Explicit value for "this user has not saved a neighborhood". Distinct from
 * GA4's own "(not set)", which is what you'd see if the dimension were simply
 * never registered — an ambiguity that would make "no hub" and "broken
 * instrumentation" look identical in a report.
 */
const NO_NEIGHBORHOOD = '(none)'

// Set once at init and read by the context setters below, which must know the
// surface to decide whether user-preference dimensions apply at all.
let currentSurface: Surface = 'site'

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
 * The user's saved theme, read straight from storage at init.
 *
 * Deliberately does NOT run useTheme's legacy-key migrations: this is a
 * read-only analytics concern and must never mutate storage as a side effect of
 * booting the tracker. A pre-rebrand user whose theme still lives under the
 * legacy key therefore reports DEFAULT_THEME on their first hit only —
 * ThemeProvider migrates and calls setThemeContext on mount, correcting every
 * hit after it.
 */
function readInitialTheme(): string {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored && isValidTheme(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/**
 * Call once at app startup (main.tsx or App.tsx).
 * Safe to call even if the measurement ID is absent.
 *
 * Registers `surface` (and, for embeds, `embed_host`) as default gtag params on
 * the config command so EVERY hit — pageviews and custom events — carries them.
 * This keeps call sites untouched and lets GA4 segment all traffic by surface.
 * Register both as event-scoped custom dimensions in GA4 Admin to use in reports.
 *
 * On the site surface we seed `theme` and `neighborhood` the same way, for the
 * same reason: both are questions about BEHAVIOUR ("which neighborhoods are
 * people actually active in?"), and a one-shot neighborhood_set/theme_changed
 * event can only ever count DECISIONS. Riding every hit turns them into
 * dimensions you can break any other metric down by.
 *
 * Seeded here rather than left to the providers because React runs child
 * effects before parent ones — AppInner's trackPageView effect fires before
 * ThemeProvider's — so the first page_view of every session would otherwise
 * carry neither value.
 *
 * Both are event-scoped, NOT user-scoped, and that is load-bearing. GA4
 * user-scoped dimensions are last-value-wins: a user who switched from
 * Highland Square to Downtown would have their entire history retroactively
 * re-attributed to Downtown, which is precisely the question being asked.
 */
export function initAnalytics(): void {
  if (!enabled || !MEASUREMENT_ID) return
  const surface = detectSurface()
  currentSurface = surface
  // Neither dimension is meaningful inside an embed. The theme there is the
  // PARTNER's white-label choice, not a user preference, so including it would
  // let one busy partner site running the Postcard theme masquerade as a
  // popular user choice. localStorage in a third-party iframe is partitioned
  // or blocked, so the hub read would be empty noise besides.
  const gtagOptions: Record<string, string> =
    surface === 'embed'
      ? { surface, embed_host: detectEmbedHost() }
      : {
          surface,
          theme: readInitialTheme(),
          neighborhood: getMyHubSlug() ?? NO_NEIGHBORHOOD,
        }
  ReactGA.initialize(MEASUREMENT_ID, { gtagOptions })
}

/**
 * Update the persistent `theme` dimension after an in-app theme switch.
 * No-op on the embed surface — see initAnalytics.
 */
export function setThemeContext(theme: string): void {
  if (!enabled || currentSurface !== 'site') return
  ReactGA.set({ theme })
}

/**
 * Update the persistent `neighborhood` dimension when the saved hub changes.
 * Pass null when the user clears their hub. No-op on the embed surface.
 */
export function setNeighborhoodContext(slug: string | null): void {
  if (!enabled || currentSurface !== 'site') return
  ReactGA.set({ neighborhood: slug ?? NO_NEIGHBORHOOD })
}

/**
 * Map a path to a clean, human-readable Content Group. The page-title and
 * page-path dimensions are either ambiguous (templated SEO titles collide) or
 * high-cardinality (every event/venue is its own path). Content Group rolls
 * pages into a stable, readable set you can actually read in a report:
 * "Home", "Event Detail", "Embed Builder", etc. It populates GA4's built-in
 * "Content group" dimension — no custom-dimension registration needed.
 *
 * Order matters: more specific prefixes (/embed-builder) come before broader
 * ones (/embed).
 */
function contentGroup(path: string): string {
  const p = path.split('?')[0]
  if (p === '/') return 'Home'
  if (p.startsWith('/events/')) {
    // /events/:slug/:id is a detail page; /events/:slug is a hub.
    return p.split('/').filter(Boolean).length >= 3 ? 'Event Detail' : 'Events Hub'
  }
  if (p.startsWith('/embed-builder')) return 'Embed Builder'
  if (p === '/embed' || p.startsWith('/embed/')) return 'Embed'
  if (p.startsWith('/admin')) return 'Admin'
  if (p.startsWith('/venues')) return 'Venues'
  if (p.startsWith('/organizations')) return 'Organizations'
  if (p.startsWith('/subscribe')) return 'Subscribe'
  if (p === '/unsubscribe') return 'Unsubscribe'
  if (p === '/submit') return 'Submit'
  if (p === '/about') return 'About'
  if (p === '/organizers') return 'Organizers'
  if (p === '/technical') return 'Technical'
  if (p === '/feedback') return 'Feedback'
  return 'Other'
}

/**
 * Track a page view. Call this on every route change.
 * @param path - e.g. "/events/jazz-night/123"
 * @param title - optional document title
 */
export function trackPageView(path: string, title?: string): void {
  if (!enabled) return
  // Set content_group first so it attaches to the page_view (and to custom
  // events fired on this page until the next route change re-sets it).
  ReactGA.set({ content_group: contentGroup(path) })
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
