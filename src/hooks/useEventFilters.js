import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { INTENTS } from '@/lib/intents'

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
 *
 * @param {object}   opts
 * @param {string[]} opts.lockedKeys - filter param keys that clearFilters()
 *   must NOT remove. Used by the embed so a visitor's "Clear filters" can
 *   never escape the partner's locked constraint (e.g. a music-only embed).
 *   Homepage passes none, so clearFilters wipes every filter as before.
 * @param {object}   opts.preset - non-URL preset facets always OR'd into the
 *   effective query. The embed uses this for facet flags (family,
 *   fundraiser) that have no dedicated filter param of their own.
 */

// All filter-owned query keys. clearFilters only ever touches these, so
// non-filter params (embed theme/features/target/view/density) survive a
// "Clear filters" untouched.
export const FILTER_PARAM_KEYS = ['intent', 'date', 'from', 'to', 'categories', 'price', 'sort', 'q']

export function useEventFilters({ lockedKeys = [], preset = {} } = {}) {
  const [searchParams, setSearchParams] = useSearchParams()

  // Single helper that writes one param key → value into the URL.
  // Passing null/empty removes the key so the URL stays clean.
  const updateParam = useCallback((key, value) => {
    const params = new URLSearchParams(searchParams)
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      params.delete(key)
    } else {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  // intent — validated against the canonical INTENTS registry so a stale or
  // hand-edited param can never set a phantom intent.
  const activeIntentId = useMemo(() => {
    const id = searchParams.get('intent')
    return INTENTS.some((i) => i.id === id) ? id : null
  }, [searchParams])
  const setActiveIntentId = useCallback((v) => updateParam('intent', v), [updateParam])

  // date — predefined date-range preset ('today' | 'this_weekend' | etc.)
  const dateRange = useMemo(() => searchParams.get('date') || null, [searchParams])
  const setDateRange = useCallback((v) => updateParam('date', v), [updateParam])

  // from / to — custom 'YYYY-MM-DD' date range (FilterTray date picker)
  const dateFrom = useMemo(() => searchParams.get('from') || null, [searchParams])
  const setDateFrom = useCallback((v) => updateParam('from', v), [updateParam])
  const dateTo = useMemo(() => searchParams.get('to') || null, [searchParams])
  const setDateTo = useCallback((v) => updateParam('to', v), [updateParam])

  // categories — comma-separated list (e.g. "music,outdoors")
  const rawCategories = useMemo(() => {
    const raw = searchParams.get('categories') || ''
    return raw.split(',').map((c) => c.trim()).filter(Boolean)
  }, [searchParams])
  const setRawCategories = useCallback((v) => updateParam('categories', v), [updateParam])

  // price — null | 'free' | 'under10' | 'under25'
  const priceFilter = useMemo(() => searchParams.get('price') || null, [searchParams])
  const setPriceFilter = useCallback((v) => updateParam('price', v), [updateParam])

  // sort — 'soonest' (default, omitted from URL) | 'latest'
  const sort = useMemo(() => searchParams.get('sort') || 'soonest', [searchParams])
  const setSort = useCallback((v) => updateParam('sort', v === 'soonest' ? null : v), [updateParam])

  // search — committed query (?q=). The draft lives in the consuming
  // component's <input> until the user commits it.
  const search = useMemo(() => searchParams.get('q') || '', [searchParams])
  const setSearch = useCallback((value) => updateParam('q', value || null), [updateParam])

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
  const intentFacets = activeIntent?.facets ?? []
  // Tray raw categories narrow; if empty, fall back to intent's categories.
  const effectiveCategories = rawCategories.length > 0
    ? rawCategories
    : (activeIntent?.categories ?? [])
  const effectiveFamily = intentFacets.includes('family') || !!preset.family
  const effectiveFundraiser = intentFacets.includes('fundraiser') || !!preset.fundraiser
  const effectiveFreeOnly = intentFacets.includes('free') || priceFilter === 'free'
  const effectivePriceMax = effectiveFreeOnly ? null : priceFilter

  const effective = {
    categories: effectiveCategories,
    family: effectiveFamily,
    fundraiser: effectiveFundraiser,
    dateRange,
    dateFrom,
    dateTo,
    search,
    freeOnly: effectiveFreeOnly,
    priceMax: effectivePriceMax,
    sort,
  }

  // Stable signature string used by consumers to reset pagination on any
  // change. Excludes density (caller appends it if relevant).
  const filterKey = [
    activeIntentId,
    effectiveCategories.join(','),
    effectiveFamily,
    effectiveFundraiser,
    dateRange,
    dateFrom,
    dateTo,
    search,
    effectiveFreeOnly,
    effectivePriceMax,
    sort,
  ].join('|')

  return {
    // raw values
    activeIntentId, setActiveIntentId,
    dateRange, setDateRange,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    rawCategories, setRawCategories,
    priceFilter, setPriceFilter,
    sort, setSort,
    search, setSearch,
    // actions
    clearFilters,
    // derived
    activeIntent,
    effective,
    filterKey,
  }
}
