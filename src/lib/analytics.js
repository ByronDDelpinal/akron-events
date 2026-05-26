/**
 * analytics.js
 *
 * Thin wrapper around react-ga4. All exports are safe no-ops when
 * VITE_GA_MEASUREMENT_ID is not set, so forks without a GA account
 * work without any changes.
 */
import ReactGA from 'react-ga4';

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const enabled = Boolean(MEASUREMENT_ID);

/**
 * Call once at app startup (main.jsx or App.jsx).
 * Safe to call even if the measurement ID is absent.
 */
export function initAnalytics() {
  if (!enabled) return;
  ReactGA.initialize(MEASUREMENT_ID);
}

/**
 * Track a page view. Call this on every route change.
 * @param {string} path - e.g. "/events/123"
 * @param {string} [title] - optional document title
 */
export function trackPageView(path, title) {
  if (!enabled) return;
  ReactGA.send({ hitType: 'pageview', page: path, title });
}

/**
 * Track a custom event.
 * @param {string} action - e.g. "click_event_card"
 * @param {Object} [params]  - e.g. { category: "Events", label: "Jazz Night" }
 */
export function trackEvent(action, params = {}) {
  if (!enabled) return;
  ReactGA.event({ action, ...params });
}
