/**
 * categoryHref.ts — pure "where does clicking a category badge go" logic.
 *
 * RELATIVE imports with explicit extensions only, on purpose: this module is
 * unit-tested under `node --test` (scripts/tests/test-category-href.js), which
 * imports the .ts file directly via type stripping — the `@/` alias does not
 * resolve there. Same rule (and same reason) as eventHref.ts. The EmbedConfig
 * import is type-only so embedConfig's `@/` imports never load at runtime.
 *
 * The badge is a NAVIGATION, not a filter control: the component renders a
 * react-router `<Link>` (a PUSH) so browser/hardware Back returns the visitor
 * to their previous filters. It deliberately never calls a useEventFilters
 * setter, whose `replace: true` convention keeps ordinary filter toggles out
 * of back-history.
 *
 * URL rule, identical on both surfaces: copy the CURRENT search, delete every
 * FILTER_PARAM_KEY except the embed's lockedKeys, then set `categories` to the
 * one slug. Same shape as useEventFilters' clearFilters. Three requirements
 * fall out of that single rule with no special-casing:
 *   • every other filter (intent/date/from/to/exclude/price/sort/q/audience/
 *     tod) clears, so the badge always lands on exactly one category;
 *   • "move an excluded category to included" needs no code — `exclude` is
 *     dropped wholesale before `categories` is set;
 *   • embed locks survive — lockedKeys covers price/date, and theme/place/
 *     features/view/density/target/title are not filter keys, so they are
 *     never touched.
 */
import { isValidCategory, FILTERABLE_CATEGORIES } from './categories.js'
import { umbrellaFestival } from './browseVisibility.js'
import { FILTER_PARAM_KEYS } from './filterParams.ts'
import type { EmbedConfig } from './embedConfig.ts'

export interface CategoryHrefContext {
  /** location.pathname — used ONLY for the "already the sole filter" compare. */
  pathname: string
  /** location.search, with or without the leading '?'. */
  search: string
  /** useEmbed() — null on the normal site. */
  embed: EmbedConfig | null
  /** The row's raw source tags, for the festival-umbrella branch. */
  tags?: string[] | null
}

/**
 * `inert` = render today's plain <span> (no anchor, no href). `link` = render
 * a <Link to={href}>.
 */
export type CategoryBadgeHref =
  | { kind: 'inert'; current?: true }
  | { kind: 'link'; href: string }

const INERT: CategoryBadgeHref = { kind: 'inert' }
/** Inert case 5 only — the badge marks the filter the visitor is already on,
 *  which the component reports as aria-current="true". */
const INERT_CURRENT: CategoryBadgeHref = { kind: 'inert', current: true }

const FILTERABLE_SLUGS: ReadonlySet<string> = new Set(
  FILTERABLE_CATEGORIES.map((c) => c.slug),
)

/** Where the browse grid lives on each surface. */
function basePath(embed: EmbedConfig | null): string {
  return embed ? '/embed' : '/'
}

/**
 * resolveCategoryBadgeHref — single source of truth for "what a category badge
 * click means". Returns `inert` for the five cases where a link would be a lie:
 *
 *   1. Unknown slug (not in the canonical taxonomy).
 *   2. Not filterable — 'other'. `?categories=other` yields a filter with no
 *      tray chip (filterOptions' CATEGORY_OPTIONS is built from
 *      FILTERABLE_CATEGORIES), i.e. a filter the visitor cannot see or undo.
 *   3. Embed whose partner did not permit this category — the locked set
 *      clamps the effective query anyway, so the link would be a no-op.
 *   4. Embed with `features.filter` off — EventsBrowser gates the whole
 *      "Filter & Sort" button on that flag, so a partner who disabled
 *      filtering but left tags on would otherwise hand visitors a filter with
 *      no UI to remove it.
 *   5. The computed target is already the current URL (this category is
 *      ALREADY the sole active filter). Exact string compare is valid because
 *      the target is built by copying the current params and mutating them, so
 *      key order is preserved.
 *
 * The one non-grid destination, SITE ONLY: a `festival` CATEGORY badge on a row
 * that is the umbrella for a registry Festival goes to that festival's hub
 * instead. (`festival-umbrella` is a TAG, never a badge — badges come from
 * event.categories, which a DB CHECK constrains to CATEGORIES.) A `festival`
 * badge on a non-umbrella row goes to the grid like every other badge.
 *
 * GUARD ORDER IS LOAD-BEARING: the `embed` check deliberately precedes AND
 * SUPPRESSES the festival branch. `/festival/<slug>` is not under `/embed`, so
 * taking that branch inside an iframe would navigate the partner's embed out of
 * its own route group and drop the theme, the chrome and every lock — the one
 * thing the embed contract never permits. Inside an embed a permitted
 * `festival` badge therefore falls through to the ordinary grid build and
 * filters the embed grid in place; a non-permitted one is inert. Do not "tidy"
 * this by hoisting the festival branch above the embed guards.
 */
export function resolveCategoryBadgeHref(
  slug: string,
  ctx: CategoryHrefContext,
): CategoryBadgeHref {
  // 1 — unknown slug.
  if (!slug || !isValidCategory(slug)) return INERT

  // 2 — not filterable ('other').
  if (!FILTERABLE_SLUGS.has(slug)) return INERT

  const { embed } = ctx
  if (embed) {
    // 4 — the partner switched filtering off entirely.
    if (!embed.features.filter) return INERT
    // 3 — the partner's locked set does not include this category.
    if (!(embed.categories.length > 0 && embed.categories.includes(slug))) return INERT
  }

  // Festival hub — SITE ONLY. `!embed` is the guard that keeps a partner
  // iframe inside /embed; see the note above.
  const href = (!embed && slug === 'festival')
    ? festivalHref(ctx) ?? gridHref(slug, ctx)
    : gridHref(slug, ctx)

  // 5 — already exactly where this badge would take us. BOTH sides go through
  // URLSearchParams first: the built href is already canonically encoded
  // (toString() rewrites ',' → '%2C' and ' ' → '+'), so comparing it against a
  // RAW location.search missed every URL that wasn't canonically encoded to
  // begin with — a hand-written partner iframe (`?features=filter,tags`) or any
  // '%20'-bearing UTM link. The pill for the filter you are already on then
  // rendered as a live link, lost aria-current, and pushed a history entry that
  // changed only the encoding, so the visitor's next Back appeared to do
  // nothing. Canonicalising both sides compares URLs, not strings.
  if (href === canonicalUrl(ctx.pathname, ctx.search)) return INERT_CURRENT

  return { kind: 'link', href }
}

/**
 * pathname + search re-encoded exactly the way gridHref's `params.toString()`
 * encodes it, so the two are comparable as plain strings. Key ORDER is
 * untouched (URLSearchParams preserves insertion order) — that is what
 * gridHref's in-place `categories` overwrite relies on.
 */
function canonicalUrl(pathname: string, search: string | null | undefined): string {
  const qs = new URLSearchParams(normalizeSearch(search)).toString()
  return `${pathname}${qs ? `?${qs}` : ''}`
}

/** `/festival/<slug>` when this row is a registry festival's umbrella.
 *  Only ever reached on the site — never inside an embed. */
function festivalHref(ctx: CategoryHrefContext): string | null {
  const festival = umbrellaFestival(ctx.tags)
  return festival ? `/festival/${festival.slug}` : null
}

/** The browse grid, filtered to exactly this one category. */
function gridHref(slug: string, ctx: CategoryHrefContext): string {
  const params = new URLSearchParams(normalizeSearch(ctx.search))
  const locked = new Set(ctx.embed?.lockedKeys ?? [])
  for (const key of FILTER_PARAM_KEYS) {
    // `categories` is skipped here and overwritten by set() below rather than
    // deleted first: set() on an EXISTING key replaces it IN PLACE, which is
    // what makes the "already the sole filter" compare a valid exact string
    // compare (delete-then-set would re-append it and reorder the query).
    if (key === 'categories') continue
    if (!locked.has(key)) params.delete(key)
  }
  params.set('categories', slug)
  const qs = params.toString()
  return `${basePath(ctx.embed)}${qs ? `?${qs}` : ''}`
}

/**
 * The id on HomePage's browse-region wrapper — the element a badge click
 * scrolls to. Exported from here so the producer (the predicate below) and
 * the consumers (HomePage's `<div id>` and CategoryBadge's getElementById)
 * cannot drift.
 *
 * It is the WRAPPER, not a grid: EventsBrowser renders one `.cards-grid` per
 * date group, each keyed by the results key, so every one of them is
 * destroyed and rebuilt by the very navigation being scrolled for. The
 * wrapper survives, and it also contains FilterBar, so its top doubles as the
 * filter bar's static position.
 */
export const BROWSE_RESULTS_ID = 'browse-results'

/**
 * shouldScrollToGrid — "does activating this badge leave the visitor on a
 * page that HAS the browse grid on it, in a way App.tsx will not already
 * handle?" Pure, additive, and deliberately separate from
 * resolveCategoryBadgeHref: the resolver's contract and its 337-line suite
 * describe WHERE a badge goes, not what the page does afterwards.
 *
 * Two rules cover every surface with no per-surface branching:
 *
 *   • Never inside an embed. This guard is EXPLICIT, not left to be a
 *     harmless no-op the way `window.scrollTo(0)` was. scrollIntoView is
 *     specified to scroll ANCESTOR scrolling boxes, which in principle
 *     includes the parent frame; the embed is auto-height, so there is
 *     nothing here to scroll and everything to lose. Cross-origin blocks it
 *     today, but a same-origin partner page is not something to rest on
 *     frame-scroll semantics — yanking a partner's page is exactly what the
 *     white-label contract forbids.
 *
 *   • Only when the target pathname equals the current one. That is the
 *     single case App.tsx's scroll-to-top effect misses, because it keys on
 *     `location.pathname` alone: a badge click on the grid is a search-only
 *     PUSH on the SAME pathname. Every cross-pathname target — EventPage and
 *     CategoryPage badges (which land on '/'), and the festival-hub branch —
 *     changes the pathname, so App.tsx scrolls the new page to top and there
 *     is no grid here to look for.
 *
 * An inert target never navigates, so it never scrolls.
 */
export function shouldScrollToGrid(
  target: CategoryBadgeHref,
  ctx: CategoryHrefContext,
): boolean {
  if (ctx.embed) return false
  if (target.kind !== 'link') return false
  return hrefPathname(target.href) === ctx.pathname
}

/** '/x?a=b#c' → '/x'. Targets are always app-relative (basePath + query). */
function hrefPathname(href: string): string {
  return href.split(/[?#]/)[0]
}

/** '' | '?a=b' | 'a=b' → '' | '?a=b'. */
function normalizeSearch(search: string | null | undefined): string {
  if (!search) return ''
  const body = search.startsWith('?') ? search.slice(1) : search
  return body ? `?${body}` : ''
}
