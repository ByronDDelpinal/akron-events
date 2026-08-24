/**
 * types.ts: the shared vocabulary of slack-ask's pure core (Phase 1).
 *
 * Phase 1 of Tier 3 (docs/ADR-slack-tier3-inbound-bot.md, sections 3, 4, 5.7,
 * 6, 9) is a read-only question answerer with NO LLM anywhere: an @-mention
 * arrives, a deterministic matcher (intent.ts) picks a handler id and a
 * parameter bag, the handler (handlers.ts) runs one hardcoded query, and a
 * renderer (render.ts) caps the result to a phone-readable reply that
 * redact.ts inspects one last time before it leaves.
 *
 * This file holds only types and the query-spec vocabulary. It has no
 * behaviour, no I/O, and no `Deno.env` read, so every other module in this
 * directory can import it without dragging a runtime dependency along.
 *
 * ── THE INJECTION SEAM ────────────────────────────────────────────────────
 * Handlers never touch a Supabase client. They describe what they want as a
 * `SelectSpec` / `CountSpec` and hand it to an injected `QueryExecutor`. That
 * is what makes `deno test` work with no network and no database: the tests
 * stub the executor and assert on the specs the handler produced, which is
 * strictly stronger than asserting on a mocked client's return value (a
 * wrong column list is caught, not just a wrong number).
 *
 * It is also what keeps the not-yet-written index.ts thin. The entry point's
 * whole job on the answering side is: build one `QueryExecutor` backed by the
 * service-role client, call `matchIntent`, look the id up in `HANDLERS`, run
 * it, render, redact, post. No business logic lives there.
 *
 * ── WHY A SPEC AND NOT A STRING OF SQL ────────────────────────────────────
 * `slack-notify/index.ts:380-382` states the codebase's hard requirement:
 * hardcoded column allowlists, never `select('*')`, because
 * `subscribers.token` is the unsubscribe secret. A spec makes that
 * requirement structural rather than a habit: `SelectSpec.columns` is a
 * required readonly array of literal column names written at the call site,
 * so a handler physically cannot request a column its author did not name,
 * and a reviewer can audit every column this function can read by grepping
 * for `columns:` in one file.
 *
 * Filters are values, never fragments. The executor is responsible for
 * binding them through PostgREST's parameterised operators. Note for anyone
 * who later adds a raw-SQL RPC to this directory: in Postgres,
 * `NOT x ILIKE ANY(...)` does NOT mean what it reads like. Always write
 * `NOT (x ILIKE ANY(...))`. This project has been bitten by that precedence.
 */

// ── Query vocabulary ──────────────────────────────────────────────────────

/** A value a filter may compare against. Never a SQL fragment. */
export type FilterValue = string | number | boolean | null

/**
 * The closed set of comparisons a handler may express. Deliberately small:
 * anything not expressible here should be done by fetching an allowlisted
 * column under a row cap and aggregating in TypeScript, which is auditable,
 * rather than by widening this union toward arbitrary SQL.
 *
 * `not_ilike` maps to PostgREST's `not.ilike`, which negates the single
 * comparison it is attached to. It is not the `NOT x ILIKE ANY(...)`
 * precedence trap, because there is no `ANY` here and no operator sequence
 * for a parser to mis-bind.
 */
export type Filter =
  | { readonly op: 'eq' | 'neq'; readonly column: string; readonly value: FilterValue }
  | { readonly op: 'gt' | 'gte' | 'lt' | 'lte'; readonly column: string; readonly value: string | number }
  | { readonly op: 'is' | 'not_is'; readonly column: string; readonly value: null | boolean }
  | { readonly op: 'in'; readonly column: string; readonly values: readonly (string | number)[] }
  | { readonly op: 'ilike' | 'not_ilike'; readonly column: string; readonly value: string }

/**
 * An embedded (joined) resource, PostgREST style.
 *
 * Needed because three real questions ("top venues", "which neighbourhoods",
 * "what's on at the Rialto") are joins, and the alternative is fetching a
 * thousand event ids and posting them back as an `in` list, which blows the
 * URL length limit and is slower besides.
 *
 * The column allowlist rule survives the join intact: an embed names its own
 * columns explicitly, exactly like the parent select, so nothing widens.
 * `inner: true` renders `relation!inner(...)`, which is what makes the embed
 * a filter as well as a projection (events with no venue drop out).
 *
 * Embeds may nest one level (`event_venues -> venues`), which is as deep as
 * this schema needs. A filter may target an embedded column with a dotted
 * path, e.g. `event_venues.venues.name`.
 */
export interface EmbedSpec {
  readonly relation: string
  readonly inner: boolean
  readonly columns: readonly string[]
  readonly embed?: readonly EmbedSpec[]
}

/**
 * A row-returning read. Every field is required on purpose:
 *
 *  - `columns` is the hardcoded allowlist (rule 3). No wildcard is
 *    representable in this type.
 *  - `limit` is mandatory, so "I forgot the LIMIT" is a compile error rather
 *    than a 12,000-row transfer into an edge isolate (rule 9).
 */
export interface SelectSpec {
  readonly table: string
  readonly columns: readonly string[]
  readonly embed?: readonly EmbedSpec[]
  readonly filters: readonly Filter[]
  readonly order?: { readonly column: string; readonly ascending: boolean }
  readonly limit: number
}

/** A `count(*)` with no row transfer. Cheap, and it cannot leak a column. */
export interface CountSpec {
  readonly table: string
  readonly filters: readonly Filter[]
}

/** An untyped row. Handlers narrow it themselves at the one place they read it. */
export type Row = Record<string, unknown>

/**
 * The seam. The real implementation (service-role Supabase client) belongs in
 * index.ts; the tests pass a stub. Nothing in handlers.ts, render.ts,
 * redact.ts, or intent.ts constructs one.
 */
export interface QueryExecutor {
  select(spec: SelectSpec): Promise<readonly Row[]>
  count(spec: CountSpec): Promise<number>
}

// ── Time windows ──────────────────────────────────────────────────────────

/**
 * The window slot, shared by every windowed handler. Produced only by
 * `parseWindow` in intent.ts, never assembled by a handler and never taken
 * from user text as a raw date string.
 *
 * `startUtc` is inclusive, `endUtc` is EXCLUSIVE. Half-open avoids the
 * classic "23:59:59.999 loses the last millisecond" bug and makes adjacent
 * windows tile without overlap.
 *
 * Both are real UTC instants derived from Eastern wall-clock boundaries, so
 * a DST transition day is genuinely 23 or 25 hours long. See the EASTERN TIME
 * section of intent.ts for why this is not `toISOString()`.
 */
export type WindowKind =
  | 'today'
  | 'tonight'
  | 'last_night'
  | 'tomorrow'
  | 'yesterday'
  | 'weekend'
  | 'week'
  | 'month'
  | 'next_days'
  | 'last_days'
  | 'last_hours'
  | 'date'

export interface TimeWindow {
  readonly kind: WindowKind
  /** Short human label for line one of the reply, e.g. `tonight`, `Fri-Sun`, `Sep`. */
  readonly label: string
  /** Inclusive lower bound, ISO 8601 UTC. */
  readonly startUtc: string
  /** Exclusive upper bound, ISO 8601 UTC. */
  readonly endUtc: string
  /** Inclusive Eastern calendar dates the window covers, `YYYY-MM-DD`. */
  readonly startDateEt: string
  readonly endDateEt: string
}

// ── Handlers ──────────────────────────────────────────────────────────────

/**
 * The closed handler set. This union is the whole capability surface of the
 * bot: anything not named here cannot be answered, by construction.
 *
 * `no_match` and `analytics_unavailable` are real handlers rather than
 * special cases in the caller, so index.ts has exactly one code path
 * ("look the id up, run it, render it") and cannot grow a second one.
 */
export type HandlerId =
  // events and content
  | 'events_in_window'
  | 'events_by_source'
  | 'events_by_category'
  | 'events_by_neighborhood'
  | 'events_added_recently'
  | 'top_venues'
  | 'top_organizations'
  | 'events_missing_image'
  | 'events_at_venue'
  | 'free_vs_paid'
  | 'featured_events'
  // scrapers and ops
  | 'scraper_health_summary'
  | 'scrapers_failing'
  | 'scrapers_zero_events'
  | 'scrapers_stale'
  | 'scraper_last_run'
  | 'last_night_totals'
  | 'scraper_registry_coverage'
  // site business
  | 'subscriber_counts'
  | 'digest_status'
  | 'feedback_recent'
  | 'embed_requests_count'
  | 'partner_orgs_count'
  | 'review_queue'
  // site traffic, read from the GA4 mirror in Postgres (migration 062)
  | 'traffic_overview'
  | 'traffic_trend'
  | 'top_pages'
  | 'outbound_clicks'
  | 'embed_traffic'
  | 'pwa_installs'
  // combined
  | 'status_summary'
  // terminal, no database
  | 'analytics_unavailable'
  | 'no_match'

export type HandlerFamily = 'events' | 'ops' | 'business' | 'traffic' | 'meta'

/**
 * The parameter bag. One shared shape rather than a per-handler generic,
 * because the registry must be a uniform `Record<HandlerId, HandlerDef>` for
 * the explicit-lookup-with-throw pattern to work (the same reason
 * `AGENT_POST_CHANNELS` in slack-notify/request.ts is a plain lookup table).
 *
 * Every field is optional here and EVERY handler re-validates and clamps what
 * it reads before querying (rule 8). The matcher is not trusted to have
 * clamped anything: it is a separate module with its own tests, and a handler
 * that trusts its caller's arithmetic is a handler that ships an unbounded
 * `days` the day someone edits a regex.
 */
export interface HandlerParams {
  readonly window?: TimeWindow
  readonly days?: number
  readonly scraperName?: string
  readonly venueQuery?: string
  readonly topic?: string
}

export interface HandlerContext {
  readonly exec: QueryExecutor
  readonly params: HandlerParams
  /** Injected so tests can pin "now". Never `new Date()` inside a handler. */
  readonly now: Date
}

/**
 * A handler returns LINES, not a finished message. render.ts owns the caps
 * (6 lines, 600 characters) and the truncation, so a handler author cannot
 * accidentally opt out of them by returning a pre-joined string.
 *
 * Lines are already escaped with `escapeSlackText` by the handler, at the
 * point each dynamic value is interpolated (rule 5). render.ts does not
 * escape, because escaping a whole assembled line would double-encode the
 * ampersands the handler already produced.
 */
export interface HandlerDef {
  readonly id: HandlerId
  readonly family: HandlerFamily
  /** One short phrase for the no_match menu. Static text, never user data. */
  readonly menuLabel: string
  /** Phrasings this handler answers. Used by the menu and by intent.test.ts. */
  readonly examples: readonly string[]
  /** False for the two terminal handlers, which need no QueryExecutor. */
  readonly needsDb: boolean
  run(ctx: HandlerContext): Promise<readonly string[]>
}

// ── Matcher result ────────────────────────────────────────────────────────

/**
 * `matchIntent` always returns a handler id. A miss is `no_match`, which is
 * itself a handler that renders the menu. There is no null branch for the
 * caller to forget, and no silent dead end (ADR section 3: "Never a dead
 * end").
 */
export interface IntentMatch {
  readonly handlerId: HandlerId
  readonly params: HandlerParams
  /** The ordered-rule name that fired. Logged, never posted. */
  readonly rule: string
  /** The normalised text the rules ran against. Logged, never posted. */
  readonly normalized: string
}
