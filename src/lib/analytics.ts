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
import { redactPath } from './planPathRedaction'

// Re-exported so existing/future call sites that only need the pure
// redaction function (e.g. its own unit test) don't have to know it now
// lives in a separate zero-dependency module.
export { redactPath }

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

// True when this document is an in-house embed PREVIEW (the embed builder's
// live-preview iframe, which loads /embed on our own origin). Such a document
// is not real partner traffic and is silenced entirely — see initAnalytics.
let suppressed = false

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
  // A real partner embed loads `/embed` in an iframe on the PARTNER's origin.
  // But the embed builder ALSO loads `/embed` in an iframe for its live
  // preview — on OUR OWN origin. That preview is not partner traffic:
  // ancestorOrigins/referrer resolve to our own hostname, so it would report
  // embed_host as our own domain and inflate embed metrics with in-house
  // previews. That self-referential noise is precisely the "embed source looks
  // wrong" symptom. Detect it (embed host == our hostname) and suppress
  // analytics entirely for that document — no init, no hits.
  let gtagOptions: Record<string, string | boolean>
  if (surface === 'embed') {
    const host = detectEmbedHost()
    if (host === window.location.hostname) {
      suppressed = true
      return
    }
    // Neither theme nor neighborhood is meaningful inside a partner embed. The
    // theme there is the PARTNER's white-label choice, not a user preference,
    // so including it would let one busy partner site running the Postcard
    // theme masquerade as a popular user choice. localStorage in a third-party
    // iframe is partitioned or blocked, so the hub read would be empty noise
    // besides. Send only surface + embed_host.
    gtagOptions = { surface, embed_host: host }
  } else {
    gtagOptions = {
      surface,
      theme: readInitialTheme(),
      neighborhood: getMyHubSlug() ?? NO_NEIGHBORHOOD,
    }
  }
  // send_page_view: false is NON-NEGOTIABLE — see this file's header and
  // planPathRedaction.ts. react-ga4 spreads gtagOptions straight into the
  // `gtag('config', MEASUREMENT_ID, {...})` call it issues here (see
  // node_modules/react-ga4/src/ga4.ts `initialize`). Without this flag, GA4's
  // default behavior on a bare `config` command is to auto-fire its OWN
  // page_view using `window.location.href` as `page_location` — a call that
  // does not go through trackPageView, so it bypasses redactPath entirely.
  // On a cold open of a shared `/d/<code>` link (the primary real-world path
  // for the day planner), `window.location.href` IS `/d/<code>` at the
  // instant this runs (main.tsx calls initAnalytics() before React ever
  // renders, so no in-app navigation has happened yet), which ships the
  // plan's bearer credential to Google. The app already fires its own
  // manual pageview via trackPageView on every route change, including the
  // first one (App.tsx's effect on [location] runs on mount too), so
  // disabling the automatic one loses no coverage — it only removes a
  // duplicate (and unredacted) hit.
  gtagOptions.send_page_view = false
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
  if (p === '/financials') return 'Financials'
  if (p === '/day' || p.startsWith('/d/')) return 'Day Plan'
  return 'Other'
}

/**
 * Track a page view. Call this on every route change.
 * @param path - e.g. "/events/jazz-night/123"
 * @param title - optional document title
 */
export function trackPageView(path: string, title?: string): void {
  if (!enabled) return
  // Redact a day-plan bearer code BEFORE it can reach GA4 — see redactPath's
  // own docstring. This must stay the very first thing this function does;
  // every other line below reads `safePath`, never the raw `path` argument.
  if (suppressed) return
  const safePath = redactPath(path)
  // Set content_group first so it attaches to the page_view (and to custom
  // events fired on this page until the next route change re-sets it).
  ReactGA.set({ content_group: contentGroup(safePath) })
  // `page` here only sets GA4's `page_path`. gtag.js separately
  // AUTO-POPULATES `page_location` from `window.location.href` on every hit
  // that doesn't explicitly override it (documented GA4 default enrichment,
  // independent of send_page_view / initAnalytics above) — so passing only
  // `page: safePath` is NOT enough. On `/d/<code>`, `window.location.href`
  // already reflects the new URL by the time this runs (the browser updates
  // it via pushState before React Router's effects fire), so an unredacted
  // code would still ship as `page_location` even with `page_path` redacted.
  // `location` is react-ga4's field name for the override (see
  // node_modules/react-ga4/src/ga4.ts `_gaCommandSendPageview`, which maps
  // an explicit `location` straight to `page_location`) — build it from the
  // REDACTED path so both page dimensions agree and neither carries the code.
  const safeLocation = typeof window !== 'undefined'
    ? `${window.location.origin}${safePath}`
    : safePath
  ReactGA.send({ hitType: 'pageview', page: safePath, title, location: safeLocation })
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
  if (!enabled || suppressed) return
  const params = (args[0] ?? {}) as Record<string, unknown>
  ReactGA.event(name, params)
}
