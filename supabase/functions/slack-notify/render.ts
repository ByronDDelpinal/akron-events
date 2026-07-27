/**
 * render.ts — pure renderers for the three Tier 1 Slack notifications.
 *
 * No Deno globals, no fetch, no Supabase client — everything here is a plain
 * function of its arguments so it can be unit-tested directly (render.test.ts)
 * without a live database or a Slack workspace. The one piece of "I/O" the
 * signup renderer needs — resolving org_ids/venue_ids to names — is done by
 * the caller (slack-notify/index.ts) and handed in as a ResolvedNames map;
 * this file never queries anything itself.
 *
 * Plain text with Slack mrkdwn, not Block Kit: partner channels stay simple,
 * and plain text is what actually shows in mobile push notifications.
 */

import { escapeSlackText, INTENT_LABELS, CATEGORY_LABELS, AGE_LABEL } from '../_shared/slack.ts'

// ── Shapes ──────────────────────────────────────────────────────────────

/**
 * Subscriber `preferences` JSONB shape (see supabase/migrations/009_subscribers.sql
 * and subscribe/index.ts:109-120 for the default object). Every field is
 * optional here because JSONB defaults can drift and this renderer must
 * never throw on a shape it doesn't fully recognize.
 */
export interface Preferences {
  intents?: string[]
  categories?: string[]
  venue_ids?: string[]
  org_ids?: string[]
  price_max?: number | null
  age_restriction?: string | null
  event_days?: number[]
  location?: {
    mode?: 'area' | 'zipcode'
    lat?: number
    lng?: number
    radius_miles?: number
    label?: string
  } | null
  keywords?: string[]
  keywords_title_only?: boolean
}

/** id -> name lookup for org_ids/venue_ids, built by a batched query in index.ts. */
export interface ResolvedNames {
  orgNames: Map<string, string>
  venueNames: Map<string, string>
}

const EMPTY_RESOLVED: ResolvedNames = { orgNames: new Map(), venueNames: new Map() }

export interface FeedbackRow {
  body: string
  page_path: string | null
  created_at: string
}

export interface SignupSubscriber {
  email: string
  frequency: string
  lookahead_days: number
  preferences: Preferences
}

// ── Small pure helpers ─────────────────────────────────────────────────

/**
 * frequency column -> the noun used in "every {noun}".
 *
 * The default branch is unreachable today — subscribers.frequency has a DB
 * CHECK constraint limiting it to daily/weekly/monthly (see subscribe/index.ts's
 * own allowlist) — but this function's input type is just `string`, and nothing
 * stops a future migration from loosening that constraint. escapeSlackText the
 * fallback so this sink is closed even if the DB-side guarantee is ever dropped.
 */
export function frequencyNoun(frequency: string): string {
  switch (frequency) {
    case 'daily':   return 'day'
    case 'weekly':  return 'week'
    case 'monthly': return 'month'
    default:        return escapeSlackText(frequency)
  }
}

/** lookahead_days column -> "N day(s) of events". Only 1/7/30 occur in practice. */
export function lookaheadPhrase(lookaheadDays: number): string {
  return `${lookaheadDays} day${lookaheadDays === 1 ? '' : 's'} of events`
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

function isAllDays(days: number[]): boolean {
  return days.length === 7 && ALL_DAYS.every((d) => days.includes(d))
}

/**
 * `preferences` is untyped JSONB at rest — the `Preferences` interface above
 * is a TypeScript-side promise the database does not enforce. `009_subscribers.sql`
 * grants anon INSERT on `subscribers` with `with check (true)`, so a hostile row
 * (e.g. `intents: "<!channel>"`, `intents: [123]`, `intents: {"a":1}`) is one curl
 * away from reaching this renderer. Every array-shaped facet below is coerced
 * through this helper before use: non-arrays become `[]`, non-string elements
 * are dropped. That is what makes `.map`/`.includes`/`.replaceAll` calls further
 * down safe to write without a try/catch — by the time they run, the value is
 * guaranteed to be a real string array, never a string, number, or object that
 * merely looks array-like.
 */
export function stringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []
}

/**
 * Same reasoning as stringArray, for `event_days`: only keep values that are
 * actually valid day-of-week integers (0-6). This doubles as the fix for the
 * `DAY_LABELS[d]` lookup below — `d` is guaranteed an in-range integer by the
 * time it's used as an array index, so a hostile `d` (e.g. the string
 * `"constructor"`, which would otherwise resolve `DAY_LABELS["constructor"]`
 * to Array's constructor function) can never reach the index expression.
 *
 * Deduped via Set: `event_days` is unbounded caller-supplied JSONB (see
 * stringArray's comment above for the same threat model), so a payload like
 * `event_days: Array(200_000).fill(0)` passes the integer-range filter
 * 200,000 times over and would otherwise render 200,000 "Sun"s. Real
 * `event_days` only ever has 7 possible distinct values (0-6), so deduping
 * is lossless for every legitimate caller and closes the volume hole for
 * every hostile one.
 */
function dayIntArray(x: unknown): number[] {
  if (!Array.isArray(x)) return []
  const valid = x.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  return [...new Set(valid)]
}

// ── List-facet cap ─────────────────────────────────────────────────────
//
// Every array-shaped bullet below (Interests, Keywords, Categories,
// Organizations, Venues, Days) renders through this one helper. Categories
// already had its own inline MAX_SHOWN=6 cap for readability — this
// generalizes that cap to every facet, because it turns out readability and
// security wanted the same fix: `subscribe/index.ts` writes these arrays
// with the SERVICE-ROLE client (see that file's insert), so a public,
// unauthenticated, uncapped-length POST reaches this renderer with no rate
// limit and no captcha. Measured against this exact renderer: a single
// 40,000-char string in `intents` produces a ~40KB Slack message; a
// 50,000-element `intents` array produces a ~690KB one. Under Slack's 40,000
// char message limit that's a wall of attacker-chosen text posted into the
// partner channel; over it, `chat.postMessage` returns `msg_too_long`, the
// caller settles the row 'failed', and the dedupe key is permanently burned
// — a real subscriber's actual future notification can never be sent again
// under that key.
//
// Slicing happens BEFORE any per-item work (map/format/escape), so cost is
// O(maxShown) regardless of how large `items` is — a 50,000-element array
// costs the same to render as a 6-element one, and `items.length` (used for
// the "+N more" suffix) is an O(1) read on a real array.
const MAX_SHOWN = 6
const ITEM_MAX_LEN = 60

/**
 * Clamp a single free-text string to ITEM_MAX_LEN, appending an ellipsis
 * when truncated. Shared by capList's per-item clamp (below) and by every
 * OTHER free-text field that reaches a renderer — the location label,
 * subscriber email, and feedback page_path all route through this one
 * function before escaping (see their call sites), so there is exactly one
 * place that defines "how long is too long for a single free-text value,"
 * not one ad hoc clamp per field.
 *
 * Clamps by CODE POINT ([...s]), not by UTF-16 code unit (a bare
 * `s.slice(n)`). Most emoji are a surrogate pair — two UTF-16 code units for
 * one character — so slicing by code unit can land mid-pair and truncate to
 * a lone surrogate, which Slack renders as U+FFFD ("�") instead of dropping
 * the character cleanly. Spreading a string iterates by code point, so the
 * cut always falls on a whole-character boundary.
 */
function clampLabel(s: string): string {
  const chars = [...s]
  return chars.length > ITEM_MAX_LEN ? `${chars.slice(0, ITEM_MAX_LEN).join('')}…` : s
}

/**
 * `toLabel` receives the RAW (unescaped) item and returns a raw (unescaped)
 * display string; capList clamps that label's length and escapes it last —
 * escaping before clamping would risk cutting a multi-character HTML entity
 * (e.g. `&amp;`) in half, leaving a stray `&am` in the output. That's
 * cosmetic, not a security gap (no unescaped `&`/`<`/`>` is ever
 * introduced), but there's no reason to invite it when escaping last avoids
 * it for free.
 */
function capList<T>(items: T[], toLabel: (item: T) => string, maxShown = MAX_SHOWN): string {
  const shown = items.slice(0, maxShown)
  const rest = items.length - shown.length
  const labels = shown.map((item) => escapeSlackText(clampLabel(toLabel(item))))
  return labels.join(', ') + (rest > 0 ? ` +${rest} more` : '')
}

/**
 * Build the "What they asked for" bullet list. Only non-default facets get
 * a bullet, EXCEPT Interests, which always renders — as the curated intents
 * when set, or "Everything happening in Akron" when default (['all']/empty).
 * That's why in production this renders exactly one bullet today: signup
 * preferences are the hardcoded default from subscribe/index.ts:109-120 for
 * every facet except intents (see that file's comment for why — no
 * "preferences updated" message is a deliberate follow-up, not built here).
 */
function buildPreferenceBullets(prefsRaw: unknown, resolved: ResolvedNames): string[] {
  // `preferences` is `jsonb not null` at the DB level, but `'null'::jsonb`
  // (the JSON literal null) satisfies a NOT NULL constraint just fine — the
  // column is never absent, but its VALUE can still be null. This file's own
  // contract ("a renderer that touches JSONB must not be able to throw")
  // means that has to be handled here, not assumed away by the caller: an
  // array also isn't a valid preferences object (Array.isArray guard), so a
  // JSONB array value falls back to `{}` the same as a JSONB null does.
  const prefs: Preferences = (prefsRaw && typeof prefsRaw === 'object' && !Array.isArray(prefsRaw))
    ? (prefsRaw as Preferences)
    : {}

  const bullets: string[] = []

  // Interests — always present. Routed through capList (see its comment
  // above) so neither a huge `intents` array nor a huge single intent
  // string can blow up this bullet's rendered size.
  const intents = stringArray(prefs.intents)
  if (intents.length === 0 || intents.includes('all')) {
    bullets.push('Interests: Everything happening in Akron')
  } else {
    const text = capList(intents, (id) => INTENT_LABELS.find((i) => i.id === id)?.label ?? id)
    bullets.push(`Interests: ${text}`)
  }

  // Price. Number.isFinite excludes Infinity/-Infinity (JSONB `1e400`
  // deserializes to Infinity — a bare `> 0` check lets it through and
  // renders "Under $Infinity"), matching the same guard already used below
  // for radius_miles. toLocaleString avoids JS's default scientific-notation
  // stringification for very large-but-finite values (a bare `1e21` would
  // otherwise render "Under $1e+21"); it's a no-op for the small integer
  // values real subscriber preferences ever hold (e.g. `(25).toLocaleString()
  // === '25'`).
  if (prefs.price_max === 0) {
    bullets.push('Free events only')
  } else if (typeof prefs.price_max === 'number' && Number.isFinite(prefs.price_max) && prefs.price_max > 0) {
    bullets.push(`Under $${prefs.price_max.toLocaleString('en-US')}`)
  }

  // Age restriction. AGE_LABEL is a closed, human-curated 3-value enum
  // written only by the preferences UI — unlike Categories below (an open,
  // growing registry where an unrecognized slug is still legible to a
  // partner and worth showing as-is), there is no value for age_restriction
  // that is ever correct to show raw. 'not_specified' (the events-table
  // column default, never chosen as a subscriber preference) means "no
  // restriction" and simply isn't an AGE_LABEL key, so it falls through to
  // "omitted" along with everything else unrecognized — no special case
  // needed. Any non-string shape (object/array/boolean/number — all
  // reachable because `preferences` is untyped JSONB at rest) is also
  // omitted rather than JSON.stringify'd: dumping raw JSON into a
  // partner-facing channel is never useful and was itself an injection sink
  // (`{"a":"<!channel>"}` reached the wire un-neutralized by escapeSlackText
  // in the object-shaped case).
  //
  // AGE_LABEL is a plain object literal, so a bare `AGE_LABEL[key]` lookup
  // with an attacker-chosen key is a prototype-reachable lookup: e.g.
  // age_restriction: "constructor" resolves via the prototype chain to
  // Object's constructor function, not undefined, and would have rendered
  // "function Object() { [native code] }" straight into the channel.
  // Object.hasOwn gates the lookup to AGE_LABEL's own keys only — inherited
  // properties (constructor, toString, hasOwnProperty, ...) always miss and
  // fall through to "omitted", same as any other unrecognized string.
  const ageRaw: unknown = prefs.age_restriction
  if (typeof ageRaw === 'string' && Object.hasOwn(AGE_LABEL, ageRaw)) {
    bullets.push(`Ages: ${AGE_LABEL[ageRaw]}`)
  }

  // Days of week — omitted when all 7 (the default) are selected. dayIntArray
  // drops anything that isn't an in-range integer AND dedupes (see its
  // comment for the 200,000-element hostile-payload case that closes), so
  // DAY_LABELS[d] below is always indexed by a validated, unique 0-6 int —
  // that also closes off a prototype-lookup vector on the DAY_LABELS array.
  // Routed through capList too (maxShown=7, one per possible day) as
  // defense-in-depth, though dayIntArray's own dedupe already bounds this to
  // at most 6 entries by the time isAllDays has ruled out the 7-entry case.
  const days = Array.isArray(prefs.event_days) ? dayIntArray(prefs.event_days) : ALL_DAYS
  if (days.length > 0 && !isAllDays(days)) {
    const sorted = [...days].sort((a, b) => a - b)
    bullets.push(`Days: ${capList(sorted, (d) => DAY_LABELS[d], 7)}`)
  }

  // Location. `label` is a free-text string (not list-shaped, so it doesn't
  // go through capList), but it's still caller-supplied JSONB — routed
  // through the shared clampLabel (defined above, next to capList) for the
  // same reason every capList item is clamped: a single huge string is as
  // much a volume vector as a huge array. capMessage (below) is the final
  // backstop on the fully-assembled message, but clamping here keeps this
  // one bullet from single-handedly consuming most of that budget.
  if (prefs.location && typeof prefs.location === 'object' && prefs.location.mode) {
    if (prefs.location.mode === 'area') {
      const label = typeof prefs.location.label === 'string' ? clampLabel(prefs.location.label) : ''
      bullets.push(escapeSlackText(label || 'a custom area'))
    } else if (prefs.location.mode === 'zipcode') {
      // radius_miles must be shape-validated, not just escaped: it's spliced
      // into the template literal directly (never through escapeSlackText),
      // so a hostile non-number (e.g. the string "<!here>") would otherwise
      // reach Slack mrkdwn completely raw.
      const milesRaw: unknown = prefs.location.radius_miles
      const miles = typeof milesRaw === 'number' && Number.isFinite(milesRaw) ? milesRaw : 0
      const label = typeof prefs.location.label === 'string' ? clampLabel(prefs.location.label) : ''
      bullets.push(`Within ${miles} miles of ${escapeSlackText(label)}`)
    }
  }

  // Keywords. Routed through capList: previously uncapped in both count and
  // per-item length, which is exactly the "36KB wall of text" hole this
  // pass closes for every list-shaped facet.
  const keywords = stringArray(prefs.keywords)
  if (keywords.length > 0) {
    const text = capList(keywords, (k) => `"${k}"`)
    bullets.push(`Keywords: ${text}${prefs.keywords_title_only ? ' (title only)' : ''}`)
  }

  // Categories — collapse past 6 (capList's default MAX_SHOWN). Rendered as
  // human display labels, never raw DB slugs: these channels are
  // partner-facing and must be readable by non-technical business partners.
  // A slug with no match in CATEGORY_LABELS (stale/removed category) still
  // renders, as the slug itself, rather than being dropped or crashing.
  //
  // CATEGORY_LABELS/INTENT_LABELS above are searched with Array#find and a
  // strict `===` comparison against each entry's own `slug`/`id` property —
  // never a bracket lookup on the array/object keyed by the untrusted value
  // itself — so, unlike AGE_LABEL, they are not a prototype-reachable lookup
  // and don't need an Object.hasOwn guard: a hostile slug like "constructor"
  // simply never `===` any real entry and falls through to the escaped-slug
  // fallback below, same as any other unrecognized value. This is the one
  // facet where "fall back to the raw value" is intentionally kept (see
  // age_restriction's comment above for why that's correct here and wrong
  // there): CATEGORY_LABELS is an open registry that grows over time, and an
  // unknown slug is still roughly legible to a partner, whereas
  // age_restriction is a closed enum where an unrecognized value is only
  // ever stale or hostile.
  const categories = stringArray(prefs.categories)
  if (categories.length > 0) {
    const text = capList(categories, (slug) => CATEGORY_LABELS.find((c) => c.slug === slug)?.label ?? slug)
    bullets.push(`Categories: ${text}`)
  }

  // Organizations / venues — UUIDs are NEVER printed. An id with no match in
  // the resolved map (deleted org/venue, or the caller passed no resolution
  // at all) renders a fixed placeholder instead of the id or a crash. Routed
  // through capList so an unbounded `org_ids`/`venue_ids` array (whether
  // from a hostile signup or a future "select all" UI) can't blow up this
  // bullet — this is defense-in-depth on top of the id-count cap applied at
  // the call site in slack-notify/index.ts before resolution ever queries
  // the DB.
  const orgIds = stringArray(prefs.org_ids)
  if (orgIds.length > 0) {
    const text = capList(orgIds, (id) => resolved.orgNames.get(id) ?? '(removed organizer)')
    bullets.push(`Organizations: ${text}`)
  }
  const venueIds = stringArray(prefs.venue_ids)
  if (venueIds.length > 0) {
    const text = capList(venueIds, (id) => resolved.venueNames.get(id) ?? '(removed venue)')
    bullets.push(`Venues: ${text}`)
  }

  return bullets
}

// Hard ceiling on any ONE fully-assembled renderer output, independent of
// any per-facet cap above.
//
// CORRECTED (code-reviewer re-review round 3, 2026-07-27): this comment
// previously claimed the constant below bounds "the fully-assembled
// message." It did not — it only ever bounded describePreferences's own
// return value, which is one line (renderSignup's 4th of 4) inside a larger
// joined message that also includes the subscriber's raw `email`
// (renderSignup, renderConfirmed) or a raw `page_path` (renderFeedback),
// NEITHER of which was capped anywhere. That gap is what let a 100,000-char
// `page_path` or `email` reach Slack's chat.postMessage as a >39,000-char
// message that POSTS, or a >500,000-char one that fails `msg_too_long` and
// permanently burns that row's dedupe key (the same failure mode capList's
// comment describes, arriving via a field capList never touches).
//
// The fix is structural, not another instance patch: `capMessage` (below)
// is called at the EXIT of every renderer in this file — renderSignup,
// renderFeedback, renderConfirmed, AND describePreferences itself — so no
// single free-text field anywhere here, today or added by a future facet,
// can grow the wire message past this bound. describePreferences also calls
// it on its own output as defense-in-depth (a huge preferences block alone
// shouldn't consume the whole budget before the caller even gets a chance
// to wrap it), but it is no longer the ONLY place this bound is enforced —
// treat capMessage-at-the-renderer's-exit as the pattern every renderer
// added to this file must follow, not describePreferences's internal cap.
export const MAX_MESSAGE_LEN = 3000
export const TRUNCATION_MARKER = '\n…(truncated)'

/**
 * Bound ANY renderer's fully-assembled output to MAX_MESSAGE_LEN. This is
 * the backstop every renderer below calls last, on its own final
 * `.join('\n')` — see the comment above MAX_MESSAGE_LEN for why a per-field
 * clamp alone (capList, clampLabel) was not sufficient by itself. Adding a
 * new renderer to this file without calling capMessage on its return value
 * is the exact class of bug this function exists to make structurally hard
 * to reintroduce — it is the obvious, minimal thing to do at a renderer's
 * exit, by design.
 *
 * Clamps by CODE POINT ([...s]), same reasoning as clampLabel above:
 * slicing a UTF-16 string by code unit can land inside a surrogate pair and
 * truncate to a lone surrogate, which Slack renders as U+FFFD instead of a
 * clean cut.
 */
export function capMessage(s: string): string {
  const chars = [...s]
  return chars.length > MAX_MESSAGE_LEN
    ? chars.slice(0, MAX_MESSAGE_LEN).join('') + TRUNCATION_MARKER
    : s
}

/**
 * Render the "What they asked for" block (header + bullets). Always
 * non-empty — the Interests bullet never omits itself, so there is always
 * at least one line beneath the header.
 */
export function describePreferences(
  prefs: Preferences | null | undefined,
  resolved: ResolvedNames = EMPTY_RESOLVED,
): string {
  const bullets = buildPreferenceBullets(prefs, resolved)
  const full = ['What they asked for:', ...bullets.map((b) => `• ${b}`)].join('\n')
  return capMessage(full)
}

// ── Feedback ───────────────────────────────────────────────────────────

// Mirrors the DB CHECK constraint in migration 043
// (`char_length(body) between 1 and 1000`) — see notify-feedback/index.ts's
// identical constant for why this is duplicated rather than imported (this
// function can't import a Node-shaped module from a different runtime).
const FEEDBACK_BODY_MAX_LEN = 1000

function blockquote(body: string): string {
  const truncated = body.length > FEEDBACK_BODY_MAX_LEN ? body.slice(0, FEEDBACK_BODY_MAX_LEN) : body
  return escapeSlackText(truncated)
    .split(/\r\n|\r|\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

function fmtDateTimeET(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })
}

/**
 * New feedback from akronpulse.com
 *
 * > {body, blockquoted per line, escaped, truncated at 1000}
 *
 * Page: {page_path}  ·  {created_at in America/New_York}
 */
export function renderFeedback(feedback: FeedbackRow): string {
  // page_path is free-text, caller-supplied text — 043_feedback_orb.sql's
  // anon INSERT WITH CHECK constrains is_private/votes/image_url/category/
  // body/status but says nothing about page_path's length, so an unbounded
  // page_path was one unauthenticated PostgREST POST away from reaching
  // this renderer raw (see MAX_MESSAGE_LEN's comment above for the exploit
  // this closed). Routed through the same clampLabel every other free-text
  // field uses, before escaping.
  const page = feedback.page_path ? escapeSlackText(clampLabel(feedback.page_path)) : 'Unknown'
  return capMessage([
    'New feedback from akronpulse.com',
    '',
    blockquote(feedback.body),
    '',
    `Page: ${page}  ·  ${fmtDateTimeET(feedback.created_at)}`,
  ].join('\n'))
}

// ── Signup ─────────────────────────────────────────────────────────────

/**
 * {email} has signed up to receive {lookaheadPhrase} every {frequencyNoun}.
 * They will not receive any emails until they confirm their subscription.
 *
 * What they asked for:
 * • Interests: Date Night, Arts & Stage
 */
export function renderSignup(sub: SignupSubscriber, resolved: ResolvedNames = EMPTY_RESOLVED): string {
  // email is free-text, caller-supplied text too — subscribe/index.ts's
  // validation regex historically had no length bound (fixed separately on
  // the write side; see that file), and this row is written with the
  // SERVICE-ROLE client, so the read side must not assume the write side
  // always enforces it. Same clampLabel treatment as page_path above.
  const email = escapeSlackText(clampLabel(sub.email))
  return capMessage([
    `${email} has signed up to receive ${lookaheadPhrase(sub.lookahead_days)} every ${frequencyNoun(sub.frequency)}.`,
    'They will not receive any emails until they confirm their subscription.',
    '',
    describePreferences(sub.preferences, resolved),
  ].join('\n'))
}

// ── Confirmed ──────────────────────────────────────────────────────────

/**
 * {email} has confirmed their subscription! — verbatim, nothing else, but
 * still routed through clampLabel + capMessage for the same reason as
 * renderSignup's email above: this renderer has no other facet caps to fall
 * back on, so it needs its own explicit bound.
 */
export function renderConfirmed(email: string): string {
  return capMessage(`${escapeSlackText(clampLabel(email))} has confirmed their subscription!`)
}
