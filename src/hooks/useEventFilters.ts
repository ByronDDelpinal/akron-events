import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { INTENTS } from '@/lib/intents'
import { trackEvent, EVENTS } from '@/lib/analytics'

/**
 * useEventFilters — the single, URL-backed source of truth for the event
 * browsing filter state.
 *
 * Extracted from HomePage so the homepage and the white-label embed share
 * one implementation of filter parsing, validation, and the derivation of
 * the "effective" arguments handed to useEvents. Every filter lives in the
 * URL query string so that:
 *   - navigating to an event detail page and pressing Back restores the
 *     exact filter state, and
 *   - inside the embed iframe, the partner's preset filters (seeded into
 *     the iframe src) are read straight back out as ordinary params.
 *
 * `replace: true` on every setter keeps filter toggles out of back-history.
 */

/** Non-URL facet presets always OR'd into the effective query (embed use). */
export interface FilterPreset {
  family?: boolean
  fundraiser?: boolean
}

export interface UseEventFiltersOptions {
  /**
   * Filter param keys that clearFilters() must NOT remove. Used by the embed
   * so a visitor's "Clear filters" can never escape the partner's locked
   * constraint (e.g. a free-only embed). Homepage passes none.
   */
  lockedKeys?: string[]
  /** Facet flags (family, fundraiser) with no dedicated filter param. */
  preset?: FilterPreset
  /**
   * The partner's locked category set (embed only). When non-empty the visitor
   * may narrow WITHIN this set but never outside it: the effective query is
   * clamped to the intersection of the visitor's selection and the locked set,
   * and falls back to the full set when the visitor has cleared their narrowing.
   * Homepage passes none.
   */
  lockedCategories?: string[]
  /**
   * Partner's locked geographic scope (embed only), already resolved from the
   * `place` slug to the venue filters useEvents understands. These are hard
   * locks with no visitor-facing control: they always flow into the effective
   * query and are unaffected by filtering or clearing. Homepage passes none.
   */
  lockedNeighborhoodSlug?: string | null
  lockedVenueCities?: string[]
}

/** The derived, validated arguments handed to useEvents. */
export interface EffectiveQuery {
  categories: string[]
  /** Content categories to hide from the grid (anti-join). */
  excludedCategories: string[]
  family: boolean
  /** Hide events flagged is_family (the "Hide kids' events" audience toggle). */
  excludeFamily: boolean
  fundraiser: boolean
  dateRange: string | null
  dateFrom: string | null
  dateTo: string | null
  search: string
  freeOnly: boolean
  priceMax: string | null
  sort: string
  /** Locked geo scope (embed) — null/[] on the homepage and category hubs. */
  neighborhoodSlug: string | null
  venueCities: string[]
}

// All filter-owned query keys. clearFilters only ever touches these, so
// non-filter params (embed theme/features/target/view/density) survive a
// "Clear filters" untouched.
export const FILTER_PARAM_KEYS = ['intent', 'date', 'from', 'to', 'categories', 'exclude', 'price', 'sort', 'q', 'audience']

type ParamValue = string | string[] | null | undefined

export function useEventFilters({
  lockedKeys = [],
  preset = {},
  lockedCategories = [],
  lockedNeighborhoodSlug = null,
  lockedVenueCities = [],
}: UseEventFiltersOptions = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const hasLockedCategories = lockedCategories.length > 0

  // Single helper that writes one param key → value into the URL.
  // Passing null/empty removes the key so the URL stays clean.
  const updateParam = useCallback((key: string, value: ParamValue) => {
    const params = new URLSearchParams(searchParams)
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      params.delete(key)
    } else {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  // Write several params in ONE history entry. Sequential updateParam() calls
  // each derive from the same render's searchParams snapshot, so the second
  // would clobber the first; the include/exclude cycle must move a slug between
  // two keys atomically, so it needs this.
  const updateParams = useCallback((entries: Record<string, ParamValue>) => {
    const params = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(entries)) {
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) params.delete(key)
      else params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  // intent — validated against the canonical INTENTS registry so a stale or
  // hand-edited param can never set a phantom intent.
  const activeIntentId = useMemo<string | null>(() => {
    const id = searchParams.get('intent')
    return INTENTS.some((i) => i.id === id) ? id : null
  }, [searchParams])
  const setActiveIntentId = useCallback((v: string | null) => updateParam('intent', v), [updateParam])

  // date — predefined date-range preset ('today' | 'this_weekend' | etc.)
  const dateRange = useMemo(() => searchParams.get('date') || null, [searchParams])
  const setDateRange = useCallback((v: string | null) => updateParam('date', v), [updateParam])

  // from / to — custom 'YYYY-MM-DD' date range (FilterTray date picker)
  const dateFrom = useMemo(() => searchParams.get('from') || null, [searchParams])
  const setDateFrom = useCallback((v: string | null) => updateParam('from', v), [updateParam])
  const dateTo = useMemo(() => searchParams.get('to') || null, [searchParams])
  const setDateTo = useCallback((v: string | null) => updateParam('to', v), [updateParam])

  // categories — comma-separated list (e.g. "music,outdoors")
  const rawCategories = useMemo(() => {
    const raw = searchParams.get('categories') || ''
    return raw.split(',').map((c) => c.trim()).filter(Boolean)
  }, [searchParams])
  const setRawCategories = useCallback((v: string[] | null) => updateParam('categories', v), [updateParam])

  // exclude — comma-separated content categories to HIDE from the grid.
  const excludedCategories = useMemo(() => {
    const raw = searchParams.get('exclude') || ''
    return raw.split(',').map((c) => c.trim()).filter(Boolean)
  }, [searchParams])
  const setExcludedCategories = useCallback((v: string[] | null) => updateParam('exclude', v), [updateParam])

  // Tri-state category cycle: off -> include -> exclude -> off. Moves the slug
  // between the two params atomically so a category is never both.
  //
  // Instrumented here rather than at the button, because this hook is the URL's
  // single source of truth and every category toggle in the app routes through
  // it — FilterTray, the FilterBar chips and CategoryPage all call this. Wiring
  // the individual controls instead would guarantee drift the first time a
  // fourth one is added.
  //
  // `action` is the state being ENTERED, not the one left behind. The exclude
  // half matters on its own: it's the only signal that says a user actively
  // does not want a category, which no view or click count can express.
  const cycleCategory = useCallback((slug: string) => {
    if (rawCategories.includes(slug)) {
      trackEvent(EVENTS.CATEGORY_FILTER, { category: slug, action: 'exclude' })
      updateParams({ categories: rawCategories.filter((c) => c !== slug), exclude: [...excludedCategories, slug] })
    } else if (excludedCategories.includes(slug)) {
      trackEvent(EVENTS.CATEGORY_FILTER, { category: slug, action: 'clear' })
      updateParams({ exclude: excludedCategories.filter((c) => c !== slug) })
    } else {
      trackEvent(EVENTS.CATEGORY_FILTER, { category: slug, action: 'include' })
      updateParams({ categories: [...rawCategories, slug] })
    }
  }, [rawCategories, excludedCategories, updateParams])

  // price — null | 'free' | 'under10' | 'under25'
  const priceFilter = useMemo(() => searchParams.get('price') || null, [searchParams])
  const setPriceFilter = useCallback((v: string | null) => updateParam('price', v), [updateParam])

  // sort — 'soonest' (default, omitted from URL) | 'latest'
  const sort = useMemo(() => searchParams.get('sort') || 'soonest', [searchParams])
  const setSort = useCallback((v: string) => updateParam('sort', v === 'soonest' ? null : v), [updateParam])

  // search — committed query (?q=). The draft lives in the consuming
  // component's <input> until the user commits it.
  const search = useMemo(() => searchParams.get('q') || '', [searchParams])
  const setSearch = useCallback((value: string | null) => updateParam('q', value || null), [updateParam])

  // audience — the "Hide kids' events" grid toggle. Only non-default value is
  // 'no-kids' (param omitted otherwise, so the default URL stays clean).
  const excludeFamily = useMemo(() => searchParams.get('audience') === 'no-kids', [searchParams])
  const setExcludeFamily = useCallback(
    (v: boolean) => updateParam('audience', v ? 'no-kids' : null),
    [updateParam],
  )

  // ── Clear ─────────────────────────────────────────────────────────────
  // Removes every FILTER_PARAM_KEY except those in lockedKeys, preserving
  // all other params (embed config). On the homepage (lockedKeys empty,
  // no other params) this is equivalent to the old setSearchParams({}).
  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams)
    for (const key of FILTER_PARAM_KEYS) {
      if (!lockedKeys.includes(key)) params.delete(key)
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams, lockedKeys])

  // ── Derived "effective" args for useEvents ────────────────────────────
  const activeIntent = INTENTS.find((i) => i.id === activeIntentId) ?? null
  const intentFacets: string[] = activeIntent?.facets ?? []
  // When the partner locked a category set, the visitor narrows within it: clamp
  // the selection to the intersection with the locked set (so a hand-edited URL
  // can't escape it) and fall back to the full locked set once narrowing clears.
  // Otherwise tray raw categories narrow; if empty, fall back to the intent's.
  const effectiveCategories = hasLockedCategories
    ? (() => {
        const narrowed = rawCategories.filter((c) => lockedCategories.includes(c))
        return narrowed.length > 0 ? narrowed : lockedCategories
      })()
    : (rawCategories.length > 0 ? rawCategories : (activeIntent?.categories ?? []))
  // Exclusion is a homepage power feature: it's disabled inside category-locked
  // embeds (which only narrow within the lock), and a slug can never be both
  // included and excluded (guards a hand-edited URL).
  const effectiveExcludedCategories = hasLockedCategories
    ? []
    : excludedCategories.filter((c) => !effectiveCategories.includes(c))
  const effectiveFamily = intentFacets.includes('family') || !!preset.family
  // The Family intent (show only kids' events) and the audience toggle (hide
  // them) are contradictory; the explicit inclusive choice wins, so the toggle
  // is suppressed whenever family is on. Keeps results from going empty.
  const effectiveExcludeFamily = excludeFamily && !effectiveFamily
  const effectiveFundraiser = intentFacets.includes('fundraiser') || !!preset.fundraiser
  const effectiveFreeOnly = intentFacets.includes('free') || priceFilter === 'free'
  const effectivePriceMax = effectiveFreeOnly ? null : priceFilter

  const effective: EffectiveQuery = {
    categories: effectiveCategories,
    excludedCategories: effectiveExcludedCategories,
    family: effectiveFamily,
    excludeFamily: effectiveExcludeFamily,
    fundraiser: effectiveFundraiser,
    dateRange,
    dateFrom,
    dateTo,
    search,
    freeOnly: effectiveFreeOnly,
    priceMax: effectivePriceMax,
    sort,
    neighborhoodSlug: lockedNeighborhoodSlug,
    venueCities: lockedVenueCities,
  }

  // Stable signature string used by consumers to reset pagination on any
  // change. Excludes density (caller appends it if relevant).
  const filterKey = [
    activeIntentId,
    effectiveCategories.join(','),
    effectiveExcludedCategories.join(','),
    effectiveFamily,
    effectiveExcludeFamily,
    effectiveFundraiser,
    dateRange,
    dateFrom,
    dateTo,
    search,
    effectiveFreeOnly,
    effectivePriceMax,
    sort,
    lockedNeighborhoodSlug,
    lockedVenueCities.join(','),
  ].join('|')

  return {
    // raw values
    activeIntentId, setActiveIntentId,
    dateRange, setDateRange,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    rawCategories, setRawCategories,
    excludedCategories, setExcludedCategories, cycleCategory,
    priceFilter, setPriceFilter,
    sort, setSort,
    search, setSearch,
    excludeFamily, setExcludeFamily,
    // actions
    clearFilters,
    // derived
    activeIntent,
    effective,
    filterKey,
  }
}
