import { useState, type ReactNode } from 'react'
import { INTENTS } from '@/lib/intents'
import FilterTray from './FilterTray'
import ViewModeToggle from './ViewModeToggle'
import './FilterBar.css'

interface DateTab {
  id: string | null
  label: string
}

const DATE_TABS: DateTab[] = [
  { id: null,            label: 'All' },
  { id: 'today',         label: 'Today' },
  { id: 'this_weekend',  label: 'This Weekend' },
  { id: 'this_week',     label: 'This Week' },
  { id: 'this_month',    label: 'This Month' },
]

export interface LockedDimensions {
  category?: boolean
  price?: boolean
  dateRange?: boolean
}

interface FilterBarProps {
  activeIntentId: string | null
  onIntentId: (id: string | null) => void
  dateRange: string | null
  onDateRange: (v: string | null) => void
  dateFrom: string | null
  onDateFrom: (v: string | null) => void
  dateTo: string | null
  onDateTo: (v: string | null) => void
  rawCategories: string[]
  onRawCategories: (cats: string[]) => void
  excludedCategories?: string[]
  onExcludedCategories?: (cats: string[]) => void
  /** Tri-state cycle for a content category: off -> include -> exclude -> off. */
  onCycleCategory?: (slug: string) => void
  priceFilter: string | null
  onPriceFilter: (v: string | null) => void
  sort: string
  onSort: (v: string) => void
  /** Committed search term + a clearer, for the active-filter pill. */
  search?: string
  onSearch?: (v: string) => void
  /** Audience toggle: hide events flagged is_family. */
  excludeFamily?: boolean
  onExcludeFamily?: (v: boolean) => void
  showAudienceToggle?: boolean
  view: string
  onView?: (v: string) => void
  total: number
  cardViewMode?: string
  onCardViewMode?: (v: string) => void
  onClearAll?: () => void
  lockedDimensions?: LockedDimensions
  lockedCategories?: string[]
  showFilterButton?: boolean
}

/**
 * FilterBar — sticky filter zone, consolidated to two rows.
 * Curated intents live inside the FilterTray alongside raw categories;
 * the active-filter summary strip renders below when any filter is on.
 */
export default function FilterBar({
  activeIntentId,  onIntentId,
  dateRange,       onDateRange,
  dateFrom,        onDateFrom,
  dateTo,          onDateTo,
  rawCategories,   onRawCategories,
  excludedCategories = [], onExcludedCategories,
  onCycleCategory,
  priceFilter,     onPriceFilter,
  sort,            onSort,
  search = '',     onSearch,
  excludeFamily = false, onExcludeFamily,
  showAudienceToggle = false,
  view,            onView,
  total,
  cardViewMode,    onCardViewMode,
  onClearAll,
  lockedDimensions = {},
  lockedCategories = [],
  showFilterButton = true,
}: FilterBarProps) {
  const [trayOpen, setTrayOpen] = useState(false)

  const activeIntent = INTENTS.find((i) => i.id === activeIntentId) ?? null

  // Locked dimensions are presets the user can't undo (category-hub pages,
  // embeds), so their pills never appear in the clearable summary strip.
  const showDatePill = (dateRange || dateFrom || dateTo) && !lockedDimensions.dateRange
  const visibleCategories = lockedDimensions.category ? [] : rawCategories
  const visibleExcluded = lockedDimensions.category ? [] : excludedCategories
  const showPricePill = priceFilter && !lockedDimensions.price
  const trimmedSearch = search.trim()
  const hasSearch = trimmedSearch.length > 0 && !!onSearch

  const trayActiveCount = [
    activeIntentId !== null,
    visibleCategories.length > 0,
    visibleExcluded.length > 0,
    excludeFamily,
    showPricePill,
    showDatePill && (dateFrom || dateTo),
    sort !== 'soonest',
  ].filter(Boolean).length

  const hasAnyClearable =
    hasSearch ||
    activeIntentId ||
    showDatePill ||
    visibleCategories.length > 0 ||
    visibleExcluded.length > 0 ||
    excludeFamily ||
    showPricePill ||
    sort !== 'soonest'

  function removeRawCat(cat: string) {
    onRawCategories(rawCategories.filter((c) => c !== cat))
  }

  return (
    <>
      <div className="filter-bar">

        {/* ── Row 1: Filter & Sort + View mode + List/Map toggle ── */}
        <div className="filter-actions-row">
          <div className="filter-actions">
            {showFilterButton && (
              <button
                className={`chip chip--more ${trayActiveCount > 0 ? 'active' : ''}`}
                onClick={() => setTrayOpen(true)}
              >
                <SlidersIcon />
                Filter &amp; Sort
                {trayActiveCount > 0 && (
                  <span className="more-badge">{trayActiveCount}</span>
                )}
              </button>
            )}
          </div>

          <div className="filter-actions-right">
            {/* Card view density toggle — hidden in map view */}
            {view === 'list' && cardViewMode && onCardViewMode && (
              <ViewModeToggle mode={cardViewMode} onChange={onCardViewMode} />
            )}

            {/* List / Map toggle */}
            {onView && (
              <div className="view-toggle" role="group" aria-label="View mode">
                <button
                  className={`view-toggle-btn ${view === 'list' ? 'active' : ''}`}
                  onClick={() => onView('list')}
                  aria-pressed={view === 'list'}
                  title="List view"
                >
                  <ListIcon /> List
                </button>
                <button
                  className={`view-toggle-btn ${view === 'map' ? 'active' : ''}`}
                  onClick={() => onView('map')}
                  aria-pressed={view === 'map'}
                  title="Map view"
                >
                  <MapIcon /> Map
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Active filter summary strip ── */}
        {hasAnyClearable && (
          <div className="filter-active-strip">
            {hasSearch && (
              <ActivePill
                search
                title={`Searching: ${trimmedSearch}`}
                label={
                  <>
                    <SearchPillIcon />
                    <span className="active-pill-label">“{truncate(trimmedSearch, SEARCH_PILL_MAX)}”</span>
                  </>
                }
                onRemove={() => onSearch?.('')}
              />
            )}
            {activeIntent && (
              <ActivePill
                label={`${activeIntent.emoji} ${activeIntent.label}`}
                onRemove={() => onIntentId(null)}
              />
            )}
            {showDatePill && dateRange && (
              <ActivePill
                label={DATE_TABS.find((t) => t.id === dateRange)?.label ?? dateRange}
                onRemove={() => onDateRange(null)}
              />
            )}
            {showDatePill && (dateFrom || dateTo) && (
              <ActivePill
                label={buildDateRangeLabel(dateFrom, dateTo)}
                onRemove={() => { onDateFrom(null); onDateTo(null) }}
              />
            )}
            {visibleCategories.map((cat) => (
              <ActivePill
                key={cat}
                label={cat.charAt(0).toUpperCase() + cat.slice(1)}
                onRemove={() => removeRawCat(cat)}
              />
            ))}
            {visibleExcluded.map((cat) => (
              <ActivePill
                key={`exclude-${cat}`}
                exclude
                label={`Not ${cat.charAt(0).toUpperCase() + cat.slice(1)}`}
                onRemove={() =>
                  onCycleCategory
                    ? onCycleCategory(cat)
                    : onExcludedCategories?.(excludedCategories.filter((c) => c !== cat))
                }
              />
            ))}
            {showPricePill && (
              <ActivePill
                label={priceFilter === 'free' ? 'Free only' : priceFilter === 'under10' ? 'Under $10' : 'Under $25'}
                onRemove={() => onPriceFilter(null)}
              />
            )}
            {excludeFamily && (
              <ActivePill
                exclude
                label="Kids' &amp; family hidden"
                onRemove={() => onExcludeFamily?.(false)}
              />
            )}
            {onClearAll && (
              <button className="active-pill active-pill--clear" onClick={onClearAll}>
                Clear filters
              </button>
            )}
          </div>
        )}

      </div>

      {/* Filter tray */}
      <FilterTray
        open={trayOpen}
        onClose={() => setTrayOpen(false)}
        activeIntentId={activeIntentId} onIntentId={onIntentId}
        rawCategories={rawCategories}   onRawCategories={onRawCategories}
        excludedCategories={excludedCategories} onCycleCategory={onCycleCategory}
        excludeFamily={excludeFamily}   onExcludeFamily={onExcludeFamily}
        showAudienceToggle={showAudienceToggle}
        priceFilter={priceFilter}       onPriceFilter={onPriceFilter}
        dateFrom={dateFrom}             onDateFrom={onDateFrom}
        dateTo={dateTo}                 onDateTo={onDateTo}
        sort={sort}                     onSort={onSort}
        total={total}
        lockedDimensions={lockedDimensions}
        lockedCategories={lockedCategories}
      />
    </>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Cap the search term shown in the pill so a long query can't blow out the
// strip. The full term stays available via the pill's title (hover) tooltip.
const SEARCH_PILL_MAX = 24
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

function buildDateRangeLabel(from: string | null, to: string | null): string {
  const fmt = (d: string | null): string => {
    if (!d) return '…'
    const [, m, day] = d.split('-')
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${months[parseInt(m, 10) - 1]} ${parseInt(day, 10)}`
  }
  if (from === to) return fmt(from)
  return `${fmt(from)} – ${fmt(to)}`
}

interface ActivePillProps {
  label: ReactNode
  onRemove: () => void
  /** Exclusion pill (a hidden category) — rendered in the muted "minus" style. */
  exclude?: boolean
  /** Search pill — accented so an active search reads at a glance. */
  search?: boolean
  /** Full text shown on hover (e.g. an untruncated search term). */
  title?: string
}

function ActivePill({ label, onRemove, exclude = false, search = false, title }: ActivePillProps) {
  const variant = exclude ? ' active-pill--exclude' : search ? ' active-pill--search' : ''
  return (
    <span className={`active-pill${variant}`} title={title}>
      {label}
      <span
        className="active-pill-x"
        role="button"
        aria-label={search ? 'Clear search' : 'Remove filter'}
        onClick={onRemove}
      >
        ✕
      </span>
    </span>
  )
}

function SearchPillIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ flexShrink: 0 }} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function SlidersIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <line x1="4" y1="6"  x2="20" y2="6"/>
      <line x1="4" y1="12" x2="20" y2="12"/>
      <line x1="4" y1="18" x2="20" y2="18"/>
      <circle cx="8"  cy="6"  r="2" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/>
    </svg>
  )
}

function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="8" y1="6"  x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <circle cx="3" cy="6"  r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="12" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="18" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  )
}

function MapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
      <line x1="9"  y1="3" x2="9"  y2="18"/>
      <line x1="15" y1="6" x2="15" y2="21"/>
    </svg>
  )
}
