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

/**
 * How a user installs. 'native' is the Chromium beforeinstallprompt dialog;
 * 'ios' is the manual Share -> Add to Home Screen flow we coach with the
 * instruction sheet. Segmenting by this is the only way to read the two
 * very different funnels apart.
 */
export type InstallMethod = 'native' | 'ios'

/**
 * Platform bucket for a standalone (installed-app) launch. iOS is called
 * out because its install itself fires no event, so launches are the only
 * way to measure iOS install success.
 */
export type StandalonePlatform = 'ios' | 'other'

/**
 * Which outbound link a user took off the event page. The primary CTA is one
 * button with two meanings — a real ticket/registration link when the event has
 * one, otherwise a fallback to the source's own detail page. Rolling those
 * together would make the click-through number unreadable: a 'source' click is
 * a user still looking, a 'tickets' click is a user converting.
 */
export type OutboundLinkType = 'tickets' | 'source'

/** How a user added an event to their calendar. */
export type CalendarMethod = 'google' | 'ics'

/**
 * Trust tier of the destination we sent a user to, mirroring sourceTiers.js.
 * This is the dimension that answers "is our traffic reaching the organizers
 * who actually host these events, or just republishers?".
 */
export type SourceTier = 'venue_official' | 'platform' | 'aggregator' | 'manual'

/** One step of the category filter's tri-state cycle: off -> include -> exclude -> off. */
export type CategoryFilterAction = 'include' | 'exclude' | 'clear'

/**
 * Which search box fired. `search_term` is a GA4 *recommended* param, so every
 * surface's searches roll into one report unless we discriminate — without this
 * the About page's data-source lookup would pollute event-search demand data.
 */
export type SearchContentType = 'events' | 'data_sources'

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
  PWA_INSTALL_CLICKED:           'pwa_install_clicked',
  PWA_INSTALL_ACCEPTED:          'pwa_install_accepted',
  PWA_INSTALL_DISMISSED:         'pwa_install_dismissed',
  PWA_INSTALL_INSTRUCTIONS_SHOWN: 'pwa_install_instructions_shown',
  PWA_STANDALONE_LAUNCH:         'pwa_standalone_launch',
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
  VIEW_EVENT:               'view_event',
  OUTBOUND_CLICK:           'outbound_click',
  ADD_TO_CALENDAR:          'add_to_calendar',
  CATEGORY_FILTER:          'category_filter',
  THEME_CHANGED:            'theme_changed',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

/**
 * The parameter contract for each event. Keyed by the literal event name so
 * call sites get exact typing. Events that take no parameters map to an empty
 * object type, which trackEvent's signature turns into "pass no second arg".
 */
export interface EventParams {
  pwa_install_clicked:      { placement: InstallPlacement; method: InstallMethod }
  pwa_install_accepted:     { placement: InstallPlacement; method: InstallMethod }
  pwa_install_dismissed:    { placement: InstallPlacement; method: InstallMethod }
  pwa_install_instructions_shown: { placement: InstallPlacement }
  pwa_standalone_launch:    { platform: StandalonePlatform }
  onboarding_closed:        { outcome: 'saved' | 'skipped' }
  neighborhood_set:         { neighborhood: string }
  neighborhood_cleared:     Record<string, never>
  newsletter_signup:        { frequency: string; placement: string; lookahead_days?: number; intents?: string }
  newsletter_confirmed:     { frequency: string; lookahead_days?: number }
  embed_builder_customized: Record<string, never>
  embed_snippet_copied:     EmbedSnippetParams
  select_content:           { content_type: string; item_id: string }
  share:                    { method: string; content_type: string; item_id: string }
  search:                   { search_term: string; content_type: SearchContentType; result_count: number }
  view_event:               { category: string; source_tier: SourceTier }
  outbound_click:           { link_type: OutboundLinkType; source_tier: SourceTier; category: string }
  add_to_calendar:          { method: CalendarMethod; category: string }
  category_filter:          { category: string; action: CategoryFilterAction }
  theme_changed:            { theme: string; previous_theme: string }
}
