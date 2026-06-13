/**
 * analyticsEvents.ts
 *
 * The single source of truth for every GA4 custom event the site fires.
 *
 * Convention (see docs/analytics-standardization-2026-06.md):
 *   - object_action, snake_case, starts with a letter, <= 40 chars.
 *   - Never reuse a reserved/automatic GA4 name or a reserved prefix
 *     (ga_, firebase_, google_).
 *   - Reuse a GA4 *recommended* name when the semantics match (share,
 *     select_content, search) to unlock Google's prebuilt reporting.
 *   - Describe with parameters, not name explosions. No category/label.
 *
 * Call sites import EVENTS and pass the typed params; trackEvent is generic
 * over this registry, so an unknown event name or a wrong/missing parameter
 * is a compile error, not a silent data-quality bug.
 */
import type { EmbedView, EmbedDensity, EmbedTarget } from './embedConfig'

/** Where a PWA-install affordance lives. */
export type InstallPlacement = 'pill' | 'footer'

/** Final embed configuration captured at the moment a partner copies the snippet. */
export interface EmbedSnippetParams {
  theme: string
  target: EmbedTarget
  view: EmbedView
  density: EmbedDensity
  locked_category_count: number
  price_locked: boolean
  date_locked: boolean
  family_only: boolean
}

/**
 * Event-name constants. The string VALUES are what GA4 receives; the keys are
 * just ergonomic call-site references. Keep values in sync with EventParams.
 */
export const EVENTS = {
  PWA_INSTALL_CLICKED:      'pwa_install_clicked',
  PWA_INSTALL_ACCEPTED:     'pwa_install_accepted',
  PWA_INSTALL_DISMISSED:    'pwa_install_dismissed',
  ONBOARDING_CLOSED:        'onboarding_closed',
  NEIGHBORHOOD_SET:         'neighborhood_set',
  NEIGHBORHOOD_CLEARED:     'neighborhood_cleared',
  NEWSLETTER_SIGNUP:        'newsletter_signup',
  NEWSLETTER_CONFIRMED:     'newsletter_confirmed',
  EMBED_BUILDER_CUSTOMIZED: 'embed_builder_customized',
  EMBED_SNIPPET_COPIED:     'embed_snippet_copied',
  SELECT_CONTENT:           'select_content',
  SHARE:                    'share',
  SEARCH:                   'search',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

/**
 * The parameter contract for each event. Keyed by the literal event name so
 * call sites get exact typing. Events that take no parameters map to an empty
 * object type, which trackEvent's signature turns into "pass no second arg".
 */
export interface EventParams {
  pwa_install_clicked:      { placement: InstallPlacement }
  pwa_install_accepted:     { placement: InstallPlacement }
  pwa_install_dismissed:    Record<string, never>
  onboarding_closed:        { outcome: 'saved' | 'skipped' }
  neighborhood_set:         { neighborhood: string }
  neighborhood_cleared:     Record<string, never>
  newsletter_signup:        { frequency: string; placement: string; lookahead_days?: number; intents?: string }
  newsletter_confirmed:     { frequency: string; lookahead_days?: number }
  embed_builder_customized: Record<string, never>
  embed_snippet_copied:     EmbedSnippetParams
  select_content:           { content_type: string; item_id: string }
  share:                    { method: string; content_type: string; item_id: string }
  search:                   { search_term: string }
}
