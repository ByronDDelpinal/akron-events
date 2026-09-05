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
 * Which surface a feedback interaction came from. The dialog is one shared
 * component mounted in several places; without this dimension the feedback
 * funnel numbers from all surfaces would be indistinguishable.
 */
export type FeedbackPlacement = 'header' | 'mobile_menu' | 'admin_toolbar' | 'empty_results' | 'event_page'

/**
 * Why an embed request attempt didn't reach the server. 'validation' covers
 * every client-side field error (required field, malformed email/website);
 * 'cooldown' is the 10-minute anti-spam window; 'insert' is a Supabase
 * error on the `embed_requests` insert itself.
 */
export type EmbedRequestFailure = 'insert' | 'validation' | 'cooldown'

/**
 * Which search box fired. `search_term` is a GA4 *recommended* param, so every
 * surface's searches roll into one report unless we discriminate — without this
 * the About page's data-source lookup would pollute event-search demand data.
 */
export type SearchContentType = 'events' | 'data_sources'

/**
 * Where a day-planner add/remove control fired from. The add button is one
 * shared component (AddToPlanButton) mounted on cards, the event detail
 * page, inside the planner itself, and on festival hub pages
 * (src/pages/FestivalPage.tsx) — without this dimension the funnels would
 * be indistinguishable, the same reason FeedbackPlacement exists for the
 * feedback dialog.
 */
export type PlanSurface = 'card' | 'event_page' | 'planner' | 'festival_hub'

/** How a plan was exported. */
export type PlanExportFormat = 'ics' | 'print'

/** Who opened a plan view. 'draft' is /day itself (no code involved yet);
 *  'owner'/'visitor' are /d/:code, split on whether THIS device holds the
 *  code in akronpulse_day_plan_code. */
export type PlanOpenedRole = 'owner' | 'visitor' | 'draft'

/** Whether the mobile map panel was opened or closed. */
export type PlanMapToggleState = 'expanded' | 'collapsed'

/**
 * The "When" section's resulting state (date preset), always present on
 * `when_filter` regardless of which control the user touched. 'custom' means
 * a from/to range is active; 'this_week' is the legacy ghost value (see
 * whenFilter.ts) -- still reportable if a partner embed's locked value
 * somehow fires this event, though in practice locked dates don't.
 */
export type WhenPreset = 'any' | 'today' | 'tomorrow' | 'this_weekend'
                        | 'next_7_days' | 'this_month' | 'this_week' | 'custom'
/** The "When" section's resulting time-of-day state. 'none' when off. */
export type TimeOfDay = 'none' | 'morning' | 'afternoon' | 'evening'
/** Which control inside the When section the user actually touched. */
export type WhenControl = 'preset' | 'range' | 'time_of_day'

/** Which control changed the map/list selection. */
export type PlanMapSelectionSource = 'list' | 'marker' | 'popup'

/** Which local mutation failed to reach the shared plan. */
export type PlanSyncOp = 'add' | 'remove'

/**
 * Which control moved the /financials adoption calculator: the slider itself
 * or one of the sourced preset chips. Preset engagement vs. free exploration
 * is the only read on whether the sourced anchors matter to readers.
 */
export type ImpactCalcVia = 'slider' | 'preset'
/** Which page's adoption slider fired impact_calc_adjusted: the full
 *  calculator on /financials or the simpler one on /friends (2026-09-02).
 *  One event, one funnel, a dimension to split it. */
export type ImpactCalcPlacement = 'financials' | 'friends'
/** Where a Become-a-Friend checkout click came from. One placement today;
 *  a union rather than string so a future footer or /financials CTA has to
 *  register itself here, the way InstallPlacement does. */
export type FriendCheckoutPlacement = 'friends_page'

/**
 * Where a link into the /guides section was clicked. One event with this
 * parameter instead of seven event names, per this registry's "describe with
 * parameters, not name explosions" rule (same shape as feedback_opened's
 * placement). Without it, footer traffic and high-intent traffic off the
 * submit-success screen would be one indistinguishable number; and 'header'
 * is a general hub entry with no track anchor, unlike the two footer
 * placements.
 */
export type GuideLinkPlacement =
  | 'header'
  | 'mobile_menu'
  | 'footer_discover'
  | 'footer_contribute'
  | 'organizers_card'
  | 'submit_success'
  | 'embed_builder_hero'
  | 'guides_hub'
  | 'related_guides'

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
  EMBED_CONTACT_CLICKED:    'embed_contact_clicked',
  EMBED_REQUEST_OPENED:     'embed_request_opened',
  EMBED_REQUEST_SUBMITTED:  'embed_request_submitted',
  EMBED_REQUEST_FAILED:     'embed_request_failed',
  SELECT_CONTENT:           'select_content',
  SHARE:                    'share',
  SEARCH:                   'search',
  VIEW_EVENT:               'view_event',
  OUTBOUND_CLICK:           'outbound_click',
  ADD_TO_CALENDAR:          'add_to_calendar',
  CATEGORY_FILTER:          'category_filter',
  // WHEN_FILTER: NOT `date_filter` or `time_filter` -- one event describing
  // both the date preset/range and time-of-day state, per this registry's
  // "describe with parameters, not name explosions" rule (mirrors
  // category_filter). Fired from WhenSection's own handlers so both funnels
  // that mount it (the tray and the hub filter strip) report identically --
  // see category_filter's own two-call-site note for why that has to be true
  // at the shared-component level, not the hook level.
  WHEN_FILTER:              'when_filter',
  THEME_CHANGED:            'theme_changed',
  FEEDBACK_OPENED:    'feedback_opened',
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  FEEDBACK_DISMISSED: 'feedback_dismissed',
  PLAN_ITEM_ADDED:    'plan_item_added',
  PLAN_ITEM_REMOVED:  'plan_item_removed',
  PLAN_SHARED:        'plan_shared',
  PLAN_OPENED:        'plan_opened',
  PLAN_EXPORTED:      'plan_exported',
  PLAN_CAP_REACHED:      'plan_cap_reached',
  PLAN_DRAFT_RECONCILED: 'plan_draft_reconciled',
  PLAN_SYNC_FAILED:      'plan_sync_failed',
  PLAN_SHARE_FAILED:     'plan_share_failed',
  PLAN_LINK_COPIED:      'plan_link_copied',
  PLAN_MAP_TOGGLED:      'plan_map_toggled',
  PLAN_MAP_SELECTION:    'plan_map_selection',
  IMPACT_CALC_ADJUSTED:  'impact_calc_adjusted',
  GUIDE_LINK_CLICK:      'guide_link_click',
  // Deliberately NOT `video_start` or `video_progress`: both are GA4 reserved
  // names (see scripts/tests/test-analytics-events.js RESERVED).
  GUIDE_VIDEO_PLAY:      'guide_video_play',
  FRIEND_CHECKOUT_CLICK:  'friend_checkout_click',
  FRIEND_CHECKOUT_RETURN: 'friend_checkout_return',
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
  embed_contact_clicked:    Record<string, never>
  // locked_filters: count of place/categories/price/date/family actually
  // set at submit time — answers "do partners use the locks, and which
  // ones" with one parameter instead of five event names.
  embed_request_opened:    Record<string, never>
  embed_request_submitted: { theme: string; locked_filters: number }
  embed_request_failed:    { reason: EmbedRequestFailure }
  select_content:           { content_type: string; item_id: string }
  share:                    { method: string; content_type: string; item_id: string }
  search:                   { search_term: string; content_type: SearchContentType; result_count: number }
  view_event:               { category: string; source_tier: SourceTier }
  outbound_click:           { link_type: OutboundLinkType; source_tier: SourceTier; category: string }
  add_to_calendar:          { method: CalendarMethod; category: string }
  category_filter:          { category: string; action: CategoryFilterAction }
  // Checked against initAnalytics' config-level default params before naming
  // these -- `surface`, `embed_host`, `theme`, `neighborhood` are registered
  // there on every hit, and an event-level param of the same name silently
  // overrides a config default (the incident that renamed plan_surface, see
  // plan_item_added below). None of these four collide with those.
  // preset / time_of_day: RESULTING state (not deltas), so any single hit is
  // self-describing in a report. changed: which control the user actually
  // touched -- the only parameter that answers "does anyone use time of day,
  // or did we build it for ourselves?". span_days: custom range length in
  // days inclusive of both ends; 0 for every preset (there is no span).
  when_filter: {
    preset: WhenPreset
    time_of_day: TimeOfDay
    changed: WhenControl
    span_days: number
  }
  theme_changed:            { theme: string; previous_theme: string }
  feedback_opened:    { placement: FeedbackPlacement }
  feedback_submitted: { placement: FeedbackPlacement }
  feedback_dismissed: { placement: FeedbackPlacement }
  // plan_surface (NOT `surface` -- that name collides with the site-wide
  // `surface` config-level default parameter registered by initAnalytics,
  // and GA4 event-level params silently override config defaults, so a
  // bare `surface` here was corrupting that dimension on every plan event.
  // See analytics.ts's initAnalytics for the dimension it was colliding
  // with. Renamed 2026-08-09 (day-plan-audit.md P0-4) -- do not revert.
  plan_item_added:   { plan_surface: PlanSurface; category: string }
  plan_item_removed: { plan_surface: PlanSurface }
  // days_spanned: distinct Eastern days in the draft at share time
  // (groupPlanItemsByDay(items).length) -- answers whether this is a
  // same-day itinerary tool or a multi-day wishlist.
  plan_shared:        { item_count: number; days_spanned: number }
  // role: 'owner' = this device holds the code in akronpulse_day_plan_code;
  // 'visitor' = someone else's /d/:code; 'draft' = /day itself, before any
  // code exists. Answers the only question that matters about this feature —
  // are shared links actually opened by OTHER people, or is this a private
  // bookmarking tool with extra steps? Without it, plan_opened is unreadable.
  plan_opened:        { role: PlanOpenedRole; item_count: number }
  // format: 'print' fires on window.print() invocation -- print INTENT, not
  // a completed print (the user may cancel the OS dialog).
  plan_exported:       { format: PlanExportFormat; item_count: number }
  plan_cap_reached:      { plan_surface: PlanSurface }
  plan_draft_reconciled: { removed: number; item_count: number }
  /** `reason` present only when the failure was terminal (the plan row is
   *  gone) and the client dropped its active code instead of reverting. */
  plan_sync_failed:      { op: PlanSyncOp; reason?: 'plan_gone' }
  plan_share_failed:     Record<string, never>
  // No identifier of any kind on purpose -- see SharedPlanPage.tsx's
  // handleCopyLink. `role` mirrors plan_opened's split.
  plan_link_copied:      { role: 'owner' | 'visitor' }
  plan_map_toggled:      { state: PlanMapToggleState }
  plan_map_selection:    { from: PlanMapSelectionSource }
  // percent: the RESULTING adoption share (0-100) after the interaction, so
  // any single hit is self-describing, mirroring when_filter's resulting-state
  // rule. Slider fires debounced on settle, never per-tick — a drag is one
  // exploration, not forty.
  impact_calc_adjusted:  { percent: number; via: ImpactCalcVia; placement: ImpactCalcPlacement }
  guide_link_click:      { guide_slug: string; placement: GuideLinkPlacement }
  guide_video_play:      { guide_slug: string }
  // placement: where on /friends the click came from ('friends_page' today,
  // room for a future footer/financials CTA later). No frequency or amount:
  // the single Square link carries both choices on Square's own page (see
  // src/lib/friends.ts), so we never learn which the visitor picked.
  friend_checkout_click:  { placement: FriendCheckoutPlacement }
  // Fired once, on mount, by /friends/thank-you -- the completed round trip
  // through Square's checkout. No parameters: Square never tells us the
  // amount or frequency chosen.
  friend_checkout_return: Record<string, never>
}
