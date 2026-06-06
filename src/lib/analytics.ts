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

/**
 * Call once at app startup (main.tsx or App.tsx).
 * Safe to call even if the measurement ID is absent.
 */
export function initAnalytics(): void {
  if (!enabled || !MEASUREMENT_ID) return
  ReactGA.initialize(MEASUREMENT_ID)
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
