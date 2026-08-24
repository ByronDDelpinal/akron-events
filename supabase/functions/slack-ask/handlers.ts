/**
 * handlers.ts: the handler registry and every query the bot can run.
 *
 * ADR section 4: "a fixed set of named, parameterized handlers in TypeScript,
 * using the service-role client with hardcoded column allowlists. Not
 * LLM-generated SQL. Not new anon-readable views."
 *
 * This file is the entire read surface of Tier 3. If a table, a column, or a
 * filter is not written here, the bot cannot read it. That is not a
 * convention, it is the design: `HANDLERS` is a frozen `Record<HandlerId,
 * HandlerDef>` and `HandlerId` is a closed union, so the set of answerable
 * questions is fixed at compile time and a caller cannot extend it. Same
 * shape as `AGENT_IDENTITIES` in _shared/slack.ts and `AGENT_POST_CHANNELS`
 * in slack-notify/request.ts.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FIVE RULES EVERY HANDLER IN THIS FILE FOLLOWS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. HARDCODED COLUMN ALLOWLISTS, NEVER `select('*')`.
 *    slack-notify/index.ts:380-382 states this as a hard requirement because
 *    `subscribers.token` is the unsubscribe secret. Tier 3 reads far more of
 *    the database than Tier 1, so the rule gets stricter, not looser. Every
 *    `SelectSpec` below names its columns literally. Grep `columns:` in this
 *    file to audit the complete set of columns this function can read.
 *
 * 2. NO PII REACHES A CHANNEL, EVER.
 *    `subscribers.email`, `subscribers.token`, `feedback_posts.email`,
 *    `feedback_posts.author_name`, `feedback_posts.body`,
 *    `embed_requests.email`, `embed_requests.name`, and
 *    `organizations.contact_email` appear in NO allowlist here. Subscriber and
 *    feedback questions are answered with counts and aggregates only.
 *    Tier 1 does put some of those emails in a private partner channel
 *    (index.ts:366, index.ts:386), deliberately, because that channel has a
 *    business need. ADR section 5.7: "Tier 3 is a different channel with a
 *    different audience and does not inherit that."
 *
 * 3. EVERY DYNAMIC VALUE IS ESCAPED AT INTERPOLATION.
 *    Via `esc` / `shortEscaped` / `errorSnippet` from render.ts, which wrap
 *    `escapeSlackText` (_shared/slack.ts:117). Scraper `last_error` is the
 *    highest-risk field in the file: third-party text, stored verbatim, and
 *    the one string here an attacker upstream could shape. It only ever
 *    reaches a line through `errorSnippet`.
 *
 * 4. EVERY HANDLER VALIDATES AND CLAMPS ITS OWN PARAMS BEFORE QUERYING.
 *    Not because the matcher is careless, but because the matcher is a
 *    different module with different tests. A day count clamps to 1-90 here
 *    even though intent.ts already clamped it; a scraper name is re-checked
 *    against SCRAPER_REGISTRY here even though the matcher only produces
 *    registry keys; a window is re-derived here if it is missing or insane. A
 *    handler that trusts its caller's arithmetic ships an unbounded query the
 *    day someone edits a regex.
 *
 * 5. A ROW CAP AND A LIMIT ON EVERY QUERY.
 *    `SelectSpec.limit` is a required field, so this is enforced by the type.
 *    Aggregations fetch one allowlisted column under `AGG_ROW_CAP` and tally
 *    in TypeScript; when the cap is hit the reply says so rather than quietly
 *    under-reporting.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NO DATABASE CLIENT IS IMPORTED HERE
 * ══════════════════════════════════════════════════════════════════════════
 * Handlers describe queries and hand them to an injected `QueryExecutor`
 * (types.ts). The service-role-backed implementation belongs in the
 * not-yet-written index.ts; the tests pass a stub and assert on the specs
 * produced, which catches a wrong column list, not just a wrong number.
 *
 * A handler returns LINES. render.ts owns the 6-line / 600-character caps, so
 * a handler cannot opt out of them.
 */

import {
  clampDays,
  easternTodayIso,
  easternToUtc,
  etDateAdd,
  etDaysBetween,
  isKnownScraper,
  parseEtDate,
  SCRAPER_REGISTRY,
  scraperLabel,
  upcomingWindow,
} from './intent.ts'
import {
  deltaPhrase,
  errorSnippet,
  esc,
  etStamp,
  GA_FLOOR_NOTE,
  gaNum,
  hoursAgo,
  plural,
  rankTally,
  shortEscaped,
  tallyLine,
} from './render.ts'
import type {
  CountSpec,
  Filter,
  HandlerContext,
  HandlerDef,
  HandlerId,
  Row,
  SelectSpec,
  TimeWindow,
} from './types.ts'

// ── Caps ──────────────────────────────────────────────────────────────────

/**
 * The most rows any aggregation may pull back. 11.7k events exist in total, so
 * a 30-day window is comfortably inside this; a "named month in peak season"
 * question is the one that could approach it, and that case reports the cap
 * rather than silently under-counting.
 */
const AGG_ROW_CAP = 3000

/** The most rows any list-shaped answer may pull back. Six lines fit ~4 items. */
const LIST_ROW_CAP = 25

/** Every event question is about the published calendar, not the raw intake. */
const PUBLISHED: Filter = { op: 'eq', column: 'status', value: 'published' }

// ── Query shaping helpers ─────────────────────────────────────────────────

function windowFilters(w: TimeWindow, column = 'start_at'): Filter[] {
  // Half-open, matching TimeWindow's contract: gte start, lt end.
  return [
    { op: 'gte', column, value: w.startUtc },
    { op: 'lt', column, value: w.endUtc },
  ]
}

/** Rolling cutoff for `created_at`-style questions. Absolute, so no ET needed. */
function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - clampDays(days) * 86_400_000).toISOString()
}

/**
 * Re-derive the window rather than trusting the one the matcher attached
 * (rule 4). "Insane" means unparseable, inverted, or spanning more than a
 * year, any of which would turn a 2-second reply into a table scan.
 */
function requireWindow(ctx: HandlerContext, fallbackDays: number): TimeWindow {
  const w = ctx.params.window
  if (!w) return upcomingWindow(ctx.now, fallbackDays)
  try {
    const span = etDaysBetween(w.startDateEt, w.endDateEt)
    const start = Date.parse(w.startUtc)
    const end = Date.parse(w.endUtc)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return upcomingWindow(ctx.now, fallbackDays)
    if (end <= start) return upcomingWindow(ctx.now, fallbackDays)
    if (span < 0 || span > 366) return upcomingWindow(ctx.now, fallbackDays)
    return w
  } catch {
    return upcomingWindow(ctx.now, fallbackDays)
  }
}

/**
 * The immediately preceding window of the same length, for the "and how does
 * that compare" half of the ADR's worked example ("47 events Fri-Sun. Last
 * weekend: 41"). Built from Eastern calendar dates, so a comparison that
 * spans a DST change still compares equal numbers of calendar days.
 */
function priorWindow(w: TimeWindow): TimeWindow {
  const spanDays = etDaysBetween(w.startDateEt, w.endDateEt) + 1
  const newStart = etDateAdd(w.startDateEt, -spanDays)
  const s = parseEtDate(newStart)
  const e = parseEtDate(w.startDateEt)
  return {
    kind: w.kind,
    label: `${spanDays}d`,
    startUtc: easternToUtc(s.year, s.month, s.day, 0).toISOString(),
    endUtc: easternToUtc(e.year, e.month, e.day, 0).toISOString(),
    startDateEt: newStart,
    endDateEt: etDateAdd(w.startDateEt, -1),
  }
}

/**
 * "Last night" as an operator means it: 18:00 ET through noon ET the next day.
 *
 * The nightly scrape runs around 10pm ET and the agent chain runs 12:45am to
 * 5:45am, so an 18:00-to-noon envelope captures the whole thing with room on
 * both ends. If the question is asked after 18:00 the envelope is tonight's,
 * which is what someone typing "how did the scrape go" at 11pm means; before
 * 18:00 it is yesterday evening's.
 */
function lastNightWindow(now: Date): { startUtc: string; endUtc: string; label: string } {
  const today = easternTodayIso(now)
  const hourEt = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' })
      .format(now),
  ) % 24
  const anchor = hourEt >= 18 ? today : etDateAdd(today, -1)
  const next = etDateAdd(anchor, 1)
  const a = parseEtDate(anchor)
  const n = parseEtDate(next)
  return {
    startUtc: easternToUtc(a.year, a.month, a.day, 18).toISOString(),
    endUtc: easternToUtc(n.year, n.month, n.day, 12).toISOString(),
    label: 'last night',
  }
}

/**
 * Pull every string at a nested path out of a PostgREST embed result.
 *
 * An embedded relation comes back as an object for a to-one join and an array
 * for a to-many, and this schema has both shapes on the same path depending on
 * the row. Walking it defensively (rather than asserting a shape) means one
 * unexpected null cannot throw and lose the whole answer.
 */
function pluck(value: unknown, path: readonly string[]): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((v) => pluck(v, path))
  if (path.length === 0) return typeof value === 'string' ? [value] : []
  if (typeof value !== 'object') return []
  return pluck((value as Row)[path[0]], path.slice(1))
}

function tally(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return counts
}

/** `(capped)` marker so a truncated aggregation never reads as a total. */
function capNote(rowCount: number): string {
  return rowCount >= AGG_ROW_CAP ? ` (first ${AGG_ROW_CAP})` : ''
}

function countSpec(table: string, filters: readonly Filter[]): CountSpec {
  return { table, filters }
}

// ══════════════════════════════════════════════════════════════════════════
// EVENTS AND CONTENT
// ══════════════════════════════════════════════════════════════════════════

/**
 * Window kinds a prior-period comparison is NOT offered for.
 *
 * `priorWindow` is built from Eastern calendar midnights, so for a window
 * shorter than a day it compares a few hours against a whole one: "9 events
 * last night. Prior 1d: 9." reads as like-for-like and is not. Suppressing
 * the comparison is better than computing a duration-exact one, because for
 * these three the comparison is not what was asked and "47 events last night."
 * on its own is a complete answer.
 */
const NO_COMPARISON: ReadonlySet<string> = new Set(['tonight', 'last_night', 'last_hours'])

async function eventsInWindow(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 7)
  if (NO_COMPARISON.has(w.kind)) {
    const only = await ctx.exec.count(countSpec('events', [PUBLISHED, ...windowFilters(w)]))
    return [`${plural(only, 'event')} ${esc(w.label)}.`]
  }
  const prior = priorWindow(w)
  const [now, before] = await Promise.all([
    ctx.exec.count(countSpec('events', [PUBLISHED, ...windowFilters(w)])),
    ctx.exec.count(countSpec('events', [PUBLISHED, ...windowFilters(prior)])),
  ])
  const comparison = before > 0 ? ` Prior ${prior.label}: ${before}.` : ''
  return [`${plural(now, 'event')} ${esc(w.label)}.${comparison}`]
}

async function eventsBySource(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  const spec: SelectSpec = {
    table: 'events',
    columns: ['source'],
    filters: [PUBLISHED, ...windowFilters(w)],
    limit: AGG_ROW_CAP,
  }
  const rows = await ctx.exec.select(spec)
  const ranked = rankTally(tally(rows.map((r) => String(r.source ?? 'unknown'))))
  if (ranked.length === 0) return [`No events ${esc(w.label)}.`]
  // scraperLabel turns `akron_civic` into `Akron Civic Theatre`. A source key
  // that is not in the registry falls back to the key itself rather than
  // `undefined`, which is why the lookup is a function and not a bare index.
  const named = ranked.map(([key, n]) => [scraperLabel(key), n] as const)
  return [
    `${plural(rows.length, 'event')} ${esc(w.label)}${capNote(rows.length)}, ${plural(ranked.length, 'source')}.`,
    tallyLine(named, 3),
    ranked.length > 3 ? tallyLine(named.slice(3), 3) : '',
  ]
}

async function eventsByCategory(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  // `category_slugs` is a denormalised text[] on events, populated for every
  // row, so this is one query instead of a join through event_categories.
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['category_slugs'],
    filters: [PUBLISHED, ...windowFilters(w)],
    limit: AGG_ROW_CAP,
  })
  const ranked = rankTally(tally(rows.flatMap((r) => pluck(r.category_slugs, []))))
  if (ranked.length === 0) return [`No categorised events ${esc(w.label)}.`]
  return [
    `${plural(rows.length, 'event')} ${esc(w.label)}${capNote(rows.length)} across ${ranked.length} categories.`,
    tallyLine(ranked, 4),
    ranked.length > 4 ? tallyLine(ranked.slice(4), 4) : '',
  ]
}

async function eventsByNeighborhood(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  // The `areas` table is venue sub-rooms ("Pool room", "Gallery Stage") and
  // `event_areas` is empty, so neither answers this question. Neighbourhood
  // lives on `venues.neighborhood_slug`, reached through `event_venues`.
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['id'],
    embed: [{
      relation: 'event_venues',
      inner: true,
      columns: [],
      embed: [{ relation: 'venues', inner: true, columns: ['neighborhood_slug'] }],
    }],
    filters: [PUBLISHED, ...windowFilters(w)],
    limit: AGG_ROW_CAP,
  })
  // DEDUPE PER EVENT. 738 events in production have more than one venue, so
  // a flat tally counts venue LINKS, not events: the neighbourhood totals
  // inflate past the number of events and "events with no neighbourhood"
  // (rows minus links) goes negative. One event contributes at most once per
  // distinct neighbourhood, and `placed` counts EVENTS that landed somewhere.
  const perRow = rows.map((r) => [...new Set(pluck(r.event_venues, ['venues', 'neighborhood_slug']))])
  const ranked = rankTally(tally(perRow.flat()))
  const placed = perRow.filter((slugs) => slugs.length > 0).length
  const unplaced = rows.length - placed
  if (ranked.length === 0) return [`No events ${esc(w.label)} have a neighbourhood on their venue.`]
  return [
    `${plural(rows.length, 'event')} ${esc(w.label)} across ${ranked.length} neighbourhoods${capNote(rows.length)}.`,
    tallyLine(ranked, 3),
    ranked.length > 3 ? tallyLine(ranked.slice(3), 3) : '',
    unplaced === 1
      ? '1 event has no neighbourhood on its venue.'
      : `${unplaced} events have no neighbourhood on their venue.`,
  ]
}

async function eventsAddedRecently(ctx: HandlerContext): Promise<string[]> {
  const days = clampDays(ctx.params.days ?? 1)
  const cutoff = daysAgoIso(ctx.now, days)
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['source'],
    // PUBLISHED, like every other events handler. Without it this counts the
    // 415 cancelled rows, and "12 events added overnight" that includes
    // cancellations is a number someone acts on and should not. The
    // consistency matters more than the marginal signal: if a cancelled
    // ingest ever needs surfacing it deserves its own handler and its own
    // wording, not a silent inflation of this one.
    filters: [PUBLISHED, { op: 'gte', column: 'created_at', value: cutoff }],
    limit: AGG_ROW_CAP,
  })
  const window = days === 1 ? 'last 24h' : `last ${days}d`
  if (rows.length === 0) return [`Nothing added in the ${window}.`]
  const ranked = rankTally(tally(rows.map((r) => scraperLabel(String(r.source ?? 'unknown')))))
  return [
    `${plural(rows.length, 'event')} added in the ${window}${capNote(rows.length)}.`,
    tallyLine(ranked, 3),
  ]
}

async function topVenues(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['id'],
    embed: [{
      relation: 'event_venues',
      inner: true,
      columns: [],
      embed: [{ relation: 'venues', inner: true, columns: ['name'] }],
    }],
    filters: [PUBLISHED, ...windowFilters(w)],
    limit: AGG_ROW_CAP,
  })
  // Dedupe per event, same reason as events_by_neighborhood: without it the
  // tally counts venue links while `capNote` describes events, so the header
  // and the numbers are counting different populations.
  //
  // `venues.listed` is NOT filtered (132 of 931 venues are unlisted). The
  // question is where events are actually happening, an unlisted venue still
  // hosts them, and filtering here would make these numbers disagree with the
  // event counts every other handler reports for the same window.
  const ranked = rankTally(
    tally(rows.flatMap((r) => [...new Set(pluck(r.event_venues, ['venues', 'name']))])),
  )
  if (ranked.length === 0) return [`No venue-linked events ${esc(w.label)}.`]
  return [
    `Top venues ${esc(w.label)} (by event)${capNote(rows.length)}:`,
    ...ranked.slice(0, 4).map(([name, n]) => `${shortEscaped(name, 34)} ${n}`),
  ]
}

async function topOrganizations(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  // `organizations.contact_email` exists and is deliberately NOT in this
  // allowlist. Only `name` is read.
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['id'],
    embed: [{
      relation: 'event_organizations',
      inner: true,
      columns: [],
      embed: [{ relation: 'organizations', inner: true, columns: ['name'] }],
    }],
    filters: [PUBLISHED, ...windowFilters(w)],
    limit: AGG_ROW_CAP,
  })
  // Dedupe per event: an event with two organisations counts once for each,
  // never twice for one.
  const ranked = rankTally(
    tally(rows.flatMap((r) => [...new Set(pluck(r.event_organizations, ['organizations', 'name']))])),
  )
  if (ranked.length === 0) return [`No org-linked events ${esc(w.label)}.`]
  return [
    `Top organisations ${esc(w.label)} (by event)${capNote(rows.length)}:`,
    ...ranked.slice(0, 4).map(([name, n]) => `${shortEscaped(name, 34)} ${n}`),
  ]
}

async function eventsMissingImage(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  // Verified against production: `image_url` is null for missing images and is
  // never the empty string, so one `is null` filter is the whole condition.
  const missing: Filter[] = [PUBLISHED, ...windowFilters(w), { op: 'is', column: 'image_url', value: null }]
  const [total, without, rows] = await Promise.all([
    ctx.exec.count(countSpec('events', [PUBLISHED, ...windowFilters(w)])),
    ctx.exec.count(countSpec('events', missing)),
    ctx.exec.select({ table: 'events', columns: ['source'], filters: missing, limit: AGG_ROW_CAP }),
  ])
  if (without === 0) return [`Every event ${esc(w.label)} has an image. ${total} checked.`]
  const pct = total > 0 ? Math.round((without / total) * 100) : 0
  const ranked = rankTally(tally(rows.map((r) => scraperLabel(String(r.source ?? 'unknown')))))
  return [
    `${without}/${total} events ${esc(w.label)} have no image (${pct}%).`,
    `Worst: ${tallyLine(ranked, 3)}`,
  ]
}

async function eventsAtVenue(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  const term = (ctx.params.venueQuery ?? '').trim()
  // Re-validate the slot (rule 4). The matcher already sanitised it; this is
  // the gate that holds if someone calls the handler from somewhere else.
  if (term.length < 2 || /[%_(),*]/.test(term)) {
    return ['Which venue? Try: what is on at the rialto this weekend']
  }
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['title', 'start_at'],
    embed: [{
      relation: 'event_venues',
      inner: true,
      columns: [],
      embed: [{ relation: 'venues', inner: true, columns: ['name'] }],
    }],
    // The term is a BOUND VALUE on an ilike filter, not interpolated SQL. The
    // `%` wrappers are added here, after sanitisation stripped any the user
    // typed, so a question cannot widen its own match.
    filters: [
      PUBLISHED,
      ...windowFilters(w),
      { op: 'ilike', column: 'event_venues.venues.name', value: `%${term}%` },
    ],
    order: { column: 'start_at', ascending: true },
    limit: LIST_ROW_CAP,
  })
  if (rows.length === 0) return [`Nothing matching "${esc(term)}" ${esc(w.label)}.`]
  // Name the venue that ACTUALLY MATCHED, not the first venue on the first
  // row. 738 events have more than one venue, and with an inner join the
  // first embedded venue on a multi-venue event is frequently not the one the
  // ilike hit, so the reply would confidently name the wrong place.
  const lowered = term.toLowerCase()
  const matched = rows
    .flatMap((r) => pluck(r.event_venues, ['venues', 'name']))
    .find((name) => name.toLowerCase().includes(lowered)) ?? term
  const todayEt = easternTodayIso(ctx.now)
  // `plural` cannot be used directly: the capped case is the string `25+`, not
  // a number, so the singular is special-cased instead of rendering "1 events".
  const count = rows.length >= LIST_ROW_CAP
    ? `${LIST_ROW_CAP}+ events`
    : plural(rows.length, 'event')
  return [
    `${count} at ${shortEscaped(matched, 30)} ${esc(w.label)}:`,
    ...rows.slice(0, 4).map((r) =>
      `${etStamp(r.start_at, todayEt)} ${shortEscaped(r.title, 44)}`
    ),
  ]
}

async function freeVsPaid(ctx: HandlerContext): Promise<string[]> {
  const w = requireWindow(ctx, 30)
  const base = [PUBLISHED, ...windowFilters(w)]
  const [total, free, paid, unknown] = await Promise.all([
    ctx.exec.count(countSpec('events', base)),
    ctx.exec.count(countSpec('events', [...base, { op: 'eq', column: 'price_min', value: 0 }])),
    ctx.exec.count(countSpec('events', [...base, { op: 'gt', column: 'price_min', value: 0 }])),
    ctx.exec.count(countSpec('events', [...base, { op: 'is', column: 'price_min', value: null }])),
  ])
  if (total === 0) return [`No events ${esc(w.label)}.`]
  const pct = Math.round((free / Math.max(1, free + paid)) * 100)
  return [
    `${free} free, ${paid} paid ${esc(w.label)} (${pct}% free of the priced ones).`,
    `${unknown} of ${total} have no price recorded.`,
  ]
}

async function featuredEvents(ctx: HandlerContext): Promise<string[]> {
  const nowIso = ctx.now.toISOString()
  const todayEt = easternTodayIso(ctx.now)
  const rows = await ctx.exec.select({
    table: 'events',
    columns: ['title', 'start_at'],
    filters: [PUBLISHED, { op: 'eq', column: 'featured', value: true }, { op: 'gte', column: 'start_at', value: nowIso }],
    order: { column: 'start_at', ascending: true },
    limit: 4,
  })
  if (rows.length === 0) {
    // `featured` is a human-only editorial flag (.claude/agents/developer.md
    // rule 2: scrapers hardcode `featured: false`), so an empty result is
    // normal and means "nobody has picked any", not "the query broke".
    const eligible = await ctx.exec.count(countSpec('events', [
      PUBLISHED,
      { op: 'eq', column: 'banner_eligible', value: true },
      { op: 'gte', column: 'start_at', value: nowIso },
    ]))
    return [
      'No featured events upcoming. Featured is a manual editorial flag.',
      `${eligible} upcoming events are banner-eligible if you want to pick one.`,
    ]
  }
  return [
    `${plural(rows.length, 'featured event')} upcoming:`,
    ...rows.map((r) => `${etStamp(r.start_at, todayEt)} ${shortEscaped(r.title, 44)}`),
  ]
}

// ══════════════════════════════════════════════════════════════════════════
// SCRAPERS AND OPS
//
// `scraper_health` (supabase/migrations/003_scraper_health.sql) is read AS-IS,
// per ADR section 4: "Use a view only where the aggregation is genuinely
// SQL-shaped and reused. scraper_health already is one." No new views are
// created for the bot, and no new anon grants: the bot reads via service-role.
// ══════════════════════════════════════════════════════════════════════════

const HEALTH_COLUMNS = ['scraper_name', 'last_status', 'is_error', 'is_stale', 'is_zero_streak'] as const

/** scraper_health has 160 rows; 300 leaves headroom without risking a big read. */
const HEALTH_ROW_CAP = 300

/**
 * Split scraper_health rows into the ones the manifest registry knows about
 * and the ones it does not.
 *
 * `scraper_health` is derived from `scraper_runs`, which records whatever
 * name a script logged, so it is a superset of the registry. In production it
 * carries four names that are not in `scripts/manifest.js`:
 * `dedupe_cross_source` (a post-processing pass, not a scraper at all),
 * `ejthomas_hall`, `uakron_chp`, and `uakron_myers_art`.
 *
 * Two consequences if this is not done: the denominators are wrong ("150/160
 * healthy" against a 156-entry registry), and a dedupe pass can appear in a
 * list of failing SCRAPERS, which sends someone looking for a scraper that
 * does not exist.
 *
 * The unknown remainder is not discarded silently. It is reported as its own
 * short fact, because a name in the health view that is not in the registry
 * is exactly the registry-drift signal worth surfacing.
 */
function splitByRegistry(rows: readonly Row[]): { known: Row[]; unknown: Row[] } {
  const known: Row[] = []
  const unknown: Row[] = []
  for (const row of rows) {
    ;(isKnownScraper(String(row.scraper_name ?? '')) ? known : unknown).push(row)
  }
  return { known, unknown }
}

/** `(+2 unregistered)` when the health view carries names the manifest lacks. */
function driftNote(unknown: readonly Row[]): string {
  return unknown.length > 0 ? ` (+${unknown.length} unregistered)` : ''
}

async function scraperHealthSummary(ctx: HandlerContext): Promise<string[]> {
  const all = await ctx.exec.select({
    table: 'scraper_health',
    columns: [...HEALTH_COLUMNS],
    filters: [],
    limit: HEALTH_ROW_CAP,
  })
  const { known, unknown } = splitByRegistry(all)
  const total = known.length
  const errored = known.filter((r) => r.is_error === true)
  const stale = known.filter((r) => r.is_stale === true)
  const zeros = known.filter((r) => r.is_zero_streak === true)
  const unhealthy = new Set([...errored, ...stale, ...zeros].map((r) => String(r.scraper_name)))
  const lines = [
    `${total - unhealthy.size}/${total} scrapers healthy (${SCRAPER_REGISTRY.size} in the registry).`,
  ]
  if (unhealthy.size > 0) {
    lines.push(`${errored.length} erroring, ${stale.length} stale, ${zeros.length} on a zero streak.`)
    lines.push([...unhealthy].slice(0, 6).map((n) => esc(scraperLabel(n))).join(', '))
  } else {
    lines.push('No alerts.')
  }
  if (unknown.length > 0) {
    lines.push(`${unknown.length} names in scraper_health are not in the manifest registry.`)
  }
  return lines
}

async function scrapersFailing(ctx: HandlerContext): Promise<string[]> {
  const all = await ctx.exec.select({
    table: 'scraper_health',
    // `last_error` is third-party text. It reaches a line only through
    // `errorSnippet`, which flattens, clips, then escapes.
    columns: ['scraper_name', 'last_error', 'last_ran_at'],
    filters: [{ op: 'is', column: 'is_error', value: true }],
    order: { column: 'last_ran_at', ascending: false },
    limit: LIST_ROW_CAP,
  })
  // Registry-filtered so a failing `dedupe_cross_source` pass is not reported
  // as a failing scraper.
  const { known, unknown } = splitByRegistry(all)
  if (known.length === 0) {
    return unknown.length > 0
      ? [`No registered scrapers are erroring. ${unknown.length} unregistered name(s) are.`]
      : ['No scrapers are erroring right now.']
  }
  return [
    `${plural(known.length, 'scraper')} erroring${driftNote(unknown)}:`,
    ...known.slice(0, 4).map((r) => `${esc(scraperLabel(String(r.scraper_name)))}: ${errorSnippet(r.last_error, 58)}`),
  ]
}

async function scrapersZeroEvents(ctx: HandlerContext): Promise<string[]> {
  const rows = await ctx.exec.select({
    table: 'scraper_health',
    columns: ['scraper_name', 'consecutive_zeros', 'last_events_found'],
    filters: [{ op: 'eq', column: 'last_events_found', value: 0 }],
    order: { column: 'consecutive_zeros', ascending: false },
    limit: LIST_ROW_CAP,
  })
  const { known, unknown } = splitByRegistry(rows)
  if (known.length === 0) return ['Every scraper returned at least one event on its last run.']
  return [
    `${plural(known.length, 'scraper')} returned 0 events on their last run${driftNote(unknown)}:`,
    ...known.slice(0, 4).map((r) =>
      `${esc(scraperLabel(String(r.scraper_name)))} (${plural(Number(r.consecutive_zeros ?? 0), 'run')} in a row)`
    ),
  ]
}

async function scrapersStale(ctx: HandlerContext): Promise<string[]> {
  const days = clampDays(ctx.params.days ?? 2)
  const hours = days * 24
  const rows = await ctx.exec.select({
    table: 'scraper_health',
    columns: ['scraper_name', 'hours_since_run'],
    filters: [{ op: 'gte', column: 'hours_since_run', value: hours }],
    order: { column: 'hours_since_run', ascending: false },
    limit: LIST_ROW_CAP,
  })
  const { known, unknown } = splitByRegistry(rows)
  if (known.length === 0) return [`Every scraper has run in the last ${days}d.`]
  return [
    `${plural(known.length, 'scraper')} have not run in ${days}d${driftNote(unknown)}:`,
    ...known.slice(0, 4).map((r) =>
      `${esc(scraperLabel(String(r.scraper_name)))} ${Math.round(Number(r.hours_since_run ?? 0))}h ago`
    ),
  ]
}

async function scraperLastRun(ctx: HandlerContext): Promise<string[]> {
  const name = (ctx.params.scraperName ?? '').trim()
  // Rule 4 and the brief's explicit instruction: a scraper_name is validated
  // against the manifest registry, never passed through raw. This is the gate.
  if (!name || !isKnownScraper(name)) {
    return [`Not a scraper I know. ${SCRAPER_REGISTRY.size} are registered, try one by name.`]
  }
  const rows = await ctx.exec.select({
    table: 'scraper_health',
    columns: ['scraper_name', 'last_ran_at', 'last_status', 'last_events_found', 'last_error', 'avg_events_last5'],
    filters: [{ op: 'eq', column: 'scraper_name', value: name }],
    limit: 1,
  })
  const label = esc(scraperLabel(name))
  if (rows.length === 0) {
    // scraper_health only lists scrapers that have logged a run at all
    // (003_scraper_health.sql header: "A scraper that has never run will not
    // appear here"), so an empty result is meaningful, not an error.
    return [`${label} has never logged a run.`]
  }
  const r = rows[0]
  const todayEt = easternTodayIso(ctx.now)
  const ago = hoursAgo(r.last_ran_at, ctx.now)
  const lines = [
    `${label}: ${esc(r.last_status)} at ${etStamp(r.last_ran_at, todayEt)}` +
    `${ago === null ? '' : ` (${ago}h ago)`}, ${Number(r.last_events_found ?? 0)} events.`,
    `Avg of last 5 runs: ${Number(r.avg_events_last5 ?? 0)}.`,
  ]
  if (r.last_error) lines.push(`Error: ${errorSnippet(r.last_error, 64)}`)
  return lines
}

async function lastNightTotals(ctx: HandlerContext): Promise<string[]> {
  const { startUtc, endUtc } = lastNightWindow(ctx.now)
  const rows = await ctx.exec.select({
    table: 'scraper_runs',
    columns: ['scraper_name', 'status', 'events_found', 'events_inserted', 'events_updated'],
    filters: [
      { op: 'gte', column: 'ran_at', value: startUtc },
      { op: 'lt', column: 'ran_at', value: endUtc },
    ],
    limit: 500,
  })
  if (rows.length === 0) return ['No scraper runs recorded last night. That is itself the finding.']
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const errors = rows.filter((r) => r.status === 'error')
  const found = rows.reduce((s, r) => s + num(r.events_found), 0)
  const inserted = rows.reduce((s, r) => s + num(r.events_inserted), 0)
  const updated = rows.reduce((s, r) => s + num(r.events_updated), 0)
  const lines = [
    `Last night: ${plural(rows.length, 'run')}, ${rows.length - errors.length} ok, ${errors.length} errors.`,
    `${found} events found, ${inserted} new, ${updated} updated.`,
  ]
  if (errors.length > 0) {
    lines.push(`Failed: ${errors.slice(0, 4).map((r) => esc(scraperLabel(String(r.scraper_name)))).join(', ')}`)
  }
  return lines
}

async function scraperRegistryCoverage(ctx: HandlerContext): Promise<string[]> {
  const { startUtc, endUtc } = lastNightWindow(ctx.now)
  const rows = await ctx.exec.select({
    table: 'scraper_runs',
    columns: ['scraper_name'],
    filters: [
      { op: 'gte', column: 'ran_at', value: startUtc },
      { op: 'lt', column: 'ran_at', value: endUtc },
    ],
    limit: 500,
  })
  const ran = new Set(rows.map((r) => String(r.scraper_name)))
  const active = [...SCRAPER_REGISTRY.entries()].filter(([, e]) => e.active).map(([k]) => k)
  const missed = active.filter((k) => !ran.has(k))
  const lines = [
    `${SCRAPER_REGISTRY.size} scrapers registered, ${active.length} active, ${ran.size} ran last night.`,
  ]
  if (missed.length === 0) return [...lines, 'Every active scraper ran.']
  lines.push(`${missed.length} active did not run:`)
  lines.push(missed.slice(0, 5).map((k) => esc(scraperLabel(k))).join(', '))
  return lines
}

// ══════════════════════════════════════════════════════════════════════════
// SITE BUSINESS
//
// Postgres-native only. Everything here is a COUNT or an aggregate. No handler
// in this section selects a column that identifies a person: not
// subscribers.email, not subscribers.token, not feedback_posts.email or
// .author_name or .body, not embed_requests.email or .name. ADR section 5.7.
// ══════════════════════════════════════════════════════════════════════════

async function subscriberCounts(ctx: HandlerContext): Promise<string[]> {
  const days = clampDays(ctx.params.days ?? 7)
  const cutoff = daysAgoIso(ctx.now, days)
  // COUNTS ONLY. `count` takes no column list at all, which is the strongest
  // possible form of "no row from this table is transferred".
  // "Confirmed" here means EXACTLY what send-digest means by it:
  // `confirmed = true AND unsubscribed_at IS NULL` (send-digest/index.ts:684-685
  // and 709-710). Reporting `confirmed = true` alone would drift above the
  // real recipient list the moment anyone unsubscribes, and a bot whose
  // subscriber count disagrees with the mailer's is worse than no count.
  const [total, confirmed, recent, unsubscribed] = await Promise.all([
    ctx.exec.count(countSpec('subscribers', [])),
    ctx.exec.count(countSpec('subscribers', [
      { op: 'is', column: 'confirmed', value: true },
      { op: 'is', column: 'unsubscribed_at', value: null },
    ])),
    ctx.exec.count(countSpec('subscribers', [{ op: 'gte', column: 'created_at', value: cutoff }])),
    ctx.exec.count(countSpec('subscribers', [{ op: 'not_is', column: 'unsubscribed_at', value: null }])),
  ])
  return [
    `${confirmed} confirmed subscribers (the digest's own definition), ${total} rows total.`,
    `+${recent} in the last ${days}d. ${unsubscribed} unsubscribed.`,
  ]
}

async function digestStatus(ctx: HandlerContext): Promise<string[]> {
  const days = clampDays(ctx.params.days ?? 2)
  const cutoff = daysAgoIso(ctx.now, days)
  const recent: Filter[] = [{ op: 'gte', column: 'sent_at', value: cutoff }]
  const [sent, failed, skipped, latest] = await Promise.all([
    ctx.exec.count(countSpec('email_sends', [...recent, { op: 'eq', column: 'status', value: 'sent' }])),
    ctx.exec.count(countSpec('email_sends', [...recent, { op: 'eq', column: 'status', value: 'failed' }])),
    ctx.exec.count(countSpec('email_sends', [...recent, { op: 'eq', column: 'status', value: 'skipped' }])),
    // `subscriber_id` and `error_message` are deliberately not read: the first
    // points at a person, the second can quote an address from a bounce.
    ctx.exec.select({
      table: 'email_sends',
      columns: ['sent_at', 'status'],
      filters: [],
      order: { column: 'sent_at', ascending: false },
      limit: 1,
    }),
  ])
  const todayEt = easternTodayIso(ctx.now)
  const last = latest.length > 0 ? etStamp(latest[0].sent_at, todayEt) : 'never'
  if (sent === 0 && failed === 0 && skipped === 0) {
    return [`No digest sends in the last ${days}d. Last send ever: ${esc(last)}.`]
  }
  const lines = [`${sent} digests sent in the last ${days}d. Last at ${esc(last)}.`]
  if (failed > 0 || skipped > 0) lines.push(`${failed} failed, ${skipped} skipped.`)
  return lines
}

async function feedbackRecent(ctx: HandlerContext): Promise<string[]> {
  const days = clampDays(ctx.params.days ?? 7)
  const cutoff = daysAgoIso(ctx.now, days)
  const recent: Filter[] = [{ op: 'gte', column: 'created_at', value: cutoff }]
  const [count, total, rows] = await Promise.all([
    ctx.exec.count(countSpec('feedback_posts', recent)),
    ctx.exec.count(countSpec('feedback_posts', [])),
    // `category` and `resolved_at` only. The post BODY, the author name, and
    // the email are all off limits: this answers "how much feedback", never
    // "what did someone say", because the channel is the wrong place to
    // relay a member of the public's words or address. `resolved_at` is a
    // timestamp, not PII.
    //
    // Resolution comes from `resolved_at`, NOT from `status`. Every row in
    // production has `status = 'published'`, which is a visibility flag, so a
    // `status !== 'resolved'` test would report the whole batch as open
    // forever. 19 of 26 rows currently have a null `resolved_at`.
    ctx.exec.select({
      table: 'feedback_posts',
      columns: ['category', 'resolved_at'],
      filters: recent,
      limit: 200,
    }),
  ])
  if (count === 0) return [`No feedback in the last ${days}d. ${total} all time.`]
  const byCategory = rankTally(tally(rows.map((r) => String(r.category ?? 'uncategorised'))))
  const open = rows.filter((r) => r.resolved_at === null || r.resolved_at === undefined).length
  return [
    `${plural(count, 'feedback post')} in the last ${days}d. ${total} all time.`,
    tallyLine(byCategory, 4),
    `${open} of the recent ones are unresolved. Read them in the admin, not here.`,
  ]
}

async function embedRequestsCount(ctx: HandlerContext): Promise<string[]> {
  const days = clampDays(ctx.params.days ?? 30)
  const cutoff = daysAgoIso(ctx.now, days)
  // Counts only: `embed_requests.email` and `.name` are Tier 1's business in
  // the private partner channel, not Tier 3's in a general channel.
  const [total, fresh, recent] = await Promise.all([
    ctx.exec.count(countSpec('embed_requests', [])),
    ctx.exec.count(countSpec('embed_requests', [{ op: 'eq', column: 'status', value: 'new' }])),
    ctx.exec.count(countSpec('embed_requests', [{ op: 'gte', column: 'created_at', value: cutoff }])),
  ])
  return [
    `${plural(total, 'embed request')} total, ${fresh} still marked new.`,
    `${recent} in the last ${days}d. Details are in #partner-embed-requests.`,
  ]
}

async function partnerOrgsCount(ctx: HandlerContext): Promise<string[]> {
  const [total, active, autoPublish] = await Promise.all([
    ctx.exec.count(countSpec('partner_orgs', [])),
    ctx.exec.count(countSpec('partner_orgs', [{ op: 'is', column: 'active', value: true }])),
    ctx.exec.count(countSpec('partner_orgs', [{ op: 'is', column: 'auto_publish', value: true }])),
  ])
  return [`${plural(total, 'partner org')}, ${active} active, ${autoPublish} on auto-publish.`]
}

async function reviewQueue(ctx: HandlerContext): Promise<string[]> {
  const nowIso = ctx.now.toISOString()
  const [flagged, upcoming, pending] = await Promise.all([
    ctx.exec.count(countSpec('events', [{ op: 'is', column: 'needs_review', value: true }])),
    ctx.exec.count(countSpec('events', [
      { op: 'is', column: 'needs_review', value: true },
      { op: 'gte', column: 'start_at', value: nowIso },
    ])),
    ctx.exec.count(countSpec('events', [{ op: 'eq', column: 'status', value: 'pending_review' }])),
  ])
  if (flagged === 0 && pending === 0) return ['Review queue is empty.']
  return [
    `${flagged} events flagged needs_review, ${upcoming} of them upcoming.`,
    `${pending} sitting in status pending_review.`,
  ]
}

// ══════════════════════════════════════════════════════════════════════════
// SITE TRAFFIC
//
// Reads the three tables from supabase/migrations/062_site_metrics.sql, which
// scripts/ga-to-db.js fills nightly from GA4. These are ORDINARY POSTGRES
// HANDLERS: same injected executor, same hardcoded column allowlists, same
// clamping, same escaping, same row caps as every handler above. No GA4
// credential exists inside this edge function and no handler here makes an
// outbound request. That separation is the whole design: the loader is a Node
// script on the maintainer's machine holding the service-account key, and the
// bot is a read-only consumer of a Postgres table.
//
// ══════════════════════════════════════════════════════════════════════════
// TWO THINGS EVERY HANDLER IN THIS SECTION IS BUILT AROUND
// ══════════════════════════════════════════════════════════════════════════
//
// 1. GA IS A FLOOR, NOT A COUNT. Ad blockers, tracking protection and DNS
//    blocklists drop the beacon; Byron's own browser network-blocks
//    google-analytics.com, so his own visits are not in the property at all.
//    Every figure here is a lower bound by an unknown, non-constant margin.
//    Nothing in this section may render a bare number: every GA-sourced
//    figure goes through `gaNum` (which prefixes `~`) and every reply ends
//    with `GA_FLOOR_NOTE`. See render.ts for why one character per figure
//    plus one line per reply beat the two alternatives.
//
// 2. USER COUNTS DO NOT ADD UP. `total_users` is GA4's distinct-user count
//    FOR THAT DAY. Summing seven days counts Tuesday's returning visitor
//    twice, so the sum is labelled `visitor-days`, never `visitors`, and a
//    per-day average is shown beside it. Views, sessions and event counts ARE
//    additive and are summed freely. The one place a true windowed distinct
//    count is needed -- the installed base -- is not derived here at all: GA4
//    computes it and the loader stores it in pwa_users_7d / pwa_users_28d.
// ══════════════════════════════════════════════════════════════════════════

/** 366 days plus headroom. One row per day, so this can never be a big read. */
const SITE_ROW_CAP = 400

/** A metrics window may not exceed a year. */
const MAX_METRICS_DAYS = 366

const SITE_COLUMNS = [
  'metric_date',
  'total_users',
  'page_views',
  'sessions',
  'outbound_clicks',
  'outbound_users',
  'pwa_launches',
  'pwa_install_accepted',
] as const

/**
 * A metrics window, in Eastern calendar dates, already clamped to what the
 * loader can possibly have written.
 */
interface MetricsRange {
  readonly startDate: string
  readonly endDate: string
  readonly days: number
  readonly label: string
}

/**
 * Re-derive and CLAMP the window for a traffic question (rule 4), with one
 * extra constraint no event handler has: the GA4 mirror can only contain days
 * that are over.
 *
 * `ga-to-db.js` never writes today, because today is a partial day that keeps
 * growing and ga-impact.js documents a same-day pull that was off by 3x and
 * pointed the wrong way. So the latest date that can exist is yesterday, and
 * a question about a window that runs past it is answered about the part that
 * is loaded, with the label saying so:
 *
 *   "traffic this week" on a Wednesday  -> "this week (Aug 24-30) so far"
 *   "traffic today"                     -> "yesterday (today not loaded yet)"
 *
 * Silently answering "today" with yesterday's number, or refusing outright,
 * are both worse: the first is a wrong answer and the second is a dead end
 * when a perfectly good answer is one day away.
 *
 * Note this deliberately does NOT reuse `requireWindow`. That helper falls
 * back to `upcomingWindow`, which looks FORWARD, and a forward window is
 * always empty in a table of past days.
 */
function metricsRange(ctx: HandlerContext, fallbackDays: number): MetricsRange {
  const latest = etDateAdd(easternTodayIso(ctx.now), -1)
  const fallback = clampDays(fallbackDays)

  let startDate = etDateAdd(latest, -(fallback - 1))
  let endDate = latest
  let label = `last ${fallback}d`

  const w = ctx.params.window
  if (w && isEtDate(w.startDateEt) && isEtDate(w.endDateEt)) {
    const span = etDaysBetween(w.startDateEt, w.endDateEt)
    if (span >= 0 && span <= MAX_METRICS_DAYS) {
      startDate = w.startDateEt
      endDate = w.endDateEt
      label = w.label
    }
  }

  if (endDate > latest) {
    endDate = latest
    label = `${label} so far`
  }
  if (startDate > endDate) {
    // The whole window is today or later: nothing is loaded for any of it.
    startDate = latest
    endDate = latest
    label = 'yesterday (today not loaded yet)'
  }
  if (etDaysBetween(startDate, endDate) > MAX_METRICS_DAYS) {
    startDate = etDateAdd(endDate, -MAX_METRICS_DAYS)
  }

  return { startDate, endDate, days: etDaysBetween(startDate, endDate) + 1, label }
}

function isEtDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** The equal-length window immediately before, for a like-for-like comparison. */
function priorMetricsRange(r: MetricsRange): MetricsRange {
  const endDate = etDateAdd(r.startDate, -1)
  const startDate = etDateAdd(endDate, -(r.days - 1))
  return { startDate, endDate, days: r.days, label: `prior ${r.days}d` }
}

/**
 * Inclusive on both ends, unlike `windowFilters`. These columns are `date`,
 * not `timestamptz`, so there is no midnight boundary to be half-open about
 * and `lte` reads as what it means.
 */
function dateRangeFilters(r: MetricsRange): Filter[] {
  return [
    { op: 'gte', column: 'metric_date', value: r.startDate },
    { op: 'lte', column: 'metric_date', value: r.endDate },
  ]
}

function sumOf(rows: readonly Row[], key: string): number {
  let total = 0
  for (const row of rows) {
    const n = Number(row[key])
    if (Number.isFinite(n)) total += n
  }
  return total
}

function siteSpec(r: MetricsRange): SelectSpec {
  return {
    table: 'site_metrics_daily',
    columns: [...SITE_COLUMNS],
    filters: dateRangeFilters(r),
    order: { column: 'metric_date', ascending: true },
    limit: SITE_ROW_CAP,
  }
}

/** "no rows" and "the loader has not run" are the same reply, on purpose. */
function noDataLines(label: string): string[] {
  return [
    `No GA data stored for ${esc(label)}.`,
    'The loader writes each day the morning after: scripts/ga-to-db.js.',
  ]
}

/**
 * The readable label for a page row: the URL slug for an event detail page,
 * the path for anything else. Both third-party strings.
 *
 * `url_slug` is a LABEL, NOT A KEY. An event URL is /events/{url-slug}/{uuid}
 * and that url-slug is date-suffixed ("ales-on-rails-aug-21") while
 * `events.slug` is year-suffixed ("ales-on-rails-2026"), so they do not join
 * (062's header records the production check). The real key is
 * `page_metrics_daily.event_id`, which this function deliberately does not
 * read: nothing in a reply needs it, and redact.ts withholds any message
 * carrying a uuid, so the safest place for that column is out of the
 * allowlist entirely.
 *
 * Any uuid segment in the path is replaced with `/{id}` first, and that is NOT
 * cosmetic: redact.ts withholds the ENTIRE reply on any uuid it sees ("no
 * handler renders a uuid"), so one `/organizations/4d890091-...` row in a
 * top-pages list would cost the whole answer rather than just that line. The
 * paths that carry one are /organizations/{id} and /venues/{id}; event detail
 * pages never reach that branch because their slug is preferred.
 *
 * Consequence, and it is intended: every organisation detail page collapses
 * into one `/organizations/{id}` tally row, so that row is the family total
 * rather than a single page. Those pages draw one to three views each and have
 * never come close to a top-four slot; a combined row is both more useful and
 * more likely to be true than an arbitrary representative.
 */
function pageLabel(row: Row): string {
  const slug = row.url_slug
  const raw = typeof slug === 'string' && slug.length > 0
    ? slug
    : (typeof row.page_path === 'string' && row.page_path.length > 0 ? row.page_path : null)
  if (raw === null) return '(unknown page)'
  // SCRUBBED ON EVERY PATH OUT, not just the fallback. url_slug comes from a
  // greedy capture in the loader, so a malformed
  // /events/x/{uuid}/{uuid} path can put a uuid inside the SLUG as easily as
  // inside the page path, and redact.ts does not care which column it came
  // from: either one withholds the whole reply. Scrubbing one branch and not
  // the other is the bug this function exists to prevent, wearing a disguise.
  //
  // Declared inline rather than at module scope: a `g` regex carries mutable
  // lastIndex, and redact.ts's header explains why a shared one is a bug
  // waiting to happen.
  return raw.replace(/\/?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '/{id}')
}

async function trafficOverview(ctx: HandlerContext): Promise<string[]> {
  const r = metricsRange(ctx, 7)
  const prior = priorMetricsRange(r)
  const [now, before] = await Promise.all([
    ctx.exec.select(siteSpec(r)),
    ctx.exec.select(siteSpec(prior)),
  ])
  if (now.length === 0) return noDataLines(r.label)

  const views = sumOf(now, 'page_views')
  const sessions = sumOf(now, 'sessions')
  // SUM OF DAILY DISTINCTS. Not "visitors": a person who came Monday and
  // Thursday is two of these. The per-day average beside it is the figure
  // that is actually comparable between windows of different lengths.
  const visitorDays = sumOf(now, 'total_users')
  const perDay = Math.round(visitorDays / Math.max(1, now.length))

  const headline = r.days === 1
    ? `Traffic ${esc(r.label)}: ${gaNum(views)} views, ${gaNum(visitorDays)} visitors, ${gaNum(sessions)} sessions.`
    : `Traffic ${esc(r.label)}: ${gaNum(views)} views, ${gaNum(visitorDays)} visitor-days (${gaNum(perDay)}/day).`

  const lines = [headline]

  if (before.length > 0) {
    const priorViews = sumOf(before, 'page_views')
    const delta = deltaPhrase(views, priorViews)
    lines.push(`Prior ${prior.days}d: ${gaNum(priorViews)} views${delta ? `, ${delta}` : ''}.`)
  }
  if (now.length < r.days) {
    // A gap is a fact about the loader, not about the traffic, and hiding it
    // would make a half-loaded week look like a quiet one.
    lines.push(`${now.length} of ${r.days} days have data stored.`)
  }
  lines.push(GA_FLOOR_NOTE)
  return lines
}

async function trafficTrend(ctx: HandlerContext): Promise<string[]> {
  const r = metricsRange(ctx, 7)
  const prior = priorMetricsRange(r)
  const [now, before] = await Promise.all([
    ctx.exec.select(siteSpec(r)),
    ctx.exec.select(siteSpec(prior)),
  ])
  if (now.length === 0) return noDataLines(r.label)
  if (before.length === 0) {
    return [
      `${gaNum(sumOf(now, 'page_views'))} views ${esc(r.label)}. Nothing stored for the ${prior.days}d before it, so there is nothing to compare against.`,
      GA_FLOOR_NOTE,
    ]
  }

  const pairs: [string, number, number][] = [
    ['views', sumOf(now, 'page_views'), sumOf(before, 'page_views')],
    ['visitor-days', sumOf(now, 'total_users'), sumOf(before, 'total_users')],
    ['sessions', sumOf(now, 'sessions'), sumOf(before, 'sessions')],
  ]
  const line = (name: string, a: number, b: number) => {
    const delta = deltaPhrase(a, b)
    return `${name} ${gaNum(a)} vs ${gaNum(b)}${delta ? `, ${delta}` : ''}`
  }
  return [
    `${esc(r.label)} vs the ${prior.days}d before:`,
    `${line(...pairs[0])}.`,
    `${line(...pairs[1])}. ${line(...pairs[2])}.`,
    GA_FLOOR_NOTE,
  ]
}

async function topPages(ctx: HandlerContext): Promise<string[]> {
  const r = metricsRange(ctx, 7)
  // One row per (day, page), so a multi-day window needs a tally in
  // TypeScript exactly like events_by_source does. Ordering by page_views
  // descending means the cap, when it bites, drops the least-viewed rows
  // first, which is the right bias for a top-N question.
  const rows = await ctx.exec.select({
    table: 'page_metrics_daily',
    columns: ['page_path', 'url_slug', 'page_views'],
    filters: dateRangeFilters(r),
    order: { column: 'page_views', ascending: false },
    limit: AGG_ROW_CAP,
  })
  if (rows.length === 0) return noDataLines(r.label)

  const totals = new Map<string, number>()
  for (const row of rows) {
    const key = pageLabel(row)
    const n = Number(row.page_views)
    totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(n) ? n : 0))
  }
  const ranked = rankTally(totals)
  const views = sumOf(rows, 'page_views')
  return [
    `Top pages ${esc(r.label)}, ${gaNum(views)} views over ${gaNum(ranked.length)} ${ranked.length === 1 ? 'page' : 'pages'}${capNote(rows.length)}:`,
    ...ranked.slice(0, 4).map(([label, n]) => `${shortEscaped(label, 44)} ${gaNum(n)}`),
    GA_FLOOR_NOTE,
  ]
}

async function outboundClicks(ctx: HandlerContext): Promise<string[]> {
  const r = metricsRange(ctx, 7)
  const [site, pages] = await Promise.all([
    ctx.exec.select(siteSpec(r)),
    ctx.exec.select({
      table: 'page_metrics_daily',
      columns: ['page_path', 'url_slug', 'outbound_clicks', 'outbound_tickets', 'outbound_source'],
      // `gt 0` rather than fetching every page and filtering here: on a
      // typical day fewer than one page in ten has a click, and the partial
      // index in 062 is built for exactly this predicate.
      filters: [...dateRangeFilters(r), { op: 'gt', column: 'outbound_clicks', value: 0 }],
      order: { column: 'outbound_clicks', ascending: false },
      limit: AGG_ROW_CAP,
    }),
  ])

  // The site-wide total is the authoritative one: it comes from an
  // un-truncated daily report, whereas the per-page rows are subject to the
  // loader's per-day page cap. They should agree, and when they do not the
  // bigger one is right.
  const total = sumOf(site, 'outbound_clicks')
  if (total === 0 && pages.length === 0) {
    return site.length === 0
      ? noDataLines(r.label)
      : [`No outbound clicks recorded ${esc(r.label)}.`, GA_FLOOR_NOTE]
  }

  const tickets = sumOf(pages, 'outbound_tickets')
  const source = sumOf(pages, 'outbound_source')
  const totals = new Map<string, number>()
  for (const row of pages) {
    const key = pageLabel(row)
    const n = Number(row.outbound_clicks)
    totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(n) ? n : 0))
  }
  const ranked = rankTally(totals)

  const lines = [`${gaNum(total)} outbound clicks ${esc(r.label)} from ${gaNum(ranked.length)} ${ranked.length === 1 ? 'page' : 'pages'}.`]
  // The tickets/source split comes from the `link_type` custom dimension and
  // is 0 when that dimension is not registered in GA4 Admin. Reporting
  // "0 to ticket links" in that case would be a false statement about the
  // clicks rather than about the dimension, so the line is simply omitted.
  if (tickets + source > 0) {
    // The split is only ever as complete as the pages it was summed from, and
    // those can fall short of the site-wide total two ways: a page trimmed by
    // the loader's per-day cap, or a click whose `link_type` was not recorded.
    // When it falls short the line names its own base rather than implying
    // the remainder went nowhere.
    const typed = tickets + source
    lines.push(typed >= total
      ? `${gaNum(tickets)} to ticket links, ${gaNum(source)} to the source site.`
      : `Of the ${gaNum(typed)} with a link type recorded: ${gaNum(tickets)} tickets, ${gaNum(source)} source.`)
  }
  for (const [label, n] of ranked.slice(0, 3)) lines.push(`${shortEscaped(label, 44)} ${gaNum(n)}`)
  lines.push(GA_FLOOR_NOTE)
  return lines
}

async function embedTraffic(ctx: HandlerContext): Promise<string[]> {
  const r = metricsRange(ctx, 7)
  const rows = await ctx.exec.select({
    table: 'embed_metrics_daily',
    columns: ['embed_host', 'page_views', 'users'],
    filters: dateRangeFilters(r),
    order: { column: 'page_views', ascending: false },
    limit: AGG_ROW_CAP,
  })
  if (rows.length === 0) {
    // Two causes, one reply, because the bot cannot tell them apart and
    // guessing would be worse than naming both. 062's header says the same:
    // an empty embed table is a valid state, not a failure.
    return [
      `No embed traffic recorded ${esc(r.label)}.`,
      'Either nobody loaded an embed, or the embed_host dimension is still unregistered in GA4 Admin.',
    ]
  }
  const totals = new Map<string, number>()
  for (const row of rows) {
    const host = typeof row.embed_host === 'string' && row.embed_host ? row.embed_host : '(unknown)'
    const n = Number(row.page_views)
    totals.set(host, (totals.get(host) ?? 0) + (Number.isFinite(n) ? n : 0))
  }
  const ranked = rankTally(totals)
  const views = sumOf(rows, 'page_views')
  return [
    `Embed views ${esc(r.label)}: ${gaNum(views)} across ${gaNum(ranked.length)} partner site${ranked.length === 1 ? '' : 's'}.`,
    ...ranked.slice(0, 3).map(([host, n]) => `${shortEscaped(host, 40)} ${gaNum(n)}`),
    GA_FLOOR_NOTE,
  ]
}

/**
 * PWA installs, and the reason this handler refuses to answer the question as
 * asked.
 *
 * THERE IS NO TRUE INSTALL COUNT, and no amount of querying produces one:
 *   * an uninstall fires no event at all, so any running total only ever goes
 *     up and drifts further from reality every week;
 *   * iOS "Add to Home Screen" fires NOTHING -- no beforeinstallprompt, no
 *     appinstalled -- so the entire iPhone install base is invisible to the
 *     one event that does exist;
 *   * `pwa_install_accepted` therefore counts Android/desktop prompt
 *     acceptances, which is a real number about a real thing but is not
 *     "installs" and must never be labelled as such.
 *
 * The only defensible signal, and the one ga-install-snapshot.js already
 * settled on, is DISTINCT USERS who fired `pwa_standalone_launch` over a
 * trailing window: people who opened the installed app recently. That is a
 * floor on the actively-installed base, which is both honest and the more
 * useful quantity anyway -- an install that was never opened again is not
 * something anyone wants counted.
 *
 * The figure is read from `pwa_users_28d` / `pwa_users_7d`, which the loader
 * asks GA4 for directly. It is NOT derived by summing `pwa_launch_users`:
 * distinct-user counts do not add, and the sum would exceed the truth by
 * however loyal the users are. Those columns are nullable and NULL means "not
 * computed for this date", which is not zero, so the query asks for the most
 * recent non-null row rather than the most recent row.
 */
async function pwaInstalls(ctx: HandlerContext): Promise<string[]> {
  const r = metricsRange(ctx, 7)
  const [snapshot, window] = await Promise.all([
    ctx.exec.select({
      table: 'site_metrics_daily',
      columns: ['metric_date', 'pwa_users_7d', 'pwa_users_28d'],
      filters: [
        { op: 'lte', column: 'metric_date', value: r.endDate },
        { op: 'not_is', column: 'pwa_users_28d', value: null },
      ],
      order: { column: 'metric_date', ascending: false },
      limit: 1,
    }),
    ctx.exec.select(siteSpec(r)),
  ])

  const launches = sumOf(window, 'pwa_launches')
  const accepted = sumOf(window, 'pwa_install_accepted')

  if (snapshot.length === 0) {
    // Never fall back to summing pwa_launch_users to fill the gap: that sum
    // is not a distinct count and would be a bigger, wronger number.
    return [
      'No installed-app snapshot stored yet, and I will not fake one from daily counts.',
      `Over ${esc(r.label)}: ${gaNum(launches)} app launches, ${gaNum(accepted)} Android/desktop install prompt${accepted === 1 ? '' : 's'} accepted.`,
      'Run scripts/ga-to-db.js to write the 7d/28d distinct-user snapshot.',
      GA_FLOOR_NOTE,
    ]
  }

  const row = snapshot[0]
  const d28 = Number(row.pwa_users_28d)
  const d7 = Number(row.pwa_users_7d)
  const asOf = isEtDate(row.metric_date) ? row.metric_date : r.endDate

  const lines = [
    `${gaNum(d28)} people opened the installed app in the 28d to ${esc(asOf)}${
      Number.isFinite(d7) ? `, ${gaNum(d7)} in the last 7d` : ''
    }.`,
    'That is a floor on active installs, not an install count: uninstalls fire no event and iOS Add to Home Screen fires none at all.',
    `Over ${esc(r.label)}: ${gaNum(launches)} launches, ${gaNum(accepted)} Android/desktop install prompt${accepted === 1 ? '' : 's'} accepted (iOS never fires that).`,
    GA_FLOOR_NOTE,
  ]
  return lines
}

// ══════════════════════════════════════════════════════════════════════════
// THE COMBINED STATUS ANSWER
// ══════════════════════════════════════════════════════════════════════════

/**
 * "What's broken?", the handler most likely to be used, so it gets the most
 * care.
 *
 * It gathers six independent facts in parallel, scores each by how much it
 * should worry a reader, and renders only the worst three. Scoring rather than
 * a fixed order matters: a night where nothing scraped at all must outrank a
 * review backlog, and on a good day neither should appear.
 *
 * All six probes are counts or a single capped select, issued concurrently, so
 * the whole handler is one round-trip's worth of latency.
 */
async function statusSummary(ctx: HandlerContext): Promise<string[]> {
  const { startUtc, endUtc } = lastNightWindow(ctx.now)
  const digestCutoff = daysAgoIso(ctx.now, 3)

  // ONE select over scraper_health rather than three counts. A `count` cannot
  // be filtered through the manifest registry, so counting the view directly
  // would include the four names in it that are not scrapers (see
  // splitByRegistry) and report a `dedupe_cross_source` failure as a scraper
  // failure in the bot's most-used answer. One 160-row read is also cheaper
  // than three round trips.
  const [health, runs, digestFailed, flagged] = await Promise.all([
    ctx.exec.select({
      table: 'scraper_health',
      columns: [...HEALTH_COLUMNS],
      filters: [],
      limit: HEALTH_ROW_CAP,
    }),
    ctx.exec.select({
      table: 'scraper_runs',
      columns: ['status', 'events_found'],
      filters: [
        { op: 'gte', column: 'ran_at', value: startUtc },
        { op: 'lt', column: 'ran_at', value: endUtc },
      ],
      limit: 500,
    }),
    ctx.exec.count(countSpec('email_sends', [
      { op: 'gte', column: 'sent_at', value: digestCutoff },
      { op: 'eq', column: 'status', value: 'failed' },
    ])),
    ctx.exec.count(countSpec('events', [{ op: 'is', column: 'needs_review', value: true }])),
  ])

  const { known } = splitByRegistry(health)
  const erroring = known.filter((r) => r.is_error === true).length
  const stale = known.filter((r) => r.is_stale === true).length
  const zeroStreak = known.filter((r) => r.is_zero_streak === true).length

  const found = runs.reduce((s, r) => s + (Number.isFinite(Number(r.events_found)) ? Number(r.events_found) : 0), 0)
  const failedRuns = runs.filter((r) => r.status === 'error').length

  // severity: higher is more alarming. The scale is deliberately coarse.
  const facts: { severity: number; line: string }[] = []
  if (runs.length === 0) {
    facts.push({ severity: 6, line: 'No scraper runs at all last night. Check the workflow.' })
  }
  if (erroring > 0) facts.push({ severity: 5, line: `${plural(erroring, 'scraper')} erroring.` })
  if (digestFailed > 0) facts.push({ severity: 4, line: `${digestFailed} digest sends failed in the last 3d.` })
  if (stale > 0) facts.push({ severity: 3, line: `${plural(stale, 'scraper')} stale, no run in 26h+.` })
  if (zeroStreak > 0) facts.push({ severity: 2, line: `${plural(zeroStreak, 'scraper')} on a zero-event streak.` })
  if (flagged > 25) facts.push({ severity: 1, line: `${flagged} events waiting on review.` })
  // NO registry-drift fact here, deliberately. scraper_health permanently
  // carries four names the manifest does not have (dedupe_cross_source,
  // uakron_chp, uakron_myers_art, ejthomas_hall), so a `> 0` test fires every
  // single time and this handler could never say "All clear." A standing
  // condition nobody will action is noise, and noise in the most-used answer
  // is how people stop reading it. scraper_health_summary reports the drift,
  // which is where anyone asking about scrapers will see it.

  const nightLine = runs.length === 0
    ? 'Nothing ran last night.'
    : `Last night: ${plural(runs.length, 'run')}, ${failedRuns} failed, ${found} events found.`

  if (facts.length === 0) return ['All clear.', nightLine]

  facts.sort((a, b) => b.severity - a.severity)
  return [
    `${facts.length} thing${facts.length === 1 ? '' : 's'} to look at.`,
    ...facts.slice(0, 3).map((f) => f.line),
    nightLine,
  ]
}

// ══════════════════════════════════════════════════════════════════════════
// TERMINAL HANDLERS (no database)
// ══════════════════════════════════════════════════════════════════════════

/**
 * The honest answer about the analytics that are STILL not available.
 *
 * SHRUNK, NOT DELETED (and it must stay). Migration 062 and
 * scripts/ga-to-db.js mirror six GA4 reports into Postgres, so views,
 * visitors, sessions, top pages, outbound clicks, embed reach and the
 * installed base are now real handlers above. What the mirror does NOT carry
 * is everything else GA4 knows:
 *
 *   * acquisition: referrers, channels, UTM campaigns, "where do people come
 *     from" -- the loader stores no source or medium dimension at all;
 *   * engagement quality: bounce rate, conversion rate, average session
 *     duration, time on page, engagement rate;
 *   * audience shape: device category, browser, city, region, country;
 *   * search: impressions and clickthrough rate, which are Search Console
 *     rather than GA4 and are not connected to anything;
 *   * anything about TODAY in real time. The loader never writes a partial
 *     day (ga-impact.js documents a same-day pull that was off by 3x and
 *     pointed the wrong way), so the freshest possible answer is yesterday.
 *
 * Without this handler those phrasings fall through to `events_in_window`,
 * which would answer "what's our bounce rate this week" with an event count
 * and a straight face. That failure is the reason it exists and it has not
 * gone away; only its scope has. It still never invents a figure and never
 * calls GA4.
 */
function analyticsUnavailable(): Promise<string[]> {
  return Promise.resolve([
    'Traffic, top pages, outbound clicks, embeds and installs are answerable. That one is not.',
    'Not stored: referrers and channels, devices, cities, bounce and conversion rates, session duration, search impressions.',
    'Nothing for today either: GA data lands the morning after, so yesterday is the freshest answer.',
  ])
}

/**
 * The fallback. ADR section 3: never a dead end.
 *
 * It teaches the phrasing rather than saying no, and it is grouped so a reader
 * can find the family they wanted. The menu is a curated constant rather than
 * a dump of every handler's examples, because 26 handlers do not fit in six
 * lines and an auto-generated menu would be truncated to uselessness.
 * render.test.ts asserts it fits the caps.
 */
export const MENU_LINES: readonly string[] = Object.freeze([
  'Not one I know. Try:',
  'events tonight / this weekend / by source / by category / top venues',
  'traffic last week / top pages / outbound clicks / embed traffic / installs',
  'scrapers? / whats failing / stale scrapers / last night / eventbrite last run',
  'subscribers / digest / feedback / embed requests / review queue / status',
])

function noMatch(): Promise<string[]> {
  return Promise.resolve([...MENU_LINES])
}

// ══════════════════════════════════════════════════════════════════════════
// THE REGISTRY
// ══════════════════════════════════════════════════════════════════════════

/**
 * Frozen, exhaustively typed, server-side. `Record<HandlerId, HandlerDef>`
 * means TypeScript fails the build if a HandlerId is added to the union
 * without an implementation here, which is the property that makes the closed
 * set actually closed.
 */
export const HANDLERS: Readonly<Record<HandlerId, HandlerDef>> = Object.freeze({
  events_in_window: {
    id: 'events_in_window',
    family: 'events',
    menuLabel: 'event count in a window',
    examples: ['events tonight', 'how many events this weekend', 'events next 14 days', 'events in september'],
    needsDb: true,
    run: eventsInWindow,
  },
  events_by_source: {
    id: 'events_by_source',
    family: 'events',
    menuLabel: 'events by source',
    examples: ['events by source', 'top sources this week', 'which sources this weekend'],
    needsDb: true,
    run: eventsBySource,
  },
  events_by_category: {
    id: 'events_by_category',
    family: 'events',
    menuLabel: 'events by category',
    examples: ['events by category', 'top categories this month', 'category breakdown'],
    needsDb: true,
    run: eventsByCategory,
  },
  events_by_neighborhood: {
    id: 'events_by_neighborhood',
    family: 'events',
    menuLabel: 'events by neighbourhood',
    examples: ['events by neighborhood', 'by neighbourhood this weekend', 'top areas next 30 days'],
    needsDb: true,
    run: eventsByNeighborhood,
  },
  events_added_recently: {
    id: 'events_added_recently',
    family: 'events',
    menuLabel: 'events added recently',
    examples: ['anything new', 'events added in the last 24 hours', 'whats new today', 'new events last 3 days'],
    needsDb: true,
    run: eventsAddedRecently,
  },
  top_venues: {
    id: 'top_venues',
    family: 'events',
    menuLabel: 'busiest venues',
    examples: ['top venues', 'busiest venues this month', 'which venues have the most events', 'most popular venues'],
    needsDb: true,
    run: topVenues,
  },
  top_organizations: {
    id: 'top_organizations',
    family: 'events',
    menuLabel: 'busiest organisations',
    examples: ['top orgs', 'top organizations this week', 'busiest organisers', 'top partner organizations'],
    needsDb: true,
    run: topOrganizations,
  },
  events_missing_image: {
    id: 'events_missing_image',
    family: 'events',
    menuLabel: 'events with no image',
    examples: ['events missing images', 'how many events without a photo', 'no artwork this month'],
    needsDb: true,
    run: eventsMissingImage,
  },
  events_at_venue: {
    id: 'events_at_venue',
    family: 'events',
    menuLabel: 'what is on at a venue',
    examples: ['whats on at the rialto', 'events at musica this weekend', 'shows at blu jazz'],
    needsDb: true,
    run: eventsAtVenue,
  },
  free_vs_paid: {
    id: 'free_vs_paid',
    family: 'events',
    menuLabel: 'free versus paid split',
    examples: ['free vs paid', 'how many free events this weekend', 'price split this month'],
    needsDb: true,
    run: freeVsPaid,
  },
  featured_events: {
    id: 'featured_events',
    family: 'events',
    menuLabel: 'featured events',
    // Only vocabulary that names the FLAG. See the featured-events rule in
    // intent.ts for why "big events" and "highlights" are not here.
    examples: ['featured events', 'whats the marquee stuff', 'spotlight'],
    needsDb: true,
    run: featuredEvents,
  },
  scraper_health_summary: {
    id: 'scraper_health_summary',
    family: 'ops',
    menuLabel: 'scraper health',
    examples: ['scrapers?', 'hows the scrape', 'scraper health', 'how are the feeds'],
    needsDb: true,
    run: scraperHealthSummary,
  },
  scrapers_failing: {
    id: 'scrapers_failing',
    family: 'ops',
    menuLabel: 'failing scrapers',
    examples: ['which scrapers are failing', 'any scraper errors', 'broken scrapers'],
    needsDb: true,
    run: scrapersFailing,
  },
  scrapers_zero_events: {
    id: 'scrapers_zero_events',
    family: 'ops',
    menuLabel: 'scrapers returning nothing',
    examples: ['which scrapers returned zero', 'scrapers with no events', 'empty scrapers'],
    needsDb: true,
    run: scrapersZeroEvents,
  },
  scrapers_stale: {
    id: 'scrapers_stale',
    family: 'ops',
    menuLabel: 'stale scrapers',
    examples: ['stale scrapers', 'scrapers that havent run in 3 days', 'which feeds have gone quiet'],
    needsDb: true,
    run: scrapersStale,
  },
  scraper_last_run: {
    id: 'scraper_last_run',
    family: 'ops',
    menuLabel: 'one scraper by name',
    examples: ['when did eventbrite last run', 'akron library scraper status', 'hows summit artspace doing'],
    needsDb: true,
    run: scraperLastRun,
  },
  last_night_totals: {
    id: 'last_night_totals',
    family: 'ops',
    menuLabel: 'last night across all scrapers',
    examples: ['last night', 'how did last night go', 'overnight totals'],
    needsDb: true,
    run: lastNightTotals,
  },
  scraper_registry_coverage: {
    id: 'scraper_registry_coverage',
    family: 'ops',
    menuLabel: 'registry size versus what ran',
    examples: ['how many scrapers are there', 'total scrapers', 'how many sources do we have'],
    needsDb: true,
    run: scraperRegistryCoverage,
  },
  subscriber_counts: {
    id: 'subscriber_counts',
    family: 'business',
    menuLabel: 'subscriber counts',
    examples: ['subscribers', 'how many subscribers', 'signups in the last 30 days'],
    needsDb: true,
    run: subscriberCounts,
  },
  digest_status: {
    id: 'digest_status',
    family: 'business',
    menuLabel: 'digest send status',
    examples: ['did the digest go out', 'digest status', 'newsletter sent'],
    needsDb: true,
    run: digestStatus,
  },
  feedback_recent: {
    id: 'feedback_recent',
    family: 'business',
    menuLabel: 'recent feedback volume',
    examples: ['any feedback', 'feedback last 14 days', 'how much feedback'],
    needsDb: true,
    run: feedbackRecent,
  },
  embed_requests_count: {
    id: 'embed_requests_count',
    family: 'business',
    menuLabel: 'embed requests',
    examples: ['embed requests', 'how many embeds', 'widget requests'],
    needsDb: true,
    run: embedRequestsCount,
  },
  partner_orgs_count: {
    id: 'partner_orgs_count',
    family: 'business',
    menuLabel: 'partner orgs',
    examples: ['how many partners', 'partner orgs'],
    needsDb: true,
    run: partnerOrgsCount,
  },
  review_queue: {
    id: 'review_queue',
    family: 'business',
    menuLabel: 'review queue depth',
    examples: ['review queue', 'how many events need review', 'moderation queue'],
    needsDb: true,
    run: reviewQueue,
  },
  traffic_overview: {
    id: 'traffic_overview',
    family: 'traffic',
    menuLabel: 'site traffic in a window',
    examples: ['how much traffic last week', 'how many people visited', 'page views this month', 'visitors yesterday'],
    needsDb: true,
    run: trafficOverview,
  },
  traffic_trend: {
    id: 'traffic_trend',
    family: 'traffic',
    menuLabel: 'traffic versus the prior period',
    examples: ['traffic vs last week', 'is traffic up or down', 'traffic trend this month', 'is traffic growing'],
    needsDb: true,
    run: trafficTrend,
  },
  top_pages: {
    id: 'top_pages',
    family: 'traffic',
    menuLabel: 'most-viewed pages',
    examples: ['top pages', 'most viewed pages last week', 'which events got the most views'],
    needsDb: true,
    run: topPages,
  },
  outbound_clicks: {
    id: 'outbound_clicks',
    family: 'traffic',
    menuLabel: 'outbound clicks to tickets and sources',
    examples: ['outbound clicks', 'how many clickthroughs last week', 'which events sent people to tickets'],
    needsDb: true,
    run: outboundClicks,
  },
  embed_traffic: {
    id: 'embed_traffic',
    family: 'traffic',
    menuLabel: 'traffic through partner embeds',
    examples: ['embed traffic', 'how many embed views last week', 'which sites embed us'],
    needsDb: true,
    run: embedTraffic,
  },
  pwa_installs: {
    id: 'pwa_installs',
    family: 'traffic',
    menuLabel: 'installed app usage (a floor, not a count)',
    examples: ['how many installs', 'pwa installs', 'is anyone using the app', 'app downloads'],
    needsDb: true,
    run: pwaInstalls,
  },
  status_summary: {
    id: 'status_summary',
    family: 'ops',
    menuLabel: 'what is broken right now',
    examples: ['status', 'whats broken', 'anything wrong', 'all good'],
    needsDb: true,
    run: statusSummary,
  },
  analytics_unavailable: {
    id: 'analytics_unavailable',
    family: 'meta',
    menuLabel: 'the analytics still not stored',
    examples: ['what are our referrers', 'bounce rate this week', 'mobile vs desktop visitors', 'conversion rate', 'traffic right now'],
    needsDb: false,
    run: analyticsUnavailable,
  },
  no_match: {
    id: 'no_match',
    family: 'meta',
    menuLabel: 'the menu',
    examples: [],
    needsDb: false,
    run: noMatch,
  },
})

/**
 * Explicit lookup with a throw, deliberately NOT a soft fallback.
 *
 * Same distinction slack-notify/request.ts draws between `planFor` (throws on
 * an unmapped kind) and `resolveAgentIdentity` (falls back to a default
 * avatar): a typo'd persona costing the default avatar is fine, a typo'd
 * handler running a DIFFERENT QUERY is not. An unknown id is a bug in the
 * caller and must surface as one.
 */
export function getHandler(id: HandlerId): HandlerDef {
  const handler = Object.hasOwn(HANDLERS, id) ? HANDLERS[id] : undefined
  if (!handler) throw new Error(`getHandler: no handler registered for id "${id}"`)
  return handler
}

/** Every handler id, for tests and for a caller that wants to log the roster. */
export const HANDLER_IDS: readonly HandlerId[] = Object.freeze(Object.keys(HANDLERS) as HandlerId[])
